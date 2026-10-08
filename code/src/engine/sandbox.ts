/**
 * The deterministic vm that runs world snippets. This shell file is the only importer of node:vm.
 *
 * Invariants:
 * - Snippets compile and run in a node:worker_threads Worker created with resourceLimits
 *   (SANDBOX_HEAP_LIMITS, or the heap fields of the limits a host is created with), and that worker
 *   lives in its own snippet process. V8 recovers some heap exhaustion inside the worker and aborts
 *   the whole process for the rest (a growing Map or object, one huge allocation). Either way only
 *   the snippet process ends: the run faults with snippet.memory, the next run gets a fresh process,
 *   and the host process keeps running.
 * - Main talks to the snippet worker through two FIFOs, one length-prefixed v8-serialized frame
 *   per message. The worker reads and writes with blocking sync calls. Main writes blocking and
 *   reads non-blocking with a deadline (guardMs + STALL_SLACK_MS of silence), since its timers
 *   cannot fire inside a blocking read. Every request carries an id the worker echoes, and an
 *   answer to another request retires the lane. A ctx call is synchronous for the snippet:
 *   the worker writes the call and blocks reading until main writes the reply. Calls carry a
 *   sequence number, so a reply the snippet stopped waiting for is dropped, never misread. Before
 *   a ctx call writes anything the worker checks it has stack to spare, so a frame is never cut.
 * - The snippet process's main thread keeps an event loop: it reports the worker dying as a frame
 *   and runs a watchdog for a worker busy with no ctx call past its wait. A process V8 aborts writes no frame;
 *   main reads EOF and reads the cause from the process's stderr.
 * - ctx stays on main. Snippet processes are pooled per heap limit and reused across runs and
 *   hosts, and retire at an outer-request boundary after LANE_REQUEST_BUDGET requests: a long-lived
 *   Bun process holds its peak heap, and a native crash came from one (A-331). A nested run (a ctx
 *   member that runs another snippet) goes to the same process: its
 *   worker serves the request inside the ctx call it is waiting on, as the in-process vm did.
 *   Processes are unref'd and exit when main closes their FIFOs, exits or is killed.
 * - Every realm starts from an empty object and gets only SANDBOX_GLOBALS. No Date, Intl,
 *   WeakRef, FinalizationRegistry, SharedArrayBuffer, Atomics, process, timers or fetch.
 *   Math.random throws "use ctx.rng". Code generation from strings is off.
 * - test/sandbox.test.ts snapshots `Object.getOwnPropertyNames(globalThis)` inside the
 *   context against SANDBOX_GLOBALS, so a runtime upgrade that adds a global fails `bun run test`.
 * - SNIPPET_LIMITS.ctxCallsPerRun bounds ctx calls; guardMs bounds CPU between them. Node meters
 *   the worker with Worker.cpuUsage. Bun meters the isolated supervisor process synchronously,
 *   conservatively including its worker, supervisor and GC. Host ctx work runs outside that process.
 *   An independent wall backstop stops a stretch after WALL_BACKSTOP_FACTOR times guardMs even if
 *   a CPU sample never resolves. Without CPU sampling, the watchdog uses wall time. Memory limits
 *   only stop runaway allocation, and the default heap runs out in less CPU time than guardMs.
 * - Every run gets a fresh context, and compile checks the source in a throwaway context.
 *   Nothing a snippet does to globals, intrinsic prototypes or the global lexical scope
 *   reaches another run or another snippet.
 * - Wall time also ends a check when a withDeadline scope's instant passes. That check is thrown
 *   away as DeadlineExpired, never judged, so no verdict depends on it.
 * - Snippets see only context-realm values: ctx data, values returned by ctx members and
 *   errors thrown by them are copied into the context. Arguments a snippet passes to ctx
 *   members are copied back as plain host data. A copied error that leaves the run is mapped
 *   back to the original host error. The vm is for determinism; it is not a reviewed security
 *   boundary.
 * - No snippet code runs outside the guard. The result leaves the run as a plain-data copy made
 *   from property descriptors (outOfRealm), so no getter, toJSON or Symbol.hasInstance a snippet
 *   defines ever runs. A result that is not plain data is snippet.runtime_error.
 * - Snippets are synchronous. Any Promise a snippet creates during compile or run faults the run
 *   with snippet.promise_returned. The worker sees each one through a v8 promise hook. The worker
 *   never turns its event loop, so a snippet rejection never reaches any process listener.
 * - No host-realm error reaches a snippet. tick turns every failure into a context-realm error,
 *   argument copies stop at MAX_ARG_DEPTH, and the context-side wrapper replaces any host
 *   object that still escapes (a stack overflow in the bridge) with a context Error.
 * - Snippets run in strict mode.
 */
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { closeSync, constants, mkdtempSync, openSync, readSync, rmSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deserialize, serialize } from 'node:v8';
import {
  SNIPPET_LIMITS,
  SnippetFault,
  type Snippet,
  type SnippetHost,
  type SnippetKind,
  type SnippetKinds,
} from './ctx.ts';
import { assertNever } from '#lib/never';
import { issue, type CheckIssue, type IssuePath } from './issues.ts';

export const SANDBOX_GLOBALS = [
  'Object', 'Array', 'Map', 'Set', 'JSON', 'Math', 'Number', 'String', 'Boolean', 'Symbol',
  'Error', 'TypeError', 'RangeError', 'RegExp', 'BigInt', 'Infinity', 'NaN', 'undefined',
  'isFinite', 'isNaN', 'parseInt', 'parseFloat', 'encodeURIComponent', 'decodeURIComponent', 'globalThis',
] as const;

/**
 * The `Symbol.for` key of the engine's call slot on the context global (A-195). A symbol key keeps the
 * global's own names exactly SANDBOX_GLOBALS. A snippet that finds the slot can only call it unarmed, which throws.
 */
export const ENGINE_CALL_SLOT = 'worldgen:call';

/** Heap limits of the snippet worker, in MB, when a host is created without its own. */
export const SANDBOX_HEAP_LIMITS = {
  maxOldGenerationSizeMb: SNIPPET_LIMITS.maxOldGenerationSizeMb,
  maxYoungGenerationSizeMb: SNIPPET_LIMITS.maxYoungGenerationSizeMb,
} as const;

export type SnippetLimits = {
  readonly ctxCallsPerRun: number;
  readonly guardMs: number;
  readonly maxOldGenerationSizeMb?: number;
  readonly maxYoungGenerationSizeMb?: number;
  /** How long a snippet process may take to start before the host reports `snippet.host_unavailable`. */
  readonly startMs?: number;
};

/** Deepest nesting a ctx argument may have. Stored values are scalars, so real arguments stay shallow. */
export const MAX_ARG_DEPTH = 64;

/**
 * Runs once inside a fresh context. Deletes every global outside the allowlist, makes
 * Math.random throw, and installs the call slot under Symbol.for(internal). Returns the realm helpers.
 */
const SETUP = `'use strict';
((keep, internal, hostFailure) => {
  const g = globalThis;
  const E = Error;
  const OP = Object.prototype;
  const getProto = Object.getPrototypeOf;
  const own = Object.getOwnPropertyDescriptor;
  /** A thrown value whose prototype chain is not this realm's is a host object: replace it. */
  const local = (e) => {
    if ((typeof e !== 'object' || e === null) && typeof e !== 'function') return e;
    for (let o = getProto(e); o !== null; o = getProto(o)) if (o === OP) return e;
    const d = own(e, 'message');
    return new E(d !== undefined && 'value' in d && typeof d.value === 'string' ? hostFailure + ': ' + d.value : hostFailure);
  };
  for (const n of Object.getOwnPropertyNames(g)) if (!keep.includes(n)) delete g[n];
  delete Array.fromAsync;
  Math.random = function random() {
    throw new E('Math.random is not available in world snippets: use ctx.rng');
  };
  Object.freeze(Math);
  let next = null;
  Object.defineProperty(g, Symbol.for(internal), {
    value: () => {
      const n = next;
      next = null;
      return n.fn(n.arg);
    },
    writable: false, enumerable: false, configurable: false,
  });
  return {
    arm(fn, arg) { next = { fn, arg }; },
    wrap(tick) {
      return (...args) => {
        try { return tick(args); } catch (e) { throw local(e); }
      };
    },
    object() { return {}; },
    array() { return []; },
    error(message) { return new E(message); },
  };
})`;

const NOT_A_FUNCTION =
  'Write exactly one function expression, such as (ctx) => { ... }, with nothing before or after it.';
const NOT_DATA = 'ctx arguments must be plain data: strings, numbers, booleans, null, arrays and objects without getters, and no BigInt, symbols, symbol keys or cycles';
const TOO_DEEP = `ctx arguments must be nested at most ${MAX_ARG_DEPTH} levels deep`;
const HOST_FAILURE = 'a ctx call failed';
const RESULT_NOT_DATA =
  'a snippet must return plain data: strings, numbers, booleans, null, arrays and plain objects without getters or functions, and no BigInt, symbols, symbol keys or cycles';
const RESULT_TOO_DEEP = `a snippet result must be nested at most ${MAX_ARG_DEPTH} levels deep`;

/** How long a snippet process may take to start. Generous, because a starved machine starts it slowly. */
const STARTUP_SLACK_MS = 30_000;
/**
 * CPU sampling excludes host ctx work. Node samples the worker; Bun samples the isolated supervisor
 * process. Independently stop a stretch that lasts this many times its CPU budget in wall time.
 */
const WALL_BACKSTOP_FACTOR = 15;
/** How often the snippet process checks its worker for a stuck run. */
const WATCH_MS = 50;
/** How often the snippet process checks that main is still its parent. A main killed mid-start leaves it blocked opening a FIFO nobody will open. */
const PARENT_WATCH_MS = 250;
/** The byte a snippet process writes once it has opened both FIFOs. */
const HELLO = 82;
/** Idle snippet processes kept per heap limit. */
const MAX_IDLE = 4;
/** Requests, nested ones included, a snippet process serves before it is retired at the next outer boundary (A-331). */
export const LANE_REQUEST_BUDGET = 2000;

/**
 * The snippet worker. Plain CommonJS, run with eval. It loops forever on a synchronous receive,
 * so it never turns its event loop. Messages from main: compile and run requests, and call
 * replies. Messages to main: ctx calls and outcomes.
 */
const SNIPPET_WORKER = String.raw`'use strict';
const { workerData } = require('node:worker_threads');
const { readSync, writeSync } = require('node:fs');
const { serialize, deserialize } = require('node:v8');
const { types } = require('node:util');
const { promiseHooks } = require('node:v8');
const { createContext, Script } = require('node:vm');
const { inFd, outFd, sab, wallFactor, setup, keep, internal, hostFailure, maxDepth, texts } = workerData;
/**
 * [token, waitMs], read by the supervisor's watchdog. The token is odd while this worker is busy and
 * goes up by one on each change. The watchdog stops a busy stretch by swapping the token for -1, so
 * a stretch is either finished by the worker or stopped by the watchdog, never both. waitMs is -1
 * once the quota has tripped: the verdict is decided and the watchdog stops the run at once.
 */
const state = new Int32Array(sab);
const releaseWeakRefs = typeof process.versions.bun === 'string' ? require('bun:jsc').releaseWeakRefs : null;
const TIMEOUT_CODE = 'ERR_SCRIPT_EXECUTION_TIMEOUT';
const NOT_PLAIN = Symbol('not plain data');
const TOO_DEEP_DATA = Symbol('nested too deep');
const IN_PROGRESS = Symbol('in progress');
const QUOTA = Symbol('quota');
const setupScript = new Script(setup, { filename: 'worldgen:sandbox-setup' });
const callScript = new Script('globalThis[Symbol.for(' + JSON.stringify(internal) + ')]()', { filename: 'worldgen:snippet-call' });
const scripts = new Map();
/** Sequence number of the last ctx call, across nested runs. */
let seq = 0;
process.on('unhandledRejection', () => {});

function busy(on) {
  const token = Atomics.load(state, 0);
  // Lost to the watchdog: it is reporting this stretch and ending the process.
  if (Atomics.compareExchange(state, 0, token, token + 1) !== token) for (;;) Atomics.wait(state, 0, -1);
}
/** One frame: a 4-byte little-endian length, then the v8-serialized message. Built whole before any write. */
function sendFrame(body) {
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  let off = 0;
  while (off < frame.length) off += writeSync(outFd, frame, off, frame.length - off);
}
let inbox = Buffer.allocUnsafe(1 << 16);
let filled = 0;
/** Blocks until main sends a whole frame. The inbox state survives a throw, so a frame is never half read. */
function receive() {
  for (;;) {
    if (filled >= 4) {
      const len = inbox.readUInt32LE(0);
      if (filled >= 4 + len) {
        const m = deserialize(inbox.subarray(4, 4 + len));
        inbox.copyWithin(0, 4 + len, filled);
        filled -= 4 + len;
        return m;
      }
      if (inbox.length < 4 + len) {
        const bigger = Buffer.allocUnsafe(Math.max(4 + len, inbox.length * 2));
        inbox.copy(bigger, 0, 0, filled);
        inbox = bigger;
      }
    }
    const n = readSync(inFd, inbox, filled, inbox.length - filled, null);
    if (n === 0) process.exit(0); // main closed the lane
    filled += n;
  }
}
/**
 * Uses more stack than one frame exchange needs. Called before a ctx call writes anything, so a
 * snippet that recursed to the stack limit gets its RangeError here, never halfway through a frame.
 */
function headroom(d) {
  return d === 0 ? 0 : headroom(d - 1) + 1;
}
const HEADROOM_FRAMES = 400;

function newRealm() {
  const context = createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
    microtaskMode: 'afterEvaluate',
  });
  return { context, realm: setupScript.runInContext(context)(keep, internal, hostFailure) };
}
function put(target, key, value) {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}
function isPlainShape(value) {
  if (types.isProxy(value)) return false;
  const proto = Object.getPrototypeOf(value);
  if (proto === null) return true;
  const root = Object.getPrototypeOf(proto);
  if (Array.isArray(value)) return Array.isArray(proto) && root !== null && Object.getPrototypeOf(root) === null;
  return root === null;
}
/** Copies a context value into plain data from descriptors only, so no snippet code runs. */
function outOfRealm(value, seen = new Map(), depth = 0) {
  if (typeof value === 'function') return NOT_PLAIN;
  if (typeof value === 'bigint' || typeof value === 'symbol') return NOT_PLAIN;
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return seen.get(value) === IN_PROGRESS ? NOT_PLAIN : seen.get(value);
  if (!isPlainShape(value)) return NOT_PLAIN;
  if (Object.getOwnPropertySymbols(value).length > 0) return NOT_PLAIN;
  if (depth >= maxDepth) return TOO_DEEP_DATA;
  seen.set(value, IN_PROGRESS);
  if (Array.isArray(value)) {
    // Walks indices without listing their names, so a large array costs one copy, not a name per
    // element. Holes stay holes. Named properties on an array are not copied.
    const out = [];
    const len = Object.getOwnPropertyDescriptor(value, 'length').value;
    for (let i = 0; i < len; i++) {
      const d = Object.getOwnPropertyDescriptor(value, i);
      if (d === undefined) continue;
      if (!('value' in d)) return NOT_PLAIN;
      const v = outOfRealm(d.value, seen, depth + 1);
      if (v === NOT_PLAIN || v === TOO_DEEP_DATA) return v;
      out[i] = v;
    }
    out.length = len;
    seen.set(value, out);
    return out;
  }
  const out = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (d === undefined || !('value' in d)) return NOT_PLAIN;
    const v = outOfRealm(d.value, seen, depth + 1);
    if (v === NOT_PLAIN || v === TOO_DEEP_DATA) return v;
    put(out, key, v);
  }
  seen.set(value, out);
  return out;
}
function isHostObject(e) {
  if ((typeof e !== 'object' || e === null) && typeof e !== 'function') return false;
  for (let o = e; o !== null; o = Object.getPrototypeOf(o)) if (o === Object.prototype) return true;
  return false;
}
/**
 * The vm's guard error. Node makes it in the snippet's realm with code as an own data property, Bun
 * a host-realm error whose prototype holds code. Walks prototypes only for a host object, which no
 * snippet can reach, so a snippet getter never runs here.
 */
function isTimeout(e) {
  if (typeof e !== 'object' || e === null) return false;
  let d = Object.getOwnPropertyDescriptor(e, 'code');
  if (d === undefined && isHostObject(e)) {
    for (let o = Object.getPrototypeOf(e); d === undefined && o !== null && o !== Object.prototype; o = Object.getPrototypeOf(o)) {
      d = Object.getOwnPropertyDescriptor(o, 'code');
    }
  }
  return d !== undefined && 'value' in d && d.value === TIMEOUT_CODE;
}
function describeThrown(e) {
  if (typeof e === 'string') return e;
  if ((typeof e === 'object' && e !== null) || typeof e === 'function') {
    const d = Object.getOwnPropertyDescriptor(e, 'message');
    if (d !== undefined && 'value' in d && typeof d.value === 'string') return d.value;
    return 'a thrown value that is not an Error';
  }
  return String(e);
}

/** Whether the runtime has a v8 promise hook. Bun's node:v8 has promiseHooks.onInit but throws "not yet implemented". */
const PROMISE_HOOK = (() => {
  try {
    const stop = promiseHooks.onInit(() => {});
    if (typeof stop === 'function') stop();
    return true;
  } catch {
    return false;
  }
})();

let promiseLog = null;
/**
 * Runs body with a v8 promise hook that logs every Promise a snippet realm creates. A nested run
 * logs to its own list. Without a hook (Bun) body just runs: shadowOf already refused every
 * source that could start async work.
 */
function logPromises(log, body) {
  if (!PROMISE_HOOK) return body();
  const outer = promiseLog;
  promiseLog = log;
  const stop = promiseHooks.onInit((p) => { if (promiseLog !== null && !isHostObject(p)) promiseLog.push(p); });
  try {
    return body();
  } finally {
    stop();
    promiseLog = outer;
  }
}

/**
 * Each word whose keyword use starts async work: async (await is a keyword only inside an async
 * function) and import, for import(). probe is valid wherever the word is an identifier, a property
 * name or text in a literal or comment, and invalid wherever it is the keyword, so swapping one
 * occurrence for it gives the parser's own answer. A fresh identifier probes async and await; import
 * is reserved, and extends is a keyword only right after class. sync is the same-length synchronous
 * text the shadow puts in the keyword's place.
 */
const PROMISE_KEYWORDS = {
  async: { probe: null, sync: '     ' },
  await: { probe: null, sync: 'void ' },
  import: { probe: 'extends', sync: 'Object' },
};
/** Whole-word occurrences. A preceding # or backslash (a private name, an escape) is never the keyword. */
const PROMISE_WORD = /(?<![\p{ID_Continue}$\\#‌‍])(?:async|await|import)(?![\p{ID_Continue}$\\‌‍])/gu;
function wrapSource(source) {
  return "'use strict';(" + source + '\n)';
}
function parses(source) {
  try {
    new Script(wrapSource(source));
    return true;
  } catch {
    return false;
  }
}
/**
 * The source with each async, await and import() keyword replaced by same-length synchronous text
 * (await after for becomes blank), or null when it has none. Parse only: nothing runs. The shadow of
 * one function expression is one function expression, so compile checks its shape without starting
 * async work.
 */
function syncShadow(source) {
  const found = [...source.matchAll(PROMISE_WORD)];
  if (found.length === 0) return null;
  let fresh = '';
  for (let n = 0; fresh === '' || source.includes(fresh); n += 1) fresh = '_' + n.toString(36).padStart(4, '0');
  let shadow = source;
  let changed = false;
  for (const m of found) {
    const word = m[0];
    if (!Object.hasOwn(PROMISE_KEYWORDS, word)) continue;
    const at = m.index;
    const { probe, sync } = PROMISE_KEYWORDS[word];
    if (parses(source.slice(0, at) + (probe ?? fresh) + source.slice(at + word.length))) continue;
    const text = word === 'await' && /\bfor\s*$/.test(source.slice(0, at)) ? '     ' : sync;
    shadow = shadow.slice(0, at) + text + shadow.slice(at + word.length);
    changed = true;
  }
  return changed ? shadow : null;
}
/**
 * Sources with async syntax, to their sync shadow, on a runtime without a promise hook (Bun). There
 * such a source compiles but never runs: each run faults with snippet.promise_returned, as Node's
 * hook would for a run that creates a Promise. With a hook this is null for every source.
 */
const shadows = new Map();
function shadowOf(source) {
  if (PROMISE_HOOK) return null;
  if (!shadows.has(source)) {
    if (shadows.size > 1000) shadows.clear();
    shadows.set(source, syncShadow(source));
  }
  return shadows.get(source);
}

function compile(req) {
  let script;
  try {
    script = new Script(wrapSource(req.source), { filename: 'snippet.js' });
  } catch (e) {
    return { t: 'compile_error', message: describeThrown(e) };
  }
  // Without a promise hook, a source with async syntax never runs: the throwaway context checks
  // its synchronous shadow for shape, and every run of it faults with snippet.promise_returned.
  const shadow = shadowOf(req.source);
  if (shadow !== null) {
    try {
      script = new Script(wrapSource(shadow), { filename: 'snippet.js' });
    } catch {
      return { t: 'promise' };
    }
  }
  // Evaluate in a throwaway context: a source that closes the parenthesis and adds
  // statements runs there, is rejected, and leaves nothing behind.
  const scratch = newRealm();
  const created = [];
  let value;
  try {
    value = logPromises(created, () => script.runInContext(scratch.context, { timeout: req.guardMs * wallFactor }));
  } catch (e) {
    if (isTimeout(e)) return { t: 'timeout' };
    return { t: 'compile_error', message: describeThrown(e) };
  }
  // Only a source that runs code besides its function expression can create a Promise.
  if (created.length > 0 || typeof value !== 'function') return { t: 'compile_error', message: texts.notAFunction };
  const text = Function.prototype.toString.call(value);
  if (text !== (shadow ?? req.source).trim() || /^class\b/.test(text)) return { t: 'compile_error', message: texts.notAFunction };
  if (shadow !== null) return { t: 'compiled' };
  if (scripts.size > 1000) scripts.clear();
  scripts.set(req.source, script);
  return { t: 'compiled' };
}

function run(req) {
  if (shadowOf(req.source) !== null) return { t: 'promise' };
  let script = scripts.get(req.source);
  if (script === undefined) {
    script = new Script("'use strict';(" + req.source + '\n)', { filename: 'snippet.js' });
    scripts.set(req.source, script);
  }
  // A fresh context per run. The source is exactly one function expression, so evaluating it
  // here only creates the function.
  const { context, realm } = newRealm();
  const fn = script.runInContext(context, { timeout: req.guardMs * wallFactor });
  let calls = 0;
  let active = true;
  let quota = false;
  /** Context-realm copies of host errors, mapped to their id on main (or QUOTA). Id -1 is a bridge failure with no host error. */
  const thrown = new Map();
  const throwCopy = (message, name, fields, id) => {
    const copy = realm.error(message);
    if (typeof name === 'string' && name !== 'Error') put(copy, 'name', name);
    for (const [k, v] of fields) put(copy, k, v);
    // A quota error is told apart by the quota flag, so a snippet that catches it and keeps calling cannot grow this map.
    if (id !== -1 && id !== QUOTA) thrown.set(copy, id);
    throw copy;
  };
  /** Rebuilds a main-thread value in the realm; placeholders listed in marks become counted wrappers. */
  const intoRealm = (enc) => {
    const ids = new Map();
    enc.marks.forEach((m, i) => ids.set(m, enc.base + i));
    const seen = new Map();
    const into = (v) => {
      if (typeof v !== 'object' || v === null) return v;
      const id = ids.get(v);
      if (id !== undefined) return realm.wrap((args) => tick(id, args));
      const known = seen.get(v);
      if (known !== undefined) return known;
      const out = Array.isArray(v) ? realm.array() : realm.object();
      seen.set(v, out);
      if (Array.isArray(v)) v.forEach((x, i) => put(out, String(i), into(x)));
      else for (const k of Object.keys(v)) put(out, k, into(v[k]));
      return out;
    };
    return into(enc.value);
  };
  const call = (id, args) => {
    if (!active) throw realm.error('ctx was used after its snippet run ended');
    calls += 1;
    if (calls > req.limit) {
      quota = true;
      Atomics.store(state, 1, -1);
      return throwCopy(req.quotaMessage, 'SnippetFault', [], QUOTA);
    }
    const hostArgs = args.map((a) => outOfRealm(a));
    if (hostArgs.includes(NOT_PLAIN)) throw realm.error(texts.notData);
    if (hostArgs.includes(TOO_DEEP_DATA)) throw realm.error(texts.tooDeep);
    headroom(HEADROOM_FRAMES);
    seq += 1;
    const mine = seq;
    let frame;
    try {
      frame = serialize({ t: 'call', seq: mine, id, args: hostArgs });
    } catch {
      throw realm.error(texts.notData);
    }
    busy(false);
    sendFrame(frame);
    let r;
    for (;;) {
      r = receive();
      // A ctx member on main may run another snippet: that request is served here, nested.
      if (r.t === 'compile' || r.t === 'run') serve(r, true);
      else if (r.t === 'ret' && r.seq === mine) break;
    }
    busy(true);
    if (r.ok) return intoRealm(r.value);
    if (r.err !== undefined) return throwCopy(r.err.message, r.err.name, r.err.fields, r.err.id);
    throw r.prim;
  };
  // Every failure leaves tick as a context-realm error. A host error that still gets out
  // (the stack overflowing inside this bridge) is replaced by the context-side wrapper.
  const tick = (id, args) => {
    try {
      return call(id, args);
    } catch (e) {
      if (isHostObject(e)) throw realm.error(hostFailure + ': ' + describeThrown(e));
      throw e;
    }
  };
  realm.arm(fn, intoRealm(req.ctx));
  const created = [];
  let result;
  try {
    // No vm timeout here: it would count time spent waiting on ctx replies, which grows with host
    // load. The watchdog stops a stretch of guardMs with no ctx call; the quota stops the rest.
    result = logPromises(created, () => callScript.runInContext(context));
  } catch (e) {
    if (quota) return { t: 'quota' };
    if (((typeof e === 'object' && e !== null) || typeof e === 'function') && thrown.has(e)) {
      const id = thrown.get(e);
      return id === QUOTA ? { t: 'quota' } : { t: 'host_error', id };
    }
    return { t: 'runtime_error', message: describeThrown(e) };
  } finally {
    active = false;
  }
  if (quota) return { t: 'quota' };
  // types.isPromise is a brand check: instanceof would run a snippet's Symbol.hasInstance.
  if (created.length > 0 || types.isPromise(result)) return { t: 'promise' };
  const copy = outOfRealm(result);
  if (copy === NOT_PLAIN) return { t: 'runtime_error', message: texts.resultNotData };
  if (copy === TOO_DEEP_DATA) return { t: 'runtime_error', message: texts.resultTooDeep };
  return { t: 'done', value: copy };
}

/** Answers one compile or run request. Called from the main loop, or nested while a run waits on a ctx call. */
function serve(req, nested) {
  const outerWait = Atomics.load(state, 1);
  // The watchdog meters CPU time against guardMs for both. A compile's vm timeout is only a wall backstop.
  Atomics.store(state, 1, req.guardMs);
  busy(true);
  let out;
  try {
    out = req.t === 'compile' ? compile(req) : run(req);
  } catch (e) {
    out = { t: 'runtime_error', message: describeThrown(e) };
  }
  // Nested requests resume a suspended realm; finish its keepalive only after the outer request ends.
  if (!nested && releaseWeakRefs !== null) releaseWeakRefs();
  Atomics.store(state, 1, outerWait);
  busy(false);
  const rid = req.rid;
  let frame;
  try {
    frame = serialize({ ...out, rid });
  } catch {
    frame = serialize({ t: 'runtime_error', message: texts.resultNotData, rid });
  }
  sendFrame(frame);
}

for (;;) {
  const req = receive();
  if (req.t === 'compile' || req.t === 'run') serve(req, false); // anything else is a stale call reply
}
`;

/**
 * The snippet process: run with `-e` on the running runtime, it opens the two FIFOs, says hello, and starts the
 * snippet worker with resourceLimits. Its own thread keeps an event loop, so it hears the worker
 * die and reports it as a 'dead' frame, then exits. A watchdog reports a worker that stays busy
 * past its wait (guardMs for a run, guardMs + slack for a compile) with no ctx call as stuck. When main closes the lane the worker reads EOF
 * and the process exits. It opens the FIFOs asynchronously and checks its parent every
 * PARENT_WATCH_MS and kills itself with SIGKILL when main is gone: a main killed before it opened the other
 * ends leaves a threadpool thread blocked in open(), and process.exit would wait for that thread forever.
 */
const SUPERVISOR = String.raw`'use strict';
const { open, writeSync } = require('node:fs');
const { serialize } = require('node:v8');
const { Worker } = require('node:worker_threads');
const [inPath, outPath, config] = process.argv.slice(1);
const { limits, code, data, parent } = JSON.parse(config);
setInterval(() => { if (process.ppid !== parent) process.kill(process.pid, 'SIGKILL'); }, ${PARENT_WATCH_MS});
open(inPath, 'r', (e1, inFd) => {
  if (e1) process.exit(1);
  open(outPath, 'w', (e2, outFd) => {
    if (e2) process.exit(1);
    serve(inFd, outFd);
  });
});
function serve(inFd, outFd) {
writeSync(outFd, Buffer.from([${HELLO}]));
const sab = new SharedArrayBuffer(8);
const state = new Int32Array(sab);
const w = new Worker(code, { eval: true, execArgv: [], resourceLimits: limits, workerData: { ...data, inFd, outFd, sab } });
let told = false;
const tell = (reason, message) => {
  if (told) return;
  told = true;
  try {
    const body = serialize({ t: 'dead', reason, message });
    const frame = Buffer.allocUnsafe(4 + body.length);
    frame.writeUInt32LE(body.length, 0);
    body.copy(frame, 4);
    let off = 0;
    while (off < frame.length) off += writeSync(outFd, frame, off, frame.length - off);
  } catch {}
  process.exit(0);
};
w.on('error', (e) => tell(e && e.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'memory' : 'crash', String(e && e.message)));
w.on('exit', (c) => tell('crash', 'the snippet worker exited with code ' + c));
let seen = 0;
let since = 0;
let cpuAtStart = 0;
let polling = false;
const processMetered = typeof process.versions.bun === 'string';
const metered = processMetered || typeof w.cpuUsage === 'function';
const cpuUs = async () => { const u = processMetered ? process.cpuUsage() : await w.cpuUsage(); return u.user + u.system; };
let wallSeen = 0;
let wallSince = 0;
/** Stops the stretch that began at token when it has used its CPU budget, or has outlasted the wall backstop. */
const watch = async () => {
  const token = Atomics.load(state, 0);
  if (token % 2 !== 1) return;
  const waitMs = Atomics.load(state, 1);
  if (waitMs < 0) {
    if (Atomics.compareExchange(state, 0, token, -1) === token) tell('quota', 'the ctx call quota tripped and the snippet kept running');
    return;
  }
  const now = performance.now();
  if (token !== seen) {
    seen = token;
    since = now;
    cpuAtStart = metered ? await cpuUs() : 0;
    return;
  }
  const spentMs = metered ? ((await cpuUs()) - cpuAtStart) / 1000 : now - since;
  if (spentMs <= waitMs && now - since <= waitMs * ${WALL_BACKSTOP_FACTOR}) return;
  if (Atomics.compareExchange(state, 0, token, -1) !== token) return;
  tell('stuck', metered && spentMs > waitMs ? (processMetered ? 'the snippet supervisor process' : 'the snippet worker') + ' used more than ' + waitMs + ' ms of CPU without a ctx call' : 'no answer from the snippet worker within ' + waitMs * ${WALL_BACKSTOP_FACTOR} + ' ms');
};
setInterval(() => {
  const token = Atomics.load(state, 0);
  if (token % 2 === 1) {
    const waitMs = Atomics.load(state, 1);
    const now = performance.now();
    if (waitMs < 0) {
      if (Atomics.compareExchange(state, 0, token, -1) === token) tell('quota', 'the ctx call quota tripped and the snippet kept running');
    } else if (token !== wallSeen) {
      wallSeen = token;
      wallSince = now;
    } else if (now - wallSince > waitMs * ${WALL_BACKSTOP_FACTOR}) {
      if (Atomics.compareExchange(state, 0, token, -1) === token) tell('stuck', 'no answer from the snippet worker within ' + waitMs * ${WALL_BACKSTOP_FACTOR} + ' ms');
    }
  }
  if (polling) return;
  polling = true;
  watch().catch(() => {}).finally(() => { polling = false; });
}, ${WATCH_MS});
}
`;

/** One snippet process. Main writes frames to toChild and reads frames from fromChild, both blocking. */
interface Lane {
  readonly key: string;
  readonly child: ChildProcess;
  readonly toChild: number;
  readonly fromChild: number;
  /** The snippet process's stderr, an unlinked file: a fatal V8 out-of-memory leaves its message here. */
  readonly errFd: number;
  /** How the lane ended, told to every run still waiting on it (an outer run whose nested run died). */
  death: Outcome | undefined;
  /** Requests served so far, outer and nested. */
  served: number;
}

type Heap = { readonly maxOldGenerationSizeMb: number; readonly maxYoungGenerationSizeMb: number; readonly startMs: number };

/** What the worker sends main. */
type Outcome =
  | { t: 'call'; seq: number; id: number; args: unknown[] }
  | { t: 'compiled' }
  | { t: 'compile_error'; message: string }
  | { t: 'timeout' }
  | { t: 'quota' }
  | { t: 'promise' }
  | { t: 'host_error'; id: number }
  | { t: 'runtime_error'; message: string }
  | { t: 'done'; value: unknown }
  | { t: 'dead'; reason: 'memory' | 'crash' | 'stuck' | 'quota' | 'start' | 'aborted'; message: string };

const idle = new Map<string, Lane[]>();
let started = 0;
const nap = new Int32Array(new SharedArrayBuffer(4));
/** The open withDeadline scope: an instant on the performance.now() timeline, and whether it has passed. */
let deadline: { readonly atMs: number; hit: boolean } | null = null;
/** True once the open scope's instant has passed. Sticky, so a hit scope's result is always discarded. */
function pastDeadline(): boolean {
  if (deadline === null) return false;
  if (!deadline.hit && performance.now() >= deadline.atMs) deadline.hit = true;
  return deadline.hit;
}
const ABORTED: Outcome = { t: 'dead', reason: 'aborted', message: 'the run deadline passed' };
/** What V8 prints when it aborts the process on heap exhaustion (near-limit, CALL_AND_RETRY_LAST, invalid table size). */
const FATAL_OOM = /out of memory|Reached heap limit|Allocation failed/i;

/** How many snippet processes this process has started. A reused one is not counted again. */
export function snippetWorkersStarted(): number {
  return started;
}

/** Waits for the hello byte on a non-blocking FIFO end. False when the process does not start in time. */
function awaitHello(fd: number, waitMs: number): boolean {
  const one = Buffer.alloc(1);
  const end = performance.now() + waitMs;
  for (;;) {
    try {
      if (readSync(fd, one, 0, 1, null) === 1) return one[0] === HELLO;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EAGAIN') return false;
    }
    if (performance.now() > end || pastDeadline()) return false;
    Atomics.wait(nap, 0, 0, 2);
  }
}

/**
 * Starts a snippet process joined to main by two FIFOs. Main first holds each FIFO by an end that
 * opens without blocking (O_RDWR, O_RDONLY|O_NONBLOCK), so a process that dies before it opens them
 * cannot hang main. After the hello it reopens the write end as a plain blocking end and the read
 * end non-blocking, so the process dying reads as EOF.
 */
function startLane(heap: Heap, key: string): Lane {
  const dir = mkdtempSync(join(tmpdir(), 'worldgen-snippet-'));
  const inPath = join(dir, 'in');
  const outPath = join(dir, 'out');
  const holds: number[] = [];
  try {
    execFileSync('mkfifo', [inPath, outPath]);
    const errFd = openSync(join(dir, 'err'), 'w+');
    const config = {
      limits: { ...heap },
      parent: process.pid,
      code: SNIPPET_WORKER,
      data: {
        wallFactor: WALL_BACKSTOP_FACTOR,
        setup: SETUP,
        keep: [...SANDBOX_GLOBALS],
        internal: ENGINE_CALL_SLOT,
        hostFailure: HOST_FAILURE,
        maxDepth: MAX_ARG_DEPTH,
        texts: { notAFunction: NOT_A_FUNCTION, notData: NOT_DATA, tooDeep: TOO_DEEP, resultNotData: RESULT_NOT_DATA, resultTooDeep: RESULT_TOO_DEEP },
      },
    };
    const child = spawn(process.execPath, ['-e', SUPERVISOR, inPath, outPath, JSON.stringify(config)], {
      stdio: ['ignore', 'ignore', errFd],
      env: { TZ: 'UTC' },
    });
    child.on('error', () => {});
    child.unref();
    started += 1;
    holds.push(openSync(inPath, constants.O_RDWR), openSync(outPath, constants.O_RDONLY | constants.O_NONBLOCK));
    if (!awaitHello(holds[1]!, heap.startMs)) {
      const lane: Lane = { key, child, toChild: -1, fromChild: -1, errFd, death: undefined, served: 0 };
      kill(lane, { t: 'dead', reason: 'start', message: `the snippet process did not start within ${heap.startMs} ms` });
      return lane;
    }
    return { key, child, toChild: openSync(inPath, constants.O_WRONLY), fromChild: openSync(outPath, constants.O_RDONLY | constants.O_NONBLOCK), errFd, death: undefined, served: 0 };
  } finally {
    for (const fd of holds) closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
  }
}

function kill(lane: Lane, death: Outcome): void {
  if (lane.death !== undefined) return;
  lane.death = death;
  for (const fd of [lane.toChild, lane.fromChild, lane.errFd]) {
    if (fd < 0) continue;
    try {
      closeSync(fd);
    } catch {
      // already closed
    }
  }
  lane.child.kill('SIGKILL');
}

function acquire(heap: Heap, key: string): Lane {
  const list = idle.get(key) ?? [];
  for (let lane = list.pop(); lane !== undefined; lane = list.pop()) {
    if (lane.child.exitCode === null && lane.child.signalCode === null) return lane;
    kill(lane, { t: 'dead', reason: 'crash', message: 'the snippet process exited while idle' });
  }
  return startLane(heap, key);
}

function release(lane: Lane): void {
  if (lane.death !== undefined) return;
  const list = idle.get(lane.key) ?? [];
  idle.set(lane.key, list);
  if (list.length < MAX_IDLE && lane.served < LANE_REQUEST_BUDGET) list.push(lane);
  else kill(lane, { t: 'dead', reason: 'crash', message: 'the snippet process was retired' });
}

/** Writes one frame. Throws only when the message cannot be serialized; a dead process shows up as EOF on the next receive. */
function post(lane: Lane, message: unknown): void {
  const body = serialize(message);
  const frame = Buffer.allocUnsafe(4 + body.length);
  frame.writeUInt32LE(body.length, 0);
  body.copy(frame, 4);
  if (lane.death !== undefined) return; // its fds are closed and their numbers may be reused
  try {
    for (let off = 0; off < frame.length; ) off += writeSync(lane.toChild, frame, off, frame.length - off);
  } catch {
    // EPIPE: the snippet process is gone.
  }
}

/** How long past a run's wall backstop the host waits for the worker's next bytes before it retires the lane. */
const STALL_SLACK_MS = 5_000;
/** Failed reads in a row before the host starts sleeping between polls. */
const SPIN_POLLS = 64;
/**
 * The first and the longest sleep between polls. Each sleep doubles up to the longest, so a reply
 * waits at most about as long again as it took to arrive, and a wait on a slow reply settles into
 * one wakeup per LONGEST_NAP_MS. A fixed 1 ms sleep made each ctx call that missed the spin cost
 * about 1.5 ms when most replies arrive within 0.3 ms.
 */
const FIRST_NAP_MS = 0.02;
const LONGEST_NAP_MS = 1;

/**
 * Reads exactly n bytes from a non-blocking fd. 'eof' when the writer is gone, 'stalled' when no
 * byte arrives for waitMs, 'aborted' when stop() says so while it waits. The host is
 * single-threaded and its timers cannot fire while it blocks in a read, so a wait on a worker that
 * will never answer has to carry its own deadline.
 */
export function readExact(fd: number, n: number, waitMs: number, stop: () => boolean = () => false): Buffer | 'eof' | 'stalled' | 'aborted' {
  const buf = Buffer.allocUnsafe(n);
  let idle = 0;
  let napMs = FIRST_NAP_MS;
  let end = performance.now() + waitMs;
  for (let got = 0; got < n; ) {
    let r: number;
    try {
      r = readSync(fd, buf, got, n - got, null);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code !== 'EAGAIN' && code !== 'EINTR') return 'eof';
      if (stop()) return 'aborted';
      if (performance.now() > end) return 'stalled';
      if ((idle += 1) > SPIN_POLLS) {
        Atomics.wait(nap, 0, 0, napMs);
        napMs = Math.min(napMs * 2, LONGEST_NAP_MS);
      }
      continue;
    }
    if (r === 0) return 'eof';
    got += r;
    idle = 0;
    napMs = FIRST_NAP_MS;
    end = performance.now() + waitMs;
  }
  return buf;
}

/** Blocks until the snippet process sends a frame, dies, or stays silent past waitMs. */
function receive(lane: Lane, waitMs: number): Outcome {
  if (lane.death === undefined && pastDeadline()) kill(lane, ABORTED);
  if (lane.death !== undefined) return lane.death;
  const head = readExact(lane.fromChild, 4, waitMs, pastDeadline);
  const body = typeof head === 'string' ? head : readExact(lane.fromChild, head.readUInt32LE(0), waitMs, pastDeadline);
  if (body === 'aborted') {
    kill(lane, ABORTED);
    return ABORTED;
  }
  if (body === 'stalled') {
    const death: Outcome = { t: 'dead', reason: 'stuck', message: `no answer from the snippet worker within ${waitMs} ms` };
    kill(lane, death);
    return death;
  }
  if (body === 'eof' || head === 'eof') return died(lane);
  const m = deserialize(body) as Outcome;
  if (m.t === 'dead') kill(lane, m);
  return m;
}

/** The snippet process ended without a frame. Its bounded stderr report retains the crash cause. */
function died(lane: Lane): Outcome {
  const buf = Buffer.alloc(16_384);
  let text = '';
  try {
    text = buf.toString('utf8', 0, readSync(lane.errFd, buf, 0, buf.length, 0));
  } catch {
    // no stderr to read
  }
  const report = text.trim() || 'no output';
  const death: Outcome = FATAL_OOM.test(text)
    ? { t: 'dead', reason: 'memory', message: 'out of memory' }
    : { t: 'dead', reason: 'crash', message: `the snippet process exited: ${report}` };
  kill(lane, death);
  return death;
}

/** A function reachable from ctx, with the object it is called on. */
type Member = { readonly owner: unknown; readonly fn: Function };
/** A value encoded for the worker: functions replaced by placeholder objects listed in marks. */
type Encoded = { value: unknown; marks: object[]; base: number };

/**
 * Encodes a host value as plain data for the worker. Members are own and inherited names, so
 * class instances keep their methods. Each function becomes a placeholder, registered in members
 * with its owner, that the worker turns into a counted wrapper.
 */
function encode(value: unknown, members: Member[]): Encoded {
  const base = members.length;
  const marks: object[] = [];
  const mark = (owner: unknown, fn: Function): object => {
    const placeholder = {};
    members.push({ owner, fn });
    marks.push(placeholder);
    return placeholder;
  };
  const seen = new Map<object, unknown>();
  const into = (v: unknown): unknown => {
    if (typeof v === 'function') return mark(undefined, v);
    if (typeof v === 'symbol') return undefined;
    if (typeof v !== 'object' || v === null) return v;
    if (seen.has(v)) return seen.get(v);
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      seen.set(v, out);
      v.forEach((x: unknown, i) => put(out, String(i), into(x)));
      return out;
    }
    const out = {};
    seen.set(v, out);
    for (const name of memberNames(v)) {
      const x: unknown = (v as Record<string, unknown>)[name];
      put(out, name, typeof x === 'function' ? mark(v, x) : into(x));
    }
    return out;
  };
  return { value: into(value), marks, base };
}

/** The reply to a ctx call: the encoded return value, or the thrown error as an id plus a description. */
function answer(lane: Lane, call: { seq: number; id: number; args: unknown[] }, members: Member[], errors: unknown[]): void {
  let reply: Record<string, unknown>;
  try {
    const m = members[call.id];
    if (m === undefined) throw new Error('unknown ctx member');
    reply = { t: 'ret', seq: call.seq, ok: true, value: encode(Reflect.apply(m.fn, m.owner, call.args), members) };
  } catch (e) {
    reply = { t: 'ret', seq: call.seq, ok: false, ...describeError(e, errors) };
  }
  try {
    post(lane, reply);
  } catch (e) {
    post(lane, { t: 'ret', seq: call.seq, ok: false, err: { id: -1, message: `${HOST_FAILURE}: ${describeThrown(e)}`, fields: [] } });
  }
}

/** An error crosses as an id into errors plus message, name and own primitive fields such as status. */
function describeError(e: unknown, errors: unknown[]): { err: unknown } | { prim: unknown } {
  if ((typeof e !== 'object' || e === null) && typeof e !== 'function') return { prim: typeof e === 'symbol' ? String(e) : e };
  errors.push(e);
  const fields: [string, unknown][] = [];
  for (const key of Object.getOwnPropertyNames(e)) {
    if (key === 'message' || key === 'stack' || key === 'name') continue;
    const d = Object.getOwnPropertyDescriptor(e, key);
    if (d !== undefined && 'value' in d && (d.value === null || typeof d.value !== 'object') && typeof d.value !== 'function' && typeof d.value !== 'symbol') {
      fields.push([key, d.value]);
    }
  }
  const name: unknown = (e as { name?: unknown }).name;
  return { err: { id: errors.length - 1, message: describeThrown(e), name: typeof name === 'string' ? name : undefined, fields } };
}

/** Lanes with a request in flight, innermost last. */
const active: Lane[] = [];
/** Id of the last request posted. The worker echoes it, so an answer can be matched to its request. */
let nextRequest = 0;

/** Thrown by withDeadline when its instant passes during a check. Not a SnippetFault: it carries no issue and is never judged. */
export class DeadlineExpired extends Error {
  override readonly name = 'DeadlineExpired';
  constructor() {
    super('the run deadline passed before the check finished');
  }
}

/**
 * Runs fn, which must be synchronous, with every snippet exchange bounded by atMs (performance.now()
 * timeline). If the instant passes while a snippet runs or is about to run, the snippet process is
 * killed, every later snippet fails at once, and this throws DeadlineExpired instead of returning
 * fn's result or rethrowing its error. If fn finishes without hitting the instant, its result is
 * returned unchanged.
 */
export function withDeadline<T>(atMs: number, fn: () => T): T {
  const outer = deadline;
  const scope = { atMs: Math.min(atMs, outer?.atMs ?? Infinity), hit: false };
  deadline = scope;
  let out: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    out = { ok: true, value: fn() };
  } catch (error) {
    out = { ok: false, error };
  } finally {
    deadline = outer;
  }
  if (scope.hit) {
    if (outer !== null) outer.hit = true;
    throw new DeadlineExpired();
  }
  if (!out.ok) throw out.error;
  return out.value;
}

/**
 * Sends one request and serves ctx calls until the worker answers it. A request made while a ctx
 * call is being served (a ctx member that runs another snippet) goes to the same lane, whose worker
 * serves it nested inside the waiting call, so nesting never waits for a process to start.
 */
function exchange(heap: Heap, request: object, members: Member[], errors: unknown[]): Outcome {
  if (pastDeadline()) return ABORTED;
  const key = `${heap.maxOldGenerationSizeMb}/${heap.maxYoungGenerationSizeMb}`;
  const outer = active.at(-1);
  const nested = outer !== undefined && outer.key === key && outer.death === undefined;
  const lane = nested ? outer : acquire(heap, key);
  active.push(lane);
  lane.served += 1;
  const rid = (nextRequest += 1);
  const waitMs = (request as { guardMs: number }).guardMs * WALL_BACKSTOP_FACTOR + STALL_SLACK_MS;
  try {
    post(lane, { ...request, rid });
    for (;;) {
      const m = receive(lane, waitMs);
      if (m.t === 'call') {
        answer(lane, m, members, errors);
        continue;
      }
      if (m.t === 'dead' || (m as { rid?: number }).rid === rid) return m;
      // The outer run's no-call guard expired while the worker served this nested request: the
      // termination cut the nested answer, and the frame that arrived is the outer run's. Nothing
      // more will come for this request, so waiting on the lane would block forever.
      kill(lane, { t: 'dead', reason: 'stuck', message: 'the snippet worker abandoned a nested run when its outer run timed out' });
      return lane.death as Outcome;
    }
  } finally {
    active.pop();
    if (!nested) release(lane);
  }
}

/**
 * How many times SNIPPET_LIMITS.guardMs the default host allows (A-169). A slow shared host such as a
 * CI runner sets WORLDGEN_GUARD_SCALE, because the guard meters CPU and Bun's supervisor includes its
 * own GC. Unset, below 1 or not a number gives 1, so a developer machine keeps the 2000 ms guard.
 */
export function guardScale(env: Readonly<Record<string, string | undefined>> = process.env): number {
  const v = Number(env['WORLDGEN_GUARD_SCALE']);
  return Number.isFinite(v) && v >= 1 ? v : 1;
}

export function createVmHost(limits: SnippetLimits = { ...SNIPPET_LIMITS, guardMs: SNIPPET_LIMITS.guardMs * guardScale() }): SnippetHost {
  const heap: Heap = {
    maxOldGenerationSizeMb: limits.maxOldGenerationSizeMb ?? SANDBOX_HEAP_LIMITS.maxOldGenerationSizeMb,
    maxYoungGenerationSizeMb: limits.maxYoungGenerationSizeMb ?? SANDBOX_HEAP_LIMITS.maxYoungGenerationSizeMb,
    startMs: limits.startMs ?? STARTUP_SLACK_MS,
  };
  const { guardMs, ctxCallsPerRun } = limits;
  return {
    compile<K extends SnippetKind>(
      _kind: K,
      source: string,
      path: IssuePath,
    ): { ok: true; run: Snippet<K> } | { ok: false; issue: CheckIssue } {
      const found = excerpt(source);
      const compileError = (message: string) => ({ ok: false as const, issue: issue('snippet.compile_error', path, { message }, found) });
      const out = exchange(heap, { t: 'compile', source, guardMs }, [], []);
      if (out.t === 'dead' && out.reason === 'aborted') throw new DeadlineExpired();
      if (out.t === 'compile_error') return compileError(out.message);
      if (out.t === 'promise') return { ok: false, issue: issue('snippet.promise_returned', path, {}, found) };
      if (out.t === 'timeout' || (out.t === 'dead' && out.reason === 'stuck')) {
        const reason = out.t === 'dead' ? out.message : `used ${guardMs} ms of CPU without a ctx call`;
        return { ok: false, issue: issue('snippet.timeout_guard', path, { ms: guardMs }, `${found}: ${reason}`) };
      }
      const unavailable = (): CheckIssue => issue('snippet.host_unavailable', path, { ms: heap.startMs }, `${found} not run: the snippet process did not start within ${heap.startMs} ms`);
      if (out.t === 'dead' && out.reason === 'start') return { ok: false, issue: unavailable() };
      const memoryIssue = issue('snippet.memory', path, { mb: heap.maxOldGenerationSizeMb }, 'ran out of memory');
      if (out.t === 'dead' && out.reason === 'memory') return { ok: false, issue: memoryIssue };
      if (out.t === 'dead') return compileError(out.message);
      if (out.t !== 'compiled') return compileError(NOT_A_FUNCTION);

      const quotaIssue = issue('snippet.call_quota', path, { limit: ctxCallsPerRun }, `more than ${ctxCallsPerRun} ctx calls`);
      const quotaMessage = new SnippetFault(quotaIssue).message;
      const runtimeFault = (message: string, found: string): SnippetFault =>
        new SnippetFault(issue('snippet.runtime_error', path, { message }, found));
      const runOnce = (ctx: SnippetKinds[K]['ctx']): unknown => {
        const members: Member[] = [];
        const errors: unknown[] = [];
        const request = { t: 'run', source, guardMs, limit: ctxCallsPerRun, quotaMessage, ctx: encode(ctx, members) };
        const res = exchange(heap, request, members, errors);
        switch (res.t) {
          case 'done':
            return res.value;
          case 'quota':
            throw new SnippetFault(quotaIssue);
          case 'host_error':
            throw errors[res.id];
          case 'promise':
            throw new SnippetFault(issue('snippet.promise_returned', path, {}, 'a Promise'));
          case 'timeout':
            throw new SnippetFault(issue('snippet.timeout_guard', path, { ms: guardMs }, `used ${guardMs} ms of CPU without a ctx call`));
          case 'runtime_error':
          case 'compile_error':
            throw runtimeFault(res.message, res.message === RESULT_NOT_DATA || res.message === RESULT_TOO_DEEP ? `returned ${res.message}` : `threw ${res.message}`);
          case 'dead':
            if (res.reason === 'aborted') throw new DeadlineExpired();
            if (res.reason === 'stuck') {
              throw new SnippetFault(issue('snippet.timeout_guard', path, { ms: guardMs }, res.message));
            }
            if (res.reason === 'memory') throw new SnippetFault(memoryIssue);
            if (res.reason === 'quota') throw new SnippetFault(quotaIssue);
            if (res.reason === 'start') throw new SnippetFault(unavailable());
            throw runtimeFault(res.message, `threw ${res.message}`);
          case 'compiled':
          case 'call':
            throw runtimeFault(`unexpected answer from the snippet worker: ${res.t}`, 'no result');
          default:
            return assertNever(res);
        }
      };
      return { ok: true, run: runOnce as Snippet<K> };
    },
  };
}

/** Defines a data property without running setters on the target's prototype chain. */
function put(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * Own and inherited member names. Covers plain objects and class instances. The walk stops at
 * any realm's Object.prototype (a prototype whose own prototype is null), so an object made in
 * another realm does not bring that realm's hasOwnProperty, __proto__ and so on along.
 */
function memberNames(obj: object): readonly string[] {
  const names = new Set<string>(Object.getOwnPropertyNames(obj));
  for (let o = Object.getPrototypeOf(obj) as object | null; o !== null && Object.getPrototypeOf(o) !== null; o = Object.getPrototypeOf(o) as object | null) {
    for (const n of Object.getOwnPropertyNames(o)) if (n !== 'constructor') names.add(n);
  }
  return [...names];
}

/** The message of a thrown value, read without running getters or toString. */
function describeThrown(e: unknown): string {
  if (typeof e === 'string') return e;
  if ((typeof e === 'object' && e !== null) || typeof e === 'function') {
    const d = Object.getOwnPropertyDescriptor(e, 'message');
    if (d !== undefined && 'value' in d && typeof d.value === 'string') return d.value;
    return 'a thrown value that is not an Error';
  }
  return String(e);
}

function excerpt(source: string): string {
  const line = source.trim().split('\n')[0] ?? '';
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}
