import { spawn } from 'node:child_process';

type CommandOutcome =
  | { kind: 'exited'; code: number }
  | { kind: 'failed'; reason: string };
type CommandResult = CommandOutcome & { out: string };

export function runCommand(
  command: string,
  args: string[],
  options: { cwd: string; timeoutMs: number; maxOutputBytes?: number },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: options.cwd, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const maxOutputBytes = options.maxOutputBytes ?? 64 * 1024 * 1024;
    let size = 0;
    let settled = false;

    const finish = (result: CommandOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
      }
      child.stdout.destroy();
      child.stderr.destroy();
      resolve({ ...result, out: Buffer.concat(chunks).toString('utf8') });
    };
    const timer = setTimeout(() => finish({ kind: 'failed', reason: `timed out after ${options.timeoutMs} ms` }), options.timeoutMs);
    const collect = (chunk: Buffer): void => {
      if (settled) return;
      const available = maxOutputBytes - size;
      chunks.push(chunk.subarray(0, available));
      size += Math.min(chunk.length, available);
      if (chunk.length > available) finish({ kind: 'failed', reason: `output exceeded ${maxOutputBytes} bytes` });
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.once('error', (error) => finish({ kind: 'failed', reason: error.message }));
    child.once('close', (code, signal) => {
      if (code === null) finish({ kind: 'failed', reason: `terminated by ${signal ?? 'an unknown signal'}` });
      else finish({ kind: 'exited', code });
    });
  });
}
