import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { parse as parseYaml } from 'yaml';
import {
  caseLayout,
  inputPaths,
  parseEventLog,
  parseSuite,
  readCaseFile,
  renderSummary,
  resolveInput,
  runCase,
  selectByTag,
  selectCases,
  summarizeCase,
  summarizePhase,
  type CaseDeps,
  type CaseRecord,
  type PhaseInput,
  type PhaseName,
  type Suite,
} from '../src/worldgen/eval.ts';
import { issue, type CheckIssue } from '../src/engine/issues.ts';
import type { RunEvent } from '../src/worldgen/events.ts';
import { inputSchema } from '../src/worldgen/input.ts';
import type { Job } from '../src/worldgen/run.ts';
import type { StepId } from '../src/worldgen/stages.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '..');
const REPO_DIR = path.resolve(CODE_DIR, '..');
const SUITE_FILE = path.join(REPO_DIR, 'eval', 'suite.yaml');
const LIVE_SUITE_FILE = path.join(REPO_DIR, 'eval', 'live-segment.yaml');
const CLI = path.join('src', 'cli', 'eval.ts');

function suite(): Suite {
  const r = parseSuite(readFileSync(SUITE_FILE, 'utf8'));
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  return r.suite;
}

function cli(args: readonly string[], env: NodeJS.ProcessEnv = process.env): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', ['--import', 'tsx', CLI, ...args], { cwd: CODE_DIR, encoding: 'utf8', env });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

async function tempSuite(text: string): Promise<{ dir: string; file: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-suite-'));
  const file = path.join(dir, 'suite.yaml');
  await writeFile(file, text);
  return { dir, file };
}

const AT = { at: '2026-10-06T10:00:00.000Z', runId: 'r1' } as const;
const USAGE = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0 } as const;

const started = (step: StepId): RunEvent => ({ ...AT, t: 'step_started', step, reason: 'planned' });
const finishedStep = (step: StepId, attempts: number): RunEvent => ({ ...AT, t: 'step_finished', step, attempts, ms: 1, costUsd: 0 });
const attempt = (step: StepId, n: number, ms: number, costUsd: number, accepted: boolean): RunEvent => ({
  ...AT,
  t: 'attempt',
  step,
  n,
  ms,
  usage: USAGE,
  costUsd,
  outcome: accepted ? { kind: 'accepted', warnings: 0 } : { kind: 'rejected', issues: [] },
  dump: '',
});
const rejected = (step: StepId, n: number, issues: readonly CheckIssue[]): RunEvent => ({
  ...AT,
  t: 'attempt',
  step,
  n,
  ms: 100,
  usage: USAGE,
  costUsd: 0.01,
  outcome: { kind: 'rejected', issues },
  dump: '',
});
const done = (ms: number, costUsd: number): RunEvent => ({ ...AT, t: 'run_finished', ms, costUsd, worldWritten: true, result: { kind: 'done', worldDir: '/w' } });

function phase(name: PhaseName, result: 'done' | 'stopped' | null, error: string | null, lines: readonly (RunEvent | string)[]): PhaseInput {
  const text = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n');
  return { phase: name, result, error, log: parseEventLog(text === '' ? '' : `${text}\n`) };
}

describe('eval/suite.yaml', () => {
  const REQUIRED = [
    'helpdesk-sla',
    'bakery-vague',
    'video-codec-impossible',
    'library-holds',
    'billing-dunning',
    'todo-projects',
    'clinic-appointments',
    'stripe-refunds',
    'petstore-store',
    'orders-csv',
    'helpdesk-add-refunds',
    'stripe-partial-refunds',
  ];

  it('parses with the suite schema', () => {
    assert.deepEqual(parseSuite(readFileSync(SUITE_FILE, 'utf8')).ok, true);
    assert.equal(suite().name, 'stress');
  });

  it('parses every case input with inputSchema from input.ts', () => {
    const raw = parseYaml(readFileSync(SUITE_FILE, 'utf8')) as { cases: { id: string; input: unknown }[] };
    const invalid = raw.cases.filter((c) => !inputSchema.safeParse(c.input).success).map((c) => c.id);
    assert.deepEqual(invalid, []);
  });

  it('has at least 12 cases, including every required id', () => {
    const ids = suite().cases.map((c) => c.id);
    assert.equal(ids.length >= 12, true);
    assert.deepEqual(REQUIRED.filter((id) => !ids.includes(id)), []);
  });

  it('tags every case, and the stopped cases are exactly the impossible ones', () => {
    const cases = suite().cases;
    assert.deepEqual(cases.filter((c) => (c.tags ?? []).length === 0).map((c) => c.id), []);
    assert.deepEqual(cases.filter((c) => c.tags?.includes('impossible')).map((c) => c.id), cases.filter((c) => c.expect === 'stopped').map((c) => c.id));
    const cheap = selectByTag(cases, ['cheap']);
    assert.deepEqual(cheap.ok ? cheap.cases.map((c) => c.id) : cheap.unknown, ['video-codec-impossible', 'stripe-refunds', 'petstore-store', 'orders-csv', 'repair-desk', 'course-enrollments-csv', 'shipments-csv', 'stripe-customers', 'forecast-impossible', 'live-market-feed-impossible']);
  });

  it('has unique lowercase kebab-case ids', () => {
    const ids = suite().cases.map((c) => c.id);
    assert.deepEqual(ids.filter((id) => !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)), []);
    assert.equal(new Set(ids).size, ids.length);
  });

  it('gives the backlog prompts verbatim and marks the impossible one as an expected stop', () => {
    const byId = new Map(suite().cases.map((c) => [c.id, c]));
    assert.deepEqual(byId.get('helpdesk-sla')?.input, { kind: 'description', text: 'A helpdesk with SLA tiers and on-call escalation' });
    assert.deepEqual(byId.get('bakery-vague')?.input, { kind: 'description', text: 'An app for a bakery' });
    assert.deepEqual(byId.get('video-codec-impossible')?.input, { kind: 'description', text: 'A real-time video codec' });
    assert.equal(byId.get('video-codec-impossible')?.expect, 'stopped');
    assert.deepEqual(suite().cases.filter((c) => c.expect === 'stopped').map((c) => c.id), ['video-codec-impossible', 'forecast-impossible', 'live-market-feed-impossible']);
  });

  it('points the OpenAPI and CSV cases at the eval inputs', () => {
    const byId = new Map(suite().cases.map((c) => [c.id, c]));
    assert.deepEqual(byId.get('stripe-refunds')?.input, { kind: 'openapi', path: 'inputs/stripe.openapi.yaml', only: ['/v1/refunds'] });
    assert.deepEqual(byId.get('petstore-store')?.input, { kind: 'openapi', path: 'inputs/petstore.openapi.yaml', only: ['/store'] });
    assert.deepEqual(byId.get('orders-csv')?.input, { kind: 'csv', paths: ['inputs/orders.csv', 'inputs/customers.csv'] });
    assert.deepEqual(byId.get('stripe-partial-refunds')?.input, {
      kind: 'openapi',
      path: 'inputs/stripe.openapi.yaml',
      only: ['/v1/charges', '/v1/refunds'],
    });
  });

  it('keeps the live segment in its own suite, one case per input kind, sharing no id or input with suite.yaml', () => {
    const r = parseSuite(readFileSync(LIVE_SUITE_FILE, 'utf8'));
    assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
    assert.deepEqual(r.suite.cases.map((c) => `${c.id} ${c.input.kind}`), ['box-office description', 'giftcards-openapi openapi', 'gym-bookings-csv csv']);
    const main = suite().cases;
    assert.deepEqual(r.suite.cases.filter((c) => main.some((m) => m.id === c.id || JSON.stringify(m.input) === JSON.stringify(c.input))).map((c) => c.id), []);
  });

  it('has a change request on exactly the three iterate cases', () => {
    assert.deepEqual(suite().cases.filter((c) => c.change !== undefined).map((c) => c.id), ['helpdesk-add-refunds', 'stripe-partial-refunds', 'petstore-add-refunds']);
  });

  describe('input files exist', () => {
    /** Written on the eval-inputs branch. Until it merges these are skipped, not failed. */
    const PENDING = new Set(['eval/inputs/stripe.openapi.yaml', 'eval/inputs/petstore.openapi.yaml', 'eval/inputs/orders.csv', 'eval/inputs/customers.csv']);
    const files = [...new Set(suite().cases.flatMap((c) => inputPaths(c.input)))];

    it('names exactly the eight eval input files', () => {
      assert.deepEqual(
        files.map((f) => path.relative(REPO_DIR, path.resolve(path.dirname(SUITE_FILE), f))).sort(),
        ['eval/inputs/courses.csv', 'eval/inputs/customers.csv', 'eval/inputs/enrollments.csv', 'eval/inputs/linear-backlog.csv', 'eval/inputs/orders.csv', 'eval/inputs/petstore.openapi.yaml', 'eval/inputs/shipments.csv', 'eval/inputs/stripe.openapi.yaml'],
      );
    });

    for (const f of files) {
      const rel = path.relative(REPO_DIR, path.resolve(path.dirname(SUITE_FILE), f));
      it(`${rel} exists`, (t) => {
        const exists = existsSync(path.join(REPO_DIR, rel));
        if (!exists && PENDING.has(rel)) {
          t.skip(`${rel} lands with the eval-inputs unit`);
          return;
        }
        assert.equal(exists, true);
      });
    }
  });
});

describe('parseSuite', () => {
  it('reports a duplicate id at its path', () => {
    const r = parseSuite(['name: s', 'cases:', '  - { id: a, input: { kind: description, text: x } }', '  - { id: a, input: { kind: description, text: y } }'].join('\n'));
    assert.deepEqual(r, { ok: false, errors: ['cases.1.id: duplicate case id "a"'] });
  });

  it('rejects an id that is not kebab-case', () => {
    const r = parseSuite('name: s\ncases:\n  - { id: Helpdesk_SLA, input: { kind: description, text: x } }\n');
    assert.deepEqual(r, { ok: false, errors: ['cases.0.id: must be lowercase kebab-case, such as helpdesk-sla'] });
  });

  it('rejects an unknown case key, so a typo in change does not drop the change', () => {
    const r = parseSuite('name: s\ncases:\n  - { id: a, input: { kind: description, text: x }, chnage: more }\n');
    assert.deepEqual(r, { ok: false, errors: ['cases.0: Unrecognized key: "chnage"'] });
  });

  it('rejects an input kind inputSchema does not know', () => {
    const r = parseSuite('name: s\ncases:\n  - { id: a, input: { kind: graphql, path: x } }\n');
    assert.deepEqual(r, { ok: false, errors: ["cases.0.input.kind: Invalid discriminator value. Expected 'description' | 'openapi' | 'csv'"] });
  });

  it('rejects an empty change request', () => {
    const r = parseSuite('name: s\ncases:\n  - { id: a, input: { kind: description, text: x }, change: "  " }\n');
    assert.deepEqual(r, { ok: false, errors: ['cases.0.change: Too small: expected string to have >=1 characters'] });
  });

  it('reports YAML syntax errors without throwing', () => {
    const r = parseSuite('name: s\ncases: [\n');
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.errors.length === 1 && r.errors[0]!.startsWith('not valid YAML: '), true);
  });

  it('defaults expect to done and keeps the optional fields', () => {
    const r = parseSuite('name: s\ncases:\n  - { id: a, input: { kind: csv, paths: [x.csv] }, change: add y, note: n }\n');
    assert.deepEqual(r, {
      ok: true,
      suite: { name: 's', cases: [{ id: 'a', input: { kind: 'csv', paths: ['x.csv'] }, change: 'add y', expect: 'done', note: 'n' }] },
    });
  });
});

describe('selectCases', () => {
  const s: Suite = {
    name: 's',
    cases: ['a', 'b', 'c'].map((id) => ({ id, input: { kind: 'description' as const, text: id }, expect: 'done' as const })),
  };

  it('selects every case for null and keeps suite order for --only', () => {
    assert.deepEqual(selectCases(s, null), { ok: true, cases: s.cases });
    const r = selectCases(s, ['c', 'a']);
    assert.deepEqual(r.ok ? r.cases.map((c) => c.id) : r.unknown, ['a', 'c']);
  });

  it('names unknown ids', () => {
    assert.deepEqual(selectCases(s, ['a', 'nope', 'zz']), { ok: false, unknown: ['nope', 'zz'] });
  });
});

describe('selectByTag', () => {
  const tagged = (id: string, tags?: string[]) => ({ id, input: { kind: 'description' as const, text: id }, expect: 'done' as const, ...(tags === undefined ? {} : { tags }) });
  const cases = [tagged('a', ['cheap', 'csv']), tagged('b'), tagged('c', ['csv']), tagged('d', ['cheap'])];

  it('keeps suite order and takes a case that carries any named tag', () => {
    const r = selectByTag(cases, ['csv']);
    assert.deepEqual(r.ok ? r.cases.map((c) => c.id) : r.unknown, ['a', 'c']);
    const both = selectByTag(cases, ['cheap', 'csv']);
    assert.deepEqual(both.ok ? both.cases.map((c) => c.id) : both.unknown, ['a', 'c', 'd']);
  });

  it('names a tag no case carries', () => {
    assert.deepEqual(selectByTag(cases, ['cheap', 'nope']), { ok: false, unknown: ['nope'] });
  });
});

describe('input paths', () => {
  it('lists the files each input kind reads', () => {
    assert.deepEqual(inputPaths({ kind: 'description', text: 'x' }), []);
    assert.deepEqual(inputPaths({ kind: 'openapi', path: 'inputs/a.yaml', only: [] }), ['inputs/a.yaml']);
    assert.deepEqual(inputPaths({ kind: 'csv', paths: ['inputs/a.csv', 'inputs/b.csv'] }), ['inputs/a.csv', 'inputs/b.csv']);
  });

  it('resolves paths against the suite directory and leaves a description alone', () => {
    assert.deepEqual(resolveInput({ kind: 'openapi', path: 'inputs/a.yaml', only: ['/v1'] }, '/repo/eval'), {
      kind: 'openapi',
      path: '/repo/eval/inputs/a.yaml',
      only: ['/v1'],
    });
    assert.deepEqual(resolveInput({ kind: 'csv', paths: ['inputs/a.csv', '/abs/b.csv'], note: 'n' }, '/repo/eval'), {
      kind: 'csv',
      paths: ['/repo/eval/inputs/a.csv', '/abs/b.csv'],
      note: 'n',
    });
    assert.deepEqual(resolveInput({ kind: 'description', text: 'x' }, '/repo/eval'), { kind: 'description', text: 'x' });
  });

  it('lays a case out under the run directory', () => {
    assert.deepEqual(caseLayout('/runs/2026-10-06-stress', 'orders-csv'), {
      dir: '/runs/2026-10-06-stress/orders-csv',
      world: '/runs/2026-10-06-stress/orders-csv/world',
      caseFile: '/runs/2026-10-06-stress/orders-csv/case.json',
      logDir: { create: '/runs/2026-10-06-stress/orders-csv', change: '/runs/2026-10-06-stress/orders-csv/change' },
      events: {
        create: '/runs/2026-10-06-stress/orders-csv/events.jsonl',
        change: '/runs/2026-10-06-stress/orders-csv/change/events.jsonl',
      },
    });
  });
});

describe('runCase', () => {
  const layout = caseLayout('/runs/r', 'c');
  const base = { input: { kind: 'csv' as const, paths: ['inputs/o.csv'] }, expect: 'done' as const };

  function fake(results: readonly ('done' | 'stopped' | Error)[], verify: CaseDeps['verify'] = async () => ({ kind: 'pass', tasks: 2 })) {
    const calls: { job: Job; phase: PhaseName }[] = [];
    const verified: string[] = [];
    const deps: CaseDeps = {
      run: async (job, phase) => {
        calls.push({ job, phase });
        const r = results[calls.length - 1];
        if (r === undefined) throw new Error('unexpected call');
        if (r instanceof Error) throw r;
        return { kind: r, dir: `/out/${calls.length}` };
      },
      verify: async (dir) => {
        verified.push(dir);
        return verify(dir);
      },
    };
    return { deps, calls, verified };
  }

  it('creates, then runs the change on the saved world, then verifies the changed world', async () => {
    const f = fake(['done', 'done']);
    const file = await runCase({ id: 'c', ...base, change: 'add refunds' }, '/repo/eval', layout, f.deps);
    assert.deepEqual(f.calls, [
      { phase: 'create', job: { kind: 'create', input: { kind: 'csv', paths: ['/repo/eval/inputs/o.csv'] }, outDir: '/runs/r/c/world' } },
      { phase: 'change', job: { kind: 'iterate', worldDir: '/out/1', request: 'add refunds' } },
    ]);
    assert.deepEqual(f.verified, ['/out/2']);
    assert.deepEqual(file, {
      id: 'c',
      expect: 'done',
      phases: [
        { phase: 'create', result: 'done', error: null },
        { phase: 'change', result: 'done', error: null },
      ],
      verify: { kind: 'pass', tasks: 2 },
    });
  });

  it('skips the change and verify when create stops', async () => {
    const f = fake(['stopped']);
    const file = await runCase({ id: 'c', ...base, change: 'add refunds' }, '/repo/eval', layout, f.deps);
    assert.equal(f.calls.length, 1);
    assert.deepEqual(f.verified, []);
    assert.deepEqual(file.phases, [{ phase: 'create', result: 'stopped', error: null }]);
    assert.deepEqual(file.verify, { kind: 'not_run' });
  });

  it('records a thrown run as an error and does not throw', async () => {
    const f = fake([new Error('not implemented')]);
    const file = await runCase({ id: 'c', ...base }, '/repo/eval', layout, f.deps);
    assert.deepEqual(file, { id: 'c', expect: 'done', phases: [{ phase: 'create', result: null, error: 'not implemented' }], verify: { kind: 'not_run' } });
  });

  it('records a thrown verify as a failed verify', async () => {
    const f = fake(['done'], async () => {
      throw new Error('disk gone');
    });
    const file = await runCase({ id: 'c', ...base }, '/repo/eval', layout, f.deps);
    assert.deepEqual(file.verify, { kind: 'fail', codes: ['verify threw: disk gone'] });
  });
});

describe('case.json', () => {
  it('reads back what runCase writes', () => {
    const file = { id: 'c', expect: 'stopped', phases: [{ phase: 'create', result: 'stopped', error: null }], verify: { kind: 'not_run' } };
    assert.deepEqual(readCaseFile(JSON.stringify(file)), { ok: true, file });
  });

  it('says why a file does not read', () => {
    assert.deepEqual(readCaseFile('{"id":"c","expect":"maybe","phases":[],"verify":{"kind":"not_run"}}'), {
      ok: false,
      why: 'expect: Invalid option: expected one of "done"|"stopped"; phases: Too small: expected array to have >=1 items',
    });
    assert.equal(readCaseFile('{').ok, false);
  });
});

describe('events.jsonl reading', () => {
  it('skips event types the scorecard does not read and flags broken lines', () => {
    const advice: RunEvent = { ...AT, t: 'advice', step: 'plan', text: 'hi' };
    const log = parseEventLog([JSON.stringify(advice), '{"no":"type"}', 'oops', JSON.stringify(started('plan')), ''].join('\n'));
    assert.deepEqual(log, { events: [{ t: 'step_started', step: 'plan' }], problems: ['line 2 has no event type', 'line 3 is not JSON'] });
  });

  it('flags an attempt whose ms is not a number', () => {
    const log = parseEventLog('{"t":"attempt","step":"plan","ms":"12","costUsd":0.1}\n');
    assert.deepEqual(log, { events: [], problems: ['line 1: attempt ms Invalid input: expected number, received string'] });
  });

  it('flags a run that returned without logging run_finished, and a log that disagrees with the result', () => {
    const silent = summarizePhase(phase('create', 'done', null, [started('plan'), attempt('plan', 1, 100, 0.01, true)]));
    assert.deepEqual(silent.logProblems, ['no run_finished event']);
    assert.equal(silent.status, 'done');
    assert.equal(silent.ms, 100);
    const disagree = summarizePhase(phase('create', 'stopped', null, [done(10, 0)]));
    assert.deepEqual(disagree.logProblems, ['run_finished says done but runWorldGen returned stopped']);
  });
});

describe('renderSummary on literal events', () => {
  const meta = { run: '2026-10-06-stress', suite: 'stress', model: 'claude-sonnet-5-5', budgetUsd: 5, maxMinutes: 15 };
  it('counts a cancelled call and preserves unresolved billing in its row and total', () => {
    const p = phase('create', 'stopped', null, [
      started('plan'),
      { ...AT, t: 'call_cancelled', step: 'plan', ms: 902000, costUsd: null },
      { ...AT, t: 'run_finished', ms: 902000, costUsd: 0, unknownCostCalls: 1, worldWritten: false,
        result: { kind: 'stopped', reason: { kind: 'time_exhausted', minutes: 15 } } },
    ]);
    assert.deepEqual(summarizePhase(p).attempts, [['plan', 1]]);
    assert.equal(summarizePhase(p).unknownCostCalls, 1);
    assert.deepEqual(summarizePhase(p).logProblems, ['1 cancelled call(s) have unknown cost; totals include known cost only']);
    const text = renderSummary(meta, [{ kind: 'record', record: { id: 'cancelled', expect: 'done', phases: [p], verify: { kind: 'not_run' } } }]);
    assert.equal(text.includes('| plan 1 | 15.0 | 0.00 + unknown |'), true);
    assert.equal(text.includes('15.0 min (1 of 1 cases); $0.00 (1 of 1 cases) + unknown billing for 1 call(s); 1 unlogged.'), true);
  });

  it('accounts for a cancelled receipt even when run_finished is missing', () => {
    const p = summarizePhase(phase('create', 'stopped', null, [
      started('plan'), { ...AT, t: 'call_cancelled', step: 'plan', ms: 900000, costUsd: 0.25 },
    ]));
    assert.equal(p.costUsd, 0.25);
    assert.equal(p.unknownCostCalls, 0);
    assert.deepEqual(p.attempts, [['plan', 1]]);
    assert.deepEqual(p.logProblems, ['no run_finished event']);
  });
  const records: CaseRecord[] = [
    {
      id: 'helpdesk-sla',
      expect: 'done',
      phases: [
        phase('create', 'done', null, [
          { ...AT, t: 'run_started', mode: 'create', input: 'description', model: 'claude-sonnet-5-5', budgetUsd: 5 },
          started('plan'),
          attempt('plan', 1, 30000, 0.25, true),
          finishedStep('plan', 1),
          started('model'),
          attempt('model', 1, 20000, 0.2, false),
          attempt('model', 2, 25000, 0.25, true),
          { ...AT, t: 'advice', step: 'model', text: 'consider a priority field' },
          finishedStep('model', 2),
          done(90000, 0.75),
        ]),
      ],
      verify: { kind: 'pass', tasks: 3 },
    },
    {
      id: 'video-codec-impossible',
      expect: 'stopped',
      phases: [
        phase('create', 'stopped', null, [
          started('plan'),
          attempt('plan', 1, 6000, 0.05, false),
          {
            ...AT,
            t: 'run_finished',
            ms: 6000,
            costUsd: 0.05,
            worldWritten: false,
            result: { kind: 'stopped', reason: { kind: 'attempts_exhausted', step: 'plan', attempts: 1, lastIssues: [] } },
          },
        ]),
      ],
      verify: { kind: 'not_run' },
    },
    {
      id: 'helpdesk-add-refunds',
      expect: 'done',
      phases: [
        phase('create', 'done', null, [started('plan'), attempt('plan', 1, 60000, 1, true), done(60000, 1)]),
        phase('change', 'stopped', null, [
          started('model'),
          attempt('model', 1, 30000, 0.5, false),
          JSON.stringify({ ...AT, t: 'attempt', step: 'model', n: 2, ms: 30000, usage: USAGE, outcome: { kind: 'rejected', issues: [] }, dump: '' }),
          {
            ...AT,
            t: 'run_finished',
            ms: 60000,
            costUsd: 1.25,
            worldWritten: false,
            result: { kind: 'stopped', reason: { kind: 'no_progress', step: 'model', repeatedIssueSet: 'ref.unknown', lastIssues: [] } },
          },
        ]),
      ],
      verify: { kind: 'not_run' },
    },
    { id: 'orders-csv', expect: 'done', phases: [phase('create', null, 'not implemented', [])], verify: { kind: 'not_run' } },
    {
      id: 'bakery-vague',
      expect: 'done',
      phases: [phase('create', 'done', null, [started('plan'), attempt('plan', 1, 12000, 0.1, true), started('workflow'), 'garbage {', done(30000, 0.3)])],
      verify: { kind: 'fail', codes: ['task.noop_nonzero'] },
    },
  ];

  it('renders one row per case, totals, pass rate, and why each case is unlogged or crashed', () => {
    assert.equal(
      renderSummary(meta, records.map((record) => ({ kind: 'record' as const, record }))),
      [
        '# Eval run 2026-10-06-stress',
        '',
        'Suite `stress`, model `claude-sonnet-5-5`, budget $5.00 and 15 min per run.',
        '',
        '| case | expect | result | stop reason | attempts per step | min | $ | verify | log | pass |',
        '|---|---|---|---|---|--:|--:|---|---|---|',
        '| helpdesk-sla | done | done | - | plan 1, model 2 | 1.5 | 0.75 | pass (3 tasks) | ok | yes |',
        '| video-codec-impossible | stopped | stopped | attempts_exhausted at plan | plan 1 | 0.1 | 0.05 | - | ok | yes |',
        '| helpdesk-add-refunds | done | stopped | change: no_progress at model | plan 1; change: model 2 | 2.0 | 2.25 | - | unlogged | no |',
        '| orders-csv | done | crashed | crashed: not implemented | - | unknown | unknown | - | ok | no |',
        '| bakery-vague | done | done | - | plan 1 | 0.5 | 0.30 | fail: task.noop_nonzero | unlogged | no |',
        '',
        '**Totals:** 5 expected cases: 1 success, 1 expected refusal, 2 product failure, 1 infra failure, 0 not run; 4.1 min (4 of 5 cases); $3.35 (4 of 5 cases); 2 unlogged.',
        '',
        '**Median and p95:** 0.5 min (4 of 5 cases) and 2.0 min (4 of 5 cases); $0.30 (4 of 5 cases) and $2.25 (4 of 5 cases).',
        '',
        '**Pass rate:** 2/5 (40%), success and expected refusal over all 5 expected cases (0 not run).',
        '',
        '## Unlogged',
        '',
        '- `helpdesk-add-refunds` change: model attempt 2 has no costUsd',
        '- `bakery-vague` create: line 4 is not JSON',
        '- `bakery-vague` create: workflow ran but logged no attempt',
        '',
        '## Errors',
        '',
        '- `orders-csv` create: not implemented',
        '',
      ].join('\n'),
    );
  });

  it('renders the top five issue codes by frequency with deterministic ties and catalog hints', () => {
    const ref = issue('ref.unknown', ['entities', 'ticket'], { kind: 'entity', name: 'agent', known: ['ticket'] }, 'agent');
    const badPath = issue('route.bad_path', ['routes', 'list', 'path'], { problem: 'path must start with /' }, 'tickets');
    const quota = issue('snippet.call_quota', ['tasks', 't'], { limit: 2 }, '3 calls');
    const uncovered = issue('plan.not_covered', ['routes', 'GET /x'], { item: 'route "x"' }, 'missing');
    const noop = issue('task.noop_not_zero', ['tasks', 't'], { score: 0.5 }, '0.5');
    const few = issue('world.too_few_tasks', ['tasks'], { have: 1 }, '1');

    const issues = [ref, ref, ref, badPath, badPath, quota, quota, uncovered, noop, few];
    const r: CaseRecord = {
      id: 'triage',
      expect: 'stopped',
      phases: [
        phase('create', 'stopped', null, [
          started('model'),
          rejected('model', 1, issues),
          {
            ...AT,
            t: 'run_finished',
            ms: 100,
            costUsd: 0.01,
            worldWritten: false,
            result: { kind: 'stopped', reason: { kind: 'attempts_exhausted', step: 'model', attempts: 1, lastIssues: issues } },
          },
        ]),
      ],
      verify: { kind: 'not_run' },
    };
    const summary = renderSummary(meta, [{ kind: 'record', record: r }]);
    const triage = summary.split('## Triage\n\n')[1];
    assert.equal(
      triage,
      [
        '| rank | issue code | count | generic fix |',
        '|--:|---|--:|---|',
        '| 1 | ref.unknown | 3 | Known entity names: ticket. |',
        '| 2 | route.bad_path | 2 | path must start with / |',
        '| 3 | snippet.call_quota | 2 | Look for a loop that never ends or lists inside a loop. |',
        '| 4 | plan.not_covered | 1 | Build what the plan says, or change the plan in the plan step. |',
        '| 5 | task.noop_not_zero | 1 | The grader passes on the seed. Grade the change, not the start state. |',
        '',
      ].join('\n'),
    );
  });

  it('does not pass an expected stop that was a model error', () => {
    const r: CaseRecord = {
      id: 'x',
      expect: 'stopped',
      phases: [
        phase('create', 'stopped', null, [
          { ...AT, t: 'run_finished', ms: 1000, costUsd: 0, worldWritten: false, result: { kind: 'stopped', reason: { kind: 'model_error', message: '529 overloaded' } } },
        ]),
      ],
      verify: { kind: 'not_run' },
    };
    assert.equal(renderSummary(meta, [{ kind: 'record', record: r }]).split('\n')[6], '| x | stopped | stopped | model_error | - | 0.0 | 0.00 | - | ok | no |');
  });

  it('does not pass an expected stop when the engine could not judge the world', () => {
    const r: CaseRecord = {
      id: 'x',
      expect: 'stopped',
      phases: [
        phase('create', 'stopped', null, [
          { ...AT, t: 'run_finished', ms: 1000, costUsd: 0.25, worldWritten: false, result: { kind: 'stopped', reason: { kind: 'judge_error', step: 'model', message: 'runtime seeding failed' } } },
        ]),
      ],
      verify: { kind: 'not_run' },
    };
    assert.equal(summarizeCase(r).pass, false);
    assert.equal(renderSummary(meta, [{ kind: 'record', record: r }]).split('\n')[6], '| x | stopped | stopped | judge_error at model | - | 0.0 | 0.25 | - | ok | no |');
  });

  it('does not pass an expected stop that was a stalled claude CLI', () => {
    const r: CaseRecord = {
      id: 'x',
      expect: 'stopped',
      phases: [
        phase('create', 'stopped', null, [
          { ...AT, t: 'run_finished', ms: 1000, costUsd: 0, worldWritten: false, result: { kind: 'stopped', reason: { kind: 'transport_stalled', step: 'plan', idleMs: 120_000 } } },
        ]),
      ],
      verify: { kind: 'not_run' },
    };
    assert.equal(renderSummary(meta, [{ kind: 'record', record: r }]).split('\n')[6], '| x | stopped | stopped | transport_stalled at plan | - | 0.0 | 0.00 | - | ok | no |');
  });

  it('escapes pipes and newlines inside a cell', () => {
    const r: CaseRecord = { id: 'x', expect: 'done', phases: [phase('create', null, 'a | b\nc', [])], verify: { kind: 'not_run' } };
    const lines = renderSummary(meta, [{ kind: 'record', record: r }]).split('\n');
    assert.equal(lines[6], '| x | done | crashed | crashed: a \\| b | - | unknown | unknown | - | ok | no |');
    assert.equal(lines.at(-2), '- `x` create: a \\| b c');
  });

  it('renders an empty run without a percentage', () => {
    assert.equal(renderSummary(meta, []).split('\n')[11], '**Pass rate:** 0/0, success and expected refusal over all 0 expected cases (0 not run).');
  });

  it('counts every case in one of five outcome classes, and passes only a success or an expected refusal (A-336)', () => {
    const machinery: CaseRecord = {
      id: 'stopped-by-overload',
      expect: 'stopped',
      phases: [
        phase('create', 'stopped', null, [
          { ...AT, t: 'run_finished', ms: 1000, costUsd: 0, worldWritten: false, result: { kind: 'stopped', reason: { kind: 'model_error', message: '529 overloaded' } } },
        ]),
      ],
      verify: { kind: 'not_run' },
    };
    const unverified: CaseRecord = { ...records[0]!, id: 'done-never-verified', verify: { kind: 'not_run' } };
    const wrongDone: CaseRecord = { ...records[0]!, id: 'impossible-but-done', expect: 'stopped' };
    assert.deepEqual(
      [...records, machinery, unverified, wrongDone].map((r) => [r.id, summarizeCase(r).outcome, summarizeCase(r).pass]),
      [
        ['helpdesk-sla', 'success', true],
        ['video-codec-impossible', 'expected refusal', true],
        ['helpdesk-add-refunds', 'product failure', false],
        ['orders-csv', 'infra failure', false],
        ['bakery-vague', 'product failure', false],
        ['stopped-by-overload', 'infra failure', false],
        ['done-never-verified', 'infra failure', false],
        ['impossible-but-done', 'product failure', false],
      ],
    );
    const lines = renderSummary(meta, [
      ...[...records, machinery].map((record) => ({ kind: 'record' as const, record })),
      { kind: 'invalid', id: 'unreadable-case', expect: 'done', why: 'not JSON' },
      { kind: 'missing', id: 'never-started', expect: 'done' },
    ]).split('\n');
    assert.equal(
      lines.find((l) => l.startsWith('**Totals:**')),
      '**Totals:** 8 expected cases: 1 success, 1 expected refusal, 2 product failure, 3 infra failure, 1 not run; 4.1 min (5 of 8 cases); $3.35 (5 of 8 cases); 2 unlogged.',
    );
    assert.equal(lines.find((l) => l.startsWith('**Pass rate:**')), '**Pass rate:** 2/8 (25%), success and expected refusal over all 8 expected cases (1 not run).');
  });
});

describe('cli: npm run eval', () => {
  it('dry-runs the description cases of the real suite with no model call and writes nothing', async () => {
    const out = path.join(await mkdtemp(path.join(tmpdir(), 'eval-out-')), 'run');
    const r = cli(['--dry-run', '--only', 'helpdesk-sla,video-codec-impossible,helpdesk-add-refunds', '--out-dir', out]);
    assert.equal(r.stderr, '');
    assert.equal(
      r.stdout,
      [
        `dry run: 3 cases from ${SUITE_FILE}, no model call`,
        'ok    helpdesk-sla (description)',
        'ok    video-codec-impossible (description)',
        'ok    helpdesk-add-refunds (description + change)',
        '3 of 3 cases ready',
        '',
      ].join('\n'),
    );
    assert.equal(r.status, 0);
    assert.equal(existsSync(out), false);
  });

  it('fails a dry run whose input file is missing', async () => {
    const s = await tempSuite('name: t\ncases:\n  - { id: a, input: { kind: description, text: x } }\n  - { id: b, input: { kind: csv, paths: [inputs/none.csv] } }\n');
    const r = cli(['--dry-run', '--suite', s.file]);
    assert.equal(
      r.stdout,
      [`dry run: 2 cases from ${s.file}, no model call`, 'ok    a (description)', 'fail  b: missing inputs/none.csv', '1 of 2 cases ready', ''].join('\n'),
    );
    assert.equal(r.status, 1);
  });

  it('exits 1 on an invalid suite and lists its errors', async () => {
    const s = await tempSuite('name: t\ncases:\n  - { id: a, input: { kind: description, text: x } }\n  - { id: a, input: { kind: description, text: y } }\n');
    const r = cli(['--dry-run', '--suite', s.file]);
    assert.equal(r.stderr, `invalid suite ${s.file}:\ncases.1.id: duplicate case id "a"\n`);
    assert.equal(r.status, 1);
  });

  const usage: readonly [string, readonly string[], string][] = [
    ['an unknown case id', ['--dry-run', '--only', 'nope'], 'unknown case id: nope'],
    ['--backend boat', ['--backend', 'boat'], '--backend boat is not available yet: boat fan-out lands with sandbox backends'],
    ['--parallel above 1 on the local backend', ['--parallel', '2'], '--parallel above 1 needs --backend boat (boat fan-out lands with sandbox backends); the local backend runs cases one at a time'],
    ['--parallel 0', ['--parallel', '0'], '--parallel needs a positive integer, got 0'],
    ['--budget-usd that is not a number', ['--budget-usd', 'five'], '--budget-usd needs a positive number, got five'],
    ['an unknown transport', ['--transport', 'carrier-pigeon'], '--transport must be one of claude-cli, sdk, got carrier-pigeon'],
    ['an unknown option', ['--fast'], 'unknown option --fast'],
    ['a flag without its value', ['--only'], '--only needs a value'],
    ['an unknown tag', ['--dry-run', '--tag', 'nope'], 'unknown tag: nope'],
    ['an unknown tag', ['--dry-run', '--tag', 'nope'], 'unknown tag: nope'],
  ];
  for (const [what, args, first] of usage) {
    it(`exits 2 on ${what}`, () => {
      const r = cli(args);
      assert.equal(r.stderr.split('\n')[0], first);
      assert.equal(r.status, 2);
    });
  }

  it('stops before writing anything when the model cannot be built', async () => {
    const out = path.join(await mkdtemp(path.join(tmpdir(), 'eval-out-')), 'run');
    const env = { ...process.env };
    delete env['LLM_KEY'];
    const r = cli(['--transport', 'sdk', '--only', 'helpdesk-sla', '--out-dir', out], env);
    assert.equal(r.stderr, '--transport sdk needs LLM_KEY set in the environment\n');
    assert.equal(r.status, 1);
    assert.equal(existsSync(out), false);
  });
});
