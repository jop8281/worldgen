import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { SECTIONS, editJsonSchema, emptyWorld, entitySchema, formatReference, worldEditSchema, worldSchema } from '../src/engine/format.ts';
import { FIELD_TYPES } from '../src/engine/fields.ts';
import { snippetDoc } from '../src/engine/ctx.ts';
import { fromZod } from '../src/engine/issues.ts';

const ALL_SECTIONS = ['entities', 'routes', 'actions', 'jobs', 'fixtures', 'seed', 'tests', 'tasks'];

function worldWith(entities: Record<string, unknown>): Record<string, unknown> {
  return {
    format: 1,
    meta: { name: 'helpdesk', description: 'd', resembles: 'Zendesk', source: 'hand', seed: 1,
      clock: { start: '2026-01-05T09:00:00.000Z' } },
    entities, routes: {}, actions: {}, jobs: {}, fixtures: {}, seed: {}, tests: {}, tasks: {},
  };
}

describe('emptyWorld', () => {
  it('R1 parses with worldSchema', () => {
    assert.equal(worldSchema.safeParse(emptyWorld('x', 'worldgen')).success, true);
  });
  it('R2 has every section as {}', () => {
    const w = emptyWorld('x', 'worldgen') as unknown as Record<string, unknown>;
    assert.deepEqual([...SECTIONS], ALL_SECTIONS);
    for (const s of ALL_SECTIONS) assert.deepEqual(w[s], {});
  });
  it('R3 uses the fixed clock start and is deterministic', () => {
    const w = emptyWorld('x', 'worldgen');
    assert.equal(w.meta.clock.start, '2026-01-05T09:00:00.000Z');
    assert.equal(w.meta.clock.tick, '0s');
    assert.equal(w.meta.name, 'x');
    assert.equal(w.meta.source, 'worldgen');
    assert.equal(w.format, 1);
    assert.deepEqual(emptyWorld('x', 'worldgen'), w);
    assert.equal(emptyWorld('y', 'hand').meta.source, 'hand');
  });
  it('rejects a name that is not snake_case', () => {
    assert.throws(() => emptyWorld('Bad Name', 'hand'));
  });
});

describe('worldEditSchema meta.clock', () => {
  it('accepts a zero tick, as the world schema does, and injects no key the edit left out', () => {
    for (const tick of ['0s', '0d']) {
      const r = worldEditSchema.safeParse({ note: 'n', meta: { clock: { tick } } });
      assert.equal(r.success, true, tick);
      if (r.success) assert.deepEqual(r.data.meta, { clock: { tick } });
    }
    const start = worldEditSchema.parse({ note: 'n', meta: { clock: { start: '2026-01-05T09:00:00.000Z' } } });
    assert.deepEqual(start.meta, { clock: { start: '2026-01-05T09:00:00.000Z' } });
  });
  it('rejects a tick that is not a duration', () => {
    for (const tick of ['-1s', '1.5h']) {
      assert.equal(worldEditSchema.safeParse({ note: 'n', meta: { clock: { tick } } }).success, false, tick);
    }
  });
});

describe('editJsonSchema', () => {
  type Js = { $schema?: string; required?: string[]; properties: Record<string, Js & { description?: string; pattern?: string }>; additionalProperties?: Js };
  const js = editJsonSchema(['entities', 'routes']) as Js;

  it('R4 lists only the written sections in upsert, patch and remove', () => {
    assert.deepEqual(Object.keys(js.properties.upsert!.properties), ['entities', 'routes']);
    assert.deepEqual(Object.keys(js.properties.patch!.properties), ['entities', 'routes']);
    assert.deepEqual(Object.keys(js.properties.remove!.properties), ['entities', 'routes']);
    assert.deepEqual(Object.keys(js.properties), ['note', 'meta', 'upsert', 'patch', 'remove']);
    assert.deepEqual(js.required, ['note']);
    const reversed = editJsonSchema(['routes', 'entities']) as Js;
    assert.deepEqual(Object.keys(reversed.properties.upsert!.properties), ['entities', 'routes']);
  });
  it('R5 is derived by z.toJSONSchema from the zod schemas', () => {
    assert.equal(js.$schema, 'https://json-schema.org/draft/2020-12/schema');
    const entity = js.properties.upsert!.properties.entities!.additionalProperties!;
    assert.equal(entity.properties.idPrefix!.pattern, '^[a-z]{2,5}$');
    assert.equal(entity.properties.idPrefix!.description, 'Row ids look like <idPrefix>_0001');
    assert.equal(js.properties.patch!.description,
      'merge-patch existing items by key. Use it to add one field or state without restating the item.');
    const all = editJsonSchema(SECTIONS) as Js;
    assert.deepEqual(Object.keys(all.properties.upsert!.properties), ALL_SECTIONS);
    assert.deepEqual(Object.keys((editJsonSchema(['tasks']) as Js).properties.remove!.properties), ['tasks']);
  });
});

describe('formatReference', () => {
  const md = formatReference();

  it('R6 has exactly one heading per section', () => {
    for (const s of ALL_SECTIONS) {
      assert.equal(md.split('\n').filter((l) => l === `## ${s}`).length, 1, s);
    }
  });
  it('R7 contains every field type doc', () => {
    assert.deepEqual(Object.keys(FIELD_TYPES), ['string', 'text', 'int', 'number', 'money', 'bool', 'datetime', 'unix_time', 'enum', 'ref', 'state']);
    for (const t of Object.values(FIELD_TYPES)) assert.ok(md.includes(t.doc), t.type);
    assert.ok(md.includes('Amount in integer minor units (1250 is 12.50 in USD). The currency is fixed on the field.'));
  });
  it('R8 contains the snippet doc of all five kinds', () => {
    for (const k of ['handler', 'job', 'seed', 'grader', 'client'] as const) assert.ok(md.includes(snippetDoc(k)), k);
    assert.ok(md.includes('### grader'));
  });
  it('R9 returns identical text on every call', () => {
    assert.equal(formatReference(), md);
    assert.ok(md.startsWith('# World format\n'));
  });
});

describe('fromZod', () => {
  it('R14 reports idPrefix TK at entities.ticket.idPrefix with the describe hint', () => {
    const input = worldWith({ ticket: { description: 'A ticket', idPrefix: 'TK', fields: {} } });
    const r = worldSchema.safeParse(input);
    assert.equal(r.success, false);
    const issues = fromZod(r.error, [], { schema: worldSchema, input });
    assert.equal(issues.length, 1);
    assert.deepEqual(issues[0].path, ['entities', 'ticket', 'idPrefix']);
    assert.equal(issues[0].code, 'schema.invalid');
    assert.equal(issues[0].severity, 'error');
    assert.equal(issues[0].found, '"TK"');
    assert.ok(issues[0].hint.includes('Row ids look like'));
    assert.equal(issues[0].hint, 'Row ids look like <idPrefix>_0001. Match the shape in prod/world-format.md.');
  });
  it('R10 maps each zod issue to one schema.invalid issue with the zod message as expected', () => {
    const input = { description: 3, idPrefix: 'TK', fields: {} };
    const r = entitySchema.safeParse(input);
    const issues = fromZod(r.error, ['entities', 'ticket'], { schema: entitySchema, input });
    assert.equal(issues.length, 2);
    assert.deepEqual(issues.map((i) => i.code), ['schema.invalid', 'schema.invalid']);
    assert.deepEqual(issues.map((i) => i.expected), ['Invalid input: expected string, received number', 'Invalid string: must match pattern /^[a-z]{2,5}$/']);
  });
  it('R11 prefixes the path with base', () => {
    const input = { description: 'd', idPrefix: 'TK', fields: {} };
    const r = entitySchema.safeParse(input);
    const issues = fromZod(r.error, ['entities', 'ticket'], { schema: entitySchema, input });
    assert.deepEqual(issues[0].path, ['entities', 'ticket', 'idPrefix']);
  });
  it('R12 truncates found to 200 chars and marks a missing value', () => {
    const long = 'a'.repeat(300);
    const input = { description: 'd', idPrefix: long, fields: {} };
    const r = entitySchema.safeParse(input);
    const [first] = fromZod(r.error, ['entities', 'ticket'], { schema: entitySchema, input });
    assert.equal(first.found.length, 200);
    assert.equal(first.found, '"' + 'a'.repeat(196) + '...');
    const missing = { description: 'd', fields: {} };
    const r2 = entitySchema.safeParse(missing);
    const [m] = fromZod(r2.error, ['entities', 'ticket'], { schema: entitySchema, input: missing });
    assert.equal(m.found, 'missing');
    assert.deepEqual(m.path, ['entities', 'ticket', 'idPrefix']);
  });
  it('R12 reads found from issue.input when zod reports it', () => {
    const r = entitySchema.safeParse({ description: 'd', idPrefix: 'TK', fields: {} }, { reportInput: true });
    const [first] = fromZod(r.error, ['entities', 'ticket'], { schema: entitySchema, input: {} });
    assert.equal(first.found, '"TK"');
  });
  it('R13 uses the plain hint when the field has no describe text', () => {
    const input = { description: 3, idPrefix: 'tk', fields: {} };
    const r = entitySchema.safeParse(input);
    const [first] = fromZod(r.error, ['entities', 'ticket'], { schema: entitySchema, input });
    assert.equal(first.hint, 'Match the shape in prod/world-format.md.');
    assert.equal(first.found, '3');
  });
  it('R13 finds describe text through a discriminated union', () => {
    const input = worldWith({});
    (input.routes as Record<string, unknown>).list_tickets = { op: 'list', entity: 'ticket', method: 'GET', path: 'tickets' };
    const r = worldSchema.safeParse(input);
    const issues = fromZod(r.error, [], { schema: worldSchema, input });
    assert.equal(issues.length, 1);
    assert.deepEqual(issues[0].path, ['routes', 'list_tickets', 'path']);
    assert.equal(issues[0].hint, 'OpenAPI-style path with {params}, such as /tickets/{id}. Match the shape in prod/world-format.md.');
  });
  it('falls back to the format path for a root-level error and to one issue for a non-zod error', () => {
    const r = worldSchema.safeParse(5);
    const [root] = fromZod(r.error, [], { schema: worldSchema, input: 5 });
    assert.deepEqual(root.path, ['format']);
    assert.equal(root.found, '5');
    assert.equal(root.expected, 'Invalid input: expected object, received number');
    const other = fromZod(new Error('boom'), ['meta'], { schema: worldSchema, input: undefined });
    assert.equal(other.length, 1);
    assert.deepEqual(other[0].path, ['meta']);
    assert.equal(other[0].expected, 'boom');
  });
  it('R14 reports a bad record key with the key as found and the key describe hint', () => {
    const input = worldWith({ Ticket: { description: 'd', idPrefix: 'tk', fields: {} } });
    const r = worldSchema.safeParse(input);
    const issues = fromZod(r.error, [], { schema: worldSchema, input });
    assert.equal(issues.length, 1);
    assert.deepEqual(issues[0].path, ['entities', 'Ticket']);
    assert.equal(issues[0].found, '"Ticket"');
    assert.equal(issues[0].expected, 'Invalid key in record: Invalid string: must match pattern /^[a-z][a-z0-9_]*$/');
    assert.equal(issues[0].hint, 'snake_case identifier. Match the shape in prod/world-format.md.');
  });
  it('requires the schema and input at compile time', () => {
    const r = entitySchema.safeParse({});
    // @ts-expect-error the two-argument form would drop found and the describe hint
    const call = () => fromZod(r.error, []);
    // @ts-expect-error input is required too
    const call2 = () => fromZod(r.error, [], { schema: entitySchema });
    assert.equal(typeof call, 'function');
    assert.equal(typeof call2, 'function');
  });
  it('works on any zod schema', () => {
    const s = z.object({ n: z.number().describe('a count') });
    const r = s.safeParse({ n: 'x' });
    const [i] = fromZod(r.error, ['meta'], { schema: s, input: { n: 'x' } });
    assert.deepEqual(i.path, ['meta', 'n']);
    assert.equal(i.hint, 'a count. Match the shape in prod/world-format.md.');
  });
});


describe('JSON error templates', () => {
  for (const kind of ['world', 'edit']) {
    const parse = (error: unknown) => kind === 'world'
      ? worldSchema.safeParse({ ...worldWith({}), meta: { ...emptyWorld('x', 'hand').meta, api: { error } } })
      : worldEditSchema.safeParse({ note: 'replace error template', meta: { api: { error } } });
    it(`${kind} rejects an object cycle at the error template`, () => {
      const error: Record<string, unknown> = { code: '$code' };
      error.self = error;
      const result = parse(error);
      assert.equal(result.success, false);
      if (!result.success) assert.deepEqual(result.error.issues[0]?.path, ['meta', 'api', 'error']);
    });
    it(`${kind} rejects an array cycle at the error template`, () => {
      const error: unknown[] = [];
      error.push(error);
      const result = parse(error);
      assert.equal(result.success, false);
      if (!result.success) assert.deepEqual(result.error.issues[0]?.path, ['meta', 'api', 'error']);
    });
    it(`${kind} accepts a shared child that has no cycle`, () => {
      const child = { message: '$message' };
      assert.equal(parse({ first: child, second: child }).success, true);
    });
  }
});
