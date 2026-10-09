import { z } from 'zod';
import type { CallWrite } from '#engine';

export const alias = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
export const where = z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]));
const end = z.strictObject({ world: alias, entity: z.string().min(1), where, field: z.string().min(1) });
export const linkSchema = z.strictObject({ name: z.string().min(1), from: end, to: end, rule: z.enum(['cites', 'equals']) });
export type Link = z.output<typeof linkSchema>;
export type LinkEnd = Link['from'];
export type LinkResult = { readonly name: string; readonly held: boolean; readonly found: string };
export type Row = Readonly<Record<string, unknown>>;
export type Tables = (world: string, entity: string) => readonly Row[];

/** The header the gateway stamps on every delivery with its trace seq, so a world's call log places each call in the trace. */
export const SEQ_HEADER = 'x-scenario-seq';
export const sourceSchema = z.enum(['agent', 'operator', 'event']);
export type Source = z.output<typeof sourceSchema>;
/** What a gate reads of a gateway trace entry and of a world's call log record (GET /_world/log). */
type TraceEntry = { readonly seq: number; readonly world: string; readonly method: string; readonly path: string; readonly status: number; readonly source: Source };
export type LoggedCall = {
  readonly req: { readonly method: string; readonly path: string; readonly headers?: Readonly<Record<string, string>> };
  readonly res: { readonly status: number };
  readonly writes: readonly CallWrite[];
};
/** The gateway's trace and each world's call log, whose calls carry the SEQ_HEADER stamp of their delivery. */
export type TraceEvidence = { readonly trace: readonly TraceEntry[]; readonly logs: (world: string) => readonly LoggedCall[] };

/** An id such as re_0051: a run of letters and "_", which is its prefix, then letters or digits. */
const ID_SHAPE = /^([A-Za-z]+_)[A-Za-z0-9]+$/;
const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The tokens of `text` that start with `prefix` and go on with letters or digits, with no letter, digit or "_" on either side. */
export const idTokens = (text: unknown, prefix: string): string[] =>
  typeof text === 'string' ? (text.match(new RegExp(`(?<![A-Za-z0-9_])${escaped(prefix)}[A-Za-z0-9]+(?![A-Za-z0-9_])`, 'g')) ?? []) : [];

/** The rows of `world`'s `entity` whose fields equal every value in `where`, a missing field counting as null. */
export const rowsWhere = (tables: Tables, at: { world: string; entity: string; where: Readonly<Record<string, unknown>> }): Row[] =>
  tables(at.world, at.entity).filter((r) => Object.entries(at.where).every(([k, v]) => (r[k] ?? null) === v));

/** Why the citing row's `text` fails the rule for `value`, as the end of a sentence about that row, or null when it holds. */
const RULES: Readonly<Record<Link['rule'], (text: unknown, value: string, kind: string) => string | null>> = {
  cites: (text, value, kind) => {
    const prefix = ID_SHAPE.exec(value)?.[1];
    if (prefix === undefined) return `cannot cite ${value}, which is not letters and "_" then letters or digits`;
    const tokens = idTokens(text, prefix);
    if (tokens.length === 0) return `cites no ${kind} id`;
    if (tokens.length > 1) return `cites ${tokens.length} ${kind} ids, not exactly 1`;
    return tokens[0] === value ? null : `cites ${tokens[0]}, not ${value}`;
  },
  equals: (text, value) => (text === value ? null : `does not equal ${value}`),
};

/** The trace entry `world`'s logged `call` carries in its SEQ_HEADER stamp, when that entry is the same call: world, method, path and status. */
export function traceEntryOf(evidence: TraceEvidence, world: string, call: LoggedCall): TraceEntry | null {
  const at = evidence.trace.find((t) => t.seq === Number(call.req.headers?.[SEQ_HEADER]));
  const same = at !== undefined && at.world === world && at.method === call.req.method && at.path === call.req.path && at.status === call.res.status;
  return same ? at : null;
}

function traceEntryOfLastWrite(evidence: TraceEvidence, world: string, wrote: (w: CallWrite) => boolean): TraceEntry | null {
  const call = evidence.logs(world).findLast((c) => c.writes.some(wrote));
  return call === undefined ? null : traceEntryOf(evidence, world, call);
}

/**
 * Whether `link` holds over the worlds' rows. `from.where` must select exactly one row, whose `from.field` is the link
 * value, a non-empty string or a number. A row that `to.where` selects must hold, in `to.field`, exactly one token shaped
 * like that value and equal to it (`cites`), or the value itself (`equals`), and the call that wrote it must be the agent's
 * and come later in the gateway trace than the call that created the `from` row, which any delivery may have made. `found`
 * says why in one sentence.
 */
export function linkResult(link: Link, tables: Tables, evidence: TraceEvidence): LinkResult {
  const { from, to } = link;
  const result = (held: boolean, found: string): LinkResult => ({ name: link.name, held, found });
  const sources = rowsWhere(tables, from);
  if (sources.length === 0) return result(false, `0 ${from.entity} rows matched where ${JSON.stringify(from.where)}`);
  if (sources.length > 1) return result(false, `${sources.length} ${from.entity} rows matched where ${JSON.stringify(from.where)}, not exactly 1`);
  const origin = sources[0]!;
  const raw = origin[from.field];
  if (!((typeof raw === 'string' && raw !== '') || typeof raw === 'number')) {
    return result(false, `1 ${from.entity} row matched, but its ${from.field} is ${raw === undefined ? 'missing' : JSON.stringify(raw)}, not a non-empty string or a number`);
  }
  const linked = String(raw);
  const source = `${from.entity} ${String(origin['id'])}`;
  const created = traceEntryOfLastWrite(evidence, from.world, (w) => w.entity === from.entity && w.id === origin['id'] && w.op === 'created');
  const targets = rowsWhere(tables, to);
  if (targets.length === 0) return result(false, `1 ${from.entity} row matched; 0 ${to.entity} rows matched where ${JSON.stringify(to.where)}`);
  const misses: string[] = [];
  for (const row of targets) {
    const target = `${to.entity} ${String(row['id'])}`;
    const why = RULES[link.rule](row[to.field], linked, from.entity);
    if (why !== null) {
      misses.push(`${target} ${to.field} ${why}`);
      continue;
    }
    const wrote = traceEntryOfLastWrite(evidence, to.world, (w) => w.entity === to.entity && w.id === row['id'] && (w.op === 'created' || w.fields.includes(to.field)));
    if (created === null) misses.push(`${source} was created by no call in the gateway trace`);
    else if (wrote === null) misses.push(`${target} ${to.field} was written by no call in the gateway trace`);
    else if (wrote.source !== 'agent') misses.push(`${target} ${to.field} was written at gateway seq ${wrote.seq} by an ${wrote.source} delivery, not by the agent`);
    else if (wrote.seq === created.seq) misses.push(`${target} was written at gateway seq ${wrote.seq}, in the call that created ${source}`);
    else if (wrote.seq < created.seq) misses.push(`${target} was written at gateway seq ${wrote.seq}, before ${source} was created at seq ${created.seq}`);
    else return result(true, `1 ${from.entity} row matched; ${target} ${to.field} ${link.rule} ${linked}, written at gateway seq ${wrote.seq} after ${source} was created at seq ${created.seq}`);
  }
  return result(false, misses.join('; '));
}
