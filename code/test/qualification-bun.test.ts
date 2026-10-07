import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

const runner = path.resolve(import.meta.dirname, '../../scripts/runner.sh');
const bash = '/bin/bash';

/** Shell dispatch fixtures, NOT native Bun execution or a product qualification. */
function dispatch(runtime: string | undefined, version: string | null, command = 'run worldplay check "a world" --json', versionExit = 0) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'required bun fixture '));
  try {
    const bin = path.join(dir, 'bin');
    mkdirSync(bin);
    const log = path.join(dir, 'calls');
    writeFileSync(log, '');
    const script = (name: string, source: string) => {
      const file = path.join(bin, name);
      writeFileSync(file, `#!/bin/sh\n${source}`); chmodSync(file, 0o755);
    };
    for (const name of ['node', 'npm', 'npx']) script(name, 'echo "UNEXPECTED NODE FAMILY" >>"$CALLS"\nexit 99\n');
    if (version !== null) script('bun', 'if [ "$1" = --version ]; then printf "%s\\n" "$FIXTURE_VERSION"; exit "$VERSION_EXIT"; fi\nprintf "<%s>\\n" "$@" >>"$CALLS"\n');
    const result = spawnSync(bash, ['-c', `set -u; source "$1"; ${command}; printf 'CONTINUED\\n'`, 'fixture', runner], {
      encoding: 'utf8', timeout: 5000,
      env: { PATH: bin, CALLS: log, FIXTURE_VERSION: version ?? '', VERSION_EXIT: String(versionExit), ...(runtime === undefined ? {} : { WORLDGEN_RUNTIME: runtime }) },
    });
    assert.equal(result.error, undefined, String(result.error));
    assert.equal(result.signal, null);
    return { ...result, calls: readFileSync(log, 'utf8') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('mandatory Bun dispatch (simulated executables)', () => {
  for (const runtime of [undefined, 'bun']) test(`${runtime ?? 'default'} refuses Node-only PATH before any work`, () => {
    const r = dispatch(runtime, null);
    assert.equal(r.status, 2, r.stderr); assert.match(r.stderr, /Bun 1\.4\.2.*missing.*fallback is disabled/);
    assert.equal(r.calls, ''); assert.equal(r.stdout, '');
  });
  for (const version of ['1.3.14', '1.4.1', '1.4.3', 'v1.4.2', '']) test(`refuses unsupported Bun version ${JSON.stringify(version)}`, () => {
    const r = dispatch('bun', version);
    assert.equal(r.status, 2, r.stderr); assert.match(r.stderr, /requires Bun 1\.4\.2/); assert.equal(r.calls, ''); assert.equal(r.stdout, '');
  });
  test('a failed version query cannot be accepted', () => {
    const r = dispatch('bun', '1.4.2', undefined, 7);
    assert.equal(r.status, 2); assert.match(r.stderr, /Cannot verify/); assert.equal(r.calls, '');
  });
  test('a typo is not a runtime fallback request', () => {
    const r = dispatch('bnu', '1.4.2'); assert.equal(r.status, 2); assert.match(r.stderr, /Unknown WORLDGEN_RUNTIME/); assert.equal(r.calls, '');
  });
  test('default runs Bun with unchanged argument boundaries and disables dotenv loading', () => {
    const r = dispatch(undefined, '1.4.2'); assert.equal(r.status, 0, r.stderr);
    assert.equal(r.calls, '<run>\n<--no-env-file>\n<--silent>\n<worldplay>\n<check>\n<a world>\n<--json>\n');
  });
  test('dependency preparation uses Bun frozen install only', () => {
    const r = dispatch(undefined, '1.4.2', 'install_deps'); assert.equal(r.status, 0, r.stderr);
    assert.equal(r.calls, '<install>\n<--no-env-file>\n<--frozen-lockfile>\n');
  });
  test('TypeScript and helper evaluation stay on Bun', () => {
    const r = dispatch('bun', '1.4.2', 'tsrun "file name.ts" "argument with spaces"; js "console.log(1)" value');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.calls, '<--no-env-file>\n<file name.ts>\n<argument with spaces>\n<--no-env-file>\n<-e>\n<console.log(1)>\n<value>\n');
  });
  test('exec TypeScript replaces the shell instead of leaving a wrapper process', () => {
    const r = dispatch('bun', '1.4.2', 'ts file.ts'); assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, ''); assert.equal(r.calls, '<--no-env-file>\n<file.ts>\n');
  });
});

// The primary CI job runs this with actual Bun, not the dispatch stand-in above.
// The separate Node job reports this native-Bun case as skipped, never as Bun evidence.
test('native Bun runner evaluates helpers and launches the product CLI', { skip: !process.versions.bun }, () => {
  const r = spawnSync('/bin/bash', ['-c', 'set -euo pipefail; source "$1"; js \'if (process.versions.bun !== "1.4.2") throw new Error("wrong executing Bun"); console.log("native-bun-ok");\'; run worldgen --help', 'native-bun', runner], {
    cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 15000,
    env: { PATH: process.env.PATH, WORLDGEN_RUNTIME: 'bun' },
  });
  assert.equal(r.error, undefined, String(r.error));
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /native-bun-ok/);
  assert.match(r.stdout, /usage:/);
});
