/**
 * Shared CLI wiring for model calls: picks the transport, meters every call into the spend
 * ledger (YOS-87), loads the few-shot example world and writes REPORT.md. Used by the worldgen, eval and live CLIs.
 * Keys are read from the environment only and never printed; the ledger stores a fingerprint.
 */
import { accessSync, constants, statSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { checkWorld, loadWorld, type World } from '#engine';
import { assertNever } from '#lib/never';
import { capsFromEnv, ledgerPath, openLedger } from '../costs/ledger.ts';
import { meteredModel } from '../costs/meter.ts';
import { accountFor } from '../costs/pricing.ts';
import { DEFAULT_API_KEY_ENV, DEFAULT_CLAUDE_BIN, transportOf, type Config, type Transport } from '../worldgen/config.ts';
import type { RunEvent } from '../worldgen/events.ts';
import { anthropicModel, claudeCliModel, probeClaudeBin, type Model, type ProposeRequest } from '../worldgen/llm.ts';
import { parsePlanYaml } from '../worldgen/plan.ts';
import { renderReport } from '../worldgen/report.ts';
import type { RunResult } from '../worldgen/run.ts';

type Env = Readonly<Record<string, string | undefined>>;

const isExecutableFile = (file: string): boolean => {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

/** Whether `bin` can be run: a path to an executable file, or a bare name found on env.PATH. */
export function binaryFound(bin: string, env: Env): boolean {
  if (bin.includes('/') || bin.includes(path.sep)) return isExecutableFile(path.resolve(bin));
  const dirs = (env['PATH'] ?? '').split(path.delimiter).filter((d) => d !== '');
  return dirs.some((d) => isExecutableFile(path.join(d, bin)));
}

/**
 * The model for `transport`, metered into the spend ledger with the caps from the environment.
 * Throws a one-line Error before any call when the transport cannot work: the claude binary is
 * not found or does not run `--version`, or the sdk key variable is unset.
 */
export function makeModel(config: Config, env: Env = process.env, transport: Transport = transportOf(config)): Model {
  const ledger = openLedger(ledgerPath(env));
  const caps = capsFromEnv(env);
  const withBudget = (req: ProposeRequest, allowance: number): ProposeRequest => ({ ...req, maxCostUsd: Math.min(req.maxCostUsd ?? config.maxCostUsd, allowance) });
  const allowanceOf = (req: ProposeRequest): number => req.maxCostUsd ?? config.maxCostUsd;
  switch (transport) {
    case 'claude-cli': {
      const bin = env.WORLDGEN_CLAUDE_BIN ?? config.claudeBin ?? DEFAULT_CLAUDE_BIN;
      if (!binaryFound(bin, env)) {
        const keyEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
        throw new Error(`the claude CLI "${bin}" was not found on PATH: install Claude Code and log in, set WORLDGEN_CLAUDE_BIN or claudeBin in worldgen.config.json, or use --transport sdk with ${keyEnv} set`);
      }
      const probe = probeClaudeBin(bin, env);
      if (!probe.ok) {
        const keyEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
        throw new Error(`the claude CLI "${bin}" could not run (${probe.error}): it is often a shell shim; set WORLDGEN_CLAUDE_BIN or claudeBin in worldgen.config.json to the real binary (try ~/.local/bin/claude), or use --transport sdk with ${keyEnv} set`);
      }
      return meteredModel(claudeCliModel({ ...config, claudeBin: bin }), ledger, { provider: 'claude-cli', account: accountFor('claude-cli'), model: config.model, caps, withBudget, allowanceOf });
    }
    case 'sdk': {
      const keyEnv = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
      const key = env[keyEnv];
      if (key === undefined || key === '') throw new Error(`--transport sdk needs ${keyEnv} set in the environment`);
      return meteredModel(anthropicModel(config, { apiKey: key }), ledger, { provider: 'anthropic', account: accountFor('anthropic', key), model: config.model, caps, withBudget, allowanceOf });
    }
    default:
      return assertNever(transport);
  }
}

/** Loads and checks config.exampleWorld; WorldGen renders it into every system prompt. */
export async function loadExampleWorld(config: Config): Promise<World> {
  const loaded = await loadWorld(config.exampleWorld);
  if (!loaded.ok) throw new Error(`example world ${config.exampleWorld} does not load: ${loaded.error[0].code}`);
  const report = checkWorld(loaded.value);
  if (!report.ok) throw new Error(`example world ${config.exampleWorld} does not check: ${report.issues[0].code}`);
  return report.world;
}

export const mtimeOf = (file: string): Promise<number | null> => stat(file).then((s) => s.mtimeMs, () => null);

/** REPORT.md for the result, unless the run wrote one itself. The plan is read back only when this run accepted one. */
export async function writeReport(outDir: string, result: RunResult, events: readonly RunEvent[], before: number | null): Promise<string> {
  const file = path.join(outDir, 'REPORT.md');
  const after = await mtimeOf(file);
  if (after !== null && after !== before) return file;
  const planned = events.some((e) => e.t === 'step_finished' && e.step === 'plan');
  const planText = planned ? await readFile(path.join(outDir, 'plan.yaml'), 'utf8').catch(() => '') : '';
  const plan = parsePlanYaml(planText) ?? undefined;
  const text = result.kind === 'done'
    ? renderReport({ plan, report: result.report, events })
    : renderReport({ plan, events, stop: result.reason });
  await mkdir(outDir, { recursive: true });
  await writeFile(file, text);
  return file;
}
