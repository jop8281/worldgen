/**
 * Sensitive fields (A-356). The API console relays a world's answer with every sensitive field masked for any role
 * below admin, and in full for an admin. The world port's own answer is unchanged, and the audit keeps no body.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { checkWorld, saveWorld, serve, worldSchema, type World, type WorldServer } from '#engine';
import type { Runner, SpawnedChild, Spawner } from '../src/sandboxes/backend.ts';
import { SENSITIVE_MASK, SENSITIVE_WITHHELD, maskSensitive, maskSensitiveText, sensitiveOf } from '../src/studio/explorer.ts';
import { AUDIT_FILE, studioServer, type StudioServer, type StudioUser } from '../src/studio/server.ts';
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

async function post(base: string, p: string, token: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`${base}${p}`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('sensitive fields: pure masking', () => {
  const sensitive = sensitiveOf(sensitiveWorld());

  it('maps each entity idPrefix to its sensitive fields', () => {
    assert.deepEqual([...sensitive].map(([prefix, fields]) => [prefix, [...fields]]), [['cus', ['tier']]]);
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
