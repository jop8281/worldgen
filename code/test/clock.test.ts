import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { check } from '../src/engine/check.ts';
import { emptyWorld } from '../src/engine/format.ts';
import { createVmHost } from '../src/engine/sandbox.ts';
import { MAX_DUE_FIRINGS, MAX_DURATION_MS, Duration, Tick, timeMath, dueJobs, fromIso, parseDuration, parseTick, toIso, type Instant } from '../src/engine/clock.ts';

const start = fromIso('2026-03-02T09:00:00.000Z');
const MIN = 60_000;
const at = (m: number) => (start + m * MIN) as Instant;

describe('parseDuration', () => {
  it('R1 parses each unit', () => {
    assert.equal(parseDuration('30s'), 30000);
    assert.equal(parseDuration('15m'), 900000);
    assert.equal(parseDuration('4h'), 14400000);
    assert.equal(parseDuration('2d'), 172800000);
  });
  it('refuses non-string durations and ticks without coercing them', () => {
    let conversions = 0;
    const object = { toString: () => { conversions++; return '1h'; } };
    const primitive = { [Symbol.toPrimitive]: () => { conversions++; throw new Error('conversion ran'); } };
    for (const value of [['1h'], object, primitive, 3600, null, undefined]) {
      assert.throws(() => Reflect.apply(parseDuration, undefined, [value]), RangeError);
      assert.throws(() => Reflect.apply(parseTick, undefined, [value]), RangeError);
    }
    assert.equal(conversions, 0);
  });

  it('R2 rejects malformed durations', () => {
    assert.throws(() => parseDuration('15' as never), RangeError);
    assert.throws(() => parseDuration('1w' as never), RangeError);
    assert.throws(() => parseDuration('' as never), RangeError);
    assert.throws(() => parseDuration('-5m' as never), RangeError);
  });
});

describe('compound durations (A-117)', () => {
  const SYNTAX = /expected whole numbers with units in the order d, h, m, s, each at most once, such as 15m, 4h or 1d12h/;
  it('sums groups written in the order d, h, m, s', () => {
    assert.equal(parseDuration('1d12h'), 129600000);
    assert.equal(parseDuration('2h30m'), 9000000);
    assert.equal(parseDuration('22d12h'), 1944000000);
    assert.equal(parseDuration('1d2h3m4s'), 93784000);
    assert.equal(parseDuration('0h30m'), 1800000);
    assert.equal(parseDuration('90m'), 5400000);
  });
  it('applies the zero rule to the total, so an all-zero compound is a tick and not a duration', () => {
    assert.equal(parseTick('0d'), 0);
    assert.equal(parseTick('0h0m'), 0);
    assert.throws(() => parseDuration('0d'), RangeError);
    assert.throws(() => parseDuration('0d'), /zero/);
    assert.throws(() => parseDuration('0h0m'), /zero/);
    assert.throws(() => parseDuration('0h0m'), { message: 'Duration "0h0m" is zero; use at least 1s (only meta.clock.tick may be 0s)' });
  });
  it('rejects anything outside the grammar with the accepted form in the message', () => {
    for (const bad of ['', '30m2h', '1h1h', '1d 12h', '1.5h', '1H', 'h', '1d12', '1w', '-1h', '+1h', '1d\n', 's1']) {
      assert.throws(() => parseDuration(bad), RangeError, JSON.stringify(bad));
      assert.throws(() => parseDuration(bad), SYNTAX, JSON.stringify(bad));
      assert.throws(() => parseTick(bad), SYNTAX, JSON.stringify(bad));
    }
    assert.throws(() => parseDuration('1.5h'), {
      message: 'Invalid duration "1.5h": expected whole numbers with units in the order d, h, m, s, each at most once, such as 15m, 4h or 1d12h',
    });
  });
  it('bounds the total by MAX_DURATION_MS, and a huge component is too large rather than NaN', () => {
    assert.equal(MAX_DURATION_MS, 8_386_597_526_400_001);
    assert.equal(parseDuration('97067101d'), 8_386_597_526_400_000);
    assert.equal(parseDuration('97067100d23h59m59s'), 8_386_597_526_399_000);
    assert.throws(() => parseDuration('97067101d1s'), /too large/);
    assert.throws(() => parseTick('97067100d24h1s'), /too large/);
    assert.throws(() => parseDuration('99999999999999999999d'), /too large/);
    assert.throws(() => parseDuration(`${'9'.repeat(400)}d${'9'.repeat(400)}h`), /too large/);
  });
  it('the Duration and Tick schemas follow the same grammar', () => {
    assert.equal(Duration.safeParse('1d12h').success, true);
    assert.equal(Duration.safeParse('30m2h').success, false);
    assert.equal(Duration.safeParse('0h0m').success, false);
    assert.equal(Tick.safeParse('0h0m').success, true);
    assert.equal(Tick.safeParse('1h1h').success, false);
  });
  it('dueJobs fires a compound interval at start plus its total', () => {
    assert.deepEqual(dueJobs({ a: { every: '1d12h' } }, start, start, (start + 259_200_000) as Instant), [
      { job: 'a', at: 1772571600000 },
      { job: 'a', at: 1772701200000 },
    ]);
  });
});

describe('toIso and fromIso', () => {
  it('R3 round-trips exactly', () => {
    assert.equal(toIso(fromIso('2026-03-02T09:00:00.000Z')), '2026-03-02T09:00:00.000Z');
    assert.equal(fromIso('2026-03-02T09:00:00.000Z'), 1772442000000);
  });
  it('R4 always emits millisecond UTC form ending in Z', () => {
    assert.equal(toIso(fromIso('2026-03-02T09:00:00Z')), '2026-03-02T09:00:00.000Z');
    assert.equal(toIso(fromIso('2026-03-02T10:00:00+01:00')), '2026-03-02T09:00:00.000Z');
    assert.equal(toIso(0 as Instant), '1970-01-01T00:00:00.000Z');
  });
  it('R5 fromIso rejects garbage', () => {
    assert.throws(() => fromIso('not a date'), RangeError);
  });
  it('R5b fromIso rejects strings without an explicit zone or in free-form', () => {
    assert.throws(() => fromIso('2026-03-02T09:00:00'), RangeError);
    assert.throws(() => fromIso('2026-03-02'), RangeError);
    assert.throws(() => fromIso('March 2, 2026'), RangeError);
  });
});

describe('dueJobs', () => {
  it('R6 orders by time then name in (from, to]', () => {
    assert.deepEqual(dueJobs({ b: { every: '15m' }, a: { every: '15m' } }, start, start, at(30)), [
      { job: 'a', at: at(15) },
      { job: 'b', at: at(15) },
      { job: 'a', at: at(30) },
      { job: 'b', at: at(30) },
    ]);
  });
  it('R7 returns [] when from equals to', () => {
    assert.deepEqual(dueJobs({ a: { every: '15m' } }, start, start, start), []);
    assert.deepEqual(dueJobs({ a: { every: '15m' } }, start, at(15), at(15)), []);
  });
  it('R8 excludes from and includes to', () => {
    assert.deepEqual(dueJobs({ a: { every: '15m' } }, start, at(15), at(30)), [{ job: 'a', at: at(30) }]);
  });
  it('R9 interleaves jobs with different intervals', () => {
    assert.deepEqual(dueJobs({ slow: { every: '30m' }, fast: { every: '10m' } }, start, start, at(30)), [
      { job: 'fast', at: at(10) },
      { job: 'fast', at: at(20) },
      { job: 'fast', at: at(30) },
      { job: 'slow', at: at(30) },
    ]);
  });
  it('R10 anchors firing times to start, not to from', () => {
    assert.deepEqual(dueJobs({ a: { every: '15m' } }, start, at(7), at(40)), [
      { job: 'a', at: at(15) },
      { job: 'a', at: at(30) },
    ]);
  });
  it('R11 never fires before start plus one interval, and returns [] for to before from', () => {
    assert.deepEqual(dueJobs({ a: { every: '15m' } }, start, at(-60), at(10)), []);
    assert.deepEqual(dueJobs({ a: { every: '15m' } }, start, at(30), at(10)), []);
  });
  it('R12 returns [] for no jobs and rejects a zero interval', () => {
    assert.deepEqual(dueJobs({}, start, start, at(60)), []);
    assert.throws(() => dueJobs({ a: { every: '0s' } }, start, start, at(60)), RangeError);
  });
});

describe('dueJobs bounds', () => {
  it('R14 rejects non-finite or unsafe bounds', () => {
    assert.throws(() => dueJobs({ a: { every: '1s' } }, start, start, Infinity as Instant), RangeError);
    assert.throws(() => dueJobs({ a: { every: '1s' } }, start, NaN as Instant, at(1)), RangeError);
    assert.throws(() => dueJobs({ a: { every: '1s' } }, Infinity as Instant, start, at(1)), RangeError);
  });
  it('R15 rejects a duration too large to be finite', () => {
    assert.throws(() => parseDuration(`${'9'.repeat(400)}s` as never), RangeError);
    assert.throws(() => dueJobs({ a: { every: `${'9'.repeat(400)}d` as never } }, start, start, at(1)), RangeError);
  });
  it('R16 caps firings per call', () => {
    assert.equal(MAX_DUE_FIRINGS, 100000);
    assert.throws(() => dueJobs({ a: { every: '1s' } }, start, start, (start + 100_001 * 1000) as Instant), RangeError);
    assert.equal(dueJobs({ a: { every: '1s' } }, start, start, (start + 100_000 * 1000) as Instant).length, 100000);
  });
});

describe('clock source', () => {
  it('R13 uses no wall clock', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/engine/clock.ts', import.meta.url), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
    assert.equal(/Date\.now|new Date\(\s*\)|performance/.test(src), false);
  });
});

describe('fix-engine-clock', () => {
  it('R17 fromIso rejects impossible calendar values', () => {
    for (const bad of [
      '2026-02-30T00:00:00Z',
      '2026-02-31T00:00:00Z',
      '2026-02-29T00:00:00Z',
      '2026-04-31T00:00:00Z',
      '2026-03-02T24:00:00Z',
      '2026-03-02T23:59:60Z',
      '2026-13-01T00:00:00Z',
      '2026-00-10T00:00:00Z',
      '2026-03-00T00:00:00Z',
      '2026-03-02T09:60:00Z',
      '2026-03-02T09:00:00+24:00',
      '2026-03-02T09:00:00+01:60',
    ]) {
      assert.throws(() => fromIso(bad), RangeError, bad);
    }
    assert.throws(() => fromIso('2026-02-30T00:00:00Z'), /day 30 \(month 2 has 28 days in 2026\)/);
    assert.throws(() => fromIso('2026-03-02T24:00:00Z'), /hour 24/);
  });
  it('R17b fromIso accepts real edge dates', () => {
    assert.equal(toIso(fromIso('2028-02-29T23:59:59Z')), '2028-02-29T23:59:59.000Z');
    assert.equal(toIso(fromIso('2026-12-31T23:59:59.999Z')), '2026-12-31T23:59:59.999Z');
    assert.equal(toIso(fromIso('2000-02-29T00:00:00Z')), '2000-02-29T00:00:00.000Z');
    assert.throws(() => fromIso('1900-02-29T00:00:00Z'), RangeError);
  });
  it('R18 Duration schema rejects zero and parseDuration throws', () => {
    assert.equal(Duration.safeParse('0s').success, false);
    assert.equal(Duration.safeParse('000d').success, false);
    assert.equal(Duration.safeParse('1s').success, true);
    assert.throws(() => parseDuration('0m' as never), /zero/);
  });
  it('R19 durations are bounded to the Date range', () => {
    assert.equal(MAX_DURATION_MS, 8_386_597_526_400_001);
    assert.equal(parseDuration('8386597526400s'), 8_386_597_526_400_000);
    assert.equal(Duration.safeParse('8386597526400s').success, true);
    assert.equal(Duration.safeParse('8386597526401s').success, false);
    assert.throws(() => parseDuration('8386597526401s'), /too large/);
    assert.throws(() => parseDuration('99999999999d' as never), RangeError);
    assert.equal(Duration.safeParse(`${'9'.repeat(400)}d`).success, false);
  });
  it('R19b start + the largest accepted duration stays a valid time, even for the latest start', () => {
    const max = parseDuration('8386597526400s');
    assert.match(toIso((start + max) as Instant), /^\+\d{6}-/);
    const latest = fromIso('9999-12-31T23:59:59.999-23:59');
    assert.equal(Number.isFinite(new Date(latest + max).getTime()), true);
    assert.equal(Number.isFinite(new Date(start + max).getTime()), true);
  });
  it('R20 check reports zero and huge durations in jobs.every, and huge ones in meta.clock.tick', () => {
    const host = createVmHost();
    const base = () => structuredClone(emptyWorld('clk', 'hand')) as Record<string, any>;
    const zeroJob = base();
    zeroJob.jobs = { tidy: { description: 'x', every: '0s', run: 'return;' } };
    const r1 = check(zeroJob, host);
    assert.equal(r1.ok, false);
    if (!r1.ok) {
      assert.deepEqual(r1.issues[0].path, ['jobs', 'tidy', 'every']);
      assert.equal(r1.issues[0].code, 'schema.invalid');
      assert.match(JSON.stringify(r1.issues[0]), /zero; use at least 1s/);
    }
    const badTick = base();
    badTick.meta.clock.tick = '1w';
    const r2 = check(badTick, host);
    assert.equal(r2.ok, false);
    if (!r2.ok) assert.deepEqual(r2.issues[0].path, ['meta', 'clock', 'tick']);
    const hugeTick = base();
    hugeTick.meta.clock.tick = '99999999999d';
    const r3 = check(hugeTick, host);
    assert.equal(r3.ok, false);
    if (!r3.ok) assert.match(JSON.stringify(r3.issues[0]), /too large/);
    const nearCap = base();
    nearCap.meta.clock.tick = '100000000d';
    nearCap.jobs = { t: { description: 'x', every: '100000000d', run: 'return;' } };
    assert.equal(check(nearCap, host).ok, false);
  });
  it('R21 check rejects an impossible meta.clock.start', () => {
    const w = structuredClone(emptyWorld('clk', 'hand')) as Record<string, any>;
    w.meta.clock.start = '2026-02-30T00:00:00Z';
    assert.equal(check(w, createVmHost()).ok, false);
  });
});

describe('engine-clock-explicit: tick may be zero, durations may not (L8)', () => {
  it('R22 Tick accepts zero in any unit and positive durations, and rejects what Duration rejects', () => {
    for (const ok of ['0s', '0m', '000d', '1s', '5m', '8386597526400s']) assert.equal(Tick.safeParse(ok).success, true, ok);
    for (const bad of ['', '0', '1w', '-1s', '1.5s', '8386597526401s', `${'9'.repeat(400)}d`]) {
      assert.equal(Tick.safeParse(bad).success, false, bad);
    }
    assert.match(String(Tick.safeParse('8386597526401s').error), /too large/);
  });
  it('R23 parseTick is parseDuration that also returns 0 for a zero tick', () => {
    assert.equal(parseTick('0s'), 0);
    assert.equal(parseTick('0h'), 0);
    assert.equal(parseTick('1s'), 1000);
    assert.equal(parseTick('5m'), 300000);
    assert.throws(() => parseTick('1w'), RangeError);
    assert.throws(() => parseTick('99999999999d'), /too large/);
    assert.throws(() => parseDuration('0s'), /zero; use at least 1s/);
  });
  // An empty world has no tasks, so since YOS-113 check stops at the tasks layer with only
  // world.too_few_tasks: every layer that reads meta.clock passed.
  it('R24 a new world defaults meta.clock.tick to 0s and check accepts an explicit 0s or 1s', () => {
    const host = createVmHost();
    assert.equal(emptyWorld('clk', 'hand').meta.clock.tick, '0s');
    const onlyTooFewTasks = (r: ReturnType<typeof check>, label: string) => {
      assert.equal(r.ok, false, label);
      if (!r.ok) {
        assert.equal(r.reached, 'tasks', label);
        assert.deepEqual(r.issues.map((i) => i.code), ['world.too_few_tasks'], label);
      }
    };
    for (const tick of ['0s', '0m', '1s']) {
      const w = structuredClone(emptyWorld('clk', 'hand')) as Record<string, any>;
      w.meta.clock.tick = tick;
      onlyTooFewTasks(check(w, host), tick);
    }
    const omitted = structuredClone(emptyWorld('clk', 'hand')) as Record<string, any>;
    delete omitted.meta.clock.tick;
    onlyTooFewTasks(check(omitted, host), 'omitted');
  });
  it('R25 check reports a zero or malformed action duration at its path', () => {
    const host = createVmHost();
    for (const [duration, message] of [['0s', /zero; use at least 1s/], ['4 hours', /expected whole numbers with units in the order d, h, m, s/]] as const) {
      const w = structuredClone(emptyWorld('clk', 'hand')) as Record<string, any>;
      w.actions = { ping: { method: 'POST', path: '/ping', duration, handler: '(ctx) => ({ status: 200, body: null })' } };
      const r = check(w, host);
      assert.equal(r.ok, false, duration);
      if (r.ok) continue;
      assert.deepEqual(r.issues[0].path, ['actions', 'ping', 'duration']);
      assert.equal(r.issues[0].code, 'schema.invalid');
      assert.match(JSON.stringify(r.issues[0]), message);
    }
  });
});

describe('timeMath offsets (A-126)', () => {
  const T = '2026-10-01T00:00:00.000Z';
  it('plus accepts a zero offset and returns the instant unchanged', () => {
    assert.equal(timeMath.plus(T, '0d'), '2026-10-01T00:00:00.000Z');
    assert.equal(timeMath.plus(T, '0s'), '2026-10-01T00:00:00.000Z');
    assert.equal(timeMath.plus(T, '0h0m'), '2026-10-01T00:00:00.000Z');
    assert.equal(timeMath.plus('2026-10-01T05:00:00Z', '0d'), '2026-10-01T05:00:00.000Z');
  });
  it('minus subtracts an unsigned offset, zero included', () => {
    assert.equal(timeMath.minus('2026-10-06T00:00:00.000Z', '5d'), '2026-10-01T00:00:00.000Z');
    assert.equal(timeMath.minus('2026-10-06T00:00:00.000Z', '1d12h'), '2026-10-04T12:00:00.000Z');
    assert.equal(timeMath.minus(T, '0s'), '2026-10-01T00:00:00.000Z');
    assert.equal(timeMath.minus(T, '0d'), '2026-10-01T00:00:00.000Z');
  });
  it('refuses signed, fractional, empty and malformed offsets with the duration message', () => {
    for (const d of ['-1d', '1.5d', '', '1h1d']) {
      assert.throws(() => timeMath.plus(T, d), { name: 'RangeError', message: /^Invalid duration/ });
      assert.throws(() => timeMath.minus(T, d), { name: 'RangeError', message: /^Invalid duration/ });
    }
    assert.throws(() => timeMath.minus(T, '-1d'), { message: 'Invalid duration "-1d": expected whole numbers with units in the order d, h, m, s, each at most once, such as 15m, 4h or 1d12h' });
  });
  it('throws a RangeError when the result is outside the four-digit-year range', () => {
    assert.throws(() => timeMath.minus('0000-01-01T00:00:00.000Z', '1d'), { name: 'RangeError', message: /outside the representable range/ });
    assert.throws(() => timeMath.plus('9999-12-31T23:59:59.999Z', '1s'), { name: 'RangeError', message: /outside the representable range/ });
    assert.equal(timeMath.minus('0000-01-02T00:00:00.000Z', '1d'), '0000-01-01T00:00:00.000Z');
  });
  it('keeps job every strict: 0d is still a zero-interval issue', () => {
    assert.throws(() => parseDuration('0d'), /zero; use at least 1s/);
    assert.equal(Duration.safeParse('0d').success, false);
    assert.equal(Tick.safeParse('0d').success, true);
  });
  it('check still rejects a job every of 0d with its existing issue', () => {
    const w = structuredClone(emptyWorld('clk', 'hand')) as Record<string, any>;
    w.jobs = { tidy: { description: 'x', every: '0d', run: 'return;' } };
    const r = check(w, createVmHost());
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.deepEqual(r.issues[0].path, ['jobs', 'tidy', 'every']);
      assert.equal(r.issues[0].code, 'schema.invalid');
      assert.match(JSON.stringify(r.issues[0]), /zero; use at least 1s/);
    }
  });
});
