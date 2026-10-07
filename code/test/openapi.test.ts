import assert from 'node:assert/strict';
import { before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyEdit, checkWorld, createRuntime, FIELD_TYPES, loadWorld, type CheckedWorld, type FieldType, type World } from '#engine';
import { fieldSchema } from '../src/engine/fields.ts';
import { ENGINE_ERROR_CODES, fieldJsonSchema, openApiOf, type OpenApiDocument, type OpenApiOperation } from '../src/engine/openapi.ts';

const HELPDESK = fileURLToPath(new URL('../../prod/worlds/helpdesk', import.meta.url));

async function helpdesk(): Promise<CheckedWorld> {
  const loaded = await loadWorld(HELPDESK);
  if (!loaded.ok) assert.fail(JSON.stringify(loaded.error));
  const report = checkWorld(loaded.value);
  if (!report.ok) assert.fail(JSON.stringify(report.issues));
  return report.world;
}

/** The helpdesk world after one edit. Unchecked: openApiOf takes any World. */
function edited(world: World, edit: unknown): World {
  const r = applyEdit(world, edit);
  if (!r.ok) assert.fail(JSON.stringify(r.error));
  return r.value.world;
}

function op(doc: OpenApiDocument, path: string, method: 'get' | 'post' | 'put' | 'patch' | 'delete'): OpenApiOperation {
  const o = doc.paths[path]?.[method];
  if (o === undefined) assert.fail(`no ${method} ${path} in ${Object.keys(doc.paths).join(', ')}`);
  return o;
}

/** The `code` slot of an error response under the default template { error: { code, message } }. */
function codeSlot(o: OpenApiOperation, status: string): unknown {
  return o.responses[status]?.content?.['application/json'].schema.properties?.['error']?.properties?.['code'];
}

const ESCALATE = `(ctx) => {
  const t = ctx.db.get('ticket', ctx.params.id);
  if (t === null) ctx.fail(404, 'ticket.not_found', 'No ticket ' + ctx.params.id);
  if (t.status === 'closed') ctx.fail(409, "ticket.closed", 'A closed ticket cannot escalate');
  if (ctx.body.level > 2) ctx.fail(418, 'teapot', 'never documented');
  return { status: 200, body: ctx.db.update('ticket', t.id, { status: 'escalated' }) };
}`;

describe('openApiOf: the helpdesk world', () => {
  let world: CheckedWorld;
  let doc: OpenApiDocument;
  before(async () => {
    world = await helpdesk();
    doc = openApiOf(world);
  });

  it('is an OpenAPI 3.1 document named after the world', () => {
    assert.equal(doc.openapi, '3.1.0');
    assert.equal(doc.info.title, 'helpdesk');
    assert.equal(doc.info.version, '1');
    assert.equal(doc.info.description.endsWith('Resembles Zendesk Support tickets API.'), true);
  });

  it('gives GET /tickets its filters, search, sort and paging params in order', () => {
    const o = op(doc, '/tickets', 'get');
    assert.equal(o.operationId, 'list_tickets');
    assert.deepEqual(o.tags, ['ticket']);
    assert.deepEqual(o.parameters.map((p) => `${p.in}:${p.name}`), [
      'query:status', 'query:priority', 'query:customer_id', 'query:assignee_id', 'query:sla_breached', 'query:escalation_level',
      'query:q', 'query:sort', 'query:limit', 'query:cursor',
    ]);
    const param = (name: string) => o.parameters.find((p) => p.name === name)?.schema;
    assert.deepEqual(param('status')?.enum, ['new', 'open', 'pending', 'escalated', 'resolved', 'closed']);
    assert.deepEqual(param('assignee_id'), { type: 'string', description: 'Set by the assign and escalate actions. Id of the agent it references.' });
    assert.deepEqual(param('escalation_level'), { type: 'integer', minimum: 0, maximum: 2 });
    assert.deepEqual(param('sort'), { type: 'string', enum: ['created_at', 'sla_due_at', '-created_at', '-sla_due_at'] });
    assert.deepEqual(param('limit'), { type: 'integer', minimum: 1, default: 25 });
    assert.deepEqual(param('cursor'), { type: 'string' });
    assert.equal(o.parameters.find((p) => p.name === 'q')?.description, 'Case-insensitive substring match on any of: subject.');
  });

  it('leaves out q and sort on a list that declares no search or sort', () => {
    assert.deepEqual(op(doc, '/sla_policies', 'get').parameters.map((p) => p.name), ['tier', 'priority', 'limit', 'cursor']);
  });

  it('turns a path param that names a field into a required equality filter', () => {
    const o = op(doc, '/tickets/{ticket_id}/events', 'get');
    assert.deepEqual(o.parameters[0], {
      name: 'ticket_id', in: 'path', required: true, description: 'Only ticket_event rows whose ticket_id equals this.',
      schema: { type: 'string', description: 'Id of the ticket it references.' },
    });
  });

  it('answers a list with the meta.api list envelope', () => {
    assert.deepEqual(op(doc, '/tickets', 'get').responses['200']?.content?.['application/json'].schema, { $ref: '#/components/schemas/ticket.list' });
    assert.deepEqual(doc.components.schemas['ticket.list'], {
      type: 'object',
      description: 'One page of ticket rows. next_cursor is null on the last page.',
      properties: { data: { type: 'array', items: { $ref: '#/components/schemas/ticket' } }, next_cursor: { type: ['string', 'null'] } },
      required: ['data', 'next_cursor'],
      additionalProperties: false,
    });
  });

  it('derives the ticket row schema from its fields', () => {
    const ticket = doc.components.schemas['ticket'];
    assert.deepEqual(ticket?.properties?.['priority']?.enum, ['low', 'normal', 'high', 'urgent']);
    assert.deepEqual(ticket?.properties?.['id'], { type: 'string', pattern: '^tkt_[0-9]+$', readOnly: true, description: 'Assigned by the engine.' });
    assert.deepEqual(ticket?.properties?.['assignee_id'], {
      type: ['string', 'null'], description: 'Set by the assign and escalate actions. Id of the agent it references.', readOnly: true,
    });
    assert.deepEqual(ticket?.properties?.['status']?.['x-transitions'], {
      new: ['open', 'escalated'], open: ['pending', 'escalated', 'resolved'], pending: ['open', 'escalated', 'resolved'],
      escalated: ['resolved'], resolved: ['open', 'closed'], closed: [],
    });
    assert.deepEqual(ticket?.required, [
      'id', 'subject', 'description', 'customer_id', 'assignee_id', 'priority', 'status', 'escalation_level', 'escalated_at',
      'sla_started_at', 'sla_due_at', 'sla_breached', 'resolved_at', 'created_at', 'updated_at',
    ]);
    assert.equal(ticket?.additionalProperties, false);
  });

  it('gives create only the writable fields, requires the ones with no default, and pins the initial state', () => {
    const create = doc.components.schemas['ticket.create'];
    assert.deepEqual(Object.keys(create?.properties ?? {}), ['subject', 'description', 'customer_id', 'priority', 'status']);
    assert.deepEqual(create?.required, ['subject', 'customer_id', 'priority']);
    assert.deepEqual(create?.properties?.['status']?.enum, ['new']);
    assert.equal(create?.properties?.['status']?.default, 'new');
    assert.equal(create?.additionalProperties, false);
    const o = op(doc, '/tickets', 'post');
    assert.deepEqual(o.requestBody, { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/ticket.create' } } } });
    assert.deepEqual(Object.keys(o.responses), ['201', '400', '422']);
  });

  it('lists the closed error codes of each standard operation by status', () => {
    assert.deepEqual(codeSlot(op(doc, '/tickets/{id}', 'get'), '404'), { type: 'string', enum: ['row.not_found'] });
    assert.deepEqual(codeSlot(op(doc, '/tickets', 'post'), '422'), {
      type: 'string', enum: ['field.unknown', 'field.readonly', 'field.required', 'field.null', 'field.type', 'ref.unresolved', 'state.initial'],
    });
    assert.deepEqual(codeSlot(op(doc, '/tickets/{id}', 'patch'), '422'), {
      type: 'string', enum: ['field.unknown', 'field.readonly', 'field.null', 'field.type', 'ref.unresolved', 'state.transition'],
    });
    // customer.email is unique, ticket has no unique field.
    assert.deepEqual(codeSlot(op(doc, '/customers', 'post'), '409'), { type: 'string', enum: ['field.unique'] });
    assert.equal(op(doc, '/tickets', 'post').responses['409'], undefined);
    assert.deepEqual(codeSlot(op(doc, '/tickets', 'get'), '400'), { type: 'string', enum: ['query.unknown', 'query.invalid', 'cursor.invalid'] });
    assert.equal(op(doc, '/tickets/{id}', 'get').responses['404']?.description, 'Not found. Codes: row.not_found.');
  });

  it('declares 404 row.not_found on a list scoped by a path param, and not on an unscoped list', () => {
    assert.deepEqual(Object.keys(op(doc, '/tickets/{ticket_id}/events', 'get').responses), ['200', '400', '404']);
    assert.deepEqual(codeSlot(op(doc, '/tickets/{ticket_id}/events', 'get'), '404'), { type: 'string', enum: ['row.not_found'] });
    assert.deepEqual(Object.keys(op(doc, '/tickets', 'get').responses), ['200', '400']);
  });

  it('shapes errors with the meta.api error template', () => {
    assert.deepEqual(op(doc, '/tickets/{id}', 'get').responses['404']?.content?.['application/json'].schema, {
      type: 'object',
      properties: {
        error: {
          type: 'object',
          properties: { code: { type: 'string', enum: ['row.not_found'] }, message: { type: 'string' } },
          required: ['code', 'message'],
          additionalProperties: false,
        },
      },
      required: ['error'],
      additionalProperties: false,
    });
  });

  it('documents the codes the engine really answers with', () => {
    const rt = createRuntime(world);
    const cases: [OpenApiOperation, string, ReturnType<typeof rt.call>][] = [
      [op(doc, '/tickets/{id}', 'get'), '404', rt.call({ method: 'GET', path: '/tickets/tkt_9999', query: {}, body: undefined })],
      [op(doc, '/tickets', 'post'), '422', rt.call({ method: 'POST', path: '/tickets', query: {}, body: {} })],
      [op(doc, '/tickets', 'get'), '400', rt.call({ method: 'GET', path: '/tickets', query: { bogus: '1' }, body: undefined })],
      [op(doc, '/tickets', 'get'), '400', rt.call({ method: 'GET', path: '/tickets', query: { cursor: '!' }, body: undefined })],
      [op(doc, '/tickets/{ticket_id}/events', 'get'), '404', rt.call({ method: 'GET', path: '/tickets/tkt_9999/events', query: {}, body: undefined })],
    ];
    assert.deepEqual(cases.map(([, status, res]) => [status, res.status, (res.body as { error: { code: string } }).error.code]), [
      ['404', 404, 'row.not_found'], ['422', 422, 'field.required'], ['400', 400, 'query.unknown'], ['400', 400, 'cursor.invalid'], ['404', 404, 'row.not_found'],
    ]);
    for (const [o, status, res] of cases) {
      const slot = codeSlot(o, status) as { enum: string[] };
      assert.equal(slot.enum.includes((res.body as { error: { code: string } }).error.code), true);
    }
  });

  it('catalogs every engine error code at the top level', () => {
    assert.deepEqual(Object.entries(doc['x-error-codes']).map(([c, v]) => `${v.status} ${c}`), [
      '400 path.invalid', '400 query.invalid', '400 query.unknown', '400 cursor.invalid', '400 body.invalid', '400 input.invalid',
      '404 route.not_found', '404 row.not_found', '404 entity.unknown', '405 method.not_allowed',
      '409 field.unique', '409 delete.restricted',
      '422 field.unknown', '422 field.readonly', '422 field.required', '422 field.null', '422 field.type', '422 ref.unresolved',
      '422 state.initial', '422 state.transition', '500 action.failed',
    ]);
    assert.equal(Object.keys(ENGINE_ERROR_CODES).length, 21);
  });

  it('never exposes the admin routes', () => {
    assert.equal(Object.keys(doc.paths).some((p) => p.startsWith('/_world')), false);
    assert.equal(JSON.stringify(doc).includes('_world'), false);
  });
});

describe('openApiOf: actions, deletes and private sections', () => {
  let doc: OpenApiDocument;
  before(async () => {
    const base = await helpdesk();
    const world = edited(base, {
      note: 'an action, deletes, a job, a test and a task with sentinel text',
      // The golden world's own actions and deletes would claim these paths first.
      remove: {
        actions: Object.keys(base.actions),
        routes: Object.entries(base.routes).filter(([, r]) => r.op === 'delete').map(([k]) => k),
      },
      upsert: {
        actions: {
          escalate_ticket: {
            method: 'POST', path: '/tickets/{id}/escalate', description: 'Escalate a ticket to the on-call agent.',
            input: { level: { type: 'int', required: true, min: 1, max: 2 }, note: { type: 'text', nullable: true }, urgent: { type: 'bool', default: false } },
            handler: ESCALATE,
          },
          ping: { method: 'GET', path: '/ping', handler: '(ctx) => ({ status: 200, body: { ok: true } })' },
        },
        routes: {
          delete_customer: { op: 'delete', method: 'DELETE', path: '/customers/{id}', entity: 'customer' },
          delete_comment: { op: 'delete', method: 'DELETE', path: '/tickets/{ticket_id}/comments/{comment_id}', entity: 'ticket_comment' },
          delete_ticket: { op: 'delete', method: 'DELETE', path: '/tickets/{id}/', entity: 'ticket' },
        },
        jobs: { sentinel_job: { description: 'SENTINEL_JOB_DESC', every: '1h', run: '(ctx) => { /* SENTINEL_JOB_RUN */ }' } },
        tests: { sentinel_test: { description: 'SENTINEL_TEST_DESC', script: '(ctx) => { /* SENTINEL_TEST_SCRIPT */ }' } },
        tasks: {
          sentinel_task: {
            difficulty: 'medium',
            instruction: 'SENTINEL_INSTRUCTION: escalate the oldest urgent ticket.',
            grader: '(ctx) => { /* SENTINEL_GRADER */ return 1; }',
            solution: '(ctx) => { /* SENTINEL_SOLUTION */ }',
            decoys: [{ why: 'SENTINEL_DECOY_WHY skips page 2', script: '(ctx) => { /* SENTINEL_DECOY_SCRIPT */ }' }],
          },
        },
        seed: { customer: '(ctx) => [/* SENTINEL_SEED */]' },
      },
    });
    doc = openApiOf(world);
  });

  it('documents an action with its params, input body and tag', () => {
    const o = op(doc, '/tickets/{id}/escalate', 'post');
    assert.equal(o.operationId, 'escalate_ticket');
    assert.deepEqual(o.tags, ['Actions']);
    assert.deepEqual(o.parameters, [{ name: 'id', in: 'path', required: true, description: 'Passed to the handler as params.id.', schema: { type: 'string' } }]);
    assert.deepEqual(o.requestBody, { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/escalate_ticket.input' } } } });
    assert.deepEqual(doc.components.schemas['escalate_ticket.input'], {
      type: 'object',
      description: 'Input of the escalate_ticket action.',
      properties: { level: { type: 'integer', minimum: 1, maximum: 2 }, note: { type: ['string', 'null'] }, urgent: { type: 'boolean', default: false } },
      required: ['level'],
      additionalProperties: false,
    });
    // Integer-like keys come first in a JS object, so the 2XX range sorts last.
    assert.deepEqual(Object.keys(o.responses), ['400', '404', '409', '422', '500', '2XX']);
  });

  it('lists the literal codes a handler passes to ctx.fail ahead of the engine codes, as an open list', () => {
    const o = op(doc, '/tickets/{id}/escalate', 'post');
    assert.deepEqual(codeSlot(o, '409'), { type: 'string', examples: ['ticket.closed', 'field.unique', 'delete.restricted'] });
    assert.deepEqual(codeSlot(o, '404'), { type: 'string', examples: ['ticket.not_found', 'row.not_found', 'entity.unknown'] });
    assert.deepEqual(codeSlot(o, '500'), { type: 'string', enum: ['action.failed'] });
    assert.equal(JSON.stringify(o).includes('teapot'), false);
    assert.equal(o.responses['409']?.description, 'Conflict. Known codes (the handler may use others): ticket.closed, field.unique, delete.restricted.');
  });

  it('gives an action with no input no request body', () => {
    const o = op(doc, '/ping', 'get');
    assert.equal(o.requestBody, undefined);
    assert.equal(doc.components.schemas['ping.input'], undefined);
  });

  it('lists delete.restricted only where a restrict ref can block the delete', () => {
    // ticket.customer_id restricts deleting a customer. Nothing references a comment.
    assert.deepEqual(codeSlot(op(doc, '/customers/{id}', 'delete'), '409'), { type: 'string', enum: ['delete.restricted'] });
    const comment = op(doc, '/tickets/{ticket_id}/comments/{comment_id}', 'delete');
    assert.deepEqual(Object.keys(comment.responses), ['204', '400', '404']);
    assert.deepEqual(comment.parameters.map((p) => [p.name, p.description]), [
      ['ticket_id', 'Not used to select the row.'], ['comment_id', 'Id of the ticket_comment.'],
    ]);
  });

  it('declares every templated path param on every operation, as OpenAPI requires', () => {
    const undeclared = Object.entries(doc.paths).flatMap(([path, item]) => Object.values(item).flatMap((o) => {
      const declared = o.parameters.filter((p) => p.in === 'path' && p.required).map((p) => p.name);
      return [...path.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]!).filter((p) => !declared.includes(p)).map((p) => `${o.operationId}:${p}`);
    }));
    assert.deepEqual(undeclared, []);
  });

  it('keys a path the way the router reads it, without a trailing slash', () => {
    assert.equal(op(doc, '/tickets/{id}', 'delete').operationId, 'delete_ticket');
    assert.equal(doc.paths['/tickets/{id}/'], undefined);
  });

  it('leaks no grader, solution, decoy, test, job or seed text', () => {
    const text = JSON.stringify(doc);
    const leaked = ['SENTINEL_JOB_DESC', 'SENTINEL_JOB_RUN', 'SENTINEL_TEST_DESC', 'SENTINEL_TEST_SCRIPT', 'SENTINEL_INSTRUCTION',
      'SENTINEL_GRADER', 'SENTINEL_SOLUTION', 'SENTINEL_DECOY_WHY', 'SENTINEL_DECOY_SCRIPT', 'SENTINEL_SEED', 'sentinel_task', 'ctx.fail']
      .filter((s) => text.includes(s));
    assert.deepEqual(leaked, []);
  });
});

describe('openApiOf: a custom meta.api shape', () => {
  it('describes Stripe id cursors, 1-100 limit and has_more without a sort query', async () => {
    const world = edited(await helpdesk(), {
      note: 'Stripe paging',
      meta: { api: { list: {
        mode: 'stripe', dataKey: 'items', hasMoreKey: 'has_more', limitParam: 'limit',
        startingAfterParam: 'starting_after', endingBeforeParam: 'ending_before',
      } } },
    });
    const doc = openApiOf(world);
    const list = op(doc, '/customers', 'get');
    assert.deepEqual(list.parameters.map((p) => p.name), ['tier', 'q', 'limit', 'starting_after', 'ending_before']);
    const param = (name: string) => list.parameters.find((p) => p.name === name)?.schema;
    assert.deepEqual(param('limit'), { type: 'integer', minimum: 1, maximum: 100, default: 25 });
    assert.deepEqual(param('starting_after'), { type: 'string' });
    assert.deepEqual(param('ending_before'), { type: 'string' });
    assert.deepEqual(doc.components.schemas['customer.list'], {
      type: 'object',
      description: 'One page of customer rows, newest first. has_more says whether another page exists in this direction.',
      properties: { items: { type: 'array', items: { $ref: '#/components/schemas/customer' } }, has_more: { type: 'boolean' } },
      required: ['items', 'has_more'],
      additionalProperties: false,
    });
  });

  it('names the paging params and envelopes after meta.api', async () => {
    const world = edited(await helpdesk(), {
      note: 'Stripe-like envelopes',
      meta: { api: {
        list: { dataKey: 'items', cursorKey: 'next_page', limitParam: 'per_page', cursorParam: 'page' },
        error: { status: '$status', error: { type: 'api_error', code: '$code', message: 'Error $code: $message', retry: false } },
      } },
    });
    const doc = openApiOf(world);
    const list = op(doc, '/customers', 'get');
    assert.deepEqual(list.parameters.map((p) => p.name), ['tier', 'q', 'sort', 'per_page', 'page']);
    assert.equal(list.parameters.at(-1)?.description, 'The next_page of the previous page, under the same sort.');
    assert.deepEqual(doc.components.schemas['customer.list']?.required, ['items', 'next_page']);
    assert.deepEqual(op(doc, '/customers/{id}', 'get').responses['404']?.content?.['application/json'].schema, {
      type: 'object',
      properties: {
        status: { type: 'integer', const: 404 },
        error: {
          type: 'object',
          properties: { type: { const: 'api_error' }, code: { type: 'string', enum: ['row.not_found'] }, message: { type: 'string' }, retry: { const: false } },
          required: ['type', 'code', 'message', 'retry'],
          additionalProperties: false,
        },
      },
      required: ['status', 'error'],
      additionalProperties: false,
    });
  });
});

describe('fieldJsonSchema', () => {
  /** The row schema of each FIELD_TYPES example definition. A new field type fails here until it has a row. */
  const EXPECTED = {
    string: { type: 'string', maxLength: 5 },
    text: { type: 'string' },
    int: { type: 'integer', minimum: 1, maximum: 3 },
    number: { type: 'number' },
    money: { type: 'integer', minimum: 0, description: 'Integer amount in minor units of USD.', 'x-currency': 'USD' },
    bool: { type: 'boolean' },
    datetime: { type: 'string', format: 'date-time' },
    unix_time: { type: 'integer', minimum: 0, description: 'Unix time in whole seconds.' },
    enum: { type: 'string', enum: ['low', 'high'] },
    ref: { type: 'string', description: 'Id of the customer it references.' },
    state: {
      type: 'string', enum: ['open', 'closed'], description: 'Workflow state. Allowed moves: open -> closed; closed is final.',
      'x-transitions': { open: ['closed'], closed: [] },
    },
  } satisfies Record<FieldType, unknown>;

  for (const t of Object.values(FIELD_TYPES)) {
    it(`maps the ${t.type} example definition`, () => {
      assert.deepEqual(fieldJsonSchema(fieldSchema.parse(t.examples.def)), EXPECTED[t.type]);
    });
  }

  it('adds null, readOnly and defaults by use', () => {
    const def = fieldSchema.parse({ type: 'enum', values: ['a', 'b'], nullable: true, readonly: true, default: 'a', description: 'Pick one.' });
    assert.deepEqual(fieldJsonSchema(def, 'row'), { type: ['string', 'null'], enum: ['a', 'b', null], description: 'Pick one.', readOnly: true });
    assert.deepEqual(fieldJsonSchema(def, 'create'), { type: ['string', 'null'], enum: ['a', 'b', null], description: 'Pick one.', default: 'a' });
    assert.deepEqual(fieldJsonSchema(def, 'update'), { type: ['string', 'null'], enum: ['a', 'b', null], description: 'Pick one.' });
    assert.deepEqual(fieldJsonSchema(def, 'query'), { type: 'string', enum: ['a', 'b'], description: 'Pick one.' });
  });

  it('describes a datetime that defaults to now instead of giving it a default', () => {
    const def = fieldSchema.parse({ type: 'datetime', default: 'now', required: true });
    assert.deepEqual(fieldJsonSchema(def, 'create'), { type: 'string', format: 'date-time', description: 'Defaults to the engine time of the write.' });
  });

  it('maps string formats to JSON Schema formats', () => {
    assert.deepEqual(fieldJsonSchema(fieldSchema.parse({ type: 'string', format: 'email' })), { type: 'string', format: 'email' });
    assert.deepEqual(fieldJsonSchema(fieldSchema.parse({ type: 'string', format: 'url', pattern: '^https' })), { type: 'string', pattern: '^https', format: 'uri' });
    assert.deepEqual(fieldJsonSchema(fieldSchema.parse({ type: 'string', format: 'phone' })),
      { type: 'string', description: 'A phone number such as +14155550123.' });
  });
});
