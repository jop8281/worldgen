/**
 * Refs that point both ways between entities (an airline's seat and booking). A nullable ref may
 * name a row of an entity seeded later, by its predictable id; it must resolve once every seed
 * has run. A cycle with no nullable ref has no seed order, and check says which refs to relax.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { check, type CheckReport } from '../src/engine/check.ts';
import { emptyWorld, worldSchema, type World } from '../src/engine/format.ts';
import { seedState } from '../src/engine/store.ts';
import { createVmHost } from '../src/engine/sandbox.ts';

const host = createVmHost();

type Raw = Record<string, any>;

/** seat.booking is nullable and may point at a booking seeded later; booking.seat is required. */
function airline(seatSeed: string, bookingSeed: string, seatBooking: Raw = { type: 'ref', entity: 'booking', nullable: true }): World {
  const w = structuredClone(emptyWorld('airline', 'hand')) as Raw;
  w.entities = {
    seat: { description: 'A seat on a flight.', idPrefix: 'sea', fields: { label: { type: 'string', required: true }, booking: seatBooking } },
    booking: { description: 'A passenger booking.', idPrefix: 'bkg', fields: { passenger: { type: 'string', required: true }, seat: { type: 'ref', entity: 'seat', required: true } } },
  };
  w.seed = { seat: seatSeed, booking: bookingSeed };
  return worldSchema.parse(w);
}

const SEATS = `(ctx) => [{ label: '1A', booking: 'bkg_0001' }, { label: '1B', booking: null }, { label: '1C', booking: 'bkg_0002' }]`;
const BOOKINGS = `(ctx) => [{ passenger: 'Ada', seat: ctx.rows('seat')[0].id }, { passenger: 'Grace', seat: ctx.rows('seat')[2].id }]`;

function seeded(world: World) {
  const r = seedState(world, host);
  if (!r.ok) throw new Error(`${r.issue.code}: ${r.issue.found}`);
  return r.state;
}

describe('seeding a ref cycle through a nullable ref', () => {
  it('lets a seat name the booking seeded after it, and both rows end up pointing at each other', () => {
    const state = seeded(airline(SEATS, BOOKINGS));
    const seats = [...state.tables['seat']!.values()].map((r) => [r.id, r['booking']]);
    assert.deepEqual(seats, [['sea_0001', 'bkg_0001'], ['sea_0002', null], ['sea_0003', 'bkg_0002']]);
    const bookings = [...state.tables['booking']!.values()].map((r) => [r.id, r['seat']]);
    assert.deepEqual(bookings, [['bkg_0001', 'sea_0001'], ['bkg_0002', 'sea_0003']]);
  });

  it('is deterministic: seeding twice gives the same rows', () => {
    const w = airline(SEATS, BOOKINGS);
    assert.deepEqual(JSON.stringify([...seeded(w).tables['seat']!.values()]), JSON.stringify([...seeded(w).tables['seat']!.values()]));
  });

  it('fails when a deferred ref never resolves, naming the row, the field and the ids that exist', () => {
    const twoOnOneSeat = `(ctx) => [{ passenger: 'Ada', seat: ctx.rows('seat')[0].id }, { passenger: 'Grace', seat: ctx.rows('seat')[0].id }]`;
    const r = seedState(airline(`(ctx) => [{ label: '1A', booking: 'bkg_0099' }]`, twoOnOneSeat), host);
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.issue.code, 'constraint.violation');
    assert.deepEqual(r.issue.path, ['seed', 'seat']);
    assert.match(r.issue.found, /row 0, field booking: "bkg_0099"/);
    assert.match(r.issue.found, /the seed made 2 booking rows, bkg_0001 to bkg_0002/);
  });

  it('still refuses an unresolved ref to an entity seeded earlier, and a ref that is not nullable', () => {
    const early = seedState(airline(SEATS, `(ctx) => [{ passenger: 'Ada', seat: 'sea_0042' }]`), host);
    assert.equal(early.ok, false);
    const hard = seedState(airline(`(ctx) => [{ label: '1A' }]`, `(ctx) => []`, { type: 'ref', entity: 'booking', nullable: true, required: true }), host);
    assert.equal(hard.ok, false);
  });

  it('lets a row name a later row of its own entity through a nullable self-ref', () => {
    const w = structuredClone(emptyWorld('tree', 'hand')) as Raw;
    w.entities = { node: { description: 'A tree node.', idPrefix: 'nod', fields: { name: { type: 'string', required: true }, parent: { type: 'ref', entity: 'node', nullable: true } } } };
    w.seed = { node: `(ctx) => [{ name: 'leaf', parent: 'nod_0002' }, { name: 'root', parent: null }]` };
    const rows = [...seeded(worldSchema.parse(w)).tables['node']!.values()].map((r) => [r.id, r['parent']]);
    assert.deepEqual(rows, [['nod_0001', 'nod_0002'], ['nod_0002', null]]);
  });
});

describe('check on a ref cycle with no nullable ref', () => {
  it('names every ref of the cycle and says how to relax one', () => {
    const w = airline(SEATS, BOOKINGS, { type: 'ref', entity: 'booking', required: true });
    const report: CheckReport = check(w, host);
    assert.equal(report.ok, false);
    if (report.ok) return;
    const cycle = report.issues.find((i) => i.code === 'seed.cycle');
    assert.ok(cycle !== undefined);
    assert.equal(cycle.found, 'seat -> booking -> seat');
    assert.equal(
      cycle.hint,
      'Make one of these refs nullable (nullable: true, and not required) to break seat -> booking -> seat: seat.booking, booking.seat. ' +
        'A nullable ref may name a row of an entity seeded later by its predictable id, such as the first booking id; it must resolve once every seed has run.',
    );
  });
});
