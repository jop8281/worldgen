/** Static evidence for the existing OpenAPI projection. Pure: no IO, model, clock or HTTP replay. */
import type { World } from './format.ts';
import type { CheckIssue } from './issues.ts';
import { openapiFidelity, underPrefix } from './openapi-fidelity.ts';

const checks = Object.freeze({
  'operation-presence': 'GET, POST, PUT, PATCH and DELETE presence; path parameters match by position.',
  'required-input-projection': 'Existing missing/extra required-input checks, including documented ID and alternative-field exemptions.',
  'primitive-type-projection': 'Types of matched primitive fields, after name normalization and identifier conversion.',
  'response-enum-projection': 'Enums of matched fields in the first success response, with values converted to text and null removed.',
});
const limitations = Object.freeze({
  'success-statuses': 'Any 2xx can satisfy a source success status; literal status equivalence is not checked.',
  'error-statuses': 'An engine status-class wildcard can satisfy a source error status.',
  'field-spelling': 'Names ignore case, underscores and hyphens; path parameter names are positional.',
  'identifier-types': 'Numeric ID/ref fields may be represented as strings.',
  'request-enums': 'A matched request enum may be narrower than the source enum.',
  'enum-values': 'Enum comparison converts values to strings and removes null.',
  'nested-objects': 'Nested object shapes are not compared; a source object may become a reference field.',
  arrays: 'Array field types, item shapes and values are not compared.',
  'form-encoding': 'Form bodies contribute required-input checks, not wire encoding or type/enum checks.',
  'media-types': 'Only application/json and required fields from application/x-www-form-urlencoded are projected.',
  references: 'Only bounded local references are followed. Unresolved references are not conformance evidence.',
  'reference-siblings': 'Reference sibling constraints are not preserved by this comparator.',
  'schema-composition': 'allOf properties are merged with a depth bound, not checked as a full schema intersection.',
  'schema-keywords': 'Other schema constraints are outside the compared projection.',
  nullability: 'Nullability is not compared; null is removed from type and enum comparisons.',
  parameters: 'Path, query, header and cookie parameter schemas and serialization are not compared.',
  security: 'Authentication and authorization behavior are not compared.',
  'error-bodies': 'Error body schemas, headers and runtime error values are not compared.',
  'response-selection': 'Only the first declared success response contributes response fields.',
  'default-response': 'The default response is not compared.',
  'optional-field-presence': 'An unmatched optional request or response field can be absent without a mismatch.',
  'http-behavior': 'Static comparison is not HTTP replay or proof of atomic refusal.',
  extensions: 'Vendor extensions, callbacks, links and webhooks are outside this profile.',
});

export const OPENAPI_CONFORMANCE_PROFILE = Object.freeze({
  id: 'worldgen.openapi.normalized.v1', version: 1,
  claim: 'normalized-projection-only', exactEquivalence: false,
  checks, limitations,
} as const);

type Feature = keyof typeof limitations;
export type OpenapiDisclosure = {
  readonly feature: Feature;
  readonly operation: string;
  /** JSON pointer at the reference use site, including properties reached through local refs. */
  readonly pointer: string;
  readonly reason: string;
};
export type OpenapiRefusal = { readonly feature: string; readonly pointer: string; readonly reason: string };
export type OpenapiCoverage = {
  readonly only: readonly string[];
  readonly operations: readonly string[];
  readonly disclosures: readonly OpenapiDisclosure[];
  readonly refusals: readonly OpenapiRefusal[];
};
export type OpenapiConformanceOptions = {
  readonly only?: readonly string[];
  readonly exact?: boolean;
  /** Only named checks from the profile are supported requirements; unknown names fail closed. */
  readonly require?: readonly string[];
};
export type OpenapiConformance = {
  readonly profile: typeof OPENAPI_CONFORMANCE_PROFILE;
  readonly scope: OpenapiCoverage;
  readonly requirements: { readonly exact: boolean; readonly features: readonly string[] };
  readonly issues: readonly CheckIssue[];
  readonly refusals: readonly OpenapiRefusal[];
  /** Null when incomplete source coverage prevented comparison. */
  readonly projectionPassed: boolean | null;
  /** Acceptance of the named projection only, never exact API equivalence. */
  readonly ok: boolean;
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);
const METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as const;
const COMPARED = new Set<string>(['get', 'post', 'put', 'patch', 'delete']);
const DATA = new Set(['example', 'examples', 'default', 'description', 'summary', 'title', 'externalDocs', 'operationId', 'tags', 'enum', 'required', 'security']);
const CONSTRAINTS = new Set(['oneOf', 'anyOf', 'not', 'if', 'then', 'else', 'const', 'additionalProperties', 'unevaluatedProperties', 'patternProperties', 'pattern', 'format', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'minItems', 'maxItems', 'uniqueItems', 'minProperties', 'maxProperties', 'discriminator', 'readOnly', 'writeOnly']);
const escapePointer = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');
const fieldKey = (s: string): string => s.toLowerCase().replace(/[_-]/g, '');
const MAX_NODES = 20000;
const MAX_RECORDS = 1000;
const MAX_DEPTH = 16;

/** Detected source features, not a full OpenAPI validator. Never copies examples, enum values or reference URLs. */
export function openapiCoverage(spec: unknown, only: readonly string[] = []): OpenapiCoverage {
  const operations: string[] = [];
  const disclosures: OpenapiDisclosure[] = [];
  const refusals: OpenapiRefusal[] = [];
  const seen = new Set<string>();
  let nodes = 0;
  let exhausted = false;
  const limit = (pointer: string): void => {
    if (!exhausted) refusals.push({ feature: 'analysis-limit', pointer, reason: 'Source coverage exceeded the bounded traversal or evidence limit. No projection pass is claimed.' });
    exhausted = true;
  };
  const refuse = (feature: string, pointer: string, reason: string): void => {
    if (exhausted) return;
    if (refusals.length + disclosures.length >= MAX_RECORDS) { limit(pointer); return; }
    refusals.push({ feature, pointer, reason });
  };
  const add = (feature: Feature, operation: string, pointer: string): void => {
    const key = JSON.stringify([feature, operation, pointer]);
    if (seen.has(key) || exhausted) return;
    if (refusals.length + disclosures.length >= MAX_RECORDS) { limit(pointer); return; }
    seen.add(key);
    disclosures.push({ feature, operation, pointer, reason: limitations[feature] });
  };
  const resolve = (ref: string): unknown => {
    // Match the existing comparator, which does not URI-decode pointer segments or traverse arrays.
    if (!ref.startsWith('#/') || ref.includes('%')) return undefined;
    let node: unknown = spec;
    for (const raw of ref.slice(2).split('/')) {
      if (/~(?![01])/.test(raw)) return undefined;
      const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
      if (!obj(node) || !Object.hasOwn(node, key)) return undefined;
      node = node[key];
    }
    return node;
  };
  const walk = (node: unknown, pointer: string, operation: string, where: 'request' | 'response', ancestors: ReadonlySet<object>, depth = 0, field?: string): void => {
    if (exhausted) return;
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) { limit(pointer); return; }
    if (node === null || typeof node !== 'object') return;
    if (ancestors.has(node)) {
      add('references', operation, pointer);
      refuse('cyclic-reference', pointer, 'A cyclic source schema cannot be completely compared by this profile.');
      return;
    }
    const next = new Set(ancestors).add(node);
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length && !exhausted; i++) walk(node[i], `${pointer}/${i}`, operation, where, next, depth + 1);
      return;
    }
    if (!obj(node)) return;
    if (Object.hasOwn(node, '$ref')) {
      add('references', operation, `${pointer}/$ref`);
      if (Object.keys(node).some((key) => key !== '$ref' && !DATA.has(key))) add('reference-siblings', operation, pointer);
      const target = typeof node.$ref === 'string' ? resolve(node.$ref) : undefined;
      if (!obj(target)) refuse('unresolved-reference', `${pointer}/$ref`, 'A reference is remote, missing or unsupported. Inline or resolve it locally before claiming conformance.');
      else walk(target, pointer, operation, where, next, depth + 1, field);
    }
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if (types.includes('array') || Object.hasOwn(node, 'items')) add('arrays', operation, pointer);
    if (field !== undefined && (types.includes('object') || obj(node.properties))) add('nested-objects', operation, pointer);
    if (field !== undefined && fieldKey(field).endsWith('id') && (types.includes('integer') || types.includes('number'))) add('identifier-types', operation, pointer);
    if (types.includes('null') || node.nullable === true) add('nullability', operation, pointer);
    if (Array.isArray(node.enum)) {
      add('enum-values', operation, pointer);
      if (where === 'request') add('request-enums', operation, pointer);
    }
    for (const [key, child] of Object.entries(node)) {
      if (exhausted) break;
      const at = `${pointer}/${escapePointer(key)}`;
      if (key === '$ref' || DATA.has(key)) continue;
      if (key === 'allOf') add('schema-composition', operation, at);
      if (CONSTRAINTS.has(key)) add('schema-keywords', operation, at);
      if (key.startsWith('x-') || key === 'callbacks' || key === 'links' || key === 'webhooks') { add('extensions', operation, at); continue; }
      if (key === 'schema' && !obj(child)) refuse('unsupported-schema', at, 'This projection requires mapping schemas; boolean or malformed schemas are not compared.');
      if (key === 'content' && obj(child)) {
        for (const mime of Object.keys(child)) {
          if (mime === 'application/x-www-form-urlencoded') add('form-encoding', operation, `${at}/${escapePointer(mime)}`);
          else if (mime !== 'application/json') add('media-types', operation, `${at}/${escapePointer(mime)}`);
        }
      }
      if (key === 'properties' && obj(child)) {
        const names = new Set<string>();
        for (const [name, schema] of Object.entries(child)) {
          if (exhausted) break;
          const property = `${at}/${escapePointer(name)}`;
          const normalized = fieldKey(name);
          if (names.has(normalized)) refuse('ambiguous-field-names', property, 'Distinct source fields collide under comparator name normalization.');
          names.add(normalized);
          add('field-spelling', operation, property);
          add('optional-field-presence', operation, property);
          if (!obj(schema)) refuse('unsupported-schema', property, 'This projection requires mapping property schemas.');
          walk(schema, property, operation, where, next, depth + 1, name);
        }
      } else walk(child, at, operation, where, next, depth + 1, key === 'items' ? 'items' : undefined);
    }
  };
  if (!obj(spec) || typeof spec.openapi !== 'string' || !/^3\.(0|1)\.\d+$/.test(spec.openapi) || !obj(spec.paths)) {
    refuse('invalid-document', '#', 'This profile requires an OpenAPI 3.0 or 3.1 document with a paths mapping.');
    return { only: [...only], operations, disclosures, refusals };
  }
  const operationKeys = new Set<string>();
  for (const [path, item] of Object.entries(spec.paths)) {
    if (exhausted) break;
    if (!underPrefix(path, only)) continue;
    const at = `#/paths/${escapePointer(path)}`;
    if (++nodes > MAX_NODES) { limit(at); break; }
    if (path.startsWith('x-')) continue;
    if (!path.startsWith('/') || !obj(item)) { refuse('invalid-path-item', at, 'A selected path must start with / and contain a mapping.'); continue; }
    if (Object.hasOwn(item, '$ref')) refuse('path-item-reference', at, 'Path-item references are not compared; inline this path item.');
    for (const method of METHODS) {
      if (exhausted) break;
      if (!Object.hasOwn(item, method)) continue;
      const operation = `${method.toUpperCase()} ${path}`;
      const pointer = `${at}/${method}`;
      const operationKey = `${method} ${path.replace(/\{[^}]*\}/g, '{}')}`;
      if (operationKeys.has(operationKey)) refuse('ambiguous-operations', pointer, 'Selected source operations collide under positional path matching.');
      operationKeys.add(operationKey);
      operations.push(operation);
      const op = item[method];
      if (!obj(op)) { refuse('invalid-operation', pointer, 'The selected operation is not a mapping.'); continue; }
      if (!COMPARED.has(method)) refuse('unsupported-method', pointer, `${method.toUpperCase()} operations are not compared by this profile.`);
      if (path.includes('{')) add('field-spelling', operation, at);
      if (Object.hasOwn(spec, 'security') || Object.hasOwn(op, 'security')) add('security', operation, pointer);
      for (const [owner, base] of [[item, at], [op, pointer]] as const) {
        if (!Object.hasOwn(owner, 'parameters')) continue;
        add('parameters', operation, `${base}/parameters`);
        walk(owner.parameters, `${base}/parameters`, operation, 'request', new Set());
      }
      if (Object.hasOwn(op, 'requestBody')) {
        if (!obj(op.requestBody)) refuse('invalid-request-body', `${pointer}/requestBody`, 'The request body must be a mapping.');
        walk(op.requestBody, `${pointer}/requestBody`, operation, 'request', new Set());
      }
      if (!obj(op.responses) || Object.keys(op.responses).length === 0) {
        refuse('missing-responses', `${pointer}/responses`, 'The selected operation has no response mapping to compare.');
        continue;
      }
      let successes = 0;
      for (const [status, response] of Object.entries(op.responses)) {
        if (exhausted) break;
        const responseAt = `${pointer}/responses/${escapePointer(status)}`;
        if (status.startsWith('x-')) { add('extensions', operation, responseAt); continue; }
        if (!/^(default|[1-5](\d{2}|XX))$/.test(status) || !obj(response)) refuse('invalid-response', responseAt, 'A response needs a valid status/default key and a mapping.');
        if (status === 'default') add('default-response', operation, responseAt);
        else if (/^2/.test(status)) { successes++; add('success-statuses', operation, responseAt); }
        else { add('error-statuses', operation, responseAt); add('error-bodies', operation, responseAt); }
        walk(response, responseAt, operation, 'response', new Set());
      }
      if (successes > 1) add('response-selection', operation, `${pointer}/responses`);
      if (Object.hasOwn(op, 'callbacks')) add('extensions', operation, `${pointer}/callbacks`);
    }
  }
  if (operations.length === 0) refuse('empty-scope', '#/paths', 'No operations were selected; an empty comparison is not conformance evidence.');
  return { only: [...only], operations, disclosures, refusals };
}

/** Comparator codes that read only paths, methods and response status keys, never a schema. */
const STRUCTURAL: ReadonlySet<string> = new Set(['openapi.operation_missing', 'openapi.operation_extra', 'openapi.status_missing']);

const requirementsOf = (options: OpenapiConformanceOptions): OpenapiConformance['requirements'] => ({ exact: options.exact ?? false, features: [...(options.require ?? [])] });

/** Requirements this profile refuses whatever the world and source: exact equivalence, and any feature that is not a named check. */
export function unsupportedRequirements(options: OpenapiConformanceOptions): OpenapiRefusal[] {
  const { exact, features } = requirementsOf(options);
  const refusals: OpenapiRefusal[] = [];
  if (exact) refusals.push({ feature: 'exact-equivalence', pointer: '#', reason: 'Exact API equivalence is not supported by worldgen.openapi.normalized.v1. Separate HTTP and schema acceptance evidence is required.' });
  for (const feature of features) {
    if (Object.hasOwn(checks, feature)) continue;
    refusals.push({ feature, pointer: '#', reason: Object.hasOwn(limitations, feature) ? limitations[feature as Feature] : 'This is not a named check in the selected conformance profile.' });
  }
  return refusals;
}

/** The result when the requirements alone refuse, so no world or source is read: nothing is compared and nothing passes. Null when they are all supported. */
export function refusedConformance(options: OpenapiConformanceOptions): OpenapiConformance | null {
  const refusals = unsupportedRequirements(options);
  if (refusals.length === 0) return null;
  return {
    profile: OPENAPI_CONFORMANCE_PROFILE, scope: { only: [...(options.only ?? [])], operations: [], disclosures: [], refusals: [] },
    requirements: requirementsOf(options), issues: [], refusals, projectionPassed: null, ok: false,
  };
}

/** Wraps rather than weakens openapiFidelity. Unsupported explicit requirements and incomplete coverage fail closed. */
export function openapiConformance(world: World, spec: unknown, options: OpenapiConformanceOptions = {}): OpenapiConformance {
  const scope = openapiCoverage(spec, options.only ?? []);
  const requirements = requirementsOf(options);
  const refusals: OpenapiRefusal[] = [
    ...scope.refusals,
    ...unsupportedRequirements(options).map((r) => ({ ...r, pointer: scope.disclosures.find((d) => d.feature === r.feature)?.pointer ?? r.pointer })),
  ];
  // Incomplete source coverage may block a pass, never hide a failure. Operation and status checks read only paths and response
  // keys, so they stand under refusals; field, type and enum checks read schemas a refusal left unresolved, so they are dropped then.
  const compared = scope.operations.length > 0 ? openapiFidelity(world, spec, scope.only) : [];
  const issues = scope.refusals.length === 0 ? compared : compared.filter((i) => STRUCTURAL.has(i.code));
  const failed = issues.some((i) => i.severity === 'error');
  const projectionPassed = failed ? false : scope.refusals.length === 0 ? true : null;
  return { profile: OPENAPI_CONFORMANCE_PROFILE, scope, requirements, issues, refusals, projectionPassed, ok: projectionPassed === true && refusals.length === 0 };
}

export const OPENAPI_EVIDENCE_FORMAT = Object.freeze({ kind: 'worldgen.openapi.conformance-evidence', version: 1 } as const);

/**
 * passed: the named projection passed and every requirement is supported. failed: the comparator
 * found an error. refused: a requirement is outside the profile. unproven: source coverage left part
 * of the comparison unproven and no error was found. Only passed is acceptance, and never of exact
 * equivalence.
 */
export type OpenapiVerdict = 'passed' | 'failed' | 'refused' | 'unproven';

/** Versioned, JSON-ready evidence for one comparison. Fields are only added within a version; a changed meaning is a new version. */
export type OpenapiEvidence = typeof OPENAPI_EVIDENCE_FORMAT & OpenapiConformance & {
  readonly verdict: OpenapiVerdict;
  /** The profile's checks: what this comparison establishes when it passes. */
  readonly covered: readonly string[];
  /** Profile limitations the selected source uses: what is compared only as a projection, or not at all. */
  readonly projected: readonly string[];
  /** What was refused: requirements outside the profile, and source parts the profile cannot compare. */
  readonly unsupported: readonly string[];
};

const sortedUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();

export function openapiEvidence(result: OpenapiConformance): OpenapiEvidence {
  const requirementRefused = unsupportedRequirements({ exact: result.requirements.exact, require: result.requirements.features }).length > 0;
  const verdict: OpenapiVerdict = result.projectionPassed === false ? 'failed' : requirementRefused ? 'refused' : result.ok ? 'passed' : 'unproven';
  return {
    ...OPENAPI_EVIDENCE_FORMAT, ...result, verdict,
    covered: Object.keys(result.profile.checks),
    projected: sortedUnique(result.scope.disclosures.map((d) => d.feature)),
    unsupported: sortedUnique(result.refusals.map((r) => r.feature)),
  };
}
