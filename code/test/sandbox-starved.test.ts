/**
 * The snippet guard measures what the snippet itself consumes, not wall time. A correct snippet
 * must pass on a machine starved of CPU, and a runaway loop must still fault. The starvation is
 * real: busy-loop child processes this file starts and kills.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { SNIPPET_LIMITS, SnippetFault, type HandlerCtx } from '../src/engine/ctx.ts';
import { createVmHost, guardScale } from '../src/engine/sandbox.ts';

const host = createVmHost();
const PATH = ['actions', 'starved', 'handler'] as const;
const ctx = {} as unknown as HandlerCtx;
/** The guard createVmHost() applies, scaled on a slow host by WORLDGEN_GUARD_SCALE (A-169), plus 3 s for the fault to land. */
const FAULT_WITHIN_MS = SNIPPET_LIMITS.guardMs * guardScale() + 3_000;

function compile(source: string) {
  const r = host.compile('handler', source, [...PATH]);
  if (!r.ok) throw new Error(`compile failed: ${r.issue.code}`);
  return r.run;
}

/** `(ctx) => { ... return n; }` that burns roughly `ms` of CPU on an idle core. */
const burn = (iterations: number): string => `(ctx) => { let n = 0; for (let i = 0; i < ${iterations}; i++) n = (n + i * 7) % 1000003; return n; }`;

function cpuMs(iterations: number): number {
  const run = compile(burn(iterations));
  const t0 = performance.now();
  run(ctx);
  return performance.now() - t0;
}

/** Iterations that cost about `targetMs` of CPU, measured here on a quiet-enough core (best of three). */
function iterationsFor(targetMs: number): number {
  const probe = 2_000_000;
  const solo = Math.min(cpuMs(probe), cpuMs(probe), cpuMs(probe));
  return Math.round((probe * targetMs) / solo);
}

/**
 * Starves the snippet processes this test owns: a helper process stops them 90 ms and lets them run
 * 10 ms, over and over, so a snippet gets a tenth of a core however many cores the machine has.
 * Busy-loop processes do not do this on a many-core machine, where the scheduler still gives a
 * fresh thread a core. It stops and resumes only direct children of this process; the test resumes them all when it ends.
 */
const STARVER = `
const { execFileSync } = require('node:child_process');
const parent = process.argv[1];
const ready = process.argv[2];
const { writeFileSync, renameSync } = require('node:fs');
const nap = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => Atomics.wait(nap, 0, 0, ms);
const mine = () => execFileSync('ps', ['-A', '-o', 'pid=,ppid=']).toString().split('\\n')
  .map((l) => l.trim().split(/\\s+/)).filter(([pid, ppid]) => ppid === parent && pid !== String(process.pid)).map(([pid]) => Number(pid));
const signal = (pids, sig) => pids.forEach((pid) => { try { process.kill(pid, sig); } catch {} });
let pids = mine();
for (let cycle = 0; ; cycle++) {
  if (cycle % 50 === 49) {
    signal(pids, 'SIGCONT');
    pids = mine();
  }
  signal(pids, 'SIGSTOP');
  if (cycle === 0) { writeFileSync(ready + '.tmp', String(pids.length)); renameSync(ready + '.tmp', ready); }
  sleep(90);
  signal(pids, 'SIGCONT');
  sleep(10);
}
`;
let starver: ChildProcess | undefined;
let readinessDirectory: string | undefined;
function starve(): void {
  readinessDirectory = mkdtempSync(join(tmpdir(), 'worldgen-starver-'));
  const ready = join(readinessDirectory, 'ready');
  starver = spawn(process.execPath, ['-e', STARVER, String(process.pid), ready], { stdio: 'ignore' });
  const deadline = performance.now() + 30_000;
  const nap = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(ready)) {
    if (performance.now() >= deadline) {
      relax();
      throw new Error('starvation helper did not become ready within 30000 ms');
    }
    Atomics.wait(nap, 0, 0, 10);
  }
  if (Number(readFileSync(ready, 'utf8')) === 0) {
    relax();
    throw new Error('starvation helper found no snippet processes');
  }
}
function relax(): void {
  if (starver === undefined) return;
  starver.kill('SIGKILL');
  starver = undefined;
  if (readinessDirectory !== undefined) {
    rmSync(readinessDirectory, { recursive: true, force: true });
    readinessDirectory = undefined;
  }
  for (const child of childPids()) {
    try {
      process.kill(child, 'SIGCONT');
    } catch {
      // exited between the listing and the signal
    }
  }
}
function childPids(): number[] {
  return execFileSync('ps', ['-A', '-o', 'pid=,ppid=']).toString().split('\n')
    .map((l) => l.trim().split(/\s+/).map(Number)).filter(([, ppid]) => ppid === process.pid).map(([pid]) => pid!);
}
after(relax);

describe('guard under CPU starvation', () => {
  it('a snippet that needs well under the guard in CPU time passes while the machine is starved', () => {
    const iterations = iterationsFor(700);
    const run = compile(burn(iterations));
    const quiet = run(ctx);
    starve();
    try {
      const t0 = performance.now();
      assert.equal(run(ctx), quiet);
      assert.ok(performance.now() - t0 > 2_000, `the machine was not starved enough: ${Math.round(performance.now() - t0)} ms wall, ${iterations} iterations`);
    } finally {
      relax();
    }
  });

  it('a loop that never ends still faults with snippet.timeout_guard', () => {
    const run = compile('(ctx) => { for (;;) {} }');
    const t0 = performance.now();
    assert.throws(
      () => run(ctx),
      (e: unknown) => e instanceof SnippetFault && e.issue.code === 'snippet.timeout_guard',
    );
    assert.ok(performance.now() - t0 < FAULT_WITHIN_MS, `took ${performance.now() - t0} ms, over ${FAULT_WITHIN_MS}`);
    assert.equal(compile('(ctx) => 7')(ctx), 7);
  });
});
