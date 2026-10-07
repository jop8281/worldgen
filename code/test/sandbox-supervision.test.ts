import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { SnippetFault, type HandlerCtx } from '../src/engine/ctx.ts';
import { createVmHost } from '../src/engine/sandbox.ts';

function pendingCpu(body: () => void): void {
  const executable = process.execPath;
  const directory = mkdtempSync(join(tmpdir(), 'worldgen-pending-cpu-'));
  const wrapper = join(directory, 'node');
  const quoted = "'" + executable.replaceAll("'", "'\\''") + "'";
  writeFileSync(wrapper, `#!/bin/sh
shift
source=$1
shift
exec ${quoted} -e 'require("node:worker_threads").Worker.prototype.cpuUsage=()=>new Promise(()=>{});'"$source" "$@"
`, { mode: 0o755 });
  process.execPath = wrapper;
  try { body(); }
  finally {
    process.execPath = executable;
    rmSync(directory, { recursive: true, force: true });
  }
}

const path = ['actions', 'pending_cpu', 'handler'] as const;
const ctx = {} as unknown as HandlerCtx;

describe('supervision while CPU observation is pending', { skip: process.versions.bun !== undefined && 'Node worker CPU fault injection; Bun uses synchronous process sampling' }, () => {
  it('stops at the supervisor wall backstop and retains that cause', () => pendingCpu(() => {
    const host = createVmHost({ guardMs: 50, ctxCallsPerRun: 3 });
    const compiled = host.compile('handler', '(ctx)=>{for(;;){}}', path);
    assert.ok(compiled.ok);
    const start = performance.now();
    assert.throws(() => compiled.run(ctx), (error: unknown) => {
      assert.ok(error instanceof SnippetFault);
      assert.equal(error.issue.code, 'snippet.timeout_guard');
      assert.equal(error.issue.found, 'no answer from the snippet worker within 750 ms');
      return true;
    });
    assert.ok(performance.now() - start < 2_000);
    const next = host.compile('handler', '(ctx)=>7', path);
    assert.ok(next.ok);
    assert.equal(next.run(ctx), 7);
  }));

  it('preserves a caught quota verdict while CPU observation is pending', () => pendingCpu(() => {
    const host = createVmHost({ guardMs: 200, ctxCallsPerRun: 3 });
    const compiled = host.compile('handler', '(ctx)=>{let n=0;for(let i=0;i<10000000;i++)n=(n+i*7)%1000003;for(;;){try{ctx.api("GET","/probe")}catch{}}}', path);
    assert.ok(compiled.ok);
    let calls = 0;
    const context = { api: () => { calls++; return { status: 200, body: {} }; } } as unknown as HandlerCtx;
    assert.throws(() => compiled.run(context), (error: unknown) => {
      assert.ok(error instanceof SnippetFault);
      assert.equal(error.issue.code, 'snippet.call_quota');
      return true;
    });
    assert.equal(calls, 3);
    const next = host.compile('handler', '(ctx)=>7', path);
    assert.ok(next.ok);
    assert.equal(next.run(ctx), 7);
  }));
});
