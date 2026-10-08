import { existsSync } from 'node:fs';
/**
 * Red-team harness: capability probe, seeded PRNG, ddmin, freezing, and an HTTP harness
 * around `npm run worldplay -- serve`.
 *
 * Capabilities. Importing this module probes every capability in CAPABILITY_UNITS once:
 * #engine functions and Runtime methods with minimal arguments, each check layer with the
 * mutation row that only that layer refuses, plus placeholder fields in the base report.
 * A capability is a stub when it throws Error('not implemented') or shows another stub
 * marker (a pass-through check layer, an empty seeded state, a 501 `action.unavailable`),
 * and absent when its export or CLI file does not exist. `cap(name)` then returns
 * `{ skip: 'unit <unit> not landed: <name> <evidence>' }`. A capability the probe cannot
 * reach because the base world fails for another reason is blocked, and skipped with that
 * reason. With REDTEAM_STRICT=1 nothing is ever skipped. CLI capabilities spawn a process,
 * so they are probed only when a test file awaits `probeCli()`.
 *
 * Env: REDTEAM_SEED (default 1), REDTEAM_ITER (default 25), REDTEAM_STRICT=1.
 */
import { spawn } from 'node:child_process';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AssertionError } from 'node:assert';
import type { TestOptions } from 'node:test';
import * as engine from '#engine';
import type { CheckedWorld, CheckLayer, CheckReport, IssueCode, Runtime, World } from '#engine';
import { MUTATIONS } from './mutations.ts';
import { baseWorld } from './world.ts';

// ---------------------------------------------------------------------------------------
// Env

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw new Error(`${name} must be an integer, got ${raw}`);
  return n;
}
export const SEED = envInt('REDTEAM_SEED', 1);
export const ITER = envInt('REDTEAM_ITER', 25);
export const STRICT = process.env['REDTEAM_STRICT'] === '1';

export const CODE_DIR = fileURLToPath(new URL('../../', import.meta.url));
/** Engine CLI per A-52 (U-7): `worldplay`; falls back to the pre-rename `world.ts` until the CLI unit lands. */
/** True when the suite runs under Bun (U-12); child processes then run .ts directly instead of via tsx. */
export const IS_BUN = typeof process.versions['bun'] === 'string';
/** Runtime-neutral argv for running a TS entry file in a child process. */
export function tsEntryArgs(file: string, rest: readonly string[] = []): string[] {
  return IS_BUN ? [file, ...rest] : ['--import', 'tsx', file, ...rest];
}
/** Runtime-neutral argv for evaluating a TS/ESM module string in a child process. */
export function tsEvalArgs(script: string, rest: readonly string[] = []): string[] {
  return IS_BUN ? ['-e', script, ...rest] : ['--import', 'tsx', '--input-type=module', '-e', script, ...rest];
}

export const CLI_PATH = existsSync(join(CODE_DIR, 'src', 'cli', 'worldplay.ts'))
  ? join(CODE_DIR, 'src', 'cli', 'worldplay.ts')
  : join(CODE_DIR, 'src', 'cli', 'world.ts');

// ---------------------------------------------------------------------------------------
// Capability probe

/**
 * Every capability, and the factory unit (`key` in research/factory/backlog.json) that lands
 * it. A capability whose unit has not landed skips with `unit <key> not landed: <cap> ...`.
 */
export const CAPABILITY_UNITS = {
  checkWorld: 'engine-check-core',
  'check.schema': 'engine-check-core',
  'check.references': 'engine-check-core',
  'check.compile': 'engine-check-core',
  'check.seed': 'engine-seed',
  'check.tests': 'engine-tests-layer',
  'check.tasks': 'engine-grade-verify-basic',
  'check.tasks.discriminating': 'engine-verify-full',
  'check.lints': 'engine-lints',
  sandbox: 'engine-sandbox',
  createRuntime: 'engine-runtime',
  'runtime.call': 'engine-runtime',
  'runtime.dump': 'engine-runtime',
  'runtime.reset': 'engine-runtime',
  'runtime.log': 'engine-runtime',
  'runtime.seed': 'engine-seed',
  'runtime.actions': 'engine-actions-jobs',
  'runtime.advance': 'engine-actions-jobs',
  'runtime.grade': 'engine-grade-verify-basic',
  applyEdit: 'engine-world-io',
  diffWorlds: 'engine-diff',
  loadWorld: 'engine-world-io',
  saveWorld: 'engine-world-io',
  emptyWorld: 'engine-format',
  editJsonSchema: 'engine-format',
  formatReference: 'engine-format',
  verifyTask: 'engine-grade-verify-basic',
  serve: 'engine-http-cli',
  cli: 'cli-world-check',
  'cli.verify': 'engine-http-cli',
  'cli.grade': 'engine-http-cli',
  'cli.serve': 'engine-http-cli',
} as const satisfies Readonly<Record<string, string>>;
export type CapName = keyof typeof CAPABILITY_UNITS;
export const CAPABILITIES = Object.keys(CAPABILITY_UNITS) as readonly CapName[];
/** Probed only by `probeCli()`, since they spawn processes. */
export const CLI_CAPS: readonly CapName[] = ['cli', 'cli.verify', 'cli.grade', 'cli.serve'];

/**
 * - ok: landed. Its tests run, and fail on a bug.
 * - stub: the unit is in the tree but still carries a stub marker (Error('not implemented'),
 *   a pass-through check layer, a placeholder initial state, a 501 `action.unavailable`).
 * - absent: the export or file does not exist.
 * - blocked: the capability exists, but the probe cannot reach it, because the base world does
 *   not check for a reason other than a stub.
 */
export type CapStatus =
  | { readonly state: 'ok' }
  | { readonly state: 'stub'; readonly reason: string }
  | { readonly state: 'blocked'; readonly reason: string }
  | { readonly state: 'absent'; readonly reason: string };

export function isNotImplemented(e: unknown): boolean {
  return e instanceof Error && e.message === 'not implemented';
}

const OK: CapStatus = { state: 'ok' };
const notLanded = (name: CapName, why: string): string => `unit ${CAPABILITY_UNITS[name]} not landed: ${name} ${why}`;
const stub = (name: CapName, why: string): CapStatus => ({ state: 'stub', reason: notLanded(name, why) });
const absent = (name: CapName, why: string): CapStatus => ({ state: 'absent', reason: notLanded(name, why) });
/** A dependency's status, for a capability that cannot work without it. The reason keeps naming the dependency's unit. */
const inherit = (s: CapStatus, name: CapName): CapStatus => (s.state === 'ok' ? s : { ...s, reason: `${s.reason} (needed by ${name})` });

/** ok unless the call throws (or rejects with) Error('not implemented'). Other errors mean the code exists. */
async function attempt(name: CapName, fn: () => unknown): Promise<CapStatus> {
  try {
    await fn();
    return OK;
  } catch (e) {
    return isNotImplemented(e) ? stub(name, 'throws Error(not implemented)') : OK;
  }
}

/**
 * Evidence about one capability: true looks like a stub, false looks landed, null cannot tell.
 * A capability is a stub when some evidence says stub and none says landed, so a half-landed
 * unit counts as landed and its tests fail instead of skipping.
 */
type Evidence = { readonly stub: boolean | null; readonly why: string };

function judge(name: CapName, evidence: readonly Evidence[], unreachable: string): CapStatus {
  if (evidence.some((e) => e.stub === false)) return OK;
  const stubs = evidence.filter((e) => e.stub === true);
  if (stubs.length > 0) return stub(name, stubs.map((e) => e.why).join('; '));
  return { state: 'blocked', reason: `blocked: ${name} cannot be observed (${unreachable})` };
}

const mentionsNotImplemented = (x: unknown): boolean => {
  try {
    return /not implemented/.test(JSON.stringify(x));
  } catch {
    return false;
  }
};

function mutated(id: string): World {
  const m = MUTATIONS.find((x) => x.id === id);
  if (!m) throw new Error(`harness probe: no mutation row ${id}`);
  const w = baseWorld();
  m.mutate(w);
  return w;
}

/**
 * Whether check layer `layer` is a stub, judged by a mutation row whose world only `layer` refuses.
 * Error layers: the report must stop at `layer`. Getting past it (ok, or stopping at a later
 * layer) is a pass-through layer. Stopping at an earlier layer tells nothing. `warning` names
 * the code a warning layer must add to an ok report.
 */
function layerEvidence(id: string, layer: CheckLayer, warning?: IssueCode): Evidence {
  const at = (l: CheckLayer): number => engine.CHECK_LAYERS.indexOf(l);
  let r: CheckReport;
  try {
    r = engine.checkWorld(mutated(id));
  } catch (e) {
    return isNotImplemented(e) ? { stub: true, why: `throws Error(not implemented) on mutation ${id}` } : { stub: false, why: '' };
  }
  if (warning !== undefined) {
    if (!r.ok) return { stub: null, why: '' };
    return r.warnings.some((w) => w.code === warning) ? { stub: false, why: '' } : { stub: true, why: `adds no ${warning} warning for mutation ${id}` };
  }
  if (r.ok) return { stub: true, why: `passes mutation ${id} (${MUTATIONS.find((m) => m.id === id)?.note ?? ''}), which only it refuses` };
  if (at(r.reached) > at(layer)) return { stub: true, why: `lets mutation ${id} through to the ${r.reached} layer` };
  if (at(r.reached) < at(layer)) return { stub: null, why: '' };
  return mentionsNotImplemented(r.issues) ? { stub: true, why: `reports Error(not implemented) on mutation ${id}` } : { stub: false, why: '' };
}

/** Placeholder output in the ok base report: a field the layer fills in is still empty. */
function baseEvidence(report: CheckReport | null, placeholder: (r: Extract<CheckReport, { ok: true }>) => boolean, what: string): Evidence {
  if (!report?.ok) return { stub: null, why: '' };
  return placeholder(report) ? { stub: true, why: `leaves ${what} in the base report` } : { stub: false, why: '' };
}

const ACTION_PROBE = { method: 'POST', path: '/tickets/tkt_0001/escalate', query: {}, body: { reason: 'probe' } } as const;
const RUNTIME_CAPS = ['runtime.call', 'runtime.dump', 'runtime.log', 'runtime.advance', 'runtime.grade', 'runtime.reset'] as const;
const CHECK_CAPS = ['check.schema', 'check.references', 'check.compile', 'check.seed', 'check.tests', 'check.tasks', 'check.tasks.discriminating', 'check.lints', 'sandbox'] as const;

export type Probe = {
  readonly caps: Readonly<Partial<Record<CapName, CapStatus>>>;
  /** The checked base world, when checkWorld accepts it. */
  readonly checked: CheckedWorld | null;
  /** The base world report, when checkWorld is implemented. */
  readonly baseReport: CheckReport | null;
};

export async function probe(): Promise<Probe> {
  const caps: Partial<Record<CapName, CapStatus>> = {};
  let checked: CheckedWorld | null = null;
  let baseReport: CheckReport | null = null;

  // checkWorld and its layers.
  caps.checkWorld = await attempt('checkWorld', () => engine.checkWorld({}));
  if (caps.checkWorld.state === 'ok') {
    try {
      baseReport = engine.checkWorld(baseWorld());
      if (baseReport.ok) checked = baseReport.world;
    } catch {
      baseReport = null;
    }
  }
  const checkStatus = caps.checkWorld;
  const unreachable =
    baseReport === null ? 'checkWorld threw on the base world' : baseReport.ok ? 'no mutation reaches it' : `the base world stops at ${baseReport.reached}`;
  if (checkStatus.state !== 'ok') {
    for (const name of CHECK_CAPS) caps[name] = inherit(checkStatus, name);
  } else {
    // The host compiles every snippet. A stub host turns each one into a compile issue that says so.
    const baseCompile: Evidence =
      baseReport && !baseReport.ok && baseReport.reached === 'compile' && mentionsNotImplemented(baseReport.issues)
        ? { stub: true, why: 'compiles the base world snippets to Error(not implemented)' }
        : { stub: null, why: '' };
    caps.sandbox = judge('sandbox', [baseCompile, layerEvidence('C01', 'compile')], unreachable);
    caps['check.schema'] = judge('check.schema', [layerEvidence('S25', 'schema')], unreachable);
    caps['check.references'] = judge('check.references', [layerEvidence('R01', 'references')], unreachable);
    caps['check.compile'] =
      caps.sandbox.state === 'stub' ? inherit(caps.sandbox, 'check.compile') : judge('check.compile', [layerEvidence('C01', 'compile')], unreachable);
    caps['check.tests'] = judge(
      'check.tests',
      [layerEvidence('T01', 'tests'), baseEvidence(baseReport, (r) => r.tests === 0, 'tests: 0 for a world with tests')],
      unreachable,
    );
    caps['check.tasks'] = judge(
      'check.tasks',
      [layerEvidence('GR-noop-one', 'tasks'), baseEvidence(baseReport, (r) => Object.keys(r.verdicts).length === 0, 'verdicts empty for a world with tasks')],
      unreachable,
    );
    caps['check.tasks.discriminating'] =
      caps['check.tasks'].state === 'stub'
        ? inherit(caps['check.tasks'], 'check.tasks.discriminating')
        : judge('check.tasks.discriminating', [layerEvidence('GR-decoy-trivial-solution', 'tasks')], unreachable);
    caps['check.lints'] = judge(
      'check.lints',
      [
        layerEvidence('L05', 'lints', 'action.unexercised'),
        baseEvidence(baseReport, (r) => Object.keys(r.stats.rows).length === 0 && Object.keys(r.stats.states).length === 0, 'stats.rows and stats.states empty'),
      ],
      unreachable,
    );
  }

  // Runtime over the checked base world.
  const noBase: CapStatus = {
    state: 'blocked',
    reason:
      baseReport === null
        ? 'blocked: checkWorld threw on the base world'
        : baseReport.ok
          ? 'blocked: base world did not check'
          : `blocked: base world does not check (${baseReport.issues.map((i) => i.code).join(', ')})`,
  };
  let seedDump: Evidence = { stub: null, why: '' };
  if (checked) {
    const world = checked;
    let rt: Runtime | null = null;
    caps.createRuntime = await attempt('createRuntime', () => {
      rt = engine.createRuntime(world);
    });
    const live = rt as Runtime | null;
    if (live) {
      try {
        const rows = Object.values(live.dump().tables).reduce((n, t) => n + t.length, 0);
        seedDump = rows === 0 ? { stub: true, why: 'starts the runtime with every table empty although the base world seeds rows' } : { stub: false, why: '' };
      } catch {
        seedDump = { stub: null, why: '' };
      }
      const calls: Record<(typeof RUNTIME_CAPS)[number], () => unknown> = {
        'runtime.call': () => live.call({ method: 'GET', path: '/tickets', query: {}, body: null }),
        'runtime.dump': () => live.dump(),
        'runtime.log': () => live.log(),
        'runtime.advance': () => live.advance('1s'),
        'runtime.grade': () => live.grade('pend_hd1005'),
        'runtime.reset': () => live.reset(),
      };
      for (const name of RUNTIME_CAPS) caps[name] = await attempt(name, calls[name]);
      // An action call on a fresh runtime. The stub answers 501 action.unavailable before reading any row.
      caps['runtime.actions'] = OK;
      try {
        const res = engine.createRuntime(world).call(ACTION_PROBE);
        if (res.status === 501 && /action\.unavailable/.test(JSON.stringify(res.body))) {
          caps['runtime.actions'] = stub('runtime.actions', 'answers 501 action.unavailable to an action call');
        }
      } catch (e) {
        // Any other throw is a bug the action tests report.
        if (isNotImplemented(e)) caps['runtime.actions'] = stub('runtime.actions', 'throws Error(not implemented)');
      }
    } else {
      for (const name of [...RUNTIME_CAPS, 'runtime.actions', 'runtime.seed'] as const) caps[name] = inherit(caps.createRuntime, name);
    }
    const dir = await mkdtemp(join(tmpdir(), 'redteam-probe-save-'));
    caps.saveWorld = await attempt('saveWorld', () => engine.saveWorld(dir, world));
    await rm(dir, { recursive: true, force: true });
  } else {
    for (const name of ['createRuntime', ...RUNTIME_CAPS, 'runtime.actions', 'runtime.seed', 'saveWorld'] as const) {
      caps[name] = checkStatus.state === 'ok' ? noBase : inherit(checkStatus, name);
    }
  }

  // Seeding is one unit: the seed check layer and the runtime's initial state.
  if (checkStatus.state === 'ok') {
    const seedLayer = layerEvidence('D01', 'seed');
    caps['check.seed'] = judge('check.seed', [seedLayer, seedDump], unreachable);
    if (caps.createRuntime?.state === 'ok') caps['runtime.seed'] = judge('runtime.seed', [seedDump, seedLayer], unreachable);
  }

  caps.applyEdit = await attempt('applyEdit', () => engine.applyEdit(baseWorld(), { note: 'probe' }));
  caps.diffWorlds = await attempt('diffWorlds', () => engine.diffWorlds(baseWorld(), baseWorld()));
  caps.loadWorld = await attempt('loadWorld', () => engine.loadWorld(join(tmpdir(), 'redteam-probe-missing-dir-0000')));
  caps.emptyWorld = await attempt('emptyWorld', () => engine.emptyWorld('probe', 'hand'));
  caps.editJsonSchema = await attempt('editJsonSchema', () => engine.editJsonSchema(['entities']));
  caps.formatReference = await attempt('formatReference', () => engine.formatReference());

  // Not exported by design (contract "Facts for test writers"): verdicts come only from
  // CheckReport.verdicts and HTTP only through the CLI. Tests use check.tasks and cli.serve.
  const exported = engine as unknown as Readonly<Record<string, unknown>>;
  for (const name of ['verifyTask', 'serve'] as const) {
    const instead = name === 'verifyTask' ? 'check.tasks' : 'cli.serve';
    caps[name] = typeof exported[name] === 'function' ? OK : { state: 'absent', reason: `${name} is not exported from #engine by design (contract, Facts for test writers): use ${instead}` };
  }
  return { caps, checked, baseReport };
}

export const PROBE: Probe = await probe();

let cliCaps: Partial<Record<CapName, CapStatus>> | null = null;

/** A subcommand that the CLI has not grown yet, or that reaches an engine stub. */
const CLI_STUB = /not implemented|(unknown|unrecognized|unsupported|invalid) (sub)?command/i;

/** Probe the CLI (spawns processes). Await it at the top of any file that uses cap('cli'...). */
export async function probeCli(): Promise<void> {
  if (cliCaps) return;
  const out: Partial<Record<CapName, CapStatus>> = {};
  try {
    await access(CLI_PATH);
  } catch {
    out.cli = absent('cli', 'is missing (no src/cli/worldplay.ts)');
    for (const name of CLI_CAPS) if (name !== 'cli') out[name] = inherit(out.cli, name);
    cliCaps = out;
    return;
  }
  const dir = await writeWorldDir(baseWorld());
  try {
    // A CLI that hangs or crashes exists and is broken, so its tests must run and fail rather
    // than skip. Only a stub marker in the output makes a stub.
    const r = await runCli(['check', dir], { timeoutMs: 60_000 });
    out.cli = /not implemented/.test(r.stdout + r.stderr) ? stub('cli', 'check prints Error(not implemented)') : OK;
    if (out.cli.state !== 'ok') {
      for (const name of CLI_CAPS) if (name !== 'cli') out[name] = inherit(out.cli, name);
    } else {
      const statePath = join(dir, 'probe-state.json');
      const rt = PROBE.checked && available('runtime.dump') ? engine.createRuntime(PROBE.checked) : null;
      await writeFile(statePath, `${JSON.stringify(rt ? rt.dump() : {})}\n`);
      const [verify, grade] = await Promise.all([
        runCli(['verify', dir], { timeoutMs: 120_000 }),
        runCli(['grade', dir, 'pend_hd1005', '--state', statePath], { timeoutMs: 60_000 }),
      ]);
      out['cli.verify'] = CLI_STUB.test(verify.stdout + verify.stderr) ? stub('cli.verify', `prints "${(verify.stdout + verify.stderr).match(CLI_STUB)?.[0] ?? ''}"`) : OK;
      out['cli.grade'] = CLI_STUB.test(grade.stdout + grade.stderr) ? stub('cli.grade', `prints "${(grade.stdout + grade.stderr).match(CLI_STUB)?.[0] ?? ''}"`) : OK;
      try {
        const s = await startServer(dir, { timeoutMs: 20_000 });
        await s.stop();
        out['cli.serve'] = OK;
      } catch (e) {
        // startServer's error carries the server output. A server that never comes up for any
        // other reason is a failure the serve tests must report.
        out['cli.serve'] = CLI_STUB.test(String(e)) ? stub('cli.serve', `prints "${String(e).match(CLI_STUB)?.[0] ?? ''}"`) : OK;
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  cliCaps = out;
}

export function capStatus(name: CapName): CapStatus {
  if (CLI_CAPS.includes(name)) {
    if (!cliCaps) throw new Error(`await probeCli() before cap('${name}')`);
    return cliCaps[name] ?? stub(name, 'was not probed');
  }
  return PROBE.caps[name] ?? stub(name, 'was not probed');
}

/** Whether probeCli() has run in this process. bun test runs every file in one process, so another file may have run it. */
export function cliProbed(): boolean {
  return cliCaps !== null;
}

export function available(name: CapName): boolean {
  return capStatus(name).state === 'ok';
}

/** node:test options that skip a test when any named capability is missing. Never skips under REDTEAM_STRICT=1. */
export function cap(...names: CapName[]): TestOptions {
  for (const name of names) {
    // capStatus runs even under STRICT so a missing `await probeCli()` is still reported.
    const s = capStatus(name);
    if (!STRICT && s.state !== 'ok') return { skip: s.reason };
  }
  return {};
}

/**
 * node:test options that skip a test unless checkWorld has landed and accepts the base world,
 * naming the base world's issue codes when it does not. Never skips under REDTEAM_STRICT=1.
 */
export function baseOk(): TestOptions {
  if (STRICT) return {};
  if (!available('checkWorld')) return cap('checkWorld');
  if (PROBE.checked) return {};
  const r = PROBE.baseReport;
  return {
    skip:
      r === null
        ? 'blocked: checkWorld threw on the base world'
        : r.ok
          ? 'blocked: base world did not check'
          : `blocked: base world does not check (${r.issues.map((i) => i.code).join(', ')})`,
  };
}

/** Mark a test as depending on an RT ambiguity in research/redteam-contract.md. */
export function todo(rt: `RT-${string}`): TestOptions {
  return { todo: rt };
}

/** Merge option objects. A skip wins over a todo. */
export function opts(...parts: TestOptions[]): TestOptions {
  const merged: TestOptions = {};
  for (const p of parts) Object.assign(merged, p);
  if (merged.skip) delete merged.todo;
  return merged;
}

/** The checked base world. Call only inside a test guarded by cap('checkWorld'). */
export function checkedBase(): CheckedWorld {
  if (PROBE.checked) return PROBE.checked;
  const r = engine.checkWorld(baseWorld());
  if (!r.ok) throw new AssertionError({ message: `base world does not check: ${JSON.stringify(r.issues, null, 2)}` });
  return r.world;
}

/** A fresh runtime over the checked base world. */
export function freshRuntime(): Runtime {
  return engine.createRuntime(checkedBase());
}

// ---------------------------------------------------------------------------------------
// PRNG

/** mulberry32: a 32-bit seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Rng = {
  readonly seed: number;
  next(): number;
  /** Integer in [lo, hi], inclusive. */
  int(lo: number, hi: number): number;
  pick<T>(xs: readonly T[]): T;
  shuffle<T>(xs: readonly T[]): T[];
  bool(p?: number): boolean;
};

export function rng(seed: number = SEED): Rng {
  const next = mulberry32(seed);
  const int = (lo: number, hi: number): number => lo + Math.floor(next() * (hi - lo + 1));
  return {
    seed,
    next,
    int,
    pick<T>(xs: readonly T[]): T {
      if (xs.length === 0) throw new Error('pick from an empty list');
      return xs[int(0, xs.length - 1)] as T;
    },
    shuffle<T>(xs: readonly T[]): T[] {
      const out = [...xs];
      for (let i = out.length - 1; i > 0; i--) {
        const j = int(0, i);
        [out[i], out[j]] = [out[j] as T, out[i] as T];
      }
      return out;
    },
    bool(p = 0.5) {
      return next() < p;
    },
  };
}

/** Seeds for one fuzz run: SEED, SEED+1, ... ITER of them. */
export function seeds(count: number = ITER): number[] {
  return Array.from({ length: count }, (_, i) => SEED + i);
}

// ---------------------------------------------------------------------------------------
// ddmin

/**
 * Delta debugging: the smallest subsequence of `calls` (order kept) for which `fails`
 * still returns true. `fails(calls)` must be true on entry; otherwise `calls` is returned.
 */
export function ddmin<T>(calls: readonly T[], fails: (subset: readonly T[]) => boolean): T[] {
  let cur = [...calls];
  if (!fails(cur)) return cur;
  let n = 2;
  while (cur.length >= 2) {
    const size = Math.ceil(cur.length / n);
    const chunks: T[][] = [];
    for (let i = 0; i < cur.length; i += size) chunks.push(cur.slice(i, i + size));
    let reduced = false;
    for (const chunk of chunks) {
      if (fails(chunk)) {
        cur = chunk;
        n = 2;
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      for (let i = 0; i < chunks.length; i++) {
        const complement = chunks.filter((_, j) => j !== i).flat();
        if (complement.length > 0 && fails(complement)) {
          cur = complement;
          n = Math.max(n - 1, 2);
          reduced = true;
          break;
        }
      }
    }
    if (!reduced) {
      if (n >= cur.length) break;
      n = Math.min(cur.length, n * 2);
    }
  }
  return cur;
}

/**
 * Minimize a failing call sequence, print the seed and the repro, and throw.
 * Use in fuzz tests: `if (fails(calls)) failWithRepro('G-07 ...', seed, calls, fails)`.
 */
export function failWithRepro<T>(label: string, seed: number, calls: readonly T[], fails: (subset: readonly T[]) => boolean, detail = ''): never {
  const min = ddmin(calls, fails);
  const message = [
    `[redteam] ${label}`,
    `  reproduce: REDTEAM_SEED=${seed} REDTEAM_ITER=1 npm test`,
    `  minimized ${min.length} of ${calls.length} calls:`,
    ...min.map((c, i) => `    ${i + 1}. ${JSON.stringify(c)}`),
    ...(detail ? [`  ${detail}`] : []),
  ].join('\n');
  console.error(message);
  throw new AssertionError({ message });
}

// ---------------------------------------------------------------------------------------
// Freezing and copying

export function deepFreeze<T>(x: T): T {
  if (x !== null && typeof x === 'object' && !Object.isFrozen(x)) {
    Object.freeze(x);
    for (const k of Reflect.ownKeys(x)) deepFreeze((x as Record<PropertyKey, unknown>)[k]);
  }
  return x;
}

export function clone<T>(x: T): T {
  return structuredClone(x);
}

// ---------------------------------------------------------------------------------------
// CLI and HTTP

/** A temp world dir holding `world.yaml`. JSON is valid YAML 1.2, so no YAML library is needed. */
export async function writeWorldDir(world: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'redteam-world-'));
  await writeFile(join(dir, 'world.yaml'), `${JSON.stringify(world, null, 2)}\n`);
  return dir;
}

export type CliResult = { readonly code: number | null; readonly stdout: string; readonly stderr: string; readonly timedOut: boolean };

/** Runs the world CLI the way `npm run worldplay -- <args>` does (tsx src/cli/worldplay.ts), from code/. */
export function runCli(args: readonly string[], o: { timeoutMs?: number } = {}): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, tsEntryArgs(CLI_PATH, args), { cwd: CODE_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, o.timeoutMs ?? 30_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

export type HttpResult = { readonly status: number; readonly body: unknown; readonly text: string; readonly headers: Headers };

export type JsonClient = {
  readonly base: string;
  /** `body` is JSON-encoded unless `raw` is given, which is sent as is. */
  request(method: string, path: string, body?: unknown, o?: { raw?: string; headers?: Record<string, string> }): Promise<HttpResult>;
  get(path: string): Promise<HttpResult>;
  post(path: string, body?: unknown): Promise<HttpResult>;
  patch(path: string, body?: unknown): Promise<HttpResult>;
  put(path: string, body?: unknown): Promise<HttpResult>;
  del(path: string): Promise<HttpResult>;
};

export function jsonClient(base: string): JsonClient {
  const request: JsonClient['request'] = async (method, path, body, o = {}) => {
    const headers: Record<string, string> = { accept: 'application/json', ...o.headers };
    let payload: string | undefined;
    if (o.raw !== undefined) payload = o.raw;
    else if (body !== undefined) payload = JSON.stringify(body);
    if (payload !== undefined && !('content-type' in headers)) headers['content-type'] = 'application/json';
    const res = await fetch(base + path, { method, headers, ...(payload !== undefined ? { body: payload } : {}) });
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text === '' ? undefined : JSON.parse(text);
    } catch {
      parsed = undefined;
    }
    return { status: res.status, body: parsed, text, headers: res.headers };
  };
  return {
    base,
    request,
    get: (p) => request('GET', p),
    post: (p, b) => request('POST', p, b),
    patch: (p, b) => request('PATCH', p, b),
    put: (p, b) => request('PUT', p, b),
    del: (p) => request('DELETE', p),
  };
}

export type Server = {
  /** The world port and the admin port serve reported once both were bound. */
  readonly port: number;
  readonly adminPort: number;
  readonly base: string;
  readonly admin: string;
  readonly api: JsonClient;
  readonly adminApi: JsonClient;
  /** Output so far, for failure messages. */
  output(): string;
  stop(): Promise<void>;
};

const SERVER_START_TIMEOUT_MS = 60_000;

async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1_000) });
    await res.arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

/** The ports in serve's `{"listening":{"world":W,"admin":A}}` line, printed once both are bound (A-348), or null before it. */
function listeningOf(out: string): { readonly world: number; readonly admin: number } | null {
  for (const line of out.split('\n')) {
    try {
      const v: unknown = JSON.parse(line);
      const l = typeof v === 'object' && v !== null ? (v as { listening?: { world?: unknown; admin?: unknown } }).listening : undefined;
      if (Number.isInteger(l?.world) && Number.isInteger(l?.admin)) return { world: l?.world as number, admin: l?.admin as number };
    } catch {
      // not the listening line
    }
  }
  return null;
}

/**
 * Launch `world serve <dir> --port 0` and wait until the ports it reports both answer. The child binds both ports
 * where the OS picks, so no other process can take one between a probe and the bind, as it could when this picked a
 * free pair first (EADDRINUSE on the admin port, YOS-233).
 */
export async function startServer(worldDir: string, o: { timeoutMs?: number; extraArgs?: readonly string[] } = {}): Promise<Server> {
  const child = spawn(process.execPath, tsEntryArgs(CLI_PATH, ['serve', worldDir, '--port', '0', ...(o.extraArgs ?? [])]), {
    cwd: CODE_DIR,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let exited = false;
  child.stdout.on('data', (d: Buffer) => (out += d.toString()));
  child.stderr.on('data', (d: Buffer) => (out += d.toString()));
  const exitedP = new Promise<void>((resolve) =>
    child.on('close', () => {
      exited = true;
      resolve();
    }),
  );
  const stop = async (): Promise<void> => {
    if (exited) return;
    child.kill('SIGTERM');
    const t = setTimeout(() => child.kill('SIGKILL'), 3_000);
    await exitedP;
    clearTimeout(t);
  };
  const urls = (ports: { readonly world: number; readonly admin: number }) => ({ base: `http://127.0.0.1:${ports.world}`, admin: `http://127.0.0.1:${ports.admin}` });
  const deadline = Date.now() + (o.timeoutMs ?? SERVER_START_TIMEOUT_MS);
  while (Date.now() < deadline && !exited) {
    const ports = listeningOf(out);
    if (ports !== null) {
      const { base, admin } = urls(ports);
      if ((await reachable(`${base}/__redteam_ping`)) && (await reachable(`${admin}/_world/state`))) {
        return { port: ports.world, adminPort: ports.admin, base, admin, api: jsonClient(base), adminApi: jsonClient(admin), output: () => out, stop };
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  const failure = exited
    ? `process exited before readiness, code=${child.exitCode}, signal=${child.signalCode}`
    : `readiness timed out after ${o.timeoutMs ?? SERVER_START_TIMEOUT_MS} ms`;
  await stop();
  const ports = listeningOf(out);
  const where = ports === null ? 'before reporting its ports' : `on ${urls(ports).base} and ${urls(ports).admin}`;
  throw new Error(`world serve did not come up ${where} (${failure}).\n${out.slice(-2000)}`);
}

/** startServer on a temp dir holding `world`, removing the dir on stop. */
export async function serveWorld(world: unknown, o: { timeoutMs?: number } = {}): Promise<Server> {
  const dir = await writeWorldDir(world);
  try {
    const s = await startServer(dir, o);
    return {
      ...s,
      stop: async () => {
        await s.stop();
        await rm(dir, { recursive: true, force: true });
      },
    };
  } catch (e) {
    await rm(dir, { recursive: true, force: true });
    throw e;
  }
}
