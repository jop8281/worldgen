/**
 * The local episode's prepare child (A-347). Not a user command: `dataset/local.ts` spawns it once
 * per episode, with cwd the code dir, as
 *
 *   bun src/cli/episode-prepare.ts <worldDir> <out>
 *
 * The episode process holds the model key, and the vm is not a security boundary, so it never runs
 * a world's snippets. This child checks the world, which runs them, freezes it under <out>, and
 * prints everything of the prepared world but the CheckedWorld as one JSON object on stdout, in an
 * environment of only TZ, PATH and the guard scale.
 *
 * Exit 0 comes with that object. 2 bad usage, 3 the world does not check or cannot be frozen
 * (stderr carries the message), 5 anything else.
 */
import { DatasetError } from '../dataset/schema.ts';
import { PreflightError, prepareWorld } from '../dataset/pipeline.ts';

const fail = (code: number, message: string): number => {
  process.stderr.write(`${message}\n`);
  return code;
};

async function main(argv: readonly string[]): Promise<number> {
  const [worldDir, out] = argv;
  if (argv.length !== 2 || worldDir === undefined || out === undefined) return fail(2, 'usage: episode-prepare <worldDir> <out>');
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
