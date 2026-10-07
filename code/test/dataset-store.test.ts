import assert from 'node:assert/strict';
import type { StateDump } from '#engine';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  DatasetError, GRADING_NOTE, canonicalJson, episodeSchema, hashState, isCompleteSuccess, redactor, sha256Hex, type Episode,
} from '../src/dataset/schema.ts';
import {
  DATASET_FILE, FAILURES_FILE, MANIFEST_FILE, appendEpisode, exportDataset, newEntryDirs, readEpisodeLog, validateExport, worldArtifactPath, writeArtifacts,
} from '../src/dataset/store.ts';
import { EASY, episode, noSecrets, tmp } from './dataset-kit.ts';

const WORLD_TEXT = 'format: 1\nmeta: {}\n';
const WORLD_VERSION = sha256Hex(WORLD_TEXT);
const dumpFor = (n: string): StateDump => ({ now: '2026-03-02T09:00:00.000Z', tables: { ticket: [{ id: `t-${n}` }] }, counters: {} }) as never;

/** An out directory holding the frozen world the episodes below refer to. */
function outDir(): string {
  const out = tmp('store');
  const file = path.join(out, ...worldArtifactPath(WORLD_VERSION).split('/'));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, WORLD_TEXT);
  return out;
}

/** A success whose state hashes match private files written under `out`. `over` can break it. */
async function stage(out: string, over: Partial<Episode> & { task?: string; run?: string } = {}): Promise<Episode> {
  const { task = EASY, run = 'run1', ...rest } = over;
  const id = `${run}__${task}__1`;
  const initial = dumpFor(`${id}-0`);
  const final = dumpFor(`${id}-1`);
  const ep = episode({ episode_id: id, run_id: run, task_id: task, world_version: WORLD_VERSION, initial_state_hash: hashState(initial), final_state_hash: hashState(final), ...rest });
  await writeArtifacts(out, id, { initialState: initial, finalState: final }, noSecrets);
  return ep;
}
const failure = (over: Partial<Episode> = {}): Partial<Episode> => ({ stop_reason: 'turn_limit', error: 'no final reply after 3 turns', final_reply: null, score: 0, messages: [episode().messages[0]!], ...over });
const read = (out: string, name: string): string => readFileSync(path.join(out, name), 'utf8');

describe('canonical JSON and state hashes', () => {
  it('orders keys, drops undefined, and hashes the same data the same whatever the key order', () => {
    assert.equal(canonicalJson({ b: [1, 2], a: 1 }), '{"a":1,"b":[1,2]}');
    assert.equal(canonicalJson({ z: undefined, y: { d: null, c: 'x' } }), '{"y":{"c":"x","d":null}}');
    assert.equal(sha256Hex(canonicalJson({ b: [1, 2], a: 1 })), '8baa73198470c7bb4c3ce142a8fd651affc0310d878bb9bd159e37a573fb4874');
    assert.equal(hashState({ b: [1, 2], a: 1 }), '8baa73198470c7bb4c3ce142a8fd651affc0310d878bb9bd159e37a573fb4874');
    assert.equal(hashState({ a: 1, b: [1, 2] }), hashState({ b: [1, 2], a: 1 }));
    assert.notEqual(hashState({ a: 1, b: [2, 1] }), hashState({ a: 1, b: [1, 2] }));
  });
  it('refuses values it cannot hash deterministically', () => {
    for (const bad of [NaN, Infinity, 1n, () => 1, new Date(0), new Map(), undefined]) assert.throws(() => canonicalJson(bad), DatasetError);
  });
});

describe('the Episode schema', () => {
  const ok = (e: unknown): boolean => episodeSchema.safeParse(e).success;
  const msgs = episode().messages;
  const [instruction, call, result, final] = msgs as [typeof msgs[0], typeof msgs[0], typeof msgs[0], typeof msgs[0]];
  const withMessages = (m: unknown[], over: Record<string, unknown> = {}) => ({ ...episode(), messages: m, ...over });

  it('refuses run and task ids that let two runs share an episode id', () => {
    const id = 'nightly__v2__refund__1';
    assert.equal(ok({ ...episode(), run_id: 'nightly__v2', task_id: 'refund', episode_id: id }), false);
    assert.equal(ok({ ...episode(), run_id: 'nightly', task_id: 'v2__refund', episode_id: id }), false);
    assert.equal(ok({ ...episode(), run_id: 'run_', task_id: 'refund', episode_id: 'run___refund__1' }), false);
    assert.equal(ok({ ...episode(), run_id: 'run', task_id: '_refund', episode_id: 'run___refund__1' }), true);
    assert.equal(ok({ ...episode(), run_id: 'run_1', task_id: 'refund_', episode_id: 'run_1__refund___1' }), true);
  });

  it('accepts a complete record', () => {
    assert.equal(ok(episode()), true);
  });
  it('rejects broken pairing and ordering', () => {
    assert.equal(ok(withMessages([instruction, call, final])), false, 'call without a result');
    assert.equal(ok(withMessages([instruction, result, final])), false, 'result without a call');
    assert.equal(ok(withMessages([instruction, call, { ...result, call_id: 'c9' }, final])), false, 'result for another call');
    assert.equal(ok(withMessages([instruction, call, result, { ...call, seq: 3 }, { ...result, seq: 4 }, { ...final, seq: 5 }])), false, 'reused call id');
    assert.equal(ok(withMessages([instruction, call, { ...call, seq: 2, call_id: 'c2' }, result, final])), false, 'a second call before the first result');
    assert.equal(ok(withMessages([instruction, { ...call, seq: 5 }, { ...result, seq: 2 }, final])), false, 'seq out of order');
    assert.equal(ok(withMessages([call, result, final])), false, 'no instruction first');
    assert.equal(ok(withMessages([instruction, { ...instruction, seq: 1 }, final])), false, 'two instructions');
    assert.equal(ok(withMessages([instruction, { ...final, seq: 1 }, { ...call, seq: 2 }, { ...result, seq: 3 }])), false, 'final reply not last');
  });
  it('ties final_reply to the last message', () => {
    assert.equal(ok(withMessages([instruction, call, result, final], { final_reply: 'Other.' })), false);
    assert.equal(ok(withMessages([instruction, call, result, final], { final_reply: null })), false);
    assert.equal(ok(withMessages([instruction, call, result], { final_reply: 'Done.' })), false);
  });
  it('is strict: no extra keys anywhere, only the pinned provider and model, only version 1', () => {
    assert.equal(ok({ ...episode(), extra: 1 }), false);
    assert.equal(ok({ ...episode(), model: 'claude-opus-5-5' }), false);
    assert.equal(ok({ ...episode(), provider: 'openai' }), false);
    assert.equal(ok({ ...episode(), schema_version: 2 }), false);
    assert.equal(ok({ ...episode(), thinking: 'hidden' }), false);
    assert.equal(ok(withMessages([instruction, { ...call, thinking: 'x' }, result, final])), false);
    assert.equal(ok({ ...episode(), score: 1.5 }), false);
    assert.equal(ok({ ...episode(), world_version: 'abc' }), false);
    assert.equal(ok({ ...episode(), episode_id: 'other__task__1' }), false);
  });
  it('needs a reply for done and an error for any other stop', () => {
    assert.equal(ok(withMessages([instruction], { stop_reason: 'done', final_reply: null })), false);
    assert.equal(ok(withMessages([instruction], { stop_reason: 'turn_limit', final_reply: null, error: null })), false);
  });
});

describe('what counts as a complete success', () => {
  const broken: [string, Partial<Episode>][] = [
    ['stopped by a limit', { stop_reason: 'turn_limit', error: 'x' }],
    ['engine score below 1', { score: 0.99 }],
    ['no score', { score: null }],
    ['a blank reply', { final_reply: '   ', messages: [episode().messages[0]!, { seq: 1, role: 'assistant', type: 'final_reply', text: '   ', commentary: '' }] }],
    ['no initial hash', { initial_state_hash: null }],
    ['no final hash', { final_state_hash: null }],
    ['an error recorded', { error: 'something' }],
    ['no model call', { usage: { ...episode().usage, model_calls: 0 } }],
    ['zero cost', { usage: { ...episode().usage, cost_usd: 0 } }],
    ['a call of unknown cost', { usage: { ...episode().usage, unaccounted_calls: 1 } }],
  ];
  it('accepts only stop done, engine score 1, a reply, both hashes, and real accounted spend', () => {
    assert.equal(isCompleteSuccess(episode()), true);
    for (const [what, over] of broken) {
      const e = episodeSchema.safeParse({ ...episode(), ...over });
      assert.equal(e.success && isCompleteSuccess(e.data), false, what);
    }
  });
});

describe('redaction', () => {
  const r = redactor(['sk-ant-AAAA1111', '', '   ', 'boat_BBBB2222']);
  it('replaces every secret in strings and object keys, longest first, and ignores blanks', () => {
    assert.equal(r.text('a sk-ant-AAAA1111 b boat_BBBB2222 c'), 'a [redacted] b [redacted] c');
    assert.deepEqual(r.deep({ 'k-sk-ant-AAAA1111': ['x boat_BBBB2222', 3, null] }), { 'k-[redacted]': ['x [redacted]', 3, null] });
    assert.equal(redactor(['', ' ']).active, false);
  });
  it('refuses text that still holds a secret, plain or JSON-escaped', () => {
    assert.throws(() => r.assertClean('file', 'has sk-ant-AAAA1111'), /file holds a supplied secret/);
    const tricky = redactor(['pa"ss\\word1']);
    assert.throws(() => tricky.assertClean('line', JSON.stringify({ v: 'pa"ss\\word1' })), /line holds a supplied secret/);
    r.assertClean('file', 'clean');
  });
});

describe('saved logs', () => {
  it('appends flushed lines, makes a repeat a no-op, and refuses a different record under the same id', async () => {
    const out = outDir();
    const ep = await stage(out);
    assert.equal(await appendEpisode(out, ep, noSecrets), 'added');
    assert.equal(await appendEpisode(out, ep, noSecrets), 'duplicate');
    const file = path.join(out, 'logs', 'run1.episodes.jsonl');
    assert.equal(readFileSync(file, 'utf8'), `${canonicalJson(ep)}\n`);
    await assert.rejects(appendEpisode(out, { ...ep, score: 0.5 }, noSecrets), /already saved with different content/);
    assert.deepEqual(await readEpisodeLog(file, noSecrets), [ep]);
  });

  it('flushes the directory entries a new log needs: its own directory, and each one mkdir created on the way', () => {
    assert.deepEqual(newEntryDirs('/o/logs/r.episodes.jsonl', undefined), ['/o/logs']);
    assert.deepEqual(newEntryDirs('/o/logs/r.episodes.jsonl', '/o/logs'), ['/o/logs', '/o']);
    assert.deepEqual(newEntryDirs('/o/logs/r.episodes.jsonl', '/o'), ['/o/logs', '/o', '/']);
  });

  it('fails closed on a truncated line, bad JSON, a blank line and an unpaired tool call, naming the line', async () => {
    const out = outDir();
    const ep = await stage(out);
    const line = canonicalJson(ep);
    const file = path.join(out, 'logs', 'run1.episodes.jsonl');
    mkdirSync(path.dirname(file), { recursive: true });
    const unpaired = canonicalJson({ ...ep, episode_id: 'run1__t2__1', task_id: 't2', messages: [ep.messages[0], ep.messages[1], ep.messages[3]] });
    const cases: [string, string, RegExp][] = [
      ['truncated', line, /the last line is incomplete/],
      ['bad json', `${line}\n{"schema_version":\n`, /:2: not JSON/],
      ['blank', `${line}\n\n`, /:2: blank line/],
      ['unpaired', `${line}\n${unpaired}\n`, /:2: not a valid episode record: messages: tool call c1 has no result|:2: not a valid episode record/],
    ];
    for (const [what, text, re] of cases) {
      writeFileSync(file, text);
      await assert.rejects(readEpisodeLog(file, noSecrets), re, what);
    }
  });

  it('refuses a record or a log that holds a supplied secret', async () => {
    const out = outDir();
    const key = 'sk-ant-LEAK-1234567';
    const ep = await stage(out, { final_reply: `key ${key}`, messages: [episode().messages[0]!, { seq: 1, role: 'assistant', type: 'final_reply', text: `key ${key}`, commentary: '' }] });
    await assert.rejects(appendEpisode(out, ep, redactor([key])), /holds a supplied secret/);
    const file = path.join(out, 'logs', 'run1.episodes.jsonl');
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${canonicalJson(ep)}\n`);
    await assert.rejects(readEpisodeLog(file, redactor([key])), /holds a supplied secret/);
  });

  it('keeps the engine state files private, and refuses a dump that holds a secret', async () => {
    const out = outDir();
    await assert.rejects(writeArtifacts(out, 'run1__t__1', { finalState: { now: 'x', tables: { a: [{ id: 'sk-ant-S3CRET-99999' }] }, counters: {} } as never }, redactor(['sk-ant-S3CRET-99999'])), /holds a supplied secret/);
    await writeArtifacts(out, 'run1__t__2', { callLog: { calls: [{ q: 'sk-ant-S3CRET-99999' }] } }, redactor(['sk-ant-S3CRET-99999']));
    assert.equal(read(out, 'private/episodes/run1__t__2/calls.json'), '{"calls":[{"q":"[redacted]"}]}');
  });
});

describe('export', () => {
  it('splits successes from failures, writes a manifest with checksums, and reopens clean', async () => {
    const out = outDir();
    const a = await stage(out);
    const b = await stage(out, { task: 'second', ...failure() });
    const c = await stage(out, { task: 'third', score: 0, final_reply: 'Confident but wrong.', messages: [episode().messages[0]!, { seq: 1, role: 'assistant', type: 'final_reply', text: 'Confident but wrong.', commentary: '' }] });
    for (const e of [c, a, b]) await appendEpisode(out, e, noSecrets);
    const res = await exportDataset({ out, redact: noSecrets });

    assert.deepEqual(res.accepted.map((e) => e.task_id), [EASY]);
    assert.deepEqual(res.failed.map((e) => e.task_id), ['second', 'third']);
    assert.equal(read(out, DATASET_FILE), `${canonicalJson(a)}\n`);
    assert.equal(read(out, FAILURES_FILE), `${canonicalJson(b)}\n${canonicalJson(c)}\n`);
    const m = JSON.parse(read(out, MANIFEST_FILE));
    assert.deepEqual(m.counts, { episodes: 3, accepted: 1, failed: 2, by_stop_reason: { done: 2, turn_limit: 1 } });
    assert.deepEqual([m.manifest_version, m.schema_version, m.provider, m.model], [1, 1, 'anthropic', 'claude-sonnet-5-5']);
    assert.deepEqual([m.engine_commits, m.run_ids, m.prompt_versions, m.config_versions], [['a0ca1351234567'], ['run1'], ['solver-prompt-1'], ['cfg-000000000000']]);
    assert.deepEqual(m.worlds, [{ world_id: 'helpdesk', world_version: WORLD_VERSION, artifact: { path: `private/worlds/${WORLD_VERSION}/world.yaml`, sha256: WORLD_VERSION } }]);
    assert.equal(m.files.dataset.sha256, sha256Hex(read(out, DATASET_FILE)));
    assert.equal(m.files.failures.records, 2);
    assert.equal(m.selection, null);
    assert.equal(m.grading_note, GRADING_NOTE);
    assert.equal((await validateExport(out, { redact: noSecrets })).counts.accepted, 1);
  });

  it('is idempotent: exporting again gives the same bytes and no duplicate rows, even with a duplicated saved line', async () => {
    const out = outDir();
    const a = await stage(out);
    await appendEpisode(out, a, noSecrets);
    await exportDataset({ out, redact: noSecrets });
    const first = [DATASET_FILE, FAILURES_FILE, MANIFEST_FILE].map((n) => read(out, n));
    await exportDataset({ out, redact: noSecrets });
    assert.deepEqual([DATASET_FILE, FAILURES_FILE, MANIFEST_FILE].map((n) => read(out, n)), first);
    const log = path.join(out, 'logs', 'run1.episodes.jsonl');
    writeFileSync(log, `${canonicalJson(a)}\n${canonicalJson(a)}\n`);
    await exportDataset({ out, redact: noSecrets });
    assert.deepEqual([DATASET_FILE, FAILURES_FILE, MANIFEST_FILE].map((n) => read(out, n)), first);
    assert.equal(read(out, DATASET_FILE).split('\n').filter(Boolean).length, 1);
  });

  it('fails on conflicting duplicate ids and leaves the earlier export untouched', async () => {
    const out = outDir();
    const a = await stage(out);
    await appendEpisode(out, a, noSecrets);
    await exportDataset({ out, redact: noSecrets });
    const before = [DATASET_FILE, FAILURES_FILE, MANIFEST_FILE].map((n) => read(out, n));
    writeFileSync(path.join(out, 'logs', 'run1.episodes.jsonl'), `${canonicalJson(a)}\n${canonicalJson({ ...a, score: 0.5 })}\n`);
    await assert.rejects(exportDataset({ out, redact: noSecrets }), /saved twice with different content/);
    assert.deepEqual([DATASET_FILE, FAILURES_FILE, MANIFEST_FILE].map((n) => read(out, n)), before);
  });

  it('lets exports of one --out overlap: each publishes one whole, valid set and leaves nothing behind', async () => {
    const out = outDir();
    for (const run of ['run1', 'run2']) await appendEpisode(out, await stage(out, { run }), noSecrets);
    const results = await Promise.all(Array.from({ length: 6 }, () => exportDataset({ out, redact: noSecrets })));
    assert.equal(new Set(results.map((r) => JSON.stringify(r.manifest))).size, 1);
    assert.deepEqual((await validateExport(out, { redact: noSecrets })).run_ids, ['run1', 'run2']);
    assert.deepEqual(readdirSync(out).sort(), [DATASET_FILE, FAILURES_FILE, 'logs', MANIFEST_FILE, 'private']);
  });

  it('waits for an export that is already running before it reads the logs', async () => {
    const out = outDir();
    await appendEpisode(out, await stage(out), noSecrets);
    const claim = path.join(out, '.export.lock');
    writeFileSync(claim, '{"pid":1}\n');
    let settled = false;
    const pending = exportDataset({ out, redact: noSecrets }).finally(() => { settled = true; });
    await sleep(300);
    assert.equal(settled, false);
    assert.equal(existsSync(path.join(out, MANIFEST_FILE)), false);
    unlinkSync(claim);
    assert.equal((await pending).manifest.counts.episodes, 1);
    assert.equal(existsSync(claim), false);
  });

  it('exports by run, task and episode id, records the selection, and refuses a selection that matches nothing', async () => {
    const out = outDir();
    for (const e of [await stage(out, { run: 'run1' }), await stage(out, { run: 'run2' }), await stage(out, { run: 'run2', task: 'other' })]) await appendEpisode(out, e, noSecrets);
    const all = await exportDataset({ out, redact: noSecrets });
    assert.deepEqual(all.accepted.map((e) => e.episode_id), [`run1__${EASY}__1`, `run2__${EASY}__1`, 'run2__other__1']);
    assert.deepEqual(all.manifest.run_ids, ['run1', 'run2']);
    const byRun = await exportDataset({ out, redact: noSecrets, runIds: ['run2'] });
    assert.deepEqual(byRun.accepted.map((e) => e.episode_id), [`run2__${EASY}__1`, 'run2__other__1']);
    assert.deepEqual(byRun.manifest.selection, { run_ids: ['run2'], task_ids: [], episode_ids: [] });
    const one = await exportDataset({ out, redact: noSecrets, taskIds: [EASY], episodeIds: [`run1__${EASY}__1`, `run2__${EASY}__1`], runIds: ['run1'] });
    assert.deepEqual(one.accepted.map((e) => e.episode_id), [`run1__${EASY}__1`]);
    await assert.rejects(exportDataset({ out, redact: noSecrets, runIds: ['nope'] }), /match no saved episode/);
  });

  it('writes an empty dataset and lists every episode as a failure when no solver succeeded', async () => {
    const out = outDir();
    for (const t of ['a', 'b']) await appendEpisode(out, await stage(out, { task: t, ...failure() }), noSecrets);
    const res = await exportDataset({ out, redact: noSecrets });
    assert.equal(res.accepted.length, 0);
    assert.equal(read(out, DATASET_FILE), '');
    assert.equal(read(out, FAILURES_FILE).split('\n').filter(Boolean).length, 2);
    assert.deepEqual(res.manifest.counts, { episodes: 2, accepted: 0, failed: 2, by_stop_reason: { turn_limit: 2 } });
    assert.equal((await validateExport(out, { redact: noSecrets })).files.dataset.records, 0);
  });

  it('refuses to export without saved logs, or when the frozen world is missing or changed', async () => {
    const empty = tmp('nolog');
    await assert.rejects(exportDataset({ out: empty, redact: noSecrets }), /no saved episode logs/);
    const out = outDir();
    await appendEpisode(out, await stage(out), noSecrets);
    const world = path.join(out, ...worldArtifactPath(WORLD_VERSION).split('/'));
    writeFileSync(world, `${WORLD_TEXT}# edited\n`);
    await assert.rejects(exportDataset({ out, redact: noSecrets }), /hashes to .* not its world version/);
  });

  it('refuses to export a secret into any public file', async () => {
    const out = outDir();
    await appendEpisode(out, await stage(out), noSecrets);
    await assert.rejects(exportDataset({ out, redact: redactor(['helpdesk']) }), /holds a supplied secret/);
  });
});

describe('reopening an export', () => {
  async function exported(): Promise<string> {
    const out = outDir();
    await appendEpisode(out, await stage(out), noSecrets);
    await appendEpisode(out, await stage(out, { task: 'b', ...failure() }), noSecrets);
    await exportDataset({ out, redact: noSecrets });
    return out;
  }
  const check = (out: string): Promise<unknown> => validateExport(out, { redact: noSecrets });
  const rewriteManifest = (out: string, f: (m: any) => void): void => {
    const m = JSON.parse(read(out, MANIFEST_FILE));
    f(m);
    writeFileSync(path.join(out, MANIFEST_FILE), `${JSON.stringify(m, null, 2)}\n`);
  };

  it('rejects a changed record, a changed manifest count, a missing file and a corrupt manifest', async () => {
    let out = await exported();
    writeFileSync(path.join(out, DATASET_FILE), read(out, DATASET_FILE).replace('"score":1', '"score":0'));
    await assert.rejects(check(out), /fails its checksum/);

    out = await exported();
    rewriteManifest(out, (m) => (m.counts.accepted = 2));
    await assert.rejects(check(out), /manifest counts do not match/);

    out = await exported();
    rewriteManifest(out, (m) => (m.files.failures.records = 5));
    await assert.rejects(check(out), /has 1 records, the manifest says 5/);

    out = await exported();
    writeFileSync(path.join(out, FAILURES_FILE), '');
    await assert.rejects(check(out), /bytes, the manifest says/);

    out = await exported();
    writeFileSync(path.join(out, MANIFEST_FILE), '{not json');
    await assert.rejects(check(out), /manifest.json: not JSON/);

    out = await exported();
    rewriteManifest(out, (m) => (m.extra = 1));
    await assert.rejects(check(out), /not a valid manifest/);

    out = await exported();
    writeFileSync(path.join(out, MANIFEST_FILE), '');
    await assert.rejects(check(out), DatasetError);
  });

  it('rejects a row in the wrong file: a failure in dataset.jsonl, a success in failures.jsonl', async () => {
    const out = outDir();
    const bad = await stage(out, { score: 0 });
    const line = `${canonicalJson(bad)}\n`;
    const good = await stage(out, { task: 'g' });
    const goodLine = `${canonicalJson(good)}\n`;
    const entry = (text: string, p: string) => ({ path: p, records: 1, bytes: Buffer.byteLength(text), sha256: sha256Hex(text) });
    const manifest = (datasetText: string, failuresText: string, accepted: number, failed: number) => ({
      manifest_version: 1, schema_version: 1, provider: 'anthropic', model: 'claude-sonnet-5-5', prompt_versions: ['solver-prompt-1'], config_versions: ['cfg-000000000000'],
      engine_commits: ['a0ca1351234567'], run_ids: ['run1'], selection: null,
      worlds: [{ world_id: 'helpdesk', world_version: WORLD_VERSION, artifact: { path: worldArtifactPath(WORLD_VERSION), sha256: WORLD_VERSION } }],
      counts: { episodes: 1, accepted, failed, by_stop_reason: { done: 1 } },
      files: { dataset: { ...entry(datasetText, DATASET_FILE), records: accepted }, failures: { ...entry(failuresText, FAILURES_FILE), records: failed } },
      grading_note: GRADING_NOTE,
    });
    writeFileSync(path.join(out, DATASET_FILE), line);
    writeFileSync(path.join(out, FAILURES_FILE), '');
    writeFileSync(path.join(out, MANIFEST_FILE), JSON.stringify(manifest(line, '', 1, 0)));
    await assert.rejects(check(out), /is not a complete success/);
    writeFileSync(path.join(out, DATASET_FILE), '');
    writeFileSync(path.join(out, FAILURES_FILE), goodLine);
    writeFileSync(path.join(out, MANIFEST_FILE), JSON.stringify(manifest('', goodLine, 0, 1)));
    await assert.rejects(check(out), /is a complete success and belongs in dataset.jsonl/);
  });

  it('rejects an id that appears twice across the files, and records out of order or not canonical', async () => {
    const out = outDir();
    const a = await stage(out);
    const same = canonicalJson(a);
    const entry = (text: string, p: string, n: number) => ({ path: p, records: n, bytes: Buffer.byteLength(text), sha256: sha256Hex(text) });
    const base = (ds: string, fl: string, nd: number, nf: number, accepted: number, failed: number) => ({
      manifest_version: 1, schema_version: 1, provider: 'anthropic', model: 'claude-sonnet-5-5', prompt_versions: ['solver-prompt-1'], config_versions: ['cfg-000000000000'],
      engine_commits: ['a0ca1351234567'], run_ids: ['run1'], selection: null,
      worlds: [{ world_id: 'helpdesk', world_version: WORLD_VERSION, artifact: { path: worldArtifactPath(WORLD_VERSION), sha256: WORLD_VERSION } }],
      counts: { episodes: accepted + failed, accepted, failed, by_stop_reason: { done: accepted + failed } },
      files: { dataset: entry(ds, DATASET_FILE, nd), failures: entry(fl, FAILURES_FILE, nf) }, grading_note: GRADING_NOTE,
    });
    const write = (ds: string, fl: string, m: unknown): void => {
      writeFileSync(path.join(out, DATASET_FILE), ds);
      writeFileSync(path.join(out, FAILURES_FILE), fl);
      writeFileSync(path.join(out, MANIFEST_FILE), JSON.stringify(m));
    };
    // The same row twice in dataset.jsonl.
    write(`${same}\n${same}\n`, '', base(`${same}\n${same}\n`, '', 2, 0, 2, 0));
    await assert.rejects(check(out), /records are not in run, task, episode order/);
    // Not in key order: z before a.
    const z = canonicalJson(await stage(out, { task: 'z' }));
    const bb = canonicalJson(await stage(out, { task: 'b' }));
    write(`${z}\n${bb}\n`, '', base(`${z}\n${bb}\n`, '', 2, 0, 2, 0));
    await assert.rejects(check(out), /records are not in run, task, episode order/);
    // Pretty-printed, not canonical.
    const pretty = `${JSON.stringify(a)}\n`;
    write(pretty, '', base(pretty, '', 1, 0, 1, 0));
    await assert.rejects(check(out), /not in canonical form/);
  });

  it('needs the engine state files of every accepted episode, and checks them against the recorded hashes', async () => {
    let out = await exported();
    writeFileSync(path.join(out, 'private/episodes', `run1__${EASY}__1`, 'final.json'), JSON.stringify(dumpFor('tampered')));
    await assert.rejects(check(out), /private final.json does not match the recorded state hash/);
    out = await exported();
    writeFileSync(path.join(out, 'private/episodes', `run1__${EASY}__1`, 'initial.json'), '{nope');
    await assert.rejects(check(out), /private initial.json is not JSON/);
    out = await exported();
    writeFileSync(path.join(out, 'private/worlds', WORLD_VERSION, 'world.yaml'), 'changed');
    await assert.rejects(check(out), /fails its checksum/);
  });
});
