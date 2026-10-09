/**
 * The four scorecards of YOS-262 (A-402), rendered as prod/scorecards.md: generator, environment fidelity, grader and
 * agent. Each has its own denominator and its own limits, and every number names the committed file it comes from.
 * Pure: cli/scorecards.ts reads the files and the engine's verdicts and hands them in.
 */
import { z } from 'zod';
import type { TaskVerdict } from '#engine';
import type { Manifest, ManifestV1 } from '../dataset/schema.ts';
import type { Outcome } from '../worldgen/eval.ts';
import { analyzeEvalOutcomes, type EvalEvidence, type ExpectedEvalCase } from '../worldgen/eval-outcomes.ts';
import { FIDELITY_FLOOR } from '../worldgen/fidelity.ts';

// ---------------------------------------------------------------------------------------------
// Inputs. Every path is relative to the repository root, with forward slashes.

/**
 * One eval run: its directory, the suite whose cases it ran, and the case evidence found there. Each evidence's
 * `source` is its case.json's path, so a run whose cases sit in lane folders keeps each case's own path.
 */
export type RunInput = {
  readonly run: string;
  readonly suite: string;
  readonly suiteFile: string;
  readonly cases: readonly ExpectedEvalCase[];
  readonly evidence: readonly EvalEvidence[];
};
/** One task of a checked world: what verify proved and how far the probes reached. */
export type GraderTask = {
  readonly task: string;
  readonly decoys: readonly number[];
  readonly alternatives: number;
  readonly solutionWrites: number;
  readonly checks: number;
  readonly flipped: number;
  readonly slots: number;
  readonly probed: number;
};
/** A world in prod/worlds: its verified tasks, or the first issue that kept it from passing check. */
export type GraderWorld = { readonly world: string; readonly source: string } & (
  | { readonly tasks: readonly GraderTask[] }
  | { readonly refused: string }
);
export type DifficultyInput = { readonly source: string; readonly text: string };
export type ExportInput = { readonly source: string } & ({ readonly manifest: Manifest | ManifestV1 } | { readonly error: string });

export type ScorecardInputs = {
  readonly runs: readonly RunInput[];
  /** Run directories with case files that no suite file holds, or that two hold equally, and so are not scored. */
  readonly unmatchedRuns: readonly string[];
  /** Run directories with no case files, directly or one folder down: older formats and drills. */
  readonly otherRuns: readonly string[];
  /** The case ids with a frozen reference in eval/fidelity/. */
  readonly references: readonly string[];
  readonly worlds: readonly GraderWorld[];
  readonly difficulty: readonly DifficultyInput[];
  readonly exports: readonly ExportInput[];
};

// ---------------------------------------------------------------------------------------------
// Formatting

const cell = (v: string | number): string => String(v).replaceAll('|', '\\|').replaceAll('\n', ' ');
const row = (vs: readonly (string | number)[]): string => `| ${vs.map(cell).join(' | ')} |`;
const code = (p: string): string => `\`${p}\``;
const pct = (n: number, of: number): string => (of === 0 ? '-' : `${((100 * n) / of).toFixed(1)}%`);
const minutes = (ms: number | null): string => (ms === null ? '-' : (ms / 60_000).toFixed(1));
const usd = (v: number | null): string => (v === null ? '-' : v.toFixed(2));
const ratio = (n: number, of: number): string => `${n}/${of} (${pct(n, of)})`;
const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);
/** x cut, not rounded, to 4 decimals, so a score just below 1 never reads as 1. */
const cut4 = (x: number): string => String(Math.floor(Math.round(x * 1e6) / 100) / 1e4);

// ---------------------------------------------------------------------------------------------
// Which runs, against which suite

/**
 * The runs a folder under eval/runs holds: itself when its case folders sit directly in it; one run made of all its
 * lane folders when those hold disjoint cases (parallel lanes of one run); one run per folder when they overlap (the
 * arms of an A/B); none when no case folder is found.
 */
export function runParts(run: string, direct: readonly string[], subs: readonly { readonly name: string; readonly ids: readonly string[] }[]): { readonly run: string; readonly parts: readonly string[] }[] {
  if (direct.length > 0) return [{ run, parts: [run] }];
  const lanes = subs.filter((s) => s.ids.length > 0);
  if (lanes.length === 0) return [];
  const ids = lanes.flatMap((s) => s.ids);
  if (new Set(ids).size === ids.length) return [{ run, parts: lanes.map((s) => `${run}/${s.name}`) }];
  return lanes.map((s) => ({ run: `${run}/${s.name}`, parts: [`${run}/${s.name}`] }));
}

/**
 * The suite file that holds the most of a run's case ids; on a tie, the smaller suite, which fits the run more
 * closely. Null when none holds any, or when two hold as many and are the same size.
 */
export function suiteFor(ids: readonly string[], suites: readonly { readonly file: string; readonly ids: readonly string[] }[]): string | null {
  const scored = suites.map((s) => ({ file: s.file, n: ids.filter((id) => s.ids.includes(id)).length, size: s.ids.length })).sort((a, b) => b.n - a.n || a.size - b.size);
  const [best, next] = scored;
  return best === undefined || best.n === 0 || (next !== undefined && next.n === best.n && next.size === best.size) ? null : best.file;
}

// ---------------------------------------------------------------------------------------------
// 1. Generator

export type GeneratorRow = {
  readonly run: string;
  readonly suite: string;
  readonly suiteFile: string;
  readonly suiteSize: number;
  /** Suite cases with any evidence in the run: every outcome but not run. */
  readonly ran: number;
  readonly passed: number;
  readonly outcomes: Readonly<Record<Outcome, number>>;
  readonly p50Ms: number | null;
  readonly p95Ms: number | null;
  readonly usd: number | null;
  readonly usdCases: number;
  /** Case folders in the run that the suite does not hold. */
  readonly unexpected: readonly string[];
};

/** A run as `bun scripts/analyze-eval.ts <suite> <run>` scores it. */
export function generatorRow(i: RunInput): GeneratorRow {
  const r = analyzeEvalOutcomes(i.cases, i.evidence);
  return {
    run: i.run, suite: i.suite, suiteFile: i.suiteFile, suiteSize: r.counts.expected,
    ran: r.counts.expected - r.outcomes['not run'], passed: r.passed, outcomes: r.outcomes,
    p50Ms: r.metrics.ms.p50, p95Ms: r.metrics.ms.p95, usd: r.metrics.costUsd.measuredTotal, usdCases: r.metrics.costUsd.measured,
    unexpected: r.unexpected.map((u) => u.id),
  };
}

function generatorCard(inputs: ScorecardInputs): string[] {
  const rows = inputs.runs.map(generatorRow);
  const notes = [
    ...rows.flatMap((r) => [
      ...(r.unexpected.length === 0 ? [] : [`- ${code(r.run)} also holds ${r.unexpected.map(code).join(', ')}, which ${code(r.suiteFile)} does not list, so ${plural(r.unexpected.length, 'it is', 'they are')} not scored.`]),
      ...(r.usdCases === r.ran ? [] : [`- ${code(r.run)} has a measured cost for ${r.usdCases} of its ${r.ran} cases run.`]),
    ]),
    ...(inputs.unmatchedRuns.length === 0 ? [] : [`- ${inputs.unmatchedRuns.map(code).join(', ')}: no one suite file holds ${plural(inputs.unmatchedRuns.length, 'its', 'their')} cases, so ${plural(inputs.unmatchedRuns.length, 'it is', 'they are')} not scored.`]),
    ...(inputs.otherRuns.length === 0 ? [] : [`- ${inputs.otherRuns.length} other ${plural(inputs.otherRuns.length, 'folder', 'folders')} under \`eval/runs/\` keep no case files, directly or one folder down, so analyze-eval cannot score them: ${inputs.otherRuns.map(code).join(', ')}.`]),
  ];
  return [
    '## 1. Generator: does WorldGen build a world the engine accepts?',
    '',
    'One row per eval run under `eval/runs/` that keeps its case files, scored as `bun scripts/analyze-eval.ts <suite> <run>` scores it, against the suite file that holds its cases. The Run and Suite columns name the files each row is computed from. A run whose cases sit in parallel lane folders is one row; the arms of an A/B are one row each.',
    '',
    'The denominator is every case of the suite (A-341), so a targeted rerun\'s rate counts the cases it did not run as not passed; Cases run shows how many it ran. A pass is a success, an `expect: done` case that ended done and passed verify, or an expected refusal, an impossible case that stopped `input_rejected` (A-384). p50 and p95 are nearest-rank over the cases with a measured time. Times and costs are client-side estimates, not invoices.',
    '',
    '| Run | Suite | Cases run | Passed | Pass rate | Success | Expected refusal | Product failure | Infra failure | p50 min | p95 min | Cost USD |',
    '|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|',
    ...rows.map((r) => row([
      code(r.run), `${r.suite} (${code(r.suiteFile)})`, `${r.ran} of ${r.suiteSize}`, r.passed, pct(r.passed, r.suiteSize),
      r.outcomes.success, r.outcomes['expected refusal'], r.outcomes['product failure'], r.outcomes['infra failure'],
      minutes(r.p50Ms), minutes(r.p95Ms), usd(r.usd),
    ])),
    '',
    ...notes,
    ...(notes.length === 0 ? [] : ['']),
    'Limits: a success says the engine accepted the world and verify passed, and an expected refusal that WorldGen turned down an impossible prompt. Neither says anything about fidelity, grader strength or whether an agent can solve the tasks. Every run is scored against the suite file as it is now, so a case whose expectation has changed since the run reads as invalid, an infra failure.',
  ];
}

// ---------------------------------------------------------------------------------------------
// 2. Environment fidelity

const fidelityCheck = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('openapi') }),
  z.strictObject({ kind: z.literal('reference'), reference: z.string(), score: z.number(), floor: z.number() }),
  z.strictObject({ kind: z.literal('unchecked'), software: z.string() }),
]);
const fidelityEvent = z.object({ t: z.literal('fidelity'), check: fidelityCheck });
type FidelityCheck = z.output<typeof fidelityCheck>;

/** The fidelity events a log recorded, in order. A line that is not JSON or not a fidelity event is skipped; analyze-eval judges the log. */
export function fidelityChecks(log: string | null | undefined): FidelityCheck[] {
  if (log == null) return [];
  return log.split('\n').flatMap((line) => {
    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      return [];
    }
    const e = fidelityEvent.safeParse(raw);
    return e.success ? [e.data.check] : [];
  });
}

/** A run's evidence for the cases its suite holds. run.ts records fidelity on a finished create run only, so only the create log counts. */
const suiteEvidence = (run: RunInput): EvalEvidence[] => run.evidence.filter((e) => run.cases.some((c) => c.id === e.id));
const eventsOf = (e: EvalEvidence): string => e.source.replace(/case\.json$/, 'events.jsonl');

export type FidelityRow = { readonly run: string; readonly caseId: string; readonly source: string; readonly reference: string; readonly score: number | null; readonly floor: number };

/**
 * A row per reference score a run recorded, and one with no score for a referenced case that recorded no fidelity
 * event at all. A run where no case recorded one predates the event, so it gives no rows.
 */
export function fidelityRows(run: RunInput, references: readonly string[]): FidelityRow[] {
  const evidence = suiteEvidence(run);
  if (!evidence.some((e) => fidelityChecks(e.logs.create).length > 0)) return [];
  return evidence.flatMap((e): FidelityRow[] => {
    const checks = fidelityChecks(e.logs.create);
    const scored = checks.flatMap((c) => (c.kind === 'reference' ? [{ run: run.run, caseId: e.id, source: eventsOf(e), reference: c.reference, score: c.score, floor: c.floor }] : []));
    if (checks.length > 0 || !references.includes(e.id)) return scored;
    return [{ run: run.run, caseId: e.id, source: eventsOf(e), reference: e.id, score: null, floor: FIDELITY_FLOOR }];
  });
}

/** How each suite case of a run was checked for fidelity: by kind, and the cases that recorded no check. */
export function fidelityKinds(run: RunInput): { readonly reference: number; readonly openapi: number; readonly unchecked: number; readonly none: number } {
  const kinds = suiteEvidence(run).map((e) => fidelityChecks(e.logs.create).map((c) => c.kind));
  return {
    reference: kinds.filter((k) => k.includes('reference')).length,
    openapi: kinds.filter((k) => k.includes('openapi')).length,
    unchecked: kinds.filter((k) => k.includes('unchecked')).length,
    none: kinds.filter((k) => k.length === 0).length,
  };
}

function fidelityCard(inputs: ScorecardInputs): string[] {
  const rows = inputs.runs.flatMap((r) => fidelityRows(r, inputs.references));
  const scored = rows.filter((r) => r.score !== null).length;
  return [
    '## 2. Environment fidelity: does a world resemble the software it names?',
    '',
    `A description case with a frozen reference in \`eval/fidelity/\` (${inputs.references.map(code).join(', ')}) is gated at its run's last step by \`fidelityScore()\` against the ${FIDELITY_FLOOR.toFixed(2)} floor (A-258): a world below the floor is sent back for repair, never saved. A finished create run records its check as a \`fidelity\` event in the case's \`events.jsonl\`, so every recorded score is at or above the floor by construction. What varies is the score, and whether the run got that far. The denominator is each run of a referenced case, in the runs that record fidelity events at all: ${scored} of ${rows.length} recorded a score.`,
    '',
    '| Run | Case | Reference | Score | Floor | Source |',
    '|---|---|---|--:|--:|---|',
    ...rows.map((r) => row([code(r.run), r.caseId, r.reference, r.score === null ? 'none recorded' : r.score, r.floor, code(r.source)])),
    '',
    'How every suite case of each run was checked, from the same `fidelity` events. An OpenAPI check means the world passed the gate against its source spec: paths, request shapes and error codes within the chosen scope. It records no score.',
    '',
    '| Run | Against a reference | Against the OpenAPI source spec | No reference, unchecked | No fidelity event | Source |',
    '|---|--:|--:|--:|--:|---|',
    ...inputs.runs.map((r) => {
      const k = fidelityKinds(r);
      return row([code(r.run), k.reference, k.openapi, k.unchecked, k.none, code(`${r.run}/**/events.jsonl`)]);
    }),
    '',
    'Limits: the references cover only the cases named above, so every other description world is unchecked, and a case that recorded `unchecked` ran before its reference existed. A run records no fidelity event when it stopped before saving a world, when it was an impossible case WorldGen refused, or when it predates the event. A change case\'s check describes its world before the change: an iterate records none.',
  ];
}

// ---------------------------------------------------------------------------------------------
// 3. Grader

/** What the grader card reads off a verdict: decoy scores, writes, and the checks and mutant slots the probes reached (A-393). */
export function graderTaskOf(v: Pick<TaskVerdict, 'taskId' | 'decoys' | 'solutionWrites' | 'checks' | 'collateral'>, alternatives: number): GraderTask {
  return {
    task: v.taskId, decoys: v.decoys.map((d) => d.score), alternatives, solutionWrites: v.solutionWrites,
    checks: v.checks.length, flipped: v.checks.filter((c) => c.flippedBy.length > 0).length,
    slots: v.collateral.length, probed: v.collateral.filter((m) => m.call !== null).length,
  };
}

type GraderTotals = { readonly tasks: number; readonly decoys: number; readonly alternatives: number; readonly oneWrite: number; readonly checks: number; readonly flipped: number; readonly slots: number; readonly probed: number };

export function graderTotals(tasks: readonly GraderTask[]): GraderTotals {
  const add = (f: (t: GraderTask) => number): number => tasks.reduce((n, t) => n + f(t), 0);
  return {
    tasks: tasks.length, decoys: add((t) => t.decoys.length), alternatives: add((t) => t.alternatives), oneWrite: tasks.filter((t) => t.solutionWrites === 1).length,
    checks: add((t) => t.checks), flipped: add((t) => t.flipped), slots: add((t) => t.slots), probed: add((t) => t.probed),
  };
}

function graderCard(inputs: ScorecardInputs): string[] {
  const verified = inputs.worlds.flatMap((w) => ('tasks' in w ? [w] : []));
  const refused = inputs.worlds.flatMap((w) => ('refused' in w ? [w] : []));
  const all = graderTotals(verified.flatMap((w) => w.tasks));
  const line = (label: string, t: GraderTotals, source: string): string =>
    row([label, t.tasks, t.decoys, t.alternatives, t.oneWrite, ratio(t.flipped, t.checks), ratio(t.probed, t.slots), source]);
  const decoys = verified.flatMap((w) => w.tasks.flatMap((t) => t.decoys.map((score) => ({ score, world: w, task: t.task }))));
  const top = decoys.reduce<(typeof decoys)[number] | null>((m, d) => (m === null || d.score > m.score ? d : m), null);
  return [
    '## 3. Grader: does each grader tell the right end state from a wrong one?',
    '',
    `Every world in \`prod/worlds/\`, checked by the engine's \`checkWorld\`, which \`bun run worldplay verify\` runs. The denominator is the ${all.tasks} tasks of the ${verified.length} worlds that pass check. A world passes only when, on every task, the reference solution scores 1, doing nothing scores 0, every decoy scores below 1, every alternative solution scores 1, and the replay is deterministic, so those controls hold for each task counted here.${top === null ? '' : ` The highest decoy score, cut to 4 decimals, is ${cut4(top.score)}, on ${top.task} in ${code(top.world.source)}.`}`,
    '',
    '- **Decoys** are shortcut solutions that must score below 1. **Alternatives** are other correct solutions that must score 1 (A-199).',
    '- **One-write solutions** make one successful writing call; `worldplay verify` prints `prefix -` for them.',
    '- **Checks flipped** counts the grader checks (goals, guards or a returned score) that some probe turned from met to unmet: a strict prefix of the solution, a decoy, an engine mutant or a free-text swap (A-393). [research/evidence/probe-coverage.md](../research/evidence/probe-coverage.md) lists the checks no probe flipped, as of the commit it names.',
    '- **Mutant slots probed** counts the engine mutant kinds that found a change to probe on each task.',
    '',
    '| World | Tasks | Decoys, all below 1 | Alternatives, all at 1 | One-write solutions | Checks flipped | Mutant slots probed | Source |',
    '|---|--:|--:|--:|--:|--:|--:|---|',
    ...verified.map((w) => line(w.world, graderTotals(w.tasks), code(w.source))),
    line('**Total**', all, code('prod/worlds/')),
    '',
    ...(refused.length === 0 ? [] : [...refused.map((w) => `- ${code(w.source)} fails check, so its tasks are not counted: ${w.refused}`), '']),
    ...(all.alternatives === 0 ? ['No task declares an alternative solution, so this card does not yet show that a second correct path also scores 1.', ''] : []),
    'Limits: an unflipped check is unprobed, not proven weak, and a flipped one is proven only against the probes that ran. The graders, decoys and alternatives of a generated world come from the same model run as its solution, so a shared blind spot passes. The engine grades the final state only, not an agent\'s final reply.',
  ];
}

// ---------------------------------------------------------------------------------------------
// 4. Agent

const tier = z.enum(['easy', 'medium', 'hard']);
const difficultySchema = z.object({
  runId: z.string(),
  models: z.array(z.string()),
  episodesPerCell: z.number(),
  budgetUsd: z.number(),
  spentUsd: z.number(),
  stop: z.object({ kind: z.string() }),
  cells: z.array(z.object({
    world: z.string(), task: z.string(), labeled: tier, model: z.string(), episodes: z.number(), trials: z.number(), passes: z.number(),
    passRate: z.number().nullable(), interval: z.tuple([z.number(), z.number()]).nullable(), measured: z.enum(['easy', 'medium', 'hard', 'unmeasured']),
  })),
  episodes: z.array(z.unknown()),
});
export type DifficultyRun = z.output<typeof difficultySchema>;

/** A difficulty.json as `bun run difficulty` writes it, or the reason it is not one. */
export function parseDifficulty(text: string): { ok: true; run: DifficultyRun } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, error: 'not JSON' };
  }
  const r = difficultySchema.safeParse(raw);
  return r.success ? { ok: true, run: r.data } : { ok: false, error: r.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ') };
}

/** Outcome counts of one export folder: by verdict for schema 2; schema 1 counts only complete successes and the rest. */
export function exportCounts(m: Manifest | ManifestV1): { readonly episodes: number; readonly success: number; readonly partial: number | null; readonly failure: number | null; readonly infra: number | null; readonly notSuccess: number } {
  if (m.manifest_version === 1) return { episodes: m.counts.episodes, success: m.counts.accepted, partial: null, failure: null, infra: null, notSuccess: m.counts.failed };
  const v = m.counts.by_verdict;
  return { episodes: m.counts.episodes, success: v.success, partial: v.partial, failure: v.failure, infra: v.infra, notSuccess: v.partial + v.failure + v.infra };
}

export type ExportGroup = {
  /** The folder that holds the world folders, such as eval/dataset/2026-10-07 or eval/dataset/2026-10-09-sweep/p1. */
  readonly folder: string;
  readonly manifests: number;
  readonly schemas: readonly number[];
  readonly models: readonly string[];
  readonly episodes: number;
  readonly success: number;
  /** Summed over the schema-2 manifests; null when the folder has none. */
  readonly partial: number | null;
  readonly failure: number | null;
  readonly infra: number | null;
  readonly notSuccess: number;
  /** Schema-2 manifests exported with successes only. */
  readonly successesOnly: number;
};

/** Readable export manifests, grouped by the folder above their world folder, in the order given. */
export function exportGroups(exports: readonly ExportInput[]): ExportGroup[] {
  const groups = new Map<string, ExportGroup>();
  const add = (n: number | null, m: number | null): number | null => (n === null ? m : m === null ? n : n + m);
  for (const e of exports) {
    if (!('manifest' in e)) continue;
    const folder = e.source.split('/').slice(0, -2).join('/');
    const c = exportCounts(e.manifest);
    const g = groups.get(folder);
    const only = e.manifest.manifest_version !== 1 && e.manifest.selection?.successes_only === true ? 1 : 0;
    groups.set(folder, {
      folder, manifests: (g?.manifests ?? 0) + 1,
      schemas: [...new Set([...(g?.schemas ?? []), e.manifest.schema_version])].sort((a, b) => a - b),
      models: [...new Set([...(g?.models ?? []), e.manifest.model])].sort(),
      episodes: (g?.episodes ?? 0) + c.episodes, success: (g?.success ?? 0) + c.success,
      partial: add(g?.partial ?? null, c.partial), failure: add(g?.failure ?? null, c.failure), infra: add(g?.infra ?? null, c.infra),
      notSuccess: (g?.notSuccess ?? 0) + c.notSuccess, successesOnly: (g?.successesOnly ?? 0) + only,
    });
  }
  return [...groups.values()];
}

function agentCard(inputs: ScorecardInputs): string[] {
  const out = [
    '## 4. Agent: how often does an agent solve a task?',
    '',
    'Graded agent episodes, from two sources, each with its own denominator.',
    '',
    '### Measured difficulty',
    '',
    'From `bun run difficulty` runs in `eval/difficulty/` (A-391). A pass is an engine score of 1. The denominator is a cell\'s trials: graded episodes that stopped done, at their turn, budget or time limit, or on an invalid turn; a model error, a refusal, a world or grade error, an interruption and a run-wide cut are not trials. The measured tier is easy at a pass rate of 2/3 or more, medium at 1/3 or more and hard below; the interval is Wilson 95%.',
    '',
  ];
  if (inputs.difficulty.length === 0) out.push('No difficulty run is committed.', '');
  for (const d of inputs.difficulty) {
    const p = parseDifficulty(d.text);
    if (!p.ok) {
      out.push(`- ${code(d.source)} is not a difficulty run: ${p.error}`, '');
      continue;
    }
    const r = p.run;
    const measured = r.cells.filter((c) => c.measured !== 'unmeasured');
    const agree = measured.filter((c) => c.measured === c.labeled).length;
    out.push(
      `${code(d.source)}: run \`${r.runId}\`, models ${r.models.join(', ')}, ${r.episodesPerCell} episodes per task per model, ${r.episodes.length} episodes, charged $${r.spentUsd} of $${r.budgetUsd}, stop ${r.stop.kind}. The labeled tier agrees with the measured one in ${agree} of ${measured.length} measured cells.`,
      '',
      '| World | Task | Model | Labeled | Measured | Agrees | Passes / trials | Pass rate | 95% interval |',
      '|---|---|---|---|---|---|--:|--:|---|',
      ...r.cells.map((c) => row([
        c.world, c.task, c.model, c.labeled, c.measured, c.measured === 'unmeasured' ? '-' : c.measured === c.labeled ? 'yes' : 'no',
        `${c.passes} / ${c.trials}`, c.passRate === null ? '-' : pct(c.passes, c.trials), c.interval === null ? '-' : `${c.interval[0]} to ${c.interval[1]}`,
      ])),
      '',
    );
  }
  const groups = exportGroups(inputs.exports);
  const unreadable = inputs.exports.flatMap((e) => ('error' in e ? [e] : []));
  const v2 = groups.filter((g) => g.partial !== null);
  const sum = (gs: readonly ExportGroup[], f: (g: ExportGroup) => number): number => gs.reduce((n, g) => n + f(g), 0);
  const dash = (n: number | null): string | number => n ?? '-';
  const successesOnly = groups.filter((g) => g.successesOnly > 0);
  out.push(
    '### Dataset exports',
    '',
    'From the `manifest.json` of each export folder in `eval/dataset/`, one per world, grouped by the folder that holds the world folders: an export, or one pass of an export made in passes (YOS-91). The denominator is the episodes the manifests count. A success is a complete success: stopped done, an engine score of exactly 1, a non-blank final reply, both state hashes and fully accounted spend. A schema-2 manifest counts every episode by verdict: success, partial, failure or infra (A-389, A-396). A schema-1 manifest counts only the successes and the rest.',
    '',
    '| Manifests | World folders | Schema | Model | Episodes | Success | Partial | Failure | Infra | Not a success |',
    '|---|--:|---|---|--:|--:|--:|--:|--:|--:|',
    ...groups.map((g) => row([code(`${g.folder}/*/manifest.json`), g.manifests, g.schemas.join(', '), g.models.join(', '), g.episodes, g.success, dash(g.partial), dash(g.failure), dash(g.infra), g.notSuccess])),
    row(['**Total**', sum(groups, (g) => g.manifests), '', '', sum(groups, (g) => g.episodes), sum(groups, (g) => g.success), '', '', '', sum(groups, (g) => g.notSuccess)]),
    '',
    ...(unreadable.length === 0 ? [] : [...unreadable.map((e) => `- ${code(e.source)} is unreadable, so it is not counted: ${e.error}`), '']),
    v2.length === 0
      ? 'No schema-2 export is committed yet, so no partial, failure or infra count is shown: the committed exports predate A-389.'
      : `Schema-2 manifests, in ${v2.length} ${plural(v2.length, 'folder', 'folders')}, count ${sum(v2, (g) => g.episodes)} episodes: ${sum(v2, (g) => g.success)} success, ${sum(v2, (g) => g.partial ?? 0)} partial, ${sum(v2, (g) => g.failure ?? 0)} failure, ${sum(v2, (g) => g.infra ?? 0)} infra.`,
    ...(successesOnly.length === 0 ? [] : ['', `${successesOnly.map((g) => code(`${g.folder}/`)).join(', ')} ${plural(successesOnly.length, 'holds', 'hold')} exports made with successes only, so ${plural(successesOnly.length, 'its', 'their')} zero partial, failure and infra counts say nothing was kept, not that nothing failed.`]),
    '',
    'Limits: few tasks, few episodes and few models; a 3-of-3 cell cannot tell easy from medium. The engine score certifies the final world state, not the agent\'s final reply. An export holds the runs someone chose to export, so its success share is not a sample of all tasks.',
  );
  return out;
}

// ---------------------------------------------------------------------------------------------

/** prod/scorecards.md. */
export function renderScorecards(inputs: ScorecardInputs): string {
  return [
    '> Generated by `bun run scorecards` in code/ from committed files only, with no model call. Do not edit by hand.',
    '',
    '# Scorecards',
    '',
    'Four separate scorecards (YOS-262, A-402). Each has its own denominator and its own limits, and no number crosses from one to another: a generator pass says nothing about an agent, and an agent pass nothing about fidelity. Every number names the committed file it comes from.',
    '',
    ...generatorCard(inputs),
    '',
    ...fidelityCard(inputs),
    '',
    ...graderCard(inputs),
    '',
    ...agentCard(inputs),
    '',
  ].join('\n');
}
