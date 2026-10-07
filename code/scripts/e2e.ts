/**
 * Acceptance run on a clean checkout (YOS-42): typecheck, the helpdesk world checked, verified and
 * driven over HTTP, the CLIs' help, and docs freshness. Prints a PASS/FAIL table and exits 1 on any
 * FAIL. Makes no model calls. The test suite is not a step: `bun run check` runs it (A-231).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:net';
import path from 'node:path';
import { json } from './e2e-http.ts';
import { runCommand } from './e2e-command.ts';

const CODE = path.resolve(import.meta.dirname, '..');
const WORLD = path.resolve(CODE, '../prod/worlds/helpdesk');
const DOCS = path.resolve(CODE, '../prod/world-format.md');
/** A step that runs longer than this fails, so a hang never stalls CI. Set E2E_STEP_MS to change it. */
const STEP_MS = Number(process.env.E2E_STEP_MS) > 0 ? Number(process.env.E2E_STEP_MS) : 10 * 60_000;
/** The runner that started this script, so `bun run e2e` drives every step with bun. */
const BUN = process.versions.bun !== undefined;
const NPM = BUN ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** `run <script> <args>` for the current runner. npm needs `--` before script args, bun takes them as is. */
function runArgs(script: string, args: readonly string[] = []): string[] {
  return BUN ? ['run', '--silent', script, ...args] : ['run', '-s', script, ...(args.length > 0 ? ['--', ...args] : [])];
}

type Status = 'PASS' | 'FAIL' | 'SKIP';
const rows: { step: string; status: Status; detail: string }[] = [];

function record(step: string, status: Status, detail = ''): void {
  rows.push({ step, status, detail });
  process.stderr.write(`${status} ${step}${detail ? ` - ${detail}` : ''}\n`);
}

function npm(script: string, args: readonly string[] = []): ReturnType<typeof runCommand> {
  return runCommand(NPM, runArgs(script, args), { cwd: CODE, timeoutMs: STEP_MS });
}

function lastLines(text: string, n = 5): string {
  return text.trim().split('\n').slice(-n).join(' | ');
}

async function cmdStep(step: string, script: string, args: readonly string[], ok: (out: string) => boolean = () => true): Promise<void> {
  const r = await npm(script, args);
  if (r.kind === 'exited' && r.code === 0 && ok(r.out)) record(step, 'PASS');
  else record(step, 'FAIL', `${r.kind === 'failed' ? r.reason : `exit ${r.code}`}: ${lastLines(r.out)}`);
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const a = s.address();
      s.close(() => (a !== null && typeof a === 'object' ? resolve(a.port) : reject(new Error('no port'))));
    });
  });
}

class StepError extends Error {}
function expect(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new StepError(msg);
}

async function httpStep(step: string, body: () => Promise<string | void>): Promise<void> {
  try {
    record(step, 'PASS', (await body()) ?? '');
  } catch (e) {
    record(step, 'FAIL', e instanceof Error ? e.message : String(e));
  }
}

/** Stops the child's whole process group: SIGTERM, then SIGKILL after a deadline. */
async function stopGroup(child: ChildProcess): Promise<void> {
  const signal = (sig: NodeJS.Signals): void => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, sig);
    } catch {
      child.kill(sig);
    }
  };
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 5_000);
      child.once('exit', () => {
        clearTimeout(t);
        resolve(true);
      });
    });
    signal('SIGTERM');
    if (!(await exited)) signal('SIGKILL');
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function driveServer(): Promise<void> {
  const port = await freePort();
  let adminPort = await freePort();
  while (adminPort === port) adminPort = await freePort();
  const server = spawn(NPM, runArgs('worldplay', ['serve', WORLD, '--port', String(port), '--admin-port', String(adminPort)]), {
    cwd: CODE,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Its own process group, so the kill below also stops the server npm starts.
    detached: true,
  });
  let out = '';
  server.stdout.on('data', (d) => (out += String(d)));
  server.stderr.on('data', (d) => (out += String(d)));
  const api = `http://127.0.0.1:${port}`;
  const admin = `http://127.0.0.1:${adminPort}`;
  try {
    const up = await new Promise<boolean>((resolve) => {
      const t = setTimeout(() => resolve(false), 60_000);
      server.stdout.on('data', () => {
        if (out.includes('admin ')) {
          clearTimeout(t);
          resolve(true);
        }
      });
      server.once('exit', () => {
        clearTimeout(t);
        resolve(false);
      });
    });
    if (!up) {
      record('serve helpdesk', 'FAIL', lastLines(out));
      return;
    }
    record('serve helpdesk', 'PASS', `world :${port}, admin :${adminPort}`);

    await httpStep('http list with paging', async () => {
      const dump = await json(admin, 'GET', '/_world/state');
      expect(dump.status === 200, `GET /_world/state is ${dump.status}`);
      const total = dump.body.tables.ticket.length;
      expect(total > 2, `only ${total} tickets`);
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const q = `/tickets?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
        const page = await json(api, 'GET', q);
        expect(page.status === 200, `GET ${q} is ${page.status}`);
        expect(page.body.data.length <= 2, `page of ${page.body.data.length} rows with limit=2`);
        seen.push(...page.body.data.map((t: { id: string }) => t.id));
        cursor = page.body.next_cursor;
        pages += 1;
      } while (cursor !== null && pages < 1000);
      expect(new Set(seen).size === seen.length, 'a ticket appeared on two pages');
      expect(seen.length === total, `pages hold ${seen.length} tickets, the state ${total}`);
      const bad = await json(api, 'GET', '/tickets?cursor=nope');
      expect(bad.status === 400, `a bad cursor gives ${bad.status}, not 400`);
      return `${total} tickets over ${pages} pages`;
    });

    const task = 'assign_newest_acme_ticket';
    await httpStep(`http admin grade ${task} on the seed is 0`, async () => {
      const g = await json(admin, 'POST', `/_world/grade/${task}`);
      expect(g.status === 200 && g.body.score === 0, `grade is ${g.status} ${JSON.stringify(g.body)}`);
    });

    await httpStep('http action assign_ticket, then grade is 1', async () => {
      const acme = (await json(api, 'GET', '/customers?q=Acme')).body.data.find((c: { name: string }) => c.name === 'Acme Logistics');
      expect(acme, 'customer Acme Logistics not found');
      const newest = (await json(api, 'GET', `/tickets?customer_id=${acme.id}&status=new&sort=-created_at&limit=1`)).body.data[0];
      expect(newest, 'no new Acme Logistics ticket');
      const priya = (await json(api, 'GET', '/agents?q=Priya+Raman')).body.data.find((a: { name: string }) => a.name === 'Priya Raman');
      expect(priya, 'agent Priya Raman not found');
      const r = await json(api, 'POST', `/tickets/${newest.id}/assign`, { agent_id: priya.id });
      expect(r.status === 200 && r.body.status === 'open' && r.body.assignee_id === priya.id, `assign is ${r.status} ${JSON.stringify(r.body)}`);
      const again = await json(api, 'POST', `/tickets/${newest.id}/assign`, { agent_id: priya.id });
      expect(again.status === 409, `a repeat assign is ${again.status}, not 409`);
      const g = await json(admin, 'POST', `/_world/grade/${task}`);
      expect(g.status === 200 && g.body.score === 1, `grade is ${g.status} ${JSON.stringify(g.body)}`);
      return `${newest.id} to ${priya.id}`;
    });

    await httpStep('http admin log', async () => {
      const l = await json(admin, 'GET', '/_world/log');
      expect(l.status === 200 && Array.isArray(l.body.calls), `log is ${l.status}`);
      expect(l.body.calls.length > 0, 'log is empty after calls');
      return `${l.body.calls.length} calls`;
    });

    await httpStep('http admin clock advance', async () => {
      const before = (await json(admin, 'GET', '/_world/state')).body.now;
      const c = await json(admin, 'POST', '/_world/clock', { advance: '4h' });
      expect(c.status === 200, `clock is ${c.status} ${JSON.stringify(c.body)}`);
      const moved = Date.parse(c.body.now) - Date.parse(before);
      expect(moved === 4 * 3600_000, `clock moved ${moved} ms, not 4h`);
      const bad = await json(admin, 'POST', '/_world/clock', { advance: 'soon' });
      expect(bad.status === 400, `a bad duration gives ${bad.status}, not 400`);
      return `${before} to ${c.body.now}, ${c.body.jobsFired.length} jobs fired`;
    });

    await httpStep('http admin state and reset', async () => {
      const r = await json(admin, 'POST', '/_world/reset');
      expect(r.status === 200, `reset is ${r.status}`);
      const s = await json(admin, 'GET', '/_world/state');
      expect(s.status === 200, `state is ${s.status}`);
      const g = await json(admin, 'POST', `/_world/grade/${task}`);
      expect(g.body.score === 0, `grade after reset is ${JSON.stringify(g.body)}, not 0`);
      const l = await json(admin, 'GET', '/_world/log');
      expect(l.body.calls.length === 0, `log after reset has ${l.body.calls.length} calls`);
      const w = await json(api, 'GET', '/_world/state');
      expect(w.status === 404, `the world port serves /_world/state with ${w.status}, not 404`);
    });
  } finally {
    await stopGroup(server);
  }
}

async function main(): Promise<number> {
  await cmdStep('typecheck', 'typecheck', []);
  await cmdStep('worldplay check helpdesk', 'worldplay', ['check', WORLD]);
  await cmdStep('worldplay verify helpdesk', 'worldplay', ['verify', WORLD]);
  await driveServer();
  if (existsSync(path.join(CODE, 'src/cli/worldgen.ts'))) {
    await cmdStep('worldgen --help', 'worldgen', ['--help'], (o) => /usage/i.test(o));
  } else {
    record('worldgen --help', 'SKIP', 'src/cli/worldgen.ts is not on this branch yet (YOS-35)');
  }
  await cmdStep('eval --help', 'eval', ['--help'], (o) => /usage/i.test(o));

  const docs = await npm('docs');
  const diff = await runCommand('git', ['diff', '--exit-code', '--stat', '--', DOCS], { cwd: CODE, timeoutMs: STEP_MS });
  if (docs.kind === 'failed' || docs.code !== 0) record('docs are fresh', 'FAIL', `npm run docs ${docs.kind === 'failed' ? docs.reason : `exit ${docs.code}`}: ${lastLines(docs.out)}`);
  else if (diff.kind === 'failed') record('docs are fresh', 'FAIL', diff.reason);
  else if (diff.code !== 0) record('docs are fresh', 'FAIL', `npm run docs changed prod/world-format.md: ${diff.out.trim()}`);
  else record('docs are fresh', 'PASS');

  const width = Math.max(...rows.map((r) => r.step.length));
  process.stdout.write(`\n${'STEP'.padEnd(width)}  RESULT  DETAIL\n`);
  for (const r of rows) process.stdout.write(`${r.step.padEnd(width)}  ${r.status.padEnd(6)}  ${r.detail}\n`);
  const failed = rows.filter((r) => r.status === 'FAIL').length;
  process.stdout.write(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${rows.length - failed} of ${rows.length} steps did not fail\n`);
  return failed === 0 ? 0 : 1;
}

// Exit explicitly: a stray handle from a child must never keep the run alive.
process.exit(await main());
