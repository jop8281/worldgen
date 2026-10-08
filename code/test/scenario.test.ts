import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { serveScenario, type ScenarioServer } from '../src/scenario/gateway.ts';
import { loadScenario, type LoadedScenario } from '../src/scenario/manifest.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '..');
const SCENARIOS = path.resolve(CODE_DIR, '../prod/scenarios');
const SHIPPED = path.join(SCENARIOS, 'support-payments');
const HELPDESK = path.resolve(CODE_DIR, '../prod/worlds/helpdesk');

async function loadOk(dir: string): Promise<LoadedScenario> {
  const r = await loadScenario(dir);
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  return r.value;
}

const open: ScenarioServer[] = [];
const temps: string[] = [];
async function start(dir = SHIPPED): Promise<ScenarioServer> {
  const s = await serveScenario(await loadOk(dir), { port: 0 });
  open.push(s);
  return s;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((s) => s.close()));
  await Promise.all(temps.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function tempScenario(yaml: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'scenario-'));
  temps.push(dir);
  await writeFile(path.join(dir, 'scenario.yaml'), yaml);
  return dir;
}
const head = `name: t\ndescription: d\nworlds:\n  support: ${HELPDESK}\n`;

type Res = { status: number; body: any };
async function call(base: string, method: string, p: string, body?: unknown): Promise<Res> {
  const r = await fetch(base + p, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }) });
  return { status: r.status, body: await r.json() };
}

async function solveSupport(s: ScenarioServer): Promise<void> {
  const acme = (await call(s.url, 'GET', '/support/customers?q=Acme')).body.data.find((c: any) => c.name === 'Acme Logistics');
  const newest = (await call(s.url, 'GET', `/support/tickets?customer_id=${acme.id}&status=new&sort=-created_at&limit=1`)).body.data[0];
  const priya = (await call(s.url, 'GET', '/support/agents?q=Priya+Raman')).body.data[0];
  const r = await call(s.url, 'POST', `/support/tickets/${newest.id}/assign`, { agent_id: priya.id });
  assert.equal(r.status, 200);
}
async function refund(s: ScenarioServer): Promise<Res> {
  const cedar = (await call(s.url, 'GET', '/payments/v1/customers?q=Cedar')).body.data.find((c: any) => c.name === 'Cedar Analytics');
  const rows = (await call(s.url, 'GET', `/payments/v1/charges?customer=${cedar.id}&status=succeeded&limit=100`)).body.data.filter((c: any) => c.description === 'Order #4821');
  const later = rows.sort((a: any, b: any) => (a.created_at < b.created_at ? 1 : -1))[0];
  return call(s.url, 'POST', '/payments/v1/refunds', { charge: later.id, reason: 'duplicate' });
}
const grade = (s: ScenarioServer): Promise<Res> => call(s.adminUrl, 'POST', '/_scenario/grade');

describe('manifest', () => {
  it('loads the shipped scenario', async () => {
    const v = await loadOk(SHIPPED);
    assert.deepEqual(Object.keys(v.worlds), ['support', 'payments']);
    assert.deepEqual(v.scenario.gates, [
      { world: 'support', task: 'assign_newest_acme_ticket' },
      { world: 'payments', task: 'refund_duplicate_charge' },
    ]);
  });

  it('loads every scenario under prod/scenarios', async () => {
    const dirs = (await readdir(SCENARIOS, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    assert.ok(dirs.includes('support-payments'));
    for (const d of dirs) {
      const r = await loadScenario(path.join(SCENARIOS, d));
      assert.ok(r.ok, `${d}: ${r.ok ? '' : r.errors.join('; ')}`);
    }
  });

  it('reports a gate on an unknown alias', async () => {
    const dir = await tempScenario(`${head}gates:\n  - {world: ghost, task: x}\n`);
    assert.deepEqual(await loadScenario(dir), { ok: false, errors: ['gates[0]: world ghost is not declared in worlds. Worlds: support'] });
  });

  it('reports a missing task with the known tasks', async () => {
    const dir = await tempScenario(`${head}gates:\n  - {world: support, task: nope}\n`);
    const r = await loadScenario(dir);
    assert.ok(!r.ok);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0]!, /^gates\[0\]: world support has no task "nope"\. Tasks: assign_newest_acme_ticket, /);
  });

  it('reports a fault on an unknown alias and a repeated gate, together', async () => {
    const dir = await tempScenario(
      `${head}gates:\n  - {world: support, task: assign_newest_acme_ticket}\n  - {world: support, task: assign_newest_acme_ticket}\nfaults:\n  - {world: ghost, method: GET, path: /x, kind: duplicate}\n`,
    );
    assert.deepEqual(await loadScenario(dir), {
      ok: false,
      errors: [
        'gates[1]: gate support/assign_newest_acme_ticket appears more than once',
        'faults[0]: world ghost is not declared in worlds. Worlds: support',
      ],
    });
  });

  it('refuses an unknown top-level key', async () => {
    const dir = await tempScenario(`${head}gates:\n  - {world: support, task: x}\nextra: 1\n`);
    assert.deepEqual(await loadScenario(dir), { ok: false, errors: ['scenario.yaml: Unrecognized key: "extra"'] });
  });

  it('names the alias and path of a world dir that does not exist', async () => {
    const dir = await tempScenario('name: t\ndescription: d\nworlds:\n  support: ./missing\ngates:\n  - {world: support, task: x}\n');
    const r = await loadScenario(dir);
    assert.ok(!r.ok);
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0]!, new RegExp(`^worlds\\.support: ${path.join(dir, 'missing')}: `));
  });
});

describe('gateway routing', () => {
  it('forwards /<alias>/<rest> with its query to that world', async () => {
    const s = await start();
    const a = await call(s.url, 'GET', '/support/customers?q=Acme');
    assert.equal(a.status, 200);
    assert.ok(a.body.data.some((c: any) => c.id === 'cus_0001' && c.name === 'Acme Logistics'));
    const c = await call(s.url, 'GET', '/payments/v1/customers?q=Cedar');
    assert.equal(c.status, 200);
    assert.ok(c.body.data.some((x: any) => x.id === 'cus_0002' && x.name === 'Cedar Analytics'));
  });

  it('answers 404 for admin routes, scenario routes, unknown aliases and the root', async () => {
    const s = await start();
    assert.equal((await call(s.url, 'GET', '/support/_world/state')).status, 404);
    assert.equal((await call(s.url, 'POST', '/payments/_world/reset')).status, 404);
    assert.equal((await call(s.url, 'GET', '/_scenario/trace')).status, 404);
    const nope = await call(s.url, 'GET', '/nope/x');
    assert.equal(nope.status, 404);
    assert.deepEqual(nope.body, { error: { code: 'route.unknown', message: 'No world at /nope. Worlds: support, payments' } });
    assert.equal((await call(s.url, 'GET', '/')).status, 404);
    assert.deepEqual(await call(s.url, 'GET', '/constructor/x'), {
      status: 404,
      body: { error: { code: 'route.unknown', message: 'No world at /constructor. Worlds: support, payments' } },
    });
    assert.equal((await call(s.url, 'GET', '/toString/x')).status, 404);
  });

  it('answers 413 above the body cap and records nothing', async () => {
    const s = await start();
    const r = await fetch(`${s.url}/support/tickets`, { method: 'POST', body: 'x'.repeat(1_048_577) });
    assert.equal(r.status, 413);
    assert.deepEqual((await call(s.adminUrl, 'GET', '/_scenario/trace')).body, { calls: [] });
  });

  it('keeps the admin port to trace and grade', async () => {
    const s = await start();
    assert.equal((await call(s.adminUrl, 'GET', '/support/customers')).status, 404);
    assert.equal((await call(s.adminUrl, 'GET', '/_scenario/grade')).status, 404);
  });
});

describe('trace', () => {
  it('records each delivery in order, with no refused request', async () => {
    const s = await start();
    await call(s.url, 'GET', '/support/customers?q=Acme');
    await call(s.url, 'GET', '/nope/x');
    await call(s.url, 'GET', '/payments/v1/customers?q=Cedar');
    await call(s.url, 'GET', '/support/tickets/tkt_9999');
    const t = await call(s.adminUrl, 'GET', '/_scenario/trace');
    assert.deepEqual(t.body, {
      calls: [
        { seq: 1, world: 'support', method: 'GET', path: '/customers?q=Acme', status: 200, fault: null },
        { seq: 2, world: 'payments', method: 'GET', path: '/v1/customers?q=Cedar', status: 200, fault: null },
        { seq: 3, world: 'support', method: 'GET', path: '/tickets/tkt_9999', status: 404, fault: null },
      ],
    });
  });
});

describe('faults', () => {
  it('drop_response: the world commits, the agent gets 504, the retry passes through', async () => {
    const s = await start();
    const first = await refund(s);
    assert.equal(first.status, 504);
    assert.deepEqual(first.body, { error: { code: 'gateway.timeout', message: 'The upstream did not answer in time.' } });
    const log = (await call(s.worlds['payments']!.adminUrl, 'GET', '/_world/log')).body.calls.filter((c: any) => c.req.method === 'POST');
    assert.equal(log.length, 1);
    assert.equal(log[0].req.path, '/v1/refunds');
    assert.equal(log[0].res.status, 200);
    const retry = await refund(s);
    assert.equal(retry.status, 409);
    assert.equal(retry.body.error.code, 'charge_already_refunded');
    const calls = (await call(s.adminUrl, 'GET', '/_scenario/trace')).body.calls;
    const posts = calls.filter((c: any) => c.method === 'POST');
    assert.deepEqual(posts, [
      { seq: 3, world: 'payments', method: 'POST', path: '/v1/refunds', status: 200, fault: 'drop_response' },
      { seq: 6, world: 'payments', method: 'POST', path: '/v1/refunds', status: 409, fault: null },
    ]);
  });

  it('duplicate: one agent request is two deliveries', async () => {
    const dir = await tempScenario(
      `${head}gates:\n  - {world: support, task: assign_newest_acme_ticket}\nfaults:\n  - {world: support, method: POST, path: /tickets/tkt_0004/assign, kind: duplicate}\n`,
    );
    const s = await start(dir);
    const r = await call(s.url, 'POST', '/support/tickets/tkt_0004/assign', { agent_id: 'agt_0001' });
    assert.equal(r.status, 200);
    assert.deepEqual((await call(s.adminUrl, 'GET', '/_scenario/trace')).body.calls, [
      { seq: 1, world: 'support', method: 'POST', path: '/tickets/tkt_0004/assign', status: 200, fault: 'duplicate' },
      { seq: 2, world: 'support', method: 'POST', path: '/tickets/tkt_0004/assign', status: 409, fault: 'duplicate' },
    ]);
    const log = (await call(s.worlds['support']!.adminUrl, 'GET', '/_world/log')).body.calls;
    assert.deepEqual(log.map((c: any) => [c.req.method, c.req.path, c.res.status]), [
      ['POST', '/tickets/tkt_0004/assign', 200],
      ['POST', '/tickets/tkt_0004/assign', 409],
    ]);
  });

  it('fires once, on the nth match only', async () => {
    const dir = await tempScenario(
      `${head}gates:\n  - {world: support, task: assign_newest_acme_ticket}\nfaults:\n  - {world: support, method: GET, path: /customers, nth: 2, kind: drop_response}\n`,
    );
    const s = await start(dir);
    const statuses: number[] = [];
    for (let i = 0; i < 3; i += 1) statuses.push((await call(s.url, 'GET', '/support/customers?q=a')).status);
    assert.deepEqual(statuses, [200, 504, 200]);
  });
});

describe('grade', () => {
  it('is 0 with both gates at 0 on a fresh server', async () => {
    const s = await start();
    const g = await grade(s);
    assert.equal(g.status, 200);
    assert.deepEqual(g.body, {
      verdict: 0,
      gates: [
        { world: 'support', task: 'assign_newest_acme_ticket', score: 0 },
        { world: 'payments', task: 'refund_duplicate_charge', score: 0 },
      ],
    });
  });

  it('is 0 with only the support gate met, then 1 once the dropped refund has committed', async () => {
    const s = await start();
    await solveSupport(s);
    assert.deepEqual((await grade(s)).body, {
      verdict: 0,
      gates: [
        { world: 'support', task: 'assign_newest_acme_ticket', score: 1 },
        { world: 'payments', task: 'refund_duplicate_charge', score: 0 },
      ],
    });
    assert.equal((await refund(s)).status, 504);
    assert.deepEqual((await grade(s)).body, {
      verdict: 1,
      gates: [
        { world: 'support', task: 'assign_newest_acme_ticket', score: 1 },
        { world: 'payments', task: 'refund_duplicate_charge', score: 1 },
      ],
    });
  });

  it('stays 1 when the agent retries after the 504 and the world refuses the second refund with 409', async () => {
    const s = await start();
    await solveSupport(s);
    assert.equal((await refund(s)).status, 504);
    assert.equal((await refund(s)).status, 409);
    assert.deepEqual((await grade(s)).body, {
      verdict: 1,
      gates: [
        { world: 'support', task: 'assign_newest_acme_ticket', score: 1 },
        { world: 'payments', task: 'refund_duplicate_charge', score: 1 },
      ],
    });
  });
});

describe('close', () => {
  it('stops the gateway and the admin port, and is safe twice', async () => {
    const s = await start();
    await s.close();
    await s.close();
    await assert.rejects(fetch(`${s.url}/support/customers`));
    await assert.rejects(fetch(`${s.adminUrl}/_scenario/trace`));
  });
});

describe('cli', () => {
  const run = (...args: string[]) => spawnSync(process.execPath, ['src/cli/scenario.ts', ...args], { cwd: CODE_DIR, encoding: 'utf8' });

  it('check prints one summary line', () => {
    const r = run('check', '../prod/scenarios/support-payments');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, 'ok support-payments: 2 worlds (support, payments), 2 gates, 1 fault\n');
  });

  it('check exits 1 and prints each error to stderr', async () => {
    const dir = await tempScenario(`${head}gates:\n  - {world: ghost, task: x}\n`);
    const r = run('check', dir);
    assert.equal(r.status, 1);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, 'gates[0]: world ghost is not declared in worlds. Worlds: support\n');
  });

  it('exits 2 on bad usage', () => {
    assert.equal(run('check').status, 2);
    assert.equal(run('check', '.', '--port', '1').status, 2);
  });

  it('--help exits 0 and names every flag', () => {
    const r = run('--help');
    assert.equal(r.status, 0);
    for (const f of ['--port', '--admin-port', '--help']) assert.ok(r.stdout.includes(f), f);
  });
});
