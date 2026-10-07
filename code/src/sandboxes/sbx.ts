/**
 * Docker Sandboxes (`sbx`) as a SandboxBackend. Drives the `sbx` CLI through a Runner.
 *
 * sbx mounts a host directory at the same path inside the sandbox, so `up` writes the bundle to
 * a host workspace named after the sandbox and mounts it; the workspace is the workdir and lives
 * until `down`. Ports are published on the host's loopback only.
 */
import {
  DEFAULT_SIZE,
  SandboxError,
  assertSandboxName,
  cli,
  detachedSh,
  lastLines,
  must,
  type CliTool,
  type ExecOpts,
  type ExecResult,
  type Runner,
  type SandboxBackend,
} from './backend.ts';
import type { Workspace } from './files.ts';

export const SBX: CliTool = {
  bin: 'sbx',
  install: "brew install docker/tap/sbx (macOS), or Docker's apt repository (Linux)",
};

export type SbxDeps = { readonly runner: Runner; readonly workspace: Workspace };

export function sbxBackend(deps: SbxDeps): SandboxBackend {
  const run = cli(SBX, deps.runner);

  const exec = async (id: string, cmd: readonly string[], opts?: ExecOpts): Promise<ExecResult> => {
    // sbx exec has no timeout flag, so the bound is the runner's.
    const res = await run(
      ['exec', ...(opts?.workdir === undefined ? [] : ['--workdir', opts.workdir]), id, ...cmd],
      opts?.timeoutSec === undefined ? {} : { timeoutMs: opts.timeoutSec * 1000 },
    );
    return { exitCode: res.code, stdout: res.stdout, stderr: res.stderr };
  };

  return {
    kind: 'sbx',

    async up(files, opts) {
      assertSandboxName(opts.name);
      const size = opts.size ?? DEFAULT_SIZE;
      const dir = await deps.workspace.write(opts.name, files);
      try {
        must(await run(['create', `--name=${opts.name}`, '--cpus', String(size.cpus), ...(opts.image === undefined ? [] : ['--template', opts.image]), 'shell', dir]), 'sbx create');
      } catch (err) {
        await deps.workspace.remove(opts.name);
        throw err;
      }
      return { id: opts.name, workdir: dir };
    },

    exec,

    async start(id, cmd, opts) {
      const res = await exec(id, detachedSh(cmd, opts.log), opts.workdir === undefined ? {} : { workdir: opts.workdir });
      if (res.exitCode !== 0) throw new SandboxError(`sbx start failed (exit ${res.exitCode}): ${lastLines(res.stderr, 1) || 'no output'}`);
    },

    async expose(id, port, opts) {
      if (opts.public) throw new SandboxError('sbx publishes ports on 127.0.0.1 only; use the boat backend for a public URL');
      must(await run(['ports', id, '--publish', `${port}:${port}`]), 'sbx ports');
      return `http://127.0.0.1:${port}`;
    },

    async down(id) {
      assertSandboxName(id);
      // A sandbox that already stopped still has to be removed, so stop's exit code is not fatal.
      await run(['stop', id]);
      must(await run(['rm', '--force', id]), 'sbx rm');
      // The mount goes last: a sandbox that failed to go keeps its files.
      await deps.workspace.remove(id);
    },
  };
}
