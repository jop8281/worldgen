import { existsSync, readFileSync, writeSync } from 'node:fs';
import { parseEpisode, redactor } from '../../src/dataset/schema.ts';
import { appendEpisode } from '../../src/dataset/store.ts';

const [out, record, release, mode] = process.argv.slice(2);
if (out === undefined || record === undefined || release === undefined) throw new Error('missing writer fixture arguments');
const episode = parseEpisode(JSON.parse(readFileSync(record, 'utf8')), 'writer fixture');
const clean = redactor([]);
const wait = new Int32Array(new SharedArrayBuffer(4));
let held = false;

try {
  const result = await appendEpisode(out, episode, {
    ...clean,
    assertClean(where, text) {
      clean.assertClean(where, text);
      if (!where.endsWith('.episodes.jsonl') || held) return;
      held = true;
      writeSync(1, 'held\n');
      if (mode === 'throw') throw new Error('controlled owner failure');
      const deadline = performance.now() + 10_000;
      while (!existsSync(release)) {
        if (performance.now() >= deadline) throw new Error('writer fixture timed out');
        Atomics.wait(wait, 0, 0, 20);
      }
    },
  });
  writeSync(1, `${result}\n`);
} catch (error) {
  writeSync(2, `${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
