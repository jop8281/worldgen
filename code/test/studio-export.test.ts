/**
 * The world export zips the private world.yaml, with every grader, solution, decoy and alternative, so only an admin
 * may take it (A-374, YOS-208). Both worlds here have no sensitive field, so the role gate, not sensitivity, is what
 * refuses them: a tenant's own shelf world and a library world, each as a viewer, an operator and another tenant's
 * operator.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { checkWorld, saveWorld, type World } from '#engine';
import type { Runner, Spawner } from '../src/sandboxes/backend.ts';
import { studioServer, type StudioServer, type StudioUser } from '../src/studio/server.ts';
import { minimalWorld } from './helpers/world.ts';

const CANARY = 'EXPORT_GRADER_CANARY_5a1e';
const digest = (token: string): string => createHash('sha256').update(token).digest('hex');
const TOKENS = { viewer: 'ann-acme-viewer', operator: 'otto-acme-operator', foreign: 'gina-globex-operator', admin: 'ada-ops-admin' } as const;
const USERS: readonly StudioUser[] = [
  { name: 'ann', role: 'viewer', tenant: 'acme', tokenSha256: digest(TOKENS.viewer) },
  { name: 'otto', role: 'operator', tenant: 'acme', tokenSha256: digest(TOKENS.operator) },
  { name: 'gina', role: 'operator', tenant: 'globex', tokenSha256: digest(TOKENS.foreign) },
  { name: 'ada', role: 'admin', tenant: 'ops', tokenSha256: digest(TOKENS.admin) },
];

/** minimalWorld with a canary comment in its first grader: the same behaviour, so it still checks. */
function canaryWorld(): World {
  const w = minimalWorld();
  const [id, task] = Object.entries(w.tasks)[0]!;
  return { ...w, tasks: { ...w.tasks, [id]: { ...task, grader: task.grader!.replace('=>', `=> /* ${CANARY} */`) } } };
}

const noSpawn: Spawner = () => {
  throw new Error('no child is spawned in this test');
};
const noRun: Runner = async () => ({ code: 0, stdout: '', stderr: '' });

describe('world export is admin-only (A-374)', () => {
  let root: string;
  let studio: StudioServer;
  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-export-'));
    const worldsDir = path.join(root, 'worlds');
    const report = checkWorld(canaryWorld());
    assert.ok(report.ok, JSON.stringify(report.ok ? [] : report.issues.slice(0, 2)));
    await mkdir(path.join(worldsDir, 'acme'), { recursive: true });
    await saveWorld(path.join(worldsDir, 'acme', 'gen-shelf'), report.world);
    await saveWorld(path.join(worldsDir, 'gen-library'), report.world);
    studio = await studioServer({ port: 0, repoRoot: root, worldsDir, spawner: noSpawn, runner: noRun, users: USERS });
  });
  after(async () => {
    await studio.close();
    await rm(root, { recursive: true, force: true });
  });

  const get = async (p: string, token: string): Promise<{ status: number; type: string | null; bytes: string }> => {
    const res = await fetch(`${studio.url}${p}`, { headers: { authorization: `Bearer ${token}` } });
    return { status: res.status, type: res.headers.get('content-type'), bytes: Buffer.from(await res.arrayBuffer()).toString('latin1') };
  };

  it('refuses every role below admin, on a tenant shelf world and on a library world, and leaks no grader', async () => {
    const asked = [
      ['viewer', '/api/worlds/gen-shelf/export', TOKENS.viewer],
      ['operator', '/api/worlds/gen-shelf/export', TOKENS.operator],
      ['operator, library', '/api/worlds/gen-library/export', TOKENS.operator],
      ['other tenant operator, library', '/api/worlds/gen-library/export', TOKENS.foreign],
    ] as const;
    for (const [who, p, token] of asked) {
      const r = await get(p, token);
      assert.equal(r.bytes.includes(CANARY), false, `${who} got the grader`);
      assert.deepEqual([who, r.status, r.type], [who, 403, 'application/json; charset=utf-8']);
      assert.equal((JSON.parse(r.bytes) as { error: { code: string } }).error.code, 'auth.forbidden');
    }
  });

  it('gives an admin the zip, private world included', async () => {
    for (const p of ['/api/worlds/gen-shelf/export?tenant=acme', '/api/worlds/gen-library/export']) {
      const r = await get(p, TOKENS.admin);
      assert.deepEqual([r.status, r.type], [200, 'application/zip']);
      assert.equal(r.bytes.includes(CANARY), true, p);
    }
  });
});
