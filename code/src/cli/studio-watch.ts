/**
 * `bun run studio-watch`: one check of a running Studio (YOS-237). Argument parsing, the two GETs, printing and the exit
 * status only; the signals and the alert rules are studio/watch.ts. The token comes only from WORLDGEN_STUDIO_TOKEN,
 * travels only as the bearer header of GET /api/costs, and is scrubbed from every line printed.
 * Exit codes: 0 healthy, 1 at least one ALERT line, 2 bad usage.
 *
 *   bun run studio-watch -- [url] [--max-5xx-rate 0.05] [--min-requests 20] [--spend-share 0.8] [--attempts 2] [--retry-ms 10000] [--timeout-ms 5000]
 */
import { z } from 'zod';
import { DEFAULT_LIMITS, okLines, parseDailyCap, parseHealth, studioAlerts, type CostsObservation, type Limits, type Observation, type Parsed } from '../studio/watch.ts';

const DEFAULT_URL = 'http://127.0.0.1:8787';
const DEFAULTS = { attempts: 2, retryMs: 10_000, timeoutMs: 5_000 };

const USAGE = `usage: bun run studio-watch -- [url] [--max-5xx-rate ${DEFAULT_LIMITS.max5xxRate}] [--min-requests ${DEFAULT_LIMITS.minRequests}] [--spend-share ${DEFAULT_LIMITS.spendShare}] [--attempts ${DEFAULTS.attempts}] [--retry-ms ${DEFAULTS.retryMs}] [--timeout-ms ${DEFAULTS.timeoutMs}]

One check of a running Studio (default ${DEFAULT_URL}), then exit. It reads GET /api/health up to
--attempts times, --retry-ms apart, each within --timeout-ms; then GET /api/costs once, with
Authorization: Bearer <WORLDGEN_STUDIO_TOKEN> when that is set. The token is never printed.
Healthy: OK lines on stdout, exit 0. Otherwise one line per problem on stdout, exit 1:
  ALERT studio.down: --attempts health reads in a row failed
  ALERT studio.5xx_rate: above --max-5xx-rate of at least --min-requests answers in the last 300 s were 5xx
  ALERT spend.cap_share: today's spend reached --spend-share of WORLDGEN_MAX_DAILY_USD
  ALERT spend.unchecked: /api/costs failed, no daily cap is set, or today's cap line has unknown-cost entries
Bad usage: stderr, exit 2.
One check per run: schedule it every 5 minutes (cron, a launchd agent or a systemd timer) and route
the ALERT lines and the exit status to the alert channel.
`;

class UsageError extends Error {}

type Args = { readonly url: string; readonly limits: Limits; readonly attempts: number; readonly retryMs: number; readonly timeoutMs: number };

const share = (n: number): boolean => n >= 0 && n <= 1;
const count = (least: number) => (n: number): boolean => Number.isInteger(n) && n >= least;

function parse(argv: readonly string[]): Args | 'help' {
  if (argv.some((a) => a === '--help' || a === '-h')) return 'help';
  let url: string | undefined;
  const limits = { ...DEFAULT_LIMITS };
  const timing = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i]!;
    const number = (ok: (n: number) => boolean, what: string): number => {
      const v = argv[++i];
      const n = Number(v);
      if (v === undefined || v.trim() === '' || !ok(n)) throw new UsageError(`${a} needs ${what}, got ${v ?? 'nothing'}`);
      return n;
    };
    if (a === '--') continue;
    if (a === '--max-5xx-rate') limits.max5xxRate = number(share, 'a number from 0 to 1');
    else if (a === '--min-requests') limits.minRequests = number(count(1), 'an integer of at least 1');
    else if (a === '--spend-share') limits.spendShare = number((n) => n > 0 && n <= 1, 'a number above 0 and at most 1');
    else if (a === '--attempts') timing.attempts = number(count(1), 'an integer of at least 1');
    else if (a === '--retry-ms') timing.retryMs = number(count(0), 'an integer of at least 0');
    else if (a === '--timeout-ms') timing.timeoutMs = number(count(1), 'an integer of at least 1');
    else if (a.startsWith('-') || url !== undefined) throw new UsageError(`unknown argument ${a}`);
    else url = a;
  }
  const base = url ?? DEFAULT_URL;
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    throw new UsageError(`the url must be an http(s) URL such as ${DEFAULT_URL}, got ${base}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new UsageError(`the url must be an http(s) URL such as ${DEFAULT_URL}, got ${base}`);
  return { url: base.replace(/\/+$/, ''), limits, ...timing };
}

const codeOf = (x: unknown): unknown => (typeof x === 'object' && x !== null && 'code' in x ? x.code : undefined);
const nameOf = (x: unknown): unknown => (typeof x === 'object' && x !== null && 'name' in x ? x.name : undefined);

/** One plain reason for a fetch that threw, the same under Node and Bun. */
function whyOf(e: unknown, timeoutMs: number): string {
  if (nameOf(e) === 'TimeoutError' || nameOf(e) === 'AbortError') return `no answer within ${timeoutMs} ms`;
  const cause = e instanceof Error ? e.cause : undefined;
  const c = codeOf(e) ?? codeOf(cause);
  if (c === 'ECONNREFUSED' || c === 'ConnectionRefused') return 'connection refused';
  const message = e instanceof Error ? e.message : String(e);
  return cause instanceof Error ? `${message}: ${cause.message}` : message;
}

const studioError = z.object({ error: z.object({ code: z.string(), message: z.string() }) });

/** The error code and message of a studio failure body, else its first 200 characters. */
function errorText(text: string): string {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const err = studioError.safeParse(body);
  return err.success ? `${err.data.error.code}: ${err.data.error.message}` : text.slice(0, 200).trim() || '(empty body)';
}

/** One GET and its parsed body, or why it failed: no answer, a status other than 200, or a body that does not parse. */
async function read<T>(url: string, route: string, headers: Record<string, string>, timeoutMs: number, parseBody: (text: string) => Parsed<T>): Promise<Parsed<T>> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(`${url}${route}`, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    text = await res.text();
  } catch (e) {
    return { ok: false, why: whyOf(e, timeoutMs) };
  }
  if (res.status !== 200) return { ok: false, why: `answered ${res.status} ${errorText(text)}` };
  const parsed = parseBody(text);
  return parsed.ok ? parsed : { ok: false, why: `answered a body the watcher cannot read: ${parsed.why}` };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function observe(args: Args, token: string | undefined): Promise<Observation> {
  let why = '';
  for (let attempt = 1; attempt <= args.attempts; attempt += 1) {
    const health = await read(args.url, '/api/health', {}, args.timeoutMs, parseHealth);
    if (health.ok) {
      const daily = await read(args.url, '/api/costs', token === undefined ? {} : { authorization: `Bearer ${token}` }, args.timeoutMs, parseDailyCap);
      const costs: CostsObservation = daily.ok ? { kind: 'ok', daily: daily.value } : { kind: 'failed', why: daily.why };
      return { health: 'up', build: health.value.build, traffic: health.value.traffic, costs };
    }
    why = health.why;
    if (attempt < args.attempts) await sleep(args.retryMs);
  }
  return { health: 'down', attempts: args.attempts, why };
}

async function main(argv: readonly string[]): Promise<number> {
  const raw = process.env['WORLDGEN_STUDIO_TOKEN'];
  const token = raw === undefined || raw === '' ? undefined : raw;
  const scrub = (line: string): string => (token === undefined ? line : line.split(token).join('<token>'));
  let args: Args | 'help';
  try {
    args = parse(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`${scrub(e.message)}\n${USAGE}`);
    return 2;
  }
  if (args === 'help') {
    process.stdout.write(USAGE);
    return 0;
  }
  const obs = await observe(args, token);
  const alerts = studioAlerts(obs, args.limits);
  const lines = alerts.length === 0 ? okLines(obs, args.limits) : alerts.map((a) => `ALERT ${a.code}: ${a.text}`);
  process.stdout.write(`${lines.map(scrub).join('\n')}\n`);
  return alerts.length === 0 ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
