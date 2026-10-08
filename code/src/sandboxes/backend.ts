/**
 * One interface over the places a world can run: local sandboxes (OpenShell, sbx) and hosted
 * ones (boat). Shell code: Node is allowed here, the engine is not imported at all.
 *
 * The CLI backends spawn their binaries through an injected `Runner`, so tests record argv and
 * never need the binaries. `upWorld()` is the one recipe on top: upload, check Node, install pinned Bun,
 * `bun install --frozen-lockfile`, start `worldplay serve` on that Bun detached, wait for the port, and expose the world port only.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { constants } from 'node:os';

/** One file to place in a sandbox. `path` is relative and POSIX, under the sandbox workdir. */
export type SandboxFile = { readonly path: string; readonly data: Uint8Array };

/** The code package plus one world, as uploaded. `world` is the world folder relative to the workdir. */
export type WorldBundle = { readonly files: readonly SandboxFile[]; readonly world: string };

export const BACKEND_KINDS = ['openshell', 'sbx', 'boat'] as const;
export type BackendKind = (typeof BACKEND_KINDS)[number];

export type SandboxSize = { readonly cpus: number; readonly memoryGi: number };
/** A simple 2-CPU VM on every backend unless the caller asks for more. */
export const DEFAULT_SIZE: SandboxSize = { cpus: 2, memoryGi: 4 };

export type UpOpts = {
  readonly idempotencyKey?: string;
  /** Sandbox name, also its id on the CLI backends. Lowercase letters, digits and dashes. */
  readonly name: string;
  readonly size?: SandboxSize;
  /** Base image, where the backend takes one (OpenShell `--from`, sbx `--template`). */
  readonly image?: string;
};

/** A running sandbox. `workdir` is where the uploaded files sit inside it. */
export type Sandbox = { readonly id: string; readonly workdir: string };

export type ExecOpts = { readonly workdir?: string; readonly timeoutSec?: number };
export type ExecResult = { readonly exitCode: number; readonly stdout: string; readonly stderr: string };
/** `log` is the file inside the sandbox that receives the detached process's stdout and stderr. */
export type StartOpts = { readonly workdir?: string; readonly log: string };
/** `public: false` keeps the port on the host's loopback. Only a hosted backend can make it public. */
export type ExposeOpts = { readonly public: boolean };

export interface SandboxBackend {
  readonly kind: BackendKind;
  readonly maxLifetimeSeconds?: number;
  /** Create the sandbox with `files` under its workdir. */
  up(files: readonly SandboxFile[], opts: UpOpts): Promise<Sandbox>;
  /** Run a command to completion. A non-zero exit is a result, not an error. */
  exec(id: string, cmd: readonly string[], opts?: ExecOpts): Promise<ExecResult>;
  /** Start a long-running command detached, and return once it is launched. */
  start(id: string, cmd: readonly string[], opts: StartOpts): Promise<void>;
  /** Make a port inside the sandbox reachable and return its URL. */
  expose(id: string, port: number, opts: ExposeOpts): Promise<string>;
  down(id: string): Promise<void>;
}

/** A failure the user can act on: a missing CLI, a failed command, a bad option. */
export class SandboxError extends Error {
  override readonly name = 'SandboxError';
}

export type SandboxStartOutcome = { readonly kind: 'not_started' } | { readonly kind: 'unknown' } | { readonly kind: 'closed'; readonly id: string } | { readonly kind: 'live'; readonly id: string };

export class SandboxStartError extends SandboxError {
  constructor(message: string, readonly sandboxStart: SandboxStartOutcome) { super(message); }
}

export class PendingSandboxError extends SandboxStartError {
  readonly pendingSandbox: { readonly id: string };

  constructor(message: string, id: string) {
    super(message, { kind: 'live', id });
    this.pendingSandbox = { id };
  }
}

export type RunOpts = {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  /**
   * The child's whole environment, so a spawned process need not inherit the controller's
   * credentials. Unset, the child inherits this process's environment (YOS-159).
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
};
export type RunResult = { readonly code: number; readonly stdout: string; readonly stderr: string };
/**
 * Runs argv[0] with argv[1..] and no shell. Resolves with the exit code, even when non-zero.
 * Rejects only when the process cannot start; a missing binary rejects with `code: 'ENOENT'`.
 */
export type Runner = (argv: readonly string[], opts?: RunOpts) => Promise<RunResult>;

/**
 * How long to keep reading after the process exits. A CLI that daemonizes a helper (OpenShell
 * `forward start -d`) can leave the helper holding our pipes, and `close` would never come.
 */
const PIPE_GRACE_MS = 500;

/** The production Runner: `node:child_process` spawn, never through a shell. */
export const nodeRunner: Runner = (argv, opts) =>
  new Promise((resolve, reject) => {
    const [bin, ...args] = argv;
    if (bin === undefined) {
      reject(new SandboxError('runner got an empty argv'));
      return;
    }
    const child = spawn(bin, args, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(opts?.cwd === undefined ? {} : { cwd: opts.cwd }),
      ...(opts?.timeoutMs === undefined ? {} : { timeout: opts.timeoutMs }),
      ...(opts?.env === undefined ? {} : { env: opts.env }),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let exitCode = 1;
    let grace: NodeJS.Timeout | undefined;
    child.stdout.setEncoding('utf8').on('data', (s: string) => (stdout += s));
    child.stderr.setEncoding('utf8').on('data', (s: string) => (stderr += s));
    const finish = (): void => {
      if (settled) return;
      settled = true;
      if (grace !== undefined) clearTimeout(grace);
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ code: exitCode, stdout, stderr });
    };
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
    child.on('exit', (code, signal) => {
      exitCode = code ?? (signal === null ? 1 : 128 + constants.signals[signal]);
      grace = setTimeout(finish, PIPE_GRACE_MS);
    });
    child.on('close', finish);
  });

/** One long-running child, started by a Spawner. */
export interface SpawnedChild {
  readonly pid: number | undefined;
  /**
   * The child's exit code once it is gone; null when a signal killed it or it never started.
   * Never rejects: a child that could not start is a child that is gone.
   */
  readonly exited: Promise<number | null>;
  /** Sends a signal. Returns false when the child is already gone. */
  kill(signal: NodeJS.Signals): boolean;
  /** The stdout and stderr captured so far, so a full pipe never blocks the child. */
  output(): string;
}

export type SpawnOpts = {
  readonly cwd?: string;
  /** The child's whole environment, as in RunOpts. Unset, the child inherits this process's environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
};
/** Starts argv as a long-running child, no shell, stdio captured, environment inherited unless opts.env replaces it. */
export type Spawner = (argv: readonly string[], opts?: SpawnOpts) => SpawnedChild;

/**
 * The production Spawner: `node:child_process` spawn, never through a shell, the environment
 * inherited unless opts.env replaces it. The long-running sibling of nodeRunner: serve and studio children
 * outlive the call that started them.
 */
export const nodeSpawn: Spawner = (argv, opts) => {
  const [bin, ...args] = argv;
  if (bin === undefined) throw new SandboxError('spawner got an empty argv');
  const child = spawn(bin, args, {
    shell: false,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...(opts?.cwd === undefined ? {} : { cwd: opts.cwd }),
    ...(opts?.env === undefined ? {} : { env: opts.env }),
  });
  let text = '';
  child.stdout.setEncoding('utf8').on('data', (s: string) => (text += s));
  child.stderr.setEncoding('utf8').on('data', (s: string) => (text += s));
  const exited = new Promise<number | null>((resolve) => {
    child.once('exit', (code, signal) => resolve(code ?? (signal === null ? 1 : null)));
    child.once('error', () => resolve(null));
  });
  return { pid: child.pid, exited, kill: (signal) => child.kill(signal), output: () => text };
};

/** True for the error a Runner rejects with when the binary is not on PATH. */
export function isMissingBinary(err: unknown): boolean {
  return err instanceof Error && 'code' in err && err.code === 'ENOENT';
}

/** A CLI a backend drives, and the one line that says how to install it. */
export type CliTool = { readonly bin: string; readonly install: string };

/** The message for a missing CLI. One line, naming the binary and the install command. */
export const missingBinaryMessage = (tool: CliTool): string => `${tool.bin} not found on PATH. Install it: ${tool.install}`;

export type Cli = (args: readonly string[], opts?: RunOpts) => Promise<RunResult>;

/** Binds a Runner to one binary and turns ENOENT into a SandboxError naming it. */
export function cli(tool: CliTool, runner: Runner): Cli {
  return async (args, opts) => {
    try {
      return await runner([tool.bin, ...args], opts);
    } catch (err) {
      if (isMissingBinary(err)) throw new SandboxError(missingBinaryMessage(tool));
      throw err;
    }
  };
}

/** The last `n` non-empty lines of a command's output. */
export function lastLines(text: string, n: number): string {
  return text
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l !== '')
    .slice(-n)
    .join('\n');
}

/** Throws a one-line SandboxError when a CLI step exits non-zero. */
export function must(res: RunResult, what: string): RunResult {
  if (res.code === 0) return res;
  const why = lastLines(res.stderr, 1) || lastLines(res.stdout, 1) || 'no output';
  throw new SandboxError(`${what} failed (exit ${res.code}): ${why}`);
}

const SANDBOX_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

/** Sandbox names go into argv and host paths, so they stay a safe slug. */
export function assertSandboxName(name: string): void {
  if (!SANDBOX_NAME.test(name)) {
    throw new SandboxError(`bad sandbox name ${JSON.stringify(name)}: use 1-63 lowercase letters, digits and dashes, starting with a letter or digit`);
  }
}

const SH_SAFE = /^[A-Za-z0-9_/.:=@%+,-]+$/;

/** Quotes one word for a POSIX shell. Safe words pass unchanged. */
export function shQuote(word: string): string {
  return SH_SAFE.test(word) ? word : `'${word.replaceAll("'", `'\\''`)}'`;
}

/**
 * The argv that launches `cmd` detached inside a sandbox: immune to hangup, stdin closed, and
 * output in `log`, so the exec session that starts it can end at once.
 */
export function detachedSh(cmd: readonly string[], log: string): string[] {
  return ['sh', '-c', `nohup ${cmd.map(shQuote).join(' ')} > ${shQuote(log)} 2>&1 < /dev/null &`];
}

/** Where `worldplay serve` writes inside the sandbox. */
export const SERVE_LOG = '/tmp/worldplay.log';
/** Installing Bun and the dependency tree downloads both, so each gets a generous bound. */
export const INSTALL_TIMEOUT_SEC = 900;
/** How long the world port may take to accept a connection after start. */
export const READY_TIMEOUT_SEC = 60;
export const MIN_NODE_MAJOR = 22;
/** Bound by a public world's `serve`: a hosted proxy reaches the sandbox over its network address, not loopback. */
export const PUBLIC_HOST = '0.0.0.0';
/** Every sandbox serves on Bun pinned to the CI version (YOS-88), installed privately so an image's own Bun, or none, never matters. */
export const SANDBOX_BUN_VERSION = '1.4.2';
const SANDBOX_BUN_DIR = '/tmp/worldgen-bun';
const SANDBOX_BUN = `${SANDBOX_BUN_DIR}/node_modules/.bin/bun`;
/**
 * Fetches Bun's own linux package for the sandbox's CPU and keeps only its binary. `npm install bun` hung for minutes
 * inside openshell while curl fetched the same tarball in under a second, so the bootstrap needs curl and tar, not npm (A-264).
 */
const BUN_BOOTSTRAP =
  `D=${SANDBOX_BUN_DIR}; A=$(uname -m); case $A in x86_64) A=x64;; esac; mkdir -p $D/node_modules/.bin && ` +
  `curl -fsSL -o $D/bun.tgz https://registry.npmjs.org/@oven/bun-linux-$A/-/bun-linux-$A-${SANDBOX_BUN_VERSION}.tgz && ` +
  `tar -xzf $D/bun.tgz -C $D package/bin/bun && mv $D/package/bin/bun ${SANDBOX_BUN} && rm -rf $D/bun.tgz $D/package && ${SANDBOX_BUN} --version`;


/**
 * A Node one-liner run inside the sandbox: connect to 127.0.0.1:<argv[1]> until it accepts, or
 * exit 1 after <argv[2]> seconds. It runs in the sandbox, so it needs nothing from the host.
 */
export const WAIT_FOR_PORT =
  "const net=require('node:net');const port=Number(process.argv[1]);const end=Date.now()+Number(process.argv[2])*1000;" +
  "const t=()=>{const s=net.connect(port,'127.0.0.1');s.on('connect',()=>{s.end();process.exit(0)});" +
  "s.on('error',()=>{s.destroy();if(Date.now()>=end)process.exit(1);setTimeout(t,250)})};t();";

/** The world's OpenAPI document, served at this path by every world and cheap to fetch. */
export const REACH_PATH = '/openapi.json';
export type Reach = { readonly ok: true } | { readonly ok: false; readonly why: string };

/**
 * Polls `<url>/openapi.json` until it returns 200 within `timeoutSec`.
 */
export async function reachWorld(
  url: string,
  timeoutSec: number = READY_TIMEOUT_SEC,
  deps: { readonly fetch?: (u: string, init: { signal: AbortSignal }) => Promise<{ status: number }>; readonly sleep?: (ms: number) => Promise<void>; readonly now?: () => number } = {},
): Promise<Reach> {
  const get = deps.fetch ?? ((u, init) => fetch(u, init));
  const sleep = deps.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = deps.now ?? Date.now;
  const end = now() + timeoutSec * 1000;
  let why = 'no answer';
  for (;;) {
    const requestMs = Math.ceil(Math.min(10_000, end - now()));
    if (requestMs <= 0) return { ok: false, why };
    try {
      const res = await get(`${url}${REACH_PATH}`, { signal: AbortSignal.timeout(requestMs) });
      if (res.status === 200) return { ok: true };
      why = `HTTP ${res.status}`;
    } catch (e) {
      why = e instanceof Error ? e.message : String(e);
    }
    const remaining = end - now();
    if (remaining <= 0) return { ok: false, why };
    await sleep(Math.min(1000, remaining));
  }
}

export type UpWorldOpts = UpOpts & {
  /** The world port. `worldplay serve` puts the admin routes on port + 1, which is never exposed. */
  readonly port: number;
  /**
   * Reach the world through a proxy that cannot see the sandbox's loopback: serve binds 0.0.0.0,
   * so only the world port may be exposed, and `reach` has to confirm the URL answers.
   */
  readonly public?: boolean;
  /** Checks the exposed URL from outside. Skipped when absent. Registry passes reachWorld for a public sandbox. */
  readonly reach?: (url: string) => Promise<Reach>;
};

export type WorldSandbox = { readonly sandbox: Sandbox; readonly url: string };

/** The admin port must exist too, so the world port stops one short of the top. */
function assertWorldPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65534) {
    throw new SandboxError(`bad port ${port}: use an integer from 1 to 65534 (the admin routes take port + 1)`);
  }
}

const NODE_VERSION = /^v(\d+)\./;

function assertNode(res: ExecResult, kind: BackendKind): void {
  const version = res.stdout.trim();
  const major = NODE_VERSION.exec(version)?.[1];
  if (res.exitCode !== 0 || major === undefined) {
    throw new SandboxError(`node not found in the ${kind} sandbox: use an image with Node ${MIN_NODE_MAJOR} or later`);
  }
  if (Number(major) < MIN_NODE_MAJOR) {
    throw new SandboxError(`the ${kind} sandbox has node ${version}: need Node ${MIN_NODE_MAJOR} or later`);
  }
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * Brings a world up in a fresh sandbox and returns the world URL. Any failure after the sandbox
 * exists tears it down before the error propagates, so a failed `up` leaves nothing running.
 */
export async function upWorld(backend: SandboxBackend, bundle: WorldBundle, opts: UpWorldOpts): Promise<WorldSandbox> {
  assertWorldPort(opts.port);
  const port = String(opts.port);
  const sandbox = await backend.up(bundle.files, {
    name: opts.name,
    ...(opts.size === undefined ? {} : { size: opts.size }),
    ...(opts.image === undefined ? {} : { image: opts.image }),
  });
  const { id, workdir } = sandbox;
  try {
    assertNode(await backend.exec(id, ['node', '-v'], { workdir }), backend.kind);

    const boot = await backend.exec(id, ['sh', '-c', BUN_BOOTSTRAP], { timeoutSec: INSTALL_TIMEOUT_SEC });
    if (boot.exitCode !== 0 || boot.stdout.trim().split('\n').pop() !== SANDBOX_BUN_VERSION) {
      throw new SandboxError(`installing Bun ${SANDBOX_BUN_VERSION} in ${backend.kind} sandbox ${id} failed (exit ${boot.exitCode}):\n${lastLines(boot.stderr || boot.stdout, 10)}`);
    }
    const ci = await backend.exec(id, [SANDBOX_BUN, 'install', '--frozen-lockfile'], { workdir, timeoutSec: INSTALL_TIMEOUT_SEC });
    if (ci.exitCode !== 0) {
      throw new SandboxError(`bun install failed in ${backend.kind} sandbox ${id} (exit ${ci.exitCode}):\n${lastLines(ci.stderr || ci.stdout, 10)}`);
    }

    const host = backend.kind === 'boat' || opts.public === true ? ['--host', PUBLIC_HOST] : [];
    await backend.start(id, [SANDBOX_BUN, 'src/cli/worldplay.ts', 'serve', bundle.world, '--port', port, ...host], { workdir, log: SERVE_LOG });

    const ready = await backend.exec(id, ['node', '-e', WAIT_FOR_PORT, port, String(READY_TIMEOUT_SEC)], { workdir });
    if (ready.exitCode !== 0) {
      const log = await backend.exec(id, ['tail', '-n', '20', SERVE_LOG]);
      throw new SandboxError(`worldplay serve did not listen on port ${port} within ${READY_TIMEOUT_SEC}s in ${backend.kind} sandbox ${id}:\n${lastLines(log.stdout, 20)}`);
    }

    // Only the world port. The admin port (port + 1) resets state and grades, so it stays inside.
    const url = await backend.expose(id, opts.port, { public: opts.public ?? false });
    if (opts.reach !== undefined) {
      const reached = await opts.reach(url);
      if (!reached.ok) {
        const log = await backend.exec(id, ['tail', '-n', '20', SERVE_LOG]);
        throw new SandboxError(`${url} did not answer ${REACH_PATH} (${reached.why}) although the ${backend.kind} sandbox ${id} listens on port ${port}:\n${lastLines(log.stdout, 20)}`);
      }
    }
    return { sandbox, url };
  } catch (err) {
    try {
      await backend.down(id);
    } catch (downErr) {
      throw new SandboxError(`${messageOf(err)}\nteardown of ${backend.kind} sandbox ${id} also failed: ${messageOf(downErr)}`);
    }
    throw err;
  }
}

/** The environment of a child that runs a world's snippets: TZ, PATH and the guard scale, never a credential (A-338, A-343, A-347). */
export function isolatedEnv(env: Readonly<Record<string, string | undefined>>): Record<string, string> {
  return { TZ: 'UTC', PATH: env['PATH'] ?? '', ...(env['WORLDGEN_GUARD_SCALE'] === undefined ? {} : { WORLDGEN_GUARD_SCALE: env['WORLDGEN_GUARD_SCALE'] }) };
}

/** A loopback port that was free a moment ago, from the OS. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const a = probe.address();
      const port = a !== null && typeof a === 'object' ? a.port : 0;
      probe.close(() => resolve(port));
    });
  });
}
