/**
 * A prod world's REPORT.md and capsule.json name the content ids of the world.yaml committed beside them (YOS-158,
 * A-332). The WID hashes the parsed world, so a new schema default moves it with no edit to world.yaml; this file
 * fails until the world's report and capsule are re-rendered (code/scripts/rerender-report.ts).
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadWorld, taskIdOf, worldIdOf, worldSchema } from '#engine';

const WORLDS = path.resolve(import.meta.dirname, '../../prod/worlds');

/** Each task row of a REPORT.md verdict table that ends in a TID: [task id, tid]. */
function citedTids(report: string): [string, string][] {
  return [...report.matchAll(/^\| (\S+) \|.*\| `(tid_[0-9a-f]{64})` \|$/gm)].map((m) => [m[1]!, m[2]!]);
}

describe('prod world reports and capsules cite the committed world', async () => {
  const names = (await readdir(WORLDS, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort();
  for (const name of names) {
    const dir = path.join(WORLDS, name);
    const report = await readFile(path.join(dir, 'REPORT.md'), 'utf8').catch(() => null);
    const capsule = await readFile(path.join(dir, 'capsule.json'), 'utf8').catch(() => null);
    if (report === null && capsule === null) continue;
    it(`${name}: every WID and TID it cites hashes from its world.yaml`, async () => {
      const loaded = await loadWorld(dir);
      assert.equal(loaded.ok, true);
      if (!loaded.ok) return;
      const world = worldSchema.parse(loaded.value);
      const wid = worldIdOf(world);
      if (capsule !== null) {
        const cited = (JSON.parse(capsule) as { worldId: string | null }).worldId;
        if (cited !== null) assert.equal(cited, wid, `${name}/capsule.json worldId`);
      }
      if (report !== null) {
        for (const cited of new Set(report.match(/wid_[0-9a-f]{64}/g) ?? [])) assert.equal(cited, wid, `${name}/REPORT.md WID`);
        for (const [task, tid] of citedTids(report)) {
          const def = world.tasks[task];
          assert.notEqual(def, undefined, `${name}/REPORT.md cites a TID for ${task}, which world.yaml has no task named`);
          if (def !== undefined) assert.equal(tid, taskIdOf(def), `${name}/REPORT.md TID of ${task}`);
        }
      }
    });
  }
});

describe('the hand-built helpdesk', () => {
  it('has the pinned WID: A-356 moved it by marking customer.email sensitive, and no other world moved', async () => {
    const loaded = await loadWorld(path.join(WORLDS, 'helpdesk'));
    assert.equal(loaded.ok, true);
    if (!loaded.ok) return;
    assert.equal(worldIdOf(worldSchema.parse(loaded.value)), 'wid_7c919f61f9a3c2b046e6367b99035ce8ae8d2aafc48601b23ed5d4c5b60eda2f');
  });
});
