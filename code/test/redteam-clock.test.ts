/**
 * Red-team: engine time and jobs (G-25 to G-30, plus G-08, G-10, G-19 and G-43 where the
 * clock is involved). Every expected timestamp, job order and score is a literal derived by
 * hand from baseWorld(): clock start 2026-01-05T09:00:00.000Z, tick 1s, jobs a (1h),
 * a_late (30m) and b (1h), each of which creates one job_run row { job, at: ctx.now() }.
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { AssertionError } from 'node:assert';
import { checkWorld, createRuntime, type ApiRequest, type CheckedWorld, type Runtime, type StateDump, type World } from '#engine';
import { cap, failWithRepro, freshRuntime, opts, probeCli, rng, seeds, serveWorld, type Rng, type Server } from './redteam/harness.ts';
import { FACTS, TASK_IDS, baseWorld } from './redteam/world.ts';

await probeCli();

// ---------------------------------------------------------------------------------------
// File-local helpers

type Method = ApiRequest['method'];

function req(method: Method, path: string, body: unknown = null): ApiRequest {
  return { method, path, query: {}, body };
}

/** A checked variant of the base world. Fails the test (not the suite) when it does not check. */
function checkedVariant(label: string, mutate: (w: World) => void): CheckedWorld {
  const w = baseWorld();
  mutate(w);
  const r = checkWorld(w);
  if (!r.ok) {
    throw new AssertionError({
      message: `${label}: variant world does not check (reached ${r.reached}): ${JSON.stringify(r.issues.map((i) => ({ code: i.code, path: i.path, found: i.found })), null, 2)}`,
    });
  }
  return r.world;
}

/** The base world without jobs, so time moves only by ticks and explicit advances. */
const noJobs = (w: World): void => {
  w.jobs = {};
};

function rowsOf(d: StateDump, entity: string): readonly Readonly<Record<string, unknown>>[] {
  return d.tables[entity] ?? [];
}
/**
 * A deep copy of the dump. Comparing a later dump against a copy, never against the object
 * dump() returned, stops an engine whose dump() hands out live state from passing every
 * "unchanged" check by comparing its state to itself.
 */
const snap = (rt: Runtime): StateDump => structuredClone(rt.dump());
const jobColumn = (d: StateDump): unknown[] => rowsOf(d, 'job_run').map((r) => r['job']);
const idColumn = (d: StateDump, entity: string): unknown[] => rowsOf(d, entity).map((r) => r['id']);

/** advance() may throw on a failing job (RT-27). Swallow only that, never a stub. */
function advanceTolerant(rt: Runtime, by: string): void {
  try {
    rt.advance(by);
  } catch (e) {
    if (e instanceof Error && e.message === 'not implemented') throw e;
  }
}

const T = {
  start: '2026-01-05T09:00:00.000Z',
  plus1s: '2026-01-05T09:00:01.000Z',
  plus5s: '2026-01-05T09:00:05.000Z',
  plus45s: '2026-01-05T09:00:45.000Z',
  plus45s90m: '2026-01-05T10:30:45.000Z',
  plus45s90m2h: '2026-01-05T12:30:45.000Z',
  plus45s90m2h2d: '2026-01-07T12:30:45.000Z',
  plus1h: '2026-01-05T10:00:00.000Z',
  plus1h1s: '2026-01-05T10:00:01.000Z',
  plus2h: '2026-01-05T11:00:00.000Z',
} as const;

/** advance('2h') straight after create: (time, name) order, hand-derived. */
const JOBS_2H = ['a_late', 'a', 'a_late', 'b', 'a_late', 'a', 'a_late', 'b'] as const;
const JOB_TIMES_2H = [
  '2026-01-05T09:30:00.000Z',
  '2026-01-05T10:00:00.000Z', '2026-01-05T10:00:00.000Z', '2026-01-05T10:00:00.000Z',
  '2026-01-05T10:30:00.000Z',
  '2026-01-05T11:00:00.000Z', '2026-01-05T11:00:00.000Z', '2026-01-05T11:00:00.000Z',
] as const;

const NEW_AGENT = (n: number) => ({ name: `Redteam Agent ${n}`, email: `rt${n}@example.test`, on_call: false });

// ---------------------------------------------------------------------------------------

describe('jobs fire in (time, name) order', () => {
  it('G-27 advance(2h) after create fires a_late, a, a_late, b, a_late, a, a_late, b', cap('createRuntime', 'runtime.advance'), () => {
    const rt = freshRuntime();
    assert.deepEqual([...rt.advance('2h').jobsFired], [...JOBS_2H]);
  });

  it('G-27 G-17 advance(1h) fires FACTS.jobsAfter1h and job_run rows land in that order with counter ids', cap('createRuntime', 'runtime.advance', 'runtime.dump'), () => {
    const rt = freshRuntime();
    assert.deepEqual([...rt.advance('1h').jobsFired], [...FACTS.jobsAfter1h]);
    const d = rt.dump();
    assert.deepEqual(jobColumn(d), [...FACTS.jobsAfter1h]);
    assert.deepEqual(idColumn(d, 'job_run'), ['job_0001', 'job_0002', 'job_0003', 'job_0004']);
  });

  it('G-27 G-17 every job_run row of a 2h advance is recorded in firing order with counter ids', cap('createRuntime', 'runtime.advance', 'runtime.dump'), () => {
    const rt = freshRuntime();
    rt.advance('2h');
    const d = rt.dump();
    assert.deepEqual(jobColumn(d), [...JOBS_2H]);
    assert.deepEqual(idColumn(d, 'job_run'), ['job_0001', 'job_0002', 'job_0003', 'job_0004', 'job_0005', 'job_0006', 'job_0007', 'job_0008']);
  });

  it('G-27 a job sees its scheduled time in ctx.now()', opts(cap('createRuntime', 'runtime.advance', 'runtime.dump')), () => {
    const rt = freshRuntime();
    rt.advance('2h');
    assert.deepEqual(rowsOf(rt.dump(), 'job_run').map((r) => r['at']), [...JOB_TIMES_2H]);
  });

  it('G-26 now after advance(2h) on the base world is start + 2h, with no extra ticks for jobs', opts(cap('createRuntime', 'runtime.advance', 'runtime.dump')), () => {
    const rt = freshRuntime();
    rt.advance('2h');
    assert.equal(rt.dump().now, T.plus2h);
  });
});

describe('advance windows are (from, to] on multiples of every', () => {
  it('G-28 one advance(2h) equals two advance(1h): same jobs, same dump', cap('createRuntime', 'runtime.advance', 'runtime.dump'), () => {
    const one = freshRuntime();
    const jobsOne = [...one.advance('2h').jobsFired];
    const oneDump = snap(one);
    const two = freshRuntime();
    const jobsTwo = [...two.advance('1h').jobsFired, ...two.advance('1h').jobsFired];
    assert.deepEqual(jobsOne, [...JOBS_2H]);
    assert.deepEqual(jobsTwo, jobsOne);
    assert.deepEqual(snap(two), oneDump);
    // Two runtimes never share state: the second one's advances leave the first one alone.
    assert.deepEqual(snap(one), oneDump, 'advancing a second runtime changed the first one');
  });

  it('G-28 2h, 120m, 7200s and four 30m steps give the same jobs and dumps', cap('createRuntime', 'runtime.advance', 'runtime.dump'), () => {
    const run = (steps: readonly string[]) => {
      const rt = freshRuntime();
      const jobs = steps.flatMap((s) => [...rt.advance(s).jobsFired]);
      return { jobs, dump: snap(rt) };
    };
    const ref = run(['2h']);
    assert.deepEqual(ref.jobs, [...JOBS_2H]);
    for (const steps of [['120m'], ['7200s'], ['30m', '30m', '30m', '30m'], ['1800s', '1h', '30m'], ['90m', '1800s']]) {
      const got = run(steps);
      assert.deepEqual(got.jobs, ref.jobs, `steps ${steps.join(' + ')}`);
      assert.deepEqual(got.dump, ref.dump, `steps ${steps.join(' + ')}`);
    }
  });

  it('G-28 29m fires nothing, the next 1m fires a_late (to is inclusive), the next 1s fires nothing (from is exclusive)', cap('createRuntime', 'runtime.advance'), () => {
    const rt = freshRuntime();
    assert.deepEqual([...rt.advance('29m').jobsFired], []);
    assert.deepEqual([...rt.advance('1m').jobsFired], ['a_late']);
    assert.deepEqual([...rt.advance('1s').jobsFired], []);
  });

  it('G-28 after a_late fires, 1799s fires nothing and the next 1s fires a, a_late, b', opts(cap('createRuntime', 'runtime.advance')), () => {
    const rt = freshRuntime();
    assert.deepEqual([...rt.advance('30m').jobsFired], ['a_late']);
    assert.deepEqual([...rt.advance('1799s').jobsFired], []);
    assert.deepEqual([...rt.advance('1s').jobsFired], ['a', 'a_late', 'b']);
  });

  it('G-28 sixty advance(1m) calls fire exactly FACTS.jobsAfter1h, the first 29 fire nothing', cap('createRuntime', 'runtime.advance'), () => {
    const rt = freshRuntime();
    const perStep = Array.from({ length: 60 }, () => [...rt.advance('1m').jobsFired]);
    assert.deepEqual(perStep.slice(0, 29).flat(), []);
    assert.deepEqual(perStep.flat(), [...FACTS.jobsAfter1h]);
  });

  /** Steps that are whole multiples of 30m are invariant under any RT-24 tick policy, because no job lies within a few ticks after a 30m boundary. */
  function splitFuzz(label: string, step: (r: Rng) => { by: string; seconds: number }): void {
    for (const seed of seeds()) {
      const r = rng(seed);
      const steps = Array.from({ length: r.int(1, 6) }, () => step(r));
      const fails = (sub: readonly { by: string; seconds: number }[]): boolean => {
        if (sub.length === 0) return false;
        try {
          const a = freshRuntime();
          const jobsA = sub.flatMap((s) => [...a.advance(s.by).jobsFired]);
          const dumpA = snap(a);
          const b = freshRuntime();
          const total = sub.reduce((n, s) => n + s.seconds, 0);
          const jobsB = [...b.advance(`${total}s`).jobsFired];
          return !isDeepStrictEqual(jobsA, jobsB) || !isDeepStrictEqual(dumpA, snap(b));
        } catch (e) {
          if (e instanceof Error && e.message === 'not implemented') throw e;
          return true;
        }
      };
      if (fails(steps)) failWithRepro(label, seed, steps, fails, 'split advances differ from one advance of the summed duration');
    }
  }

  it('G-28 fuzz: splitting an advance on 30m multiples never changes jobs or state', cap('createRuntime', 'runtime.advance', 'runtime.dump'), () => {
    splitFuzz('G-28 split on 30m multiples', (r) => {
      const k = r.int(1, 4);
      const forms = k % 2 === 0 ? [`${k / 2}h`, `${k * 30}m`, `${k * 1800}s`] : [`${k * 30}m`, `${k * 1800}s`];
      return { by: r.pick(forms), seconds: k * 1800 };
    });
  });

  it('G-28 fuzz: splitting an advance at arbitrary seconds never changes jobs or state', opts(cap('createRuntime', 'runtime.advance', 'runtime.dump')), () => {
    splitFuzz('G-28 split at arbitrary seconds', (r) => {
      const seconds = r.int(1, 5400);
      const forms = [`${seconds}s`, ...(seconds % 60 === 0 ? [`${seconds / 60}m`] : [])];
      return { by: r.pick(forms), seconds };
    });
  });
});

describe('advance moves time by exactly d, and refuses anything else', () => {
  it('G-26 in a world without jobs, advance moves now by exactly d in s, m, h and d units', cap('checkWorld', 'createRuntime', 'runtime.advance', 'runtime.dump'), () => {
    const rt = createRuntime(checkedVariant('no jobs', noJobs));
    assert.equal(rt.dump().now, T.start);
    assert.deepEqual([...rt.advance('45s').jobsFired], []);
    assert.equal(rt.dump().now, T.plus45s);
    rt.advance('90m');
    assert.equal(rt.dump().now, T.plus45s90m);
    rt.advance('2h');
    assert.equal(rt.dump().now, T.plus45s90m2h);
    rt.advance('2d');
    assert.equal(rt.dump().now, T.plus45s90m2h2d);
  });

  /** RT-24 allows 0 or 1 tick per fired job, so now lands in [start + d, start + d + jobs * tick]. Bounds are literals. */
  it('G-26 with jobs firing, advance(d) moves now to start + d, plus at most one tick per fired job', cap('createRuntime', 'runtime.advance', 'runtime.dump'), () => {
    const cases: readonly { readonly by: string; readonly jobs: readonly string[]; readonly lo: string; readonly hi: string }[] = [
      { by: '45m', jobs: ['a_late'], lo: '2026-01-05T09:45:00.000Z', hi: '2026-01-05T09:45:01.000Z' },
      { by: '1h', jobs: FACTS.jobsAfter1h, lo: T.plus1h, hi: '2026-01-05T10:00:04.000Z' },
      { by: '2h', jobs: JOBS_2H, lo: T.plus2h, hi: '2026-01-05T11:00:08.000Z' },
      { by: '150m', jobs: [...JOBS_2H, 'a_late'], lo: '2026-01-05T11:30:00.000Z', hi: '2026-01-05T11:30:09.000Z' },
    ];
    for (const c of cases) {
      const rt = freshRuntime();
      assert.deepEqual([...rt.advance(c.by).jobsFired], [...c.jobs], `advance(${c.by}) jobs`);
      const now = rt.dump().now;
      assert.ok(now >= c.lo && now <= c.hi, `advance(${c.by}): now ${now} is outside [${c.lo}, ${c.hi}]`);
    }
  });

  /** Not Durations. `advance` is typed `Duration`, so what it does with these is RT-90. */
  const GARBAGE: readonly unknown[] = [
    '-1h', '-0s', '1 h', '', ' 1h', '1h ', '1h\n', '1.5h', '1,5h', '1e3s', '0x10s', '1w', '1y', '1ms', 'h', '1H', '1M',
    '30m1h', '1h1h', '1d 12h', '1d12', 'PT1H', 'NaN', 'Infinity', '4 hours', 'soon', 3600, 1, -1, null, undefined, {}, ['1h'], { advance: '1h' },
  ];

  it('G-26 negative, malformed and non-string durations leave now, rows and jobs unchanged', opts(cap('createRuntime', 'runtime.advance', 'runtime.dump')), () => {
    const rt = freshRuntime();
    const before = snap(rt);
    for (const bad of GARBAGE) {
      let fired: readonly string[] = [];
      try {
        fired = rt.advance(bad as string).jobsFired;
      } catch (e) {
        if (e instanceof Error && e.message === 'not implemented') throw e;
      }
      assert.deepEqual([...fired], [], `advance(${JSON.stringify(bad)}) fired jobs`);
      assert.deepEqual(rt.dump(), before, `advance(${JSON.stringify(bad)}) changed the state`);
    }
    // The runtime still works afterwards, and the refused advances left no hidden clock state behind.
    assert.equal(before.now, T.start);
    assert.deepEqual([...rt.advance('1h').jobsFired], [...FACTS.jobsAfter1h]);
    assert.deepEqual(rowsOf(rt.dump(), 'job_run').map((r) => [r['id'], r['job']]), [
      ['job_0001', 'a_late'], ['job_0002', 'a'], ['job_0003', 'a_late'], ['job_0004', 'b'],
    ]);
  });

  it('G-26 advance(0s) fires nothing and leaves now unchanged', opts(cap('createRuntime', 'runtime.advance', 'runtime.dump')), () => {
    const rt = freshRuntime();
    const before = snap(rt);
    assert.deepEqual([...rt.advance('0s').jobsFired], []);
    assert.deepEqual(rt.dump(), before);
  });
});

describe('ticks', () => {
  it('G-25 each committed write advances now by exactly one tick, whatever it writes', cap('createRuntime', 'runtime.call', 'runtime.dump', 'runtime.seed', 'runtime.actions'), () => {
    const rt = freshRuntime();
    assert.equal(rt.dump().now, T.start);
    const r1 = rt.call(req('POST', '/agents', NEW_AGENT(1)));
    assert.ok(r1.status >= 200 && r1.status < 300, `create agent returned ${r1.status}`);
    assert.equal(rt.dump().now, T.plus1s);
    // now is checked after every write, so a kind that ticks twice cannot hide behind one that ticks zero times.
    const writes: readonly { readonly req: ApiRequest; readonly now: string }[] = [
      { req: req('POST', '/agents', NEW_AGENT(2)), now: '2026-01-05T09:00:02.000Z' },
      { req: req('PATCH', '/tickets/tkt_0005', { status: 'pending' }), now: '2026-01-05T09:00:03.000Z' },
      { req: req('POST', '/tickets/tkt_0001/escalate', { reason: 'tick probe' }), now: '2026-01-05T09:00:04.000Z' },
      { req: req('DELETE', '/tickets/tkt_0011'), now: T.plus5s },
    ];
    for (const w of writes) {
      const r = rt.call(w.req);
      const label = `${w.req.method} ${w.req.path}`;
      assert.ok(r.status >= 200 && r.status < 300, `${label} returned ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(rt.dump().now, w.now, `${label}: now`);
    }
  });

  /** An action whose handler makes three writes. One call is one tick, however many rows it writes. */
  const withTripleWrite = (w: World): void => {
    w.actions['triple_write'] = {
      method: 'POST',
      path: '/tickets/{id}/triple_write',
      description: 'Red-team probe: three writes in one call.',
      input: {},
      handler: `(ctx) => {
  const t = ctx.db.get('ticket', ctx.params.id);
  if (!t) ctx.fail(404, 'not_found', 'ticket not found');
  ctx.db.update('ticket', t.id, { priority: 'low' });
  ctx.db.update('ticket', t.id, { priority: 'high' });
  ctx.db.create('agent', { name: 'Triple Write', email: 'triple@example.test', on_call: false });
  return { status: 200, body: ctx.db.get('ticket', t.id) };
}`,
    };
  };

  it('G-25 a call whose handler writes three rows advances now by one tick, not three', cap('checkWorld', 'createRuntime', 'runtime.call', 'runtime.dump', 'runtime.seed', 'runtime.actions'), () => {
    const rt = createRuntime(checkedVariant('triple write action', withTripleWrite));
    const r = rt.call(req('POST', '/tickets/tkt_0002/triple_write', {}));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const d = rt.dump();
    assert.equal(d.now, T.plus1s);
    assert.equal(rowsOf(d, 'ticket').find((t) => t['id'] === 'tkt_0002')?.['priority'], 'high');
    assert.deepEqual(idColumn(d, 'agent'), [...FACTS.agentIds, FACTS.nextAgentId]);
  });

  it('G-25 a write after advance(1h) lands one tick after start + 1h', cap('checkWorld', 'createRuntime', 'runtime.call', 'runtime.advance', 'runtime.dump', 'runtime.seed'), () => {
    const rt = createRuntime(checkedVariant('no jobs', noJobs));
    rt.advance('1h');
    assert.equal(rt.dump().now, T.plus1h);
    const r = rt.call(req('PATCH', '/tickets/tkt_0005', { status: 'pending' }));
    assert.equal(r.status, 200);
    assert.equal(rt.dump().now, T.plus1h1s);
  });

  /** Calls that must fail on a fresh base runtime. Each is a different refusal path. */
  const FAILING: readonly { readonly why: string; readonly req: ApiRequest }[] = [
    { why: 'open -> closed is not a transition', req: req('PATCH', '/tickets/tkt_0001', { status: 'closed' }) },
    { why: 'escalated is readonly', req: req('PATCH', '/tickets/tkt_0001', { escalated: true }) },
    { why: 'missing ticket', req: req('PATCH', '/tickets/tkt_9999', { priority: 'low' }) },
    { why: 'handler writes, then ctx.fail', req: req('POST', '/tickets/tkt_0002/escalate', { reason: 'probe', fail: true }) },
    { why: 'escalate a closed ticket', req: req('POST', '/tickets/tkt_0004/escalate', { reason: 'probe' }) },
    { why: 'action input missing required reason', req: req('POST', '/tickets/tkt_0001/escalate', {}) },
    { why: 'create without required ref_code', req: req('POST', '/tickets', { subject: 'No ref', priority: 'low' }) },
    { why: 'duplicate unique ref_code', req: req('POST', '/tickets', { subject: 'Dup', priority: 'low', ref_code: 'HD-1001' }) },
    { why: 'money is a float', req: req('PATCH', '/tickets/tkt_0001', { credit: 12.5 }) },
    { why: 'ref to a missing agent', req: req('PATCH', '/tickets/tkt_0001', { assignee: 'agt_9999' }) },
    { why: 'restrict delete of an agent with tickets', req: req('DELETE', '/agents/agt_0001') },
    { why: 'duplicate unique email', req: req('POST', '/agents', { name: 'Clone', email: 'ava@example.test', on_call: false }) },
    { why: 'unknown route', req: req('POST', '/nope', { a: 1 }) },
  ];

  it('G-25 G-08 G-10 failed calls do not tick, leave the whole dump unchanged and use up no id', cap('createRuntime', 'runtime.call', 'runtime.dump', 'runtime.seed', 'runtime.actions'), () => {
    const rt = freshRuntime();
    const before = snap(rt);
    assert.equal(before.now, T.start);
    for (const f of FAILING) {
      const r = rt.call(f.req);
      assert.ok(r.status >= 400 && r.status < 500, `${f.why}: status ${r.status}`);
      assert.deepEqual(rt.dump(), before, `${f.why}: dump changed`);
    }
    // No time was spent: the first committed write is exactly one tick after start.
    const ok = rt.call(req('POST', '/agents', NEW_AGENT(9)));
    assert.ok(ok.status >= 200 && ok.status < 300, `create agent returned ${ok.status}`);
    assert.equal(rt.dump().now, T.plus1s);
    // The failed agent and ticket creates did not use up a counter id (counters live outside the dump).
    const ticket = rt.call(req('POST', '/tickets', { subject: 'After failures', status: 'open', priority: 'low', ref_code: 'HD-2001' }));
    assert.ok(ticket.status >= 200 && ticket.status < 300, `create ticket returned ${ticket.status}: ${JSON.stringify(ticket.body)}`);
    const d = rt.dump();
    assert.equal(d.now, '2026-01-05T09:00:02.000Z');
    assert.deepEqual(idColumn(d, 'agent'), [...FACTS.agentIds, FACTS.nextAgentId]);
    assert.deepEqual(idColumn(d, 'ticket'), [...FACTS.ticketIds, FACTS.nextTicketId]);
  });

  it('G-25 a failed call after jobs fired does not tick either', cap('createRuntime', 'runtime.call', 'runtime.advance', 'runtime.dump', 'runtime.seed', 'runtime.actions'), () => {
    const rt = freshRuntime();
    rt.advance('1h');
    const before = snap(rt);
    for (const f of FAILING) {
      const r = rt.call(f.req);
      assert.ok(r.status >= 400 && r.status < 500, `${f.why}: status ${r.status}`);
    }
    assert.deepEqual(rt.dump(), before);
    // The next committed write lands exactly one tick later. RT-24 allows two clock readings after advance('1h').
    const nextTick: Readonly<Record<string, string>> = {
      '2026-01-05T10:00:00.000Z': '2026-01-05T10:00:01.000Z',
      '2026-01-05T10:00:04.000Z': '2026-01-05T10:00:05.000Z',
    };
    const expected = nextTick[before.now];
    assert.ok(expected, `now after advance('1h') is ${before.now}`);
    assert.equal(rt.call(req('PATCH', '/tickets/tkt_0005', { status: 'pending' })).status, 200);
    assert.equal(rt.dump().now, expected);
  });
});

describe('reset and the clock', () => {
  it('G-19 G-17 reset after writes and advances restores the seed clock, rows and counters', cap('createRuntime', 'runtime.call', 'runtime.advance', 'runtime.dump', 'runtime.reset', 'runtime.log'), () => {
    const pristine = snap(freshRuntime());
    const rt = freshRuntime();
    assert.ok(rt.call(req('POST', '/agents', NEW_AGENT(1))).status < 300);
    assert.ok(rt.call(req('POST', '/tickets', { subject: 'Before reset', status: 'open', priority: 'low', ref_code: 'HD-2002' })).status < 300);
    rt.advance('3h');
    assert.equal(rt.call(req('PATCH', '/tickets/tkt_0005', { status: 'pending' })).status, 200);
    rt.reset();
    assert.deepEqual(rt.dump(), pristine);
    assert.equal(pristine.now, T.start);
    assert.deepEqual([...rt.log()], []);
    assert.deepEqual([...rt.advance('1h').jobsFired], [...FACTS.jobsAfter1h]);
    assert.deepEqual(idColumn(rt.dump(), 'job_run'), ['job_0001', 'job_0002', 'job_0003', 'job_0004']);
    const created = rt.call(req('POST', '/agents', NEW_AGENT(2)));
    assert.ok(created.status >= 200 && created.status < 300, `create agent returned ${created.status}`);
    assert.deepEqual(idColumn(rt.dump(), 'agent'), [...FACTS.agentIds, FACTS.nextAgentId]);
    // The ticket counter is reset too, not only the counters the test touches last.
    const ticket = rt.call(req('POST', '/tickets', { subject: 'After reset', status: 'open', priority: 'low', ref_code: 'HD-2002' }));
    assert.ok(ticket.status >= 200 && ticket.status < 300, `create ticket returned ${ticket.status}: ${JSON.stringify(ticket.body)}`);
    assert.deepEqual(idColumn(rt.dump(), 'ticket'), [...FACTS.ticketIds, FACTS.nextTicketId]);
  });
});

describe('one transaction per job', () => {
  /** b writes, then throws whenever job a has already run. a runs before b at 10:00 and 11:00. */
  const bThrowsAfterA = (w: World): void => {
    const b = w.jobs['b'];
    if (!b) throw new Error('fixture has no job b');
    b.run = `(ctx) => {
  ctx.db.create('job_run', { job: 'b', at: ctx.now() });
  if (ctx.db.list('job_run', { where: { job: 'a' } }).length > 0) throw new Error('job b exploded');
}`;
  };

  it('G-29 a throwing job keeps the writes of jobs that fired before it, and loses its own', cap('checkWorld', 'createRuntime', 'runtime.advance', 'runtime.dump'), () => {
    const rt = createRuntime(checkedVariant('b throws', bThrowsAfterA));
    advanceTolerant(rt, '1h');
    const d = rt.dump();
    assert.deepEqual(jobColumn(d), ['a_late', 'a', 'a_late']);
    assert.deepEqual(idColumn(d, 'job_run'), ['job_0001', 'job_0002', 'job_0003']);
  });

  it('G-29 G-10 a rolled-back job does not use up an id', cap('checkWorld', 'createRuntime', 'runtime.advance', 'runtime.dump'), () => {
    const rt = createRuntime(checkedVariant('b throws', bThrowsAfterA));
    advanceTolerant(rt, '1h');
    advanceTolerant(rt, '1h');
    const d = rt.dump();
    assert.deepEqual(jobColumn(d), ['a_late', 'a', 'a_late', 'a_late', 'a', 'a_late']);
    assert.deepEqual(idColumn(d, 'job_run'), ['job_0001', 'job_0002', 'job_0003', 'job_0004', 'job_0005', 'job_0006']);
  });

  it('G-29 a job that breaks the data model is rolled back alone', cap('checkWorld', 'createRuntime', 'runtime.advance', 'runtime.dump'), () => {
    const rt = createRuntime(
      checkedVariant('a writes an invalid enum', (w) => {
        const a = w.jobs['a'];
        if (!a) throw new Error('fixture has no job a');
        a.run = `(ctx) => {
  ctx.db.create('job_run', { job: 'a', at: ctx.now() });
  if (ctx.db.list('job_run').length > 1) ctx.db.create('job_run', { job: 'zzz', at: ctx.now() });
}`;
      }),
    );
    advanceTolerant(rt, '1h');
    const d = rt.dump();
    // RT-27: the engine may stop at the failing job or go on to a_late and b at 10:00. Either way
    // a's rolled-back rows are gone and used up no id, so ids stay consecutive.
    const rows = rowsOf(d, 'job_run').map((r) => [r['id'], r['job']]);
    const stopped = [['job_0001', 'a_late']];
    const continued = [['job_0001', 'a_late'], ['job_0002', 'a_late'], ['job_0003', 'b']];
    assert.ok(isDeepStrictEqual(rows, stopped) || isDeepStrictEqual(rows, continued), `job_run rows ${JSON.stringify(rows)}`);
  });

  it('G-29 jobs after a throwing job at the same time still fire', opts(cap('checkWorld', 'createRuntime', 'runtime.advance', 'runtime.dump')), () => {
    const rt = createRuntime(
      checkedVariant('a throws after a_late', (w) => {
        const a = w.jobs['a'];
        if (!a) throw new Error('fixture has no job a');
        a.run = `(ctx) => {
  ctx.db.create('job_run', { job: 'a', at: ctx.now() });
  if (ctx.db.list('job_run', { where: { job: 'a_late' } }).length > 0) throw new Error('job a exploded');
}`;
      }),
    );
    advanceTolerant(rt, '1h');
    assert.deepEqual(jobColumn(rt.dump()), ['a_late', 'a_late', 'b']);
  });
});

describe('ctx.changes() and jobs', () => {
  it('G-30 jobs firing between calls never change a base-world grade', cap('createRuntime', 'runtime.call', 'runtime.advance', 'runtime.grade'), () => {
    const idle = freshRuntime();
    idle.advance('2h');
    for (const id of TASK_IDS) assert.equal(idle.grade(id), 0, `${id}: noop plus jobs`);

    const easy = freshRuntime();
    easy.advance('1h');
    assert.equal(easy.call(req('PATCH', '/tickets/tkt_0005', { status: 'pending' })).status, 200);
    easy.advance('1h');
    assert.equal(easy.grade('pend_hd1005'), 1);

    const medium = freshRuntime();
    assert.equal(medium.call(req('PATCH', '/tickets/tkt_0001', { status: 'pending' })).status, 200);
    medium.advance('90m');
    assert.equal(medium.grade('pend_open_urgent'), 0.5);
    assert.equal(medium.call(req('PATCH', '/tickets/tkt_0009', { status: 'pending' })).status, 200);
    medium.advance('30m');
    assert.equal(medium.grade('pend_open_urgent'), 1);
  });

  /**
   * A fourth task whose grader encodes what ctx.changes() returned as a literal score.
   * Verification sees only the noop (0) and solution (1) states, so the task checks ok.
   * (If RT-66, an idle noop that advances the clock, is ever adopted, the noop would score
   * 0.25 here and this variant would stop checking.)
   */
  const PROBE_GRADER = `(ctx) => {
  const def = ctx.changes();
  const all = ctx.changes({ includeJobs: true });
  const jobs = all.filter((c) => c.origin === 'job');
  if (def.some((c) => c.origin !== 'call')) return 0.125;
  if (all.some((c) => c.origin !== 'call' && c.origin !== 'job')) return 0.0625;
  if (all.filter((c) => c.origin === 'call').length !== def.length) return 0.1875;
  const jobsOk = jobs.length === 4 && jobs.every((c) => c.entity === 'job_run' && c.kind === 'created') &&
    JSON.stringify(jobs.map((c) => c.id).sort()) === '["job_0001","job_0002","job_0003","job_0004"]';
  if (def.length === 0) {
    if (jobs.length === 0) return 0;
    return jobsOk ? 0.25 : 0.3125;
  }
  const c = def[0];
  if (def.length === 1 && c.entity === 'ticket' && c.id === 'tkt_0005' && c.kind === 'updated') {
    if (jobs.length === 0) return JSON.stringify(c.fields) === '["status"]' ? 1 : 0.9375;
    return jobsOk ? 0.75 : 0.8125;
  }
  if (def.length === 1 && c.entity === 'ticket' && c.id === 'tkt_0002' && c.kind === 'updated') {
    return JSON.stringify(c.fields) === '["priority"]' ? 0.5 : 0.4375;
  }
  if (def.length === 1 && c.entity === 'agent' && c.kind === 'created') {
    return c.id === 'agt_0004' && ctx.changes({ ignore: ['agent'] }).length === 0 ? 0.625 : 0.5625;
  }
  return 0.875;
}`;
  const withProbeTask = (w: World): void => {
    w.tasks['probe_changes'] = {
      difficulty: 'easy',
      instruction: 'Move the ticket tkt_0005 to pending (red-team probe for ctx.changes).',
      grader: PROBE_GRADER,
      solution: `(ctx) => {
  const r = ctx.api('PATCH', '/tickets/tkt_0005', { status: 'pending' });
  ctx.assert(r.status === 200, 'patch returned ' + r.status);
}`,
      decoys: [],
      alternatives: [],
    };
  };

  const SCENARIOS: readonly { readonly name: string; readonly score: number; run(rt: Runtime): void }[] = [
    { name: 'untouched seed', score: 0, run: () => {} },
    { name: 'only jobs fired: default hides them, includeJobs shows job_run creates', score: 0.25, run: (rt) => rt.advance('1h') },
    { name: 'one call patches tkt_0005', score: 1, run: (rt) => rt.call(req('PATCH', '/tickets/tkt_0005', { status: 'pending' })) },
    {
      name: 'jobs fired, then one call patches tkt_0005',
      score: 0.75,
      run: (rt) => {
        rt.advance('1h');
        rt.call(req('PATCH', '/tickets/tkt_0005', { status: 'pending' }));
      },
    },
    { name: 'fields lists only the changed field, never updated_at', score: 0.5, run: (rt) => rt.call(req('PATCH', '/tickets/tkt_0002', { priority: 'high' })) },
    { name: 'a created agent is agt_0004 and ignore drops it', score: 0.625, run: (rt) => rt.call(req('POST', '/agents', NEW_AGENT(4))) },
    {
      name: 'a failed escalate that wrote before ctx.fail leaves no change behind',
      score: 0,
      run: (rt) => rt.call(req('POST', '/tickets/tkt_0002/escalate', { reason: 'probe', fail: true })),
    },
    {
      name: 'failed calls around a fired job leave only the job changes',
      score: 0.25,
      run: (rt) => {
        rt.call(req('PATCH', '/tickets/tkt_0001', { status: 'closed' }));
        rt.advance('1h');
        rt.call(req('POST', '/agents', { name: 'Clone', email: 'ava@example.test', on_call: false }));
      },
    },
  ];

  it('G-30 G-17 changes() tags origin, hides job changes by default and shows them with includeJobs', cap('checkWorld', 'createRuntime', 'runtime.call', 'runtime.advance', 'runtime.grade'), () => {
    const world = checkedVariant('probe task (a failure here usually means ctx.changes() is wrong)', withProbeTask);
    const wrong: string[] = [];
    for (const s of SCENARIOS) {
      const rt = createRuntime(world);
      s.run(rt);
      const got = rt.grade('probe_changes');
      if (got !== s.score) wrong.push(`${s.name}: expected ${s.score}, got ${got}`);
    }
    assert.deepEqual(wrong, []);
  });
});

describe('admin clock over HTTP', { concurrency: false }, () => {
  let server: Server | null = null;
  const up = async (): Promise<Server> => (server ??= await serveWorld(baseWorld()));
  after(async () => {
    await server?.stop();
  });

  const BAD_BODIES: readonly { readonly label: string; readonly body?: unknown; readonly raw?: string }[] = [
    { label: 'soon', body: { advance: 'soon' } },
    { label: 'negative', body: { advance: '-1h' } },
    { label: 'fraction', body: { advance: '1.5h' } },
    { label: 'spaced', body: { advance: '4 h' } },
    { label: 'number', body: { advance: 3600 } },
    { label: 'null', body: { advance: null } },
    { label: 'missing key', body: {} },
    { label: 'array body', body: ['1h'] },
    { label: 'truncated JSON', raw: '{"advance":' },
    { label: 'form encoded', raw: 'advance=1h' },
  ];

  it('G-26 G-43 the admin clock refuses bad durations with a 4xx and keeps time and rows', cap('cli.serve'), async () => {
    const s = await up();
    await s.adminApi.post('/_world/reset');
    const before = (await s.adminApi.get('/_world/state')).body;
    for (const b of BAD_BODIES) {
      const r = b.raw !== undefined ? await s.adminApi.request('POST', '/_world/clock', undefined, { raw: b.raw }) : await s.adminApi.post('/_world/clock', b.body);
      assert.ok(r.status >= 400 && r.status < 500, `${b.label}: status ${r.status} ${r.text.slice(0, 200)}`);
      assert.deepEqual((await s.adminApi.get('/_world/state')).body, before, `${b.label}: state changed`);
    }
  });

  it('G-26 the admin clock answers exactly 400 for bad durations', opts(cap('cli.serve')), async () => {
    const s = await up();
    for (const b of BAD_BODIES.filter((x) => x.body !== undefined)) {
      const r = await s.adminApi.post('/_world/clock', b.body);
      assert.equal(r.status, 400, b.label);
    }
  });

  it('G-26 the admin clock with 0s changes nothing', opts(cap('cli.serve')), async () => {
    const s = await up();
    await s.adminApi.post('/_world/reset');
    const before = (await s.adminApi.get('/_world/state')).body;
    await s.adminApi.post('/_world/clock', { advance: '0s' });
    assert.deepEqual((await s.adminApi.get('/_world/state')).body, before);
  });

  it('G-43 G-27 the admin clock advance(1h) fires the four jobs in order', cap('cli.serve'), async () => {
    const s = await up();
    await s.adminApi.post('/_world/reset');
    const r = await s.adminApi.post('/_world/clock', { advance: '1h' });
    assert.ok(r.status >= 200 && r.status < 300, `status ${r.status}`);
    const state = (await s.adminApi.get('/_world/state')).body as StateDump;
    assert.deepEqual(jobColumn(state), [...FACTS.jobsAfter1h]);
    assert.ok(state.now >= T.plus1h && state.now <= '2026-01-05T10:00:04.000Z', `now ${state.now}`);
  });

  it('G-43 G-28 the admin clock honours the duration it is given: 4h after reset fires sixteen jobs', cap('cli.serve'), async () => {
    const s = await up();
    assert.ok((await s.adminApi.post('/_world/reset')).status < 300);
    const r = await s.adminApi.post('/_world/clock', { advance: '4h' });
    assert.ok(r.status >= 200 && r.status < 300, `status ${r.status}`);
    const state = (await s.adminApi.get('/_world/state')).body as StateDump;
    assert.deepEqual(jobColumn(state), [...FACTS.jobsAfter1h, ...FACTS.jobsAfter1h, ...FACTS.jobsAfter1h, ...FACTS.jobsAfter1h]);
    assert.ok(state.now >= '2026-01-05T13:00:00.000Z' && state.now <= '2026-01-05T13:00:16.000Z', `now ${state.now}`);
    // Reset puts the clock back to the start.
    assert.ok((await s.adminApi.post('/_world/reset')).status < 300);
    assert.equal(((await s.adminApi.get('/_world/state')).body as StateDump).now, T.start);
  });
});
