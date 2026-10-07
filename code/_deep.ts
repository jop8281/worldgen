import { checkWorld, createRuntime, loadWorld } from '#engine';
const l = await loadWorld('../prod/worlds/gen-bakery-vague'); if (!l.ok) throw 0;
const r = checkWorld(l.value, l.lines); if (!r.ok) throw new Error('check');
const rt = createRuntime(r.world);
const d = 100_000;
const arr = JSON.parse('['.repeat(d) + ']'.repeat(d));
const objs = JSON.parse('{"a":'.repeat(d) + '1' + '}'.repeat(d));
const id = (e: string) => (rt.dump().tables[e] ?? [])[0]?.['id'] as string | undefined;
const writes = [
  ...Object.values(r.world.routes).filter((x) => x.op === 'create' || x.op === 'update').map((x) => ({ m: x.method, p: x.path, e: x.entity, f: Object.keys(r.world.entities[x.entity]!.fields)[0] })),
  ...Object.values(r.world.actions).map((a) => ({ m: a.method, p: a.path, e: null as string | null, f: Object.keys(a.input)[0] })),
];
let total = 0;
for (const w of writes) {
  const path = w.p.replace(/\{[^}]+\}/g, () => (w.e ? id(w.e) : undefined) ?? 'x');
  for (const [label, body] of [['arr', arr], ['objIn', w.f ? { [w.f]: objs } : objs]] as const) {
    const t = performance.now();
    const res = rt.call({ method: w.m, path, query: {}, body });
    const ms = performance.now() - t; total += ms;
    if (ms > 300) console.log(`${w.m} ${w.p} ${label} -> ${res.status} ${ms.toFixed(0)} ms`);
  }
}
console.log('writes', writes.length, 'total ms', total.toFixed(0));
