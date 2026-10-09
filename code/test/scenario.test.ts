import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { checkWorld, loadWorld, renderWorldYaml } from '#engine';
import { buildScenarioWorlds, worldDirOf } from '../scripts/scenario-worlds.ts';
import { serveScenario, type ScenarioServer } from '../src/scenario/gateway.ts';
import { linkResult, type Link } from '../src/scenario/links.ts';
import { loadScenario, type LoadedScenario } from '../src/scenario/manifest.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '..');
const SCENARIOS = path.resolve(CODE_DIR, '../prod/scenarios');
const SHIPPED = path.join(SCENARIOS, 'support-payments');
const FLAGSHIP = path.join(SCENARIOS, 'billing-duplicate-charge');
const HELPDESK = path.resolve(CODE_DIR, '../prod/worlds/helpdesk');

async function loadOk(dir: string): Promise<LoadedScenario> {
  const r = await loadScenario(dir);
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  return r.value;
}

const open: ScenarioServer[] = [];
const temps: string[] = [];
const loaded = new Map<string, Promise<LoadedScenario>>();
async function start(dir = SHIPPED): Promise<ScenarioServer> {
  let l = loaded.get(dir);
  if (l === undefined) loaded.set(dir, (l = loadOk(dir)));
  const s = await serveScenario(await l, { port: 0 });
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

  it('loads every scenario under prod/scenarios, with each of its worlds checked and every task verified', async () => {
    const dirs = (await readdir(SCENARIOS, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    assert.ok(dirs.includes('support-payments') && dirs.includes('billing-duplicate-charge'), dirs.join(', '));
    for (const d of dirs) {
      const r = await loadScenario(path.join(SCENARIOS, d));
      assert.ok(r.ok, `${d}: ${r.ok ? '' : r.errors.join('; ')}`);
      for (const [alias, rel] of Object.entries(r.value.scenario.worlds)) {
        const world = await loadWorld(path.resolve(SCENARIOS, d, rel));
        assert.ok(world.ok, `${d}/${alias}: ${world.ok ? '' : JSON.stringify(world.error, null, 2)}`);
        const report = checkWorld(world.value);
        assert.ok(report.ok, `${d}/${alias}: ${report.ok ? '' : `reached ${report.reached}:\n${JSON.stringify(report.issues, null, 2)}`}`);
        assert.deepEqual(Object.keys(report.verdicts), Object.keys(report.world.tasks), `${d}/${alias}: a task without a verdict`);
      }
    }
  });

  it('holds the worlds scripts/scenario-worlds.ts builds, with no drift', async () => {
    const built = await buildScenarioWorlds();
    for (const alias of ['support', 'payments'] as const) {
      const committed = await readFile(path.join(worldDirOf(alias), 'world.yaml'), 'utf8');
      assert.equal(committed, renderWorldYaml(built[alias]), `${alias} drifted: run \`bun scripts/scenario-worlds.ts\` from code/ and commit it`);
    }
  });

  it('reports a link on an unknown alias, an unknown entity and unknown fields, together', async () => {
    const to = '{world: support, entity: ticket_event, where: {ticket_id: tkt_0001}, field: note}';
    const dir = await tempScenario(
      `${head}gates:\n  - {world: support, task: assign_newest_acme_ticket}\nlinks:\n`
        + `  - {name: a, rule: cites, from: {world: ghost, entity: refund, where: {}, field: id}, to: ${to}}\n`
        + `  - {name: b, rule: cites, from: {world: support, entity: invoice, where: {}, field: id}, to: ${to}}\n`
        + '  - {name: c, rule: equals, from: {world: support, entity: ticket, where: {id: tkt_0001}, field: id}, to: {world: support, entity: ticket_event, where: {ticket: tkt_0001}, field: body}}\n',
    );
    assert.deepEqual(await loadScenario(dir), {
      ok: false,
      errors: [
        'links[0].from: world ghost is not declared in worlds. Worlds: support',
        'links[1].from: world support has no entity "invoice". Entities: customer, agent, sla_policy, oncall_shift, ticket, ticket_comment, ticket_event',
        'links[2].to.where: ticket_event in world support has no field "ticket". Fields: id, ticket_id, kind, note, actor_id',
        'links[2].to.field: ticket_event in world support has no field "body". Fields: id, ticket_id, kind, note, actor_id',
      ],
    });
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
      links: [],
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
      links: [],
    });
    assert.equal((await refund(s)).status, 504);
    assert.deepEqual((await grade(s)).body, {
      verdict: 1,
      gates: [
        { world: 'support', task: 'assign_newest_acme_ticket', score: 1 },
        { world: 'payments', task: 'refund_duplicate_charge', score: 1 },
      ],
      links: [],
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
      links: [],
    });
  });
});

describe('linkResult', () => {
  const link: Link = {
    name: 'note cites refund',
    from: { world: 'payments', entity: 'refund', where: { charge: 'ch_0002' }, field: 'id' },
    to: { world: 'support', entity: 'ticket_event', where: { ticket_id: 'tkt_0001', kind: 'resolved' }, field: 'note' },
    rule: 'cites',
  };
  type Tables = Record<string, Record<string, Record<string, unknown>[]>>;
  const over = (t: Tables) => (world: string, entity: string) => t[world]?.[entity] ?? [];
  const refund = (id: string, charge: string) => ({ id, charge, amount: 14900 });
  const resolved = (id: string, note: string | null) => ({ id, ticket_id: 'tkt_0001', kind: 'resolved', note });
  const cited = (...notes: (string | null)[]) => ({
    payments: { refund: [refund('re_0006', 'ch_0001'), refund('re_0007', 'ch_0002')] },
    support: { ticket_event: notes.map((n, i) => resolved(`evt_${String(9 + i).padStart(4, '0')}`, n)) },
  });

  it('holds when the resolved note cites the one matched refund id and no other, whatever other ids it names', () => {
    assert.deepEqual(linkResult(link, over(cited('Refunded O-7301 on charge ch_0002, refund re_0007.'))), {
      name: 'note cites refund', held: true, found: '1 refund row matched; ticket_event evt_0009 note cites re_0007',
    });
  });

  it('counts a token only between characters that are not letters, digits or "_"', () => {
    assert.deepEqual(linkResult(link, over(cited('see xre_0006, re_0006_b and (re_0007).'))), {
      name: 'note cites refund', held: true, found: '1 refund row matched; ticket_event evt_0009 note cites re_0007',
    });
  });

  it('fails when no from row matches', () => {
    const t = { payments: { refund: [refund('re_0006', 'ch_0001')] }, support: { ticket_event: [resolved('evt_0009', 'refund re_0006')] } };
    assert.deepEqual(linkResult(link, over(t)), { name: 'note cites refund', held: false, found: '0 refund rows matched where {"charge":"ch_0002"}' });
  });

  it('fails when two from rows match', () => {
    const t = { payments: { refund: [refund('re_0007', 'ch_0002'), refund('re_0008', 'ch_0002')] }, support: { ticket_event: [resolved('evt_0009', 're_0007 re_0008')] } };
    assert.deepEqual(linkResult(link, over(t)), { name: 'note cites refund', held: false, found: '2 refund rows matched where {"charge":"ch_0002"}, not exactly 1' });
  });

  it('fails when the from row has no usable value', () => {
    const t = { payments: { refund: [{ charge: 'ch_0002' }] }, support: { ticket_event: [resolved('evt_0009', 'refund re_0007')] } };
    assert.deepEqual(linkResult(link, over(t)), { name: 'note cites refund', held: false, found: '1 refund row matched, but its id is missing, not a non-empty string or a number' });
  });

  it('fails when no to row matches', () => {
    const t = { payments: { refund: [refund('re_0007', 'ch_0002')] }, support: { ticket_event: [{ id: 'evt_0009', ticket_id: 'tkt_0001', kind: 'created', note: 'refund re_0007' }] } };
    assert.deepEqual(linkResult(link, over(t)), {
      name: 'note cites refund', held: false, found: '1 refund row matched; 0 ticket_event rows matched where {"ticket_id":"tkt_0001","kind":"resolved"}',
    });
  });

  it('fails when the note cites no refund id, and names each to row that fails', () => {
    assert.deepEqual(linkResult(link, over(cited('Refunded O-7301.', null))), {
      name: 'note cites refund', held: false, found: 'ticket_event evt_0009 note cites no refund id; ticket_event evt_0010 note cites no refund id',
    });
  });

  it('fails when the note cites more than one refund id, the matched one among them', () => {
    const shotgun = Array.from({ length: 99 }, (_, i) => `re_${String(i + 1).padStart(4, '0')}`).join(' ');
    assert.deepEqual(linkResult(link, over(cited(`Refunded O-7301: ${shotgun}.`))), {
      name: 'note cites refund', held: false, found: 'ticket_event evt_0009 note cites 99 refund ids, not exactly 1',
    });
  });

  it('fails when the one cited id is another refund, or holds the value only inside a longer id', () => {
    assert.deepEqual(linkResult(link, over(cited('Refunded O-7301, refund re_0006.'))), {
      name: 'note cites refund', held: false, found: 'ticket_event evt_0009 note cites re_0006, not re_0007',
    });
    assert.deepEqual(linkResult(link, over(cited('Refunded O-7301, refund re_00071.'))), {
      name: 'note cites refund', held: false, found: 'ticket_event evt_0009 note cites re_00071, not re_0007',
    });
  });

  it('fails when the linked value is not shaped like an id, so no text can cite it', () => {
    const t = { payments: { refund: [{ id: 42, charge: 'ch_0002' }] }, support: { ticket_event: [resolved('evt_0009', 'refund 42')] } };
    assert.deepEqual(linkResult(link, over(t)), {
      name: 'note cites refund', held: false, found: 'ticket_event evt_0009 note cannot cite 42, which is not letters and "_" then letters or digits',
    });
  });

  it('equals needs the whole text to be the value', () => {
    const t = { payments: { refund: [refund('re_0007', 'ch_0002')] }, support: { ticket_event: [resolved('evt_0009', 'refund re_0007'), resolved('evt_0010', 're_0007')] } };
    assert.deepEqual(linkResult({ ...link, rule: 'equals' }, over(t)), { name: 'note cites refund', held: true, found: '1 refund row matched; ticket_event evt_0010 note equals re_0007' });
    t.support.ticket_event.pop();
    assert.deepEqual(linkResult({ ...link, rule: 'equals' }, over(t)), { name: 'note cites refund', held: false, found: 'ticket_event evt_0009 note does not equal re_0007' });
  });
});

describe('the flagship: billing-duplicate-charge', () => {
  const LINK = 'the ticket note cites the refund payments created';
  const gates = (support: number, payments: number) => [
    { world: 'support', task: 'resolve_acme_double_charge', score: support },
    { world: 'payments', task: 'refund_acme_duplicate_o7301', score: payments },
  ];
  const NO_REFUND = { name: LINK, held: false, found: '0 refund rows matched where {"charge":"ch_0142"}' };

  async function acmeCharges(s: ScenarioServer): Promise<{ id: string; description: string; amount: number }[]> {
    const acme = (await call(s.url, 'GET', '/payments/v1/customers?q=Acme')).body.data.find((c: any) => c.name === 'Acme Logistics');
    const rows = (await call(s.url, 'GET', `/payments/v1/charges?customer=${acme.id}&limit=100`)).body.data;
    return rows.sort((a: any, b: any) => (a.created_at < b.created_at ? -1 : 1));
  }
  const refundCharge = (s: ScenarioServer, charge: string): Promise<Res> => call(s.url, 'POST', '/payments/v1/refunds', { charge, reason: 'duplicate' });
  async function resolveTicket(s: ScenarioServer, note: string): Promise<Res> {
    const acme = (await call(s.url, 'GET', '/support/customers?q=Acme')).body.data.find((c: any) => c.name === 'Acme Logistics');
    const ticket = (await call(s.url, 'GET', `/support/tickets?customer_id=${acme.id}&q=O-7301`)).body.data[0];
    return call(s.url, 'POST', `/support/tickets/${ticket.id}/resolve`, { note });
  }
  const refundsOf = async (s: ScenarioServer, charge: string): Promise<string[]> =>
    (await call(s.url, 'GET', `/payments/v1/refunds?charge=${charge}`)).body.data.map((r: any) => r.id);

  it('the reference: refund the later O-7301 charge, find the refund after the 504 instead of retrying, cite it, and every gate and the link pass', async () => {
    const s = await start(FLAGSHIP);
    assert.deepEqual((await grade(s)).body, { verdict: 0, gates: gates(0, 0), links: [NO_REFUND] });
    const charges = await acmeCharges(s);
    assert.deepEqual(charges.map((c) => [c.id, c.description]), [['ch_0141', 'Order O-7301'], ['ch_0142', 'Order O-7301'], ['ch_0143', 'Order O-7302']]);
    const lost = await refundCharge(s, 'ch_0142');
    assert.deepEqual(lost, { status: 504, body: { error: { code: 'gateway.timeout', message: 'The upstream did not answer in time.' } } });
    assert.deepEqual(await refundsOf(s, 'ch_0142'), ['re_0051']);
    assert.equal((await resolveTicket(s, 'Refunded the duplicate O-7301 charge, refund re_0051.')).status, 200);
    assert.deepEqual((await grade(s)).body, {
      verdict: 1,
      gates: gates(1, 1),
      links: [{ name: LINK, held: true, found: '1 refund row matched; ticket_event evt_1036 note cites re_0051' }],
    });
    const writes = (await call(s.adminUrl, 'GET', '/_scenario/trace')).body.calls.filter((c: any) => c.method === 'POST');
    assert.deepEqual(writes.map((c: any) => [c.world, c.path, c.status, c.fault]), [
      ['payments', '/v1/refunds', 200, 'drop_response'],
      ['support', '/tickets/tkt_0321/resolve', 200, null],
    ]);
  });

  it('refunding on amount alone hits O-7302: the payments gate and the link fail', async () => {
    const s = await start(FLAGSHIP);
    const newest = (await acmeCharges(s)).filter((c) => c.amount === 14900).at(-1)!;
    assert.equal(newest.id, 'ch_0143');
    assert.equal((await refundCharge(s, newest.id)).status, 504);
    assert.deepEqual(await refundsOf(s, 'ch_0143'), ['re_0051']);
    assert.equal((await resolveTicket(s, 'Refunded the duplicate O-7301 charge, refund re_0051.')).status, 200);
    assert.deepEqual((await grade(s)).body, { verdict: 0, gates: gates(1, 0), links: [NO_REFUND] });
  });

  it('retrying the other O-7301 charge after the 504 refunds twice: the payments gate and the link fail', async () => {
    const s = await start(FLAGSHIP);
    assert.equal((await refundCharge(s, 'ch_0142')).status, 504);
    const retry = await refundCharge(s, 'ch_0141');
    assert.equal(retry.status, 200);
    assert.equal(retry.body.id, 're_0052');
    assert.equal((await resolveTicket(s, 'Refunded the duplicate O-7301 charge, refund re_0052.')).status, 200);
    assert.deepEqual((await grade(s)).body, {
      verdict: 0,
      gates: gates(1, 0),
      links: [{ name: LINK, held: false, found: 'ticket_event evt_1036 note cites re_0052, not re_0051' }],
    });
  });

  it('replying without refunding: the payments gate and the link fail', async () => {
    const s = await start(FLAGSHIP);
    assert.equal((await resolveTicket(s, 'Refunded the duplicate O-7301 charge, refund re_0051.')).status, 200);
    assert.deepEqual((await grade(s)).body, { verdict: 0, gates: gates(1, 0), links: [NO_REFUND] });
  });

  it('a note that lists re_0001 to re_0099: the link fails, and the support gate keeps only its resolve half', async () => {
    const s = await start(FLAGSHIP);
    assert.equal((await refundCharge(s, 'ch_0142')).status, 504);
    const shotgun = Array.from({ length: 99 }, (_, i) => `re_${String(i + 1).padStart(4, '0')}`).join(' ');
    assert.equal((await resolveTicket(s, `Refunded the duplicate O-7301 charge, refund ${shotgun}.`)).status, 200);
    assert.deepEqual((await grade(s)).body, {
      verdict: 0,
      gates: gates(0.5, 1),
      links: [{ name: LINK, held: false, found: 'ticket_event evt_1036 note cites 99 refund ids, not exactly 1' }],
    });
  });

  it('citing the wrong refund id after the right refund: both gates pass and only the link fails', async () => {
    const s = await start(FLAGSHIP);
    assert.equal((await refundCharge(s, 'ch_0142')).status, 504);
    assert.equal((await resolveTicket(s, 'Refunded the duplicate O-7301 charge, refund re_0050.')).status, 200);
    assert.deepEqual((await grade(s)).body, {
      verdict: 0,
      gates: gates(1, 1),
      links: [{ name: LINK, held: false, found: 'ticket_event evt_1036 note cites re_0050, not re_0051' }],
    });
  });

  it('a limit: citing the predicted id re_0051 before refunding passes, because the link does not order the two writes', async () => {
    const s = await start(FLAGSHIP);
    assert.equal((await resolveTicket(s, 'Refunded the duplicate O-7301 charge, refund re_0051.')).status, 200);
    assert.equal((await refundCharge(s, 'ch_0142')).status, 504);
    assert.deepEqual((await grade(s)).body, {
      verdict: 1,
      gates: gates(1, 1),
      links: [{ name: LINK, held: true, found: '1 refund row matched; ticket_event evt_1036 note cites re_0051' }],
    });
  });

  it('a limit: a blind retry on the same charge after the 504 is refused with 409 and still scores 1', async () => {
    const s = await start(FLAGSHIP);
    assert.equal((await refundCharge(s, 'ch_0142')).status, 504);
    const retry = await refundCharge(s, 'ch_0142');
    assert.equal(retry.status, 409);
    assert.equal(retry.body.error.code, 'charge_already_refunded');
    assert.deepEqual(await refundsOf(s, 'ch_0142'), ['re_0051']);
    assert.equal((await resolveTicket(s, 'Refunded the duplicate O-7301 charge, refund re_0051.')).status, 200);
    assert.deepEqual((await grade(s)).body, {
      verdict: 1,
      gates: gates(1, 1),
      links: [{ name: LINK, held: true, found: '1 refund row matched; ticket_event evt_1036 note cites re_0051' }],
    });
  });

  it('refunding without replying: the support gate and the link fail', async () => {
    const s = await start(FLAGSHIP);
    assert.equal((await refundCharge(s, 'ch_0142')).status, 504);
    assert.deepEqual((await grade(s)).body, {
      verdict: 0,
      gates: gates(0, 1),
      links: [{ name: LINK, held: false, found: '1 refund row matched; 0 ticket_event rows matched where {"ticket_id":"tkt_0321","kind":"resolved"}' }],
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
    assert.equal(r.stdout, 'ok support-payments: 2 worlds (support, payments), 2 gates, 1 fault, 0 links\n');
  });

  it('check prints the flagship\'s summary line', () => {
    const r = run('check', '../prod/scenarios/billing-duplicate-charge');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'ok billing-duplicate-charge: 2 worlds (support, payments), 2 gates, 1 fault, 1 link\n');
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
