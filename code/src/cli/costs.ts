/**
 * The spend CLI: totals from the spend ledger, grouped, plus the caps and what is left of them.
 * Argument parsing and printing only; every number comes from src/costs/ledger.ts.
 * Exit codes: 0 ok, 1 release refused, 2 bad usage.
 *
 *   bun run costs [-- --since 2026-10-06] [--by provider|kind|account|day|run] [--json] [--file <ledger>]
 */
import {
  CAPS,
  CAP_NAMES,
  GROUP_BY,
  METERS,
  PROVIDERS,
  SPEND_KINDS,
  capStatus,
  capsFromEnv,
  filterEvents,
  groupEvents,
  ledgerPath,
  meterReport,
  openLedger,
  parseSince,
  sumEvents,
  type CapLine,
  type CapName,
  type GroupBy,
  type Provider,
  type SpendCaps,
  type Totals,
} from '../costs/ledger.ts';
import { parseArgs as parseFlags } from 'node:util';
import { boatReceiptsPath, openBoatReceipts } from '../costs/boat-receipts.ts';

const USAGE = `usage: costs [--since <YYYY-MM-DD>] [--by ${GROUP_BY.join('|')}] [--json] [--file <ledger.jsonl>]
       costs release <claim-id> [--usd <n> [--estimated]] [--file <ledger.jsonl>]
       costs reprice-unpriced --provider <name> --usd-per-compute-hour <n> --note <text> [--file <ledger.jsonl>]

Prints spend from the ledger (WORLDGEN_COSTS_FILE, default ~/.worldgen/costs.jsonl): the llm and
sandbox meters (today and all time), current pending obligations, the spend grouped, and the caps with the budget they leave:
${CAP_NAMES.map((c) => CAPS[c].env).join(', ')}.
Pending obligations are shown regardless of --since; they are not settled spending.
Boat receipts saved by sandbox capture-usage appear separately as list-price usage evidence.

release closes an abandoned claim (its process died before settling). With --usd it records that
final cost (--estimated marks it as an estimate). Without it billing stays unknown, and caps count
the claim at its admitted bound. Open model claims also expire on their own after 2 hours.

reprice-unpriced records a user's rate decision: every earlier unpriced sandbox line of that provider
that has recorded seconds reads as estimated spend at seconds / 3600 x multiplier x rate. It appends
one line and edits none; lines written after it are not repriced.
`;

const isGroupBy = (s: string): s is GroupBy => GROUP_BY.some((g) => g === s);
const usd = (n: number): string => `$${n.toFixed(4)}`;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

function usageError(message: string): number {
  process.stderr.write(`${message}\n${USAGE}`);
  return 2;
}

type Args = { since: string | undefined; by: GroupBy; json: boolean; file: string | undefined };

function parseArgs(argv: readonly string[]): Args | string {
  const args: Args = { since: undefined, by: 'provider', json: false, file: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    const value = (): string | undefined => {
      i += 1;
      return argv[i];
    };
    if (a === '--json') args.json = true;
    else if (a === '--since') {
      const v = value();
      if (v === undefined) return '--since needs a date';
      args.since = v;
    } else if (a === '--by') {
      const v = value();
      if (v === undefined || !isGroupBy(v)) return `--by takes one of ${GROUP_BY.join(', ')}`;
      args.by = v;
    } else if (a === '--file') {
      const v = value();
      if (v === undefined) return '--file needs a path';
      args.file = v;
    } else return `unknown argument ${a}`;
  }
  return args;
}

/** Priced usd, and unpriced time beside it: unpriced seconds are never shown as $0. */
function money(t: Pick<Totals, 'usd' | 'unpriced' | 'unpricedSeconds'>): string {
  if (t.unpriced === 0) return usd(t.usd);
  const unpriced = `unpriced: ${t.unpricedSeconds} sandbox-seconds`;
  return t.usd === 0 ? unpriced : `${usd(t.usd)} + ${unpriced}`;
}

function capText(cap: CapName, line: CapLine | undefined, day: string): string {
  const name = cap.padEnd(18);
  if (line === undefined) return `  ${name}  none (set ${CAPS[cap].env})`;
  const window = CAPS[cap].window === 'day' ? `spent ${day}` : 'spent';
  const pending = line.reservedUsd === undefined ? '' : `  reserved ${usd(line.reservedUsd)}`;
  const unknown = line.unpriced === undefined ? '' : `  unknown billing ${line.unpriced}`;
  return `  ${name}  cap ${usd(line.capUsd)}  ${window} ${usd(line.spentUsd)}${pending}${unknown}  remaining ${usd(line.remainingUsd)}`;
}

function release(argv: readonly string[]): number {
  const [id, ...rest] = argv;
  if (id === undefined || id.startsWith('--')) return usageError('release needs a claim id');
  let usdArg: number | undefined;
  let estimated = false;
  let file: string | undefined;
  for (let i = 0; i < rest.length; i += 1) {
    const a = rest[i];
    if (a === '--estimated') estimated = true;
    else if (a === '--usd') {
      const n = Number(rest[(i += 1)]);
      if (!Number.isFinite(n) || n < 0) return usageError('--usd takes a non-negative number');
      usdArg = n;
    } else if (a === '--file') {
      file = rest[(i += 1)];
      if (file === undefined) return usageError('--file needs a path');
    } else return usageError(`unknown argument ${a}`);
  }
  if (estimated && usdArg === undefined) return usageError('--estimated needs --usd');
  try {
    const e = openLedger(file ?? ledgerPath(process.env)).releaseClaim(id, usdArg, estimated);
    process.stdout.write(`released ${id}: ${e.usd === null ? `billing unknown${e.exposureUsd === undefined ? '' : `, counted at ${usd(e.exposureUsd)}`}` : usd(e.usd)}\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

function repriceUnpriced(argv: readonly string[]): number {
  const p = tryArgs(() => parseFlags({ args: [...argv], options: { provider: { type: 'string' }, 'usd-per-compute-hour': { type: 'string' }, note: { type: 'string' }, file: { type: 'string' } } }));
  if (typeof p === 'string') return usageError(p);
  const { provider, note, file } = p.values;
  const rate = Number(p.values['usd-per-compute-hour']);
  if (provider === undefined || !PROVIDERS.some((x) => x === provider)) return usageError(`--provider takes one of ${PROVIDERS.join(', ')}`);
  if (!Number.isFinite(rate) || rate <= 0) return usageError('--usd-per-compute-hour takes a positive number');
  if (note === undefined || note.trim() === '') return usageError('--note is required: say whose decision the rate is');
  try {
    const n = openLedger(file ?? ledgerPath(process.env)).repriceUnpriced(provider as Provider, rate, note);
    process.stdout.write(`repriced ${n} unpriced ${provider} sandbox line${n === 1 ? '' : 's'} at $${rate}/compute-hour\n`);
    return 0;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
}

const tryArgs = <T>(f: () => T): T | string => {
  try {
    return f();
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
};

function main(argv: readonly string[]): number {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (argv[0] === 'release') return release(argv.slice(1));
  if (argv[0] === 'reprice-unpriced') return repriceUnpriced(argv.slice(1));
  const args = parseArgs(argv);
  if (typeof args === 'string') return usageError(args);
  let caps: SpendCaps;
  try {
    if (args.since !== undefined) parseSince(args.since);
    caps = capsFromEnv(process.env);
  } catch (err) {
    return usageError(err instanceof Error ? err.message : String(err));
  }

  const ledger = openLedger(args.file ?? ledgerPath(process.env));
  const { events, corrupt, foreign, reservations } = ledger.read();
  const captured = openBoatReceipts(boatReceiptsPath(ledger.path)).read();
  // Unknown-cost calls caps count at their claim's bound (A-164): a large bound is a guess to settle, not spend.
  const unknownAtBound = events.flatMap(e => e.usd === null && e.reservationId !== undefined ? [{ reservationId: e.reservationId, at: e.t, kind: e.kind, provider: e.provider, runId: e.runId ?? null, countedUsd: e.exposureUsd ?? null }] : []);
  const partialModelUsage = events.flatMap(e => e.partialModelUsage === undefined ? [] : [{ reservationId: e.reservationId ?? null, observedAt: e.t, account: e.account, runId: e.runId ?? null, model: e.model ?? null, step: e.step ?? null, finalBilling: 'unknown', evidence: 'observed_lower_bound', ...e.partialModelUsage }]);
  const pending = reservations.map(r => ({ id: r.id, kind: r.kind, provider: r.provider, account: r.account, startedAt: r.origin === 'inventory' ? null : r.t, ...(r.closedAt === undefined ? {} : { closedAt: r.closedAt }), ...(r.origin === 'inventory' ? { origin: r.origin, accountBasis: r.accountBasis, observedAt: r.t } : {}), runId: r.runId ?? null, model: r.model ?? null, step: r.step ?? null, sandboxId: r.sandboxId ?? null, boundUsd: r.boundUsd, remainingUsd: r.remainingUsd }));
  const selected = filterEvents(events, { since: args.since });
  const rows = groupEvents(selected, args.by);
  const total = sumEvents(selected, corrupt);
  const now = ledger.now();
  const status = capStatus(ledger, caps, now);
  const meters = meterReport(events, now);

  if (args.json) {
    const capsOut = Object.fromEntries(CAP_NAMES.map((c) => [c, status.lines[c] ?? null]));
    const metersOut = { day: meters.day, ...Object.fromEntries(SPEND_KINDS.map((k) => [METERS[k].name, meters.kinds[k]])), total: meters.total };
    const out = { file: ledger.path, since: args.since ?? null, by: args.by, meters: metersOut, rows, total, ...(foreign > 0 ? { foreignLines: foreign } : {}), pending, caps: { day: status.day, ...capsOut }, ...(unknownAtBound.length === 0 ? {} : { unknownAtBound }), ...(partialModelUsage.length === 0 ? {} : { partialModelUsage }), ...(captured.receipts.length > 0 || captured.corrupt > 0 ? { boatUsageReceipts: captured } : {}) };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return 0;
  }

  const meterLine = (name: string, one: string, many: string, m: { today: Totals; allTime: Totals }): string =>
    `  ${name.padEnd(7)}  today ${money(m.today)}  all time ${money(m.allTime)}  ${m.allTime.events} ${m.allTime.events === 1 ? one : many}  ${m.allTime.seconds} s`;
  const width = Math.max(5, ...rows.map((r) => r.key.length));
  const row = (key: string, t: Pick<Totals, 'usd' | 'events' | 'estimated' | 'unpriced' | 'unpricedSeconds'>): string =>
    `  ${key.padEnd(width)}  ${money(t).padStart(11)}  ${plural(t.events, 'event')}${t.estimated > 0 ? `, ${t.estimated} estimated` : ''}`;
  const lines = [
    `ledger ${ledger.path}`,
    `meters (today is ${meters.day} UTC)`,
    ...SPEND_KINDS.map((k) => meterLine(METERS[k].name, METERS[k].one, METERS[k].many, meters.kinds[k])),
    meterLine('total', 'event', 'events', meters.total),
    ...(args.since === undefined ? [] : [`since ${args.since}`]),
    `by ${args.by}`,
    ...rows.map((r) => row(r.key, r)),
    row('total', total),
    ...(events.some(e => e.boatUsage !== undefined) ? ['Reconciled Boat dollars are list-price estimates; account groups identify inspection keys, not payers.'] : []),
    ...(corrupt > 0 ? [`skipped ${plural(corrupt, 'corrupt line')}`] : []),
    ...(foreign > 0 ? [`skipped ${plural(foreign, 'foreign line')} written by newer code (A-201); update this checkout to read them`] : []),
    ...(pending.length === 0 ? [] : [
      `pending obligations (${pending.length}; not settled spending)`,
      ...pending.map(r => `  ${r.id}  ${r.kind}  ${r.provider}  ${r.account}  ${r.origin === 'inventory' ? `observed ${r.observedAt}` : `started ${r.startedAt}`}  ${r.remainingUsd === null ? 'billing unknown' : `reserved ${usd(r.remainingUsd)}`}\n    run ${r.runId ?? '-'}  model ${r.model ?? '-'}  step ${r.step ?? '-'}  VM ${r.sandboxId ?? '-'}${r.origin === 'inventory' ? '  inventory observation; inspection key, payer unverified' : ''}${r.closedAt === undefined ? '' : `  verified closed ${r.closedAt}; usage reconciliation pending`}`),
    ]),
    ...(captured.receipts.length === 0 && captured.corrupt === 0 ? [] : [
      'Boat usage receipts (all stored UTC days; list-price estimates, separate from settled spend)',
      ...captured.receipts.map(r => `  VM ${r.sandboxId}  requested ${r.requestedWindow.since.slice(0, 10)}  ${r.coverage}  returned ${r.returnedWindow.since} to ${r.returnedWindow.until}  ${usd(r.listPriceUsd)}  ${r.billableSeconds} billable seconds (size multiplier already applied)  ${r.running ? 'meter moving' : 'meter paused or stopped'}  wallet ${r.walletStatus}`),
      ...(captured.corrupt === 0 ? [] : [`  ${captured.corrupt} corrupt receipt records; receipt evidence is incomplete`]),
    ]),
    ...(unknownAtBound.length === 0 ? [] : [
      'Calls with unknown final billing (caps count each at its admitted bound; settle one with `costs release <claim> --usd <n>` once its cost is known)',
      ...unknownAtBound.map(r => `  claim ${r.reservationId}  ${r.kind}  ${r.provider}  at ${r.at}  counted ${r.countedUsd === null ? 'unknown (no bound): caps refuse until it is settled' : usd(r.countedUsd)}  run ${r.runId ?? '-'}`),
    ]),
    ...(partialModelUsage.length === 0 ? [] : [
      'Observed partial model usage (lower bounds; final billing unknown, separate from settled spending)',
      ...partialModelUsage.map(r => `  claim ${r.reservationId ?? '-'}  ${r.account}  observed ${usd(r.observedCostUsd)}  ${r.inputTokens} input / ${r.outputTokens} output tokens  run ${r.runId ?? '-'}  step ${r.step ?? '-'}`),
    ]),
    'caps',
    ...CAP_NAMES.map((c) => capText(c, status.lines[c], status.day)),
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

process.exitCode = main(process.argv.slice(2));
