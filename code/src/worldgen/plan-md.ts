/**
 * plan.md, the human view of the plan (design law L12, YOS-182): code renders it from the
 * same Plan that plan.yaml renders from, in plan.yaml's key order, so the two files always
 * agree. Every line comes from a plan field; nothing is invented, and no plan field is
 * left out.
 *
 * Invariants:
 * - Pure: no model, no file IO, no clock. run.ts writes it beside plan.yaml: right after
 *   the plan step accepts on create, and staged beside plan.yaml at the end of an accepted
 *   iterate, rolled back with it. On a stop it is untouched, like plan.yaml (A-39, A-85).
 * - The same plan always renders the same text, so plan.md is a view, never a second
 *   source of truth (L12).
 */
import type { Plan } from './plan.ts';

type Workflow = Plan['workflows'][number];
type AcceptanceTest = Plan['acceptanceTests'][number];
type Task = Plan['tasks'][number];

/** One table cell: a pipe escaped and a newline flattened, so one plan value stays on one row. */
const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
/** One heading or title line. */
const oneLine = (s: string): string => s.replace(/\s+/g, ' ').trim();
/** A list item; continuation lines are indented to stay inside the item. */
function item(text: string, depth = 0): string {
  const pad = '  '.repeat(depth);
  return `${pad}- ${text.split(/\r?\n/).join(`\n${pad}  `)}`;
}
/** `blocks` one to a line, or `empty` when the plan holds none. */
const blockList = (blocks: readonly string[], empty: string): string => (blocks.length === 0 ? empty : blocks.join('\n'));
/** A record as `key: value` pairs, or `none` when it holds none. */
const pairs = (record: Readonly<Record<string, string | number>>): string => {
  const entries = Object.entries(record);
  return entries.length === 0 ? 'none' : entries.map(([key, value]) => `${key}: ${value}`).join(', ');
};

/** One workflow: its declared lifecycle (states), the actions that move it, and its rules in their typed forms. */
function workflowMd(w: Workflow): string {
  const rules = w.rules.map((r) => item(typeof r === 'string' ? r : 'by' in r ? `${r.rule} Enforced by: ${r.by.join(', ')}. Tested by: ${r.test}` : `${r.rule} Enforced by the data model: ${r.schema}`, 1));
  return [
    `### ${w.name} (${w.entity})`,
    `- States: ${w.states.length === 0 ? 'none' : w.states.join(', ')}`,
    `- Actions: ${w.actions.length === 0 ? 'none' : w.actions.join(', ')}`,
    rules.length === 0 ? '- Rules: none' : ['- Rules:', ...rules].join('\n'),
  ].join('\n');
}

/** One acceptance test: what it proves, the actions it names, then its script verbatim in a fence. */
function acceptanceTestMd(t: AcceptanceTest): string {
  return [
    `### ${t.id}`,
    item(`Intent: ${t.intent}`),
    `- Actions: ${t.actions.join(', ')}`,
    item(`Description: ${t.description}`),
    '',
    '```js',
    t.script,
    '```',
  ].join('\n');
}

/** One task: its difficulty and intent, its decoy idea, and the pressure it declares. */
function taskMd(t: Task): string {
  const p = t.pressure;
  const pressure = p === undefined ? [] : [
    ...(p.paging === undefined ? [] : [`paging past the first page of ${p.paging}`]),
    ...(p.states === undefined || p.states.length === 0 ? [] : [`seeded rows in ${p.states.join(', ')}`]),
    ...(p.distractors === undefined ? [] : [`distractor rows of ${p.distractors}`]),
  ];
  return [
    item(`\`${t.id}\` (${t.difficulty}): ${t.intent}`),
    item(`Decoy idea: ${t.decoyIdea}`, 1),
    ...(pressure.length === 0 ? [] : [item(`Pressure: ${pressure.join('; ')}`, 1)]),
  ].join('\n');
}

/** plan.md for `plan`. Sections follow plan.yaml's key order, so the two files read alike. */
export function renderPlanMd(plan: Plan): string {
  const entities = plan.entities.map((e) => `| \`${e.name}\` | ${cell(e.purpose)} | ${cell(e.keyFields.join(', '))} |`);
  const routes = plan.routes.map((r) => `| \`${r.id}\` | ${r.method} | ${r.path} | ${cell(r.purpose)} |`);
  const meta = [
    `- Revision: ${plan.revision}`,
    ...(plan.verdict.kind === 'refuse'
      ? [`- Verdict: refuse — ${plan.verdict.why}`, ...(plan.verdict.feasibleIf === undefined ? [] : [`- Feasible if: ${plan.verdict.feasibleIf}`])]
      : ['- Verdict: proceed']),
    `- Clock: starts ${plan.clock.start}, tick ${plan.clock.tick}`,
  ].join('\n');
  const seed = [
    item(`Rows per entity: ${pairs(plan.seed.rowsPerEntity)}`),
    item(`Mix: ${plan.seed.mix}`),
    ...(plan.seed.stateMix === undefined ? [] : [
      `- State mix: ${Object.entries(plan.seed.stateMix)
        .map(([entity, mix]) => `${entity}: ${Object.entries(mix).map(([state, pct]) => `${state} ${pct}%`).join(', ')}`)
        .join('; ')}`,
    ]),
  ].join('\n');
  const blocks: string[] = [
    `# WorldGen plan: ${oneLine(plan.software)}`,
    plan.summary,
    meta,
    '## Entities',
    entities.length === 0 ? 'None. The plan names no entity.' : ['| Entity | Purpose | Key fields |', '|---|---|---|', ...entities].join('\n'),
    '## Workflows',
    blockList(plan.workflows.map(workflowMd), 'None. The plan declares no workflow.'),
    '## Jobs',
    blockList(plan.jobs.map((j) => item(`\`${j.name}\` runs every ${j.every}: ${j.rule}`)), 'None. The plan declares no job.'),
    '## Acceptance tests',
    blockList(plan.acceptanceTests.map(acceptanceTestMd), 'None. The plan records no acceptance test.'),
    '## Routes',
    routes.length === 0 ? 'None. The plan declares no route.' : ['| Route | Method | Path | Purpose |', '|---|---|---|---|', ...routes].join('\n'),
    '## Seed',
    seed,
    '## Tasks',
    blockList(plan.tasks.map(taskMd), 'None. The plan records no task.'),
    '## Open questions',
    blockList(
      (plan.open_questions ?? []).map((q) => `${item(q.question)}\n${item(`Default answer: ${q.default_answer}`, 1)}`),
      'None. The plan asks no open question.',
    ),
    '## Assumptions',
    blockList(plan.assumptions.map((a) => `${item(a.decision)}\n${item(`Why: ${a.why}`, 1)}`), 'None. The plan records no assumption.'),
    '## Out of scope',
    blockList(plan.outOfScope.map((o) => `${item(o.what)}\n${item(`Why: ${o.why}`, 1)}`), 'None. The plan leaves nothing out.'),
    '## Changes',
    blockList(plan.changes.map((c) => item(c)), 'None. The plan changes no existing item.'),
  ];
  return `${blocks.join('\n\n')}\n`;
}
