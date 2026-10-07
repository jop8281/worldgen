/**
 * The observability vocabulary. Every step, attempt, repair, backtrack, time and cost is
 * one RunEvent. createEmitter writes runs/<runId>/events.jsonl and a one-line console view.
 *
 * Invariants:
 * - RunEvent, StopReason and AttemptOutcome are closed unions. Every switch over them ends
 *   in assertNever (architecture test).
 * - `advice` is the only place model commentary goes. Acceptance never reads it.
 * - Events carry InputDigest facts, never raw input.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { assertNever } from '#lib/never';
import type { CheckIssue } from '#engine';
import { capReached, type CapName, type SpendEvent } from '../costs/ledger.ts';
import type { Transport } from './config.ts';
import type { InputKind } from './input.ts';
import type { Usage } from './llm.ts';
import type { StageId, StepId } from './stages.ts';

export type StopReason =
  | { readonly kind: 'input_rejected'; readonly why: string }
  | { readonly kind: 'attempts_exhausted'; readonly step: StepId; readonly attempts: number; readonly lastIssues: readonly CheckIssue[] }
  | { readonly kind: 'no_progress'; readonly step: StepId; readonly repeatedIssueSet: string; readonly lastIssues: readonly CheckIssue[] }
  | { readonly kind: 'backtrack_limit'; readonly step: StepId; readonly backtracks: number }
  /** This run's own spend reached its per-run budget, `maxCostUsd`. */
  | { readonly kind: 'budget_exhausted'; readonly spentUsd: number; readonly limitUsd: number }
  /** The spend ledger, shared by every session, refused a call: `cap` was reached on `day` (UTC) or in all time. */
  | { readonly kind: 'spend_cap'; readonly cap: CapName; readonly capUsd: number; readonly spentUsd: number; readonly day: string }
  /** `refused` is set when preflight refused a call because it could not finish in the time left: the step, its estimate and the time left. Absent when the clock simply ran out. */
  | { readonly kind: 'time_exhausted'; readonly minutes: number; readonly refused?: { readonly step: StepId; readonly estimateMs: number; readonly remainingMs: number } }
  /** A call preflight refused, or the transport ended at its step share, because it would eat the time reserved for later steps. */
  | { readonly kind: 'stage_time_exhausted'; readonly step: StepId; readonly shareMs: number }
  | { readonly kind: 'model_error'; readonly message: string }
  | { readonly kind: 'judge_error'; readonly step: StepId; readonly message: string }
  /** The engine could not judge a proposal: its snippet host failed to start after a recheck. Not the model's fault. */
  | { readonly kind: 'infra_unavailable'; readonly step: StepId; readonly issues: readonly CheckIssue[] }
  /** The transport stalled twice on one step: the claude CLI wrote nothing for `idleMs`, was stopped, retried, and stalled again. */
  | { readonly kind: 'transport_stalled'; readonly step: StepId; readonly idleMs: number }
  /** The operator stopped the run (SIGINT or SIGTERM to the CLI, or Studio's stop): the in-flight call was cancelled and billed. */
  | { readonly kind: 'cancelled' };

/** How far a call the transport cut off had got (llm.ts CallProgress, trimmed): `outputTokens` is a lower bound, `outputBytes` the answer streamed. */
export type CutProgress = { readonly messages: number; readonly outputTokens: number; readonly schemaRetries: number; readonly outputBytes: number };

export type AttemptOutcome =
  | { readonly kind: 'accepted'; readonly warnings: number }
  /** Engine check, plan coverage, stage `done`, or the iterate gate refused it. */
  | { readonly kind: 'rejected'; readonly issues: readonly CheckIssue[] }
  /** The proposal did not parse as a WorldEdit or Plan. */
  | { readonly kind: 'invalid_output'; readonly issues: readonly CheckIssue[] }
  /**
   * The call ran out of the step's time share (StepShareExpired). A time stop. `progress` is null when the call never
   * returned at all, so there was no stream to read.
   */
  | { readonly kind: 'share_expired'; readonly shareMs: number; readonly progress: CutProgress | null }
  /** The transport stopped the call because it wrote nothing for `idleMs` (CallStalled). */
  | { readonly kind: 'stalled'; readonly idleMs: number; readonly progress: CutProgress }
  | { readonly kind: 'model_error'; readonly message: string }
  | { readonly kind: 'judge_error'; readonly message: string }
  /** The run deadline passed while the engine was still checking the proposal, so it was never judged. A time stop, never a CheckIssue (A-118). */
  | { readonly kind: 'judge_expired' }
  /** The engine's snippet host did not start, even on a recheck, so the proposal was never judged. Never shown to the model. */
  | { readonly kind: 'infra_unavailable'; readonly issues: readonly CheckIssue[] };

type At = { readonly at: string; readonly runId: string };

/**
 * How a finished create run's resemblance to the real software was checked (W10, A-260 follow-up):
 * against the OpenAPI source spec, against a frozen fidelity reference with its score and floor, or
 * not at all, which REPORT.md then says.
 */
export type FidelityCheck =
  | { readonly kind: 'openapi' }
  | { readonly kind: 'reference'; readonly reference: string; readonly score: number; readonly floor: number }
  | { readonly kind: 'unchecked'; readonly software: string };

export type RunEvent = At &
  (
    | { readonly t: 'run_started'; readonly mode: 'create' | 'iterate'; readonly input: InputKind | 'change_request';
        readonly model: string; readonly budgetUsd: number;
        /** How model calls are made (U-11). Absent only in logs written before YOS-35. */
        readonly transport?: Transport }
    | { readonly t: 'step_started'; readonly step: StepId; readonly reason: 'planned' | 'changed' | 'backtracked' }
    | { readonly t: 'step_skipped'; readonly step: StageId; readonly why: string }
    | { readonly t: 'attempt'; readonly step: StepId; readonly n: number; readonly ms: number; readonly usage: Usage;
        readonly costUsd: number | null; readonly partialModelUsage?: SpendEvent['partialModelUsage']; readonly outcome: AttemptOutcome; readonly dump: string }
    | { readonly t: 'backtracked'; readonly from: StepId; readonly to: StepId; readonly because: readonly CheckIssue[] }
    | { readonly t: 'advice'; readonly step: StepId; readonly text: string }
    /** A call preflight refused before it was made: it would not fit in the budget or time left. */
    | { readonly t: 'call_refused'; readonly step: StepId; readonly reason: StopReason; readonly estimateUsd: number;
        readonly estimateMs: number; readonly remainingMs: number }
    /** Attempt `n` stalled and the step runs it again with the same prompt, outside `maxAttempts`. */
    | { readonly t: 'stall_retry'; readonly step: StepId; readonly n: number; readonly idleMs: number; readonly remainingMs: number }
    /** The run deadline cancelled this call. A null cost means billing could not be confirmed. */
    | { readonly t: 'call_cancelled'; readonly step: StepId; readonly ms: number; readonly costUsd: number | null; readonly partialModelUsage?: SpendEvent['partialModelUsage'] }
    | { readonly t: 'step_finished'; readonly step: StepId; readonly attempts: number; readonly ms: number; readonly costUsd: number }
    | { readonly t: 'fidelity'; readonly check: FidelityCheck }
    | { readonly t: 'run_finished'; readonly ms: number; readonly costUsd: number; readonly unknownCostCalls?: number; readonly worldWritten: boolean | null;
        readonly result: { readonly kind: 'done'; readonly worldDir: string } | { readonly kind: 'stopped'; readonly reason: StopReason } | { readonly kind: 'crashed'; readonly message: string } }
  );

export type Emit = (e: RunEvent) => void;

function summarize(e: RunEvent): string {
  const head = `[${e.runId}]`;
  switch (e.t) {
    case 'run_started':
      return `${head} run started: ${e.mode} from ${e.input}, model ${e.model}, budget $${e.budgetUsd.toFixed(2)}`;
    case 'step_started':
      return `${head} ${e.step} started (${e.reason})`;
    case 'step_skipped':
      return `${head} ${e.step} skipped: ${e.why}`;
    case 'attempt':
      return `${head} ${e.step} attempt ${e.n}: ${e.outcome.kind}, ${e.ms}ms, ${e.costUsd === null ? 'cost unknown' : `$${e.costUsd.toFixed(4)}`}`;
    case 'backtracked':
      return `${head} backtracked ${e.from} -> ${e.to} (${e.because.length} issues)`;
    case 'call_refused':
      return `${head} ${e.step} call refused: ${describeStop(e.reason)}; estimated $${e.estimateUsd.toFixed(4)} and ${Math.round(e.estimateMs / 1000)}s with ${Math.round(e.remainingMs / 1000)}s left`;
    case 'call_cancelled':
      return `${head} ${e.step} call cancelled at run deadline: ${e.ms}ms, ${e.costUsd === null ? 'cost unknown' : `$${e.costUsd.toFixed(4)}`}`;
    case 'advice':
      return `${head} ${e.step} advice: ${e.text}`;
    case 'stall_retry':
      return `${head} ${e.step} attempt ${e.n} stalled: no output for ${Math.round(e.idleMs / 1000)}s; retrying once with ${Math.round(e.remainingMs / 1000)}s left`;
    case 'step_finished':
      return `${head} ${e.step} finished: ${e.attempts} attempts, ${e.ms}ms, $${e.costUsd.toFixed(4)}`;
    case 'fidelity':
      return `${head} fidelity: ${e.check.kind === 'openapi' ? 'checked against the OpenAPI source spec' : e.check.kind === 'reference' ? `${e.check.score} against reference ${e.check.reference} (floor ${e.check.floor})` : `not checked: no frozen reference for ${e.check.software}`}`;
    case 'run_finished':
      return `${head} run finished: ${e.result.kind === 'done' ? 'done' : e.result.kind === 'crashed' ? `crashed (${e.result.message})` : `stopped (${e.result.reason.kind})`}, ${e.ms}ms, $${e.costUsd.toFixed(4)}${e.unknownCostCalls ? ` known; ${e.unknownCostCalls} call(s) have unknown cost` : ''}`;
    default:
      return assertNever(e);
  }
}

/** Distinct issue codes, at most five, then a count of the rest. */
function codeList(issues: readonly CheckIssue[]): string {
  const codes = [...new Set(issues.map((i) => i.code))];
  if (codes.length === 0) return 'none';
  const shown = codes.slice(0, 5).join(', ');
  return codes.length > 5 ? `${shown}, +${codes.length - 5} more` : shown;
}

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** The refused call in words: the next call (step), its estimate and the time left, in whole seconds. */
export function refusedText(r: { readonly step: StepId; readonly estimateMs: number; readonly remainingMs: number }): string {
  return `the next call (${r.step}) needed ~${Math.round(r.estimateMs / 1000)} s and ${Math.round(r.remainingMs / 1000)} s were left`;
}

/** A StopReason on one line: its kind, then what it carries. The worldgen CLI prints this on a stop. */
export function describeStop(reason: StopReason): string {
  switch (reason.kind) {
    case 'input_rejected':
      return `input_rejected: ${flat(reason.why)}`;
    case 'attempts_exhausted':
      return `attempts_exhausted: ${reason.step} still rejected after ${reason.attempts} attempts (last issues: ${codeList(reason.lastIssues)})`;
    case 'no_progress':
      return `no_progress: ${reason.step} kept returning the same issues (last issues: ${codeList(reason.lastIssues)})`;
    case 'backtrack_limit':
      return `backtrack_limit: ${reason.step} after ${reason.backtracks} backtracks`;
    case 'budget_exhausted':
      return `budget_exhausted: this run spent $${reason.spentUsd.toFixed(4)} of its per-run budget maxCostUsd=$${reason.limitUsd.toFixed(2)}`;
    case 'spend_cap':
      return `spend_cap: ${capReached(reason.cap, reason.capUsd, reason.spentUsd, reason.day)}`;
    case 'time_exhausted':
      return reason.refused === undefined
        ? `time_exhausted: hit the ${reason.minutes}-minute limit`
        : `time_exhausted: ${refusedText(reason.refused)}`;
    case 'stage_time_exhausted':
      return `stage_time_exhausted: ${reason.step} has ${Math.round(reason.shareMs / 1000)}s before the time reserved for later steps`;
    case 'model_error':
      return `model_error: ${flat(reason.message)}`;
    case 'judge_error':
      return `judge_error: ${reason.step}: ${flat(reason.message)}`;
    case 'infra_unavailable':
      return `infra_unavailable: the engine could not run ${reason.step} snippets (${codeList(reason.issues)}); rerun when the machine is less busy`;
    case 'cancelled':
      return 'cancelled: the operator stopped the run';
    case 'transport_stalled':
      return `transport_stalled: the claude CLI went silent for ${Math.round(reason.idleMs / 1000)} s on the ${reason.step} step; billing is unknown`;
    default:
      return assertNever(reason);
  }
}

/**
 * The console view with run totals. An attempt line carries the run's spend so far (summed
 * from attempt events) and the time since run_started (from event timestamps, so it reads no
 * clock). Every other line is the plain summary.
 */
function progressView(): (e: RunEvent) => string {
  let startedMs: number | null = null;
  let spentUsd = 0;
  let unknownCostCalls = 0;
  return (e) => {
    if (e.t === 'run_started') {
      startedMs = Date.parse(e.at);
      spentUsd = 0;
      unknownCostCalls = 0;
    }
    if (e.t !== 'attempt') return summarize(e);
    spentUsd += e.costUsd ?? 0;
    if (e.costUsd === null) unknownCostCalls += 1;
    const elapsedMs = startedMs === null ? 0 : Date.parse(e.at) - startedMs;
    return `[${e.runId}] ${e.step} attempt ${e.n}: ${e.outcome.kind}, $${spentUsd.toFixed(4)} ${unknownCostCalls > 0 ? 'known + unknown' : 'spent'}, ${(elapsedMs / 1000).toFixed(1)}s elapsed`;
  };
}

export type EmitterOptions = {
  readonly console: boolean;
  /** With console: attempt lines show the run's cumulative $ and elapsed time instead of the attempt's own ms and $. */
  readonly progress?: boolean;
};

/**
 * Keeps every event, appends each to `<runDir>/events.jsonl`, and prints a one-line view when
 * `console` is set. A null runDir writes no file: the worldgen CLI's console view passes null,
 * since runWorldGen already writes events.jsonl under the world's runs/ directory.
 */
export function createEmitter(runDir: string | null, opts: EmitterOptions = { console: false }): Emit & { events(): readonly RunEvent[] } {
  if (runDir !== null) mkdirSync(runDir, { recursive: true });
  const file = runDir === null ? null : join(runDir, 'events.jsonl');
  const view = opts.progress === true ? progressView() : summarize;
  const seen: RunEvent[] = [];
  const emit = (e: RunEvent): void => {
    seen.push(e);
    if (file !== null) appendFileSync(file, `${JSON.stringify(e)}\n`);
    if (opts.console) console.log(view(e));
  };
  return Object.assign(emit, { events: (): readonly RunEvent[] => [...seen] });
}
