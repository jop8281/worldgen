/**
 * The environment of the Studio's generate and iterate children (A-372, YOS-254). They run candidate-world snippets,
 * so they get GENERATION_ENV and their transport's credential, never BOAT_* or ANTHROPIC_*, and the claude CLI still
 * runs under that environment.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { checkWorld, saveWorld } from '#engine';
import type { Runner, SpawnedChild, Spawner } from '../src/sandboxes/backend.ts';
import { generationEnv, studioServer, type StudioServer } from '../src/studio/server.ts';
import { PLAN } from './helpers/scripted-world.ts';
import { minimalWorld } from './helpers/world.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '..');

/** The studio's own environment: what a child needs, beside keys and a canary it must never pass on. */
const PARENT: Readonly<Record<string, string>> = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/studio',
  USER: 'studio',
  TMPDIR: '/tmp/studio',
  CLAUDE_CONFIG_DIR: '/home/studio/.claude',
  CLAUDE_CODE_OAUTH_TOKEN: 'oauth-for-the-claude-cli',
  WORLDGEN_CLAUDE_BIN: '/home/studio/.local/bin/claude',
  WORLDGEN_COSTS_FILE: '/home/studio/.worldgen/costs.jsonl',
  WORLDGEN_MAX_DAILY_USD: '100',
  WORLDGEN_MAX_TOTAL_USD: '200',
  LLM_KEY: 'llm-key-for-sdk-only',
  BOAT_API_KEY: 'boat-key-must-not-pass',
  BOAT_BASE_URL: 'https://api.boat.dev',
  BOAT_USD_PER_COMPUTE_HOUR: '0.05',
  WORLDGEN_BOAT_ORG: 'org_secret',
  ANTHROPIC_API_KEY: 'anthropic-key-must-not-pass',
  WORLDGEN_STUDIO_TOKEN: 'studio-sign-in-token',
  STUDIO_CANARY: 'canary-must-not-pass',
};

const roots: string[] = [];
const studios: StudioServer[] = [];
after(async () => {
  for (const s of studios) await s.close();
  for (const r of roots) await rm(r, { recursive: true, force: true });
});

/** A studio whose spawner records each child's env, over a worlds dir that holds the minimal world as `hand`. */
async function studioWith(transport?: 'claude-cli' | 'sdk'): Promise<{ url: string; envs: Record<string, string | undefined>[] }> {
  const root = await mkdtemp(path.join(tmpdir(), 'studio-model-env-'));
  roots.push(root);
  const worldsDir = path.join(root, 'prod', 'worlds');
  await mkdir(path.join(root, 'code'), { recursive: true });
  const checked = checkWorld(minimalWorld());
  assert.ok(checked.ok);
  await saveWorld(path.join(worldsDir, 'hand'), checked.world);
  const envs: Record<string, string | undefined>[] = [];
  const spawner: Spawner = (_argv, o) => {
    envs.push({ ...o?.env });
    let gone: (code: number | null) => void = () => {};
    const exited = new Promise<number | null>((resolve) => (gone = resolve));
    const child: SpawnedChild = { pid: 46000 + envs.length, exited, kill: () => (gone(null), true), output: () => '' };
    return child;
  };
  const runner: Runner = async (argv) => (argv[0] === 'git' ? { code: 0, stdout: 'abc1234\n', stderr: '' } : { code: 0, stdout: '', stderr: '' });
  const studio = await studioServer({ port: 0, repoRoot: root, worldsDir, spawner, runner, env: PARENT, ...(transport === undefined ? {} : { transport }) });
  studios.push(studio);
  return { url: studio.url, envs };
}

async function post(base: string, p: string, body: unknown): Promise<number> {
  const res = await fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  await res.arrayBuffer();
  return res.status;
}

describe('the environment of a Studio generate or iterate child (A-372)', () => {
  const CLI_KEYS = [
    'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CONFIG_DIR', 'HOME', 'PATH', 'TMPDIR', 'TZ', 'USER',
    'WORLDGEN_CLAUDE_BIN', 'WORLDGEN_COSTS_FILE', 'WORLDGEN_MAX_DAILY_USD', 'WORLDGEN_MAX_TOTAL_USD',
  ];

  it('gives generate and iterate only GENERATION_ENV and the claude CLI token, never Boat, Anthropic, the studio token or a canary', async () => {
    const studio = await studioWith();
    assert.equal(await post(studio.url, '/api/generate', { kind: 'description', text: 'A tiny app', outSlug: 'tiny' }), 200);
    assert.equal(await post(studio.url, '/api/worlds/hand/iterate', { change: 'add a refunds queue' }), 200);
    assert.deepEqual(studio.envs.map((e) => Object.keys(e).sort()), [CLI_KEYS, CLI_KEYS]);
    assert.deepEqual([studio.envs[0]?.['TZ'], studio.envs[0]?.['HOME'], studio.envs[0]?.['WORLDGEN_CLAUDE_BIN']], ['UTC', '/home/studio', '/home/studio/.local/bin/claude']);
  });

  it('gives LLM_KEY, not the claude CLI token, when the studio runs worldgen with --transport sdk', async () => {
    const studio = await studioWith('sdk');
    assert.equal(await post(studio.url, '/api/generate', { kind: 'description', text: 'A tiny app', outSlug: 'tiny' }), 200);
    assert.deepEqual(Object.keys(studio.envs[0] ?? {}).sort(), [
      'CLAUDE_CONFIG_DIR', 'HOME', 'LLM_KEY', 'PATH', 'TMPDIR', 'TZ', 'USER',
      'WORLDGEN_CLAUDE_BIN', 'WORLDGEN_COSTS_FILE', 'WORLDGEN_MAX_DAILY_USD', 'WORLDGEN_MAX_TOTAL_USD',
    ]);
    assert.equal(studio.envs[0]?.['LLM_KEY'], 'llm-key-for-sdk-only');
  });

  it('still runs the default claude -p transport: worldgen finds the CLI and the CLI sees no key it should not', { timeout: 120_000 }, async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'studio-model-env-cli-'));
    roots.push(root);
    const seen = path.join(root, 'claude-env.json');
    const refusal = { ...PLAN, verdict: { kind: 'refuse', why: 'A video codec is computation on frames, not records an agent changes through an API.' }, workflows: [], tasks: [] };
    const bin = path.join(root, 'claude');
    writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
if (process.argv.includes('--version')) { process.stdout.write('2.0.0 (Claude Code)\\n'); process.exit(0); }
fs.writeFileSync(${JSON.stringify(seen)}, JSON.stringify(Object.keys(process.env).sort()));
process.stdin.resume();
process.stdin.on('end', () => process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: ${JSON.stringify(refusal)}, total_cost_usd: 0.0001, usage: { input_tokens: 100, output_tokens: 20 } })));
`);
    chmodSync(bin, 0o755);
    const env = generationEnv({ ...PARENT, PATH: process.env['PATH'] ?? '/usr/bin:/bin', HOME: root, TMPDIR: root, WORLDGEN_CLAUDE_BIN: bin, WORLDGEN_COSTS_FILE: path.join(root, 'costs.jsonl') }, undefined);
    const out = path.join(root, 'gen-codec');
    const r = spawnSync(process.execPath, ['src/cli/worldgen.ts', 'A video codec that encodes frames', '--out', out], { cwd: CODE_DIR, env, encoding: 'utf8', timeout: 110_000 });
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.startsWith('stopped: input_rejected'), r.stderr);
    assert.equal(existsSync(seen), true);
    const keys = JSON.parse(readFileSync(seen, 'utf8')) as string[];
    for (const needed of ['HOME', 'PATH', 'WORLDGEN_CLAUDE_BIN', 'WORLDGEN_COSTS_FILE', 'CLAUDE_CODE_OAUTH_TOKEN']) assert.equal(keys.includes(needed), true, needed);
    for (const never of ['BOAT_API_KEY', 'BOAT_BASE_URL', 'WORLDGEN_BOAT_ORG', 'ANTHROPIC_API_KEY', 'LLM_KEY', 'WORLDGEN_STUDIO_TOKEN', 'STUDIO_CANARY']) assert.equal(keys.includes(never), false, never);
  });
});
