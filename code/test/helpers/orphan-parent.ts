import { createVmHost } from '../../src/engine/sandbox.ts';
import type { JobCtx } from '../../src/engine/ctx.ts';

const mode = process.argv[2];
const host = createVmHost();
const ctx = { db: { get: () => undefined, list: () => [], create: () => undefined, update: () => undefined, delete: () => undefined }, now: () => '2026-01-01T00:00:00.000Z', time: { plus: (t: string) => t, minutesBetween: () => 0 } } as unknown as JobCtx;
const path = ['jobs', 'x', 'run'] as never;
if (mode === 'idle') {
  const c = host.compile('job', '(ctx) => 1', path);
  if (c.ok) c.run(ctx);
  console.log('ready');
  setInterval(() => {}, 1000);
} else {
  const c = host.compile('job', '(ctx) => { console.log; for (;;) {} }', path);
  console.log('ready');
  if (c.ok) c.run(ctx);
}
