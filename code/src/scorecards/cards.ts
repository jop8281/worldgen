/**
 * The four scorecards of YOS-262 (A-402), rendered as prod/scorecards.md: generator, environment fidelity, grader and
 * agent. Each has its own denominator and its own limits, and every number names the committed file it comes from.
 * Pure: cli/scorecards.ts reads the files and the engine's verdicts and hands them in.
 */
import { z } from 'zod';
import type { Manifest, ManifestV1 } from '../dataset/schema.ts';
import type { Outcome } from '../worldgen/eval.ts';
import { analyzeEvalOutcomes, type EvalEvidence, type ExpectedEvalCase } from '../worldgen/eval-outcomes.ts';

/** A-258's FIDELITY_FLOOR, as each recorded fidelity event also carries it. */
const FIDELITY_FLOOR = 0.8;

// ---------------------------------------------------------------------------------------------
// Inputs. Every path is relative to the repository root, with forward slashes.

/** One eval run: its directory, the suite whose cases it ran, and the case evidence found there. */
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
export type ExportInput = { readonly source: string; readonly manifest: Manifest | ManifestV1 };

export type ScorecardInputs = {
  readonly runs: readonly RunInput[];
  /** Run directories with case files that no suite file holds, and so are not scored. */
  readonly unmatchedRuns: readonly string[];
  /** Run directories with no case files: older formats and drills. */
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

// ---------------------------------------------------------------------------------------------
// 1. Generator

/** The suite file that holds the most of a run's case ids, or null when none holds any or two hold as many. */
export function suiteFor(ids: readonly string[], suites: readonly { readonly file: string; readonly ids: readonly string[] }[]): string | null {
  const scored = suites.map((s) => ({ file: s.file, n: ids.filter((id) => s.ids.includes(id)).length })).sort((a, b) => b.n - a.n);
  const [best, next] = scored;
  return best === undefined || best.n === 0 || (next !== undefined && next.n === best.n) ? null : best.file;
}


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
  const notes = rows.flatMap((r) => [
    ...(r.unexpected.length === 0 ? [] : [`- ${code(r.run)} also holds ${r.unexpected.map(code).join(', ')}, which ${code(r.suiteFile)} does not list, so ${r.unexpected.length === 1 ? 'it is' : 'they are'} not scored.`]),
    ...(r.usdCases === r.ran ? [] : [`- ${code(r.run)} has a measured cost for ${r.usdCases} of its ${r.ran} cases.`]),
  ]);
  return [
    '## 1. Generator: does WorldGen build a world the engine accepts?',
    '',
    'One row per eval run under `eval/runs/` that keeps its case files, scored as `bun scripts/analyze-eval.ts <suite> <run>` scores it, against the suite file that holds its cases. The denominator is the cases the run ran. A pass is a success or an expected refusal. A targeted rerun runs only some of its suite, so its rate is over those cases, not the suite. The Run and Suite columns name the files each row is computed from. p50 and p95 are nearest-rank over the cases with a measured time. Times and costs are client-side estimates, not invoices.',
    '',
    '| Run | Suite | Cases run | Passed | Pass rate | Success | Expected refusal | Product failure | Infra failure | p50 min | p95 min | Cost USD |',
    '|---|---|--:|--:|--:|--:|--:|--:|--:|--:|--:|--:|',
    ...rows.map((r) => row([
      code(r.run), `${r.suite} (${code(r.suiteFile)})`, `${r.ran} of ${r.suiteSize}`, r.passed, pct(r.passed, r.ran),
      r.outcomes.success, r.outcomes['expected refusal'], r.outcomes['product failure'], r.outcomes['infra failure'],
      minutes(r.p50Ms), minutes(r.p95Ms), usd(r.usd),
    ])),
    '',
    ...notes,
    ...(inputs.unmatchedRuns.length === 0 ? [] : [`- No suite file holds the cases of ${inputs.unmatchedRuns.map(code).join(', ')}, so ${inputs.unmatchedRuns.length === 1 ? 'it is' : 'they are'} not scored.`]),
    ...(inputs.otherRuns.length === 0 ? [] : [`- ${inputs.otherRuns.length} other folders under \`eval/runs/\` keep no case files, so analyze-eval cannot score them: ${inputs.otherRuns.map(code).join(', ')}.`]),
    ...(notes.length + inputs.unmatchedRuns.length + inputs.otherRuns.length === 0 ? [] : ['']),
    `Limits: a generator pass says the engine accepted the world and verify passed. It says nothing about fidelity, grader strength or whether an agent can solve the tasks.`,
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

export type FidelityRow = { readonly run: string; readonly caseId: string; readonly source: string; readonly reference: string; readonly score: number | null; readonly floor: number };

/** A row per reference score a run recorded, and one with no score for a referenced case that recorded none. */
export function fidelityRows(run: RunInput, references: readonly string[]): FidelityRow[] {
  return [...run.evidence].sort((a, b) => a.id.localeCompare(b.id)).flatMap((e): FidelityRow[] => {
    const scored = (['create', 'change'] as const).flatMap((phase) =>
      fidelityChecks(e.logs[phase]).flatMap((c) =>
        c.kind === 'reference' ? [{ run: run.run, caseId: e.id, source: `${run.run}/${e.id}/${phase === 'create' ? '' : 'change/'}events.jsonl`, reference: c.reference, score: c.score, floor: c.floor }] : []));
    if (scored.length > 0 || !references.includes(e.id)) return scored;
    return [{ run: run.run, caseId: e.id, source: `${run.run}/${e.id}/events.jsonl`, reference: e.id, score: null, floor: FIDELITY_FLOOR }];
  });
}

/** How each case of a run was checked for fidelity: by kind, and the cases that recorded no check. */
export function fidelityKinds(run: RunInput): { readonly reference: number; readonly openapi: number; readonly unchecked: number; readonly none: number } {
  const kinds = run.evidence.map((e) => [...fidelityChecks(e.logs.create), ...fidelityChecks(e.logs.change)].map((c) => c.kind));
  return {
    reference: kinds.filter((k) => k.includes('reference')).length,
    openapi: kinds.filter((k) => k.includes('openapi')).length,
    unchecked: kinds.filter((k) => k.includes('unchecked')).length,
    none: kinds.filter((k) => k.length === 0).length,
  };
}

function fidelityCard(inputs: ScorecardInputs): string[] {
  const rows = inputs.runs.flatMap((r) => fidelityRows(r, inputs.references));
  const scored = rows.filter((r) => r.score !== null);
  const above = scored.filter((r) => r.score! >= r.floor).length;
  return [
    '## 2. Environment fidelity: does a world resemble the software it names?',
    '',
    `A description case with a frozen reference in \`eval/fidelity/\` (${inputs.references.map(code).join(', ')}) is scored at its run's last step by \`fidelityScore()\` against the ${FIDELITY_FLOOR.toFixed(2)} floor (A-258), and the run records the score as a \`fidelity\` event in the case's \`events.jsonl\`. The denominator is the recorded scores: ${above} of ${scored.length} are at or above the floor.`,
    '',
    '| Run | Case | Reference | Score | Floor | At or above the floor | Source |',
    '|---|---|---|--:|--:|---|---|',
    ...rows.map((r) => row([code(r.run), r.caseId, r.reference, r.score === null ? 'none recorded' : r.score, r.floor, r.score === null ? '-' : r.score >= r.floor ? 'yes' : 'no', code(r.source)])),
    '',
    'How every case of each run was checked, from the same `fidelity` events:',
    '',
    '| Run | Against a reference | Against the OpenAPI source spec | No reference, unchecked | No fidelity event | Source |',
    '|---|--:|--:|--:|--:|---|',
    ...inputs.runs.map((r) => {
      const k = fidelityKinds(r);
      return row([code(r.run), k.reference, k.openapi, k.unchecked, k.none, code(`${r.run}/*/events.jsonl`)]);
    }),
    '',
    'Limits: the references cover only the cases named above, so every other description world is unchecked. An OpenAPI check compares paths, request shapes and error codes within the chosen scope with the source spec (`worldplay openapi`); the event records that it ran, not a score. A run that stopped before its last step records no fidelity event.',
  ];
}

// ---------------------------------------------------------------------------------------------
// 3. Grader

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
  // Rounded down, so a decoy just below 1 never reads as 1.
  const decoyTop = Math.floor(verified.flatMap((w) => w.tasks.flatMap((t) => t.decoys)).reduce((m, s) => Math.max(m, s), 0) * 1e4) / 1e4;
  return [
    '## 3. Grader: does each grader tell the right end state from a wrong one?',
    '',
    `Every world in \`prod/worlds/\`, checked by the engine's \`checkWorld\`, which \`bun run worldplay verify\` runs. The denominator is the ${all.tasks} tasks of the ${verified.length} worlds that pass check. A world passes only when, on every task, the reference solution scores 1, doing nothing scores 0, every decoy scores below 1, every alternative solution scores 1, and the replay is deterministic, so those controls hold for each task counted here. The highest decoy score, rounded down, is ${decoyTop}.`,
    '',
    '- **Decoys** are shortcut solutions that must score below 1. **Alternatives** are other correct solutions that must score 1 (A-199).',
    '- **One-write solutions** make one successful writing call; `worldplay verify` prints `prefix -` for them.',
    '- **Checks flipped** counts the grader checks (goals, guards or a returned score) that some probe turned from met to unmet: a strict prefix of the solution, a decoy, an engine mutant or a free-text swap (A-393). [research/evidence/probe-coverage.md](../research/evidence/probe-coverage.md) lists the checks no probe flips.',
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

function agentCard(inputs: ScorecardInputs): string[] {
  const out = [
    '## 4. Agent: how often does an agent solve a task?',
    '',
    'Graded agent episodes: an episode passes when the engine scores its final state 1. Two sources, each with its own denominator.',
    '',
    '### Measured difficulty',
    '',
    'From `bun run difficulty` runs in `eval/difficulty/` (A-391). The denominator is a cell\'s trials: graded episodes that stopped done or at their turn, budget or time limit. The measured tier is easy at a pass rate of 2/3 or more, medium at 1/3 or more and hard below; the interval is Wilson 95%.',
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
  const v2 = inputs.exports.filter((e) => e.manifest.manifest_version !== 1);
  const total = (es: readonly ExportInput[], f: (c: ReturnType<typeof exportCounts>) => number): number => es.reduce((n, e) => n + f(exportCounts(e.manifest)), 0);
  out.push(
    '### Dataset exports',
    '',
    'From the `manifest.json` of each export folder in `eval/dataset/` (YOS-91). The denominator is the episodes an export holds. A schema-2 export counts every episode by verdict: success, partial, failure or infra (A-389, A-396). A schema-1 export counts only the complete successes and the rest.',
    '',
    '| Export folder | Schema | Model | Episodes | Success | Partial | Failure | Infra | Not a success | Source |',
    '|---|--:|---|--:|--:|--:|--:|--:|--:|---|',
    ...inputs.exports.map((e) => {
      const c = exportCounts(e.manifest);
      const dash = (n: number | null): string | number => n ?? '-';
      return row([code(e.source.replace(/\/manifest\.json$/, '/')), e.manifest.schema_version, e.manifest.model, c.episodes, c.success, dash(c.partial), dash(c.failure), dash(c.infra), c.notSuccess, code(e.source)]);
    }),
    row(['**Total**', '', '', total(inputs.exports, (c) => c.episodes), total(inputs.exports, (c) => c.success), '', '', '', total(inputs.exports, (c) => c.notSuccess), code('eval/dataset/')]),
    '',
    v2.length === 0
      ? 'No schema-2 export is committed yet, so no partial, failure or infra count is shown: the committed exports predate A-389.'
      : `${v2.length} schema-2 export folder${v2.length === 1 ? ' holds' : 's hold'} ${total(v2, (c) => c.episodes)} episodes: ${total(v2, (c) => c.success)} success, ${total(v2, (c) => c.partial ?? 0)} partial, ${total(v2, (c) => c.failure ?? 0)} failure, ${total(v2, (c) => c.infra ?? 0)} infra.`,
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
