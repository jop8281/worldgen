import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, type TestContext } from 'node:test';
import { saveWorld } from '#engine';
import { withEvalAttempt } from '../src/cli/eval-retention.ts';
import { caseLayout } from '../src/worldgen/eval.ts';
import { bareWorld, checkedForTest } from './helpers/world.ts';

async function directory(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-retention-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function artifacts(dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  async function walk(at: string, prefix: string): Promise<void> {
    for (const entry of (await readdir(at, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = `${prefix}${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(at, entry.name), `${relative}/`);
      else files[relative] = (await readFile(path.join(at, entry.name))).toString('base64');
    }
  }
  await walk(dir, '');
  return files;
}

async function previous(runDir: string): Promise<Record<string, string>> {
  const layout = caseLayout(runDir, 'repair');
  await mkdir(layout.logDir.change, { recursive: true });
  await writeFile(layout.caseFile, '{"legacy":"failed case with intentionally unknown fields"}\n');
  await writeFile(layout.events.create, '{"t":"attempt","outcome":"failed"}\r\npartial');
  await writeFile(layout.events.change, Buffer.from([0, 255, 10, 13, 32]));
  await writeFile(path.join(layout.dir, 'REPORT.md'), '# Stopped\nOriginal failure must survive.\n');
  // Serialization-only fixture: no checkWorld, VM, or provider is involved.
  await saveWorld(layout.world, checkedForTest(bareWorld()));
  return artifacts(layout.dir);
}

async function history(runDir: string): Promise<string[]> {
  const base = path.join(runDir, '.attempts', 'repair');
  return (await readdir(base)).filter((name) => name.startsWith('attempt-')).sort()
    .map((name) => path.join(base, name, 'artifacts'));
}

describe('eval attempt retention', () => {
  it('R3 first execution uses the unchanged latest layout without inventing prior evidence', async (t) => {
    const runDir = await directory(t);
    const value = await withEvalAttempt(runDir, 'repair', async (layout) => {
      assert.deepEqual(layout, caseLayout(runDir, 'repair'));
      assert.deepEqual(await readdir(layout.dir), []);
      await writeFile(layout.caseFile, '{"result":"done"}\n');
      return 42;
    });
    assert.equal(value, 42);
    assert.equal(await readFile(path.join(runDir, 'repair/case.json'), 'utf8'), '{"result":"done"}\n');
    assert.deepEqual(await history(runDir), []);
    await assert.rejects(readFile(path.join(runDir, '.attempts/repair/active.lock')), { code: 'ENOENT' });
  });

  it('R1/R3 retains every legacy byte before new writes and leaves other cases and summary intact', async (t) => {
    const runDir = await directory(t);
    const expected = await previous(runDir);
    await mkdir(path.join(runDir, 'other'));
    await writeFile(path.join(runDir, 'other/case.json'), 'other case');
    await writeFile(path.join(runDir, 'summary.md'), 'original summary');
    let retained = '';
    await withEvalAttempt(runDir, 'repair', async (layout) => {
      assert.deepEqual(await artifacts(retained), expected);
      assert.deepEqual(await readdir(layout.dir), []);
      await writeFile(layout.caseFile, '{"result":"done"}');
      await writeFile(path.join(layout.dir, 'REPORT.md'), 'new successful report');
    }, (dir) => { retained = dir; });
    assert.deepEqual(await artifacts(retained), expected);
    assert.equal(await readFile(path.join(runDir, 'other/case.json'), 'utf8'), 'other case');
    assert.equal(await readFile(path.join(runDir, 'summary.md'), 'utf8'), 'original summary');
  });

  it('R2 retains successful, failed and partial attempts separately across repeated reruns', async (t) => {
    const runDir = await directory(t);
    const expected = await previous(runDir);
    const retained: string[] = [];
    await withEvalAttempt(runDir, 'repair', async (layout) => {
      await writeFile(layout.caseFile, 'successful rerun');
    }, (dir) => { retained.push(dir); });
    await assert.rejects(withEvalAttempt(runDir, 'repair', async (layout) => {
      await writeFile(layout.events.create, 'partial failed rerun');
      throw new Error('generation failed');
    }, (dir) => { retained.push(dir); }), /generation failed/);
    await withEvalAttempt(runDir, 'repair', async (layout) => {
      await writeFile(layout.caseFile, 'latest successful rerun');
    }, (dir) => { retained.push(dir); });
    assert.equal(new Set(retained).size, 3);
    assert.deepEqual(await artifacts(retained[0]!), expected);
    assert.equal(await readFile(path.join(retained[1]!, 'case.json'), 'utf8'), 'successful rerun');
    assert.equal(await readFile(path.join(retained[2]!, 'events.jsonl'), 'utf8'), 'partial failed rerun');
    assert.equal(await readFile(path.join(runDir, 'repair/case.json'), 'utf8'), 'latest successful rerun');
  });

  it('R2/R4 an interruption at the retained boundary preserves evidence and never starts new work', async (t) => {
    const runDir = await directory(t);
    const expected = await previous(runDir);
    let called = false;
    let retained = '';
    await assert.rejects(withEvalAttempt(runDir, 'repair', async () => { called = true; }, (dir) => {
      retained = dir;
      throw new Error('interrupted preparation');
    }), /interrupted preparation/);
    assert.equal(called, false);
    assert.deepEqual(await artifacts(retained), expected);
    await withEvalAttempt(runDir, 'repair', async (layout) => {
      await writeFile(layout.caseFile, 'recovered ordinary error');
    });
    assert.deepEqual(await artifacts(retained), expected);
  });

  it('R4 blocked history storage aborts before any old bytes or new work change', async (t) => {
    for (const blocked of ['.attempts', '.attempts/repair']) {
      const runDir = await directory(t);
      const expected = await previous(runDir);
      if (blocked.includes('/')) await mkdir(path.join(runDir, '.attempts'));
      await writeFile(path.join(runDir, blocked), 'not a directory');
      let called = false;
      await assert.rejects(withEvalAttempt(runDir, 'repair', async () => { called = true; }));
      assert.equal(called, false);
      assert.deepEqual(await artifacts(path.join(runDir, 'repair')), expected);
      assert.equal(await readFile(path.join(runDir, blocked), 'utf8'), 'not a directory');
    }
  });

  it('R4 failure to create the fresh directory reports the retained recovery path and does not run', async (t) => {
    const runDir = await directory(t);
    const expected = await previous(runDir);
    let retained = '';
    let called = false;
    await assert.rejects(withEvalAttempt(runDir, 'repair', async () => { called = true; }, (dir) => {
      retained = dir;
      writeFileSync(path.join(runDir, 'repair'), 'competing path must not be deleted');
    }), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error.message.includes(`previous artifacts retained at ${retained}`));
      return true;
    });
    assert.equal(called, false);
    assert.deepEqual(await artifacts(retained), expected);
    assert.equal(await readFile(path.join(runDir, 'repair'), 'utf8'), 'competing path must not be deleted');
  });

  it('R4 rejects a symlink run directory before writing beneath it', async (t) => {
    const parent = await directory(t);
    const target = await directory(t);
    await writeFile(path.join(target, 'marker'), 'untouched');
    const runDir = path.join(parent, 'run');
    await symlink(target, runDir);
    await assert.rejects(withEvalAttempt(runDir, 'repair', async () => { assert.fail('must not run'); }), /directory/);
    assert.deepEqual(await readdir(target), ['marker']);
  });

  it('R4 rejects symlink storage and case paths without following them', async (t) => {
    for (const link of ['.attempts', '.attempts/repair', 'repair']) {
      const runDir = await directory(t);
      const target = await directory(t);
      await writeFile(path.join(target, 'marker'), 'outside target must not change');
      if (link.includes('/')) await mkdir(path.join(runDir, '.attempts'));
      await symlink(target, path.join(runDir, link));
      let called = false;
      await assert.rejects(withEvalAttempt(runDir, 'repair', async () => { called = true; }), /directory/);
      assert.equal(called, false);
      assert.equal(await readlink(path.join(runDir, link)), target);
      assert.deepEqual(await readdir(target), ['marker']);
    }
  });

  it('R4 rejects invalid IDs and a non-directory current case', async (t) => {
    const runDir = await directory(t);
    for (const id of ['', '../escape', '.attempts', 'a/b']) {
      await assert.rejects(withEvalAttempt(runDir, id, async () => { assert.fail('must not run'); }), /case id/);
    }
    assert.deepEqual(await readdir(runDir), []);
    await writeFile(path.join(runDir, 'repair'), 'legacy file');
    await assert.rejects(withEvalAttempt(runDir, 'repair', async () => { assert.fail('must not run'); }), /directory/);
    assert.equal(await readFile(path.join(runDir, 'repair'), 'utf8'), 'legacy file');
  });

  it('R5 refuses a concurrent case run before it can archive or overwrite the active attempt', async (t) => {
    const runDir = await directory(t);
    const expected = await previous(runDir);
    let ready!: () => void;
    const started = new Promise<void>((resolve) => { ready = resolve; });
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const first = withEvalAttempt(runDir, 'repair', async (layout) => {
      await writeFile(layout.events.create, 'active attempt');
      ready();
      await wait;
    });
    await started;
    try {
      await assert.rejects(withEvalAttempt(runDir, 'repair', async () => { assert.fail('second must not run'); }), /active or interrupted/);
      assert.equal(await readFile(path.join(runDir, 'repair/events.jsonl'), 'utf8'), 'active attempt');
      const retained = await history(runDir);
      assert.equal(retained.length, 1);
      assert.deepEqual(await artifacts(retained[0]!), expected);
    } finally {
      release();
      await first;
    }
  });

  it('R2/R5 abrupt termination retains old and partial bytes and fails closed on the remaining lock', async (t) => {
    const runDir = await directory(t);
    const expected = await previous(runDir);
    const helper = new URL('../src/cli/eval-retention.ts', import.meta.url).href;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { writeFile } from 'node:fs/promises';
      import { withEvalAttempt } from ${JSON.stringify(helper)};
      await withEvalAttempt(process.argv[1], 'repair', async (layout) => {
        await writeFile(layout.events.create, 'interrupted partial output');
        process.kill(process.pid, 'SIGKILL');
      });
    `, runDir], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.error, undefined, child.stderr);
    assert.equal(child.signal, 'SIGKILL', child.stderr);
    const retained = await history(runDir);
    assert.equal(retained.length, 1);
    assert.deepEqual(await artifacts(retained[0]!), expected);
    assert.equal(await readFile(path.join(runDir, 'repair/events.jsonl'), 'utf8'), 'interrupted partial output');
    const owner = JSON.parse(await readFile(path.join(runDir, '.attempts/repair/active.lock'), 'utf8')) as { pid: number };
    assert.equal(owner.pid, child.pid);
    await assert.rejects(withEvalAttempt(runDir, 'repair', async () => { assert.fail('must not steal lock'); }), /active or interrupted/);
    assert.deepEqual(await artifacts(retained[0]!), expected);
  });
});
