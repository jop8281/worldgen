/**
 * The red-team run's report (A-404). Each task runs once with the red-team solver, which sees only the public world and
 * makes a near-miss of the task on purpose: wrong in one important way, said in its reply. A full score is a candidate
 * grader bug, and the row keeps the trace that earned it. `rowOf` turns an episode into a row; `renderRedteamSummary` writes summary.md.
 * Triage notes, one per fooled task, say whether the trace really skipped the task or did it anyway.
 * Pure: no model, no IO.
 */
import type { Episode } from './schema.ts';

/** One request the red-team solver sent, with what the world answered. */
export type RedteamStep = {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body?: unknown;
  readonly outcome: 'response' | 'rejected' | 'error';
  readonly status: number | null;
};

/** One task's red-team episode. `fooled` is a full engine score: the grader accepted what the trace did. */
export type RedteamRow = {
  readonly world: string;
  readonly task: string;
  readonly difficulty: Episode['difficulty'];
  readonly score: number | null;
  readonly fooled: boolean;
  readonly stopReason: Episode['stop_reason'];
  readonly costUsd: number;
  readonly modelCalls: number;
  readonly trace: readonly RedteamStep[];
  readonly finalReply: string | null;
};

/** The row of one red-team episode of `world`. */
export function rowOf(world: string, ep: Episode): RedteamRow {
  const results = new Map(ep.messages.flatMap((m) => (m.type === 'tool_result' ? [[m.call_id, m] as const] : [])));
  const trace = ep.messages.flatMap((m): RedteamStep[] => {
    if (m.type !== 'tool_call') return [];
    const r = results.get(m.call_id);
    return [{
      method: m.request.method, path: m.request.path, query: m.request.query,
      ...(m.request.body === undefined ? {} : { body: m.request.body }),
      outcome: r?.outcome ?? 'error', status: r?.status ?? null,
    }];
  });
  return {
    world, task: ep.task_id, difficulty: ep.difficulty, score: ep.score, fooled: ep.score === 1, stopReason: ep.stop_reason,
    costUsd: ep.usage.cost_usd, modelCalls: ep.usage.model_calls, trace, finalReply: ep.final_reply,
  };
}

export type RedteamRun = {
  readonly date: string;
  readonly model: string;
  readonly engineCommit: string;
  readonly rows: readonly RedteamRow[];
  /** Per fooled task, keyed `<world>/<task>`: whether the trace skipped the task (a grader bug) or did it anyway. */
  readonly triage?: Readonly<Record<string, string>>;
};

const usd = (n: number): string => `$${n.toFixed(4)}`;
const cell = (s: string): string => s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
const stepText = (s: RedteamStep): string => {
  const q = Object.keys(s.query).length === 0 ? '' : `?${new URLSearchParams(s.query).toString()}`;
  return `${s.method} ${s.path}${q}${s.body === undefined ? '' : ` ${JSON.stringify(s.body)}`}`;
};
const answer = (s: RedteamStep): string => (s.outcome === 'response' ? String(s.status) : s.outcome);
const scoreText = (n: number | null): string => (n === null ? 'not graded' : n.toFixed(3));

/** summary.md for a red-team run: the counts and spend, each fooled grader with its trace and triage, then every task. */
export function renderRedteamSummary(run: RedteamRun): string {
  const { rows } = run;
  const fooled = rows.filter((r) => r.fooled);
  const graded = rows.filter((r) => r.score !== null);
  const partial = graded.filter((r) => r.score !== null && r.score > 0 && r.score < 1).length;
  const zero = graded.filter((r) => r.score === 0).length;
  const spend = rows.reduce((n, r) => n + r.costUsd, 0);
  const worlds = new Set(rows.map((r) => r.world)).size;
  const out = [
    `# Red-team run ${run.date}`,
    '',
    `Each task ran once with the red-team solver (A-404) on \`${run.model}\`, engine \`${run.engineCommit}\`. The solver saw only the public world and made a near-miss of the task on purpose: wrong in one important way, said in its reply. A full score is a candidate grader bug; its triage says whether the near-miss really was wrong.`,
    '',
    '| | Count |',
    '|---|--:|',
    `| Tasks run | ${rows.length} (${worlds} worlds) |`,
    `| Fooled: scored 1 | ${fooled.length} |`,
    `| Scored above 0 and below 1 | ${partial} |`,
    `| Scored 0 | ${zero} |`,
    `| Not graded | ${rows.length - graded.length} |`,
    `| Model spend | ${usd(spend)} over ${rows.reduce((n, r) => n + r.modelCalls, 0)} calls |`,
    '',
    '## Fooled graders',
    '',
  ];
  if (fooled.length === 0) out.push('None: no grader gave full marks.', '');
  for (const r of fooled) {
    const key = `${r.world}/${r.task}`;
    out.push(`### ${key} (${r.difficulty})`, '', `Triage: ${run.triage?.[key] ?? 'not triaged yet.'}`, '', `Final reply: ${r.finalReply === null ? 'none' : JSON.stringify(r.finalReply)}`, '');
    out.push('| # | Request | Answer |', '|--:|---|---|', ...r.trace.map((s, i) => `| ${i + 1} | \`${cell(stepText(s))}\` | ${answer(s)} |`), '');
  }
  out.push('## Every task', '', '| World | Task | Difficulty | Score | Stop | Calls | Spend |', '|---|---|---|--:|---|--:|--:|');
  for (const r of rows) out.push(`| ${r.world} | ${r.task} | ${r.difficulty} | ${scoreText(r.score)} | ${r.stopReason} | ${r.modelCalls} | ${usd(r.costUsd)} |`);
  return `${out.join('\n')}\n`;
}
