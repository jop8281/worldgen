/**
 * The live run: intake planning, the results table, and the runner with a canned run function.
 * No model is called anywhere. A canned run copies the helpdesk world, so verify is the real engine.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { parseArgs, runLive, type LiveArgs, type LiveDeps, type RunSummary } from '../src/cli/live.ts';
import { checkWorld, loadWorld } from '#engine';
import { delivered, planIntake, renderLiveRun, type LiveCase, type LiveCheck, type LiveMeta, type LiveRow } from '../src/worldgen/live.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '..');
const HELPDESK = path.resolve(CODE_DIR, '../prod/worlds/helpdesk');

describe('planIntake', () => {
  it('plans one case per prompt, in order, with its args and change request attached', () => {
    const plan = planIntake([
      '02-refunds.openapi.yaml',
      '02-refunds.args',
      '01-dental-clinic.txt',
      '01-dental-clinic.change.txt',
      '03-orders/orders.csv',
      '03-orders/customers.csv',
      '01-dental-clinic.v2.txt',
      'README.md',
      '.gitkeep',
    ]);
    assert.deepEqual(plan.problems, []);
    assert.deepEqual(plan.cases.map((c) => [c.id, c.outName, c.input.kind, c.changeFile]), [
      ['01-dental-clinic', 'gen-dental-clinic', 'description', '01-dental-clinic.change.txt'],
      ['01-dental-clinic.v2', 'gen-dental-clinic-v2', 'description', null],
      ['02-refunds', 'gen-refunds', 'openapi', null],
      ['03-orders', 'gen-orders', 'csv', null],
    ]);
    assert.deepEqual(plan.cases[2]?.input, { kind: 'openapi', file: '02-refunds.openapi.yaml', argsFile: '02-refunds.args' });
    assert.deepEqual(plan.cases[3]?.input, { kind: 'csv', dir: '03-orders', files: ['03-orders/customers.csv', '03-orders/orders.csv'] });
  });

  it('reports every file that is not part of the format, naming the file', () => {
    const plan = planIntake(['notes.md', 'Bad_Name.txt', '1-x.txt', '04-orphan.args', '05-gone.change.txt', 'deep/er/x.csv', 'a-folder/readme.txt', '06-x.docx']);
    assert.deepEqual(plan.cases, []);
    assert.deepEqual(plan.problems.map((p) => p.split(':')[0]), ['04-orphan.args', '05-gone.change.txt', '06-x.docx', '1-x.txt', 'Bad_Name.txt', 'a-folder/readme.txt', 'deep/er/x.csv', 'notes.md']);
  });

  it('refuses two files for one prompt id', () => {
    const plan = planIntake(['01-a.txt', '01-a.openapi.yaml']);
    assert.equal(plan.problems.length, 1);
    assert.match(plan.problems[0]!, /01-a\.txt: prompt 01-a is already given by another file/);
  });
});

const meta: LiveMeta = { date: '2026-10-07', commit: 'abc1234', model: 'claude-sonnet-5-5', maxCostUsd: 5, maxMinutes: 15 };
const row = (over: Partial<LiveRow>): LiveRow => ({ id: '01-a', inputKind: 'description', changed: false, outcome: 'done', detail: '', check: { kind: 'pass', tasks: 3 }, ms: 120000, costUsd: 1.234, dir: 'prod/worlds/gen-a', ...over });

describe('renderLiveRun', () => {
  it('writes one row per prompt and totals only what ran', () => {
    const text = renderLiveRun(meta, [
      row({}),
      row({ id: '02-b', inputKind: 'openapi', changed: true, outcome: 'stopped', detail: 'budget_exhausted at tasks', check: { kind: 'not_run' }, ms: 60000, costUsd: 5, dir: 'eval/runs/2026-10-07-live/gen-b' }),
      row({ id: '03-c', outcome: 'done', detail: 'engine rejects it | really', check: { kind: 'fail', codes: ['task.noop_not_zero'] }, ms: 0, costUsd: 0, dir: 'eval/runs/2026-10-07-live/gen-c' }),
      row({ id: '04-d', outcome: 'skipped', detail: 'prod/worlds/gen-d already holds a world', check: { kind: 'not_run' }, ms: 0, costUsd: 0, dir: 'prod/worlds/gen-d' }),
    ]);
    assert.ok(text.includes('Run on 2026-10-07 at commit `abc1234`, model `claude-sonnet-5-5`, with a budget of $5 and 15 minutes per prompt.'));
    assert.ok(text.includes('| 01-a | description | done | pass, 3 tasks | 2.0 | 1.23 | `prod/worlds/gen-a` |'));
    assert.ok(text.includes('| 02-b | openapi + change | stopped: budget_exhausted at tasks | not run | 1.0 | 5.00 | `eval/runs/2026-10-07-live/gen-b` |'));
    assert.ok(text.includes('| 03-c | description | done: engine rejects it \\| really | FAIL task.noop_not_zero | 0.0 | 0.00 |'));
    assert.ok(text.includes('| 04-d | description | skipped: prod/worlds/gen-d already holds a world | - | - | - |'));
    assert.ok(text.includes('Delivered 1 of 3 prompts that ran, 1 skipped because a world was already there. Total 3.0 minutes and $6.23'));
  });

  it('counts a done world that fails verify as not delivered', () => {
    assert.equal(delivered(row({})), true);
    assert.equal(delivered(row({ check: { kind: 'fail', codes: ['x'] } })), false);
    assert.equal(delivered(row({ outcome: 'stopped', check: { kind: 'not_run' } })), false);
  });
});

describe('parseArgs', () => {
  it('needs a prompts directory, and rejects unknown flags and bad numbers', () => {
    assert.throws(() => parseArgs([]), /give the prompts directory/);
    assert.throws(() => parseArgs(['p', '--bogus']), /unknown option --bogus/);
    assert.throws(() => parseArgs(['p', '--budget-usd', '0']), /--budget-usd needs a positive number, got 0/);
    assert.throws(() => parseArgs(['p', '--date', 'today']), /--date needs YYYY-MM-DD/);
    assert.throws(() => parseArgs(['p', 'q']), /unexpected argument q/);
  });

  it('keeps the A-48 limits unless a flag overrides them', () => {
    const a = parseArgs(['p', '--only', '01-a, 02-b', '--max-minutes', '3']) as LiveArgs;
    assert.deepEqual(a.only, ['01-a', '02-b']);
    assert.deepEqual(a.overrides, { maxMinutes: 3 });
  });
});

let tmp = '';
before(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'live-test-'));
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

async function verifyWorld(dir: string): Promise<LiveCheck> {
  const loaded = await loadWorld(dir);
  if (!loaded.ok) return { kind: 'fail', codes: loaded.error.map((i) => i.code) };
  const report = checkWorld(loaded.value);
  return report.ok ? { kind: 'pass', tasks: Object.keys(report.verdicts).length } : { kind: 'fail', codes: report.issues.map((i) => i.code) };
}

async function setup(name: string, files: Record<string, string>): Promise<{ args: LiveArgs; root: string }> {
  const root = await mkdtemp(path.join(tmp, `${name}-`));
  const promptsDir = path.join(root, 'prompts');
  await mkdir(promptsDir, { recursive: true });
  for (const [f, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(promptsDir, f)), { recursive: true });
    await writeFile(path.join(promptsDir, f), text);
  }
  const args: LiveArgs = { promptsDir, only: null, dryRun: false, commit: 'abc1234', date: '2026-10-07', report: path.join(root, 'LIVE-RUN.md'), worldsDir: path.join(root, 'worlds'), outDir: path.join(root, 'runs'), overrides: {} };
  return { args, root };
}

/** A canned run: the helpdesk world copied into the job's directory, or a stop. */
function canned(script: Record<string, 'done' | 'stopped' | 'broken' | 'throws'>, seen: unknown[] = []): LiveDeps {
  return {
    verify: verifyWorld,
    run: async (job): Promise<RunSummary> => {
      seen.push(job);
      const dir = job.kind === 'create' ? job.outDir : job.worldDir;
      const key = path.basename(dir);
      const how = script[key] ?? 'done';
      if (how === 'throws') throw new Error('claude CLI exited 1');
      if (job.kind === 'create') {
        if (how === 'stopped') {
          await mkdir(dir, { recursive: true });
          await writeFile(path.join(dir, 'REPORT.md'), 'Stopped\n');
        } else {
          await cp(HELPDESK, dir, { recursive: true });
          if (how === 'broken') await writeFile(path.join(dir, 'world.yaml'), 'not: a world\n');
        }
      }
      return how === 'stopped'
        ? { kind: 'stopped', dir, costUsd: 0.5, ms: 1000, stopLine: 'budget_exhausted at tasks' }
        : { kind: 'done', dir, costUsd: 1, ms: 2000, stopLine: '' };
    },
  };
}

const planOf = (files: string[]): readonly LiveCase[] => planIntake(files).cases;

describe('runLive', () => {
  it('keeps unknown cancelled billing in the saved live table', async () => {
    const { args } = await setup('cancelled-cost', { '01-a.txt': 'one' });
    const deps = canned({ 'gen-a': 'stopped' });
    const { rows, code } = await runLive(args, planOf(['01-a.txt']), meta, {
      ...deps,
      run: async (job) => ({ ...await deps.run(job), costUsd: 0, unknownCostCalls: 1, stopLine: 'time_exhausted' }),
    });
    assert.equal(code, 1);
    assert.equal(rows[0]?.unknownCostCalls, 1);
    const table = await readFile(args.report, 'utf8');
    assert.equal(table.includes('| 0.00 + unknown |'), true);
    assert.equal(table.includes('This total excludes 1 cancelled call(s) with unknown cost.'), true);
  });

  it('moves a verified world into the worlds dir, keeps a stop outside it, and writes the table', async () => {
    const { args, root } = await setup('mix', { '01-ok.txt': 'A todo app\n', '02-stop.txt': 'Something impossible', '03-bad.txt': 'Looks done' });
    const seen: unknown[] = [];
    const cases = planOf(['01-ok.txt', '02-stop.txt', '03-bad.txt']);
    const { rows, code } = await runLive(args, cases, meta, canned({ 'gen-stop': 'stopped', 'gen-bad': 'broken' }, seen));
    assert.equal(code, 1);
    assert.deepEqual(rows.map((r) => [r.id, r.outcome, r.check.kind]), [['01-ok', 'done', 'pass'], ['02-stop', 'stopped', 'not_run'], ['03-bad', 'done', 'fail']]);
    assert.equal(existsSync(path.join(root, 'worlds/gen-ok/world.yaml')), true);
    assert.equal(existsSync(path.join(root, 'runs/gen-ok')), false);
    assert.equal(existsSync(path.join(root, 'runs/gen-stop/REPORT.md')), true);
    assert.equal(existsSync(path.join(root, 'worlds/gen-stop')), false);
    assert.equal(existsSync(path.join(root, 'runs/gen-bad/world.yaml')), true);
    assert.equal(existsSync(path.join(root, 'worlds/gen-bad')), false);
    assert.deepEqual((seen[0] as { input: unknown }).input, { kind: 'description', text: 'A todo app' });
    const table = await readFile(args.report, 'utf8');
    assert.ok(table.includes('| 02-stop | description | stopped: budget_exhausted at tasks | not run |'));
    assert.ok(table.includes('Delivered 1 of 3 prompts that ran'));
  });

  it('records a crash as a row and carries on with the next prompt', async () => {
    const { args } = await setup('crash', { '01-a.txt': 'one', '02-b.txt': 'two' });
    const { rows, code } = await runLive(args, planOf(['01-a.txt', '02-b.txt']), meta, canned({ 'gen-a': 'throws' }));
    assert.deepEqual(rows.map((r) => [r.outcome, r.detail]), [['crashed', 'claude CLI exited 1'], ['done', '']]);
    assert.equal(code, 1);
  });

  it('runs the change request on the world the first run saved, and adds the cost of both', async () => {
    const { args } = await setup('change', { '01-a.txt': 'one', '01-a.change.txt': 'add refunds\n' });
    const seen: unknown[] = [];
    const { rows, code } = await runLive(args, planOf(['01-a.txt', '01-a.change.txt']), meta, canned({}, seen));
    assert.equal(code, 0);
    assert.equal(seen.length, 2);
    assert.equal((seen[1] as { kind: string; request: string }).kind, 'iterate');
    assert.equal((seen[1] as { request: string }).request, 'add refunds');
    assert.deepEqual([rows[0]?.costUsd, rows[0]?.ms, rows[0]?.changed], [2, 4000, true]);
  });

  it('skips a prompt whose world is already delivered, and leaves its files alone', async () => {
    const { args, root } = await setup('skip', { '01-a.txt': 'one' });
    await cp(HELPDESK, path.join(root, 'worlds/gen-a'), { recursive: true });
    const seen: unknown[] = [];
    const { rows, code } = await runLive(args, planOf(['01-a.txt']), meta, canned({}, seen));
    assert.equal(seen.length, 0);
    assert.equal(rows[0]?.outcome, 'skipped');
    assert.equal(code, 0);
  });

  it('reads an OpenAPI prompt with its --only args and a CSV prompt with every file', async () => {
    const { args } = await setup('kinds', { '01-r.openapi.yaml': 'openapi: 3.0.0\n', '01-r.args': '--only /v1/refunds\n', '02-o/a.csv': 'x\n1\n', '02-o/b.csv': 'y\n2\n' });
    const seen: { input: { kind: string; only?: string[]; paths?: string[] } }[] = [];
    await runLive(args, planOf(['01-r.openapi.yaml', '01-r.args', '02-o/a.csv', '02-o/b.csv']), meta, canned({}, seen));
    assert.equal(seen[0]?.input.kind, 'openapi');
    assert.deepEqual(seen[0]?.input.only, ['/v1/refunds']);
    assert.equal(seen[1]?.input.kind, 'csv');
    assert.deepEqual(seen[1]?.input.paths?.map((p) => path.basename(p)), ['a.csv', 'b.csv']);
  });
});

describe('npm run live', () => {
  const live = (args: readonly string[]): { status: number | null; stdout: string; stderr: string } => {
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/live.ts', ...args], { cwd: CODE_DIR, encoding: 'utf8', env: { PATH: process.env['PATH'] ?? '' } });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };

  it('--dry-run lists the prompts without any model call or file written', async () => {
    const { args, root } = await setup('dry', { '01-a.txt': 'one', '02-r.openapi.yaml': 'x', '03-o/a.csv': 'x' });
    const r = live([args.promptsDir, '--dry-run']);
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '01-a  description  -> prod/worlds/gen-a\n02-r  openapi  -> prod/worlds/gen-r\n03-o  csv  -> prod/worlds/gen-o\n3 prompts ready. No model was called.\n');
    assert.equal(existsSync(path.join(root, 'LIVE-RUN.md')), false);
  });

  it('exits 2 on an intake problem, naming the file, before any model call', async () => {
    const { args } = await setup('bad', { '01-a.txt': 'one', 'stray.pdf': 'x' });
    const r = live([args.promptsDir]);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /stray\.pdf: not part of the intake format/);
    assert.equal(r.stdout, '');
  });

  it('exits 2 on bad usage and 0 on --help', () => {
    assert.equal(live([]).status, 2);
    assert.equal(live([]).stderr, 'give the prompts directory (see --help)\n');
    const h = live(['--help']);
    assert.equal(h.status, 0);
    assert.ok(h.stdout.includes('--dry-run'));
  });
});
