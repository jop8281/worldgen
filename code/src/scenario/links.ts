import { z } from 'zod';

export const alias = z.string().regex(/^[a-z][a-z0-9-]{0,31}$/);
const value = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const end = z.strictObject({ world: alias, entity: z.string().min(1), where: z.record(z.string(), value), field: z.string().min(1) });
export const linkSchema = z.strictObject({ name: z.string().min(1), from: end, to: end, rule: z.enum(['contains', 'equals']) });
export type Link = z.output<typeof linkSchema>;
export type LinkEnd = Link['from'];
export type LinkResult = { readonly name: string; readonly held: boolean; readonly found: string };
type Row = Readonly<Record<string, unknown>>;

const WORD = '[A-Za-z0-9_]';
const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const RULES: Readonly<Record<Link['rule'], (text: string, value: string) => boolean>> = {
  contains: (text, value) => new RegExp(`(?<!${WORD})${escaped(value)}(?!${WORD})`).test(text),
  equals: (text, value) => text === value,
};

/**
 * Whether `link` holds over the worlds' rows. `from.where` must select exactly one row, whose `from.field` is the link
 * value, a non-empty string or a number. `to.where` must select a row whose `to.field` is a string that contains that
 * value as a whole token, or equals it, by `rule`. `found` says why in one sentence.
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
  const textOf = (r: Row): string | null => {
    const text = r[to.field];
    return typeof text === 'string' ? text : null;
  };
  const hit = targets.find((r) => {
    const text = textOf(r);
    return text !== null && RULES[link.rule](text, linked);
  });
  if (hit !== undefined) return result(true, `1 ${from.entity} row matched; ${to.entity} ${String(hit['id'])} ${to.field} ${link.rule} ${linked}`);
  if (link.rule === 'contains') {
    for (const r of targets) {
      const token = textOf(r)?.match(new RegExp(`${WORD}*${escaped(linked)}${WORD}*`))?.[0];
      if (token !== undefined) return result(false, `1 ${from.entity} row matched; ${to.entity} ${String(r['id'])} ${to.field} has ${linked} only inside ${token}`);
    }
  }
  return result(false, `1 ${from.entity} row matched; no ${to.entity} ${to.field} ${link.rule} ${linked}`);
}
