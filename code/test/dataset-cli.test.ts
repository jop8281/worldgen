import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { main, type CliDeps } from '../src/cli/dataset.ts';
import { configSchema } from '../src/worldgen/config.ts';
import { PROMPT_VERSION } from '../src/dataset/schema.ts';
import { engineGrader } from '../src/dataset/verifier.ts';
import type { SolverProposer } from '../src/dataset/solver.ts';
import { COMMIT, EASY_REPLY, HELPDESK_DIR, easyOnly, fakeBackend, helpdesk, randomPort, solveAll, tmp } from './dataset-kit.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '..');
const KEYS = { LLM_KEY: 'sk-ant-api03-CLI-ANTHROPIC-SECRET', BOAT_API_KEY: 'boat_live_CLI-BOAT-SECRET-0001' };

type Ran = { code: number; stdout: string; stderr: string };
/** Runs the real CLI in a child process with exactly this environment. No key unless the test gives one. */
const spawnCli = (args: string[], env: Record<string, string> = {}): Promise<Ran> =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--import', 'tsx', 'src/cli/dataset.ts', ...args],
      { cwd: CODE_DIR, env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', WORLDGEN_COSTS_FILE: path.join(tmp('costs'), 'costs.jsonl'), ...env } },
      (err, stdout, stderr) => resolve({ code: err === null ? 0 : typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1, stdout, stderr }),
    );
  });

const required = (out: string, over: Record<string, string> = {}): string[] =>
  Object.entries({ world: HELPDESK_DIR, out, 'run-id': 'cli-run', 'engine-commit': COMMIT, 'max-turns': '40', 'budget-usd': '2', 'max-minutes': '5', ...over }).flatMap(([k, v]) => [`--${k}`, v]);

describe('the dataset CLI as a program', () => {
  it('prints usage and exits 0 for --help, naming both keys and the grading limit', async () => {
    const r = await spawnCli(['--help']);
    assert.equal(r.code, 0);
    assert.equal(r.stdout.startsWith('usage: dataset --world <dir> --out <dir> --run-id <id> --engine-commit <sha> --max-turns <n> --budget-usd <n> --max-minutes <n>'), true);
    for (const needle of ['claude-sonnet-5-5', 'LLM_KEY', 'BOAT_API_KEY', 'does not independently certify that the final reply is factually correct']) assert.equal(r.stdout.includes(needle), true, needle);
  });

  it('releases the claim of a crashed run with release-claim, and refuses one whose process is alive', async () => {
    const out = tmp('release');
    mkdirSync(path.join(out, 'logs'));
    writeFileSync(path.join(out, 'logs/r1.episodes.jsonl'), '');
    const claim = path.join(out, 'logs/r1.episodes.jsonl.lock');
    writeFileSync(claim, `${JSON.stringify({ pid: process.pid, host: hostname() })}\n`);
    const alive = await spawnCli(['release-claim', '--out', out, '--run-id', 'r1']);
    assert.deepEqual([alive.code, alive.stderr.includes(`process ${process.pid} still holds`)], [1, true], alive.stderr);
    const dead = spawnSync(process.execPath, ['-e', '']).pid;
    writeFileSync(claim, `${JSON.stringify({ pid: dead, host: hostname() })}\n`);
    const released = await spawnCli(['release-claim', '--out', out, '--run-id', 'r1']);
    assert.equal(released.code, 0, released.stderr);
    assert.equal(released.stdout.includes(`r1.episodes.jsonl.lock: process ${dead} is gone and the log holds 0 valid episode(s)`), true, released.stdout);
    assert.equal(existsSync(claim), false);
    const usage = await spawnCli(['release-claim', '--out', out]);
    assert.deepEqual([usage.code, usage.stderr.includes('usage: dataset release-claim')], [2, true]);
  });

  it('exits 2 with a usage message for a missing, unknown or malformed option', async () => {
    const cases: [string[], string][] = [
      [[], '--world is required'],
      [required(tmp('o')).filter((a) => a !== '--run-id' && a !== 'cli-run'), '--run-id is required'],
      [required(tmp('o'), { 'max-turns': '0' }), '--max-turns must be a positive whole number, got "0"'],
      [required(tmp('o'), { 'budget-usd': 'abc' }), '--budget-usd must be a positive number, got "abc"'],
      [required(tmp('o'), { 'max-minutes': '-3' }), "Option '--max-minutes' argument is ambiguous"],
      [[...required(tmp('o')), '--sandbox', 'local'], 'Unknown option'],
      [[...required(tmp('o')), 'extra'], 'unexpected argument "extra"'],
    ];
    for (const [args, message] of cases) {
      const r = await spawnCli(args);
      assert.equal(r.code, 2, args.join(' '));
      assert.equal(r.stderr.includes(message), true, `${message} in ${r.stderr}`);
      assert.equal(r.stderr.includes('usage: dataset'), true);
      assert.equal(r.stdout, '');
    }
  });

  it('refuses a world that does not check before it needs a key, and creates nothing', async () => {
    const out = path.join(tmp('pre'), 'out');
    const r = await spawnCli(required(out, { world: path.join(tmp('nowhere'), 'w') }));
    assert.equal(r.code, 1);
    assert.match(r.stderr, /^the world in .* does not check \(1 issue\):\nschema\.invalid format: expected a readable world\.yaml in the world directory, found no file at /);
    assert.equal(existsSync(out), false);
  });

  it('redacts known controller keys from invalid-world preflight errors', async () => {
    const world = tmp('invalid-secret-world');
    writeFileSync(path.join(world, 'world.yaml'), readFileSync(path.join(HELPDESK_DIR, 'world.yaml'), 'utf8').replace('format: 1', `format: ${KEYS.LLM_KEY}`));
    const out = path.join(tmp('invalid-secret-out'), 'out');
    const result = await spawnCli(required(out, { world }), KEYS);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /schema.invalid/);
    assert.match(result.stderr, /\[redacted\]/);
    assert.equal(result.stderr.includes(KEYS.LLM_KEY), false);
    assert.equal(result.stderr.includes(KEYS.BOAT_API_KEY), false);
    assert.equal(existsSync(out), false);
  });

  it('redacts a configured SDK key before invalid-world errors without requiring keys', async () => {
    const secret = 'custom-controller-secret-90214';
    const world = tmp('invalid-custom-world');
    writeFileSync(path.join(world, 'world.yaml'), readFileSync(path.join(HELPDESK_DIR, 'world.yaml'), 'utf8').replace('format: 1', `format: ${secret}`));
    const out = path.join(tmp('invalid-custom-out'), 'out');
    const errors: string[] = [];
    const code = await main(required(out, { world }), { CUSTOM_LLM_KEY: secret }, {
      config: configSchema.parse({ model: 'claude-sonnet-5-5', apiKeyEnv: 'CUSTOM_LLM_KEY', maxCostUsd: 1 }),
      err: (line) => errors.push(line),
    });
    assert.equal(code, 1);
    assert.match(errors.join('\n'), /schema.invalid/);
    assert.match(errors.join('\n'), /\[redacted\]/);
    assert.equal(errors.join('\n').includes(secret), false);
    assert.equal(errors.join('\n').includes('BOAT_API_KEY must be set'), false);
    assert.equal(existsSync(out), false);
  });

  it('defaults to the logged-in CLI without requiring LLM_KEY', async () => {
    const out = path.join(tmp('cli-default'), 'out');
    const result = await spawnCli(required(out), { BOAT_API_KEY: KEYS.BOAT_API_KEY, WORLDGEN_BOAT_ORG: 'org_test', WORLDGEN_CLAUDE_BIN: '/missing/claude' });
    assert.equal(result.code, 1);
    assert.match(result.stderr, /the claude CLI "\/missing\/claude" was not found/);
    assert.equal(existsSync(out), false);
  });

  it('names every missing key, exits 1, and creates nothing: no network, no sandbox', async () => {
    const out = path.join(tmp('nokey'), 'out');
    const none = await spawnCli(required(out, { transport: 'sdk' }));
    assert.equal(none.code, 1);
    assert.equal(none.stderr, 'LLM_KEY and BOAT_API_KEY and WORLDGEN_BOAT_ORG must be set in the environment of this command; none is ever written to a file or uploaded\n');
    const onlyBoat = await spawnCli(required(out, { transport: 'sdk' }), { BOAT_API_KEY: KEYS.BOAT_API_KEY, WORLDGEN_BOAT_ORG: 'org_test' });
    assert.equal(onlyBoat.stderr, 'LLM_KEY must be set in the environment of this command; none is ever written to a file or uploaded\n');
    const blank = await spawnCli(required(out, { transport: 'sdk' }), { LLM_KEY: '   ', BOAT_API_KEY: KEYS.BOAT_API_KEY, WORLDGEN_BOAT_ORG: 'org_test' });
    assert.equal(blank.code, 1);
    // A login token or another variable never stands in for the key.
    const other = await spawnCli(required(out, { transport: 'sdk' }), { ANTHROPIC_API_KEY: 'sk-other', ANTHROPIC_AUTH_TOKEN: 'tok', BOAT_API_KEY: KEYS.BOAT_API_KEY, WORLDGEN_BOAT_ORG: 'org_test' });
    assert.equal(other.stderr.startsWith('LLM_KEY must be set'), true);
    assert.equal(existsSync(out), false);
  });
});

describe('the dataset CLI in process, over a fake Boat sandbox and a scripted solver', () => {
  const run = async (args: string[], deps: CliDeps, env: Record<string, string> = KEYS) => {
    const out: string[] = [];
    const err: string[] = [];
    const before = process.listenerCount('SIGINT');
    const code = await main(args, env, {
      out: (l) => out.push(l),
      err: (l) => err.push(l),
      makeBundle: async (dir) => ({ files: [{ path: 'worlds/w/world.yaml', data: readFileSync(path.join(dir, 'public', 'world.yaml')) }], world: 'worlds/w' }),
      // The CLI's default grader is the verifier child process; these tests verify in-process.
      grader: engineGrader,
      ...deps,
    });
    assert.equal(process.listenerCount('SIGINT'), before, 'the CLI left a signal handler behind');
    return { code, out, err };
  };

  it('defaults to Claude CLI without requiring an SDK key', async (t) => {
    const bin = path.join(tmp('claude-bin'), 'claude');
    writeFileSync(bin, `#!${process.execPath}\nprocess.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ subtype: 'success', is_error: false, structured_output: { action: 'finish', final_reply: 'No changes made.' }, total_cost_usd: 0.0001, usage: { input_tokens: 100, output_tokens: 20 } })));\n`);
    chmodSync(bin, 0o755);
    const originalFetch = globalThis.fetch;
    t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      assert.equal(new URL(url).hostname, '127.0.0.1');
      return originalFetch(input, init);
    });
    const env = { PATH: '', WORLDGEN_CLAUDE_BIN: bin, WORLDGEN_COSTS_FILE: path.join(tmp('cli-costs'), 'costs.jsonl') };
    const args = required(tmp('cli-default'));
    const port = randomPort();
    const backend = fakeBackend(await helpdesk(), { port });
    const r = await run(args, { backend, port }, env);
    assert.equal(r.code, 3, r.err.join('\n'));
    assert.equal(r.err.some((line) => line.includes('accepted 0 of 3 task(s)')), true);
    assert.equal(backend.stopped(), true);
  });

  it('uses the SDK when explicitly requested even when the generation default is the Claude CLI', async (t) => {
    const originalFetch = globalThis.fetch;
    const requests: string[] = [];
    t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof globalThis.fetch>[0], init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (new URL(url).hostname !== 'api.anthropic.com') {
        assert.equal(new URL(url).hostname, '127.0.0.1');
        return originalFetch(input, init);
      }
      requests.push(url);
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, 'claude-sonnet-5-5');
      assert.equal(body.tools[0].name, 'solver_turn');
      return new Response(JSON.stringify({
        id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5',
        content: [{ type: 'tool_use', id: 'tool_fake', name: 'solver_turn', input: { action: 'finish', final_reply: 'No changes made.' } }],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 },
      }), { headers: { 'content-type': 'application/json' } });
    });
    const port = randomPort();
    const backend = fakeBackend(await helpdesk(), { port });
    const r = await run(required(tmp('cli-sdk'), { transport: 'sdk' }), { backend, port }, {
      ...KEYS, PATH: '', WORLDGEN_COSTS_FILE: path.join(tmp('sdk-costs'), 'costs.jsonl'),
    });
    assert.equal(r.code, 3, r.err.join('\n'));
    assert.equal(requests.length, 3);
    assert.equal(backend.stopped(), true);
  });

  it('exits 0 and says where everything is when every task has an accepted episode', async () => {
    const outDir = tmp('cli-ok');
    const port = randomPort();
    const backend = fakeBackend(await helpdesk(), { port });
    const r = await run(required(outDir), { backend, nextTurn: solveAll, port });
    assert.equal(r.code, 0, r.err.join('\n'));
    assert.equal(r.out.includes('dataset run cli-run: accepted'), true);
    assert.equal(r.out.some((l) => l.startsWith('  accepted 3 of 3 task(s), failed or missing 0, model spend $')), true);
    assert.equal(r.out.includes('  sandbox fake-sandbox-1: teardown confirmed'), true);
    assert.equal(r.out.some((l) => l.includes('does not independently certify that the final reply is factually correct')), true);
    assert.equal(r.err.length, 0);
    assert.deepEqual(readdirSync(outDir).sort(), ['REPORT.md', 'dataset.jsonl', 'failures.jsonl', 'logs', 'manifest.json', 'private']);
    assert.equal(backend.events.at(-1), 'down');
  });

  it('exits 3 and names the missing episodes when the pipeline is sound but a task was not solved', async () => {
    const port = randomPort();
    const r = await run(required(tmp('cli-partial')), { backend: fakeBackend(await helpdesk(), { port }), nextTurn: easyOnly, port });
    assert.equal(r.code, 3);
    assert.equal(r.err.includes('dataset run cli-run: incomplete'), true);
    assert.equal(r.err.some((l) => l.startsWith('  accepted 1 of 3 task(s), failed or missing 2')), true);
    assert.equal(r.out.some((l) => l.startsWith('dataset run')), false);
  });

  it('records a --model override on the manifest and every episode, and the default model without one (A-283)', async () => {
    const lines = (dir: string, file: string): unknown[] => readFileSync(path.join(dir, file), 'utf8').split('\n').filter(Boolean).map((l) => (JSON.parse(l) as { model: unknown }).model);
    for (const [flag, model] of [[[], 'claude-sonnet-5-5'], [['--model', 'claude-opus-5-5'], 'claude-opus-5-5']] as const) {
      const outDir = tmp('cli-model');
      const port = randomPort();
      const r = await run([...required(outDir), ...flag], { backend: fakeBackend(await helpdesk(), { port }), nextTurn: solveAll, port });
      assert.equal(r.code, 0, r.err.join('\n'));
      assert.equal((JSON.parse(readFileSync(path.join(outDir, 'manifest.json'), 'utf8')) as { model: unknown }).model, model);
      assert.deepEqual(lines(outDir, 'dataset.jsonl'), [model, model, model]);
    }
  });

  it('refuses a --model with no known price before it touches the sandbox, and creates nothing', async () => {
    const outDir = path.join(tmp('cli-unpriced'), 'out');
    const port = randomPort();
    const backend = fakeBackend(await helpdesk(), { port });
    const r = await run([...required(outDir), '--model', 'claude-haiku-4-5'], { backend, nextTurn: solveAll, port });
    assert.equal(r.code, 1);
    assert.equal(r.err.some((l) => l.includes('model: model "claude-haiku-4-5" has no known price: add prices.claude-haiku-4-5 with inputPerMTok and outputPerMTok, or use claude-sonnet-5-5')), true, r.err.join('\n'));
    assert.deepEqual(backend.events, []);
    assert.equal(existsSync(outDir), false);
  });

  it('exits 1 with the problem named when the sandbox stop is not confirmed', async () => {
    const port = randomPort();
    const r = await run(required(tmp('cli-down')), { backend: fakeBackend(await helpdesk(), { port, failDown: true }), nextTurn: solveAll, port });
    assert.equal(r.code, 1);
    assert.equal(r.err.includes('dataset run cli-run: failed'), true);
    assert.equal(r.err.includes('  sandbox fake-sandbox-1: teardown failed'), true);
    assert.equal(r.err.includes('  problem: teardown of sandbox fake-sandbox-1 failed and it may still be running: boat stop never confirmed'), true);
  });

  it('exits 1 for a reused run id, without touching the sandbox', async () => {
    const outDir = tmp('cli-reuse');
    const port = randomPort();
    const first = await run(required(outDir), { backend: fakeBackend(await helpdesk(), { port }), nextTurn: easyOnly, port });
    assert.equal(first.code, 3, first.err.join('\n'));
    const backend = fakeBackend(await helpdesk(), { port });
    const second = await run(required(outDir), { backend, nextTurn: easyOnly, port });
    assert.equal(second.code, 1);
    assert.deepEqual(second.err, [`run id cli-run is already used in ${outDir}: pick another --run-id`]);
    assert.deepEqual(backend.events, []);
  });

  it('solves through the proposer with an abort signal and a prompt that holds only public text', async () => {
    const w = await helpdesk();
    const seen: Parameters<SolverProposer['propose']>[0][] = [];
    const easy = [
      { action: 'request', method: 'GET', path: '/customers', query: { q: 'Acme' } },
      { action: 'request', method: 'GET', path: '/tickets', query: { customer_id: 'cus_0001', status: 'new', sort: '-created_at', limit: '1' } },
      { action: 'request', method: 'GET', path: '/agents', query: { q: 'Priya Raman' } },
      { action: 'request', method: 'POST', path: '/tickets/tkt_0004/assign', body: { agent_id: 'agt_0001' } },
      { action: 'finish', final_reply: EASY_REPLY },
    ];
    const proposer: SolverProposer = {
      async propose(req) {
        seen.push(req);
        const turn = Number(/This is turn (\d+) of/.exec(req.prompt)?.[1]);
        const input = req.prompt.startsWith('Task (easy)') ? easy[turn - 1] : { action: 'finish', final_reply: 'I could not do this.' };
        return { input, advice: [`thinking aloud about ${KEYS.LLM_KEY}`], usage: { inputTokens: 1000, outputTokens: 50, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.002, ms: 3 };
      },
    };
    const outDir = tmp('cli-proposer');
    const port = randomPort();
    const r = await run(required(outDir), { backend: fakeBackend(w, { port }), proposer, port });
    assert.equal(r.code, 3);
    assert.equal(seen.length, 5 + 1 + 1);
    assert.equal(seen.every((q) => q.signal instanceof AbortSignal), true);
    assert.equal(seen.every((q) => q.tool.name === 'solver_turn'), true);
    const everything = seen.map((q) => `${q.system}\n${q.prompt}`).join('\n');
    for (const t of Object.values(w.tasks)) {
      assert.ok(t.grader !== undefined && t.solution !== undefined, 'the golden helpdesk is the private form');
      assert.equal(everything.includes(t.grader), false);
      assert.equal(everything.includes(t.solution), false);
      for (const d of t.decoys) assert.equal(everything.includes(d.script), false);
    }
    for (const needle of ['_world', 'decoy', '127.0.0.1', KEYS.BOAT_API_KEY]) assert.equal(everything.includes(needle), false, needle);

    const rows = readFileSync(path.join(outDir, 'dataset.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].final_reply, EASY_REPLY);
    assert.equal(rows[0].score, 1);
    assert.equal(rows[0].prompt_version, PROMPT_VERSION);
    assert.equal(rows[0].messages[1].commentary, 'thinking aloud about [redacted]');
    assert.equal(rows[0].usage.cost_usd, 0.01);
    assert.equal(rows[0].model, 'claude-sonnet-5-5');
    assert.equal(readFileSync(path.join(outDir, 'failures.jsonl'), 'utf8').split('\n').filter(Boolean).length, 2);
  });
});
