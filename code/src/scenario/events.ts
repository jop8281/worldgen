import type { EventFault, ScenarioEvent } from './manifest.ts';

export type JsonRequest = { readonly world: string; readonly method: string; readonly path: string; readonly body?: unknown };
type Release<R> = { readonly send: readonly R[]; readonly hold: R | undefined };

/**
 * Per event fault, what a firing sends given its own request and the one the rule held. `out_of_order` holds a request
 * until the rule fires again, then sends the newer one first; the gateway flushes any still held before a final grade.
 */
export const EVENT_DELIVERY: Readonly<Record<EventFault | 'none', <R>(now: R, held: R | undefined) => Release<R>>> = {
  none: (now) => ({ send: [now], hold: undefined }),
  duplicate: (now) => ({ send: [now, now], hold: undefined }),
  out_of_order: (now, held) => (held === undefined ? { send: [], hold: now } : { send: [now, held], hold: undefined }),
};

const TEMPLATE = /\$\{([^}]*)\}/g;
const FIELD = /^response\.([A-Za-z_][A-Za-z0-9_]*)$/;

const mapStrings = (v: unknown, f: (s: string) => string): unknown => {
  if (typeof v === 'string') return f(v);
  if (Array.isArray(v)) return v.map((x) => mapStrings(x, f));
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, mapStrings(x, f)]));
  return v;
};

/** Each `${...}` in `deliver.path` and the strings of `deliver.body` that is not `${response.<field>}`. */
export function templateErrors(deliver: ScenarioEvent['deliver']): string[] {
  const bad: string[] = [];
  const scan = (s: string): string => {
    for (const [whole, inner] of s.matchAll(TEMPLATE)) if (!FIELD.test(inner ?? '')) bad.push(whole);
    return s;
  };
  scan(deliver.path);
  mapStrings(deliver.body, scan);
  return bad;
}

class Unfilled extends Error {}

/**
 * `deliver` with each `${response.<field>}` filled from `response`, the triggering response's parsed JSON body: a
 * top-level string, number or boolean field, URL-encoded in the path. Otherwise the reason, in one sentence.
 */
export function filled(deliver: ScenarioEvent['deliver'], response: unknown): { ok: true; value: JsonRequest } | { ok: false; reason: string } {
  const fields = response !== null && typeof response === 'object' && !Array.isArray(response) ? (response as Record<string, unknown>) : null;
  const fill = (encode: (s: string) => string) => (s: string): string =>
    s.replace(TEMPLATE, (whole: string, inner: string) => {
      const name = FIELD.exec(inner)?.[1];
      if (name === undefined) throw new Unfilled(`${whole} is not \${response.<field>}`);
      if (fields === null) throw new Unfilled(`${whole}: the triggering response is not a JSON object`);
      if (!Object.hasOwn(fields, name)) throw new Unfilled(`${whole}: the triggering response has no top-level field "${name}"`);
      const v = fields[name];
      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') throw new Unfilled(`${whole}: the triggering response's ${name} is not a string, number or boolean`);
      return encode(String(v));
    });
  try {
    return { ok: true, value: { world: deliver.world, method: deliver.method, path: fill(encodeURIComponent)(deliver.path), body: mapStrings(deliver.body, fill((s) => s)) } };
  } catch (e) {
    if (e instanceof Unfilled) return { ok: false, reason: e.message };
    throw e;
  }
}
