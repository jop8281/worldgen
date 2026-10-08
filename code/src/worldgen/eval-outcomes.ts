/** Offline analysis against an explicit expected set; no providers or file IO. */
import { CASE_ID, caseFileSchema, type PhaseName } from './eval.ts';
import type { RunEvent, StopReason } from './events.ts';

export type ExpectedEvalCase = { readonly id: string; readonly expect: 'done' | 'stopped'; readonly change?: string };
export type EvalEvidence = {
  readonly id: string;
  readonly source: string;
  readonly caseText: string | null;
  readonly logs: Readonly<Partial<Record<PhaseName, string | null>>>;
  readonly problem?: string;
};
type Metrics = { ms: number | null; costUsd: number | null; attempts: number | null };
type CaseOutcome = {
  id: string; status: 'valid' | 'invalid' | 'missing' | 'duplicate'; passed: boolean;
  sources: string[]; diagnostics: string[]; metrics: Metrics;
};
const EVENT_TAGS = {
  run_started: true, step_started: true, step_skipped: true, attempt: true,
  backtracked: true, advice: true, call_refused: true, stall_retry: true, call_cancelled: true, step_finished: true, fidelity: true, run_finished: true,
} satisfies Record<RunEvent['t'], true>;
const STOP_TAGS = {
  input_rejected: true, attempts_exhausted: true, no_progress: true, backtrack_limit: true,
  budget_exhausted: true, time_exhausted: true, stage_time_exhausted: true, model_error: true,
  spend_cap: true, cost_unenforceable: true, judge_error: true, infra_unavailable: true, transport_stalled: true, cancelled: true,
} satisfies Record<StopReason['kind'], true>;
const unknownMetrics = (): Metrics => ({ ms: null, costUsd: null, attempts: null });
const record = (v: unknown): Record<string, unknown> | null => typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : null;
const measured = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const count = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const sum = (values: readonly (number | null)[]): number | null => values.includes(null) ? null : measured(values.reduce<number>((n, v) => n + (v ?? 0), 0));

export function validateExpectedCases(expected: readonly ExpectedEvalCase[]): void {
  if (expected.length === 0) throw new Error('Expected set must contain at least one case');
  const seen = new Set<string>();
  for (const c of expected) {
    if (!CASE_ID.test(c.id)) throw new Error('Invalid expected case id');
    if (seen.has(c.id)) throw new Error('Expected set contains a duplicate case id');
    if (c.expect !== 'done' && c.expect !== 'stopped') throw new Error('Invalid expected outcome');
    if (c.change !== undefined && c.change.trim().length === 0) throw new Error('Invalid expected change');
    seen.add(c.id);
  }
}

type PhaseAnalysis = { invalid: boolean; diagnostics: string[]; metrics: Metrics; result: string | null; stop: string | null; runId: string | null; mode: string | null };
function analyzeLog(text: string | null | undefined): PhaseAnalysis {
  const out: PhaseAnalysis = { invalid: false, diagnostics: [], metrics: unknownMetrics(), result: null, stop: null, runId: null, mode: null };
  const invalid = (why: string): PhaseAnalysis => ({ ...out, invalid: true, diagnostics: [why], metrics: unknownMetrics() });
  if (text === undefined || text === null || text.trim() === '') {
    out.diagnostics.push('Event log missing or empty');
    return out;
  }
  const events: Record<string, unknown>[] = [];
  for (const line of text.split('\n').filter((line) => line.trim() !== '')) {
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { return invalid('Invalid event JSON'); }
    const e = record(raw);
    if (e === null || typeof e.t !== 'string' || !Object.hasOwn(EVENT_TAGS, e.t)) return invalid('Unknown or invalid event tag');
    if (typeof e.runId !== 'string' || e.runId.length === 0) return invalid('Missing event run identity');
    events.push(e);
  }
  if (new Set(events.map((e) => e.runId)).size !== 1) return invalid('Mixed run identities');
  const starts = events.filter((e) => e.t === 'run_started');
  const finishes = events.filter((e) => e.t === 'run_finished');
  if (starts.length > 1 || finishes.length > 1 || (starts.length === 1 && events[0]?.t !== 'run_started') ||
      (finishes.length === 1 && events.at(-1)?.t !== 'run_finished')) return invalid('Contradictory run event order');
  const start = starts[0];
  if (start !== undefined) {
    if (start.mode !== 'create' && start.mode !== 'iterate') return invalid('Unknown run mode');
    out.mode = start.mode;
    out.runId = typeof start.runId === 'string' ? start.runId : null;
  }
  const finish = finishes[0];
  if (finish === undefined) {
    out.diagnostics.push('Terminal event missing; totals and attempt coverage unknown');
    return out;
  }
  const result = record(finish.result);
  if (result?.kind !== 'done' && result?.kind !== 'stopped') return invalid('Invalid terminal result');
  out.result = result.kind;
  if (result.kind === 'stopped') {
    const reason = record(result.reason);
    if (typeof reason?.kind !== 'string' || !Object.hasOwn(STOP_TAGS, reason.kind)) return invalid('Unknown terminal stop reason');
    out.stop = reason.kind;
  }
  out.metrics.ms = measured(finish.ms);
  out.metrics.costUsd = measured(finish.costUsd);
  let attemptsKnown = starts.length === 1;
  let attempts = 0;
  const sequence = new Map<string, number>();
  // step_finished.attempts is per invocation; backtracking resets only the target's attempt.n.
  const active = new Map<string, { attempts: number; refused: boolean }>();
  let refused = false;
  let backtrackTo: string | null = null;
  for (const e of events) {
    if (refused && e.t !== 'run_finished') attemptsKnown = false;
    if (e.t === 'step_started') {
      if (typeof e.step !== 'string' || active.size !== 0 || (backtrackTo !== null && e.step !== backtrackTo)) attemptsKnown = false;
      else {
        active.set(e.step, { attempts: 0, refused: false });
        backtrackTo = null;
      }
    } else if (e.t === 'attempt') {
      attempts++;
      const n = count(e.n);
      if (typeof e.step !== 'string' || n === null || n !== (sequence.get(e.step) ?? 0) + 1) attemptsKnown = false;
      if (typeof e.step === 'string') {
        if (n !== null) sequence.set(e.step, n);
        const step = active.get(e.step);
        if (step === undefined || step.refused) attemptsKnown = false;
        else step.attempts++;
      }
    } else if (e.t === 'call_refused') {
      const step = typeof e.step === 'string' ? active.get(e.step) : undefined;
      if (step === undefined) attemptsKnown = false;
      else step.refused = true;
      refused = true;
    } else if (e.t === 'step_finished') {
      const step = typeof e.step === 'string' ? active.get(e.step) : undefined;
      if (step === undefined || step.attempts === 0 || step.refused || count(e.attempts) === null || e.attempts !== step.attempts) attemptsKnown = false;
      if (typeof e.step === 'string') active.delete(e.step);
    } else if (e.t === 'backtracked') {
      // Backtracking ends an invocation without a step_finished event.
      const step = typeof e.from === 'string' ? active.get(e.from) : undefined;
      if (step === undefined || step.attempts === 0 || step.refused || typeof e.to !== 'string') attemptsKnown = false;
      if (typeof e.from === 'string') active.delete(e.from);
      if (typeof e.to === 'string') {
        sequence.set(e.to, 0);
        backtrackTo = e.to;
      }
    }
  }
  for (const step of active.values()) {
    if (out.result === 'done' || (step.attempts === 0 && !step.refused)) attemptsKnown = false;
  }
  if (backtrackTo !== null || (out.result === 'done' && (refused || attempts === 0))) attemptsKnown = false;
  out.metrics.attempts = attemptsKnown ? attempts : null;
  if (Object.values(out.metrics).some((v) => v === null)) out.diagnostics.push('One or more measurements unknown');
  return out;
}

function analyzeCase(expected: ExpectedEvalCase, evidence: readonly EvalEvidence[]): CaseOutcome {
  const out: CaseOutcome = { id: expected.id, status: 'valid', passed: false, sources: evidence.map((e) => e.source), diagnostics: [], metrics: unknownMetrics() };
  const invalid = (why: string): CaseOutcome => ({ ...out, status: 'invalid', diagnostics: [...out.diagnostics, why], metrics: unknownMetrics() });
  if (evidence.length === 0) return { ...out, status: 'missing', diagnostics: ['Expected case evidence missing'] };
  if (evidence.length > 1) return { ...out, status: 'duplicate', diagnostics: ['Multiple records for one expected case'] };
  const e = evidence[0]!;
  if (e.problem !== undefined) return invalid('Evidence path unreadable or unsafe');
  if (e.caseText === null) return invalid('Case record unreadable');
  let raw: unknown;
  try { raw = JSON.parse(e.caseText); } catch { return invalid('Invalid case JSON'); }
  const parsed = caseFileSchema.safeParse(raw);
  if (!parsed.success) return invalid('Invalid case record schema');
  const file = parsed.data;
  if (file.id !== expected.id || file.expect !== expected.expect) return invalid('Case identity or expectation differs from manifest');
  const first = file.phases[0]!;
  const needsChange = expected.change !== undefined && first.result === 'done';
  if (first.phase !== 'create' || file.phases.length !== (needsChange ? 2 : 1) || (needsChange && file.phases[1]?.phase !== 'change')) return invalid('Case phases differ from expected execution order');
  const final = file.phases.at(-1)!;
  if (file.phases.some((p) => (p.result === null) !== (p.error !== null)) ||
      (final.result === 'done') === (file.verify.kind === 'not_run')) return invalid('Case result, error or verification contradicts its phases');
  const phases: PhaseAnalysis[] = [];
  for (const phase of file.phases) {
    const analysis = analyzeLog(e.logs[phase.phase]);
    out.diagnostics.push(...analysis.diagnostics.map((d) => `${phase.phase}: ${d}`));
    if (analysis.invalid) return invalid('Invalid phase event evidence');
    if (analysis.mode !== null && analysis.mode !== (phase.phase === 'create' ? 'create' : 'iterate')) return invalid('Run mode contradicts case phase');
    if (analysis.runId !== null && phases.some((p) => p.runId === analysis.runId)) return invalid('Run identity reused across phases');
    if (analysis.result !== null && phase.result !== analysis.result) return invalid('Case result contradicts terminal event');
    phases.push(analysis);
  }
  if (Object.keys(e.logs).some((name) => !file.phases.some((p) => p.phase === name) && e.logs[name as PhaseName] != null)) return invalid('Event evidence for an unexpected phase');
  out.metrics = {
    ms: sum(phases.map((p) => p.metrics.ms)), costUsd: sum(phases.map((p) => p.metrics.costUsd)), attempts: sum(phases.map((p) => p.metrics.attempts)),
  };
  const stop = phases.at(-1)?.stop;
  out.passed = expected.expect === 'done'
    ? final.result === 'done' && file.verify.kind === 'pass'
    : final.result === 'stopped' && stop != null && stop !== 'model_error';
  return out;
}

function summarize(values: readonly (number | null)[], expected: number) {
  const sample = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
  const measuredTotal = sample.length === 0 ? null : sum(sample);
  return {
    measured: sample.length, expected, coverage: sample.length / expected, measuredTotal,
    total: sample.length === expected ? measuredTotal : null,
    p50: sample[Math.ceil(0.5 * sample.length) - 1] ?? null,
    p95: sample[Math.ceil(0.95 * sample.length) - 1] ?? null,
  };
}

export function analyzeEvalOutcomes(expected: readonly ExpectedEvalCase[], evidence: readonly EvalEvidence[]) {
  validateExpectedCases(expected);
  const known = new Set(expected.map((c) => c.id));
  const cases = expected.map((c) => analyzeCase(c, evidence.filter((e) => e.id === c.id)));
  const unexpected = evidence.filter((e) => !known.has(e.id)).map(({ id, source }) => ({ id, source }));
  const counts = {
    expected: expected.length, observed: evidence.length,
    valid: cases.filter((c) => c.status === 'valid').length,
    invalid: cases.filter((c) => c.status === 'invalid').length,
    missing: cases.filter((c) => c.status === 'missing').length,
    duplicate: cases.filter((c) => c.status === 'duplicate').length, unexpected: unexpected.length,
  };
  const metrics = {
    ms: summarize(cases.map((c) => c.metrics.ms), expected.length),
    costUsd: summarize(cases.map((c) => c.metrics.costUsd), expected.length),
    attempts: summarize(cases.map((c) => c.metrics.attempts), expected.length),
  };
  const passed = cases.filter((c) => c.passed).length;
  const validSuite = counts.valid === expected.length && counts.unexpected === 0;
  return {
    counts, cases, unexpected, passed, passRate: passed / expected.length,
    allPassed: validSuite && passed === expected.length,
    completeSuite: validSuite && Object.values(metrics).every((m) => m.total !== null), metrics,
    percentileMethod: 'nearest-rank: sorted measured case totals at ceil(p × n), one-based; no interpolation; null for no samples',
    interpretation: 'Descriptive evidence only; no improvement claim. Rates use all expected cases; measured totals and percentiles cover only measured expected cases.',
  };
}
