import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DESTRUCTIVE, diffWorlds, type WorldChange } from '../src/engine/diff.ts';
import { worldSchema, type World } from '../src/engine/format.ts';

/** A small inline world. prod/worlds/helpdesk does not exist yet, so the tests build their own. */
function raw(): Record<string, any> {
  return {
    format: 1,
    meta: {
      name: 'helpdesk', description: 'A helpdesk', resembles: 'Zendesk tickets API', source: 'hand', seed: 7,
      clock: { start: '2026-01-05T09:00:00.000Z', tick: '1s' },
    },
    entities: {
      customer: { description: 'A customer', idPrefix: 'cus', fields: { name: { type: 'string', required: true } } },
      ticket: {
        description: 'A support ticket',
        idPrefix: 'tkt',
        fields: {
          subject: { type: 'string', required: true },
          priority: { type: 'enum', values: ['low', 'high'] },
          status: {
            type: 'state', states: ['open', 'pending', 'closed'], initial: 'open',
            transitions: { open: ['pending', 'closed'], pending: ['open', 'closed'], closed: [] },
          },
        },
      },
    },
    routes: {
      get_ticket: { op: 'get', entity: 'ticket', method: 'GET', path: '/tickets/{id}' },
      list_tickets: { op: 'list', entity: 'ticket', method: 'GET', path: '/tickets' },
    },
    actions: {
      close_ticket: { method: 'POST', path: '/tickets/{id}/close', input: { reason: { type: 'string' } }, handler: '(ctx) => 1' },
    },
    jobs: { sla: { description: 'Breach SLA', every: '1h', run: '(ctx) => 1' } },
    fixtures: { orders: [{ id: 1, total: 1250 }] },
    seed: { ticket: '(ctx) => 1' },
    tests: { smoke: { description: 'Lists tickets', script: '(ctx) => 1' } },
    tasks: {
      close_one: {
        difficulty: 'medium',
        instruction: 'Close the oldest open ticket for the customer.',
        grader: '(ctx) => 1',
        solution: '(ctx) => 1',
        decoys: [{ why: 'closes the newest ticket', script: '(ctx) => 2' }],
      },
    },
  };
}

const base = (): World => worldSchema.parse(raw());
const edited = (f: (w: Record<string, any>) => void): World => {
  const w = raw();
  f(w);
  return worldSchema.parse(w);
};
const changes = (f: (w: Record<string, any>) => void): readonly WorldChange[] => diffWorlds(base(), edited(f)).changes;

describe('diffWorlds items (acceptance 1)', () => {
  it('R1 adding an entity yields item_added with the item', () => {
    assert.deepEqual(changes((w) => {
      w.entities.agent = { description: 'An agent', idPrefix: 'agt', fields: {} };
    }), [
      { section: 'entities', key: 'agent', kind: 'item_added', path: ['entities', 'agent'],
        after: { description: 'An agent', idPrefix: 'agt', fields: {} } },
    ]);
  });
  it('R1 removing a route yields item_removed, which is destructive', () => {
    const got = changes((w) => {
      delete w.routes.list_tickets;
    });
    assert.deepEqual(got, [
      { section: 'routes', key: 'list_tickets', kind: 'item_removed', path: ['routes', 'list_tickets'],
        before: { op: 'list', entity: 'ticket', method: 'GET', path: '/tickets', filters: [], search: [], sort: [], pageSize: 25 } },
    ]);
    assert.equal(DESTRUCTIVE.has('item_removed'), true);
  });
  it('R1 adding and removing items in non-entity sections', () => {
    assert.deepEqual(changes((w) => {
      delete w.seed.ticket;
      w.jobs.expire = { description: 'Expire', every: '1d', run: '(ctx) => 3' };
    }), [
      { section: 'jobs', key: 'expire', kind: 'item_added', path: ['jobs', 'expire'],
        after: { description: 'Expire', every: '1d', run: '(ctx) => 3' } },
      { section: 'seed', key: 'ticket', kind: 'item_removed', path: ['seed', 'ticket'], before: '(ctx) => 1' },
    ]);
  });
});

describe('diffWorlds fields (acceptance 2)', () => {
  it('R2 removing a field yields field_removed, adding one yields field_added', () => {
    assert.deepEqual(changes((w) => {
      delete w.entities.ticket.fields.subject;
      w.entities.ticket.fields.due_at = { type: 'datetime' };
    }), [
      { section: 'entities', key: 'ticket', kind: 'field_added', path: ['entities', 'ticket', 'fields', 'due_at'],
        after: { type: 'datetime', required: false, nullable: false, unique: false, readonly: false } },
      { section: 'entities', key: 'ticket', kind: 'field_removed', path: ['entities', 'ticket', 'fields', 'subject'],
        before: { type: 'string', required: true, nullable: false, unique: false, readonly: false } },
    ]);
    assert.equal(DESTRUCTIVE.has('field_removed'), true);
    assert.equal(DESTRUCTIVE.has('field_added'), false);
  });
  it('R3 changing a field type yields one field_changed with both whole definitions', () => {
    assert.deepEqual(changes((w) => {
      w.entities.ticket.fields.subject = { type: 'text', required: true };
    }), [
      { section: 'entities', key: 'ticket', kind: 'field_changed', path: ['entities', 'ticket', 'fields', 'subject'],
        before: { type: 'string', required: true, nullable: false, unique: false, readonly: false },
        after: { type: 'text', required: true, nullable: false, unique: false, readonly: false } },
    ]);
  });
  it('R3 changing enum values yields field_changed with before and after values', () => {
    assert.deepEqual(changes((w) => {
      w.entities.ticket.fields.priority.values = ['low', 'medium', 'high'];
    }), [
      { section: 'entities', key: 'ticket', kind: 'field_changed', path: ['entities', 'ticket', 'fields', 'priority', 'values'],
        before: ['low', 'high'], after: ['low', 'medium', 'high'] },
    ]);
  });
  it('R3 reordering enum values is a change, because order drives sorting', () => {
    assert.deepEqual(changes((w) => {
      w.entities.ticket.fields.priority.values = ['high', 'low'];
    }).map((c) => c.kind), ['field_changed']);
  });
  it('R3 changing another attribute yields field_changed at that attribute', () => {
    assert.deepEqual(changes((w) => {
      w.entities.customer.fields.name.required = false;
      w.entities.customer.fields.name.maxLength = 80;
    }), [
      { section: 'entities', key: 'customer', kind: 'field_changed', path: ['entities', 'customer', 'fields', 'name', 'maxLength'], after: 80 },
      { section: 'entities', key: 'customer', kind: 'field_changed', path: ['entities', 'customer', 'fields', 'name', 'required'],
        before: true, after: false },
    ]);
  });
});

describe('diffWorlds states, idPrefix, snippets and meta (acceptance 3)', () => {
  it('R4 removing a state yields state_removed at its index, and the dropped transitions', () => {
    const got = changes((w) => {
      const s = w.entities.ticket.fields.status;
      s.states = ['open', 'closed'];
      s.transitions = { open: ['closed'], closed: [] };
    });
    assert.deepEqual(got, [
      { section: 'entities', key: 'ticket', kind: 'state_removed', path: ['entities', 'ticket', 'fields', 'status', 'states', 1],
        before: 'pending' },
      { section: 'entities', key: 'ticket', kind: 'transition_changed',
        path: ['entities', 'ticket', 'fields', 'status', 'transitions', 'open'], before: ['pending', 'closed'], after: ['closed'] },
      { section: 'entities', key: 'ticket', kind: 'transition_changed',
        path: ['entities', 'ticket', 'fields', 'status', 'transitions', 'pending'], before: ['open', 'closed'] },
    ]);
    assert.equal(DESTRUCTIVE.has('state_removed'), true);
  });
  it('R4 adding a state yields field_changed on states and transition_added for edges into it; an empty from-list equals none', () => {
    assert.deepEqual(changes((w) => {
      const s = w.entities.ticket.fields.status;
      s.states = ['open', 'pending', 'closed', 'archived'];
      s.transitions.closed = ['archived'];
      s.transitions.archived = [];
    }), [
      { section: 'entities', key: 'ticket', kind: 'field_changed', path: ['entities', 'ticket', 'fields', 'status', 'states'],
        before: ['open', 'pending', 'closed'], after: ['open', 'pending', 'closed', 'archived'] },
      { section: 'entities', key: 'ticket', kind: 'transition_added',
        path: ['entities', 'ticket', 'fields', 'status', 'transitions', 'closed'], before: [], after: ['archived'] },
    ]);
    assert.equal(DESTRUCTIVE.has('field_changed'), false);
    assert.equal(DESTRUCTIVE.has('transition_added'), false);
  });
  it('R5 only adding targets yields transition_added, which is not destructive; reordering targets yields nothing', () => {
    assert.deepEqual(changes((w) => {
      w.entities.ticket.fields.status.transitions.closed = ['open'];
      w.entities.ticket.fields.status.transitions.open = ['closed', 'pending'];
      w.entities.ticket.fields.status.transitions.pending = ['closed', 'open', 'open'];
    }), [
      { section: 'entities', key: 'ticket', kind: 'transition_added',
        path: ['entities', 'ticket', 'fields', 'status', 'transitions', 'closed'], before: [], after: ['open'] },
    ]);
    assert.equal(DESTRUCTIVE.has('transition_added'), false);
  });
  it('R5 removing a target yields transition_changed, which is destructive, also when another target is added', () => {
    assert.deepEqual(changes((w) => {
      w.entities.ticket.fields.status.transitions.open = ['closed'];
      w.entities.ticket.fields.status.transitions.pending = ['pending', 'closed'];
    }), [
      { section: 'entities', key: 'ticket', kind: 'transition_changed',
        path: ['entities', 'ticket', 'fields', 'status', 'transitions', 'open'], before: ['pending', 'closed'], after: ['closed'] },
      { section: 'entities', key: 'ticket', kind: 'transition_changed',
        path: ['entities', 'ticket', 'fields', 'status', 'transitions', 'pending'], before: ['open', 'closed'], after: ['pending', 'closed'] },
    ]);
    assert.equal(DESTRUCTIVE.has('transition_changed'), true);
  });
  it('R6 changing idPrefix yields id_prefix_changed', () => {
    assert.deepEqual(changes((w) => {
      w.entities.ticket.idPrefix = 'tk';
    }), [
      { section: 'entities', key: 'ticket', kind: 'id_prefix_changed', path: ['entities', 'ticket', 'idPrefix'], before: 'tkt', after: 'tk' },
    ]);
    assert.equal(DESTRUCTIVE.has('id_prefix_changed'), true);
  });
  it('R7 editing any snippet yields snippet_changed at its path', () => {
    assert.deepEqual(changes((w) => {
      w.actions.close_ticket.handler = '(ctx) => 2';
      w.jobs.sla.run = '(ctx) => 2';
      w.seed.ticket = '(ctx) => 2';
      w.tests.smoke.script = '(ctx) => 2';
      w.tasks.close_one.grader = '(ctx) => 2';
      w.tasks.close_one.solution = '(ctx) => 2';
      w.tasks.close_one.decoys[0].script = '(ctx) => 3';
    }), [
      { section: 'actions', key: 'close_ticket', kind: 'snippet_changed', path: ['actions', 'close_ticket', 'handler'],
        before: '(ctx) => 1', after: '(ctx) => 2' },
      { section: 'jobs', key: 'sla', kind: 'snippet_changed', path: ['jobs', 'sla', 'run'], before: '(ctx) => 1', after: '(ctx) => 2' },
      { section: 'seed', key: 'ticket', kind: 'snippet_changed', path: ['seed', 'ticket'], before: '(ctx) => 1', after: '(ctx) => 2' },
      { section: 'tests', key: 'smoke', kind: 'snippet_changed', path: ['tests', 'smoke', 'script'], before: '(ctx) => 1', after: '(ctx) => 2' },
      { section: 'tasks', key: 'close_one', kind: 'snippet_changed', path: ['tasks', 'close_one', 'decoys', 0, 'script'],
        before: '(ctx) => 2', after: '(ctx) => 3' },
      { section: 'tasks', key: 'close_one', kind: 'snippet_changed', path: ['tasks', 'close_one', 'grader'], before: '(ctx) => 1', after: '(ctx) => 2' },
      { section: 'tasks', key: 'close_one', kind: 'snippet_changed', path: ['tasks', 'close_one', 'solution'], before: '(ctx) => 1', after: '(ctx) => 2' },
    ]);
  });
  it('R8 meta changes yield meta_changed at the deepest differing path', () => {
    assert.deepEqual(changes((w) => {
      w.meta.description = 'A bigger helpdesk';
      w.meta.clock.tick = '2s';
      w.meta.api = { list: { dataKey: 'items' } };
    }), [
      { section: 'meta', key: 'api', kind: 'meta_changed', path: ['meta', 'api', 'list', 'dataKey'], before: 'data', after: 'items' },
      { section: 'meta', key: 'clock', kind: 'meta_changed', path: ['meta', 'clock', 'tick'], before: '1s', after: '2s' },
      { section: 'meta', key: 'description', kind: 'meta_changed', path: ['meta', 'description'],
        before: 'A helpdesk', after: 'A bigger helpdesk' },
    ]);
  });
});

describe('diffWorlds identity and order (acceptance 4)', () => {
  it('R9 diffWorlds(w, w) returns no changes', () => {
    const w = base();
    assert.deepEqual(diffWorlds(w, w), { changes: [] });
  });
  it('R9 two separately parsed equal worlds have no changes', () => {
    assert.deepEqual(diffWorlds(base(), base()), { changes: [] });
  });
  it('R10 orders by section (meta first), then key, then path', () => {
    const f = (w: Record<string, any>): void => {
      w.tasks.close_one.difficulty = 'hard';
      w.routes.get_ticket.path = '/tickets/{ticket_id}';
      w.entities.ticket.idPrefix = 'tk';
      w.entities.customer.fields.email = { type: 'string', format: 'email' };
      w.meta.seed = 8;
      w.entities.ticket.fields.priority.values = ['low'];
    };
    const summary = changes(f).map((c) => [c.kind, ...c.path].join(' '));
    assert.deepEqual(summary, [
      'meta_changed meta seed',
      'field_added entities customer fields email',
      'enum_value_removed entities ticket fields priority values 1',
      'id_prefix_changed entities ticket idPrefix',
      'endpoint_changed routes get_ticket path',
      'item_changed tasks close_one difficulty',
    ]);
  });
  it('R10 the order does not depend on the key order of either world', () => {
    const reversedKeys = edited((w) => {
      w.entities = { ticket: w.entities.ticket, customer: w.entities.customer, zone: { description: 'z', idPrefix: 'zn', fields: {} } };
      w.routes = { list_tickets: w.routes.list_tickets };
    });
    const summary = diffWorlds(base(), reversedKeys).changes.map((c) => [c.kind, ...c.path].join(' '));
    assert.deepEqual(summary, ['item_added entities zone', 'item_removed routes get_ticket']);
    assert.deepEqual(diffWorlds(base(), reversedKeys), diffWorlds(base(), reversedKeys));
  });
  it('R10 numeric path steps sort numerically', () => {
    const got = diffWorlds(
      edited((w) => {
        w.tasks.close_one.decoys = Array.from({ length: 11 }, (_, i) => ({ why: `mistake number ${i}`, script: `(ctx) => ${i}` }));
      }),
      edited((w) => {
        w.tasks.close_one.decoys = Array.from({ length: 11 }, (_, i) => ({ why: `mistake number ${i}`, script: `(ctx) => ${i + 1}` }));
      }),
    ).changes;
    assert.deepEqual(got.map((c) => c.path[3]), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });
});

describe('diffWorlds paths and other changes (acceptance 5, header)', () => {
  const all = (): readonly WorldChange[] => changes((w) => {
    w.meta.name = 'helpdesk_two';
    w.entities.agent = { description: 'An agent', idPrefix: 'agt', fields: {} };
    delete w.entities.customer;
    w.entities.ticket.description = 'A ticket';
    w.entities.ticket.fields.status.states = ['open', 'closed'];
    w.entities.ticket.fields.status.transitions = { open: ['closed'], closed: [] };
    w.routes.list_tickets.pageSize = 50;
    w.actions.close_ticket.input = { note: { type: 'text' } };
    w.jobs.sla.every = '2h';
    w.fixtures.orders = [{ id: 1, total: 1300 }];
    w.tests.smoke.description = 'Smoke';
    w.tasks.close_one.instruction = 'Close the newest open ticket for the customer.';
    w.tasks.close_one.decoys = [];
  });

  it('R11 every path starts with its section, then its key', () => {
    const got = all();
    assert.equal(got.length, 15);
    for (const c of got) {
      assert.equal(c.path[0], c.section);
      assert.equal(c.path[1], c.key);
      assert.equal(c.path.every((p) => typeof p === 'string' || typeof p === 'number'), true);
    }
  });
  it('R12 reports every other change to an existing item', () => {
    assert.deepEqual(all().map((c) => [c.kind, ...c.path].join(' ')), [
      'meta_changed meta name',
      'item_added entities agent',
      'item_removed entities customer',
      'item_changed entities ticket description',
      'state_removed entities ticket fields status states 1',
      'transition_changed entities ticket fields status transitions open',
      'transition_changed entities ticket fields status transitions pending',
      'item_changed routes list_tickets pageSize',
      'field_added actions close_ticket input note',
      'field_removed actions close_ticket input reason',
      'item_changed jobs sla every',
      'item_changed fixtures orders',
      'item_changed tests smoke description',
      'item_changed tasks close_one decoys 0',
      'item_changed tasks close_one instruction',
    ]);
  });
  it('R12 a removed decoy and a fixtures edit carry before and after', () => {
    const got = all();
    assert.deepEqual(got.find((c) => c.path[0] === 'tasks' && c.path[2] === 'decoys'), {
      section: 'tasks', key: 'close_one', kind: 'item_changed', path: ['tasks', 'close_one', 'decoys', 0],
      before: { why: 'closes the newest ticket', script: '(ctx) => 2' },
    });
    assert.deepEqual(got.find((c) => c.section === 'fixtures'), {
      section: 'fixtures', key: 'orders', kind: 'item_changed', path: ['fixtures', 'orders'],
      before: [{ id: 1, total: 1250 }], after: [{ id: 1, total: 1300 }],
    });
    assert.equal(DESTRUCTIVE.has('item_changed'), false);
  });
});

describe('diffWorlds narrowing is destructive, pure widening is not (fix-engine-diff)', () => {
  const destructive = (got: readonly WorldChange[]): string[] =>
    got.filter((c) => DESTRUCTIVE.has(c.kind)).map((c) => [c.kind, ...c.path].join(' '));

  it('N1 removing an enum value yields enum_value_removed at its index in before, which is destructive', () => {
    assert.deepEqual(changes((w) => {
      w.entities.ticket.fields.priority.values = ['high', 'urgent'];
    }), [
      { section: 'entities', key: 'ticket', kind: 'field_changed', path: ['entities', 'ticket', 'fields', 'priority', 'values'],
        before: ['low', 'high'], after: ['high', 'urgent'] },
      { section: 'entities', key: 'ticket', kind: 'enum_value_removed', path: ['entities', 'ticket', 'fields', 'priority', 'values', 0],
        before: 'low' },
    ]);
    assert.equal(DESTRUCTIVE.has('enum_value_removed'), true);
  });
  it('N1 only adding an enum value is not destructive', () => {
    assert.deepEqual(destructive(changes((w) => {
      w.entities.ticket.fields.priority.values = ['low', 'high', 'urgent'];
    })), []);
  });
  it('N2 a state field changed to another type yields field_changed plus every lost state and transition', () => {
    const got = changes((w) => {
      w.entities.ticket.fields.status = { type: 'string' };
    });
    assert.deepEqual(got.map((c) => [c.kind, ...c.path].join(' ')), [
      'field_changed entities ticket fields status',
      'state_removed entities ticket fields status states 0',
      'state_removed entities ticket fields status states 1',
      'state_removed entities ticket fields status states 2',
      'transition_changed entities ticket fields status transitions open',
      'transition_changed entities ticket fields status transitions pending',
    ]);
    assert.deepEqual(got.slice(1).map((c) => [c.before, c.after]), [
      ['open', undefined],
      ['pending', undefined],
      ['closed', undefined],
      [['pending', 'closed'], undefined],
      [['open', 'closed'], undefined],
    ]);
    assert.deepEqual(got[0]?.after, { type: 'string', required: false, nullable: false, unique: false, readonly: false });
    assert.deepEqual(destructive(got).length, 5);
  });
  it('N3 an existing field going optional to required yields field_required, which is destructive', () => {
    assert.deepEqual(changes((w) => {
      w.entities.ticket.fields.priority.required = true;
      w.actions.close_ticket.input.reason.required = true;
    }), [
      { section: 'entities', key: 'ticket', kind: 'field_required', path: ['entities', 'ticket', 'fields', 'priority', 'required'],
        before: false, after: true },
      { section: 'actions', key: 'close_ticket', kind: 'field_required', path: ['actions', 'close_ticket', 'input', 'reason', 'required'],
        before: false, after: true },
    ]);
    assert.equal(DESTRUCTIVE.has('field_required'), true);
  });
  it('N3 a field going required to optional is not destructive', () => {
    assert.deepEqual(destructive(changes((w) => {
      w.entities.customer.fields.name.required = false;
    })), []);
  });
  it('N4 a new required action input or entity field yields required_field_added, which is destructive', () => {
    assert.deepEqual(changes((w) => {
      w.actions.close_ticket.input.code = { type: 'string', required: true };
      w.entities.customer.fields.email = { type: 'string', required: true };
    }), [
      { section: 'entities', key: 'customer', kind: 'required_field_added', path: ['entities', 'customer', 'fields', 'email'],
        after: { type: 'string', required: true, nullable: false, unique: false, readonly: false } },
      { section: 'actions', key: 'close_ticket', kind: 'required_field_added', path: ['actions', 'close_ticket', 'input', 'code'],
        after: { type: 'string', required: true, nullable: false, unique: false, readonly: false } },
    ]);
    assert.equal(DESTRUCTIVE.has('required_field_added'), true);
  });
  it('N4 a new optional action input stays field_added and is not destructive', () => {
    assert.deepEqual(changes((w) => {
      w.actions.close_ticket.input.code = { type: 'string' };
    }).map((c) => [c.kind, ...c.path].join(' ')), ['field_added actions close_ticket input code']);
    assert.equal(DESTRUCTIVE.has('field_added'), false);
  });
  it('N5 a route path, route method or action method or path change yields endpoint_changed, which is destructive', () => {
    assert.deepEqual(changes((w) => {
      w.routes.get_ticket.path = '/t/{id}';
      w.routes.list_tickets.method = 'POST';
      w.actions.close_ticket.method = 'PUT';
      w.actions.close_ticket.path = '/tickets/{id}/closure';
    }), [
      { section: 'routes', key: 'get_ticket', kind: 'endpoint_changed', path: ['routes', 'get_ticket', 'path'],
        before: '/tickets/{id}', after: '/t/{id}' },
      { section: 'routes', key: 'list_tickets', kind: 'endpoint_changed', path: ['routes', 'list_tickets', 'method'],
        before: 'GET', after: 'POST' },
      { section: 'actions', key: 'close_ticket', kind: 'endpoint_changed', path: ['actions', 'close_ticket', 'method'],
        before: 'POST', after: 'PUT' },
      { section: 'actions', key: 'close_ticket', kind: 'endpoint_changed', path: ['actions', 'close_ticket', 'path'],
        before: '/tickets/{id}/close', after: '/tickets/{id}/closure' },
    ]);
    assert.equal(DESTRUCTIVE.has('endpoint_changed'), true);
  });
  it('N6 the add-refunds iterate (new state, edge into it, new action and route) has no destructive change', () => {
    const got = changes((w) => {
      const s = w.entities.ticket.fields.status;
      s.states = ['open', 'pending', 'closed', 'refunded'];
      s.transitions.closed = ['refunded'];
      s.transitions.refunded = [];
      w.actions.refund_ticket = { method: 'POST', path: '/tickets/{id}/refund', input: { amount: { type: 'int' } }, handler: '(ctx) => 1' };
      w.routes.create_ticket = { op: 'create', entity: 'ticket', method: 'POST', path: '/tickets' };
    });
    assert.deepEqual(got.map((c) => [c.kind, ...c.path].join(' ')), [
      'field_changed entities ticket fields status states',
      'transition_added entities ticket fields status transitions closed',
      'item_added routes create_ticket',
      'item_added actions refund_ticket',
    ]);
    assert.deepEqual(destructive(got), []);
  });
});
