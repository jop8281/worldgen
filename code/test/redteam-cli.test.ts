/**
 * Red-team: the `worldplay` CLI (G-56 to G-58). Each test spawns `bun src/cli/worldplay.ts` the way
 * `bun run worldplay <args>` does. Expected output fragments are literals: issue codes, the
 * path segments of the mutated item, the found value, and the fixed parts of the
 * expected and hint texts in ISSUES.
 *
 * Ambiguities this file owns in the contract: RT-97 (how the CLI fails on a bad
 * invocation), RT-98 (whether a CLI failure is a clean message with no Node stack trace)
 * and RT-99 (what `world verify` prints for a failing task).
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { World } from '#engine';
import { cap, freshRuntime, opts, probeCli, runCli, writeWorldDir, type CliResult } from './redteam/harness.ts';
import { MUTATIONS } from './redteam/mutations.ts';
import { TASK_IDS, baseWorld } from './redteam/world.ts';

await probeCli();

// ---------------------------------------------------------------------------------------
// File-local helpers

const dirs: string[] = [];
after(async () => {
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function worldDir(mutate?: (w: World) => void): Promise<string> {
  const w = baseWorld();
  mutate?.(w);
  const d = await writeWorldDir(w);
  dirs.push(d);
  return d;
}

async function scratch(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), 'redteam-cli-'));
  dirs.push(d);
  return d;
}

function mutation(id: string): (w: World) => void {
  const m = MUTATIONS.find((x) => x.id === id);
  if (!m) throw new Error(`no mutation ${id}`);
  return m.mutate;
}

const out = (r: CliResult): string => `${r.stdout}\n${r.stderr}`;
const show = (r: CliResult): string => `exit ${String(r.code)}${r.timedOut ? ' (timed out)' : ''}\n--- stdout\n${r.stdout.slice(-3000)}\n--- stderr\n${r.stderr.slice(-3000)}`;

/** A Node stack frame or an internal path means an unhandled error reached the user (RT-98). */
const STACK = /\n\s+at\s+\S.*:\d+:\d+\)?\s*(\n|$)|node:internal\/|\bat async\b/;

/** Exited by itself, non-zero, and said something (G-56: a broken world prints its issues). */
function assertFailed(r: CliResult, label: string): void {
  assert.equal(r.timedOut, false, `${label}: timed out\n${show(r)}`);
  assert.notEqual(r.code, null, `${label}: killed by a signal\n${show(r)}`);
  assert.notEqual(r.code, 0, `${label}: exit 0\n${show(r)}`);
  assert.ok(out(r).trim().length > 0, `${label}: printed nothing`);
}

function assertIncludesAll(r: CliResult, fragments: readonly string[], label: string): void {
  const text = out(r);
  const missing = fragments.filter((f) => !text.includes(f));
  assert.deepEqual(missing, [], `${label}: output lacks ${JSON.stringify(missing)}\n${show(r)}`);
}

/** A number printed on its own, not part of 1005, 0.5 or a word. `re` is the number's pattern. */
const standaloneNumber = (re: string): RegExp => new RegExp(`(^|[^\\w.])(${re})(?=$|[^\\w.]|\\.(?!\\d))`, 'm');
/** A score printed as a standalone number, such as "1", "1.0" or "1.000", not part of 1005 or 0.5. */
const standalone = (n: 0 | 1): RegExp => standaloneNumber(`${n}(\\.0+)?`);
/** 0.5 printed as "0.5", ".5" or "0.50". */
const HALF = standaloneNumber('0?\\.50*');

/** CLI runs shared between a guaranteed test and its RT-98 counterpart, so each spawns once. */
const runs = new Map<string, Promise<CliResult>>();
function once(key: string, make: () => Promise<readonly string[]>, timeoutMs?: number): Promise<CliResult> {
  let p = runs.get(key);
  if (!p) {
    p = make().then((args) => runCli(args, timeoutMs === undefined ? {} : { timeoutMs }));
    runs.set(key, p);
  }
  return p;
}

const checkMutated = (id: string): Promise<CliResult> => once(`check ${id}`, async () => ['check', await worldDir(mutation(id))]);
const checkMissingDir = (): Promise<CliResult> => once('check missing dir', async () => ['check', join(await scratch(), 'no-such-world')]);
const checkBadYaml = (): Promise<CliResult> =>
  once('check bad yaml', async () => {
    const d = await scratch();
    await writeFile(join(d, 'world.yaml'), 'format: 1\nmeta: [unclosed\n');
    return ['check', d];
  });

// ---------------------------------------------------------------------------------------

describe('world check (G-56)', () => {
  it('G-56 check exits 0 on the base world', cap('cli'), async () => {
    const r = await runCli(['check', await worldDir()]);
    assert.equal(r.code, 0, show(r));
  });

  it('G-56 check on a broken reference exits non-zero and prints code, path, expected, found and hint', cap('cli'), async () => {
    const r = await checkMutated('R01');
    assertFailed(r, 'R01');
    // R01: routes.get_ticket.entity = 'tickt'. expected/hint fixed text comes from ISSUES['ref.unknown'].
    // The hint lists the declared entities, and job_run appears nowhere else in the issue.
    assertIncludesAll(r, ['ref.unknown', 'routes', 'get_ticket', 'tickt', 'one of the declared', 'Known ', 'job_run'], 'R01');
  });

  it('G-56 check on a schema error exits non-zero and names the field path', cap('cli'), async () => {
    const r = await checkMutated('S20');
    assertFailed(r, 'S20');
    // S20 sets the instruction to 'do it' (found). The hint is the fixed text of ISSUES['schema.invalid'].
    assertIncludesAll(r, ['schema.invalid', 'tasks', 'pend_hd1005', 'instruction', 'do it', 'Match the shape in prod/world-format.md'], 'S20');
  });

  it('G-56 check on a failing seed exits non-zero and prints the snippet error', cap('cli'), async () => {
    const r = await checkMutated('D01');
    assertFailed(r, 'D01');
    // expected is the fixed text of ISSUES['snippet.runtime_error'], hint is the thrown message.
    assertIncludesAll(r, ['snippet.runtime_error', 'seed', 'ticket', 'the snippet runs without throwing', 'seed exploded'], 'D01');
  });

  it('G-56 G-03 a world with only warnings exits 0', cap('cli'), async () => {
    // L05 adds an action nothing calls: action.unexercised, a warning, and no other effect (RT-32).
    const r = await runCli(['check', await worldDir(mutation('L05'))]);
    assert.equal(r.code, 0, show(r));
  });

  it('G-56 G-55 check on a missing dir exits non-zero', cap('cli'), async () => {
    assertFailed(await checkMissingDir(), 'missing dir');
  });

  it('G-56 G-55 check on unparseable YAML exits non-zero', cap('cli'), async () => {
    assertFailed(await checkBadYaml(), 'bad yaml');
  });

  it('G-56 check failures print no Node stack trace, and a missing dir is named', opts(cap('cli')), async () => {
    const cases: readonly (readonly [string, CliResult])[] = [
      ['R01', await checkMutated('R01')],
      ['S20', await checkMutated('S20')],
      ['D01', await checkMutated('D01')],
      ['missing dir', await checkMissingDir()],
      ['bad yaml', await checkBadYaml()],
    ];
    for (const [label, r] of cases) assert.doesNotMatch(out(r), STACK, `${label}: printed a stack trace\n${show(r)}`);
    const missing = await checkMissingDir();
    assert.ok(out(missing).includes('no-such-world') || out(missing).includes('world.yaml'), show(missing));
  });
});

describe('world CLI argument errors (RT-97)', () => {
  it('G-56 an unknown subcommand exits non-zero and names it or prints usage', opts(cap('cli')), async () => {
    const r = await runCli(['frobnicate', await worldDir()]);
    assertFailed(r, 'unknown subcommand');
    assert.doesNotMatch(out(r), STACK, show(r));
    assert.ok(out(r).includes('frobnicate') || /usage/i.test(out(r)), show(r));
  });

  it('G-56 no arguments and check without a dir print usage, never a stack trace', opts(cap('cli')), async () => {
    for (const args of [[], ['check']]) {
      const r = await runCli(args);
      assert.equal(r.timedOut, false, show(r));
      assert.ok(out(r).trim().length > 0, `${JSON.stringify(args)} printed nothing`);
      assert.doesNotMatch(out(r), STACK, `${JSON.stringify(args)}\n${show(r)}`);
    }
  });
});

describe('world verify (G-57)', () => {
  const noopHalf = (): Promise<CliResult> =>
    once('verify GR-noop-half', async () => ['verify', await worldDir(mutation('GR-noop-half'))], 120_000);

  it('G-57 verify exits 0 on the base world and names every task', cap('cli'), async () => {
    const r = await runCli(['verify', await worldDir()], { timeoutMs: 120_000 });
    assert.equal(r.code, 0, show(r));
    assertIncludesAll(r, [...TASK_IDS], 'verify');
    // G-57 prints the scores: every solution 1, every noop 0, and decoys below 1. Two decoys
    // score exactly 0.5 (pend_open_urgent first page, escalate_unassigned no assign).
    const text = out(r);
    assert.match(text, standalone(1), `no solution score 1\n${show(r)}`);
    assert.match(text, standalone(0), `no noop score 0\n${show(r)}`);
    assert.match(text, HALF, `no decoy score 0.5\n${show(r)}`);
  });

  it('G-57 verify exits non-zero when a grader passes on the seed', cap('cli'), async () => {
    assertFailed(await noopHalf(), 'GR-noop-half');
  });

  it('G-57 a failing verify names the task and the issue code', opts(cap('cli')), async () => {
    const r = await noopHalf();
    assertIncludesAll(r, ['pend_hd1005', 'task.noop_not_zero'], 'GR-noop-half');
  });
});

describe('world grade --state (G-58)', () => {
  it('G-58 grade --state prints 1 for the solution end state and 0 for the seed', cap('cli', 'runtime.call', 'runtime.dump'), async () => {
    const dir = await worldDir();
    const d = await scratch();
    const solved = freshRuntime();
    assert.equal(solved.call({ method: 'PATCH', path: '/tickets/tkt_0005', query: {}, body: { status: 'pending' } }).status, 200);
    const endPath = join(d, 'end.json');
    const seedPath = join(d, 'seed.json');
    await writeFile(endPath, JSON.stringify(solved.dump()));
    await writeFile(seedPath, JSON.stringify(freshRuntime().dump()));

    const one = await runCli(['grade', dir, 'pend_hd1005', '--state', endPath]);
    assert.equal(one.code, 0, show(one));
    assert.match(one.stdout, standalone(1), show(one));

    const zero = await runCli(['grade', dir, 'pend_hd1005', '--state', seedPath]);
    assert.equal(zero.code, 0, show(zero));
    assert.match(zero.stdout, standalone(0), show(zero));
  });

  it('G-58 grade --state grades the named task on the given state, including fractions', cap('cli', 'runtime.call', 'runtime.dump'), async () => {
    const dir = await worldDir();
    const d = await scratch();
    // tkt_0001 is one of the two open urgent tickets: pend_open_urgent scores 1/2.
    const half = freshRuntime();
    assert.equal(half.call({ method: 'PATCH', path: '/tickets/tkt_0001', query: {}, body: { status: 'pending' } }).status, 200);
    const halfPath = join(d, 'half.json');
    await writeFile(halfPath, JSON.stringify(half.dump()));
    // The pend_hd1005 solution touches tkt_0005, outside pend_open_urgent's targets: that grader gives 0.
    const easy = freshRuntime();
    assert.equal(easy.call({ method: 'PATCH', path: '/tickets/tkt_0005', query: {}, body: { status: 'pending' } }).status, 200);
    const easyPath = join(d, 'easy.json');
    await writeFile(easyPath, JSON.stringify(easy.dump()));

    const r1 = await runCli(['grade', dir, 'pend_open_urgent', '--state', halfPath]);
    assert.equal(r1.code, 0, show(r1));
    assert.match(r1.stdout, HALF, show(r1));

    const r2 = await runCli(['grade', dir, 'pend_open_urgent', '--state', easyPath]);
    assert.equal(r2.code, 0, show(r2));
    assert.match(r2.stdout, standalone(0), show(r2));
  });

  it('G-58 grade of an unknown task exits non-zero', opts(cap('cli', 'runtime.dump')), async () => {
    const dir = await worldDir();
    const statePath = join(await scratch(), 'seed.json');
    await writeFile(statePath, JSON.stringify(freshRuntime().dump()));
    assertFailed(await runCli(['grade', dir, 'no_such_task', '--state', statePath]), 'unknown task');
  });

  it('G-58 grade with a missing, unparseable or wrong-shaped state file exits non-zero without a stack trace', opts(cap('cli')), async () => {
    const dir = await worldDir();
    const d = await scratch();
    const garbage = join(d, 'garbage.json');
    const wrongShape = join(d, 'wrong.json');
    await writeFile(garbage, '{"now": ');
    await writeFile(wrongShape, JSON.stringify({ now: 'yesterday', tables: 'none' }));
    for (const [label, path] of [['missing', join(d, 'absent.json')], ['garbage', garbage], ['wrong shape', wrongShape]] as const) {
      const r = await runCli(['grade', dir, 'pend_hd1005', '--state', path]);
      assertFailed(r, `state ${label}`);
      assert.doesNotMatch(out(r), STACK, `state ${label}\n${show(r)}`);
    }
  });
});
