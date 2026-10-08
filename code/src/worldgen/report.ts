/**
 * REPORT.md, rendered by code from the plan, the engine's check report and verdicts, the world
 * delta and the run events. No model writes any of it.
 *
 * Invariants:
 * - Takes no Model and imports nothing from llm.ts (A-35, architecture test).
 * - Proof numbers come only from engine TaskVerdicts (A-29). On a stop the report claims no
 *   world and no verified task, even when a check report is passed (A-39).
 * - Proof names the world and each task by engine content id (A-121).
 * - Pure: the same input always renders the same text. Model commentary (`advice`) is never
 *   rendered.
 */
import { assertNever } from '#lib/never';
import { DESTRUCTIVE, taskIdOf, worldIdOf, type CheckIssue, type CheckReport, type Task, type TaskVerdict, type World, type WorldChange, type WorldDelta } from '#engine';
import { capReached, unenforceable } from '../costs/ledger.ts';
import { fixtureFed } from './input-coverage.ts';
import { refusedText, type AttemptOutcome, type CutProgress, type FidelityCheck, type RunEvent, type StopReason } from './events.ts';
import type { Plan } from './plan.ts';
import { pressureChecks, type StepId } from './stages.ts';

export type ReportInput = {
  /** Absent when the run stopped before a plan was made. */
  readonly plan?: Plan | undefined;
  /** The engine's report on the world handed over. Ignored on a stop. */
  readonly report?: Extract<CheckReport, { ok: true }> | undefined;
  /** Iterate: what changed against the previous world. */
  readonly delta?: WorldDelta | undefined;
  readonly events: readonly RunEvent[];
  readonly stop?: StopReason | undefined;
  /** The input's field names (InputDigest.sourceFields). With a report, the world's fields the input never names are listed as invented. */
  readonly sourceFields?: readonly string[] | undefined;
  readonly crash?: { readonly message: string; readonly worldWritten: boolean | null } | undefined;
};

/** Most issues the stop block lists. The rest are counted. */
const MAX_ISSUES = 10;

const plural = (n: number, word: string): string => `${n} ${n === 1 ? word : `${word}s`}`;
const minutes = (ms: number): string => (ms / 60000).toFixed(2);
const usd = (n: number): string => n.toFixed(4);
const score = (n: number): string => n.toFixed(3);
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** A list item. Continuation lines are indented so text that spans lines stays inside its item. */
function item(text: string, depth = 0): string {
  const pad = '  '.repeat(depth);
  return `${pad}- ${text.split(/\r?\n/).join(`\n${pad}  `)}`;
}

const issueItem = (i: CheckIssue): string => item(`\`${i.code}\` at \`${i.path.join('.')}\`: ${i.hint}`);

/** Why the run stopped, in one sentence, and the issues it last saw. */
function stopFacts(stop: StopReason, events: readonly RunEvent[]): { why: string; issues: readonly CheckIssue[] } {
  const cut = lastAttempt(events);
  if (stop.kind === 'time_exhausted' && cut?.outcome.kind === 'judge_expired') {
    return { why: `The run hit its ${stop.minutes}-minute limit while the engine was still checking the ${cut.step} step's proposal, so the check was cut short and the proposal was not judged.`, issues: [] };
  }
  switch (stop.kind) {
    case 'input_rejected':
      return { why: `The input was rejected: ${stop.why}`, issues: lastAttemptIssues(events) };
    case 'attempts_exhausted':
      return { why: `The ${stop.step} step was still rejected after ${plural(stop.attempts, 'attempt')}.`, issues: stop.lastIssues };
    case 'no_progress':
      return { why: `The ${stop.step} step made no progress: the same issues came back.`, issues: stop.lastIssues };
    case 'backtrack_limit':
      return { why: `The ${stop.step} step hit the backtrack limit after ${plural(stop.backtracks, 'backtrack')}.`, issues: lastAttemptIssues(events) };
    case 'budget_exhausted':
      return { why: `The run spent $${usd(stop.spentUsd)} of its per-run budget maxCostUsd=$${stop.limitUsd.toFixed(2)} (this run only; set by --budget-usd or worldgen.config.json).`, issues: lastAttemptIssues(events) };
    case 'cost_unenforceable':
      return { why: `The run was ${unenforceable(stop.cap, stop.claim)}. Spend of unknown cost, from any session, blocks every capped run until it is settled.`, issues: lastAttemptIssues(events) };
    case 'spend_cap':
      return { why: `The run was refused by a spend cap shared by every session, not by its own budget: ${capReached(stop.cap, stop.capUsd, stop.spentUsd, stop.day)}.`, issues: lastAttemptIssues(events) };
    case 'time_exhausted':
      return { why: stop.refused === undefined ? `The run hit its ${stop.minutes}-minute limit.` : `The run did not reach its ${stop.minutes}-minute limit: ${refusedText(stop.refused)}.`, issues: lastAttemptIssues(events) };
    case 'stage_time_exhausted': {
      const last = lastAttemptOutcome(events);
      if (last?.kind === 'share_expired') return { why: shareCutText(stop.step, stop.shareMs, last.progress), issues: [] };
      return { why: `The ${stop.step} step had ${Math.round(stop.shareMs / 1000)} seconds left before the time reserved for the steps after it, and its next call would not fit.`, issues: lastAttemptIssues(events) };
    }
    case 'model_error':
      return { why: `The model call failed: ${stop.message}`, issues: lastAttemptIssues(events) };
    case 'judge_error':
      return { why: `The engine could not finish judging ${stop.step}: ${stop.message}`, issues: [] };
    case 'infra_unavailable':
      return { why: `The engine's snippet host did not start while checking ${stop.step}, even on a recheck. The proposal was not judged and the model was not asked to change it. Rerun when the machine is less busy.`, issues: stop.issues };
    case 'cancelled':
      return { why: 'The operator stopped the run. The call in flight was cancelled and its cost recorded, and no world was written.', issues: [] };
    case 'transport_stalled':
      return { why: `The claude CLI went silent for ${Math.round(stop.idleMs / 1000)} s on the ${stop.step} step. The run stopped with unknown billing; reconcile the interrupted charge before resuming.`, issues: [] };
    default:
      return assertNever(stop);
  }
}

/** A call cut at its share: still writing, sent nothing, or (progress null) never returned, so nothing was read. */
function shareCutText(step: StepId, shareMs: number, progress: CutProgress | null): string {
  const share = `its ${Math.round(shareMs / 1000)} s share ran out`;
  const fix = `Raise maxMinutes, or lower the ${step} effort in stepModels.`;
  if (progress === null) return `The ${step} call did not return before ${share}, so the run stopped. ${fix}`;
  if (progress.outputTokens === 0 && progress.outputBytes === 0) return `The ${step} call sent nothing before ${share}, so the run stopped. ${fix}`;
  const sofar = [
    plural(progress.messages, 'message'),
    `${progress.outputTokens.toLocaleString('en-US')} output tokens and ${progress.outputBytes.toLocaleString('en-US')} answer bytes so far`,
    ...(progress.schemaRetries === 0 ? [] : [`${progress.schemaRetries} schema ${progress.schemaRetries === 1 ? 'retry' : 'retries'} by the CLI`]),
  ];
  return `The ${step} call was still writing when ${share} (${sofar.join(', ')}), so the run stopped. ${fix}`;
}

/** The last attempt event, if any. */
function lastAttempt(events: readonly RunEvent[]): Extract<RunEvent, { t: 'attempt' }> | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const e = events[i];
    if (e !== undefined && e.t === 'attempt') return e;
  }
  return undefined;
}

/** The outcome of the last attempt event, if any. */
function lastAttemptOutcome(events: readonly RunEvent[]): AttemptOutcome | undefined {
  return lastAttempt(events)?.outcome;
}

/** The engine issues of the last attempt, or none when it was accepted or never reached the engine. */
function lastAttemptIssues(events: readonly RunEvent[]): readonly CheckIssue[] {
  const o = lastAttemptOutcome(events);
  if (o === undefined) return [];
  switch (o.kind) {
    case 'rejected':
    case 'invalid_output':
      return o.issues;
    case 'accepted':
    case 'share_expired':
    case 'judge_expired':
    case 'stalled':
    case 'model_error':
    case 'judge_error':
      return [];
    case 'infra_unavailable':
      return o.issues;
    default:
      return assertNever(o);
  }
}

function stopBlocks(stop: StopReason, events: readonly RunEvent[]): string[] {
  const { why, issues } = stopFacts(stop, events);
  const out = [`Stopped: ${stop.kind}`, why, 'No world.yaml was written.'];
  if (issues.length === 0) return [...out, 'Last issues: none recorded.'];
  const shown = issues.slice(0, MAX_ISSUES).map(issueItem);
  const more = issues.length - MAX_ISSUES;
  if (more > 0) shown.push(item(`${plural(more, 'more issue')} ${more === 1 ? 'is' : 'are'} in events.jsonl.`));
  return [...out, 'Last issues:', shown.join('\n')];
}

/** One "Kind (n):" block and its list, or "Kind: none.". */
function listing(label: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [`${label}: none.`] : [`${label} (${lines.length}):`, lines.join('\n')];
}

function built(report: ReportInput['report'], stopped: boolean): string[] {
  if (stopped) return ['Nothing was handed over: the run stopped.'];
  if (!report) return ['No checked world was given, so nothing is listed.'];
  const w = report.world;
  return [
    ...listing('Entities', Object.keys(w.entities).map((e) => item(`\`${e}\`: ${plural(report.stats.rows[e] ?? 0, 'seeded row')}`))),
    ...listing('Routes', Object.entries(w.routes).map(([id, r]) => item(`\`${id}\`: ${r.method} ${r.path}`))),
    ...listing('Actions', Object.entries(w.actions).map(([id, a]) => item(`\`${id}\`: ${a.method} ${a.path}`))),
    ...listing('Jobs', Object.entries(w.jobs).map(([id, j]) => item(`\`${id}\`: every ${j.every}`))),
  ];
}

const changeLine = (c: WorldChange): string =>
  item(`${c.kind} \`${c.path.join('.')}\`${DESTRUCTIVE.has(c.kind) ? ' (destructive)' : ''}`);

function changes(delta: WorldDelta, stopped: boolean): string[] {
  if (delta.changes.length === 0) return ['No changes.'];
  const lines = delta.changes.map(changeLine).join('\n');
  return stopped ? ['The run stopped, so none of these changes were written:', lines] : [lines];
}

/** Each entry as a list item with its reason nested under it, or `empty` for none. */
function reasoned(entries: readonly (readonly [string, string])[] | undefined, empty: string): string[] {
  if (entries === undefined) return ['No plan was made.'];
  if (entries.length === 0) return [empty];
  return [entries.map(([what, why]) => `${item(what)}\n${item(`Why: ${why}`, 1)}`).join('\n')];
}

/** The questions the plan asked of the input, each with the answer it took. Empty when the plan asked none. */
function questions(plan: ReportInput['plan']): string[] {
  const asked = plan?.open_questions ?? [];
  if (asked.length === 0) return [];
  return ['## Questions asked of the input', asked.map((q) => `${item(q.question)}\n${item(`Default answer: ${q.default_answer}`, 1)}`).join('\n')];
}

function verdictRow(v: TaskVerdict, task: Task | undefined): string {
  const decoys = v.decoys.length === 0 ? 'none' : v.decoys.map((d) => score(d.score)).join(', ');
  const prefix = v.bestPrefixScore === null ? 'n/a' : score(v.bestPrefixScore);
  const contract = task?.allows === undefined ? 'legacy' : `declared (${task.allows.length})`;
  const probed = `${v.collateral.filter((m) => m.call !== null).length}/${v.collateral.length}`;
  return `| ${v.taskId} | ${v.difficulty} | ${score(v.solution)} | ${score(v.noop)} | ${decoys} | ${prefix} | ${contract}; mutants ${probed} | ${task === undefined ? 'n/a' : `\`${taskIdOf(task)}\``} |`;
}

function proof(report: ReportInput['report'], stopped: boolean): string[] {
  if (stopped) return ['None. The run stopped, so this report claims no verified task.'];
  if (!report) return ['No checked world was given, so there is nothing to prove.'];
  const lead = `The engine check passed: ${plural(report.tests, 'world test')}, ${plural(report.warnings.length, 'warning')}. Each row is one engine TaskVerdict.`;
  const world = `World id (WID): \`${worldIdOf(report.world)}\`.`;
  const fed = fixtureFed(report.world);
  const imported = report.warnings.filter((w) => w.code === 'seed.too_few_rows_for_paging' && fed.has(String(w.path[1])))
    .map((w) => item(`\`${String(w.path[1])}\` fits on one page (${w.found}), but its rows come from the input's fixtures, so the input sets its size and no task is held to paging on it.`));
  const head = imported.length === 0 ? [lead, world] : [lead, world, 'Paging exemptions:', imported.join('\n')];
  const verdicts = Object.values(report.verdicts);
  if (verdicts.length === 0) return [...head, 'No tasks were verified.'];
  const table = ['| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |', '|---|---|---|---|---|---|---|---|', ...verdicts.map((v) => verdictRow(v, report.world.tasks[v.taskId])),
    '', 'Collateral: *declared (n)* means the task\'s `allows` contract is enforced by the engine (A-224); *legacy* means only its grader\'s own guards and the engine mutants judge it (YOS-156). *mutants k/7* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).'];
  const decoys = verdicts.flatMap((v) => v.decoys.map((d) => item(`\`${v.taskId}\` ${score(d.score)}: ${d.why}`)));
  return [...head, table.join('\n'), ...(decoys.length === 0 ? [] : ['Decoys:', decoys.join('\n')])];
}

type StepTotals = { attempts: number; ms: number; costUsd: number; unknownCostCalls: number };

/** Per step attempts, minutes and dollars, summed from attempt events so a step that stopped still counts. */
function run(events: readonly RunEvent[]): string[] {
  if (events.length === 0) return ['No events were recorded.'];
  const steps = new Map<StepId, StepTotals>();
  const step = (id: StepId): StepTotals => {
    const have = steps.get(id);
    if (have) return have;
    const fresh = { attempts: 0, ms: 0, costUsd: 0, unknownCostCalls: 0 };
    steps.set(id, fresh);
    return fresh;
  };
  let started: string | undefined;
  let finished: string | undefined;
  const skipped: string[] = [];
  const backtracks: string[] = [];
  const partial: string[] = [];
  for (const e of events) {
    switch (e.t) {
      case 'run_started':
        started = `Mode: ${e.mode} from ${e.input}. Model: ${e.model}. Budget: $${e.budgetUsd.toFixed(2)}.`;
        break;
      case 'step_started':
        step(e.step);
        break;
      case 'attempt':
      case 'call_cancelled': {
        if (e.partialModelUsage !== undefined) {
          partial.push(`${e.step}: observed partial usage is ${e.partialModelUsage.outputTokens}+ output tokens, priced at $${e.partialModelUsage.observedCostUsd.toFixed(7)} as a lower bound; final billing is unknown and excluded from known spending.`);
        }
        const s = step(e.step);
        s.attempts += 1;
        s.ms += e.ms;
        s.costUsd += e.costUsd ?? 0;
        if (e.costUsd === null) s.unknownCostCalls += 1;
        break;
      }
      case 'step_skipped':
        skipped.push(item(`\`${e.step}\`: ${e.why}`));
        break;
      case 'backtracked':
        backtracks.push(item(`\`${e.from}\` to \`${e.to}\`: ${plural(e.because.length, 'issue')}`));
        break;
      case 'run_finished':
        finished = e.unknownCostCalls
          ? `Run total: ${minutes(e.ms)} minutes, $${usd(e.costUsd)} known. Cost remains unknown for ${plural(e.unknownCostCalls, 'model call')}; the total excludes that billing.`
          : `Run total: ${minutes(e.ms)} minutes, $${usd(e.costUsd)}.`;
        break;
      // Model commentary is never rendered. A step's time and cost are already in its attempts. Fidelity has its own section.
      case 'advice':
      case 'fidelity':
      case 'call_refused':
      case 'stall_retry':
      case 'step_finished':
        break;
      default:
        assertNever(e);
    }
  }
  const out: string[] = started === undefined ? [] : [started];
  if (steps.size === 0) out.push('No step ran.');
  else {
    const dollars = (s: StepTotals): string => `${usd(s.costUsd)}${s.unknownCostCalls > 0 ? ' + unknown' : ''}`;
    const rows = [...steps].map(([id, s]) => `| ${id} | ${s.attempts} | ${minutes(s.ms)} | ${dollars(s)} |`);
    const all = [...steps.values()].reduce(
      (a, s) => ({ attempts: a.attempts + s.attempts, ms: a.ms + s.ms, costUsd: a.costUsd + s.costUsd, unknownCostCalls: a.unknownCostCalls + s.unknownCostCalls }),
      { attempts: 0, ms: 0, costUsd: 0, unknownCostCalls: 0 },
    );
    rows.push(`| Total | ${all.attempts} | ${minutes(all.ms)} | ${dollars(all)} |`);
    out.push(['| Step | Attempts | Minutes | $ |', '|---|---|---|---|', ...rows].join('\n'));
  }
  if (skipped.length > 0) out.push('Skipped:', skipped.join('\n'));
  if (backtracks.length > 0) out.push('Backtracks:', backtracks.join('\n'));
  if (partial.length > 0) out.push('Observed partial model usage:', partial.join('\n'));
  if (finished !== undefined) out.push(finished);
  return out;
}

/**
 * Each entity field whose name the input never gives, so a reader sees what WorldGen made up or
 * renamed without reading the plan. The engine's id, created_at and updated_at are not fields here.
 */
function invented(world: World, sourceFields: readonly string[]): string[] {
  const named = new Set(sourceFields);
  const lines = Object.entries(world.entities).flatMap(([en, entity]) =>
    Object.keys(entity.fields).filter((fn) => !named.has(fn)).map((fn) => item(`\`${en}.${fn}\``)));
  if (lines.length === 0) return ['None. The input names every field.'];
  return [`${plural(lines.length, 'field')} match no column or property name in the input. WorldGen invented each one, or renamed an input field.`, lines.join('\n')];
}

/** How the handed-over world's resemblance to the real software was checked. Unchecked is said outright, never implied by silence. */
function fidelity(check: FidelityCheck): string {
  switch (check.kind) {
    case 'openapi':
      return 'Checked against the OpenAPI source spec. The last step rejected any route, field type or enum that departs from it.';
    case 'reference':
      return `Scored ${score(check.score)} against the frozen reference \`${check.reference}\`. The last step required at least ${score(check.floor)}.`;
    case 'unchecked':
      return `Not checked. The input gave no source spec or frozen reference of ${oneLine(check.software)}, so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.`;
    default:
      return assertNever(check);
  }
}

/** Each task's reach from its reference trace, and every pressure claim with its result (A-228). */
function coverage(report: NonNullable<ReportInput['report']>, plan: Plan): string[] {
  const checks = pressureChecks(report, plan);
  const result = (c: (typeof checks)[number]): string => (c.met ? 'met' : c.exempt !== null ? 'exempt' : 'unmet');
  const rows = Object.values(report.verdicts).map((v) => {
    const mine = checks.filter((c) => c.task === v.taskId).map((c) => `${c.need.split(':')[0]}: ${result(c)}`);
    const names = (xs: readonly string[]): string => (xs.length === 0 ? 'none' : xs.join(', '));
    return `| ${v.taskId} | ${v.difficulty} | ${v.solutionRowsChanged} | ${names(v.solutionLaterPageEntities)} | ${names(v.solutionDistractorEntities)} | ${mine.length === 0 ? 'none declared' : mine.join('; ')} |`;
  });
  const lead = 'From each reference solution\'s trace. A hard task must change more than one row or reach a row past the first list page, and a task\'s declared pressure must show in its trace or the seed.';
  const table = ['| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |', '|---|---|---|---|---|---|', ...rows].join('\n');
  const exempt = checks.filter((c) => !c.met && c.exempt !== null).map((c) => item(`\`${c.task}\` ${c.need}: ${c.exempt}`));
  return exempt.length === 0 ? [lead, table] : [lead, table, 'Exemptions:', exempt.join('\n')];
}

/** REPORT.md for a done, stopped or crashed run. Blocks are separated by one blank line; the text ends in a newline. */
export function renderReport(input: ReportInput): string {
  const { plan, delta, events, stop, crash } = input;
  const stopped = stop !== undefined || crash !== undefined;
  const report = stopped ? undefined : input.report;
  const blocks: string[] = crash !== undefined
    ? [`Crashed: ${oneLine(crash.message)}`, crash.worldWritten === true ? 'world.yaml was written before the run failed; no successful handover is claimed.' : crash.worldWritten === false ? 'No new world.yaml remains from this run.' : 'Whether world.yaml was restored is unknown after rollback failed.']
    : stop !== undefined ? stopBlocks(stop, events)
    : [plan ? `# WorldGen report: ${oneLine(plan.software)}` : '# WorldGen report', ...(plan ? [plan.summary] : [])];
  blocks.push('## What was built', ...(crash === undefined ? built(report, stopped) : ['The run crashed; no successful handover is claimed.']));
  if (delta) blocks.push('## Changes', ...changes(delta, stopped));
  blocks.push('## Assumed and why', ...reasoned(plan?.assumptions.map((a) => [a.decision, a.why] as const), 'None. The plan records no assumptions.'));
  if (report && input.sourceFields) blocks.push('## Fields not in the input', ...invented(report.world, input.sourceFields));
  blocks.push(...questions(plan));
  blocks.push('## Left out', ...reasoned(plan?.outOfScope.map((o) => [o.what, o.why] as const), 'None. The plan leaves nothing out.'));
  blocks.push('## Proof', ...proof(report, stopped));
  if (report && plan) blocks.push('## Coverage', ...coverage(report, plan));
  const checked = report ? events.flatMap((e) => (e.t === 'fidelity' ? [e.check] : [])).at(-1) : undefined;
  if (checked) blocks.push('## Fidelity', fidelity(checked));
  blocks.push('## Run', ...run(events));
  return `${blocks.join('\n\n')}\n`;
}
