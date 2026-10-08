/**
 * `bun run eval`'s transport (YOS-255): `--transport`, like `--model`, is a config override, so the model factory and
 * the run's events read one transport, from worldgen.config.json unless the command line says otherwise.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { evalConfig, parseEvalArgs } from '../src/cli/eval-args.ts';

const CODE_DIR = path.resolve(import.meta.dirname, '..');
const SHIPPED = path.join(CODE_DIR, 'worldgen.config.json');
const SUITE = '/suite.yaml';

/** worldgen.config.json with its transport set to `transport`, in a temp dir. */
function configWith(transport: string): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'eval-transport-')), 'worldgen.config.json');
  const shipped = JSON.parse(readFileSync(SHIPPED, 'utf8')) as Record<string, unknown>;
  writeFileSync(file, JSON.stringify({ ...shipped, transport, exampleWorld: path.resolve(CODE_DIR, String(shipped['exampleWorld'])) }));
  return file;
}

describe('eval transport (YOS-255)', () => {
  it('parses --transport into the config overrides, beside --model', () => {
    assert.deepEqual(parseEvalArgs(['--transport', 'sdk', '--model', 'claude-sonnet-5-5'], SUITE), {
      suite: SUITE, only: null, tags: null, dryRun: false, outDir: null, backend: 'local', parallel: 1,
      overrides: { transport: 'sdk', model: 'claude-sonnet-5-5' },
    });
  });

  it('takes the transport from worldgen.config.json when the command line names none', async () => {
    const sdk = await evalConfig(configWith('sdk'), {});
    assert.deepEqual([sdk.transport, sdk.config.transport], ['sdk', 'sdk']);
    const shipped = await evalConfig(SHIPPED, {});
    assert.deepEqual([shipped.transport, shipped.config.transport], ['claude-cli', 'claude-cli']);
  });

  it('lets --transport override the config, and the config the run records says the same', async () => {
    const flagged = await evalConfig(SHIPPED, (parseEvalArgs(['--transport', 'sdk'], SUITE) as { overrides: object }).overrides);
    assert.deepEqual([flagged.transport, flagged.config.transport], ['sdk', 'sdk']);
    const back = await evalConfig(configWith('sdk'), (parseEvalArgs(['--transport', 'claude-cli'], SUITE) as { overrides: object }).overrides);
    assert.deepEqual([back.transport, back.config.transport], ['claude-cli', 'claude-cli']);
  });

  it('builds the sdk model the flag names, which refuses without LLM_KEY before any call or file', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'eval-transport-run-'));
    const env = { PATH: process.env['PATH'] ?? '', HOME: home, WORLDGEN_COSTS_FILE: path.join(home, 'costs.jsonl'), WORLDGEN_CLAUDE_BIN: '/nonexistent/claude' };
    const r = spawnSync(process.execPath, ['src/cli/eval.ts', '--only', 'helpdesk-sla', '--transport', 'sdk', '--out-dir', path.join(home, 'run')], { cwd: CODE_DIR, env, encoding: 'utf8', timeout: 60_000 });
    assert.deepEqual([r.status, r.stderr.trim()], [1, '--transport sdk needs LLM_KEY set in the environment']);
    assert.deepEqual([existsSync(path.join(home, 'run')), existsSync(path.join(home, 'costs.jsonl'))], [false, false]);
  });
});
