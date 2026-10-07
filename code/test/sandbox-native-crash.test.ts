import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { createVmHost } from '../src/engine/sandbox.ts';

it('retains the native crash report beyond its banner', () => {
  const executable = process.execPath;
  const directory = mkdtempSync(join(tmpdir(), 'worldgen-native-crash-'));
  const wrapper = join(directory, 'runtime');
  const quoted = "'" + executable.replaceAll("'", "'\\''") + "'";
  const injection = `require('node:fs').readSync(inFd, Buffer.alloc(4), 0, 4, null); writeSync(2, Buffer.from('============================================================\\npanic: Segmentation fault at address 0x1000024f8')); process.kill(process.pid, 'SIGKILL');`;
  const bootstrap = `const source=process.argv[1].replace('const w = new Worker', ${JSON.stringify(injection)}+'const w = new Worker'); process.argv.splice(1,1); globalThis.require=require; eval(source);`;
  writeFileSync(wrapper, `#!/bin/sh\nshift\nexec ${quoted} -e '${bootstrap.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
  process.execPath = wrapper;
  try {
    const host = createVmHost({ guardMs: 2_000, ctxCallsPerRun: 20_000, maxOldGenerationSizeMb: 123, startMs: 2_000 });
    const result = host.compile('job', '(ctx) => 1', ['jobs', 'native_crash', 'handler']);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.issue.hint, 'the snippet process exited: ============================================================\npanic: Segmentation fault at address 0x1000024f8');
  } finally {
    process.execPath = executable;
    rmSync(directory, { recursive: true, force: true });
  }
});
