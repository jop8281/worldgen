/**
 * The openapi input kind (backlog wg-input-openapi). O1..O6 follow its acceptance list:
 * O1 load and narrowing, O2 summary, O3 apiShape, O4 observations, O5 redaction, O6 the Petstore fixture.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INPUT_KINDS, digestInput, redact, type InputDigest } from '../src/worldgen/input.ts';

const PETSTORE = fileURLToPath(new URL('./fixtures/petstore.openapi.yaml', import.meta.url));
/** The deliberate redaction-test token planted in the Petstore fixture. */
const TOKEN = 'tok_REDACTION_TEST_8f2c4e6a';

async function petstore(only: string[] = []): Promise<InputDigest> {
  const r = await digestInput({ kind: 'openapi', path: PETSTORE, only });
  if (!r.ok) throw new Error(r.why);
  return r.digest;
}

/** Digests an inline document the way digestInput does after load. */
const digestDoc = (document: unknown, only: string[] = []): InputDigest => INPUT_KINDS.openapi.digest(redact('openapi', { document, only }));

const opLines = (d: InputDigest): string[] => d.summary.split('\n').filter((l) => /^[A-Z]+ \//.test(l));

async function tempFile(name: string, content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wg-openapi-'));
  const path = join(dir, name);
  await writeFile(path, content);
  return path;
}

const ok200 = (schema: unknown) => ({ '200': { description: 'ok', content: { 'application/json': { schema } } } });

describe('openapi load', () => {
  it('O1 reads YAML and passes only through', async () => {
    const loaded = await INPUT_KINDS.openapi.load({ kind: 'openapi', path: PETSTORE, only: ['/store'] });
    assert.equal((loaded.document as { openapi: string }).openapi, '3.0.3');
    assert.deepEqual(loaded.only, ['/store']);
  });

  it('O1 reads JSON', async () => {
    const doc = { openapi: '3.1.0', info: { title: 'Tiny', version: '2' }, paths: { '/a': { get: { summary: 'Get a', responses: ok200({ type: 'string' }) } } } };
    const r = await digestInput({ kind: 'openapi', path: await tempFile('tiny.json', JSON.stringify(doc)), only: [] });
    assert.equal(r.ok && r.digest.summary, ['OpenAPI 3.1.0: Tiny, version 2', 'Operations: kept 1 of 1; dropped 0.', 'GET /a: Get a', '  responses: 200 string', 'Error schema: none declared.', 'List envelope: none (no GET response wraps a data array).'].join('\n'));
    assert.equal(r.ok && r.digest.apiShape, null);
  });

  it('O1 refuses a missing file, Swagger 2.0, a non-mapping, bad YAML and a document without paths', async () => {
    assert.deepEqual(await digestInput({ kind: 'openapi', path: '/nonexistent/petstore.yaml', only: [] }), { ok: false, why: 'Cannot read OpenAPI file /nonexistent/petstore.yaml (ENOENT).' });
    const swagger = await tempFile('old.yaml', 'swagger: "2.0"\npaths: {}\n');
    assert.deepEqual(await digestInput({ kind: 'openapi', path: swagger, only: [] }), { ok: false, why: `${swagger} is Swagger 2.0. Only OpenAPI 3.x is supported; convert it first.` });
    const list = await tempFile('list.yaml', '- a\n- b\n');
    assert.deepEqual(await digestInput({ kind: 'openapi', path: list, only: [] }), { ok: false, why: `${list} is not an OpenAPI document: its top level is not a mapping.` });
    const bad = await tempFile('bad.yaml', 'openapi: 3.0.0\npaths: [unclosed\n');
    const r = await digestInput({ kind: 'openapi', path: bad, only: [] });
    assert.equal(!r.ok && r.why.startsWith(`${bad} is not valid YAML or JSON: `), true);
    const noPaths = await tempFile('nopaths.yaml', 'openapi: 3.0.0\ninfo: { title: x, version: "1" }\n');
    assert.deepEqual(await digestInput({ kind: 'openapi', path: noPaths, only: [] }), { ok: false, why: `${noPaths} has no paths.` });
    const notOpenapi = await tempFile('plain.yaml', 'paths: {}\n');
    assert.deepEqual(await digestInput({ kind: 'openapi', path: notOpenapi, only: [] }), { ok: false, why: `${notOpenapi} is not an OpenAPI document: it has no "openapi: 3.x" field.` });
  });

  it('O2 refuses a document with no operations', () => {
    assert.throws(() => digestDoc({ openapi: '3.0.0', paths: {} }), { message: 'The OpenAPI document has no operations.' });
  });
});

describe('openapi narrowing', () => {
  it('O6 only /store keeps only /store operations and counts the dropped ones', async () => {
    const d = await petstore(['/store']);
    assert.deepEqual(opLines(d), [
      'GET /store/inventory: Returns pet inventories by status',
      'POST /store/orders: Place an order for a pet',
      'GET /store/orders/{orderId}: Find purchase order by ID',
      'DELETE /store/orders/{orderId}: Delete purchase order by ID',
    ]);
    assert.equal(d.summary.split('\n')[4], 'Operations: kept 4 of 7 under /store; dropped 3.');
    assert.equal(/\s\/pets/.test(d.summary), false);
  });

  it('O1 a prefix matches at a segment boundary, with or without a trailing slash', async () => {
    assert.equal(opLines(await petstore(['/store/'])).length, 4);
    const r = await digestInput({ kind: 'openapi', path: PETSTORE, only: ['/sto'] });
    assert.deepEqual(r, { ok: false, why: 'No operation path starts with /sto. Paths: /pets, /pets/{petId}, /store/inventory, /store/orders, /store/orders/{orderId}.' });
  });

  it('O1 several prefixes keep the union', async () => {
    const d = await petstore(['/pets', '/store/inventory']);
    assert.deepEqual(opLines(d), ['GET /pets: List all pets', 'POST /pets: Create a pet', 'GET /pets/{petId}: Info for a specific pet', 'GET /store/inventory: Returns pet inventories by status']);
    assert.equal(d.summary.split('\n')[4], 'Operations: kept 4 of 7 under /pets, /store/inventory; dropped 3.');
  });
});

describe('openapi summary', () => {
  it('O2 O6 the Petstore fixture summary', async () => {
    assert.equal((await petstore()).summary, [
      'OpenAPI 3.0.3: Swagger Petstore, version 1.0.0',
      'About: A sample pet store with pets and store orders.',
      'Server: https://petstore.example.com/v1',
      'Auth: api_key apiKey header X-Api-Key',
      'Operations: kept 7 of 7; dropped 0.',
      'GET /pets: List all pets',
      '  params: limit query integer, Authorization header string',
      '  responses: 200 array<Pet>, default Error',
      'POST /pets: Create a pet',
      '  body (application/json): name string required, tag string',
      '  responses: 201 Pet, default Error',
      'GET /pets/{petId}: Info for a specific pet',
      '  params: petId path integer(int64) required',
      '  responses: 200 Pet, default Error',
      'GET /store/inventory: Returns pet inventories by status',
      '  responses: 200 map<integer(int32)>',
      'POST /store/orders: Place an order for a pet',
      '  body (application/json): id integer(int64), pet_id integer(int64) required, quantity integer required, ship_date string(date-time), status enum(placed|approved|delivered), complete boolean',
      '  responses: 200 Order, 400 Error',
      'GET /store/orders/{orderId}: Find purchase order by ID',
      '  params: orderId path integer(int64) required',
      '  responses: 200 Order, 404 Error',
      'DELETE /store/orders/{orderId}: Delete purchase order by ID',
      '  params: orderId path integer(int64) required',
      '  responses: 204, 404 Error',
      'Schemas:',
      '  Pet: name string required, tag string, id integer(int64) required',
      '  NewPet: name string required, tag string',
      '  Error: code integer(int32) required, message string required',
      '  Order: id integer(int64), pet_id integer(int64) required, quantity integer required, ship_date string(date-time), status enum(placed|approved|delivered), complete boolean',
      'Error schema: Error, used by 6 of 6 error responses.',
      'List envelope: none (no GET response wraps a data array).',
      'Proposed meta.api: {"list":{"mode":"cursor","dataKey":"data","cursorKey":"next_cursor","limitParam":"limit","cursorParam":"cursor","hasMoreKey":"has_more","startingAfterParam":"starting_after","endingBeforeParam":"ending_before"},"error":{"code":"$status","message":"$message"}}',
    ].join('\n'));
  });

  it('O1 allOf merges referenced parts with own properties and required lists', () => {
    const d = digestDoc({
      openapi: '3.0.0',
      components: {
        schemas: {
          Base: { type: 'object', required: ['id'], properties: { id: { type: 'string' }, created: { type: 'integer', format: 'unix-time' } } },
          Ticket: { allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', required: ['subject'], properties: { subject: { type: 'string' }, priority: { type: 'string', enum: ['low', 'high'] } } }] },
        },
      },
      paths: { '/tickets': { post: { summary: 'Open a ticket', requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Ticket' } } } }, responses: ok200({ $ref: '#/components/schemas/Ticket' }) } } },
    });
    assert.deepEqual(d.summary.split('\n').slice(2, 8), [
      'POST /tickets: Open a ticket',
      '  body (application/json): id string required, created integer(unix-time), subject string required, priority enum(low|high)',
      '  responses: 200 Ticket',
      'Schemas:',
      '  Ticket: id string required, created integer(unix-time), subject string required, priority enum(low|high)',
      '  Base: id string required, created integer(unix-time)',
    ]);
  });

  it('O1 recursive and cyclic schemas stop at the depth cut', () => {
    const d = digestDoc({
      openapi: '3.0.0',
      components: {
        schemas: {
          Node: { type: 'object', properties: { name: { type: 'string' }, children: { type: 'array', items: { $ref: '#/components/schemas/Node' } }, meta: { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'string' } } } } } } } } },
          A: { allOf: [{ $ref: '#/components/schemas/B' }, { properties: { a: { type: 'string' } } }] },
          B: { allOf: [{ $ref: '#/components/schemas/A' }, { properties: { b: { type: 'string' } } }] },
          Loop: { $ref: '#/components/schemas/Loop' },
        },
      },
      paths: {
        '/nodes': { get: { summary: 'Nodes', responses: ok200({ $ref: '#/components/schemas/Node' }) } },
        '/ab': { get: { summary: 'AB', responses: ok200({ $ref: '#/components/schemas/A' }) } },
        '/loop': { get: { summary: 'Loop', responses: ok200({ $ref: '#/components/schemas/Loop' }) } },
      },
    });
    assert.deepEqual(d.summary.split('\n').filter((l) => l.startsWith('  ') && !l.startsWith('  responses')), [
      '  Node: name string, children array<Node>, meta {a {b object}}',
      '  A: a string, b string',
      '  B: b string, a string',
      '  Loop: unresolved $ref',
    ]);
  });

  it('O1 a remote $ref is named, never followed', () => {
    const d = digestDoc({ openapi: '3.0.0', paths: { '/x': { get: { summary: 'X', responses: ok200({ $ref: 'https://example.com/common.yaml#/Thing' }) } } } });
    assert.equal(d.summary.split('\n')[3], '  responses: 200 https://example.com/common.yaml#/Thing');
  });

  it('O2 lists params, form bodies, nullable and union types', () => {
    const d = digestDoc({
      openapi: '3.0.0',
      paths: {
        '/v1/refunds/{refund}': {
          parameters: [{ name: 'refund', in: 'path', required: true, schema: { type: 'string' } }],
          post: {
            summary: 'Update a refund',
            parameters: [{ name: 'expand', in: 'query', schema: { type: 'array', items: { type: 'string' } } }],
            requestBody: { content: { 'application/x-www-form-urlencoded': { schema: { type: 'object', properties: { note: { type: 'string', nullable: true }, charge: { anyOf: [{ type: 'string' }, { type: 'integer' }] } } } } } },
            responses: { '204': { description: 'done' } },
          },
        },
      },
    });
    assert.deepEqual(d.summary.split('\n').slice(1, 6), [
      'Operations: kept 1 of 1; dropped 0.',
      'POST /v1/refunds/{refund}: Update a refund',
      '  params: refund path string required, expand query array<string>',
      '  body (application/x-www-form-urlencoded): note string|null, charge string|integer',
      '  responses: 204',
    ]);
  });
});

describe('openapi apiShape', () => {
  it('O3 the Petstore error schema becomes meta.api.error; bare-array lists keep default list keys', async () => {
    assert.deepEqual((await petstore()).apiShape, {
      list: { mode: 'cursor', dataKey: 'data', cursorKey: 'next_cursor', limitParam: 'limit', cursorParam: 'cursor', hasMoreKey: 'has_more', startingAfterParam: 'starting_after', endingBeforeParam: 'ending_before' },
      error: { code: '$status', message: '$message' },
    });
  });

  const listDoc = (second: Record<string, unknown>) => ({
    openapi: '3.0.0',
    components: { schemas: { Problem: { type: 'object', properties: { status: { type: 'integer' }, error_code: { type: 'string' }, detail: { type: 'string' }, extra: { type: 'string' } } } } },
    paths: {
      '/users': {
        get: {
          summary: 'List users',
          parameters: [{ name: 'page_size', in: 'query', schema: { type: 'integer' } }, { name: 'page_token', in: 'query', schema: { type: 'string' } }],
          responses: { ...ok200({ type: 'object', properties: { items: { type: 'array', items: { type: 'string' } }, next_page_token: { type: 'string' } } }), '400': { description: 'bad', content: { 'application/json': { schema: { $ref: '#/components/schemas/Problem' } } } } },
        },
      },
      '/teams': {
        get: {
          summary: 'List teams',
          parameters: [{ name: 'page_size', in: 'query', schema: { type: 'integer' } }, { name: 'page_token', in: 'query', schema: { type: 'string' } }],
          responses: ok200({ type: 'object', properties: second }),
        },
      },
    },
  });

  it('O3 list responses sharing a data array key and cursor field propose meta.api.list', () => {
    const d = digestDoc(listDoc({ items: { type: 'array', items: { type: 'string' } }, next_page_token: { type: 'string' }, total: { type: 'integer' } }));
    assert.deepEqual(d.apiShape, {
      list: { mode: 'cursor', dataKey: 'items', cursorKey: 'next_page_token', limitParam: 'page_size', cursorParam: 'page_token', hasMoreKey: 'has_more', startingAfterParam: 'starting_after', endingBeforeParam: 'ending_before' },
      error: { status: '$status', error_code: '$code', detail: '$message' },
    });
    assert.equal(d.summary.includes('List envelope: items array with next_page_token, shared by 2 list operations.'), true);
  });

  it('O3 list responses that disagree propose no list keys', () => {
    const d = digestDoc(listDoc({ data: { type: 'array', items: { type: 'string' } }, next: { type: 'string' } }));
    assert.deepEqual(d.apiShape?.list, { mode: 'cursor', dataKey: 'data', cursorKey: 'next_cursor', limitParam: 'limit', cursorParam: 'cursor', hasMoreKey: 'has_more', startingAfterParam: 'starting_after', endingBeforeParam: 'ending_before' });
    assert.equal(d.summary.includes('List envelope: not shared (items+next_page_token, data+next).'), true);
  });

  it('O3 no shared envelope and no error schema give null', () => {
    assert.equal(digestDoc({ openapi: '3.0.0', paths: { '/a': { get: { summary: 'A', responses: ok200({ type: 'array', items: { type: 'string' } }) } } } }).apiShape, null);
  });
});

describe('openapi observations', () => {
  it('O4 response examples become observations with body shapes, values dropped', async () => {
    assert.deepEqual((await petstore()).observations, [
      { method: 'POST', path: '/pets', status: 201, bodyShape: { id: 'integer', name: 'string', tag: 'string', api_key: 'string' } },
      { method: 'POST', path: '/store/orders', status: 200, bodyShape: { id: 'integer', pet_id: 'integer', quantity: 'integer', ship_date: 'string', status: 'string', complete: 'boolean' } },
      { method: 'GET', path: '/store/orders/{orderId}', status: 404, bodyShape: { code: 'integer', message: 'string' } },
      { method: 'DELETE', path: '/store/orders/{orderId}', status: 404, bodyShape: { code: 'integer', message: 'string' } },
    ]);
  });

  it('O4 default responses and non-JSON media without examples give none', () => {
    const d = digestDoc({ openapi: '3.0.0', paths: { '/a': { get: { summary: 'A', responses: { default: { description: 'x', content: { 'application/json': { example: { a: 1 } } } }, '200': { description: 'ok' } } } } } });
    assert.deepEqual(d.observations, []);
  });
});

describe('openapi redact', () => {
  it('O5 the fixture token never reaches the digest', async () => {
    assert.equal((await readFile(PETSTORE, 'utf8')).includes(TOKEN), true);
    const d = await petstore();
    assert.equal(JSON.stringify(d).includes(TOKEN), false);
    const loaded = await INPUT_KINDS.openapi.load({ kind: 'openapi', path: PETSTORE, only: [] });
    assert.equal(JSON.stringify(redact('openapi', loaded)).includes(TOKEN), false);
  });

  it('O5 security schemes keep their type fields; Authorization, X-Api-Key and cookie parameters lose their examples', () => {
    const out = redact('openapi', {
      only: ['/v1'],
      document: {
        components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'use tok_A', 'x-example': 'tok_B' } } },
        parameters: [
          { name: 'Authorization', in: 'header', required: true, example: 'Bearer abc', schema: { type: 'string', example: 'Bearer def' } },
          { name: 'X-Api-Key', in: 'header', examples: { one: { value: 'k1' } }, schema: { type: 'string', default: 'k2' } },
          { name: 'sid', in: 'cookie', example: 'c1' },
          { name: 'Idempotency-Key', in: 'header', example: 'idem-1' },
        ],
      },
    });
    assert.deepEqual(out, {
      only: ['/v1'],
      document: {
        components: { securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
        parameters: [
          { name: 'Authorization', in: 'header', required: true, schema: { type: 'string' } },
          { name: 'X-Api-Key', in: 'header', schema: { type: 'string' } },
          { name: 'sid', in: 'cookie' },
          { name: 'Idempotency-Key', in: 'header', example: 'idem-1' },
        ],
      },
    });
  });

  it('O5 a password property keeps its type, example credentials are masked, and a /tokens path survives', () => {
    const out = redact('openapi', {
      only: [],
      document: {
        paths: { '/tokens': { get: { summary: 'List tokens', responses: { '200': { description: 'ok', headers: { 'Set-Cookie': { schema: { type: 'string' }, example: 'sid=s1' } }, content: { 'application/json': { example: { user: 'bob', password: 'pw-1', api_key: 12345, tokens: ['t1', 't2'], active: true } } } } } } } },
        components: { schemas: { User: { type: 'object', required: ['password'], properties: { password: { type: 'string', minLength: 8, example: 'pw-2' } } } } },
        servers: [{ url: 'https://admin:pw-3@api.example.com' }],
      },
    });
    assert.deepEqual(out.document, {
      paths: { '/tokens': { get: { summary: 'List tokens', responses: { '200': { description: 'ok', headers: { 'Set-Cookie': { schema: { type: 'string' } } }, content: { 'application/json': { example: { user: 'bob', password: '[redacted]', api_key: '[redacted]', tokens: ['[redacted]', '[redacted]'], active: true } } } } } } } },
      components: { schemas: { User: { type: 'object', required: ['password'], properties: { password: { type: 'string', minLength: 8 } } } } },
      servers: [{ url: 'https://[redacted]@api.example.com' }],
    });
  });

  it('O5 redact accepts an empty document', () => {
    assert.deepEqual(redact('openapi', { document: {}, only: [] }), { document: {}, only: [] });
  });
});
