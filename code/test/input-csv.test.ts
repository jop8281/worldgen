/**
 * The csv input kind (backlog wg-input-csv). C1..C5 follow its acceptance list:
 * C1 RFC 4180 load and table names, C2 summary, C3 fixtures, C4 redaction, C5 the orders/customers fixtures.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INPUT_KINDS, digestInput, parseCsv, redact, type InputDigest, type LoadedKinds } from '../src/worldgen/input.ts';

const fixture = (name: string): string => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const ORDERS = fixture('orders.csv');
const CUSTOMERS = fixture('customers.csv');

async function digestFiles(paths: string[], note?: string): Promise<InputDigest> {
  const r = await digestInput(note === undefined ? { kind: 'csv', paths } : { kind: 'csv', paths, note });
  if (!r.ok) throw new Error(r.why);
  return r.digest;
}

/** Digests inline tables the way digestInput does after load. */
const digestTables = (tables: LoadedKinds['csv']['tables'], note: string | null = null): InputDigest => INPUT_KINDS.csv.digest(redact('csv', { tables, note }));

async function tempDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wg-csv-'));
  for (const [name, content] of Object.entries(files)) await writeFile(join(dir, name), content);
  return dir;
}

const line = (d: InputDigest, column: string): string | undefined => d.summary.split('\n').find((l) => l.startsWith(`  ${column}: `));

describe('csv parse (RFC 4180)', () => {
  it('C1 quoted fields hold commas, escaped quotes and newlines', () => {
    assert.deepEqual(parseCsv('a,b,c\n1,"x, y","say ""hi"""\n2,"line1\nline2",\n', 'f.csv'), [
      ['a', 'b', 'c'],
      ['1', 'x, y', 'say "hi"'],
      ['2', 'line1\nline2', ''],
    ]);
  });

  it('C1 CRLF, a BOM, blank lines and a last record without a newline', () => {
    assert.deepEqual(parseCsv('﻿id,name\r\n1,Ada\r\n\r\n2,"Grace\r\nHopper"\r\n3,Alan', 'f.csv'), [
      ['id', 'name'],
      ['1', 'Ada'],
      ['2', 'Grace\r\nHopper'],
      ['3', 'Alan'],
    ]);
  });

  it('C1 a quote inside an unquoted field is literal, and an empty quoted field is empty', () => {
    assert.deepEqual(parseCsv('a,b\n5" pipe,""\n', 'f.csv'), [['a', 'b'], ['5" pipe', '']]);
  });

  it('C1 an unclosed quote and a wrong field count throw with the line', () => {
    assert.throws(() => parseCsv('a,b\n1,"open\n2,3\n', 'f.csv'), { message: 'f.csv: the quoted field opened on line 2 is never closed.' });
    assert.throws(() => parseCsv('a,b\n1,"two\nlines"\n1,2,3\n', 'f.csv'), { message: 'f.csv line 4: 3 fields, the header has 2.' });
  });
});

describe('csv load', () => {
  it('C1 loads several files; table and column names are snake_case', async () => {
    const dir = await tempDir({ 'Customer Orders.csv': 'Order ID,Total Cents,Order ID\nA1,5,x\n', 'OrderItems.csv': 'id,Prénom,\n1,Zoë,\n' });
    const loaded = await INPUT_KINDS.csv.load({ kind: 'csv', paths: [join(dir, 'Customer Orders.csv'), join(dir, 'OrderItems.csv')], note: 'two tables' });
    assert.deepEqual(loaded, {
      tables: [
        { name: 'customer_orders', header: ['order_id', 'total_cents', 'order_id_2'], rows: [['A1', '5', 'x']] },
        { name: 'order_items', header: ['id', 'prenom', 'column_3'], rows: [['1', 'Zoë', '']] },
      ],
      note: 'two tables',
    });
  });

  it('C1 refuses a missing file, an empty file and two files with one table name', async () => {
    assert.deepEqual(await digestInput({ kind: 'csv', paths: ['/nonexistent/orders.csv'] }), { ok: false, why: 'Cannot read CSV file /nonexistent/orders.csv (ENOENT).' });
    const dir = await tempDir({ 'empty.csv': '\n\n', 'a.csv': 'id\n1\n', 'A.CSV': 'id\n2\n' });
    assert.deepEqual(await digestInput({ kind: 'csv', paths: [join(dir, 'empty.csv')] }), { ok: false, why: `${join(dir, 'empty.csv')} is empty.` });
    assert.deepEqual(await digestInput({ kind: 'csv', paths: [join(dir, 'a.csv'), join(dir, 'A.CSV')] }), { ok: false, why: 'Two CSV files map to the table name a. Rename one.' });
  });
});

describe('csv digest', () => {
  it('C2 C5 the orders and customers fixture summary', async () => {
    assert.equal((await digestFiles([ORDERS, CUSTOMERS], 'An online shop.')).summary, [
      'CSV: 2 tables (orders, customers). Fixtures keep up to 2000 rows per table.',
      'Note: An online shop.',
      'Table orders: 36 rows, key id',
      '  id: string, null 0.00, 36 distinct, key, e.g. "ord_0001"',
      '  customer_id: ref(customers.id), null 0.00, 12 distinct, e.g. "cus_0001"',
      '  status: enum(pending|paid|shipped|delivered|cancelled|refunded), null 0.00, 6 distinct',
      '  total_cents: int, null 0.00, 36 distinct, key, e.g. "11800"',
      '  currency: enum(USD), null 0.00, 1 distinct',
      '  item_count: int, null 0.00, 5 distinct, e.g. "5"',
      '  placed_at: datetime, null 0.00, 36 distinct, key, from "2026-01-13T10:00:00Z" to "2026-02-20T18:05:00Z"',
      '  shipped_at: datetime, null 0.50, 18 distinct, from "2026-01-16T14:00:00Z" to "2026-02-20T14:00:00Z"',
      '  note: enum("Call \\"before\\" delivery"|"Two lines:\\nleave with the neighbour, flat 2"|Fragile: glassware, handle with care|Gift wrap, no receipt|Leave at the front desk|Back door, ring twice), null 0.75, 6 distinct',
      'Table customers: 12 rows, key id',
      '  id: string, null 0.00, 12 distinct, key, e.g. "cus_0001"',
      '  name: string, null 0.00, 12 distinct, key, e.g. "Ada Lovelace"',
      '  email: string, null 0.00, 12 distinct, key, e.g. "ada.lovelace@example.com"',
      '  country: string, null 0.00, 5 distinct, e.g. "CA"',
      '  plan: string, null 0.00, 3 distinct, e.g. "free"',
      '  created_at: datetime, null 0.00, 12 distinct, key, from "2026-01-01T09:00:00Z" to "2026-01-12T12:00:00Z"',
    ].join('\n'));
  });

  it('C2 a time column shows its earliest and latest cell, not its first row', async () => {
    const dir = await tempDir({ 'loans.csv': 'id,returned_at\nL1,2026-03-01T00:00:00Z\nL2,\nL3,2026-01-05T09:00:00.000Z\nL4,2026-09-30T21:00:00Z\n' });
    const d = await digestFiles([join(dir, 'loans.csv')]);
    assert.equal(line(d, 'returned_at'), '  returned_at: datetime, null 0.25, 3 distinct, from "2026-01-05T09:00:00.000Z" to "2026-09-30T21:00:00Z"');
  });

  it('C5 orders.customer_id is inferred as a ref to customers whatever the file order', async () => {
    const d = await digestFiles([CUSTOMERS, ORDERS]);
    assert.equal(line(d, 'customer_id'), '  customer_id: ref(customers.id), null 0.00, 12 distinct, e.g. "cus_0001"');
    assert.deepEqual(d.observations, []);
    assert.equal(d.apiShape, null);
  });

  it('C2 integer keys need a name that points at the table; a count column is not a ref', () => {
    const ids = Array.from({ length: 12 }, (_, i) => String(i + 1));
    const d = digestTables([
      { name: 'customers', header: ['id', 'name'], rows: ids.map((id) => [id, `n${id}`]) },
      { name: 'orders', header: ['id', 'customer', 'quantity'], rows: Array.from({ length: 30 }, (_, i) => [String(100 + i), String((i % 12) + 1), String((i % 5) + 1)]) },
    ]);
    assert.equal(line(d, 'customer'), '  customer: ref(customers.id), null 0.00, 12 distinct, e.g. "1"');
    assert.equal(line(d, 'quantity'), '  quantity: int, null 0.00, 5 distinct, e.g. "1"');
  });

  it('C2 a ref needs at least 95% of filled values to match the key', () => {
    const keys = Array.from({ length: 20 }, (_, i) => [`acct_${i}`]);
    const refs = (misses: number): string[][] => Array.from({ length: 20 }, (_, i) => [i < misses ? `zz_${i}` : `acct_${i}`, '']);
    const at95 = digestTables([{ name: 'accounts', header: ['id'], rows: keys }, { name: 'events', header: ['account_id', 'memo'], rows: refs(1) }]);
    assert.equal(line(at95, 'account_id'), '  account_id: ref(accounts.id, 95% match), null 0.00, 20 distinct, key, e.g. "zz_0"');
    assert.equal(line(at95, 'memo'), '  memo: empty, null 1.00, 0 distinct');
    const at90 = digestTables([{ name: 'accounts', header: ['id'], rows: keys }, { name: 'events', header: ['account_id', 'memo'], rows: refs(2) }]);
    assert.equal(line(at90, 'account_id'), '  account_id: string, null 0.00, 20 distinct, key, e.g. "zz_0"');
  });
});

describe('csv fixtures', () => {
  it('C3 every row is converted to Values of the inferred types', async () => {
    const d = await digestFiles([ORDERS, CUSTOMERS]);
    assert.equal(d.fixtures.orders?.length, 36);
    assert.equal(d.fixtures.customers?.length, 12);
    assert.deepEqual(d.fixtures.orders?.[3], {
      id: 'ord_0004',
      customer_id: 'cus_0011',
      status: 'delivered',
      total_cents: 10149,
      currency: 'USD',
      item_count: 1,
      placed_at: '2026-01-16T13:21:00.000Z',
      shipped_at: '2026-01-17T14:00:00.000Z',
      note: 'Two lines:\nleave with the neighbour, flat 2',
    });
    assert.deepEqual(d.fixtures.orders?.[0]?.shipped_at, null);
  });

  it('C3 bool, number and text cells convert; blank cells are null', () => {
    const long = 'x'.repeat(250);
    const d = digestTables([{ name: 'items', header: ['id', 'active', 'weight', 'body'], rows: [['a', 'true', '1.5', long], ['b', 'false', '', 'short']] }]);
    assert.deepEqual(d.fixtures.items, [
      { id: 'a', active: true, weight: 1.5, body: long },
      { id: 'b', active: false, weight: null, body: 'short' },
    ]);
    assert.equal(line(d, 'body'), `  body: text, null 0.00, 2 distinct, key, e.g. "${'x'.repeat(40)}..."`);
  });

  it('C3 fixtures are capped at 2000 rows per table; the summary counts every row', () => {
    const rows = Array.from({ length: 2100 }, (_, i) => [`r${i}`]);
    const d = digestTables([{ name: 'big', header: ['id'], rows }]);
    assert.equal(d.fixtures.big?.length, 2000);
    assert.deepEqual(d.fixtures.big?.[1999], { id: 'r1999' });
    assert.equal(d.summary.split('\n')[1], 'Table big: 2100 rows (fixtures keep 2000), key id');
  });
});

describe('csv redact', () => {
  /** A deliberate redaction-test value, written by this test only. */
  const TOKEN = 'tok_REDACTION_TEST_c5v1';
  const STRIPE_SHAPED = 'sk_test_REDACTIONTEST1234';

  it('C4 a token never reaches the digest or the fixtures', async () => {
    const dir = await tempDir({
      'users.csv': `id,email,api_key,password,auth_token,notes\nu1,ada@example.com,${TOKEN},${TOKEN},${TOKEN},key ${STRIPE_SHAPED} here\nu2,bob@example.com,,,,plain\n`,
    });
    const d = await digestFiles([join(dir, 'users.csv')]);
    const json = JSON.stringify(d);
    assert.equal(json.includes(TOKEN), false);
    assert.equal(json.includes(STRIPE_SHAPED), false);
    assert.deepEqual(d.fixtures.users, [
      { id: 'u1', email: 'ada@example.com', api_key: '[redacted]', password: '[redacted]', auth_token: '[redacted]', notes: 'key [redacted] here' },
      { id: 'u2', email: 'bob@example.com', api_key: null, password: null, auth_token: null, notes: 'plain' },
    ]);
    assert.equal(line(d, 'api_key'), '  api_key: string, null 0.50, 1 distinct, e.g. "[redacted]"');
  });

  it('C4 credential column names are matched by word, so passenger_count and author survive', () => {
    const out = redact('csv', {
      tables: [{ name: 'trips', header: ['passenger_count', 'author', 'session_id', 'X-Api-Key', 'clientSecret'], rows: [['3', 'Ada', 's1', 'k1', 'c1']] }],
      note: 'password=hunter2',
    });
    assert.deepEqual(out, {
      tables: [{ name: 'trips', header: ['passenger_count', 'author', 'session_id', 'X-Api-Key', 'clientSecret'], rows: [['3', 'Ada', '[redacted]', '[redacted]', '[redacted]']] }],
      note: 'password=[redacted]',
    });
  });
});
