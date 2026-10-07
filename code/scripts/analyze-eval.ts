import { readFile } from 'node:fs/promises';
import { parseSuite } from '../src/worldgen/eval.ts';
import { analyzeEvalOutcomes } from '../src/worldgen/eval-outcomes.ts';
import { readEvalEvidence } from '../src/cli/eval-analysis-files.ts';

const args = process.argv.slice(2);
if (args.length !== 2) {
  console.error('Usage: bun scripts/analyze-eval.ts SUITE_FILE RUN_DIRECTORY');
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
