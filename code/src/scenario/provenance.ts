import { z } from 'zod';
import { alias, idTokens, rowsWhere, sourceSchema, traceEntryOf, where, type Row, type Tables, type TraceEvidence } from './links.ts';

export const provenanceSchema = z.strictObject({
  name: z.string().min(1),
  rows: z.strictObject({ world: alias, entity: z.string().min(1), where }),
  source: sourceSchema,
  cites: z.strictObject({ field: z.string().min(1), world: alias, entity: z.string().min(1) }).optional(),
});
export type Provenance = z.output<typeof provenanceSchema>;
export type ProvenanceResult = { readonly name: string; readonly held: boolean; readonly found: string };

/**
 * Whether every row `rows` selects was written only by `source` deliveries: each logged call that created or updated the
 * row is placed in the gateway trace by its stamp, as a link places its writes. With `cites`, the row's `cites.field` must
 * also hold exactly one token shaped like a `cites.entity` id (its `idPrefix`, "_", then letters or digits), and that id
 * must be a row of `cites.entity` in `cites.world`. No matched row holds. `found` says why in one sentence.
 */
export function provenanceResult(rule: Provenance, tables: Tables, evidence: TraceEvidence, idPrefix: (world: string, entity: string) => string): ProvenanceResult {
  const { rows, source, cites } = rule;
  const result = (held: boolean, found: string): ProvenanceResult => ({ name: rule.name, held, found });
  const why = (row: Row): string | null => {
    const named = `${rows.entity} ${String(row['id'])}`;
    const writers = evidence.logs(rows.world).filter((c) => c.writes.some((w) => w.entity === rows.entity && w.id === row['id']));
    if (writers.length === 0) return `${named} was written by no logged call, so no delivery made it`;
    for (const call of writers) {
      const at = traceEntryOf(evidence, rows.world, call);
      if (at === null) return `${named} was written by a logged call that no gateway trace entry matches`;
      if (at.source !== source) return `${named} was written at gateway seq ${at.seq} by an ${at.source} delivery, not by an ${source} delivery`;
    }
    if (cites === undefined) return null;
    const tokens = idTokens(row[cites.field], `${idPrefix(cites.world, cites.entity)}_`);
    if (tokens.length === 0) return `${named} ${cites.field} cites no ${cites.entity} id`;
    if (tokens.length > 1) return `${named} ${cites.field} cites ${tokens.length} ${cites.entity} ids, not exactly 1`;
    const exists = tables(cites.world, cites.entity).some((r) => r['id'] === tokens[0]);
    return exists ? null : `${named} ${cites.field} cites ${tokens[0]}, which is no ${cites.entity} in world ${cites.world}`;
  };
  const matched = rowsWhere(tables, rows);
  const misses = matched.map(why).filter((m) => m !== null);
  if (misses.length > 0) return result(false, misses.join('; '));
  const head = `${matched.length} ${rows.entity} row${matched.length === 1 ? '' : 's'} matched where ${JSON.stringify(rows.where)}`;
  if (matched.length === 0) return result(true, `${head}, so none came from another source`);
  const each = matched.length === 1 ? 'it was' : 'each was';
  return result(true, `${head}; ${each} written only by ${source} deliveries${cites === undefined ? '' : ` and cites one ${cites.entity} in world ${cites.world}`}`);
}
