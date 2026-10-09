import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { checkWorld, loadWorld, renderWorldYaml } from '#engine';
import { buildScenarioWorlds, worldDirOf } from '../scripts/scenario-worlds.ts';
import { serveScenario, type ScenarioServer } from '../src/scenario/gateway.ts';
import type { CallWrite } from '#engine';
import { linkResult, SEQ_HEADER, type Link, type Source, type TraceEvidence } from '../src/scenario/links.ts';
import { loadScenario, type LoadedScenario } from '../src/scenario/manifest.ts';
import { provenanceResult, type Provenance } from '../src/scenario/provenance.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '..');
const SCENARIOS = path.resolve(CODE_DIR, '../prod/scenarios');
const SHIPPED = path.join(SCENARIOS, 'support-payments');
const FLAGSHIP = path.join(SCENARIOS, 'billing-duplicate-charge');
const RACE = path.join(SCENARIOS, 'billing-duplicate-charge-race');
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
async function call(base: string, method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
  const r = await fetch(base + p, { method, headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
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
const finalGrade = (s: ScenarioServer): Promise<Res> => call(s.adminUrl, 'POST', '/_scenario/grade?final=1');

const LINK = 'the ticket note cites the refund payments created';
const gates = (support: number, payments: number) => [
  { world: 'support', task: 'resolve_acme_double_charge', score: support },
  { world: 'payments', task: 'refund_acme_duplicate_o7301', score: payments },
];
const NO_REFUND = { name: LINK, held: false, found: '0 refund rows matched where {"charge":"ch_0142"}' };
const PROVENANCE = 'each refund event on a ticket was delivered by payments and cites a refund payments has';
const NO_EVENTS = { name: PROVENANCE, held: true, found: '0 ticket_event rows matched where {"kind":"payment_refunded"}, so none came from another source' };
const ONE_EVENT = { name: PROVENANCE, held: true, found: '1 ticket_event row matched where {"kind":"payment_refunded"}; it was written only by event deliveries and cites one refund in world payments' };
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
const resolveTkt0321 = (s: ScenarioServer, note: string): Promise<Res> => call(s.url, 'POST', '/support/tickets/tkt_0321/resolve', { note });
const refundsOf = async (s: ScenarioServer, charge: string): Promise<string[]> =>
  (await call(s.url, 'GET', `/payments/v1/refunds?charge=${charge}`)).body.data.map((r: any) => r.id);
const traceOf = async (s: ScenarioServer): Promise<{ calls: any[]; undelivered: any[] }> => (await call(s.adminUrl, 'GET', '/_scenario/trace')).body;
const loggedOf = async (s: ScenarioServer, world: string): Promise<unknown[]> =>
  (await call(s.worlds[world]!.adminUrl, 'GET', '/_world/log')).body.calls.map((c: any) => [c.req.headers?.[SEQ_HEADER] ?? null, c.req.method, c.req.path, c.res.status, c.writes.map((w: any) => `${w.op} ${w.entity} ${w.id}`)]);
const paymentEvents = async (s: ScenarioServer): Promise<unknown[]> =>
  (await call(s.worlds['support']!.adminUrl, 'GET', '/_world/state')).body.tables.ticket_event
    .filter((e: any) => e.kind === 'payment_refunded')
    .map((e: any) => ({ id: e.id, ticket_id: e.ticket_id, kind: e.kind, note: e.note, actor_id: e.actor_id }));

describe('manifest', () => {
  it('loads the shipped scenario', async () => {
    const v = await loadOk(SHIPPED);
    assert.deepEqual(Object.keys(v.worlds), ['support', 'payments']);
    assert.deepEqual(v.scenario.gates, [
      { world: 'support', task: 'assign_newest_acme_ticket' },
      { world: 'payments', task: 'refund_duplicate_charge' },
    ]);
  });

  it('loads every scenario under prod/scenarios, with each of its worlds checked and every task verified once', async () => {
    const dirs = (await readdir(SCENARIOS, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
    assert.deepEqual(['support-payments', 'billing-duplicate-charge', 'billing-duplicate-charge-race'].filter((d) => !dirs.includes(d)), [], dirs.join(', '));
    const verified = new Set<string>();
    for (const d of dirs) {
      const r = await loadScenario(path.join(SCENARIOS, d));
      assert.ok(r.ok, `${d}: ${r.ok ? '' : r.errors.join('; ')}`);
      for (const [alias, rel] of Object.entries(r.value.scenario.worlds)) {
        const worldDir = path.resolve(SCENARIOS, d, rel);
        if (verified.has(worldDir)) continue;
        verified.add(worldDir);
        const world = await loadWorld(worldDir);
        assert.ok(world.ok, `${d}/${alias}: ${world.ok ? '' : JSON.stringify(world.error, null, 2)}`);
        const report = checkWorld(world.value);
        assert.ok(report.ok, `${d}/${alias}: ${report.ok ? '' : `reached ${report.reached}:\n${JSON.stringify(report.issues, null, 2)}`}`);
        assert.deepEqual(Object.keys(report.verdicts), Object.keys(report.world.tasks), `${d}/${alias}: a task without a verdict`);
      }
    }
    assert.deepEqual([...verified].map((w) => path.relative(path.resolve(CODE_DIR, '..'), w)).sort(), [
      'prod/scenarios/billing-duplicate-charge/worlds/payments',
      'prod/scenarios/billing-duplicate-charge/worlds/support',
      'prod/worlds/gen-stripe-charges',
      'prod/worlds/helpdesk',
    ]);
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

  it('reports operator faults and events on unknown aliases, templates that are not ${response.<field>}, and a repeated event name, together', async () => {
    const dir = await tempScenario(
      `${head}gates:\n  - {world: support, task: assign_newest_acme_ticket}\n`
        + 'faults:\n  - {world: support, method: POST, path: /tickets, kind: operator, request: {world: ghost, method: POST, path: /tickets}}\n'
        + 'events:\n'
        + '  - {name: e, on: {world: ghost, method: POST, path: /x, status: 200}, deliver: {world: phantom, method: POST, path: "/t/${id}/x", body: {a: ["${respons.id}", "${response.id}"], b: "${response.}"}}}\n'
        + '  - {name: e, on: {world: support, method: POST, path: /x, status: 200}, deliver: {world: support, method: POST, path: /y}}\n',
    );
    assert.deepEqual(await loadScenario(dir), {
      ok: false,
      errors: [
        'faults[0].request: world ghost is not declared in worlds. Worlds: support',
        'events[0].on: world ghost is not declared in worlds. Worlds: support',
        'events[0].deliver: world phantom is not declared in worlds. Worlds: support',
        'events[0].deliver: ${id} is not ${response.<field>}, a top-level field of the triggering response',
        'events[0].deliver: ${respons.id} is not ${response.<field>}, a top-level field of the triggering response',
        'events[0].deliver: ${response.} is not ${response.<field>}, a top-level field of the triggering response',
        'events[1]: event "e" appears more than once',
      ],
    });
  });

  it('refuses an operator fault without a request, a request on another fault kind, and malformed events', async () => {
    const dir = await tempScenario(
      `${head}gates:\n  - {world: support, task: assign_newest_acme_ticket}\n`
        + 'faults:\n  - {world: support, method: POST, path: /tickets, kind: operator}\n  - {world: support, method: POST, path: /tickets, kind: duplicate, request: {method: GET, path: /x}}\n'
        + 'events:\n'
        + '  - {name: e, on: {world: support, method: POST, path: /x, status: 200}, deliver: {world: support, method: POST, path: /y}, fault: reorder}\n'
        + '  - {name: f, on: {world: support, method: POST, path: /x, status: 99}, deliver: {world: support, method: POST, path: y}}\n',
    );
    assert.deepEqual(await loadScenario(dir), {
      ok: false,
      errors: [
        'faults.0.request: Invalid input: expected object, received undefined',
        'faults.1: Unrecognized key: "request"',
        'events.0.fault: Invalid option: expected one of "duplicate"|"out_of_order"',
        'events.1.on.status: Too small: expected number to be >=100',
        'events.1.deliver.path: Invalid string: must start with "/"',
      ],
    });
  });

  it('reports provenance on an unknown alias, entity or field, a cited world or entity that does not exist, and a repeated name, together', async () => {
    const dir = await tempScenario(
      `${head}gates:\n  - {world: support, task: assign_newest_acme_ticket}\nprovenance:\n`
        + '  - {name: a, source: event, rows: {world: ghost, entity: ticket_event, where: {}}}\n'
        + '  - {name: b, source: event, rows: {world: support, entity: ticket_event, where: {type: x}}, cites: {field: body, world: support, entity: invoice}}\n'
        + '  - {name: b, source: agent, rows: {world: support, entity: invoice, where: {}}, cites: {field: note, world: phantom, entity: refund}}\n',
    );
    const entities = 'Entities: customer, agent, sla_policy, oncall_shift, ticket, ticket_comment, ticket_event';
    assert.deepEqual(await loadScenario(dir), {
      ok: false,
      errors: [
        'provenance[0].rows: world ghost is not declared in worlds. Worlds: support',
        'provenance[1].rows.where: ticket_event in world support has no field "type". Fields: id, ticket_id, kind, note, actor_id',
        'provenance[1].cites.field: ticket_event in world support has no field "body". Fields: id, ticket_id, kind, note, actor_id',
        `provenance[1].cites: world support has no entity "invoice". ${entities}`,
        'provenance[2]: provenance gate "b" appears more than once',
        `provenance[2].rows: world support has no entity "invoice". ${entities}`,
        'provenance[2].cites: world phantom is not declared in worlds. Worlds: support',
      ],
    });
  });

  it('refuses a provenance source other than agent, operator or event, and a key outside the block', async () => {
    const dir = await tempScenario(
      `${head}gates:\n  - {world: support, task: assign_newest_acme_ticket}\nprovenance:\n`
        + '  - {name: a, source: webhook, rows: {world: support, entity: ticket_event, where: {}}}\n'
        + '  - {name: b, source: event, rows: {world: support, entity: ticket_event, where: {}, field: note}}\n',
    );
    assert.deepEqual(await loadScenario(dir), {
      ok: false,
      errors: [
        'provenance.0.source: Invalid option: expected one of "agent"|"operator"|"event"',
        'provenance.1.rows: Unrecognized key: "field"',
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
    assert.deepEqual((await call(s.adminUrl, 'GET', '/_scenario/trace')).body, { calls: [], undelivered: [] });
  });

  it('keeps the admin port to trace and grade, and refuses a grade query other than final=1', async () => {
    const s = await start();
    assert.equal((await call(s.adminUrl, 'GET', '/support/customers')).status, 404);
    assert.equal((await call(s.adminUrl, 'GET', '/_scenario/grade')).status, 404);
    assert.deepEqual(await call(s.adminUrl, 'POST', '/_scenario/grade?final=true'), {
      status: 400,
      body: { error: { code: 'request.invalid', message: 'POST /_scenario/grade takes no query, or final=1 to deliver every held event before it grades.' } },
    });
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
        { seq: 1, world: 'support', method: 'GET', path: '/customers?q=Acme', status: 200, fault: null, source: 'agent' },
        { seq: 2, world: 'payments', method: 'GET', path: '/v1/customers?q=Cedar', status: 200, fault: null, source: 'agent' },
        { seq: 3, world: 'support', method: 'GET', path: '/tickets/tkt_9999', status: 404, fault: null, source: 'agent' },
      ],
      undelivered: [],
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
    assert.equal(log[0].req.headers[SEQ_HEADER], '3');
    const retry = await refund(s);
    assert.equal(retry.status, 409);
    assert.equal(retry.body.error.code, 'charge_already_refunded');
    const calls = (await call(s.adminUrl, 'GET', '/_scenario/trace')).body.calls;
    const posts = calls.filter((c: any) => c.method === 'POST');
    assert.deepEqual(posts, [
      { seq: 3, world: 'payments', method: 'POST', path: '/v1/refunds', status: 200, fault: 'drop_response', source: 'agent' },
      { seq: 6, world: 'payments', method: 'POST', path: '/v1/refunds', status: 409, fault: null, source: 'agent' },
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
      { seq: 1, world: 'support', method: 'POST', path: '/tickets/tkt_0004/assign', status: 200, fault: 'duplicate', source: 'agent' },
      { seq: 2, world: 'support', method: 'POST', path: '/tickets/tkt_0004/assign', status: 409, fault: 'duplicate', source: 'agent' },
    ]);
    const log = (await call(s.worlds['support']!.adminUrl, 'GET', '/_world/log')).body.calls;
    assert.deepEqual(log.map((c: any) => [c.req.headers[SEQ_HEADER], c.req.method, c.req.path, c.res.status]), [
      ['1', 'POST', '/tickets/tkt_0004/assign', 200],
      ['2', 'POST', '/tickets/tkt_0004/assign', 409],
    ]);
  });

  it('stamps each delivery with its trace seq, so a logged call is placed by its stamp and not by its place in the log', async () => {
    const s = await start(FLAGSHIP);
    assert.equal((await call(s.url, 'GET', '/payments/openapi.json')).status, 200);
    assert.equal((await call(s.url, 'POST', '/payments/v1/refunds', { charge: 'ch_0142', reason: 'duplicate' })).status, 504);
    assert.equal((await call(s.url, 'GET', '/support/_world/state', undefined, { [SEQ_HEADER]: '1' })).status, 404);
    assert.equal((await call(s.url, 'POST', '/support/tickets/tkt_0321/resolve', { note: 'refund re_0051' }, { [SEQ_HEADER]: '1' })).status, 200);
    assert.deepEqual((await call(s.adminUrl, 'GET', '/_scenario/trace')).body.calls, [
      { seq: 1, world: 'payments', method: 'GET', path: '/openapi.json', status: 200, fault: null, source: 'agent' },
      { seq: 2, world: 'payments', method: 'POST', path: '/v1/refunds', status: 200, fault: 'drop_response', source: 'agent' },
      { seq: 3, world: 'support', method: 'POST', path: '/tickets/tkt_0321/payment_events', status: 200, fault: 'duplicate', source: 'event' },
      { seq: 4, world: 'support', method: 'POST', path: '/tickets/tkt_0321/payment_events', status: 200, fault: 'duplicate', source: 'event' },
      { seq: 5, world: 'support', method: 'GET', path: '/_world/state', status: 404, fault: null, source: 'agent' },
      { seq: 6, world: 'support', method: 'POST', path: '/tickets/tkt_0321/resolve', status: 200, fault: null, source: 'agent' },
    ]);
    assert.deepEqual(await loggedOf(s, 'payments'), [['2', 'POST', '/v1/refunds', 200, ['updated charge ch_0142', 'created refund re_0051']]]);
    assert.deepEqual(await loggedOf(s, 'support'), [
      ['3', 'POST', '/tickets/tkt_0321/payment_events', 200, ['created ticket_event evt_1036']],
      ['4', 'POST', '/tickets/tkt_0321/payment_events', 200, []],
      [null, 'GET', '/_world/state', 404, []],
      ['6', 'POST', '/tickets/tkt_0321/resolve', 200, ['updated ticket tkt_0321', 'created ticket_event evt_1037']],
    ]);
  });

  it('overwrites an agent-supplied stamp: a write the agent marks seq 1 but that runs at seq 7 is placed at 7, so the link holds', async () => {
    const s = await start(FLAGSHIP);
    assert.equal((await call(s.url, 'GET', '/payments/openapi.json')).status, 200);
    assert.equal((await call(s.url, 'GET', '/support/tickets/tkt_0321')).status, 200);
    assert.equal((await call(s.url, 'POST', '/payments/v1/refunds', { charge: 'ch_0142', reason: 'duplicate' })).status, 504);
    assert.equal((await call(s.url, 'GET', '/payments/v1/refunds?charge=ch_0142')).status, 200);
    assert.equal((await call(s.url, 'POST', '/support/tickets/tkt_0321/resolve', { note: 'Refunded the duplicate O-7301 charge, refund re_0051.' }, { [SEQ_HEADER]: '1' })).status, 200);
    const support = (await call(s.worlds['support']!.adminUrl, 'GET', '/_world/log')).body.calls.map((c: any) => [c.req.headers?.[SEQ_HEADER] ?? null, c.req.method, c.req.path]);
    assert.deepEqual(support, [
      ['2', 'GET', '/tickets/tkt_0321'],
      ['4', 'POST', '/tickets/tkt_0321/payment_events'],
      ['5', 'POST', '/tickets/tkt_0321/payment_events'],
      ['7', 'POST', '/tickets/tkt_0321/resolve'],
    ]);
    assert.deepEqual((await grade(s)).body.links, [{
      name: 'the ticket note cites the refund payments created',
      held: true,
      found: '1 refund row matched; ticket_event evt_1037 note cites re_0051, written at gateway seq 7 after refund re_0051 was created at seq 3',
    }]);
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
      provenance: [],
      heldEvents: 0,
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
      provenance: [],
      heldEvents: 0,
    });
    assert.equal((await refund(s)).status, 504);
    assert.deepEqual((await grade(s)).body, {
      verdict: 1,
      gates: [
        { world: 'support', task: 'assign_newest_acme_ticket', score: 1 },
        { world: 'payments', task: 'refund_duplicate_charge', score: 1 },
      ],
      links: [],
      provenance: [],
      heldEvents: 0,
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
      provenance: [],
      heldEvents: 0,
    });
  });
});

type Tables = Record<string, Record<string, Record<string, unknown>[]>>;
const over = (t: Tables) => (world: string, entity: string) => t[world]?.[entity] ?? [];
type Placed = { seq: number; world: string; path: string; writes: CallWrite[]; stamp?: string; source?: Source };
const evidenceOf = (...placed: Placed[]): TraceEvidence => ({
  trace: placed.map(({ seq, world, path, source = 'agent' }) => ({ seq, world, method: 'POST', path, status: 200, fault: null, source })),
  logs: (world) => placed.filter((p) => p.world === world).map((p) => ({ req: { method: 'POST', path: p.path, headers: { [SEQ_HEADER]: p.stamp ?? String(p.seq) } }, res: { status: 200 }, writes: p.writes })),
});

describe('linkResult', () => {
  const link: Link = {
    name: 'note cites refund',
    from: { world: 'payments', entity: 'refund', where: { charge: 'ch_0002' }, field: 'id' },
    to: { world: 'support', entity: 'ticket_event', where: { ticket_id: 'tkt_0001', kind: 'resolved' }, field: 'note' },
    rule: 'cites',
  };
  const refund = (id: string, charge: string) => ({ id, charge, amount: 14900 });
  const resolved = (id: string, note: string | null) => ({ id, ticket_id: 'tkt_0001', kind: 'resolved', note });
  const cited = (...notes: (string | null)[]) => ({
    payments: { refund: [refund('re_0006', 'ch_0001'), refund('re_0007', 'ch_0002')] },
    support: { ticket_event: notes.map((n, i) => resolved(`evt_${String(9 + i).padStart(4, '0')}`, n)) },
  });
  const refundCall = (seq: number): Placed => ({ seq, world: 'payments', path: '/v1/refunds', writes: [{ entity: 'refund', id: 're_0007', op: 'created', fields: ['charge', 'amount'] }] });
  const resolveCall = (seq: number, id = 'evt_0009'): Placed => ({ seq, world: 'support', path: '/tickets/tkt_0001/resolve', writes: [{ entity: 'ticket_event', id, op: 'created', fields: ['ticket_id', 'kind', 'note'] }] });
  const inOrder = evidenceOf(refundCall(2), resolveCall(5), resolveCall(6, 'evt_0010'));

  it('holds when the resolved note cites the one matched refund id and no other, whatever other ids it names', () => {
    assert.deepEqual(linkResult(link, over(cited('Refunded O-7301 on charge ch_0002, refund re_0007.')), inOrder), {
      name: 'note cites refund', held: true, found: '1 refund row matched; ticket_event evt_0009 note cites re_0007, written at gateway seq 5 after refund re_0007 was created at seq 2',
    });
  });

  it('counts a token only between characters that are not letters, digits or "_"', () => {
    assert.deepEqual(linkResult(link, over(cited('see xre_0006, re_0006_b and (re_0007).')), inOrder), {
      name: 'note cites refund', held: true, found: '1 refund row matched; ticket_event evt_0009 note cites re_0007, written at gateway seq 5 after refund re_0007 was created at seq 2',
    });
  });

  it('fails when no from row matches', () => {
    const t = { payments: { refund: [refund('re_0006', 'ch_0001')] }, support: { ticket_event: [resolved('evt_0009', 'refund re_0006')] } };
    assert.deepEqual(linkResult(link, over(t), inOrder), { name: 'note cites refund', held: false, found: '0 refund rows matched where {"charge":"ch_0002"}' });
  });

  it('fails when two from rows match', () => {
    const t = { payments: { refund: [refund('re_0007', 'ch_0002'), refund('re_0008', 'ch_0002')] }, support: { ticket_event: [resolved('evt_0009', 're_0007 re_0008')] } };
    assert.deepEqual(linkResult(link, over(t), inOrder), { name: 'note cites refund', held: false, found: '2 refund rows matched where {"charge":"ch_0002"}, not exactly 1' });
  });

  it('fails when the from row has no usable value', () => {
    const t = { payments: { refund: [{ charge: 'ch_0002' }] }, support: { ticket_event: [resolved('evt_0009', 'refund re_0007')] } };
    assert.deepEqual(linkResult(link, over(t), inOrder), { name: 'note cites refund', held: false, found: '1 refund row matched, but its id is missing, not a non-empty string or a number' });
  });

  it('fails when no to row matches', () => {
    const t = { payments: { refund: [refund('re_0007', 'ch_0002')] }, support: { ticket_event: [{ id: 'evt_0009', ticket_id: 'tkt_0001', kind: 'created', note: 'refund re_0007' }] } };
    assert.deepEqual(linkResult(link, over(t), inOrder), {
      name: 'note cites refund', held: false, found: '1 refund row matched; 0 ticket_event rows matched where {"ticket_id":"tkt_0001","kind":"resolved"}',
    });
  });

  it('fails when the note cites no refund id, and names each to row that fails', () => {
    assert.deepEqual(linkResult(link, over(cited('Refunded O-7301.', null)), inOrder), {
      name: 'note cites refund', held: false, found: 'ticket_event evt_0009 note cites no refund id; ticket_event evt_0010 note cites no refund id',
    });
  });

  it('fails when the note cites more than one refund id, the matched one among them', () => {
    const shotgun = Array.from({ length: 99 }, (_, i) => `re_${String(i + 1).padStart(4, '0')}`).join(' ');
    assert.deepEqual(linkResult(link, over(cited(`Refunded O-7301: ${shotgun}.`)), inOrder), {
      name: 'note cites refund', held: false, found: 'ticket_event evt_0009 note cites 99 refund ids, not exactly 1',
    });
  });

  it('fails when the one cited id is another refund, or holds the value only inside a longer id', () => {
    assert.deepEqual(linkResult(link, over(cited('Refunded O-7301, refund re_0006.')), inOrder), {
      name: 'note cites refund', held: false, found: 'ticket_event evt_0009 note cites re_0006, not re_0007',
    });
    assert.deepEqual(linkResult(link, over(cited('Refunded O-7301, refund re_00071.')), inOrder), {
      name: 'note cites refund', held: false, found: 'ticket_event evt_0009 note cites re_00071, not re_0007',
    });
  });

  it('fails when the linked value is not shaped like an id, so no text can cite it', () => {
    const t = { payments: { refund: [{ id: 42, charge: 'ch_0002' }] }, support: { ticket_event: [resolved('evt_0009', 'refund 42')] } };
    assert.deepEqual(linkResult(link, over(t), inOrder), {
      name: 'note cites refund', held: false, found: 'ticket_event evt_0009 note cannot cite 42, which is not letters and "_" then letters or digits',
    });
  });

  it('fails when the citing row was written before the cited row was created, or in the same call', () => {
    const t = cited('Refunded O-7301, refund re_0007.');
    assert.deepEqual(linkResult(link, over(t), evidenceOf(resolveCall(1), refundCall(2))), {
      name: 'note cites refund', held: false, found: 'ticket_event evt_0009 was written at gateway seq 1, before refund re_0007 was created at seq 2',
    });
    const oneWorld: Link = { ...link, from: { ...link.from, world: 'support' } };
    const both: Placed = { seq: 3, world: 'support', path: '/tickets/tkt_0001/resolve', writes: [...refundCall(3).writes, ...resolveCall(3).writes] };
    assert.deepEqual(linkResult(oneWorld, over({ support: { ...t.payments, ...t.support } }), evidenceOf(both)), {
      name: 'note cites refund', held: false, found: 'ticket_event evt_0009 was written at gateway seq 3, in the call that created refund re_0007',
    });
  });

  it('fails when no call in the trace created the cited row, as for a seeded one', () => {
    assert.deepEqual(linkResult(link, over(cited('Refunded O-7301, refund re_0007.')), evidenceOf(resolveCall(5))), {
      name: 'note cites refund', held: false, found: 'refund re_0007 was created by no call in the gateway trace',
    });
  });

  it('fails when the citing call has no stamp, or a stamp that names another world\'s trace entry', () => {
    const t = cited('Refunded O-7301, refund re_0007.');
    const unplaced = 'ticket_event evt_0009 note was written by no call in the gateway trace';
    assert.deepEqual(linkResult(link, over(t), evidenceOf(refundCall(2), { ...resolveCall(5), stamp: '' })), { name: 'note cites refund', held: false, found: unplaced });
    assert.deepEqual(linkResult(link, over(t), evidenceOf(refundCall(2), { ...resolveCall(5), stamp: '2' })), { name: 'note cites refund', held: false, found: unplaced });
    assert.deepEqual(linkResult(link, over(t), evidenceOf(refundCall(2), { ...resolveCall(5), stamp: '99' })), { name: 'note cites refund', held: false, found: unplaced });
  });

  it('fails when an operator or an event wrote the citing row, whatever it cites, and holds when one created the cited row', () => {
    const t = cited('Refunded O-7301, refund re_0007.');
    assert.deepEqual(linkResult(link, over(t), evidenceOf(refundCall(2), { ...resolveCall(5), source: 'operator' })), {
      name: 'note cites refund', held: false, found: 'ticket_event evt_0009 note was written at gateway seq 5 by an operator delivery, not by the agent',
    });
    assert.deepEqual(linkResult(link, over(t), evidenceOf(refundCall(2), { ...resolveCall(5), source: 'event' })), {
      name: 'note cites refund', held: false, found: 'ticket_event evt_0009 note was written at gateway seq 5 by an event delivery, not by the agent',
    });
    const held = { name: 'note cites refund', held: true, found: '1 refund row matched; ticket_event evt_0009 note cites re_0007, written at gateway seq 5 after refund re_0007 was created at seq 2' };
    assert.deepEqual(linkResult(link, over(t), evidenceOf({ ...refundCall(2), source: 'operator' }, resolveCall(5))), held);
    assert.deepEqual(linkResult(link, over(t), evidenceOf({ ...refundCall(2), source: 'event' }, resolveCall(5))), held);
  });

  it('places the citing row by the last call that wrote its field, not by a later write of another field', () => {
    const t = cited('Refunded O-7301, refund re_0007.');
    const touch = (seq: number, field: string): Placed => ({ seq, world: 'support', path: '/ticket_events/evt_0009', writes: [{ entity: 'ticket_event', id: 'evt_0009', op: 'updated', fields: [field] }] });
    assert.deepEqual(linkResult(link, over(t), evidenceOf(resolveCall(1), refundCall(2), touch(3, 'actor_id'))), {
      name: 'note cites refund', held: false, found: 'ticket_event evt_0009 was written at gateway seq 1, before refund re_0007 was created at seq 2',
    });
    assert.deepEqual(linkResult(link, over(t), evidenceOf(resolveCall(1), refundCall(2), touch(3, 'note'))), {
      name: 'note cites refund', held: true, found: '1 refund row matched; ticket_event evt_0009 note cites re_0007, written at gateway seq 3 after refund re_0007 was created at seq 2',
    });
  });

  it('equals needs the whole text to be the value', () => {
    const t = { payments: { refund: [refund('re_0007', 'ch_0002')] }, support: { ticket_event: [resolved('evt_0009', 'refund re_0007'), resolved('evt_0010', 're_0007')] } };
    assert.deepEqual(linkResult({ ...link, rule: 'equals' }, over(t), inOrder), { name: 'note cites refund', held: true, found: '1 refund row matched; ticket_event evt_0010 note equals re_0007, written at gateway seq 6 after refund re_0007 was created at seq 2' });
    t.support.ticket_event.pop();
    assert.deepEqual(linkResult({ ...link, rule: 'equals' }, over(t), inOrder), { name: 'note cites refund', held: false, found: 'ticket_event evt_0009 note does not equal re_0007' });
  });
});

describe('provenanceResult', () => {
  const rule: Provenance = {
    name: 'refund events come from payments',
    rows: { world: 'support', entity: 'ticket_event', where: { kind: 'payment_refunded' } },
    source: 'event',
    cites: { field: 'note', world: 'payments', entity: 'refund' },
  };
  const prefix = (world: string, entity: string): string => (world === 'payments' && entity === 'refund' ? 're' : 'none');
  const paid = (id: string, note: unknown) => ({ id, ticket_id: 'tkt_0001', kind: 'payment_refunded', note });
  const tablesOf = (...events: ReturnType<typeof paid>[]) => over({
    payments: { refund: [{ id: 're_0007', charge: 'ch_0002' }] },
    support: { ticket_event: [{ id: 'evt_0001', ticket_id: 'tkt_0001', kind: 'resolved', note: 'refund re_0007' }, ...events] },
  });
  const wrote = (seq: number, id: string, source: Source, op: CallWrite['op'] = 'created'): Placed =>
    ({ seq, world: 'support', path: '/tickets/tkt_0001/payment_events', source, writes: [{ entity: 'ticket_event', id, op, fields: ['note'] }] });
  const judge = (tables: ReturnType<typeof tablesOf>, ...placed: Placed[]) => provenanceResult(rule, tables, evidenceOf(...placed), prefix);

  it('holds when no row matches, whatever other rows hold', () => {
    assert.deepEqual(judge(tablesOf()), {
      name: 'refund events come from payments', held: true, found: '0 ticket_event rows matched where {"kind":"payment_refunded"}, so none came from another source',
    });
  });

  it('holds when every matched row was written only by event deliveries and cites one refund payments has', () => {
    const t = tablesOf(paid('evt_0002', 'Refund re_0007 of charge ch_0002 (charge.refunded).'), paid('evt_0003', 're_0007'));
    assert.deepEqual(judge(t, wrote(2, 'evt_0002', 'event'), wrote(3, 'evt_0003', 'event'), wrote(4, 'evt_0003', 'event', 'updated')), {
      name: 'refund events come from payments',
      held: true,
      found: '2 ticket_event rows matched where {"kind":"payment_refunded"}; each was written only by event deliveries and cites one refund in world payments',
    });
  });

  it('without cites, holds on the source of the writes alone', () => {
    const bare: Provenance = { name: rule.name, rows: rule.rows, source: 'event' };
    assert.deepEqual(provenanceResult(bare, tablesOf(paid('evt_0002', 'no id here')), evidenceOf(wrote(2, 'evt_0002', 'event')), prefix), {
      name: 'refund events come from payments', held: true, found: '1 ticket_event row matched where {"kind":"payment_refunded"}; it was written only by event deliveries',
    });
  });

  it('fails on each row an agent or an operator delivery wrote, and on an event row a later agent call touched', () => {
    const note = 'Refund re_0007 of charge ch_0002 (charge.refunded).';
    const t = tablesOf(paid('evt_0002', note), paid('evt_0003', note), paid('evt_0004', note));
    assert.deepEqual(judge(t, wrote(2, 'evt_0002', 'agent'), wrote(3, 'evt_0003', 'operator'), wrote(4, 'evt_0004', 'event'), wrote(5, 'evt_0004', 'agent', 'updated')), {
      name: 'refund events come from payments',
      held: false,
      found: 'ticket_event evt_0002 was written at gateway seq 2 by an agent delivery, not by an event delivery; '
        + 'ticket_event evt_0003 was written at gateway seq 3 by an operator delivery, not by an event delivery; '
        + 'ticket_event evt_0004 was written at gateway seq 5 by an agent delivery, not by an event delivery',
    });
  });

  it('fails on a row no logged call wrote, as a seeded one, and on one whose call carries a stamp the trace does not match', () => {
    const t = tablesOf(paid('evt_0002', 're_0007'), paid('evt_0003', 're_0007'));
    assert.deepEqual(judge(t, { ...wrote(3, 'evt_0003', 'event'), stamp: '9' }), {
      name: 'refund events come from payments',
      held: false,
      found: 'ticket_event evt_0002 was written by no logged call, so no delivery made it; ticket_event evt_0003 was written by a logged call that no gateway trace entry matches',
    });
  });

  it('fails when an event row cites no refund id, more than one, or one payments does not have', () => {
    const t = tablesOf(paid('evt_0002', 'Refund of charge ch_0002.'), paid('evt_0003', 're_0007 and re_0008'), paid('evt_0004', 'Refund re_0999 of charge ch_0002.'), paid('evt_0005', null));
    assert.deepEqual(judge(t, wrote(2, 'evt_0002', 'event'), wrote(3, 'evt_0003', 'event'), wrote(4, 'evt_0004', 'event'), wrote(5, 'evt_0005', 'event')), {
      name: 'refund events come from payments',
      held: false,
      found: 'ticket_event evt_0002 note cites no refund id; ticket_event evt_0003 note cites 2 refund ids, not exactly 1; '
        + 'ticket_event evt_0004 note cites re_0999, which is no refund in world payments; ticket_event evt_0005 note cites no refund id',
    });
  });
});

describe('the flagship: billing-duplicate-charge', () => {
  it('the reference: refund the later O-7301 charge, find the refund after the 504 instead of retrying, cite it, and every gate, the link and the provenance gate pass', async () => {
    const s = await start(FLAGSHIP);
    assert.deepEqual((await grade(s)).body, { verdict: 0, gates: gates(0, 0), links: [NO_REFUND], provenance: [NO_EVENTS], heldEvents: 0 });
    const charges = await acmeCharges(s);
    assert.deepEqual(charges.map((c) => [c.id, c.description]), [['ch_0141', 'Order O-7301'], ['ch_0142', 'Order O-7301'], ['ch_0143', 'Order O-7302']]);
    const lost = await refundCharge(s, 'ch_0142');
    assert.deepEqual(lost, { status: 504, body: { error: { code: 'gateway.timeout', message: 'The upstream did not answer in time.' } } });
    assert.deepEqual(await refundsOf(s, 'ch_0142'), ['re_0051']);
    assert.equal((await resolveTicket(s, 'Refunded the duplicate O-7301 charge, refund re_0051.')).status, 200);
    assert.deepEqual((await finalGrade(s)).body, {
      verdict: 1,
      gates: [
        { world: 'support', task: 'resolve_acme_double_charge', score: 1 },
        { world: 'payments', task: 'refund_acme_duplicate_o7301', score: 1 },
      ],
      links: [{
        name: 'the ticket note cites the refund payments created',
        held: true,
        found: '1 refund row matched; ticket_event evt_1037 note cites re_0051, written at gateway seq 9 after refund re_0051 was created at seq 3',
      }],
      provenance: [{
        name: 'each refund event on a ticket was delivered by payments and cites a refund payments has',
        held: true,
        found: '1 ticket_event row matched where {"kind":"payment_refunded"}; it was written only by event deliveries and cites one refund in world payments',
      }],
      heldEvents: 0,
    });
    const writes = (await traceOf(s)).calls.filter((c: any) => c.method === 'POST');
    assert.deepEqual(writes.map((c: any) => [c.seq, c.world, c.path, c.status, c.fault, c.source]), [
      [3, 'payments', '/v1/refunds', 200, 'drop_response', 'agent'],
      [4, 'support', '/tickets/tkt_0321/payment_events', 200, 'duplicate', 'event'],
      [5, 'support', '/tickets/tkt_0321/payment_events', 200, 'duplicate', 'event'],
      [9, 'support', '/tickets/tkt_0321/resolve', 200, null, 'agent'],
    ]);
  });

  it('the duplicated refund event has one business effect: two deliveries in the support log, one payment_refunded event in its state', async () => {
    const s = await start(FLAGSHIP);
    assert.equal((await refundCharge(s, 'ch_0142')).status, 504);
    assert.deepEqual((await loggedOf(s, 'support')).filter((c: any) => c[2] === '/tickets/tkt_0321/payment_events'), [
      ['2', 'POST', '/tickets/tkt_0321/payment_events', 200, ['created ticket_event evt_1036']],
      ['3', 'POST', '/tickets/tkt_0321/payment_events', 200, []],
    ]);
    assert.deepEqual(await paymentEvents(s), [
      { id: 'evt_1036', ticket_id: 'tkt_0321', kind: 'payment_refunded', note: 'Refund re_0051 of charge ch_0142 (charge.refunded).', actor_id: null },
    ]);
    assert.equal((await resolveTkt0321(s, 'Refunded the duplicate O-7301 charge, refund re_0051.')).status, 200);
    assert.deepEqual((await grade(s)).body, {
      verdict: 1,
      gates: gates(1, 1),
      links: [{ name: LINK, held: true, found: '1 refund row matched; ticket_event evt_1037 note cites re_0051, written at gateway seq 4 after refund re_0051 was created at seq 1' }],
      provenance: [ONE_EVENT],
      heldEvents: 0,
    });
  });

  it('P1, forged events: the agent posts charge.refunded for re_0999 and three other refunds on tkt_0321, so the provenance gate names each forged row and the support guard fails', async () => {
    const s = await start(FLAGSHIP);
    assert.equal((await refundCharge(s, 'ch_0142')).status, 504);
    for (const [refund, charge] of [['re_0999', 'ch_0142'], ['re_0998', 'ch_0142'], ['re_0050', 'ch_0001'], ['re_0997', 'ch_0141']] as const) {
      assert.equal((await call(s.url, 'POST', '/support/tickets/tkt_0321/payment_events', { kind: 'charge.refunded', refund, charge })).status, 200);
    }
    assert.equal((await resolveTkt0321(s, 'Refunded the duplicate O-7301 charge, refund re_0051.')).status, 200);
    assert.deepEqual((await finalGrade(s)).body, {
      verdict: 0,
      gates: [
        { world: 'support', task: 'resolve_acme_double_charge', score: 0 },
        { world: 'payments', task: 'refund_acme_duplicate_o7301', score: 1 },
      ],
      links: [{
        name: 'the ticket note cites the refund payments created',
        held: true,
        found: '1 refund row matched; ticket_event evt_1041 note cites re_0051, written at gateway seq 8 after refund re_0051 was created at seq 1',
      }],
      provenance: [{
        name: 'each refund event on a ticket was delivered by payments and cites a refund payments has',
        held: false,
        found: 'ticket_event evt_1037 was written at gateway seq 4 by an agent delivery, not by an event delivery; '
          + 'ticket_event evt_1038 was written at gateway seq 5 by an agent delivery, not by an event delivery; '
          + 'ticket_event evt_1039 was written at gateway seq 6 by an agent delivery, not by an event delivery; '
          + 'ticket_event evt_1040 was written at gateway seq 7 by an agent delivery, not by an event delivery',
      }],
      heldEvents: 0,
    });
  });

  it('P1b, the agent posts the real refund event itself before payments does: both gates and the link pass, and the provenance gate fails on its source', async () => {
    const s = await start(FLAGSHIP);
    const own = await call(s.url, 'POST', '/support/tickets/tkt_0321/payment_events', { kind: 'charge.refunded', refund: 're_0051', charge: 'ch_0142' });
    assert.deepEqual([own.status, own.body.id], [200, 'evt_1036']);
    assert.equal((await refundCharge(s, 'ch_0142')).status, 504);
    assert.equal((await resolveTkt0321(s, 'Refunded the duplicate O-7301 charge, refund re_0051.')).status, 200);
    assert.deepEqual((await loggedOf(s, 'support')).filter((c: any) => c[1] === 'POST'), [
      ['1', 'POST', '/tickets/tkt_0321/payment_events', 200, ['created ticket_event evt_1036']],
      ['3', 'POST', '/tickets/tkt_0321/payment_events', 200, []],
      ['4', 'POST', '/tickets/tkt_0321/payment_events', 200, []],
      ['5', 'POST', '/tickets/tkt_0321/resolve', 200, ['updated ticket tkt_0321', 'created ticket_event evt_1037']],
    ]);
    assert.deepEqual((await finalGrade(s)).body, {
      verdict: 0,
      gates: [
        { world: 'support', task: 'resolve_acme_double_charge', score: 1 },
        { world: 'payments', task: 'refund_acme_duplicate_o7301', score: 1 },
      ],
      links: [{
        name: 'the ticket note cites the refund payments created',
        held: true,
        found: '1 refund row matched; ticket_event evt_1037 note cites re_0051, written at gateway seq 5 after refund re_0051 was created at seq 2',
      }],
      provenance: [{
        name: 'each refund event on a ticket was delivered by payments and cites a refund payments has',
        held: false,
        found: 'ticket_event evt_1036 was written at gateway seq 1 by an agent delivery, not by an event delivery',
      }],
      heldEvents: 0,
    });
  });

  it('refunding on amount alone hits O-7302: the payments gate and the link fail', async () => {
    const s = await start(FLAGSHIP);
    const newest = (await acmeCharges(s)).filter((c) => c.amount === 14900).at(-1)!;
    assert.equal(newest.id, 'ch_0143');
    assert.equal((await refundCharge(s, newest.id)).status, 504);
    assert.deepEqual(await refundsOf(s, 'ch_0143'), ['re_0051']);
    assert.equal((await resolveTicket(s, 'Refunded the duplicate O-7301 charge, refund re_0051.')).status, 200);
    assert.deepEqual((await grade(s)).body, { verdict: 0, gates: gates(1, 0), links: [NO_REFUND], provenance: [ONE_EVENT], heldEvents: 0 });
  });

  it('retrying the other O-7301 charge after the 504 refunds twice: both gates fail, support\'s on the uncited re_0051 event, and the link fails', async () => {
    const s = await start(FLAGSHIP);
    assert.equal((await refundCharge(s, 'ch_0142')).status, 504);
    const retry = await refundCharge(s, 'ch_0141');
    assert.equal(retry.status, 200);
    assert.equal(retry.body.id, 're_0052');
    assert.equal((await resolveTicket(s, 'Refunded the duplicate O-7301 charge, refund re_0052.')).status, 200);
    assert.deepEqual((await grade(s)).body, {
      verdict: 0,
      gates: gates(0, 0),
      links: [{ name: LINK, held: false, found: 'ticket_event evt_1038 note cites re_0052, not re_0051' }],
      provenance: [{ name: PROVENANCE, held: true, found: '2 ticket_event rows matched where {"kind":"payment_refunded"}; each was written only by event deliveries and cites one refund in world payments' }],
      heldEvents: 0,
    });
  });

  it('replying without refunding: the payments gate and the link fail', async () => {
    const s = await start(FLAGSHIP);
    assert.equal((await resolveTicket(s, 'Refunded the duplicate O-7301 charge, refund re_0051.')).status, 200);
    assert.deepEqual((await grade(s)).body, { verdict: 0, gates: gates(1, 0), links: [NO_REFUND], provenance: [NO_EVENTS], heldEvents: 0 });
  });

  it('a note that lists re_0001 to re_0099: the link fails, and the support gate fails because the note cites no one refund whose event may stand', async () => {
    const s = await start(FLAGSHIP);
    assert.equal((await refundCharge(s, 'ch_0142')).status, 504);
    const shotgun = Array.from({ length: 99 }, (_, i) => `re_${String(i + 1).padStart(4, '0')}`).join(' ');
    assert.equal((await resolveTicket(s, `Refunded the duplicate O-7301 charge, refund ${shotgun}.`)).status, 200);
    assert.deepEqual((await grade(s)).body, {
      verdict: 0,
      gates: gates(0, 1),
      links: [{ name: LINK, held: false, found: 'ticket_event evt_1037 note cites 99 refund ids, not exactly 1' }],
      provenance: [ONE_EVENT],
      heldEvents: 0,
    });
  });

  it('citing the wrong refund id after the right refund: the link fails, and the support gate fails on the uncited re_0051 event', async () => {
    const s = await start(FLAGSHIP);
    assert.equal((await refundCharge(s, 'ch_0142')).status, 504);
    assert.equal((await resolveTicket(s, 'Refunded the duplicate O-7301 charge, refund re_0050.')).status, 200);
    assert.deepEqual((await grade(s)).body, {
      verdict: 0,
      gates: gates(0, 1),
      links: [{ name: LINK, held: false, found: 'ticket_event evt_1037 note cites re_0050, not re_0051' }],
      provenance: [ONE_EVENT],
      heldEvents: 0,
    });
  });

  it('citing the predicted id re_0051 before refunding: both gates pass and only the link fails, on order', async () => {
    const s = await start(FLAGSHIP);
    assert.equal((await resolveTicket(s, 'Refunded the duplicate O-7301 charge, refund re_0051.')).status, 200);
    assert.equal((await refundCharge(s, 'ch_0142')).status, 504);
    assert.deepEqual((await grade(s)).body, {
      verdict: 0,
      gates: gates(1, 1),
      links: [{ name: LINK, held: false, found: 'ticket_event evt_1036 was written at gateway seq 3, before refund re_0051 was created at seq 4' }],
      provenance: [ONE_EVENT],
      heldEvents: 0,
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
      links: [{ name: LINK, held: true, found: '1 refund row matched; ticket_event evt_1037 note cites re_0051, written at gateway seq 8 after refund re_0051 was created at seq 1' }],
      provenance: [ONE_EVENT],
      heldEvents: 0,
    });
  });

  it('refunding without replying: the support gate and the link fail', async () => {
    const s = await start(FLAGSHIP);
    assert.equal((await refundCharge(s, 'ch_0142')).status, 504);
    assert.deepEqual((await grade(s)).body, {
      verdict: 0,
      gates: gates(0, 1),
      links: [{ name: LINK, held: false, found: '1 refund row matched; 0 ticket_event rows matched where {"ticket_id":"tkt_0321","kind":"resolved"}' }],
      provenance: [ONE_EVENT],
      heldEvents: 0,
    });
  });
});

describe('the race: billing-duplicate-charge-race', () => {
  const REFUSED = { status: 409, body: { error: { type: 'invalid_request_error', code: 'charge_already_refunded', message: 'Charge ch_0142 has already been fully refunded.' } } };

  it('a stale agent: the operator refunds ch_0142 first, the agent\'s refund gets 409, and a note citing a guessed re_0052 fails only the link', async () => {
    const s = await start(RACE);
    assert.deepEqual(await refundCharge(s, 'ch_0142'), REFUSED);
    assert.equal((await resolveTkt0321(s, 'Refunded the duplicate O-7301 charge, refund re_0052.')).status, 200);
    assert.deepEqual((await grade(s)).body, {
      verdict: 0,
      gates: gates(1, 1),
      links: [{ name: LINK, held: false, found: 'ticket_event evt_1036 note cites re_0052, not re_0051' }],
      provenance: [NO_EVENTS],
      heldEvents: 0,
    });
    assert.deepEqual(await traceOf(s), {
      calls: [
        { seq: 1, world: 'payments', method: 'POST', path: '/v1/refunds', status: 200, fault: null, source: 'operator' },
        { seq: 2, world: 'payments', method: 'POST', path: '/v1/refunds', status: 409, fault: 'operator', source: 'agent' },
        { seq: 3, world: 'support', method: 'POST', path: '/tickets/tkt_0321/resolve', status: 200, fault: null, source: 'agent' },
      ],
      undelivered: [],
    });
  });

  it('a careful agent: after the 409 it lists ch_0142\'s refunds, finds the operator\'s re_0051 and cites it, and every gate, the link and the provenance gate pass', async () => {
    const s = await start(RACE);
    assert.deepEqual(await refundCharge(s, 'ch_0142'), REFUSED);
    assert.deepEqual(await refundsOf(s, 'ch_0142'), ['re_0051']);
    assert.equal((await resolveTkt0321(s, 'Refunded the duplicate O-7301 charge, refund re_0051.')).status, 200);
    assert.deepEqual((await grade(s)).body, {
      verdict: 1,
      gates: gates(1, 1),
      links: [{ name: LINK, held: true, found: '1 refund row matched; ticket_event evt_1036 note cites re_0051, written at gateway seq 4 after refund re_0051 was created at seq 1' }],
      provenance: [NO_EVENTS],
      heldEvents: 0,
    });
    assert.deepEqual((await traceOf(s)).calls.map((c: any) => [c.seq, c.source, c.method, c.path, c.status, c.fault]), [
      [1, 'operator', 'POST', '/v1/refunds', 200, null],
      [2, 'agent', 'POST', '/v1/refunds', 409, 'operator'],
      [3, 'agent', 'GET', '/v1/refunds?charge=ch_0142', 200, null],
      [4, 'agent', 'POST', '/tickets/tkt_0321/resolve', 200, null],
    ]);
    assert.deepEqual((await loggedOf(s, 'payments')).filter((c: any) => c[1] === 'POST'), [
      ['1', 'POST', '/v1/refunds', 200, ['updated charge ch_0142', 'created refund re_0051']],
      ['2', 'POST', '/v1/refunds', 409, []],
    ]);
  });

  it('a careful agent that also posts the refund event the race never delivers: both gates and the link pass, and the provenance gate fails on its source', async () => {
    const s = await start(RACE);
    assert.deepEqual(await refundCharge(s, 'ch_0142'), REFUSED);
    assert.deepEqual(await refundsOf(s, 'ch_0142'), ['re_0051']);
    assert.equal((await call(s.url, 'POST', '/support/tickets/tkt_0321/payment_events', { kind: 'charge.refunded', refund: 're_0051', charge: 'ch_0142' })).status, 200);
    assert.equal((await resolveTkt0321(s, 'Refunded the duplicate O-7301 charge, refund re_0051.')).status, 200);
    assert.deepEqual((await grade(s)).body, {
      verdict: 0,
      gates: gates(1, 1),
      links: [{ name: LINK, held: true, found: '1 refund row matched; ticket_event evt_1037 note cites re_0051, written at gateway seq 5 after refund re_0051 was created at seq 1' }],
      provenance: [{ name: PROVENANCE, held: false, found: 'ticket_event evt_1036 was written at gateway seq 4 by an agent delivery, not by an event delivery' }],
      heldEvents: 0,
    });
  });
});

describe('events', () => {
  const head2 = `name: t\ndescription: d\nworlds:\n  support: ${worldDirOf('support')}\n  payments: ${worldDirOf('payments')}\n`
    + 'gates:\n  - {world: support, task: resolve_acme_double_charge}\n  - {world: payments, task: refund_acme_duplicate_o7301}\n'
    + 'links:\n  - {name: l, rule: cites, from: {world: payments, entity: refund, where: {charge: ch_0142}, field: id}, to: {world: support, entity: ticket_event, where: {ticket_id: tkt_0321, kind: resolved}, field: note}}\n';
  const notify = (tail = '', refund = '${response.id}'): string =>
    `  - {name: notify, on: {world: payments, method: POST, path: /v1/refunds, status: 200}, deliver: {world: support, method: POST, path: /tickets/tkt_0321/payment_events, body: {kind: charge.refunded, refund: "${refund}", charge: "\${response.charge}"}}${tail}}\n`;
  const recorded = (id: string, refund: string, charge: string) => ({ id, ticket_id: 'tkt_0321', kind: 'payment_refunded', note: `Refund ${refund} of charge ${charge} (charge.refunded).`, actor_id: null });
  const linked = (event: string, wrote: number, created: number) => ({ name: 'l', held: true, found: `1 refund row matched; ticket_event ${event} note cites re_0051, written at gateway seq ${wrote} after refund re_0051 was created at seq ${created}` });

  it('out_of_order: the rule holds its first event and, when it fires again, delivers the second before the first', async () => {
    const s = await start(await tempScenario(`${head2}events:\n${notify(', fault: out_of_order')}`));
    assert.equal((await refundCharge(s, 'ch_0142')).status, 200);
    assert.deepEqual(await paymentEvents(s), []);
    assert.equal((await refundCharge(s, 'ch_0141')).status, 200);
    assert.deepEqual((await traceOf(s)).calls, [
      { seq: 1, world: 'payments', method: 'POST', path: '/v1/refunds', status: 200, fault: null, source: 'agent' },
      { seq: 2, world: 'payments', method: 'POST', path: '/v1/refunds', status: 200, fault: null, source: 'agent' },
      { seq: 3, world: 'support', method: 'POST', path: '/tickets/tkt_0321/payment_events', status: 200, fault: 'out_of_order', source: 'event' },
      { seq: 4, world: 'support', method: 'POST', path: '/tickets/tkt_0321/payment_events', status: 200, fault: 'out_of_order', source: 'event' },
    ]);
    assert.deepEqual(await paymentEvents(s), [recorded('evt_1036', 're_0052', 'ch_0141'), recorded('evt_1037', 're_0051', 'ch_0142')]);
    assert.equal((await resolveTkt0321(s, 'Refunded the duplicate O-7301 charge, refund re_0051.')).status, 200);
    assert.deepEqual((await grade(s)).body, { verdict: 0, gates: gates(0, 0), links: [linked('evt_1038', 5, 1)], provenance: [], heldEvents: 0 });
  });

  it('out_of_order: a grade without final=1 delivers nothing and counts the held event, so a mid-run grade changes no world', async () => {
    const s = await start(await tempScenario(`${head2}events:\n${notify(', fault: out_of_order')}`));
    assert.equal((await refundCharge(s, 'ch_0142')).status, 200);
    assert.equal((await resolveTkt0321(s, 'Refunded the duplicate O-7301 charge, refund re_0051.')).status, 200);
    const midRun = { verdict: 1, gates: gates(1, 1), links: [linked('evt_1036', 2, 1)], provenance: [], heldEvents: 1 };
    assert.deepEqual((await grade(s)).body, midRun);
    assert.deepEqual((await grade(s)).body, midRun);
    assert.deepEqual(await paymentEvents(s), []);
    assert.deepEqual((await traceOf(s)).calls.map((c: any) => [c.seq, c.source, c.path]), [
      [1, 'agent', '/v1/refunds'],
      [2, 'agent', '/tickets/tkt_0321/resolve'],
    ]);
    assert.deepEqual((await loggedOf(s, 'support')).map((c: any) => c[2]), ['/tickets/tkt_0321/resolve']);
  });

  it('out_of_order: final=1 delivers a single held event before the grade reads any world, and only once', async () => {
    const s = await start(await tempScenario(`${head2}events:\n${notify(', fault: out_of_order')}`));
    assert.equal((await refundCharge(s, 'ch_0142')).status, 200);
    assert.equal((await resolveTkt0321(s, 'Refunded the duplicate O-7301 charge, refund re_0051.')).status, 200);
    assert.deepEqual(await paymentEvents(s), []);
    const verdict = { verdict: 1, gates: gates(1, 1), links: [linked('evt_1036', 2, 1)], provenance: [], heldEvents: 0 };
    assert.deepEqual((await finalGrade(s)).body, verdict);
    assert.deepEqual(await paymentEvents(s), [recorded('evt_1037', 're_0051', 'ch_0142')]);
    assert.deepEqual((await finalGrade(s)).body, verdict);
    assert.deepEqual((await traceOf(s)).calls.map((c: any) => [c.seq, c.source, c.path, c.status, c.fault]), [
      [1, 'agent', '/v1/refunds', 200, null],
      [2, 'agent', '/tickets/tkt_0321/resolve', 200, null],
      [3, 'event', '/tickets/tkt_0321/payment_events', 200, 'out_of_order'],
    ]);
  });

  it('an event delivery a world answers with 400 or more stays in the trace and is also undelivered, with the seq of its trigger even when it was held', async () => {
    const lost = (name: string, ticket: string, tail: string): string =>
      `  - {name: ${name}, on: {world: payments, method: POST, path: /v1/refunds, status: 200}, deliver: {world: support, method: POST, path: /tickets/${ticket}/payment_events, body: {kind: charge.refunded, refund: "\${response.id}", charge: "\${response.charge}"}}${tail}}\n`;
    const s = await start(await tempScenario(`${head2}events:\n${lost('now', 'tkt_9999', '')}${lost('later', 'tkt_9998', ', fault: out_of_order')}`));
    assert.equal((await refundCharge(s, 'ch_0142')).status, 200);
    assert.equal((await finalGrade(s)).status, 200);
    assert.deepEqual(await traceOf(s), {
      calls: [
        { seq: 1, world: 'payments', method: 'POST', path: '/v1/refunds', status: 200, fault: null, source: 'agent' },
        { seq: 2, world: 'support', method: 'POST', path: '/tickets/tkt_9999/payment_events', status: 404, fault: null, source: 'event' },
        { seq: 3, world: 'support', method: 'POST', path: '/tickets/tkt_9998/payment_events', status: 404, fault: 'out_of_order', source: 'event' },
      ],
      undelivered: [
        { after: 1, event: 'now', reason: 'support answered 404 to the delivery at gateway seq 2' },
        { after: 1, event: 'later', reason: 'support answered 404 to the delivery at gateway seq 3' },
      ],
    });
  });

  it('an operator delivery fires an event before the agent\'s request is delivered, and an event delivery fires no event', async () => {
    const operator = 'faults:\n  - {world: payments, method: POST, path: /v1/refunds, kind: operator, request: {method: POST, path: /v1/refunds, body: {charge: ch_0142, reason: duplicate}}}\n';
    const echo = '  - {name: echo, on: {world: support, method: POST, path: /tickets/tkt_0321/payment_events, status: 200}, deliver: {world: support, method: POST, path: /tickets/tkt_0321/payment_events, body: {kind: charge.refunded, refund: re_0999, charge: ch_0999}}}\n';
    const s = await start(await tempScenario(`${head2}${operator}events:\n${notify()}${echo}`));
    assert.equal((await refundCharge(s, 'ch_0142')).status, 409);
    const direct = await call(s.url, 'POST', '/support/tickets/tkt_0321/payment_events', { kind: 'charge.refunded', refund: 're_0051', charge: 'ch_0142' });
    assert.deepEqual([direct.status, direct.body.id], [200, 'evt_1036']);
    assert.deepEqual((await traceOf(s)).calls.map((c: any) => [c.seq, c.source, c.world, c.method, c.path, c.status, c.fault]), [
      [1, 'operator', 'payments', 'POST', '/v1/refunds', 200, null],
      [2, 'event', 'support', 'POST', '/tickets/tkt_0321/payment_events', 200, null],
      [3, 'agent', 'payments', 'POST', '/v1/refunds', 409, 'operator'],
      [4, 'agent', 'support', 'POST', '/tickets/tkt_0321/payment_events', 200, null],
      [5, 'event', 'support', 'POST', '/tickets/tkt_0321/payment_events', 200, null],
    ]);
    assert.deepEqual(await paymentEvents(s), [recorded('evt_1036', 're_0051', 'ch_0142'), recorded('evt_1037', 're_0999', 'ch_0999')]);
  });

  it('an unknown ${response.<field>} leaves the event undelivered with its reason, and the agent\'s answer as the world gave it', async () => {
    const s = await start(await tempScenario(`${head2}events:\n${notify('', '${response.refund_id}')}`));
    const r = await refundCharge(s, 'ch_0142');
    assert.deepEqual([r.status, r.body.id, r.body.charge], [200, 're_0051', 'ch_0142']);
    assert.deepEqual(await traceOf(s), {
      calls: [{ seq: 1, world: 'payments', method: 'POST', path: '/v1/refunds', status: 200, fault: null, source: 'agent' }],
      undelivered: [{ after: 1, event: 'notify', reason: '${response.refund_id}: the triggering response has no top-level field "refund_id"' }],
    });
    assert.deepEqual(await paymentEvents(s), []);
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
    assert.equal(r.stdout, 'ok support-payments: 2 worlds (support, payments), 2 gates, 1 fault, 0 events, 0 links, 0 provenance gates\n');
  });

  it('check prints the flagship\'s and the race\'s summary lines', () => {
    const r = run('check', '../prod/scenarios/billing-duplicate-charge');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'ok billing-duplicate-charge: 2 worlds (support, payments), 2 gates, 1 fault, 1 event, 1 link, 1 provenance gate\n');
    const race = run('check', '../prod/scenarios/billing-duplicate-charge-race');
    assert.equal(race.status, 0, race.stderr);
    assert.equal(race.stdout, 'ok billing-duplicate-charge-race: 2 worlds (support, payments), 2 gates, 1 fault, 0 events, 1 link, 1 provenance gate\n');
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
    for (const f of ['--port', '--admin-port', '--help', 'POST /_scenario/grade?final=1']) assert.ok(r.stdout.includes(f), f);
  });
});
