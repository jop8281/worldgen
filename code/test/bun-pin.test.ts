/**
 * One Bun version everywhere (YOS-259, A-385): the sandbox bootstrap, the runner, CI, package.json, both images and the
 * factory check name the same pinned Bun. The expected value is the literal, so a bump touches every site and this test.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { BUN_BOOTSTRAP, SANDBOX_BUN_VERSION } from '../src/sandboxes/backend.ts';

const REPO_DIR = path.resolve(import.meta.dirname, '../..');
const read = (file: string): string => readFileSync(path.join(REPO_DIR, file), 'utf8');
const all = (text: string, re: RegExp): string[] => [...text.matchAll(re)].map((m) => m[1]!);

describe('the Bun pin (YOS-259)', () => {
  it('names Bun 1.4.2 at every site that installs, requires or runs Bun', () => {
    const pkg = JSON.parse(read('code/package.json')) as { packageManager: string; engines: { bun: string } };
    assert.deepEqual(
      {
        'backend.ts SANDBOX_BUN_VERSION': [SANDBOX_BUN_VERSION],
        'backend.ts BUN_BOOTSTRAP': all(BUN_BOOTSTRAP, /bun-linux-\$A-([\d.]+)\.tgz/g),
        'scripts/runner.sh': all(read('scripts/runner.sh'), /^WORLDGEN_BUN_VERSION=(\S+)$/gm),
        'scripts/factory-check.sh': all(read('scripts/factory-check.sh'), /"\$\(bun --version\)" != "([\d.]+)"/g),
        '.github/workflows/check.yml': all(read('.github/workflows/check.yml'), /^\s*bun-version:\s*(\S+)\s*$/gm),
        'package.json packageManager': [pkg.packageManager],
        'package.json engines.bun': [pkg.engines.bun],
        Dockerfile: all(read('Dockerfile'), /^FROM\s+([^@\s]+)/gm),
        'Dockerfile.studio': all(read('Dockerfile.studio'), /^FROM\s+([^@\s]+)/gm),
      },
      {
        'backend.ts SANDBOX_BUN_VERSION': ['1.4.2'],
        'backend.ts BUN_BOOTSTRAP': ['1.4.2'],
        'scripts/runner.sh': ['1.4.2'],
        'scripts/factory-check.sh': ['1.4.2'],
        '.github/workflows/check.yml': ['1.4.2', '1.4.2'],
        'package.json packageManager': ['bun@1.4.2'],
        'package.json engines.bun': ['1.4.2'],
        Dockerfile: ['oven/bun:1.4.2-slim'],
        'Dockerfile.studio': ['oven/bun:1.4.2-slim'],
      },
    );
  });
});
