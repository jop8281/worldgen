/** Markdown from engine conformance evidence. No model verdict, IO or world mutation. */
import { openapiEvidence, type OpenapiConformance } from '#engine';

const cell = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/\\/g, '&#92;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;')
  .replace(/\|/g, '&#124;').replace(/`/g, '&#96;').replace(/[\r\n]+/g, ' ');

/** What the normalized projection showed, in words. Refused requirements stop the comparison before the world or source is read. */
export function projectionText(result: OpenapiConformance): string {
  if (result.projectionPassed === true) return 'passed';
  if (result.projectionPassed === false) return 'failed';
  return result.scope.operations.length === 0 && result.scope.refusals.length === 0
    ? 'not compared (the requirements were refused before the world or source was read)'
    : 'incomplete (no failure found; refused source parts unproven)';
}

export function renderOpenapiConformance(result: OpenapiConformance): string {
  const evidence = openapiEvidence(result);
  return [
    '# OpenAPI conformance', '',
    `Profile: ${result.profile.id}. Evidence: ${evidence.kind} v${evidence.version}, verdict ${evidence.verdict}.`,
    `Normalized projection: ${projectionText(result)}. Requested requirements: ${result.ok ? 'accepted' : 'rejected'}.`,
    'Exact API equivalence: not established. This is static evidence, not HTTP replay or proof of atomic refusal.', '',
    `Input scope: ${result.scope.only.length === 0 ? 'all source paths' : result.scope.only.map(cell).join(', ')}.`,
    `Selected operations: ${result.scope.operations.length}.`,
    ...result.scope.operations.map((operation) => `- ${cell(operation)}`), '',
    '## Requested requirements', '',
    `Exact equivalence requested: ${result.requirements.exact ? 'yes' : 'no'}.`,
    `Required features: ${result.requirements.features.length === 0 ? 'none' : result.requirements.features.map(cell).join(', ')}.`, '',
    '## Checked projection', '',
    ...Object.entries(result.profile.checks).map(([name, reason]) => `- ${name}: ${reason}`), '',
    '## Profile limitations', '',
    ...Object.entries(result.profile.limitations).map(([name, reason]) => `- ${name}: ${reason}`), '',
    '## Detected source disclosures', '',
    'These identify source features subject to a limitation, not observed runtime differences. Pointers describe reference use sites.', '',
    '| Operation | Source pointer | Feature | Limitation |',
    '|---|---|---|---|',
    ...result.scope.disclosures.map((d) => `| ${cell(d.operation)} | ${cell(d.pointer)} | ${d.feature} | ${cell(d.reason)} |`), '',
    '## Refusals', '',
    ...(result.refusals.length === 0 ? ['None.'] : result.refusals.map((r) => `- ${cell(r.feature)} at ${cell(r.pointer)}: ${cell(r.reason)}`)), '',
    '## Comparator issues', '',
    ...(result.issues.length === 0 ? [result.projectionPassed === null ? 'Not evaluated.' : 'None.'] : result.issues.map((i) => `- ${i.severity} ${i.code} at ${cell(i.path.join('.'))}: ${cell(i.hint)}`)), '',
  ].join('\n');
}
