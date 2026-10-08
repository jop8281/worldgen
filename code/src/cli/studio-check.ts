/**
 * The Studio's check child (A-338). Not a user command: `studio/server.ts` spawns it, one process
 * per Explorer request, as
 *
 *   bun src/cli/studio-check.ts <worldDir> <name>
 *
 * The web process holds the model key, the sandbox key and the sign-in token, and the vm is not a
 * security boundary, so the web process never runs a world's snippets. This child loads and checks
 * the world, which runs them, in an environment of only TZ, PATH and the guard scale, and prints
 * the Explorer view as one JSON object on stdout.
 *
 * Exit 0 comes with that object. 2 bad usage, 3 the world does not load or check. stderr carries
 * only the authored one-line reason, which is the text the route returns, never task source.
 */
import { checkWorld, loadWorld } from '#engine';
import { explorerOf } from '../studio/explorer.ts';

const fail = (code: number, message: string): number => {
  process.stderr.write(`${message}\n`);
  return code;
};

async function main(argv: readonly string[]): Promise<number> {
  const [worldDir, name] = argv;
  if (argv.length !== 2 || worldDir === undefined || name === undefined) return fail(2, 'usage: studio-check <worldDir> <name>');
  const loaded = await loadWorld(worldDir);
  if (!loaded.ok) return fail(3, `${name} does not load: ${loaded.error[0].code}`);
  const report = checkWorld(loaded.value);
  if (!report.ok) return fail(3, `${name} does not check: ${report.issues.map((i) => i.code).slice(0, 5).join(', ')}`);
  process.stdout.write(`${JSON.stringify(explorerOf(name, report.world))}\n`);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
