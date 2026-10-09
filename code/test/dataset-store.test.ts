import assert from 'node:assert/strict';
import type { StateDump } from '#engine';
import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  DatasetError, GRADING_NOTE, canonicalJson, episodeSchema, hashState, isCompleteSuccess, outcomeOf, parseEpisode, redactor, sha256Hex, type Episode,
  type GradeCounts,
} from '../src/dataset/schema.ts';
import {
  DATASET_FILE, FAILURES_FILE, MANIFEST_FILE, appendEpisode, exportDataset, newEntryDirs, readEpisodeLog, validateExport, worldArtifactPath, writeArtifacts,
} from '../src/dataset/store.ts';
import { EASY, KIT_COUNTS, episode, noSecrets, tmp, v1 } from './dataset-kit.ts';

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

/** A success whose state hashes match private files written under `out`. `over` can break it; `counts` are the verifier's. */
async function stage(out: string, over: Partial<Episode> & { task?: string; run?: string; counts?: GradeCounts | null } = {}): Promise<Episode> {
  const { task = EASY, run = 'run1', counts = KIT_COUNTS, ...rest } = over;
  const id = `${run}__${task}__1`;
  const initial = dumpFor(`${id}-0`);
  const final = dumpFor(`${id}-1`);
  const ep = episode({ episode_id: id, run_id: run, task_id: task, world_version: WORLD_VERSION, initial_state_hash: hashState(initial), final_state_hash: hashState(final), ...rest }, counts);
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
  // Built through episode(), so the outcome follows the changed fields and only the rule under test can fail.
  const withMessages = (m: unknown[], over: Partial<Episode> = {}): Episode => episode({ ...over, messages: m as Episode['messages'] });

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
  it('is strict: no extra keys anywhere, only the Anthropic provider and a Claude model id (A-283), only version 2', () => {
    assert.equal(ok({ ...episode(), extra: 1 }), false);
    assert.equal(ok({ ...episode(), model: 'claude-opus-5-5' }), true);
    assert.equal(ok({ ...episode(), model: null }), true, 'null: the agent called no model');
    assert.equal(ok({ ...episode(), model: 'gpt-5' }), false);
    assert.equal(ok({ ...episode(), model: 'claude-opus-5-5 --fallback-model x' }), false);
    assert.equal(ok({ ...episode(), provider: 'openai' }), false);
    assert.equal(ok({ ...episode(), schema_version: 1 }), false, 'a version 1 row reads through parseEpisode, not as is');
    assert.equal(ok({ ...episode(), schema_version: 3 }), false);
    assert.equal(ok({ ...episode(), thinking: 'hidden' }), false);
    assert.equal(ok(withMessages([instruction, { ...call, thinking: 'x' }, result, final])), false);
    assert.equal(ok(episode({ score: 1.5 })), false);
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
      const e = episodeSchema.safeParse(episode(over));
      assert.equal(e.success, true, `${what}: a valid record`);
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
    await assert.rejects(appendEpisode(out, await stage(out, { score: 0.5 }), noSecrets), /already saved with different content/);
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

/** Counts the verifier answers: goals met of total, guards held of total. */
const counts = (met: number, goals: number, held: number, guards: number): GradeCounts => ({ goals: { met, total: goals }, guards: { held, total: guards } });

/** One episode of each verdict (A-389), staged under `out`: a success, a turn limit, a broken guard, a partial and an infra stop. */
async function everyVerdict(out: string): Promise<Record<'success' | 'limit' | 'guard' | 'partial' | 'infra', Episode>> {
  const reply = (text: string): Partial<Episode> => ({ final_reply: text, messages: [episode().messages[0]!, { seq: 1, role: 'assistant', type: 'final_reply', text, commentary: '' }] });
  return {
    success: await stage(out, { counts: counts(2, 2, 1, 1) }),
    limit: await stage(out, { task: 'second', ...failure(), counts: counts(0, 2, 1, 1) }),
    guard: await stage(out, { task: 'third', score: 0, ...reply('Confident but wrong.'), counts: counts(2, 2, 0, 1) }),
    partial: await stage(out, { task: 'fourth', score: 0.5, ...reply('Half of it.'), counts: counts(1, 2, 1, 1) }),
    infra: await stage(out, { task: 'fifth', ...failure({ stop_reason: 'model_error', error: 'model call failed', score: null }), counts: null }),
  };
}

describe('outcome labels (A-389)', () => {
  it('labels each row with its reward, verdict and a public failure cause, from the record and the verifier counts', () => {
    const at = (over: Partial<Episode>, c: GradeCounts | null) => episode(over, c).outcome;
    assert.deepEqual(at({}, counts(2, 2, 1, 1)), { reward: 1, verdict: 'success', failure_cause: null, goals: { met: 2, total: 2 }, guards: { held: 1, total: 1 } });
    assert.deepEqual(at({ score: 0.5 }, counts(1, 2, 1, 1)), { reward: 0.5, verdict: 'partial', failure_cause: '1 of 2 goals met', goals: { met: 1, total: 2 }, guards: { held: 1, total: 1 } });
    assert.deepEqual(at({ score: 0 }, counts(2, 2, 0, 1)), { reward: 0, verdict: 'failure', failure_cause: 'guard broken', goals: { met: 2, total: 2 }, guards: { held: 0, total: 1 } });
    assert.deepEqual(at({ score: 0.25 }, counts(0, 0, 0, 0)), { reward: 0.25, verdict: 'partial', failure_cause: 'scored 0.25', goals: { met: 0, total: 0 }, guards: { held: 0, total: 0 } });
    assert.deepEqual(at(failure(), counts(0, 2, 1, 1)), { reward: 0, verdict: 'failure', failure_cause: 'turn_limit', goals: { met: 0, total: 2 }, guards: { held: 1, total: 1 } });
    assert.deepEqual(at(failure({ stop_reason: 'model_error', error: 'x', score: 0.5 }), counts(1, 2, 1, 1)), { reward: 0.5, verdict: 'infra', failure_cause: 'model_error', goals: { met: 1, total: 2 }, guards: { held: 1, total: 1 } });
    assert.deepEqual(at({ score: null, stop_reason: 'grade_error', error: 'grading failed' }, null), { reward: 0, verdict: 'infra', failure_cause: 'grade_error', goals: null, guards: null });
    assert.deepEqual(at({ score: null }, null), { reward: 0, verdict: 'infra', failure_cause: 'scored none', goals: null, guards: null });
    assert.deepEqual(at({ usage: { ...episode().usage, unaccounted_calls: 1 } }, counts(1, 1, 0, 0)), { reward: 1, verdict: 'partial', failure_cause: 'incomplete record', goals: { met: 1, total: 1 }, guards: { held: 0, total: 0 } });
    assert.deepEqual(at(failure({ stop_reason: 'invalid_turn', error: 'not a valid turn' }), counts(0, 1, 1, 1)), { reward: 0, verdict: 'failure', failure_cause: 'invalid_turn', goals: { met: 0, total: 1 }, guards: { held: 1, total: 1 } });
    // An episode's own budget or deadline is the agent's; a run's shared one is not (A-396).
    for (const [stop, verdict, cause] of [
      ['budget_limit', 'failure', 'budget_limit'], ['time_limit', 'failure', 'time_limit'], ['run_budget_limit', 'infra', 'run budget'], ['run_time_limit', 'infra', 'run time'],
    ] as const) {
      assert.deepEqual(at(failure({ stop_reason: stop, error: 'cut' }), counts(0, 1, 1, 1)), { reward: 0, verdict, failure_cause: cause, goals: { met: 0, total: 1 }, guards: { held: 1, total: 1 } }, stop);
    }
  });

  it('refuses an outcome the record does not imply, half-counted grades and a count above its total', () => {
    const ok = (e: unknown): boolean => episodeSchema.safeParse(e).success;
    assert.equal(ok(episode()), true);
    assert.equal(ok({ ...episode(), score: 0.5 }), false, 'the outcome still says success');
    assert.equal(ok({ ...episode(), outcome: { ...episode().outcome, verdict: 'partial' } }), false);
    assert.equal(ok({ ...episode(), outcome: { ...episode().outcome, failure_cause: 'the grader wanted a refund' } }), false, 'no free text');
    assert.equal(ok({ ...episode(), outcome: { ...episode().outcome, guards: null } }), false, 'goals without guards');
    assert.equal(ok(episode({}, counts(3, 2, 0, 0))), false, 'more goals met than there are');
    assert.equal(ok({ ...episode(), outcome: { ...episode().outcome, goals: { met: 1, total: 1, names: ['x'] } } }), false, 'counts only, no names');
    const ungraded = episode({ score: null }, null);
    assert.equal(ok(ungraded), true);
    assert.equal(ok({ ...ungraded, outcome: { ...ungraded.outcome, goals: { met: 1, total: 1 }, guards: { held: 1, total: 1 } } }), false, 'an ungraded row has no counts');
    assert.equal(ok(episode({}, counts(1, 1, 0, 1))), false, 'a broken guard scores 0, never 1');
    assert.equal(ok(episode({ score: 0 }, counts(1, 1, 0, 1))), true);
  });

  it('reads a version 1 row as version 2, with the outcome derived and no verifier counts', () => {
    const old = v1(episode({ score: 0.5 }));
    assert.equal(old.schema_version, 1);
    const read = parseEpisode(JSON.parse(canonicalJson(old)), 'old');
    assert.equal(read.schema_version, 2);
    assert.deepEqual(read.outcome, { reward: 0.5, verdict: 'partial', failure_cause: 'scored 0.5', goals: null, guards: null });
    assert.deepEqual(outcomeOf(old, null), read.outcome);
  });
});

describe('export', () => {
  it('puts every episode in dataset.jsonl with its outcome, counts them by verdict and cause, and reopens clean', async () => {
    const out = outDir();
    const e = await everyVerdict(out);
    for (const x of [e.guard, e.success, e.infra, e.limit, e.partial]) await appendEpisode(out, x, noSecrets);
    const res = await exportDataset({ out, redact: noSecrets });

    assert.deepEqual(res.episodes.map((x) => [x.task_id, x.outcome.verdict, x.outcome.reward, x.outcome.failure_cause]), [
      [EASY, 'success', 1, null],
      ['fifth', 'infra', 0, 'model_error'],
      ['fourth', 'partial', 0.5, '1 of 2 goals met'],
      ['second', 'failure', 0, 'turn_limit'],
      ['third', 'failure', 0, 'guard broken'],
    ]);
    assert.equal(read(out, DATASET_FILE), [e.success, e.infra, e.partial, e.limit, e.guard].map((x) => `${canonicalJson(x)}\n`).join(''));
    assert.equal(existsSync(path.join(out, FAILURES_FILE)), false);
    const m = JSON.parse(read(out, MANIFEST_FILE));
    assert.deepEqual(m.counts, {
      episodes: 5,
      by_verdict: { success: 1, partial: 1, failure: 2, infra: 1 },
      by_stop_reason: { done: 3, model_error: 1, turn_limit: 1 },
      by_failure_cause: { '1 of 2 goals met': 1, 'guard broken': 1, model_error: 1, turn_limit: 1 },
    });
    assert.deepEqual([m.manifest_version, m.schema_version, m.provider, m.model], [2, 2, 'anthropic', 'claude-sonnet-5-5']);
    assert.deepEqual([m.engine_commits, m.run_ids, m.prompt_versions, m.config_versions], [['a0ca1351234567'], ['run1'], ['solver-prompt-1'], ['cfg-000000000000']]);
    assert.deepEqual(m.worlds, [{ world_id: 'helpdesk', world_version: WORLD_VERSION, artifact: { path: `private/worlds/${WORLD_VERSION}/world.yaml`, sha256: WORLD_VERSION } }]);
    assert.deepEqual(Object.keys(m.files), ['dataset']);
    assert.equal(m.files.dataset.sha256, sha256Hex(read(out, DATASET_FILE)));
    assert.equal(m.files.dataset.records, 5);
    assert.equal(m.selection, null);
    assert.equal(m.grading_note, GRADING_NOTE);
    assert.equal((await validateExport(out, { redact: noSecrets })).manifest_version, 2);
  });

  it('keeps the successes-only view behind a flag, records it, and refuses a failure in such an export', async () => {
    const out = outDir();
    for (const x of Object.values(await everyVerdict(out))) await appendEpisode(out, x, noSecrets);
    const res = await exportDataset({ out, redact: noSecrets, successesOnly: true });
    assert.deepEqual(res.episodes.map((x) => x.task_id), [EASY]);
    assert.deepEqual(res.manifest.selection, { run_ids: [], task_ids: [], episode_ids: [], successes_only: true });
    assert.deepEqual(res.manifest.counts, { episodes: 1, by_verdict: { success: 1, partial: 0, failure: 0, infra: 0 }, by_stop_reason: { done: 1 }, by_failure_cause: {} });
    assert.equal(read(out, DATASET_FILE).split('\n').filter(Boolean).length, 1);

    // The full export of the same logs, relabelled as successes-only, is refused row by row.
    const full = await exportDataset({ out, redact: noSecrets });
    const m = JSON.parse(read(out, MANIFEST_FILE));
    m.selection = { run_ids: [], task_ids: [], episode_ids: [], successes_only: true };
    writeFileSync(path.join(out, MANIFEST_FILE), JSON.stringify(m));
    await assert.rejects(validateExport(out, { redact: noSecrets }), /fifth__1 is not a success, and this export keeps successes only/);
    assert.equal(full.episodes.length, 5);
  });

  it('exports an empty dataset with the flag when nothing succeeded, and every row without it', async () => {
    const out = outDir();
    for (const t of ['a', 'b']) await appendEpisode(out, await stage(out, { task: t, ...failure() }), noSecrets);
    const only = await exportDataset({ out, redact: noSecrets, successesOnly: true });
    assert.deepEqual([only.episodes.length, read(out, DATASET_FILE)], [0, '']);
    const res = await exportDataset({ out, redact: noSecrets });
    assert.equal(read(out, DATASET_FILE).split('\n').filter(Boolean).length, 2);
    assert.deepEqual(res.manifest.counts, { episodes: 2, by_verdict: { success: 0, partial: 0, failure: 2, infra: 0 }, by_stop_reason: { turn_limit: 2 }, by_failure_cause: { turn_limit: 2 } });
    assert.equal((await validateExport(out, { redact: noSecrets })).manifest_version, 2);
  });

  it('removes the failures.jsonl a version 1 export left, since dataset.jsonl now holds its rows', async () => {
    const out = outDir();
    await appendEpisode(out, await stage(out, { task: 'b', ...failure() }), noSecrets);
    writeFileSync(path.join(out, FAILURES_FILE), 'stale\n');
    await exportDataset({ out, redact: noSecrets });
    assert.equal(existsSync(path.join(out, FAILURES_FILE)), false);
    assert.equal(read(out, DATASET_FILE).split('\n').filter(Boolean).length, 1);
  });

  it('re-exports version 1 episode logs as version 2 rows, with outcomes and no verifier counts', async () => {
    const out = outDir();
    const ok = await stage(out);
    const bad = await stage(out, { task: 'b', ...failure() });
    mkdirSync(path.join(out, 'logs'), { recursive: true });
    writeFileSync(path.join(out, 'logs', 'run1.episodes.jsonl'), `${canonicalJson(v1(ok))}\n${canonicalJson(v1(bad))}\n`);
    const res = await exportDataset({ out, redact: noSecrets });
    assert.deepEqual(res.episodes.map((x) => [x.schema_version, x.outcome]), [
      [2, { reward: 1, verdict: 'success', failure_cause: null, goals: null, guards: null }],
      [2, { reward: 0, verdict: 'failure', failure_cause: 'turn_limit', goals: null, guards: null }],
    ]);
  });

  it('is idempotent: exporting again gives the same bytes and no duplicate rows, even with a duplicated saved line', async () => {
    const out = outDir();
    const a = await stage(out);
    await appendEpisode(out, a, noSecrets);
    await exportDataset({ out, redact: noSecrets });
    const first = [DATASET_FILE, MANIFEST_FILE].map((n) => read(out, n));
    await exportDataset({ out, redact: noSecrets });
    assert.deepEqual([DATASET_FILE, MANIFEST_FILE].map((n) => read(out, n)), first);
    const log = path.join(out, 'logs', 'run1.episodes.jsonl');
    writeFileSync(log, `${canonicalJson(a)}\n${canonicalJson(a)}\n`);
    await exportDataset({ out, redact: noSecrets });
    assert.deepEqual([DATASET_FILE, MANIFEST_FILE].map((n) => read(out, n)), first);
    assert.equal(read(out, DATASET_FILE).split('\n').filter(Boolean).length, 1);
  });

  it('fails on conflicting duplicate ids and leaves the earlier export untouched', async () => {
    const out = outDir();
    const a = await stage(out);
    await appendEpisode(out, a, noSecrets);
    await exportDataset({ out, redact: noSecrets });
    const before = [DATASET_FILE, MANIFEST_FILE].map((n) => read(out, n));
    writeFileSync(path.join(out, 'logs', 'run1.episodes.jsonl'), `${canonicalJson(a)}\n${canonicalJson(await stage(out, { score: 0.5 }))}\n`);
    await assert.rejects(exportDataset({ out, redact: noSecrets }), /saved twice with different content/);
    assert.deepEqual([DATASET_FILE, MANIFEST_FILE].map((n) => read(out, n)), before);
  });

  it('lets exports of one --out overlap: each publishes one whole, valid set and leaves nothing behind', async () => {
    const out = outDir();
    for (const run of ['run1', 'run2']) await appendEpisode(out, await stage(out, { run }), noSecrets);
    const results = await Promise.all(Array.from({ length: 6 }, () => exportDataset({ out, redact: noSecrets })));
    assert.equal(new Set(results.map((r) => JSON.stringify(r.manifest))).size, 1);
    assert.deepEqual((await validateExport(out, { redact: noSecrets })).run_ids, ['run1', 'run2']);
    assert.deepEqual(readdirSync(out).sort(), [DATASET_FILE, 'logs', MANIFEST_FILE, 'private']);
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
    assert.deepEqual(all.episodes.map((e) => e.episode_id), [`run1__${EASY}__1`, `run2__${EASY}__1`, 'run2__other__1']);
    assert.deepEqual(all.manifest.run_ids, ['run1', 'run2']);
    const byRun = await exportDataset({ out, redact: noSecrets, runIds: ['run2'] });
    assert.deepEqual(byRun.episodes.map((e) => e.episode_id), [`run2__${EASY}__1`, 'run2__other__1']);
    assert.deepEqual(byRun.manifest.selection, { run_ids: ['run2'], task_ids: [], episode_ids: [], successes_only: false });
    const one = await exportDataset({ out, redact: noSecrets, taskIds: [EASY], episodeIds: [`run1__${EASY}__1`, `run2__${EASY}__1`], runIds: ['run1'] });
    assert.deepEqual(one.episodes.map((e) => e.episode_id), [`run1__${EASY}__1`]);
    await assert.rejects(exportDataset({ out, redact: noSecrets, runIds: ['nope'] }), /match no saved episode/);
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

describe('the recorded model (YOS-190)', () => {
  it('reads an episode log row written before the noop agent existed, which names its model', async () => {
    const file = path.join(tmp('old-row'), 'run1.episodes.jsonl');
    writeFileSync(file, `${canonicalJson(episode())}\n`);
    assert.deepEqual((await readEpisodeLog(file, noSecrets)).map((e) => e.model), ['claude-sonnet-5-5']);
  });

  it('exports a noop episode with no model beside a Sonnet one, and the manifest names Sonnet', async () => {
    const out = outDir();
    const sonnet = await stage(out);
    const noop = await stage(out, {
      task: 'noop-task', model: null, score: 0, final_reply: 'No action taken.',
      messages: [episode().messages[0]!, { seq: 1, role: 'assistant', type: 'final_reply', text: 'No action taken.', commentary: '' }],
      usage: { ...episode().usage, model_calls: 0, cost_usd: 0 },
    });
    for (const e of [sonnet, noop]) await appendEpisode(out, e, noSecrets);
    const res = await exportDataset({ out, redact: noSecrets });
    assert.deepEqual(res.episodes.map((e) => [e.model, e.outcome.verdict]), [['claude-sonnet-5-5', 'success'], [null, 'failure']]);
    assert.equal(JSON.parse(read(out, MANIFEST_FILE)).model, 'claude-sonnet-5-5');
    assert.equal((await validateExport(out, { redact: noSecrets })).model, 'claude-sonnet-5-5');
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
    rewriteManifest(out, (m) => (m.counts.by_verdict.success = 2));
    await assert.rejects(check(out), /manifest counts do not match/);

    out = await exported();
    rewriteManifest(out, (m) => (m.files.dataset.records = 5));
    await assert.rejects(check(out), /has 2 records, the manifest says 5/);

    out = await exported();
    writeFileSync(path.join(out, DATASET_FILE), '');
    await assert.rejects(check(out), /bytes, the manifest says/);

    out = await exported();
    writeFileSync(path.join(out, MANIFEST_FILE), '{not json');
    await assert.rejects(check(out), /manifest.json: not JSON/);

    out = await exported();
    rewriteManifest(out, (m) => (m.extra = 1));
    await assert.rejects(check(out), /not a valid manifest/);

    out = await exported();
    rewriteManifest(out, (m) => (m.files.failures = m.files.dataset));
    await assert.rejects(check(out), /not a valid manifest/);

    out = await exported();
    writeFileSync(path.join(out, MANIFEST_FILE), '');
    await assert.rejects(check(out), DatasetError);
  });

  it('rejects a relabelled row even with a matching checksum: the outcome must follow from the record', async () => {
    const out = await exported();
    const text = read(out, DATASET_FILE).replace('"verdict":"failure"', '"verdict":"success"');
    writeFileSync(path.join(out, DATASET_FILE), text);
    rewriteManifest(out, (m) => (m.files.dataset.sha256 = sha256Hex(text)));
    await assert.rejects(check(out), /not a valid episode record: outcome: must be/);
  });

  it('rejects a version 1 row inside a version 2 export', async () => {
    const out = await exported();
    const lines = read(out, DATASET_FILE).split('\n').filter(Boolean);
    const text = `${canonicalJson(v1(JSON.parse(lines[0]!)))}\n${lines[1]}\n`;
    writeFileSync(path.join(out, DATASET_FILE), text);
    rewriteManifest(out, (m) => (m.files.dataset = { ...m.files.dataset, bytes: Buffer.byteLength(text), sha256: sha256Hex(text) }));
    await assert.rejects(check(out), /dataset.jsonl:1: record is not in canonical form/);
  });

  it('needs the engine state files of every complete success, and checks them against the recorded hashes', async () => {
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

describe('reopening a version 1 export (before A-389)', () => {
  const check = (out: string) => validateExport(out, { redact: noSecrets });
  const entry = (text: string, p: string) => ({ path: p, records: text.split('\n').filter(Boolean).length, bytes: Buffer.byteLength(text), sha256: sha256Hex(text) });
  /** Writes `accepted` to dataset.jsonl and `failed` to failures.jsonl as version 1 rows, with a version 1 manifest that `edit` can change. */
  function writeV1(out: string, accepted: readonly Episode[], failed: readonly Episode[], edit: (m: any) => void = () => {}): void {
    const ds = accepted.map((e) => `${canonicalJson(v1(e))}\n`).join('');
    const fl = failed.map((e) => `${canonicalJson(v1(e))}\n`).join('');
    const stops: Record<string, number> = {};
    for (const e of [...accepted, ...failed]) stops[e.stop_reason] = (stops[e.stop_reason] ?? 0) + 1;
    const m = {
      manifest_version: 1, schema_version: 1, provider: 'anthropic', model: 'claude-sonnet-5-5', prompt_versions: ['solver-prompt-1'], config_versions: ['cfg-000000000000'],
      engine_commits: ['a0ca1351234567'], run_ids: ['run1'], selection: null,
      worlds: [{ world_id: 'helpdesk', world_version: WORLD_VERSION, artifact: { path: worldArtifactPath(WORLD_VERSION), sha256: WORLD_VERSION } }],
      counts: { episodes: accepted.length + failed.length, accepted: accepted.length, failed: failed.length, by_stop_reason: stops },
      files: { dataset: entry(ds, DATASET_FILE), failures: entry(fl, FAILURES_FILE) },
      grading_note: GRADING_NOTE,
    };
    edit(m);
    writeFileSync(path.join(out, DATASET_FILE), ds);
    writeFileSync(path.join(out, FAILURES_FILE), fl);
    writeFileSync(path.join(out, MANIFEST_FILE), JSON.stringify(m));
  }

  it('validates a version 1 export with its two files, and its rows read as version 2', async () => {
    const out = outDir();
    const good = await stage(out);
    const bad = await stage(out, { task: 'b', ...failure() });
    writeV1(out, [good], [bad]);
    const m = await check(out);
    assert.deepEqual([m.manifest_version, m.schema_version, m.counts], [1, 1, { episodes: 2, accepted: 1, failed: 1, by_stop_reason: { done: 1, turn_limit: 1 } }]);
    const row = parseEpisode(JSON.parse(read(out, FAILURES_FILE)), 'failures.jsonl:1');
    assert.deepEqual(row.outcome, { reward: 0, verdict: 'failure', failure_cause: 'turn_limit', goals: null, guards: null });
  });

  it('rejects a row in the wrong file: a failure in dataset.jsonl, a success in failures.jsonl', async () => {
    const out = outDir();
    const bad = await stage(out, { score: 0 });
    const good = await stage(out, { task: 'g' });
    writeV1(out, [bad], []);
    await assert.rejects(check(out), /is not a complete success/);
    writeV1(out, [], [good]);
    await assert.rejects(check(out), /is a complete success and belongs in dataset.jsonl/);
  });

  it('rejects an id that appears twice across the files, and records out of order or not canonical', async () => {
    const out = outDir();
    const a = await stage(out);
    writeV1(out, [a], [a], (m) => (m.counts = { episodes: 2, accepted: 1, failed: 1, by_stop_reason: { done: 2 } }));
    await assert.rejects(check(out), /is a complete success and belongs in dataset.jsonl/);
    writeV1(out, [a, a], []);
    await assert.rejects(check(out), /records are not in run, task, episode order/);
    writeV1(out, [await stage(out, { task: 'z' }), await stage(out, { task: 'b' })], []);
    await assert.rejects(check(out), /records are not in run, task, episode order/);
    const pretty = `${JSON.stringify(v1(a))}\n`;
    writeV1(out, [a], [], (m) => (m.files.dataset = { ...m.files.dataset, bytes: Buffer.byteLength(pretty), sha256: sha256Hex(pretty) }));
    writeFileSync(path.join(out, DATASET_FILE), pretty);
    await assert.rejects(check(out), /not in canonical form/);
    // A version 2 row cannot hide in a version 1 file.
    const v2line = `${canonicalJson(a)}\n`;
    writeV1(out, [a], [], (m) => (m.files.dataset = { ...m.files.dataset, bytes: Buffer.byteLength(v2line), sha256: sha256Hex(v2line) }));
    writeFileSync(path.join(out, DATASET_FILE), v2line);
    await assert.rejects(check(out), /not a valid version 1 episode record/);
  });
});
