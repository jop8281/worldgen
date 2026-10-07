import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { before, describe, it } from 'node:test';
import { loadWorld, worldSchema, type World } from '#engine';
import { emptyWorld } from '#engine';
import { FIDELITY_FLOOR, fidelityGate, fidelityScore, parseFidelityReference, type FidelityReference } from '../src/worldgen/fidelity.ts';
import {
  fidelityCell,
  parseSuite,
  renderSummary,
  type CaseRecord,
  type FidelityResult,
} from '../src/worldgen/eval.ts';

const REPO_DIR = path.resolve(import.meta.dirname, '..', '..');
const reference = (id: string): FidelityReference => {
  const r = parseFidelityReference(readFileSync(path.join(REPO_DIR, 'eval', 'fidelity', `${id}.yaml`), 'utf8'));
  assert.ok(r.ok, r.ok ? '' : r.errors.join('\n'));
  return r.reference;
};
let base: World;
before(async () => {
  const loaded = await loadWorld(path.join(REPO_DIR, 'prod', 'worlds', 'helpdesk'));
  assert.ok(loaded.ok);
  base = worldSchema.parse(loaded.value);
});
const helpdesk = (): World => structuredClone(base);
/** Field definitions with the engine's defaults filled in, parsed from the shorthand a test writes. */
const fieldsOf = (fields: Record<string, unknown>): World['entities'][string]['fields'] =>
  worldSchema.parse({ ...rawTiny, entities: { t: { description: 'd', idPrefix: 'tt', fields } } }).entities['t']!.fields;
const rawTiny = {
  format: 1,
  meta: { name: 'tiny', description: 'x', resembles: 'Linear', source: 'worldgen', seed: 1, clock: { start: '2026-01-01T00:00:00.000Z' } },
  entities: {},
  routes: {},
  actions: {},
  jobs: {},
  fixtures: {},
  seed: {},
  tests: {},
  tasks: {},
};

describe('fidelity references', () => {
  it('every case with a reference exists in the suite and parses', () => {
    const suite = parseSuite(readFileSync(path.join(REPO_DIR, 'eval', 'suite.yaml'), 'utf8'));
    assert.ok(suite.ok);
    const ids = suite.suite.cases.map((c) => c.id);
    for (const id of ['helpdesk-sla', 'retail-tau2-known', 'linear-description']) {
      assert.ok(ids.includes(id), id);
      assert.equal(reference(id).case, id);
    }
  });

  it('every reference lists at least two error cases and a state set', () => {
    for (const id of ['helpdesk-sla', 'retail-tau2-known', 'linear-description']) {
      assert.ok(reference(id).errors.length >= 2, id);
      assert.ok(reference(id).stateSets.length >= 1, id);
    }
  });
});

describe('fidelityScore on the helpdesk world', () => {
  it('scores prod/worlds/helpdesk 68 of 71 and names the three misses', () => {
    const f = fidelityScore(reference('helpdesk-sla'), helpdesk());
    assert.equal(f.score, 0.9577);
    assert.equal(f.earned, 68);
    // 71 = entities and fields 43 + states 7 + transitions 3 + routes 15 + errors 3
    assert.equal(f.total, 71);
    assert.deepEqual(
      f.misses.map((m) => [m.kind, m.path, m.weight]),
      [
        ['field.missing', 'ticket.type', 1],
        ['state.missing', 'ticket.status.hold', 1],
        ['route.missing', 'GET /search', 1],
      ],
    );
  });

  it('drops by the literal weight of a removed entity, 2 for it and 4 for its fields', () => {
    const w = helpdesk();
    delete w.entities['oncall_shift'];
    const f = fidelityScore(reference('helpdesk-sla'), w);
    assert.equal(f.score, 0.8732);
    assert.equal(f.total - f.earned, 9);
    assert.deepEqual(f.misses.find((m) => m.kind === 'entity.missing'), {
      kind: 'entity.missing',
      path: 'oncall_shift',
      weight: 6,
      detail: 'no entity named oncall_shift or oncall, shift, on_call_schedule',
    });
  });

  it('matches an entity and a field by synonym', () => {
    const w = helpdesk();
    const ent = w.entities['sla_policy']!;
    delete w.entities['sla_policy'];
    w.entities['sla'] = ent;
    const fields = ent.fields;
    fields['target_minutes'] = fields['resolution_minutes']!;
    delete fields['resolution_minutes'];
    assert.equal(fidelityScore(reference('helpdesk-sla'), w).score, 0.9577);
  });

  it('reports a field of the wrong type and withholds its weight', () => {
    const w = helpdesk();
    w.entities['ticket']!.fields['subject'] = fieldsOf({ f: { type: 'int' } })['f']!;
    const f = fidelityScore(reference('helpdesk-sla'), w);
    assert.equal(f.score, 0.9296);
    const m = f.misses.find((x) => x.kind === 'field.type_mismatch');
    assert.deepEqual(m, { kind: 'field.type_mismatch', path: 'ticket.subject', weight: 2, detail: 'ticket.subject is int, the real field is string or text' });
  });

  it('flags a machine stricter than the real one, with the forbidden moves', () => {
    const w = helpdesk();
    const status = w.entities['ticket']!.fields['status']!;
    assert.equal(status.type, 'state');
    if (status.type !== 'state') return;
    status.transitions['resolved'] = ['closed'];
    status.transitions['open'] = ['pending', 'escalated'];
    const f = fidelityScore(reference('helpdesk-sla'), w);
    assert.equal(f.score, 0.9155);
    const m = f.misses.find((x) => x.kind === 'transitions.stricter_than_real');
    assert.deepEqual(m, { kind: 'transitions.stricter_than_real', path: 'ticket.status', weight: 3, detail: 'the world forbids open -> resolved, resolved -> open' });
  });

  it('an enum stands in for states and is never stricter', () => {
    const w = helpdesk();
    w.entities['ticket']!.fields['status'] = fieldsOf({ f: { type: 'enum', values: ['new', 'open', 'pending', 'escalated', 'resolved', 'closed'] } })['f']!;
    const f = fidelityScore(reference('helpdesk-sla'), w);
    assert.equal(f.misses.some((m) => m.kind === 'transitions.stricter_than_real'), false);
    // The "closed ticket back to open" error needs a state field, so its weight 1 is lost.
    assert.equal(f.score, 0.9437);
  });

  it('removing a route loses exactly its weight', () => {
    const w = helpdesk();
    delete w.routes['list_tickets'];
    const f = fidelityScore(reference('helpdesk-sla'), w);
    assert.equal(f.score, 0.9296);
    assert.equal(f.misses.find((m) => m.kind === 'route.missing' && m.path === 'GET /tickets')?.weight, 2);
  });
});

describe('fidelityScore on small worlds', () => {
  const tiny = (statuses: Record<string, string[]>, initial = 'backlog'): World =>
    worldSchema.parse({
      ...rawTiny,
      entities: {
        issue: {
          description: 'd',
          idPrefix: 'iss',
          fields: { title: { type: 'string' }, status: { type: 'state', states: Object.keys(statuses), initial, transitions: statuses } },
        },
      },
      routes: { list: { op: 'list', method: 'GET', path: '/issues', entity: 'issue' } },
    });
  const all = { backlog: ['unstarted', 'started', 'completed', 'canceled'], unstarted: ['backlog', 'started', 'completed', 'canceled'], started: ['backlog', 'unstarted', 'completed', 'canceled'], completed: ['backlog', 'unstarted', 'started', 'canceled'], canceled: ['backlog', 'unstarted', 'started', 'completed'] };

  it('the closed-to-open error item is lost when the world allows that move', () => {
    const w = helpdesk();
    const status = w.entities['ticket']!.fields['status'] as { transitions: Record<string, string[]> };
    status.transitions['closed'] = ['open'];
    const f = fidelityScore(reference('helpdesk-sla'), w);
    assert.equal(f.earned, 67);
    assert.ok(f.misses.some((m) => m.path === 'error 422: move a closed ticket back to open' && m.weight === 1));
  });

  it('any-to-any reference: full machine earns the transitions item, a linear flow loses it', () => {
    const ref = reference('linear-description');
    const open = fidelityScore(ref, tiny(all));
    const strict = fidelityScore(ref, tiny({ backlog: ['unstarted'], unstarted: ['started'], started: ['completed', 'canceled'], completed: [], canceled: [] }));
    assert.equal(open.misses.some((m) => m.kind === 'transitions.stricter_than_real'), false);
    assert.equal(strict.misses.filter((m) => m.kind === 'transitions.stricter_than_real').length, 1);
    assert.equal(open.earned - strict.earned, 4);
    // 82 = entities and fields 58 + states 5 + transitions 4 + routes 13 + errors 2
    assert.equal(open.total, 82);
    assert.equal(open.earned, 17);
    assert.equal(open.score, 0.2073);
  });

  it('Linear earns the five states and the moves from an enum workflow_state.type with a ref on issue', () => {
    const w = worldSchema.parse({
      ...rawTiny,
      entities: {
        workflow_state: {
          description: 'd',
          idPrefix: 'ws',
          fields: { name: { type: 'string' }, type: { type: 'enum', values: ['backlog', 'unstarted', 'started', 'completed', 'canceled'] } },
        },
        issue: { description: 'd', idPrefix: 'iss', fields: { title: { type: 'string' }, state_id: { type: 'ref', entity: 'workflow_state' } } },
      },
    });
    const f = fidelityScore(reference('linear-description'), w);
    assert.equal(f.earned, 22);
    assert.equal(f.total, 82);
    assert.equal(f.misses.some((m) => m.kind === 'state.missing' && m.path.startsWith('workflow_state.type')), false);
  });

  it('a state field matching one reference state loses the transitions weight as state.missing', () => {
    const f = fidelityScore(reference('linear-description'), tiny({ backlog: ['zzz'], zzz: ['backlog'] }));
    assert.equal(f.earned, 9);
    assert.deepEqual(f.misses.find((m) => m.path === 'workflow_state.type.transitions'), {
      kind: 'state.missing',
      path: 'workflow_state.type.transitions',
      weight: 4,
      detail: 'fewer than two real states match, so moves cannot be compared',
    });
  });

  it('a state field matching no reference state loses the transitions weight too', () => {
    const f = fidelityScore(reference('linear-description'), tiny({ aaa: ['bbb'], bbb: ['aaa'] }, 'aaa'));
    assert.equal(f.earned, 8);
    assert.equal(f.misses.filter((m) => m.kind === 'state.missing').length, 6);
    assert.ok(f.misses.some((m) => m.path === 'workflow_state.type.transitions'));
  });

  it('binds the issue reference to an entity named issue even when a ticket entity comes first', () => {
    const w = worldSchema.parse({
      ...rawTiny,
      entities: {
        ticket: { description: 'd', idPrefix: 'tk', fields: { note: { type: 'string' } } },
        issue: { description: 'd', idPrefix: 'iss', fields: { title: { type: 'string' } } },
      },
    });
    const f = fidelityScore(reference('linear-description'), w);
    assert.equal(f.misses.some((m) => m.path === 'issue.title'), false);
    assert.equal(f.misses.some((m) => m.path === 'issue.description'), true);
  });

  it('an empty world scores 0 and lists a miss for every entity', () => {
    const w = tiny({ backlog: ['started'], started: [] });
    w.entities = {};
    w.routes = {};
    const f = fidelityScore(reference('retail-tau2-known'), w);
    assert.equal(f.score, 0);
    assert.equal(f.misses.filter((m) => m.kind === 'entity.missing').length, 7);
  });

  it('a retail cancellation route earns the route item and the cancel error item through its synonym', () => {
    const w = tiny({ backlog: ['started'], started: [] });
    w.entities = {};
    w.routes = { cancel: { ...w.routes['list']!, method: 'POST', path: '/orders/{order_id}/cancellation' } };
    const f = fidelityScore(reference('retail-tau2-known'), w);
    assert.equal(f.earned, 4);
    // 74 = entities and fields 40 + states 12 + transitions 4 + routes 13 + errors 5
    assert.equal(f.total, 74);
    assert.equal(f.misses.some((m) => m.path === 'POST /orders/{id}/cancel'), false);
    assert.equal(f.misses.some((m) => m.path === 'error 409: cancel an order that is not pending'), false);
  });
});

describe('reference parsing', () => {
  const valid = {
    case: 'x',
    source: 's',
    entities: [{ name: 'a', weight: 1, fields: [{ name: 'f', types: ['string'], weight: 1 }] }],
    stateSets: [{ entity: 'a', field: 'f', states: [{ name: 's1', weight: 1 }, { name: 's2', weight: 1 }], transitions: { weight: 1, anyToAny: true } }],
    routes: [{ method: 'GET', path: '/a/{id}', weight: 1 }],
    errors: [
      { case: 'e1', status: 404, via: { kind: 'route', method: 'get', path: '/a/{x}' }, weight: 1 },
      { case: 'e2', status: 409, via: { kind: 'state', entity: 'a', field: 'f', from: 's1', to: 's2' }, weight: 1 },
    ],
  };
  const errorsOf = (edit: (r: typeof valid) => void): readonly string[] => {
    const r = structuredClone(valid);
    edit(r);
    const parsed = parseFidelityReference(JSON.stringify(r));
    assert.equal(parsed.ok, false);
    return parsed.ok ? [] : parsed.errors;
  };

  it('rejects an unknown key', () => {
    assert.deepEqual(errorsOf((r) => void ((r as Record<string, unknown>).bogus = 1)), ['(root): Unrecognized key: "bogus"']);
  });

  it('rejects a state error whose from or to is not a declared state', () => {
    assert.deepEqual(errorsOf((r) => void ((r.errors[1]!.via as { to: string }).to = 'nope')), ['errors.1.via: nope is not a state of a.f']);
  });

  it('accepts the minimal reference', () => {
    assert.equal(parseFidelityReference(JSON.stringify(valid)).ok, true);
  });
  it('rejects a type that is not an engine field type', () => {
    assert.deepEqual(errorsOf((r) => void (r.entities[0]!.fields[0]!.types = ['boolean'])), ['entities.0.fields.0.types.0: not an engine field type']);
  });
  it('rejects a via route that is not in routes', () => {
    assert.deepEqual(errorsOf((r) => void (r.errors[0]!.via = { kind: 'route', method: 'GET', path: '/nope' } as never)), ['errors.0.via: no route GET /nope in routes']);
  });
  it('rejects a state set on an unknown entity', () => {
    assert.deepEqual(errorsOf((r) => void (r.stateSets[0]!.entity = 'ghost')), [
      'stateSets.0.entity: no reference entity named ghost',
      'errors.1.via: no state set a.f in stateSets',
    ]);
  });
  it('rejects synonyms that collide across two entities', () => {
    assert.deepEqual(
      errorsOf((r) => void r.entities.push({ name: 'b', synonyms: ['A'], weight: 1, fields: [] } as never)),
      ['entities.1.name: entity name "a" is also used by a'],
    );
  });
  it('rejects a duplicate route', () => {
    assert.deepEqual(errorsOf((r) => void r.routes.push({ method: 'get', path: '/a/{other}/', weight: 1 })), ['routes.1: duplicate route GET /a/{}']);
  });
  it('rejects a single error case', () => {
    assert.deepEqual(errorsOf((r) => void r.errors.pop()), ['errors: Too small: expected array to have >=2 items']);
  });
});

describe('summary.md fidelity', () => {
  const result: FidelityResult = {
    kind: 'scored',
    fidelity: {
      score: 0.9577,
      earned: 68,
      total: 71,
      misses: [
        { kind: 'field.missing', path: 'ticket.type', weight: 1, detail: 'ticket has no field named type' },
        { kind: 'route.missing', path: 'GET /search', weight: 1, detail: 'no route or action for GET /search' },
      ],
    },
  };
  const rec = (id: string, fidelity?: FidelityResult): CaseRecord => ({
    id,
    expect: 'done',
    phases: [{ phase: 'create', result: 'stopped', error: null, log: { events: [], problems: [] } }],
    verify: { kind: 'not_run' },
    ...(fidelity === undefined ? {} : { fidelity }),
  });
  const meta = { run: 'r', suite: 's', model: 'm', budgetUsd: 1, maxMinutes: 1 };

  it('formats the cell from the integers, floored, with the weights', () => {
    assert.equal(fidelityCell(result), '0.957 (68/71)');
    assert.equal(fidelityCell({ kind: 'scored', fidelity: { score: 0.7995, earned: 1599, total: 2000, misses: [] } }), '0.799 (1599/2000)');
    assert.equal(fidelityCell({ kind: 'no_world', why: 'last phase did not finish' }), 'no world: last phase did not finish');
    assert.equal(fidelityCell(null), '-');
  });

  it('adds the column and the misses section, with - for a case without a reference', () => {
    const lines = renderSummary(meta, [{ kind: 'record', record: rec('a', result) }, { kind: 'record', record: rec('b', { kind: 'no_world', why: 'last phase did not finish' }) }, { kind: 'record', record: rec('c') }]).split('\n');
    assert.equal(lines[4], '| case | expect | result | stop reason | attempts per step | min | $ | verify | fidelity | log | pass |');
    assert.ok(lines[6]!.includes('| 0.957 (68/71) | '));
    assert.ok(lines[7]!.includes('| no world: last phase did not finish | '));
    assert.ok(lines[8]!.includes('| - | '));
    const i = lines.indexOf('## Fidelity misses');
    assert.deepEqual(lines.slice(i, i + 6), [
      '## Fidelity misses',
      '',
      '- `a` field.missing ticket.type (1): ticket has no field named type',
      '- `a` route.missing GET /search (1): no route or action for GET /search',
      '- `a` missed 3 of 71',
      '',
    ]);
  });

  it('leaves the table as before when no case has a reference', () => {
    const text = renderSummary(meta, [{ kind: 'record', record: rec('a') }]);
    assert.equal(text.split('\n')[4], '| case | expect | result | stop reason | attempts per step | min | $ | verify | log | pass |');
    assert.equal(text.includes('Fidelity misses'), false);
  });
});

describe('fidelityGate: the last step\'s floor for a description that names a reference (A-258)', () => {
  it('passes the golden helpdesk against helpdesk-sla, which scores above the 0.80 floor', () => {
    assert.equal(FIDELITY_FLOOR, 0.8);
    assert.equal(fidelityScore(reference('helpdesk-sla'), helpdesk()).score, 0.9577);
    assert.deepEqual(fidelityGate(reference('helpdesk-sla'), helpdesk()), []);
  });

  it('refuses an empty world with one issue per miss, heaviest first, rooted at the section that builds it', () => {
    const issues = fidelityGate(reference('helpdesk-sla'), worldSchema.parse(emptyWorld('tiny', 'hand')));
    assert.equal(issues.length, 28);
    assert.deepEqual(issues.map((i) => i.code).filter((c) => c !== 'fidelity.below_floor'), []);
    assert.deepEqual([issues[0]?.path, issues[0]?.found], [['entities'], 'no entity named ticket or issue, case, request']);
    assert.equal(issues[0]?.expected, "the real software's entity.missing ticket: fidelity to the frozen reference is 0, below the floor of 0.8");
    assert.equal(issues.filter((i) => i.path[0] === 'routes').length, 13);
    assert.equal(issues.find((i) => i.path[0] === 'routes')?.found, 'no route or action for GET /tickets');
  });
});
