/**
 * The rehearsal suite (eval/suite.yaml) and its scorecard (summary.md).
 * No model and no file IO: cli/eval.ts reads files, runs runWorldGen per phase through
 * runCase, and writes what renderSummary returns.
 *
 * Invariants:
 * - A case's input parses with inputSchema, the union the worldgen CLI parses (A-38).
 * - Input paths in a suite resolve against the suite file's directory.
 * - Fidelity (fidelityScore, in fidelity.ts) is a scorecard metric: a frozen reference in eval/fidelity/<case>.yaml
 *   is matched against a world by written rules (see normName), with no model and no guessing. It is
 *   structural, scored on the schema-parsed world, and independent of check, verify and pass. The runner
 *   also hands a description case its reference, so that run's last step gates on it (A-258).
 * - The scorecard reads events.jsonl lines, not the RunResult, so a step that ran without an
 *   attempt event carrying ms and costUsd shows as `unlogged` (AGENTS.md: every stage,
 *   attempt, time and cost is logged).
 */
import path from 'node:path';
import { partialModelUsageSchema } from '../costs/ledger.ts';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { assertNever } from '#lib/never';
import type { RunEvent, StopReason } from './events.ts';
import { inputSchema, type Input } from './input.ts';
import type { Job, RunResult } from './run.ts';
import type { Fidelity } from './fidelity.ts';

/** Lowercase kebab-case, such as helpdesk-sla. */
export const CASE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const caseId = z.string().regex(CASE_ID, 'must be lowercase kebab-case, such as helpdesk-sla');
const expectSchema = z.enum(['done', 'stopped']);
export type Expect = z.output<typeof expectSchema>;

export const suiteCaseSchema = z.strictObject({
  id: caseId,
  input: inputSchema,
  /** A change request, run as an iterate job on the world the create phase saved. */
  change: z.string().trim().min(1).optional(),
  /** `stopped` marks a prompt WorldGen should refuse. Such a case passes on an honest stop. */
  expect: expectSchema.default('done'),
  /** What a good result looks like, for the person triaging. The runner never reads it. */
  note: z.string().optional(),
  /** Groups for `--tag`, so a rehearsal can pick a subset such as `cheap`. */
  tags: z.array(caseId).optional(),
});

export const suiteSchema = z
  .strictObject({ name: caseId, cases: z.array(suiteCaseSchema).min(1) })
  .superRefine((suite, ctx) => {
    const seen = new Set<string>();
    suite.cases.forEach((c, i) => {
      if (seen.has(c.id)) ctx.addIssue({ code: 'custom', path: ['cases', i, 'id'], message: `duplicate case id "${c.id}"` });
      seen.add(c.id);
    });
  });
export type Suite = z.output<typeof suiteSchema>;
export type SuiteCase = Suite['cases'][number];

const where = (p: readonly PropertyKey[]): string => (p.length === 0 ? '(root)' : p.map(String).join('.'));
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Parses suite.yaml text. Errors are `<path>: <message>`, one per zod issue. */
export function parseSuite(text: string): { ok: true; suite: Suite } | { ok: false; errors: readonly string[] } {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    return { ok: false, errors: [`not valid YAML: ${message(e)}`] };
  }
  const parsed = suiteSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, errors: parsed.error.issues.map((i) => `${where(i.path)}: ${i.message}`) };
  return { ok: true, suite: parsed.data };
}

/** The cases `--only` names, in suite order. `null` selects every case. */
export function selectCases(
  suite: Suite,
  only: readonly string[] | null,
): { ok: true; cases: readonly SuiteCase[] } | { ok: false; unknown: readonly string[] } {
  if (only === null) return { ok: true, cases: suite.cases };
  const known = new Set(suite.cases.map((c) => c.id));
  const unknown = only.filter((id) => !known.has(id));
  if (unknown.length > 0) return { ok: false, unknown };
  return { ok: true, cases: suite.cases.filter((c) => only.includes(c.id)) };
}

/** The cases that carry any of `tags`, in suite order. A tag no case carries is unknown. */
export function selectByTag(
  cases: readonly SuiteCase[],
  tags: readonly string[],
): { ok: true; cases: readonly SuiteCase[] } | { ok: false; unknown: readonly string[] } {
  const unknown = tags.filter((t) => !cases.some((c) => c.tags?.includes(t)));
  if (unknown.length > 0) return { ok: false, unknown };
  return { ok: true, cases: cases.filter((c) => tags.some((t) => c.tags?.includes(t))) };
}

/** The files an input reads, as written in the suite. */
export function inputPaths(input: Input): readonly string[] {
  switch (input.kind) {
    case 'description':
      return [];
    case 'openapi':
      return [input.path];
    case 'csv':
      return input.paths;
    default:
      return assertNever(input);
  }
}

/** The input with every file path resolved against `baseDir`, the suite file's directory. */
export function resolveInput(input: Input, baseDir: string): Input {
  switch (input.kind) {
    case 'description':
      return input;
    case 'openapi':
      return { ...input, path: path.resolve(baseDir, input.path) };
    case 'csv':
      return { ...input, paths: input.paths.map((p) => path.resolve(baseDir, p)) };
    default:
      return assertNever(input);
  }
}

const phaseSchema = z.enum(['create', 'change']);
export type PhaseName = z.output<typeof phaseSchema>;

/** Where one case's files go inside a run directory. `events` is the events.jsonl createEmitter writes in `logDir`. */
export type CaseLayout = {
  readonly dir: string;
  readonly world: string;
  readonly caseFile: string;
  readonly logDir: Readonly<Record<PhaseName, string>>;
  readonly events: Readonly<Record<PhaseName, string>>;
};

export function caseLayout(runDir: string, id: string): CaseLayout {
  const dir = path.join(runDir, id);
  const logDir = { create: dir, change: path.join(dir, 'change') };
  return {
    dir,
    world: path.join(dir, 'world'),
    caseFile: path.join(dir, 'case.json'),
    logDir,
    events: { create: path.join(logDir.create, 'events.jsonl'), change: path.join(logDir.change, 'events.jsonl') },
  };
}

/** `<YYYY-MM-DD>-<suite>`, the directory name under eval/runs/. */
export const runName = (date: string, suite: string): string => `${date}-${suite}`;

const verifySchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('pass'), tasks: z.number().int().nonnegative() }),
  z.strictObject({ kind: z.literal('fail'), codes: z.array(z.string()) }),
  z.strictObject({ kind: z.literal('not_run') }),
]);
/** The engine's verdict on the world a case ended with. `not_run` when no world was saved. */
export type VerifyResult = z.output<typeof verifySchema>;

const phaseRecordSchema = z.strictObject({
  phase: phaseSchema,
  /** What runWorldGen returned, or null when it threw. */
  result: expectSchema.nullable(),
  error: z.string().nullable(),
});
export type PhaseRecord = z.output<typeof phaseRecordSchema>;

/** `case.json`: what the runner knows beyond events.jsonl. */
export const caseFileSchema = z.strictObject({
  id: caseId,
  expect: expectSchema,
  phases: z.array(phaseRecordSchema).min(1).max(2),
  verify: verifySchema,
});
export type CaseFile = z.output<typeof caseFileSchema>;

/** Parses case.json text, or says why it cannot. */
export function readCaseFile(text: string): { ok: true; file: CaseFile } | { ok: false; why: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { ok: false, why: `not JSON: ${message(e)}` };
  }
  const parsed = caseFileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, why: parsed.error.issues.map((i) => `${where(i.path)}: ${i.message}`).join('; ') };
  return { ok: true, file: parsed.data };
}

export type CaseDeps = {
  /** Runs one runWorldGen job. The CLI gives it an emitter that writes the phase's events.jsonl. */
  readonly run: (job: Job, phase: PhaseName) => Promise<Pick<RunResult, 'kind' | 'dir'>>;
  /** Loads and checks a saved world; the check's tasks layer verifies every task. */
  readonly verify: (worldDir: string) => Promise<VerifyResult>;
};

/** Runs the create phase, then the change request when the case has one and create saved a world, then verify. Never throws. */
export async function runCase(c: SuiteCase, baseDir: string, layout: CaseLayout, deps: CaseDeps): Promise<CaseFile> {
  const phases: PhaseRecord[] = [];
  const phase = async (job: Job, name: PhaseName): Promise<Pick<RunResult, 'kind' | 'dir'> | null> => {
    try {
      const r = await deps.run(job, name);
      phases.push({ phase: name, result: r.kind, error: null });
      return r;
    } catch (e) {
      phases.push({ phase: name, result: null, error: message(e) });
      return null;
    }
  };
  let last = await phase({ kind: 'create', input: resolveInput(c.input, baseDir), outDir: layout.world }, 'create');
  if (last !== null && last.kind === 'done' && c.change !== undefined) {
    last = await phase({ kind: 'iterate', worldDir: last.dir, request: c.change }, 'change');
  }
  let verify: VerifyResult = { kind: 'not_run' };
  if (last !== null && last.kind === 'done') {
    try {
      verify = await deps.verify(last.dir);
    } catch (e) {
      verify = { kind: 'fail', codes: [`verify threw: ${message(e)}`] };
    }
  }
  return { id: c.id, expect: c.expect, phases, verify };
}

// ---------------------------------------------------------------------------------------
// events.jsonl, read leniently: the scorecard must say what is missing, not crash on it.

const stepName = z.string().min(1);
const amount = z.number().nonnegative();
const loggedIssue = z.object({ code: z.string().min(1), hint: z.string().optional() });
const loggedEvent = z.discriminatedUnion('t', [
  z.object({ t: z.literal('step_started'), step: stepName }),
  z.object({
    t: z.literal('attempt'),
    step: stepName,
    n: z.number().int().optional(),
    ms: amount.optional(),
    costUsd: amount.nullable().optional(),
    partialModelUsage: partialModelUsageSchema.optional(),
    outcome: z.object({ kind: z.string().min(1), issues: z.array(loggedIssue).readonly().optional() }).optional(),
  }),
  z.object({ t: z.literal('call_cancelled'), step: stepName, ms: amount, costUsd: amount.nullable(), partialModelUsage: partialModelUsageSchema.optional() }),
  z.object({ t: z.literal('step_finished'), step: stepName }),
  z.object({
    t: z.literal('run_finished'),
    ms: amount,
    costUsd: amount,
    unknownCostCalls: z.number().int().nonnegative().optional(),
    result: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('done') }),
      z.object({ kind: z.literal('crashed'), message: z.string() }),
      z.object({ kind: z.literal('stopped'), reason: z.object({ kind: z.string().min(1), step: stepName.optional() }) }),
    ]),
  }),
]);
/** The slice of a RunEvent the scorecard reads. */
export type LoggedEvent = z.output<typeof loggedEvent>;
const READ = new Set<string>(['step_started', 'attempt', 'call_cancelled', 'step_finished', 'run_finished']);

/** Compile-time guard: every RunEvent the scorecard reads parses with its lenient schema. */
export const RUN_EVENTS_PARSE: Extract<RunEvent, { t: LoggedEvent['t'] }> extends z.input<typeof loggedEvent> ? true : never = true;

export type EventLog = { readonly events: readonly LoggedEvent[]; readonly problems: readonly string[] };
export type IssueObservation = { readonly code: string; readonly hint: string | null };

/** Parses events.jsonl text. Event types the scorecard does not read are skipped; broken lines become problems. */
export function parseEventLog(text: string): EventLog {
  const events: LoggedEvent[] = [];
  const problems: string[] = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      problems.push(`line ${i + 1} is not JSON`);
      return;
    }
    const t = typeof raw === 'object' && raw !== null && 't' in raw ? raw.t : undefined;
    if (typeof t !== 'string') {
      problems.push(`line ${i + 1} has no event type`);
      return;
    }
    if (!READ.has(t)) return;
    const parsed = loggedEvent.safeParse(raw);
    if (parsed.success) events.push(parsed.data);
    else problems.push(`line ${i + 1}: ${t} ${parsed.error.issues.map((x) => `${where(x.path)} ${x.message}`).join('; ')}`);
  });
  return { events, problems };
}

export type PhaseInput = PhaseRecord & { readonly log: EventLog };
export type PhaseStatus = 'done' | 'stopped' | 'crashed';

export type PhaseSummary = {
  readonly phase: PhaseName;
  readonly status: PhaseStatus;
  /** `<reason kind>[ at <step>]` for a stop, the error for a crash, else null. */
  readonly stop: string | null;
  readonly stopKind: string | null;
  /** Attempt events per step, in the order steps first appear. */
  readonly attempts: readonly (readonly [string, number])[];
  /** From run_finished, else the attempt sum. Null when an attempt lacks it or nothing was logged: unknown, never 0. */
  readonly ms: number | null;
  readonly costUsd: number | null;
  /** Calls whose final billing is unknown (logged costUsd null). A run_finished total excludes them. */
  readonly unknownCostCalls: number;
  /** Why the phase is unlogged. Empty when every step that ran logged attempts with ms and costUsd. */
  readonly logProblems: readonly string[];
  readonly error: string | null;
  /** Issue code + catalog hint from rejected/invalid attempt events, one row per occurrence. */
  readonly issues: readonly IssueObservation[];
};

const firstLine = (s: string): string => (s.split('\n')[0] ?? '').trim();

export function summarizePhase(p: PhaseInput): PhaseSummary {
  const problems = [...p.log.problems];
  const attempts = new Map<string, number>();
  const ran: string[] = [];
  const logged = new Set<string>();
  let msSum: number | null = 0;
  let costSum: number | null = 0;
  let unknownCostCalls = 0;
  const issues: IssueObservation[] = [];
  let finished: Extract<LoggedEvent, { t: 'run_finished' }> | null = null;
  const sawStep = (step: string): void => {
    if (!ran.includes(step)) ran.push(step);
  };
  for (const e of p.log.events) {
    switch (e.t) {
      case 'step_started':
      case 'step_finished':
        sawStep(e.step);
        break;
      case 'attempt':
      case 'call_cancelled': {
        sawStep(e.step);
        const n = (attempts.get(e.step) ?? 0) + 1;
        attempts.set(e.step, n);
        const label = `${e.step} attempt ${e.t === 'attempt' ? e.n ?? n : n}`;
        if (e.ms === undefined) problems.push(`${label} has no ms`);
        if (e.costUsd === undefined) problems.push(`${label} has no costUsd`);
        if (e.ms !== undefined && e.costUsd !== undefined) logged.add(e.step);
        msSum = msSum === null || e.ms === undefined ? null : msSum + e.ms;
        costSum = costSum === null || e.costUsd === undefined || e.costUsd === null ? null : costSum + e.costUsd;
        if (e.costUsd === null) unknownCostCalls += 1;
        if (e.t === 'attempt') {
          for (const i of e.outcome?.issues ?? []) {
            const hint = i.hint?.trim();
            issues.push({ code: i.code, hint: hint === undefined || hint === '' ? null : hint });
          }
        }
        break;
      }
      case 'run_finished':
        if (finished !== null) problems.push('more than one run_finished event');
        finished = e;
        break;
      default:
        assertNever(e);
    }
  }
  for (const step of ran) if (!attempts.has(step)) problems.push(`${step} ran but logged no attempt`);
  unknownCostCalls = Math.max(unknownCostCalls, finished?.unknownCostCalls ?? 0);
  if (unknownCostCalls > 0) problems.push(`${unknownCostCalls} cancelled call(s) have unknown cost; totals include known cost only`);
  const fromLog: PhaseStatus | null = finished === null ? null : finished.result.kind;
  if (finished === null && p.error === null) problems.push('no run_finished event');
  if (fromLog !== null && p.result !== null && fromLog !== p.result) problems.push(`run_finished says ${fromLog} but runWorldGen returned ${p.result}`);
  const status: PhaseStatus = fromLog ?? p.result ?? 'crashed';

  let stop: string | null = null;
  let stopKind: string | null = null;
  if (finished !== null && finished.result.kind === 'stopped') {
    const r = finished.result.reason;
    stopKind = r.kind;
    stop = r.step === undefined ? r.kind : `${r.kind} at ${r.step}`;
  } else if (status === 'stopped') {
    stop = 'stopped, reason not logged';
  } else if (status === 'crashed') {
    const message = finished?.result.kind === 'crashed' ? finished.result.message : p.error;
    stop = message === null ? 'crashed' : `crashed: ${firstLine(message)}`;
  }
  return {
    phase: p.phase,
    status,
    stop,
    stopKind,
    attempts: [...attempts],
    ms: finished !== null ? finished.ms : attempts.size === 0 ? null : msSum,
    costUsd: finished !== null ? finished.costUsd : attempts.size === 0 ? null : costSum,
    unknownCostCalls,
    logProblems: problems,
    error: p.error,
    issues,
  };
}

export type CaseRecord = {
  readonly id: string;
  readonly expect: Expect;
  readonly phases: readonly PhaseInput[];
  readonly verify: VerifyResult;
  /** Absent when the case has no reference. */
  readonly fidelity?: FidelityResult;
};

export type CaseRow = {
  readonly id: string;
  readonly expect: Expect;
  readonly status: PhaseStatus;
  readonly stop: string;
  readonly attempts: string;
  readonly ms: number | null;
  readonly costUsd: number | null;
  readonly unknownCostCalls: number;
  readonly verify: string;
  readonly fidelity: FidelityResult | null;
  readonly logged: boolean;
  readonly outcome: RunOutcome;
  /** A success or an expected refusal. */
  readonly pass: boolean;
  readonly phases: readonly PhaseSummary[];
};

/** The sum, or null when any part is unknown or there is no part. */
const sumKnown = (parts: readonly (number | null)[]): number | null =>
  parts.length === 0 || parts.includes(null) ? null : parts.reduce<number>((a, b) => a + (b ?? 0), 0);

const prefix = (phase: PhaseName): string => (phase === 'change' ? 'change: ' : '');

function verifyCell(v: VerifyResult): string {
  switch (v.kind) {
    case 'pass':
      return `pass (${v.tasks} task${v.tasks === 1 ? '' : 's'})`;
    case 'fail':
      return `fail: ${v.codes.join(', ')}`;
    case 'not_run':
      return '-';
    default:
      return assertNever(v);
  }
}

/**
 * Whether a stop is a verdict on the prompt (true) or a failure of the machinery around the model (false).
 * A machinery stop is an infra failure on any case. A Record, so a new stop kind must be classified here.
 */
const STOP_IS_VERDICT: Record<StopReason['kind'], boolean> = {
  input_rejected: true,
  attempts_exhausted: true,
  no_progress: true,
  backtrack_limit: true,
  budget_exhausted: true,
  spend_cap: true,
  cost_unenforceable: false,
  time_exhausted: true,
  stage_time_exhausted: true,
  model_error: false, // a 529 overload is not the product's verdict (A-340)
  judge_error: false,
  infra_unavailable: false,
  transport_stalled: false,
  cancelled: false,
};
const VERDICT_STOPS = new Set<string>(Object.entries(STOP_IS_VERDICT).flatMap(([kind, verdict]) => (verdict ? [kind] : [])));
/**
 * The stops that are WorldGen refusing the prompt itself: the only end an `expect: stopped` case passes on (A-384). The
 * plan's own verdict stops a run as `input_rejected`; running out of attempts, progress, budget or time on an impossible
 * prompt is not a refusal but a run that tried to build it.
 */
const REFUSAL_STOPS: ReadonlySet<string> = new Set<StopReason['kind']>(['input_rejected']);

/**
 * What a suite case's end says (A-336), in the order summary.md counts them. A success or an expected refusal is a
 * pass; an expected refusal is an `expect: stopped` case stopped by `input_rejected` (A-384). A product failure is the
 * wrong verdict on the prompt, including any other verdict stop on an `expect: stopped` case. An infra failure is a
 * crash, a machinery stop, a stop whose reason was never logged (A-340), a done world the harness never verified, or an
 * unreadable case.json, and is never a pass. Not run is a suite case with no case output.
 */
export const OUTCOMES = ['success', 'expected refusal', 'product failure', 'infra failure', 'not run'] as const;
export type Outcome = (typeof OUTCOMES)[number];
export type RunOutcome = Exclude<Outcome, 'not run'>;

/** The one classifier of a case that left a readable record: summary.md and eval-outcomes.ts both call it (A-340). */
export function outcomeOf(expect: Expect, status: PhaseStatus, stopKind: string | null, verify: VerifyResult): RunOutcome {
  if (status === 'crashed' || (status === 'stopped' && (stopKind === null || !VERDICT_STOPS.has(stopKind)))) return 'infra failure';
  if (expect === 'stopped') return status === 'stopped' && stopKind !== null && REFUSAL_STOPS.has(stopKind) ? 'expected refusal' : 'product failure';
  if (status === 'stopped') return 'product failure';
  if (verify.kind === 'not_run') return 'infra failure';
  return verify.kind === 'pass' ? 'success' : 'product failure';
}

export function summarizeCase(r: CaseRecord): CaseRow {
  const phases = r.phases.map(summarizePhase);
  const last = phases[phases.length - 1];
  const status: PhaseStatus = last === undefined ? 'crashed' : last.status;
  const stop = last === undefined || last.stop === null ? '-' : `${prefix(last.phase)}${last.stop}`;
  const attemptParts = phases
    .filter((p) => p.attempts.length > 0)
    .map((p) => `${prefix(p.phase)}${p.attempts.map(([step, n]) => `${step} ${n}`).join(', ')}`);
  const outcome = outcomeOf(r.expect, status, last?.stopKind ?? null, r.verify);
  return {
    id: r.id,
    expect: r.expect,
    status,
    stop,
    attempts: attemptParts.length === 0 ? '-' : attemptParts.join('; '),
    ms: sumKnown(phases.map((p) => p.ms)),
    costUsd: sumKnown(phases.map((p) => p.costUsd)),
    unknownCostCalls: phases.reduce((s, p) => s + p.unknownCostCalls, 0),
    verify: verifyCell(r.verify),
    fidelity: r.fidelity ?? null,
    logged: phases.length > 0 && phases.every((p) => p.logProblems.length === 0),
    outcome,
    pass: outcome === 'success' || outcome === 'expected refusal',
    phases,
  };
}

export type SummaryMeta = {
  /** The run directory name, `<YYYY-MM-DD>-<suite>`. */
  readonly run: string;
  readonly suite: string;
  readonly model: string;
  readonly budgetUsd: number;
  readonly maxMinutes: number;
};

const cell = (s: string): string => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|');
const minutes = (ms: number | null): string => (ms === null ? 'unknown' : (ms / 60000).toFixed(1));
const usd = (n: number | null): string => (n === null ? 'unknown' : n.toFixed(2));

export type TriageRow = {
  readonly code: string;
  readonly count: number;
  readonly fix: string;
};

function triageRows(rows: readonly CaseRow[]): readonly TriageRow[] {
  const byCode = new Map<string, { count: number; hints: Map<string, number> }>();
  for (const row of rows) {
    for (const phase of row.phases) {
      for (const observed of phase.issues) {
        const entry = byCode.get(observed.code) ?? { count: 0, hints: new Map<string, number>() };
        entry.count += 1;
        if (observed.hint !== null) entry.hints.set(observed.hint, (entry.hints.get(observed.hint) ?? 0) + 1);
        byCode.set(observed.code, entry);
      }
    }
  }
  return [...byCode]
    .map(([code, entry]): TriageRow => {
      const hint = [...entry.hints]
        .sort(([a, ac], [b, bc]) => bc - ac || a.localeCompare(b))[0]?.[0];
      return {
        code,
        count: entry.count,
        fix: hint ?? `No generic hint was logged for ${code}; add one in issues.ts before the stress rerun.`,
      };
    })
    .sort((a, b) => b.count - a.count || a.code.localeCompare(b.code))
    .slice(0, 5);
}

/** One expected suite case in a run directory: its parsed case.json, or why there is none to read. */
export type SummaryEntry =
  | { readonly kind: 'record'; readonly record: CaseRecord }
  | { readonly kind: 'missing'; readonly id: string; readonly expect: Expect }
  | { readonly kind: 'invalid'; readonly id: string; readonly expect: Expect; readonly why: string };

/** Nearest-rank percentile of the known values, with how many of `of` cases it covers. */
function percentile(values: readonly (number | null)[], p: number, show: (n: number) => string, of: number): string {
  const known = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  if (known.length === 0) return `unknown (0 of ${of} cases)`;
  return `${show(known[Math.ceil((p / 100) * known.length) - 1]!)} (${known.length} of ${of} cases)`;
}

/** The known part of a total, and how many of `of` cases it covers. */
function knownTotal(values: readonly (number | null)[], show: (n: number) => string, of: number): string {
  const known = values.filter((v): v is number => v !== null);
  return known.length === 0 ? `unknown (0 of ${of} cases)` : `${show(known.reduce((a, b) => a + b, 0))} (${known.length} of ${of} cases)`;
}

/**
 * summary.md: one row per expected suite case, missing and invalid ones included, totals by outcome class, the pass
 * rate over every expected case (A-341), top issue triage, then why each case is missing, invalid, unlogged or crashed. Unknown
 * time or cost prints as unknown, never 0.
 */
export function renderSummary(meta: SummaryMeta, entries: readonly SummaryEntry[]): string {
  const rows = entries.flatMap((e) => (e.kind === 'record' ? [summarizeCase(e.record)] : []));
  const absent = entries.flatMap((e) => (e.kind === 'record' ? [] : [e]));
  const expected = entries.length;
  const outcomes: readonly Outcome[] = [...rows.map((r) => r.outcome), ...absent.map((a): Outcome => (a.kind === 'missing' ? 'not run' : 'infra failure'))];
  const count = (o: Outcome): number => outcomes.filter((x) => x === o).length;
  const passed = rows.filter((r) => r.pass).length;
  const unlogged = rows.filter((r) => !r.logged).length;
  const unknownCostCalls = rows.reduce((s, r) => s + r.unknownCostCalls, 0);
  const showFidelity = rows.some((r) => r.fidelity !== null);
  const out = [
    `# Eval run ${meta.run}`,
    '',
    `Suite \`${meta.suite}\`, model \`${meta.model}\`, budget $${usd(meta.budgetUsd)} and ${meta.maxMinutes} min per run.`,
    '',
    ...(showFidelity
      ? ['| case | expect | result | stop reason | attempts per step | min | $ | verify | fidelity | log | pass |', '|---|---|---|---|---|--:|--:|---|--:|---|---|']
      : ['| case | expect | result | stop reason | attempts per step | min | $ | verify | log | pass |', '|---|---|---|---|---|--:|--:|---|---|---|']),
    ...rows.map((r) => {
      const mid = showFidelity ? [fidelityCell(r.fidelity)] : [];
      return `| ${[r.id, r.expect, r.status, r.stop, r.attempts, minutes(r.ms), `${usd(r.costUsd)}${r.unknownCostCalls > 0 ? ' + unknown' : ''}`, r.verify, ...mid, r.logged ? 'ok' : 'unlogged', r.pass ? 'yes' : 'no'].map(cell).join(' | ')} |`;
    }),
    ...absent.map((a) => {
      const mid = showFidelity ? ['-'] : [];
      return `| ${[a.id, a.expect, a.kind, '-', '-', 'unknown', 'unknown', '-', ...mid, '-', 'no'].map(cell).join(' | ')} |`;
    }),
    '',
    `**Totals:** ${expected} expected cases: ${OUTCOMES.map((o) => `${count(o)} ${o}`).join(', ')}; ` +
      `${knownTotal(rows.map((r) => r.ms), (n) => `${minutes(n)} min`, expected)}; ${knownTotal(rows.map((r) => r.costUsd), (n) => `$${usd(n)}`, expected)}` +
      `${unknownCostCalls > 0 ? ` + unknown billing for ${unknownCostCalls} call(s)` : ''}; ${unlogged} unlogged.`,
    '',
    `**Median and p95:** ${percentile(rows.map((r) => r.ms), 50, (n) => `${minutes(n)} min`, expected)} and ${percentile(rows.map((r) => r.ms), 95, (n) => `${minutes(n)} min`, expected)}; ` +
      `${percentile(rows.map((r) => r.costUsd), 50, (n) => `$${usd(n)}`, expected)} and ${percentile(rows.map((r) => r.costUsd), 95, (n) => `$${usd(n)}`, expected)}.`,
    '',
    `**Pass rate:** ${passed}/${expected}${expected === 0 ? '' : ` (${Math.round((100 * passed) / expected)}%)`}, success and expected refusal over all ${expected} expected cases (${count('not run')} not run).`,
  ];
  if (absent.length > 0) {
    out.push('', '## Missing or invalid', '', ...absent.map((a) => `- \`${a.id}\`: ${a.kind === 'missing' ? 'no case.json in the run directory' : `case.json is invalid: ${cell(a.why)}`}`));
  }
  const triage = triageRows(rows);
  if (triage.length > 0) {
    out.push(
      '',
      '## Triage',
      '',
      '| rank | issue code | count | generic fix |',
      '|--:|---|--:|---|',
      ...triage.map((r, i) => `| ${i + 1} | ${cell(r.code)} | ${r.count} | ${cell(r.fix)} |`),
    );
  }
  const unloggedLines = rows.flatMap((r) => r.phases.flatMap((p) => p.logProblems.map((why) => `- \`${r.id}\` ${p.phase}: ${why}`)));
  if (unloggedLines.length > 0) out.push('', '## Unlogged', '', ...unloggedLines);
  const errorLines = rows.flatMap((r) => r.phases.flatMap((p) => (p.error === null ? [] : [`- \`${r.id}\` ${p.phase}: ${cell(p.error)}`])));
  if (errorLines.length > 0) out.push('', '## Errors', '', ...errorLines);
  const missLines = rows.flatMap((r) => {
    if (r.fidelity?.kind !== 'scored') return [];
    const f = r.fidelity.fidelity;
    return [...f.misses.map((m) => `- \`${r.id}\` ${m.kind} ${m.path} (${m.weight}): ${m.detail}`), `- \`${r.id}\` missed ${f.total - f.earned} of ${f.total}`];
  });
  if (missLines.length > 0) out.push('', '## Fidelity misses', '', ...missLines.map(cell));
  return `${out.join('\n')}\n`;
}

// ---------------------------------------------------------------------------------------
// Fidelity scorecard cells. Scoring itself is in fidelity.ts.

export type FidelityResult =
  | { readonly kind: 'scored'; readonly fidelity: Fidelity }
  | { readonly kind: 'no_world'; readonly why: string };

/** Floored from the integers so 0.7995 never shows as 0.800 and looks like it meets the 0.80 target. */
export function fidelityCell(r: FidelityResult | null): string {
  if (r === null) return '-';
  switch (r.kind) {
    case 'scored': {
      const { earned, total } = r.fidelity;
      return `${(Math.floor((1000 * earned) / total) / 1000).toFixed(3)} (${earned}/${total})`;
    }
    case 'no_world':
      return `no world: ${r.why}`;
    default:
      return assertNever(r);
  }
}
