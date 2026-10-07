import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

// Keep the full acceptance subprocess on the retained Node compatibility path:
// Bun's runner uses process.execPath and would bypass a PATH-only command shim.
const NODE = process.versions['bun'] === undefined ? process.execPath : 'node';

describe('acceptance deadline reporting and cleanup', () => {
  it('R4 clears timers after successful and malformed responses so the client exits naturally', { timeout: 8_000 }, () => {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { createServer } from 'node:http';
      import { json } from './scripts/e2e-http.ts';
      const server = createServer((req, res) => res.end(req.url === '/invalid' ? '{bad' : '{"ok":true}'));
      await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
      const base = 'http://127.0.0.1:' + server.address().port;
      try {
        assert.deepEqual(await json(base, 'GET', '/ok'), { status: 200, body: { ok: true } });
        await assert.rejects(json(base, 'GET', '/invalid'), SyntaxError);
      } finally {
        await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
      }
    `], {
      cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 5_000,
    });
    assert.equal(result.error, undefined, result.stderr);
    assert.equal(result.status, 0, result.stderr);
  });

  it('R3 reports a stalled body as FAIL, exits 1 and stops its server child', { timeout: 40_000 }, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'worldgen-e2e-deadline-'));
    const started = path.join(dir, 'started.json');
    try {
      const bin = path.join(dir, 'bin');
      const stopped = path.join(dir, 'stopped.json');
      await mkdir(bin);
      // Only this acceptance child sees the shim. All commands are local fake responses;
      // the real acceptance script still owns HTTP calls, reporting and process cleanup.
      await writeFile(path.join(bin, 'npm'), `#!/usr/bin/env node
const { createServer } = require('node:http');
const { writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (!args.includes('serve')) { console.log('usage: fake local acceptance command'); process.exit(0); }
const port = Number(args[args.indexOf('--port') + 1]);
const adminPort = Number(args[args.indexOf('--admin-port') + 1]);
writeFileSync(${JSON.stringify(started)}, JSON.stringify({ pid: process.pid }));
let first = true;
const servers = [port, adminPort].map((port) => createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  if (first) {
    first = false;
    res.flushHeaders();
    res.write('{"tables":');
    return;
  }
  res.end(JSON.stringify({ tables: { ticket: [] }, data: [], calls: [], score: 0, now: '2026-01-01T00:00:00.000Z', jobsFired: [] }));
}).listen(port, '127.0.0.1'));
let ready = 0;
for (const server of servers) server.on('listening', () => {
  if (++ready === 2) console.log('world ready; admin ready');
});
process.on('SIGTERM', () => {
  writeFileSync(${JSON.stringify(stopped)}, JSON.stringify({ pid: process.pid, signal: 'SIGTERM' }));
  for (const server of servers) { server.closeAllConnections(); server.close(); }
  process.exit(0);
});
`, { mode: 0o755 });
      const result = spawnSync(NODE, ['--import', 'tsx', 'scripts/e2e.ts'], {
        cwd: path.resolve(import.meta.dirname, '..'),
        env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env['PATH'] ?? ''}` },
        encoding: 'utf8', timeout: 30_000, maxBuffer: 1024 * 1024,
      });
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /FAIL http list with paging - HTTP GET \/_world\/state timed out after 10000 ms/);
      assert.match(result.stdout, /STEP\s+RESULT\s+DETAIL/);
      assert.match(result.stdout, /FAIL: \d+ of \d+ steps did not fail/);
      const cleanup = JSON.parse(await readFile(stopped, 'utf8')) as { pid: number; signal: string };
      assert.equal(cleanup.signal, 'SIGTERM');
      assert.throws(() => process.kill(cleanup.pid, 0), { code: 'ESRCH' });
    } finally {
      // If a regression forces the acceptance child to time out, its detached fake server
      // must still be reaped by the test instead of becoming an orphan.
      try {
        const child = JSON.parse(await readFile(started, 'utf8')) as { pid: number };
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });
});
