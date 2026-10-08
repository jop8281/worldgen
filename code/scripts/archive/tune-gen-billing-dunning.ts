/**
 * Cuts host round trips in the two hourly gen-billing-dunning jobs without changing what they do,
 * then saves through checkWorld and saveWorld. Every ctx call is an IPC round trip to the snippet
 * process, and the tests advance the clock about 2,600 hours, so per-row ctx.time calls dominated check.
 * - "is this instant due" compares canonical ISO strings in the snippet and calls
 *   ctx.time.minutesBetween only for a non-canonical value, so the result is unchanged.
 * - billing_cycle scans invoices for the next number only when a renewal is due.
 * Rerunning is safe: each rewrite applies only to the original text.
 * Usage: bun scripts/archive/tune-gen-billing-dunning.ts [worldDir]
 */
import path from 'node:path';
import { checkWorld, loadWorld, saveWorld } from '#engine';

const DIR = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '../../../prod/worlds/gen-billing-dunning'));

const BEFORE = `const before = (a, b) => (/^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$/.test(a) && /^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$/.test(b)) ? a > b : ctx.time.minutesBetween(a, b) < 0;`;

const rewrites: Record<string, [string, string][]> = {
  billing_cycle: [
    [
      `let seq = 0; for (const i of ctx.db.list('invoice')) { const n = parseInt(String(i.number).replace(/[^0-9]/g, ''), 10); if (n > seq) seq = n; } `,
      `${BEFORE} let seq = -1; const nextSeq = () => { if (seq < 0) { seq = 0; for (const i of ctx.db.list('invoice')) { const n = parseInt(String(i.number).replace(/[^0-9]/g, ''), 10); if (n > seq) seq = n; } } return seq + 1; }; `,
    ],
    [`if (ctx.time.minutesBetween(sub.current_period_end, now) < 0) continue;`, `if (before(sub.current_period_end, now)) continue;`],
    [`seq += 1; ctx.db.update('subscription'`, `seq = nextSeq(); ctx.db.update('subscription'`],
  ],
  dunning_retry: [
    [`const FAIL = `, `${BEFORE} const FAIL = `],
    [`if (ctx.time.minutesBetween(inv.next_retry_at, now) < 0) continue;`, `if (before(inv.next_retry_at, now)) continue;`],
  ],
};

const loaded = await loadWorld(DIR);
if (!loaded.ok) {
  for (const i of loaded.error) process.stderr.write(`${i.code} ${i.path.join('.')}: ${i.found}\n`);
  process.exit(1);
}
const world = loaded.value as { jobs: Record<string, { run: string }> };
for (const [id, pairs] of Object.entries(rewrites)) {
  const job = world.jobs[id];
  if (job === undefined) throw new Error(`job ${id} not found in ${DIR}`);
  if (job.run.includes('const before = ')) continue;
  for (const [from, to] of pairs) {
    if (job.run.split(from).length !== 2) throw new Error(`job ${id}: expected exactly one match for ${JSON.stringify(from)}`);
    job.run = job.run.replace(from, () => to);
  }
}

const report = checkWorld(world);
for (const w of report.warnings) process.stderr.write(`warning ${w.code} ${w.path.join('.')}: ${w.found}\n`);
if (!report.ok) {
  for (const i of report.issues) process.stderr.write(`${i.code} ${i.path.join('.')}: expected ${i.expected}, found ${i.found}. ${i.hint}\n`);
  process.exit(1);
}
await saveWorld(DIR, report.world);
process.stderr.write(`wrote ${DIR}/world.yaml\n`);
