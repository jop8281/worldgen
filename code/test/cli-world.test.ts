import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { checkWorld, createRuntime, renderWorldYaml, type Runtime, type World } from '#engine';
import { bareWorld, minimalWorld, withStubTasks } from './helpers/world.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '..');
const CLI = ['src/cli/worldplay.ts'];

function run(...args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [...CLI, ...args], { cwd: CODE_DIR, encoding: 'utf8' });
  // The task worlds page by default and seed few rows, so the engine's paging lint warns on stderr.
  // Those lines are not what these tests are about.
  const stderr = r.stderr.split('\n').filter((l) => !/^world\.yaml:\d+: warning seed\.too_few_rows_for_paging /.test(l)).join('\n');
  return { status: r.status, stdout: r.stdout, stderr };
}

/**
 * The seed has 5 customers and 12 tickets, and the engine warns when an entity has fewer than
 * three pages of rows. A list pageSize of 1 and 4 keeps these worlds free of that warning.
 */
function withSmallPages(world: World): World {
  const w = structuredClone(world) as unknown as { routes: Record<string, { op: string; entity: string; pageSize?: number }> };
  for (const route of Object.values(w.routes)) {
    if (route.op === 'list') route.pageSize = route.entity === 'customer' ? 1 : 4;
  }
  return w as unknown as World;
}

/**
 * stderr without the paging lint's warning lines. minimalWorld seeds a handful of rows, so since #52
 * every command that checks it first prints seed.too_few_rows_for_paging; R1 and R3 cover warnings.
 */
function withoutPagingLint(stderr: string): string {
  return stderr.replace(/^warning seed\.too_few_rows_for_paging .*\n/gm, '');
}

async function worldDir(world: World): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cli-world-'));
  await writeFile(path.join(dir, 'world.yaml'), renderWorldYaml(world));
  return dir;
}

async function jsonFile(value: unknown): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'cli-state-'));
  const file = path.join(dir, 'end.json');
  await writeFile(file, typeof value === 'string' ? value : JSON.stringify(value));
  return file;
}

let validDir = '';
let taskFreeDir = '';
let typoDir = '';
let linesDir = '';
let tasksDir = '';
let failingTaskDir = '';

/**
 * The world with every list route at pageSize 1, so its few seed rows clear the paging lint
 * (seed.too_few_rows_for_paging, added in #52) and check prints no warning.
 */
function pageable(world: World): World {
  const w = structuredClone(world) as unknown as { routes: Record<string, { op: string; pageSize?: number }> };
  for (const r of Object.values(w.routes)) if (r.op === 'list') r.pageSize = 1;
  return w as unknown as World;
}

/** bareWorld plus one test that calls resolve_ticket, and no tasks. Since YOS-113 it fails world.too_few_tasks. */
function taskFreeWorld(): World {
  return pageable({
    ...bareWorld(),
    tests: {
      resolves_pending: {
        description: 'Resolving a pending ticket returns 200.',
        script: `(ctx) => {
          const t = ctx.api('GET', '/tickets?status=pending').body.data[0];
          ctx.assert(t, 'no pending ticket');
          const r = ctx.api('POST', '/tickets/' + t.id + '/resolve');
          ctx.assert(r.status === 200, 'resolve returned ' + r.status);
        }`,
      },
    },
  });
}

/** taskFreeWorld plus three stub tasks, so the check report has no issues and no warnings. */
const validWorld = (): World => withStubTasks(taskFreeWorld());

/**
 * A hand-written world.yaml with two reference typos on known lines: the route entity `tiket`
 * on line 18 and the sort field `titel` on line 28. Nothing else is wrong with it.
 */
const LINES_WORLD = `format: 1
meta:
  name: shop
  description: A small shop helpdesk.
  resembles: a helpdesk tickets API
  source: hand
  seed: 1
  clock: { start: '2026-01-05T09:00:00.000Z' }
entities:
  ticket:
    description: A support request.
    idPrefix: tkt
    fields:
      title: { type: text }
routes:
  list_tickets:
    op: list
    entity: tiket
    method: GET
    path: /tickets
  search_tickets:
    op: list
    entity: ticket
    method: GET
    path: /tickets/search
    sort:
      - title
      - titel
actions: {}
jobs: {}
fixtures: {}
seed: {}
tests: {}
tasks: {}
`;

/** The 1-based number of the first line of `dir`/world.yaml equal to `text` (after the line `after`), found without the engine. */
async function lineIn(dir: string, text: string, after = ''): Promise<number> {
  const lines = (await readFile(path.join(dir, 'world.yaml'), 'utf8')).split('\n');
  const from = after === '' ? 0 : lines.indexOf(after);
  const at = lines.indexOf(text, from);
  assert.ok(from >= 0 && at >= 0, `${text} not in ${dir}/world.yaml`);
  return at + 1;
}

/** A runtime over the checked minimalWorld, the same world tasksDir holds. */
function minimalRuntime(): Runtime {
  const report = checkWorld(minimalWorld());
  if (!report.ok) assert.fail(JSON.stringify(report.issues, null, 2));
  return createRuntime(report.world);
}

before(async () => {
  validDir = await worldDir(withSmallPages(validWorld()));
  taskFreeDir = await worldDir(taskFreeWorld());
  const w = structuredClone(bareWorld()) as unknown as { routes: Record<string, { entity: string }> };
  assert.ok(w.routes.get_ticket !== undefined);
  w.routes.get_ticket.entity = 'tiket';
  typoDir = await worldDir(w as unknown as World);
  tasksDir = await worldDir(minimalWorld());
  failingTaskDir = await worldDir(minimalWorld({
    tasks: { resolve_initech_pending: null, escalate_acme: null, resolve_password_ticket: { grader: '(ctx) => 0' } },
  }));
  linesDir = await mkdtemp(path.join(tmpdir(), 'cli-world-lines-'));
  await writeFile(path.join(linesDir, 'world.yaml'), LINES_WORLD);
});

describe('world check', () => {
  it('R1 a valid world prints ok and exits 0', () => {
    const r = run('check', validDir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, 'ok\n');
  });

  it('R2 a ref typo exits 1 and prints one issue line in the documented format, with its world.yaml line', async () => {
    const r = run('check', typoDir);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const lines = r.stdout.split('\n');
    assert.equal(lines.length, 5);
    const typo = await lineIn(typoDir, '    entity: tiket', '  get_ticket:');
    const actions = await lineIn(typoDir, 'actions:');
    assert.equal(
      lines[0],
      `world.yaml:${typo}: error ref.unknown routes.get_ticket.entity: expected one of the declared entity names, found "tiket". Known entity names: customer, ticket.`,
    );
    assert.equal(
      lines[1],
      `world.yaml:${actions}: error layer.blocked actions: expected earlier layers pass, found skipped layers: compile. Not checked because the references layer failed. Fix those issues first.`,
    );
    assert.equal(lines[4], '');
  });

  it('R3 --json prints {ok, reached, issues} on stdout, each issue with file and line', async () => {
    const r = run('check', typoDir, '--json');
    assert.equal(r.status, 1);
    const parsed = JSON.parse(r.stdout) as { ok: boolean; reached: string; issues: { file: string; line: number; code: string; path: string[]; found: string }[] };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reached, 'references');
    assert.deepEqual(parsed.issues.map((i) => i.code), ['ref.unknown', 'layer.blocked', 'layer.blocked', 'layer.blocked']);
    assert.deepEqual(parsed.issues[0]?.path, ['routes', 'get_ticket', 'entity']);
    assert.equal(parsed.issues[0]?.found, '"tiket"');
    assert.equal(parsed.issues[0]?.file, 'world.yaml');
    assert.equal(parsed.issues[0]?.line, await lineIn(typoDir, '    entity: tiket', '  get_ticket:'));
  });

  it('R3 --json on a valid world prints ok, the last layer and no issues', () => {
    const r = run('check', validDir, '--json');
    assert.equal(r.status, 0);
    assert.deepEqual(JSON.parse(r.stdout), { ok: true, reached: 'lints', issues: [] });
  });

  it('YOS-77 a typo on a known line reports that exact line', () => {
    const r = run('check', linesDir);
    assert.equal(r.status, 1);
    assert.deepEqual(r.stdout.split('\n').slice(0, 2), [
      'world.yaml:18: error ref.unknown routes.list_tickets.entity: expected one of the declared entity names, found "tiket". Known entity names: ticket.',
      'world.yaml:28: error ref.unknown routes.search_tickets.sort.1: expected one of the declared ticket field names, found "titel". Known ticket field names: title, id, created_at, updated_at.',
    ]);
  });

  it('YOS-77 --json gives each issue as {file, line, path, code, severity, expected, found, hint}', () => {
    const r = run('check', linesDir, '--json');
    assert.equal(r.status, 1);
    const parsed = JSON.parse(r.stdout) as { ok: boolean; reached: string; issues: unknown[] };
    assert.equal(parsed.ok, false);
    assert.equal(parsed.reached, 'references');
    assert.deepEqual(parsed.issues[0], {
      file: 'world.yaml',
      line: 18,
      path: ['routes', 'list_tickets', 'entity'],
      code: 'ref.unknown',
      severity: 'error',
      expected: 'one of the declared entity names',
      found: '"tiket"',
      hint: 'Known entity names: ticket.',
    });
    assert.deepEqual(parsed.issues[1], {
      file: 'world.yaml',
      line: 28,
      path: ['routes', 'search_tickets', 'sort', 1],
      code: 'ref.unknown',
      severity: 'error',
      expected: 'one of the declared ticket field names',
      found: '"titel"',
      hint: 'Known ticket field names: title, id, created_at, updated_at.',
    });
  });

  it('YOS-77 a YAML syntax error prints its line, and --json carries it', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cli-world-syntax-'));
    await writeFile(path.join(dir, 'world.yaml'), 'format: 1\nmeta: [1, 2\nother: x\n');
    const r = run('check', dir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^world\.yaml:3: error schema\.invalid format: expected world\.yaml to be valid YAML, found line 3, column 1 in /);
    const j = JSON.parse(run('check', dir, '--json').stdout) as { ok: boolean; reached: string; issues: { file: string; line: number | null }[] };
    assert.deepEqual([j.ok, j.reached, j.issues[0]?.file, j.issues[0]?.line], [false, 'schema', 'world.yaml', 3]);
  });

  it('R4 a directory without world.yaml is a format issue and exits 1', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cli-world-empty-'));
    const r = run('check', dir);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^error schema\.invalid format: expected /);
    const j = JSON.parse(run('check', dir, '--json').stdout) as { ok: boolean; reached: string; issues: { file: string; line: number | null }[] };
    assert.deepEqual([j.ok, j.reached, j.issues[0]?.file, j.issues[0]?.line], [false, 'schema', 'world.yaml', null]);
  });

  it('R5 check without a dir exits 2 with usage on stderr and nothing on stdout', () => {
    const r = run('check');
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /usage: worldplay <command>/);
  });
});

describe('world usage', () => {
  it('R6 an unknown subcommand exits 2 and lists every subcommand', () => {
    const r = run('frobnicate');
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /unknown command frobnicate/);
    for (const c of ['check', 'serve', 'verify', 'openapi', 'grade', 'docs']) assert.match(r.stderr, new RegExp(`^  ${c}\\b`, 'm'));
    assert.doesNotMatch(r.stderr, /not implemented/);
  });
});

describe('world verify on the helpdesk world', () => {
  const HELPDESK = path.resolve(CODE_DIR, '../prod/worlds/helpdesk');

  it('default output stays the human text', () => {
    const r = run('verify', HELPDESK);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.split('\n')[2], 'escalate_breached_enterprise_tickets hard solution 1.000 noop 0.000 decoys [0.571, 0.000, 0.000, 0.000, 0.000, 0.000] prefix 0.857 mutants 6/8 probed (not probed: extra_delete, perturb)');
  });

  it('--json prints one proof object per task', () => {
    const r = run('verify', HELPDESK, '--json');
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines.length, 3);
    assert.deepEqual(JSON.parse(lines[2] ?? ''), {
      task: 'escalate_breached_enterprise_tickets',
      difficulty: 'hard',
      proof: {
        reference: { score: 1, calls: 10 },
        noop: { score: 0 },
        near_miss: { score: 0.5714285714285714 },
        decoys: [0.5714285714285714, 0, 0, 0, 0, 0],
        best_prefix: 0.8571428571428571,
        replay_identical: true,
        state: 'fb006c250daecd25f730c1b0ec2a9d72',
      },
    });
    assert.deepEqual(JSON.parse(lines[0] ?? '').proof.best_prefix, null);
    assert.equal(JSON.parse(lines[0] ?? '').proof.state, 'bc9b2d5a7fbcefc30aaee94ef8637b59');
  });
});

describe('world verify', () => {
  it('R12 prints one verdict line per task in declaration order and exits 0', () => {
    const r = run('verify', tasksDir);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const lines = r.stdout.split('\n');
    assert.equal(lines.length, 4);
    // One write and no decoys, so nothing here depends on how decoys and prefixes are scored.
    assert.equal(lines[0], 'resolve_password_ticket easy solution 1.000 noop 0.000 decoys [] prefix - mutants 6/8 probed (not probed: extra_action, perturb)');
    assert.match(lines[1] ?? '', /^resolve_initech_pending medium solution 1\.000 noop 0\.000 decoys \[(\d\.\d{3}(, \d\.\d{3})*)?\] prefix (-|\d\.\d{3}) mutants \d\/8 probed( \(not probed: [a-z_, ]+\))?$/);
    assert.match(lines[2] ?? '', /^escalate_acme hard solution 1\.000 noop 0\.000 decoys \[(\d\.\d{3}(, \d\.\d{3})*)?\] prefix (-|\d\.\d{3}) mutants \d\/8 probed( \(not probed: [a-z_, ]+\))?$/);
    assert.equal(lines[3], '');
  });

  it('R12 --json on a world that fails check prints the check --json document, not issue text', () => {
    const r = run('verify', typoDir, '--json');
    assert.equal(r.status, 1);
    assert.equal(r.stdout, run('check', typoDir, '--json').stdout);
    const parsed = JSON.parse(r.stdout) as { ok: boolean; reached: string; issues: { code: string }[] };
    assert.deepEqual({ ok: parsed.ok, reached: parsed.reached, first: parsed.issues[0]?.code }, { ok: false, reached: 'references', first: 'ref.unknown' });
  });

  it('R12 a world without tasks fails world.too_few_tasks and exits 1 (YOS-113)', async () => {
    const r = run('verify', taskFreeDir);
    assert.equal(r.status, 1);
    const line = await lineIn(taskFreeDir, 'tasks: {}');
    assert.equal(r.stdout, `world.yaml:${line}: error world.too_few_tasks tasks: expected at least 3 tasks covering easy, medium and hard, found 0 tasks. The world has 0.\n`);
  });

  it('R12 --json on a world without tasks prints the check document with world.too_few_tasks and exits 1 (YOS-113)', () => {
    const r = run('verify', taskFreeDir, '--json');
    assert.equal(r.status, 1);
    const parsed = JSON.parse(r.stdout) as { ok: boolean; issues: { code: string }[] };
    assert.deepEqual({ ok: parsed.ok, codes: parsed.issues.map((i) => i.code) }, { ok: false, codes: ['world.too_few_tasks'] });
  });

  it('R12 a task whose solution does not score 1 prints the issue and exits 1', async () => {
    const r = run('verify', failingTaskDir);
    assert.equal(r.status, 1);
    const task = await lineIn(failingTaskDir, '  resolve_password_ticket:', 'tasks:');
    assert.equal(
      r.stdout.split('\n')[0],
      `world.yaml:${task}: error task.solution_not_full_marks tasks.resolve_password_ticket: expected the solution scores exactly 1, found solution scored 0. Either the solution misses rows (check paging) or the grader asks for more than the instruction says.`,
    );
  });

  it('R12 a world that fails an earlier layer exits 1 with its issues', () => {
    const r = run('verify', typoDir);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^world\.yaml:\d+: error ref\.unknown routes\.get_ticket\.entity: /);
  });

  it('R12 verify without a dir exits 2', () => {
    const r = run('verify');
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.equal(r.stdout, '');
    assert.match(r.stderr, /^verify takes exactly one <dir>\n/);
  });
});

describe('world grade', () => {
  it('R13 prints 1 for an end state where the task is done, and 0 for the seed', async () => {
    const rt = minimalRuntime();
    const seed = await jsonFile(rt.dump());
    assert.equal(rt.call({ method: 'POST', path: '/tickets/tkt_0002/resolve', query: {}, body: undefined }).status, 200);
    const end = await jsonFile(rt.dump());
    const done = run('grade', tasksDir, 'resolve_password_ticket', '--state', end);
    assert.equal(done.status, 0, done.stdout + done.stderr);
    assert.equal(done.stdout, '1\n');
    // A dump carries no write trace, so the grade says an undone edit went unjudged (A-387).
    assert.equal(withoutPagingLint(done.stderr), 'caveat: no journal or call log given, so ctx.changes() and the collateral guards saw only the end state; an edit undone before it was not judged\n');
    const noop = run('grade', tasksDir, 'resolve_password_ticket', `--state=${seed}`);
    assert.equal(noop.status, 0, noop.stdout + noop.stderr);
    assert.equal(noop.stdout, '0\n');
  });

  it('R13 warns on stderr when jobs may have fired, since a dump carries no journal', async () => {
    const rt = minimalRuntime();
    assert.equal(rt.call({ method: 'POST', path: '/tickets/tkt_0002/resolve', query: {}, body: undefined }).status, 200);
    rt.advance('4h');
    const r = run('grade', tasksDir, 'resolve_password_ticket', '--state', await jsonFile(rt.dump()));
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout, '0.5\n');
    assert.equal(
      withoutPagingLint(r.stderr),
      'caveat: no journal given and job(s) escalate_overdue may have fired before 2026-01-05T13:00:01.000Z; their changes counted as calls, so a collateral check may have lowered this score; no journal or call log given, so ctx.changes() and the collateral guards saw only the end state; an edit undone before it was not judged\n',
    );
  });

  it('R13 an unknown task prints the issue and exits 1', async () => {
    const r = run('grade', tasksDir, 'nope', '--state', await jsonFile(minimalRuntime().dump()));
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.equal(
      r.stdout,
      'error ref.unknown tasks.nope: expected one of the declared task names, found "nope". Known task names: resolve_password_ticket, resolve_initech_pending, escalate_acme.\n',
    );
  });

  it('R13 a state file that is not JSON or not a dump exits 1 and says why', async () => {
    const notJson = await jsonFile('{"now": ');
    const a = run('grade', tasksDir, 'resolve_password_ticket', '--state', notJson);
    assert.equal(a.status, 1, a.stdout + a.stderr);
    assert.match(withoutPagingLint(a.stderr), new RegExp(`^grade: ${notJson.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is not JSON: `));
    const b = run('grade', tasksDir, 'resolve_password_ticket', '--state', await jsonFile({ now: 'yesterday', tables: {}, counters: {} }));
    assert.equal(b.status, 1, b.stdout + b.stderr);
    assert.equal(withoutPagingLint(b.stderr), 'grade: Not a state dump: now "yesterday" is not an ISO 8601 time\n');
    const c = run('grade', tasksDir, 'resolve_password_ticket', '--state', path.join(tmpdir(), 'no-such-dir-xyz', 'end.json'));
    assert.equal(c.status, 1, c.stdout + c.stderr);
    assert.match(withoutPagingLint(c.stderr), /^grade: cannot read /);
  });

  it('R13 missing <task> or --state exits 2 with usage', () => {
    const a = run('grade', tasksDir, 'resolve_password_ticket');
    assert.equal(a.status, 2, a.stdout + a.stderr);
    assert.match(a.stderr, /^grade takes <dir> <task> --state <file>\n/);
    const b = run('grade', tasksDir, '--state', 'end.json');
    assert.equal(b.status, 2, b.stdout + b.stderr);
    assert.equal(b.stdout, '');
  });
});

/** Starts `worldplay serve` and resolves with its two printed URLs once both lines are out. */
function startServe(args: string[], env: NodeJS.ProcessEnv = {}): { urls: Promise<{ world: string; admin: string }>; exit: Promise<number | null>; stop: () => void; output: () => string } {
  const child = spawn(process.execPath, [...CLI, 'serve', ...args], { cwd: CODE_DIR, env: { ...process.env, WORLDPLAY_HOST: undefined, WORLDPLAY_ADMIN_HOST: undefined, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  const urls = new Promise<{ world: string; admin: string }>((resolve, reject) => {
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      out += chunk;
      const world = /^world (http:\/\/\S+)$/m.exec(out)?.[1];
      const admin = /^admin (http:\/\/\S+)$/m.exec(out)?.[1];
      if (world !== undefined && admin !== undefined) resolve({ world, admin });
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      err += chunk;
    });
    void exit.then((code) => reject(new Error(`serve exited ${String(code)} before printing URLs:\n${out}${err}`)));
  });
  return { urls, exit, stop: () => child.kill('SIGTERM'), output: () => out + err };
}

describe('world serve', () => {
  it('R11 checks, prints the world and admin URLs, serves both, and exits 0 on SIGTERM', async () => {
    const s = startServe([tasksDir, '--port', '0']);
    try {
      const { world, admin } = await s.urls;
      assert.match(world, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.match(admin, /^http:\/\/127\.0\.0\.1:\d+$/);
      // Port 0 binds both ports where the OS picks, and the first line reports them for a parent to read (A-348).
      const listening = JSON.parse(s.output().split('\n')[0] ?? '') as unknown;
      assert.deepEqual(listening, { listening: { world: Number(new URL(world).port), admin: Number(new URL(admin).port) } });
      const tickets = await fetch(`${world}/tickets?limit=1`);
      assert.equal(tickets.status, 200);
      assert.deepEqual(((await tickets.json()) as { data: { id: string }[] }).data.map((t) => t.id), ['tkt_0001']);
      assert.equal((await fetch(`${world}/_world/state`)).status, 404);
      const state = await fetch(`${admin}/_world/state`);
      assert.equal(state.status, 200);
      // One successful call (the list) moved engine time by the 1s tick; the 404 did not.
      assert.equal(((await state.json()) as { now: string }).now, '2026-01-05T09:00:01.000Z');
    } finally {
      s.stop();
    }
    assert.equal(await s.exit, 0, s.output());
  });

  it('R11 WORLDPLAY_HOST sets the bind host and --host overrides it', async () => {
    const all = startServe([tasksDir, '--port', '0'], { WORLDPLAY_HOST: '0.0.0.0' });
    try {
      const { world, admin } = await all.urls;
      assert.match(world, /^http:\/\/0\.0\.0\.0:\d+$/);
      assert.match(admin, /^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      all.stop();
    }
    assert.equal(await all.exit, 0, all.output());
    const flag = startServe([tasksDir, '--port', '0', '--host', '127.0.0.1'], { WORLDPLAY_HOST: '0.0.0.0' });
    try {
      assert.match((await flag.urls).world, /^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      flag.stop();
    }
    assert.equal(await flag.exit, 0, flag.output());
  });

  it('R11 a SIGTERM sent the moment the URLs print is handled: exit 0, never killed by the signal', async () => {
    const codes: (number | null)[] = [];
    for (let i = 0; i < 12; i++) {
      const s = startServe([tasksDir, '--port', '0']);
      await s.urls;
      s.stop();
      codes.push(await s.exit);
    }
    assert.deepEqual(codes, Array(12).fill(0));
  });

  it('R11 WORLDPLAY_ADMIN_HOST sets the admin bind host and --admin-host overrides it', async () => {
    const env = startServe([tasksDir, '--port', '0'], { WORLDPLAY_ADMIN_HOST: '0.0.0.0' });
    try {
      const { world, admin } = await env.urls;
      assert.match(world, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.match(admin, /^http:\/\/0\.0\.0\.0:\d+$/);
    } finally {
      env.stop();
    }
    assert.equal(await env.exit, 0, env.output());
    const flag = startServe([tasksDir, '--port', '0', '--admin-host', '127.0.0.1'], { WORLDPLAY_ADMIN_HOST: '0.0.0.0' });
    try {
      assert.match((await flag.urls).admin, /^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      flag.stop();
    }
    assert.equal(await flag.exit, 0, flag.output());
  });

  it('R11 serve usage names --admin-host and both env defaults', () => {
    const r = run('serve');
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /\[--admin-host 127\.0\.0\.1\]/);
    assert.match(r.stderr, /env WORLDPLAY_HOST and WORLDPLAY_ADMIN_HOST set the defaults/);
  });

  it('R11 a world that fails check prints its issues and exits 1 without serving', () => {
    const r = run('serve', typoDir, '--port', '0');
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^world\.yaml:\d+: error ref\.unknown routes\.get_ticket\.entity: /);
    assert.doesNotMatch(r.stdout, /^world http/m);
  });

  it('R11 a bad --port or a missing dir exits 2', () => {
    const port = run('serve', validDir, '--port', 'abc');
    assert.equal(port.status, 2, port.stdout + port.stderr);
    assert.match(port.stderr, /^--port must be a whole number from 0 to 65535, got abc\n/);
    const dir = run('serve');
    assert.equal(dir.status, 2, dir.stdout + dir.stderr);
    assert.match(dir.stderr, /^serve takes exactly one <dir>\n/);
  });
});

describe('worldplay openapi', () => {
  const world = '../prod/worlds/gen-petstore';
  const spec = '../eval/inputs/petstore.openapi.yaml';

  it('exits 0 with only warnings, one per extra operation', () => {
    const r = run('openapi', world, '--spec', spec, '--only', '/store');
    assert.equal(r.status, 0);
    assert.equal(r.stdout.split('\n').filter((l) => l.startsWith('warning openapi.operation_extra ')).length, 3);
    assert.equal(r.stdout.includes('error '), false);
  });

  it('exits 1 on a missing operation', () => {
    const r = run('openapi', world, '--spec', '../eval/inputs/stripe.openapi.yaml', '--only', '/v1/refunds');
    assert.equal(r.status, 1);
    assert.match(r.stdout.split('\n')[0] ?? '', /^error openapi\.operation_missing input\.openapi\.(GET|POST) \/v1\/refunds/);
  });

  it('needs --spec', () => {
    const r = run('openapi', world);
    assert.equal(r.status, 2);
  });
});
