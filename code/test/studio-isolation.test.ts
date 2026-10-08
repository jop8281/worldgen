/**
 * The studio never runs a world's snippets itself (A-338). The Explorer's check and the proof run
 * in one-shot children whose environment is an allowlist, so a snippet never sits beside the web
 * process's credentials, and a check that hangs cannot block the API.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { parse, stringify } from 'yaml';
import { checkWorld, saveWorld } from '#engine';
import { nodeRunner, type RunOpts, type Runner, type Spawner } from '../src/sandboxes/backend.ts';
import { studioServer, type StudioServer } from '../src/studio/server.ts';
import { minimalWorld } from './helpers/world.ts';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const noSpawner: Spawner = () => {
  throw new Error('no child is spawned in this test');
};

async function writeGood(dir: string): Promise<void> {
  const report = checkWorld(minimalWorld());
  assert.ok(report.ok);
  await mkdir(dir, { recursive: true });
  await saveWorld(dir, report.world);
}

describe('studio isolation: the check and proof children', () => {
  let root: string;
  let worldsDir: string;
  let server: StudioServer | undefined;

  before(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'studio-isolation-'));
    worldsDir = path.join(root, 'worlds');
    await writeGood(path.join(worldsDir, 'good'));
    // A world whose check hangs: saveWorld wants a checked world, so add the test to the saved yaml.
    const hang = path.join(worldsDir, 'hang');
    await writeGood(hang);
    const doc = parse(await readFile(path.join(hang, 'world.yaml'), 'utf8')) as Record<string, unknown>;
    doc['tests'] = { spin: { description: 'Never returns.', script: '(ctx) => { for (;;) {} }' } };
    await writeFile(path.join(hang, 'world.yaml'), stringify(doc));
  });

  after(async () => {
    await server?.close();
    await rm(root, { recursive: true, force: true });
  });

  it('builds both children from an allowlisted environment', async () => {
    const seen: { argv: readonly string[]; opts: RunOpts | undefined }[] = [];
    const runner: Runner = async (argv, opts) => {
      seen.push({ argv: [...argv], opts });
      if (argv.some((a) => a.includes('src/cli/studio-check.ts'))) return { code: 0, stdout: '{"wid":"wid_x"}\n', stderr: '' };
      return { code: 0, stdout: '{"task":"t","verified":true}\n', stderr: '' };
    };
    const env = {
      PATH: '/usr/bin:/bin',
      HOME: '/home/op',
      LLM_KEY: 'sk-live-1',
      ANTHROPIC_API_KEY: 'sk-ant-2',
      BOAT_API_KEY: 'boat-3',
      WORLDGEN_STUDIO_TOKEN: 'tok-4',
      AWS_SECRET_ACCESS_KEY: 'aws-5',
      WORLDGEN_GUARD_SCALE: '4',
    };
    const s = await studioServer({ port: 0, repoRoot: root, worldsDir, spawner: noSpawner, runner, env });
    try {
      const ex = await fetch(`${s.url}/api/worlds/good/explorer`);
      assert.equal(ex.status, 200);
      const pr = await fetch(`${s.url}/api/worlds/good/proof`, { method: 'POST' });
      assert.equal(pr.status, 200);
    } finally {
      await s.close();
    }
    const check = seen.find((c) => c.argv.includes('src/cli/studio-check.ts'));
    const proof = seen.find((c) => c.argv.includes('verify'));
    assert.ok(check !== undefined, 'explorer never ran the check child');
    assert.ok(proof !== undefined);
    assert.deepEqual(check.argv, ['bun', 'src/cli/studio-check.ts', path.join(worldsDir, 'good'), 'good']);
    const expected = { TZ: 'UTC', PATH: '/usr/bin:/bin', WORLDGEN_GUARD_SCALE: '4' };
    assert.deepEqual(check.opts?.env, expected);
    assert.deepEqual(proof.opts?.env, expected);
  });

  it('starts one check child for concurrent requests to the same unchecked world', async () => {
    let calls = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const runner: Runner = async () => {
      calls += 1;
      await gate;
      return { code: 0, stdout: '{"wid":"wid_once"}\n', stderr: '' };
    };
    const s = await studioServer({ port: 0, repoRoot: root, worldsDir, spawner: noSpawner, runner, env: { PATH: '/usr/bin' } });
    try {
      const both = [fetch(`${s.url}/api/worlds/good/explorer`), fetch(`${s.url}/api/worlds/good/explorer`)];
      while (calls === 0) await new Promise((resolve) => setTimeout(resolve, 10));
      await new Promise((resolve) => setTimeout(resolve, 200));
      release();
      const answers = await Promise.all(both.map(async (r) => [(await r).status, await (await r).json()]));
      assert.deepEqual(answers, [[200, { wid: 'wid_once' }], [200, { wid: 'wid_once' }]]);
      assert.equal(calls, 1);
    } finally {
      await s.close();
    }
  });

  it('keeps the API answering while a hanging world is checked', async () => {
    server = await studioServer({ port: 0, repoRoot: REPO_ROOT, worldsDir, spawner: noSpawner, runner: nodeRunner });
    const base = server.url;
    let pending = true;
    const explorer = fetch(`${base}/api/worlds/hang/explorer`).then(async (r) => {
      pending = false;
      return { status: r.status, body: (await r.json()) as { error?: { code?: string; message?: string } } };
    });
    const health: { status: number; ms: number }[] = [];
    while (pending) {
      const t0 = performance.now();
      const r = await fetch(`${base}/api/health`);
      const ms = performance.now() - t0;
      if (pending) health.push({ status: r.status, ms });
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const answer = await explorer;
    assert.equal(answer.status, 422);
    assert.equal(answer.body.error?.code, 'world.invalid');
    const message = answer.body.error?.message ?? '';
    assert.ok(message.includes('snippet.timeout_guard'), message);
    assert.ok(message.length <= 300);
    assert.ok(health.length >= 3, `only ${health.length} health answers while pending`);
    assert.ok(health.every((h) => h.status === 200));
    assert.ok(Math.max(...health.map((h) => h.ms)) < 1000, `slowest health took ${Math.max(...health.map((h) => h.ms))} ms`);
  });
});
