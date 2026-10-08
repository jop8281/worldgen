/**
 * Sensitive fields (A-356). The API console relays a world's answer with every sensitive field masked for any role
 * below admin, and in full for an admin. The world port's own answer is unchanged, and the audit keeps no body.
 * Episode transcripts are masked the same way, a world with a sensitive field exports only for an admin, and a
 * world whose definition cannot be read relays withheld bodies.
 */
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { checkWorld, saveWorld, serve, worldSchema, type World, type WorldServer } from '#engine';
import type { Runner, SpawnedChild, Spawner } from '../src/sandboxes/backend.ts';
import { runLocalEpisode } from '../src/dataset/local.ts';
import { redactor } from '../src/dataset/schema.ts';
import { SENSITIVE_MASK, SENSITIVE_WITHHELD, SENSITIVITY_UNREAD, episodeBelowAdmin, maskSensitive, maskSensitiveText, runEventsBelowAdmin, sensitiveOf } from '../src/studio/explorer.ts';
import { AUDIT_FILE, studioServer, type StudioServer, type StudioUser } from '../src/studio/server.ts';
import { scripted } from './dataset-kit.ts';
import { minimalWorld } from './helpers/world.ts';

const USERS: readonly StudioUser[] = [
  { name: 'vera', role: 'viewer', tenant: 'default', tokenSha256: 'f314e5680966dbe2271774a44be7bb0ddbf8d03612d39be7a19a8d74e285ca2b' },
  { name: 'olga', role: 'operator', tenant: 'default', tokenSha256: '0d8dc9deab36314a0e348de096f11795a300d35258412ffe048c9eecdabb8edd' },
  { name: 'ada', role: 'admin', tenant: 'default', tokenSha256: '86a038a189a3a7d826a98a2a8c1a67489e27c884c7017932b8c70ada02636069' },
];
const VIEWER = 'viewer-token-v1';
const OPERATOR = 'operator-token-o1';
const ADMIN = 'admin-token-a1';

/** The minimal helpdesk with customer.tier marked sensitive. */
function sensitiveWorld(): World {
  const w = minimalWorld() as unknown as { entities: { customer: { fields: { tier: Record<string, unknown> } } } };
  w.entities.customer.fields.tier = { ...w.entities.customer.fields.tier, sensitive: true };
  return worldSchema.parse(w);
}

async function get(base: string, p: string, token: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetch(`${base}${p}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  return { status: res.status, body: res.headers.get('content-type')?.startsWith('application/json') === true ? (JSON.parse(text) as Record<string, unknown>) : null };
}

async function post(base: string, p: string, token: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${p}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('sensitive fields: pure masking', () => {
  const sensitive = sensitiveOf(sensitiveWorld());

  it('maps each entity idPrefix to its sensitive fields', () => {
    assert.deepEqual([...sensitive].map(([prefix, fields]) => [prefix, [...fields]]), [['cus', ['tier']]]);
  });

  it('gives two entities that share an idPrefix the union of their sensitive fields', () => {
    const shared = sensitiveOf({ entities: {
      customer: { idPrefix: 'cus', fields: { tier: { type: 'string', sensitive: true } } },
      contact: { idPrefix: 'cus', fields: { phone: { type: 'string', sensitive: true } } },
    } });
    assert.deepEqual([...shared].map(([prefix, fields]) => [prefix, [...fields]]), [['cus', ['tier', 'phone']]]);
  });

  it('masks the field in list, single and nested rows, and nothing else', () => {
    assert.deepEqual(
      maskSensitive({ data: [{ id: 'cus_0001', name: 'Acme', tier: 'enterprise' }, { id: 'tkt_0001', tier: 'kept' }], next: null }, sensitive),
      { data: [{ id: 'cus_0001', name: 'Acme', tier: SENSITIVE_MASK }, { id: 'tkt_0001', tier: 'kept' }], next: null },
    );
    assert.deepEqual(maskSensitive({ id: 'tkt_0002', customer: { id: 'cus_0002', tier: 'pro' } }, sensitive), { id: 'tkt_0002', customer: { id: 'cus_0002', tier: '[sensitive]' } });
  });

  it('withholds a body it cannot read as JSON, such as one cut at the size limit', () => {
    assert.equal(maskSensitiveText('{"id":"cus_0001","tier":"enterprise"', sensitive), SENSITIVE_WITHHELD);
    assert.equal(maskSensitiveText('{"id":"cus_0001","tier":"enterprise"}', sensitive), '{"id":"cus_0001","tier":"[sensitive]"}');
  });

  it('masks each tool result of an episode, withholds a body kept as text, and withholds every body when the world is unread', () => {
    const episode = { run_id: 'r', messages: [
      { type: 'tool_call', request: { method: 'GET', path: '/customers', query: {} } },
      { type: 'tool_result', body: { data: [{ id: 'cus_0001', tier: 'enterprise' }] }, truncated: false },
      { type: 'tool_result', body: '{"id":"cus_0001","tier":"enter', truncated: true },
      { type: 'tool_result', body: null, truncated: false },
    ] };
    const bodies = (e: unknown): unknown[] => (e as typeof episode).messages.filter((m) => m.type === 'tool_result').map((m) => (m as { body: unknown }).body);
    assert.deepEqual(bodies(episodeBelowAdmin(episode, sensitive)), [{ data: [{ id: 'cus_0001', tier: SENSITIVE_MASK }] }, SENSITIVE_WITHHELD, null]);
    assert.deepEqual(bodies(episodeBelowAdmin(episode, null)), [SENSITIVITY_UNREAD, SENSITIVITY_UNREAD, null]);
    assert.equal(episodeBelowAdmin(episode, new Map()), episode);
  });
});

describe('sensitive fields: the API console relay', () => {
  let root: string;
  let worldsDir: string;
  let world: WorldServer;
  let studio: StudioServer;
  let svc = '';

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-sensitive-'));
    worldsDir = path.join(root, 'worlds');
    const report = checkWorld(sensitiveWorld());
    assert.ok(report.ok);
    await saveWorld(path.join(worldsDir, 'secretive'), report.world);
    world = await serve(report.world, { port: 0 });
    const spawner: Spawner = () => {
      let gone: (code: number | null) => void = () => {};
      const exited = new Promise<number | null>((resolve) => (gone = resolve));
      const child: SpawnedChild = { pid: 4343, exited, kill: () => (gone(null), true), output: () => `{"listening":{"world":${world.port},"admin":${world.adminPort}}}\n` };
      return child;
    };
    const runner: Runner = async () => ({ code: 0, stdout: '', stderr: '' });
    studio = await studioServer({ port: 0, repoRoot: root, worldsDir, spawner, runner, users: USERS });
    const served = await post(studio.url, '/api/worlds/secretive/serve', ADMIN, {});
    assert.equal(served.status, 200, JSON.stringify(served.body));
    svc = String(served.body['id']);
  });
  after(async () => {
    await studio.close();
    await world.close();
    await rm(root, { recursive: true, force: true });
  });

  const tiers = async (token: string, p: string): Promise<unknown> => {
    const r = await post(studio.url, `/api/services/${svc}/call`, token, { method: 'GET', path: p });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const answer = JSON.parse(String(r.body['body'])) as { data?: { id: string; name: string; tier: string }[]; id?: string; tier?: string };
    return answer.data === undefined ? [answer.id, answer.tier] : answer.data.map((c) => [c.id, c.name, c.tier]);
  };

  it('masks a sensitive field for an operator, in a list and in a single row', async () => {
    assert.deepEqual(await tiers(OPERATOR, '/customers'), [
      ['cus_0001', 'Acme', '[sensitive]'], ['cus_0002', 'Globex', '[sensitive]'], ['cus_0003', 'Initech', '[sensitive]'],
      ['cus_0004', 'Umbrella', '[sensitive]'], ['cus_0005', 'Hooli', '[sensitive]'],
    ]);
    assert.deepEqual(await tiers(OPERATOR, '/customers/cus_0001'), ['cus_0001', '[sensitive]']);
  });

  it('shows it in full for an admin, and the world port itself is unchanged', async () => {
    const full = [['cus_0001', 'Acme', 'enterprise'], ['cus_0002', 'Globex', 'pro'], ['cus_0003', 'Initech', 'pro'], ['cus_0004', 'Umbrella', 'free'], ['cus_0005', 'Hooli', 'free']];
    assert.deepEqual(await tiers(ADMIN, '/customers'), full);
    const direct = (await (await fetch(`${world.url}/customers`)).json()) as { data: { id: string; name: string; tier: string }[] };
    assert.deepEqual(direct.data.map((c) => [c.id, c.name, c.tier]), full);
  });

  it('refuses the console to a viewer, and the audit keeps no body', async () => {
    assert.equal((await post(studio.url, `/api/services/${svc}/call`, VIEWER, { method: 'GET', path: '/customers' })).status, 403);
    const lines = (await readFile(path.join(worldsDir, AUDIT_FILE), 'utf8')).trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);
    const calls = lines.filter((l) => String(l['path']).endsWith('/call') && l['status'] === 200);
    assert.ok(calls.length >= 2);
    for (const l of calls) assert.deepEqual(Object.keys(l), ['at', 'user', 'role', 'tenant', 'method', 'path', 'status']);
    assert.equal(lines.some((l) => JSON.stringify(l).includes('enterprise') || JSON.stringify(l).includes(SENSITIVE_MASK)), false);
  });
});

describe('sensitive fields: episodes, export and an unreadable world', () => {
  let root: string;
  let worldsDir: string;
  let world: WorldServer;
  let studio: StudioServer;
  let broken = '';
  let plainSvc = '';

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-sensitive-routes-'));
    worldsDir = path.join(root, 'worlds');
    const report = checkWorld(sensitiveWorld());
    assert.ok(report.ok);
    await saveWorld(path.join(worldsDir, 'secretive'), report.world);
    await mkdir(path.join(worldsDir, 'helpdesk'), { recursive: true });
    await copyFile(path.resolve(import.meta.dirname, '../../prod/worlds/helpdesk/world.yaml'), path.join(worldsDir, 'helpdesk', 'world.yaml'));
    await mkdir(path.join(worldsDir, 'broken'), { recursive: true });
    await writeFile(path.join(worldsDir, 'broken', 'world.yaml'), 'entities: [not a world\n');
    const plain = checkWorld(minimalWorld());
    assert.ok(plain.ok);
    await saveWorld(path.join(worldsDir, 'plain'), plain.world);
    // One real episode on the sensitive world: the agent lists the customers, then finishes.
    await runLocalEpisode({
      worldDir: path.join(worldsDir, 'secretive'), taskId: 'resolve_password_ticket', out: path.join(root, 'eval', 'episodes', 'ep-sens'), runId: 'ep-sens',
      engineCommit: 'abcdef1', model: null, nextTurn: scripted([{ action: 'request', method: 'GET', path: '/customers', query: {} }]),
      maxTurns: 3, budgetUsd: 0.01, maxMinutes: 2, redact: redactor([]),
    });
    world = await serve(report.world, { port: 0 });
    // The serve child reports the sensitive world's ports, whichever world dir it was asked to serve.
    const spawner: Spawner = () => {
      let gone: (code: number | null) => void = () => {};
      const exited = new Promise<number | null>((resolve) => (gone = resolve));
      const child: SpawnedChild = { pid: 4344, exited, kill: () => (gone(null), true), output: () => `{"listening":{"world":${world.port},"admin":${world.adminPort}}}\n` };
      return child;
    };
    const runner: Runner = async () => ({ code: 0, stdout: '', stderr: '' });
    studio = await studioServer({ port: 0, repoRoot: root, worldsDir, spawner, runner, users: USERS });
    const served = await post(studio.url, '/api/worlds/broken/serve', ADMIN, {});
    assert.equal(served.status, 200, JSON.stringify(served.body));
    broken = String(served.body['id']);
    const servedPlain = await post(studio.url, '/api/worlds/plain/serve', ADMIN, {});
    assert.equal(servedPlain.status, 200, JSON.stringify(servedPlain.body));
    plainSvc = String(servedPlain.body['id']);
  });
  after(async () => {
    await studio.close();
    await world.close();
    await rm(root, { recursive: true, force: true });
  });

  /** The customer tiers in the episode's tool result for its GET /customers call, as `token` sees them. */
  const episodeTiers = async (token: string): Promise<unknown> => {
    const r = await get(studio.url, '/api/episodes/ep-sens', token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const messages = (r.body?.['episode'] as { messages: { type: string; body: unknown }[] }).messages;
    const result = messages.find((m) => m.type === 'tool_result');
    return (result?.body as { data: { id: string; tier: string }[] }).data.map((c) => [c.id, c.tier]);
  };

  it('masks a sensitive field in an episode transcript for a viewer and an operator, and shows it to an admin', async () => {
    const masked = [['cus_0001', '[sensitive]'], ['cus_0002', '[sensitive]'], ['cus_0003', '[sensitive]'], ['cus_0004', '[sensitive]'], ['cus_0005', '[sensitive]']];
    assert.deepEqual(await episodeTiers(VIEWER), masked);
    assert.deepEqual(await episodeTiers(OPERATOR), masked);
    assert.deepEqual(await episodeTiers(ADMIN), [['cus_0001', 'enterprise'], ['cus_0002', 'pro'], ['cus_0003', 'pro'], ['cus_0004', 'free'], ['cus_0005', 'free']]);
  });

  it('keeps the episode analytics to counts: no row value reaches a viewer', async () => {
    const r = await get(studio.url, '/api/episodes/analytics', VIEWER);
    assert.equal(r.status, 200);
    assert.equal(r.body?.['episodes'], 1);
    assert.equal(JSON.stringify(r.body).includes('enterprise'), false);
  });

  it('exports a world with a sensitive field only to an admin', async () => {
    const refused = await get(studio.url, '/api/worlds/helpdesk/export', OPERATOR);
    assert.deepEqual([refused.status, (refused.body?.['error'] as { code?: string } | undefined)?.code], [403, 'export.sensitive']);
    assert.equal((await get(studio.url, '/api/worlds/helpdesk/export', VIEWER)).status, 403);
    assert.equal((await get(studio.url, '/api/worlds/helpdesk/export', ADMIN)).status, 200);
  });

  it('fails closed on a world whose definition cannot be read: withheld for an operator, in full for an admin, no export below admin', async () => {
    const call = async (token: string): Promise<string> => {
      const r = await post(studio.url, `/api/services/${broken}/call`, token, { method: 'GET', path: '/customers/cus_0001' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return String(r.body['body']);
    };
    assert.equal(await call(OPERATOR), SENSITIVITY_UNREAD);
    assert.equal((JSON.parse(await call(ADMIN)) as { tier: string }).tier, 'enterprise');
    assert.equal((await get(studio.url, '/api/worlds/broken/export', OPERATOR)).status, 403);
  });

  it('masks an episode by the world it ran on, frozen in its run, even after its world dir holds a world with no sensitive field', async () => {
    const plain = checkWorld(minimalWorld());
    assert.ok(plain.ok);
    await saveWorld(path.join(worldsDir, 'secretive'), plain.world);
    assert.deepEqual(await episodeTiers(OPERATOR), [['cus_0001', '[sensitive]'], ['cus_0002', '[sensitive]'], ['cus_0003', '[sensitive]'], ['cus_0004', '[sensitive]'], ['cus_0005', '[sensitive]']]);
  });

  it('masks a field marked sensitive after the world was served, without a restart', async () => {
    const tier = async (): Promise<string> => {
      const r = await post(studio.url, `/api/services/${plainSvc}/call`, OPERATOR, { method: 'GET', path: '/customers/cus_0001' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      return (JSON.parse(String(r.body['body'])) as { tier: string }).tier;
    };
    assert.equal(await tier(), 'enterprise');
    const marked = checkWorld(sensitiveWorld());
    assert.ok(marked.ok);
    await saveWorld(path.join(worldsDir, 'plain'), marked.world);
    assert.equal(await tier(), SENSITIVE_MASK);
  });
});

/** The minimal helpdesk with ticket.status, a state field, marked sensitive (YOS-252). */
function statusSensitiveWorld(): World {
  const w = minimalWorld() as unknown as { entities: { ticket: { fields: { status: Record<string, unknown> } } } };
  w.entities.ticket.fields.status = { ...w.entities.ticket.fields.status, sensitive: true };
  return worldSchema.parse(w);
}

const REFUSAL = 'ticket tkt_0002 status cannot move from pending to open';
const MESSAGE_WITHHELD = '[withheld: the message names a sensitive field]';
const RUN_WITHHELD = "[withheld: it can quote seed values, and the run's world has a sensitive field or saved none to tell]";
/** A seed rejection that quotes a customer's tier, as a run's events hold it. */
const TIER_ISSUE = { code: 'constraint.violation', severity: 'error', path: ['seed', 'customer'], expected: 'customer.tier to satisfy enum', found: 'row 0, field tier: "platinum"', hint: 'The engine refused this write. Fix the value or the field definition.' };
const RUN_EVENTS = [
  { t: 'attempt', step: 'seed', n: 1, outcome: { kind: 'rejected', issues: [TIER_ISSUE] } },
  { t: 'backtracked', from: 'seed', to: 'model', because: [TIER_ISSUE] },
  { t: 'run_finished', result: { kind: 'stopped', reason: { kind: 'no_progress', step: 'seed', repeatedIssueSet: 'constraint.violation@seed/customer: row 0, field tier: "*"', lastIssues: [TIER_ISSUE] } } },
];
const TIER_WITHHELD = { ...TIER_ISSUE, found: RUN_WITHHELD, hint: RUN_WITHHELD };
const RUN_EVENTS_WITHHELD = [
  { t: 'attempt', step: 'seed', n: 1, outcome: { kind: 'rejected', issues: [TIER_WITHHELD] } },
  { t: 'backtracked', from: 'seed', to: 'model', because: [TIER_WITHHELD] },
  { t: 'run_finished', result: { kind: 'stopped', reason: { kind: 'no_progress', step: 'seed', repeatedIssueSet: RUN_WITHHELD, lastIssues: [TIER_WITHHELD] } } },
];

describe('sensitive fields: refusals and run events, pure (YOS-252, A-367)', () => {
  const status = sensitiveOf(statusSensitiveWorld());

  it('withholds text outside any row that names a sensitive field, such as a state.transition refusal, and leaves a row\'s own text', () => {
    assert.deepEqual(maskSensitive({ error: { code: 'state.transition', message: REFUSAL } }, status), { error: { code: 'state.transition', message: MESSAGE_WITHHELD } });
    assert.deepEqual(maskSensitive({ code: 422, type: 'state.transition', message: REFUSAL }, status), { code: 422, type: 'state.transition', message: MESSAGE_WITHHELD });
    assert.deepEqual(maskSensitive({ id: 'tkt_0002', subject: 'status page is down', status: 'pending' }, status), { id: 'tkt_0002', subject: 'status page is down', status: '[sensitive]' });
    assert.deepEqual(maskSensitive({ error: { code: 'row.not_found', message: 'No ticket tkt_0099; statuses are elsewhere' } }, status),
      { error: { code: 'row.not_found', message: 'No ticket tkt_0099; statuses are elsewhere' } });
    const email = sensitiveOf({ entities: { customer: { idPrefix: 'cus', fields: { email: { type: 'string', sensitive: true } } } } });
    assert.deepEqual(maskSensitive({ error: { code: 'field.unique', message: 'customer.email "ann@example.com" is already used by cus_0003' } }, email),
      { error: { code: 'field.unique', message: MESSAGE_WITHHELD } });
  });

  it('withholds an issue\'s found and hint and a repeated issue set, unless the run\'s world is known to have no sensitive field', () => {
    assert.deepEqual(runEventsBelowAdmin(RUN_EVENTS, sensitiveOf(sensitiveWorld())), RUN_EVENTS_WITHHELD);
    assert.deepEqual(runEventsBelowAdmin(RUN_EVENTS, null), RUN_EVENTS_WITHHELD);
    assert.deepEqual(runEventsBelowAdmin(RUN_EVENTS, sensitiveOf(minimalWorld())), RUN_EVENTS);
  });
});

describe('sensitive fields: a refusal through the API console relay (YOS-252)', () => {
  let root: string;
  let world: WorldServer;
  let studio: StudioServer;
  let svc = '';

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-sensitive-refusal-'));
    const worldsDir = path.join(root, 'worlds');
    const report = checkWorld(statusSensitiveWorld());
    assert.ok(report.ok);
    await saveWorld(path.join(worldsDir, 'stately'), report.world);
    world = await serve(report.world, { port: 0 });
    const spawner: Spawner = () => {
      let gone: (code: number | null) => void = () => {};
      const exited = new Promise<number | null>((resolve) => (gone = resolve));
      const child: SpawnedChild = { pid: 4345, exited, kill: () => (gone(null), true), output: () => `{"listening":{"world":${world.port},"admin":${world.adminPort}}}\n` };
      return child;
    };
    const runner: Runner = async () => ({ code: 0, stdout: '', stderr: '' });
    studio = await studioServer({ port: 0, repoRoot: root, worldsDir, spawner, runner, users: USERS });
    const served = await post(studio.url, '/api/worlds/stately/serve', ADMIN, {});
    assert.equal(served.status, 200, JSON.stringify(served.body));
    svc = String(served.body['id']);
  });
  after(async () => {
    await studio.close();
    await world.close();
    await rm(root, { recursive: true, force: true });
  });

  it('withholds a refusal that names the stored state of a sensitive state field from an operator, and shows it to an admin', async () => {
    const patch = (token: string) => post(studio.url, `/api/services/${svc}/call`, token, { method: 'PATCH', path: '/tickets/tkt_0002', body: { status: 'open' } });
    const asOperator = await patch(OPERATOR);
    assert.deepEqual([asOperator.status, asOperator.body['status'], asOperator.body['body']], [200, 422, `{"error":{"code":"state.transition","message":"${MESSAGE_WITHHELD}"}}`]);
    const asAdmin = await patch(ADMIN);
    assert.deepEqual([asAdmin.status, asAdmin.body['status'], asAdmin.body['body']], [200, 422, `{"error":{"code":"state.transition","message":"${REFUSAL}"}}`]);
  });
});

describe('sensitive fields: a generation run\'s events (A-367)', () => {
  let root: string;
  let worldsDir: string;
  let studio: StudioServer;

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-sensitive-run-'));
    worldsDir = path.join(root, 'worlds');
    const spawner: Spawner = () => ({ pid: 4346, exited: new Promise<number | null>(() => {}), kill: () => true, output: () => '' });
    const runner: Runner = async () => ({ code: 0, stdout: '', stderr: '' });
    studio = await studioServer({ port: 0, repoRoot: root, worldsDir, spawner, runner, users: USERS });
  });
  after(async () => {
    await studio.close();
    await rm(root, { recursive: true, force: true });
  });

  it('withholds issue text from a viewer until the run saves a world with no sensitive field, and shows it to an admin', async () => {
    const begun = await post(studio.url, '/api/generate', OPERATOR, { kind: 'description', text: 'A tiny helpdesk', outSlug: 'secrets' });
    assert.equal(begun.status, 200, JSON.stringify(begun.body));
    const runId = String(begun.body['runId']);
    const outDir = String(begun.body['outDir']);
    const writeEvents = async (dir: string): Promise<void> => {
      await mkdir(path.join(dir, 'runs', runId), { recursive: true });
      await writeFile(path.join(dir, 'runs', runId, 'events.jsonl'), `${RUN_EVENTS.map((e) => JSON.stringify(e)).join('\n')}\n`);
    };
    const events = async (token: string): Promise<unknown> => (await get(studio.url, `/api/generate/${runId}`, token)).body?.['events'];
    // Still building in <out>.partial: no saved world says whether a field is sensitive.
    await writeEvents(`${outDir}.partial`);
    assert.deepEqual(await events(VIEWER), RUN_EVENTS_WITHHELD);
    assert.deepEqual(await events(OPERATOR), RUN_EVENTS_WITHHELD);
    assert.deepEqual(await events(ADMIN), RUN_EVENTS);
    const save = async (w: World): Promise<void> => {
      const report = checkWorld(w);
      assert.ok(report.ok);
      await saveWorld(outDir, report.world);
    };
    await save(sensitiveWorld());
    await writeEvents(outDir);
    assert.deepEqual(await events(VIEWER), RUN_EVENTS_WITHHELD);
    await save(minimalWorld());
    assert.deepEqual(await events(VIEWER), RUN_EVENTS);
  });
});
