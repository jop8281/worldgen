import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { SNIPPET_LIMITS, SnippetFault, type JobCtx } from '../src/engine/ctx.ts';
import type { IssuePath } from '../src/engine/issues.ts';
import type { Row } from '../src/engine/store.ts';
import { ENGINE_CALL_SLOT, MAX_ARG_DEPTH, SANDBOX_GLOBALS, SANDBOX_HEAP_LIMITS, createVmHost, guardScale, snippetWorkersStarted } from '../src/engine/sandbox.ts';

const CODE_DIR = fileURLToPath(new URL('..', import.meta.url));
const PATH: IssuePath = ['jobs', 'escalate', 'run'];
const NOW = '2026-01-01T00:00:00.000Z';

function jobCtx(over: Partial<JobCtx> = {}): JobCtx {
  const row = { id: 't1', title: 'Printer on fire' } as unknown as Row;
  return {
    db: {
      get: () => row,
      list: () => [row],
      create: () => row,
      update: () => row,
      delete: () => undefined,
    },
    now: () => NOW,
    time: { plus: (t) => t, minus: (t) => t, minutesBetween: () => 0 },
    ...over,
  };
}

const host = createVmHost();

/** Compile a job snippet and run it, returning whatever the snippet returned. */
function run(source: string, ctx: JobCtx = jobCtx(), h = host): unknown {
  const c = h.compile('job', source, PATH);
  if (!c.ok) throw new Error(`compile failed: ${c.issue.code} ${c.issue.hint}`);
  return c.run(ctx) as unknown;
}

function fault(fn: () => unknown): SnippetFault {
  try {
    fn();
  } catch (e) {
    if (e instanceof SnippetFault) return e;
    throw e;
  }
  throw new Error('expected a SnippetFault');
}

/** PIDs of this process's direct children. */
function childPids(): number[] {
  const out = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }).stdout;
  return out.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter(([, ppid]) => ppid === process.pid).map(([p]) => p as number);
}

/** Upper-bound slack for guard timing: proves a runaway stopped, tolerates a loaded machine. */
const LOAD_SLACK_MS = 5_000;

describe('compile', () => {
  it('compiles a function expression whose run returns ctx.now()', () => {
    const c = host.compile('job', '(ctx) => ctx.now()', PATH);
    assert.equal(c.ok, true);
    if (!c.ok) return;
    assert.equal(c.run(jobCtx()) as unknown, '2026-01-01T00:00:00.000Z');
  });

  it('accepts surrounding whitespace and a function keyword expression', () => {
    assert.equal(run('\n  function (ctx) { return ctx.now(); }  \n'), '2026-01-01T00:00:00.000Z');
  });

  it('reports a syntax error as snippet.compile_error with the vm message in hint', () => {
    const c = host.compile('job', '(ctx) => {', PATH);
    assert.equal(c.ok, false);
    if (c.ok) return;
    assert.equal(c.issue.code, 'snippet.compile_error');
    assert.deepEqual(c.issue.path, ['jobs', 'escalate', 'run']);
    assert.equal(c.issue.hint, 'Unexpected token \')\'');
    assert.equal(c.issue.expected, 'a JS function expression (ctx) => ...');
  });

  for (const source of [
    '1 + 1',
    '(() => { return (ctx) => 1; })()',
    '(ctx) => 1, 2',
    '0, (ctx) => 1',
    '(ctx) => 1); (ctx) => (2',
    'class { }',
    '',
  ]) {
    it(`rejects a source that is not one function expression: ${JSON.stringify(source)}`, () => {
      const c = host.compile('job', source, PATH);
      assert.equal(c.ok, false);
      if (c.ok) return;
      assert.equal(c.issue.code, 'snippet.compile_error');
    });
  }

  it('reports a snippet process that does not start as snippet.host_unavailable, never snippet.compile_error', () => {
    // A heap size no other test uses, so no idle process of the right key can be reused.
    const h = createVmHost({ ctxCallsPerRun: 20_000, guardMs: 2_000, maxOldGenerationSizeMb: 127, startMs: 0 });
    const c = h.compile('job', '(ctx) => 1', PATH);
    assert.equal(c.ok, false);
    if (c.ok) return;
    assert.equal(c.issue.code, 'snippet.host_unavailable');
    assert.match(c.issue.hint, /not an error in the snippet/);
  });

  it('stops a runaway source at compile time with snippet.timeout_guard', () => {
    const h = createVmHost({ ctxCallsPerRun: 20_000, guardMs: 100 });
    const c = h.compile('job', '(() => { while (true) {} })()', PATH);
    assert.equal(c.ok, false);
    if (c.ok) return;
    assert.equal(c.issue.code, 'snippet.timeout_guard');
  });
});

describe('sandbox globals', () => {
  it('pins SANDBOX_GLOBALS to the reviewed allowlist', () => {
    assert.deepEqual([...SANDBOX_GLOBALS], [
      'Object', 'Array', 'Map', 'Set', 'JSON', 'Math', 'Number', 'String', 'Boolean', 'Symbol',
      'Error', 'TypeError', 'RangeError', 'RegExp', 'BigInt', 'Infinity', 'NaN', 'undefined',
      'isFinite', 'isNaN', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent', 'globalThis',
    ]);
    assert.equal(ENGINE_CALL_SLOT, 'worldgen:call');
  });

  it('exposes exactly SANDBOX_GLOBALS inside the context, with the call slot under a symbol (A-195)', () => {
    const names = run('(ctx) => Object.getOwnPropertyNames(globalThis)') as readonly string[];
    assert.deepEqual([...names].sort(), [...SANDBOX_GLOBALS].sort());
    assert.equal([...names].length, 25);
  });

  it('has no clock, locale, process, timers, network or weak refs', () => {
    const types = run(
      '(ctx) => [typeof Date, typeof Intl, typeof process, typeof setTimeout, typeof fetch, typeof WeakRef, typeof SharedArrayBuffer, typeof Atomics, typeof FinalizationRegistry, typeof console, typeof Promise, typeof eval, typeof Function, typeof require].join(",")',
    );
    assert.equal(
      types,
      'undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined,undefined',
    );
  });

  it('makes Math.random throw an Error that points to ctx.rng', () => {
    const out = run('(ctx) => { try { Math.random(); return "no throw"; } catch (e) { return [e instanceof Error, e.message.includes("use ctx.rng")].join(","); } }');
    assert.equal(out, 'true,true');
  });

  it('keeps Math.random throwing after a snippet tries to replace it', () => {
    run('(ctx) => { try { Math.random = () => 0.5; } catch (e) {} return 0; }');
    const f = fault(() => run('(ctx) => Math.random()'));
    assert.equal(f.issue.code, 'snippet.runtime_error');
    assert.equal(f.issue.hint.includes('use ctx.rng'), true);
  });

  it('makes eval and new Function throw', () => {
    const out = run(`(ctx) => {
      const r = [];
      try { eval('1'); r.push('eval ran'); } catch (e) { r.push('eval threw'); }
      try { new Function(''); r.push('Function ran'); } catch (e) { r.push('Function threw'); }
      try { new ((() => {}).constructor)('return 1'); r.push('ctor ran'); } catch (e) { r.push('ctor threw'); }
      try { new (ctx.now.constructor)('return 1'); r.push('ctx ctor ran'); } catch (e) { r.push('ctx ctor threw'); }
      return r.join(',');
    }`);
    assert.equal(out, 'eval threw,Function threw,ctor threw,ctx ctor threw');
  });

  it('removes globals a run creates before the next run', () => {
    assert.equal(run('(ctx) => { globalThis.leak = 41; return leak + 1; }'), 42);
    assert.equal(run('(ctx) => typeof globalThis.leak'), 'undefined');
  });

  it('encodes and decodes a query value, so a test or solution can build a URL (A-274)', () => {
    assert.equal(run("(ctx) => encodeURIComponent('Acme & Co/é=1')"), 'Acme%20%26%20Co%2F%C3%A9%3D1');
    assert.equal(run("(ctx) => decodeURIComponent('Acme%20%26%20Co%2F%C3%A9%3D1')"), 'Acme & Co/é=1');
  });

  it('turns the URIError of a lone surrogate into the same snippet.runtime_error every run (A-274)', () => {
    const first = fault(() => run("(ctx) => encodeURIComponent('\\uD800')"));
    const again = fault(() => run("(ctx) => encodeURIComponent('\\uD800')"));
    assert.equal(first.issue.code, 'snippet.runtime_error');
    assert.equal(again.issue.hint, first.issue.hint);
    const decode = fault(() => run("(ctx) => decodeURIComponent('%E0%A4%A')"));
    assert.equal(decode.issue.code, 'snippet.runtime_error');
  });

  it('runs snippets in strict mode, so an implicit global is an error', () => {
    const f = fault(() => run('(ctx) => { implicitGlobal = 1; return 0; }'));
    assert.equal(f.issue.code, 'snippet.runtime_error');
    assert.equal(f.issue.hint, 'implicitGlobal is not defined');
  });
});

describe('run faults', () => {
  it('SnippetFault is an Error that carries its issue', () => {
    const f = fault(() => run('(ctx) => { throw new Error("boom"); }'));
    assert.equal(f instanceof Error, true);
    assert.equal(f.name, 'SnippetFault');
    assert.equal(f.issue.code, 'snippet.runtime_error');
    assert.equal(f.message, 'snippet.runtime_error: boom');
  });

  it('turns a returned Promise into snippet.promise_returned', async () => {
    let unhandled = 0;
    const onUnhandled = () => { unhandled += 1; };
    process.on('unhandledRejection', onUnhandled);
    try {
      const f = fault(() => run('async (ctx) => { throw new Error("late"); }'));
      assert.equal(f.issue.code, 'snippet.promise_returned');
      assert.deepEqual(f.issue.path, ['jobs', 'escalate', 'run']);
      const g = fault(() => run('async (ctx) => 1'));
      assert.equal(g.issue.code, 'snippet.promise_returned');
      await new Promise((r) => setImmediate(r));
      assert.equal(unhandled, 0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('reports a plain throw as snippet.runtime_error with the message in hint', () => {
    const f = fault(() => run('(ctx) => { throw new TypeError("bad ticket"); }'));
    assert.equal(f.issue.code, 'snippet.runtime_error');
    assert.equal(f.issue.hint, 'bad ticket');
    const g = fault(() => run('(ctx) => { throw "plain string"; }'));
    assert.equal(g.issue.code, 'snippet.runtime_error');
    assert.equal(g.issue.hint, 'plain string');
    // The engine words this one: V8 "Cannot read properties of null (reading 'x')", JavaScriptCore
    // "null is not an object (evaluating 'null.x')". Both name the null and the property.
    const h = fault(() => run('(ctx) => null.x'));
    assert.equal(h.issue.code, 'snippet.runtime_error');
    assert.match(h.issue.hint, /\bnull\b.*'(null\.)?x'/);
  });

  it('rethrows an error thrown by a ctx member unchanged', () => {
    const control = new Error('ctx.fail 409 conflict');
    const ctx = jobCtx({ now: () => { throw control; } });
    let caught: unknown;
    try {
      run('(ctx) => ctx.now()', ctx);
    } catch (e) {
      caught = e;
    }
    assert.equal(caught, control);
  });

  it('rethrows a ctx member error even when the snippet catches and rethrows it', () => {
    const control = new Error('ctx.fail 404 missing');
    const ctx = jobCtx({ now: () => { throw control; } });
    let caught: unknown;
    try {
      run('(ctx) => { try { return ctx.now(); } catch (e) { throw e; } }', ctx);
    } catch (e) {
      caught = e;
    }
    assert.equal(caught, control);
  });

  it('stops `while(true){}` with snippet.timeout_guard within a load-proof bound derived from guardMs', () => {
    const h = createVmHost({ ctxCallsPerRun: 20_000, guardMs: 300 });
    const started = performance.now();
    const f = fault(() => run('(ctx) => { while (true) {} }', jobCtx(), h));
    const elapsed = performance.now() - started;
    assert.equal(f.issue.code, 'snippet.timeout_guard');
    assert.equal(f.issue.expected, 'uses at most 300 ms of CPU time between ctx calls');
    assert.equal(elapsed < 300 + LOAD_SLACK_MS, true, `took ${elapsed} ms`);
  });

  it('gives snippet.call_quota, not timeout_guard, when ctx calls outlast guardMs (a slow host)', () => {
    const h = createVmHost({ ctxCallsPerRun: 20_000, guardMs: 20 });
    const f = fault(() => run('(ctx) => { for (;;) ctx.now(); }', jobCtx(), h));
    assert.equal(f.issue.code, 'snippet.call_quota');
    assert.equal(f.issue.expected, 'at most 20000 ctx calls per run');
  });

  it('does not run a Symbol.hasInstance the snippet puts on Promise after the guarded call', () => {
    const h = createVmHost({ ctxCallsPerRun: 20_000, guardMs: 300 });
    const started = performance.now();
    const f = fault(() => run(
      '(ctx) => { const P = (async () => {})().constructor; Object.defineProperty(P, Symbol.hasInstance, { value: () => { while (true) {} } }); return 1; }',
      jobCtx(),
      h,
    ));
    // Creating the Promise is enough to fault: snippets are synchronous.
    assert.equal(f.issue.code, 'snippet.promise_returned');
    assert.equal(performance.now() - started < 300 + LOAD_SLACK_MS, true);
  });

  it('faults a snippet that starts async work without returning it, and the host keeps running', async () => {
    let unhandled = 0;
    const onUnhandled = () => { unhandled += 1; };
    process.on('unhandledRejection', onUnhandled);
    try {
      const f = fault(() => run('(ctx) => { (async () => { throw new Error("x"); })(); return 1; }'));
      assert.equal(f.issue.code, 'snippet.promise_returned');
      const g = fault(() => run('(ctx) => { const xs = [1, 2].map(async (n) => n); return xs.length; }'));
      assert.equal(g.issue.code, 'snippet.promise_returned');
      await new Promise((r) => setImmediate(r));
      assert.equal(unhandled, 0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('rejects at compile time a source that starts async work before its function', async () => {
    let unhandled = 0;
    const onUnhandled = () => { unhandled += 1; };
    process.on('unhandledRejection', onUnhandled);
    try {
      const c = host.compile('job', '(async () => { throw new Error("w"); })(), (ctx) => 1', PATH);
      assert.equal(c.ok ? 'ok' : c.issue.code, 'snippet.compile_error');
      await new Promise((r) => setImmediate(r));
      assert.equal(unhandled, 0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('keeps the host process alive when a snippet breaks the Promise it rejects, and host rejections still crash', () => {
    // A child process with Node's default unhandled-rejection mode and no other listeners.
    const script = [
      "import { createVmHost } from './src/engine/sandbox.ts';",
      'const h = createVmHost();',
      "const srcs = ['(ctx) => { const p = (async () => { throw new Error(\"a\"); })(); Object.setPrototypeOf(p, null); return 1; }',",
      "  '(ctx) => { const p = (async () => { throw new Error(\"b\"); })(); Object.defineProperty(p, \"constructor\", { get() { throw 1; } }); Object.freeze(p); return 1; }'];",
      "const codes = srcs.map((s) => { const c = h.compile('job', s, ['x']); try { c.run({}); return 'no fault'; } catch (e) { return e.issue.code; } });",
      "setTimeout(() => { console.log(codes.join(',')); if (process.argv.includes('host')) Promise.reject(new Error('host boom')); }, 20);",
    ].join('\n');
    const child = (arg: string) => spawnSync(process.execPath, ['--input-type=module', '-e', script, arg], { encoding: 'utf8', cwd: CODE_DIR });
    const quiet = child('none');
    assert.deepEqual([quiet.status, quiet.stdout.trim()], [0, 'snippet.promise_returned,snippet.promise_returned']);
    const loud = child('host');
    assert.equal(loud.status, 1);
    assert.equal(loud.stderr.includes('host boom'), true);
  });

  it('silences a returned Promise under the guard, so a looping constructor getter still ends in promise_returned', () => {
    const h = createVmHost({ ctxCallsPerRun: 20_000, guardMs: 300 });
    const started = performance.now();
    const f = fault(() => run(
      '(ctx) => { const p = (async () => 1)(); Object.defineProperty(p.constructor.prototype, "constructor", { get() { while (true) {} } }); return p; }',
      jobCtx(),
      h,
    ));
    assert.equal(f.issue.code, 'snippet.promise_returned');
    assert.equal(performance.now() - started < 300 + LOAD_SLACK_MS, true);
  });

  it('uses the default guard of 2000 ms', () => {
    assert.equal(SNIPPET_LIMITS.guardMs, 2000);
  });
});

describe('ctx call quota', () => {
  it('allows exactly ctxCallsPerRun calls (20000)', () => {
    assert.equal(run('(ctx) => { let n = 0; for (let i = 0; i < 20000; i++) { ctx.now(); n++; } return n; }'), 20000);
  });

  it('throws snippet.call_quota on call 20001', () => {
    const f = fault(() => run('(ctx) => { for (let i = 0; i < 20001; i++) ctx.now(); return 0; }'));
    assert.equal(f.issue.code, 'snippet.call_quota');
    assert.equal(f.issue.expected, 'at most 20000 ctx calls per run');
  });

  it('counts nested members such as ctx.db.get and ctx.time.plus', () => {
    const h = createVmHost({ ctxCallsPerRun: 3, guardMs: 2000 });
    assert.equal(run('(ctx) => { ctx.db.get("ticket", "t1"); ctx.time.plus("x", "1m"); return ctx.now(); }', jobCtx(), h), '2026-01-01T00:00:00.000Z');
    const f = fault(() => run('(ctx) => { ctx.db.get("ticket", "t1"); ctx.db.list("ticket"); ctx.time.plus("x", "1m"); ctx.time.minutesBetween("a", "b"); return 0; }', jobCtx(), h));
    assert.equal(f.issue.code, 'snippet.call_quota');
  });

  it('never leaves a stale answer for the next request on a pooled process after a quota trip', () => {
    // The watchdog reports a tripped quota by claiming the run's token. A worker that read the claimed token after the
    // claim used to answer anyway, so its answer and the watchdog's dead frame both reached the lane, and the next request
    // read the dead one: about one trip in 800 on a quiet machine, more under load. Many trips in a row make it show.
    const tight = createVmHost({ ...SNIPPET_LIMITS, ctxCallsPerRun: 1, guardMs: 2000 });
    for (let i = 0; i < 1000; i++) {
      assert.equal(fault(() => run('(ctx) => { ctx.now(); ctx.now(); return 0; }', jobCtx(), tight)).issue.code, 'snippet.call_quota');
      assert.equal(run('(ctx) => ctx.now()', jobCtx(), tight), NOW);
    }
  });

  it('resets the counter on every run', () => {
    const h = createVmHost({ ctxCallsPerRun: 2, guardMs: 2000 });
    const src = '(ctx) => { ctx.now(); return ctx.now(); }';
    assert.equal(run(src, jobCtx(), h), '2026-01-01T00:00:00.000Z');
    assert.equal(run(src, jobCtx(), h), '2026-01-01T00:00:00.000Z');
  });

  it('still faults when the snippet catches the quota error', () => {
    const h = createVmHost({ ctxCallsPerRun: 2, guardMs: 2000 });
    const f = fault(() => run('(ctx) => { for (let i = 0; i < 5; i++) { try { ctx.now(); } catch (e) {} } return "swallowed"; }', jobCtx(), h));
    assert.equal(f.issue.code, 'snippet.call_quota');
    assert.equal(f.issue.expected, 'at most 2 ctx calls per run');
  });

  it('passes arguments through to the ctx implementation', () => {
    const seen: string[] = [];
    const ctx = jobCtx({
      time: {
        plus(t, d) { seen.push(`${t}+${d}`); return 'later'; },
        minus: (t) => t,
        minutesBetween: () => 0,
      },
    });
    assert.equal(run('(ctx) => ctx.time.plus("2026-01-01T00:00:00.000Z", "15m")', ctx), 'later');
    assert.deepEqual(seen, ['2026-01-01T00:00:00.000Z+15m']);
  });
});

describe('isolation between sources and runs', () => {
  const NOT_ONE_FUNCTION = 'Write exactly one function expression, such as (ctx) => { ... }, with nothing before or after it.';

  for (const source of [
    '(ctx) => 1); var v = 1; ((ctx) => 1',
    '(ctx) => 1); function g() {} ((ctx) => 1',
  ]) {
    it(`rejects a top-level declaration without breaking the host: ${JSON.stringify(source)}`, () => {
      const h = createVmHost();
      const c = h.compile('job', source, PATH);
      assert.equal(c.ok, false);
      if (c.ok) return;
      assert.equal(c.issue.code, 'snippet.compile_error');
      assert.equal(c.issue.hint, NOT_ONE_FUNCTION);
      assert.equal(run('(ctx) => 2', jobCtx(), h), 2);
      assert.equal(run('(ctx) => [typeof v, typeof g].join(",")', jobCtx(), h), 'undefined,undefined');
    });
  }

  it('leaves no let, const or class from a rejected source in later snippets', () => {
    const h = createVmHost();
    for (const source of [
      '(ctx) => 1); let leaked = 7; ((ctx) => 1',
      '(ctx) => 1); const kept = 8; ((ctx) => 1',
      '(ctx) => 1); class Q {} ((ctx) => 1',
    ]) {
      const first = h.compile('job', source, PATH);
      const second = h.compile('job', source, PATH);
      assert.equal(first.ok, false);
      assert.equal(second.ok, false);
      if (first.ok || second.ok) return;
      assert.equal(first.issue.hint, NOT_ONE_FUNCTION);
      assert.equal(second.issue.hint, NOT_ONE_FUNCTION);
    }
    assert.equal(run('(ctx) => [typeof leaked, typeof kept, typeof Q].join(",")', jobCtx(), h), 'undefined,undefined,undefined');
  });

  it('does not carry intrinsic prototype changes into the next run', () => {
    const src = '(ctx) => { Array.prototype.leak = (Array.prototype.leak || 0) + 1; Object.prototype.seen = (Object.prototype.seen || 0) + 1; return [Array.prototype.leak, ({}).seen].join(","); }';
    assert.equal(run(src), '1,1');
    assert.equal(run(src), '1,1');
    assert.equal(run('(ctx) => [typeof [].leak, typeof ({}).seen].join(",")'), 'undefined,undefined');
  });

  it('does not carry intrinsic prototype changes into another snippet', () => {
    run('(ctx) => { JSON.parse = () => "poisoned"; Map.prototype.get = () => "poisoned"; return 0; }');
    assert.equal(run('(ctx) => JSON.parse("[1]")[0] + new Map([["a", 2]]).get("a")'), 3);
  });
});

describe('host realm values', () => {
  const ESCAPE = (expr: string): string =>
    `(ctx) => { try { return typeof (${expr}).constructor.constructor("return process")(); } catch (e) { return "blocked"; } }`;

  it('copies rows returned by ctx members into the context, so their constructor cannot make code', () => {
    assert.equal(run(ESCAPE('ctx.db.get("ticket", "t1")')), 'blocked');
    assert.equal(run(ESCAPE('ctx.db.list("ticket")')), 'blocked');
    assert.equal(run(ESCAPE('ctx.db.list("ticket")[0]')), 'blocked');
  });

  it('copies ctx data members into the context', () => {
    const ctx = { ...jobCtx(), extra: { nested: [{ a: 1 }] } } as unknown as JobCtx;
    assert.equal(run(ESCAPE('ctx.extra'), ctx), 'blocked');
    assert.equal(run(ESCAPE('ctx.extra.nested[0]'), ctx), 'blocked');
    assert.equal(run('(ctx) => ctx.extra.nested[0].a + ctx.db.get("ticket", "t1").title.length', ctx), 16);
  });

  it('copies errors thrown by ctx members into the context, keeping message, name and primitive fields', () => {
    const control = Object.assign(new TypeError('ctx.fail 409 conflict'), { status: 409, detail: { x: 1 } });
    const ctx = jobCtx({ now: () => { throw control; } });
    const out = run(
      '(ctx) => { try { ctx.now(); return "no throw"; } catch (e) { let esc; try { esc = typeof e.constructor.constructor("return process")(); } catch (x) { esc = "blocked"; } return [esc, e.message, e.name, e.status, typeof e.detail, e instanceof Error].join(","); } }',
      ctx,
    );
    assert.equal(out, 'blocked,ctx.fail 409 conflict,TypeError,409,undefined,true');
  });

  it('copies the quota error into the context and still ends in snippet.call_quota', () => {
    const h = createVmHost({ ctxCallsPerRun: 1, guardMs: 2000 });
    const f = fault(() => run('(ctx) => { ctx.now(); try { ctx.now(); } catch (e) { return typeof e.constructor.constructor("return process")(); } return "x"; }', jobCtx(), h));
    assert.equal(f.issue.code, 'snippet.call_quota');
  });

  it('passes arguments to ctx members as plain host data', () => {
    const seen: unknown[] = [];
    const ctx = jobCtx({
      db: {
        get: () => null,
        list: () => [],
        create: (entity, data) => { seen.push(entity, Object.getPrototypeOf(data) === Object.prototype, data); return { id: 'n1' } as unknown as Row; },
        update: () => { throw new Error('unused'); },
        delete: () => undefined,
      },
    });
    assert.equal(run('(ctx) => ctx.db.create("ticket", { title: "x", tags: ["a"] }).id', ctx), 'n1');
    assert.deepEqual(seen, ['ticket', true, { title: 'x', tags: ['a'] }]);
  });

  it('caps ctx argument nesting at MAX_ARG_DEPTH (64) levels with a context-realm error', () => {
    assert.equal(MAX_ARG_DEPTH, 64);
    const nested = (levels: number): string =>
      `(ctx) => { let o = {}; for (let i = 1; i < ${levels}; i++) o = { o }; try { return ctx.db.create("ticket", o).title; } catch (e) { try { return typeof e.constructor.constructor("return process")(); } catch (x) { return "blocked: " + e.message; } } }`;
    assert.equal(run(nested(64)), 'Printer on fire');
    assert.equal(run(nested(65)), 'blocked: ctx arguments must be nested at most 64 levels deep');
    assert.equal(run(nested(100_000)), 'blocked: ctx arguments must be nested at most 64 levels deep');
  });

  it('keeps host errors out of reach when the host stack overflows inside a ctx call', () => {
    const h = createVmHost({ ctxCallsPerRun: 1_000_000, guardMs: 5000 });
    // Calls ctx.now() at every recursion depth on the way back up, so some calls start with
    // too little stack left for the host side of the call.
    const out = run(
      '(ctx) => { let leaks = 0; const f = (d) => { try { f(d + 1); } catch (e) {} try { ctx.now(); } catch (e) { try { if (typeof e.constructor.constructor("return process")() === "object") leaks += 1; } catch (x) {} } }; try { f(0); } catch (e) {} return leaks; }',
      jobCtx(),
      h,
    );
    assert.equal(out, 0);
  });

  it('rejects cyclic and BigInt ctx arguments as plain-data violations', () => {
    const ctx = { ...jobCtx(), inspect: () => 'called' } as unknown as JobCtx;
    for (const source of [
      '(ctx) => ctx.inspect((() => { const value = {}; value.self = value; return value; })())',
      '(ctx) => ctx.inspect((() => { const value = []; value.push(value); return value; })())',
      '(ctx) => ctx.inspect({ value: 1n })',
      '(ctx) => ctx.inspect({ value: Symbol("x") })',
      '(ctx) => ctx.inspect({ [Symbol("x")]: 1 })',
    ]) {
      const f = fault(() => run(source, ctx));
      assert.equal(f.issue.code, 'snippet.runtime_error');
      assert.equal(f.issue.hint, 'ctx arguments must be plain data: strings, numbers, booleans, null, arrays and objects without getters, and no BigInt, symbols, symbol keys or cycles');
    }
  });

  it('accepts a shared acyclic child as a ctx argument', () => {
    const ctx = { ...jobCtx(), inspect: (v: unknown) => JSON.stringify(v) } as unknown as JobCtx;
    assert.equal(run('(ctx) => { const c = { n: 1 }; return ctx.inspect({ a: c, b: c, l: [c, c] }); }', ctx), '{"a":{"n":1},"b":{"n":1},"l":[{"n":1},{"n":1}]}');
  });

  it('refuses functions and getters as ctx arguments with snippet.runtime_error', () => {
    const f = fault(() => run('(ctx) => ctx.db.create("ticket", { get title() { return "x"; } })'));
    assert.equal(f.issue.code, 'snippet.runtime_error');
    assert.equal(f.issue.hint, 'ctx arguments must be plain data: strings, numbers, booleans, null, arrays and objects without getters, and no BigInt, symbols, symbol keys or cycles');
    const g = fault(() => run('(ctx) => ctx.db.create("ticket", { f() {} })'));
    assert.equal(g.issue.code, 'snippet.runtime_error');
  });

  it('copies another snippet\'s result into a run without that realm\'s Object.prototype members', () => {
    const handler = host.compile('handler', '(ctx) => ({ status: 200, body: { a: 1 } })', PATH);
    if (!handler.ok) throw new Error('compile failed');
    const ctx = { ...jobCtx(), api: () => handler.run({} as never) } as unknown as JobCtx;
    const out = run('(ctx) => { const r = ctx.api(); return [Object.keys(r).join("|"), Object.keys(r.body).length, JSON.stringify(r.body)]; }', ctx);
    assert.deepEqual(out, ['status|body', 1, '{"a":1}']);
  });

  it('copies null-prototype objects and class instances returned by ctx members by their own and class members', () => {
    class Box { constructor(readonly v: number) {} twice(): number { return this.v * 2; } }
    const bare = Object.assign(Object.create(null) as object, { a: 1 });
    const ctx = { ...jobCtx(), bare: () => bare, box: () => new Box(4) } as unknown as JobCtx;
    assert.deepEqual(run('(ctx) => [Object.keys(ctx.bare()).join("|"), Object.keys(ctx.box()).join("|"), ctx.box().twice()]', ctx), ['a', 'v|twice', 8]);
  });

  it('stops the member walk at any realm root, not only the host Object.prototype', () => {
    // Stands in for another realm's Object.prototype: a prototype whose own prototype is null.
    const root = Object.create(null, { hasOwnProperty: { value: () => true }, toString: { value: () => 'x' } }) as object;
    const tagged = Object.assign(Object.create(Object.create(root, { kind: { value: 'row', enumerable: true } }) as object) as object, { a: 1 });
    const ctx = { ...jobCtx(), other: () => tagged } as unknown as JobCtx;
    assert.equal(run('(ctx) => Object.keys(ctx.other()).join("|")', ctx), 'a|kind');
  });
});

describe('snippet results', () => {
  it('returns results as plain host data, so identical runs are deepStrictEqual', () => {
    const c = host.compile('job', '(ctx) => ({ a: [1, 2], b: { c: null } })', PATH);
    if (!c.ok) throw new Error('compile failed');
    const first = c.run(jobCtx()) as unknown;
    assert.equal(isDeepStrictEqual(first, c.run(jobCtx())), true);
    assert.deepEqual(first, { a: [1, 2], b: { c: null } });
    assert.equal(Object.getPrototypeOf(first) === Object.prototype, true);
    assert.equal((first as { a: unknown[] }).a instanceof Array, true);
  });

  it('refuses a result with a getter instead of running it on the host', () => {
    const h = createVmHost({ ctxCallsPerRun: 20_000, guardMs: 300 });
    const started = performance.now();
    const f = fault(() => run('(ctx) => ({ get status() { while (true) {} } })', jobCtx(), h));
    assert.equal(f.issue.code, 'snippet.runtime_error');
    assert.equal(f.issue.hint, 'a snippet must return plain data: strings, numbers, booleans, null, arrays and plain objects without getters or functions, and no BigInt, symbols, symbol keys or cycles');
    assert.equal(performance.now() - started < 300 + LOAD_SLACK_MS, true);
  });

  it('refuses functions and nesting past MAX_ARG_DEPTH in a result', () => {
    assert.equal(fault(() => run('(ctx) => ({ toJSON() { while (true) {} } })')).issue.code, 'snippet.runtime_error');
    assert.equal(fault(() => run('(ctx) => () => 1')).issue.code, 'snippet.runtime_error');
    assert.equal(run('(ctx) => { let o = { end: true }; for (let i = 1; i < 64; i++) o = { o }; return o; }') !== undefined, true);
    const f = fault(() => run('(ctx) => { let o = {}; for (let i = 0; i < 70; i++) o = { o }; return o; }'));
    assert.equal(f.issue.hint, 'a snippet result must be nested at most 64 levels deep');
  });

  it('rejects cycles and BigInt in snippet results as plain-data violations', () => {
    for (const source of [
      '(ctx) => { const value = {}; value.self = value; return value; }',
      '(ctx) => { const value = []; value.push(value); return value; }',
      '(ctx) => ({ value: 1n })',
      '(ctx) => 1n',
      '(ctx) => ({ value: Symbol("x") })',
      '(ctx) => ({ [Symbol("x")]: 1 })',
    ]) {
      const f = fault(() => run(source));
      assert.equal(f.issue.code, 'snippet.runtime_error');
      assert.equal(f.issue.hint, 'a snippet must return plain data: strings, numbers, booleans, null, arrays and plain objects without getters or functions, and no BigInt, symbols, symbol keys or cycles');
    }
  });

  it('accepts a shared acyclic child in a snippet result', () => {
    assert.deepEqual(run('(ctx) => { const c = { n: 1 }; return { a: c, b: c }; }'), { a: { n: 1 }, b: { n: 1 } });
  });
});

/** Bun ignores Worker resourceLimits, so the heap bound holds only on Node, whose CI job gates it (A-87). */
const HEAP_BOUND_SKIP = process.versions.bun !== undefined && 'YOS-59: Bun ignores heap limits; the Node job enforces this';

describe('memory bound and worker reuse', { skip: HEAP_BOUND_SKIP }, () => {
  const GROW = '(ctx) => { const a = []; for (;;) a.push(new Array(1e6).fill(1)); }';
  /** About 40 MB of live doubles: under the default heap limit, over a 32 MB one. */
  const FORTY_MB = '(ctx) => { const a = []; for (let i = 0; i < 50; i++) a.push(new Array(1e5).fill(1.5)); return a.length; }';

  it('pins the default heap limits to 128 MB old and 16 MB young generation', () => {
    assert.deepEqual({ ...SANDBOX_HEAP_LIMITS }, { maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 });
  });

  it('faults a snippet that allocates without bound, and the same host keeps running snippets', () => {
    const f = fault(() => run(GROW));
    assert.equal(f.issue.code, 'snippet.memory');
    assert.equal(f.issue.hint, 'the snippet ran out of memory: its heap is limited to 128 MB');
    assert.deepEqual(f.issue.path, ['jobs', 'escalate', 'run']);
    assert.equal(run('(ctx) => ctx.now()'), '2026-01-01T00:00:00.000Z');
  });

  it('faults an unbounded allocation at compile time without breaking the host', () => {
    const c = host.compile('job', '(() => { const a = []; for (;;) a.push(new Array(1e6).fill(1)); })(), (ctx) => 1', PATH);
    assert.equal(c.ok ? 'ok' : c.issue.code, 'snippet.memory');
    if (c.ok) return;
    assert.equal(c.issue.hint, 'the snippet ran out of memory: its heap is limited to 128 MB');
    assert.equal(run('(ctx) => 7'), 7);
  });

  // V8 cannot recover these in the worker: it aborts the whole process (FATAL ERROR ... heap out of memory).
  const FATAL = [
    '(ctx) => { const m = new Map(); for (let i = 0; ; i++) m.set(i, { i }); }',
    '(ctx) => { const o = {}; for (let i = 0; ; i++) o["k" + i] = i; }',
    '(ctx) => new Array(1e8).fill(1).length',
    '(ctx) => { const a = []; a.length = 2e8; a.fill(0); return 1; }',
  ];
  for (const source of FATAL) {
    it(`faults a process-fatal allocation with snippet.memory and the host keeps running: ${source}`, () => {
      const f = fault(() => run(source));
      assert.equal(f.issue.code, 'snippet.memory');
      assert.equal(f.issue.hint, 'the snippet ran out of memory: its heap is limited to 128 MB');
      assert.equal(run('(ctx) => ctx.now()'), '2026-01-01T00:00:00.000Z');
    });
  }

  it('passes a 3 million element array to a ctx member under the default heap limit', () => {
    const ctx = { ...jobCtx(), f: (a: number[]) => [a.length, a[0], a[2_999_999]] } as unknown as JobCtx;
    assert.deepEqual(run('(ctx) => { const a = []; for (let i = 0; i < 3e6; i++) a.push(i); return ctx.f(a); }', ctx), [3_000_000, 0, 2_999_999]);
  });

  it('applies the heap limits a host is created with', () => {
    assert.equal(run(FORTY_MB), 50);
    const small = createVmHost({ ctxCallsPerRun: 20_000, guardMs: 2000, maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8 });
    const f = fault(() => run(FORTY_MB, jobCtx(), small));
    assert.equal(f.issue.code, 'snippet.memory');
    assert.equal(f.issue.hint, 'the snippet ran out of memory: its heap is limited to 32 MB');
    assert.equal(run('(ctx) => ctx.now()', jobCtx(), small), '2026-01-01T00:00:00.000Z');
  });

  it('runs 200 trivial snippets on one reused worker under 5000 ms with no state carried between runs', () => {
    // Its own pool key, so no earlier test's requests bring this process near LANE_REQUEST_BUDGET mid-test.
    const h = createVmHost({ ...SNIPPET_LIMITS, maxYoungGenerationSizeMb: SNIPPET_LIMITS.maxYoungGenerationSizeMb - 2 });
    assert.equal(run('(ctx) => 0', jobCtx(), h), 0);
    const started = snippetWorkersStarted();
    const t0 = performance.now();
    const seen: unknown[] = [];
    for (let i = 0; i < 200; i++) {
      seen.push(run('(ctx) => { const before = [typeof globalThis.mark, typeof [].mark].join(","); globalThis.mark = 1; Array.prototype.mark = 1; return before; }', jobCtx(), h));
    }
    assert.equal(performance.now() - t0 < 5000, true);
    assert.equal(snippetWorkersStarted(), started);
    assert.deepEqual(new Set(seen), new Set(['undefined,undefined']));
  });

  it('serves a nested run on the outer run\'s process, and an inner out-of-memory faults the outer run too', () => {
    const h = createVmHost({ ...SNIPPET_LIMITS, maxYoungGenerationSizeMb: SNIPPET_LIMITS.maxYoungGenerationSizeMb - 3 });
    const inner = h.compile('handler', '(ctx) => ({ status: 201 })', PATH);
    const grow = h.compile('handler', GROW, PATH);
    if (!inner.ok || !grow.ok) throw new Error('compile failed');
    const started = snippetWorkersStarted();
    const nest = (snippet: typeof inner) => ({ ...jobCtx(), api: () => snippet.run({} as never) }) as unknown as JobCtx;
    assert.equal(run('(ctx) => ctx.api().status + ctx.api().status', nest(inner), h), 402);
    assert.equal(snippetWorkersStarted(), started);
    const f = fault(() => run('(ctx) => { try { return ctx.api(); } catch (e) { return "caught"; } }', nest(grow), h));
    assert.equal(f.issue.code, 'snippet.memory');
    assert.equal(run('(ctx) => ctx.api().status', nest(inner), h), 201);
  });

  it('gives snippet.memory, not timeout_guard, to a no-call allocation whose snippet process is starved of CPU', () => {
    // Scaled like the default host (A-169): on a 2-vCPU runner the starved allocation takes 5 to 8 s of wall time, at the 15 x guardMs backstop.
    const h = createVmHost({ ctxCallsPerRun: 20_000, guardMs: 500 * guardScale(), maxOldGenerationSizeMb: 96, maxYoungGenerationSizeMb: 16 });
    const before = new Set(childPids());
    assert.equal(run('(ctx) => 1', jobCtx(), h), 1);
    const [pid] = childPids().filter((p) => !before.has(p));
    assert.equal(typeof pid, 'number', 'the warm-up run started a snippet process');
    const starver = spawn(process.execPath, ['-e', `
      const pid = ${pid};
      const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      try { for (;;) { process.kill(pid, 'SIGSTOP'); nap(300); process.kill(pid, 'SIGCONT'); nap(5); } } catch {}
    `], { stdio: 'ignore' });
    try {
      const give = performance.now() + 10_000;
      while (!spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.includes('T')) {
        assert.ok(performance.now() < give, `snippet process ${String(pid)} never stopped`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      const f = fault(() => run(GROW, jobCtx(), h));
      assert.equal(f.issue.code, 'snippet.memory');
      assert.equal(f.issue.hint, 'the snippet ran out of memory: its heap is limited to 96 MB');
    } finally {
      starver.kill('SIGKILL');
      try { process.kill(pid as number, 'SIGCONT'); } catch {}
    }
  });

  it('gives snippet.memory, not timeout_guard, at the default limits under a tenth of a core: the heap runs out in less CPU than guardMs', () => {
    // One MB off the default young generation gives this host its own pool key, so the warm-up starts a fresh snippet process to starve.
    const h = createVmHost({ ...SNIPPET_LIMITS, maxYoungGenerationSizeMb: SNIPPET_LIMITS.maxYoungGenerationSizeMb - 1 });
    const before = new Set(childPids());
    assert.equal(run('(ctx) => 1', jobCtx(), h), 1);
    const [pid] = childPids().filter((p) => !before.has(p));
    assert.equal(typeof pid, 'number', 'the warm-up run started a snippet process');
    const starver = spawn(process.execPath, ['-e', `
      const pid = ${pid};
      const nap = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      try { for (;;) { process.kill(pid, 'SIGSTOP'); nap(90); process.kill(pid, 'SIGCONT'); nap(10); } } catch {}
    `], { stdio: 'ignore' });
    try {
      const give = performance.now() + 10_000;
      while (!spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.includes('T')) {
        assert.ok(performance.now() < give, `snippet process ${String(pid)} never stopped`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
      const f = fault(() => run(GROW, jobCtx(), h));
      assert.equal(f.issue.code, 'snippet.memory');
      assert.equal(f.issue.hint, 'the snippet ran out of memory: its heap is limited to 128 MB');
    } finally {
      starver.kill('SIGKILL');
      try { process.kill(pid as number, 'SIGCONT'); } catch {}
    }
  });

  it('serves ctx calls synchronously and in order between snippet statements', () => {
    const log: string[] = [];
    const ctx = jobCtx({ now: () => { log.push(`now${log.length}`); return String(log.length); } });
    assert.equal(run('(ctx) => [ctx.now(), ctx.now(), ctx.now()].join("|")', ctx), '1|2|3');
    assert.deepEqual(log, ['now0', 'now1', 'now2']);
  });
});

describe('snippet process request budget', () => {
  it('retires a snippet process after 2000 requests and starts a fresh one for the next', () => {
    const h = createVmHost({ ctxCallsPerRun: 20_000, guardMs: 2000, maxOldGenerationSizeMb: 77, maxYoungGenerationSizeMb: 7 });
    const started = snippetWorkersStarted();
    const c = h.compile('job', '(ctx) => 1', PATH);
    if (!c.ok) throw new Error('compile failed');
    for (let i = 0; i < 2000; i++) assert.equal(c.run(jobCtx()), 1);
    assert.equal(snippetWorkersStarted() - started, 2);
  });
});
