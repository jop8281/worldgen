import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it } from 'node:test';
import { openLedger } from '../src/costs/ledger.ts';
import { meteredModel } from '../src/costs/meter.ts';
import { capsuleSchema } from '../src/worldgen/capsule.ts';
import { configSchema } from '../src/worldgen/config.ts';
import { caseLayout, parseEventLog, runCase, summarizeCase } from '../src/worldgen/eval.ts';
import { createEmitter } from '../src/worldgen/events.ts';
import { ModelError, type Model } from '../src/worldgen/llm.ts';
import { partialDir, runWorldGen } from '../src/worldgen/run.ts';
import { EDITS, PLAN } from './helpers/scripted-world.ts';
import { minimalWorld } from './helpers/world.ts';

describe('runWorldGen exception artifacts', () => {
  it('retains the paid attempt and crash artifacts when its dump write fails, then rethrows the original error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wg-crash-'));
    const failure = new Error('attempt dump could not be written');
    const ledger = openLedger(join(dir, 'costs.jsonl'));
    let calls = 0;
    const raw: Model = { async propose() { calls += 1; return { input: PLAN, advice: [], usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.125, ms: 1 }; } };
    const model = meteredModel(raw, ledger, { provider: 'claude-cli', account: 'claude-cli', caps: { maxTotalUsd: 1 } });
    try {
      await assert.rejects(runWorldGen({ kind: 'create', input: { kind: 'description', text: 'Offline persistence test' }, outDir: dir }, configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5 }), {
        model, exampleWorld: minimalWorld(), runId: 'crash', fs: { ...fs, async writeFile(path, ...args) {
          if (String(path).endsWith('001-plan-1.json')) throw failure;
          return fs.writeFile(path, ...args);
        } },
      }), error => error === failure);
      assert.equal(calls, 1);
      assert.equal(ledger.totals().usd, 0.125);
      assert.equal(ledger.read().reservations.length, 0);
      assert.equal(existsSync(join(partialDir(dir), 'world.yaml')), false);
      assert.equal(existsSync(join(partialDir(dir), 'plan.yaml')), false);
      assert.match(readFileSync(join(partialDir(dir), 'REPORT.md'), 'utf8'), /^Crashed: attempt dump could not be written/);
      const capsule = capsuleSchema.parse(JSON.parse(readFileSync(join(partialDir(dir), 'capsule.json'), 'utf8')));
      assert.equal(capsule.costUsd, 0.125);
      assert.equal(capsule.worldId, null);
      assert.deepEqual(capsule.attempts.map(a => [a.step, a.n, a.costUsd]), [['plan', 1, 0.125]]);
      const log = parseEventLog(readFileSync(join(partialDir(dir), 'runs', 'crash', 'events.jsonl'), 'utf8'));
      assert.deepEqual(log.problems, []);
      assert.deepEqual(log.events.filter(e => e.t === 'run_finished').map(e => e.result.kind), ['crashed']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('preserves unknown billing and its exposure when interrupted-call evidence cannot be dumped', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wg-crash-unknown-'));
    const failure = new Error('interrupted attempt dump failed');
    const ledger = openLedger(join(dir, 'costs.jsonl'));
    const partialModelUsage = { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, observedCostUsd: 0.02 };
    let calls = 0;
    const raw: Model = { async propose() { calls += 1; throw new ModelError('transport interrupted', undefined, { kind: 'unknown', partialModelUsage }); } };
    const model = meteredModel(raw, ledger, { provider: 'claude-cli', account: 'claude-cli', caps: { maxTotalUsd: 1 } });
    try {
      await assert.rejects(runWorldGen({ kind: 'create', input: { kind: 'description', text: 'Offline unknown-billing persistence test' }, outDir: dir }, configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5 }), {
        model, exampleWorld: minimalWorld(), runId: 'unknown_crash', fs: { ...fs, async writeFile(path, ...args) {
          if (String(path).endsWith('001-plan-1.json')) throw failure;
          return fs.writeFile(path, ...args);
        } },
      }), error => error === failure);
      assert.equal(calls, 1);
      assert.equal(ledger.totals().usd, 0);
      assert.equal(ledger.read().events[0]?.usd, null);
      // A-164: the claim closes on the unknown settle; caps count it at the admitted bound, the $5 budget trimmed to the $1 cap.
      assert.equal(ledger.read().reservations.length, 0);
      assert.equal(ledger.read().events[0]?.exposureUsd, 1);
      assert.equal(ledger.totals().unpriced, 1);
      const capsule = capsuleSchema.parse(JSON.parse(readFileSync(join(partialDir(dir), 'capsule.json'), 'utf8')));
      assert.equal(capsule.costUsd, 0);
      assert.equal(capsule.unknownCostCalls, 1);
      assert.equal(capsule.attempts[0]?.costUsd, null);
      assert.deepEqual(capsule.attempts[0]?.partialModelUsage, partialModelUsage);
      assert.match(readFileSync(join(partialDir(dir), 'REPORT.md'), 'utf8'), /Cost remains unknown for 1 model call/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('writes the crash capsule even when both report writes fail, without masking the first error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wg-crash-report-'));
    const first = new Error('initial report write failed');
    let reportWrites = 0;
    const model: Model = { async propose() { throw new Error('must not call the model'); } };
    try {
      await assert.rejects(runWorldGen({ kind: 'create', input: { kind: 'description', text: '' }, outDir: dir }, configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5 }), {
        model, exampleWorld: minimalWorld(), runId: 'report_crash', fs: { ...fs, async writeFile(path, ...args) {
          if (String(path).endsWith('REPORT.md')) { reportWrites += 1; throw reportWrites === 1 ? first : new Error('secondary report write failed'); }
          return fs.writeFile(path, ...args);
        } },
      }), error => error === first);
      assert.equal(reportWrites, 2);
      assert.equal(existsSync(join(partialDir(dir), 'REPORT.md')), false);
      const capsule = capsuleSchema.parse(JSON.parse(readFileSync(join(partialDir(dir), 'capsule.json'), 'utf8')));
      assert.equal(capsule.costUsd, 0);
      assert.equal(capsule.worldId, null);
      assert.deepEqual(capsule.attempts, []);
      const log = parseEventLog(readFileSync(join(partialDir(dir), 'runs', 'report_crash', 'events.jsonl'), 'utf8'));
      assert.deepEqual(log.problems, []);
      assert.deepEqual(log.events.filter(e => e.t === 'run_finished').map(e => e.result.kind), ['crashed']);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('reports an already-written world truthfully when the final create report fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wg-crash-saved-'));
    const failure = new Error('final report write failed');
    const inputs = [PLAN, EDITS.model, EDITS.workflow, EDITS.seed, EDITS.tasks];
    let calls = 0;
    let injected = false;
    const model: Model = { async propose() { return { input: inputs[calls++], advice: [], usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.125, ms: 1 }; } };
    try {
      await assert.rejects(runWorldGen({ kind: 'create', input: { kind: 'description', text: 'Offline final report failure' }, outDir: dir }, configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5 }), {
        model, exampleWorld: minimalWorld(), runId: 'saved_crash', fs: { ...fs, async writeFile(path, ...args) {
          if (!injected && String(path).endsWith('REPORT.md')) { injected = true; throw failure; }
          return fs.writeFile(path, ...args);
        } },
      }), error => error === failure);
      assert.equal(calls, 5);
      assert.equal(existsSync(join(partialDir(dir), 'world.yaml')), true);
      assert.equal(existsSync(join(partialDir(dir), 'plan.yaml')), true);
      const capsule = capsuleSchema.parse(JSON.parse(readFileSync(join(partialDir(dir), 'capsule.json'), 'utf8')));
      assert.equal(capsule.costUsd, 0.625);
      assert.match(capsule.worldId ?? '', /^wid_[0-9a-f]{64}$/);
      assert.equal(capsule.attempts.length, 5);
      assert.match(readFileSync(join(partialDir(dir), 'REPORT.md'), 'utf8'), /^Crashed: final report write failed/);
      assert.match(readFileSync(join(partialDir(dir), 'REPORT.md'), 'utf8'), /world.yaml was written before the run failed/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('the eval caller records a crash with actual known spend and does not verify or pass it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wg-eval-crash-'));
    const layout = caseLayout(dir, 'exception');
    const ledger = openLedger(join(dir, 'costs.jsonl'));
    let calls = 0;
    let verified = false;
    const raw: Model = { async propose() { calls += 1; return { input: PLAN, advice: [], usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 }, costUsd: 0.125, ms: 1 }; } };
    const model = meteredModel(raw, ledger, { provider: 'claude-cli', account: 'claude-cli', caps: { maxTotalUsd: 1 } });
    try {
      const file = await runCase({ id: 'exception', input: { kind: 'description', text: 'Offline eval persistence error' }, expect: 'done' }, dir, layout, {
        run: (job, phase) => runWorldGen(job, configSchema.parse({ model: 'claude-sonnet-5-5', maxCostUsd: 5 }), {
          model, exampleWorld: minimalWorld(), runId: 'eval_crash', emit: createEmitter(layout.logDir[phase]), fs: { ...fs, async writeFile(path, ...args) {
            if (String(path).endsWith('001-plan-1.json')) throw new Error('eval attempt dump failed');
            return fs.writeFile(path, ...args);
          } },
        }),
        verify: async () => { verified = true; return { kind: 'pass', tasks: 1 }; },
      });
      assert.equal(calls, 1);
      assert.equal(verified, false);
      assert.deepEqual(file.phases, [{ phase: 'create', result: null, error: 'eval attempt dump failed' }]);
      assert.deepEqual(file.verify, { kind: 'not_run' });
      const log = parseEventLog(readFileSync(layout.events.create, 'utf8'));
      const row = summarizeCase({ ...file, phases: file.phases.map(phase => ({ ...phase, log })) });
      assert.equal(row.status, 'crashed');
      assert.equal(row.pass, false);
      assert.equal(row.costUsd, 0.125);
      assert.equal(row.unknownCostCalls, 0);
      assert.equal(row.logged, true);
      assert.equal(row.stop, 'crashed: eval attempt dump failed');
      assert.equal(ledger.totals().usd, 0.125);
      assert.match(readFileSync(join(partialDir(layout.world), 'REPORT.md'), 'utf8'), /^Crashed: eval attempt dump failed/);
      const capsule = capsuleSchema.parse(JSON.parse(readFileSync(join(partialDir(layout.world), 'capsule.json'), 'utf8')));
      assert.equal(capsule.costUsd, 0.125);
      assert.equal(capsule.worldId, null);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
