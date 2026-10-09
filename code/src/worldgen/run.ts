/**
 * runWorldGen digests the input, plans, runs each stage through the repair loop, then saves or stops.
 * The only worldgen module that holds a Model. It asks. judge.ts and the engine decide.
 *
 * Invariants:
 * - world.yaml is written only through saveWorld(CheckedWorld). On a stop it is not touched,
 *   and on iterate the previous world stays as it was (`worldWritten: false`).
 * - Create and iterate are the same loop. Create starts from emptyWorld, iterate from the
 *   loaded world plus a change request, runs only `stagesToRun` of the sections the plan
 *   changes, and gates every stage with preservationIssues on top of blockingIssues.
 * - Iterate writes nothing the old world depends on until the whole run is accepted: plan.yaml,
 *   plan.md and world.yaml change together at the end.
 * - Every exit, done or stopped, create or iterate, writes REPORT.md (iterate adds the delta) and capsule.json.
 * - A backtrack reruns its target with the issues it owns, then every later step in order. The step that
 *   backtracked gets its rejected answer and issues back when it runs again, as it never saw them applied.
 * - Code writes meta and fixtures (from the plan and the input digest). A stage edit that
 *   touches them, or any section its stage does not own, is `edit.out_of_scope`.
 * - Every attempt is recorded in the Ledger, logged as an `attempt` event, and dumped to
 *   runs/<runId>/<seq>-<step>-<n>.json. policy.decide() alone chooses what happens next.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as nodeFs from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import {
  DeadlineExpired, SECTIONS, applyEdit, checkWorld, contentDigest, diffWorlds, editJsonSchema, emptyWorld, formatReference, issue, loadWorld, lowerRules, openapiFidelity, renderWorldYaml,
  saveWorld, withDeadline, worldSchema,
  type CheckIssue, type CheckReport, type CheckedWorld, type IssuePath, type Section, type Step, type World, type WorldEdit,
} from '#engine';
import { assertNever } from '#lib/never';
import { CostUnenforceableError, SpendCapError, type SpendEvent } from '../costs/ledger.ts';
import { CAPSULE_FILE, runCapsule, type InputSource } from './capsule.ts';
import { stepModel, transportOf, type Config } from './config.ts';
import { createEmitter, type AttemptOutcome, type CutProgress, type Emit, type FidelityCheck, type RunEvent, type StopReason } from './events.ts';
import { INPUT_KINDS, digestInput, redact, type Input, type InputDigest } from './input.ts';
import { fixturePlanIssues, operationPlanIssues } from './input-coverage.ts';
import { ITERATE_PLAN_BRIEF, admissibleIssues, applyPlanPatch, changedSections, iteratePlanBlocks, iteratePlanSchema, iterateStageBlock, planPatchSchema, planWithWorldTests, revisesPlanOnly } from './iterate.ts';
import { FIDELITY_FLOOR, fidelityGate, fidelityScore, parseFidelityReference } from './fidelity.ts';
import { blockingIssues, checkJudgeable, infraIssues, preservationIssues, requestScopeIssues, unplannedChanges } from './judge.ts';
import { CallStalled, ModelError, StepShareExpired, estimateCallUsd, type CallProgress, type Model, type Proposal, type ProposeRequest, type Usage } from './llm.ts';
import { frozenTests, parsePlanYaml, planSchemaFor, pressurePlanIssues, renderPlanYaml, type Plan, type planSchema } from './plan.ts';
import { renderPlanMd } from './plan-md.ts';
import { attemptIssueSet, decide, estimateCallMs, nextIsRepair, ownerOf, preflight, remainingMs, stepShareMs, type CallRecord, record, recordBacktrack, recordStallRetry, type Ledger } from './policy.ts';
import { renderReport } from './report.ts';
import { PLAN_BRIEF, SPEC_FIELD_NAMES, STAGES, STAGE_IDS, actionRoutesLeftOut, dateOnlyColumnLines, engineErrorCodes, engineSuccessStatuses, isTestRun, pathRuleExample, seedNeedLines, seedNeeds, stageChecklist, taskPressureLines, stagesToRun, takenPaths, writesOf, type StageId, type StepId } from './stages.ts';

export type Job =
  | { readonly kind: 'create'; readonly input: Input; readonly outDir: string }
  | { readonly kind: 'iterate'; readonly worldDir: string; readonly request: string };

export type RunResult =
  | { readonly kind: 'done'; readonly dir: string; readonly report: Extract<CheckReport, { ok: true }>; readonly costUsd: number; readonly ms: number }
  | { readonly kind: 'stopped'; readonly dir: string; readonly reason: StopReason; readonly costUsd: number; readonly ms: number; readonly unknownCostCalls?: number };

export type RunDeps = {
  readonly model: Model;
  /**
   * The few-shot world rendered into every system prompt, or the config's list of them, of which the run renders the
   * one `pickExample` takes for its input digest (A-390). Reading config.exampleWorld from disk is the caller's job.
   */
  readonly exampleWorld: World | readonly World[];
  /** Sees every event too. events.jsonl is always written; this is for a console view or a test. */
  readonly emit?: Emit;
  /** Wall clock in ms for event times, budgets and durations. Defaults to Date.now. */
  readonly now?: () => number;
  /** Defaults to a timestamp plus a random suffix. */
  readonly runId?: string;
  /** Defaults to digestInput. A seam for input kinds whose adapters supply fixtures or an API shape. */
  readonly digest?: (input: Input) => Promise<{ ok: true; digest: InputDigest } | { ok: false; why: string }>;
  /** Defaults to the engine's checkWorld. A seam for a test that needs the snippet host to be unavailable. */
  readonly check?: (world: World) => CheckReport;
  /** Defaults to node:fs/promises. A seam for a test that fails one write or rename, on any runtime. */
  readonly fs?: RunFs;
  /** Aborted when the operator stops the run. The run then cancels its call, records it, and stops with `cancelled` (A-279). */
  readonly signal?: AbortSignal;
};

/** The file operations a run performs on its output directory. */
export type RunFs = Pick<typeof nodeFs, 'mkdir' | 'readFile' | 'rename' | 'rm' | 'writeFile'>;

/** Every step in dependency order. */
const STEPS: readonly StepId[] = ['plan', ...STAGE_IDS];
const LAST_STEP: StepId = STEPS[STEPS.length - 1] ?? 'tasks';
const EXPIRED = Symbol('deadline');
const SHARE_EXPIRED = Symbol('share');
const INTERRUPTED = Symbol('interrupted');
/**
 * How long past its step share the run waits for a call before abandoning it. Covers the transport's own SIGTERM-then-SIGKILL.
 * Also the margin a call's timeoutMs keeps before the run deadline, so a transport kill is recorded and billed, not abandoned.
 */
const SHARE_GRACE_MS = 15_000;

/** fn's result, or EXPIRED when the run deadline (atMs, performance.now() timeline) passed while the engine was judging. */
function beforeDeadline<T>(atMs: number, fn: () => T): T | typeof EXPIRED {
  try {
    return withDeadline(atMs, fn);
  } catch (e) {
    if (e instanceof DeadlineExpired) return EXPIRED;
    throw e;
  }
}

const CANCEL_SETTLE_MS = 2000;
function judgeBeforeDeadline<T>(atMs: number, judge: () => Judged<T>): Judged<T> | typeof EXPIRED {
  try {
    return beforeDeadline(atMs, judge);
  } catch (error) {
    return { ok: false, outcome: { kind: 'judge_error', message: error instanceof Error ? error.message : String(error) }, issues: [] };
  }
}

const PLAN_TOOL = 'submit_plan';
const EDIT_TOOL = 'edit_world';
const ZERO_USAGE: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
const cutProgress = (p: CallProgress): CutProgress => ({ messages: p.messages, outputTokens: p.usage.outputTokens, schemaRetries: p.schemaRetries, outputBytes: p.outputBytes });
const FOUND_MAX = 200;
const EDIT_KEYS: ReadonlySet<string> = new Set(['note', 'meta', 'upsert', 'patch', 'remove']);
const EDIT_OPS = ['upsert', 'patch', 'remove'] as const;

type OkReport = Extract<CheckReport, { ok: true }>;
/**
 * What the model must fix: the issues of its rejected answer on this step, or, with `from`, the
 * issues a later step found that this step owns (a backtrack). With `rerunBy`, this step's answer was
 * rejected for issues an earlier step owned, and that step has run again since. `previous` is the answer to show.
 */
export type Feedback = {
  readonly issues: readonly CheckIssue[];
  readonly previous: unknown;
  readonly from?: StepId;
  readonly rerunBy?: StepId;
  /** On a retry after two or more attempts, every attempt of this step so far (YOS-246, A-364). */
  readonly history?: readonly TriedAttempt[];
  /** The attempt `previous` is when it is not the latest: the best full one so far. */
  readonly bestOf?: number;
};

/** One rejected attempt of the step being retried: its own issues, and the owned items it left out that an earlier attempt wrote. */
export type TriedAttempt = { readonly n: number; readonly input: unknown; readonly issues: readonly CheckIssue[]; readonly left: readonly string[] };

/** How many of an earlier attempt's issues its history line names. */
const HISTORY_ISSUES = 8;

function historyLine(t: TriedAttempt): string {
  const named = t.issues.slice(0, HISTORY_ISSUES).map((i) => `${i.code} at ${i.path.join('.')}`);
  const more = t.issues.length > HISTORY_ISSUES ? [`and ${t.issues.length - HISTORY_ISSUES} more`] : [];
  const left = t.left.length > 0 ? `, which left ${t.left.join(', ')} untouched` : '';
  return `- attempt ${t.n}${left}: ${named.length === 0 ? 'no issue reported' : [...named, ...more].join('; ')}`;
}

/**
 * The attempt to build on: the one with the fewest own issues among those that left no owned item out, the latest on
 * a tie. The first attempt leaves nothing out, so there is always one.
 */
/** The frozen-test failures of the latest attempt that had any, its `layer.blocked` left out (A-406). */
function lastFrozenTestFailures(tried: readonly TriedAttempt[]): readonly CheckIssue[] {
  for (const t of [...tried].reverse()) {
    const failed = t.issues.filter((i) => isTestRun(i) && i.code !== 'layer.blocked');
    if (failed.length > 0) return failed;
  }
  return [];
}

function bestAttempt(tried: readonly TriedAttempt[]): TriedAttempt | undefined {
  let best: TriedAttempt | undefined;
  for (const t of tried) if (t.left.length === 0 && (best === undefined || t.issues.length <= best.issues.length)) best = t;
  return best ?? tried.at(-1);
}

/** The owned items an edit writes, as `section.key`. A plan answer is always whole, so it writes none here. */
function touchedItems(step: StepId, input: unknown): ReadonlySet<string> {
  const out = new Set<string>();
  if (step === 'plan' || !isRecord(input)) return out;
  for (const section of writesOf(step)) {
    for (const op of EDIT_OPS) {
      const part = isRecord(input[op]) ? input[op][section] : undefined;
      const keys = Array.isArray(part) ? part.filter((k): k is string => typeof k === 'string') : isRecord(part) ? Object.keys(part) : [];
      for (const k of keys) out.add(`${section}.${k}`);
    }
  }
  return out;
}

/** One judged attempt. Only an accepted attempt carries a value. */
type Judged<T> =
  | { readonly ok: true; readonly outcome: Extract<AttemptOutcome, { kind: 'accepted' }>; readonly value: T }
  | { readonly ok: false; readonly outcome: Exclude<AttemptOutcome, { kind: 'accepted' }>; readonly issues: readonly CheckIssue[] };

type StepOutcome<T> =
  | { readonly kind: 'advance'; readonly value: T }
  | { readonly kind: 'backtrack'; readonly to: StepId; readonly because: readonly CheckIssue[]; readonly previous: unknown }
  | { readonly kind: 'stop'; readonly reason: StopReason };

/** A stage's accepted edit: the new world, the edit that made it (null when a skipped stage changed nothing), and the checked world when the engine report is ok. */
type StageValue = {
  readonly world: World;
  readonly edit: WorldEdit | null;
  readonly checked: { readonly world: CheckedWorld; readonly report: OkReport } | null;
  /** Debt this stage's judge forgave: issues the world already had before the iterate (A-291). */
  readonly forgiven: readonly CheckIssue[];
};

/** What an iterate run keeps the world to: the old checked world, and every edit accepted so far (they exempt their own `remove`s). */
type Gate = {
  readonly before: CheckedWorld;
  readonly edits: readonly WorldEdit[];
  readonly request: string;
  /** Per stage, the keys of the issues its judge raised on the world and plan from before the run whose owner the plan does not reach (A-291). */
  readonly debt: ReadonlyMap<StageId, ReadonlySet<string>>;
};

/** An issue's identity across two judgements: the same code at the same path, asking and finding the same. */
const debtKey = (i: CheckIssue): string => JSON.stringify([i.code, i.path, i.expected, i.found]);

/**
 * What a stage's judge may forgive in an iterate: each issue it raises on the world and plan from before the run,
 * unless the stage that owns it is one the plan's changes reach. That stage is changing what the issue is about, so
 * it must leave it right; any other stage that tried would be refused by the scope gate (A-289).
 */
function debtOf(report: CheckReport, world: CheckedWorld, plan: Plan, toRun: ReadonlySet<StageId>, digest?: InputDigest): ReadonlyMap<StageId, ReadonlySet<string>> {
  return new Map(STAGE_IDS.map((stage) => {
    const owed = blockingIssues(stage, report, plan, world, digest).blocking.filter((i) => {
      const owner = ownerOf(i);
      return owner === 'plan' || !toRun.has(owner);
    });
    return [stage, new Set(owed.map(debtKey))] as const;
  }));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The few-shot world for an input: the entry its content digest picks, the first eight hex digits modulo the list
 * length, so the same input always gets the same example and different inputs spread over the list (A-390).
 */
export function pickExample<T>(examples: readonly T[], digest: string): T {
  const n = Number.parseInt(digest.slice(0, 8), 16);
  const pick = examples[(Number.isNaN(n) ? 0 : n) % examples.length];
  if (pick === undefined) throw new Error('no example world to pick from');
  return pick;
}

/**
 * The system prompt for a step. The shared part (role, format reference, example world) comes
 * first and is the same for every step, so a prompt cache can reuse it; the step's brief comes last.
 */
export function systemPrompt(step: StepId, exampleWorld: World, mode: 'create' | 'iterate' = 'create'): string {
  const example = step === 'workflow' ? pathRuleExample(exampleWorld) : null;
  const planBrief = mode === 'iterate' ? ITERATE_PLAN_BRIEF : PLAN_BRIEF;
  const brief = step === 'plan' ? planBrief : example === null ? STAGES[step].brief : `${STAGES[step].brief}\n\n${example}`;
  return [
    'You are WorldGen. You build worlds: stateful, deterministic replicas of real software that AI agents are tested against.',
    'A world is built in steps. The plan step writes plan.yaml and fixes the acceptance tests before implementation starts. Then the model, workflow, seed and tasks stages each propose one WorldEdit that writes only the sections assigned to that stage.',
    'Code writes meta and fixtures, so never edit them. The world engine checks every proposal and is the only judge. When it rejects one, its issues say exactly what to fix.',
    '',
    formatReference().trimEnd(),
    '',
    '## Example world',
    '',
    'A complete world the engine accepts. Follow its conventions, not its domain.',
    '',
    '```yaml',
    renderWorldYaml(exampleWorld).trimEnd(),
    '```',
    '',
    `## This step: ${step}`,
    '',
    brief,
  ].join('\n');
}

/** Issues as the model reads them: code, path, expected, found and hint for each. */
export function renderIssues(issues: readonly CheckIssue[]): string {
  const field = (name: string, value: string) => `  ${name}: ${value.replace(/\n/g, '\n    ')}`;
  return issues
    .map((i) => [`- code: ${i.code}`, field('path', i.path.join('.')), field('expected', i.expected), field('found', i.found), field('hint', i.hint)].join('\n'))
    .join('\n');
}

function promptSection(title: string, lines: readonly string[]): string[] {
  return lines.length === 0 ? [] : ['', `## ${title}`, '', ...lines];
}

/** `again` asks for the next answer: in full by default, as a patch on the iterate plan step (A-345). */
function feedbackBlock(feedback: Feedback | null, again = 'Answer again in full'): string[] {
  if (feedback === null) return [];
  const label = feedback.bestOf === undefined ? 'Your previous answer:' : `Your best answer so far (attempt ${feedback.bestOf}):`;
  const previous = feedback.previous === undefined ? [] : ['', label, '', '```json', JSON.stringify(feedback.previous, null, 2), '```'];
  const history = feedback.history === undefined || feedback.history.length < 2 ? [] : [
    '', '## Earlier attempts in this step', '', 'Every attempt was judged against the world above, as your next answer will be.', '',
    ...feedback.history.map(historyLine),
  ];
  const head = feedback.rerunBy !== undefined
    ? ['## Your previous answer was rejected for issues an earlier step owned', '',
      `It was not applied. Since then the ${feedback.rerunBy} step has run again, and every step between it and this one has run again or been rechecked, so the world above may have changed. ${again}, keep what was right, and fix what the issues below still show.`]
    : feedback.from === undefined
      ? ['## Your previous answer was rejected', '', `It was not applied. ${again}, and fix every issue below.`]
      : [`## The ${feedback.from} step found issues that this step must fix`, '',
        `Your earlier answer was accepted and is part of what you see above. ${again}, and fix every issue below. Every step after this one runs again.`];
  return [
    '',
    ...head,
    ...previous,
    ...history,
    '',
    'Issues:',
    '',
    renderIssues(feedback.issues),
  ];
}

/** The plan step's prompt: the redacted input digest, the approved plan when the step runs again, then any rejection to fix. */
export function planPrompt(digest: InputDigest, feedback: Feedback | null, approved: Plan | null = null): string {
  const parts = [`## Input (${digest.kind})`, '', digest.summary];
  if (digest.observations.length > 0) {
    parts.push('', '## Observed requests', '', ...digest.observations.map((o) => `- ${o.method} ${o.path} -> ${o.status}`));
  }
  const tables = Object.entries(digest.fixtures);
  if (tables.length > 0) {
    parts.push('', '## Imported tables', '', ...tables.map(([name, rows]) => `- ${name}: ${rows.length} rows, columns ${Object.keys(rows[0] ?? {}).join(', ')}`));
  }
  if (approved !== null) {
    parts.push(
      '', '## Current approved plan', '', '```yaml', renderPlanYaml(approved).trimEnd(), '```',
      '', `This is revision ${approved.revision}. Answer with revision ${approved.revision + 1}: change what the issues below require, and keep the rest as it is.`,
    );
  }
  parts.push(
    ...promptSection('Engine error codes', engineErrorCodes()),
    ...promptSection('Engine success statuses', engineSuccessStatuses()),
    ...promptSection('Spec field names', digest.kind === 'openapi' ? SPEC_FIELD_NAMES : []),
    '', '## Your task', '', `Call ${PLAN_TOOL} with the plan.`, ...feedbackBlock(feedback),
  );
  return parts.join('\n');
}

/** The plan step's prompt on iterate: the request, the old plan (or the world when there is none), then any rejection to fix. */
export function iteratePlanPrompt(request: string, oldPlan: Plan | null, world: World, feedback: Feedback | null): string {
  const task = oldPlan === null ? `Call ${PLAN_TOOL} with the whole plan.` : `Call ${PLAN_TOOL} with a patch on the existing plan: revision, changes and only the keys that change.`;
  const again = oldPlan === null ? undefined : 'Answer again with a patch on the plan above';
  return [...iteratePlanBlocks(request, oldPlan, world), ...promptSection('Engine error codes', engineErrorCodes()), '', '## Your task', '', task, ...feedbackBlock(feedback, again)].join('\n');
}

/** A stage's prompt: the plan, the world so far, what the stage may write, then any rejection to fix. On iterate it carries the change request. */
export function stagePrompt(stage: StageId, plan: Plan, world: World, feedback: Feedback | null, request: string | null = null, openapi = false): string {
  return [
    '## Plan',
    '',
    '```yaml',
    renderPlanYaml(plan).trimEnd(),
    '```',
    '',
    '## Current world',
    '',
    '```yaml',
    renderWorldYaml(world).trimEnd(),
    '```',
    '',
    ...(request === null ? [] : [...iterateStageBlock(request), '']),
    '## Your task',
    '',
    `Call ${EDIT_TOOL} with one WorldEdit for the ${stage} stage. It may write only ${writesOf(stage).join(', ')}.`,
    ...promptSection('Required keys', stageChecklist(stage, plan, world)),
    ...promptSection('Action routes', actionRoutesLeftOut(stage, plan)),
    ...promptSection('Paths routes already own', stage === 'workflow' ? takenPaths(world) : []),
    ...promptSection('What the planned tasks need from the seed', stage === 'seed' ? seedNeedLines(seedNeeds(plan, world)) : []),
    ...promptSection('Pressure each task must show, every claim in every answer', stage === 'tasks' ? taskPressureLines(plan, world) : []),
    ...promptSection('Imported date-only columns', stage === 'model' ? dateOnlyColumnLines(world) : []),
    ...promptSection('Spec field names', openapi && stage === 'model' ? SPEC_FIELD_NAMES : []),
    ...feedbackBlock(feedback),
  ].join('\n');
}

/** The plan's rules for a run: `planSchemaFor` the input kind on create, `iteratePlanSchema` of the old world on iterate. */
type PlanSchema = typeof planSchema;

function planTool(schema: PlanSchema): ProposeRequest['tool'] {
  return {
    name: PLAN_TOOL,
    description: 'Submit the plan for this world. Every later stage follows it.',
    inputSchema: z.toJSONSchema(schema, { io: 'input' }),
  };
}

/** The iterate plan tool when a plan exists: a patch on it (A-345). */
const PATCH_TOOL: ProposeRequest['tool'] = {
  name: PLAN_TOOL,
  description: 'Submit a patch on the existing plan: revision, changes and only the keys that change. Every key you leave out stays as it is.',
  inputSchema: z.toJSONSchema(planPatchSchema, { io: 'input' }),
};

/** A plan patch on `base`, judged as the whole plan it makes. A patch that does not parse is invalid output, with each issue at its path in the patch. */
function judgePatch(schema: PlanSchema, input: unknown, base: Plan, approved: Plan | null): Judged<Plan> {
  const parsed = planPatchSchema.safeParse(input);
  if (parsed.success) return judgePlan(schema, applyPlanPatch(base, parsed.data), approved);
  const issues = parsed.error.issues.map((zi) => {
    const rel = zi.path.map((k) => (typeof k === 'number' ? k : String(k)));
    return issue('schema.invalid', ['plan', ...rel], { message: zi.message }, renderFound(valueAt(input, rel)));
  });
  return { ok: false, outcome: { kind: 'invalid_output', issues }, issues };
}

function editTool(stage: StageId): ProposeRequest['tool'] {
  const writes = writesOf(stage);
  return {
    name: EDIT_TOOL,
    description: `Propose one WorldEdit for the ${stage} stage. It may write only ${writes.join(', ')}.`,
    inputSchema: editJsonSchema(writes),
  };
}

function renderFound(v: unknown): string {
  const s = v === undefined ? 'missing' : (JSON.stringify(v) ?? String(v));
  return s.length > FOUND_MAX ? `${s.slice(0, FOUND_MAX)}...` : s;
}

function valueAt(v: unknown, path: readonly (string | number)[]): unknown {
  let cur = v;
  for (const k of path) {
    if (typeof cur !== 'object' || cur === null || !Object.hasOwn(cur, k)) return undefined;
    cur = (cur as Record<string | number, unknown>)[k];
  }
  return cur;
}

/**
 * A plan proposal against `schema`. Once a plan is approved (in this run, or the recorded plan.yaml on iterate), a new one must raise its revision.
 * On create, a plan that pads or remaps an imported CSV table is rejected here, so the plan step fixes it before any seed runs (A-221),
 * and so is a plan whose routes leave out an input OpenAPI operation, which would otherwise reach the model step unowned (YOS-244).
 */
function judgePlan(schema: PlanSchema, input: unknown, approved: Plan | null, digest?: InputDigest): Judged<Plan> {
  const parsed = schema.safeParse(input);
  if (parsed.success) {
    if (approved !== null && parsed.data.revision <= approved.revision) {
      const problem = issue('schema.invalid', ['plan', 'revision'], { message: `revision must be greater than the approved revision ${approved.revision}` }, String(parsed.data.revision));
      return { ok: false, outcome: { kind: 'invalid_output', issues: [problem] }, issues: [problem] };
    }
    const conflicts = [
      ...pressurePlanIssues(parsed.data),
      ...(digest === undefined ? [] : [...fixturePlanIssues(parsed.data, digest), ...operationPlanIssues(parsed.data, digest)]),
    ];
    if (conflicts.length > 0) return { ok: false, outcome: { kind: 'rejected', issues: conflicts }, issues: conflicts };
    return { ok: true, outcome: { kind: 'accepted', warnings: 0 }, value: parsed.data };
  }
  const issues = parsed.error.issues.map((zi) => {
    const rel = zi.path.map((k) => (typeof k === 'number' ? k : String(k)));
    return issue('schema.invalid', ['plan', ...rel], { message: zi.message }, renderFound(valueAt(input, rel)));
  });
  return { ok: false, outcome: { kind: 'invalid_output', issues }, issues };
}

/** `edit.out_of_scope` for each part of a raw edit outside the stage's sections: meta, unowned or unknown sections, unknown keys. */
export function scopeIssues(stage: StageId, input: unknown): readonly CheckIssue[] {
  if (!isRecord(input)) return [];
  const allowed = writesOf(stage);
  const sections: readonly string[] = SECTIONS;
  const out: CheckIssue[] = [];
  const empty = (v: unknown) => (isRecord(v) && Object.keys(v).length === 0) || (Array.isArray(v) && v.length === 0);
  for (const key of Object.keys(input)) {
    if (!EDIT_KEYS.has(key)) out.push(issue('edit.out_of_scope', ['format', key], { section: key, allowed }, `edit key ${key}`));
  }
  if (isRecord(input['meta']) && !empty(input['meta'])) {
    out.push(issue('edit.out_of_scope', ['meta'], { section: 'meta', allowed }, `meta: ${Object.keys(input['meta']).join(', ')}`));
  }
  for (const op of EDIT_OPS) {
    const part = input[op];
    if (!isRecord(part)) continue;
    for (const [key, value] of Object.entries(part)) {
      if ((allowed as readonly string[]).includes(key) || empty(value)) continue;
      const path: IssuePath = sections.includes(key) ? [key as Section] : ['format', op, key];
      out.push(issue('edit.out_of_scope', path, { section: key, allowed }, `${op}.${key}`));
    }
  }
  return out;
}

/**
 * The departures the model step can fix, since they sit on the fields of the routes it built: field types and enums
 * (A-110), and the requiredness of a route's request fields (A-318). No action exists yet at the model step, so a
 * request departure there is a route's. Missing operations and statuses may still come from workflow actions, so they
 * wait for the last step. The model step never has a checked world (no tasks yet), so it checks its candidate once
 * its own sections pass.
 */
const MODEL_DEPARTURES: ReadonlySet<string> = new Set(['openapi.field_type', 'openapi.field_enum', 'openapi.required_field_missing', 'openapi.required_field_extra']);

/**
 * Which departures `stage` judges before the last step: at model, the route fields it built; at workflow, the request
 * of an operation it serves with an action (A-210, A-318), on its candidate once its own sections pass.
 */
function earlyDeparture(stage: StageId, world: World, i: CheckIssue): boolean {
  if (stage === 'model') return MODEL_DEPARTURES.has(i.code) && !actionRequestIssue(world, i);
  return stage === 'workflow' && actionRequestIssue(world, i);
}

/**
 * How a create run checks resemblance to the real software. `gate` is the last step's issues for a finished
 * world: OpenAPI conformance to the source spec, or, for a description that names a frozen reference, the
 * fidelity floor (A-258); empty otherwise. `check` is what the handed-over world's REPORT.md says was checked.
 */
type Fidelity = { readonly gate: (world: World) => readonly CheckIssue[]; readonly check: (world: World, software: string) => FidelityCheck };
const UNCHECKED: Fidelity = { gate: () => [], check: (_world, software) => ({ kind: 'unchecked', software }) };

/**
 * Loads the spec or the reference once. One that cannot be read again leaves the check off: digest already
 * accepted the spec, and the CLI and the eval runner refuse a bad reference before the run starts.
 */
async function fidelityOf(input: Input, fs: RunFs): Promise<Fidelity> {
  if (input.kind === 'description') {
    if (input.fidelity === undefined) return UNCHECKED;
    const parsed = parseFidelityReference(await fs.readFile(input.fidelity, 'utf8').catch(() => ''));
    if (!parsed.ok) return UNCHECKED;
    const reference = parsed.reference;
    return {
      gate: (world) => fidelityGate(reference, world),
      check: (world) => ({ kind: 'reference', reference: reference.case, score: fidelityScore(reference, world).score, floor: FIDELITY_FLOOR }),
    };
  }
  if (input.kind !== 'openapi') return UNCHECKED;
  try {
    const { document, only } = await INPUT_KINDS.openapi.load(input);
    return { gate: (world) => openapiFidelity(world, document, only), check: () => ({ kind: 'openapi' }) };
  } catch {
    return UNCHECKED;
  }
}

/**
 * Judges a world candidate for `stage`: the engine report and plan through blockingIssues, then,
 * on iterate, the preservation gate. An ok report gets the full gate (unplanned destructive
 * changes, old tests and decoys rerun, lost rows). A failed report carries no checked world to
 * rerun, so it gets the one rule that needs none, unplanned destructive changes. The last step
 * must leave a checked world, so there an engine error that `blockingIssues` defers to a later
 * stage blocks too.
 */
function judgeCandidate(stage: StageId, candidate: World, edit: WorldEdit | null, plan: Plan, gate: Gate | null, fidelity: Fidelity, check: (world: World) => CheckReport, digest?: InputDigest): Judged<StageValue> {
  const report = checkJudgeable(() => check(candidate));
  const infra = infraIssues(report);
  if (infra.length > 0) return { ok: false, outcome: { kind: 'infra_unavailable', issues: infra }, issues: infra };
  const raw = blockingIssues(stage, report, plan, candidate, digest);
  const owed = gate?.debt.get(stage) ?? new Set<string>();
  const forgiven = raw.blocking.filter((i) => owed.has(debtKey(i)));
  const blockingNow = raw.blocking.filter((i) => !owed.has(debtKey(i)));
  const j = forgiven.length === 0 ? raw : { ...raw, blocking: blockingNow, accepted: report.ok && blockingNow.length === 0 ? report.world : null };
  const edits = gate === null ? [] : edit === null ? gate.edits : [...gate.edits, edit];
  const kept = gate === null
    ? []
    : [
      ...(report.ok ? preservationIssues(gate.before, report.world, edits, plan) : unplannedChanges(diffWorlds(gate.before, candidate), edits, plan)),
      ...requestScopeIssues(diffWorlds(gate.before, candidate), plan, gate.request),
    ];
  const own = [...j.blocking, ...kept];
  const checked = j.accepted !== null && kept.length === 0 && report.ok ? { world: j.accepted, report } : null;
  const subject = checked?.world ?? ((stage === 'model' || stage === 'workflow') && own.length === 0 ? candidate : null);
  const departures = subject === null ? [] : fidelity.gate(subject)
    .filter((i) => i.severity === 'error' && (stage === LAST_STEP ? checked !== null : earlyDeparture(stage, subject, i)));
  if (departures.length > 0) return { ok: false, outcome: { kind: 'rejected', issues: departures }, issues: departures };
  const blocking = own.length > 0 || stage !== LAST_STEP || checked !== null ? own : j.deferred;
  if (blocking.length > 0 || (stage === LAST_STEP && checked === null)) {
    return { ok: false, outcome: { kind: 'rejected', issues: blocking }, issues: blocking };
  }
  return { ok: true, outcome: { kind: 'accepted', warnings: report.warnings.length }, value: { world: candidate, edit, checked, forgiven } };
}

/**
 * Who must fix `i` while `step` runs. A test that fails or cannot run at the seed step is the seed's: the
 * world passed its tests before this attempt and the attempt wrote only seed, so the seed data broke it.
 * Sent upstream instead, the owner repairs blind and the seed is regenerated with no word of why it failed.
 */
function ownerIn(step: StepId, i: CheckIssue, world: World | null = null): StepId {
  if (world !== null && actionRequestIssue(world, i)) return 'workflow';
  // The workflow step judges request departures only on its candidate's actions (earlyDeparture), which the world
  // before its edit may not hold yet (A-318).
  if (step === 'workflow' && requestDeparture(i)) return 'workflow';
  return step === 'seed' && isTestRun(i) ? 'seed' : ownerOf(i);
}

const REQUEST_FIDELITY: ReadonlySet<string> = new Set(['openapi.field_enum', 'openapi.required_field_missing', 'openapi.required_field_extra']);
const paramless = (path: string): string => path.replace(/\{[^}]*\}/g, '{}');

/**
 * A spec request-body issue on an operation the world serves with an action. Its body is `actions.<id>.input`,
 * which the workflow stage writes, so the model stage cannot fix it (A-210). Path: input, openapi, `METHOD /path`, request, field.
 */
const requestDeparture = (i: CheckIssue): boolean => REQUEST_FIDELITY.has(i.code) && i.path[3] === 'request';

function actionRequestIssue(world: World, i: CheckIssue): boolean {
  if (!requestDeparture(i)) return false;
  const [method, path] = String(i.path[2]).split(' ');
  return Object.values(world.actions).some((a) => a.method === method && paramless(a.path) === paramless(path ?? ''));
}

/**
 * What `step` itself must fix: the issues it owns, or all of them when it owns none. `layer.blocked` only says
 * that another issue came first, so it is left out. A step told to act on an upstream issue distorts what it owns.
 */
function ownIssues(issues: readonly CheckIssue[], step: StepId, world: World | null = null): readonly CheckIssue[] {
  const real = issues.filter((i) => i.code !== 'layer.blocked');
  const mine = real.filter((i) => ownerIn(step, i, world) === step);
  return mine.length > 0 ? mine : issues;
}

/**
 * Applies and judges one stage edit. An edit that writes the plan's frozen tests is `rejected`, not
 * `invalid_output`, so policy can send it back to the plan step that owns them.
 */
function judgeEdit(stage: StageId, world: World, plan: Plan, input: unknown, gate: Gate | null, fidelity: Fidelity, check: (world: World) => CheckReport, digest?: InputDigest): Judged<StageValue> {
  const scope = scopeIssues(stage, input);
  if (scope.some((i) => i.path[0] === 'tests')) return { ok: false, outcome: { kind: 'rejected', issues: scope }, issues: scope };
  if (scope.length > 0) return { ok: false, outcome: { kind: 'invalid_output', issues: scope }, issues: scope };
  const applied = applyEdit(world, input);
  if (!applied.ok) return { ok: false, outcome: { kind: 'invalid_output', issues: applied.error }, issues: applied.error };
  return judgeCandidate(stage, withLoweredRules(applied.value.world), applied.value.edit, plan, gate, fidelity, check, digest);
}

/**
 * `world` with each handler or job run that has rules set to the source the rules lower to, so the
 * model writes rules and code writes the JavaScript (A-168). Rules that do not lower are left for
 * the engine's rules.invalid.
 */
function withLoweredRules(world: World): World {
  const lower = <T extends { readonly rules?: Step[] | undefined }>(items: Record<string, T>, actions: boolean, set: (item: T, source: string) => T) =>
    Object.fromEntries(Object.entries(items).map(([key, item]) => {
      if (item.rules === undefined) return [key, item];
      const lowered = lowerRules(world, item.rules, actions ? key : null);
      return [key, lowered.ok ? set(item, lowered.source) : item];
    }));
  return {
    ...world,
    actions: lower(world.actions, true, (a, handler) => ({ ...a, handler })),
    jobs: lower(world.jobs, false, (j, run) => ({ ...j, run })),
  };
}

/** A Name for meta.name from the output directory: `gen-helpdesk` becomes `gen_helpdesk`. */
function worldName(outDir: string): string {
  const slug = basename(resolve(outDir)).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^[^a-z]+/, '').replace(/_+$/, '');
  return slug === '' ? 'world' : slug;
}

/** The world before any stage: empty sections, plus the digest's fixtures and API shape, written by code. */
function baseWorld(outDir: string, digest: InputDigest): { ok: true; world: World } | { ok: false; why: string } {
  const empty = emptyWorld(worldName(outDir), 'worldgen');
  const parsed = worldSchema.safeParse({
    ...empty,
    meta: { ...empty.meta, ...(digest.apiShape === null ? {} : { api: digest.apiShape }) },
    fixtures: digest.fixtures,
  });
  if (parsed.success) return { ok: true, world: parsed.data };
  const why = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
  return { ok: false, why: `The input's tables or API shape do not fit the world format: ${why}` };
}

function newRunId(ms: number): string {
  return `run_${new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z')}_${randomUUID().slice(0, 8)}`;
}

function failedCallCost(error: unknown): number | null {
  if (error instanceof SpendCapError) return 0;
  if (!(error instanceof ModelError)) return null;
  switch (error.billing.kind) {
    case 'billed': return error.billing.costUsd;
    case 'not_started': return 0;
    case 'unknown': return null;
    default: return assertNever(error.billing);
  }
}

function partialCallUsage(error: unknown): SpendEvent['partialModelUsage'] {
  if (error instanceof ModelError && error.partialModelUsage !== undefined) return error.partialModelUsage;
  if ((error instanceof StepShareExpired || error instanceof CallStalled) && error.usage !== undefined && error.costUsd !== undefined) {
    return { ...error.usage, observedCostUsd: error.costUsd };
  }
  return undefined;
}

type CancelledBilling = { readonly costUsd: number | null; readonly partialModelUsage?: SpendEvent['partialModelUsage'] };
async function cancelledBilling(pending: Promise<Proposal>): Promise<CancelledBilling> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      pending.then((p) => ({ costUsd: p.costUsd }), (error: unknown) => {
        const partialModelUsage = partialCallUsage(error);
        return { costUsd: failedCallCost(error), ...(partialModelUsage === undefined ? {} : { partialModelUsage }) };
      }),
      new Promise<CancelledBilling>((resolve) => { timer = setTimeout(() => resolve({ costUsd: null }), CANCEL_SETTLE_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** The directory a create run writes into until it is done: `<out>.partial`, a sibling of `<out>`. */
export const partialDir = (outDir: string): string => `${resolve(outDir)}.partial`;

/** Renames `from` to `to` when it exists, so an earlier run's directory is kept, never mixed into or deleted. */
async function setAside(fs: RunFs, from: string, to: string): Promise<void> {
  try {
    await fs.rename(from, to);
  } catch (e) {
    if (!(isRecord(e) && e.code === 'ENOENT')) throw e;
  }
}

/** Whether redact() leaves this text as it is, so the capsule can carry it without a secret (A-351). */
const safeText = (text: string): boolean => redact('description', { text }).text === text;

/** A path the capsule can carry: relative to the repository holding it, or null outside one or when redact() would mask part of it. */
function repoPath(file: string): string | null {
  const abs = resolve(file);
  let dir = dirname(abs);
  while (!existsSync(join(dir, '.git'))) {
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  const rel = relative(dir, abs).split(sep).join('/');
  return safeText(rel) ? rel : null;
}

/** The input as capsule.json records it, so rerender-report.ts can re-render the report with no arguments (A-351). */
function sourceOf(job: Job, runRel: string): InputSource {
  if (job.kind === 'iterate') return { kind: 'change_request', before: `${runRel.split(sep).join('/')}/before` };
  const input = job.input;
  switch (input.kind) {
    case 'description':
      return { kind: 'description' };
    case 'openapi': {
      const clean = input.only.every(safeText);
      return { kind: 'openapi', path: clean ? repoPath(input.path) : null, only: clean ? [...input.only] : [] };
    }
    case 'csv':
      return { kind: 'csv', paths: input.paths.map(repoPath) };
    default:
      return assertNever(input);
  }
}

export async function runWorldGen(job: Job, config: Config, deps: RunDeps): Promise<RunResult> {
  const fs = deps.fs ?? nodeFs;
  /** Where a done run's world lands. A create builds in `<out>.partial` and renames it here only when done (A-293). */
  const finalDir = job.kind === 'create' ? job.outDir : job.worldDir;
  /**
   * Where the run writes: the partial dir on create, so a stop or crash leaves `<out>` untouched; the world itself on iterate.
   * A rerun reuses an existing partial dir: each run's events and dumps stay under runs/<runId>.
   */
  const outDir = job.kind === 'create' ? partialDir(job.outDir) : job.worldDir;
  const now = deps.now ?? Date.now;
  const check = deps.check ?? checkWorld;
  const started = now();
  // The run start on the performance timeline, so a deadline before any call costs no extra read of the injected clock.
  const perfStarted = performance.now();
  const runId = deps.runId ?? newRunId(started);
  const runRel = join('runs', runId);
  let toFile: Emit | undefined;
  const seen: RunEvent[] = [];
  const emit = (e: RunEvent): void => {
    seen.push(e);
    toFile ??= createEmitter(join(outDir, runRel));
    toFile(e);
    deps.emit?.(e);
  };
  const at = () => ({ at: new Date(now()).toISOString(), runId });
  const zero = <T>(v: T): Record<StepId, T> => ({ plan: v, model: v, workflow: v, seed: v, tasks: v });
  let ledger: Ledger = { startedAtMs: started, spentUsd: 0, attempts: zero(0), backtracks: 0, seenIssueSets: zero<readonly string[]>([]), stallRetries: zero(0) };
  let seq = 0;
  let unknownCostCalls = 0;
  /** Each step's call durations, for the time preflight. */
  const callMs: Record<StepId, CallRecord[]> = { plan: [], model: [], workflow: [], seed: [], tasks: [] };
  const systems = new Map<StepId, string>();
  const systemFor = (step: StepId): string => {
    const hit = systems.get(step);
    if (hit !== undefined) return hit;
    if (inputDigest === null) throw new Error(`the ${step} system prompt needs the input digest, which picks the example world`);
    // concat flattens a list one level and wraps a single world, so both forms give the list to pick from.
    const text = systemPrompt(step, pickExample(([] as World[]).concat(deps.exampleWorld), inputDigest), job.kind);
    systems.set(step, text);
    return text;
  };

  /** The run so far. On iterate `before` is the old checked world, which every stage is gated against. */
  let world: World | null = null;
  let plan: Plan | null = null;
  let before: CheckedWorld | null = null;
  let oldPlan: Plan | null = null;
  let writtenWorld: World | null = null;
  let worldWritten: boolean | null = false;
  let inputDigest: string | null = job.kind === 'iterate' ? contentDigest(job.request) : null;
  const source = sourceOf(job, runRel);

  /** capsule.json beside REPORT.md: what this run was given, what it wrote, and what it spent. */
  const writeCapsule = (events: readonly RunEvent[], written: World | null): Promise<void> =>
    fs.writeFile(join(outDir, CAPSULE_FILE), `${JSON.stringify(runCapsule(events, { inputDigest, world: written, source }), null, 2)}\n`);

  /** REPORT.md carries the stop reason (and on iterate the delta); world.yaml, plan.yaml and plan.md are untouched. */
  const stop = async (reason: StopReason): Promise<RunResult> => {
    const ms = now() - started;
    const unpriced = unknownCostCalls === 0 ? {} : { unknownCostCalls };
    const finished: RunEvent = { ...at(), t: 'run_finished', ms, costUsd: ledger.spentUsd, ...unpriced, worldWritten: false, result: { kind: 'stopped', reason } };
    const delta = before !== null && world !== null ? diffWorlds(before, world) : undefined;
    await fs.writeFile(join(outDir, 'REPORT.md'), renderReport({ plan: plan ?? oldPlan ?? undefined, delta, events: [...seen, finished], stop: reason }));
    await writeCapsule([...seen, finished], null);
    emit(finished);
    return { kind: 'stopped', dir: outDir, reason, costUsd: ledger.spentUsd, ms, ...unpriced };
  };

  /** Runs attempts on one step until policy advances, backtracks or stops. */
  async function runStep<T>(
    step: StepId,
    reason: 'planned' | 'changed' | 'backtracked',
    carried: Feedback | null,
    ask: (feedback: Feedback | null) => Pick<ProposeRequest, 'prompt' | 'tool'>,
    judge: (input: unknown) => Judged<T>,
  ): Promise<StepOutcome<T>> {
    emit({ ...at(), t: 'step_started', step, reason });
    const stepStarted = now();
    let stepCost = 0;
    let made = 0;
    let feedback = carried;
    let escalated = false;
    let lastCount: number | undefined;
    const tried: TriedAttempt[] = [];
    /** Every owned item an attempt of this step has written: a later answer that leaves one out is partial. */
    const covered = new Set<string>();
    for (;;) {
      const choice = stepModel(config, step, escalated);
      const asked = { system: systemFor(step), ...ask(feedback) };
      const estimateUsd = estimateCallUsd(config, choice.model, asked.system.length + asked.prompt.length);
      const repair = nextIsRepair(callMs[step], feedback !== null);
      const estimateMs = estimateCallMs(choice.effort, callMs[step], repair, step);
      // checkedAt on the performance timeline: the judge below is bounded by the run deadline, perfAt + left.
      const perfAt = performance.now();
      const checkedAt = now();
      const left = remainingMs(config, ledger, checkedAt);
      if (deps.signal?.aborted === true) return { kind: 'stop', reason: { kind: 'cancelled' } };
      const refused = preflight(config, ledger, checkedAt, estimateUsd, estimateMs, step, callMs);
      if (refused !== null) {
        emit({ ...at(), t: 'call_refused', step, reason: refused, estimateUsd, estimateMs, remainingMs: left });
        return { kind: 'stop', reason: refused };
      }
      const shareMs = stepShareMs(config, ledger, step, checkedAt, callMs);
      const cancel = new AbortController();
      const callStarted = now();
      const leftMs = remainingMs(config, ledger, callStarted);
      // On the last step the share is all the time left: without the margin the transport's kill and the run deadline fire together.
      // Keep SHARE_GRACE_MS before the run deadline so a transport kill is recorded, unless that would cut a call preflight let through: then it races the deadline as before.
      const margined = Math.min(shareMs, leftMs - SHARE_GRACE_MS);
      const timeoutMs = estimateMs <= margined ? margined : Math.max(0, Math.min(shareMs, leftMs));
      const req: ProposeRequest = { ...asked, model: choice.model, effort: choice.effort, timeoutMs, maxCostUsd: Math.max(0, config.maxCostUsd - ledger.spentUsd), signal: cancel.signal, runId, step };
      let proposal: Proposal | null = null;
      let failure: { message: string; usage: Usage; costUsd: number | null; ms: number } | null = null;
      let partialModelUsage: SpendEvent['partialModelUsage'];
      /** Why the call produced no proposal when the transport, not the model, ended it. */
      let cut: Extract<AttemptOutcome, { kind: 'share_expired' | 'stalled' }> | null = null;
      // No model, even one that never settles, may outlive its step share or maxMinutes. The abandoned call is dropped, so it cannot touch the ledger or emit.
      const backstop = leftMs <= shareMs + SHARE_GRACE_MS ? EXPIRED : SHARE_EXPIRED;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<typeof EXPIRED | typeof SHARE_EXPIRED>((resolveExpired) => {
        deadline = setTimeout(() => resolveExpired(backstop), Math.min(leftMs, shareMs + SHARE_GRACE_MS));
      });
      const interrupted = new Promise<typeof INTERRUPTED>((resolveInterrupted) => {
        deps.signal?.addEventListener('abort', () => resolveInterrupted(INTERRUPTED), { once: true });
      });
      try {
        const pending = deps.model.propose(req);
        const settled = await Promise.race([interrupted, pending, expired]);
        if (settled === INTERRUPTED) {
          cancel.abort();
          const billing = await cancelledBilling(pending);
          partialModelUsage = billing.partialModelUsage;
          if (billing.costUsd === null) unknownCostCalls += 1;
          else ledger = { ...ledger, spentUsd: ledger.spentUsd + billing.costUsd };
          emit({ ...at(), t: 'call_cancelled', step, ms: now() - callStarted, ...billing });
          return { kind: 'stop', reason: { kind: 'cancelled' } };
        }
        if (settled === EXPIRED) {
          cancel.abort();
          const billing = await cancelledBilling(pending);
          const { costUsd } = billing;
          partialModelUsage = billing.partialModelUsage;
          if (costUsd === null) unknownCostCalls += 1;
          else ledger = { ...ledger, spentUsd: ledger.spentUsd + costUsd };
          emit({ ...at(), t: 'call_cancelled', step, ms: now() - callStarted, ...billing });
          return { kind: 'stop', reason: { kind: 'time_exhausted', minutes: config.maxMinutes } };
        }
        if (settled === SHARE_EXPIRED) {
          cancel.abort();
          const billing = await cancelledBilling(pending);
          const { costUsd } = billing;
          partialModelUsage = billing.partialModelUsage;
          if (costUsd === null) unknownCostCalls += 1;
          cut = { kind: 'share_expired', shareMs, progress: null };
          failure = { message: `the call outlived its ${shareMs} ms step share`, usage: ZERO_USAGE, costUsd, ms: now() - callStarted };
        } else {
          proposal = settled;
        }
      } catch (e) {
        // The spend ledger refused the call before it was made: a cap ran out, the model did not fail.
        if (e instanceof SpendCapError) return { kind: 'stop', reason: { kind: 'spend_cap', cap: e.cap, capUsd: e.capUsd, spentUsd: e.spentUsd, day: e.day } };
        if (e instanceof CostUnenforceableError) return { kind: 'stop', reason: { kind: 'cost_unenforceable', cap: e.cap, claim: e.claim } };
        if (e instanceof StepShareExpired) cut = { kind: 'share_expired', shareMs: e.shareMs, progress: cutProgress(e.progress) };
        if (e instanceof CallStalled) cut = { kind: 'stalled', idleMs: e.idleMs, progress: cutProgress(e.progress) };
        const billed = e instanceof ModelError ? e : undefined;
        const costUsd = failedCallCost(e);
        if (costUsd === null) unknownCostCalls += 1;
        partialModelUsage = partialCallUsage(e);
        failure = {
          message: e instanceof Error ? e.message : String(e),
          usage: billed?.usage ?? ZERO_USAGE,
          costUsd,
          ms: billed?.ms ?? (e instanceof StepShareExpired || e instanceof CallStalled ? e.ms : now() - callStarted),
        };
      } finally {
        clearTimeout(deadline);
      }
      const p = proposal;
      // The engine still judging at maxMinutes is a judge_expired attempt: logged, dumped and charged like any other; decide() stops on it.
      const verdict = p === null ? null : judgeBeforeDeadline(perfAt + left, () => judge(p.input));
      const judged: Judged<T> = verdict !== null
        ? (verdict === EXPIRED ? { ok: false, outcome: { kind: 'judge_expired' }, issues: [] } : verdict)
        : cut !== null
          ? { ok: false, outcome: cut, issues: [] }
          : { ok: false, outcome: { kind: 'model_error', message: failure?.message ?? 'no proposal' }, issues: [] };
      const usage = proposal?.usage ?? failure?.usage ?? ZERO_USAGE;
      const costUsd = proposal !== null ? proposal.costUsd : failure?.costUsd ?? null;
      const ms = proposal?.ms ?? failure?.ms ?? 0;
      const issues = judged.ok ? [] : judged.issues;
      const owned = issues.map((i) => ({ issue: i, owner: ownerIn(step, i, world) }));
      ledger = record(ledger, step, costUsd ?? 0, attemptIssueSet(judged.outcome, owned));
      stepCost += costUsd ?? 0;
      // A stalled call's time is the transport's silence, not how long this step's calls take.
      if (judged.outcome.kind !== 'stalled') callMs[step].push({ ms, repair });
      made += 1;
      const n = ledger.attempts[step];
      seq += 1;
      const dump = join(runRel, `${String(seq).padStart(3, '0')}-${step}-${n}.json`);
      for (const text of proposal?.advice ?? []) emit({ ...at(), t: 'advice', step, text });
      emit({ ...at(), t: 'attempt', step, n, ms, usage, costUsd, outcome: judged.outcome, dump, ...(partialModelUsage === undefined ? {} : { partialModelUsage }) });
      await fs.writeFile(join(outDir, dump), `${JSON.stringify({
        step, n, model: req.model, effort: req.effort ?? null, escalated,
        system: req.system, prompt: req.prompt, tool: req.tool.name,
        proposal: proposal === null ? null : { input: proposal.input, advice: proposal.advice },
        outcome: judged.outcome, usage, costUsd, ms, ...(partialModelUsage === undefined ? {} : { partialModelUsage }),
      }, null, 2)}\n`);

      if (judged.outcome.kind === 'stalled' && costUsd === null) {
        return { kind: 'stop', reason: { kind: 'transport_stalled', step, idleMs: judged.outcome.idleMs } };
      }

      const decision = decide(config, { step, ledger, nowMs: now(), last: step === LAST_STEP }, judged.outcome, owned);
      switch (decision.kind) {
        case 'advance':
          if (!judged.ok) throw new Error(`policy advanced ${step} on a ${judged.outcome.kind} attempt`);
          emit({ ...at(), t: 'step_finished', step, attempts: made, ms: now() - stepStarted, costUsd: stepCost });
          return { kind: 'advance', value: judged.value };
        case 'retry':
          // The transport stalled: run the same request again, with the feedback the stalled attempt had.
          if (judged.outcome.kind === 'stalled') {
            ledger = recordStallRetry(ledger, step);
            emit({ ...at(), t: 'stall_retry', step, n, idleMs: judged.outcome.idleMs, remainingMs: remainingMs(config, ledger, now()) });
            break;
          }
          {
            const touched = touchedItems(step, proposal?.input);
            const left = proposal === null ? [] : [...covered].filter((k) => !touched.has(k)).sort();
            // An attempt that leaves at least as many issues as the one before it makes no headway, and from then on the
            // step escalates. A partial answer is judged without what it left out, so its rise is not counted (A-364).
            if (left.length === 0) {
              if (lastCount !== undefined && issues.length >= lastCount) escalated = true;
              lastCount = issues.length;
            }
            for (const k of touched) covered.add(k);
            const own = ownIssues(issues, step, world);
            if (proposal !== null) tried.push({ n: made, input: proposal.input, issues: own, left });
            const best = bestAttempt(tried);
            feedback = best === undefined
              ? { issues: own, previous: proposal?.input }
              : { issues: best.issues, previous: best.input, history: tried, ...(best.n === made ? {} : { bestOf: best.n }) };
          }
          break;
        case 'backtrack': {
          // A step that traded the frozen tests against another check also hands the plan the test failures it last saw (A-406).
          const failedTests = decision.withFrozenTests === true ? lastFrozenTestFailures(tried) : [];
          return { kind: 'backtrack', to: decision.to, because: [...issues, ...failedTests], previous: proposal?.input };
        }
        case 'stop':
          return { kind: 'stop', reason: decision.reason };
        default:
          return assertNever(decision);
      }
    }
  }

  try {
  emit({
    ...at(), t: 'run_started', mode: job.kind, input: job.kind === 'create' ? job.input.kind : 'change_request',
    model: config.model, budgetUsd: config.maxCostUsd, transport: transportOf(config),
  });

  /** The plan step's schema and prompt: from the input digest on create, from the request, old plan and world on iterate. */
  let planRules: PlanSchema;
  let askPlan: (feedback: Feedback | null) => Pick<ProposeRequest, 'prompt' | 'tool'>;
  /** Iterate with a plan.yaml only: the plan a patch applies to, its acceptance tests as the world holds them (A-345). */
  let patchBase: Plan | null = null;
  let gate: Gate | null = null;
  /** Iterate only: the engine report on the world as it was before the run, the baseline for its debt. */
  let beforeReport: CheckReport | null = null;
  /** Iterate only: the old world's failing issues it was admitted with, each owned by a stage that must rerun and clear it (A-395). */
  let admitted: readonly CheckIssue[] = [];
  /** Create from an OpenAPI spec only: conformance to the spec at the last step. */
  let fidelity: Fidelity = UNCHECKED;
  let coverageDigest: InputDigest | undefined;
  /** Iterate only: the stages the plan's changes reach. Others run only if their own acceptance fails. */
  let toRun: ReadonlySet<StageId> | null = null;
  let final: StageValue['checked'] = null;
  let reason: 'planned' | 'changed' | 'backtracked' = 'planned';

  if (job.kind === 'create') {
    const digested = await (deps.digest ?? digestInput)(job.input)
      .catch((e: unknown) => ({ ok: false as const, why: `The input could not be read: ${e instanceof Error ? e.message : String(e)}` }));
      if (!digested.ok) return await stop({ kind: 'input_rejected', why: digested.why });
    const digest = digested.digest;
    coverageDigest = digest;
    inputDigest = contentDigest(digest);
    fidelity = await fidelityOf(job.input, fs);
    planRules = planSchemaFor(digest.kind);
    askPlan = (fb) => ({ prompt: planPrompt(digest, fb, plan), tool: planTool(planRules) });
    const base = baseWorld(finalDir, digest);
      if (!base.ok) return await stop({ kind: 'input_rejected', why: base.why });
    world = base.world;
  } else {
    const loaded = await loadWorld(outDir);
      if (!loaded.ok) return await stop({ kind: 'input_rejected', why: `${outDir} has no usable world.yaml: ${loaded.error[0].found}` });
    const deadline = perfStarted + config.maxMinutes * 60_000;
    const firstCheck = beforeDeadline(deadline, () => checkWorld(loaded.value, loaded.lines));
      if (firstCheck === EXPIRED) return await stop({ kind: 'time_exhausted', minutes: config.maxMinutes });
    let checkedOld: CheckReport = firstCheck;
    if (!firstCheck.ok) {
      // An old world held back only at the tasks layer by issues a stage owns is admitted, those issues tolerated, as
      // work that stage must clear; the plan below must rerun it (A-395). Any other failure is refused as before.
      const owed = admissibleIssues(firstCheck);
      if (owed !== null) {
        const retried = beforeDeadline(deadline, () => checkWorld(loaded.value, loaded.lines, { tolerate: new Set(owed.map((i) => i.code)) }));
          if (retried === EXPIRED) return await stop({ kind: 'time_exhausted', minutes: config.maxMinutes });
        if (retried.ok) {
          checkedOld = retried;
          admitted = owed;
        }
      }
    }
    if (!checkedOld.ok) {
      const [first] = firstCheck.ok ? checkedOld.issues : firstCheck.issues;
        return await stop({ kind: 'input_rejected', why: `the existing world does not pass the engine: ${first.code} at ${first.path.join('.')} (${first.found})` });
    }
    const existing = checkedOld.world;
    // The world this change starts from, so its report's Changes section can be re-rendered later (A-351).
    await saveWorld(join(outDir, runRel, 'before'), existing);
    before = existing;
    world = existing;
    beforeReport = checkedOld;
    gate = { before: existing, edits: [], request: job.request, debt: new Map() };
    const previous = parsePlanYaml(await fs.readFile(join(outDir, 'plan.yaml'), 'utf8').catch(() => ''));
    oldPlan = previous;
    planRules = iteratePlanSchema(existing, previous);
    const base = previous === null ? null : planWithWorldTests(previous, existing);
    patchBase = base;
    // After a backtrack the plan accepted earlier in this run is the plan a patch applies to, and the one shown.
    askPlan = (fb) => ({ prompt: iteratePlanPrompt(job.request, base === null ? null : (plan ?? base), existing, fb), tool: base === null ? planTool(planRules) : PATCH_TOOL });
    reason = 'changed';
  }

  let index = 0;
  let carried: Feedback | null = null;
  /** The last rejection of each step that backtracked and has not advanced since. Its answer was never applied. */
  const rejectedBefore = new Map<StepId, Feedback>();
  while (index < STEPS.length) {
    const step = STEPS[index] ?? LAST_STEP;
    // The backtrack target's own feedback and the iterate probe's describe the world as it is now, so they win.
    carried = carried ?? rejectedBefore.get(step) ?? null;
    let outcome: StepOutcome<unknown>;
    if (step === 'plan') {
      const r: StepOutcome<Plan> = await runStep<Plan>(step, reason, carried, askPlan, (input) =>
        patchBase === null ? judgePlan(planRules, input, plan ?? oldPlan, coverageDigest) : judgePatch(planRules, input, plan ?? patchBase, plan ?? oldPlan));
      if (r.kind === 'advance') {
        const accepted: Plan = r.value;
        plan = accepted;
        if (job.kind === 'create') {
          await fs.mkdir(outDir, { recursive: true });
          await fs.writeFile(join(outDir, 'plan.yaml'), renderPlanYaml(accepted));
          await fs.writeFile(join(outDir, 'plan.md'), renderPlanMd(accepted));
        }
        if (accepted.verdict.kind === 'refuse') {
          const { why, feasibleIf } = accepted.verdict;
            return await stop({ kind: 'input_rejected', why: feasibleIf === undefined || feasibleIf === '' ? why : `${why} What would make it feasible: ${feasibleIf}` });
        }
        if (job.kind === 'create' && world !== null) {
          world = {
            ...world,
            meta: { ...world.meta, description: accepted.summary, resembles: accepted.software, clock: accepted.clock },
            tests: frozenTests(accepted, {}),
          };
        } else if (world !== null && before !== null) {
          const changed = changedSections(accepted, world);
          const reruns: ReadonlySet<string> = new Set(stagesToRun(changed));
          toRun = new Set(stagesToRun(changed));
          const unowned = admitted.find((i) => !reruns.has(ownerOf(i)));
          if (unowned !== undefined) {
              return await stop({ kind: 'input_rejected', why: `the existing world does not pass the engine, and the change plan does not rerun ${ownerOf(unowned)}, which owns ${unowned.code} at ${unowned.path.join('.')}` });
          }
          if (gate !== null && beforeReport !== null) gate = { ...gate, debt: debtOf(beforeReport, before, oldPlan ?? accepted, toRun, coverageDigest) };
          // A plan-only revision (A-294) reaches no stage: every stage is then probed against the unchanged world below.
          if (toRun.size === 0 && !revisesPlanOnly(patchBase ?? oldPlan, accepted)) {
              return await stop({ kind: 'input_rejected', why: 'the plan changes nothing in the world: it adds no item the world lacks and its changes name no existing item' });
          }
          world = { ...world, tests: frozenTests(accepted, before.tests) };
        }
      }
      outcome = r;
    } else {
      const current: Plan | null = plan;
      if (current === null) throw new Error(`stage ${step} reached before the plan`);
      const start: World | null = world;
      if (start === null) throw new Error(`stage ${step} reached before the world`);
      const request = job.kind === 'iterate' ? job.request : null;
      // A stage the plan's changes do not reach is skipped only when the world as it stands already passes
      // that stage's own acceptance, preservation included. Otherwise it runs, with what failed as feedback.
      if (toRun !== null && !toRun.has(step) && reason !== 'backtracked') {
        const probe = judgeBeforeDeadline(performance.now() + remainingMs(config, ledger, now()), (): Judged<StageValue> => judgeCandidate(step, start, null, current, gate, fidelity, check, coverageDigest));
          if (probe === EXPIRED) return await stop({ kind: 'time_exhausted', minutes: config.maxMinutes });
        if (probe.ok) {
          const { forgiven } = probe.value;
          const carriedDebt = forgiven.length === 0 ? '' : `; it keeps ${forgiven.length} issue(s) the world had before this iterate: ${[...new Set(forgiven.map((i) => i.code))].join(', ')}`;
          emit({ ...at(), t: 'step_skipped', step, why: `no planned change reaches ${[...writesOf(step), ...STAGES[step].reads].join(', ')}${carriedDebt}` });
          if (step === LAST_STEP) final = probe.value.checked;
          rejectedBefore.delete(step);
          index += 1;
          carried = null;
          continue;
        }
          if (probe.outcome.kind === 'judge_error') return await stop({ kind: 'judge_error', step, message: probe.outcome.message });
        carried = { issues: probe.issues, previous: undefined };
      }
      const r: StepOutcome<StageValue> = await runStep<StageValue>(
        step, reason, carried,
        (fb): Pick<ProposeRequest, 'prompt' | 'tool'> => ({ prompt: stagePrompt(step, current, start, fb, request, job.kind === 'create' && job.input.kind === 'openapi'), tool: editTool(step) }),
        (input): Judged<StageValue> => judgeEdit(step, start, current, input, gate, fidelity, check, coverageDigest),
      );
      if (r.kind === 'advance') {
        world = r.value.world;
        if (gate !== null && r.value.edit !== null) gate = { ...gate, edits: [...gate.edits, r.value.edit] };
        if (step === LAST_STEP) final = r.value.checked;
      }
      outcome = r;
    }
    switch (outcome.kind) {
      case 'advance':
        rejectedBefore.delete(step);
        index += 1;
        reason = job.kind === 'create' ? 'planned' : 'changed';
        carried = null;
        break;
      case 'backtrack':
        emit({ ...at(), t: 'backtracked', from: step, to: outcome.to, because: outcome.because });
        rejectedBefore.set(step, { issues: outcome.because, previous: outcome.previous, rerunBy: outcome.to });
        ledger = recordBacktrack(ledger, outcome.to);
        index = STEPS.indexOf(outcome.to);
        reason = 'backtracked';
        // The world is not rolled back, so a stage sees its earlier answer in it; the plan gets its earlier plan.
        carried = { issues: outcome.because, previous: outcome.to === 'plan' ? (plan ?? undefined) : undefined, from: step };
        break;
      case 'stop':
          return await stop(outcome.reason);
      default:
        return assertNever(outcome);
    }
  }

  if (final === null) throw new Error('the last stage advanced without a checked world');
  const ms = now() - started;
  const finished: RunEvent = { ...at(), t: 'run_finished', ms, costUsd: ledger.spentUsd, worldWritten: true, result: { kind: 'done', worldDir: finalDir } };
  if (job.kind === 'iterate' && plan !== null && before !== null) {
    const planFile = join(outDir, 'plan.yaml');
    const planMdFile = join(outDir, 'plan.md');
    const originalPlan = await fs.readFile(planFile).catch((e: unknown) => {
      if (isRecord(e) && e.code === 'ENOENT') return null;
      throw e;
    });
    const originalPlanMd = await fs.readFile(planMdFile).catch((e: unknown) => {
      if (isRecord(e) && e.code === 'ENOENT') return null;
      throw e;
    });
    const staged = join(outDir, 'plan.yaml.tmp');
    const stagedMd = join(outDir, 'plan.md.tmp');
    await fs.writeFile(staged, renderPlanYaml(plan));
    await fs.writeFile(stagedMd, renderPlanMd(plan));
    let savedWorld = false;
    let planWritten = false;
    let planMdWritten = false;
    try {
      await saveWorld(outDir, final.world);
        savedWorld = true;
      worldWritten = true;
        writtenWorld = final.world;
      await fs.rename(staged, planFile);
      planWritten = true;
      await fs.rename(stagedMd, planMdFile);
      planMdWritten = true;
      await fs.writeFile(join(outDir, 'REPORT.md'), renderReport({ plan, report: final.report, delta: diffWorlds(before, final.world), events: [...seen, finished] }));
      await writeCapsule([...seen, finished], final.world);
      emit(finished);
    } catch (e) {
      const failures: unknown[] = [e];
        // The old world goes back through saveWorld like any world.yaml write (A-85); the old plan and plan.md are restored byte for byte.
        if (savedWorld) {
          try { await saveWorld(outDir, before); worldWritten = false; writtenWorld = null; } catch (rollbackError) { worldWritten = null; writtenWorld = null; failures.push(rollbackError); }
      }
      if (planWritten) {
        try {
          if (originalPlan === null) await fs.rm(planFile);
          else {
            await fs.writeFile(`${planFile}.rollback`, originalPlan);
            await fs.rename(`${planFile}.rollback`, planFile);
          }
        } catch (rollbackError) { failures.push(rollbackError); }
      }
      if (planMdWritten) {
        try {
          if (originalPlanMd === null) await fs.rm(planMdFile);
          else {
            await fs.writeFile(`${planMdFile}.rollback`, originalPlanMd);
            await fs.rename(`${planMdFile}.rollback`, planMdFile);
          }
        } catch (rollbackError) { failures.push(rollbackError); }
      }
      try {
        await fs.rm(staged, { force: true });
        await fs.rm(stagedMd, { force: true });
      } catch (rollbackError) { failures.push(rollbackError); }
      if (failures.length > 1) throw new AggregateError(failures, 'iterate persistence failed and restoring the original files also failed');
      throw e;
    }
  } else {
    emit({ ...at(), t: 'fidelity', check: fidelity.check(final.world, plan?.software ?? 'the described software') });
    await saveWorld(outDir, final.world);
      worldWritten = true;
      writtenWorld = final.world;
      await fs.writeFile(join(outDir, 'REPORT.md'), renderReport({ plan: plan ?? undefined, report: final.report, events: [...seen, finished], sourceFields: coverageDigest?.sourceFields }));
    await writeCapsule([...seen, finished], final.world);
    emit(finished);
    if (job.kind === 'create') {
      await setAside(fs, finalDir, `${finalDir}.replaced-${runId}`);
      await fs.rename(outDir, finalDir);
    }
  }
  return { kind: 'done', dir: finalDir, report: final.report, costUsd: ledger.spentUsd, ms };
  } catch (error) {
    if (!seen.some(event => event.t === 'run_finished')) {
      const message = error instanceof Error ? error.message : String(error);
      const finished: RunEvent = { ...at(), t: 'run_finished', ms: now() - started, costUsd: ledger.spentUsd,
        ...(unknownCostCalls === 0 ? {} : { unknownCostCalls }), worldWritten, result: { kind: 'crashed', message } };
      try { emit(finished); } catch { /* Keep the original exception if the event sink fails too. */ }
      await Promise.allSettled([
        Promise.resolve().then(() => fs.writeFile(join(outDir, 'REPORT.md'), renderReport({ plan: plan ?? oldPlan ?? undefined, events: seen, crash: { message, worldWritten } }))),
        Promise.resolve().then(() => writeCapsule(seen, writtenWorld)),
      ]);
    }
    throw error;
  }
}
