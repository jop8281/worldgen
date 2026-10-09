import { z } from 'zod';

export const alias = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const value = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const end = z.strictObject({ world: alias, entity: z.string().min(1), where: z.record(z.string(), value), field: z.string().min(1) });
export const linkSchema = z.strictObject({ name: z.string().min(1), from: end, to: end, rule: z.enum(['cites', 'equals']) });
export type Link = z.output<typeof linkSchema>;
export type LinkEnd = Link['from'];
export type LinkResult = { readonly name: string; readonly held: boolean; readonly found: string };
type Row = Readonly<Record<string, unknown>>;

/** An id such as re_0051: a run of letters and "_", which is its prefix, then letters or digits. */
const ID_SHAPE = /^([A-Za-z]+_)[A-Za-z0-9]+$/;
const escaped = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Why the citing row's `text` fails the rule for `value`, as the end of a sentence about that row, or null when it holds. */
const RULES: Readonly<Record<Link['rule'], (text: unknown, value: string, kind: string) => string | null>> = {
  cites: (text, value, kind) => {
    const prefix = ID_SHAPE.exec(value)?.[1];
    if (prefix === undefined) return `cannot cite ${value}, which is not letters and "_" then letters or digits`;
    const shaped = new RegExp(`(?<![A-Za-z0-9_])${escaped(prefix)}[A-Za-z0-9]+(?![A-Za-z0-9_])`, 'g');
    const tokens = typeof text === 'string' ? (text.match(shaped) ?? []) : [];
    if (tokens.length === 0) return `cites no ${kind} id`;
    if (tokens.length > 1) return `cites ${tokens.length} ${kind} ids, not exactly 1`;
    return tokens[0] === value ? null : `cites ${tokens[0]}, not ${value}`;
  },
  equals: (text, value) => (text === value ? null : `does not equal ${value}`),
};

/**
 * Whether `link` holds over the worlds' rows. `from.where` must select exactly one row, whose `from.field` is the link
 * value, a non-empty string or a number. A row that `to.where` selects must hold, in `to.field`, exactly one token shaped
 * like that value and equal to it (`cites`), or the value itself (`equals`). `found` says why in one sentence.
 */
export function linkResult(link: Link, tables: (world: string, entity: string) => readonly Row[]): LinkResult {
  const { from, to } = link;
  const result = (held: boolean, found: string): LinkResult => ({ name: link.name, held, found });
  const select = (e: LinkEnd): Row[] => tables(e.world, e.entity).filter((r) => Object.entries(e.where).every(([k, v]) => (r[k] ?? null) === v));
  const sources = select(from);
  if (sources.length === 0) return result(false, `0 ${from.entity} rows matched where ${JSON.stringify(from.where)}`);
  if (sources.length > 1) return result(false, `${sources.length} ${from.entity} rows matched where ${JSON.stringify(from.where)}, not exactly 1`);
  const raw = sources[0]![from.field];
  if (!((typeof raw === 'string' && raw !== '') || typeof raw === 'number')) {
    return result(false, `1 ${from.entity} row matched, but its ${from.field} is ${raw === undefined ? 'missing' : JSON.stringify(raw)}, not a non-empty string or a number`);
  }
  const linked = String(raw);
  const targets = select(to);
  if (targets.length === 0) return result(false, `1 ${from.entity} row matched; 0 ${to.entity} rows matched where ${JSON.stringify(to.where)}`);
  const misses: string[] = [];
  for (const row of targets) {
    const at = `${to.entity} ${String(row['id'])} ${to.field}`;
    const why = RULES[link.rule](row[to.field], linked, from.entity);
    if (why === null) return result(true, `1 ${from.entity} row matched; ${at} ${link.rule} ${linked}`);
    misses.push(`${at} ${why}`);
  }
  return result(false, misses.join('; '));
}
