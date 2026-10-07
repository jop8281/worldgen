/** Read current eval case paths only. Hidden history is never discovered as another case. */
import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { CASE_ID } from '../worldgen/eval.ts';
import { validateExpectedCases, type EvalEvidence, type ExpectedEvalCase } from '../worldgen/eval-outcomes.ts';

const absent = (e: unknown): boolean => e instanceof Error && 'code' in e && e.code === 'ENOENT';
async function stat(file: string) {
  try { return await lstat(file); } catch (e) { if (absent(e)) return null; throw e; }
}
async function readRegular(file: string): Promise<string | null> {
  const info = await stat(file);
  if (info === null) return null;
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe evidence file');
  return readFile(file, 'utf8');
}

export async function readEvalEvidence(runDirectory: string, expected: readonly ExpectedEvalCase[]): Promise<EvalEvidence[]> {
  validateExpectedCases(expected);
  const root = await lstat(runDirectory);
  if (!root.isDirectory() || root.isSymbolicLink()) throw new Error('Run directory must be a real directory');
  const names = await readdir(runDirectory);
  const ids = [...new Set([...expected.map((c) => c.id), ...names.filter((name) => CASE_ID.test(name))])].sort();
  const evidence: EvalEvidence[] = [];
  for (const id of ids) {
    // IDs come only from the validated manifest or validated directory names, never case.json.
    const dir = path.join(runDirectory, id);
    const source = path.join(id, 'case.json');
    try {
      const info = await stat(dir);
      if (info === null) continue;
      if (!info.isDirectory() || info.isSymbolicLink()) {
        // Ordinary root files aren't case evidence; a symlink could conceal a case.
        if (!info.isSymbolicLink() && !expected.some((c) => c.id === id)) continue;
        throw new Error('Unsafe case directory');
      }
      const caseText = await readRegular(path.join(dir, 'case.json'));
      if (caseText === null) continue;
      const create = await readRegular(path.join(dir, 'events.jsonl'));
      const changeDir = path.join(dir, 'change');
      const changeInfo = await stat(changeDir);
      if (changeInfo !== null && (!changeInfo.isDirectory() || changeInfo.isSymbolicLink())) throw new Error('Unsafe change directory');
      const change = changeInfo === null ? null : await readRegular(path.join(changeDir, 'events.jsonl'));
      evidence.push({ id, source, caseText, logs: { create, change } });
    } catch {
      evidence.push({ id, source, caseText: null, logs: {}, problem: 'Unreadable or unsafe current case evidence' });
    }
  }
  return evidence;
}
