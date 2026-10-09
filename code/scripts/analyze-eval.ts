import { readFile } from 'node:fs/promises';
import { parseSuite } from '../src/worldgen/eval.ts';
import { analyzeEvalOutcomes } from '../src/worldgen/eval-outcomes.ts';
import { readEvalEvidence } from '../src/cli/eval-analysis-files.ts';

const USAGE = `Usage: bun scripts/analyze-eval.ts SUITE_FILE RUN_DIRECTORY

Recomputes a run's scorecard from its committed events: each case's outcome, the pass count and rate, time and cost.
Exit 0 only when the run covers the whole suite and every case passed, 1 otherwise, 2 on bad usage. A targeted rerun
or a full run with any failure exits 1, so read the numbers, not the exit code.`;
const args = process.argv.slice(2);
if (args.some((a) => a === '--help' || a === '-h')) {
  console.log(USAGE);
} else if (args.length !== 2) {
  console.error(USAGE);
  process.exitCode = 2;
} else {
  try {
    const suite = parseSuite(await readFile(args[0]!, 'utf8'));
    if (!suite.ok) throw new Error('Invalid suite');
    const report = analyzeEvalOutcomes(suite.suite.cases, await readEvalEvidence(args[1]!, suite.suite.cases));
    console.log(JSON.stringify(report, null, 2));
    process.exitCode = report.completeSuite && report.allPassed ? 0 : 1;
  } catch {
    console.error('Cannot analyze eval: invalid suite or unreadable run directory');
    process.exitCode = 2;
  }
}
