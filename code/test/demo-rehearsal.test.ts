import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

const scripts = path.resolve(import.meta.dirname, '../../scripts');
/** Real Git/worktrees and shell; Bun installation and product demo are explicitly simulated. */
function fixture(check: (f: { run: (mode: string, extra?: Record<string, string>) => ReturnType<typeof spawnSync>; home: string; demo: string; sha: string; calls: string }) => void) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'demo rehearsal fixture '));
  const repo = path.join(dir, 'repo'), home = path.join(dir, 'home'), bin = path.join(dir, 'bin');
  try {
    for (const sub of [repo, home, bin, `${repo}/scripts`, `${repo}/code`]) mkdirSync(sub, { recursive: true });
    for (const file of ['runner.sh', 'demo-rehearsal.sh']) copyFileSync(path.join(scripts, file), path.join(repo, 'scripts', file));
    writeFileSync(path.join(repo, '.gitignore'), 'code/node_modules/\n');
    writeFileSync(path.join(repo, 'code/package.json'), '{}\n');
    writeFileSync(path.join(repo, 'code/bun.lock'), 'fixture lock\n');
    writeFileSync(path.join(repo, 'scripts/solve-demo.sh'), '#!/bin/sh\nexit 0\n');
    writeFileSync(path.join(repo, 'scripts/demo-all.sh'), `#!/bin/sh
[ "$#" = 0 ] && [ "$WORLDGEN_RUNTIME" = bun ] && [ -z "\${BOAT_API_KEY:-}" ] && [ -z "\${LLM_KEY:-}" ] || exit 98
printf 'demo invoked\\n' >>"$DEMO_CALLS"
case "$DEMO_TEST_RESULT" in
 fail) echo '24 passed, 1 failed, 1s'; exit 7 ;;
 partial) echo '24 passed, 0 failed, 1s' ;;
 *) echo '25 passed, 0 failed, 1s' ;;
esac
`);
    for (const world of ['helpdesk', 'gen-rental-fleet', 'gen-stripe-charges', 'gen-library-loans', 'gen-repair-desk', 'gen-petstore']) {
      const folder = path.join(repo, 'prod/worlds', world); mkdirSync(folder, { recursive: true });
      writeFileSync(path.join(folder, 'world.yaml'), 'fixture: true\n');
    }
    const calls = path.join(dir, 'calls'); writeFileSync(calls, '');
    const tool = (name: string, source: string) => { const file = path.join(bin, name); writeFileSync(file, `#!/bin/sh\n${source}`); chmodSync(file, 0o755); };
    tool('bun', `if [ "$1" = --version ]; then echo "\${DEMO_TEST_BUN:-1.4.2}"; exit 0; fi
[ "$1" = install ] && [ "$2" = --no-env-file ] && [ "$3" = --frozen-lockfile ] || exit 99
printf 'bun install simulated\\n' >>"$DEMO_CALLS"
[ "\${DEMO_TEST_INSTALL:-0}" = 0 ] || exit 8
mkdir -p node_modules
`);
    for (const name of ['node', 'npm', 'npx', 'curl', 'jq']) tool(name, 'echo "unexpected tool invocation" >&2\nexit 99\n');
    const env = { PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}`, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', DEMO_CALLS: calls, DEMO_TEST_RESULT: 'pass', WORLDGEN_RUNTIME: 'node', BOAT_API_KEY: 'fixture-do-not-use', LLM_KEY: 'fixture-do-not-use' };
    const git = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], { cwd: repo, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git('init', '-q'); git('add', '.'); git('-c', 'user.name=Demo fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
    git('remote', 'add', 'origin', repo);
    const sha = git('rev-parse', 'HEAD'), demo = path.join(home, `worldgen-demo-${sha.slice(0, 8)}`);
    const run = (mode: string, extra: Record<string, string> = {}) => {
      const r = spawnSync('/bin/bash', [path.join(repo, 'scripts/demo-rehearsal.sh'), mode], { env: { ...env, WORLDGEN_DEMO_SHA: sha, ...extra }, encoding: 'utf8', timeout: 15000 });
      assert.equal(r.error, undefined, String(r.error)); assert.equal(r.signal, null); return r;
    };
    check({ run, home, demo, sha, calls });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('offline demo wrapper (simulated product)', () => {
  test('prepares a new detached source with Bun, then rehearses without installing or paid calls', () => fixture(({ run, home, calls }) => {
    const prepared = run('prepare'); assert.equal(prepared.status, 0, String(prepared.stderr)); assert.match(String(prepared.stdout), /PREPARED, NOT REHEARSED/);
    assert.equal(readFileSync(calls, 'utf8'), 'bun install simulated\n');
    const rehearsed = run('rehearse'); assert.equal(rehearsed.status, 0, `${rehearsed.stdout}\n${rehearsed.stderr}`);
    assert.match(String(rehearsed.stdout), /OFFLINE REHEARSAL PASSED/);
    assert.equal(readFileSync(calls, 'utf8'), 'bun install simulated\ndemo invoked\n');
    const evidence = readdirSync(home).find(p => p.startsWith('worldgen-demo-rehearse-')); assert.ok(evidence);
    assert.equal(readFileSync(path.join(home, evidence, 'exits.txt'), 'utf8'), 'demo=0\ntee=0\n');
  }));
  test('will not overwrite a prepared checkout', () => fixture(({ run }) => { assert.equal(run('prepare').status, 0); const r = run('prepare'); assert.equal(r.status, 2); assert.match(String(r.stderr), /Refusing to overwrite/); }));
  test('refuses an absent or moving source selection', () => fixture(({ run }) => { for (const sha of ['', 'main', 'abcdef']) { const r = run('prepare', { WORLDGEN_DEMO_SHA: sha }); assert.equal(r.status, 2); assert.match(String(r.stderr), /immutable full/); } }));
  test('will not replace Bun with an inherited Node selection', () => fixture(({ run, calls }) => { const r = run('prepare', { DEMO_TEST_BUN: '1.3.14', WORLDGEN_RUNTIME: 'node' }); assert.equal(r.status, 2); assert.match(String(r.stderr), /requires Bun 1\.4\.2/); assert.equal(readFileSync(calls, 'utf8'), ''); }));
  test('retains install failure and does not start the demo', () => fixture(({ run, home, calls }) => { const r = run('prepare', { DEMO_TEST_INSTALL: '1' }); assert.equal(r.status, 1); assert.match(String(r.stderr), /Installation failed/); assert.equal(readFileSync(calls, 'utf8'), 'bun install simulated\n'); const e = readdirSync(home).find(p => p.startsWith('worldgen-demo-prepare-')); assert.ok(e); assert.equal(readFileSync(path.join(home, e, 'install-exit.txt'), 'utf8'), '8\n'); }));
  test('preserves actual demo failure instead of returning tee success', () => fixture(({ run, home }) => { assert.equal(run('prepare').status, 0); const r = run('rehearse', { DEMO_TEST_RESULT: 'fail' }); assert.equal(r.status, 1); const e = readdirSync(home).find(p => p.startsWith('worldgen-demo-rehearse-')); assert.ok(e); assert.equal(readFileSync(path.join(home, e, 'exits.txt'), 'utf8'), 'demo=7\ntee=0\n'); }));
  test('a zero exit with an incomplete summary is not a pass', () => fixture(({ run }) => { assert.equal(run('prepare').status, 0); const r = run('rehearse', { DEMO_TEST_RESULT: 'partial' }); assert.equal(r.status, 1); assert.match(String(r.stderr), /complete 25-step summary is absent/); }));
  test('refuses tracked source changes before the demonstration', () => fixture(({ run, demo, calls }) => { assert.equal(run('prepare').status, 0); writeFileSync(path.join(demo, 'code/package.json'), '{"modified":true}'); const r = run('rehearse'); assert.equal(r.status, 2); assert.match(String(r.stderr), /Tracked source is modified/); assert.equal(readFileSync(calls, 'utf8'), 'bun install simulated\n'); }));
});
