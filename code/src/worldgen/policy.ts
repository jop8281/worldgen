/**
 * When to retry, advance, backtrack or stop. A pure function over a ledger. No model, no IO.
 * test/policy.test.ts covers it with table tests, no fake model needed.
 *
 * Invariants:
 * - One Ledger is threaded through the whole run. Budget checks read it, never a copy.
 * - The same issue set seen twice on one step, within one stretch between backtracks, stops with `no_progress`.
 *   An issue is its code, path and `found` with quoted values masked, so another failing field is progress.
 * - Backtrack targets come from issue owners (ISSUES[code].owner and SECTION_OWNER),
 *   never from a guess.
 * - A backtrack resets the target step's attempts, so it gets its full repair budget again, and starts a new
 *   stretch: every step's seen issue sets are cleared. `maxBacktracks` bounds how often that can happen.
 * - The budget stops further calls, never a finished world: an accepted last step is kept even
 *   when its own call crossed `maxCostUsd`, and the overspend is reported on the decision.
 */
import { ISSUES, type CheckIssue, type Section } from '#engine';
import { stepModel, type Config, type Effort } from './config.ts';
import { assertNever } from '#lib/never';
import type { AttemptOutcome, StopReason } from './events.ts';
import { SECTION_OWNER, isTestRun, type StepId } from './stages.ts';

export type Ledger = {
  readonly startedAtMs: number;
  readonly spentUsd: number;
  readonly attempts: Readonly<Record<StepId, number>>;
  readonly backtracks: number;
  /** Key of each rejected issue set, per step, since the last backtrack. */
  readonly seenIssueSets: Readonly<Record<StepId, readonly string[]>>;
  /** Stalled attempts the loop ran again, per step. They count in `attempts` but not against `maxAttempts`. */
  readonly stallRetries: Readonly<Record<StepId, number>>;
};

/** `last`: no step follows this one in the run (iterate runs can end before `tasks`). Defaults to `step === 'tasks'`. */
export type LoopState = { readonly step: StepId; readonly ledger: Ledger; readonly nowMs: number; readonly last?: boolean };

/** Spend over the limit that an accepted last step was allowed to keep. The loop reports it as a warning. */
export type Overspend = { readonly spentUsd: number; readonly limitUsd: number };

/** An issue plus the step that must fix it. */
export type OwnedIssue = { readonly issue: CheckIssue; readonly owner: StepId };

export type Decision =
  | { readonly kind: 'advance'; readonly overspent?: Overspend }
  | { readonly kind: 'retry' }
  | { readonly kind: 'backtrack'; readonly to: StepId }
  | { readonly kind: 'stop'; readonly reason: StopReason };

/** Step order is dependency order. An owner "earlier" than the current step is a backtrack target. */
const STEP_ORDER: readonly StepId[] = ['plan', 'model', 'workflow', 'seed', 'tasks'];
const rank = (s: StepId): number => STEP_ORDER.indexOf(s);

/** The world section that builds each kind of planned item `planCoverage` checks (plan.ts). */
const PLAN_ITEM_SECTION: Readonly<Record<string, Section>> = { entities: 'entities', routes: 'routes', workflows: 'actions', jobs: 'jobs', tasks: 'tasks' };

/**
 * The step that must fix an issue: `ISSUES[code].owner`, or `path[0]` for `at_path`, mapped
 * through SECTION_OWNER. `plan`, `meta`, `format` and `input` map to the plan step. A test that
 * fails or cannot run (`isTestRun`) maps to workflow; anything else about tests, such as an edit
 * that touches them, maps to plan, which owns them.
 * `fixtures` is written by code, and `model` is the first stage that reads it.
 * A `plan.not_covered` gap rooted at the plan (`path[0] = plan`) is a missing world item, so it
 * belongs to the stage that builds the item's section (`plan/entities/0` -> entities -> model), not
 * to plan, which already named it. A gap rooted at a world section (`seed/tasks`) goes by `path[0]`.
 * Lookups are own-key only, so a name such as `constructor` never reads a prototype member; an
 * unknown root maps to `plan`.
 */
export function ownerOf(issue: CheckIssue): StepId {
  if (isTestRun(issue)) return 'workflow';
  const declared = ISSUES[issue.code].owner;
  const owner = planItemSection(issue) ?? (declared === 'at_path' ? String(issue.path[0]) : declared);
  if (!Object.hasOwn(SECTION_OWNER, owner)) return 'plan';
  const stage = SECTION_OWNER[owner as Section];
  return stage === 'input' ? 'model' : stage;
}

/** The section a plan-rooted `plan.not_covered` gap names (`plan/<kind>/...`), else undefined. */
function planItemSection(issue: CheckIssue): Section | undefined {
  if (issue.code !== 'plan.not_covered' || issue.path[0] !== 'plan') return undefined;
  const kind = String(issue.path[1]);
  return Object.hasOwn(PLAN_ITEM_SECTION, kind) ? PLAN_ITEM_SECTION[kind] : undefined;
}

/** A JSON-style double-quoted literal, or a single-quoted one that is not an apostrophe inside a word. */
const QUOTED = /"(?:[^"\\]|\\.)*"|(?<!\w)'(?:[^'\\]|\\.)*'(?!\w)/g;

/**
 * Canonical key of an issue set: sorted, de-duplicated `code@path: found` entries joined by `|`. Order, expected
 * and hint text do not matter. In `found`, each quoted literal becomes `"*"` and whitespace collapses, so the same
 * field failing with another id is the same issue, while another field or row (`row 0` vs `row 3`) is not.
 */
export function issueSetKey(issues: readonly CheckIssue[]): string {
  const entry = (i: CheckIssue): string => {
    const found = i.found.replace(QUOTED, '"*"').replace(/\s+/g, ' ').trim();
    return `${i.code}@${i.path.join('/')}: ${found}`.replace(/[\\|]/g, '\\$&');
  };
  return [...new Set(issues.map(entry))].sort().join('|');
}

/**
 * The `<entity>.<field>` that a seed issue says one column misses: a seed value the engine refused
 * (`row N, field F:`) or a CSV fixture value written differently (`F: expected`). Null for any other issue.
 */
function missedField(code: string, path: readonly string[], found: string): string | null {
  if (path.length !== 2 || path[0] !== 'seed') return null;
  const named = code === 'constraint.violation' ? [...found.matchAll(/^row \d+, field (\w+):/g)]
    : code === 'plan.not_covered' ? [...found.matchAll(/(\w+): expected /g)] : [];
  const fields = new Set(named.map((m) => m[1]));
  return fields.size === 1 ? `${path[1]}.${[...fields][0]}` : null;
}

/**
 * The one field every blocking seed issue misses, when at least one says a value does not fit the field's type
 * (`field.type`) or a CSV fixture value was written differently. `layer.blocked`, which only follows them, is left out.
 */
function typeMiss(issues: readonly CheckIssue[]): string | null {
  const real = issues.filter((i) => i.code !== 'layer.blocked');
  const fields = new Set(real.map((i) => missedField(i.code, i.path.map(String), i.found)));
  if (real.length === 0 || fields.size !== 1 || fields.has(null)) return null;
  return real.some((i) => i.code === 'plan.not_covered' || i.expected.includes(' to satisfy field.type ')) ? [...fields][0]! : null;
}

/** The one field an issue-set key's seed issues miss, its `layer.blocked` left out, or null. Keys escape `\\` and `|` (issueSetKey). */
function fieldOfKey(key: string): string | null {
  const entries: string[] = [];
  let entry = '';
  for (let i = 0; i < key.length; i++) {
    const c = key[i]!;
    if (c === '\\') entry += key[++i] ?? '';
    else if (c === '|') {
      entries.push(entry);
      entry = '';
    } else entry += c;
  }
  entries.push(entry);
  const fields = new Set(entries.filter((e) => !e.startsWith('layer.blocked@')).map((e) => {
    const at = e.indexOf('@');
    const colon = e.indexOf(': ', at);
    return at < 0 || colon < 0 ? null : missedField(e.slice(0, at), e.slice(at + 1, colon).split('/'), e.slice(colon + 2));
  }));
  return fields.size === 1 && !fields.has(null) ? [...fields][0]! : null;
}

/**
 * The issues that count for an attempt: the blocking errors of a rejection, or all its issues when
 * none block; an `invalid_output`'s own issues. Empty for outcomes that carry no issues.
 */
function countedIssues(outcome: AttemptOutcome, issues: readonly OwnedIssue[]): readonly CheckIssue[] {
  if (outcome.kind === 'invalid_output') return outcome.issues;
  if (outcome.kind !== 'rejected') return [];
  const errors = issues.filter((o) => o.issue.severity === 'error');
  return errors.length > 0 ? errors.map((o) => o.issue) : issues.map((o) => o.issue);
}

/**
 * The issue-set key the loop must pass to `record` for an attempt, and the key `decide` looks up.
 * Null when the outcome is not a rejection (accepted, model_error). Always use this, never
 * `issueSetKey` directly, so warnings alongside errors cannot make the two keys differ.
 */
export function attemptIssueSet(outcome: AttemptOutcome, issues: readonly OwnedIssue[]): string | null {
  if (outcome.kind !== 'rejected' && outcome.kind !== 'invalid_output') return null;
  return issueSetKey(countedIssues(outcome, issues));
}

/** How long a call may take when its step has made none yet, by effort. Absent effort is the model default. */
export const DEFAULT_CALL_MS: Readonly<Record<Effort | 'default', number>> = {
  low: 60_000, medium: 120_000, high: 180_000, default: 180_000, xhigh: 300_000, max: 420_000,
};

/**
 * The first-call figure per step: the p75 of the step's accepted, rejected and invalid_output first calls in the
 * stress-2 and stress-3 runs of 2026-10-07, at the efforts the config gives (A-311, refreshing A-131). p75, not the
 * median (plan 166 s, model 22 s, workflow 28 s, seed 68 s, tasks 115 s): a refusal on the median would let half the
 * calls start with less time than they take. n: plan 49, model 43, workflow 43, seed 37, tasks 32.
 */
export const MEASURED_FIRST_CALL: Readonly<Record<StepId, { readonly effort: Effort; readonly ms: number }>> = {
  plan: { effort: 'high', ms: 206_000 },
  model: { effort: 'high', ms: 26_000 },
  workflow: { effort: 'medium', ms: 41_000 },
  seed: { effort: 'medium', ms: 82_000 },
  tasks: { effort: 'high', ms: 132_000 },
};

/** A first call with no history: the step's measured figure, scaled by the effort ladder when the effort differs; without a step, the ladder. */
function firstCallDefaultMs(effort: Effort | undefined, step: StepId | undefined): number {
  const ladder = DEFAULT_CALL_MS[effort ?? 'default'];
  if (step === undefined) return ladder;
  const m = MEASURED_FIRST_CALL[step];
  return Math.round((m.ms * ladder) / DEFAULT_CALL_MS[m.effort]);
}

/** A finished call's duration, and whether it was a repair (`nextIsRepair`). */
export type CallRecord = { readonly ms: number; readonly repair: boolean };

/**
 * Whether a step's next call is a repair: it carries feedback, or the step already made a first call. A rerun after a
 * backtrack with no feedback of its own still finds its earlier answer in the world. Eleven such live reruns took a
 * median 0.36 of their first call, p75 0.64 (A-349). So the preflight in run.ts and the reserve below price it the same
 * way, as a repair.
 */
export function nextIsRepair(history: readonly CallRecord[], feedback: boolean): boolean {
  return feedback || history.some((c) => !c.repair);
}

/** A repair rewrites only what the engine rejected. Live seed and workflow repairs took 0.16 to 0.19 of the first call, one workflow repair 0.76. */
export const REPAIR_FRACTION = 0.25;

/**
 * A call's expected duration, from calls of its own kind. A first call: the slowest of the step's last three first
 * calls, else the effort's default. A repair: the slowest of its last three repairs, else REPAIR_FRACTION of the
 * slowest first call, else of the effort's default. A repair never inherits a first call's time.
 */
export function estimateCallMs(effort: Effort | undefined, history: readonly CallRecord[], repair: boolean, step?: StepId): number {
  const slowest = (own: boolean): number | null => {
    const ms = history.filter((c) => c.repair === own).slice(-3).map((c) => c.ms);
    return ms.length === 0 ? null : Math.max(...ms);
  };
  if (!repair) return slowest(false) ?? firstCallDefaultMs(effort, step);
  return slowest(true) ?? REPAIR_FRACTION * (slowest(false) ?? firstCallDefaultMs(effort, step));
}

/** Ms left before `maxMinutes` runs out at `nowMs`. Never negative. */
export function remainingMs(config: Config, ledger: Ledger, nowMs: number): number {
  return Math.max(0, config.maxMinutes * 60_000 - (nowMs - ledger.startedAtMs));
}

/** Each step's finished calls, oldest first. */
export type CallHistory = Readonly<Record<StepId, readonly CallRecord[]>>;

export const NO_CALLS: CallHistory = { plan: [], model: [], workflow: [], seed: [], tasks: [] };

/**
 * Ms a later step keeps while an earlier step runs: the estimate of its next call at its configured effort (A-311).
 * A step that already made a first call runs again only after a backtrack, as a repair (A-139, A-349), tasks included
 * (A-330). Before its first call a step keeps a whole first call (A-114). `steps[step].reserve` of `maxMinutes` is a floor.
 */
function reserveMs(config: Config, step: StepId, history: CallHistory): number {
  const calls = history[step];
  const estimate = estimateCallMs(stepModel(config, step, false).effort, calls, nextIsRepair(calls, false), step);
  return Math.max(estimate, (config.steps[step].reserve ?? 0) * config.maxMinutes * 60_000);
}

/**
 * Ms `step` may still use: the run's time left minus the reserves of the steps after it (`reserveMs`), but never less
 * than `steps[step].minShareSeconds` while that much time is left (A-185). Never negative. The last step gets all that is left.
 */
export function stepShareMs(config: Config, ledger: Ledger, step: StepId, nowMs: number, history: CallHistory = NO_CALLS): number {
  const reserved = STEP_ORDER.slice(STEP_ORDER.indexOf(step) + 1).reduce((ms, later) => ms + reserveMs(config, later, history), 0);
  const left = remainingMs(config, ledger, nowMs);
  const floorMs = Math.min((config.steps[step].minShareSeconds ?? 0) * 1000, left);
  return Math.max(0, Math.round(Math.max(left - reserved, floorMs)));
}

/**
 * Before a call: stop when it would not fit. Budget first: budget_exhausted when spent plus `estimateUsd`
 * passes `maxCostUsd`. Then time_exhausted when `estimateMs` is more than the time left. Then, given `step`,
 * stage_time_exhausted when `estimateMs` is more than that step's share (`stepShareMs`).
 */
export function preflight(config: Config, ledger: Ledger, nowMs: number, estimateUsd: number, estimateMs: number, step?: StepId, history: CallHistory = NO_CALLS): StopReason | null {
  if (ledger.spentUsd + estimateUsd > config.maxCostUsd) {
    return { kind: 'budget_exhausted', spentUsd: ledger.spentUsd, limitUsd: config.maxCostUsd };
  }
  const left = remainingMs(config, ledger, nowMs);
  if (estimateMs > left) {
    return step === undefined
      ? { kind: 'time_exhausted', minutes: config.maxMinutes }
      : { kind: 'time_exhausted', minutes: config.maxMinutes, refused: { step, estimateMs, remainingMs: left } };
  }
  if (step !== undefined) {
    const shareMs = stepShareMs(config, ledger, step, nowMs, history);
    if (estimateMs > shareMs) return { kind: 'stage_time_exhausted', step, shareMs };
  }
  return null;
}

/**
 * Call `record` (with `attemptIssueSet`) for the attempt just made, then `decide`. So `ledger.attempts[step]` counts
 * that attempt, and `seenIssueSets[step]` already holds its set.
 * Order of rules: budget, time, accepted, share_expired, judge_expired, stalled, model_error, backtrack, a seed's second
 * miss on one field's type (back to model, A-368), no_progress (a
 * repeated failing test at workflow or seed, or a repeated unmet pressure claim at tasks, backtracks to plan instead), attempts, retry.
 * A stalled call is the transport's failure, not the model's: it retries once per step (`stallRetries`), outside
 * `maxAttempts`, and preflight decides whether the retry fits in the time left. A second stall stops.
 * Budget: at or over `maxCostUsd` stops, except an accepted last step, which advances with
 * `overspent` so the world is saved. Any other step would need a further call, which the budget forbids.
 */
export function decide(config: Config, state: LoopState, outcome: AttemptOutcome, issues: readonly OwnedIssue[]): Decision {
  const { step, ledger, nowMs } = state;
  const last = state.last ?? step === 'tasks';
  const overBudget = ledger.spentUsd >= config.maxCostUsd;
  if (overBudget && !(outcome.kind === 'accepted' && last)) {
    return { kind: 'stop', reason: { kind: 'budget_exhausted', spentUsd: ledger.spentUsd, limitUsd: config.maxCostUsd } };
  }
  if (nowMs - ledger.startedAtMs >= config.maxMinutes * 60_000) {
    return { kind: 'stop', reason: { kind: 'time_exhausted', minutes: config.maxMinutes } };
  }
  switch (outcome.kind) {
    case 'accepted':
      return overBudget ? { kind: 'advance', overspent: { spentUsd: ledger.spentUsd, limitUsd: config.maxCostUsd } } : { kind: 'advance' };
    case 'share_expired':
      return { kind: 'stop', reason: { kind: 'stage_time_exhausted', step, shareMs: outcome.shareMs } };
    case 'judge_expired':
      return { kind: 'stop', reason: { kind: 'time_exhausted', minutes: config.maxMinutes } };
    case 'stalled':
      return ledger.stallRetries[step] >= 1 ? { kind: 'stop', reason: { kind: 'transport_stalled', step, idleMs: outcome.idleMs } } : { kind: 'retry' };
    case 'model_error':
      return { kind: 'stop', reason: { kind: 'model_error', message: outcome.message } };
    case 'judge_error':
      return { kind: 'stop', reason: { kind: 'judge_error', step, message: outcome.message } };
    case 'infra_unavailable':
      return { kind: 'stop', reason: { kind: 'infra_unavailable', step, issues: outcome.issues } };
    case 'rejected':
    case 'invalid_output':
      break;
    default:
      return assertNever(outcome);
  }

  // invalid_output issues describe the proposal's shape, not the world, so they never backtrack. A rejection with no
  // error was blocked by its warnings, such as seed.too_few_rows_for_paging at tasks, so those decide where it goes (A-270).
  const errors = issues.filter((o) => o.issue.severity === 'error');
  const owned = outcome.kind === 'rejected' ? (errors.length > 0 ? errors : issues) : [];
  const lastIssues = countedIssues(outcome, issues);

  if (owned.length > 0 && owned.every((o) => rank(o.owner) < rank(step))) {
    if (ledger.backtracks >= config.maxBacktracks) {
      return { kind: 'stop', reason: { kind: 'backtrack_limit', step, backtracks: ledger.backtracks } };
    }
    const to = owned.map((o) => o.owner).reduce((a, b) => (rank(b) < rank(a) ? b : a));
    return { kind: 'backtrack', to };
  }

  const key = issueSetKey(lastIssues);
  // Same value as attemptIssueSet(outcome, issues), which the loop records.
  const seen = (ledger.seenIssueSets[step] ?? []).filter((k) => k === key).length;
  // A seed that misses one field twice in a row, the second time on its type, is held by the type the model step
  // chose, so it goes back there while a backtrack is left. A first miss stays: the seed may fix its own value (A-368).
  if (step === 'seed' && seen < 2 && ledger.backtracks < config.maxBacktracks) {
    const field = typeMiss(owned.map((o) => o.issue));
    const prior = ledger.seenIssueSets.seed;
    const before = prior.at(-1) === key ? prior.at(-2) : prior.at(-1);
    if (field !== null && before !== undefined && before !== key && fieldOfKey(before) === field) return { kind: 'backtrack', to: 'model' };
  }
  if (seen >= 2) {
    // Neither workflow nor seed can edit the plan's frozen tests, so a test they keep failing goes back to the plan that wrote it (A-161, A-165).
    if ((step === 'workflow' || step === 'seed') && owned.length > 0 && owned.every((o) => isTestRun(o.issue))) {
      if (ledger.backtracks >= config.maxBacktracks) {
        return { kind: 'stop', reason: { kind: 'backtrack_limit', step, backtracks: ledger.backtracks } };
      }
      return { kind: 'backtrack', to: 'plan' };
    }
    // A pressure claim the tasks step keeps missing is the plan's to drop: the seed cannot make it true (A-285).
    if (step === 'tasks' && owned.length > 0 && owned.every((o) => o.issue.code === 'task.pressure_unmet')) {
      if (ledger.backtracks >= config.maxBacktracks) {
        return { kind: 'stop', reason: { kind: 'backtrack_limit', step, backtracks: ledger.backtracks } };
      }
      return { kind: 'backtrack', to: 'plan' };
    }
    return { kind: 'stop', reason: { kind: 'no_progress', step, repeatedIssueSet: key, lastIssues } };
  }
  const attempts = ledger.attempts[step];
  if (attempts - ledger.stallRetries[step] >= config.steps[step].maxAttempts) {
    return { kind: 'stop', reason: { kind: 'attempts_exhausted', step, attempts, lastIssues } };
  }
  return { kind: 'retry' };
}

/** Account one attempt: +1 attempt, +cost, and the rejected issue set (null when accepted). Returns a new Ledger. */
export function record(ledger: Ledger, step: StepId, costUsd: number, issueSet: string | null): Ledger {
  return {
    ...ledger,
    spentUsd: ledger.spentUsd + costUsd,
    attempts: { ...ledger.attempts, [step]: ledger.attempts[step] + 1 },
    seenIssueSets:
      issueSet === null ? ledger.seenIssueSets : { ...ledger.seenIssueSets, [step]: [...(ledger.seenIssueSets[step] ?? []), issueSet] },
  };
}

/**
 * Account one backtrack to `to`: +1 backtrack, and `to` starts over with zero attempts and zero stall retries, so the
 * step that must repair an upstream error gets its full `maxAttempts`. `record` takes no flag for it, so the
 * loop calls this when it follows a `backtrack` decision. Seen issue sets are cleared for every step: the
 * rerun changes the world the later steps answer against, so a set seen before it is not a repeat (A-124).
 */
export function recordBacktrack(ledger: Ledger, to: StepId): Ledger {
  return {
    ...ledger,
    backtracks: ledger.backtracks + 1,
    attempts: { ...ledger.attempts, [to]: 0 },
    stallRetries: { ...ledger.stallRetries, [to]: 0 },
    seenIssueSets: { plan: [], model: [], workflow: [], seed: [], tasks: [] },
  };
}

/** Account one stall retry on `step`. The loop calls this when it follows a `retry` decision for a `stalled` attempt. */
export function recordStallRetry(ledger: Ledger, step: StepId): Ledger {
  return { ...ledger, stallRetries: { ...ledger.stallRetries, [step]: ledger.stallRetries[step] + 1 } };
}
