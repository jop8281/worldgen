/**
 *   bun scripts/scenario-worlds.ts [--check]   # --check writes nothing and exits 1 when a committed world differs
 *
 * Exit codes: 0 written or no drift, 1 a world was refused or drifted, 2 bad usage.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { applyEdit, checkWorld, choicesOf, loadWorld, renderWorldYaml, saveWorld, type CheckedWorld, type TaskVerdict, type World } from '#engine';

const USAGE = 'usage: bun scripts/scenario-worlds.ts [--check]\n';
const REPO = path.resolve(import.meta.dirname, '../..');
const SCENARIO_DIR = path.join(REPO, 'prod/scenarios/billing-duplicate-charge');

type Derivation = { readonly from: string; readonly edit: (source: World) => unknown };

const SUPPORT_TASK = {
  difficulty: 'medium',
  instruction: 'Acme Logistics was charged $149.00 twice for order O-7301. Once the duplicate is refunded in the payments system, resolve their ticket "Charged twice for order O-7301" with a note that names the order and the refund id.',
  grader: `(ctx) => {
  const acme = ctx.seed.list('customer', { where: { name: 'Acme Logistics' } })[0];
  if (!acme) return 0;
  const ticket = ctx.seed.list('ticket', { where: { customer_id: acme.id, subject: 'Charged twice for order O-7301' } })[0];
  if (!ticket) return 0;
  const old = new Set(ctx.seed.list('ticket_event', { where: { ticket_id: ticket.id } }).map((e) => e.id));
  const resolved = ctx.db.list('ticket_event', { where: { ticket_id: ticket.id, kind: 'resolved' } }).filter((e) => !old.has(e.id));
  // The payments system's refund event reaches the ticket through receive_payment_event, which writes this note with no actor (A-410).
  const perRefund = new Map();
  for (const e of ctx.db.list('ticket_event', { where: { ticket_id: ticket.id, kind: 'payment_refunded' } })) {
    const m = e.actor_id === null && typeof e.note === 'string' ? /^Refund (re_[A-Za-z0-9]+) of charge ch_[A-Za-z0-9]+ \\(charge\\.refunded\\)\\.$/.exec(e.note) : null;
    if (m && !perRefund.has(m[1])) perRefund.set(m[1], e.id);
  }
  ctx.guardChanges('only the resolve fields of the ticket, its resolved event and one payment event per refund changed', [
    { entity: 'ticket', id: ticket.id, kind: 'updated', fields: ['status', 'resolved_at'] },
    ...[...resolved.map((e) => e.id), ...perRefund.values()].map((id) => ({ entity: 'ticket_event', id, kind: 'created', fields: ['ticket_id', 'kind', 'note', 'actor_id'] })),
  ]);
  ctx.goal(0.5, 'the ticket is resolved, with one resolved event', ctx.db.get('ticket', ticket.id).status === 'resolved' && resolved.length === 1);
  // The note must name the order and exactly one refund id as the payments world writes them (re_ and at least four digits), so a note of nonsense or a list of ids scores below 1 (A-388, A-397).
  const note = resolved.length === 1 && typeof resolved[0].note === 'string' ? resolved[0].note : '';
  ctx.goal(0.5, 'the resolution note names order O-7301 and exactly one refund id', note.includes('O-7301') && (note.match(/\\bre_\\d{4,}\\b/g) || []).length === 1);
  return ctx.score();
}`,
  solution: `(ctx) => {
  const acme = ctx.api('GET', '/customers?q=Acme').body.data.find((c) => c.name === 'Acme Logistics');
  ctx.assert(acme, 'customer Acme Logistics not found');
  const ticket = ctx.api('GET', '/tickets?customer_id=' + acme.id + '&q=O-7301').body.data.find((t) => t.subject === 'Charged twice for order O-7301');
  ctx.assert(ticket, 'ticket "Charged twice for order O-7301" not found');
  const r = ctx.api('POST', '/tickets/' + ticket.id + '/resolve', { note: 'Refunded the duplicate O-7301 charge, refund re_0051.' });
  ctx.assert(r.status === 200, 'resolve failed: ' + JSON.stringify(r.body));
}`,
  decoys: [
    {
      why: 'resolves the ticket with no note, so nothing records which refund settled it',
      script: `(ctx) => {
  const acme = ctx.api('GET', '/customers?q=Acme').body.data.find((c) => c.name === 'Acme Logistics');
  const ticket = ctx.api('GET', '/tickets?customer_id=' + acme.id + '&q=O-7301').body.data[0];
  ctx.api('POST', '/tickets/' + ticket.id + '/resolve', {});
}`,
    },
    {
      why: 'resolves the ticket with a note that names the order but no refund id',
      script: `(ctx) => {
  const acme = ctx.api('GET', '/customers?q=Acme').body.data.find((c) => c.name === 'Acme Logistics');
  const ticket = ctx.api('GET', '/tickets?customer_id=' + acme.id + '&q=O-7301').body.data[0];
  ctx.api('POST', '/tickets/' + ticket.id + '/resolve', { note: 'Refunded the duplicate O-7301 charge.' });
}`,
    },
    {
      why: 'resolves the ticket with a note that lists refund ids re_0001 to re_0099, so it cites no one refund',
      script: `(ctx) => {
  const acme = ctx.api('GET', '/customers?q=Acme').body.data.find((c) => c.name === 'Acme Logistics');
  const ticket = ctx.api('GET', '/tickets?customer_id=' + acme.id + '&q=O-7301').body.data[0];
  const ids = Array.from({ length: 99 }, (_, i) => 're_' + String(i + 1).padStart(4, '0'));
  ctx.api('POST', '/tickets/' + ticket.id + '/resolve', { note: 'Refunded the duplicate O-7301 charge, refund ' + ids.join(' ') + '.' });
}`,
    },
    {
      why: 'PATCHes the ticket status to resolved instead of calling the resolve action, so no resolved event carries a note',
      script: `(ctx) => {
  const acme = ctx.api('GET', '/customers?q=Acme').body.data.find((c) => c.name === 'Acme Logistics');
  const ticket = ctx.api('GET', '/tickets?customer_id=' + acme.id + '&q=O-7301').body.data[0];
  ctx.api('PATCH', '/tickets/' + ticket.id, { status: 'resolved' });
}`,
    },
  ],
};

const RECEIVE_PAYMENT_EVENT = {
  method: 'POST',
  path: '/tickets/{id}/payment_events',
  description: 'Record a refund event from the payments system on a ticket, as a payment_refunded event whose note names the refund and the charge. A second event for a refund already recorded on any ticket answers 200 with the recorded event and writes nothing.',
  input: {
    kind: { type: 'enum', values: ['charge.refunded'], required: true, description: 'The payments event type.' },
    refund: { type: 'string', pattern: '^re_[A-Za-z0-9]+$', required: true, description: 'The refund id, such as re_0051.' },
    charge: { type: 'string', pattern: '^ch_[A-Za-z0-9]+$', required: true, description: 'The refunded charge id, such as ch_0142.' },
  },
  handler: `(ctx) => {
  const id = ctx.params.id;
  const t = ctx.db.get('ticket', id);
  if (t === null) ctx.fail(404, 'not_found', 'ticket ' + id + ' not found');
  const named = 'Refund ' + ctx.body.refund + ' of charge ';
  const seen = ctx.db.list('ticket_event', { where: { kind: 'payment_refunded' } }).find((e) => typeof e.note === 'string' && e.note.startsWith(named));
  if (seen) return { status: 200, body: seen };
  const event = ctx.db.create('ticket_event', { ticket_id: id, kind: 'payment_refunded', note: named + ctx.body.charge + ' (' + ctx.body.kind + ').', actor_id: null });
  return { status: 200, body: event };
}`,
};

const PAYMENT_EVENT_TEST = {
  description: 'receive_payment_event records one payment_refunded event per refund: a repeat answers 200 with the same event and writes nothing, and an unknown ticket is 404.',
  script: `(ctx) => {
  const body = { kind: 'charge.refunded', refund: 're_9001', charge: 'ch_9001' };
  const first = ctx.api('POST', '/tickets/tkt_0001/payment_events', body);
  ctx.assert(first.status === 200, 'first event returned ' + first.status + ' ' + JSON.stringify(first.body));
  ctx.assert(first.body.kind === 'payment_refunded' && first.body.note === 'Refund re_9001 of charge ch_9001 (charge.refunded).' && first.body.actor_id === null, 'recorded ' + JSON.stringify(first.body));
  const again = ctx.api('POST', '/tickets/tkt_0001/payment_events', body);
  ctx.assert(again.status === 200 && again.body.id === first.body.id, 'repeat returned ' + again.status + ' ' + JSON.stringify(again.body));
  const recorded = ctx.api('GET', '/tickets/tkt_0001/events?sort=-created_at&limit=5').body.data.filter((e) => e.kind === 'payment_refunded');
  ctx.assert(recorded.length === 1, 'one payment_refunded event, got ' + recorded.length);
  const missing = ctx.api('POST', '/tickets/tkt_9999/payment_events', body);
  ctx.assert(missing.status === 404, 'unknown ticket returned ' + missing.status);
}`,
};

const ticketSeed = (original: string): string => `(ctx) => {
  const base = (${original.trim()})(ctx);
  const acme = ctx.rows('customer').find((c) => c.name === 'Acme Logistics');
  const template = base.find((t) => t.customer_id === acme.id && t.status === 'open' && t.assignee_id !== null && !t.sla_breached);
  const minutes = ctx.rows('sla_policy').find((p) => p.code === acme.tier + '_' + template.priority).resolution_minutes;
  const created = ctx.time.minus(ctx.now(), '50m');
  return [...base, {
    ...template,
    subject: 'Charged twice for order O-7301',
    description: 'Acme Logistics was charged $149.00 twice for order O-7301. Please refund the duplicate charge.',
    sla_started_at: created,
    sla_due_at: ctx.time.plus(created, minutes + 'm'),
    created_at: created,
    updated_at: ctx.time.minus(ctx.now(), '25m'),
  }];
}`;

const PAYMENTS_TASK = {
  difficulty: 'medium',
  instruction: 'Acme Logistics was charged $149.00 twice for order O-7301. Refund the later of the two O-7301 charges in full, once, with reason duplicate. Do not touch any other charge.',
  grader: `(ctx) => {
  const acme = ctx.seed.list('customer', { where: { name: 'Acme Logistics' } })[0];
  if (!acme) return 0;
  const pair = ctx.seed.list('charge', { where: { customer: acme.id, description: 'Order O-7301' } });
  if (pair.length !== 2) return 0;
  const later = pair[0].created_at > pair[1].created_at ? pair[0] : pair[1];
  const fresh = ctx.db.list('refund').filter((r) => ctx.seed.get('refund', r.id) === null);
  ctx.guardChanges('only the later O-7301 charge and its refund changed', [
    { entity: 'charge', id: later.id, kind: 'updated', fields: ['amount_refunded', 'refunded'] },
    ...fresh.filter((r) => r.charge === later.id).map((r) => ({ entity: 'refund', id: r.id, kind: 'created', fields: ['charge', 'amount', 'currency', 'reason', 'status', 'failure_reason', 'receipt_number', 'payment_intent'] })),
  ]);
  ctx.guard('exactly one refund was created', fresh.length === 1);
  const refund = fresh.length === 1 && fresh[0].charge === later.id ? fresh[0] : null;
  ctx.goal(0.4, 'one refund of the later O-7301 charge for its full amount', refund !== null && refund.amount === later.amount);
  ctx.goal(0.3, 'the refund reason is duplicate', refund !== null && refund.reason === 'duplicate');
  const end = ctx.db.get('charge', later.id);
  ctx.goal(0.3, 'the later O-7301 charge is fully refunded', end.amount_refunded === later.amount && end.refunded === true);
  return ctx.score();
}`,
  solution: `(ctx) => {
  const acme = ctx.api('GET', '/v1/customers?q=Acme').body.data.find((c) => c.name === 'Acme Logistics');
  ctx.assert(acme, 'customer Acme Logistics not found');
  const pair = ctx.api('GET', '/v1/charges?customer=' + acme.id + '&status=succeeded&limit=100').body.data.filter((c) => c.description === 'Order O-7301');
  ctx.assert(pair.length === 2, 'expected two O-7301 charges, found ' + pair.length);
  const later = pair[0].created_at > pair[1].created_at ? pair[0] : pair[1];
  const r = ctx.api('POST', '/v1/refunds', { charge: later.id, reason: 'duplicate' });
  ctx.assert(r.status === 200, 'refund failed: ' + JSON.stringify(r.body));
}`,
  decoys: [
    {
      why: 'refunds the earlier of the two O-7301 charges instead of the later one',
      script: `(ctx) => {
  const acme = ctx.api('GET', '/v1/customers?q=Acme').body.data.find((c) => c.name === 'Acme Logistics');
  const pair = ctx.api('GET', '/v1/charges?customer=' + acme.id + '&limit=100').body.data.filter((c) => c.description === 'Order O-7301');
  const earlier = pair[0].created_at < pair[1].created_at ? pair[0] : pair[1];
  ctx.api('POST', '/v1/refunds', { charge: earlier.id, reason: 'duplicate' });
}`,
    },
    {
      why: 'chooses on amount alone and refunds the newest $149.00 charge, which is order O-7302',
      script: `(ctx) => {
  const acme = ctx.api('GET', '/v1/customers?q=Acme').body.data.find((c) => c.name === 'Acme Logistics');
  const newest = ctx.api('GET', '/v1/charges?customer=' + acme.id + '&limit=100').body.data.filter((c) => c.amount === 14900)[0];
  ctx.api('POST', '/v1/refunds', { charge: newest.id, reason: 'duplicate' });
}`,
    },
    {
      why: 'refunds both O-7301 charges, so the customer gets the order for free',
      script: `(ctx) => {
  const acme = ctx.api('GET', '/v1/customers?q=Acme').body.data.find((c) => c.name === 'Acme Logistics');
  for (const c of ctx.api('GET', '/v1/charges?customer=' + acme.id + '&limit=100').body.data.filter((x) => x.description === 'Order O-7301')) {
    ctx.api('POST', '/v1/refunds', { charge: c.id, reason: 'duplicate' });
  }
}`,
    },
  ],
};

const customerSeed = (original: string): string => `(ctx) => {
  const base = (${original.trim()})(ctx);
  const since = '2025-02-11T09:00:00.000Z';
  return [...base, { name: 'Acme Logistics', email: 'billing@acmelogistics.example', description: null, card_state: 'valid', livemode: false, created_at: since, updated_at: since }];
}`;

const HIDE_ACME = `const acme = ctx.rows('customer').find((c) => c.name === 'Acme Logistics');
  const before = { ...ctx, rows: (entity) => ctx.rows(entity).filter((r) => r.id !== acme.id && r.customer !== acme.id) };`;

const chargeSeed = (original: string): string => `(ctx) => {
  ${HIDE_ACME}
  const base = (${original.trim()})(before);
  const template = base.find((c) => c.status === 'succeeded' && c.captured && c.amount_refunded === 0 && c.customer !== null);
  const charge = (n, description, ago) => {
    const at = ctx.time.minus(ctx.now(), ago);
    return { ...template, amount: 14900, currency: 'usd', customer: acme.id, description, receipt_email: acme.email, amount_captured: 14900,
      payment_intent: 'pi_' + String(base.length + n).padStart(4, '0'), created_at: at, updated_at: at };
  };
  return [...base, charge(1, 'Order O-7301', '2d4h12m'), charge(2, 'Order O-7301', '2d4h5m'), charge(3, 'Order O-7302', '1d2h')];
}`;

const refundSeed = (original: string): string => `(ctx) => {
  ${HIDE_ACME}
  return (${original.trim()})(before);
}`;

const seedOf = (world: World, entity: string): string => {
  const source = world.seed[entity];
  if (source === undefined) throw new Error(`${world.meta.name} has no ${entity} seed`);
  return source;
};

const eventKinds = (world: World): readonly string[] => {
  const field = world.entities['ticket_event']?.fields['kind'];
  const kinds = field === undefined ? undefined : choicesOf(field);
  if (kinds === undefined) throw new Error(`${world.meta.name} has no ticket_event.kind enum`);
  return kinds;
};

const DERIVED = {
  support: {
    from: 'prod/worlds/helpdesk',
    edit: (source) => ({
      note: 'acme_support: the helpdesk plus Acme Logistics\' O-7301 duplicate-charge ticket, the task that resolves it (A-397), and the action that records a refund event (A-410)',
      meta: {
        name: 'acme_support',
        description: `${source.meta.description} Acme Logistics has an open billing ticket about order O-7301.`,
      },
      upsert: {
        actions: { receive_payment_event: RECEIVE_PAYMENT_EVENT },
        seed: { ticket: ticketSeed(seedOf(source, 'ticket')) },
        tests: { payment_event_once_per_refund: PAYMENT_EVENT_TEST },
        tasks: { resolve_acme_double_charge: SUPPORT_TASK },
      },
      patch: { entities: { ticket_event: { fields: { kind: { values: [...eventKinds(source), 'payment_refunded'] } } } } },
    }),
  },
  payments: {
    from: 'prod/worlds/gen-stripe-charges',
    edit: (source) => ({
      note: 'acme_payments: the Stripe charges world plus Acme Logistics, its duplicate O-7301 charge, and the task that refunds it (A-397)',
      meta: {
        name: 'acme_payments',
        description: `${source.meta.description} Acme Logistics is a customer with card charges for orders O-7301 and O-7302.`,
      },
      upsert: {
        seed: { customer: customerSeed(seedOf(source, 'customer')), charge: chargeSeed(seedOf(source, 'charge')), refund: refundSeed(seedOf(source, 'refund')) },
        tasks: { refund_acme_duplicate_o7301: PAYMENTS_TASK },
      },
    }),
  },
} satisfies Record<string, Derivation>;
export type DerivedAlias = keyof typeof DERIVED;

const answerOf = (v: TaskVerdict): string =>
  JSON.stringify({ calls: v.solutionCalls, writes: v.solutionWrites, rows: v.solutionRowsChanged, decoys: v.decoys.map((d) => d.score) });

async function derive({ from, edit }: Derivation): Promise<CheckedWorld> {
  const loaded = await loadWorld(path.join(REPO, from));
  if (!loaded.ok) throw new Error(`${from} did not load: ${JSON.stringify(loaded.error)}`);
  const source = checkWorld(loaded.value);
  if (!source.ok) throw new Error(`${from} failed check at ${source.reached}: ${JSON.stringify(source.issues)}`);
  const edited = applyEdit(source.world, edit(source.world));
  if (!edited.ok) throw new Error(`the edit of ${from} was refused: ${JSON.stringify(edited.error)}`);
  const report = checkWorld(edited.value.world);
  if (!report.ok) throw new Error(`the world derived from ${from} failed check at ${report.reached}: ${JSON.stringify(report.issues)}`);
  for (const [task, verdict] of Object.entries(source.verdicts)) {
    const derived = report.verdicts[task];
    if (derived === undefined || answerOf(derived) !== answerOf(verdict)) {
      throw new Error(`${task} verifies as ${derived === undefined ? 'nothing' : answerOf(derived)} on the world derived from ${from}, and as ${answerOf(verdict)} on ${from}`);
    }
  }
  return report.world;
}

export async function buildScenarioWorlds(): Promise<Readonly<Record<DerivedAlias, CheckedWorld>>> {
  return { support: await derive(DERIVED.support), payments: await derive(DERIVED.payments) };
}

export const worldDirOf = (alias: DerivedAlias): string => path.join(SCENARIO_DIR, 'worlds', alias);

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (args.some((a) => a !== '--check')) {
    process.stderr.write(USAGE);
    return 2;
  }
  const check = args.includes('--check');
  let worlds: Readonly<Record<DerivedAlias, CheckedWorld>>;
  try {
    worlds = await buildScenarioWorlds();
  } catch (e) {
    process.stderr.write(`refused: ${e instanceof Error ? e.message : String(e)}\n`);
    return 1;
  }
  let drifted = 0;
  for (const alias of ['support', 'payments'] as const) {
    const world = worlds[alias];
    const dir = worldDirOf(alias);
    const rel = path.relative(REPO, path.join(dir, 'world.yaml'));
    const committed = await readFile(path.join(dir, 'world.yaml'), 'utf8').catch(() => null);
    const same = committed === renderWorldYaml(world);
    if (check) {
      if (!same) drifted++;
      process.stdout.write(`${same ? 'same' : 'drifted'} ${rel}\n`);
    } else {
      if (!same) await saveWorld(dir, world);
      process.stdout.write(`${same ? 'unchanged' : 'wrote'} ${rel}\n`);
    }
  }
  return drifted > 0 ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exit(await main());
