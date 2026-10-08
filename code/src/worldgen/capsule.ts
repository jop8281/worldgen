/**
 * capsule.json: what one WorldGen run was given, what it wrote and what it spent, built from the
 * run's events and nothing else. No model, no file IO (run.ts writes it).
 */
import { z } from 'zod';
import { worldIdOf, type World } from '#engine';
import { partialModelUsageSchema } from '../costs/ledger.ts';
import { TRANSPORTS } from './config.ts';
import type { RunEvent } from './events.ts';

export const CAPSULE_FILE = 'capsule.json';
const SHA256 = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * What re-rendering this run's report needs besides its own files (A-351), never the input's contents. A description
 * needs nothing more: its digest is input.digest. An OpenAPI spec and CSV tables are paths relative to the repository
 * root, null when the file lies outside it or the path would carry a secret. A change request names the world it started
 * from, saved through saveWorld under the run's directory.
 */
export const inputSourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('description') }),
  z.strictObject({ kind: z.literal('openapi'), path: z.string().min(1).nullable(), only: z.array(z.string()) }),
  z.strictObject({ kind: z.literal('csv'), paths: z.array(z.string().min(1).nullable()).min(1) }),
  z.strictObject({ kind: z.literal('change_request'), before: z.string().min(1) }),
]);
export type InputSource = z.output<typeof inputSourceSchema>;
export const capsuleSchema = z.strictObject({
  capsule: z.literal(1),
  runId: z.string().min(1),
  mode: z.enum(['create', 'iterate']),
  /** digest: contentDigest of the InputDigest on create, of the request on iterate; null when the run stopped before the input was digested. */
  input: z.strictObject({ kind: z.string().min(1), digest: SHA256.nullable(), source: inputSourceSchema.optional() }),
  /** WID of the world this run wrote; null on every stop, iterate included. */
  worldId: z.string().regex(/^wid_[0-9a-f]{64}$/).nullable(),
  model: z.string().min(1),
  transport: z.enum(TRANSPORTS),
  attempts: z.array(z.strictObject({
    step: z.string().min(1), n: z.number().int().min(1), outcome: z.string().min(1),
    ms: z.number().min(0), costUsd: z.number().min(0).nullable(),
    partialModelUsage: partialModelUsageSchema.optional(),
  })),
  cancelledCalls: z.array(z.strictObject({
    step: z.string().min(1), ms: z.number().min(0), costUsd: z.number().min(0).nullable(),
    partialModelUsage: partialModelUsageSchema.optional(),
  })).optional(),
  ms: z.number().min(0),
  costUsd: z.number().min(0),
  unknownCostCalls: z.number().int().nonnegative().optional(),
});
export type RunCapsule = z.output<typeof capsuleSchema>;

/** Throws for events that are not one run's: run_started with a transport, then run_finished. */
export function runCapsule(events: readonly RunEvent[], run: { readonly inputDigest: string | null; readonly world: World | null; readonly source?: InputSource | undefined }): RunCapsule {
  const started = events.find((e): e is Extract<RunEvent, { t: 'run_started' }> => e.t === 'run_started');
  const finished = events.findLast((e): e is Extract<RunEvent, { t: 'run_finished' }> => e.t === 'run_finished');
  if (started === undefined || started.transport === undefined || finished === undefined) {
    throw new Error('runCapsule takes the events of one runWorldGen run: run_started with a transport, then run_finished');
  }
  const cancelledCalls = events.flatMap((e) => e.t === 'call_cancelled' ? [{ step: e.step, ms: e.ms, costUsd: e.costUsd, ...(e.partialModelUsage === undefined ? {} : { partialModelUsage: e.partialModelUsage }) }] : []);
  return {
    capsule: 1, runId: started.runId, mode: started.mode,
    input: { kind: started.input, digest: run.inputDigest, ...(run.source === undefined ? {} : { source: run.source }) },
    worldId: run.world === null ? null : worldIdOf(run.world),
    model: started.model, transport: started.transport,
    attempts: events.flatMap((e) => (e.t === 'attempt' ? [{ step: e.step, n: e.n, outcome: e.outcome.kind, ms: e.ms, costUsd: e.costUsd, ...(e.partialModelUsage === undefined ? {} : { partialModelUsage: e.partialModelUsage }) }] : [])),
    ...(cancelledCalls.length === 0 ? {} : { cancelledCalls }),
    ms: finished.ms, costUsd: finished.costUsd,
    ...(finished.unknownCostCalls === undefined ? {} : { unknownCostCalls: finished.unknownCostCalls }),
  };
}
