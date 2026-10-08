/**
 * Golden tables for the options the model-calling CLIs repeat (YOS-203): --model, --transport, --budget-usd and
 * --max-minutes, with the edge cases around them: a missing or blank value, an unknown flag, `--`, a positional that
 * starts with "-", `--transport sdk`, a budget above every spend cap (the caps bind per call, not here), a repeated
 * option and `--option=value`. Every expected value was captured from the six CLIs before they shared a parser, so a
 * refactor that changes a parse result, an error text or an exit code fails a row here. Each CLI is reached the way
 * it is today: eval, live and episode through their exported parsers, dataset through main with its seams, and
 * worldgen and studio, which run main when imported, as processes.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { main as datasetMain, USAGE as DATASET_USAGE } from '../src/cli/dataset.ts';
import { parse as parseEpisode } from '../src/cli/episode.ts';
import { parseEvalArgs } from '../src/cli/eval-args.ts';
import { parseArgs as parseLive } from '../src/cli/live.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '..');
const REPO_DIR = path.resolve(CODE_DIR, '..');

type Outcome = 'help' | { readonly ok: unknown } | { readonly error: string };
type Rows = readonly (readonly [readonly string[], Outcome])[];
type DatasetOutcome = { readonly code: 0; readonly help: true } | { readonly code: 2; readonly usage: string } | { readonly code: number; readonly err: string; readonly checked: boolean };
type Spawned = { readonly status: number | null; readonly stderr: string } | { readonly status: number | null; readonly firstLine: string; readonly standIn?: true };
type StudioRow = ({ readonly serves: string } | { readonly status: number | null; readonly firstLine: string }) & { readonly env?: Readonly<Record<string, string>> };

const no = (error: string): Outcome => ({ error });
/** A parse result, or the refusal it threw. A refusal that is not the CLI's UsageError (exit 2) names its class. */
function outcome(parse: () => unknown): Outcome {
  try {
    const r = parse();
    return r === 'help' ? 'help' : { ok: r };
  } catch (e) {
    const err = e as Error;
    return { error: err.constructor.name === 'UsageError' ? err.message : `${err.constructor.name}: ${err.message}` };
  }
}
const evalOk = (overrides: object): Outcome => ({ ok: { suite: '/golden/suite.yaml', only: null, tags: null, dryRun: false, outDir: null, backend: 'local', parallel: 1, overrides } });
const liveOk = (overrides: object): Outcome => ({
  ok: { promptsDir: '/golden/prompts', only: null, dryRun: false, commit: null, date: '2026-10-08', report: path.join(REPO_DIR, 'prod/LIVE-RUN.md'), worldsDir: path.join(REPO_DIR, 'prod/worlds'), outDir: null, overrides },
});
const episodeOk = (over: object): Outcome => ({
  ok: { world: '/golden/world', task: 't1', out: '/golden/out', runId: 'r1', engineCommit: 'abcdef1', agent: 'noop', maxTurns: 12, budgetUsd: 0.5, maxMinutes: 5, transport: undefined, ...over },
});

const L = ['/golden/prompts', '--date', '2026-10-08'];
const E = ['--world', '/golden/world', '--task', 't1', '--out', '/golden/out', '--run-id', 'r1', '--engine-commit', 'abcdef1'];
const D = ['--world', '/golden/world', '--out', '/golden/out', '--run-id', 'r1', '--engine-commit', 'abcdef1', '--max-turns', '3', '--budget-usd', '2', '--max-minutes', '5'];
/** worldgen's base row. `<home>` is the row's scratch HOME, so nothing is written outside it. */
const B = ['golden options desk', '--out', '<home>/out'];

const EVAL: Rows = [
  [[], evalOk({})],
  [['--model', 'claude-sonnet-5-5', '--transport', 'sdk', '--budget-usd', '2.5', '--max-minutes', '7'], evalOk({ model: 'claude-sonnet-5-5', transport: 'sdk', maxCostUsd: 2.5, maxMinutes: 7 })],
  [['--transport', 'sdk'], evalOk({ transport: 'sdk' })],
  [['--transport', 'claude-cli'], evalOk({ transport: 'claude-cli' })],
  [['--transport', 'bogus'], no('--transport must be one of claude-cli, sdk, got bogus')],
  [['--transport', 'SDK'], no('--transport must be one of claude-cli, sdk, got SDK')],
  [['--model'], no('--model needs a value')],
  [['--model', '--transport', 'sdk'], no('--model needs a value')],
  [['--model', ''], evalOk({ model: '' })],
  [['--model', ' '], evalOk({ model: ' ' })],
  [['--bogus'], no('unknown option --bogus')],
  [['--'], no('unknown option --')],
  [['--', '-dash'], no('unknown option --')],
  [['-dash'], no('unknown option -dash')],
  [['--budget-usd', '1000000'], evalOk({ maxCostUsd: 1000000 })],
  [['--budget-usd', '0'], no('--budget-usd needs a positive number, got 0')],
  [['--budget-usd', '-1'], no('--budget-usd needs a positive number, got -1')],
  [['--budget-usd', 'abc'], no('--budget-usd needs a positive number, got abc')],
  [['--budget-usd', '1e2'], evalOk({ maxCostUsd: 100 })],
  [['--budget-usd', ' 5 '], evalOk({ maxCostUsd: 5 })],
  [['--budget-usd', '0x10'], evalOk({ maxCostUsd: 16 })],
  [['--max-minutes', '0.5'], evalOk({ maxMinutes: 0.5 })],
  [['--max-minutes', '0'], no('--max-minutes needs a positive number, got 0')],
  [['--model', 'claude-sonnet-5-5', '--model', 'claude-opus-5-5'], evalOk({ model: 'claude-opus-5-5' })],
  [['--model=claude-sonnet-5-5'], no('unknown option --model=claude-sonnet-5-5')],
  [['--budget-usd', 'abc', '--bogus'], no('--budget-usd needs a positive number, got abc')],
  [['--bogus', '--budget-usd', 'abc'], no('unknown option --bogus')],
  [['--help'], 'help'],
  [['-h'], 'help'],
  [['--bogus', '--help'], no('unknown option --bogus')],
  [['stray'], no('unexpected argument stray')],
];

const LIVE: Rows = [
  [[...L], liveOk({})],
  [[...L, '--model', 'claude-sonnet-5-5', '--transport', 'sdk', '--budget-usd', '2.5', '--max-minutes', '7'], liveOk({ model: 'claude-sonnet-5-5', transport: 'sdk', maxCostUsd: 2.5, maxMinutes: 7 })],
  [[...L, '--transport', 'sdk'], liveOk({ transport: 'sdk' })],
  [[...L, '--transport', 'claude-cli'], liveOk({ transport: 'claude-cli' })],
  [[...L, '--transport', 'bogus'], no('--transport must be one of claude-cli, sdk, got bogus')],
  [[...L, '--transport', 'SDK'], no('--transport must be one of claude-cli, sdk, got SDK')],
  [[...L, '--model'], no('--model needs a value')],
  [[...L, '--model', '--transport', 'sdk'], no('--model needs a value')],
  [[...L, '--model', ''], no('--model needs a value')],
  [[...L, '--model', ' '], no('--model needs a value')],
  [[...L, '--bogus'], no('unknown option --bogus')],
  [[...L, '--'], no('unknown option --')],
  [[...L, '--', '-dash'], no('unknown option --')],
  [[...L, '-dash'], no('unknown option -dash')],
  [[...L, '--budget-usd', '1000000'], liveOk({ maxCostUsd: 1000000 })],
  [[...L, '--budget-usd', '0'], no('--budget-usd needs a positive number, got 0')],
  [[...L, '--budget-usd', '-1'], no('--budget-usd needs a positive number, got -1')],
  [[...L, '--budget-usd', 'abc'], no('--budget-usd needs a positive number, got abc')],
  [[...L, '--budget-usd', '1e2'], liveOk({ maxCostUsd: 100 })],
  [[...L, '--budget-usd', ' 5 '], liveOk({ maxCostUsd: 5 })],
  [[...L, '--budget-usd', '0x10'], liveOk({ maxCostUsd: 16 })],
  [[...L, '--max-minutes', '0.5'], liveOk({ maxMinutes: 0.5 })],
  [[...L, '--max-minutes', '0'], no('--max-minutes needs a positive number, got 0')],
  [[...L, '--model', 'claude-sonnet-5-5', '--model', 'claude-opus-5-5'], no('--model is given twice')],
  [[...L, '--model=claude-sonnet-5-5'], no('unknown option --model=claude-sonnet-5-5')],
  [[...L, '--budget-usd', 'abc', '--bogus'], no('unknown option --bogus')],
  [[...L, '--bogus', '--budget-usd', 'abc'], no('unknown option --bogus')],
  [[...L, '--help'], 'help'],
  [[...L, '-h'], 'help'],
  [[...L, '--bogus', '--help'], 'help'],
  [[], no('give the prompts directory')],
  [['--date', '2026-10-08'], no('give the prompts directory')],
  [['/golden/prompts', '/golden/other', '--date', '2026-10-08'], no('unexpected argument /golden/other')],
  [['--model', 'claude-sonnet-5-5', '/golden/prompts', '--date', '2026-10-08'], liveOk({ model: 'claude-sonnet-5-5' })],
];

const EPISODE: Rows = [
  [[...E], episodeOk({})],
  [[...E, '--model', 'claude-sonnet-5-5', '--transport', 'sdk', '--budget-usd', '2.5', '--max-minutes', '7'], no('Unknown option \'--model\'')],
  [[...E, '--transport', 'sdk'], episodeOk({ transport: 'sdk' })],
  [[...E, '--transport', 'claude-cli'], episodeOk({ transport: 'claude-cli' })],
  [[...E, '--transport', 'bogus'], no('--transport must be one of claude-cli, sdk, got bogus')],
  [[...E, '--transport', 'SDK'], no('--transport must be one of claude-cli, sdk, got SDK')],
  [[...E, '--model'], no('Unknown option \'--model\'')],
  [[...E, '--model', '--transport', 'sdk'], no('Unknown option \'--model\'')],
  [[...E, '--model', ''], no('Unknown option \'--model\'')],
  [[...E, '--model', ' '], no('Unknown option \'--model\'')],
  [[...E, '--bogus'], no('Unknown option \'--bogus\'')],
  [[...E, '--'], episodeOk({})],
  [[...E, '--', '-dash'], no('Unexpected argument \'-dash\'. This command does not take positional arguments')],
  [[...E, '-dash'], no('Unknown option \'d\'')],
  [[...E, '--budget-usd', '1000000'], episodeOk({ budgetUsd: 1000000 })],
  [[...E, '--budget-usd', '0'], no('--budget-usd needs a positive number, got 0')],
  [[...E, '--budget-usd', '-1'], no('Option \'--budget-usd\' argument is ambiguous.\nDid you forget to specify the option argument for \'--budget-usd\'?\nTo specify an option argument starting with a dash use \'--budget-usd=-XYZ\'.')],
  [[...E, '--budget-usd', 'abc'], no('--budget-usd needs a positive number, got abc')],
  [[...E, '--budget-usd', '1e2'], episodeOk({ budgetUsd: 100 })],
  [[...E, '--budget-usd', ' 5 '], episodeOk({ budgetUsd: 5 })],
  [[...E, '--budget-usd', '0x10'], episodeOk({ budgetUsd: 16 })],
  [[...E, '--max-minutes', '0.5'], episodeOk({ maxMinutes: 0.5 })],
  [[...E, '--max-minutes', '0'], no('--max-minutes needs a positive number, got 0')],
  [[...E, '--model', 'claude-sonnet-5-5', '--model', 'claude-opus-5-5'], no('Unknown option \'--model\'')],
  [[...E, '--model=claude-sonnet-5-5'], no('Unknown option \'--model\'')],
  [[...E, '--budget-usd', 'abc', '--bogus'], no('Unknown option \'--bogus\'')],
  [[...E, '--bogus', '--budget-usd', 'abc'], no('Unknown option \'--bogus\'')],
  [[...E, '--help'], 'help'],
  [[...E, '-h'], 'help'],
  [[...E, '--bogus', '--help'], no('Unknown option \'--bogus\'')],
  [[...E, '--budget-usd'], no('Option \'--budget-usd <value>\' argument missing')],
  [[...E, '--budget-usd', '--max-minutes', '3'], no('Option \'--budget-usd\' argument is ambiguous.\nDid you forget to specify the option argument for \'--budget-usd\'?\nTo specify an option argument starting with a dash use \'--budget-usd=-XYZ\'.')],
  [[...E, '--budget-usd', ''], no('--budget-usd needs a positive number, got ')],
  [[...E, '--transport', ''], no('--transport must be one of claude-cli, sdk, got ')],
  [[...E, '--max-turns', '2.7'], episodeOk({ maxTurns: 2 })],
  [['--task', 't1', '--out', '/golden/out', '--run-id', 'r1', '--engine-commit', 'abcdef1'], no('--world is required')],
];

const DATASET: readonly (readonly [readonly string[], DatasetOutcome])[] = [
  [[...D], { code: 1, err: 'BOAT_API_KEY and WORLDGEN_BOAT_ORG must be set in the environment of this command; none is ever written to a file or uploaded', checked: true }],
  [[...D, '--model', 'claude-sonnet-5-5', '--transport', 'sdk', '--budget-usd', '2.5', '--max-minutes', '7'], { code: 1, err: 'LLM_KEY and BOAT_API_KEY and WORLDGEN_BOAT_ORG must be set in the environment of this command; none is ever written to a file or uploaded', checked: true }],
  [[...D, '--transport', 'sdk'], { code: 1, err: 'LLM_KEY and BOAT_API_KEY and WORLDGEN_BOAT_ORG must be set in the environment of this command; none is ever written to a file or uploaded', checked: true }],
  [[...D, '--transport', 'claude-cli'], { code: 1, err: 'BOAT_API_KEY and WORLDGEN_BOAT_ORG must be set in the environment of this command; none is ever written to a file or uploaded', checked: true }],
  [[...D, '--transport', 'bogus'], { code: 2, usage: '--transport must be claude-cli or sdk' }],
  [[...D, '--transport', 'SDK'], { code: 2, usage: '--transport must be claude-cli or sdk' }],
  [[...D, '--model'], { code: 2, usage: 'Option \'--model <value>\' argument missing' }],
  [[...D, '--model', '--transport', 'sdk'], { code: 2, usage: 'Option \'--model\' argument is ambiguous.\nDid you forget to specify the option argument for \'--model\'?\nTo specify an option argument starting with a dash use \'--model=-XYZ\'.' }],
  [[...D, '--model', ''], { code: 1, err: 'invalid config <code>/worldgen.config.json:\nmodel: model "" is not a Claude model id such as claude-sonnet-5-5', checked: false }],
  [[...D, '--model', ' '], { code: 1, err: 'invalid config <code>/worldgen.config.json:\nmodel: model " " is not a Claude model id such as claude-sonnet-5-5', checked: false }],
  [[...D, '--bogus'], { code: 2, usage: 'Unknown option \'--bogus\'. To specify a positional argument starting with a \'-\', place it at the end of the command after \'--\', as in \'-- "--bogus"' }],
  [[...D, '--'], { code: 1, err: 'BOAT_API_KEY and WORLDGEN_BOAT_ORG must be set in the environment of this command; none is ever written to a file or uploaded', checked: true }],
  [[...D, '--', '-dash'], { code: 2, usage: 'unexpected argument "-dash"' }],
  [[...D, '-dash'], { code: 2, usage: 'Unknown option \'d\'. To specify a positional argument starting with a \'-\', place it at the end of the command after \'--\', as in \'-- "d"' }],
  [[...D, '--budget-usd', '1000000'], { code: 1, err: 'BOAT_API_KEY and WORLDGEN_BOAT_ORG must be set in the environment of this command; none is ever written to a file or uploaded', checked: true }],
  [[...D, '--budget-usd', '0'], { code: 2, usage: '--budget-usd must be a positive number, got "0"' }],
  [[...D, '--budget-usd', '-1'], { code: 2, usage: 'Option \'--budget-usd\' argument is ambiguous.\nDid you forget to specify the option argument for \'--budget-usd\'?\nTo specify an option argument starting with a dash use \'--budget-usd=-XYZ\'.' }],
  [[...D, '--budget-usd', 'abc'], { code: 2, usage: '--budget-usd must be a positive number, got "abc"' }],
  [[...D, '--budget-usd', '1e2'], { code: 2, usage: '--budget-usd must be a positive number, got "1e2"' }],
  [[...D, '--budget-usd', ' 5 '], { code: 2, usage: '--budget-usd must be a positive number, got " 5 "' }],
  [[...D, '--budget-usd', '0x10'], { code: 2, usage: '--budget-usd must be a positive number, got "0x10"' }],
  [[...D, '--max-minutes', '0.5'], { code: 1, err: 'BOAT_API_KEY and WORLDGEN_BOAT_ORG must be set in the environment of this command; none is ever written to a file or uploaded', checked: true }],
  [[...D, '--max-minutes', '0'], { code: 2, usage: '--max-minutes must be a positive number, got "0"' }],
  [[...D, '--model', 'claude-sonnet-5-5', '--model', 'claude-opus-5-5'], { code: 1, err: 'BOAT_API_KEY and WORLDGEN_BOAT_ORG must be set in the environment of this command; none is ever written to a file or uploaded', checked: true }],
  [[...D, '--model=claude-sonnet-5-5'], { code: 1, err: 'BOAT_API_KEY and WORLDGEN_BOAT_ORG must be set in the environment of this command; none is ever written to a file or uploaded', checked: true }],
  [[...D, '--budget-usd', 'abc', '--bogus'], { code: 2, usage: 'Unknown option \'--bogus\'. To specify a positional argument starting with a \'-\', place it at the end of the command after \'--\', as in \'-- "--bogus"' }],
  [[...D, '--bogus', '--budget-usd', 'abc'], { code: 2, usage: 'Unknown option \'--bogus\'. To specify a positional argument starting with a \'-\', place it at the end of the command after \'--\', as in \'-- "--bogus"' }],
  [[...D, '--help'], { code: 0, help: true }],
  [[...D, '-h'], { code: 0, help: true }],
  [[...D, '--bogus', '--help'], { code: 2, usage: 'Unknown option \'--bogus\'. To specify a positional argument starting with a \'-\', place it at the end of the command after \'--\', as in \'-- "--bogus"' }],
  [[], { code: 2, usage: '--world is required' }],
  [['--world', '/golden/world', '--out', '/golden/out', '--run-id', 'r1', '--engine-commit', 'abcdef1', '--max-turns', '3'], { code: 2, usage: '--budget-usd is required' }],
  [[...D, '--budget-usd'], { code: 2, usage: 'Option \'--budget-usd <value>\' argument missing' }],
  [[...D, '--transport', ''], { code: 2, usage: '--transport must be claude-cli or sdk' }],
  [[...D, '--max-turns', '2.7'], { code: 2, usage: '--max-turns must be a positive whole number, got "2.7"' }],
];

const WORLDGEN: readonly (readonly [readonly string[], Spawned])[] = [
  [[...B], { status: 2, stderr: 'the claude CLI "<home>/no-claude" was not found on PATH: install Claude Code and log in, set WORLDGEN_CLAUDE_BIN or claudeBin in worldgen.config.json, or use --transport sdk with LLM_KEY set\n' }],
  [[...B, '--transport', 'sdk'], { status: 2, stderr: '--transport sdk needs LLM_KEY set in the environment\n' }],
  [[...B, '--transport', 'bogus'], { status: 2, stderr: '--transport must be one of claude-cli, sdk, got bogus (see --help)\n' }],
  [[...B, '--transport', 'SDK'], { status: 2, stderr: '--transport must be one of claude-cli, sdk, got SDK (see --help)\n' }],
  [[...B, '--model'], { status: 2, stderr: '--model needs a value (see --help)\n' }],
  [[...B, '--model', '--transport', 'sdk'], { status: 2, stderr: '--model needs a value (see --help)\n' }],
  [[...B, '--model', ''], { status: 2, stderr: '--model needs a value (see --help)\n' }],
  [[...B, '--model', ' '], { status: 2, stderr: '--model needs a value (see --help)\n' }],
  [[...B, '--bogus'], { status: 2, stderr: 'unknown option --bogus (see --help)\n' }],
  [[...B, '-dash'], { status: 2, stderr: 'unknown option -dash (see --help)\n' }],
  [[...B, '--budget-usd', '0'], { status: 2, stderr: '--budget-usd needs a positive number, got 0 (see --help)\n' }],
  [[...B, '--budget-usd', '-1'], { status: 2, stderr: '--budget-usd needs a positive number, got -1 (see --help)\n' }],
  [[...B, '--budget-usd', 'abc'], { status: 2, stderr: '--budget-usd needs a positive number, got abc (see --help)\n' }],
  [[...B, '--max-minutes', '0'], { status: 2, stderr: '--max-minutes needs a positive number, got 0 (see --help)\n' }],
  [[...B, '--model', 'claude-sonnet-5-5', '--model', 'claude-opus-5-5'], { status: 2, stderr: '--model is given twice (see --help)\n' }],
  [[...B, '--model=claude-sonnet-5-5'], { status: 2, stderr: 'unknown option --model=claude-sonnet-5-5 (see --help)\n' }],
  [[...B, '--budget-usd', 'abc', '--bogus'], { status: 2, stderr: 'unknown option --bogus (see --help)\n' }],
  [[...B, '--bogus', '--budget-usd', 'abc'], { status: 2, stderr: 'unknown option --bogus (see --help)\n' }],
  [[...B, '--bogus', '--help'], { status: 0, firstLine: 'usage:' }],
  [[...B, '--budget-usd', ' 5 ', '--transport', 'sdk'], { status: 2, stderr: '--transport sdk needs LLM_KEY set in the environment\n' }],
  [[...B, '--budget-usd', '0x10', '--transport', 'sdk'], { status: 2, stderr: '--transport sdk needs LLM_KEY set in the environment\n' }],
  [[...B, '--budget-usd', '1000000', '--transport', 'sdk'], { status: 2, stderr: '--transport sdk needs LLM_KEY set in the environment\n' }],
  [[...B, '--', '--transport', 'sdk'], { status: 2, stderr: 'the claude CLI "<home>/no-claude" was not found on PATH: install Claude Code and log in, set WORLDGEN_CLAUDE_BIN or claudeBin in worldgen.config.json, or use --transport sdk with LLM_KEY set\n' }],
  [['--out', '<home>/out', '--transport', 'sdk', '--', '-dash desk'], { status: 2, stderr: '--transport sdk needs LLM_KEY set in the environment\n' }],
  [['--help'], { status: 0, firstLine: 'usage:' }],
  [[], { status: 2, stderr: 'No input given. Pass a description, --openapi <file> or --csv <file...>. (see --help)\n' }],
  [[...B, '--model', 'claude-sonnet-5-5', '--transport', 'claude-cli', '--budget-usd', '2.5', '--max-minutes', '7'], { status: 1, firstLine: 'worldgen: description input into <home>/out (model claude-sonnet-5-5, transport claude-cli, budget $2.50, 7 min)', standIn: true }],
  [[...B, '--budget-usd', '1e2', '--max-minutes', '0.5'], { status: 1, firstLine: 'worldgen: description input into <home>/out (model claude-sonnet-5-5, transport claude-cli, budget $100.00, 0.5 min)', standIn: true }],
];

const STUDIO: readonly (readonly [readonly string[], StudioRow])[] = [
  [['--transport', 'sdk'], { serves: 'studio on http://127.0.0.1:<port> (worlds under <home>/worlds)' }],
  [[], { serves: 'studio on http://127.0.0.1:<port> (worlds under <home>/worlds)', env: { WORLDGEN_TRANSPORT: 'sdk' } }],
  [['--transport', 'bogus'], { status: 2, firstLine: '--transport must be claude-cli or sdk, got bogus' }],
  [['--transport', 'SDK'], { status: 2, firstLine: '--transport must be claude-cli or sdk, got SDK' }],
  [['--transport'], { status: 2, firstLine: '--transport needs a value' }],
  [['--transport', ''], { status: 2, firstLine: '--transport needs a value' }],
  [['--transport', '--host', '127.0.0.1'], { status: 2, firstLine: '--transport needs a value' }],
  [['--bogus'], { status: 2, firstLine: 'unknown argument --bogus' }],
  [['stray'], { status: 2, firstLine: 'unknown argument stray' }],
  [['--'], { status: 2, firstLine: 'unknown argument --' }],
  [['-dash'], { status: 2, firstLine: 'unknown argument -dash' }],
  [['--transport', 'sdk', '--transport', 'bogus'], { status: 2, firstLine: '--transport must be claude-cli or sdk, got bogus' }],
  [['--transport=sdk'], { status: 2, firstLine: 'unknown argument --transport=sdk' }],
  [['--model', 'claude-sonnet-5-5'], { status: 2, firstLine: 'unknown argument --model' }],
  [['--budget-usd', '2'], { status: 2, firstLine: 'unknown argument --budget-usd' }],
  [['--max-minutes', '5'], { status: 2, firstLine: 'unknown argument --max-minutes' }],
  [['--help'], { status: 0, firstLine: 'usage: bun run studio [--port 8787] [--host 127.0.0.1] [--transport claude-cli|sdk] [--users <file>] [--origin <url>] [--worlds-dir <dir>] [--repo-root <dir>]' }],
  [[], { status: 2, firstLine: '--transport must be claude-cli or sdk, got bogus', env: { WORLDGEN_TRANSPORT: 'bogus' } }],
];

const scratchRoot = mkdtempSync(path.join(tmpdir(), 'cli-options-golden-'));
const fill = (args: readonly string[], home: string): string[] => args.map((a) => a.split('<home>').join(home));
const shown = (text: string, home: string): string => text.split(home).join('<home>');
/** A scratch HOME with the spend ledger inside it, so a spawned CLI never touches the real home and gets no key. */
function scratchEnv(): { home: string; env: Record<string, string> } {
  const home = mkdtempSync(path.join(scratchRoot, 'row-'));
  return { home, env: { PATH: process.env['PATH'] ?? '', HOME: home, WORLDGEN_COSTS_FILE: path.join(home, 'costs.jsonl') } };
}

describe('CLI options golden: eval (parseEvalArgs)', () => {
  it('parses or refuses every row as before the shared parser', () => {
    assert.deepEqual(EVAL.map(([argv]) => [argv, outcome(() => parseEvalArgs(argv, '/golden/suite.yaml'))]), EVAL);
  });
});

describe('CLI options golden: live (parseArgs)', () => {
  it('parses or refuses every row as before the shared parser', () => {
    assert.deepEqual(LIVE.map(([argv]) => [argv, outcome(() => parseLive(argv))]), LIVE);
  });
});

describe('CLI options golden: episode (parse)', () => {
  it('parses or refuses every row as before the shared parser', () => {
    assert.deepEqual(EPISODE.map(([argv]) => [argv, outcome(() => parseEpisode(argv))]), EPISODE);
  });
});

describe('CLI options golden: dataset (main, with a check child that finds no tasks)', () => {
  it('exits, refuses and reaches the world check for every row as before the shared parser', async () => {
    const got: (readonly [readonly string[], DatasetOutcome])[] = [];
    for (const [argv] of DATASET) {
      const out: string[] = [];
      const err: string[] = [];
      const ran: string[][] = [];
      const runner = async (a: readonly string[]) => {
        ran.push(a.slice(2));
        return { code: 0, stdout: JSON.stringify({ tasks: [] }), stderr: '' };
      };
      const code = await datasetMain(argv, { PATH: process.env['PATH'] ?? '' }, { out: (l) => out.push(l), err: (l) => err.push(l), runner });
      const usage = err.length === 1 && err[0]!.endsWith(`\n${DATASET_USAGE}`) ? err[0]!.slice(0, -DATASET_USAGE.length - 1) : null;
      got.push([argv, code === 0 && out.length === 1 && out[0] === DATASET_USAGE.trimEnd() && err.length === 0
        ? { code: 0, help: true }
        : code === 2 && usage !== null
          ? { code: 2, usage }
          : { code, err: err.join('\n').split(CODE_DIR).join('<code>'), checked: JSON.stringify(ran) === JSON.stringify([['--check', '/golden/world']]) }]);
    }
    assert.deepEqual(got, DATASET);
  });
});

describe('CLI options golden: worldgen (the process)', () => {
  it('exits and answers every row as before the shared parser, before any model call', () => {
    // The stand-in answers the binary probe and fails every -p call, so a row that passes parsing prints its header
    // line, which names the model, transport, budget and minutes the options set, then stops without a model.
    const standIn = path.join(scratchRoot, 'claude');
    writeFileSync(standIn, "#!/bin/sh\nif [ \"$1\" = --version ]; then echo '0.0.0 (golden stand-in)'; exit 0; fi\nexit 3\n");
    chmodSync(standIn, 0o755);
    const got = WORLDGEN.map(([argv, want]): readonly [readonly string[], Spawned] => {
      const { home, env } = scratchEnv();
      const isStandIn = 'standIn' in want;
      const r = spawnSync(process.execPath, ['src/cli/worldgen.ts', ...fill(argv, home)], {
        cwd: CODE_DIR, encoding: 'utf8', timeout: 120_000, env: { ...env, WORLDGEN_CLAUDE_BIN: isStandIn ? standIn : path.join(home, 'no-claude') },
      });
      const stdout = shown(r.stdout, home);
      return [argv, 'stderr' in want
        ? { status: r.status, stderr: shown(r.stderr, home), ...(stdout === '' ? {} : { stdout }) }
        : { status: r.status, firstLine: stdout.split('\n')[0]!, ...(isStandIn ? { standIn: true as const } : {}) }];
    });
    assert.deepEqual(got, WORLDGEN);
  });
});

describe('CLI options golden: studio (the process)', () => {
  it('refuses, or starts serving, for every row as before the shared parser', async () => {
    const got: (readonly [readonly string[], StudioRow])[] = [];
    for (const [argv, want] of STUDIO) {
      const { home, env: base } = scratchEnv();
      const env = { ...base, ...(want.env ?? {}) };
      const args = ['src/cli/studio.ts', '--port', '0', '--worlds-dir', path.join(home, 'worlds'), ...argv];
      const extra = want.env === undefined ? {} : { env: want.env };
      if ('serves' in want) {
        const child = spawn(process.execPath, args, { cwd: CODE_DIR, env, stdio: ['ignore', 'pipe', 'pipe'] });
        try {
          const line = await new Promise<string>((done) => {
            let stdout = '';
            let stderr = '';
            child.stderr.on('data', (d) => { stderr += d; });
            child.stdout.on('data', (d) => {
              stdout += d;
              if (stdout.includes('\n')) done(stdout.split('\n')[0]!);
            });
            child.once('exit', (code) => done(`exited ${code}: ${stderr}`));
          });
          got.push([argv, { serves: shown(line, home).replace(/:\d+ /, ':<port> '), ...extra }]);
        } finally {
          const exited = new Promise((done) => child.once('exit', done));
          child.kill('SIGTERM');
          const t = setTimeout(() => child.kill('SIGKILL'), 10_000);
          await exited;
          clearTimeout(t);
        }
      } else {
        const r = spawnSync(process.execPath, args, { cwd: CODE_DIR, encoding: 'utf8', timeout: 30_000, env });
        got.push([argv, { status: r.status, firstLine: shown(r.status === 0 ? r.stdout : r.stderr, home).split('\n')[0]!, ...extra }]);
      }
    }
    assert.deepEqual(got, STUDIO);
  });
});
