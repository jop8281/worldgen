import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  OPENAPI_CONFORMANCE_PROFILE, checkWorld, loadWorld, openapiConformance, openapiCoverage, openapiEvidence,
  openapiFidelity, refusedConformance, serve, worldSchema, type World,
} from '#engine';
import { renderOpenapiConformance } from '../src/worldgen/openapi-report.ts';

const code = fileURLToPath(new URL('..', import.meta.url));
const helpdesk = fileURLToPath(new URL('../../prod/worlds/helpdesk', import.meta.url));
const source = (schema: unknown, mime = 'application/json') => ({
  openapi: '3.1.0',
  paths: { '/profile-probe': { post: {
    requestBody: { content: { [mime]: { schema } } },
    responses: { '200': { description: 'OK' } },
  } } },
});
const simple = { type: 'object', required: ['quantity'], properties: { quantity: { type: 'integer' } } };
const only = ['/profile-probe'];
let base: World;
before(async () => {
  const loaded = await loadWorld(helpdesk);
  assert.ok(loaded.ok);
  base = worldSchema.parse(loaded.value);
});
function probe(required = true): World {
  const world = structuredClone(base);
  world.actions.profile_probe = {
    method: 'POST', path: '/profile-probe', description: 'Literal profile test probe',
    input: { quantity: { type: 'int', required, nullable: false, unique: false, readonly: false } },
    handler: '(ctx) => ({ status: 200, body: { quantity: ctx.body.quantity } })',
  };
  return world;
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(value !== null && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

describe('OpenAPI conformance profile', () => {
  it('qualifies a passing projection and preserves its comparator issues exactly', () => {
    const world = probe();
    const spec = source(simple);
    const result = openapiConformance(world, spec, { only });
    assert.equal(result.ok, true);
    assert.equal(result.projectionPassed, true);
    assert.equal(result.profile.id, 'worldgen.openapi.normalized.v1');
    assert.equal(result.profile.exactEquivalence, false);
    assert.deepEqual(result.issues, openapiFidelity(world, spec, only));
    assert.deepEqual(result.scope.operations, ['POST /profile-probe']);
    assert.ok(result.scope.disclosures.some((d) => d.feature === 'success-statuses'));
  });

  it('refuses exact equivalence even when the projection passes', () => {
    const result = openapiConformance(probe(), source(simple), { only, exact: true });
    assert.equal(result.projectionPassed, true);
    assert.equal(result.ok, false);
    assert.deepEqual(result.refusals.map((r) => r.feature), ['exact-equivalence']);
  });

  it('accepts only named projection checks and refuses unknown or unsupported promises', () => {
    const world = probe();
    assert.equal(openapiConformance(world, source(simple), { only, require: Object.keys(OPENAPI_CONFORMANCE_PROFILE.checks) }).ok, true);
    for (const feature of ['form-encoding', 'http-behavior', 'nested-objects', 'typo-feature', '__proto__']) {
      const result = openapiConformance(world, source(simple), { only, require: [feature] });
      assert.equal(result.ok, false, feature);
      assert.equal(result.refusals[0]?.feature, feature);
      assert.ok(result.refusals[0]?.reason);
    }
  });

  it('preserves both missing and extra required-field failures', () => {
    const missing = openapiConformance(probe(false), source(simple), { only });
    assert.equal(missing.ok, false);
    assert.ok(missing.issues.some((i) => i.code === 'openapi.required_field_missing'));
    const extra = openapiConformance(probe(), source({ ...simple, required: [] }), { only });
    assert.equal(extra.ok, false);
    assert.ok(extra.issues.some((i) => i.code === 'openapi.required_field_extra'));
  });

  it('discloses nested, array, form, enum, ID and nullability projections', () => {
    const spec = source({ type: 'object', properties: {
      customerId: { type: 'integer' },
      nested: { properties: { count: { type: 'integer' } } },
      tags: { type: 'array', items: { type: 'string' } },
      mode: { type: ['string', 'null'], enum: ['literal-value-not-copied', null] },
    } }, 'application/x-www-form-urlencoded');
    const coverage = openapiCoverage(spec);
    assert.deepEqual(coverage.refusals, []);
    const found = new Set(coverage.disclosures.map((d) => d.feature));
    for (const feature of ['identifier-types', 'nested-objects', 'arrays', 'form-encoding', 'request-enums', 'enum-values', 'nullability', 'success-statuses'] as const) assert.ok(found.has(feature), feature);
    assert.ok(!JSON.stringify(coverage).includes('literal-value-not-copied'));
  });

  it('refuses missing and remote refs without copying their URLs or examples', () => {
    for (const ref of ['#/components/schemas/Missing', 'https://example.invalid/private?token=do-not-copy']) {
      const spec = source({ $ref: ref, example: 'secret-example-do-not-copy' });
      const result = openapiConformance(probe(), spec, { only });
      assert.equal(result.ok, false);
      assert.equal(result.projectionPassed, null);
      assert.ok(result.refusals.some((r) => r.feature === 'unresolved-reference'));
      assert.ok(!JSON.stringify(result).includes('do-not-copy'));
    }
  });

  it('detects cyclic references and schema traversal bounds', () => {
    const cyclic = { ...source({ $ref: '#/components/schemas/Loop' }), components: { schemas: { Loop: { type: 'object', properties: { child: { $ref: '#/components/schemas/Loop' } } } } } };
    assert.ok(openapiCoverage(cyclic).refusals.some((r) => r.feature === 'cyclic-reference'));
    let deep: unknown = { type: 'string' };
    for (let i = 0; i < 30; i++) deep = { type: 'object', properties: { child: deep } };
    const result = openapiConformance(probe(), source(deep));
    assert.equal(result.projectionPassed, null);
    assert.ok(result.refusals.some((r) => r.feature === 'analysis-limit'));
  });

  it('resolves escaped local pointer segments and inventories reference siblings', () => {
    const spec = { ...source({ $ref: '#/components/schemas/a~1b~0c', nullable: true }), components: { schemas: { 'a/b~c': simple } } };
    const result = openapiConformance(probe(), spec, { only });
    assert.equal(result.ok, true);
    assert.ok(result.scope.disclosures.some((d) => d.feature === 'reference-siblings'));
    assert.ok(result.scope.disclosures.some((d) => d.pointer.endsWith('/properties/quantity')));
  });

  it('rejects invalid documents, empty scopes and unimplemented HTTP methods', () => {
    for (const spec of [null, {}, { openapi: '2.0', paths: {} }, { openapi: '3.1.0', paths: {} }, { openapi: '3.1.0', paths: { '/x': { head: { responses: { '200': {} } } } } }]) {
      const result = openapiConformance(probe(), spec);
      assert.equal(result.ok, false);
      assert.equal(result.projectionPassed, null);
      assert.ok(result.refusals.length > 0);
    }
    assert.equal(openapiConformance(probe(), source(simple), { only: ['/not-selected'] }).ok, false);
  });

  it('scopes evidence using the shared prefix rule, ignoring unrelated unresolved input', () => {
    const spec = { ...source(simple), paths: { ...source(simple).paths, '/profile-probe-other': { post: {
      requestBody: { $ref: 'remote.yaml' }, responses: { '200': {} },
    } } } };
    assert.equal(openapiConformance(probe(), spec, { only }).ok, true);
    assert.equal(openapiConformance(probe(), spec).ok, false);
  });

  it('refuses ambiguous normalized source fields and bounds evidence without a silent success', () => {
    const ambiguous = source({ type: 'object', properties: { photoUrls: { type: 'string' }, photo_urls: { type: 'string' } } });
    assert.ok(openapiCoverage(ambiguous).refusals.some((r) => r.feature === 'ambiguous-field-names'));
    const properties = Object.fromEntries(Array.from({ length: 1100 }, (_, i) => [`field_${i}`, { type: 'string' }]));
    const result = openapiConformance(probe(), source({ type: 'object', properties }));
    assert.equal(result.projectionPassed, null);
    assert.ok(result.refusals.some((r) => r.feature === 'analysis-limit'));
    assert.ok(result.scope.disclosures.length <= 1000);
  });

  it('renders machine facts deterministically without mutating the source or world', () => {
    const world = probe();
    const spec = source(simple);
    const original = JSON.stringify({ world, spec });
    const result = openapiConformance(world, spec, { only, exact: true });
    const text = renderOpenapiConformance(result);
    assert.equal(text, renderOpenapiConformance(result));
    assert.match(text, /Normalized projection: passed/);
    assert.match(text, /Requested requirements: rejected/);
    assert.match(text, /Exact API equivalence: not established/);
    assert.match(text, /exact-equivalence/);
    assert.match(text, /POST \/profile-probe/);
    assert.equal(JSON.stringify({ world, spec }), original);
  });

  it('escapes source-controlled markup in Markdown evidence', () => {
    const result = openapiConformance(probe(), source(simple), { only, require: ['<b>|![x](https://example.invalid)'] });
    const text = renderOpenapiConformance(result);
    assert.ok(!text.includes('<b>'));
    assert.ok(!text.includes('![x]'));
    assert.match(text, /&lt;b&gt;&#124;!&#91;x&#93;/);
  });
});

describe('Versioned OpenAPI conformance evidence', () => {
  it('names its format, what it covers and what the source only projects, and never claims exact equivalence', () => {
    const evidence = openapiEvidence(openapiConformance(probe(), source(simple), { only }));
    assert.deepEqual([evidence.kind, evidence.version, evidence.verdict, evidence.ok], ['worldgen.openapi.conformance-evidence', 1, 'passed', true]);
    assert.equal(evidence.profile.exactEquivalence, false);
    assert.deepEqual(evidence.covered, ['operation-presence', 'required-input-projection', 'primitive-type-projection', 'response-enum-projection']);
    assert.deepEqual(evidence.projected, ['field-spelling', 'optional-field-presence', 'success-statuses']);
    assert.deepEqual(evidence.unsupported, []);
    assert.deepEqual(JSON.parse(JSON.stringify(evidence)), evidence);
  });

  it('gives a missing required field the failed verdict, and keeps the comparator issue', () => {
    const evidence = openapiEvidence(openapiConformance(probe(false), source(simple), { only }));
    assert.equal(evidence.verdict, 'failed');
    assert.deepEqual(evidence.issues, openapiFidelity(probe(false), source(simple), only));
    assert.ok(evidence.issues.length > 0);
  });

  it('never passes an invalid document or an empty scope, and names what it could not compare', () => {
    const invalid = openapiEvidence(openapiConformance(probe(), { swagger: '2.0' }, { only }));
    assert.deepEqual([invalid.verdict, invalid.ok, invalid.unsupported], ['unproven', false, ['invalid-document']]);
    const empty = openapiEvidence(openapiConformance(probe(), source(simple), { only: ['/nowhere'] }));
    assert.deepEqual([empty.verdict, empty.ok, empty.unsupported], ['unproven', false, ['empty-scope']]);
  });

  it('refuses exact equivalence and unnamed features from the requirements alone, before any world or source', () => {
    assert.equal(refusedConformance({ only, require: ['operation-presence'] }), null);
    const refused = refusedConformance({ only, exact: true, require: ['operation-presence', 'nested-objects'] });
    assert.ok(refused !== null);
    const evidence = openapiEvidence(refused);
    assert.deepEqual([evidence.verdict, evidence.ok, evidence.projectionPassed, evidence.unsupported], ['refused', false, null, ['exact-equivalence', 'nested-objects']]);
    assert.deepEqual([evidence.scope.operations, evidence.issues], [[], []]);
    assert.equal(openapiEvidence(openapiConformance(probe(), source(simple), { only, exact: true })).verdict, 'refused');
    assert.match(renderOpenapiConformance(refused), /Normalized projection: not compared \(the requirements were refused before the world or source was read\)/);
  });
});

function cli(args: readonly string[], world = helpdesk) {
  return spawnSync(process.execPath, ['src/cli/worldplay.ts', 'openapi', world, ...args], {
    cwd: code, encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024,
  });
}

describe('OpenAPI conformance CLI', () => {
  it('rejects empty feature requirements before attempting world or source IO', () => {
    const result = cli(['--spec', '/does-not-exist.json', '--require', 'operation-presence,']);
    assert.equal(result.status, 2, result.stderr);
    assert.match(result.stderr, /--require needs nonempty/);
  });

  it('refuses --exact before it reads the world or the source', () => {
    const result = cli(['--spec', '/does-not-exist.json', '--exact'], '/does-not-exist-world');
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /refused exact-equivalence at #: Exact API equivalence is not supported/);
    assert.match(result.stdout, /verdict refused; normalized projection not compared/);
    assert.doesNotMatch(result.stdout + result.stderr, /cannot read|does not exist|ENOENT/);
  });

  it('preserves legacy JSON, returns qualified evidence and never overwrites an existing report', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'yos160-'));
    const spec = path.join(dir, 'source.json');
    const report = path.join(dir, 'REPORT.md');
    const original = await readFile(path.join(helpdesk, 'world.yaml'), 'utf8');
    try {
      await writeFile(spec, JSON.stringify({ openapi: '3.1.0', paths: { '/tickets': { get: { responses: { '200': { description: 'OK' } } } } } }));
      const args = ['--spec', spec, '--only', '/tickets'];
      const legacy = cli([...args, '--json']);
      assert.equal(legacy.status, 0, legacy.stderr);
      assert.ok(Array.isArray(JSON.parse(legacy.stdout)));
      assert.match(legacy.stderr, /Exact API equivalence not established/);
      const evidence = cli([...args, '--json', '--profile', '--report', report]);
      assert.equal(evidence.status, 0, evidence.stderr);
      const value = JSON.parse(evidence.stdout);
      assert.equal(value.ok, true);
      assert.deepEqual([value.kind, value.version, value.verdict], ['worldgen.openapi.conformance-evidence', 1, 'passed']);
      assert.equal(value.profile.exactEquivalence, false);
      const saved = await readFile(report, 'utf8');
      assert.match(saved, /worldgen.openapi.normalized.v1/);
      const exact = cli([...args, '--exact', '--json', '--profile']);
      assert.equal(exact.status, 1, exact.stderr);
      assert.equal(JSON.parse(exact.stdout).ok, false);
      assert.equal(JSON.parse(exact.stdout).refusals[0].feature, 'exact-equivalence');
      const overwrite = cli([...args, '--report', report]);
      assert.equal(overwrite.status, 1, overwrite.stderr);
      assert.match(overwrite.stderr, /cannot create report/);
      assert.equal(await readFile(report, 'utf8'), saved);
      assert.equal(await readFile(path.join(helpdesk, 'world.yaml'), 'utf8'), original);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});

describe('Literal HTTP controls for the profiled surface', () => {
  it('retains status/error contracts and leaves state unchanged after refused writes', async () => {
    const checked = checkWorld(base);
    assert.ok(checked.ok, JSON.stringify(checked));
    const server = await serve(checked.world, { port: 0, adminPort: 0, host: '127.0.0.1', adminHost: '127.0.0.1' });
    const request = (url: string, init: NonNullable<Parameters<typeof fetch>[1]> = {}) => fetch(url, { ...init, signal: AbortSignal.timeout(10000) });
    try {
      // A successful list commits and ticks engine time, so the snapshot follows it; only the refused calls must change nothing.
      const listed = await request(`${server.url}/tickets`);
      assert.equal(listed.status, 200);
      assert.ok(Array.isArray(object(await listed.json()).data));
      const beforeResponse = await request(`${server.adminUrl}/_world/state`);
      assert.equal(beforeResponse.status, 200);
      const beforeState = await beforeResponse.json();
      const rejected = await request(`${server.url}/tickets`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(rejected.status, 422);
      assert.equal(object(object(await rejected.json()).error).code, 'field.required');
      const missing = await request(`${server.url}/tickets/not-an-existing-ticket`);
      assert.equal(missing.status, 404);
      assert.equal(object(object(await missing.json()).error).code, 'row.not_found');
      const afterResponse = await request(`${server.adminUrl}/_world/state`);
      assert.equal(afterResponse.status, 200);
      assert.deepEqual(await afterResponse.json(), beforeState);
    } finally { await server.close(); }
  });
});
