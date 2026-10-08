import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { capStatus, openLedger } from '../src/costs/ledger.ts';
import { meteredModel, type Billed } from '../src/costs/meter.ts';
import { StepShareExpired } from '../src/worldgen/llm.ts';

const usage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 10, cacheWriteTokens: 5 };
const dirs: string[] = [];
after(() => { for (const dir of dirs) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'partial-billing-'));
  dirs.push(dir);
  const file = join(dir, 'costs.jsonl');
  return { file, ledger: openLedger(file, { now: () => Date.parse('2026-10-06T23:59:00Z') }) };
}

describe('partial model usage is not final spending', () => {
  for (const outcome of ['explicit_unknown', 'legacy_share', 'legacy_stall', 'abort'] as const) it(`preserves the admitted allowance and lower-bound evidence for ${outcome}`, async () => {
    const { ledger, file } = fixture();
    const error = Object.assign(outcome === 'legacy_share' ? new StepShareExpired(1000, 1000) : new Error('interrupted'), {
      usage, costUsd: 0.2399543, ms: 1000, costBasis: 'cli_configured_rates',
      ...(outcome === 'explicit_unknown' ? { billing: { kind: 'unknown' } } : {}),
      ...(outcome === 'legacy_stall' ? { kind: 'stalled' } : {}),
      ...(outcome === 'abort' ? { name: 'AbortError' } : {}),
    });
    let calls = 0;
    const model = meteredModel<{ maxCostUsd?: number }, Billed>({ async propose(req) { calls += 1; assert.equal(req.maxCostUsd, 0.5); throw error; } }, ledger,
      { provider: 'claude-cli', account: 'claude-cli', caps: { maxTotalUsd: 0.5 }, withBudget: (req, maxCostUsd) => ({ ...req, maxCostUsd }) });
    await assert.rejects(model.propose({}), e => e === error);
    const reopened = openLedger(file, { now: () => Date.parse('2026-10-07T01:00:00Z') });
    // A-164: the claim closes, and caps count its unknown billing at the admitted $0.50.
    assert.deepEqual([reopened.totals().usd, reopened.totals().unpriced, reopened.read().reservations.length, reopened.read().events[0]?.exposureUsd], [0, 1, 0, 0.5]);
    assert.deepEqual(reopened.read().events[0]?.partialModelUsage, { ...usage, observedCostUsd: 0.2399543, costBasis: 'cli_configured_rates' });
    assert.equal(reopened.read().events[0]?.estimated, 'unpriced');
    assert.equal(capStatus(reopened, { maxTotalUsd: 0.5 }, reopened.now()).lines.maxTotalUsd?.remainingUsd, 0);
    await assert.rejects(model.propose({}), /spend cap WORLDGEN_MAX_TOTAL_USD=\$0\.50 reached: \$0\.50 spent/);
    assert.equal(calls, 1);
  });

  it('settles a terminal billed receipt even when the transport failed after receiving it', async () => {
    const { ledger } = fixture();
    const error = Object.assign(new Error('unusable final response'), { billing: { kind: 'billed' }, usage, costUsd: 0.2, costBasis: 'cli_reported_cost' });
    const model = meteredModel({ async propose() { throw error; } }, ledger, { provider: 'claude-cli', account: 'claude-cli', caps: { maxTotalUsd: 0.5 } });
    await assert.rejects(model.propose({}), e => e === error);
    assert.deepEqual([ledger.totals().usd, ledger.read().reservations.length, ledger.read().events[0]?.costBasis], [0.2, 0, 'cli_reported_cost']);
  });

  it('releases only authoritative not-started proof, even if a preflight error carries an estimate', async () => {
    const { ledger } = fixture();
    const error = Object.assign(new Error('preflight aborted'), { name: 'AbortError', billing: { kind: 'not_started' }, usage, costUsd: 0.2 });
    const model = meteredModel({ async propose() { throw error; } }, ledger, { provider: 'claude-cli', account: 'claude-cli', caps: { maxTotalUsd: 0.5 } });
    await assert.rejects(model.propose({}), e => e === error);
    assert.deepEqual([ledger.totals().events, ledger.read().reservations.length], [0, 0]);
  });

  it('labels partial evidence in the actual costs CLI without adding it to settled dollars', async () => {
    const { ledger, file } = fixture();
    const error = Object.assign(new StepShareExpired(1000, 1000), { usage, costUsd: 0.2399543 });
    const model = meteredModel({ async propose() { throw error; } }, ledger, { provider: 'claude-cli', account: 'claude-cli', caps: { maxTotalUsd: 0.5 } });
    await assert.rejects(model.propose({}));
    const cli = (...args: string[]) => spawnSync(process.execPath, ['src/cli/costs.ts', '--file', file, ...args], { cwd: new URL('..', import.meta.url), encoding: 'utf8', env: { PATH: process.env['PATH'] } });
    const json = cli('--json');
    assert.equal(json.status, 0);
    const out = JSON.parse(json.stdout);
    assert.deepEqual([out.total.usd, out.partialModelUsage[0].observedCostUsd, out.partialModelUsage[0].evidence, out.partialModelUsage[0].finalBilling], [0, 0.2399543, 'observed_lower_bound', 'unknown']);
    const text = cli();
    assert.equal(text.status, 0);
    assert.equal(text.stdout.includes('Observed partial model usage (lower bounds; final billing unknown, separate from settled spending)'), true);
  });
});
