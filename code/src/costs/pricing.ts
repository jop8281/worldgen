/**
 * Who pays and at what rate, for the spend ledger. Model prices are not here: they stay in
 * worldgen/llm.ts (DEFAULT_PRICES), and the meter records the costUsd the model client reports.
 */
import { createHash } from 'node:crypto';
import { assertNever } from '#lib/never';
import { roundUsd, type Provider } from './ledger.ts';

/** `sha256:` + the first 12 hex of sha256(key). The only form in which a key reaches the ledger. */
export function fingerprint(key: string): string {
  if (key.trim() === '') throw new Error('cannot fingerprint an empty key');
  return `sha256:${createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 12)}`;
}

export const CLI_ACCOUNT = 'claude-cli';
export const LOCAL_ACCOUNT = 'local';

/**
 * The ledger account for a provider: the key fingerprint for anthropic (LLM_KEY) and boat,
 * `claude-cli` for the CLI transport (billed to its own login), `local` for local sandboxes.
 */
export function accountFor(provider: Provider, key?: string): string {
  switch (provider) {
    case 'anthropic':
    case 'boat':
      if (key === undefined) throw new Error(`${provider} spend needs the key to fingerprint`);
      return fingerprint(key);
    case 'claude-cli':
      return CLI_ACCOUNT;
    case 'openshell':
    case 'sbx':
      return LOCAL_ACCOUNT;
    default:
      return assertNever(provider);
  }
}

/** boat.dev public sizes: compute is billed per hour times the size multiplier. */
export const BOAT_SIZES = {
  small: { vcpu: 2, memoryGb: 4, multiplier: 0.5 },
  default: { vcpu: 4, memoryGb: 8, multiplier: 1 },
  large: { vcpu: 8, memoryGb: 16, multiplier: 2 },
} as const satisfies Record<string, { vcpu: number; memoryGb: number; multiplier: number }>;
export type BoatSize = keyof typeof BOAT_SIZES;

export function isBoatSize(s: string): s is BoatSize {
  return Object.hasOwn(BOAT_SIZES, s);
}

export const RATE_ENV = 'BOAT_USD_PER_COMPUTE_HOUR';
export const RATE_NOTE = `set ${RATE_ENV}`;

/**
 * The boat compute-hour rate from the environment. boat.dev publishes no rate this repo can cite,
 * so without the variable the rate is unknown (null) and sandbox time is recorded unpriced, never as $0.
 */
export function computeHourRate(env: Readonly<Record<string, string | undefined>>): { usdPerComputeHour: number | null; note?: string } {
  const raw = env[RATE_ENV];
  if (raw === undefined || raw.trim() === '') return { usdPerComputeHour: null, note: RATE_NOTE };
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${RATE_ENV} must be a non-negative number of USD, got "${raw}"`);
  return { usdPerComputeHour: n };
}

/** hours x multiplier x rate, rounded to a billionth of a dollar. */
export function sandboxUsd(seconds: number, multiplier: number, usdPerComputeHour: number): number {
  return roundUsd((seconds / 3600) * multiplier * usdPerComputeHour);
}
