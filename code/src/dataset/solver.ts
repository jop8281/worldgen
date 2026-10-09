/**
 * The solver's side of an episode: the prompt, the one tool, and `solverTurn`, which turns any
 * proposer (the metered Anthropic model from cli/models.ts) into the `NextTurn` that episode.ts
 * wants. The proposer type is structural, so this file imports no model and no SDK.
 *
 * Each call renders the public history into one prompt, because the proposer takes a single
 * message. The system prompt carries the API documentation, which does not change within an
 * episode. Neither holds a task object, a grader, a reference solution or an admin route: the
 * only inputs are a `TurnView`. Hidden thinking is never requested and never read; only the
 * model's text outside its tool call comes back, as commentary.
 */
import { z } from 'zod';
import type { NextTurn, TurnResult, TurnView } from './episode.ts';
import type { PublicMessage } from './schema.ts';

export const SOLVER_TOOL = 'solver_turn';

/** The tool's input schema. Flat, because tool schemas must be an object at the top. `pickDecision` drops fields the chosen action does not use. */
const toolInput = z.object({
  action: z.enum(['request', 'finish']).describe('"request" sends one API request. "finish" ends the task.'),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional().describe('with action "request": the HTTP method'),
  path: z.string().optional().describe('with action "request": a documented path starting with "/", with ids filled in, and no query string'),
  query: z.record(z.string(), z.string()).optional().describe('with action "request": query parameters'),
  body: z.unknown().optional().describe('with action "request": the JSON request body, where the operation takes one'),
  final_reply: z.string().optional().describe('with action "finish": your message to the user'),
});
export const SOLVER_TOOL_SCHEMA: object = z.toJSONSchema(toolInput, { io: 'input' });

/** The structural slice of llm.ts `Model` the solver needs. A `Model` is assignable to it. */
export interface SolverProposer {
  propose(req: {
    readonly system: string;
    readonly prompt: string;
    /** `prompt` as append-only blocks, so a transport can send each turn as a cache extension (A-400). */
    readonly blocks?: readonly string[] | undefined;
    readonly tool: { readonly name: string; readonly description: string; readonly inputSchema: object };
    readonly signal?: AbortSignal | undefined;
    readonly maxCostUsd?: number | undefined;
    /** The run and step the spend ledger files this call under (A-365). Plain data: no key, no environment. */
    readonly runId?: string | undefined;
    readonly step?: string | undefined;
  }): Promise<{
    readonly input: unknown;
    readonly advice: readonly string[];
    readonly usage: TurnResult['usage'];
    readonly costUsd: number;
    readonly ms: number;
  }>;
}

const SYSTEM = [
  'You are an agent completing a task by calling a live HTTP API. You act only through the tool "solver_turn", once per turn.',
  '',
  'With action "request" you send one HTTP request: a method, a path from the API documentation below (relative, starting with "/", ids filled in, no query string), optional "query" parameters and an optional JSON "body". You then see the response. Only documented methods and paths are accepted; anything else comes back as a rejection.',
  'With action "finish" you end the task. Put your message to the user in "final_reply": what you did and what came of it. State only what the responses you saw support, and say so plainly if you could not complete the task.',
  '',
  'Look things up before you write to them, never guess an id, and read error responses: they say what to fix. Finish when the task is done or cannot be done.',
  '',
  'API documentation (OpenAPI 3.1, JSON):',
].join('\n');

const json = (v: unknown): string => JSON.stringify(v) ?? 'null';

function renderMessage(m: PublicMessage): string {
  switch (m.type) {
    case 'instruction':
      return '';
    case 'tool_call': {
      const q = Object.keys(m.request.query).length === 0 ? '' : ` query ${json(m.request.query)}`;
      const b = m.request.body === undefined ? '' : ` body ${json(m.request.body)}`;
      const said = m.commentary === '' ? '' : `You said: ${m.commentary}\n`;
      return `${said}Request ${m.call_id}: ${m.request.method} ${m.request.path}${q}${b}`;
    }
    case 'tool_result':
      if (m.outcome === 'rejected') return `Result ${m.call_id}: rejected, not sent: ${m.detail ?? ''}`;
      if (m.outcome === 'error') return `Result ${m.call_id}: failed: ${m.detail ?? ''}`;
      return `Result ${m.call_id}: HTTP ${m.status ?? ''}${m.truncated ? ' (cut short)' : ''} ${json(m.body)}`;
    case 'final_reply':
      return `You finished: ${m.text}`;
  }
}

/** The system prompt for a view: the fixed instructions and the public API documentation. */
export const systemOf = (view: TurnView): string => `${SYSTEM}\n${json(view.openapi)}`;

/**
 * The user prompt for a view as append-only blocks: the task, then per turn its counter and the request and result it
 * made. Turn k's blocks are a prefix of turn k+1's, so each call reads the cache the previous one wrote (A-400).
 */
export function blocksOf(view: TurnView): string[] {
  const counter = (k: number): string => `This is turn ${k} of at most ${view.maxTurns}. Call solver_turn.`;
  const blocks = [`Task (${view.difficulty}):\n${view.instruction}`];
  let turn = 1;
  for (const m of view.messages) {
    if (m.type === 'instruction') continue;
    if (m.type === 'tool_call' || m.type === 'final_reply') blocks.push(counter(turn++));
    blocks.push(renderMessage(m));
  }
  blocks.push(counter(view.turn));
  return blocks;
}

/** The user prompt for a view as one text: its blocks joined. */
export const promptOf = (view: TurnView): string => blocksOf(view).join('\n\n');

const pick = (o: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> =>
  Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

/** Keeps the fields the chosen action uses and drops the others. Anything else is left for the episode to reject. */
export function pickDecision(input: unknown): unknown {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return input;
  const o = input as Record<string, unknown>;
  if (o['action'] === 'request') return { action: 'request', ...pick(o, ['method', 'path', 'query', 'body']) };
  if (o['action'] === 'finish') return { action: 'finish', ...pick(o, ['final_reply']) };
  return input;
}

/** The step every solver call is filed under in the spend ledger. */
export const SOLVER_STEP = 'solver';

/**
 * A NextTurn over `proposer`. `signal` goes to the request, so a deadline cancels the HTTP call itself. `runId`, the
 * dataset or episode run, goes on every request with the step `solver`, so `costs --by run` files the call under it.
 */
export function solverTurn(proposer: SolverProposer, runId?: string): NextTurn {
  return async (view, signal) => {
    signal.throwIfAborted();
    const p = await proposer.propose({
      system: systemOf(view),
      prompt: promptOf(view),
      blocks: blocksOf(view),
      tool: { name: SOLVER_TOOL, description: 'Send one API request, or finish the task with your final reply.', inputSchema: SOLVER_TOOL_SCHEMA },
      signal,
      maxCostUsd: view.budgetLeftUsd,
      ...(runId === undefined ? {} : { runId }),
      step: SOLVER_STEP,
    });
    return { decision: pickDecision(p.input), commentary: p.advice.join('\n'), usage: p.usage, costUsd: p.costUsd, ms: p.ms };
  };
}
