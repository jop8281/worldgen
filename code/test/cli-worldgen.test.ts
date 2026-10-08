import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, mock } from 'node:test';
import { checkWorld, issue, loadWorld, renderWorldYaml } from '#engine';
import { createEmitter, describeStop, type RunEvent } from '../src/worldgen/events.ts';
import { genDirName, inputSlug, type Input } from '../src/worldgen/input.ts';
import { parsePlanYaml, planSchema, renderPlanYaml, type Plan } from '../src/worldgen/plan.ts';
import { openLedger } from '../src/costs/ledger.ts';
import { capsuleSchema } from '../src/worldgen/capsule.ts';
import { partialDir } from '../src/worldgen/run.ts';
import { EDITS, PLAN } from './helpers/scripted-world.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '..');
const HELPDESK = path.resolve(CODE_DIR, '../prod/worlds/helpdesk');

type Ran = { status: number | null; stdout: string; stderr: string };

/** A scratch HOME with the spend ledger inside it, so a spawned CLI never touches the real home. */
function scratch(): { home: string; env: Record<string, string> } {
  const home = mkdtempSync(path.join(tmpdir(), 'cli-worldgen-'));
  return { home, env: { PATH: process.env['PATH'] ?? '', HOME: home, WORLDGEN_COSTS_FILE: path.join(home, 'costs.jsonl') } };
}

/** Runs the CLI with exactly `env`: no LLM_KEY unless a test adds one. A `timeoutMs` run is SIGKILLed when it outlives it. */
function worldgen(args: readonly string[], env: Record<string, string> = scratch().env, timeoutMs?: number): Ran {
  return cli('src/cli/worldgen.ts', args, env, timeoutMs);
}

function cli(entry: string, args: readonly string[], env: Record<string, string>, timeoutMs?: number): Ran {
  const limit = timeoutMs === undefined ? {} : { timeout: timeoutMs, killSignal: 'SIGKILL' as const };
  const r = spawnSync(process.execPath, ['--import', 'tsx', entry, ...args], { cwd: CODE_DIR, encoding: 'utf8', env, ...limit });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('worldgen CLI: help and usage errors', () => {
  it('--help lists every flag and exits 0', () => {
    const r = worldgen(['--help']);
    assert.equal(r.status, 0);
    assert.equal(r.stderr, '');
    for (const flag of ['--out', '--openapi', '--only', '--csv', '--world', '--model', '--transport', '--budget-usd', '--max-minutes', '--help']) {
      assert.ok(r.stdout.includes(flag), `--help does not list ${flag}`);
    }
    assert.ok(r.stdout.includes('claude-cli (default'));
    assert.ok(r.stdout.includes('../prod/worlds/gen-<slug-of-input>'));
  });

  it('an unknown flag exits 2 with one line', () => {
    const r = worldgen(['A helpdesk with SLA tiers', '--bogus']);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, 'unknown option --bogus (see --help)\n');
    assert.equal(r.stdout, '');
  });

  it('no input exits 2', () => {
    const r = worldgen([]);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, 'No input given. Pass a description, --openapi <file> or --csv <file...>. (see --help)\n');
  });

  it('a budget that is not a positive number exits 2', () => {
    const r = worldgen(['A helpdesk', '--budget-usd', '0']);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, '--budget-usd needs a positive number, got 0 (see --help)\n');
  });

  it('an unknown transport exits 2', () => {
    const r = worldgen(['A helpdesk', '--transport', 'http']);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, '--transport must be one of claude-cli, sdk, got http (see --help)\n');
  });

  it('--world with a change request checks model access before any call, like create does', () => {
    const { home, env } = scratch();
    const r = worldgen(['--world', HELPDESK, 'add refunds'], { ...env, PATH: path.join(home, 'empty-bin') });
    assert.equal(r.status, 2);
    assert.ok(r.stderr.startsWith('the claude CLI "claude" was not found on PATH'), r.stderr);
    assert.equal(r.stdout, '');
  });

  it('--world on a directory with no world.yaml exits 2 and writes nothing there', () => {
    const { home, env } = scratch();
    const dir = path.join(home, 'empty-world');
    mkdirSync(dir);
    const r = worldgen(['--world', dir, 'add refunds'], env);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, `${dir} has no world.yaml: --world iterates on an existing world\n`);
    assert.deepEqual(readdirSync(dir), []);
  });

  it('--world on a world.yaml that is not valid stops with input_rejected before any model call, leaving world.yaml byte for byte', () => {
    const { home, env } = scratch();
    const dir = path.join(home, 'broken-world');
    mkdirSync(dir);
    writeFileSync(path.join(dir, 'world.yaml'), 'format: 1\nmeta: [unbalanced\n');
    const r = worldgen(['--world', dir, 'add refunds', '--transport', 'sdk'], { ...env, LLM_KEY: 'test-key-never-sent' });
    assert.equal(r.status, 1);
    assert.ok(r.stderr.startsWith(`stopped: input_rejected: ${dir} has no usable world.yaml`), r.stderr);
    assert.equal(readFileSync(path.join(dir, 'world.yaml'), 'utf8'), 'format: 1\nmeta: [unbalanced\n');
    assert.equal(readFileSync(path.join(dir, 'REPORT.md'), 'utf8').split('\n')[0], 'Stopped: input_rejected');
  });

  it('--world without a change request is a usage error', () => {
    const r = worldgen(['--world', HELPDESK]);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, '--world needs a change request (see --help)\n');
  });

  it('refuses an --out that already holds a world', () => {
    const r = worldgen(['A helpdesk', '--out', '../prod/worlds/helpdesk']);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, `${HELPDESK} already holds a world.yaml: pass another --out, or --world to iterate on it\n`);
  });
});

describe('worldgen CLI: model access is checked before any work', () => {
  it('--transport sdk without LLM_KEY exits 2 naming the variable, and writes nothing', () => {
    const { home, env } = scratch();
    const out = path.join(home, 'gen-helpdesk');
    const r = worldgen(['A helpdesk with SLA tiers', '--transport', 'sdk', '--out', out], env);
    assert.equal(r.status, 2);
    assert.equal(r.stderr, '--transport sdk needs LLM_KEY set in the environment\n');
    assert.equal(r.stdout, '');
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(path.join(home, 'costs.jsonl')), false);
  });

  it('reads a description that starts with - as text after --, and as an unknown option without it', () => {
    const { home, env } = scratch();
    const out = path.join(home, 'gen-pricing');
    const noBin = { ...env, PATH: path.join(home, 'empty-bin') };
    const text = worldgen(['--out', out, '--', '-5% price on tier 2'], noBin);
    assert.equal(text.status, 2);
    assert.equal(text.stderr.startsWith('the claude CLI "claude" was not found on PATH'), true, text.stderr);
    const option = worldgen(['-5% price on tier 2', '--out', out], noBin);
    assert.equal(option.status, 2);
    assert.equal(option.stderr.split('\n')[0], 'unknown option -5% price on tier 2 (see --help)');
    assert.equal(existsSync(out), false);
  });

  it('the default claude-cli transport exits 2 when no claude binary is on PATH', () => {
    const { home, env } = scratch();
    const out = path.join(home, 'gen-helpdesk');
    const r = worldgen(['A helpdesk with SLA tiers', '--out', out], { ...env, PATH: path.join(home, 'empty-bin') });
    assert.equal(r.status, 2);
    assert.equal(
      r.stderr,
      'the claude CLI "claude" was not found on PATH: install Claude Code and log in, set WORLDGEN_CLAUDE_BIN or claudeBin in worldgen.config.json, or use --transport sdk with LLM_KEY set\n',
    );
    assert.equal(r.stdout, '');
    assert.equal(existsSync(out), false);
  });

  it('exits 2 when the claude on PATH is a shim that cannot run, before any run directory or ledger entry', () => {
    const { home, env } = scratch();
    const bin = path.join(home, 'shim-bin');
    mkdirSync(bin);
    writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "Error: claude not found in PATH" >&2\nexit 127\n', { mode: 0o755 });
    const out = path.join(home, 'gen-helpdesk');
    const r = worldgen(['A helpdesk with SLA tiers', '--out', out], { ...env, PATH: `${bin}:/usr/bin:/bin` });
    assert.equal(r.status, 2);
    assert.equal(
      r.stderr,
      'the claude CLI "claude" could not run (exit 127: Error: claude not found in PATH): it is often a shell shim; set WORLDGEN_CLAUDE_BIN or claudeBin in worldgen.config.json to the real binary (try ~/.local/bin/claude), or use --transport sdk with LLM_KEY set\n',
    );
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(path.join(home, 'costs.jsonl')), false);
  });
});

describe('worldgen CLI: a run that stops', () => {
  it('exits 1, prints the StopReason on one line, writes REPORT.md and records the transport first', () => {
    // A missing spec file stops at digest, before any model call, whether or not the openapi adapter exists yet.
    const { home, env } = scratch();
    const out = path.join(home, 'gen-refunds');
    const r = worldgen(['--openapi', path.join(home, 'missing.openapi.yaml'), '--only', '/v1/refunds', '--transport', 'sdk', '--out', out], {
      ...env,
      LLM_KEY: 'test-key-never-sent',
    });
    assert.equal(r.status, 1);
    assert.ok(r.stderr.startsWith('stopped: input_rejected: '), r.stderr);
    assert.equal(r.stderr.trimEnd().split('\n').length, 1);
    assert.equal(r.stdout.split('\n')[0], `worldgen: openapi input into ${out} (model claude-sonnet-5-5, transport sdk, budget $5.00, 15 min)`);
    assert.equal(readFileSync(path.join(partialDir(out), 'REPORT.md'), 'utf8').split('\n')[0], 'Stopped: input_rejected');
    assert.equal(existsSync(out), false);
    const runs = readdirSync(path.join(partialDir(out), 'runs'));
    assert.equal(runs.length, 1);
    const first: unknown = JSON.parse(readFileSync(path.join(partialDir(out), 'runs', runs[0]!, 'events.jsonl'), 'utf8').split('\n')[0]!);
    assert.deepEqual(
      typeof first === 'object' && first !== null && 't' in first && 'transport' in first ? [first.t, first.transport] : null,
      ['run_started', 'sdk'],
    );
    assert.equal(existsSync(path.join(home, 'costs.jsonl')), false);
  });
});

describe('worldgen CLI: exit', () => {
  it('exits once the run returns, even with a handle still open, and flushes stdout first', () => {
    // The interval stands in for a lingering handle such as an abandoned claude child's pipes.
    const r = spawnSync(process.execPath, ['--import', 'tsx', 'test/helpers/linger-cli.ts', '--help'], {
      cwd: CODE_DIR, encoding: 'utf8', env: scratch().env, timeout: 10_000, killSignal: 'SIGKILL',
    });
    assert.equal(r.error, undefined);
    assert.equal(r.signal, null);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.startsWith('usage:'), true);
  });

  it('exits 1 after a stopped run has written run_finished and REPORT.md, even with a handle still open', () => {
    // The same digest stop as above, before any model call, so no model is needed.
    const { home, env } = scratch();
    const out = path.join(home, 'gen-refunds');
    const r = spawnSync(
      process.execPath,
      ['--import', 'tsx', 'test/helpers/linger-cli.ts', '--openapi', path.join(home, 'missing.openapi.yaml'), '--transport', 'sdk', '--out', out],
      { cwd: CODE_DIR, encoding: 'utf8', env: { ...env, LLM_KEY: 'test-key-never-sent' }, timeout: 10_000, killSignal: 'SIGKILL' },
    );
    assert.equal(r.error, undefined);
    assert.equal(r.signal, null);
    assert.equal(r.status, 1);
    assert.equal(r.stderr.startsWith('stopped: input_rejected: '), true, r.stderr);
    assert.equal(readFileSync(path.join(partialDir(out), 'REPORT.md'), 'utf8').split('\n')[0], 'Stopped: input_rejected');
    const runs = readdirSync(path.join(partialDir(out), 'runs'));
    const last: unknown = JSON.parse(readFileSync(path.join(partialDir(out), 'runs', runs[0]!, 'events.jsonl'), 'utf8').trimEnd().split('\n').at(-1)!);
    assert.equal(typeof last === 'object' && last !== null && 't' in last ? last.t : null, 'run_finished');
  });
});

/**
 * A stand-in for the claude binary, found through WORLDGEN_CLAUDE_BIN. It answers `--version` for the probe and each
 * `-p` call with the next entry of the JSON script in FAKE_CLAUDE_SCRIPT, as the one result line claudeCliModel parses.
 * The call count lives in FAKE_CLAUDE_COUNT. A prompt that does not name the entry's step exits 3, so order drift fails loudly.
 * Like Linux, it refuses an argv string of 131072 bytes or more, which macOS would pass (A-378), and like the real CLI it
 * needs a readable --system-prompt-file.
 */
const FAKE_CLAUDE = `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv.includes('--version')) {
  process.stdout.write('0.0.0 (fake claude)\\n');
  process.exit(0);
}
const long = process.argv.findIndex((a) => Buffer.byteLength(a) >= 131072);
if (long >= 0) {
  process.stderr.write('fake claude: argument ' + process.argv[long - 1] + ' is ' + Buffer.byteLength(process.argv[long]) + ' bytes: spawn E2BIG on Linux\\n');
  process.exit(7);
}
const systemFile = process.argv[process.argv.indexOf('--system-prompt-file') + 1];
if (!process.argv.includes('--system-prompt-file') || fs.readFileSync(systemFile, 'utf8') === '') {
  process.stderr.write('fake claude: no system prompt file\\n');
  process.exit(3);
}
const script = JSON.parse(fs.readFileSync(process.env.FAKE_CLAUDE_SCRIPT, 'utf8'));
const countFile = process.env.FAKE_CLAUDE_COUNT;
const n = fs.existsSync(countFile) ? Number(fs.readFileSync(countFile, 'utf8')) : 0;
fs.writeFileSync(countFile, String(n + 1));
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => { prompt += d; });
process.stdin.on('end', () => {
  const entry = script[n];
  if (entry === undefined) {
    process.stderr.write('fake claude: no scripted reply for call ' + (n + 1) + '\\n');
    process.exit(3);
  }
  if (!prompt.includes(entry.expect)) {
    process.stderr.write('fake claude: call ' + (n + 1) + ' expected a prompt with "' + entry.expect + '"\\n');
    process.exit(3);
  }
  process.stdout.write(JSON.stringify({
    type: 'result', subtype: 'success', is_error: false, result: JSON.stringify(entry.input), structured_output: entry.input,
    total_cost_usd: 0.125, usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  }) + '\\n');
});
`;

/** The same plan and stage edits the runWorldGen tests script, one claude -p call each. */
const SCRIPTED_CALLS = [
  { expect: 'Call submit_plan with the plan.', input: PLAN },
  { expect: 'Call edit_world with one WorldEdit for the model stage.', input: EDITS.model },
  { expect: 'Call edit_world with one WorldEdit for the workflow stage.', input: EDITS.workflow },
  { expect: 'Call edit_world with one WorldEdit for the seed stage.', input: EDITS.seed },
  { expect: 'Call edit_world with one WorldEdit for the tasks stage.', input: EDITS.tasks },
];

const eventOf = (line: string): { t?: unknown; worldWritten?: unknown; result?: { kind?: unknown } } => {
  const v: unknown = JSON.parse(line);
  return typeof v === 'object' && v !== null ? v : {};
};

describe('worldgen CLI: a description to a finished world (M1)', () => {
  it('runs the real entry over a stand-in claude to a saved world that worldplay checks and verifies', async () => {
    const { home, env } = scratch();
    const bin = path.join(home, 'bin', 'claude');
    mkdirSync(path.dirname(bin));
    writeFileSync(bin, FAKE_CLAUDE);
    chmodSync(bin, 0o755);
    const script = path.join(home, 'script.json');
    writeFileSync(script, JSON.stringify(SCRIPTED_CALLS));
    const count = path.join(home, 'calls');
    const out = path.join(home, 'gen-helpdesk');

    const r = worldgen(['A helpdesk where overdue tickets escalate', '--out', out], {
      ...env, WORLDGEN_CLAUDE_BIN: bin, FAKE_CLAUDE_SCRIPT: script, FAKE_CLAUDE_COUNT: count,
    }, 180_000);
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr.includes('stopped:'), false, r.stderr);
    assert.equal(lines[0], `worldgen: description input into ${out} (model claude-sonnet-5-5, transport claude-cli, budget $5.00, 15 min)`);
    assert.ok(lines.at(-1)!.startsWith(`done: ${out} with 3 verified tasks, $0.6250, `), lines.at(-1));

    const loaded = await loadWorld(out);
    assert.equal(loaded.ok, true);
    const checked = loaded.ok ? checkWorld(loaded.value) : null;
    assert.equal(checked?.ok, true);
    assert.equal(readFileSync(path.join(out, 'world.yaml'), 'utf8'), checked?.ok ? renderWorldYaml(checked.world) : null);

    const check = cli('src/cli/worldplay.ts', ['check', out], env, 180_000);
    assert.equal(check.status, 0, check.stdout + check.stderr);
    const verify = cli('src/cli/worldplay.ts', ['verify', out], env, 180_000);
    assert.equal(verify.status, 0, verify.stdout + verify.stderr);
    for (const task of ['resolve_password_ticket easy', 'resolve_initech_pending medium', 'escalate_acme hard']) {
      assert.ok(verify.stdout.split('\n').some((l) => l.startsWith(`${task} solution 1.000 noop 0.000 `)), `${task}: ${verify.stdout}`);
    }

    // Every model call is filed under the run and its step (A-365), so `costs --by run` isolates the run.
    const runDirs = readdirSync(path.join(out, 'runs'));
    assert.equal(runDirs.length, 1);
    const runId = runDirs[0];
    const ledgerLines = readFileSync(env['WORLDGEN_COSTS_FILE'] ?? '', 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { op?: string; runId?: string; step?: string; event?: { kind?: string; runId?: string; step?: string } });
    const steps = ['plan', 'model', 'workflow', 'seed', 'tasks'];
    assert.deepEqual(ledgerLines.filter((l) => l.op === 'start_model').map((l) => [l.runId, l.step]), steps.map((step) => [runId, step]));
    assert.deepEqual(ledgerLines.filter((l) => l.op === 'settle' && l.event?.kind === 'model_call').map((l) => [l.event?.runId, l.event?.step]), steps.map((step) => [runId, step]));
    const byRun = cli('src/cli/costs.ts', ['--json', '--by', 'run'], env);
    assert.equal(byRun.status, 0, byRun.stderr);
    assert.deepEqual((JSON.parse(byRun.stdout) as { rows: { key: string; usd: number; events: number }[] }).rows.map((r) => [r.key, r.usd, r.events]), [[runId, 0.625, 5]]);

    assert.equal(readFileSync(path.join(out, 'REPORT.md'), 'utf8').split('\n')[0], '# WorldGen report: Zendesk-style helpdesk');
    assert.equal(parsePlanYaml(readFileSync(path.join(out, 'plan.yaml'), 'utf8'))?.software, PLAN.software);

    const runs = readdirSync(path.join(out, 'runs'));
    assert.equal(runs.length, 1);
    const events = readFileSync(path.join(out, 'runs', runs[0]!, 'events.jsonl'), 'utf8').trimEnd().split('\n').map(eventOf);
    assert.equal(events[0]?.t, 'run_started');
    const last = events.at(-1);
    assert.deepEqual([last?.t, last?.result?.kind, last?.worldWritten], ['run_finished', 'done', true]);

    assert.equal(readFileSync(count, 'utf8'), '5');
    const ledger = openLedger(path.join(home, 'costs.jsonl'));
    assert.equal(ledger.read().events.length, 5);
    assert.equal(ledger.read().reservations.length, 0);
    assert.deepEqual(ledger.read().events.map((event) => event.usd), [0.125, 0.125, 0.125, 0.125, 0.125]);
  });
});

describe('inputSlug', () => {
  const slug: (input: Input) => string = inputSlug;

  it('joins a description\'s words with - and cuts at a word boundary within 40 characters', () => {
    assert.equal(slug({ kind: 'description', text: 'A helpdesk with SLA tiers and on-call escalation' }), 'a-helpdesk-with-sla-tiers-and-on-call');
  });

  it('folds accents and drops punctuation', () => {
    assert.equal(slug({ kind: 'description', text: 'Café   Ünïcode!' }), 'cafe-unicode');
  });

  it('uses the OpenAPI file stem plus the --only prefixes', () => {
    assert.equal(slug({ kind: 'openapi', path: '../eval/inputs/stripe.openapi.yaml', only: ['/v1/refunds'] }), 'stripe-openapi-v1-refunds');
  });

  it('uses the first CSV file stem', () => {
    assert.equal(slug({ kind: 'csv', paths: ['../eval/inputs/orders.csv', 'customers.csv'] }), 'orders');
  });

  it('cuts one long word to 40 characters and falls back to world', () => {
    assert.equal(slug({ kind: 'description', text: 'x'.repeat(50) }), 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
    assert.equal(slug({ kind: 'description', text: '!!! ???' }), 'world');
  });
});

describe('genDirName (A-44 default --out)', () => {
  it('prefixes the slug with gen-', () => {
    assert.equal(genDirName({ kind: 'description', text: 'A helpdesk with SLA tiers' }), 'gen-a-helpdesk-with-sla-tiers');
    assert.equal(genDirName({ kind: 'openapi', path: '../eval/inputs/stripe.openapi.yaml', only: ['/v1/refunds'] }), 'gen-stripe-openapi-v1-refunds');
    assert.equal(genDirName({ kind: 'csv', paths: ['../eval/inputs/orders.csv', 'customers.csv'] }), 'gen-orders');
    assert.equal(genDirName({ kind: 'description', text: '!!!' }), 'gen-world');
  });
});

describe('describeStop', () => {
  const notCovered = issue('plan.not_covered', ['plan', 'tasks', 0], { item: 'task "solve_one"' }, 'no tasks.solve_one');
  const invalid = issue('schema.invalid', ['plan', 'summary'], { message: 'expected string' }, 'missing');

  it('puts every stop kind on one line', () => {
    assert.equal(describeStop({ kind: 'input_rejected', why: 'The input asks for\na phishing site.' }), 'input_rejected: The input asks for a phishing site.');
    assert.equal(
      describeStop({ kind: 'attempts_exhausted', step: 'tasks', attempts: 5, lastIssues: [notCovered, invalid, notCovered] }),
      'attempts_exhausted: tasks still rejected after 5 attempts (last issues: plan.not_covered, schema.invalid)',
    );
    assert.equal(
      describeStop({ kind: 'no_progress', step: 'seed', repeatedIssueSet: 'x', lastIssues: [] }),
      'no_progress: seed kept returning the same issues (last issues: none)',
    );
    assert.equal(describeStop({ kind: 'backtrack_limit', step: 'workflow', backtracks: 2 }), 'backtrack_limit: workflow after 2 backtracks');
    assert.equal(describeStop({ kind: 'budget_exhausted', spentUsd: 5.0625, limitUsd: 5 }), 'budget_exhausted: this run spent $5.0625 of its per-run budget maxCostUsd=$5.00');
    assert.equal(
      describeStop({ kind: 'spend_cap', cap: 'maxDailyLlmUsd', capUsd: 40, spentUsd: 40.5, day: '2026-10-07' }),
      'spend_cap: daily LLM spend cap WORLDGEN_MAX_DAILY_LLM_USD=$40.00 reached: $40.50 spent today (2026-10-07 UTC), all sessions, model calls only',
    );
    assert.equal(describeStop({ kind: 'time_exhausted', minutes: 15 }), 'time_exhausted: hit the 15-minute limit');
    assert.equal(describeStop({ kind: 'time_exhausted', minutes: 15, refused: { step: 'tasks', estimateMs: 180_000, remainingMs: 173_976 } }), 'time_exhausted: the next call (tasks) needed ~180 s and 174 s were left');
    assert.equal(describeStop({ kind: 'stage_time_exhausted', step: 'workflow', shareMs: 90_000 }), 'stage_time_exhausted: workflow has 90s before the time reserved for later steps');
    assert.equal(describeStop({ kind: 'model_error', message: 'claude -p failed\n  (exit 1)' }), 'model_error: claude -p failed (exit 1)');
  });
});

describe('createEmitter progress view', () => {
  const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const events: RunEvent[] = [
    { at: '2026-10-06T12:00:00.000Z', runId: 'r1', t: 'run_started', mode: 'create', input: 'description', model: 'claude-sonnet-5-5', budgetUsd: 5, transport: 'claude-cli' },
    { at: '2026-10-06T12:00:01.500Z', runId: 'r1', t: 'attempt', step: 'plan', n: 1, ms: 1400, usage, costUsd: 0.125, outcome: { kind: 'invalid_output', issues: [] }, dump: 'a' },
    { at: '2026-10-06T12:00:04.000Z', runId: 'r1', t: 'attempt', step: 'plan', n: 2, ms: 2400, usage, costUsd: 0.25, outcome: { kind: 'accepted', warnings: 0 }, dump: 'b' },
  ];

  it('prints one line per attempt with step, attempt, cumulative $ and elapsed time, and keeps events without a file', () => {
    const log = mock.method(console, 'log', () => {});
    try {
      const emit = createEmitter(null, { console: true, progress: true });
      for (const e of events) emit(e);
      assert.deepEqual(log.mock.calls.map((c) => c.arguments[0]), [
        '[r1] run started: create from description, model claude-sonnet-5-5, budget $5.00',
        '[r1] plan attempt 1: invalid_output, $0.1250 spent, 1.5s elapsed',
        '[r1] plan attempt 2: accepted, $0.3750 spent, 4.0s elapsed',
      ]);
      assert.deepEqual(emit.events(), events);
    } finally {
      log.mock.restore();
    }
  });
});

describe('parsePlanYaml', () => {
  const plan: Plan = planSchema.parse({
    software: 'Zendesk-style helpdesk',
    clock: { start: '2026-01-05T09:00:00.000Z', tick: '0s' },
    summary: 'Tickets that escalate when their SLA runs out.',
    verdict: { kind: 'proceed' },
    entities: [{ name: 'ticket', purpose: 'a support request', keyFields: ['status', 'priority'] }],
    workflows: [{ name: 'lifecycle', entity: 'ticket', states: ['open', 'solved'], rules: ['solved is final'], actions: ['solve_ticket'] }],
    jobs: [{ name: 'escalate_overdue', every: '1h', rule: 'open tickets past due escalate' }],
    acceptanceTests: [{
      id: 'solve_ticket',
      intent: 'A ticket can be solved through the public API.',
      actions: ['solve_ticket'],
      description: 'a ticket can be solved',
      script: "(ctx) => { const r = ctx.api('POST', '/tickets/tk_0001/solve'); ctx.assert(r.status === 200, 'solve failed'); }",
    }],
    routes: [{ id: 'list_tickets', method: 'GET', path: '/tickets', purpose: 'list tickets' }],
    seed: { rowsPerEntity: { ticket: 12 }, mix: 'mostly open' },
    tasks: [
      { id: 'solve_one', difficulty: 'easy', intent: 'solve a ticket', decoyIdea: 'solve the wrong ticket' },
      { id: 'reassign', difficulty: 'medium', intent: 'reassign a ticket', decoyIdea: 'reassign to an absent agent' },
      { id: 'triage', difficulty: 'hard', intent: 'triage the queue', decoyIdea: 'skip premium tickets' },
    ],
    assumptions: [{ decision: 'one queue', why: 'the description names no queues' }],
    outOfScope: [{ what: 'billing', why: 'not asked for' }],
  });

  it('reads back what renderPlanYaml wrote', () => {
    assert.deepEqual(parsePlanYaml(renderPlanYaml(plan)), plan);
  });

  it('returns null for text that is not YAML or not a plan', () => {
    assert.equal(parsePlanYaml('software: [unclosed'), null);
    assert.equal(parsePlanYaml('software: only this\n'), null);
    assert.equal(parsePlanYaml(''), null);
  });
});


describe('worldgen CLI: exception artifacts before generation', () => {
  it('exits 1 with crash artifacts when the event-log path is blocked, without a model call', () => {
    const { home, env } = scratch();
    const bin = path.join(home, 'fake-claude');
    const script = path.join(home, 'script.json');
    const count = path.join(home, 'count');
    writeFileSync(bin, FAKE_CLAUDE);
    chmodSync(bin, 0o755);
    writeFileSync(script, '[]');
    const out = path.join(home, 'out');
    mkdirSync(partialDir(out));
    writeFileSync(path.join(partialDir(out), 'runs'), 'blocks the event-log directory');
    const r = worldgen(['Offline CLI output failure', '--out', out], {
      ...env, WORLDGEN_CLAUDE_BIN: bin, FAKE_CLAUDE_SCRIPT: script, FAKE_CLAUDE_COUNT: count,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /worldgen crashed: (ENOTDIR|EEXIST)/);
    assert.equal(existsSync(count), false);
    assert.equal(existsSync(out), false);
    assert.equal(existsSync(path.join(partialDir(out), 'plan.yaml')), false);
    assert.match(readFileSync(path.join(partialDir(out), 'REPORT.md'), 'utf8'), /^Crashed:/);
    const capsule = capsuleSchema.parse(JSON.parse(readFileSync(path.join(partialDir(out), 'capsule.json'), 'utf8')));
    assert.equal(capsule.costUsd, 0);
    assert.equal(capsule.worldId, null);
    assert.deepEqual(capsule.attempts, []);
    const ledger = openLedger(path.join(home, 'costs.jsonl'));
    assert.equal(ledger.read().events.length, 0);
    assert.equal(ledger.read().reservations.length, 0);
  });
});
