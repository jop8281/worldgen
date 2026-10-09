/**
 * `bun run evidence` (A-392): an exported dataset re-checked from the repository alone. Uses the committed gen-orders
 * export, whose four episodes replay on the frozen world beside them, and copies of it altered in one place each.
 */
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { checkWorld, createRuntime, loadWorld, renderWorldYaml } from '#engine';
import { main } from '../src/cli/evidence.ts';
import { checkExportFolder, replayEpisode } from '../src/dataset/evidence.ts';
import { canonicalJson, hashState, outcomeOf, parseEpisode, sha256Hex, type Episode } from '../src/dataset/schema.ts';

const REPO = path.resolve(import.meta.dirname, '../..');
const ORDERS = path.join(REPO, 'eval/dataset/2026-10-07/gen-orders');

let tmp = '';
before(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'evidence-'));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** A copy of the gen-orders export folder inside its own export dir, optionally altered. */
async function copyOfOrders(name: string, alter?: (folder: string) => Promise<void>): Promise<string> {
  const folder = path.join(tmp, name, 'gen-orders');
  await cp(ORDERS, folder, { recursive: true });
  if (alter !== undefined) await alter(folder);
  return folder;
}

/** Rewrites the first episode of dataset.jsonl. */
const editFirstEpisode = (edit: (ep: Record<string, any>) => void) => async (folder: string): Promise<void> => {
  const file = path.join(folder, 'dataset.jsonl');
  const [first, ...rest] = (await readFile(file, 'utf8')).split('\n');
  const ep = JSON.parse(first!);
  edit(ep);
  await writeFile(file, [JSON.stringify(ep), ...rest].join('\n'));
};
const firstResultIs404 = editFirstEpisode((ep) => {
  ep.messages.find((m: { type: string }) => m.type === 'tool_result').status = 404;
});

/**
 * The committed version 1 gen-orders export rewritten as version 2 (A-389): every row in dataset.jsonl with its outcome,
 * the last one turned into a done run the engine scored 0, and a manifest 2 with its counts and checksum.
 */
const asVersion2 = async (folder: string): Promise<void> => {
  const v1rows = (await readFile(path.join(folder, 'dataset.jsonl'), 'utf8')).split('\n').filter(Boolean);
  const rows = v1rows.map((l, i) => {
    const ep = parseEpisode(JSON.parse(l), `row ${i + 1}`);
    if (i !== v1rows.length - 1) return ep;
    const failed = { ...ep, score: 0 };
    return { ...failed, outcome: outcomeOf(failed, null) };
  });
  const text = rows.map((r) => `${canonicalJson(r)}\n`).join('');
  const m = JSON.parse(await readFile(path.join(folder, 'manifest.json'), 'utf8'));
  const manifest = {
    ...m, manifest_version: 2, schema_version: 2,
    counts: { episodes: 4, by_verdict: { success: 3, partial: 0, failure: 1, infra: 0 }, by_stop_reason: { done: 4 }, by_failure_cause: { 'scored 0': 1 } },
    files: { dataset: { path: 'dataset.jsonl', records: 4, bytes: Buffer.byteLength(text), sha256: sha256Hex(text) } },
  };
  await writeFile(path.join(folder, 'dataset.jsonl'), text);
  await rm(path.join(folder, 'failures.jsonl'));
  await writeFile(path.join(folder, 'manifest.json'), JSON.stringify(manifest, null, 2));
};

describe('checkExportFolder', () => {
  it('reads a version 2 export: replays its complete successes and counts its other rows, unreplayed (A-389)', async () => {
    const f = await checkExportFolder(await copyOfOrders('v2', asVersion2));
    assert.equal(f.error, null);
    assert.deepEqual([f.changedFiles, f.worldOk, f.failedRuns], [[], true, 1]);
    assert.deepEqual(f.replays.map((r) => [r.episode, r.agrees]), [
      ['gen-orders-w2__cancel_stale_pending_with_gift_note__1', true],
      ['gen-orders-w2__pay_oldest_pending_for_customer__1', true],
      ['gen-orders-w2__refund_delivered_big_orders_for_customer__1', true],
    ]);
  });

  it('replays every committed gen-orders episode to its recorded score on the frozen world', async () => {
    const f = await checkExportFolder(ORDERS);
    assert.equal(f.error, null);
    assert.deepEqual(f.changedFiles, []);
    assert.equal(f.worldVersion, 'cf95a05bc09eea7f17f2a1a5b090d9e1a42e0f293bee0520553937ba7b66c956');
    assert.equal(f.worldOk, true);
    assert.equal(f.failedRuns, 0);
    // The frozen world predates A-388: its graders never read these texts, and the replay still reproduces every score.
    assert.deepEqual(f.gaps, [
      'refund_delivered_big_orders_for_customer grader never reads order_event.note',
      'cancel_stale_pending_with_gift_note grader never reads order_event.note',
      'ship_all_paid_large_orders grader never reads order.tracking_number',
    ]);
    assert.deepEqual(f.replays.map((r) => [r.episode, r.recorded, r.replayed, r.taskOk, r.seedOk, r.calls, r.mismatches, r.finalOk, r.agrees]), [
      ['gen-orders-w2__cancel_stale_pending_with_gift_note__1', 1, 1, true, true, 3, 0, true, true],
      ['gen-orders-w2__pay_oldest_pending_for_customer__1', 1, 1, true, true, 3, 0, true, true],
      ['gen-orders-w2__refund_delivered_big_orders_for_customer__1', 1, 1, true, true, 3, 0, true, true],
      ['gen-orders-w2__ship_all_paid_large_orders__1', 1, 1, true, true, 4, 0, true, true],
    ]);
  });

  it('flags an edited episode: the file no longer matches its sha-256, and the replay answers otherwise', async () => {
    const f = await checkExportFolder(await copyOfOrders('tampered', firstResultIs404));
    assert.deepEqual(f.changedFiles, ['dataset.jsonl']);
    const r = f.replays[0]!;
    assert.deepEqual([r.episode, r.mismatches, r.agrees], ['gen-orders-w2__cancel_stale_pending_with_gift_note__1', 1, false]);
    assert.deepEqual(f.replays.slice(1).map((x) => x.agrees), [true, true, true]);
  });

  it('flags an episode whose instruction is not the world task it names', async () => {
    const f = await checkExportFolder(await copyOfOrders('reworded', editFirstEpisode((ep) => {
      ep.messages[0].text = 'Cancel every order in the store.';
    })));
    assert.deepEqual([f.replays[0]!.taskOk, f.replays[0]!.agrees], [false, false]);
  });

  it('reports a cut dataset.jsonl line as one invalid episode instead of throwing', async () => {
    const f = await checkExportFolder(await copyOfOrders('cut', async (folder) => {
      const file = path.join(folder, 'dataset.jsonl');
      await writeFile(file, (await readFile(file, 'utf8')).slice(0, 2000));
    }));
    assert.deepEqual(f.changedFiles, ['dataset.jsonl']);
    assert.deepEqual(f.replays.map((r) => [r.episode, r.replayed, r.agrees]), [['dataset.jsonl:1', 'episode.invalid', false]]);
  });

  it('reports an unreadable manifest and a manifest naming two worlds as folder errors', async () => {
    const broken = await checkExportFolder(await copyOfOrders('broken-manifest', (folder) => writeFile(path.join(folder, 'manifest.json'), '{"manifest_version":')));
    assert.match(broken.error ?? '', /^manifest\.json: /);
    const two = await checkExportFolder(await copyOfOrders('two-worlds', async (folder) => {
      const file = path.join(folder, 'manifest.json');
      const m = JSON.parse(await readFile(file, 'utf8'));
      m.worlds.push({ ...m.worlds[0], world_version: 'a'.repeat(64), artifact: { ...m.worlds[0].artifact, sha256: 'a'.repeat(64) } });
      await writeFile(file, JSON.stringify(m));
    }));
    assert.equal(two.error, 'manifest.json names 2 worlds; a folder holds exactly one frozen world');
  });

  it('refuses a world the episodes did not run on, and replays nothing against it', async () => {
    const f = await checkExportFolder(ORDERS, path.join(REPO, 'prod/worlds/helpdesk'));
    assert.equal(f.worldOk, false);
    assert.deepEqual(f.replays, []);
  });
});

describe('replayEpisode', () => {
  it('accepts a DELETE answered 204 with no body, which the episode records as ""', async () => {
    const loaded = await loadWorld(path.join(REPO, 'prod/worlds/gen-petstore'));
    if (!loaded.ok) assert.fail('gen-petstore did not load');
    const report = checkWorld(loaded.value);
    if (!report.ok) assert.fail('gen-petstore did not check');
    const world = report.world;
    const [taskId, task] = Object.entries(world.tasks)[0]!;
    const request = { method: 'DELETE', path: '/pet/pet_0003', query: {} };
    const seed = createRuntime(world);
    const after = createRuntime(world);
    assert.equal(after.call({ method: 'DELETE', path: '/pet/pet_0003', query: {}, body: undefined }).status, 204);
    const template = JSON.parse((await readFile(path.join(ORDERS, 'dataset.jsonl'), 'utf8')).split('\n')[0]!);
    const ep: Episode = {
      ...template,
      task_id: taskId,
      difficulty: task.difficulty,
      world_version: sha256Hex(renderWorldYaml(world)),
      initial_state_hash: hashState(JSON.parse(JSON.stringify(seed.dump()))),
      final_state_hash: hashState(JSON.parse(JSON.stringify(after.dump()))),
      messages: [
        { seq: 0, role: 'user', type: 'instruction', text: task.instruction },
        { seq: 1, role: 'assistant', type: 'tool_call', call_id: 'c1', request, commentary: '' },
        { seq: 2, role: 'tool', type: 'tool_result', call_id: 'c1', outcome: 'response', status: 204, body: '', truncated: false, detail: null },
        { seq: 3, role: 'assistant', type: 'final_reply', text: 'Done.', commentary: '' },
      ],
    };
    const r = replayEpisode(world, ep);
    assert.deepEqual([r.taskOk, r.seedOk, r.calls, r.mismatches, r.finalOk], [true, true, 1, 0, true]);
  });
});

describe('bun run evidence', () => {
  it('answers 0 and one summary line when every folder agrees', async () => {
    await copyOfOrders('clean');
    const lines: string[] = [];
    assert.equal(await main([path.join(tmp, 'clean')], (l) => void lines.push(l)), 0);
    assert.equal(lines.at(-1), '4 of 4 episodes replay to their recorded score; 1 of 1 folders agree');
    assert.equal(lines[2], '  world  cf95a05bc09e ok, the version the episodes ran on');
    assert.deepEqual(lines.filter((l) => l.startsWith('  note')), [
      '  note   frozen world predates A-388: refund_delivered_big_orders_for_customer grader never reads order_event.note',
      '  note   frozen world predates A-388: cancel_stale_pending_with_gift_note grader never reads order_event.note',
      '  note   frozen world predates A-388: ship_all_paid_large_orders grader never reads order.tracking_number',
    ]);
  });

  it('answers 1 when a folder differs', async () => {
    await copyOfOrders('cli-tampered', firstResultIs404);
    const lines: string[] = [];
    assert.equal(await main([path.join(tmp, 'cli-tampered')], (l) => void lines.push(l)), 1);
    assert.equal(lines.at(-1), '3 of 4 episodes replay to their recorded score; 0 of 1 folders agree');
  });

  it('answers 2 on an unknown option or a dir with no export', async () => {
    assert.equal(await main(['--bogus'], () => {}), 2);
    assert.equal(await main([path.join(tmp, 'no-such-dir')], () => {}), 2);
  });
});
