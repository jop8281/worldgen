/**
 * Red-team: WorldEdit, diffWorlds, saveWorld and loadWorld (G-50 to G-55).
 *
 * Expected worlds are built from the fixture with plain object spreads, or are literals.
 * Nothing here calls engine logic to compute an expected value.
 *
 * Ambiguities this file owns in the contract: RT-91 (unknown keys and sections in an edit),
 * RT-92 (removing a missing key), RT-93 (patching a missing item), RT-94 (a widening
 * transition change), RT-95 (multi-document world.yaml) and RT-96 (byte-stable saveWorld).
 */
import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isDeepStrictEqual } from 'node:util';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyEdit, checkWorld, diffWorlds, emptyWorld, loadWorld, saveWorld, DESTRUCTIVE, ISSUES,
  type ChangeKind, type CheckIssue, type CheckedWorld, type IssueCode, type Section, type World,
} from '#engine';
import { cap, clone, deepFreeze, failWithRepro, opts, rng, todo, writeWorldDir, SEED, type Rng } from './redteam/harness.ts';
import { SNIPPETS, baseWorld, field } from './redteam/world.ts';

// ---------------------------------------------------------------------------------------
// File-local helpers

const SECTION_NAMES: readonly Section[] = ['entities', 'routes', 'actions', 'jobs', 'fixtures', 'seed', 'tests', 'tasks'];
const PATH_HEADS: readonly string[] = [...SECTION_NAMES, 'meta', 'format', 'plan', 'input'];

function at<T>(rec: Readonly<Record<string, T>>, key: string): T {
  const v = rec[key];
  if (v === undefined) throw new assert.AssertionError({ message: `no ${key} in ${JSON.stringify(Object.keys(rec))}` });
  return v;
}

/** Apply and require ok. */
function mustApply(world: World, edit: unknown): World {
  const r = applyEdit(world, edit);
  if (!r.ok) throw new assert.AssertionError({ message: `applyEdit refused ${JSON.stringify(edit)}: ${JSON.stringify(r.error.map((i) => [i.code, i.path, i.found]))}` });
  return r.value.world;
}

/** Problems with one issue's shape (G-02 applied to edit issues). */
function issueProblems(i: CheckIssue): string[] {
  const out: string[] = [];
  if (!(i.code in ISSUES)) out.push(`unknown code ${String(i.code)}`);
  else if (i.severity !== ISSUES[i.code as IssueCode].severity) out.push(`${i.code}: severity ${i.severity}`);
  if (!Array.isArray(i.path) || i.path.length === 0) out.push(`${i.code}: empty path`);
  else if (!PATH_HEADS.includes(String(i.path[0]))) out.push(`${i.code}: path head ${String(i.path[0])}`);
  for (const k of ['expected', 'found', 'hint'] as const) if (typeof i[k] !== 'string' || i[k] === '') out.push(`${i.code}: empty ${k}`);
  return out;
}

/** Set an own enumerable property, even for '__proto__'. */
function defineOwn(o: Record<string, unknown>, k: string, v: unknown): void {
  Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
}

/** Rebuild every plain object with its keys in reverse order. Arrays keep their order. */
function reverseKeys<T>(x: T): T {
  if (Array.isArray(x)) return x.map(reverseKeys) as T;
  if (x !== null && typeof x === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(x).reverse()) out[k] = reverseKeys((x as Record<string, unknown>)[k]);
    return out as T;
  }
  return x;
}

const ticketOf = (w: World) => at(w.entities, 'ticket');
const NOTE = 'red-team edit';
const JOB_C = { description: 'Job c from an edit.', every: '1h', run: SNIPPETS.job('a') };

// ---------------------------------------------------------------------------------------
// applyEdit

describe('applyEdit purity (G-50)', () => {
  it('G-50 a note-only edit returns a deep-equal world and leaves the input untouched', cap('applyEdit'), () => {
    const input = baseWorld();
    const r = applyEdit(input, { note: NOTE });
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.deepEqual(r.value.world, baseWorld());
      assert.deepEqual(r.value.edit, { note: NOTE, upsert: {}, patch: {}, remove: {} });
    }
    assert.deepEqual(input, baseWorld());
  });

  it('G-50 an edit on a deep-frozen world works, and the result is independent of the input', cap('applyEdit'), () => {
    const frozen = deepFreeze(baseWorld());
    const w = mustApply(frozen, { note: NOTE, patch: { jobs: { a: { every: '2h' } } }, upsert: { jobs: { c: JOB_C } } });
    const b = baseWorld();
    // The whole result, so an upsert that replaces the section or a patch that lands on every item fails.
    assert.deepEqual(w, { ...b, jobs: { ...b.jobs, a: { ...at(b.jobs, 'a'), every: '2h' }, c: JOB_C } });
    assert.equal(at(frozen.jobs, 'a').every, '1h');
    assert.deepEqual(frozen, baseWorld());
    // The result is not tied to the input: changing it leaves the input and a second result alone.
    const again = mustApply(frozen, { note: NOTE, patch: { jobs: { a: { every: '2h' } } }, upsert: { jobs: { c: JOB_C } } });
    const copy = clone(again);
    const resultJobs: Record<string, unknown> = w.jobs;
    if (!Object.isFrozen(resultJobs)) resultJobs['d'] = JOB_C;
    assert.deepEqual(again, copy);
  });

  it('G-50 generation is edit(emptyWorld): upserting every base section rebuilds the base world', cap('applyEdit', 'emptyWorld'), () => {
    const b = baseWorld();
    const { format: _format, meta, ...sections } = b;
    void _format;
    const w = mustApply(emptyWorld('redteam_desk', 'hand'), { note: 'generate', meta, upsert: sections });
    assert.deepEqual(w, baseWorld());
  });

  /** Fuzz material: what a confused model might send. */
  const KEYS: Readonly<Record<Section, readonly string[]>> = (() => {
    const b = baseWorld();
    return Object.fromEntries(SECTION_NAMES.map((s) => [s, [...Object.keys(b[s]), 'new_item', 'nope']])) as Record<Section, string[]>;
  })();
  const ODD_KEYS = ['__proto__', 'constructor', 'prototype', 'Bad Key', '', 'description', 'fields', 'every', 'run', 'widgets', 'toString'];
  const PATCHES: Readonly<Record<Section, readonly unknown[]>> = {
    entities: [{ description: 'Patched.' }, { fields: { credit: null } }, { fields: { status: { transitions: { closed: ['open'] } } } }, { idPrefix: 'zz' }, { fields: null }],
    routes: [{ pageSize: 5 }, { filters: [] }, { description: null }, { op: 'delete' }],
    actions: [{ description: 'Patched.' }, { input: { reason: null } }, { handler: '(ctx) => ({ status: 200, body: {} })' }],
    jobs: [{ every: '2h' }, { description: 'Patched.' }, { run: null }],
    fixtures: [{ a: 1 }],
    seed: [{ x: 1 }],
    tests: [{ description: 'Patched.' }, { script: null }],
    tasks: [{ difficulty: 'hard' }, { decoys: [] }, { instruction: 'A replacement instruction long enough to pass.' }],
  };

  function garbage(r: Rng, depth = 0): unknown {
    switch (r.int(0, depth >= 3 ? 6 : 8)) {
      case 0: return null;
      case 1: return r.bool();
      case 2: return r.pick([0, -1, 1.5, -0, 1e308, Number.MAX_SAFE_INTEGER, Number.NaN, Number.POSITIVE_INFINITY]);
      case 3: return r.pick(['', 'x', '(ctx) => {}', '1h', 'ticket', 'Bad Key', 'a'.repeat(5000), 'café ✓ 日本語']);
      case 4: return undefined;
      case 5: return r.pick(ODD_KEYS);
      case 6: return r.pick(['open', 'pending', 'closed', 'easy']);
      case 7: return Array.from({ length: r.int(0, 3) }, () => garbage(r, depth + 1));
      default: {
        const o: Record<string, unknown> = {};
        for (let i = r.int(0, 3); i > 0; i--) defineOwn(o, r.pick([...ODD_KEYS, 'note', 'upsert', 'patch', 'remove']), garbage(r, depth + 1));
        return o;
      }
    }
  }

  function sectionMap(r: Rng, value: (s: Section) => unknown): unknown {
    if (r.bool(0.08)) return garbage(r);
    const o: Record<string, unknown> = {};
    for (let i = r.int(1, 3); i > 0; i--) {
      if (r.bool(0.1)) defineOwn(o, r.pick(['widgets', '__proto__', 'Entities', 'meta']), garbage(r));
      else {
        const s = r.pick(SECTION_NAMES);
        o[s] = value(s);
      }
    }
    return o;
  }

  function recordOf(r: Rng, s: Section, item: () => unknown): unknown {
    if (r.bool(0.08)) return garbage(r);
    const o: Record<string, unknown> = {};
    for (let i = r.int(1, 2); i > 0; i--) defineOwn(o, r.bool(0.9) ? r.pick(at(KEYS, s)) : r.pick(ODD_KEYS), item());
    return o;
  }

  function plausibleItem(r: Rng, s: Section): unknown {
    const items = Object.values(baseWorld()[s] as Record<string, unknown>);
    return items.length > 0 ? clone(r.pick(items)) : garbage(r);
  }

  function fuzzEdit(r: Rng): unknown {
    if (r.bool(0.05)) return garbage(r);
    const e: Record<string, unknown> = {};
    const noteRoll = r.int(0, 9);
    if (noteRoll < 8) e['note'] = `fuzz ${r.int(0, 999)}`;
    else if (noteRoll === 8) e['note'] = garbage(r);
    if (r.bool(0.45)) e['upsert'] = sectionMap(r, (s) => recordOf(r, s, () => (r.bool(0.65) ? plausibleItem(r, s) : garbage(r))));
    if (r.bool(0.45)) e['patch'] = sectionMap(r, (s) => recordOf(r, s, () => (r.bool(0.65) ? clone(r.pick(at(PATCHES, s))) : garbage(r))));
    if (r.bool(0.4)) e['remove'] = sectionMap(r, (s) => (r.bool(0.85) ? Array.from({ length: r.int(0, 3) }, () => r.pick(at(KEYS, s))) : garbage(r)));
    if (r.bool(0.15)) e['meta'] = r.bool(0.5) ? { seed: r.int(0, 99) } : garbage(r);
    if (r.bool(0.05)) defineOwn(e, r.pick(['widgets', '__proto__', 'entities']), garbage(r));
    return e;
  }

  /** An own data property, read without walking the prototype chain (keys may be '__proto__'). */
  function own(x: unknown, k: string): unknown {
    return x !== null && typeof x === 'object' ? Object.getOwnPropertyDescriptor(x, k)?.value : undefined;
  }
  function plainKeys(x: unknown): string[] {
    return x !== null && typeof x === 'object' && !Array.isArray(x) ? Object.keys(x) : [];
  }

  /**
   * Invariance on an accepted edit, compared with a fresh baseWorld(): items the edit does not
   * name stay deep-equal, no item appears that the edit did not upsert or patch, an item only
   * removed is gone, and meta and format stay unless the edit has a meta.
   */
  function collateral(edit: unknown, out: World): string | null {
    const base = baseWorld();
    if (!isDeepStrictEqual(out.format, base.format)) return 'format changed';
    if (own(edit, 'meta') === undefined && !isDeepStrictEqual(out.meta, base.meta)) return 'meta changed by an edit without meta';
    for (const s of SECTION_NAMES) {
      const up = plainKeys(own(own(edit, 'upsert'), s));
      const pa = plainKeys(own(own(edit, 'patch'), s));
      const rmRaw = own(own(edit, 'remove'), s);
      const rm = Array.isArray(rmRaw) ? rmRaw.filter((k): k is string => typeof k === 'string') : [];
      const named = new Set([...up, ...pa, ...rm]);
      const before = base[s] as Readonly<Record<string, unknown>>;
      const after = out[s] as unknown;
      if (after === null || typeof after !== 'object' || Array.isArray(after)) return `${s} is not a record`;
      for (const k of Object.keys(before)) {
        if (named.has(k)) continue;
        if (!Object.hasOwn(after, k)) return `${s}.${k} vanished, though the edit does not name it`;
        if (!isDeepStrictEqual(own(after, k), before[k])) return `${s}.${k} changed, though the edit does not name it`;
      }
      const allowed = new Set([...Object.keys(before), ...up, ...pa]);
      for (const k of Object.keys(after)) if (!allowed.has(k)) return `${s}.${k} appeared, though the edit does not upsert or patch it`;
      for (const k of rm) if (!up.includes(k) && !pa.includes(k) && Object.hasOwn(after, k)) return `${s}.${k} survived its remove`;
    }
    return null;
  }

  /** null when the edit behaves, else a description of what went wrong. */
  function misbehaviour(edit: unknown): string | null {
    const protoKeys = Object.getOwnPropertyNames(Object.prototype).length;
    try {
      const world = baseWorld();
      const editCopy = clone(edit);
      const r1 = applyEdit(world, editCopy);
      if (!isDeepStrictEqual(world, baseWorld())) return 'mutated the input world';
      if (!isDeepStrictEqual(editCopy, edit)) return 'mutated the input edit';
      if (typeof r1 !== 'object' || r1 === null || typeof r1.ok !== 'boolean') return `not a Result: ${JSON.stringify(r1)}`;
      if (r1.ok) {
        if (typeof r1.value.world !== 'object' || r1.value.world === null) return 'ok without a world';
        const c = collateral(edit, r1.value.world);
        if (c !== null) return c;
      } else {
        if (!Array.isArray(r1.error) || r1.error.length === 0) return 'ok false with no issues';
        const bad = r1.error.flatMap(issueProblems);
        if (bad.length > 0) return `malformed issues: ${bad.join('; ')}`;
      }
      const r2 = applyEdit(deepFreeze(baseWorld()), deepFreeze(clone(edit)));
      if (!isDeepStrictEqual(r1, r2)) return 'frozen inputs or a second call gave a different result';
      if (Object.getOwnPropertyNames(Object.prototype).length !== protoKeys) return 'polluted Object.prototype';
      return null;
    } catch (e) {
      if (e instanceof Error && e.message === 'not implemented') throw e;
      return `threw ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`;
    }
  }

  it('G-50 G-52 200 fuzzed edits never throw, never mutate their inputs, and repeat deterministically', cap('applyEdit'), () => {
    const r = rng(SEED);
    const edits = Array.from({ length: 200 }, () => fuzzEdit(r));
    const failing = edits.map((e) => misbehaviour(e)).findIndex((m) => m !== null);
    if (failing >= 0) {
      failWithRepro('G-50 fuzzed applyEdit', SEED, edits, (sub) => sub.some((e) => misbehaviour(e) !== null), `first failure: ${misbehaviour(edits[failing])}`);
    }
  });

  /** Every object reachable from x keeps a plain prototype and inherits no 'polluted' key. */
  function protoProblems(x: unknown, path: string, out: string[], seen: Set<object> = new Set()): string[] {
    if (x === null || typeof x !== 'object' || seen.has(x)) return out;
    seen.add(x);
    const proto: unknown = Object.getPrototypeOf(x);
    const plain = Array.isArray(x) ? proto === Array.prototype : proto === Object.prototype || proto === null;
    if (!plain) out.push(`${path} has a swapped prototype`);
    if ('polluted' in x && !Object.hasOwn(x, 'polluted')) out.push(`${path} inherits polluted`);
    for (const k of Object.keys(x)) protoProblems(Object.getOwnPropertyDescriptor(x, k)?.value, `${path}.${k}`, out, seen);
    return out;
  }

  it('G-50 __proto__ and constructor keys in an edit never pollute Object.prototype', cap('applyEdit'), () => {
    const attacks = [
      '{"note":"p","patch":{"entities":{"ticket":{"__proto__":{"polluted":"yes"}}}}}',
      '{"note":"p","patch":{"jobs":{"a":{"constructor":{"prototype":{"polluted":"yes"}}}}}}',
      '{"note":"p","patch":{"jobs":{"__proto__":{"polluted":"yes"}}}}',
      '{"note":"p","upsert":{"jobs":{"__proto__":{"description":"x","every":"1h","run":"(ctx) => {}"}}}}',
      '{"note":"p","upsert":{"__proto__":{"polluted":"yes"}}}',
      '{"note":"p","meta":{"__proto__":{"polluted":"yes"}}}',
      '{"note":"p","__proto__":{"polluted":"yes"}}',
      '{"note":"p","remove":{"jobs":["__proto__"]}}',
    ];
    for (const json of attacks) {
      const r = applyEdit(baseWorld(), JSON.parse(json));
      assert.equal(({} as Record<string, unknown>)['polluted'], undefined, `polluted by ${json}`);
      assert.equal(Object.hasOwn(Object.prototype, 'polluted'), false, `polluted by ${json}`);
      if (r.ok) {
        // At any depth: a merge patch that assigns __proto__ swaps the prototype of the item it lands on.
        assert.deepEqual(protoProblems(r.value, 'value', []), [], json);
        // Sections the attack does not touch are unchanged.
        assert.deepEqual(r.value.world.routes, baseWorld().routes, `${json}: routes changed`);
        assert.deepEqual(r.value.world.tasks, baseWorld().tasks, `${json}: tasks changed`);
      }
    }
  });
});

describe('applyEdit order and merge patch (G-51)', () => {
  it('G-51 remove runs before upsert: removing and upserting the same key keeps the upserted item', cap('applyEdit'), () => {
    const replaced = { description: 'Replaced b.', every: '2h', run: SNIPPETS.job('b') };
    const w = mustApply(baseWorld(), { note: NOTE, remove: { jobs: ['b'] }, upsert: { jobs: { b: replaced } } });
    assert.deepEqual(at(w.jobs, 'b'), replaced);
  });

  it('G-51 upsert runs before patch: a patch extends an item upserted in the same edit', cap('applyEdit'), () => {
    const w = mustApply(baseWorld(), { note: NOTE, upsert: { jobs: { c: JOB_C } }, patch: { jobs: { c: { description: 'Patched c.' } } } });
    assert.deepEqual(at(w.jobs, 'c'), { ...JOB_C, description: 'Patched c.' });
  });

  it('G-51 remove, upsert and patch of one key in one edit give upsert merged with patch', cap('applyEdit'), () => {
    const up = { description: 'Upserted a.', every: '2h', run: SNIPPETS.job('a') };
    const w = mustApply(baseWorld(), { note: NOTE, patch: { jobs: { a: { every: '3h' } } }, upsert: { jobs: { a: up } }, remove: { jobs: ['a'] } });
    assert.deepEqual(at(w.jobs, 'a'), { ...up, every: '3h' });
  });

  it('G-51 patch merges into the item: untouched keys and items stay, scalars are replaced', cap('applyEdit'), () => {
    const b = baseWorld();
    const w = mustApply(b, { note: NOTE, patch: { entities: { ticket: { description: 'Patched.', fields: { subject: { maxLength: 200 } } } } } });
    const t = ticketOf(w);
    const bt = ticketOf(baseWorld());
    assert.equal(t.description, 'Patched.');
    assert.equal(t.idPrefix, 'tkt');
    assert.deepEqual(at(t.fields, 'subject'), { ...at(bt.fields, 'subject'), maxLength: 200 });
    assert.deepEqual(Object.keys(t.fields).sort(), Object.keys(bt.fields).sort());
    for (const f of Object.keys(bt.fields).filter((k) => k !== 'subject')) assert.deepEqual(at(t.fields, f), at(bt.fields, f), f);
    const { entities: _we, ...wRest } = w;
    const { entities: _be, ...bRest } = baseWorld();
    void _we;
    void _be;
    assert.deepEqual(wRest, bRest);
    assert.deepEqual(at(w.entities, 'agent'), at(baseWorld().entities, 'agent'));
  });

  it('G-51 merge patch replaces arrays wholesale, never merging by index', cap('applyEdit'), () => {
    const w = mustApply(baseWorld(), {
      note: NOTE,
      patch: {
        routes: { list_tickets: { filters: ['status'] } },
        // The default moves too: a default outside values is field.default_invalid since YOS-70.
        entities: { ticket: { fields: { priority: { values: ['low', 'high'], default: 'low' } } } },
      },
    });
    assert.deepEqual((at(w.routes, 'list_tickets') as { filters: string[] }).filters, ['status']);
    assert.deepEqual((at(ticketOf(w).fields, 'priority') as { values: string[] }).values, ['low', 'high']);
  });

  it('G-51 null in a merge patch deletes the key at any depth, and a null for a missing key adds nothing', cap('applyEdit'), () => {
    const w = mustApply(baseWorld(), {
      note: NOTE,
      patch: {
        entities: { ticket: { fields: { credit: null, status: { transitions: { closed: null } } } } },
        routes: { list_tickets: { description: null } },
      },
    });
    const t = ticketOf(w);
    assert.ok(!('credit' in t.fields), 'credit should be deleted');
    assert.deepEqual((at(t.fields, 'status') as { transitions: unknown }).transitions, { open: ['pending'], pending: ['open', 'closed'] });
    assert.ok(!('description' in at(w.routes, 'list_tickets')), 'a null for a missing key must not create it');
  });

  it('G-51 nulls inside a patch value for a new key are stripped (RFC 7386 MergePatch({}, v))', cap('applyEdit'), () => {
    const w = mustApply(baseWorld(), { note: NOTE, patch: { entities: { ticket: { fields: { flagged: { type: 'bool', default: null } } } } } });
    const flagged = at(ticketOf(w).fields, 'flagged') as Record<string, unknown>;
    assert.equal(flagged['type'], 'bool');
    assert.ok(!('default' in flagged) || flagged['default'] !== null, 'default: null was stored instead of being dropped');
  });

  it('G-51 upsert replaces the whole item, dropping keys the new item omits', cap('applyEdit'), () => {
    const slim = { description: 'Slim agent.', idPrefix: 'agt', fields: { name: field<'string'>({ type: 'string', required: true }) } };
    const w = mustApply(baseWorld(), { note: NOTE, upsert: { entities: { agent: slim } } });
    const a = at(w.entities, 'agent');
    assert.equal(a.description, 'Slim agent.');
    assert.deepEqual(Object.keys(a.fields), ['name']);
  });

  it('G-51 upsert and patch are idempotent', cap('applyEdit'), () => {
    const edit = { note: NOTE, upsert: { jobs: { c: JOB_C } }, patch: { entities: { ticket: { description: 'P.' } }, jobs: { a: { every: '2h' } } } };
    const once = mustApply(baseWorld(), edit);
    const onceCopy = clone(once);
    assert.deepEqual(mustApply(once, edit), onceCopy);
    assert.deepEqual(once, onceCopy, 'the second apply mutated its input');
    const b = baseWorld();
    assert.deepEqual(once, {
      ...b,
      entities: { ...b.entities, ticket: { ...at(b.entities, 'ticket'), description: 'P.' } },
      jobs: { ...b.jobs, a: { ...at(b.jobs, 'a'), every: '2h' }, c: JOB_C },
    });
  });
});

describe('applyEdit judges shape, never semantics (G-52)', () => {
  it('G-52 an edit that breaks references still applies', cap('applyEdit'), () => {
    const w = mustApply(baseWorld(), {
      note: NOTE,
      remove: { entities: ['agent'] },
      upsert: { routes: { get_ghost: { op: 'get', method: 'GET', path: '/ghosts/{id}', entity: 'ghost' } } },
    });
    assert.equal(w.entities['agent'], undefined);
    assert.equal((at(ticketOf(w).fields, 'assignee') as { entity: string }).entity, 'agent');
    assert.equal((at(w.routes, 'get_ghost') as { entity: string }).entity, 'ghost');
  });

  it('G-52 G-07 checkWorld then reports the broken reference at the ref field', cap('applyEdit', 'checkWorld'), () => {
    const w = mustApply(baseWorld(), { note: NOTE, remove: { entities: ['agent'] } });
    const r = checkWorld(w);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reached, 'references');
      const hit = r.issues.some((i) => i.code === 'ref.unknown' && isDeepStrictEqual(i.path.slice(0, 4), ['entities', 'ticket', 'fields', 'assignee']));
      assert.ok(hit, JSON.stringify(r.issues.map((i) => [i.code, i.path])));
    }
  });

  /**
   * `mentions`: a segment one schema.invalid issue must point at, as a path segment or inside
   * `found`, so an engine cannot answer every bad edit with one generic issue.
   */
  const MALFORMED: readonly { readonly label: string; readonly edit: unknown; readonly mentions?: readonly string[] }[] = [
    { label: 'null', edit: null },
    { label: 'array', edit: [] },
    { label: 'string', edit: 'add refunds' },
    { label: 'number', edit: 42 },
    { label: 'no note', edit: { upsert: { jobs: { c: JOB_C } } } },
    { label: 'note is a number', edit: { note: 1 } },
    { label: 'upsert is an array', edit: { note: NOTE, upsert: [] } },
    { label: 'remove value is a string', edit: { note: NOTE, remove: { jobs: 'b' } }, mentions: ['jobs'] },
    { label: 'patch item is null', edit: { note: NOTE, patch: { jobs: { a: null } } }, mentions: ['jobs'] },
    { label: 'patch item is an array', edit: { note: NOTE, patch: { jobs: { a: ['every'] } } }, mentions: ['jobs'] },
    { label: 'upserted job has a bad duration', edit: { note: NOTE, upsert: { jobs: { c: { ...JOB_C, every: 'soon' } } } }, mentions: ['every', 'soon'] },
    { label: 'upserted job has no run', edit: { note: NOTE, upsert: { jobs: { c: { description: 'x', every: '1h' } } } }, mentions: ['run'] },
    { label: 'upserted entity key is not snake_case', edit: { note: NOTE, upsert: { entities: { BadName: at(baseWorld().entities, 'agent') } } }, mentions: ['BadName'] },
    { label: 'remove key is not snake_case', edit: { note: NOTE, remove: { jobs: ['Not Snake'] } }, mentions: ['Not Snake'] },
    { label: 'meta seed is a float', edit: { note: NOTE, meta: { seed: 1.5 } }, mentions: ['seed', '1.5'] },
  ];

  it('G-52 malformed edits (non-objects, no note, bad items) give ok false with catalog issues', cap('applyEdit'), () => {
    const wrong: string[] = [];
    for (const m of MALFORMED) {
      const r = applyEdit(baseWorld(), m.edit);
      if (r.ok) wrong.push(`${m.label}: accepted`);
      else if (r.error.length === 0) wrong.push(`${m.label}: no issues`);
      else {
        wrong.push(...r.error.flatMap(issueProblems).map((p) => `${m.label}: ${p}`));
        // worldEditSchema rejects these, so the catalog code is schema.invalid.
        const schemaIssues = r.error.filter((i) => i.code === 'schema.invalid');
        if (schemaIssues.length === 0) wrong.push(`${m.label}: no schema.invalid issue, got ${r.error.map((i) => i.code).join(', ')}`);
        const mentions = m.mentions;
        if (mentions && !schemaIssues.some((i) => mentions.some((x) => i.path.map(String).includes(x) || String(i.found).includes(x)))) {
          wrong.push(`${m.label}: no schema.invalid issue points at ${mentions.join(' or ')}: ${JSON.stringify(r.error.map((i) => [i.path, i.found]))}`);
        }
      }
    }
    assert.deepEqual(wrong, []);
  });

  /** worldEditSchema is a plain z.object, which strips unknown keys by default (RT-91). */
  const UNKNOWN_KEYS: readonly { readonly label: string; readonly edit: unknown }[] = [
    { label: 'unknown top-level key (a section written outside upsert)', edit: { note: NOTE, jobs: { c: JOB_C } } },
    { label: 'unknown section in upsert', edit: { note: NOTE, upsert: { widgets: { w: {} } } } },
    { label: 'unknown section in patch', edit: { note: NOTE, patch: { widgets: { w: {} } } } },
    { label: 'unknown section in remove', edit: { note: NOTE, remove: { widgets: ['w'] } } },
  ];

  it('G-52 unknown keys and sections in an edit are refused with catalog issues, not silently dropped', opts(cap('applyEdit')), () => {
    const wrong: string[] = [];
    for (const m of UNKNOWN_KEYS) {
      const r = applyEdit(baseWorld(), m.edit);
      if (r.ok) wrong.push(`${m.label}: accepted`);
      else wrong.push(...r.error.flatMap(issueProblems).map((p) => `${m.label}: ${p}`));
    }
    assert.deepEqual(wrong, []);
  });

  it('G-52 removing a key that does not exist is an issue', cap('applyEdit'), () => {
    const r = applyEdit(baseWorld(), { note: NOTE, remove: { jobs: ['nope'] } });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.deepEqual(r.error.flatMap(issueProblems), []);
      assert.ok(r.error.some((i) => i.path.includes('nope') || i.found.includes('nope')), JSON.stringify(r.error));
    }
  });

  it('G-52 a patch on a missing item is an issue, not a silent partial create', opts(cap('applyEdit')), () => {
    const r = applyEdit(baseWorld(), { note: NOTE, patch: { jobs: { ghost: { every: '2h' } } } });
    assert.equal(r.ok, false);
  });
});

// ---------------------------------------------------------------------------------------
// diffWorlds

describe('diffWorlds (G-53)', () => {
  it('G-53 DESTRUCTIVE is exactly the removal and narrowing kinds', () => {
    // Narrowing kinds joined in 8ce7180 (YOS-67): endpoint, enum value, required.
    assert.deepEqual([...DESTRUCTIVE].sort(), [
      'endpoint_changed', 'enum_value_removed', 'field_removed', 'field_required', 'id_prefix_changed', 'item_removed',
      'required_field_added', 'state_removed', 'transition_changed',
    ]);
  });

  it('G-53 identical worlds give an empty delta, and frozen inputs are fine', cap('diffWorlds'), () => {
    assert.deepEqual(diffWorlds(baseWorld(), baseWorld()).changes, []);
    const a = deepFreeze(baseWorld());
    const b = deepFreeze(baseWorld());
    assert.deepEqual(diffWorlds(a, b).changes, []);
    assert.deepEqual(diffWorlds(a, a).changes, []);
  });

  it('G-53 reordering object keys at every depth gives an empty delta', cap('diffWorlds'), () => {
    const reordered = reverseKeys(baseWorld());
    assert.notDeepEqual(Object.keys(reordered.entities), Object.keys(baseWorld().entities));
    assert.deepEqual(diffWorlds(baseWorld(), reordered).changes, []);
    assert.deepEqual(diffWorlds(reordered, baseWorld()).changes, []);
  });

  type DiffRow = {
    readonly note: string;
    readonly destructive: boolean;
    readonly section: Section | 'meta';
    /** null: the key is not asserted (meta). */
    readonly key: string | null;
    readonly pathPrefix: readonly (string | number)[];
    /** A segment the change path must contain, such as the field name. */
    readonly mentions?: string;
    /** Other kinds the same edit may also produce. */
    readonly alsoAllowed?: readonly ChangeKind[];
    mutate(w: World): void;
  };
  const statusOf = (w: World) => at(ticketOf(w).fields, 'status') as { states: string[]; transitions: Record<string, string[]> };

  /** One row per ChangeKind. A new kind fails typecheck here until it gets a row. */
  const DIFF_ROWS: Readonly<Record<ChangeKind, DiffRow>> = {
    item_added: { note: 'add job c', destructive: false, section: 'jobs', key: 'c', pathPrefix: ['jobs', 'c'], mutate: (w) => { w.jobs['c'] = JOB_C; } },
    item_changed: { note: 'reword job b description', destructive: false, section: 'jobs', key: 'b', pathPrefix: ['jobs', 'b'], mutate: (w) => { const b = w.jobs['b']; if (b) b.description = `${b.description} (reworded)`; } },
    item_removed: { note: 'remove job b', destructive: true, section: 'jobs', key: 'b', pathPrefix: ['jobs', 'b'], mutate: (w) => { delete w.jobs['b']; } },
    field_added: {
      note: 'add ticket.channel', destructive: false, section: 'entities', key: 'ticket', pathPrefix: ['entities', 'ticket'], mentions: 'channel',
      mutate: (w) => { ticketOf(w).fields['channel'] = field<'enum'>({ type: 'enum', values: ['email', 'phone'] }); },
    },
    field_removed: {
      note: 'remove ticket.credit', destructive: true, section: 'entities', key: 'ticket', pathPrefix: ['entities', 'ticket'], mentions: 'credit',
      mutate: (w) => { delete ticketOf(w).fields['credit']; },
    },
    field_changed: {
      note: 'subject maxLength 120 -> 200', destructive: false, section: 'entities', key: 'ticket', pathPrefix: ['entities', 'ticket'], mentions: 'subject',
      mutate: (w) => { (at(ticketOf(w).fields, 'subject') as { maxLength?: number }).maxLength = 200; },
    },
    state_removed: {
      note: 'drop the closed state', destructive: true, section: 'entities', key: 'ticket', pathPrefix: ['entities', 'ticket'], mentions: 'status',
      alsoAllowed: ['transition_changed', 'field_changed'],
      mutate: (w) => { const s = statusOf(w); s.states = ['open', 'pending']; s.transitions = { open: ['pending'], pending: ['open'] }; },
    },
    transition_changed: {
      note: 'drop pending -> open', destructive: true, section: 'entities', key: 'ticket', pathPrefix: ['entities', 'ticket'], mentions: 'status',
      alsoAllowed: ['field_changed'],
      mutate: (w) => { statusOf(w).transitions = { open: ['pending'], pending: ['closed'], closed: [] }; },
    },
    field_required: {
      note: 'ticket.credit becomes required', destructive: true, section: 'entities', key: 'ticket', pathPrefix: ['entities', 'ticket'], mentions: 'credit',
      alsoAllowed: ['field_changed'],
      mutate: (w) => { (at(ticketOf(w).fields, 'credit') as { required?: boolean }).required = true; },
    },
    required_field_added: {
      note: 'add required ticket.channel', destructive: true, section: 'entities', key: 'ticket', pathPrefix: ['entities', 'ticket'], mentions: 'channel',
      alsoAllowed: ['field_added'],
      mutate: (w) => { ticketOf(w).fields['channel'] = field<'enum'>({ type: 'enum', required: true, values: ['email', 'phone'] }); },
    },
    enum_value_removed: {
      note: "priority loses 'low'", destructive: true, section: 'entities', key: 'ticket', pathPrefix: ['entities', 'ticket'], mentions: 'priority',
      alsoAllowed: ['field_changed'],
      mutate: (w) => { (at(ticketOf(w).fields, 'priority') as { values: string[] }).values = ['normal', 'high', 'urgent']; },
    },
    transition_added: {
      note: 'add closed -> open', destructive: false, section: 'entities', key: 'ticket', pathPrefix: ['entities', 'ticket'], mentions: 'status',
      alsoAllowed: ['field_changed'],
      mutate: (w) => { statusOf(w).transitions = { open: ['pending'], pending: ['open', 'closed'], closed: ['open'] }; },
    },
    endpoint_changed: {
      note: 'get_agent moves to /agents/by-id/{id}', destructive: true, section: 'routes', key: 'get_agent', pathPrefix: ['routes', 'get_agent'],
      alsoAllowed: ['item_changed'],
      mutate: (w) => { const r = at(w.routes, 'get_agent') as { path: string }; r.path = '/agents/by-id/{id}'; },
    },
    id_prefix_changed: {
      note: 'tkt -> tix', destructive: true, section: 'entities', key: 'ticket', pathPrefix: ['entities', 'ticket'],
      mutate: (w) => { ticketOf(w).idPrefix = 'tix'; },
    },
    snippet_changed: {
      note: 'escalate handler gains a comment', destructive: false, section: 'actions', key: 'escalate', pathPrefix: ['actions', 'escalate'],
      mutate: (w) => { at(w.actions, 'escalate').handler = SNIPPETS.escalate.replace('(ctx) => {', '(ctx) => { // changed'); },
    },
    meta_changed: {
      note: 'meta.description changes', destructive: false, section: 'meta', key: null, pathPrefix: ['meta'],
      mutate: (w) => { w.meta.description = 'A different description.'; },
    },
  };

  for (const [kind, row] of Object.entries(DIFF_ROWS) as [ChangeKind, DiffRow][]) {
    it(`G-53 ${kind} (${row.note}) is ${row.destructive ? '' : 'not '}destructive`, cap('diffWorlds'), () => {
      assert.equal(DESTRUCTIVE.has(kind), row.destructive);
      const after = baseWorld();
      row.mutate(after);
      const changes = diffWorlds(baseWorld(), after).changes;
      const hit = changes.find(
        (c) => c.kind === kind && c.section === row.section && (row.key === null || c.key === row.key) &&
          isDeepStrictEqual(c.path.slice(0, row.pathPrefix.length), [...row.pathPrefix]) &&
          (row.mentions === undefined || c.path.includes(row.mentions)),
      );
      assert.ok(hit, `no ${kind} change in ${JSON.stringify(changes)}`);
      assert.equal(changes.filter((c) => c.kind === kind).length, 1, `one edit, one ${kind}: ${JSON.stringify(changes)}`);
      const allowed: readonly ChangeKind[] = [kind, ...(row.alsoAllowed ?? [])];
      const unrelated = changes.filter(
        (c) => !allowed.includes(c.kind) || c.section !== row.section || (row.key !== null && c.key !== row.key) ||
          !isDeepStrictEqual(c.path.slice(0, row.pathPrefix.length), [...row.pathPrefix]),
      );
      assert.deepEqual(unrelated.map((c) => [c.kind, c.section, c.key, c.path]), [], 'unrelated changes reported');
      // A diff reads its inputs only.
      const fresh = baseWorld();
      row.mutate(fresh);
      assert.deepEqual(after, fresh, 'diffWorlds changed its after argument');
    });
  }

  it('G-53 a snippet change inside a task decoy is snippet_changed on that task', cap('diffWorlds'), () => {
    const after = baseWorld();
    const d = at(after.tasks, 'pend_open_urgent').decoys[0];
    assert.ok(d);
    d.script = `${d.script} `;
    const changes = diffWorlds(baseWorld(), after).changes;
    assert.ok(changes.some((c) => c.kind === 'snippet_changed' && c.section === 'tasks' && c.key === 'pend_open_urgent'), JSON.stringify(changes));
    assert.ok(changes.every((c) => !DESTRUCTIVE.has(c.kind)), JSON.stringify(changes));
    assert.ok(changes.every((c) => c.section === 'tasks' && c.key === 'pend_open_urgent'), `changes outside the edited task: ${JSON.stringify(changes)}`);
  });

  it('G-53 diffs are directional: a removal one way is an addition the other way', cap('diffWorlds'), () => {
    const smaller = baseWorld();
    delete smaller.jobs['b'];
    delete ticketOf(smaller).fields['credit'];
    const rows = (w1: World, w2: World): string[] => diffWorlds(w1, w2).changes.map((c) => `${c.kind} ${c.section} ${c.key}`).sort();
    assert.deepEqual(rows(baseWorld(), smaller), ['field_removed entities ticket', 'item_removed jobs b']);
    assert.deepEqual(rows(smaller, baseWorld()), ['field_added entities ticket', 'item_added jobs b']);
  });

  it('G-53 adding a state with new transitions out of it (add refunds) is not destructive', opts(cap('diffWorlds')), () => {
    const after = baseWorld();
    const s = statusOf(after);
    s.states = [...s.states, 'refunded'];
    s.transitions = { ...s.transitions, closed: ['refunded'], refunded: [] };
    const changes = diffWorlds(baseWorld(), after).changes;
    assert.ok(changes.length > 0);
    assert.deepEqual(changes.filter((c) => DESTRUCTIVE.has(c.kind)).map((c) => [c.kind, c.path]), []);
  });
});

// ---------------------------------------------------------------------------------------
// saveWorld and loadWorld

const tmpDirs: string[] = [];
async function tmp(prefix: string): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), `redteam-${prefix}-`));
  tmpDirs.push(d);
  return d;
}
after(async () => {
  await Promise.all(tmpDirs.map((d) => rm(d, { recursive: true, force: true })));
});

/** Every snippet in a world, by readable path. */
function snippets(w: World): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, a] of Object.entries(w.actions)) out.set(`actions.${k}.handler`, a.handler);
  for (const [k, j] of Object.entries(w.jobs)) out.set(`jobs.${k}.run`, j.run);
  for (const [k, s] of Object.entries(w.seed)) out.set(`seed.${k}`, s);
  for (const [k, t] of Object.entries(w.tests)) out.set(`tests.${k}.script`, t.script);
  for (const [k, t] of Object.entries(w.tasks)) {
    // A bare task (the public form of a world, YOS-159) carries no snippet source.
    if (t.grader !== undefined) out.set(`tasks.${k}.grader`, t.grader);
    if (t.solution !== undefined) out.set(`tasks.${k}.solution`, t.solution);
    t.decoys.forEach((d, i) => out.set(`tasks.${k}.decoys.${i}.script`, d.script));
  }
  return out;
}

function mustCheck(label: string, w: unknown): CheckedWorld {
  const r = checkWorld(w);
  if (!r.ok) throw new assert.AssertionError({ message: `${label} does not check (reached ${r.reached}): ${JSON.stringify(r.issues.map((i) => [i.code, i.path, i.found]))}` });
  return r.world;
}

/** save, load, check, and compare snippets byte for byte, then the whole world. */
async function roundTrip(label: string, w: World): Promise<void> {
  const checked = mustCheck(label, w);
  const dir = await tmp('save');
  await saveWorld(dir, checked);
  // Load from a copy of the file in another dir, so only the bytes on disk carry the world.
  const copyDir = await tmp('load');
  await writeFile(join(copyDir, 'world.yaml'), await readFile(join(dir, 'world.yaml')));
  const loaded = await loadWorld(copyDir);
  assert.equal(loaded.ok, true, loaded.ok ? '' : JSON.stringify(loaded.error));
  if (!loaded.ok) return;
  const again = mustCheck(`${label} after save and load`, loaded.value);
  const before = snippets(checked);
  const afterLoad = snippets(again);
  const diffs = [...before].filter(([k, v]) => afterLoad.get(k) !== v).map(([k, v]) => `${k}: saved ${JSON.stringify(v)} loaded ${JSON.stringify(afterLoad.get(k))}`);
  assert.deepEqual(diffs, [], 'snippets changed in the round trip');
  assert.deepEqual(JSON.parse(JSON.stringify(again)), JSON.parse(JSON.stringify(checked)));
}

const NASTY_COMMENT = ['\t/*', '---', '...', '# not a yaml comment', 'key: value', '- item', '? complex', '%YAML 1.2', '&anchor *alias !tag', '*/   '].join('\n');

/** Base world whose snippets stress YAML block scalars. Behaviour is unchanged: only comments, whitespace and unused consts. */
function nastyWorld(): World {
  const w = baseWorld();
  at(w.actions, 'escalate').handler = '  ' + SNIPPETS.escalate.replace('(ctx) => {', `(ctx) => {\n${NASTY_COMMENT}\n\tconst label = 'café ✓ 日本語 😀 \\t #';   `);
  at(w.jobs, 'a').run = `${SNIPPETS.job('a')}\n`;
  at(w.jobs, 'a_late').run = `${SNIPPETS.job('a_late')}\n\n\n`;
  at(w.jobs, 'b').run = `\n${SNIPPETS.job('b')}`;
  w.seed['job_run'] = '(ctx) => []   ';
  at(w.tests, 'escalate_ok').script = SNIPPETS.testEscalateOk.replace(/^ {2}/gm, '\t');
  // The comment sits inside the body: a comment outside the function expression is a compile error
  // (research/spec-calls/engine-sandbox.md). The trailing newline and spaces stay outside it.
  at(w.tasks, 'pend_hd1005').grader = `${SNIPPETS.easyGrader.replace(/\}$/, '  // end #\n}')}\n  `;
  at(w.tasks, 'pend_hd1005').solution = `\n\n${SNIPPETS.easySolution}\n`;
  return w;
}

/** Base world whose plain strings a YAML 1.1 reader would coerce, or that need quoting. */
function coercibleWorld(): World {
  const w = baseWorld();
  at(w.entities, 'agent').description = 'yes';
  at(w.entities, 'ticket').description = 'null';
  at(w.entities, 'job_run').description = '1e3';
  at(w.jobs, 'a').description = 'no';
  at(w.jobs, 'a_late').description = '2026-01-05';
  at(w.jobs, 'b').description = '0x1F';
  w.meta.description = '~';
  w.meta.resembles = 'on';
  at(w.tests, 'escalate_ok').description = '- starts like a list item';
  at(w.tests, 'escalate_atomic').description = ': starts with a colon';
  at(w.tests, 'illegal_transition').description = '# starts like a comment';
  at(w.routes, 'list_tickets').description = '';
  at(w.routes, 'get_ticket').description = '@ starts with an at sign';
  at(w.routes, 'list_agents').description = "  leading spaces, trailing tab\t";
  at(w.tasks, 'pend_open_urgent').instruction = `Move every "open" ticket with 'urgent' priority to pending: all of them.`;
  const d = at(w.tasks, 'escalate_unassigned').decoys[1];
  if (d) d.why = 'line one\nline two, with a trailing space ';
  (at(ticketOf(w).fields, 'subject') as { description?: string }).description = 'false';
  return w;
}

describe('saveWorld and loadWorld round trip (G-54)', () => {
  const caps = cap('checkWorld', 'saveWorld', 'loadWorld');

  it('G-54 the base world round-trips', caps, async () => {
    await roundTrip('base world', baseWorld());
  });

  it('G-54 snippets with ---, #, tabs, unicode, trailing spaces and missing or extra final newlines round-trip byte for byte', caps, async () => {
    await roundTrip('nasty snippets', nastyWorld());
  });

  it('G-54 control characters and U+2028 inside snippet strings round-trip byte for byte', caps, async () => {
    const w = baseWorld();
    at(w.tasks, 'pend_hd1005').decoys = [
      { why: 'moves the first ticket on page 1 instead of HD-1005', script: SNIPPETS.easyDecoyWrongTicket.replace('(ctx) => {', "(ctx) => {\n  const odd = '  \u0007\u001b ﻿';") },
    ];
    await roundTrip('control characters', w);
  });

  it('G-54 saveWorld writes snippets as YAML block scalars, so each snippet line is a line of the file (index.ts saveWorld)', cap('checkWorld', 'saveWorld'), async () => {
    const dir = await tmp('block');
    await saveWorld(dir, mustCheck('base world', baseWorld()));
    const text = await readFile(join(dir, 'world.yaml'), 'utf8');
    // Short lines from the fixture snippets, so a folding writer keeps them whole.
    const lines = [
      "const t = ctx.db.get('ticket', ctx.params.id);",
      "if (!t) ctx.fail(404, 'not_found', 'ticket not found');",
      "ctx.assert(r.status === 200, 'patch returned ' + r.status);",
    ];
    const escape = (x: string): string => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const missing = lines.filter((l) => !new RegExp(`^[ \\t]+${escape(l)}[ \\t]*$`, 'm').test(text));
    assert.deepEqual(missing, [], `snippet lines not written as block scalar lines:\n${text.slice(0, 1500)}`);
  });

  it('G-54 strings YAML might coerce (yes, null, 1e3, dates, ~) or must quote stay byte-identical strings', caps, async () => {
    await roundTrip('coercible strings', coercibleWorld());
  });

  it('G-54 saveWorld is deterministic and a fixpoint: save, load, check, save gives the same bytes', opts(caps), async () => {
    const checked = mustCheck('nasty snippets', nastyWorld());
    const [d1, d2, d3] = [await tmp('fix1'), await tmp('fix2'), await tmp('fix3')];
    await saveWorld(d1, checked);
    await saveWorld(d2, checked);
    const bytes1 = await readFile(join(d1, 'world.yaml'));
    assert.ok(bytes1.equals(await readFile(join(d2, 'world.yaml'))), 'two saves of one world differ');
    const loaded = await loadWorld(d1);
    assert.ok(loaded.ok);
    if (!loaded.ok) return;
    await saveWorld(d3, mustCheck('reloaded', loaded.value));
    assert.ok(bytes1.equals(await readFile(join(d3, 'world.yaml'))), 'save -> load -> save is not a fixpoint');
  });
});

describe('loadWorld (G-55)', () => {
  it('G-55 a JSON world.yaml loads to the same object, unchecked', cap('loadWorld'), async () => {
    const dir = await writeWorldDir(baseWorld());
    tmpDirs.push(dir);
    const r = await loadWorld(dir);
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual(r.value, baseWorld());
  });

  it('G-55 block scalars load with YAML chomping rules', cap('loadWorld'), async () => {
    const dir = await tmp('yaml');
    const text = ['format: 1', 'clip: |', '  (ctx) => {', '    return 1;', '  }', 'keep: |+', '  a', '', 'strip: |-', '  b', 'indented: |2', '    two leading spaces', ''].join('\n');
    await writeFile(join(dir, 'world.yaml'), text);
    const r = await loadWorld(dir);
    assert.equal(r.ok, true, r.ok ? '' : JSON.stringify(r.error));
    if (r.ok) assert.deepEqual(r.value, { format: 1, clip: '(ctx) => {\n  return 1;\n}\n', keep: 'a\n\n', strip: 'b', indented: '  two leading spaces\n' });
  });

  const BAD: readonly { readonly label: string; readonly todo?: `RT-${string}`; setup(dir: string): Promise<string> }[] = [
    { label: 'missing dir', setup: async (dir) => join(dir, 'does-not-exist') },
    { label: 'dir without world.yaml', setup: async (dir) => dir },
    {
      label: 'world.yaml is a directory',
      setup: async (dir) => {
        await mkdir(join(dir, 'world.yaml'));
        return dir;
      },
    },
    {
      label: 'unclosed flow sequence',
      setup: async (dir) => {
        await writeFile(join(dir, 'world.yaml'), 'format: 1\nmeta: [unclosed\n');
        return dir;
      },
    },
    {
      label: 'tab indentation',
      setup: async (dir) => {
        await writeFile(join(dir, 'world.yaml'), 'format: 1\nmeta:\n\tname: x\n');
        return dir;
      },
    },
    {
      label: 'duplicate keys',
      setup: async (dir) => {
        await writeFile(join(dir, 'world.yaml'), 'format: 1\nformat: 2\n');
        return dir;
      },
    },
    {
      label: 'two documents',
      setup: async (dir) => {
        await writeFile(join(dir, 'world.yaml'), 'format: 1\n---\nformat: 2\n');
        return dir;
      },
    },
  ];

  async function badLoadProblems(b: (typeof BAD)[number]): Promise<string[]> {
    const dir = await b.setup(await tmp('bad'));
    const r = await loadWorld(dir);
    if (r.ok) return [`${b.label}: loaded ${JSON.stringify(r.value).slice(0, 200)}`];
    if (r.error.length === 0) return [`${b.label}: no issues`];
    return r.error.flatMap(issueProblems).map((p) => `${b.label}: ${p}`);
  }

  it('G-55 loadWorld returns ok false with catalog issues and never throws on a missing dir or bad YAML', cap('loadWorld'), async () => {
    const wrong: string[] = [];
    for (const b of BAD.filter((x) => !x.todo)) wrong.push(...(await badLoadProblems(b)));
    assert.deepEqual(wrong, []);
  });

  for (const b of BAD.filter((x) => x.todo)) {
    it(`G-55 loadWorld refuses ${b.label}`, opts(cap('loadWorld'), todo(b.todo ?? 'RT-?')), async () => {
      assert.deepEqual(await badLoadProblems(b), []);
    });
  }

  it('G-55 odd files (empty, binary, alias-heavy) give a Result and never throw', cap('loadWorld'), async () => {
    const levels = ['a: &a ["x","x","x","x","x","x","x","x","x","x"]'];
    for (const [prev, cur] of [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e']] as const) levels.push(`${cur}: &${cur} [${Array.from({ length: 10 }, () => `*${prev}`).join(',')}]`);
    const files: readonly { readonly label: string; readonly bytes: string | Buffer }[] = [
      { label: 'empty file', bytes: '' },
      { label: 'only a comment', bytes: '# nothing here\n' },
      { label: 'binary', bytes: Buffer.from([0xff, 0xfe, 0x00, 0x01, 0x80, 0x0a]) },
      { label: 'scalar document', bytes: '42\n' },
      { label: 'alias fan-out', bytes: `${levels.join('\n')}\n` },
    ];
    for (const f of files) {
      const dir = await tmp('odd');
      await writeFile(join(dir, 'world.yaml'), f.bytes);
      const r = await loadWorld(dir);
      assert.equal(typeof r.ok, 'boolean', f.label);
      if (!r.ok) assert.deepEqual(r.error.flatMap(issueProblems), [], f.label);
    }
  });
});
