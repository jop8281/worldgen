/**
 * The runtime HTTP error-code catalog (YOS-184): closed against what api.ts and http.ts
 * actually emit, the single source behind x-error-codes, and split from the other two code
 * sets: check issues (ISSUES in issues.ts) and handler codes, which are world data passed
 * to ctx.fail (design.md s4 item 9).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { before, describe, it } from 'node:test';
import { checkWorld, loadWorld, type CheckedWorld } from '#engine';
import { RUNTIME_ERROR_CODES, type RuntimeErrorCode } from '../src/engine/error-codes.ts';
import { ISSUES } from '../src/engine/issues.ts';
import { ENGINE_ERROR_CODES, openApiOf } from '../src/engine/openapi.ts';

const HELPDESK = fileURLToPath(new URL('../../prod/worlds/helpdesk', import.meta.url));

async function helpdesk(): Promise<CheckedWorld> {
  const loaded = await loadWorld(HELPDESK);
  if (!loaded.ok) assert.fail(JSON.stringify(loaded.error));
  const report = checkWorld(loaded.value);
  if (!report.ok) assert.fail(JSON.stringify(report.issues));
  return report.world;
}

/** The closed catalog: one pinned status per code. A new code fails here until it joins this list. */
const CATALOG: Readonly<Record<string, number>> = {
  // A routed call: api.ts, and the store refusals it surfaces
  'path.invalid': 400, 'query.invalid': 400, 'query.unknown': 400, 'cursor.invalid': 400, 'body.invalid': 400, 'input.invalid': 400,
  'route.not_found': 404, 'row.not_found': 404, 'entity.unknown': 404, 'method.not_allowed': 405,
  'field.unique': 409, 'delete.restricted': 409,
  'field.unknown': 422, 'field.readonly': 422, 'field.required': 422, 'field.null': 422, 'field.type': 422, 'ref.unresolved': 422,
  'state.initial': 422, 'state.transition': 422, 'action.failed': 500,
  // The runtime around a call: api.ts
  'idempotency_error': 400, 'engine.internal': 500,
  // The HTTP adapter: http.ts
  'body.too_large': 413, 'engine.error': 500,
  // The admin routes: http.ts
  'clock.invalid': 400, 'task.unknown': 404, 'grade.failed': 500,
};

/** Code-shaped string literals in quotes: word characters joined by dots or underscores, one whole literal. */
const CODE_LITERAL = /(['"])([a-z][a-z0-9_]*(?:[._][a-z][a-z0-9_]*)+)\1/g;

/** Every runtime code each file mints, found by grep. A new emit fails here until it joins the catalog. */
const EMITTED: Readonly<Record<'api.ts' | 'http.ts', readonly RuntimeErrorCode[]>> = {
  'api.ts': [
    'path.invalid', 'query.invalid', 'query.unknown', 'cursor.invalid', 'body.invalid', 'input.invalid',
    'entity.unknown', 'row.not_found', 'route.not_found', 'method.not_allowed', 'action.failed',
    'idempotency_error', 'engine.internal',
  ],
  'http.ts': [
    'route.not_found', 'method.not_allowed', 'body.invalid', 'body.too_large',
    'clock.invalid', 'task.unknown', 'grade.failed', 'engine.error',
  ],
};

/**
 * Code-shaped literals in each file that are not runtime codes: engine column names, the
 * one-segment openapi.json path, and the store's tx.aborted, which is compared and never
 * emitted. Names in ISSUES, the check-issue catalog, are allowed the same way: a different
 * closed set.
 */
const NOT_RUNTIME: Readonly<Record<'api.ts' | 'http.ts', readonly string[]>> = {
  'api.ts': ['created_at', 'openapi.json', 'tx.aborted', 'updated_at'],
  'http.ts': [],
};

const literalsOf = (file: 'api.ts' | 'http.ts'): string[] =>
  [...readFileSync(fileURLToPath(new URL(`../src/engine/${file}`, import.meta.url)), 'utf8').matchAll(CODE_LITERAL)]
    .map((m) => m[2]!);

describe('RUNTIME_ERROR_CODES, the closed runtime catalog', () => {
  it('is exactly the literal list, with the pinned status per code', () => {
    assert.deepEqual(Object.keys(RUNTIME_ERROR_CODES), Object.keys(CATALOG));
    for (const [code, def] of Object.entries(RUNTIME_ERROR_CODES)) {
      assert.equal(def.status, CATALOG[code], code);
    }
  });

  it('documents the runtime-only codes the public document leaves out', () => {
    assert.equal(RUNTIME_ERROR_CODES['idempotency_error'].meaning, 'The Idempotency-Key was already used with a different request.');
    assert.equal(RUNTIME_ERROR_CODES['engine.internal'].meaning, 'The runtime around the call failed; the call left no partial change.');
    assert.equal(RUNTIME_ERROR_CODES['body.too_large'].meaning, 'The request body is larger than the adapter reads.');
    assert.equal(RUNTIME_ERROR_CODES['engine.error'].meaning, 'The HTTP adapter failed while answering the request.');
    assert.equal(RUNTIME_ERROR_CODES['clock.invalid'].meaning, 'The admin clock body is not {"advance": "<duration>"}, or the move passes the latest instant.');
    assert.equal(RUNTIME_ERROR_CODES['task.unknown'].meaning, 'The admin grade route names a task the world does not have.');
    assert.equal(RUNTIME_ERROR_CODES['grade.failed'].meaning, 'Grading the named task failed.');
  });

  it('shares no code with ISSUES, the check-issue catalog', () => {
    for (const code of Object.keys(RUNTIME_ERROR_CODES)) {
      assert.equal(Object.hasOwn(ISSUES, code), false, code);
    }
  });

  it('holds every runtime code api.ts and http.ts mint, and only those', () => {
    for (const file of ['api.ts', 'http.ts'] as const) {
      const found = [...new Set(literalsOf(file))];
      const runtime = found.filter((c) => Object.hasOwn(RUNTIME_ERROR_CODES, c));
      assert.deepEqual(runtime.sort(), [...EMITTED[file]].sort(), file);
      const other = found.filter((c) => !Object.hasOwn(RUNTIME_ERROR_CODES, c) && !Object.hasOwn(ISSUES, c));
      assert.deepEqual(other.sort(), [...NOT_RUNTIME[file]].sort(), file);
    }
  });
});

describe('x-error-codes derives from the catalog', () => {
  let world: CheckedWorld;
  before(async () => {
    world = await helpdesk();
  });

  /** The public subset, byte for byte as GET /openapi.json answers it. */
  const X_ERROR_CODES = {
    'path.invalid': { status: 400, meaning: 'A path segment is not valid percent-encoding.' },
    'query.invalid': { status: 400, meaning: 'A query value does not parse: a filter, limit, sort, or the percent-encoding itself.' },
    'query.unknown': { status: 400, meaning: 'A query parameter this operation does not declare.' },
    'cursor.invalid': { status: 400, meaning: 'The cursor was not returned by this list, or was issued under another sort.' },
    'body.invalid': { status: 400, meaning: 'The request body is not a JSON object.' },
    'input.invalid': { status: 400, meaning: "The body breaks the action's input fields." },
    'route.not_found': { status: 404, meaning: 'No route or action matches the path.' },
    'row.not_found': { status: 404, meaning: 'No row has this id.' },
    'entity.unknown': { status: 404, meaning: 'An action handler named an entity the world does not have.' },
    'method.not_allowed': { status: 405, meaning: 'The path exists only under other methods.' },
    'field.unique': { status: 409, meaning: 'Another row already holds this value in a unique field.' },
    'delete.restricted': { status: 409, meaning: 'Another row references this one with onDelete restrict.' },
    'field.unknown': { status: 422, meaning: 'The body names a field the entity does not have.' },
    'field.readonly': { status: 422, meaning: 'The body sets id, created_at, updated_at or a readonly field.' },
    'field.required': { status: 422, meaning: 'A required field is missing.' },
    'field.null': { status: 422, meaning: 'A field that is not nullable would be null.' },
    'field.type': { status: 422, meaning: "A value does not fit the field's type." },
    'ref.unresolved': { status: 422, meaning: 'A ref names a row that does not exist.' },
    'state.initial': { status: 422, meaning: 'A create sets a state field to something other than its initial state.' },
    'state.transition': { status: 422, meaning: 'A write moves a state field along an undeclared transition.' },
    'action.failed': { status: 500, meaning: 'The action handler threw or returned a malformed result.' },
  };

  it('is the public subset of the catalog, byte for byte', () => {
    assert.deepEqual(openApiOf(world)['x-error-codes'], X_ERROR_CODES);
  });

  it('is the catalog members themselves, so statuses and meanings cannot drift', () => {
    assert.deepEqual(Object.keys(ENGINE_ERROR_CODES), Object.keys(X_ERROR_CODES));
    for (const [code, def] of Object.entries(ENGINE_ERROR_CODES)) {
      assert.equal(def, RUNTIME_ERROR_CODES[code as RuntimeErrorCode], code);
    }
  });
});
