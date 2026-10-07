import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { describe, it } from 'node:test';
import { runCommand } from '../scripts/e2e-command.ts';

const cwd = path.resolve(import.meta.dirname, '..');

async function assertStopped(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      assert.ok(error instanceof Error && 'code' in error && error.code === 'ESRCH');
      return;
    }
    await delay(20);
  }
  assert.fail(`process ${pid} survived command cleanup`);
}

describe('acceptance command deadlines', () => {
  it('retains output and the actual nonzero exit code', async () => {
    const result = await runCommand(process.execPath, ['-e', "process.stdout.write('out'); process.stderr.write('err'); process.exitCode = 7"], { cwd, timeoutMs: 5_000 });
    assert.equal(result.kind, 'exited');
    assert.equal(result.code, 7);
    assert.ok(result.out.includes('out'));
    assert.ok(result.out.includes('err'));
  });

  it('reports a command that cannot start', async () => {
    const result = await runCommand('/worldgen/no-such-command', [], { cwd, timeoutMs: 5_000 });
    assert.equal(result.kind, 'failed');
    assert.match(result.reason, /ENOENT/);
  });

  for (const launcherExits of [false, true]) {
    it(`kills a SIGTERM-ignoring descendant when the launcher ${launcherExits ? 'exits before the deadline' : 'also ignores SIGTERM'}`, { timeout: 15_000 }, async () => {
      const dir = await mkdtemp(path.join(tmpdir(), 'e2e-command-'));
      const pidFile = path.join(dir, 'pid');
      const childSource = `
        require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
        process.on('SIGTERM', () => {});
        process.stdout.write('descendant ready');
        setInterval(() => {}, 1000);
      `;
      const launcher = `
        const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childSource)}], {stdio: ['ignore', 'inherit', 'inherit']});
        process.on('SIGTERM', () => {});
        ${launcherExits ? 'child.unref();' : 'setInterval(() => {}, 1000);'}
      `;
      try {
        const result = await runCommand(process.execPath, ['-e', launcher], { cwd, timeoutMs: 2_000 });
        assert.equal(result.kind, 'failed');
        assert.match(result.reason, /timed out after 2000 ms/);
        assert.match(result.out, /descendant ready/);
        await assertStopped(Number(await readFile(pidFile, 'utf8')));
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  it('bounds captured output and stops the writer', { timeout: 10_000 }, async () => {
    const result = await runCommand(process.execPath, ['-e', "setInterval(() => process.stdout.write('x'.repeat(4096)), 1)"], { cwd, timeoutMs: 5_000, maxOutputBytes: 1024 });
    assert.equal(result.kind, 'failed');
    assert.equal(result.reason, 'output exceeded 1024 bytes');
    assert.equal(result.out, 'x'.repeat(1024));
  });
});
