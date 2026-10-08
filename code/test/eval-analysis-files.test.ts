import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { readEvalEvidence } from '../src/cli/eval-analysis-files.ts';
import { analyzeEvalOutcomes } from '../src/worldgen/eval-outcomes.ts';
import type { RunEvent, StopReason } from '../src/worldgen/events.ts';

describe('offline eval evidence reader', () => {
  it('R4-R5 preserves missing/invalid/unexpected cases, ignores hidden history and leaves input bytes alone', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'eval-analysis-'));
    try {
      const expected = [{ id: 'alpha', expect: 'done' as const }, { id: 'beta', expect: 'done' as const }, { id: 'gamma', expect: 'done' as const }];
      for (const id of ['alpha', 'beta', 'extra', '.attempts']) await mkdir(path.join(root, id));
      const file = JSON.stringify({ id: 'alpha', expect: 'done', phases: [{ phase: 'create', result: 'done', error: null }], verify: { kind: 'pass', tasks: 3 } });
      await writeFile(path.join(root, 'alpha/case.json'), file);
      await writeFile(path.join(root, 'alpha/events.jsonl'), [
        { t: 'run_started', mode: 'create' }, { t: 'step_started', step: 'plan' }, { t: 'attempt', step: 'plan', n: 1 },
        { t: 'step_finished', step: 'plan', attempts: 1 }, { t: 'run_finished', ms: 0, costUsd: 0, result: { kind: 'done' } },
      ].map((e) => JSON.stringify({ ...e, runId: 'r' })).join('\n'));
      await writeFile(path.join(root, 'beta/case.json'), '{broken');
      await writeFile(path.join(root, 'extra/case.json'), file.replace('alpha', 'extra'));
      await writeFile(path.join(root, '.attempts/case.json'), file);
      const report = analyzeEvalOutcomes(expected, await readEvalEvidence(root, expected));
      assert.deepEqual(report.counts, { expected: 3, observed: 3, valid: 1, invalid: 1, missing: 1, duplicate: 0, unexpected: 1 });
      assert.equal(report.metrics.costUsd.measured, 1);
      assert.deepEqual(await readFile(path.join(root, 'alpha/case.json'), 'utf8'), file);
      await assert.rejects(readEvalEvidence(path.join(root, 'absent'), expected), /ENOENT/);
      await assert.rejects(readEvalEvidence(root, [{ id: '../escape', expect: 'done' }]), /case id/);

      const suite = path.join(root, 'suite.yaml');
      await writeFile(suite, 'name: sample\ncases:\n  - id: alpha\n    input: { kind: description, text: Sample }\n  - id: gamma\n    input: { kind: description, text: Missing }\n');
      const child = spawnSync(process.execPath, ['scripts/analyze-eval.ts', suite, root], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 20_000 });
      assert.equal(child.error, undefined, child.stderr);
      assert.equal(child.status, 1, child.stderr);
      const cli = JSON.parse(child.stdout);
      assert.equal(cli.counts.expected, 2);
      assert.equal(cli.counts.missing, 1);
      assert.equal(cli.passRate, 0.5);
      assert.equal(cli.metrics.costUsd.total, null);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('R4 rejects symlinked directories, case records and event paths without reading their contents', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'eval-analysis-links-'));
    const outside = await mkdtemp(path.join(tmpdir(), 'eval-analysis-outside-'));
    try {
      const file = JSON.stringify({ id: 'alpha', expect: 'done', phases: [{ phase: 'create', result: 'done', error: null }], verify: { kind: 'pass', tasks: 3 } });
      await writeFile(path.join(outside, 'case.json'), file);
      await writeFile(path.join(outside, 'events.jsonl'), 'SECRET-OUTSIDE');
      const expected = [{ id: 'alpha', expect: 'done' as const }];
      for (const target of ['directory', 'case.json', 'events.jsonl', 'change', 'change/events.jsonl']) {
        const dir = path.join(root, 'alpha');
        if (target === 'directory') await symlink(outside, dir, 'dir');
        else {
          await mkdir(dir);
          if (target !== 'case.json') await writeFile(path.join(dir, 'case.json'), file);
          if (target === 'change/events.jsonl') await mkdir(path.join(dir, 'change'));
          await symlink(target === 'change' ? outside : path.join(outside, target === 'case.json' ? 'case.json' : 'events.jsonl'), path.join(dir, target));
        }
        const report = analyzeEvalOutcomes(expected, await readEvalEvidence(root, expected));
        assert.equal(report.counts.invalid, 1, target);
        assert.equal(JSON.stringify(report).includes('SECRET-OUTSIDE'), false);
        await rm(dir, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('R4-R5 CLI exits zero only for a complete passing report and two for usage or unreadable inputs', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'eval-analysis-cli-'));
    try {
      await mkdir(path.join(root, 'alpha'));
      await writeFile(path.join(root, 'alpha/case.json'), JSON.stringify({ id: 'alpha', expect: 'stopped', phases: [{ phase: 'create', result: 'stopped', error: null }], verify: { kind: 'not_run' } }));
      // The current producer's input rejection before any step, with no model call: the only stop that passes an
      // expect: stopped case (A-384).
      const at = { runId: 'offline', at: '2026-10-07T00:00:00Z' };
      const reason: StopReason = { kind: 'input_rejected', why: 'The input could not be read: empty description' };
      const events: RunEvent[] = [
        { ...at, t: 'run_started', mode: 'create', input: 'description', model: 'offline-fixture', budgetUsd: 0, transport: 'claude-cli' },
        { ...at, t: 'run_finished', ms: 0, costUsd: 0, worldWritten: false, result: { kind: 'stopped', reason } },
      ];
      await writeFile(path.join(root, 'alpha/events.jsonl'), events.map((e) => JSON.stringify(e)).join('\n'));
      const suite = path.join(root, 'suite.yaml');
      await writeFile(suite, 'name: sample\ncases:\n  - id: alpha\n    input: { kind: description, text: Sample }\n    expect: stopped\n');
      const run = (args: string[]) => spawnSync(process.execPath, ['scripts/analyze-eval.ts', ...args], { cwd: path.resolve(import.meta.dirname, '..'), encoding: 'utf8', timeout: 20_000 });
      const complete = run([suite, root]);
      assert.equal(complete.error, undefined);
      assert.equal(complete.status, 0, complete.stderr);
      assert.equal(JSON.parse(complete.stdout).completeSuite, true);
      assert.equal(JSON.parse(complete.stdout).metrics.attempts.total, 0);
      for (const args of [[], [suite, path.join(root, 'absent')], [path.join(root, 'absent.yaml'), root]]) {
        const failed = run(args);
        assert.equal(failed.error, undefined);
        assert.equal(failed.status, 2);
        assert.equal(failed.stdout, '');
      }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
