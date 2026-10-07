/**
 * The live run: the hiring team's prompts in prod/prompts/, one WorldGen run each, and the
 * results table in prod/LIVE-RUN.md. No model and no file IO: cli/live.ts lists the directory,
 * reads the files and runs runWorldGen, and this module plans the cases and renders the table.
 *
 * Invariants:
 * - A prompt file is never edited. `<NN>-<slug>.v2.txt` is a clarification and a separate run.
 * - A file that is not part of the intake format is a problem, never silently skipped.
 * - The table reports what happened: a stop is a result, and so is a world that is done but fails verify.
 */
import { CASE_ID } from './eval.ts';

export type IntakeInput =
  | { readonly kind: 'description'; readonly file: string }
  | { readonly kind: 'openapi'; readonly file: string; readonly argsFile: string | null }
  | { readonly kind: 'csv'; readonly dir: string; readonly files: readonly string[] };

export type LiveCase = {
  /** `<NN>-<slug>`, plus `.v2` for a clarification. */
  readonly id: string;
  /** The world folder name under prod/worlds: `gen-<slug>`, plus `-v2` for a clarification. */
  readonly outName: string;
  readonly input: IntakeInput;
  /** A change request run on the world the create run saved, or null. */
  readonly changeFile: string | null;
};

export type IntakePlan = { readonly cases: readonly LiveCase[]; readonly problems: readonly string[] };

const ORDER = /^(\d{2,})-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const OPENAPI_EXT = /\.openapi\.(?:ya?ml|json)$/;

/**
 * Plans the cases from the files under the prompts directory, as relative POSIX paths. README.md
 * and dotfiles are not prompts. Cases come back in order of their `NN`.
 */
export function planIntake(paths: readonly string[]): IntakePlan {
  const problems: string[] = [];
  const cases = new Map<string, LiveCase>();
  const argsFiles = new Map<string, string>();
  const changes = new Map<string, string>();
  const csv = new Map<string, string[]>();

  const idOf = (stem: string, file: string): string | null => {
    const base = stem.replace(/\.v2$/, '');
    const m = ORDER.exec(base);
    if (m === null) {
      problems.push(`${file}: name it <NN>-<slug>, with a two-digit order and a lowercase kebab-case slug`);
      return null;
    }
    return stem;
  };
  const outNameOf = (id: string): string => `gen-${id.replace(/^\d+-/, '').replace(/\.v2$/, '-v2')}`;
  const add = (id: string, file: string, input: IntakeInput): void => {
    if (cases.has(id)) problems.push(`${file}: prompt ${id} is already given by another file`);
    else cases.set(id, { id, outName: outNameOf(id), input, changeFile: null });
  };

  for (const file of [...paths].sort()) {
    const parts = file.split('/');
    const name = parts.at(-1) ?? file;
    if (parts.length === 1 && (name === 'README.md' || name.startsWith('.'))) continue;
    if (parts.length === 2 && parts[0] !== undefined) {
      const dir = parts[0];
      if (name.endsWith('.csv') && ORDER.test(dir)) csv.set(dir, [...(csv.get(dir) ?? []), file]);
      else problems.push(`${file}: a folder holds the CSV files of one prompt, named <NN>-<slug>/<table>.csv`);
      continue;
    }
    if (parts.length !== 1) {
      problems.push(`${file}: prompts sit directly in the prompts directory, or in one folder for CSV files`);
      continue;
    }
    let m: RegExpExecArray | null;
    if ((m = /^(.+)\.change\.txt$/.exec(name)) !== null) {
      const id = idOf(m[1]!, file);
      if (id !== null) changes.set(id, file);
    } else if ((m = /^(.+)\.args$/.exec(name)) !== null) {
      const id = idOf(m[1]!, file);
      if (id !== null) argsFiles.set(id, file);
    } else if (OPENAPI_EXT.test(name)) {
      const id = idOf(name.replace(OPENAPI_EXT, ''), file);
      if (id !== null) add(id, file, { kind: 'openapi', file, argsFile: null });
    } else if (name.endsWith('.txt')) {
      const id = idOf(name.slice(0, -'.txt'.length), file);
      if (id !== null) add(id, file, { kind: 'description', file });
    } else {
      problems.push(`${file}: not part of the intake format (.txt, .openapi.yaml with an optional .args, a CSV folder, .change.txt)`);
    }
  }
  for (const [dir, files] of csv) add(dir, `${dir}/`, { kind: 'csv', dir, files: [...files].sort() });

  for (const [id, file] of argsFiles) {
    const c = cases.get(id);
    if (c === undefined || c.input.kind !== 'openapi') problems.push(`${file}: no ${id}.openapi.yaml for these arguments`);
    else cases.set(id, { ...c, input: { ...c.input, argsFile: file } });
  }
  for (const [id, file] of changes) {
    const c = cases.get(id);
    if (c === undefined) problems.push(`${file}: no prompt ${id} to change`);
    else cases.set(id, { ...c, changeFile: file });
  }
  for (const id of cases.keys()) {
    if (!CASE_ID.test(id.replace(/\.v2$/, ''))) problems.push(`${id}: not a valid prompt id`);
  }
  const order = [...cases.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return { cases: order, problems: problems.sort() };
}

export type LiveOutcome = 'done' | 'stopped' | 'crashed' | 'skipped';
export type LiveCheck = { readonly kind: 'pass'; readonly tasks: number } | { readonly kind: 'fail'; readonly codes: readonly string[] } | { readonly kind: 'not_run' };

export type LiveRow = {
  readonly id: string;
  readonly inputKind: IntakeInput['kind'];
  readonly changed: boolean;
  readonly outcome: LiveOutcome;
  /** The stop line, the crash message or the reason it was skipped. Empty for done. */
  readonly detail: string;
  readonly check: LiveCheck;
  readonly ms: number;
  readonly costUsd: number;
  readonly unknownCostCalls?: number;
  /** Where the artifacts are, relative to the repo root. */
  readonly dir: string;
};

export type LiveMeta = {
  readonly date: string;
  readonly commit: string;
  readonly model: string;
  readonly maxCostUsd: number;
  readonly maxMinutes: number;
};

/** A row's world is delivered when WorldGen finished and the engine accepts it. */
export const delivered = (r: LiveRow): boolean => r.outcome === 'done' && r.check.kind === 'pass';

const cell = (s: string): string => s.replace(/\r?\n/g, ' ').replace(/\|/g, '\\|').trim();
const minutes = (ms: number): string => (ms / 60000).toFixed(1);

function checkCell(c: LiveCheck): string {
  switch (c.kind) {
    case 'pass':
      return `pass, ${c.tasks} tasks`;
    case 'fail':
      return `FAIL ${c.codes.join(', ')}`;
    case 'not_run':
      return 'not run';
  }
}

/** prod/LIVE-RUN.md: one row per prompt, then the totals. Skipped rows are listed but not counted. */
export function renderLiveRun(meta: LiveMeta, rows: readonly LiveRow[]): string {
  const ran = rows.filter((r) => r.outcome !== 'skipped');
  const ok = ran.filter(delivered);
  const cost = ran.reduce((s, r) => s + r.costUsd, 0);
  const unknownCostCalls = ran.reduce((s, r) => s + (r.unknownCostCalls ?? 0), 0);
  const ms = ran.reduce((s, r) => s + r.ms, 0);
  const lines = [
    '# Live run',
    '',
    `Run on ${meta.date} at commit \`${meta.commit}\`, model \`${meta.model}\`, with a budget of $${meta.maxCostUsd} and ${meta.maxMinutes} minutes per prompt. The prompts are in [prompts/](prompts/), exactly as received. Each row is what happened; a stop is a result, and no world was edited by hand.`,
    '',
    '| Prompt | Input | Outcome | Engine check and verify | Minutes | USD | Artifacts |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((r) => {
      const outcome = r.detail === '' ? r.outcome : `${r.outcome}: ${r.detail}`;
      const input = r.changed ? `${r.inputKind} + change` : r.inputKind;
      return `| ${cell(r.id)} | ${input} | ${cell(outcome)} | ${r.outcome === 'skipped' ? '-' : checkCell(r.check)} | ${r.outcome === 'skipped' ? '-' : minutes(r.ms)} | ${r.outcome === 'skipped' ? '-' : `${r.costUsd.toFixed(2)}${r.unknownCostCalls ? ' + unknown' : ''}`} | \`${cell(r.dir)}\` |`;
    }),
    '',
    `Delivered ${ok.length} of ${ran.length} prompts that ran, ${rows.length - ran.length} skipped because a world was already there. Total ${minutes(ms)} minutes and $${cost.toFixed(2)} (a client-side estimate).${unknownCostCalls > 0 ? ` This total excludes ${unknownCostCalls} cancelled call(s) with unknown cost.` : ''}`,
    '',
    'A delivered world is in `prod/worlds/gen-<slug>/` with its `plan.yaml` and `REPORT.md`, which lists what was assumed and what was left out. A stopped or invalid run stays in the artifacts folder, outside `prod/worlds`, with its stop report.',
    '',
  ];
  return lines.join('\n');
}
