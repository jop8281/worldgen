/**
 * `bun run studio`: the operator web app on one loopback port. Argument parsing and wiring
 * only; the page is studio/page.ts and the routes are studio/server.ts. The children
 * (`worldplay serve`, `worldgen`, `costs`) are spawned by the server through the injected
 * spawners from sandboxes/backend.ts; this file never imports llm.ts and makes no model call.
 * Exit codes: 0 never (the listening server keeps the process alive), 1 failure, 2 bad usage.
 *
 *   bun run studio [--port 8787] [--host 127.0.0.1] [--transport claude-cli|sdk] [--worlds-dir <dir>] [--repo-root <dir>]
 */
import path from 'node:path';
import { nodeRunner, nodeSpawn } from '../sandboxes/backend.ts';
import { studioServer } from '../studio/server.ts';

const DEFAULT_PORT = 8787;
const CODE_DIR = path.resolve(import.meta.dirname, '../..');

const USAGE = `usage: bun run studio [--port ${DEFAULT_PORT}] [--host 127.0.0.1] [--transport claude-cli|sdk] [--worlds-dir <dir>] [--repo-root <dir>]

The operator web app on one port (default ${DEFAULT_PORT}, bound to 127.0.0.1): the worlds
table, world rollout (a child worldplay serve per Serve click), generation runs (a child
worldgen whose events.jsonl the page polls), the eval runs and the spend ledger. Children are
spawned with the environment passed through untouched, so the operator's own env carries every
key (LLM_KEY, BOAT_API_KEY, the spend caps); the studio stores and logs none.
--repo-root defaults to the repository this file lives in; --worlds-dir defaults to
<repo-root>/prod/worlds. A served world keeps its own two ports; the studio port has no
/_world route. Ctrl-C stops the studio; the studio SIGTERMs its tracked children.
--host binds another interface. The studio has no login and starts worldgen runs, so bind
0.0.0.0 only inside a container whose port is published on the host's loopback.
--transport (or WORLDGEN_TRANSPORT) is passed to every worldgen run; sdk reads LLM_KEY from the
studio's own environment, which a container gets at run time (docker run -e LLM_KEY), never from the image.
GET /api/health answers readiness with WORLDGEN_BUILD_SHA, the runtime and the world count.
`;

class UsageError extends Error {}

type Args = { readonly port: number; readonly host: string | undefined; readonly transport: 'claude-cli' | 'sdk' | undefined; readonly repoRoot: string; readonly worldsDir: string | undefined };

function parse(argv: readonly string[]): Args | 'help' {
  if (argv.some((a) => a === '--help' || a === '-h')) return 'help';
  let port = DEFAULT_PORT;
  let repoRoot: string | undefined;
  let worldsDir: string | undefined;
  let host: string | undefined;
  let transport: string | undefined = process.env['WORLDGEN_TRANSPORT'] === '' ? undefined : process.env['WORLDGEN_TRANSPORT'];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined || v.trim() === '' || v.startsWith('--')) throw new UsageError(`${a} needs a value`);
      return v;
    };
    if (a === '--port') {
      const n = Number(value());
      if (!Number.isInteger(n) || n < 0 || n > 65535) throw new UsageError(`--port needs an integer from 0 to 65535, got ${n}`);
      port = n;
    } else if (a === '--host') host = value();
    else if (a === '--transport') transport = value();
    else if (a === '--repo-root') repoRoot = path.resolve(value());
    else if (a === '--worlds-dir') worldsDir = path.resolve(value());
    else throw new UsageError(`unknown argument ${a}`);
  }
  if (transport !== undefined && transport !== 'claude-cli' && transport !== 'sdk') throw new UsageError(`--transport must be claude-cli or sdk, got ${transport}`);
  return { port, host, transport, repoRoot: repoRoot ?? path.resolve(CODE_DIR, '..'), worldsDir };
}

async function main(argv: readonly string[]): Promise<number> {
  let args: Args | 'help';
  try {
    args = parse(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`${e.message}\n${USAGE}`);
    return 2;
  }
  if (args === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  try {
    const server = await studioServer({
      port: args.port,
      ...(args.host === undefined ? {} : { host: args.host }),
      ...(args.transport === undefined ? {} : { transport: args.transport }),
      ...(process.env['WORLDGEN_BUILD_SHA'] === undefined ? {} : { build: process.env['WORLDGEN_BUILD_SHA'] }),
      repoRoot: args.repoRoot,
      ...(args.worldsDir === undefined ? {} : { worldsDir: args.worldsDir }),
      spawner: nodeSpawn,
      runner: nodeRunner,
    });
    process.stdout.write(`studio on ${server.url} (worlds under ${args.worldsDir ?? path.join(args.repoRoot, 'prod', 'worlds')})\n`);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  return 0;
}

// The listening server holds the process open, so the exit code is only reached on a failure.
process.exitCode = await main(process.argv.slice(2));
