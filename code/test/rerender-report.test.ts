/**
 * scripts/rerender-report.ts re-renders a world from the input its capsule records (A-351), with no arguments, and
 * refuses with a clear message when the capsule records none. It runs on a copy of a prod world, never on prod/.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

const CODE = path.resolve(import.meta.dirname, '..');
/** A csv-created world (its capsule records a create from csv input) that no iterate has rewritten since. */
const LOANS = path.resolve(CODE, '../prod/worlds/gen-library-loans');

function copyOfLoans(): { root: string; dir: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'rerender-'));
  const dir = path.join(root, 'gen-library-loans');
  cpSync(LOANS, dir, { recursive: true });
  return { root, dir };
}

const rerender = (...args: string[]) => spawnSync('bun', ['scripts/rerender-report.ts', ...args], { cwd: CODE, encoding: 'utf8', timeout: 120_000 });

describe('rerender-report.ts reads the run input from capsule.json (A-351)', () => {
  it('re-renders a world with no arguments, and the report and capsule come out unchanged', () => {
    const { root, dir } = copyOfLoans();
    try {
      const r = rerender(dir);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'gen-library-loans: wid_14b93ec57fdb9839d5023a5aa1069ed87f3c187d8afbe2c27e563fb3bd664297 -> wid_14b93ec57fdb9839d5023a5aa1069ed87f3c187d8afbe2c27e563fb3bd664297\n');
      for (const f of ['REPORT.md', 'capsule.json']) assert.equal(readFileSync(path.join(dir, f), 'utf8'), readFileSync(path.join(LOANS, f), 'utf8'), f);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses a capsule that records no input when no override is given', () => {
    const { root, dir } = copyOfLoans();
    try {
      const file = path.join(dir, 'capsule.json');
      const capsule = JSON.parse(readFileSync(file, 'utf8')) as { input: Record<string, unknown> };
      delete capsule.input['source'];
      writeFileSync(file, `${JSON.stringify(capsule, null, 2)}\n`);
      const r = rerender(dir);
      assert.equal(r.status, 1);
      assert.equal(r.stderr, "gen-library-loans: refused: capsule.json records no usable csv input (A-351): pass the run's input after --\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
