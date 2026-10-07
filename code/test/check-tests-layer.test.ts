import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { check, type CheckReport } from '../src/engine/check.ts';
import type { World } from '../src/engine/format.ts';
import type { CheckIssue } from '../src/engine/issues.ts';
import { createVmHost } from '../src/engine/sandbox.ts';
import { bareWorld, minimalWorld, withStubTasks } from './helpers/world.ts';

const host = createVmHost();

/** bareWorld with the given tests (name to script). */
const stubbed = (): World => withStubTasks(bareWorld()); // an ok report needs 3 tasks since YOS-113
function withTests(tests: Record<string, string>, base: World = bareWorld()): World {
  return { ...base, tests: Object.fromEntries(Object.entries(tests).map(([n, script]) => [n, { description: `Test ${n}.`, script }])) };
}

function ok(report: CheckReport): Extract<CheckReport, { ok: true }> {
  if (!report.ok) throw new Error(`expected ok, got ${JSON.stringify(report.issues.map((i) => [i.code, i.path, i.hint]))}`);
  return report;
}

function failed(report: CheckReport): Extract<CheckReport, { ok: false }> {
  if (report.ok) throw new Error('expected a failed report');
  return report;
}

const brief = (i: CheckIssue): { code: string; path: readonly (string | number)[]; hint: string } => ({ code: i.code, path: i.path, hint: i.hint });

describe('check tests layer: ctx.api and fresh state', () => {
  it('runs each test from a fresh seeded state', () => {
    const r = check(withTests({
      a_creates: `(ctx) => {
        const c = ctx.api('POST', '/customers', { name: 'Newco', tier: 'free' });
        ctx.assert(c.status === 201, 'create returned ' + c.status);
        ctx.assert(ctx.api('GET', '/customers').body.data.length === 6, 'expected 6 after create');
      }`,
      b_sees_seed: `(ctx) => {
        const list = ctx.api('GET', '/customers');
        ctx.assert(list.body.data.length === 5, 'expected 5 seeded customers, saw ' + list.body.data.length);
      }`,
    }, stubbed()), host);
    assert.equal(ok(r).tests, 2);
  });

  it('returns { status, body } from handle, with the query string and the world error envelope', () => {
    const r = check(withTests({
      shape: `(ctx) => {
        const res = ctx.api('GET', '/tickets?status=resolved');
        ctx.assert(res.status === 200, 'status ' + res.status);
        ctx.assert(JSON.stringify(Object.keys(res).sort()) === '["body","status"]', 'keys ' + Object.keys(res));
        ctx.assert(res.body.data.length === 2, 'resolved count ' + res.body.data.length);
        ctx.assert(res.body.data[0].id === 'tkt_0003', 'first resolved ' + res.body.data[0].id);
        const missing = ctx.api('GET', '/tickets/tkt_9999');
        ctx.assert(missing.status === 404, 'missing status ' + missing.status);
        const nowhere = ctx.api('GET', '/nowhere');
        ctx.assert(nowhere.status === 404, 'nowhere status ' + nowhere.status);
      }`,
    }, stubbed()), host);
    assert.equal(ok(r).tests, 1);
  });

  it('gives ctx.now() as engine time, starting at meta.clock.start', () => {
    const r = check(withTests({
      clock: `(ctx) => { ctx.assert(ctx.now() === '2026-01-05T09:00:00.000Z', 'now was ' + ctx.now()); }`,
    }, stubbed()), host);
    assert.equal(ok(r).tests, 1);
  });
});

describe('check tests layer: failures', () => {
  it('reports a failing assert as test.failed with the message in hint', () => {
    const r = failed(check(withTests({ boom: `(ctx) => { ctx.assert(1 === 2, 'boom'); }` }), host));
    assert.equal(r.reached, 'tests');
    assert.deepEqual(r.issues.map(brief), [{ code: 'test.failed', path: ['tests', 'boom', 'script'], hint: 'boom' }]);
    assert.equal(r.issues[0].severity, 'error');
  });

  it('still fails a test whose script catches the failed assert', () => {
    const r = failed(check(withTests({ sly: `(ctx) => { try { ctx.assert(false, 'caught me'); } catch (e) {} }` }), host));
    assert.deepEqual(r.issues.map(brief), [{ code: 'test.failed', path: ['tests', 'sly', 'script'], hint: 'caught me' }]);
  });

  it('reports a runtime error as its own snippet issue at the script path', () => {
    const r = failed(check(withTests({ npe: `(ctx) => { const x = null; return x.y; }` }), host));
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0].code, 'snippet.runtime_error');
    assert.deepEqual(r.issues[0].path, ['tests', 'npe', 'script']);
  });

  it('reports an async script as snippet.promise_returned', () => {
    const r = failed(check(withTests({ later: `async (ctx) => { ctx.api('GET', '/tickets'); }` }), host));
    assert.deepEqual(r.issues.map((i) => [i.code, i.path]), [['snippet.promise_returned', ['tests', 'later', 'script']]]);
  });

  it('gives client scripts no ctx.db: reaching state directly is a runtime error', () => {
    const r = failed(check(withTests({ sneaky: `(ctx) => { ctx.db.update('ticket', 'tkt_0001', { status: 'resolved' }); }` }), host));
    assert.deepEqual(r.issues.map((i) => [i.code, i.path]), [['snippet.runtime_error', ['tests', 'sneaky', 'script']]]);
  });

  it('reports a ctx.api call with an unknown method as a runtime error naming the methods', () => {
    const r = failed(check(withTests({ fetchy: `(ctx) => { ctx.api('FETCH', '/tickets'); }` }), host));
    assert.equal(r.issues.length, 1);
    assert.equal(r.issues[0].code, 'snippet.runtime_error');
    assert.deepEqual(r.issues[0].path, ['tests', 'fetchy', 'script']);
    assert.equal(r.issues[0].hint, 'ctx.api method must be one of GET, POST, PUT, PATCH, DELETE, got "FETCH"');
  });

  it('reports every failing test, passes the rest, and blocks the tasks layer', () => {
    const w = withTests({
      first: `(ctx) => { ctx.assert(false, 'first failed'); }`,
      fine: `(ctx) => { ctx.assert(ctx.api('GET', '/tickets').status === 200, 'list'); }`,
      second: `(ctx) => { ctx.assert(false, 'second failed'); }`,
    }, minimalWorld());
    const r = failed(check(w, host));
    assert.equal(r.reached, 'tests');
    assert.deepEqual(r.issues.map((i) => [i.code, i.path]), [
      ['test.failed', ['tests', 'first', 'script']],
      ['test.failed', ['tests', 'second', 'script']],
      ['layer.blocked', ['tasks']],
    ]);
  });
});

describe('check tests layer: enforcement is the same as for agents', () => {
  it('answers 422 to an undeclared state transition and 200 to a declared one', () => {
    const r = check(withTests({
      illegal: `(ctx) => {
        const res = ctx.api('PATCH', '/tickets/tkt_0001', { status: 'resolved' });
        ctx.assert(res.status === 422, 'open -> resolved returned ' + res.status);
      }`,
      legal: `(ctx) => {
        const res = ctx.api('PATCH', '/tickets/tkt_0001', { status: 'pending' });
        ctx.assert(res.status === 200, 'open -> pending returned ' + res.status);
        ctx.assert(res.body.status === 'pending', 'body status ' + res.body.status);
      }`,
    }, stubbed()), host);
    assert.equal(ok(r).tests, 2);
  });

  it('fails a test that expects the undeclared transition to succeed', () => {
    const r = failed(check(withTests({
      wrong: `(ctx) => {
        const res = ctx.api('PATCH', '/tickets/tkt_0001', { status: 'resolved' });
        ctx.assert(res.status === 200, 'open -> resolved returned ' + res.status);
      }`,
    }), host));
    assert.deepEqual(r.issues.map(brief), [{ code: 'test.failed', path: ['tests', 'wrong', 'script'], hint: 'open -> resolved returned 422' }]);
  });
});

describe('check tests layer: unexercised actions and test count', () => {
  it('lists an action no test calls and warns once per action without blocking ok', () => {
    const r = ok(check(withTests({ lists: `(ctx) => { ctx.api('GET', '/tickets'); }` }, stubbed()), host));
    assert.deepEqual(r.stats.unexercisedActions, ['resolve_ticket']);
    const warned = r.warnings.filter((w) => w.code === 'action.unexercised');
    assert.deepEqual(warned.map((w) => [w.path, w.severity, w.hint]), [[['actions', 'resolve_ticket'], 'warning', 'Remove resolve_ticket, or call it from a test or a task solution.']]);
  });

  it('does not count an action as exercised when input validation refuses the call before its handler', () => {
    const r = ok(check(withTests({
      junk: `(ctx) => {
        const res = ctx.api('POST', '/tickets/tkt_0002/resolve', { junk: 1 });
        ctx.assert(res.status === 400 && res.body.error.code === 'input.invalid', 'junk body returned ' + res.status);
      }`,
    }, stubbed()), host));
    assert.deepEqual(r.stats.unexercisedActions, ['resolve_ticket']);
  });

  it('counts an action as exercised when a test calls it, even when it refuses with 409', () => {
    const r = ok(check(withTests({
      refused: `(ctx) => {
        const res = ctx.api('POST', '/tickets/tkt_0001/resolve');
        ctx.assert(res.status === 409, 'resolve of an open ticket returned ' + res.status);
      }`,
    }, stubbed()), host));
    assert.deepEqual(r.stats.unexercisedActions, []);
    assert.deepEqual(r.warnings.filter((w) => w.code === 'action.unexercised'), []);
  });

  it('lists every action of a world with no tests, in declaration order', () => {
    const base = withStubTasks(bareWorld());
    const extra = { ...base.actions.resolve_ticket!, path: '/tickets/{id}/close' };
    const r = ok(check({ ...base, actions: { resolve_ticket: base.actions.resolve_ticket, close_ticket: extra } }, host));
    assert.deepEqual(r.stats.unexercisedActions, ['resolve_ticket', 'close_ticket']);
    assert.equal(r.tests, 0);
  });

  it('reports the number of tests run in the ok report', () => {
    const r = ok(check(withTests({
      one: `(ctx) => {}`,
      two: `(ctx) => { ctx.api('POST', '/tickets/tkt_0002/resolve'); }`,
      three: `(ctx) => { ctx.assert(true, 'never'); }`,
    }, stubbed()), host));
    assert.equal(r.tests, 3);
    assert.deepEqual(r.stats.unexercisedActions, []);
  });
});

describe('check tests layer: ctx.advance', () => {
  const HOURLY = { description: 'Adds one customer per hour.', every: '1h', run: "(ctx) => { ctx.db.create('customer', { name: 'Hourly ' + ctx.now(), tier: 'free' }); }" };

  it('fires a job with every 1h after ctx.advance(1h), and not before', () => {
    const r = check(withTests({
      hourly: `(ctx) => {
        const early = ctx.advance('59m');
        ctx.assert(JSON.stringify(early.jobsFired) === '[]', 'fired early: ' + JSON.stringify(early.jobsFired));
        ctx.assert(ctx.api('GET', '/customers').body.data.length === 5, 'customer added early');
        const due = ctx.advance('1m');
        ctx.assert(JSON.stringify(due.jobsFired) === '["hourly"]', 'fired ' + JSON.stringify(due.jobsFired));
        ctx.assert(due.jobsFailed.length === 0, 'job failed');
        const names = ctx.api('GET', '/customers').body.data.map((c) => c.name);
        ctx.assert(names.includes('Hourly 2026-01-05T10:00:00.000Z'), 'customers ' + names);
        ctx.assert(ctx.now() === '2026-01-05T10:00:02.000Z', 'now ' + ctx.now());
      }`,
    }, { ...withStubTasks(bareWorld()), jobs: { hourly: HOURLY } }), host);
    assert.equal(ok(r).tests, 1);
  });

  it('starts each test at meta.clock.start, whatever an earlier test advanced', () => {
    const r = check(withTests({
      a_moves: `(ctx) => { ctx.advance('3d'); }`,
      b_fresh: `(ctx) => { ctx.assert(ctx.now() === '2026-01-05T09:00:00.000Z', 'now ' + ctx.now()); }`,
    }, stubbed()), host);
    assert.equal(ok(r).tests, 2);
  });

  it('reports a bad duration as a runtime error with the clock parser message', () => {
    const r = failed(check(withTests({ soon: `(ctx) => { ctx.advance('soon'); }`, num: `(ctx) => { ctx.advance(60); }` }), host));
    assert.deepEqual(r.issues.map(brief), [
      { code: 'snippet.runtime_error', path: ['tests', 'soon', 'script'], hint: 'Invalid duration "soon": expected whole numbers with units in the order d, h, m, s, each at most once, such as 15m, 4h or 1d12h' },
      { code: 'snippet.runtime_error', path: ['tests', 'num', 'script'], hint: "ctx.advance takes a duration such as '15m' or '4h', got 60" },
    ]);
  });
});

describe('check tests layer: a create that collides with a seed row (A-128)', () => {
  const collide = `(ctx) => {
    const res = ctx.api('POST', '/customers', { name: 'Acme', tier: 'free' });
    ctx.assert(res.status === 201, 'create returned ' + res.status);
  }`;

  it('names the seed row the failing create collided with, as test.seed_collision', () => {
    const r = failed(check(withTests({ create_acme: collide }, stubbed()), host));
    assert.deepEqual(r.issues.map(brief), [
      {
        code: 'test.seed_collision',
        path: ['tests', 'create_acme', 'script'],
        hint: 'The test created customer.name "Acme", which seed row cus_0001 already holds. It collides with seed row cus_0001. Change one side: seed rows must avoid values that test scripts create, and a test must create values the seed does not use, or derive them from ctx, for example by reading the seeded rows and adding a suffix.',
      },
      { code: 'layer.blocked', path: ['tasks'], hint: 'Not checked because the tests layer failed. Fix those issues first.' },
    ]);
  });

  it('keeps test.failed when the 409 is a collision with a row the test itself created', () => {
    const r = failed(check(withTests({
      twice: `(ctx) => {
        ctx.api('POST', '/customers', { name: 'Newco', tier: 'free' });
        const again = ctx.api('POST', '/customers', { name: 'Newco', tier: 'free' });
        ctx.assert(again.status === 201, 'second create returned ' + again.status);
      }`,
    }, stubbed()), host));
    assert.deepEqual(r.issues.map((i) => i.code), ['test.failed', 'layer.blocked']);
  });

  it('passes a test that expects the 409 against a seed row', () => {
    const r = check(withTests({
      refuses_duplicate: `(ctx) => {
        const res = ctx.api('POST', '/customers', { name: 'Acme', tier: 'free' });
        ctx.assert(res.status === 409, 'duplicate returned ' + res.status);
      }`,
    }, stubbed()), host);
    assert.equal(ok(r).tests, 1);
  });
});

describe('check tests layer: unexercised actions on a world with too few tasks (A-136)', () => {
  const resolves = `(ctx) => {
    const c = ctx.api('POST', '/customers', { name: 'Test Co', tier: 'free' });
    const t = ctx.api('POST', '/tickets', { customer: c.body.id, subject: 'Help', priority: 'low' });
    ctx.api('PATCH', '/tickets/' + t.body.id, { status: 'pending' });
    const r = ctx.api('POST', '/tickets/' + t.body.id + '/resolve');
    ctx.assert(r.status === 200, 'resolve returned ' + r.status);
  }`;
  const withClose = (base: World): World => ({ ...base, actions: { ...base.actions, close_ticket: { ...base.actions.resolve_ticket!, path: '/tickets/{id}/close' } } });
  const unexercised = (r: Extract<CheckReport, { ok: false }>) =>
    r.warnings.filter((w) => w.code === 'action.unexercised').map((w) => ({ code: w.code, path: w.path, severity: w.severity }));

  it('warns about every action no test calls when the only error is world.too_few_tasks', () => {
    const r = failed(check(withClose(bareWorld()), host));
    assert.equal(r.reached, 'tasks');
    assert.deepEqual(r.issues.map((i) => i.code), ['world.too_few_tasks']);
    assert.deepEqual(unexercised(r), [
      { code: 'action.unexercised', path: ['actions', 'resolve_ticket'], severity: 'warning' },
      { code: 'action.unexercised', path: ['actions', 'close_ticket'], severity: 'warning' },
    ]);
  });

  it('leaves out an action a test calls', () => {
    const r = failed(check(withTests({ resolves }, withClose(bareWorld())), host));
    assert.deepEqual(r.issues.map((i) => i.code), ['world.too_few_tasks']);
    assert.deepEqual(unexercised(r), [{ code: 'action.unexercised', path: ['actions', 'close_ticket'], severity: 'warning' }]);
  });

  it('emits none when a task fails to verify, since its solution calls are unknown', () => {
    const base = withStubTasks(withClose(bareWorld()));
    const broken: World = { ...base, tasks: { stub_easy: { ...base.tasks.stub_easy!, solution: `(ctx) => { ctx.assert(false, 'nope'); }` } } };
    const r = failed(check(broken, host));
    assert.equal(r.reached, 'tasks');
    assert.equal(r.issues.some((i) => i.code === 'world.too_few_tasks'), true);
    assert.equal(r.issues.some((i) => i.code !== 'world.too_few_tasks'), true);
    assert.deepEqual(unexercised(r), []);
  });
});
