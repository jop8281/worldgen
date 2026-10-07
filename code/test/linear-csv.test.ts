/**
 * The Linear backlog CSV eval case (YOS-95, A-54, testbed T1): the frozen export and its label file,
 * loaded through the csv input kind. Adapter only; the live generation run is separate.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { digestInput, parseCsv } from '../src/worldgen/input.ts';

const input = (name: string): string => fileURLToPath(new URL(`../../eval/inputs/${name}`, import.meta.url));
const BACKLOG = input('linear-backlog.csv');
const LABELS = input('linear-backlog.labels.csv');

async function rows(path: string): Promise<Record<string, string>[]> {
  const [head, ...body] = parseCsv(await readFile(path, 'utf8'), path);
  return body.map((r) => Object.fromEntries(head!.map((h, i) => [h, r[i] ?? ''])));
}

describe('linear-backlog.csv', () => {
  it('has the eleven columns and 123 rows', async () => {
    const [head, ...body] = parseCsv(await readFile(BACKLOG, 'utf8'), BACKLOG);
    assert.deepEqual(head, ['ID', 'Title', 'Status', 'Priority', 'Project', 'Milestone', 'Labels', 'Parent', 'Created', 'Updated', 'Completed']);
    assert.equal(body.length, 123);
  });

  it('digest has no email pattern and the file has no Assignee column', async () => {
    const r = await digestInput({ kind: 'csv', paths: [BACKLOG] });
    if (!r.ok) throw new Error(r.why);
    assert.equal(/\S+@\S+/.test(JSON.stringify(r.digest)), false);
    assert.equal(r.digest.summary.includes('Table linear_backlog: 123 rows, key id'), true);
    assert.equal((await rows(BACKLOG)).every((x) => !('Assignee' in x)), true);
  });

  it('the file itself has no @ and descriptions are absent', async () => {
    assert.equal((await readFile(BACKLOG, 'utf8')).includes('@'), false);
  });

  it('every Parent resolves to an ID in the file', async () => {
    const all = await rows(BACKLOG);
    const ids = new Set(all.map((x) => x.ID ?? ''));
    assert.equal(ids.size, 123);
    const parents = all.map((x) => x.Parent ?? '').filter((p) => p !== '');
    assert.equal(parents.length, 3);
    for (const p of parents) assert.equal(ids.has(p), true);
  });

  it('the label file covers every Status with a valid category', async () => {
    const labels = await rows(LABELS);
    assert.deepEqual(labels.map((l) => `${l.Status}=${l.Category}`), [
      'Backlog=backlog', 'In Progress=started', 'In Review=started', 'Done=completed', 'Duplicate=canceled', 'Canceled=canceled',
    ]);
    const statuses = new Set((await rows(BACKLOG)).map((x) => x.Status));
    assert.deepEqual([...statuses].sort(), labels.map((l) => l.Status).sort());
  });
});
