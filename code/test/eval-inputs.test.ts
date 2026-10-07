/**
 * The eval input files in ../eval/inputs (backlog eval-inputs), digested through digestInput.
 * E1 Stripe subset, E2 Petstore, E3 orders and customers, E4 no secrets in any input.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { INPUT_KINDS, digestInput, redact, type Input, type InputDigest } from '../src/worldgen/input.ts';

const input = (name: string): string => fileURLToPath(new URL(`../../eval/inputs/${name}`, import.meta.url));
const STRIPE = input('stripe.openapi.yaml');
const PETSTORE = input('petstore.openapi.yaml');
const ORDERS = input('orders.csv');
const CUSTOMERS = input('customers.csv');
const GIFTCARDS = input('live/giftcards.openapi.yaml');
const GYM = input('live/gym-bookings.csv');

async function digest(i: Input): Promise<InputDigest> {
  const r = await digestInput(i);
  if (!r.ok) throw new Error(r.why);
  return r.digest;
}

const opLines = (d: InputDigest): string[] => d.summary.split('\n').filter((l) => /^[A-Z]+ \//.test(l));

describe('eval inputs: stripe.openapi.yaml', () => {
  it('E1 narrowed to /v1/refunds keeps only refund operations', async () => {
    const d = await digest({ kind: 'openapi', path: STRIPE, only: ['/v1/refunds'] });
    assert.deepEqual(opLines(d), [
      'GET /v1/refunds: List all refunds',
      'POST /v1/refunds: Create a refund',
      'GET /v1/refunds/{refund}: Retrieve a refund',
      'POST /v1/refunds/{refund}: Update a refund',
      'POST /v1/refunds/{refund}/cancel: Cancel a refund',
    ]);
    assert.equal(d.summary.includes('Operations: kept 5 of 13 under /v1/refunds; dropped 8.'), true);
    assert.deepEqual(d.observations.map((o) => `${o.method} ${o.path} ${o.status}`), ['GET /v1/refunds 200']);
  });

  it('E1 the list envelope and shared $ref error schema become meta.api', async () => {
    const d = await digest({ kind: 'openapi', path: STRIPE, only: ['/v1/refunds'] });
    assert.deepEqual(d.apiShape, {
      list: { mode: 'stripe', dataKey: 'data', cursorKey: 'next_cursor', limitParam: 'limit', cursorParam: 'cursor', hasMoreKey: 'has_more', startingAfterParam: 'starting_after', endingBeforeParam: 'ending_before' },
      error: { error: { type: 'invalid_request_error', code: '$code', message: '$message' } },
    });
    assert.equal(d.summary.includes('Error schema: Error, used by 5 of 5 error responses.'), true);
    assert.equal(d.summary.includes('List envelope: data array with has_more (boolean, so stripe paging), shared by 1 list operation.'), true);
  });

  it('E1 the whole file has charges, refunds and customers with list, get and create, plus updates and a delete', async () => {
    const d = await digest({ kind: 'openapi', path: STRIPE, only: [] });
    assert.deepEqual(opLines(d), [
      'GET /v1/charges: List all charges',
      'POST /v1/charges: Create a charge',
      'GET /v1/charges/{charge}: Retrieve a charge',
      'GET /v1/refunds: List all refunds',
      'POST /v1/refunds: Create a refund',
      'GET /v1/refunds/{refund}: Retrieve a refund',
      'POST /v1/refunds/{refund}: Update a refund',
      'POST /v1/refunds/{refund}/cancel: Cancel a refund',
      'GET /v1/customers: List all customers',
      'POST /v1/customers: Create a customer',
      'GET /v1/customers/{customer}: Retrieve a customer',
      'POST /v1/customers/{customer}: Update a customer',
      'DELETE /v1/customers/{customer}: Delete a customer',
    ]);
    assert.equal(d.summary.includes('List envelope: data array with has_more (boolean, so stripe paging), shared by 3 list operations.'), true);
  });

  it('E1 narrowed to /v1/customers keeps the customer operations with the same envelopes as refunds', async () => {
    const d = await digest({ kind: 'openapi', path: STRIPE, only: ['/v1/customers'] });
    assert.deepEqual(opLines(d), [
      'GET /v1/customers: List all customers',
      'POST /v1/customers: Create a customer',
      'GET /v1/customers/{customer}: Retrieve a customer',
      'POST /v1/customers/{customer}: Update a customer',
      'DELETE /v1/customers/{customer}: Delete a customer',
    ]);
    assert.equal(d.summary.includes('Operations: kept 5 of 13 under /v1/customers; dropped 8.'), true);
    assert.equal(d.summary.includes('  DeletedCustomer: deleted enum(true) required, id string required, object enum(customer) required'), true);
    assert.deepEqual(d.apiShape, {
      list: { mode: 'stripe', dataKey: 'data', cursorKey: 'next_cursor', limitParam: 'limit', cursorParam: 'cursor', hasMoreKey: 'has_more', startingAfterParam: 'starting_after', endingBeforeParam: 'ending_before' },
      error: { error: { type: 'invalid_request_error', code: '$code', message: '$message' } },
    });
    assert.deepEqual(d.observations.map((o) => `${o.method} ${o.path} ${o.status}`), ['POST /v1/customers 200']);
  });
});

describe('eval inputs: petstore.openapi.yaml', () => {
  it('E2 is OpenAPI 3.0 and narrows to /store/orders', async () => {
    const d = await digest({ kind: 'openapi', path: PETSTORE, only: ['/store/orders'] });
    assert.equal(d.summary.split('\n')[0], 'OpenAPI 3.0.3: Swagger Petstore - OpenAPI 3.0, version 1.0.19');
    assert.deepEqual(opLines(d), [
      'POST /store/orders: Place an order for a pet',
      'GET /store/orders/{orderId}: Find purchase order by ID',
      'DELETE /store/orders/{orderId}: Delete purchase order by ID',
    ]);
    assert.deepEqual(d.apiShape?.error, { code: '$status', type: '$code', message: '$message' });
  });
});

describe('eval inputs: orders.csv and customers.csv', () => {
  it('E3 orders.customer_id is inferred as a ref to customers', async () => {
    const d = await digest({ kind: 'csv', paths: [ORDERS, CUSTOMERS] });
    assert.equal(d.summary.split('\n').find((l) => l.startsWith('  customer_id: ')), '  customer_id: ref(customers.id), null 0.00, 18 distinct, e.g. "cus_0010"');
    assert.equal(d.summary.split('\n').find((l) => l.startsWith('  status: ')), '  status: enum(pending|paid|shipped|delivered|cancelled|refunded), null 0.00, 6 distinct');
  });

  it('E3 sizes and statuses, and every orders.customer_id exists in customers', async () => {
    const d = await digest({ kind: 'csv', paths: [ORDERS, CUSTOMERS] });
    const orders = d.fixtures.orders ?? [];
    const customers = d.fixtures.customers ?? [];
    assert.equal(orders.length, 72);
    assert.equal(customers.length, 18);
    assert.deepEqual([...new Set(orders.map((o) => o.status))].sort(), ['cancelled', 'delivered', 'paid', 'pending', 'refunded', 'shipped']);
    const ids = new Set(customers.map((c) => c.id));
    assert.deepEqual(orders.filter((o) => !ids.has(o.customer_id ?? null)).map((o) => o.id), []);
  });
});

describe('eval inputs: the live segment in live/', () => {
  it('E5 giftcards.openapi.yaml narrowed to /v1/gift_cards keeps the 8 card operations and drops merchants and payouts', async () => {
    const d = await digest({ kind: 'openapi', path: GIFTCARDS, only: ['/v1/gift_cards'] });
    assert.deepEqual(opLines(d), [
      'GET /v1/gift_cards: List gift cards',
      'POST /v1/gift_cards: Create a gift card',
      'GET /v1/gift_cards/{gift_card}: Retrieve a gift card',
      "GET /v1/gift_cards/{gift_card}/activities: List a gift card's activities",
      'POST /v1/gift_cards/{gift_card}/activities: Load, redeem, refund or adjust a gift card',
      'POST /v1/gift_cards/{gift_card}/freeze: Freeze an active gift card',
      'POST /v1/gift_cards/{gift_card}/unfreeze: Unfreeze a frozen gift card',
      'POST /v1/gift_cards/{gift_card}/deactivate: Deactivate a gift card for good',
    ]);
    assert.equal(d.summary.includes('Operations: kept 8 of 10 under /v1/gift_cards; dropped 2.'), true);
    assert.deepEqual(d.apiShape?.error, { error: { code: '$code', message: '$message' } });
  });

  it('E5 gym-bookings.csv has 155 bookings in 16 classes, no class over capacity, a waitlist only on a full class, and nothing open on a class that already ran', async () => {
    const d = await digest({ kind: 'csv', paths: [GYM] });
    const rows = d.fixtures.gym_bookings ?? [];
    assert.equal(rows.length, 155);
    assert.deepEqual([...new Set(rows.map((r) => r.status))].sort(), ['attended', 'booked', 'cancelled', 'no_show', 'waitlisted']);
    const seated = new Map<string, number>();
    for (const r of rows) if (['booked', 'attended', 'no_show'].includes(String(r.status))) seated.set(String(r.class_id), (seated.get(String(r.class_id)) ?? 0) + 1);
    const capacity = new Map(rows.map((r) => [String(r.class_id), Number(r.capacity)]));
    assert.equal(capacity.size, 16);
    assert.deepEqual([...capacity].filter(([c, cap]) => (seated.get(c) ?? 0) > cap), []);
    const waitlisted = [...new Set(rows.filter((r) => r.status === 'waitlisted').map((r) => String(r.class_id)))].sort();
    assert.deepEqual(waitlisted, ['C006', 'C014']);
    assert.deepEqual(waitlisted.map((c) => seated.get(c) === capacity.get(c)), [true, true]);
    const open = rows.filter((r) => (r.status === 'booked' || r.status === 'waitlisted') && String(r.starts_at) < '2026-10-07T06:00:00Z');
    assert.deepEqual(open.map((r) => r.booking_id), []);
  });
});

describe('eval inputs: no secrets', () => {
  it('E4 redaction leaves every loaded input unchanged', async () => {
    for (const path of [STRIPE, PETSTORE, GIFTCARDS]) {
      const loaded = await INPUT_KINDS.openapi.load({ kind: 'openapi', path, only: [] });
      assert.deepEqual(redact('openapi', loaded), loaded, path);
    }
    for (const paths of [[ORDERS, CUSTOMERS], [GYM]]) {
      const loaded = await INPUT_KINDS.csv.load({ kind: 'csv', paths });
      assert.deepEqual(redact('csv', loaded), loaded, paths.join());
    }
  });

  it('E4 no line of any input matches a text redaction pattern', async () => {
    for (const path of [STRIPE, PETSTORE, ORDERS, CUSTOMERS, GIFTCARDS, GYM]) {
      const lines = (await readFile(path, 'utf8')).split('\n');
      // Chunks of whole lines below the 8000-char digest cut, so redact sees multi-line context.
      const chunks: string[] = [];
      for (const l of lines) {
        if (chunks.length === 0 || chunks.at(-1)!.length + l.length > 6000) chunks.push(l);
        else chunks[chunks.length - 1] += `\n${l}`;
      }
      for (const chunk of chunks.filter((c) => c.trim() !== '')) assert.equal(redact('description', { text: chunk }).text, chunk.trim(), path);
    }
  });
});
