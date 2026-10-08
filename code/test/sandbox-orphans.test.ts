import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const HELPER = fileURLToPath(new URL('./helpers/orphan-parent.ts', import.meta.url));
const PARENTS = 12;
const SIGKILL_WINDOW_MS = 1_500;
const GONE_WITHIN_MS = 60_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function childrenOf(pid: number): number[] {
  try {
    return execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).split('\n').filter(Boolean).map(Number);
  } catch {
    return [];
  }
}

/**
 * `gone`: no process, or a zombie. `unstarted`: alive with no CPU time at all, still stopped at the first
 * instruction of node (macOS holds a freshly spawned binary for a while under a burst of spawns, seen up to a
 * minute at load 15). It has run no code, so it has no watchdog yet and will die at its first check. `running`: it
 * has executed, so a main that is gone must have taken it down.
 */
function stateOf(pid: number): 'gone' | 'unstarted' | 'running' {
  try {
    process.kill(pid, 0);
    const [stat = '', time = ''] = execFileSync('ps', ['-o', 'stat=,time=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/);
    if (stat.startsWith('Z')) return 'gone';
    return /^[0:.]+$/.test(time) ? 'unstarted' : 'running';
  } catch {
    return 'gone';
  }
}

describe('snippet processes die with their parent', () => {
  it('SIGKILL of a main at any point of lane startup leaves no snippet process behind', async () => {
    const orphans: number[] = [];
    let spawned = 0;
    await Promise.all(
      Array.from({ length: PARENTS }, async (_, i) => {
        const parent = spawn(process.execPath, [HELPER, 'idle'], { stdio: 'ignore' });
        await sleep(300 + (i * SIGKILL_WINDOW_MS) / PARENTS);
        const kids = childrenOf(parent.pid!);
        spawned += kids.length;
        parent.kill('SIGKILL');
        const deadline = Date.now() + GONE_WITHIN_MS;
        for (const kid of kids) {
          while (stateOf(kid) !== 'gone' && Date.now() < deadline) await sleep(100);
          if (stateOf(kid) === 'running') orphans.push(kid);
          else if (stateOf(kid) === 'unstarted') process.kill(kid, 'SIGKILL');
        }
      }),
    );
    for (const pid of orphans) process.kill(pid, 'SIGKILL');
    assert.ok(spawned > 0, 'at least one parent had started a snippet process when it was killed');
    assert.deepEqual(orphans, []);
  });
});
