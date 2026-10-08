/**
 * Read-only probe for one grader weakness: "do the task correctly, then edit the target row".
 * For every task of every world it replays the reference solution on a fresh runtime, picks a row the
 * solution wrote, makes ONE extra edit through the public update route to a writable field the solution
 * did not write, and grades the final state. hole=yes means the grader still gave 1.
 * Never saves a world. Usage: bun scripts/archive/probe-collateral.ts [worldDir ...] [--json]
 * Default: every directory under ../prod/worlds.
 */
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { checkWorld, gradeDump, loadWorld, type CheckedWorld, type Field, type Value } from '#engine';
import { runtime, type CallRecord } from '../../src/engine/api.ts';
import { clientCtx } from '../../src/engine/tasks.ts';
import { createVmHost } from '../../src/engine/sandbox.ts';

type Verdict = 'yes' | 'no' | 'not_probeable';
type Row = { world: string; task: string; hole: Verdict; evidence: string };
type Edit = { entity: string; id: string; field: string; value: Value };

const args = process.argv.slice(2);
const json = args.includes('--json');
const PROD = path.resolve(import.meta.dirname, '../../../prod/worlds');
const dirs = args.filter((a) => !a.startsWith('--')).map((a) => path.resolve(a));
if (dirs.length === 0) dirs.push(...readdirSync(PROD, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(PROD, d.name)).sort());

const host = createVmHost();

/** Valid-looking replacement values for a field, most likely first. Types are matched by FIELD_TYPES names. */
function candidates(def: Field, cur: Value): Value[] {
  const d = def as unknown as Record<string, unknown>;
  switch (def.type) {
    case 'bool': return [typeof cur === 'boolean' ? !cur : true];
    case 'int': case 'number': case 'money': case 'unix_time': {
      const n = typeof cur === 'number' ? cur : 0;
      return [n + 1, n + 2, n - 1, n + 100].filter((v) => v !== cur);
    }
    case 'enum': return ((d.values as string[]) ?? []).filter((v) => v !== cur);
    case 'datetime': {
      const t = typeof cur === 'string' ? Date.parse(cur) : NaN;
      return Number.isNaN(t) ? ['2030-01-01T00:00:00Z'] : [new Date(t + 60_000).toISOString(), new Date(t + 86_400_000).toISOString()];
    }
    case 'string': case 'text': {
      const s = typeof cur === 'string' ? cur : '';
      return [`${s} (edited)`, `${s}!`, 'x', `${s}x`, 'edited'].filter((v) => v !== cur);
    }
    default: return []; // ref and state need a world-specific id or transition, so they are not probed
  }
}

function probeTask(world: CheckedWorld, taskId: string): { hole: Verdict; evidence: string } {
  const task = world.tasks[taskId];
  if (task === undefined) return { hole: 'not_probeable', evidence: 'task missing' };
  const rt = runtime(world, host);
  const { ctx, failed } = clientCtx(rt);
  const compiled = host.compile('client', task.solution, ['tasks', taskId, 'solution']);
  if (!compiled.ok) return { hole: 'not_probeable', evidence: `solution does not compile: ${compiled.issue.code}` };
  try { compiled.run(ctx); } catch (e) {
    return { hole: 'not_probeable', evidence: `solution failed: ${failed() ?? (e instanceof Error ? e.message : String(e))}` };
  }
  const log: readonly CallRecord[] = rt.log();
  // Rows the solution wrote, updated rows first, with the fields it wrote.
  const wrote = new Map<string, { entity: string; id: string; kind: string; fields: Set<string> }>();
  for (const c of log) {
    if (c.res.status >= 400) continue;
    for (const w of c.writes) {
      if (w.op === 'deleted') continue;
      const k = `${w.entity}/${w.id}`;
      const e = wrote.get(k) ?? { entity: w.entity, id: w.id, kind: w.op, fields: new Set<string>() };
      for (const f of w.fields) e.fields.add(f);
      wrote.set(k, e);
    }
  }
  const targets = [...wrote.values()].sort((a, b) => Number(b.kind === 'updated') - Number(a.kind === 'updated'));
  if (targets.length === 0) return { hole: 'not_probeable', evidence: 'solution writes no row through the API (only deletes or reads)' };

  const base = gradeDump(world, taskId, rt.dump(), rt.journal(), log);
  if (!base.ok) return { hole: 'not_probeable', evidence: `grader fault on the solution: ${base.issue.code}` };
  if (base.score !== 1) return { hole: 'not_probeable', evidence: `solution scored ${base.score} on this replay` };

  const dump0 = rt.dump();
  const tried: string[] = [];
  for (const t of targets) {
    const ent = world.entities[t.entity];
    if (ent === undefined) continue;
    const route = Object.values(world.routes).find((r) => r.op === 'update' && r.entity === t.entity);
    // Without a standard update route, an update-shaped action (PUT or PATCH) whose input names the field is the way in.
    const actions = Object.values(world.actions).filter((a) => a.method === 'PUT' || a.method === 'PATCH');
    if (route === undefined && actions.length === 0) { tried.push(`${t.entity}: no update route or PUT/PATCH action`); continue; }
    const row = dump0.tables[t.entity]?.find((r) => r.id === t.id);
    if (row === undefined) continue;
    for (const [name, def] of Object.entries(ent.fields)) {
      const d = def as unknown as { readonly?: boolean; unique?: boolean };
      if (t.fields.has(name) || d.readonly === true || d.unique === true) continue;
      for (const value of candidates(def, (row[name] ?? null) as Value)) {
        // Probe on a replay so a refused or ineffective edit leaves nothing behind.
        const r2 = runtime(world, host);
        const c2 = clientCtx(r2);
        const comp = host.compile('client', task.solution, ['tasks', taskId, 'solution']);
        if (!comp.ok) continue;
        try { comp.run(c2.ctx); } catch { continue; }
        let res: { status: number } = { status: 404 };
        if (route !== undefined) res = r2.call({ method: route.method, path: route.path.replace('{id}', t.id), query: {}, body: { [name]: value } });
        else {
          const act = actions.find((a) => Object.hasOwn(a.input, name) && (Object.hasOwn(a.input, 'id') || a.path.includes('{id}')));
          if (act === undefined) { tried.push(`${t.entity}.${name}: no PUT/PATCH action takes it`); continue; }
          // The action's own inputs come from the row's current values, so required ones are met; only `name` differs.
          const body: Record<string, Value> = {};
          for (const k of Object.keys(act.input)) if (k in row) body[k] = row[k] as Value;
          body.id = t.id;
          body[name] = value;
          res = r2.call({ method: act.method, path: act.path.replace('{id}', t.id), query: {}, body });
        }
        if (res.status >= 400) { tried.push(`${t.entity}.${name}=${JSON.stringify(value)} refused ${res.status}`); continue; }
        const after = r2.dump().tables[t.entity]?.find((x) => x.id === t.id);
        if (after === undefined || after[name] !== value) { tried.push(`${t.entity}.${name} edit had no effect`); continue; }
        const g = gradeDump(world, taskId, r2.dump(), r2.journal(), r2.log());
        const edit: Edit = { entity: t.entity, id: t.id, field: name, value };
        const what = `after the solution, edit ${edit.entity}.${edit.field}=${JSON.stringify(edit.value)}`;
        if (!g.ok) return { hole: 'not_probeable', evidence: `${what}: grader fault ${g.issue.code}` };
        return g.score >= 1
          ? { hole: 'yes', evidence: `${what} still scored ${g.score}` }
          : { hole: 'no', evidence: `${what} scored ${g.score}` };
      }
    }
    tried.push(`${t.entity}/${t.id}: no other writable non-unique plain field`);
  }
  return { hole: 'not_probeable', evidence: [...new Set(tried)].slice(0, 3).join('; ') || 'no suitable field' };
}

const rows: Row[] = [];
for (const dir of dirs) {
  const name = path.basename(dir);
  const loaded = await loadWorld(dir);
  if (!loaded.ok) { rows.push({ world: name, task: '-', hole: 'not_probeable', evidence: `load failed: ${loaded.error[0].code}` }); continue; }
  const report = checkWorld(loaded.value, loaded.lines);
  if (!report.ok) { rows.push({ world: name, task: '-', hole: 'not_probeable', evidence: `check failed: ${report.issues[0].code}` }); continue; }
  for (const taskId of Object.keys(report.world.tasks)) {
    try { rows.push({ world: name, task: taskId, ...probeTask(report.world, taskId) }); }
    catch (e) { rows.push({ world: name, task: taskId, hole: 'not_probeable', evidence: `probe error: ${e instanceof Error ? e.message : String(e)}` }); }
  }
}
if (json) process.stdout.write(`${JSON.stringify(rows, null, 1)}\n`);
else {
  for (const r of rows) process.stdout.write(`${r.hole.padEnd(13)} ${r.world}/${r.task}  ${r.evidence}\n`);
  const n = (v: Verdict): number => rows.filter((r) => r.hole === v).length;
  process.stdout.write(`\nyes ${n('yes')}  no ${n('no')}  not_probeable ${n('not_probeable')}\n`);
}
