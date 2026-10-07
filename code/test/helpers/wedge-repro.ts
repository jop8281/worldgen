/**
 * Run as a child process by test/sandbox-wedge.test.ts. An outer snippet calls a ctx member that
 * runs a nested snippet returning a large array, and the host stalls just long enough that the
 * outer run's wall-clock guard expires while the worker is still serving the nested run. It
 * prints one line per case and `done` at the end. Before the lane fix it stops printing: the
 * host blocks in readSync on a reply the worker will never send.
 */
import { createVmHost } from '../../src/engine/sandbox.ts';

const guard = 200;
const host = createVmHost({ ctxCallsPerRun: 20_000, guardMs: guard, maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16 });
const compile = (source: string): ((ctx: unknown) => unknown) => {
  const r = host.compile('handler', source, ['actions', 'repro', 'handler']);
  if (!r.ok) throw new Error(`compile failed: ${source}`);
  return r.run as (ctx: unknown) => unknown;
};
const big = compile('(ctx) => { const out = []; for (let i = 0; i < 30000; i++) out.push("row-" + i + "-xxxxxxxxxxxxxxxx"); return out; }');
const outer = compile('(ctx) => ctx.api().length');
const stall = (ms: number): void => {
  const end = Date.now() + ms;
  while (Date.now() < end);
};

for (const hostMs of [guard - 10, guard, guard + 20, guard + 60]) {
  for (let rep = 0; rep < 2; rep++) {
    let outcome: string;
    try {
      outcome = `ok ${String(outer({ api: () => (stall(hostMs), big({})) }))}`;
    } catch (e) {
      outcome = `threw ${(e as { issue?: { code?: string } }).issue?.code ?? 'error'}`;
    }
    console.log(`host=${hostMs} rep=${rep} ${outcome}`);
  }
}
console.log('done');
