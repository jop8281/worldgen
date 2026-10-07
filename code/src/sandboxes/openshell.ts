/**
 * NVIDIA OpenShell (Apache-2.0) as a SandboxBackend. Drives the `openshell` CLI through a Runner.
 *
 * `up` writes the bundle to a host workspace, creates the sandbox detached with that directory
 * uploaded to /work, then deletes the host copy. Ports are forwarded to the host's loopback only.
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

export const OPENSHELL: CliTool = {
  bin: 'openshell',
  install: 'curl -LsSf https://raw.githubusercontent.com/NVIDIA/OpenShell/main/install.sh | sh',
};
/** Where the bundle lands inside the sandbox. */
export const OPENSHELL_WORKDIR = '/sandbox/work';

export type OpenShellDeps = { readonly runner: Runner; readonly workspace: Workspace };

export function openshellBackend(deps: OpenShellDeps): SandboxBackend {
  const run = cli(OPENSHELL, deps.runner);

  const exec = async (id: string, cmd: readonly string[], opts?: ExecOpts): Promise<ExecResult> => {
    const res = await run([
      'sandbox', 'exec', '-n', id, '--no-login-shell', '--no-tty',
      ...(opts?.workdir === undefined ? [] : ['--workdir', opts.workdir]),
      ...(opts?.timeoutSec === undefined ? [] : ['--timeout', String(opts.timeoutSec)]),
      '--', ...cmd,
    ]);
    return { exitCode: res.code, stdout: res.stdout, stderr: res.stderr };
  };

  return {
    kind: 'openshell',

    async up(files, opts) {
      assertSandboxName(opts.name);
      const size = opts.size ?? DEFAULT_SIZE;
      const dir = await deps.workspace.write(opts.name, files);
      try {
        must(
          await run([
            'sandbox', 'create', '--name', opts.name,
            ...(opts.image === undefined ? [] : ['--from', opts.image]),
            '--cpu', String(size.cpus), '--memory', `${size.memoryGi}Gi`,
            '--upload', `${dir}:${OPENSHELL_WORKDIR}`, '--no-git-ignore',
            '--detach', '--no-auto-providers',
          ]),
          'openshell sandbox create',
        );
      } catch (err) {
        // create can fail after the sandbox exists (a failed upload), so remove it; its exit code is moot.
        await run(['sandbox', 'delete', opts.name]);
        throw err;
      } finally {
        // The upload copied the files in, so the host copy is not needed either way.
        await deps.workspace.remove(opts.name);
      }
      // openshell nests the uploaded directory under its own name.
      return { id: opts.name, workdir: `${OPENSHELL_WORKDIR}/${opts.name}` };
    },

    exec,

    async start(id, cmd, opts) {
      const res = await exec(id, detachedSh(cmd, opts.log), opts.workdir === undefined ? {} : { workdir: opts.workdir });
      if (res.exitCode !== 0) throw new SandboxError(`openshell start failed (exit ${res.exitCode}): ${lastLines(res.stderr, 1) || 'no output'}`);
    },

    async expose(id, port, opts) {
      if (opts.public) throw new SandboxError('openshell forwards ports to 127.0.0.1 only; use the boat backend for a public URL');
      must(await run(['forward', 'start', String(port), id, '-d']), 'openshell forward start');
      return `http://127.0.0.1:${port}`;
    },

    async down(id) {
      must(await run(['sandbox', 'delete', id]), 'openshell sandbox delete');
    },
  };
}
