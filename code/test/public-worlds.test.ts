import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkWorld, loadWorld, publicWorldOf, renderWorldYaml, taskPrivacy } from '#engine';

const WORLDS = fileURLToPath(new URL('../../prod/worlds/', import.meta.url));
const FIX = 'run `bun scripts/render-public-worlds.ts` from code/ and commit the result';

/** Same filter as worlds.test.ts: no dot dirs, no unfinished `.partial` runs; `generated/` holds worlds one level down. */
async function worldDirs(): Promise<string[]> {
  const subdirs = async (dir: string): Promise<string[]> =>
    (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.endsWith('.partial')).map((e) => e.name);
  const top = await subdirs(WORLDS);
  const generated = top.includes('generated') ? (await subdirs(path.join(WORLDS, 'generated'))).map((n) => `generated/${n}`) : [];
  return [...top.filter((n) => n !== 'generated'), ...generated].sort();
}

describe('committed public worlds (YOS-159)', async () => {
  for (const name of await worldDirs()) {
    it(`${name}/public/world.yaml is the public form of the private world`, async () => {
      const loaded = await loadWorld(path.join(WORLDS, name));
      if (!loaded.ok) assert.fail(`${name} did not load`);
      const priv = checkWorld(loaded.value);
      if (!priv.ok) assert.fail(`${name} failed check at ${priv.reached}`);
      const pub = checkWorld(publicWorldOf(priv.world));
      if (!pub.ok) assert.fail(`${name} public form failed check at ${pub.reached}:\n${JSON.stringify(pub.issues, null, 2)}`);

      const file = path.join(WORLDS, name, 'public', 'world.yaml');
      const text = await readFile(file, 'utf8').catch(() => assert.fail(`${file} is missing: ${FIX}`));
      assert.equal(text, renderWorldYaml(pub.world), `${file} is stale: ${FIX}`);

      const committed = await loadWorld(path.join(WORLDS, name, 'public'));
      if (!committed.ok) assert.fail(`${file} did not load`);
      const report = checkWorld(committed.value);
      if (!report.ok) assert.fail(`${file} failed check at ${report.reached}`);
      if (Object.keys(report.world.tasks).length > 0) assert.equal(taskPrivacy(report.world), 'public');
      for (const [id, task] of Object.entries(report.world.tasks)) {
        assert.deepEqual(Object.keys(task).sort(), ['alternatives', 'decoys', 'difficulty', 'instruction'], `${name} task ${id}`);
        assert.deepEqual(task.decoys, [], `${name} task ${id} decoys`);
        assert.deepEqual(task.alternatives, [], `${name} task ${id} alternatives`);
      }
      assert.deepEqual(Object.keys(report.world.tasks), Object.keys(priv.world.tasks));
    });
  }
});
