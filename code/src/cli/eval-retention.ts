import { lstat, mkdir, mkdtemp, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { CASE_ID, caseLayout, type CaseLayout } from '../worldgen/eval.ts';

function code(error: unknown): unknown {
  return error instanceof Error && 'code' in error ? error.code : undefined;
}

async function directory(at: string, recursive = false): Promise<void> {
  try {
    await mkdir(at, { recursive });
  } catch (error) {
    if (code(error) !== 'EEXIST') throw error;
  }
  if (!(await lstat(at)).isDirectory()) throw new Error(`Eval storage must be a real directory: ${at}`);
}

/**
 * Retains the previous case by atomic rename before allowing new writes at its usual path.
 * The lock covers this case only; callers must serialize whole-suite summary publication.
 * A killed process leaves active.lock in place for deliberate operator recovery.
 */
export async function withEvalAttempt<T>(
  runDir: string,
  caseId: string,
  run: (layout: CaseLayout) => Promise<T>,
  onRetained: (directory: string) => void = () => {},
): Promise<T> {
  if (!CASE_ID.test(caseId)) throw new Error('invalid eval case id');
  const layout = caseLayout(runDir, caseId);
  await directory(runDir, true);
  const history = path.join(runDir, '.attempts');
  await directory(history);
  const caseHistory = path.join(history, caseId);
  await directory(caseHistory);
  const lockPath = path.join(caseHistory, 'active.lock');
  const lock = await open(lockPath, 'wx', 0o600).catch((error: unknown) => {
    if (code(error) === 'EEXIST') throw new Error(
      `Eval case ${caseId} is active or interrupted; inspect ${lockPath} and confirm its process stopped before removing the lock`,
      { cause: error },
    );
    throw error;
  });
  try {
    await lock.writeFile(`${JSON.stringify({ pid: process.pid })}\n`);
    let retained: string | null = null;
    try {
      const previous = await lstat(layout.dir).catch((error: unknown) => {
        if (code(error) === 'ENOENT') return null;
        throw error;
      });
      if (previous !== null) {
        if (!previous.isDirectory()) throw new Error(`Eval case must be a real directory: ${layout.dir}`);
        const attempt = await mkdtemp(path.join(caseHistory, 'attempt-'));
        await directory(attempt);
        const destination = path.join(attempt, 'artifacts');
        await rename(layout.dir, destination);
        retained = destination;
        onRetained(destination);
      }
      await mkdir(layout.dir);
    } catch (error) {
      if (retained !== null) throw new Error(
        `Cannot prepare eval case ${caseId}; previous artifacts retained at ${retained}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
      throw error;
    }
    return await run(layout);
  } finally {
    await lock.close();
    await unlink(lockPath);
  }
}
