/**
 * Replays one task script over the world port: `replay-http.ts <world-dir> <task|auto> <solution|decoy> <world-url>`.
 * The routes come from world.yaml, not from the caller, so a regenerated world keeps the demo working as long as one task
 * has a solution and a decoy that avoid now(). It prints the task name on stdout
 * and logs each call as "  METHOD PATH -> STATUS" on stderr. A throw, from the snippet or an assert, exits 1.
 */
import { execFileSync } from 'node:child_process';
import { loadWorld } from '#engine';

type Snippets = { solution: string; decoy: string };

function usage(): never {
  process.stderr.write('usage: replay-http.ts <world-dir> <task|auto> <solution|decoy> <world-url>\n');
  return process.exit(2);
}

function call(base: string, method: string, path: string, body?: unknown): { status: number; body: unknown } {
  const args = ['-sS', '-g', '--max-time', '30', '-X', method, '-w', '\n%{http_code}'];
  if (body !== undefined) args.push('-H', 'content-type: application/json', '-d', JSON.stringify(body));
  const wire = path.replace(/[^A-Za-z0-9\-._~:/?&=%+!$'()*,;@]/g, (c) => encodeURIComponent(c));
  args.push(base + wire);
  let out: string;
  try {
    out = execFileSync('curl', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const err = e as { stderr?: Buffer | string };
    throw new Error(`curl failed for ${method} ${path}: ${String(err.stderr ?? e).trim()}`);
  }
  const cut = out.lastIndexOf('\n');
  const text = out.slice(0, cut);
  const status = Number(out.slice(cut + 1));
  process.stderr.write(`  ${method} ${path} -> ${status}\n`);
  if (text === '') return { status, body: null };
  try {
    return { status, body: JSON.parse(text) as unknown };
  } catch {
    return { status, body: text };
  }
}

async function main(): Promise<void> {
  const [dir, wanted, which, base] = process.argv.slice(2);
  if (!dir || !wanted || !base || (which !== 'solution' && which !== 'decoy')) usage();
  const loaded = await loadWorld(dir);
  if (!loaded.ok) throw new Error(`cannot load ${dir}: ${JSON.stringify(loaded.error)}`);
  const tasks = (loaded.value as { tasks?: Record<string, { solution?: string; decoys?: { script?: string }[] }> }).tasks ?? {};
  const snippets = (name: string): Snippets | null => {
    const t = tasks[name];
    const solution = t?.solution;
    const decoy = t?.decoys?.[0]?.script;
    return solution && decoy ? { solution, decoy } : null;
  };
  const usable = (name: string): boolean => {
    const s = snippets(name);
    return s !== null && !/\bnow\b/.test(s.solution) && !/\bnow\b/.test(s.decoy);
  };
  const task = wanted === 'auto' ? Object.keys(tasks).find(usable) : wanted;
  if (task === undefined || !usable(task)) throw new Error(`no task in ${dir} with a solution and a decoy that avoid now()`);
  process.stdout.write(`${task}\n`);
  const source = snippets(task)![which];
  let failure: string | null = null;
  const methods = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
  const ctx = {
    api: (method: string, path: string, body?: unknown) => {
      if (!methods.includes(method)) throw new Error(`ctx.api method must be one of ${methods.join(', ')}, got ${JSON.stringify(method) ?? String(method)}`);
      if (typeof path !== 'string') throw new Error(`ctx.api path must be a string such as '/tickets', got ${JSON.stringify(path) ?? String(path)}`);
      return call(base, method, path, body);
    },
    assert(condition: unknown, message: string): void {
      if (condition) return;
      failure ??= String(message);
      throw new Error(`assert failed: ${String(message)}`);
    },
    now(): never {
      throw new Error('ctx.now is not available over HTTP');
    },
  };
  try {
    const fn = new Function(`'use strict'; return (${source}\n);`)() as (c: typeof ctx) => unknown;
    fn(ctx);
  } catch (e) {
    throw new Error(`${task} ${which}: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (failure !== null) throw new Error(`${task} ${which}: assert failed (caught by the script): ${failure}`);
}

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
