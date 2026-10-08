/**
 * `bun run studio`: the operator web app on one loopback port. Argument parsing and wiring
 * only; the page is studio/page.ts and the routes are studio/server.ts. The children
 * (`worldplay serve`, `worldgen`, `costs`) are spawned by the server through the injected
 * spawners from sandboxes/backend.ts; this file never imports llm.ts and makes no model call.
 * Exit codes: 0 never (the listening server keeps the process alive), 1 failure, 2 bad usage.
 *
 *   bun run studio [--port 8787] [--host 127.0.0.1] [--transport claude-cli|sdk] [--users <file>] [--origin <url>] [--worlds-dir <dir>] [--repo-root <dir>]
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { nodeRunner, nodeSpawn } from '../sandboxes/backend.ts';
import { originOf, parseUsersFile, studioServer, type StudioUser } from '../studio/server.ts';

const DEFAULT_PORT = 8787;
const CODE_DIR = path.resolve(import.meta.dirname, '../..');

const USAGE = `usage: bun run studio [--port ${DEFAULT_PORT}] [--host 127.0.0.1] [--transport claude-cli|sdk] [--users <file>] [--origin <url>] [--worlds-dir <dir>] [--repo-root <dir>]

The operator web app on one port (default ${DEFAULT_PORT}, bound to 127.0.0.1): the worlds
table, world rollout (a child worldplay serve per Serve click), generation runs (a child
worldgen whose events.jsonl the page polls), the eval runs and the spend ledger. worldgen and
episode children get the environment whole, so the operator's own env carries every key
(LLM_KEY, BOAT_API_KEY, the spend caps); the studio stores and logs none. A child that runs a
world's snippets (serve, the Explorer check, the proof) gets only TZ, PATH and the guard scale.
--repo-root defaults to the repository this file lives in; --worlds-dir defaults to
<repo-root>/prod/worlds. A served world keeps its own two ports; the studio port has no
/_world route. Ctrl-C stops the studio; the studio SIGTERMs its tracked children.
--host binds another interface. The studio starts worldgen runs, so it refuses to bind a
non-loopback host unless sign-in is on: --users <file>, or WORLDGEN_STUDIO_TOKEN (one admin,
named admin, whose token is that value). Give only one of the two.
Sign-in: the page and its API take a bearer token (Authorization: Bearer <token>; the page keeps
it in sessionStorage, never a cookie). Three roles, each able to do the ones before it: viewer
(every read), operator (also starts and stops runs, services and episodes) and admin (also reads
GET /api/audit, the log of every POST in <worlds-dir>/.studio-audit.jsonl). GET / and
GET /api/health need no token. Without users the studio is open: every request is the admin local.
--users is a JSON file {"users": [{"name": "ada", "role": "admin", "token_sha256": "<64 hex>"}]}.
Make a hash with: printf %s "$TOKEN" | shasum -a 256
--transport (or WORLDGEN_TRANSPORT) is passed to every worldgen run; sdk reads LLM_KEY from the
studio's own environment, which a container gets at run time (docker run -e LLM_KEY), never from the image.
--origin (or WORLDGEN_STUDIO_ORIGIN) is the one public origin the studio is also reached at, such as
http://127.0.0.1:9000 for a published container port. Otherwise it answers only to its bound
address and the loopback names (127.0.0.1, localhost), and refuses any other Host or POST Origin.
GET /api/health answers readiness with WORLDGEN_BUILD_SHA, the runtime and the world count.
`;

class UsageError extends Error {}

type Args = { readonly port: number; readonly host: string | undefined; readonly transport: 'claude-cli' | 'sdk' | undefined; readonly users: readonly StudioUser[]; readonly origin: string | undefined; readonly repoRoot: string; readonly worldsDir: string | undefined };

function parse(argv: readonly string[]): Args | 'help' {
  if (argv.some((a) => a === '--help' || a === '-h')) return 'help';
  let port = DEFAULT_PORT;
  let repoRoot: string | undefined;
  let worldsDir: string | undefined;
  let host: string | undefined;
  let users: readonly StudioUser[] = [];
  let usersFile: string | undefined;
  let transport: string | undefined = process.env['WORLDGEN_TRANSPORT'] === '' ? undefined : process.env['WORLDGEN_TRANSPORT'];
  let origin: string | undefined = process.env['WORLDGEN_STUDIO_ORIGIN'] === '' ? undefined : process.env['WORLDGEN_STUDIO_ORIGIN'];
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
    else if (a === '--origin') origin = value();
    else if (a === '--users') {
      usersFile = value();
      try {
        users = parseUsersFile(readFileSync(usersFile, 'utf8'));
      } catch (e) {
        throw new UsageError(`--users ${usersFile}: ${e instanceof Error ? e.message : String(e)}`);
      }
    } else if (a === '--repo-root') repoRoot = path.resolve(value());
    else if (a === '--worlds-dir') worldsDir = path.resolve(value());
    else throw new UsageError(`unknown argument ${a}`);
  }
  if (transport !== undefined && transport !== 'claude-cli' && transport !== 'sdk') throw new UsageError(`--transport must be claude-cli or sdk, got ${transport}`);
  if (origin !== undefined && originOf(origin) === null) throw new UsageError(`--origin must be an http(s) origin such as http://127.0.0.1:8787, got ${origin}`);
  const token = process.env['WORLDGEN_STUDIO_TOKEN'];
  if (token !== undefined && token !== '') {
    if (usersFile !== undefined) throw new UsageError('give --users or WORLDGEN_STUDIO_TOKEN, not both');
    users = [{ name: 'admin', role: 'admin', tokenSha256: createHash('sha256').update(token).digest('hex') }];
  }
  // Generation and episode children get this environment; none of them needs the studio's own credential.
  delete process.env['WORLDGEN_STUDIO_TOKEN'];
  return { port, host, transport, users, origin, repoRoot: repoRoot ?? path.resolve(CODE_DIR, '..'), worldsDir };
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
      users: args.users,
      ...(args.origin === undefined ? {} : { origin: args.origin }),
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
