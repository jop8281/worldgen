import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { openApiOf } from '#engine';
import { checkRequest, routesOf, runEpisode, type EpisodeInput, type NextTurn, type SendableRequest, type TurnView, type WorldPort } from '../src/dataset/episode.ts';
import { isCompleteSuccess, redactor } from '../src/dataset/schema.ts';
import { SOLVER_TOOL, promptOf, solverTurn, systemOf, type SolverProposer } from '../src/dataset/solver.ts';
import { configSchema } from '../src/worldgen/config.ts';
import { anthropicModel, ModelError, type MessagesClient } from '../src/worldgen/llm.ts';
import {
  COST, EASY, EASY_REPLY, easySolver, episodeInput, helpdesk, lazySolver, localWorld, preparedHelpdesk, scripted, turn, type LocalWorld,
} from './dataset-kit.ts';

const get = (path: string, query: Record<string, string> = {}) => ({ action: 'request', method: 'GET', path, query });

describe('checkRequest: which public requests may be sent', () => {
  let routes: ReturnType<typeof routesOf>;
  before(async () => {
    routes = routesOf(openApiOf(await helpdesk()));
  });
  const q = {};

  it('accepts a documented method and path, a placeholder segment, and string query values', () => {
    assert.deepEqual(checkRequest({ method: 'GET', path: '/tickets', query: { status: 'new', limit: '1' } }, routes), {
      ok: true, send: { method: 'GET', target: '/tickets?status=new&limit=1', bodyText: undefined },
    });
    assert.deepEqual(checkRequest({ method: 'POST', path: '/tickets/tkt_0004/assign', query: q, body: { agent_id: 'agt_0001' } }, routes), {
      ok: true, send: { method: 'POST', target: '/tickets/tkt_0004/assign', bodyText: '{"agent_id":"agt_0001"}' },
    });
    assert.equal(checkRequest({ method: 'get', path: '/tickets/tkt_0001', query: q }, routes).ok, true);
  });

  const refused: [string, string, string][] = [
    ['an absolute URL', 'http://evil.example/tickets', 'path must be relative and start with "/", not an absolute URL'],
    ['an https URL', 'https://127.0.0.1:4001/_world/state', 'path must be relative and start with "/", not an absolute URL'],
    ['a protocol-relative URL', '//evil.example/tickets', 'path must not start with "//" (protocol-relative URL)'],
    ['a backslash', '/tickets\\..\\x', 'path must not contain a backslash'],
    ['the admin prefix', '/_world/state', 'path is outside the public API'],
    ['an encoded admin prefix', '/%5Fworld/state', 'path is outside the public API'],
    ['an upper-case encoded admin prefix', '/%5FWORLD/reset', 'path is outside the public API'],
    ['a dot segment', '/tickets/../_world', 'path must not contain "." or ".." segments'],
    ['an encoded dot segment', '/tickets/%2e%2e/%5fworld', 'path must not contain "." or ".." segments'],
    ['an encoded slash', '/tickets/..%2F_world%2Fstate', 'path must not encode a separator, backslash or control character'],
    ['an encoded backslash', '/tickets/%5C', 'path must not encode a separator, backslash or control character'],
    ['a double-encoded segment', '/tickets/%252e%252e', 'path must not be double-encoded'],
    ['malformed percent-encoding', '/tickets/%zz', 'path has malformed percent-encoding'],
    ['a query string in the path', '/tickets?status=new', 'put query parameters in "query", not in the path'],
    ['a fragment', '/tickets#x', 'put query parameters in "query", not in the path'],
    ['an empty segment', '/tickets//x', 'path must not contain an empty segment'],
    ['a trailing slash', '/tickets/', 'path must not contain an empty segment'],
    ['a doubled root', '//', 'path must not start with "//" (protocol-relative URL)'],
    ['the root, which this API does not document', '/', '/ is not a path in the API documentation'],
    ['whitespace', '/tickets/ x', 'path must not contain whitespace or control characters'],
    ['a path that is not documented', '/nope', '/nope is not a path in the API documentation'],
    ['the served OpenAPI document', '/openapi.json', '/openapi.json is not a path in the API documentation'],
    ['too many segments', '/tickets/tkt_0001/events/x', '/tickets/tkt_0001/events/x is not a path in the API documentation'],
    ['an empty path', '', 'path must be 1 to 2000 characters'],
  ];
  for (const [what, path, reason] of refused) {
    it(`refuses ${what}`, () => {
      assert.deepEqual(checkRequest({ method: 'GET', path, query: q }, routes), { ok: false, reason });
    });
  }

  it('allows the root path only when the API documents it', () => {
    const doc = { paths: { '/': { get: {} } } } as never;
    assert.deepEqual(checkRequest({ method: 'GET', path: '/', query: q }, routesOf(doc)), { ok: true, send: { method: 'GET', target: '/', bodyText: undefined } });
    assert.equal(checkRequest({ method: 'POST', path: '/', query: q }, routesOf(doc)).ok, false);
    assert.equal(checkRequest({ method: 'GET', path: '//', query: q }, routesOf(doc)).ok, false);
  });

  it('refuses an undocumented method on a documented path, naming the documented ones', () => {
    assert.deepEqual(checkRequest({ method: 'DELETE', path: '/tickets/tkt_0001', query: q }, routes), {
      ok: false, reason: 'DELETE is not documented for /tickets/tkt_0001; documented: GET /tickets/{id}, PATCH /tickets/{id}',
    });
    assert.deepEqual(checkRequest({ method: 'TRACE', path: '/tickets', query: q }, routes), { ok: false, reason: 'method must be one of GET, POST, PUT, PATCH, DELETE' });
  });

  it('refuses a body on GET and DELETE, a huge body, and a bad query name', () => {
    assert.deepEqual(checkRequest({ method: 'GET', path: '/tickets', query: q, body: { a: 1 } }, routes), { ok: false, reason: 'GET takes no body' });
    const huge = checkRequest({ method: 'POST', path: '/tickets', query: q, body: { text: 'x'.repeat(100_001) } }, routes);
    assert.deepEqual(huge, { ok: false, reason: 'body is longer than 100000 characters' });
    assert.deepEqual(checkRequest({ method: 'GET', path: '/tickets', query: { 'a b': '1' } }, routes), { ok: false, reason: 'query names must be non-empty and free of whitespace and control characters' });
  });
});

describe('runEpisode against the golden helpdesk over HTTP', () => {
  let world: LocalWorld;
  before(async () => {
    world = await localWorld(await helpdesk());
  });
  after(async () => {
    await world.close();
  });
  const fixedNow = () => 5000;
  const fixed = { now: fixedNow, deadline: 5000 + 60_000 };

  it('solves the easy task: engine score 1, the exact reply, paired calls, stable ids and full hashes', async () => {
    const { prep } = await preparedHelpdesk();
    const { episode, artifacts } = await runEpisode(await episodeInput(world.port, easySolver, fixed));
    assert.equal(episode.stop_reason, 'done');
    assert.equal(episode.score, 1);
    assert.equal(episode.error, null);
    assert.equal(episode.final_reply, EASY_REPLY);
    assert.equal(episode.episode_id, `run1__${EASY}__1`);
    assert.equal(episode.initial_state_hash, prep.seedHash);
    assert.match(episode.final_state_hash ?? '', /^[0-9a-f]{64}$/);
    assert.notEqual(episode.final_state_hash, episode.initial_state_hash);
    assert.deepEqual(episode.messages.map((m) => (m.type === 'tool_call' || m.type === 'tool_result' ? `${m.type}:${m.call_id}` : m.type)), [
      'instruction', 'tool_call:c1', 'tool_result:c1', 'tool_call:c2', 'tool_result:c2', 'tool_call:c3', 'tool_result:c3', 'tool_call:c4', 'tool_result:c4', 'final_reply',
    ]);
    assert.deepEqual(episode.messages[1], {
      seq: 1, role: 'assistant', type: 'tool_call', call_id: 'c1', request: { method: 'GET', path: '/customers', query: { q: 'Acme' } }, commentary: 'Looking up the customer.',
    });
    const last = episode.messages[8];
    assert.equal(last?.type === 'tool_result' ? last.status : null, 200);
    assert.deepEqual(episode.usage, { model_calls: 5, unaccounted_calls: 0, input_tokens: 5000, output_tokens: 500, cache_read_tokens: 0, cache_write_tokens: 0, cost_usd: 0.015, duration_ms: 0 });
    assert.equal(isCompleteSuccess(episode), true);
    assert.equal(episode.messages[0]?.type === 'instruction' ? episode.messages[0].text : '', prep.tasks.find((t) => t.id === EASY)?.instruction);
    // The engine's own evidence is returned apart from the record.
    assert.equal(typeof artifacts.initialState?.now, 'string');
    assert.equal(Array.isArray(artifacts.callLog), true);
    assert.equal((artifacts.callLog as readonly unknown[]).length, 4);
  });

  it('gives the same record on a second run: reset isolation and stable ids', async () => {
    const a = await runEpisode(await episodeInput(world.port, easySolver, fixed));
    const b = await runEpisode(await episodeInput(world.port, easySolver, fixed));
    assert.deepEqual(a.episode, b.episode);
    assert.equal(b.episode.score, 1);
  });

  it('starts every episode from the frozen seed and an empty conversation, whatever the last one did', async () => {
    const { prep } = await preparedHelpdesk();
    const solved = await runEpisode(await episodeInput(world.port, easySolver, fixed));
    assert.notEqual(solved.episode.final_state_hash, prep.seedHash);
    const views: TurnView[] = [];
    const lazy = await runEpisode(await episodeInput(world.port, async (v, s) => (views.push(v), lazySolver(v, s)), fixed));
    assert.equal(lazy.episode.initial_state_hash, prep.seedHash);
    assert.equal(lazy.episode.final_state_hash, prep.seedHash);
    assert.equal(lazy.episode.score, 0);
    assert.equal(views.length, 1);
    assert.equal(views[0]?.messages.length, 1);
  });

  it('does not accept a confident reply that the engine scores 0', async () => {
    const { episode } = await runEpisode(await episodeInput(world.port, lazySolver, fixed));
    assert.equal(episode.stop_reason, 'done');
    assert.equal(episode.final_reply, 'All done, the ticket is assigned.');
    assert.equal(episode.score, 0);
    assert.equal(isCompleteSuccess(episode), false);
  });

  it('scores a wrong assignment 0 and keeps the solver\'s reply', async () => {
    const solver = scripted([
      { action: 'request', method: 'POST', path: '/tickets/tkt_0004/assign', body: { agent_id: 'agt_0002' } },
      { action: 'finish', final_reply: 'Assigned.' },
    ]);
    const { episode } = await runEpisode(await episodeInput(world.port, solver, fixed));
    assert.equal(episode.score, 0);
    assert.equal(isCompleteSuccess(episode), false);
    assert.equal(episode.messages[2]?.type === 'tool_result' ? episode.messages[2].status : null, 200);
  });

  it('shows the solver the public task/history and controller limits without private world state', async () => {
    const w = await helpdesk();
    const { prep } = await preparedHelpdesk();
    const views: TurnView[] = [];
    await runEpisode(await episodeInput(world.port, async (v, s) => (views.push(structuredClone(v)), easySolver(v, s)), fixed));
    assert.equal(views.length, 5);
    assert.deepEqual(Object.keys(views[0] ?? {}).sort(), ['budgetLeftUsd', 'difficulty', 'instruction', 'maxTurns', 'messages', 'openapi', 'turn']);
    assert.deepEqual(views[0]?.openapi, openApiOf(w));
    assert.equal(views[0]?.difficulty, 'easy');
    assert.deepEqual(views[0]?.messages.map((m) => m.type), ['instruction']);
    const seen = views.map((v) => JSON.stringify(v)).join('\n');
    for (const t of Object.values(w.tasks)) {
      assert.ok(t.grader !== undefined && t.solution !== undefined, 'the golden helpdesk is the private form');
      assert.equal(seen.includes(t.grader), false);
      assert.equal(seen.includes(t.solution), false);
      for (const d of t.decoys) assert.equal(seen.includes(d.script), false);
    }
    for (const needle of ['_world', 'decoys', 'adminUrl', 'ctx.seed', 'ctx.api(']) assert.equal(seen.includes(needle), false, needle);
    for (const other of prep.tasks.filter((t) => t.id !== EASY)) assert.equal(seen.includes(other.instruction), false);
  });

  it('rejects requests outside the public API without sending them, and tells the solver why', async () => {
    const sent: SendableRequest[] = [];
    const spy: WorldPort = { ...world.port, call: (r, s) => (sent.push(r), world.port.call(r, s)) };
    const solver = scripted([get('/_world/state'), { action: 'request', method: 'GET', path: 'http://evil.example/tickets' }, { action: 'finish', final_reply: 'Could not.' }]);
    const { episode } = await runEpisode(await episodeInput(spy, solver, fixed));
    assert.deepEqual(sent, []);
    assert.equal(episode.stop_reason, 'done');
    const results = episode.messages.filter((m) => m.type === 'tool_result');
    assert.deepEqual(results.map((m) => (m.type === 'tool_result' ? [m.outcome, m.status, m.detail] : null)), [
      ['rejected', null, 'path is outside the public API'],
      ['rejected', null, 'path must be relative and start with "/", not an absolute URL'],
    ]);
    assert.equal(episode.score, 0);
  });

  it('stops at the turn limit and still records the engine score', async () => {
    const { episode } = await runEpisode(await episodeInput(world.port, scripted(Array.from({ length: 9 }, () => get('/agents'))), { ...fixed, maxTurns: 3 }));
    assert.equal(episode.stop_reason, 'turn_limit');
    assert.equal(episode.error, 'no final reply after 3 turns');
    assert.equal(episode.final_reply, null);
    assert.equal(episode.score, 0);
    assert.equal(episode.usage.model_calls, 3);
    assert.equal(isCompleteSuccess(episode), false);
  });

  it('stops when the model budget is spent, after the call that spent it', async () => {
    const remaining: number[] = [];
    const solver: NextTurn = async view => { remaining.push(view.budgetLeftUsd); return turn(get('/agents'), '', 0.01); };
    const { episode } = await runEpisode(await episodeInput(world.port, solver, { ...fixed, budgetLeftUsd: 0.025 }));
    assert.equal(episode.stop_reason, 'budget_limit');
    assert.equal(episode.usage.model_calls, 3);
    assert.equal(episode.usage.cost_usd, 0.03);
    assert.deepEqual(remaining.map(n => Math.round(n * 1e9) / 1e9), [0.025, 0.015, 0.005]);
    assert.equal(episode.error?.startsWith('the model budget is spent'), true);
  });

  it('does not even reset the world when no budget is left', async () => {
    let resets = 0;
    const spy: WorldPort = { ...world.port, reset: async () => void (resets += 1) };
    const { episode } = await runEpisode(await episodeInput(spy, easySolver, { ...fixed, budgetLeftUsd: 0 }));
    assert.equal(resets, 0);
    assert.equal(episode.stop_reason, 'budget_limit');
    assert.equal(episode.initial_state_hash, null);
    assert.equal(episode.score, null);
    assert.deepEqual(episode.messages.map((m) => m.type), ['instruction']);
    assert.equal(episode.usage.model_calls, 0);
  });

  it('cancels the pending model call at the deadline instead of racing it, and accounts the call as unknown', async () => {
    let aborted = false;
    const hanging: NextTurn = (_v, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('Request was aborted.'));
        });
      });
    const input = await episodeInput(world.port, hanging);
    const t0 = Date.now();
    const { episode } = await runEpisode({ ...input, deadline: t0 + 1000 });
    assert.equal(aborted, true);
    assert.equal(Date.now() - t0 < 5000, true);
    assert.equal(episode.stop_reason, 'time_limit');
    assert.equal(episode.usage.model_calls, 0);
    assert.equal(episode.usage.unaccounted_calls, 1);
    assert.equal(episode.score, 0);
    assert.equal(isCompleteSuccess(episode), false);
  });

  it('cancels the real SDK request when the deadline passes: the HTTP call is aborted and not retried', async () => {
    let httpCalls = 0;
    let httpAborted = false;
    const hangingFetch = (async (_url: unknown, init?: RequestInit) => {
      if (String(_url).includes('/count_tokens')) return new Response(JSON.stringify({ input_tokens: 1 }), { headers: { 'content-type': 'application/json' } });
      httpCalls += 1;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          httpAborted = true;
          reject(new DOMException('aborted', 'AbortError'));
        });
      });
    }) as typeof globalThis.fetch;
    const model = anthropicModel(configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5 }), { apiKey: 'sk-test-abc123456', fetch: hangingFetch });
    const input = await episodeInput(world.port, solverTurn(model));
    // The deadline must outlast the reset and state read before the first call: 32 to 46 ms on an idle Mac, more on a loaded runner.
    const { episode } = await runEpisode({ ...input, deadline: Date.now() + 1000 });
    assert.equal(httpAborted, true);
    assert.equal(httpCalls, 1);
    assert.equal(episode.stop_reason, 'time_limit');
    assert.equal(episode.usage.unaccounted_calls, 1);
  });

  it('stops as interrupted when the operator aborts, and cancels the pending call', async () => {
    const controller = new AbortController();
    let aborted = false;
    const hanging: NextTurn = (_v, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('Request was aborted.'));
        });
        setTimeout(() => controller.abort(), 20);
      });
    const { episode } = await runEpisode(await episodeInput(world.port, hanging, { interrupt: controller.signal }));
    assert.equal(aborted, true);
    assert.equal(episode.stop_reason, 'interrupted');
    assert.equal(episode.error, 'the operator interrupted the run; it cancelled a pending model call and that call\'s cost is unknown');
  });

  it('accounts a billed malformed output, and does not invent a cost for an unbilled failure', async () => {
    const billed = new ModelError('model did not call tool "solver_turn" (stop_reason: end_turn)', undefined, {
      usage: { inputTokens: 4000, outputTokens: 50, cacheReadTokens: 100, cacheWriteTokens: 7 }, costUsd: 0.0085, ms: 30,
    });
    const a = await runEpisode(await episodeInput(world.port, async () => { throw billed; }, fixed));
    assert.equal(a.episode.stop_reason, 'model_error');
    assert.deepEqual([a.episode.usage.model_calls, a.episode.usage.unaccounted_calls, a.episode.usage.input_tokens, a.episode.usage.cache_write_tokens, a.episode.usage.cost_usd], [1, 0, 4000, 7, 0.0085]);
    assert.equal(a.episode.error, 'model call failed: model did not call tool "solver_turn" (stop_reason: end_turn)');

    const refused = await runEpisode(await episodeInput(world.port, async () => { throw new ModelError('Anthropic API error 401: invalid x-api-key', 401, { kind: 'not_started' }); }, fixed));
    assert.deepEqual([refused.episode.stop_reason, refused.episode.usage.model_calls, refused.episode.usage.unaccounted_calls, refused.episode.usage.cost_usd], ['model_error', 0, 0, 0]);

    const lost = await runEpisode(await episodeInput(world.port, async () => { throw new ModelError('Anthropic API error: ECONNRESET'); }, fixed));
    assert.deepEqual([lost.episode.stop_reason, lost.episode.usage.model_calls, lost.episode.usage.unaccounted_calls], ['model_error', 0, 1]);
    const answeredUnknown = await runEpisode(await episodeInput(world.port, async () => { throw new ModelError('synthetic paid request HTTP 500', 500); }, fixed));
    assert.equal(answeredUnknown.episode.usage.unaccounted_calls, 1);
  });

  it('does not count refused SDK admission as an unknown paid episode call', async () => {
    let creates = 0;
    const model = anthropicModel(configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 1 }), { apiKey: 'sk-synthetic-only', client: { messages: {
      async countTokens() { return { input_tokens: 1_000_000 }; },
      async create() { creates += 1; return { content: [], usage: { input_tokens: 0, output_tokens: 0 } }; },
    } } });
    const result = await runEpisode(await episodeInput(world.port, solverTurn(model), fixed));
    assert.deepEqual([creates, result.episode.stop_reason, result.episode.usage.model_calls, result.episode.usage.unaccounted_calls, result.episode.usage.cost_usd], [0, 'model_error', 0, 0, 0]);
  });

  it('stops on a malformed turn as invalid_turn, an agent failure and not infra (A-389), and still accounts what it cost', async () => {
    for (const decision of [{ action: 'request', method: 'GET' }, { action: 'dance' }, 'finish', { action: 'finish' }, { action: 'finish', final_reply: 'x', extra: 1 }]) {
      const { episode } = await runEpisode(await episodeInput(world.port, async () => turn(decision), fixed));
      assert.equal(episode.stop_reason, 'invalid_turn');
      assert.deepEqual([episode.outcome.verdict, episode.outcome.failure_cause], ['failure', 'invalid_turn']);
      assert.equal(episode.usage.model_calls, 1);
      assert.equal(episode.usage.cost_usd, COST);
      assert.equal(episode.final_reply, null);
      assert.equal(episode.score, 0);
    }
  });

  it('ends with world_error, a paired error result and a redacted detail when the public request cannot be sent', async () => {
    const secretUrl = 'http://127.0.0.1:41999';
    const broken: WorldPort = { ...world.port, call: async () => { throw new Error(`connect ECONNREFUSED ${secretUrl}`); } };
    const { episode } = await runEpisode(await episodeInput(broken, easySolver, { ...fixed, redact: redactor([secretUrl]) }));
    assert.equal(episode.stop_reason, 'world_error');
    assert.equal(episode.error, 'public request failed: connect ECONNREFUSED [redacted]');
    assert.deepEqual(episode.messages.map((m) => m.type), ['instruction', 'tool_call', 'tool_result']);
    const result = episode.messages[2];
    assert.deepEqual(result?.type === 'tool_result' ? [result.outcome, result.status, result.detail] : null, ['error', null, 'the request could not be completed: connect ECONNREFUSED [redacted]']);
    assert.equal(JSON.stringify(episode).includes(secretUrl), false);
  });

  it('refuses to start from a world that did not reset to the frozen seed', async () => {
    const solved = await runEpisode(await episodeInput(world.port, easySolver, fixed));
    assert.equal(solved.episode.score, 1);
    let calls = 0;
    const stuck: WorldPort = { ...world.port, reset: async () => undefined };
    const { episode } = await runEpisode(await episodeInput(stuck, async (v, s) => (calls += 1, lazySolver(v, s)), fixed));
    assert.equal(episode.stop_reason, 'world_error');
    assert.equal(calls, 0);
    assert.equal(episode.error?.startsWith('after the reset the world state hash is '), true);
    assert.equal(episode.initial_state_hash, solved.episode.final_state_hash);
    assert.equal(episode.score, null);
    await world.port.reset();
  });

  it('is a grade_error, with no score, when the verifier refuses to grade', async () => {
    const refused: EpisodeInput['grade'] = async () => ({ ok: false, reason: 'grade answered HTTP 500' });
    const { episode, artifacts } = await runEpisode(await episodeInput(world.port, lazySolver, { ...fixed, grade: refused }));
    assert.deepEqual(artifacts.errors, [{ boundary: 'grade', message: 'grade answered HTTP 500' }]);
    assert.equal(JSON.stringify(episode).includes('HTTP 500'), false);
    assert.equal(episode.stop_reason, 'grade_error');
    assert.equal(episode.score, null);
    assert.equal(episode.error, 'grading failed at the grade; the details are in the private diagnostics');
    assert.equal(isCompleteSuccess(episode), false);
    const limited = await runEpisode(await episodeInput(world.port, scripted([get('/agents'), get('/agents')]), { ...fixed, maxTurns: 1, grade: refused }));
    assert.equal(limited.episode.stop_reason, 'turn_limit');
    assert.equal(limited.episode.error, 'no final reply after 1 turns; grading failed at the grade; the details are in the private diagnostics');
  });

  it('is a grade_error when the verifier answers counts that are not two integer pairs, or a broken guard scored above 0 (A-389)', async () => {
    const answering = (counts: Record<string, unknown>, score = 0): EpisodeInput['grade'] => async () => ({ ok: true, score, ...counts }) as never;
    for (const [what, grade] of [
      ['a name in a pair', answering({ goals: { met: 0, total: 1, missed: ['refund issued'] }, guards: { held: 1, total: 1 } })],
      ['met above total', answering({ goals: { met: 2, total: 1 }, guards: { held: 1, total: 1 } })],
      ['no counts', answering({})],
      ['a broken guard scored 1', answering({ goals: { met: 1, total: 1 }, guards: { held: 0, total: 1 } }, 1)],
    ] as const) {
      const { episode, artifacts } = await runEpisode(await episodeInput(world.port, lazySolver, { ...fixed, grade }));
      assert.deepEqual([episode.stop_reason, episode.score, episode.outcome.verdict, episode.outcome.goals], ['grade_error', null, 'infra', null], what);
      assert.equal(JSON.stringify(episode).includes('refund issued'), false, what);
      assert.equal(artifacts.errors?.[0]?.boundary, 'grade', what);
    }
  });

  it('keeps the final reply exactly as returned, and redacts a supplied secret from every public string', async () => {
    const reply = '  Done.\n\nAssigned ✅ — see "x"  ';
    const exact = await runEpisode(await episodeInput(world.port, scripted([{ action: 'finish', final_reply: reply }]), fixed));
    assert.equal(exact.episode.final_reply, reply);
    assert.equal(exact.episode.messages[1]?.type === 'final_reply' ? exact.episode.messages[1].text : null, reply);

    const key = 'sk-ant-SECRET-1234567890';
    const solver = scripted([get('/agents', { q: key }), { action: 'finish', final_reply: `my key is ${key}` }]);
    const { episode } = await runEpisode(await episodeInput(world.port, async (v, s) => ({ ...(await solver(v, s)), commentary: `key ${key}` }), { ...fixed, redact: redactor([key]) }));
    assert.equal(episode.final_reply, 'my key is [redacted]');
    assert.equal(JSON.stringify(episode).includes('SECRET-1234567890'), false);
    assert.equal(episode.messages[1]?.type === 'tool_call' ? episode.messages[1].commentary : null, 'key [redacted]');
  });

  it('cuts an oversized response and flags it', async () => {
    const big: WorldPort = { ...world.port, call: async () => ({ status: 200, text: JSON.stringify({ data: 'x'.repeat(30_000) }) }) };
    const { episode } = await runEpisode(await episodeInput(big, scripted([get('/agents'), { action: 'finish', final_reply: 'Seen.' }]), fixed));
    const r = episode.messages[2];
    assert.equal(r?.type === 'tool_result' ? r.truncated : null, true);
    assert.equal(r?.type === 'tool_result' && typeof r.body === 'string' ? r.body.length : null, 20_000);
  });
});

describe('the solver turn over the Anthropic model', () => {
  const view = async (): Promise<TurnView> => {
    const { prep } = await preparedHelpdesk();
    return {
      instruction: 'Assign the newest unassigned ticket from Acme to Priya.', difficulty: 'easy', openapi: prep.openapi, turn: 2, maxTurns: 10, budgetLeftUsd: 0.25,
      messages: [
        { seq: 0, role: 'user', type: 'instruction', text: 'x' },
        { seq: 1, role: 'assistant', type: 'tool_call', call_id: 'c1', request: { method: 'GET', path: '/customers', query: { q: 'Acme' } }, commentary: 'Looking up.' },
        { seq: 2, role: 'tool', type: 'tool_result', call_id: 'c1', outcome: 'response', status: 200, body: { data: [{ id: 'cus_0001' }] }, truncated: false, detail: null },
      ],
    };
  };

  it('renders the task, the history and the API documentation, and nothing hidden', async () => {
    const v = await view();
    assert.equal(
      promptOf(v),
      [
        'Task (easy):',
        'Assign the newest unassigned ticket from Acme to Priya.',
        '',
        'So far:',
        'You said: Looking up.\nRequest c1: GET /customers query {"q":"Acme"}',
        'Result c1: HTTP 200 {"data":[{"id":"cus_0001"}]}',
        '',
        'This is turn 2 of at most 10. Call solver_turn.',
      ].join('\n'),
    );
    assert.equal(systemOf(v).endsWith(JSON.stringify(v.openapi)), true);
    const w = await helpdesk();
    const all = `${systemOf(v)}\n${promptOf(v)}`;
    for (const t of Object.values(w.tasks)) {
      assert.ok(t.grader !== undefined && t.solution !== undefined, 'the golden helpdesk is the private form');
      assert.equal(all.includes(t.grader), false);
      assert.equal(all.includes(t.solution), false);
    }
    assert.equal(all.includes('_world'), false);
  });

  it('asks the pinned model through the SDK with one tool, a signal, no thinking, and returns only text as commentary', async () => {
    const seen: { params: Record<string, unknown>; signal: AbortSignal | undefined }[] = [];
    const client: MessagesClient = {
      messages: { countTokens: async () => ({ input_tokens: 1 }),
        async create(params, options) {
          seen.push({ params, signal: options?.signal });
          return {
            content: [
              { type: 'thinking', thinking: 'SECRET REASONING' } as never,
              { type: 'text', text: 'I will look it up.' },
              { type: 'tool_use', name: SOLVER_TOOL, input: { action: 'request', method: 'GET', path: '/agents', query: { q: 'P' }, final_reply: 'ignored' } },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 12_000, output_tokens: 80, cache_read_tokens: 0 } as never,
          };
        },
      },
    };
    const model = anthropicModel(configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5 }), { apiKey: 'sk-test-abc123456', client });
    const controller = new AbortController();
    const r = await solverTurn(model)(await view(), controller.signal);
    assert.deepEqual(r.decision, { action: 'request', method: 'GET', path: '/agents', query: { q: 'P' } });
    assert.equal(r.commentary, 'I will look it up.');
    assert.equal(JSON.stringify(r).includes('SECRET REASONING'), false);
    assert.equal(r.costUsd, 0.024800);
    const p = seen[0];
    assert.equal(p?.signal?.aborted, false);
    assert.equal(p?.params['model'], 'claude-sonnet-5-5');
    assert.equal('thinking' in (p?.params ?? {}), false);
    const tools = p?.params['tools'] as { name: string; input_schema: { type: string; properties: Record<string, unknown> } }[];
    assert.deepEqual(tools.map((t) => t.name), [SOLVER_TOOL]);
    assert.equal(tools[0]?.input_schema.type, 'object');
    assert.deepEqual(Object.keys(tools[0]?.input_schema.properties ?? {}).sort(), ['action', 'body', 'final_reply', 'method', 'path', 'query']);
    assert.equal((p?.params['messages'] as unknown[]).length, 1);
  });

  it('names the run and the solver step on every request, and only the step without a run (A-365, YOS-251)', async () => {
    const seen: Parameters<SolverProposer['propose']>[0][] = [];
    const proposer: SolverProposer = {
      async propose(req) {
        seen.push(req);
        return { input: { action: 'finish', final_reply: 'done' }, advice: [], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }, costUsd: 0, ms: 1 };
      },
    };
    await solverTurn(proposer, 'ds-run-7')(await view(), new AbortController().signal);
    await solverTurn(proposer)(await view(), new AbortController().signal);
    assert.deepEqual(seen.map((q) => ['runId' in q ? q.runId : 'absent', q.step]), [['ds-run-7', 'solver'], ['absent', 'solver']]);
  });

  it('sends nothing when the signal is already aborted', async () => {
    let calls = 0;
    const proposer: SolverProposer = { propose: async () => { calls += 1; throw new Error('unreachable'); } };
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(solverTurn(proposer)(await view(), controller.signal), /aborted/i);
    assert.equal(calls, 0);
  });

  it('passes a finish through with only its reply', async () => {
    let remaining: number | undefined;
    const proposer: SolverProposer = {
      propose: async req => { remaining = req.maxCostUsd; return { input: { action: 'finish', final_reply: 'Done.', method: 'GET' }, advice: ['a', 'b'], usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0 }, costUsd: 0.5, ms: 3 }; },
    };
    const r = await solverTurn(proposer)(await view(), new AbortController().signal);
    assert.deepEqual(r.decision, { action: 'finish', final_reply: 'Done.' });
    assert.equal(r.commentary, 'a\nb');
    assert.equal(r.costUsd, 0.5);
    assert.equal(remaining, 0.25);
  });
});
