import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { appendEpisode, readEpisodeLog, releaseStaleClaim, startRunLog } from '../src/dataset/store.ts';
import { canonicalJson } from '../src/dataset/schema.ts';
import { EASY, episode, noSecrets } from './dataset-kit.ts';

const CODE = path.resolve(import.meta.dirname, '..');
const initial = episode();
const next = episode({ episode_id: `run1__${EASY}__2` });

async function heldWriter(mode = 'wait') {
  const out = mkdtempSync(path.join(tmpdir(), 'dataset-writer-'));
  await appendEpisode(out, initial, noSecrets);
  const record = path.join(out, 'record.json');
  const release = path.join(out, 'release');
  writeFileSync(record, JSON.stringify(next));
  const child = spawn(process.execPath, ['--import', 'tsx', 'test/helpers/episode-writer.ts', out, record, release, mode], {
    cwd: CODE, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const ready = new Promise<void>((resolve, reject) => {
    const deadline = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`writer did not enter log validation: ${stderr}`)); }, 8_000);
    child.stdout.on('data', () => {
      if (stdout.includes('held\n')) { clearTimeout(deadline); resolve(); }
    });
    child.once('error', (error) => { clearTimeout(deadline); reject(error); });
    child.once('close', () => {
      clearTimeout(deadline);
      if (!stdout.includes('held\n')) reject(new Error(`writer exited before log validation: ${stderr}`));
    });
  });
  try {
    await ready;
  } catch (error) {
    await done;
    rmSync(out, { recursive: true, force: true });
    throw error;
  }
  return {
    out, child, done,
    file: path.join(out, 'logs/run1.episodes.jsonl'),
    claim: path.join(out, 'logs/run1.episodes.jsonl.lock'),
    stderr: () => stderr,
    async release() { writeFileSync(release, 'release\n'); return done; },
    async cleanup() { writeFileSync(release, 'release\n'); await done; rmSync(out, { recursive: true, force: true }); },
  };
}

describe('dataset episode writer claims', () => {
  it('refuses a competing real writer before mutation, then preserves duplicate and conflict semantics', async () => {
    const owner = await heldWriter();
    try {
      const before = readFileSync(owner.file, 'utf8');
      await assert.rejects(appendEpisode(owner.out, next, noSecrets), /episode log.*already has a writer/);
      assert.equal(readFileSync(owner.file, 'utf8'), before);
      assert.deepEqual(await owner.release(), { code: 0, signal: null });
      assert.equal(existsSync(owner.claim), false);
      assert.equal(await appendEpisode(owner.out, next, noSecrets), 'duplicate');
      await assert.rejects(appendEpisode(owner.out, { ...next, score: 0.5 }, noSecrets), /already saved with different content/);
      assert.equal(existsSync(owner.claim), false);
      assert.deepEqual(await readEpisodeLog(owner.file, noSecrets), [initial, next]);
    } finally { await owner.cleanup(); }
  });

  it('shares the claim across directory aliases while another run log remains independent', async () => {
    const owner = await heldWriter();
    try {
      const alias = `${owner.out}-alias`;
      const logsAlias = `${owner.out}-logs-alias`;
      symlinkSync(owner.out, alias, 'dir');
      mkdirSync(logsAlias);
      symlinkSync(path.join(owner.out, 'logs'), path.join(logsAlias, 'logs'), 'dir');
      try {
        for (const out of [alias, logsAlias, path.relative(process.cwd(), owner.out)]) {
          await assert.rejects(appendEpisode(out, next, noSecrets), /episode log.*already has a writer/);
        }
        const independent = episode({ run_id: 'run2', episode_id: `run2__${EASY}__1` });
        assert.equal(await appendEpisode(owner.out, independent, noSecrets), 'added');
        assert.deepEqual(await readEpisodeLog(path.join(owner.out, 'logs/run2.episodes.jsonl'), noSecrets), [independent]);
        assert.equal(readFileSync(owner.file, 'utf8'), `${canonicalJson(initial)}\n`);
      } finally { rmSync(alias); rmSync(logsAlias, { recursive: true }); }
    } finally { await owner.cleanup(); }
  });

  it('releases the claim after an exception inside the actual child writer', async () => {
    const owner = await heldWriter('throw');
    try {
      assert.deepEqual(await owner.done, { code: 1, signal: null });
      assert.match(owner.stderr(), /controlled owner failure/);
      assert.equal(existsSync(owner.claim), false);
      assert.deepEqual(await readEpisodeLog(owner.file, noSecrets), [initial]);
      assert.equal(await appendEpisode(owner.out, next, noSecrets), 'added');
    } finally { await owner.cleanup(); }
  });

  it('refuses log-file symlinks during and after another writer without contaminating its run', async () => {
    const owner = await heldWriter();
    try {
      const alias = path.join(owner.out, 'logs/run2.episodes.jsonl');
      const other = episode({ run_id: 'run2', episode_id: `run2__${EASY}__1` });
      symlinkSync(owner.file, alias);
      const before = readFileSync(owner.file, 'utf8');
      await assert.rejects(appendEpisode(owner.out, other, noSecrets), /symbolic link/);
      assert.equal(readFileSync(owner.file, 'utf8'), before);
      assert.equal(existsSync(`${alias}.lock`), false);
      assert.deepEqual(await owner.release(), { code: 0, signal: null });
      await assert.rejects(appendEpisode(owner.out, other, noSecrets), /symbolic link/);
      assert.deepEqual(await readEpisodeLog(owner.file, noSecrets), [initial, next]);
      unlinkSync(alias);
      assert.equal(await appendEpisode(owner.out, other, noSecrets), 'added');
    } finally { await owner.cleanup(); }
  });

  it('refuses a hard-linked log, which a writer could reach without the other run\'s claim', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'dataset-writer-'));
    try {
      assert.equal(await startRunLog(out, 'run1'), true);
      const file = path.join(out, 'logs/run1.episodes.jsonl');
      linkSync(file, path.join(out, 'logs/run2.episodes.jsonl'));
      await assert.rejects(appendEpisode(out, episode({ run_id: 'run2', episode_id: `run2__${EASY}__1` }), noSecrets), /has 2 hard links/);
      assert.equal(readFileSync(file, 'utf8'), '');
    } finally { rmSync(out, { recursive: true, force: true }); }
  });

  it('refuses a dangling log-file symlink without creating its target', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'dataset-writer-'));
    try {
      mkdirSync(path.join(out, 'logs'));
      const target = path.join(out, 'missing-target');
      const file = path.join(out, 'logs/run1.episodes.jsonl');
      symlinkSync(target, file);
      await assert.rejects(appendEpisode(out, initial, noSecrets), /symbolic link/);
      assert.equal(existsSync(target), false);
      assert.equal(existsSync(`${file}.lock`), false);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });

  it('keeps an abrupt-death claim closed until the writer is stopped and the log is preserved and validated', async () => {
    const owner = await heldWriter();
    try {
      assert.equal(existsSync(owner.claim), true);
      const { token, ...holder } = JSON.parse(readFileSync(owner.claim, 'utf8')) as Record<string, unknown>;
      assert.deepEqual(holder, { pid: owner.child.pid, host: hostname() });
      assert.match(String(token), /^[0-9a-f]{32}$/);
      owner.child.kill('SIGKILL');
      assert.deepEqual(await owner.done, { code: null, signal: 'SIGKILL' });
      const before = readFileSync(owner.file, 'utf8');
      await assert.rejects(appendEpisode(owner.out, next, noSecrets), /episode log.*already has a writer/);
      assert.equal(readFileSync(owner.file, 'utf8'), before);
      const backup = `${owner.file}.recovery-copy`;
      copyFileSync(owner.file, backup);
      assert.deepEqual(await readEpisodeLog(backup, noSecrets), [initial]);
      assert.equal(readFileSync(backup, 'utf8'), before);
      unlinkSync(owner.claim);
      assert.equal(await appendEpisode(owner.out, next, noSecrets), 'added');
      assert.deepEqual(await readEpisodeLog(owner.file, noSecrets), [initial, next]);
    } finally { await owner.cleanup(); }
  });

  it('refuses a log that holds another run\'s episode, or one id with two contents, and writes nothing', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'dataset-writer-'));
    try {
      mkdirSync(path.join(out, 'logs'));
      const foreign = path.join(out, 'logs/run2.episodes.jsonl');
      writeFileSync(foreign, `${canonicalJson(initial)}\n`);
      await assert.rejects(appendEpisode(out, episode({ run_id: 'run2', episode_id: `run2__${EASY}__1` }), noSecrets), /episode run1__\S+ belongs to run run1/);
      assert.equal(readFileSync(foreign, 'utf8'), `${canonicalJson(initial)}\n`);
      const twice = path.join(out, 'logs/run1.episodes.jsonl');
      const text = `${canonicalJson(initial)}\n${canonicalJson({ ...initial, score: 0.5 })}\n`;
      writeFileSync(twice, text);
      await assert.rejects(appendEpisode(out, next, noSecrets), /saved twice with different content/);
      assert.equal(readFileSync(twice, 'utf8'), text);
      assert.equal(existsSync(`${twice}.lock`), false);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });

  it('rolls a failed append back before it releases the claim, so a retry adds the episode once', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'dataset-writer-'));
    try {
      await appendEpisode(out, initial, noSecrets);
      const file = path.join(out, 'logs/run1.episodes.jsonl');
      const before = readFileSync(file, 'utf8');
      const probe = await open(file, 'r');
      const proto = Object.getPrototypeOf(probe) as { appendFile(this: FileHandle, data: string | Uint8Array): Promise<void> };
      await probe.close();
      const appendFile = proto.appendFile;
      proto.appendFile = async function (this: FileHandle, data: string | Uint8Array) {
        await this.write(String(data).slice(0, 20));
        throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
      };
      try {
        await assert.rejects(appendEpisode(out, next, noSecrets), /ENOSPC/);
      } finally { proto.appendFile = appendFile; }
      assert.equal(readFileSync(file, 'utf8'), before);
      assert.equal(existsSync(`${file}.lock`), false);
      assert.equal(await appendEpisode(out, next, noSecrets), 'added');
      assert.deepEqual(await readEpisodeLog(file, noSecrets), [initial, next]);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });

  it('leaves a claim that another writer took while this one held it, and says the log needs validating', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'dataset-writer-'));
    try {
      const claim = path.join(out, 'logs/run1.episodes.jsonl.lock');
      let swapped = false;
      const redact = {
        ...noSecrets,
        assertClean(where: string, text: string) {
          noSecrets.assertClean(where, text);
          if (!where.endsWith('.episodes.jsonl') || swapped) return;
          swapped = true;
          unlinkSync(claim);
          writeFileSync(claim, '{"pid":0}\n');
        },
      };
      await assert.rejects(appendEpisode(out, initial, redact), /removed while this process held it/);
      assert.equal(readFileSync(claim, 'utf8'), '{"pid":0}\n');
    } finally { rmSync(out, { recursive: true, force: true }); }
  });

  it("leaves another writer's claim that has this claim's inode, as Linux gives a file re-created at once", async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'dataset-writer-'));
    try {
      const claim = path.join(out, 'logs/run1.episodes.jsonl.lock');
      let rewritten = false;
      const redact = {
        ...noSecrets,
        assertClean(where: string, text: string) {
          noSecrets.assertClean(where, text);
          if (!where.endsWith('.episodes.jsonl') || rewritten) return;
          rewritten = true;
          writeFileSync(claim, '{"pid":0}\n');
        },
      };
      await assert.rejects(appendEpisode(out, initial, redact), /replaced or removed while this process held it/);
      assert.equal(readFileSync(claim, 'utf8'), '{"pid":0}\n');
    } finally { rmSync(out, { recursive: true, force: true }); }
  });
});

describe('releasing the claim of a crashed writer', () => {
  it('refuses while the writer is alive, then releases after it dies and the log validates', async () => {
    const owner = await heldWriter();
    try {
      await assert.rejects(releaseStaleClaim(owner.out, 'run1', noSecrets), new RegExp(`process ${owner.child.pid} still holds`));
      assert.equal(existsSync(owner.claim), true);
      owner.child.kill('SIGKILL');
      await owner.done;
      const released = await releaseStaleClaim(owner.out, 'run1', noSecrets);
      assert.deepEqual([released.pid, released.episodes], [owner.child.pid, 1]);
      assert.equal(existsSync(owner.claim), false);
      assert.equal(await appendEpisode(owner.out, next, noSecrets), 'added');
      await assert.rejects(releaseStaleClaim(owner.out, 'run1', noSecrets), /run run1 has no claim to release/);
    } finally { await owner.cleanup(); }
  });

  it('keeps a claim that another host took, one that names no process, and one over a log that does not validate', async () => {
    const out = mkdtempSync(path.join(tmpdir(), 'dataset-writer-'));
    try {
      await appendEpisode(out, initial, noSecrets);
      const file = path.join(out, 'logs/run1.episodes.jsonl');
      const claim = `${file}.lock`;
      writeFileSync(claim, `${JSON.stringify({ pid: 1, host: 'elsewhere.example' })}\n`);
      await assert.rejects(releaseStaleClaim(out, 'run1', noSecrets), /was taken on host elsewhere\.example/);
      writeFileSync(claim, '{"pid":1}\n');
      await assert.rejects(releaseStaleClaim(out, 'run1', noSecrets), /names no process and host/);
      const dead = spawnSync(process.execPath, ['-e', '']).pid;
      writeFileSync(claim, `${JSON.stringify({ pid: dead, host: hostname() })}\n`);
      appendFileSync(file, '{"partial');
      await assert.rejects(releaseStaleClaim(out, 'run1', noSecrets), /the claim stays because the log does not validate: .*last line is incomplete/);
      assert.equal(existsSync(claim), true);
    } finally { rmSync(out, { recursive: true, force: true }); }
  });
});
