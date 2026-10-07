/**
 * Engine time. The only core module allowed to construct a Date, and only from an Instant.
 *
 * Invariants:
 * - Time starts at `meta.clock.start` and is explicit (design law L8): it moves by explicit
 *   advances (`/_world/clock`, `Runtime.advance`), by an action's declared `duration` after the
 *   action commits, and by `meta.clock.tick` per committed call, which is 0s unless a world opts
 *   in. Failed calls do not move it.
 * - Due jobs fire in (time, job name) order, each in its own transaction.
 */
import { z } from 'zod';
import type { TimeMath } from './ctx.ts';

/** Engine milliseconds since the Unix epoch. Never read from the wall clock. */
export type Instant = number & { readonly __brand: 'Instant' };
/** ISO 8601 UTC string, the form snippets see. */
export type Iso = string;

/**
 * Latest instant fromIso can return: 9999-12-31T23:59:59.999Z plus two days of slack for a
 * -HH:MM offset (the four-digit year in the ISO pattern is the only bound on a start).
 */
export const MAX_START_MS = Date.UTC(9999, 11, 31, 23, 59, 59, 999) + 2 * 86_400_000;
/**
 * Largest duration, in ms, that can be added to any valid start and still be a Date. A Date
 * holds +-8.64e15 ms in absolute terms, so the cap leaves room for the latest start.
 */
export const MAX_DURATION_MS = 8.64e15 - MAX_START_MS;

/**
 * Latest engine time: the end of the Date range. Time never passes it. runtime.advance refuses
 * a move past it before any job fires, and a call's tick that would pass it leaves the clock put.
 */
export const MAX_INSTANT = 8.64e15;

/** Whole-number groups in the order d, h, m, s, each at most once, such as 15m or 1d12h. */
const DURATION = /^(?=\d)(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/;
const GROUP_MS = [86_400_000, 3_600_000, 60_000, 1000] as const;

/**
 * The milliseconds in `d`, or why it is not a usable duration. Shared by the schemas and parsers.
 * Only a tick may be zero (`allowZero`); every other duration totals at least 1s.
 */
function measure(d: string, allowZero: boolean): { ms: number } | { problem: string } {
  if (typeof d !== 'string') return { problem: 'Invalid duration: expected a string such as 15m' };
  const m = DURATION.exec(d);
  if (!m) {
    return { problem: `Invalid duration "${d}": expected whole numbers with units in the order d, h, m, s, each at most once, such as 15m, 4h or 1d12h` };
  }
  const ms = GROUP_MS.reduce((sum, unit, i) => sum + Number(m[i + 1] ?? 0) * unit, 0);
  if (ms === 0 && !allowZero) return { problem: `Duration "${d}" is zero; use at least 1s (only meta.clock.tick may be 0s)` };
  if (!Number.isFinite(ms) || ms > MAX_DURATION_MS) {
    return { problem: `Duration "${d}" is too large; the most is ${MAX_DURATION_MS} ms (about 97 million days)` };
  }
  return { ms };
}

const refine = (allowZero: boolean) => (d: string, ctx: z.RefinementCtx) => {
  const r = measure(d, allowZero);
  if ('problem' in r) ctx.addIssue({ code: 'custom', message: r.problem });
};

export const Duration = z
  .string()
  .superRefine(refine(false))
  .describe('Positive duration such as 30s, 15m, 4h, 2d or 1d12h (units in the order d, h, m, s), at most MAX_DURATION_MS (about 8.39e15 ms)');
export type Duration = z.output<typeof Duration>;

/** A per-call tick: a Duration that may also be zero, such as 0s (no implicit drift) or 1s. */
export const Tick = z
  .string()
  .superRefine(refine(true))
  .describe('Duration such as 0s, 1s, 5m or 1h30m: zero, or positive and at most MAX_DURATION_MS');
export type Tick = z.output<typeof Tick>;

function durationMs(d: string, allowZero: boolean): number {
  const r = measure(d, allowZero);
  if ('problem' in r) throw new RangeError(r.problem);
  return r.ms;
}
/** Milliseconds in a positive duration within the Date range. Throws RangeError otherwise. */
export function parseDuration(d: Duration): number {
  return durationMs(d, false);
}
/** Milliseconds in a tick: like parseDuration, but 0s is 0. Throws RangeError otherwise. */
export function parseTick(d: Tick): number {
  return durationMs(d, true);
}
export function toIso(t: Instant): Iso {
  return new Date(t).toISOString(); // deterministic because t is engine time
}
// Explicit Z or +-HH:MM offset required, so the result never depends on the host timezone.
const ISO_WITH_ZONE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const daysIn = (y: number, mo: number): number =>
  mo === 2 ? (y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28) : [4, 6, 9, 11].includes(mo) ? 30 : 31;
export function fromIso(iso: Iso): Instant {
  const m = ISO_WITH_ZONE.exec(iso);
  if (!m) {
    throw new RangeError(`Invalid ISO 8601 time "${iso}": expected YYYY-MM-DDTHH:mm:ss with Z or +-HH:MM offset`);
  }
  const [y, mo, d, h, mi, sec, oh, om] = m.slice(1).map((x) => (x === undefined ? 0 : Number(x))) as [
    number, number, number, number, number, number, number, number,
  ];
  // new Date() rolls Feb 30 over to Mar 2 and 24:00 to the next day, so check every field first.
  const bad =
    mo < 1 || mo > 12 ? `month ${mo}`
    : d < 1 || d > daysIn(y, mo) ? `day ${d} (month ${mo} has ${daysIn(y, mo)} days in ${y})`
    : h > 23 ? `hour ${h}`
    : mi > 59 ? `minute ${mi}`
    : sec > 59 ? `second ${sec}`
    : oh > 23 ? `offset hour ${oh}`
    : om > 59 ? `offset minute ${om}`
    : null;
  if (bad) throw new RangeError(`Invalid ISO 8601 time "${iso}": impossible ${bad}`);
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) throw new RangeError(`Invalid ISO 8601 time "${iso}"`);
  return t as Instant;
}
/** Most firings one dueJobs call may return; larger windows throw RangeError. */
export const MAX_DUE_FIRINGS = 100_000;
/**
 * Jobs due in (from, to], sorted by time, then by job name.
 * A job fires at start + k * every for k >= 1. Pure: reads no clock.
 */
export function dueJobs(
  jobs: Readonly<Record<string, { every: Duration }>>,
  start: Instant,
  from: Instant,
  to: Instant,
): readonly { job: string; at: Instant }[] {
  const out: { job: string; at: Instant }[] = [];
  for (const [name, v] of [['start', start], ['from', from], ['to', to]] as const) {
    if (!Number.isSafeInteger(v)) throw new RangeError(`dueJobs ${name} must be a safe integer, got ${v}`);
  }
  if (to <= from) return out;
  let count = 0;
  for (const job of Object.keys(jobs)) {
    const step = parseDuration(jobs[job]!.every);
    if (step <= 0) throw new RangeError(`Job "${job}" has a zero interval; use at least 1s`);
    const after = Math.max(from, start);
    if (to > start) {
      count += Math.floor((to - start) / step) - Math.floor((after - start) / step);
      if (count > MAX_DUE_FIRINGS) {
        throw new RangeError(`dueJobs window yields more than ${MAX_DUE_FIRINGS} firings; advance in smaller steps`);
      }
    }
    for (let at = start + (Math.floor((after - start) / step) + 1) * step; at <= to; at += step) {
      out.push({ job, at: at as Instant });
    }
  }
  // Code-unit order, not localeCompare, so the order cannot vary by host locale.
  return out.sort((x, y) => x.at - y.at || (x.job < y.job ? -1 : x.job > y.job ? 1 : 0));
}

/** First and last ms whose ISO string has a four-digit year, the only form fromIso reads back. */
const MIN_ISO_MS = -62_167_219_200_000;
const MAX_ISO_MS = 253_402_300_799_999;

function shifted(t: Iso, deltaMs: number): Iso {
  const ms = fromIso(t) + deltaMs;
  if (ms < MIN_ISO_MS || ms > MAX_ISO_MS) {
    throw new RangeError(`Time "${t}" ${deltaMs < 0 ? 'minus' : 'plus'} ${Math.abs(deltaMs)} ms is outside the representable range 0000-01-01 to 9999-12-31`);
  }
  return toIso(ms as Instant);
}

/** Pure date math on ISO strings, shared by every snippet ctx that exposes `time`. Offsets use the duration grammar and may be zero. */
export const timeMath: TimeMath = {
  plus: (t, d) => shifted(t, parseTick(d)),
  minus: (t, d) => shifted(t, -parseTick(d)),
  minutesBetween: (a, b) => (fromIso(b) - fromIso(a)) / 60_000,
};
