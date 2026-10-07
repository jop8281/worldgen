import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import YAML from 'yaml';
import { z } from 'zod';
import { CHECK_LAYERS } from '../src/engine/check.ts';
import { checkWorld } from '../src/engine/index.ts';

const expectationSchema = z.object({
  code: z.string(),
  path: z.array(z.union([z.string(), z.number()])),
  layer: z.enum(CHECK_LAYERS),
});

const casesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'broken-worlds');
const expectedCases = [
  'compile',
  'lints',
  'nondeterministic-entropy',
  'reference',
  'route',
  'schema',
  'seed',
  'state-machine',
  'task-decoy-full-marks',
  'task-noop-not-zero',
  'task-prefix-full-marks',
  'task-solution-not-full',
  'tests',
];

const cases = readdirSync(casesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

describe('broken-world conformance corpus', () => {
  it('keeps every check layer and task failure family represented', () => {
    assert.deepEqual(cases, expectedCases);
  });

  for (const name of cases) {
    it(`${name} reports its exact first issue`, async () => {
      const caseDir = path.join(casesDir, name);
      const files = (await readdir(caseDir)).sort();
      assert.deepEqual(files, ['expect.json', 'world.yaml']);

      const [worldSource, expectationSource] = await Promise.all([
        readFile(path.join(caseDir, 'world.yaml'), 'utf8'),
        readFile(path.join(caseDir, 'expect.json'), 'utf8'),
      ]);
      const world: unknown = YAML.parse(worldSource);
      const expected = expectationSchema.parse(JSON.parse(expectationSource));
      const report = checkWorld(world);
      const first = report.ok ? report.warnings[0] : report.issues[0];

      assert.equal(report.ok, expected.layer === 'lints');
      assert.ok(first, 'the fixture should produce an issue or lint');
      assert.deepEqual({
        code: first.code,
        path: first.path,
        layer: report.ok ? 'lints' : report.reached,
      }, expected);
    });
  }
});
