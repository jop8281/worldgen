/**
 * `bun run sandbox`: bring a world up in a sandbox, run a command in it, tear it down.
 * Argument parsing only; the backends, sizes and the cost handoff live in sandboxes/registry.ts.
 * Exit codes: 0 ok (exec passes the command's own code through), 1 failure, 2 bad usage.
 */
import path from 'node:path';
import { assertNever } from '#lib/never';
import { boatUsageWindow } from '../boat/client.ts';
import type { BoatSize } from '../costs/pricing.ts';
import { BACKEND_KINDS, type BackendKind } from '../sandboxes/backend.ts';
import { DEFAULT_SIZE_NAME, SIZE_NAMES, captureBoatUsage, discoverBoat, trackBoat, reconcileBoatUsage, reconcileCreate, downDetached, execDetached, upDetached } from '../sandboxes/registry.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '../..');

const USAGE = `usage:
  bun run sandbox -- up <worldDir> --backend openshell|sbx|boat [--size small|default|large] [--port 4000] [--ttl 1800] [--image <img>]
  bun run sandbox -- exec <id> -- <cmd...>
  bun run sandbox -- down <id>
  bun run sandbox -- discover [--org <wallet>] [--day YYYY-MM-DD]
  bun run sandbox -- track [--org <wallet>]
  bun run sandbox -- capture-usage --day YYYY-MM-DD [--org <wallet>]
  bun run sandbox -- reconcile-create <reservation-uuid>
  bun run sandbox -- reconcile-usage <observed-reservation-uuid> [--org <wallet>]

up prints the sandbox id and the world URL. Only the world port is exposed; the admin port stays inside.
--image picks the base image on openshell and sbx, such as node:22-bookworm; boat takes none.
Sizes: small is 2 CPU and 4 GB (the default), default 4 and 8, large 8 and 16. boat needs BOAT_API_KEY and WORLDGEN_BOAT_ORG.
Boat provisioning also needs BOAT_USD_PER_COMPUTE_HOUR and a finite WORLDGEN_MAX_DAILY_SANDBOX_USD,
WORLDGEN_MAX_DAILY_USD or WORLDGEN_MAX_TOTAL_USD. The full TTL cost is reserved before creation.
reconcile-create replays a persisted create key within 24 hours and immediately archives the VM.
A failed original create may provision on replay; its existing reservation covers that TTL.
Existing VMs can still be stopped when no cap or price is configured, or when a cap is exhausted.
track records owned, non-archived inventory as unresolved exposure; it never creates or stops VMs.
Inspection keys identify provenance, not the payer. Unknown exposure requires verified billing
reconciliation; tracking does not import dollars or clear it with a configured-rate estimate.
down archives tracked VMs and records a verified cutoff while leaving unknown billing pending.
capture-usage saves UTC-day list-price receipts separately from spend; it never clears unknown holds.
reconcile-usage requires exact provider coverage from creation through that cutoff. It replaces
covered estimates with list-price estimates and resolves the observed hold; it does not verify an invoice.
`;

class UsageError extends Error {}

type Command =
  | { readonly kind: 'up'; readonly worldDir: string; readonly backend: BackendKind; readonly size: BoatSize; readonly port: number; readonly ttl: number | undefined; readonly image: string | undefined }
  | { readonly kind: 'exec'; readonly id: string; readonly cmd: readonly string[] }
  | { readonly kind: 'down'; readonly id: string }
  | { readonly kind: 'reconcile-create'; readonly id: string }
  | { readonly kind: 'reconcile-usage'; readonly id: string; readonly org?: string }
  | { readonly kind: 'discover'; readonly org?: string; readonly day?: string }
  | { readonly kind: 'track'; readonly org?: string }
  | { readonly kind: 'capture-usage'; readonly day: string; readonly org?: string }
  | { readonly kind: 'help' };

function oneOf<T extends string>(flag: string, v: string, allowed: readonly T[]): T {
  const hit = allowed.find((a) => a === v);
  if (hit === undefined) throw new UsageError(`${flag} must be one of ${allowed.join(', ')}, got ${v}`);
  return hit;
}

function int(flag: string, v: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new UsageError(`${flag} needs an integer from ${min} to ${max}, got ${v}`);
  return n;
}

function parse(argv: readonly string[]): Command {
  const [sub, ...rest] = argv;
  const own = argv.includes('--') ? argv.slice(0, argv.indexOf('--')) : argv;
  if (sub === undefined || own.some((a) => a === '--help' || a === '-h')) return { kind: 'help' };
  if (sub === 'exec') {
    const [id, sep, ...cmd] = rest;
    if (id === undefined || sep !== '--' || cmd.length === 0) throw new UsageError('exec needs <id> -- <cmd...>');
    return { kind: 'exec', id, cmd };
  }
  if (sub === 'discover' || sub === 'capture-usage') {
    let org: string | undefined;
    let day: string | undefined;
    for (let i = 0; i < rest.length; i += 2) {
      const flag = rest[i];
      const value = rest[i + 1];
      if (value === undefined || value === '' || value.startsWith('--')) throw new UsageError(`${sub} options need a value`);
      if (flag === '--org' && org === undefined) org = value;
      else if (flag === '--day' && day === undefined) {
        try { boatUsageWindow(value); } catch { throw new UsageError('--day needs a valid UTC date (YYYY-MM-DD)'); }
        day = value;
      } else throw new UsageError(`${sub} accepts --org <wallet> and --day YYYY-MM-DD once each`);
    }
    if (sub === 'capture-usage') {
      if (day === undefined) throw new UsageError('capture-usage requires --day YYYY-MM-DD');
      return { kind: sub, day, ...(org === undefined ? {} : { org }) };
    }
    return { kind: 'discover', ...(org === undefined ? {} : { org }), ...(day === undefined ? {} : { day }) };
  }
  if (sub === 'track') {
    if (rest.length === 0) return { kind: 'track' };
    if (rest.length === 2 && rest[0] === '--org' && rest[1] !== undefined && rest[1] !== '' && !rest[1].startsWith('--')) return { kind: 'track', org: rest[1] };
    throw new UsageError('track accepts --org <wallet> once');
  }
  if (sub === 'reconcile-create') {
    if (rest.length !== 1 || rest[0] === undefined) throw new UsageError('reconcile-create needs exactly one reservation UUID');
    return { kind: 'reconcile-create', id: rest[0] };
  }
  if (sub === 'reconcile-usage') {
    if (rest[0] !== undefined && !rest[0].startsWith('--')) {
      if (rest.length === 1) return { kind: sub, id: rest[0] };
      if (rest.length === 3 && rest[1] === '--org' && rest[2] !== undefined && rest[2] !== '' && !rest[2].startsWith('--')) return { kind: sub, id: rest[0], org: rest[2] };
    }
    throw new UsageError('reconcile-usage needs <observed-reservation-uuid> and optional --org <wallet>');
  }
  if (sub === 'down') {
    if (rest.length !== 1 || rest[0] === undefined) throw new UsageError('down needs exactly one <id>');
    return { kind: 'down', id: rest[0] };
  }
  if (sub !== 'up') throw new UsageError(`unknown command ${sub}`);
  let worldDir: string | undefined;
  let backend: BackendKind | undefined;
  let size: BoatSize = DEFAULT_SIZE_NAME;
  let port = 4000;
  let ttl: number | undefined;
  let image: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]!;
    const value = (): string => {
      const v = rest[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${flag} needs a value`);
      return v;
    };
    if (flag === '--backend') backend = oneOf(flag, value(), BACKEND_KINDS);
    else if (flag === '--size') size = oneOf(flag, value(), SIZE_NAMES);
    else if (flag === '--port') port = int(flag, value(), 1, 65534);
    else if (flag === '--ttl') ttl = int(flag, value(), 60, 86400);
    else if (flag === '--image') image = value();
    else if (flag.startsWith('-')) throw new UsageError(`unknown option ${flag}`);
    else if (worldDir === undefined) worldDir = path.resolve(flag);
    else throw new UsageError(`unexpected argument ${flag}`);
  }
  if (worldDir === undefined) throw new UsageError('up needs <worldDir>');
  if (backend === undefined) throw new UsageError(`up needs --backend ${BACKEND_KINDS.join('|')}`);
  if (ttl !== undefined && backend !== 'boat') throw new UsageError('--ttl applies to the boat backend only');
  if (image !== undefined && backend === 'boat') throw new UsageError('--image applies to the openshell and sbx backends only');
  return { kind: 'up', worldDir, backend, size, port, ttl, image };
}

async function main(argv: readonly string[]): Promise<number> {
  let cmd: Command;
  try {
    cmd = parse(argv);
  } catch (e) {
    if (!(e instanceof UsageError)) throw e;
    process.stderr.write(`${e.message}\n${USAGE}`);
    return 2;
  }
  const deps = { env: process.env };
  try {
    switch (cmd.kind) {
      case 'help':
        process.stdout.write(USAGE);
        return 0;
      case 'up': {
        const rec = await upDetached(
          { kind: cmd.backend, codeDir: CODE_DIR, worldDir: cmd.worldDir, port: cmd.port, size: cmd.size, ...(cmd.ttl === undefined ? {} : { ttlSeconds: cmd.ttl }), ...(cmd.image === undefined ? {} : { image: cmd.image }) },
          deps,
        );
        process.stdout.write(`${rec.id}\n${rec.url ?? ''}\n`);
        return 0;
      }
      case 'exec': {
        const res = await execDetached(cmd.id, cmd.cmd, deps);
        process.stdout.write(res.stdout);
        process.stderr.write(res.stderr);
        return res.exitCode;
      }
      case 'discover':
        process.stdout.write(`${JSON.stringify(await discoverBoat(deps, cmd.org, cmd.day), null, 2)}\n`);
        return 0;
      case 'track':
        process.stdout.write(`${JSON.stringify(await trackBoat(deps, cmd.org), null, 2)}\n`);
        return 0;
      case 'capture-usage':
        process.stdout.write(`${JSON.stringify(await captureBoatUsage(deps, cmd.day, cmd.org), null, 2)}\n`);
        return 0;
      case 'reconcile-usage':
        process.stdout.write(`${JSON.stringify(await reconcileBoatUsage(cmd.id, deps, cmd.org), null, 2)}\n`);
        return 0;
      case 'reconcile-create': {
        const id = await reconcileCreate(cmd.id, deps);
        process.stdout.write(`${id} archived; creation reconciled at configured estimate rates\n`);
        return 0;
      }
      case 'down': {
        const closed = await downDetached(cmd.id, deps);
        process.stdout.write(`${cmd.id} down${'billing' in closed ? '; past billing remains unknown' : ''}\n`);
        return 0;
      }
      default:
        return assertNever(cmd);
    }
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
