import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { applyEdit, checkWorld, loadWorld, openapiFidelity, type CheckedWorld, type CheckIssue, type World } from '#engine';

const root = (p: string): string => fileURLToPath(new URL(`../../${p}`, import.meta.url));

async function checked(dir: string): Promise<CheckedWorld> {
  const loaded = await loadWorld(root(dir));
  assert.ok(loaded.ok);
  const report = checkWorld(loaded.value, loaded.lines);
  assert.ok(report.ok);
  return report.world;
}

const petstore = (): Promise<CheckedWorld> => checked('prod/worlds/gen-petstore');

const brief = (issues: readonly CheckIssue[]): string[] => issues.map((i) => `${i.severity} ${i.code} ${i.path.slice(2).join(' > ')}`);

describe('openapiFidelity', () => {
  it('reports only extra operations for the shipped Petstore, whose inputs match the spec', async () => {
    const spec = parseYaml(await readFile(root('eval/inputs/petstore.openapi.yaml'), 'utf8'));
    const issues = openapiFidelity(await petstore(), spec);
    assert.deepEqual(brief(issues), [
      'warning openapi.operation_extra GET /store/orders',
      'warning openapi.operation_extra GET /categories',
      'warning openapi.operation_extra POST /categories',
      'warning openapi.operation_extra POST /store/orders/{id}/approve',
      'warning openapi.operation_extra POST /store/orders/{id}/deliver',
    ]);
  });

  it('rejects making a source-optional request field required', async () => {
    const world = await petstore();
    const quantity = { type: 'int' as const, required: true, nullable: false, unique: false, readonly: false, min: 1 };
    world.actions.contract_probe = {
      method: 'POST', path: '/contract-probe', description: 'Required-input fidelity probe',
      input: { quantity },
      handler: '(ctx) => ({ status: 200, body: { quantity: ctx.body.quantity } })',
    };
    const checked = checkWorld(world);
    assert.ok(checked.ok);
    const spec = { openapi: '3.0.3', paths: { '/contract-probe': { post: {
      requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { quantity: { type: 'integer' } } } } } },
      responses: { '200': { description: 'ok' } },
    } } } };
    assert.deepEqual(brief(openapiFidelity(checked.world, spec, ['/contract-probe'])), [
      'error openapi.required_field_extra POST /contract-probe > request > quantity',
    ]);
  });

  it('rejects making a source-required request field optional', async () => {
    const world = await petstore();
    world.actions.contract_probe = {
      method: 'POST', path: '/contract-probe', description: 'Required-input fidelity probe',
      input: { quantity: { type: 'int', required: false, nullable: false, unique: false, readonly: false, min: 1 } },
      handler: '(ctx) => ({ status: 200, body: { quantity: ctx.body.quantity } })',
    };
    const checked = checkWorld(world);
    assert.ok(checked.ok);
    const spec = { openapi: '3.0.3', paths: { '/contract-probe': { post: {
      requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['quantity'], properties: { quantity: { type: 'integer' } } } } } },
      responses: { '200': { description: 'ok' } },
    } } } };
    assert.deepEqual(brief(openapiFidelity(checked.world, spec, ['/contract-probe'])), [
      'error openapi.required_field_missing POST /contract-probe > request > quantity',
    ]);
  });

  it('says why a request may leave out a field the source requires: no body, not taken, optional or defaulted (YOS-241)', async () => {
    const spec = { openapi: '3.0.3', paths: { '/contract-probe': { post: {
      requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['quantity'], properties: { quantity: { type: 'integer' }, note: { type: 'string' } } } } } },
      responses: { '200': { description: 'ok' } },
    } } } };
    const int = { type: 'int', nullable: false, unique: false, readonly: false } as const;
    const found = async (input: World['actions'][string]['input']): Promise<string[]> => {
      const world = await petstore();
      world.actions.contract_probe = { method: 'POST', path: '/contract-probe', description: 'Required-input fidelity probe', input, handler: '(ctx) => ({ status: 200, body: {} })' };
      const checked = checkWorld(world);
      assert.ok(checked.ok, JSON.stringify(checked.ok ? null : checked.issues));
      return openapiFidelity(checked.world, spec, ['/contract-probe']).filter((i) => i.code === 'openapi.required_field_missing').map((i) => i.found);
    };
    assert.deepEqual(await found({}), ['no request body']);
    assert.deepEqual(await found({ note: { type: 'string', required: false, nullable: true, unique: false, readonly: false } }), ['fields note']);
    assert.deepEqual(await found({ quantity: { ...int, required: false } }), ['quantity is optional']);
    assert.deepEqual(await found({ quantity: { ...int, required: true, default: 1 } }), ['quantity has a default, so a request may leave it out']);
    assert.deepEqual(await found({ quantity: { ...int, required: true } }), []);
  });

  it('accepts a required source object represented by a required reference', async () => {
    const world = await petstore();
    const category = Object.values(world.entities.pet?.fields ?? {}).find((f) => f.type === 'ref' && f.entity === 'category');
    assert.ok(category?.type === 'ref');
    world.actions.contract_probe = {
      method: 'POST', path: '/contract-probe', description: 'Required-reference fidelity probe',
      input: { category_id: { ...category, required: true } },
      handler: '(ctx) => ({ status: 200, body: { category_id: ctx.body.category_id } })',
    };
    const checked = checkWorld(world);
    assert.ok(checked.ok);
    const spec = { openapi: '3.0.3', paths: { '/contract-probe': { post: {
      requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['category'], properties: { category: { type: 'object', properties: { id: { type: 'integer' } } } } } } } },
      responses: { '200': { description: 'ok' } },
    } } } };
    assert.deepEqual(openapiFidelity(checked.world, spec, ['/contract-probe']), []);
  });

  it('prefers a declared source reference field over an optional source object', async () => {
    const world = await petstore();
    const category = Object.values(world.entities.pet?.fields ?? {}).find((f) => f.type === 'ref' && f.entity === 'category');
    assert.ok(category?.type === 'ref');
    world.actions.contract_probe = {
      method: 'POST', path: '/contract-probe', description: 'Declared-reference fidelity probe',
      input: { category_id: { ...category, required: true } },
      handler: '(ctx) => ({ status: 200, body: { category_id: ctx.body.category_id } })',
    };
    const checked = checkWorld(world);
    assert.ok(checked.ok);
    const spec = { openapi: '3.0.3', paths: { '/contract-probe': { post: {
      requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['categoryId'], properties: {
        categoryId: { type: 'integer' }, category: { type: 'object', properties: { id: { type: 'integer' } } },
      } } } } },
      responses: { '200': { description: 'ok' } },
    } } } };
    assert.deepEqual(openapiFidelity(checked.world, spec, ['/contract-probe']), []);
  });

  it('prefers a direct required world field over an optional flattened reference', async () => {
    const world = await petstore();
    const category = Object.values(world.entities.pet?.fields ?? {}).find((f) => f.type === 'ref' && f.entity === 'category');
    assert.ok(category?.type === 'ref');
    world.actions.contract_probe = {
      method: 'POST', path: '/contract-probe', description: 'Direct-field fidelity probe',
      input: {
        category: { type: 'text', required: true, nullable: false, unique: false, readonly: false },
        category_id: { ...category, required: false },
      },
      handler: '(ctx) => ({ status: 200, body: { category: ctx.body.category, category_id: ctx.body.category_id } })',
    };
    const checked = checkWorld(world);
    assert.ok(checked.ok);
    const spec = { openapi: '3.0.3', paths: { '/contract-probe': { post: {
      requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['category'], properties: {
        category: { type: 'object', properties: { id: { type: 'integer' } } },
      } } } } },
      responses: { '200': { description: 'ok' } },
    } } } };
    assert.deepEqual(openapiFidelity(checked.world, spec, ['/contract-probe']), []);
  });

  it('compares only paths under --only', async () => {
    const spec = parseYaml(await readFile(root('eval/inputs/petstore.openapi.yaml'), 'utf8'));
    const issues = openapiFidelity(await petstore(), spec, ['/store']);
    assert.deepEqual(brief(issues), [
      'warning openapi.operation_extra GET /store/orders',
      'warning openapi.operation_extra POST /store/orders/{id}/approve',
      'warning openapi.operation_extra POST /store/orders/{id}/deliver',
    ]);
  });

  it('flags each kind of mismatch in a small inline spec', async () => {
    const spec = {
      openapi: '3.0.3',
      paths: {
        '/pet/{petId}': {
          get: {
            responses: {
              '200': { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'integer' }, status: { type: 'string', enum: ['available', 'gone'] } } } } } },
              '418': { description: 'teapot' },
            },
          },
        },
        '/pet/{petId}/walk': { post: { responses: { '200': { description: 'ok' } } } },
      },
    };
    const issues = openapiFidelity(await petstore(), spec, ['/pet/']);
    assert.deepEqual(brief(issues).filter((l) => l.startsWith('error')), [
      'error openapi.status_missing GET /pet/{petId} > responses > 418',
      'error openapi.field_type GET /pet/{petId} > response > name',
      'error openapi.field_enum GET /pet/{petId} > response > status',
      'error openapi.operation_missing POST /pet/{petId}/walk',
    ]);
    const type = issues.find((i) => i.code === 'openapi.field_type');
    assert.equal(type?.expected, 'response field name of GET /pet/{petId} has type integer, as in the source spec');
    assert.equal(type?.found, 'string');
    const status = issues.find((i) => i.code === 'openapi.status_missing');
    assert.equal(status?.found, '200, 400, 404');
  });

  it('finds the 404 a scoped list answers for an unknown parent, so a spec declaring it is met', async () => {
    const spec = { openapi: '3.0.3', paths: { '/tickets/{ticket_id}/events': { get: {
      parameters: [{ name: 'ticket_id', in: 'path', required: true, schema: { type: 'string' } }],
      responses: { '200': { description: 'A page of events.' }, '404': { description: 'No such ticket.' } },
    } } } };
    assert.deepEqual(brief(openapiFidelity(await checked('prod/worlds/helpdesk'), spec, ['/tickets/{ticket_id}/events'])), []);
  });

  it('sees has_more as a string cursor in cursor mode and as a boolean in stripe mode', async () => {
    const spec = {
      openapi: '3.0.3',
      paths: {
        '/store/orders': {
          get: {
            responses: { '200': { content: { 'application/json': { schema: { type: 'object', properties: { data: { type: 'array' }, has_more: { type: 'boolean' } } } } } } },
          },
        },
      },
    };
    // Only the envelope matters here, and the world's task snippets page with its own cursor, so the probe world is not run.
    const withList = (list: Record<string, string>, routes: Record<string, { sort: string[] }> = {}): World => {
      const edited = applyEdit(world, { note: 'has_more envelope', meta: { api: { list } }, patch: { routes } });
      assert.ok(edited.ok);
      return edited.value.world;
    };
    const world = await petstore();
    const errors = (w: World): CheckIssue[] => openapiFidelity(w, spec, ['/store/orders']).filter((i) => i.severity === 'error');
    const cursor = errors(withList({ mode: 'cursor', cursorKey: 'has_more' }));
    assert.deepEqual(brief(cursor), ['error openapi.field_type GET /store/orders > response > has_more']);
    assert.equal(cursor[0]?.found, 'string');
    // Stripe mode refuses route sort fields (route.sort_ignored), so the edit drops them.
    const unsorted = Object.fromEntries(Object.entries(world.routes).filter(([, r]) => r.op === 'list' && r.sort.length > 0).map(([id]) => [id, { sort: [] }]));
    assert.deepEqual(brief(errors(withList({ mode: 'stripe' }, unsorted))), []);
  });

  it('flags a request field the spec requires and the world route does not accept', async () => {
    const spec = {
      openapi: '3.0.3',
      paths: {
        '/pet': {
          post: {
            requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['microchip_id'], properties: { microchip_id: { type: 'string' } } } } } },
            responses: { '200': { description: 'ok' } },
          },
        },
      },
    };
    const issues = openapiFidelity(await petstore(), spec, ['/pet']);
    const missing = issues.filter((i) => i.code === 'openapi.required_field_missing');
    assert.deepEqual(brief(missing), ['error openapi.required_field_missing POST /pet > request > microchip_id']);
  });

  const probe = async (path: string, input: Record<string, { required: boolean }>, spec: object, only = [path]) => {
    const world = await petstore();
    const field = (required: boolean) => ({ type: 'string' as const, required, nullable: !required, unique: false, readonly: false });
    world.actions.contract_probe = {
      method: 'POST', path, description: 'Required-input fidelity probe',
      input: Object.fromEntries(Object.entries(input).map(([k, v]) => [k, field(v.required)])),
      handler: '(ctx) => ({ status: 200, body: {} })',
    };
    const checked = checkWorld(world);
    assert.ok(checked.ok, JSON.stringify(checked.ok ? null : checked.issues));
    return brief(openapiFidelity(checked.world, { openapi: '3.0.3', paths: { [path]: { post: { ...spec, responses: { '200': { description: 'ok' } } } } } }, only));
  };
  const body = (type: string, schema: object) => ({ requestBody: { content: { [type]: { schema: { type: 'object', ...schema } } } } });

  it('reads a form-encoded source body, so a field the form requires is not extra', async () => {
    const form = body('application/x-www-form-urlencoded', { required: ['amount'], properties: { amount: { type: 'string' }, note: { type: 'string' } } });
    assert.deepEqual(await probe('/probe', { amount: { required: true } }, form), []);
    assert.deepEqual(await probe('/probe', { amount: { required: true }, note: { required: true } }, form), [
      'error openapi.required_field_extra POST /probe > request > note',
    ]);
  });

  it('lets a body id find the row on an operation with no path parameter, and only there', async () => {
    const json = body('application/json', { properties: { id: { type: 'string' } } });
    assert.deepEqual(await probe('/probe', { id: { required: true } }, json), []);
    assert.deepEqual(await probe('/probe/{ref}', { id: { required: true } }, json), [
      'error openapi.required_field_extra POST /probe/{ref} > request > id',
    ]);
  });

  it('lets the world require one of two optional alternatives it models only one of', async () => {
    const either = body('application/json', { properties: { charge: { type: 'string' }, payment_intent: { type: 'string' } } });
    assert.deepEqual(await probe('/probe', { charge: { required: true } }, either), []);
    const enumerated = body('application/json', { properties: { charge: { type: 'string' }, kind: { type: 'string', enum: ['a', 'b'] } } });
    assert.deepEqual(await probe('/probe', { charge: { required: true } }, enumerated), [
      'error openapi.required_field_extra POST /probe > request > charge',
    ]);
  });
});
