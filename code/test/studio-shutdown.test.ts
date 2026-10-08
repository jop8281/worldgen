/**
 * Stopping the studio (YOS-187): a stop signal closes it, close() stops every served world and running check and
 * waits until each is gone, and a second signal cuts that wait.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { Runner, Spawner } from '../src/sandboxes/backend.ts';
import { stopOnSignals, studioServer, type SignalHost } from '../src/studio/server.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '..');
const REPO_ROOT = path.resolve(CODE_DIR, '..');
const HELPDESK = path.join(REPO_ROOT, 'prod', 'worlds', 'helpdesk');
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A worlds dir holding a copy of helpdesk. */
function worldsDir(): { root: string; worlds: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'studio-shutdown-'));
  const worlds = path.join(root, 'worlds');
  cpSync(HELPDESK, path.join(worlds, 'helpdesk'), { recursive: true });
  return { root, worlds };
}

/** True while `pid` names a live process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** A process stand-in: the listeners it was given, the exit codes asked of it, and what it wrote to stderr. */
function fakeHost() {
  const listeners = new Map<string, () => void>();
  const exits: number[] = [];
  let said = '';
  const host: SignalHost = { on: (event, listener) => listeners.set(event, listener), exit: (code) => void exits.push(code), stderr: { write: (text) => (said += text) } };
  return { host, exits, said: () => said, send: (signal: 'SIGINT' | 'SIGTERM') => listeners.get(signal)?.() };
}

describe('stopOnSignals', () => {
  const cases: readonly { readonly name: string; readonly signal: 'SIGINT' | 'SIGTERM'; readonly close: () => Promise<void>; readonly exits: readonly number[] }[] = [
    { name: 'SIGTERM exits 0 once close resolves', signal: 'SIGTERM', close: async () => {}, exits: [0] },
    { name: 'SIGINT exits 130 once close resolves', signal: 'SIGINT', close: async () => {}, exits: [130] },
    { name: 'a close that fails exits 1', signal: 'SIGTERM', close: async () => { throw new Error('disk gone'); }, exits: [1] },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const f = fakeHost();
      stopOnSignals({ close: c.close }, f.host);
      f.send(c.signal);
      await tick();
      assert.deepEqual(f.exits, c.exits);
    });
  }

  it('a second signal while close waits exits at once, by that signal, and closes only once', async () => {
    for (const [second, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
      const f = fakeHost();
      let closes = 0;
      stopOnSignals({ close: () => { closes += 1; return new Promise<void>(() => {}); } }, f.host);
      f.send('SIGTERM');
      await tick();
      assert.deepEqual(f.exits, []);
      f.send(second);
      await tick();
      assert.deepEqual(f.exits, [code]);
      assert.equal(closes, 1);
      assert.match(f.said(), new RegExp(`studio: ${second} again, exiting before every child is gone`));
    }
  });
});

describe('close()', () => {
  it('stops a running Explorer check and resolves only once it is gone', async () => {
    const { root, worlds } = worldsDir();
    const order: string[] = [];
    let checking!: () => void;
    const started = new Promise<void>((resolve) => (checking = resolve));
    const runner: Runner = (argv, opts) => {
      if (argv[1] !== 'src/cli/studio-check.ts') return Promise.resolve({ code: 0, stdout: 'abc1234\n', stderr: '' });
      checking();
      return new Promise((resolve) => {
        opts?.signal?.addEventListener('abort', () => setTimeout(() => {
          order.push('check gone');
          resolve({ code: 143, stdout: '', stderr: '' });
        }, 50));
      });
    };
    const spawner: Spawner = () => { throw new Error('no child is spawned here'); };
    const server = await studioServer({ port: 0, repoRoot: root, worldsDir: worlds, spawner, runner });
    try {
      const explorer = fetch(`${server.url}/api/worlds/helpdesk/explorer`).catch(() => null);
      await started;
      await server.close();
      order.push('closed');
      assert.deepEqual(order, ['check gone', 'closed']);
      await explorer;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('close() and a serve still starting', () => {
  it('stops a world that has not reported its ports, and resolves only once it is gone', async () => {
    const { root, worlds } = worldsDir();
    const signals: string[] = [];
    let spawned!: () => void;
    const started = new Promise<void>((resolve) => (spawned = resolve));
    const spawner: Spawner = () => {
      let die: (code: number | null) => void = () => {};
      const exited = new Promise<number | null>((resolve) => (die = resolve));
      spawned();
      return { pid: 48001, exited, kill: (signal) => (signals.push(signal ?? 'SIGTERM'), setTimeout(() => die(null), 50), true), output: () => '' };
    };
    const runner: Runner = async () => ({ code: 0, stdout: 'abc1234\n', stderr: '' });
    const server = await studioServer({ port: 0, repoRoot: root, worldsDir: worlds, spawner, runner, serveWaitMs: 60_000 });
    try {
      const serve = fetch(`${server.url}/api/worlds/helpdesk/serve`, { method: 'POST' }).catch(() => null);
      await started;
      await server.close();
      assert.deepEqual(signals, ['SIGTERM']);
      await serve;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the studio process', () => {
  it('SIGTERM stops the world it serves, waits for it, then exits 0', async () => {
    const { root, worlds } = worldsDir();
    const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'WORLDGEN_STUDIO_TOKEN'));
    const studio = spawn(process.execPath, ['src/cli/studio.ts', '--port', '0', '--worlds-dir', worlds], { cwd: CODE_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<number | null>((resolve) => studio.once('exit', (code) => resolve(code)));
    let said = '';
    studio.stderr.setEncoding('utf8').on('data', (s: string) => (said += s));
    let worldPid: number | undefined;
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let out = '';
        studio.stdout.setEncoding('utf8').on('data', (s: string) => {
          out += s;
          const m = /studio on (http:\/\/\S+)/.exec(out);
          if (m !== null) resolve(m[1]!);
        });
        void exited.then((code) => reject(new Error(`the studio exited ${code} before it listened: ${said}`)));
      });
      const served = (await (await fetch(`${url}/api/worlds/helpdesk/serve`, { method: 'POST' })).json()) as { pid: number };
      worldPid = served.pid;
      assert.equal(alive(worldPid), true);
      studio.kill('SIGTERM');
      assert.equal(await exited, 0);
      assert.equal(alive(worldPid), false);
      assert.equal(alive(studio.pid!), false);
      assert.match(said, /studio: SIGTERM, stopping every served world/);
    } finally {
      studio.kill('SIGKILL');
      if (worldPid !== undefined && alive(worldPid)) process.kill(worldPid, 'SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  });
});
