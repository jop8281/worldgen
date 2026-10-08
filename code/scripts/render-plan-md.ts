/**
 * Writes plan.md beside each world's plan.yaml: renderPlanMd of the plan.yaml parsed with the plan schema, exactly what
 * runWorldGen writes on create and iterate. No model call. It writes nothing else: world.yaml, plan.yaml, REPORT.md,
 * capsule.json and every content id stay as they are. With no arguments it covers every prod/worlds/gen-* world with a
 * plan.yaml. A plan.yaml that does not fit the current schema is listed and left without a plan.md, and the exit is 1.
 *
 *   bun scripts/render-plan-md.ts [<worldDir>...]
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { renderPlanMd } from '../src/worldgen/plan-md.ts';
import { parsePlanYaml } from '../src/worldgen/plan.ts';

const WORLDS = path.resolve(import.meta.dirname, '../../prod/worlds');

function main(argv: readonly string[]): number {
  if (argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write('usage: bun scripts/render-plan-md.ts [<worldDir>...]\n');
    return 0;
  }
  const dirs = argv.length > 0
    ? argv.map((d) => path.resolve(d))
    : readdirSync(WORLDS, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name.startsWith('gen-')).map((e) => path.join(WORLDS, e.name)).sort();
  const refused: string[] = [];
  for (const dir of dirs) {
    const yaml = path.join(dir, 'plan.yaml');
    if (!existsSync(yaml)) continue;
    const plan = parsePlanYaml(readFileSync(yaml, 'utf8'));
    if (plan === null) {
      refused.push(dir);
      continue;
    }
    const md = path.join(dir, 'plan.md');
    const text = renderPlanMd(plan);
    const before = existsSync(md) ? readFileSync(md, 'utf8') : null;
    if (before === text) continue;
    writeFileSync(md, text);
    process.stdout.write(`${before === null ? 'wrote' : 'rewrote'} ${path.relative(process.cwd(), md)}\n`);
  }
  for (const dir of refused) process.stderr.write(`${path.relative(process.cwd(), dir)}/plan.yaml does not fit the current plan schema; no plan.md written\n`);
  return refused.length === 0 ? 0 : 1;
}

process.exitCode = main(process.argv.slice(2));
