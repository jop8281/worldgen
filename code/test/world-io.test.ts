import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ownerOf } from '../src/worldgen/policy.ts';
import YAML from 'yaml';
import { applyEdit, checkWorld, emptyWorld, loadWorld, renderWorldYaml, type World } from '#engine';

async function tmp(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), 'world-io-'));
}

const SCRIPT = 'async-free\n(ctx) => {\n  return 1;\n}\n';

function base(): World {
  const r = applyEdit(emptyWorld('shop', 'hand'), {
    note: 'seed',
    upsert: {
      entities: { ticket: { description: 'A ticket', idPrefix: 'tk', fields: { title: { type: 'text' } } } },
      tests: { t_one: { description: 'one', script: SCRIPT } },
      tasks: { t1: { difficulty: 'easy', instruction: 'Close the oldest open ticket please', grader: 'g', solution: 's',
        decoys: [{ why: 'closes the wrong ticket', script: 'd' }] } },
    },
  });
  assert.equal(r.ok, true);
  if (!r.ok) throw new Error('unreachable');
  return r.value.world;
}

describe('loadWorld', () => {
  it('R1 returns the parsed yaml unchecked', async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, 'world.yaml'), 'format: 1\nmeta:\n  name: x\nlist: [1, 2]\n');
    const r = await loadWorld(dir);
    if (!r.ok) assert.fail(JSON.stringify(r.error));
    assert.deepEqual(r.value, { format: 1, meta: { name: 'x' }, list: [1, 2] });
    assert.equal(r.lines.file, 'world.yaml');
    assert.equal(r.lines.lineOf(['meta', 'name']), 3);
    assert.equal(r.lines.lineOf(['list', 1]), 4);
  });
  it('R3 an unresolved alias is one format issue, not a throw', async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, 'world.yaml'), 'a: *nope\n');
    const r = await loadWorld(dir);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error.length, 1);
    assert.deepEqual(r.error[0].path, ['format']);
  });
  it('R3 an alias fan-out bomb is one format issue, not a throw', async () => {
    const dir = await tmp();
    let text = 'a0: &a0 [x, x, x, x, x, x, x, x, x, x]\n';
    for (let i = 1; i < 12; i++) text += `a${i}: &a${i} [${Array(10).fill(`*a${i - 1}`).join(', ')}]\n`;
    await writeFile(path.join(dir, 'world.yaml'), text);
    const r = await loadWorld(dir);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual(r.error[0].path, ['format']);
  });
  it('R2 missing file is one format issue naming the path', async () => {
    const dir = await tmp();
    const r = await loadWorld(dir);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error.length, 1);
    assert.deepEqual(r.error[0].path, ['format']);
    assert.equal(r.error[0].code, 'schema.invalid');
    assert.equal(r.error[0].found.includes(path.join(dir, 'world.yaml')), true);
  });
  it('R2 a directory named world.yaml is also a format issue', async () => {
    const dir = await tmp();
    await import('node:fs/promises').then((fs) => fs.mkdir(path.join(dir, 'world.yaml')));
    const r = await loadWorld(dir);
    assert.equal(r.ok, false);
    if (!r.ok) assert.deepEqual(r.error[0].path, ['format']);
  });
  it('R3 syntax error reports line and column', async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, 'world.yaml'), 'format: 1\nmeta: [1, 2\nother: x\n');
    const r = await loadWorld(dir);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error.length, 1);
    assert.deepEqual(r.error[0].path, ['format']);
    assert.match(r.error[0].found, /line 3, column 1/);
  });
  it('R3 duplicate keys are a syntax error with a position', async () => {
    const dir = await tmp();
    await writeFile(path.join(dir, 'world.yaml'), 'a: 1\nb: 2\na: 3\n');
    const r = await loadWorld(dir);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.error[0].found, /line 3, column 1/);
  });
});

describe('renderWorldYaml', () => {
  it('R4 writes multi-line snippets as literal block scalars', () => {
    const text = renderWorldYaml(base());
    assert.equal(text.includes('script: |\n'), true);
    assert.equal(text.includes('      async-free\n      (ctx) => {\n        return 1;\n      }\n'), true);
    assert.equal(text.includes('\\n'), false);
  });
  it('R5 orders top-level keys by SECTIONS whatever the input order', () => {
    const w = base();
    const shuffled = Object.fromEntries(Object.entries(w).reverse()) as unknown as World;
    const top = renderWorldYaml(shuffled).split('\n').filter((l: string) => /^[a-z]/.test(l)).map((l: string) => l.split(':')[0]);
    assert.deepEqual(top, ['format', 'meta', 'entities', 'routes', 'actions', 'jobs', 'fixtures', 'seed', 'tests', 'tasks']);
  });
  it('R6 round-trips awkward strings through loadWorld', async () => {
    const awkward = [
      'a\n', 'a\n\n', 'a\nb', 'a  \nb', ' lead\nb', '\tt\nb', 'x\n\n\ny', 'é\n日本\n', 'null\ntrue', '- a\n- b\n', '# c\nd: e\n',
      'single', '', ' ', 'a\r\nb', 'ends with space \nx', '\nstarts blank', 'a: b', '"quoted"\nline',
    ];
    const w = base();
    for (const s of awkward) {
      const w2 = { ...w, tests: { t_one: { description: s, script: s } } } as World;
      const dir = await tmp();
      await writeFile(path.join(dir, 'world.yaml'), renderWorldYaml(w2));
      const loaded = await loadWorld(dir);
      if (!loaded.ok) assert.fail(JSON.stringify(loaded.error));
      assert.deepEqual(loaded.value, w2, JSON.stringify(s));
    }
  });
  it('R6 load(render(w)) deep-equals w', async () => {
    const w = base();
    const dir = await tmp();
    await writeFile(path.join(dir, 'world.yaml'), renderWorldYaml(w));
    const loaded = await loadWorld(dir);
    if (!loaded.ok) assert.fail(JSON.stringify(loaded.error));
    assert.deepEqual(loaded.value, w);
  });
  it('R6 is stable: render twice is byte-identical', () => {
    assert.equal(renderWorldYaml(base()), renderWorldYaml(base()));
  });
});

describe('applyEdit', () => {
  it('R7 applies remove, then upsert, then patch', () => {
    const r = applyEdit(base(), {
      note: 'order',
      remove: { tests: ['t_one'] },
      upsert: { tests: { t_one: { description: 'new', script: 'x' }, t_two: { description: 'two', script: 'y' } } },
      patch: { tests: { t_two: { description: 'patched' } } },
    });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.value.world.tests, {
      t_one: { description: 'new', script: 'x' },
      t_two: { description: 'patched', script: 'y' },
    });
    assert.equal(r.value.edit.note, 'order');
  });
  it('R7 remove of an absent key is an issue at that key (A-196)', () => {
    const r = applyEdit(base(), { note: 'n', remove: { tests: ['nope'] } });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual(r.error.map((i) => [i.code, i.path, i.found]), [['schema.invalid', ['tests', 'nope'], 'no tests.nope']]);
  });
  it('R8 patching tasks.t1 with decoys null removes the key, then the default applies', () => {
    const r = applyEdit(base(), { note: 'n', patch: { tasks: { t1: { decoys: null, difficulty: 'hard' } } } });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.value.world.tasks.t1, {
      difficulty: 'hard', instruction: 'Close the oldest open ticket please', grader: 'g', solution: 's', decoys: [], alternatives: [],
    });
  });
  it('R8 nested objects merge and arrays replace', () => {
    const r = applyEdit(base(), { note: 'n', patch: { entities: { ticket: {
      fields: { body: { type: 'text' } },
    } }, tasks: { t1: { decoys: [{ why: 'a different plausible mistake', script: 'z' }] } } } });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(Object.keys(r.value.world.entities.ticket!.fields), ['title', 'body']);
    assert.deepEqual(r.value.world.tasks.t1!.decoys, [{ why: 'a different plausible mistake', script: 'z' }]);
  });
  it('R9 patching a missing key returns one issue at [section, key]', () => {
    const r = applyEdit(base(), { note: 'n', patch: { tasks: { t9: { difficulty: 'easy' } } } });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error.length, 1);
    assert.deepEqual(r.error[0].path, ['tasks', 't9']);
  });
  it('R9 a key removed in the same edit cannot be patched', () => {
    const r = applyEdit(base(), { note: 'n', remove: { tasks: ['t1'] }, patch: { tasks: { t1: { difficulty: 'easy' } } } });
    assert.equal(r.ok, false);
    if (!r.ok) assert.deepEqual(r.error[0].path, ['tasks', 't1']);
  });
  it('R10 an unparsable edit returns schema issues with paths', () => {
    const r = applyEdit(base(), { note: 'n', remove: { tests: 'oops' }, bogus: 1, upsert: { entities: { BadName: {} } } });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error.every((i) => i.code === 'schema.invalid'), true);
    assert.equal(r.error.some((i) => i.path.join('.') === 'tests'), true);
    assert.equal(r.error.some((i) => i.path.join('.') === 'entities.BadName'), true);
  });
  it('R10 a non-object edit is one issue at [format]', () => {
    const r = applyEdit(base(), 42);
    assert.equal(r.ok, false);
    if (!r.ok) assert.deepEqual(r.error[0].path, ['format']);
  });
  it('R11 never runs semantic checks: a dangling route entity is accepted', () => {
    const r = applyEdit(base(), { note: 'n', upsert: { routes: { list_ghosts: { op: 'list', entity: 'ghost', method: 'GET', path: '/ghosts' } } } });
    assert.equal(r.ok, true);
  });
  it('R11 a patch that breaks the schema returns schema issues', () => {
    const r = applyEdit(base(), { note: 'n', patch: { tasks: { t1: { difficulty: 'impossible' } } } });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual(r.error[0].path, ['tasks', 't1', 'difficulty']);
    assert.equal(r.error[0].found, '"impossible"');
  });
  it('R12 does not mutate the input world', () => {
    const w = base();
    const before = structuredClone(w);
    applyEdit(w, { note: 'n', remove: { tasks: ['t1'] }, patch: { entities: { ticket: { description: 'changed' } } } });
    assert.deepEqual(w, before);
  });
  it('R12 a description-only meta edit keeps custom api and clock.tick', () => {
    const seeded = applyEdit(base(), { note: 'n', meta: { api: { list: { dataKey: 'items' } }, clock: { start: '2026-01-05T09:00:00.000Z', tick: '5m' } } });
    assert.equal(seeded.ok, true);
    if (!seeded.ok) return;
    assert.equal(seeded.value.world.meta.api.list.dataKey, 'items');
    const r = applyEdit(seeded.value.world, { note: 'n', meta: { description: 'x' } });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.world.meta.api.list.dataKey, 'items');
    assert.equal(r.value.world.meta.clock.tick, '5m');
    assert.equal(r.value.world.meta.description, 'x');
  });
  it('R12 meta is merge-patched', () => {
    const r = applyEdit(base(), { note: 'n', meta: { description: 'A shop', seed: 7 } });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.world.meta.description, 'A shop');
    assert.equal(r.value.world.meta.seed, 7);
    assert.equal(r.value.world.meta.name, 'shop');
  });
  it('R12 meta.api.error is replaced whole, not merged, and nulls inside it are kept', () => {
    const first = applyEdit(base(), { note: 'n', meta: { api: { error: { error: { type: '$code', message: '$message', param: null } } } } });
    assert.equal(first.ok, true);
    if (!first.ok) return;
    assert.deepEqual(first.value.world.meta.api.error, { error: { type: '$code', message: '$message', param: null } });
    const second = applyEdit(first.value.world, { note: 'n', meta: { api: { error: { message: '$message', status: '$status' } } } });
    assert.equal(second.ok, true);
    if (!second.ok) return;
    assert.deepEqual(second.value.world.meta.api.error, { message: '$message', status: '$status' });
  });
  it('R12 other meta.api keys still merge beside an untouched error template', () => {
    const r = applyEdit(base(), { note: 'n', meta: { api: { list: { dataKey: 'items' } } } });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.value.world.meta.api.list.dataKey, 'items');
    assert.equal(r.value.world.meta.api.list.cursorKey, 'next_cursor');
    assert.deepEqual(r.value.world.meta.api.error, { error: { code: '$code', message: '$message' } });
  });
  it('R10 an edit parse issue resolves to an owner step through ownerOf', () => {
    const r = applyEdit(base(), { note: 'n', remove: { tests: 'oops' }, upsert: { entities: { BadName: {} } }, bogus: 1 });
    assert.equal(r.ok, false);
    if (r.ok) return;
    const byPath = Object.fromEntries(r.error.map((i) => [i.path.join('.'), ownerOf(i)]));
    assert.equal(byPath['tests'], 'plan');
    assert.equal(byPath['entities.BadName'], 'model');
  });
  it('R8 a __proto__ key in a patch is data, not a prototype write', () => {
    const patch = JSON.parse('{"note":"n","patch":{"tests":{"t_one":{"__proto__":{"polluted":true}}}}}') as unknown;
    applyEdit(base(), patch);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
});

describe('fix-engine-world-io', () => {
  const issuesOf = (r: { ok: boolean; error?: readonly { code: string; path: readonly (string | number)[] }[] }) =>
    (r.ok ? [] : (r.error ?? []).map((i) => [i.code, i.path.join('.')]));

  it('A1 a nested meta edit is a merge patch: clock.tick changes and clock.start stays', () => {
    const r = applyEdit(base(), { note: 'n', meta: { clock: { tick: '2s' } } });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.value.world.meta.clock, { start: '2026-01-05T09:00:00.000Z', tick: '2s' });
  });
  it('A1 a nested meta edit keeps sibling api.list keys', () => {
    const r = applyEdit(base(), { note: 'n', meta: { api: { list: { cursorKey: 'next' } } } });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.deepEqual(r.value.world.meta.api.list, {
      mode: 'cursor', dataKey: 'data', cursorKey: 'next', limitParam: 'limit', cursorParam: 'cursor',
      hasMoreKey: 'has_more', startingAfterParam: 'starting_after', endingBeforeParam: 'ending_before',
    });
  });
  it('A2 an unknown key in a patch item is a schema.invalid issue at its path', () => {
    const r = applyEdit(base(), { note: 'n', patch: { entities: { ticket: { fields: { title: { requried: true } } } } } });
    assert.deepEqual(issuesOf(r), [['schema.invalid', 'entities.ticket.fields.title.requried']]);
  });
  it('A2 an unknown key in an upserted item is a schema.invalid issue at its path', () => {
    const r = applyEdit(base(), { note: 'n', upsert: { tests: { t2: { description: 'two', script: SCRIPT, owner: 'x' } } } });
    assert.deepEqual(issuesOf(r), [['schema.invalid', 'tests.t2.owner']]);
  });
  it('A2 an unknown meta key in an edit is a schema.invalid issue at its path', () => {
    const r = applyEdit(base(), { note: 'n', meta: { clock: { speed: 2 } } });
    assert.deepEqual(issuesOf(r), [['schema.invalid', 'meta.clock.speed']]);
  });
  it('A2 an unknown top-level edit key is a schema.invalid issue naming the key', () => {
    const r = applyEdit(base(), { note: 'n', upsertt: { tests: {} } });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.error.length, 1);
    assert.equal(r.error[0].code, 'schema.invalid');
    assert.match(r.error[0].expected, /upsertt/);
  });
  it('A4 a typo in a field definition fails checkWorld naming the key', () => {
    const w = structuredClone(base()) as unknown as { entities: { ticket: { fields: Record<string, unknown> } } };
    w.entities.ticket.fields.title = { type: 'text', requried: true };
    const r = checkWorld(w);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.deepEqual(r.issues.filter((i) => i.code === 'schema.invalid').map((i) => [i.path.join('.'), i.expected]),
      [['entities.ticket.fields.title', 'Unrecognized key: "requried"']]);
  });
  it('A4 an unknown top-level section fails checkWorld naming the key', () => {
    const r = checkWorld({ ...base(), workflows: { x: 1 } });
    assert.equal(r.ok, false);
    if (r.ok) return;
    const schema = r.issues.filter((i) => i.code === 'schema.invalid');
    assert.equal(schema.length, 1);
    assert.match(schema[0]?.expected ?? '', /workflows/);
  });
  it('A3 save then load is the identity over tricky strings (property-style)', () => {
    const atoms = ['', ' ', '  ', '\t', '\n', 'a', '#', ':', '- ', '"', "'", '|', '\r\n', '{}', 'null', '1'];
    const cases = new Set<string>();
    for (const a of atoms) for (const b of atoms) for (const c of atoms) cases.add(a + b + c);
    let mismatches = 0;
    for (const s of cases) {
      const w = structuredClone(base());
      w.meta.description = s;
      w.tests.t_one = { description: s, script: SCRIPT };
      const back = YAML.parse(renderWorldYaml(w)) as World;
      if (back.meta.description !== s || back.tests.t_one?.description !== s) mismatches += 1;
    }
    assert.equal(mismatches, 0);
  });
  it('A3 a whitespace-only line string survives a round trip', () => {
    const w = structuredClone(base());
    w.meta.description = ' \n';
    assert.equal((YAML.parse(renderWorldYaml(w)) as World).meta.description, ' \n');
  });
});
