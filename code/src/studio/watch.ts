/**
 * Studio health signals (YOS-237): the traffic counter behind GET /api/health, the parts of /api/health and /api/costs
 * the watcher reads, and the alerts one check raises. Pure: no IO, and time comes in as epoch ms.
 */
import { z } from 'zod';

export const TRAFFIC_WINDOW_SECONDS = 300;
const BUCKETS = 30;
const BUCKET_MS = (TRAFFIC_WINDOW_SECONDS * 1000) / BUCKETS;

type Counts = { readonly requests: number; readonly errors5xx: number };
export type Traffic = Counts & { readonly since: string; readonly windowSeconds: number; readonly window: Counts };

export interface TrafficCounter {
  record(now: number, status: number): void;
  snapshot(now: number): Traffic;
}

/** Answers since `start` and in the last 300 s, kept in 30 buckets of 10 s, so memory stays the same under any load. */
export function trafficCounter(start: number): TrafficCounter {
  const ring = Array.from({ length: BUCKETS }, () => ({ slot: -1, requests: 0, errors5xx: 0 }));
  let requests = 0;
  let errors5xx = 0;
  // A wall clock can step back; a late request counts in the newest bucket instead of wiping a newer one.
  let latest = 0;
  const slotOf = (now: number): number => Math.max(latest, Math.floor(Math.max(0, now - start) / BUCKET_MS));
  return {
    record(now, status) {
      const slot = slotOf(now);
      latest = slot;
      const is5xx = status >= 500 && status <= 599 ? 1 : 0;
      requests += 1;
      errors5xx += is5xx;
      const b = ring[slot % BUCKETS]!;
      if (b.slot !== slot) Object.assign(b, { slot, requests: 0, errors5xx: 0 });
      b.requests += 1;
      b.errors5xx += is5xx;
    },
    snapshot(now) {
      const slot = slotOf(now);
      const live = ring.filter((b) => b.slot > slot - BUCKETS && b.slot <= slot);
      return {
        since: new Date(start).toISOString(),
        requests,
        errors5xx,
        windowSeconds: TRAFFIC_WINDOW_SECONDS,
        window: { requests: live.reduce((n, b) => n + b.requests, 0), errors5xx: live.reduce((n, b) => n + b.errors5xx, 0) },
      };
    },
  };
}

// ---- what the watcher reads ----------------------------------------------------------------------

const count = z.number().int().nonnegative();
const healthSchema = z.object({
  ok: z.literal(true),
  build: z.string(),
  traffic: z.object({
    since: z.string(),
    requests: count,
    errors5xx: count,
    windowSeconds: z.number().positive(),
    window: z.object({ requests: count, errors5xx: count }),
  }),
});
const dailyCapSchema = z.object({
  capUsd: z.number().nonnegative(),
  spentUsd: z.number().nonnegative(),
  reservedUsd: z.number().nonnegative().optional(),
  unpriced: count.optional(),
});
/** `costs --json` writes every cap name, null when its variable is unset; only the daily combined cap is read. */
const costsSchema = z.object({ caps: z.object({ maxDailyUsd: dailyCapSchema.nullable() }) });

/** The WORLDGEN_MAX_DAILY_USD line of `costs --json`, as far as the watcher reads it. */
export type DailyCap = z.infer<typeof dailyCapSchema>;
export type Parsed<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly why: string };

function parseWith<T>(schema: z.ZodType<T>, text: string): Parsed<T> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, why: 'the body is not JSON' };
  }
  const parsed = schema.safeParse(value);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, why: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ') };
}

/** The build and traffic of a GET /api/health body. */
export function parseHealth(text: string): Parsed<{ build: string; traffic: Traffic }> {
  const p = parseWith(healthSchema, text);
  return p.ok ? { ok: true, value: { build: p.value.build, traffic: p.value.traffic } } : p;
}

/** The daily cap line of a GET /api/costs body, null when no daily cap is set. */
export function parseDailyCap(text: string): Parsed<DailyCap | null> {
  const p = parseWith(costsSchema, text);
  return p.ok ? { ok: true, value: p.value.caps.maxDailyUsd } : p;
}

// ---- alerts --------------------------------------------------------------------------------------

export const ALERT_CODES = ['studio.down', 'studio.5xx_rate', 'spend.cap_share', 'spend.unchecked'] as const;
export type AlertCode = (typeof ALERT_CODES)[number];
export type Alert = { readonly code: AlertCode; readonly text: string };

export type CostsObservation = { readonly kind: 'failed'; readonly why: string } | { readonly kind: 'ok'; readonly daily: DailyCap | null };
/** One check. A down studio carries no costs: the watcher reads /api/costs only from a studio that answered health. */
export type Observation =
  | { readonly health: 'down'; readonly attempts: number; readonly why: string }
  | { readonly health: 'up'; readonly build: string; readonly traffic: Traffic; readonly costs: CostsObservation };

export type Limits = { readonly max5xxRate: number; readonly minRequests: number; readonly spendShare: number };
export const DEFAULT_LIMITS: Limits = { max5xxRate: 0.05, minRequests: 20, spendShare: 0.8 };

const DAILY_CAP = 'WORLDGEN_MAX_DAILY_USD';
const usd = (n: number): string => `$${n.toFixed(2)}`;
const percent = (share: number): string => `${Math.round(share * 1000) / 10}%`;
/** Spent plus reserved, as the ledger counts a cap: an open claim already holds its share of the budget. */
const shareOf = (d: DailyCap): number => (d.capUsd > 0 ? (d.spentUsd + (d.reservedUsd ?? 0)) / d.capUsd : 1);
const spentText = (d: DailyCap): string =>
  `${usd(d.spentUsd)}${d.reservedUsd === undefined ? '' : ` plus ${usd(d.reservedUsd)} reserved`} of the ${usd(d.capUsd)} ${DAILY_CAP} cap spent today (${percent(shareOf(d))})`;

function spendAlert(costs: CostsObservation, limits: Limits): Alert | null {
  if (costs.kind === 'failed') return { code: 'spend.unchecked', text: `GET /api/costs failed: ${costs.why}` };
  const d = costs.daily;
  if (d === null) return { code: 'spend.unchecked', text: `no ${DAILY_CAP} cap is set` };
  if (d.unpriced !== undefined && d.unpriced > 0) {
    return { code: 'spend.unchecked', text: `today's ${DAILY_CAP} line has ${d.unpriced} ${d.unpriced === 1 ? 'entry' : 'entries'} of unknown cost; settle them with costs release` };
  }
  // The epsilon keeps 8.40 of 10.50 at 80%, where float division lands just under.
  if (shareOf(d) >= limits.spendShare - 1e-9) return { code: 'spend.cap_share', text: `${spentText(d)}, at or above ${percent(limits.spendShare)}` };
  return null;
}

/** Every problem one check found, in a fixed order: the studio, then spend. Empty means healthy. */
export function studioAlerts(obs: Observation, limits: Limits = DEFAULT_LIMITS): Alert[] {
  if (obs.health === 'down') return [{ code: 'studio.down', text: `GET /api/health failed ${obs.attempts} ${obs.attempts === 1 ? 'time' : 'times'} in a row; last: ${obs.why}` }];
  const alerts: Alert[] = [];
  const { window, windowSeconds } = obs.traffic;
  if (window.requests >= limits.minRequests && window.errors5xx / window.requests > limits.max5xxRate) {
    alerts.push({
      code: 'studio.5xx_rate',
      text: `${window.errors5xx} of ${window.requests} requests in the last ${windowSeconds} s answered 5xx (${percent(window.errors5xx / window.requests)}), above ${percent(limits.max5xxRate)}`,
    });
  }
  const spend = spendAlert(obs.costs, limits);
  if (spend !== null) alerts.push(spend);
  return alerts;
}

/** What a healthy check prints: the build and window traffic, then today's share of the daily cap. */
export function okLines(obs: Observation, limits: Limits = DEFAULT_LIMITS): string[] {
  if (obs.health === 'down') return [];
  const { window, windowSeconds } = obs.traffic;
  const lines = [`OK studio: build ${obs.build}, ${window.requests} ${window.requests === 1 ? 'request' : 'requests'} in the last ${windowSeconds} s, ${window.errors5xx} answered 5xx`];
  if (obs.costs.kind === 'ok' && obs.costs.daily !== null) lines.push(`OK spend: ${spentText(obs.costs.daily)}, alert at ${percent(limits.spendShare)}`);
  return lines;
}
