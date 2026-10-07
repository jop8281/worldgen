/**
 * The trusted verifier child process (YOS-159, A-224). Not a user command: `dataset/verifier.ts`
 * spawns it, one process per submission, as
 *
 *   node_modules/.bin/tsx src/cli/verifier.ts <privateWorldDir> <requestFile> <engineRevision> <ledgerFile>
 *
 * It loads and checks the private world, verifies one protocol request against it (the engine's
 * `verifySubmission` replays the trace and grades), records the submission in the run's ledger,
 * and prints exactly one bounded verdict JSON object on stdout. It has no listener, reads no
 * credential (its environment is only TZ and PATH), and touches no file but the request, the
 * ledger and the private world.
 *
 * Exit 0 always comes with a verdict, graded or rejected, and a rejection never carries grader
 * source. A non-zero exit means the verifier itself failed and no score may be used: 2 bad
 * usage, 3 the private world does not load or check, 4 the request or ledger cannot be read,
 * 5 an unexpected failure. stderr carries only these authored one-line reasons, never world or
 * grader content.
 */
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { checkWorld, loadWorld, verifySubmission, worldIdOf, type VerifierHeld } from '#engine';

const WORLD_FILE = 'world.yaml';

const fail = (code: number, message: string): number => {
  process.stderr.write(`${message}\n`);
  return code;
};

/** The submission ids this verifier session (the run's ledger) already graded. Null when the ledger is corrupt. */
async function readLedger(file: string): Promise<ReadonlySet<string> | null> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (e) {
    return (e as { code?: unknown } | null)?.code === 'ENOENT' ? new Set<string>() : null;
  }
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return null;
    }
    const submission = (entry as { submission?: unknown } | null)?.submission;
    if (typeof submission !== 'string' || submission === '') return null;
    seen.add(submission);
  }
  return seen;
}

async function main(argv: readonly string[]): Promise<number> {
  const [worldDir, requestFile, engine, ledgerFile] = argv;
  if (argv.length !== 4 || worldDir === undefined || requestFile === undefined || engine === undefined || ledgerFile === undefined) {
    return fail(2, 'usage: verifier <privateWorldDir> <requestFile> <engineRevision> <ledgerFile>');
  }

  const loaded = await loadWorld(worldDir);
  if (!loaded.ok) return fail(3, `the private world in ${worldDir} does not load`);
  const report = checkWorld(loaded.value);
  if (!report.ok) return fail(3, `the private world in ${worldDir} does not check`);
  const world = report.world;

  let worldYaml: string;
  let requestText: string;
  try {
    worldYaml = await readFile(path.join(worldDir, WORLD_FILE), 'utf8');
    requestText = await readFile(requestFile, 'utf8');
  } catch {
    return fail(4, `the request ${requestFile} or the world ${path.join(worldDir, WORLD_FILE)} cannot be read`);
  }

  const seen = await readLedger(ledgerFile);
  if (seen === null) return fail(4, `the verifier ledger ${ledgerFile} is corrupt`);

  // The held identities: the WID of the parsed full world, the sha of the world.yaml file this
  // process holds, and the engine revision the spawner declared.
  const held: VerifierHeld = {
    wid: worldIdOf(world),
    worldVersion: createHash('sha256').update(worldYaml, 'utf8').digest('hex'),
    engine,
  };

  const { verdict, ledger } = verifySubmission(world, held, requestText, seen);
  if (ledger !== null) {
    try {
      await mkdir(path.dirname(ledgerFile), { recursive: true, mode: 0o700 });
      await appendFile(ledgerFile, `${JSON.stringify({ submission: ledger })}\n`, { mode: 0o600 });
    } catch {
      // No recorded submission, no verdict: the score must not be used a second time.
      return fail(5, `the verifier ledger ${ledgerFile} could not be written`);
    }
  }
  process.stdout.write(`${JSON.stringify(verdict)}\n`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
