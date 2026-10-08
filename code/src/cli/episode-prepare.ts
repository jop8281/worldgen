/**
 * The prepare child (A-347, A-353). Not a user command: `dataset/local.ts` spawns it once per
 * episode, and `dataset/pipeline.ts` spawns it for the dataset run's check and prepare, with cwd the code dir, as
 *
 *   bun src/cli/episode-prepare.ts <worldDir> <out>
 *   bun src/cli/episode-prepare.ts --check <worldDir>
 *
 * The controller process holds the model key, and the vm is not a security boundary, so it never runs
 * a world's snippets. This child checks the world, which runs them, freezes it under <out>, and
 * prints everything of the prepared world but the CheckedWorld as one JSON object on stdout, in an
 * environment of only TZ, PATH and the guard scale.
 *
 * `--check` only checks: it writes nothing and prints `{ tasks, source, wid }`, where `source` is the
 * checked world as JSON for the controller's secret guard and `wid` its id, which the prepare's must match.
 *
 * Exit 0 comes with that object. 2 bad usage, 3 the world does not check or cannot be frozen
 * (stderr carries the message), 5 anything else.
 */
import { worldIdOf } from '#engine';
import { DatasetError } from '../dataset/schema.ts';
import { PreflightError, checkForRun, prepareWorld } from '../dataset/pipeline.ts';

const fail = (code: number, message: string): number => {
  process.stderr.write(`${message}\n`);
  return code;
};

async function main(argv: readonly string[]): Promise<number> {
  if (argv[0] === '--check') {
    const dir = argv[1];
    if (argv.length !== 2 || dir === undefined) return fail(2, 'usage: episode-prepare --check <worldDir>');
    try {
      const { world, tasks } = await checkForRun(dir);
      process.stdout.write(`${JSON.stringify({ tasks, source: JSON.stringify(world), wid: worldIdOf(world) })}\n`);
      return 0;
    } catch (e) {
      return fail(e instanceof PreflightError ? 3 : 5, e instanceof Error ? e.message : String(e));
    }
  }
  const [worldDir, out] = argv;
  if (argv.length !== 2 || worldDir === undefined || out === undefined) return fail(2, 'usage: episode-prepare <worldDir> <out> | --check <worldDir>');
  try {
    const { world: _world, ...prepared } = await prepareWorld(worldDir, out);
    process.stdout.write(`${JSON.stringify(prepared)}\n`);
    return 0;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return fail(e instanceof PreflightError || e instanceof DatasetError ? 3 : 5, message);
  }
}

process.exitCode = await main(process.argv.slice(2));
