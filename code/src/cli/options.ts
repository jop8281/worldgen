/**
 * The options the model-calling CLIs repeat (YOS-203): `--model`, `--transport`, `--budget-usd` and `--max-minutes`,
 * read into worldgen.config.json overrides, the rule for an option's value, the config file they override and the
 * refusal a bad command line gets. Parsing only. Each CLI keeps its own walk over argv, since their positionals,
 * subcommands and flags differ; test/cli-options-golden.test.ts pins what each one accepts and refuses.
 */
import path from 'node:path';
import { assertNever } from '#lib/never';
import { TRANSPORTS, type Config, type Transport } from '../worldgen/config.ts';

/** The settings file the CLIs read. The options below override it for one command. */
export const CONFIG_FILE = path.resolve(import.meta.dirname, '../../worldgen.config.json');

/** A bad command line. The CLI prints the message and exits 2, before any model call. */
export class UsageError extends Error {}

/** The options that override worldgen.config.json. Each takes one value. modelOverrides checks them in this order; eval checks them in argv order. */
export const MODEL_OPTIONS = ['--model', '--transport', '--budget-usd', '--max-minutes'] as const;
export type ModelOption = (typeof MODEL_OPTIONS)[number];
export const isModelOption = (arg: string): arg is ModelOption => MODEL_OPTIONS.some((o) => o === arg);

/**
 * The value `flag` was given, `next` on argv. Missing, or another long option, is refused. A blank value is refused
 * too, except where a CLI passes `blank: 'accept'` (eval, until YOS-203 settles it).
 */
export function optionValue(flag: string, next: string | undefined, blank: 'refuse' | 'accept' = 'refuse'): string {
  if (next === undefined || next.startsWith('--') || (blank === 'refuse' && next.trim() === '')) throw new UsageError(`${flag} needs a value`);
  return next;
}

/** A positive finite number, as `Number` reads it, so "1e2" is 100. */
export function positiveNumber(flag: string, v: string): number {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`${flag} needs a positive number, got ${v}`);
  return n;
}

export function oneOf<T extends string>(flag: string, v: string, allowed: readonly T[]): T {
  const hit = allowed.find((a) => a === v);
  if (hit === undefined) throw new UsageError(`${flag} must be one of ${allowed.join(', ')}, got ${v}`);
  return hit;
}

export const transportOption = (flag: string, v: string): Transport => oneOf(flag, v, TRANSPORTS);

/** The override one option sets. */
export function modelOverride(option: ModelOption, v: string): Partial<Config> {
  switch (option) {
    case '--model':
      return { model: v };
    case '--transport':
      return { transport: transportOption(option, v) };
    case '--budget-usd':
      return { maxCostUsd: positiveNumber(option, v) };
    case '--max-minutes':
      return { maxMinutes: positiveNumber(option, v) };
    default:
      return assertNever(option);
  }
}

/** The overrides of every option `given` holds, checked in MODEL_OPTIONS order, so the first bad one is the one named. */
export function modelOverrides(given: (option: ModelOption) => string | undefined): Partial<Config> {
  const overrides: Partial<Config> = {};
  for (const option of MODEL_OPTIONS) {
    const v = given(option);
    if (v !== undefined) Object.assign(overrides, modelOverride(option, v));
  }
  return overrides;
}
