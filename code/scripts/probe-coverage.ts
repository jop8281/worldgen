/**
 * Probe coverage over a directory of worlds (A-393): per world, how many grader checks some verifyTask probe
 * flipped and how many engine mutant slots found something to probe, then the totals and every check no probe
 * flipped. Usage: bun scripts/probe-coverage.ts ../prod/worlds. Prints Markdown; exits 1 if a world fails check.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { checkWorld, loadWorld, type TaskVerdict } from '../src/engine/index.ts';

const USAGE = 'usage: bun scripts/probe-coverage.ts <worlds-dir>\nverifies every world in <worlds-dir> and prints grader checks flipped and mutant slots probed, per world and in total, as Markdown\n';
const root = process.argv[2];
if (root === '--help') {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (root === undefined) {
  process.stderr.write(USAGE);
  process.exit(2);
}

type Row = { world: string; verdicts: TaskVerdict[] };
const rows: Row[] = [];
let failed = false;
for (const name of (await readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name).sort()) {
  const loaded = await loadWorld(path.join(root, name));
  const report = loaded.ok ? checkWorld(loaded.value, loaded.lines) : null;
  if (report === null || !report.ok) {
    process.stderr.write(`${name}: not acceptable, skipped\n`);
    failed = true;
    continue;
  }
  rows.push({ world: name, verdicts: Object.values(report.verdicts) });
}

const count = (vs: readonly TaskVerdict[]) => ({
  tasks: vs.length,
  checks: vs.reduce((n, v) => n + v.checks.length, 0),
  flipped: vs.reduce((n, v) => n + v.checks.filter((c) => c.flippedBy.length > 0).length, 0),
  slots: vs.reduce((n, v) => n + v.collateral.length, 0),
  probed: vs.reduce((n, v) => n + v.collateral.filter((m) => m.call !== null).length, 0),
  unattributed: vs.reduce((n, v) => n + v.unattributedProbes.length, 0),
});
const pct = (a: number, b: number): string => (b === 0 ? '-' : `${((100 * a) / b).toFixed(1)}%`);
const line = (label: string, c: ReturnType<typeof count>): string =>
  `| ${label} | ${c.tasks} | ${c.flipped}/${c.checks} (${pct(c.flipped, c.checks)}) | ${c.probed}/${c.slots} (${pct(c.probed, c.slots)}) | ${c.unattributed} |`;

const all = rows.flatMap((r) => r.verdicts);
// Every strict prefix is graded on a verified task, since verify stops at the first one that scores 1.
const runs = {
  decoys: all.reduce((n, v) => n + v.decoys.length, 0),
  prefixes: all.reduce((n, v) => n + Math.max(v.solutionWrites - 1, 0), 0),
  mutants: all.reduce((n, v) => n + v.collateral.filter((m) => m.call !== null).length, 0),
};
const fullMarks = all.reduce((n, v) => n + v.collateral.filter((m) => m.score === 1).length + v.decoys.filter((d) => d.score === 1).length, 0);
const out = [
  '| World | Tasks | Grader checks flipped | Mutant slots probed | Unattributed probes |',
  '|---|--:|--:|--:|--:|',
  ...rows.map((r) => line(r.world, count(r.verdicts))),
  line('**Total**', count(all)),
  '',
  `Probe runs graded: ${runs.decoys + runs.prefixes + runs.mutants} (${runs.decoys} decoys, ${runs.prefixes} prefixes, ${runs.mutants} mutants). Full marks among them: ${fullMarks}; verify allows one only for a mutant inside its task's declared \`allows\`.`,
  '',
  '| Probe | Checks it flipped |',
  '|---|--:|',
];
const byProbe = new Map<string, number>();
for (const v of all) for (const c of v.checks) for (const probe of new Set(c.flippedBy.map((p) => p.replace(/ \d+$/, '')))) byProbe.set(probe, (byProbe.get(probe) ?? 0) + 1);
out.push(...[...byProbe].sort((a, b) => b[1] - a[1]).map(([probe, n]) => `| ${probe} | ${n} |`));
out.push('', 'Checks no probe flipped:', '');
for (const r of rows) for (const v of r.verdicts) for (const c of v.checks) if (c.flippedBy.length === 0) out.push(`- ${r.world} ${v.taskId}: ${c.check}`);
process.stdout.write(`${out.join('\n')}\n`);
process.exit(failed ? 1 : 0);
