/**
 * `bun run evidence` (A-392): an exported dataset re-checked from the repository alone. Uses the committed gen-orders
 * export, whose four episodes replay on the frozen world beside them, and copies of it altered in one place each.
 */
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { main } from '../src/cli/evidence.ts';
import { checkExportFolder } from '../src/dataset/evidence.ts';

const REPO = path.resolve(import.meta.dirname, '../..');
const ORDERS = path.join(REPO, 'eval/dataset/2026-10-07/gen-orders');

let tmp = '';
before(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'evidence-'));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** A copy of the gen-orders export folder inside its own export dir. */
async function copyOfOrders(name: string): Promise<string> {
  const folder = path.join(tmp, name, 'gen-orders');
  await cp(ORDERS, folder, { recursive: true });
  return folder;
}

describe('checkExportFolder', () => {
  it('replays every committed gen-orders episode to its recorded score on the frozen world', async () => {
    const f = await checkExportFolder(ORDERS);
    assert.deepEqual(f.changedFiles, []);
    assert.equal(f.worldVersion, 'cf95a05bc09eea7f17f2a1a5b090d9e1a42e0f293bee0520553937ba7b66c956');
    assert.equal(f.worldOk, true);
    assert.equal(f.failedRuns, 0);
    assert.deepEqual(f.replays.map((r) => [r.episode, r.recorded, r.replayed, r.seedOk, r.calls, r.mismatches, r.finalOk, r.agrees]), [
      ['gen-orders-w2__cancel_stale_pending_with_gift_note__1', 1, 1, true, 3, 0, true, true],
      ['gen-orders-w2__pay_oldest_pending_for_customer__1', 1, 1, true, 3, 0, true, true],
      ['gen-orders-w2__refund_delivered_big_orders_for_customer__1', 1, 1, true, 3, 0, true, true],
      ['gen-orders-w2__ship_all_paid_large_orders__1', 1, 1, true, 4, 0, true, true],
    ]);
  });

  it('flags an edited episode: the file no longer matches its sha-256, and the replay answers otherwise', async () => {
    const folder = await copyOfOrders('tampered');
    const file = path.join(folder, 'dataset.jsonl');
    const [first, ...rest] = (await readFile(file, 'utf8')).split('\n');
    const ep = JSON.parse(first!);
    const result = ep.messages.find((m: { type: string }) => m.type === 'tool_result');
    result.status = 404;
    await writeFile(file, [JSON.stringify(ep), ...rest].join('\n'));
    const f = await checkExportFolder(folder);
    assert.deepEqual(f.changedFiles, ['dataset.jsonl']);
    const r = f.replays[0]!;
    assert.deepEqual([r.episode, r.mismatches, r.agrees], ['gen-orders-w2__cancel_stale_pending_with_gift_note__1', 1, false]);
    assert.deepEqual(f.replays.slice(1).map((x) => x.agrees), [true, true, true]);
  });

  it('refuses a world the episodes did not run on, and replays nothing against it', async () => {
    const f = await checkExportFolder(ORDERS, path.join(REPO, 'prod/worlds/helpdesk'));
    assert.equal(f.worldOk, false);
    assert.deepEqual(f.replays, []);
  });
});

describe('bun run evidence', () => {
  it('answers 0 and one summary line when every folder agrees', async () => {
    await copyOfOrders('clean');
    const lines: string[] = [];
    assert.equal(await main([path.join(tmp, 'clean')], (l) => void lines.push(l)), 0);
    assert.equal(lines.at(-1), '4 of 4 episodes replay to their recorded score; 1 of 1 folders agree');
    assert.equal(lines[2], '  world  cf95a05bc09e ok, the version the episodes ran on');
  });

  it('answers 1 when a folder differs', async () => {
    const lines: string[] = [];
    assert.equal(await main([path.join(tmp, 'tampered')], (l) => void lines.push(l)), 1);
    assert.equal(lines.at(-1), '3 of 4 episodes replay to their recorded score; 0 of 1 folders agree');
  });

  it('answers 2 on an unknown option or a dir with no export', async () => {
    assert.equal(await main(['--bogus'], () => {}), 2);
    assert.equal(await main([path.join(tmp, 'no-such-dir')], () => {}), 2);
  });
});
