import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkWorld, diffWorlds, worldEditSchema, type CheckIssue, type CheckedWorld, type World, type WorldEdit } from '#engine';
import { preservationIssues, unplannedChanges } from '../src/worldgen/judge.ts';
import type { Plan } from '../src/worldgen/plan.ts';
import { minimalWorld, type Overrides } from './helpers/world.ts';

function planWith(changes: readonly string[]): Plan {
  return {
    revision: 1,
    software: 'Zendesk-style helpdesk',
    clock: { start: '2026-01-05T09:00:00.000Z', tick: '0s' },
    summary: 'Tickets for a few customers.',
    verdict: { kind: 'proceed' },
    entities: [{ name: 'ticket', purpose: 'a support request', keyFields: ['status'] }],
    workflows: [{ name: 'support', entity: 'ticket', states: ['open', 'pending', 'resolved'], rules: [], actions: ['resolve_ticket'] }],
    jobs: [],
    acceptanceTests: [],
    routes: [],
    seed: { rowsPerEntity: { ticket: 12 }, mix: 'mostly open' },
    tasks: [],
    assumptions: [],
    outOfScope: [],
    changes: [...changes],
  };
}

function edit(raw: Record<string, unknown> = {}): WorldEdit {
  return worldEditSchema.parse({ note: 'iterate', ...raw });
}

/** The engine's verdict on a fixture. Every before and after world here must pass checkWorld. */
function checked(world: World): CheckedWorld {
  const r = checkWorld(world);
  if (!r.ok) throw new Error(`fixture rejected: ${JSON.stringify(r.issues.map((i) => [i.code, i.path, i.found]))}`);
  return r.world;
}

const status = (states: readonly string[], transitions: Readonly<Record<string, readonly string[]>>): Overrides<World> => ({
  entities: { ticket: { fields: { status: { states: [...states], transitions: Object.fromEntries(Object.entries(transitions).map(([k, v]) => [k, [...v]])) } } } },
});

/** minimalWorld with a fourth ticket state that no task uses. */
const withClosed = (): World =>
  minimalWorld(status(['open', 'pending', 'resolved', 'closed'], { open: ['pending'], pending: ['resolved'], resolved: ['open', 'closed'], closed: [] }));

const SMOKE_TEST = {
  description: 'The first seeded ticket is the login problem.',
  script: `(ctx) => {
  const r = ctx.api('GET', '/tickets/tkt_0001');
  ctx.assert(r.status === 200, 'get failed');
  ctx.assert(r.body.subject === 'Cannot log in', 'wrong subject ' + r.body.subject);
}`,
};

/** MEDIUM_GRADER without the stray-change penalty: resolving every pending ticket now scores 1. */
/** minimalWorld's medium grader, except a target may also change priority. */
const PRIORITY_LENIENT_GRADER = `(ctx) => {
  const c = ctx.db.list('customer', { where: { name: 'Initech' } })[0];
  if (!c) return 0;
  const targets = ctx.seed.list('ticket', { where: { customer: c.id, status: 'pending' } });
  const done = targets.filter((t) => ctx.db.get('ticket', t.id).status === 'resolved').length;
  if (targets.length === 0 || done === 0) return 0;
  const score = done / targets.length;
  const stray = ctx.changes().some((x) => !targets.some((t) => t.id === x.id) || x.fields.some((f) => f !== 'status' && f !== 'priority'));
  return stray ? score / 2 : score;
}`;
/** Scores 0.5 under minimalWorld's medium grader, which allows only status on a target, and 1 under PRIORITY_LENIENT_GRADER. */
const URGENT_DECOY = {
  why: 'resolves the pending Initech tickets and also makes them urgent',
  script: `(ctx) => {
  const c = ctx.api('GET', '/customers').body.data.find((x) => x.name === 'Initech');
  for (const t of ctx.api('GET', '/tickets?customer=' + c.id + '&status=pending').body.data) {
    ctx.api('PATCH', '/tickets/' + t.id, { priority: 'urgent' });
    ctx.api('POST', '/tickets/' + t.id + '/resolve');
  }
}`,
};
const HALF_DECOY = {
  why: 'resolves only the first pending Initech ticket',
  script: `(ctx) => {
  const c = ctx.api('GET', '/customers').body.data.find((x) => x.name === 'Initech');
  const t = ctx.api('GET', '/tickets?customer=' + c.id + '&status=pending').body.data[0];
  ctx.api('POST', '/tickets/' + t.id + '/resolve');
}`,
};

/** minimalWorld with the ticket seed's text rewritten. */
function reseeded(from: string, to: string, over: Overrides<World> = {}): World {
  const w = minimalWorld(over);
  const ticket = w.seed['ticket'];
  if (ticket === undefined || !ticket.includes(from)) throw new Error(`seed has no ${from}`);
  return { ...w, seed: { ...w.seed, ticket: ticket.replace(from, to) } };
}

/** The first ticket renamed in the seed, and the smoke test rewritten to match. */
const renamedLogin = (): World =>
  reseeded("'Cannot log in'", "'Cannot sign in'", { tests: { smoke: { ...SMOKE_TEST, script: SMOKE_TEST.script.replace('Cannot log in', 'Cannot sign in') } } });

const INITECH_BY_ID = 'Resolve every pending ticket of the customer Initech, which are tkt_0008 and tkt_0012. Leave all other tickets alone.';

type Row = {
  readonly name: string;
  readonly before: () => World;
  readonly after: () => World;
  readonly edits?: readonly WorldEdit[];
  readonly changes?: readonly string[];
  readonly expect: readonly (readonly [string, readonly (string | number)[]])[];
};

const STATUS_PATH = ['entities', 'ticket', 'fields', 'status'] as const;

const ROWS: readonly Row[] = [
  {
    name: 'removing a state without plan.changes is unplanned, and so is the edge into it',
    before: withClosed,
    after: () => minimalWorld(),
    expect: [
      ['iterate.unplanned_change', [...STATUS_PATH, 'states', 3]],
      ['iterate.unplanned_change', [...STATUS_PATH, 'transitions', 'resolved']],
    ],
  },
  {
    name: 'removing a state that plan.changes names passes, edges into it included',
    before: withClosed,
    after: () => minimalWorld(),
    changes: ['entities.ticket.fields.status.states.closed'],
    expect: [],
  },
  {
    name: 'plan.changes naming the whole field covers every change under it',
    before: withClosed,
    after: () => minimalWorld(),
    changes: ['entities.ticket.fields.status'],
    expect: [],
  },
  {
    name: 'adding a field passes',
    before: () => minimalWorld(),
    after: () => minimalWorld({ entities: { ticket: { fields: { tags: { type: 'string' } } } } }),
    expect: [],
  },
  {
    name: 'add refunds: a new state and a transition into it pass with no plan.changes',
    before: () => minimalWorld(),
    after: () => minimalWorld(status(['open', 'pending', 'resolved', 'refunded'], { open: ['pending'], pending: ['resolved'], resolved: ['open', 'refunded'], refunded: [] })),
    expect: [],
  },
  {
    name: 'removing a transition is blocked',
    before: () => minimalWorld(),
    after: () => minimalWorld(status(['open', 'pending', 'resolved'], { open: ['pending'], pending: ['resolved'], resolved: [] })),
    expect: [['iterate.unplanned_change', [...STATUS_PATH, 'transitions', 'resolved']]],
  },
  {
    name: 'removing a test without naming it is unplanned',
    before: () => minimalWorld({ tests: { smoke: SMOKE_TEST } }),
    after: () => minimalWorld(),
    expect: [['iterate.unplanned_change', ['tests', 'smoke']]],
  },
  {
    name: 'removing a test that edit.remove names passes',
    before: () => minimalWorld({ tests: { smoke: SMOKE_TEST } }),
    after: () => minimalWorld(),
    edits: [edit(), edit({ remove: { tests: ['smoke'] } })],
    expect: [],
  },
  {
    name: 'a grader change that lets an old decoy pass is a regression',
    before: () => minimalWorld({ tasks: { resolve_initech_pending: { decoys: [URGENT_DECOY] } } }),
    after: () => minimalWorld({ tasks: { resolve_initech_pending: { grader: PRIORITY_LENIENT_GRADER, decoys: [HALF_DECOY] } } }),
    expect: [['iterate.regression', ['tasks', 'resolve_initech_pending', 'decoys', 0]]],
  },
  {
    name: 'an old decoy passing is not a regression when plan.changes names its task',
    before: () => minimalWorld({ tasks: { resolve_initech_pending: { decoys: [URGENT_DECOY] } } }),
    after: () => minimalWorld({ tasks: { resolve_initech_pending: { grader: PRIORITY_LENIENT_GRADER, decoys: [HALF_DECOY] } } }),
    changes: ['tasks.resolve_initech_pending'],
    expect: [],
  },
  {
    name: 'an old test that fails against the new world is a regression',
    before: () => minimalWorld({ tests: { smoke: SMOKE_TEST } }),
    after: () => renamedLogin(),
    expect: [['iterate.regression', ['tests', 'smoke']]],
  },
  {
    name: 'an old test that fails is not a regression when plan.changes names it',
    before: () => minimalWorld({ tests: { smoke: SMOKE_TEST } }),
    after: () => renamedLogin(),
    changes: ['tests.smoke'],
    expect: [],
  },
  {
    name: 'a row an old task names by id must survive a reseed',
    before: () => minimalWorld({ tasks: { resolve_initech_pending: { instruction: INITECH_BY_ID } } }),
    after: () => reseeded("[2, 'pending', 'high', 'Duplicate charge'],", '', { tasks: { resolve_initech_pending: { instruction: INITECH_BY_ID } } }),
    expect: [['iterate.regression', ['seed', 'ticket']]],
  },
];

const summary = (issues: readonly CheckIssue[]) => issues.map((i) => [i.code, i.path]);

describe('preservationIssues', () => {
  for (const row of ROWS) {
    it(row.name, () => {
      const before = checked(row.before());
      const after = checked(row.after());
      const issues = preservationIssues(before, after, row.edits ?? [edit()], planWith(row.changes ?? []));
      assert.deepEqual(summary(issues), row.expect.map(([code, path]) => [code, path]));
    });
  }

  it('an unplanned change names the dotted path to add to plan.changes', () => {
    const issues = preservationIssues(checked(withClosed()), checked(minimalWorld()), [edit()], planWith([]));
    assert.deepEqual(issues[0], {
      code: 'iterate.unplanned_change',
      severity: 'error',
      path: ['entities', 'ticket', 'fields', 'status', 'states', 3],
      expected: 'existing items unchanged unless edit.remove or plan.changes names them',
      found: 'entities.ticket.fields.status.states.closed removed',
      hint: 'Unplanned: state_removed at entities.ticket.fields.status.states.closed. Restore it or add it to plan.changes.',
    });
    assert.equal(issues[1]?.found, '["open","closed"] became ["open"]');
  });

  it('a regressed decoy says which decoy and what it now scores', () => {
    const before = minimalWorld({ tasks: { resolve_initech_pending: { decoys: [URGENT_DECOY] } } });
    const after = minimalWorld({ tasks: { resolve_initech_pending: { grader: PRIORITY_LENIENT_GRADER, decoys: [HALF_DECOY] } } });
    const [only] = preservationIssues(checked(before), checked(after), [edit()], planWith([]));
    assert.equal(only?.found, 'scored 1');
    assert.equal(
      only?.hint,
      'Old decoy 0 of resolve_initech_pending ("resolves the pending Initech tickets and also makes them urgent") now scores 1. Make the grader score it below 1, or name tasks.resolve_initech_pending in plan.changes.',
    );
  });

  it('a regressed test carries the failure the old script hit', () => {
    const after = renamedLogin();
    const [only] = preservationIssues(checked(minimalWorld({ tests: { smoke: SMOKE_TEST } })), checked(after), [edit()], planWith([]));
    assert.equal(only?.found, 'ctx.assert failed: "wrong subject Cannot sign in"');
  });

  it('a lost row names the id and the old text that uses it', () => {
    const over: Overrides<World> = { tasks: { resolve_initech_pending: { instruction: INITECH_BY_ID } } };
    const after = reseeded("[2, 'pending', 'high', 'Duplicate charge'],", '', over);
    const [only] = preservationIssues(checked(minimalWorld(over)), checked(after), [edit()], planWith([]));
    assert.equal(only?.found, 'no ticket tkt_0012 after seeding');
    assert.equal(
      only?.hint,
      'Row tkt_0012 is gone from the new seed, but the old tasks.resolve_initech_pending.instruction names it. Seed it again, or name tasks.resolve_initech_pending in plan.changes.',
    );
  });
});

describe('unplannedChanges', () => {
  const delta = () => diffWorlds(withClosed(), minimalWorld());

  const cases: readonly (readonly [string, readonly string[], number])[] = [
    ['no names', [], 2],
    ['section-rooted state path', ['entities.ticket.fields.status.states.closed'], 0],
    ['item key without the section', ['ticket'], 0],
    ['the whole item', ['entities.ticket'], 0],
    ['only the edge, not the state', ['entities.ticket.fields.status.transitions.resolved'], 1],
    ['a bare section is too broad to count', ['entities'], 2],
    ['a sibling field does not count', ['entities.ticket.fields.priority'], 2],
    ['whitespace around a name is ignored', ['  entities.ticket.fields.status  '], 0],
  ];
  for (const [name, changes, count] of cases) {
    it(`${name}: ${count} unplanned`, () => {
      assert.equal(unplannedChanges(delta(), [edit()], planWith(changes)).length, count);
    });
  }

  it('edit.remove covers every destructive change under the item it names', () => {
    const removed = diffWorlds(minimalWorld({ tests: { smoke: SMOKE_TEST } }), minimalWorld());
    assert.equal(unplannedChanges(removed, [edit({ remove: { tests: ['smoke'] } })], planWith([])).length, 0);
    assert.equal(unplannedChanges(removed, [edit({ remove: { tasks: ['smoke'] } })], planWith([])).length, 1);
  });

  it('non-destructive changes never count', () => {
    const added = diffWorlds(minimalWorld(), minimalWorld({ tests: { smoke: SMOKE_TEST } }));
    assert.equal(added.changes.length, 1);
    assert.deepEqual(unplannedChanges(added, [edit()], planWith([])), []);
  });
});
