/**
 * Writes prod/worlds/retail-tau2/world.yaml through checkWorld and saveWorld. The world is a hand-mapped
 * model of the tau2-bench retail domain (sierra-research/tau2-bench at commit 5bfa7e3), read from
 * research/tau2-retail-expected-behaviour.md. The seed is written by hand, not copied from tau2's db.json.
 * Usage: bun scripts/build-retail-tau2.ts [outDir]
 */
import path from 'node:path';
import { checkWorld, saveWorld } from '#engine';

const OUT = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '../../prod/worlds/retail-tau2'));

const fn = (body: string): string => `(ctx) => {\n${body.trim()}\n}\n`;

const IDS = `const ids = (s) => String(s).split(',').map((x) => x.trim()).filter((x) => x !== '');`;

const ORDER = `
const order = ctx.db.get('order', ctx.params.id);
if (order === null) ctx.fail(404, 'not_found', 'order ' + ctx.params.id + ' not found');
const lines = ctx.db.list('order_item', { where: { order_id: order.id } });
const entries = ctx.db.list('payment_entry', { where: { order_id: order.id } });
const take = (wanted) => {
  const rest = lines.slice();
  const out = [];
  for (const w of wanted) {
    const i = rest.findIndex((l) => l.variant_id === w);
    if (i < 0) ctx.fail(404, 'not_found', 'item ' + w + ' not found in order ' + order.number);
    out.push(rest[i]);
    rest.splice(i, 1);
  }
  return out;
};
const method = (id) => {
  const m = ctx.db.get('payment_method', id);
  if (m === null || m.customer_id !== order.customer_id) ctx.fail(404, 'not_found', 'payment method ' + id + ' not found');
  return m;
};
const move = (m, delta) => {
  if (m.kind === 'gift_card') ctx.db.update('payment_method', m.id, { balance: m.balance + delta });
};
const swap = (oldIds, newIds, allowSame) => {
  if (oldIds.length === 0) ctx.fail(400, 'input.invalid', 'item_ids expected at least one item id');
  if (oldIds.length !== newIds.length) ctx.fail(400, 'input.invalid', 'item_ids and new_item_ids must have the same length');
  const olds = take(oldIds);
  const news = newIds.map((id, i) => {
    const v = ctx.db.get('variant', id);
    if (v === null || v.product_id !== olds[i].product_id) ctx.fail(404, 'not_found', 'variant ' + id + ' not found for product ' + olds[i].name);
    if (!v.available) ctx.fail(409, 'unavailable', 'variant ' + id + ' is not available');
    if (!allowSame && v.id === olds[i].variant_id) ctx.fail(400, 'input.invalid', 'the new item id should be different from the old item id');
    return v;
  });
  const diff = news.reduce((sum, v, i) => sum + v.price - olds[i].price, 0);
  return { olds, news, diff };
};
`;

const ADDRESS_INPUT = {
  address1: { type: 'string', required: true },
  address2: { type: 'string', nullable: true },
  city: { type: 'string', required: true },
  state: { type: 'string', required: true },
  country: { type: 'string', required: true },
  zip: { type: 'string', required: true },
};

const addr = {
  address1: { type: 'string', required: true },
  address2: { type: 'string', nullable: true },
  city: { type: 'string', required: true },
  state: { type: 'string', required: true },
  country: { type: 'string', required: true },
  zip: { type: 'string', required: true },
};

const ORDER_STATES = ['pending', 'pending_item_modified', 'processed', 'delivered', 'cancelled', 'exchange_requested', 'return_requested'];

const entities = {
  customer: {
    description: 'A shopper. The default address is what a new order would ship to.',
    idPrefix: 'cus',
    fields: {
      first_name: { type: 'string', required: true },
      last_name: { type: 'string', required: true },
      email: { type: 'string', required: true, unique: true, format: 'email' },
      ...addr,
    },
  },
  payment_method: {
    description: 'A payment method on file: a credit card, a PayPal account or a gift card. Only gift cards hold a balance.',
    idPrefix: 'pay',
    fields: {
      customer_id: { type: 'ref', entity: 'customer', required: true },
      kind: { type: 'enum', values: ['credit_card', 'paypal', 'gift_card'], required: true },
      brand: { type: 'string', nullable: true, description: 'Card brand, for credit cards.' },
      last_four: { type: 'string', nullable: true, pattern: '^[0-9]{4}$' },
      balance: { type: 'money', currency: 'USD', min: 0, nullable: true, description: 'Gift card balance in cents. Null for other kinds.' },
    },
  },
  product: {
    description: 'A product type. A product id is not an item id: items are its variants.',
    idPrefix: 'prd',
    fields: { name: { type: 'string', required: true, unique: true } },
  },
  variant: {
    description: 'One purchasable item of a product, with its options and price. The item id in order calls is the id of a variant.',
    idPrefix: 'var',
    fields: {
      product_id: { type: 'ref', entity: 'product', required: true },
      options: { type: 'string', required: true, description: 'For example "color: blue, size: M".' },
      available: { type: 'bool', required: true },
      price: { type: 'money', currency: 'USD', min: 0, required: true },
    },
  },
  order: {
    description: 'An order. Its status moves only through the order actions.',
    idPrefix: 'ord',
    fields: {
      number: { type: 'string', required: true, unique: true, pattern: '^#W[0-9]{7}$' },
      customer_id: { type: 'ref', entity: 'customer', required: true },
      status: {
        type: 'state',
        states: ORDER_STATES,
        initial: 'pending',
        transitions: {
          pending: ['pending_item_modified', 'processed', 'cancelled'],
          pending_item_modified: ['processed'],
          processed: ['delivered'],
          delivered: ['return_requested', 'exchange_requested'],
          cancelled: [],
          exchange_requested: [],
          return_requested: [],
        },
      },
      ...addr,
      cancel_reason: { type: 'enum', values: ['no longer needed', 'ordered by mistake'], nullable: true },
      return_payment_method_id: { type: 'ref', entity: 'payment_method', nullable: true },
      exchange_payment_method_id: { type: 'ref', entity: 'payment_method', nullable: true },
      exchange_price_difference: { type: 'money', currency: 'USD', nullable: true, description: 'Cents. Negative when the new items cost less.' },
    },
  },
  order_item: {
    description: 'One line of an order: the variant bought and its price at purchase.',
    idPrefix: 'itm',
    fields: {
      order_id: { type: 'ref', entity: 'order', required: true },
      product_id: { type: 'ref', entity: 'product', required: true },
      variant_id: { type: 'ref', entity: 'variant', required: true },
      name: { type: 'string', required: true },
      price: { type: 'money', currency: 'USD', min: 0, required: true },
      options: { type: 'string', required: true },
      request: { type: 'enum', values: ['return', 'exchange'], nullable: true, description: 'Set when the line is part of a return or exchange request.' },
      exchange_variant_id: { type: 'ref', entity: 'variant', nullable: true },
    },
  },
  payment_entry: {
    description: 'One row of an order payment history: a payment or a refund against a payment method.',
    idPrefix: 'txn',
    fields: {
      order_id: { type: 'ref', entity: 'order', required: true },
      kind: { type: 'enum', values: ['payment', 'refund'], required: true },
      amount: { type: 'money', currency: 'USD', min: 0, required: true },
      payment_method_id: { type: 'ref', entity: 'payment_method', required: true },
    },
  },
};

const read = (op: 'list' | 'get', entity: string, path: string, extra: Record<string, unknown> = {}, description?: string) => ({
  op,
  entity,
  method: 'GET',
  path,
  ...extra,
  ...(description === undefined ? {} : { description }),
});

const routes = {
  list_customers: read('list', 'customer', '/customers', { filters: ['email', 'last_name', 'zip'], sort: ['last_name'] }, 'Find a customer by email, or by last_name and zip.'),
  get_customer: read('get', 'customer', '/customers/{id}'),
  list_payment_methods: read('list', 'payment_method', '/payment_methods', { filters: ['customer_id', 'kind'] }),
  list_products: read('list', 'product', '/products', { search: ['name'] }, 'The product types. Variants are the items.'),
  get_product: read('get', 'product', '/products/{id}'),
  list_variants: read('list', 'variant', '/variants', { filters: ['product_id', 'available'] }),
  get_variant: read('get', 'variant', '/variants/{id}'),
  list_orders: read('list', 'order', '/orders', { filters: ['number', 'customer_id', 'status'], sort: ['created_at'] }),
  get_order: read('get', 'order', '/orders/{id}'),
  list_order_items: read('list', 'order_item', '/order_items', { filters: ['order_id', 'variant_id'] }),
  list_payment_entries: read('list', 'payment_entry', '/payment_entries', { filters: ['order_id', 'kind'] }),
};

const METHOD_INPUT = { type: 'string', required: true, description: 'Id of a payment method of the order customer.' };
const ITEM_IDS = { type: 'string', required: true, description: 'Comma-separated variant ids as they appear in the order. List a repeated id once per unit.' };

const actions = {
  cancel_pending_order: {
    method: 'POST',
    path: '/orders/{id}/cancel',
    description: 'Cancel a pending order. Every row of its payment history is refunded to the same method, and gift cards are credited at once.',
    input: { reason: { type: 'enum', values: ['no longer needed', 'ordered by mistake'], required: true } },
    handler: fn(`${ORDER}
if (order.status !== 'pending') ctx.fail(409, 'invalid_state', 'order ' + order.number + ' is ' + order.status + '. Only pending orders can be cancelled.');
for (const e of entries) {
  ctx.db.create('payment_entry', { order_id: order.id, kind: 'refund', amount: e.amount, payment_method_id: e.payment_method_id });
  move(ctx.db.get('payment_method', e.payment_method_id), e.amount);
}
return { status: 200, body: ctx.db.update('order', order.id, { status: 'cancelled', cancel_reason: ctx.body.reason }) };`),
  },
  modify_pending_order_address: {
    method: 'POST',
    path: '/orders/{id}/address',
    description: 'Replace the shipping address of an order whose status starts with pending, which includes pending_item_modified. The status is unchanged.',
    input: ADDRESS_INPUT,
    handler: fn(`${ORDER}
if (order.status !== 'pending' && order.status !== 'pending_item_modified') ctx.fail(409, 'invalid_state', 'order ' + order.number + ' is ' + order.status + '. Only pending orders can be modified.');
const b = ctx.body;
return { status: 200, body: ctx.db.update('order', order.id, { address1: b.address1, address2: b.address2 === undefined ? null : b.address2, city: b.city, state: b.state, country: b.country, zip: b.zip }) };`),
  },
  modify_pending_order_payment: {
    method: 'POST',
    path: '/orders/{id}/payment',
    description: 'Pay a pending order with another method. Adds a payment on the new method and a refund on the old one.',
    input: { payment_method_id: METHOD_INPUT },
    handler: fn(`${ORDER}
if (order.status !== 'pending' && order.status !== 'pending_item_modified') ctx.fail(409, 'invalid_state', 'order ' + order.number + ' is ' + order.status + '. Only pending orders can be modified.');
const next = method(ctx.body.payment_method_id);
if (entries.length !== 1 || entries[0].kind !== 'payment') ctx.fail(409, 'invalid_state', 'there should be exactly one payment for a pending order');
const paid = entries[0];
if (next.id === paid.payment_method_id) ctx.fail(409, 'no_change', 'the new payment method should be different from the current one');
if (next.kind === 'gift_card' && next.balance < paid.amount) ctx.fail(409, 'insufficient_balance', 'insufficient gift card balance to pay for the order');
ctx.db.create('payment_entry', { order_id: order.id, kind: 'payment', amount: paid.amount, payment_method_id: next.id });
ctx.db.create('payment_entry', { order_id: order.id, kind: 'refund', amount: paid.amount, payment_method_id: paid.payment_method_id });
move(next, -paid.amount);
move(ctx.db.get('payment_method', paid.payment_method_id), paid.amount);
return { status: 200, body: ctx.db.get('order', order.id) };`),
  },
  modify_pending_order_items: {
    method: 'POST',
    path: '/orders/{id}/items/modify',
    description: 'Swap items of a pending order for other available variants of the same product, once. The price difference is paid or refunded through the given method. The status becomes pending_item_modified.',
    input: { item_ids: ITEM_IDS, new_item_ids: { type: 'string', required: true, description: 'Comma-separated variant ids, one per item_ids entry in the same order.' }, payment_method_id: METHOD_INPUT },
    handler: fn(`${IDS}
${ORDER}
if (order.status !== 'pending') ctx.fail(409, 'invalid_state', 'order ' + order.number + ' is ' + order.status + '. Only pending orders can be modified.');
const { olds, news, diff } = swap(ids(ctx.body.item_ids), ids(ctx.body.new_item_ids), false);
const pay = method(ctx.body.payment_method_id);
if (pay.kind === 'gift_card' && pay.balance < diff) ctx.fail(409, 'insufficient_balance', 'insufficient gift card balance to pay for the order');
if (diff > 0) ctx.db.create('payment_entry', { order_id: order.id, kind: 'payment', amount: diff, payment_method_id: pay.id });
else ctx.db.create('payment_entry', { order_id: order.id, kind: 'refund', amount: -diff, payment_method_id: pay.id });
move(pay, -diff);
news.forEach((v, i) => ctx.db.update('order_item', olds[i].id, { variant_id: v.id, price: v.price, options: v.options }));
return { status: 200, body: ctx.db.update('order', order.id, { status: 'pending_item_modified' }) };`),
  },
  return_delivered_order_items: {
    method: 'POST',
    path: '/orders/{id}/return',
    description: 'Request a return of items of a delivered order. The refund method is the original payment method or a gift card. No money moves yet.',
    input: { item_ids: ITEM_IDS, payment_method_id: METHOD_INPUT },
    handler: fn(`${IDS}
${ORDER}
if (order.status !== 'delivered') ctx.fail(409, 'invalid_state', 'order ' + order.number + ' is ' + order.status + '. Only delivered orders can be returned.');
const pay = method(ctx.body.payment_method_id);
if (pay.kind !== 'gift_card' && (entries.length === 0 || pay.id !== entries[0].payment_method_id)) ctx.fail(400, 'invalid_method', 'payment method should be the original payment method');
const wanted = ids(ctx.body.item_ids);
if (wanted.length === 0) ctx.fail(400, 'input.invalid', 'item_ids expected at least one item id');
for (const l of take(wanted)) ctx.db.update('order_item', l.id, { request: 'return' });
return { status: 200, body: ctx.db.update('order', order.id, { status: 'return_requested', return_payment_method_id: pay.id }) };`),
  },
  exchange_delivered_order_items: {
    method: 'POST',
    path: '/orders/{id}/exchange',
    description: 'Request an exchange of items of a delivered order for other available variants of the same product. The price difference is recorded on the order. No money moves yet.',
    input: { item_ids: ITEM_IDS, new_item_ids: { type: 'string', required: true, description: 'Comma-separated variant ids, one per item_ids entry in the same order.' }, payment_method_id: METHOD_INPUT },
    handler: fn(`${IDS}
${ORDER}
if (order.status !== 'delivered') ctx.fail(409, 'invalid_state', 'order ' + order.number + ' is ' + order.status + '. Only delivered orders can be exchanged.');
const { olds, news, diff } = swap(ids(ctx.body.item_ids), ids(ctx.body.new_item_ids), true);
const pay = method(ctx.body.payment_method_id);
if (pay.kind === 'gift_card' && pay.balance < diff) ctx.fail(409, 'insufficient_balance', 'insufficient gift card balance to pay for the order');
olds.forEach((l, i) => ctx.db.update('order_item', l.id, { request: 'exchange', exchange_variant_id: news[i].id }));
return { status: 200, body: ctx.db.update('order', order.id, { status: 'exchange_requested', exchange_payment_method_id: pay.id, exchange_price_difference: diff }) };`),
  },
  modify_user_address: {
    method: 'POST',
    path: '/customers/{id}/address',
    description: 'Replace the default address of a customer. Existing orders keep their own address.',
    input: ADDRESS_INPUT,
    handler: fn(`const c = ctx.db.get('customer', ctx.params.id);
if (c === null) ctx.fail(404, 'not_found', 'customer ' + ctx.params.id + ' not found');
const b = ctx.body;
return { status: 200, body: ctx.db.update('customer', c.id, { address1: b.address1, address2: b.address2 === undefined ? null : b.address2, city: b.city, state: b.state, country: b.country, zip: b.zip }) };`),
  },
};

const SEED_LOOKUPS = `
const cus = (email) => ctx.rows('customer').find((c) => c.email === email);
const pm = (email, kind) => ctx.rows('payment_method').find((m) => m.customer_id === cus(email).id && m.kind === kind);
const variant = (product, options) => {
  const p = ctx.rows('product').find((x) => x.name === product);
  return ctx.rows('variant').find((v) => v.product_id === p.id && v.options === options);
};
const orderOf = (number) => ctx.rows('order').find((o) => o.number === number);
`;

const seed = {
  product: fn(`return ['T-Shirt', 'Water Bottle', 'Desk Lamp', 'Running Shoes'].map((name) => ({ name }));`),
  variant: fn(`const p = (name) => ctx.rows('product').find((x) => x.name === name).id;
const rows = [
  ['T-Shirt', 'color: blue, size: M', true, 4850],
  ['T-Shirt', 'color: blue, size: L', true, 4925],
  ['T-Shirt', 'color: red, size: M', true, 5100],
  ['T-Shirt', 'color: red, size: L', false, 5200],
  ['Water Bottle', 'capacity: 750ml, material: steel', true, 3499],
  ['Water Bottle', 'capacity: 1000ml, material: steel', true, 3999],
  ['Water Bottle', 'capacity: 750ml, material: glass', true, 2999],
  ['Water Bottle', 'capacity: 500ml, material: plastic', false, 1499],
  ['Desk Lamp', 'color: white, power: USB', true, 5800],
  ['Desk Lamp', 'color: black, power: USB', true, 6400],
  ['Desk Lamp', 'color: white, power: battery', false, 5500],
  ['Running Shoes', 'size: 9', true, 9800],
  ['Running Shoes', 'size: 10', true, 9950],
  ['Running Shoes', 'size: 11', false, 10100],
];
return rows.map(([name, options, available, price]) => ({ product_id: p(name), options, available, price }));`),
  customer: fn(`return [
  { first_name: 'Sofia', last_name: 'Li', email: 'sofia.li4822@example.com', address1: '143 Oak Street', address2: 'Apt 4', city: 'Chicago', state: 'IL', country: 'USA', zip: '60601' },
  { first_name: 'Daiki', last_name: 'Sanchez', email: 'daiki.sanchez1479@example.com', address1: '981 Birch Road', address2: null, city: 'Indianapolis', state: 'IN', country: 'USA', zip: '46236' },
  { first_name: 'Mia', last_name: 'Garcia', email: 'mia.garcia6034@example.com', address1: '22 Harbor Way', address2: 'Suite 9', city: 'Seattle', state: 'WA', country: 'USA', zip: '98101' },
  { first_name: 'Noah', last_name: 'Patel', email: 'noah.patel7711@example.com', address1: '560 Elm Avenue', address2: null, city: 'Denver', state: 'CO', country: 'USA', zip: '80202' },
  { first_name: 'Yara', last_name: 'Cohen', email: 'yara.cohen3158@example.com', address1: '77 Pine Court', address2: 'Floor 2', city: 'Boston', state: 'MA', country: 'USA', zip: '02108' },
  { first_name: 'Aarav', last_name: 'Anderson', email: 'aarav.anderson2958@example.com', address1: '14 Lantern Row', address2: 'Apt 2', city: 'Fort Washington', state: 'PA', country: 'USA', zip: '19031' },
  { first_name: 'Lena', last_name: 'Fischer', email: 'lena.fischer5521@example.com', address1: '301 Valencia Street', address2: null, city: 'San Francisco', state: 'CA', country: 'USA', zip: '94110' },
  { first_name: 'Omar', last_name: 'Haddad', email: 'omar.haddad8047@example.com', address1: '88 Cedar Hill Road', address2: null, city: 'Dallas', state: 'TX', country: 'USA', zip: '75201' },
  { first_name: 'Priya', last_name: 'Nair', email: 'priya.nair1936@example.com', address1: '12 Willow Lane', address2: 'Unit 7', city: 'Austin', state: 'TX', country: 'USA', zip: '76171' },
  { first_name: 'Tomas', last_name: 'Novak', email: 'tomas.novak6672@example.com', address1: '640 Prairie Avenue', address2: null, city: 'Madison', state: 'WI', country: 'USA', zip: '53703' },
];`),
  payment_method: fn(`${SEED_LOOKUPS}
const card = (email, brand, last_four) => ({ customer_id: cus(email).id, kind: 'credit_card', brand, last_four, balance: null });
const gift = (email, balance) => ({ customer_id: cus(email).id, kind: 'gift_card', brand: null, last_four: null, balance });
const paypal = (email) => ({ customer_id: cus(email).id, kind: 'paypal', brand: null, last_four: null, balance: null });
return [
  card('sofia.li4822@example.com', 'visa', '8105'),
  gift('sofia.li4822@example.com', 10000),
  paypal('sofia.li4822@example.com'),
  card('daiki.sanchez1479@example.com', 'mastercard', '2231'),
  gift('daiki.sanchez1479@example.com', 1500),
  paypal('mia.garcia6034@example.com'),
  card('mia.garcia6034@example.com', 'visa', '4417'),
  gift('noah.patel7711@example.com', 20000),
  card('noah.patel7711@example.com', 'discover', '6032'),
  card('yara.cohen3158@example.com', 'amex', '1009'),
  card('aarav.anderson2958@example.com', 'visa', '3340'),
  gift('aarav.anderson2958@example.com', 1000),
  card('lena.fischer5521@example.com', 'amex', '7712'),
  card('omar.haddad8047@example.com', 'visa', '5590'),
  gift('omar.haddad8047@example.com', 500),
  card('priya.nair1936@example.com', 'mastercard', '1187'),
  gift('priya.nair1936@example.com', 3000),
  card('tomas.novak6672@example.com', 'discover', '9041'),
  gift('tomas.novak6672@example.com', 1250),
];`),
  order: fn(`${SEED_LOOKUPS}
const at = (email, number, status, extra) => {
  const c = cus(email);
  return Object.assign({ number, customer_id: c.id, status, address1: c.address1, address2: c.address2, city: c.city, state: c.state, country: c.country, zip: c.zip, cancel_reason: null, return_payment_method_id: null, exchange_payment_method_id: null, exchange_price_difference: null }, extra);
};
return [
  at('sofia.li4822@example.com', '#W4689314', 'pending', {}),
  at('sofia.li4822@example.com', '#W2201765', 'delivered', {}),
  at('daiki.sanchez1479@example.com', '#W7745160', 'pending', {}),
  at('daiki.sanchez1479@example.com', '#W1980243', 'cancelled', { cancel_reason: 'ordered by mistake' }),
  at('noah.patel7711@example.com', '#W6310952', 'processed', {}),
  at('yara.cohen3158@example.com', '#W3857026', 'delivered', {}),
  at('mia.garcia6034@example.com', '#W9024471', 'exchange_requested', { exchange_payment_method_id: pm('mia.garcia6034@example.com', 'paypal').id, exchange_price_difference: 1000 }),
  at('noah.patel7711@example.com', '#W5126838', 'return_requested', { return_payment_method_id: pm('noah.patel7711@example.com', 'gift_card').id }),
  at('yara.cohen3158@example.com', '#W8463390', 'pending_item_modified', {}),
  at('aarav.anderson2958@example.com', '#W6201943', 'delivered', {}),
  at('lena.fischer5521@example.com', '#W5018277', 'pending', {}),
  at('omar.haddad8047@example.com', '#W7159204', 'delivered', {}),
  at('priya.nair1936@example.com', '#W2634508', 'pending', {}),
  at('priya.nair1936@example.com', '#W3450281', 'delivered', {}),
  at('tomas.novak6672@example.com', '#W8827340', 'pending', {}),
];`),
  order_item: fn(`${SEED_LOOKUPS}
const line = (number, product, options, extra) => {
  const v = variant(product, options);
  return Object.assign({ order_id: orderOf(number).id, product_id: v.product_id, variant_id: v.id, name: product, price: v.price, options, request: null, exchange_variant_id: null }, extra);
};
return [
  line('#W4689314', 'T-Shirt', 'color: blue, size: M', {}),
  line('#W4689314', 'Water Bottle', 'capacity: 750ml, material: steel', {}),
  line('#W2201765', 'Desk Lamp', 'color: white, power: USB', {}),
  line('#W7745160', 'Running Shoes', 'size: 9', {}),
  line('#W1980243', 'Water Bottle', 'capacity: 1000ml, material: steel', {}),
  line('#W6310952', 'T-Shirt', 'color: blue, size: L', {}),
  line('#W3857026', 'T-Shirt', 'color: red, size: M', {}),
  line('#W3857026', 'Running Shoes', 'size: 10', {}),
  line('#W9024471', 'Water Bottle', 'capacity: 750ml, material: glass', { request: 'exchange', exchange_variant_id: variant('Water Bottle', 'capacity: 1000ml, material: steel').id }),
  line('#W5126838', 'Desk Lamp', 'color: black, power: USB', { request: 'return' }),
  line('#W8463390', 'Desk Lamp', 'color: black, power: USB', {}),
  line('#W6201943', 'T-Shirt', 'color: blue, size: M', {}),
  line('#W6201943', 'T-Shirt', 'color: blue, size: M', {}),
  line('#W5018277', 'T-Shirt', 'color: blue, size: M', {}),
  line('#W5018277', 'Water Bottle', 'capacity: 750ml, material: steel', {}),
  line('#W5018277', 'Running Shoes', 'size: 9', {}),
  line('#W7159204', 'T-Shirt', 'color: red, size: M', {}),
  line('#W7159204', 'Water Bottle', 'capacity: 1000ml, material: steel', {}),
  line('#W7159204', 'Desk Lamp', 'color: white, power: USB', {}),
  line('#W7159204', 'Running Shoes', 'size: 10', {}),
  line('#W2634508', 'Desk Lamp', 'color: white, power: USB', {}),
  line('#W3450281', 'Water Bottle', 'capacity: 750ml, material: glass', {}),
  line('#W8827340', 'T-Shirt', 'color: blue, size: M', {}),
  line('#W8827340', 'Water Bottle', 'capacity: 750ml, material: glass', {}),
];`),
  payment_entry: fn(`${SEED_LOOKUPS}
const e = (number, kind, amount, email, type) => ({ order_id: orderOf(number).id, kind, amount, payment_method_id: pm(email, type).id });
return [
  e('#W4689314', 'payment', 8349, 'sofia.li4822@example.com', 'credit_card'),
  e('#W2201765', 'payment', 5800, 'sofia.li4822@example.com', 'credit_card'),
  e('#W7745160', 'payment', 9800, 'daiki.sanchez1479@example.com', 'credit_card'),
  e('#W1980243', 'payment', 3999, 'daiki.sanchez1479@example.com', 'gift_card'),
  e('#W1980243', 'refund', 3999, 'daiki.sanchez1479@example.com', 'gift_card'),
  e('#W6310952', 'payment', 4925, 'noah.patel7711@example.com', 'credit_card'),
  e('#W3857026', 'payment', 15050, 'yara.cohen3158@example.com', 'credit_card'),
  e('#W9024471', 'payment', 2999, 'mia.garcia6034@example.com', 'paypal'),
  e('#W5126838', 'payment', 6400, 'noah.patel7711@example.com', 'gift_card'),
  e('#W8463390', 'payment', 5800, 'yara.cohen3158@example.com', 'credit_card'),
  e('#W8463390', 'payment', 600, 'yara.cohen3158@example.com', 'credit_card'),
  e('#W6201943', 'payment', 9700, 'aarav.anderson2958@example.com', 'credit_card'),
  e('#W5018277', 'payment', 18149, 'lena.fischer5521@example.com', 'credit_card'),
  e('#W7159204', 'payment', 24849, 'omar.haddad8047@example.com', 'credit_card'),
  e('#W2634508', 'payment', 5800, 'priya.nair1936@example.com', 'credit_card'),
  e('#W3450281', 'payment', 2999, 'priya.nair1936@example.com', 'credit_card'),
  e('#W8827340', 'payment', 7849, 'tomas.novak6672@example.com', 'credit_card'),
];`),
};

const TEST_PRELUDE = `
const esc = (s) => s.split('#').join('%23').split(' ').join('+');
const order = (n) => ctx.api('GET', '/orders?number=' + esc(n)).body.data[0];
const lines = (o) => ctx.api('GET', '/order_items?order_id=' + o.id).body.data;
const entries = (o) => ctx.api('GET', '/payment_entries?order_id=' + o.id).body.data;
const customer = (email) => ctx.api('GET', '/customers?email=' + esc(email)).body.data[0];
const methods = (email) => ctx.api('GET', '/payment_methods?customer_id=' + customer(email).id).body.data;
const kind = (email, k) => methods(email).find((m) => m.kind === k);
const variant = (product, options) => {
  const p = ctx.api('GET', '/products?q=' + esc(product)).body.data[0];
  return ctx.api('GET', '/variants?product_id=' + p.id).body.data.find((v) => v.options === options);
};
const post = (o, tail, body) => ctx.api('POST', '/orders/' + o.id + tail, body);
`;

const tests = {
  cancel_refunds_every_payment_row: {
    description: 'Cancelling a pending order refunds each payment row to its method. Other statuses answer 409. A second cancel answers 409.',
    script: fn(`${TEST_PRELUDE}
const o = order('#W7745160');
const r = post(o, '/cancel', { reason: 'no longer needed' });
ctx.assert(r.status === 200 && r.body.status === 'cancelled' && r.body.cancel_reason === 'no longer needed', 'cancel failed: ' + JSON.stringify(r.body));
const rows = entries(o);
ctx.assert(rows.length === 2 && rows[1].kind === 'refund' && rows[1].amount === 9800, 'expected one refund of 9800, got ' + JSON.stringify(rows));
ctx.assert(post(o, '/cancel', { reason: 'no longer needed' }).status === 409, 'second cancel should answer 409');
ctx.assert(post(order('#W2201765'), '/cancel', { reason: 'ordered by mistake' }).status === 409, 'a delivered order cannot be cancelled');
ctx.assert(post(order('#W8463390'), '/cancel', { reason: 'ordered by mistake' }).status === 409, 'pending_item_modified cannot be cancelled');
ctx.assert(post(order('#W4689314'), '/cancel', { reason: 'changed my mind' }).status >= 400, 'an unknown reason must be refused');`),
  },
  cancel_after_payment_change_over_refunds: {
    description: 'Cancel refunds every payment history row, refunds included, and credits gift cards each time (Q3).',
    script: fn(`${TEST_PRELUDE}
const o = order('#W4689314');
const gift = kind('sofia.li4822@example.com', 'gift_card');
ctx.assert(post(o, '/payment', { payment_method_id: gift.id }).status === 200, 'gift card 10000 covers 8349');
ctx.assert(kind('sofia.li4822@example.com', 'gift_card').balance === 1651, 'gift card should hold 1651');
ctx.assert(post(o, '/cancel', { reason: 'no longer needed' }).status === 200, 'cancel failed');
ctx.assert(entries(o).length === 6, 'expected one refund per history row, three payments and refunds in all six rows');
ctx.assert(kind('sofia.li4822@example.com', 'gift_card').balance === 10000, 'the gift card is credited the full amount again');`),
  },
  modify_items_with_gift_card: {
    description: 'Swapping shoes 9 for 10 pays 150 from the gift card, sets pending_item_modified and refuses a second modification.',
    script: fn(`${TEST_PRELUDE}
const o = order('#W7745160');
const gift = kind('daiki.sanchez1479@example.com', 'gift_card');
const nine = variant('Running Shoes', 'size: 9');
const ten = variant('Running Shoes', 'size: 10');
const eleven = variant('Running Shoes', 'size: 11');
ctx.assert(post(o, '/items/modify', { item_ids: nine.id, new_item_ids: eleven.id, payment_method_id: gift.id }).status === 409, 'variant 11 is unavailable');
ctx.assert(post(o, '/items/modify', { item_ids: nine.id, new_item_ids: nine.id, payment_method_id: gift.id }).status === 400, 'same item id is refused');
const r = post(o, '/items/modify', { item_ids: nine.id, new_item_ids: ten.id, payment_method_id: gift.id });
ctx.assert(r.status === 200 && r.body.status === 'pending_item_modified', 'modify failed: ' + JSON.stringify(r.body));
ctx.assert(lines(o)[0].variant_id === ten.id && lines(o)[0].price === 9950, 'the line should now be size 10');
ctx.assert(kind('daiki.sanchez1479@example.com', 'gift_card').balance === 1350, 'gift card should hold 1350');
ctx.assert(entries(o).some((e) => e.kind === 'payment' && e.amount === 150), 'a payment of 150 is missing');
ctx.assert(post(o, '/items/modify', { item_ids: ten.id, new_item_ids: nine.id, payment_method_id: gift.id }).status === 409, 'items can be modified once');`),
  },
  address_allowed_after_item_change: {
    description: 'The tau2 code guards address and payment changes with "pending" in status, so pending_item_modified orders still accept them (Q1).',
    script: fn(`${TEST_PRELUDE}
const o = order('#W8463390');
const body = { address1: '5 Quay Street', address2: null, city: 'Salem', state: 'MA', country: 'USA', zip: '01970' };
const r = post(o, '/address', body);
ctx.assert(r.status === 200 && r.body.city === 'Salem' && r.body.status === 'pending_item_modified', 'address change failed: ' + JSON.stringify(r.body));
ctx.assert(post(order('#W2201765'), '/address', body).status === 409, 'a delivered order keeps its address');
const lamp = variant('Desk Lamp', 'color: black, power: USB');
const white = variant('Desk Lamp', 'color: white, power: USB');
const card = kind('yara.cohen3158@example.com', 'credit_card');
ctx.assert(post(o, '/items/modify', { item_ids: lamp.id, new_item_ids: white.id, payment_method_id: card.id }).status === 409, 'a second item change is refused');`),
  },
  modify_payment_moves_money: {
    description: 'Changing the payment method adds a payment and a refund row and moves gift card balances. One method must differ and cover the total.',
    script: fn(`${TEST_PRELUDE}
const o = order('#W4689314');
const card = kind('sofia.li4822@example.com', 'credit_card');
const paypal = kind('sofia.li4822@example.com', 'paypal');
ctx.assert(post(o, '/payment', { payment_method_id: card.id }).status === 409, 'the same method is refused');
ctx.assert(post(o, '/payment', { payment_method_id: kind('daiki.sanchez1479@example.com', 'credit_card').id }).status === 404, 'a method of another customer is refused');
const r = post(o, '/payment', { payment_method_id: paypal.id });
ctx.assert(r.status === 200, 'payment change failed: ' + JSON.stringify(r.body));
const rows = entries(o);
ctx.assert(rows.length === 3 && rows[1].kind === 'payment' && rows[1].payment_method_id === paypal.id && rows[2].kind === 'refund' && rows[2].payment_method_id === card.id, 'expected payment then refund rows, got ' + JSON.stringify(rows));
ctx.assert(post(o, '/payment', { payment_method_id: card.id }).status === 409, 'more than one payment row is refused');`),
  },
  return_refund_method_rule: {
    description: 'A return needs a delivered order and the original method or a gift card. It moves no money (Q4).',
    script: fn(`${TEST_PRELUDE}
const o = order('#W2201765');
const lamp = variant('Desk Lamp', 'color: white, power: USB');
const paypal = kind('sofia.li4822@example.com', 'paypal');
ctx.assert(post(o, '/return', { item_ids: lamp.id, payment_method_id: paypal.id }).status === 400, 'paypal is neither the original method nor a gift card');
ctx.assert(post(o, '/return', { item_ids: 'var_9999', payment_method_id: paypal.id }).status === 400, 'the method rule comes first');
const gift = kind('sofia.li4822@example.com', 'gift_card');
ctx.assert(post(o, '/return', { item_ids: lamp.id + ',' + lamp.id, payment_method_id: gift.id }).status === 404, 'one lamp cannot be returned twice');
const r = post(o, '/return', { item_ids: lamp.id, payment_method_id: gift.id });
ctx.assert(r.status === 200 && r.body.status === 'return_requested' && r.body.return_payment_method_id === gift.id, 'return failed: ' + JSON.stringify(r.body));
ctx.assert(lines(o)[0].request === 'return', 'the line should carry the return request');
ctx.assert(kind('sofia.li4822@example.com', 'gift_card').balance === 10000, 'a return moves no money');
ctx.assert(post(order('#W4689314'), '/return', { item_ids: lamp.id, payment_method_id: gift.id }).status === 409, 'a pending order cannot be returned');`),
  },
  exchange_records_difference: {
    description: 'An exchange records the price difference and the method without moving money. It refuses other products and unavailable variants, and accepts the same variant (Q5).',
    script: fn(`${TEST_PRELUDE}
const o = order('#W3857026');
const red = variant('T-Shirt', 'color: red, size: M');
const redL = variant('T-Shirt', 'color: red, size: L');
const blue = variant('T-Shirt', 'color: blue, size: M');
const card = kind('yara.cohen3158@example.com', 'credit_card');
ctx.assert(post(o, '/exchange', { item_ids: red.id, new_item_ids: redL.id, payment_method_id: card.id }).status === 409, 'red L is unavailable');
ctx.assert(post(o, '/exchange', { item_ids: red.id, new_item_ids: variant('Desk Lamp', 'color: black, power: USB').id, payment_method_id: card.id }).status === 404, 'another product is refused');
ctx.assert(post(o, '/exchange', { item_ids: red.id + ',' + red.id, new_item_ids: blue.id, payment_method_id: card.id }).status === 400, 'lengths must match');
const r = post(o, '/exchange', { item_ids: red.id, new_item_ids: blue.id, payment_method_id: card.id });
ctx.assert(r.status === 200 && r.body.status === 'exchange_requested' && r.body.exchange_price_difference === -250 && r.body.exchange_payment_method_id === card.id, 'exchange failed: ' + JSON.stringify(r.body));
ctx.assert(entries(o).length === 1, 'an exchange writes no payment rows');
const same = order('#W2201765');
const lamp = variant('Desk Lamp', 'color: white, power: USB');
const ok = post(same, '/exchange', { item_ids: lamp.id, new_item_ids: lamp.id, payment_method_id: kind('sofia.li4822@example.com', 'credit_card').id });
ctx.assert(ok.status === 200 && ok.body.exchange_price_difference === 0, 'the same variant is accepted');`),
  },
  user_address_replaced: {
    description: 'Changing the default address of a customer leaves their orders alone. An unknown customer answers 404.',
    script: fn(`${TEST_PRELUDE}
const c = customer('mia.garcia6034@example.com');
const body = { address1: '9 Lake Drive', address2: null, city: 'Tacoma', state: 'WA', country: 'USA', zip: '98402' };
const r = ctx.api('POST', '/customers/' + c.id + '/address', body);
ctx.assert(r.status === 200 && r.body.city === 'Tacoma' && r.body.address2 === null, 'address change failed: ' + JSON.stringify(r.body));
ctx.assert(order('#W9024471').city === 'Seattle', 'the order keeps its address');
ctx.assert(ctx.api('POST', '/customers/cus_9999/address', body).status === 404, 'unknown customer');`),
  },
};

const TASK_PRELUDE = TEST_PRELUDE;

const NO_COLLATERAL = (target: string, extra: string) => `
const allowed = (c) => {
  if (c.entity === 'order' && c.id === ${target}.id) return true;
  if (c.entity === 'payment_entry' && c.kind === 'created') return ctx.db.get('payment_entry', c.id).order_id === ${target}.id;
  if (c.entity === 'order_item') return ctx.db.get('order_item', c.id).order_id === ${target}.id;
${extra}
  return false;
};
ctx.guard('only the target order, its lines and its new payment rows changed', ctx.changes().every(allowed));`;

const tasks = {
  cancel_mistaken_order: {
    difficulty: 'easy',
    instruction: 'The customer with the email sofia.li4822@example.com ordered by mistake and wants their pending order cancelled. Cancel it and give "ordered by mistake" as the reason.',
    grader: fn(`const o = ctx.seed.list('order', { where: { number: '#W4689314' } })[0];
if (!o) return 0;
${NO_COLLATERAL('o', '')}
const end = ctx.db.get('order', o.id);
ctx.goal(0.6, 'cancelled with the reason ordered by mistake', end.status === 'cancelled' && end.cancel_reason === 'ordered by mistake');
const paid = ctx.seed.list('payment_entry', { where: { order_id: o.id, kind: 'payment' } });
const refunds = ctx.db.list('payment_entry', { where: { order_id: o.id, kind: 'refund' } });
ctx.goal(0.4, 'the paid amount refunded to the original method', paid.length === 1 && refunds.length === 1 && refunds[0].amount === paid[0].amount && refunds[0].payment_method_id === paid[0].payment_method_id);
return ctx.score();`),
    solution: fn(`${TASK_PRELUDE}
const c = customer('sofia.li4822@example.com');
const pending = ctx.api('GET', '/orders?customer_id=' + c.id + '&status=pending').body.data;
ctx.assert(pending.length === 1, 'expected one pending order, found ' + pending.length);
const r = post(pending[0], '/cancel', { reason: 'ordered by mistake' });
ctx.assert(r.status === 200, 'cancel failed: ' + JSON.stringify(r.body));`),
    decoys: [
      {
        why: 'cancels with the other allowed reason, no longer needed, although the customer said it was a mistake',
        script: fn(`${TASK_PRELUDE}
const c = customer('sofia.li4822@example.com');
const pending = ctx.api('GET', '/orders?customer_id=' + c.id + '&status=pending').body.data[0];
post(pending, '/cancel', { reason: 'no longer needed' });`),
      },
    ],
  },
  exchange_lamp_with_gift_card: {
    difficulty: 'medium',
    instruction: 'Sofia Li (email sofia.li4822@example.com) received her order with the white USB desk lamp. She wants the black USB desk lamp instead and will pay the price difference with her gift card. Request the exchange.',
    grader: fn(`const o = ctx.seed.list('order', { where: { number: '#W2201765' } })[0];
if (!o) return 0;
${NO_COLLATERAL('o', '')}
const black = ctx.seed.list('variant', { where: { options: 'color: black, power: USB' } })[0];
const gift = ctx.seed.list('payment_method', { where: { kind: 'gift_card', customer_id: o.customer_id } })[0];
const end = ctx.db.get('order', o.id);
const line = ctx.db.list('order_item', { where: { order_id: o.id } })[0];
ctx.goal(0.4, 'the lamp line is marked for exchange with the black lamp', end.status === 'exchange_requested' && line.request === 'exchange' && line.exchange_variant_id === black.id);
ctx.goal(0.3, 'the exchange is paid with the gift card', end.exchange_payment_method_id === gift.id);
ctx.goal(0.3, 'the recorded price difference is 600', end.exchange_price_difference === 600);
return ctx.score();`),
    solution: fn(`${TASK_PRELUDE}
const c = customer('sofia.li4822@example.com');
const delivered = ctx.api('GET', '/orders?customer_id=' + c.id + '&status=delivered').body.data;
const white = variant('Desk Lamp', 'color: white, power: USB');
const target = delivered.find((o) => lines(o).some((l) => l.variant_id === white.id));
ctx.assert(target, 'no delivered order with the white lamp');
const black = variant('Desk Lamp', 'color: black, power: USB');
const gift = kind('sofia.li4822@example.com', 'gift_card');
const r = post(target, '/exchange', { item_ids: white.id, new_item_ids: black.id, payment_method_id: gift.id });
ctx.assert(r.status === 200, 'exchange failed: ' + JSON.stringify(r.body));`),
    decoys: [
      {
        why: 'pays the exchange difference with the credit card instead of the gift card',
        script: fn(`${TASK_PRELUDE}
const target = order('#W2201765');
const white = variant('Desk Lamp', 'color: white, power: USB');
const black = variant('Desk Lamp', 'color: black, power: USB');
post(target, '/exchange', { item_ids: white.id, new_item_ids: black.id, payment_method_id: kind('sofia.li4822@example.com', 'credit_card').id });`),
      },
      {
        why: 'returns the white lamp to the gift card instead of exchanging it',
        script: fn(`${TASK_PRELUDE}
const target = order('#W2201765');
const white = variant('Desk Lamp', 'color: white, power: USB');
post(target, '/return', { item_ids: white.id, payment_method_id: kind('sofia.li4822@example.com', 'gift_card').id });`),
      },
    ],
  },
  resize_shoes_and_move_address: {
    difficulty: 'hard',
    instruction: 'Daiki Sanchez (last name Sanchez, zip 46236) has a pending order for running shoes. They want size 10 instead of size 9, with the price difference paid from their gift card, and the shipping address of that order changed to 77 Cedar Lane, Austin, TX 78701, USA. Do both on the order.',
    grader: fn(`const o = ctx.seed.list('order', { where: { number: '#W7745160' } })[0];
if (!o) return 0;
const gift = ctx.seed.list('payment_method', { where: { kind: 'gift_card', customer_id: o.customer_id } })[0];
${NO_COLLATERAL('o', "  if (c.entity === 'payment_method') return c.id === gift.id;")}
const ten = ctx.seed.list('variant', { where: { options: 'size: 10' } })[0];
const end = ctx.db.get('order', o.id);
const line = ctx.db.list('order_item', { where: { order_id: o.id } })[0];
ctx.goal(0.25, 'the shoes line is size 10 at its price', line.variant_id === ten.id && line.price === ten.price);
ctx.goal(0.2, 'a payment of 150 on the gift card', ctx.db.list('payment_entry', { where: { order_id: o.id, kind: 'payment' } }).some((e) => e.amount === 150 && e.payment_method_id === gift.id));
ctx.goal(0.2, 'the gift card balance fell by 150', ctx.db.get('payment_method', gift.id).balance === gift.balance - 150);
ctx.goal(0.35, 'the order ships to 77 Cedar Lane, Austin', end.address1 === '77 Cedar Lane' && end.city === 'Austin' && end.state === 'TX' && end.zip === '78701' && end.country === 'USA');
return ctx.score();`),
    solution: fn(`${TASK_PRELUDE}
const found = ctx.api('GET', '/customers?last_name=Sanchez&zip=46236').body.data;
ctx.assert(found.length === 1, 'expected one customer, found ' + found.length);
const orders = ctx.api('GET', '/orders?customer_id=' + found[0].id + '&status=pending').body.data;
ctx.assert(orders.length === 1, 'expected one pending order, found ' + orders.length);
const gift = methods(found[0].email).find((m) => m.kind === 'gift_card');
const r1 = post(orders[0], '/items/modify', { item_ids: variant('Running Shoes', 'size: 9').id, new_item_ids: variant('Running Shoes', 'size: 10').id, payment_method_id: gift.id });
ctx.assert(r1.status === 200, 'item change failed: ' + JSON.stringify(r1.body));
const r2 = post(orders[0], '/address', { address1: '77 Cedar Lane', address2: null, city: 'Austin', state: 'TX', country: 'USA', zip: '78701' });
ctx.assert(r2.status === 200, 'address change failed: ' + JSON.stringify(r2.body));`),
    decoys: [
      {
        why: 'pays the size difference with the credit card instead of the gift card',
        script: fn(`${TASK_PRELUDE}
const o = order('#W7745160');
const card = kind('daiki.sanchez1479@example.com', 'credit_card');
post(o, '/items/modify', { item_ids: variant('Running Shoes', 'size: 9').id, new_item_ids: variant('Running Shoes', 'size: 10').id, payment_method_id: card.id });
post(o, '/address', { address1: '77 Cedar Lane', address2: null, city: 'Austin', state: 'TX', country: 'USA', zip: '78701' });`),
      },
      {
        why: 'changes the default address of the customer instead of the address of the order, and swaps the shoes',
        script: fn(`${TASK_PRELUDE}
const o = order('#W7745160');
const c = customer('daiki.sanchez1479@example.com');
post(o, '/items/modify', { item_ids: variant('Running Shoes', 'size: 9').id, new_item_ids: variant('Running Shoes', 'size: 10').id, payment_method_id: kind('daiki.sanchez1479@example.com', 'gift_card').id });
ctx.api('POST', '/customers/' + c.id + '/address', { address1: '77 Cedar Lane', address2: null, city: 'Austin', state: 'TX', country: 'USA', zip: '78701' });`),
      },
    ],
  },
  exchange_two_units_of_one_item: {
    difficulty: 'medium',
    instruction: 'Aarav Anderson (last name Anderson, zip 19031) received an order with two blue medium T-shirts. He wants to exchange one of them for the blue large and the other for the red medium, with the price difference paid from his gift card. Request this as one exchange on the order.',
    grader: fn(`const o = ctx.seed.list('order', { where: { number: '#W6201943' } })[0];
if (!o) return 0;
${NO_COLLATERAL('o', '')}
ctx.guard('an exchange moves no money', ctx.db.list('payment_entry', { where: { order_id: o.id } }).length === ctx.seed.list('payment_entry', { where: { order_id: o.id } }).length);
const blueL = ctx.seed.list('variant', { where: { options: 'color: blue, size: L' } })[0];
const redM = ctx.seed.list('variant', { where: { options: 'color: red, size: M' } })[0];
const gift = ctx.seed.list('payment_method', { where: { kind: 'gift_card', customer_id: o.customer_id } })[0];
const end = ctx.db.get('order', o.id);
const picked = ctx.db.list('order_item', { where: { order_id: o.id } }).filter((l) => l.request === 'exchange').map((l) => l.exchange_variant_id).sort();
ctx.goal(0.5, 'both units are exchanged, one for blue L and one for red M', end.status === 'exchange_requested' && picked.length === 2 && picked.join() === [blueL.id, redM.id].sort().join());
ctx.goal(0.25, 'the exchange is paid with the gift card', end.exchange_payment_method_id === gift.id);
ctx.goal(0.25, 'the recorded price difference is 325', end.exchange_price_difference === 325);
return ctx.score();`),
    solution: fn(`${TASK_PRELUDE}
const found = ctx.api('GET', '/customers?last_name=Anderson&zip=19031').body.data;
ctx.assert(found.length === 1, 'expected one customer, found ' + found.length);
const delivered = ctx.api('GET', '/orders?customer_id=' + found[0].id + '&status=delivered').body.data;
ctx.assert(delivered.length === 1, 'expected one delivered order, found ' + delivered.length);
const blueM = variant('T-Shirt', 'color: blue, size: M');
const gift = methods(found[0].email).find((m) => m.kind === 'gift_card');
const r = post(delivered[0], '/exchange', { item_ids: blueM.id + ',' + blueM.id, new_item_ids: variant('T-Shirt', 'color: blue, size: L').id + ',' + variant('T-Shirt', 'color: red, size: M').id, payment_method_id: gift.id });
ctx.assert(r.status === 200, 'exchange failed: ' + JSON.stringify(r.body));`),
    decoys: [
      {
        why: 'exchanges only one of the two shirts',
        script: fn(`${TASK_PRELUDE}
const o = order('#W6201943');
post(o, '/exchange', { item_ids: variant('T-Shirt', 'color: blue, size: M').id, new_item_ids: variant('T-Shirt', 'color: blue, size: L').id, payment_method_id: kind('aarav.anderson2958@example.com', 'gift_card').id });`),
      },
      {
        why: 'sends both shirts to the blue large',
        script: fn(`${TASK_PRELUDE}
const o = order('#W6201943');
const blueM = variant('T-Shirt', 'color: blue, size: M');
const blueL = variant('T-Shirt', 'color: blue, size: L');
post(o, '/exchange', { item_ids: blueM.id + ',' + blueM.id, new_item_ids: blueL.id + ',' + blueL.id, payment_method_id: kind('aarav.anderson2958@example.com', 'gift_card').id });`),
      },
    ],
  },
  modify_three_items_in_one_call: {
    difficulty: 'hard',
    instruction: 'Lena Fischer (last name Fischer, zip 94110) has a pending order with a T-shirt, a water bottle and running shoes. She wants the blue large T-shirt, the 1000ml steel bottle and the size 10 shoes, paid with her credit card. Items of an order can be changed only once, so make all three changes together.',
    grader: fn(`const o = ctx.seed.list('order', { where: { number: '#W5018277' } })[0];
if (!o) return 0;
${NO_COLLATERAL('o', '')}
const want = { 'T-Shirt': 'color: blue, size: L', 'Water Bottle': 'capacity: 1000ml, material: steel', 'Running Shoes': 'size: 10' };
const card = ctx.seed.list('payment_method', { where: { kind: 'credit_card', customer_id: o.customer_id } })[0];
const end = ctx.db.get('order', o.id);
const lines = ctx.db.list('order_item', { where: { order_id: o.id } });
for (const name of Object.keys(want)) {
  const v = ctx.seed.list('variant', { where: { options: want[name] } }).find((x) => ctx.seed.get('product', x.product_id).name === name);
  const l = lines.find((x) => x.name === name);
  ctx.goal(0.2, name + ' line is ' + want[name] + ' at its own price', l !== undefined && l.variant_id === v.id && l.price === v.price);
}
ctx.goal(0.25, 'a payment of 725 on the credit card', ctx.db.list('payment_entry', { where: { order_id: o.id, kind: 'payment' } }).some((e) => e.amount === 725 && e.payment_method_id === card.id));
ctx.goal(0.15, 'the order is pending_item_modified', end.status === 'pending_item_modified');
return ctx.score();`),
    solution: fn(`${TASK_PRELUDE}
const found = ctx.api('GET', '/customers?last_name=Fischer&zip=94110').body.data;
ctx.assert(found.length === 1, 'expected one customer, found ' + found.length);
const pending = ctx.api('GET', '/orders?customer_id=' + found[0].id + '&status=pending').body.data;
ctx.assert(pending.length === 1, 'expected one pending order, found ' + pending.length);
const card = methods(found[0].email).find((m) => m.kind === 'credit_card');
const olds = [variant('T-Shirt', 'color: blue, size: M'), variant('Water Bottle', 'capacity: 750ml, material: steel'), variant('Running Shoes', 'size: 9')];
const news = [variant('T-Shirt', 'color: blue, size: L'), variant('Water Bottle', 'capacity: 1000ml, material: steel'), variant('Running Shoes', 'size: 10')];
const r = post(pending[0], '/items/modify', { item_ids: olds.map((v) => v.id).join(','), new_item_ids: news.map((v) => v.id).join(','), payment_method_id: card.id });
ctx.assert(r.status === 200, 'item change failed: ' + JSON.stringify(r.body));`),
    decoys: [
      {
        why: 'changes the items one call at a time, so only the first change is accepted',
        script: fn(`${TASK_PRELUDE}
const o = order('#W5018277');
const card = kind('lena.fischer5521@example.com', 'credit_card');
post(o, '/items/modify', { item_ids: variant('T-Shirt', 'color: blue, size: M').id, new_item_ids: variant('T-Shirt', 'color: blue, size: L').id, payment_method_id: card.id });
post(o, '/items/modify', { item_ids: variant('Water Bottle', 'capacity: 750ml, material: steel').id, new_item_ids: variant('Water Bottle', 'capacity: 1000ml, material: steel').id, payment_method_id: card.id });
post(o, '/items/modify', { item_ids: variant('Running Shoes', 'size: 9').id, new_item_ids: variant('Running Shoes', 'size: 10').id, payment_method_id: card.id });`),
      },
      {
        why: 'changes the T-shirt and the bottle together and leaves the shoes',
        script: fn(`${TASK_PRELUDE}
const o = order('#W5018277');
post(o, '/items/modify', {
  item_ids: variant('T-Shirt', 'color: blue, size: M').id + ',' + variant('Water Bottle', 'capacity: 750ml, material: steel').id,
  new_item_ids: variant('T-Shirt', 'color: blue, size: L').id + ',' + variant('Water Bottle', 'capacity: 1000ml, material: steel').id,
  payment_method_id: kind('lena.fischer5521@example.com', 'credit_card').id,
});`),
      },
    ],
  },
  return_four_items_to_gift_card: {
    difficulty: 'medium',
    instruction: 'Omar Haddad (last name Haddad, zip 75201) wants to return all four items of his delivered order. He wants the refund on his gift card instead of the card he paid with. Return them in one request.',
    grader: fn(`const o = ctx.seed.list('order', { where: { number: '#W7159204' } })[0];
if (!o) return 0;
${NO_COLLATERAL('o', '')}
ctx.guard('a return moves no money', ctx.db.list('payment_entry', { where: { order_id: o.id } }).length === ctx.seed.list('payment_entry', { where: { order_id: o.id } }).length);
const gift = ctx.seed.list('payment_method', { where: { kind: 'gift_card', customer_id: o.customer_id } })[0];
const end = ctx.db.get('order', o.id);
const lines = ctx.db.list('order_item', { where: { order_id: o.id } });
ctx.goal(0.5, 'all four lines are in the return', end.status === 'return_requested' && lines.length === 4 && lines.every((l) => l.request === 'return'));
ctx.goal(0.5, 'the refund goes to the gift card', end.return_payment_method_id === gift.id);
return ctx.score();`),
    solution: fn(`${TASK_PRELUDE}
const found = ctx.api('GET', '/customers?last_name=Haddad&zip=75201').body.data;
ctx.assert(found.length === 1, 'expected one customer, found ' + found.length);
const delivered = ctx.api('GET', '/orders?customer_id=' + found[0].id + '&status=delivered').body.data;
ctx.assert(delivered.length === 1, 'expected one delivered order, found ' + delivered.length);
const gift = methods(found[0].email).find((m) => m.kind === 'gift_card');
const all = lines(delivered[0]).map((l) => l.variant_id).join(',');
const r = post(delivered[0], '/return', { item_ids: all, payment_method_id: gift.id });
ctx.assert(r.status === 200, 'return failed: ' + JSON.stringify(r.body));`),
    decoys: [
      {
        why: 'returns the items in two requests, so the second is refused and two items stay',
        script: fn(`${TASK_PRELUDE}
const o = order('#W7159204');
const gift = kind('omar.haddad8047@example.com', 'gift_card');
const ids = lines(o).map((l) => l.variant_id);
post(o, '/return', { item_ids: ids.slice(0, 2).join(','), payment_method_id: gift.id });
post(o, '/return', { item_ids: ids.slice(2).join(','), payment_method_id: gift.id });`),
      },
      {
        why: 'returns all four items to the original credit card',
        script: fn(`${TASK_PRELUDE}
const o = order('#W7159204');
post(o, '/return', { item_ids: lines(o).map((l) => l.variant_id).join(','), payment_method_id: kind('omar.haddad8047@example.com', 'credit_card').id });`),
      },
    ],
  },
  cancel_one_order_return_from_another: {
    difficulty: 'medium',
    instruction: 'Priya Nair (last name Nair, zip 76171) has two orders. She no longer needs her pending order, so cancel it with the reason "no longer needed". She also wants to return the water bottle from her delivered order, refunded to her gift card.',
    grader: fn(`const pending = ctx.seed.list('order', { where: { number: '#W2634508' } })[0];
const delivered = ctx.seed.list('order', { where: { number: '#W3450281' } })[0];
if (!pending || !delivered) return 0;
const allowed = (c) => {
  if (c.entity === 'order') return c.id === pending.id || c.id === delivered.id;
  if (c.entity === 'payment_entry') return c.kind === 'created' && ctx.db.get('payment_entry', c.id).order_id === pending.id;
  if (c.entity === 'order_item') return ctx.db.get('order_item', c.id).order_id === delivered.id;
  return false;
};
ctx.guard('only the two orders, the returned line and the refund rows changed', ctx.changes().every(allowed));
const gift = ctx.seed.list('payment_method', { where: { kind: 'gift_card', customer_id: pending.customer_id } })[0];
const p = ctx.db.get('order', pending.id);
const d = ctx.db.get('order', delivered.id);
const paid = ctx.seed.list('payment_entry', { where: { order_id: pending.id, kind: 'payment' } });
const refunds = ctx.db.list('payment_entry', { where: { order_id: pending.id, kind: 'refund' } });
ctx.goal(0.35, 'the pending order is cancelled as no longer needed', p.status === 'cancelled' && p.cancel_reason === 'no longer needed');
ctx.goal(0.15, 'its payment is refunded to the original method', paid.length === 1 && refunds.length === 1 && refunds[0].amount === paid[0].amount && refunds[0].payment_method_id === paid[0].payment_method_id);
ctx.goal(0.25, 'the bottle line is in a return', d.status === 'return_requested' && ctx.db.list('order_item', { where: { order_id: delivered.id } }).every((l) => l.request === 'return'));
ctx.goal(0.25, 'the return refunds the gift card', d.return_payment_method_id === gift.id);
return ctx.score();`),
    solution: fn(`${TASK_PRELUDE}
const found = ctx.api('GET', '/customers?last_name=Nair&zip=76171').body.data;
ctx.assert(found.length === 1, 'expected one customer, found ' + found.length);
const pending = ctx.api('GET', '/orders?customer_id=' + found[0].id + '&status=pending').body.data;
const delivered = ctx.api('GET', '/orders?customer_id=' + found[0].id + '&status=delivered').body.data;
ctx.assert(pending.length === 1 && delivered.length === 1, 'expected one pending and one delivered order');
const gift = methods(found[0].email).find((m) => m.kind === 'gift_card');
const r1 = post(pending[0], '/cancel', { reason: 'no longer needed' });
ctx.assert(r1.status === 200, 'cancel failed: ' + JSON.stringify(r1.body));
const r2 = post(delivered[0], '/return', { item_ids: lines(delivered[0])[0].variant_id, payment_method_id: gift.id });
ctx.assert(r2.status === 200, 'return failed: ' + JSON.stringify(r2.body));`),
    decoys: [
      {
        why: 'cancels with the reason ordered by mistake',
        script: fn(`${TASK_PRELUDE}
post(order('#W2634508'), '/cancel', { reason: 'ordered by mistake' });
const o = order('#W3450281');
post(o, '/return', { item_ids: lines(o)[0].variant_id, payment_method_id: kind('priya.nair1936@example.com', 'gift_card').id });`),
      },
      {
        why: 'returns the bottle to the gift card but never cancels the pending order',
        script: fn(`${TASK_PRELUDE}
const o = order('#W3450281');
post(o, '/return', { item_ids: lines(o)[0].variant_id, payment_method_id: kind('priya.nair1936@example.com', 'gift_card').id });`),
      },
    ],
  },
  modify_two_items_exact_gift_balance: {
    difficulty: 'hard',
    instruction: 'Tomas Novak (last name Novak, zip 53703) has a pending order with a blue medium T-shirt and a 750ml glass water bottle. He wants the red medium T-shirt and the 1000ml steel bottle, with the price difference paid from his gift card. Change both items in one request.',
    grader: fn(`const o = ctx.seed.list('order', { where: { number: '#W8827340' } })[0];
if (!o) return 0;
const gift = ctx.seed.list('payment_method', { where: { kind: 'gift_card', customer_id: o.customer_id } })[0];
${NO_COLLATERAL('o', "  if (c.entity === 'payment_method') return c.id === gift.id;")}
const want = { 'T-Shirt': 'color: red, size: M', 'Water Bottle': 'capacity: 1000ml, material: steel' };
const lines = ctx.db.list('order_item', { where: { order_id: o.id } });
for (const name of Object.keys(want)) {
  const v = ctx.seed.list('variant', { where: { options: want[name] } }).find((x) => ctx.seed.get('product', x.product_id).name === name);
  const l = lines.find((x) => x.name === name);
  ctx.goal(0.2, name + ' line is ' + want[name] + ' at its own price', l !== undefined && l.variant_id === v.id && l.price === v.price);
}
ctx.goal(0.3, 'a payment of 1250 on the gift card', ctx.db.list('payment_entry', { where: { order_id: o.id, kind: 'payment' } }).some((e) => e.amount === 1250 && e.payment_method_id === gift.id));
ctx.goal(0.15, 'the gift card is spent to zero', ctx.db.get('payment_method', gift.id).balance === 0);
ctx.goal(0.15, 'the order is pending_item_modified', ctx.db.get('order', o.id).status === 'pending_item_modified');
return ctx.score();`),
    solution: fn(`${TASK_PRELUDE}
const found = ctx.api('GET', '/customers?last_name=Novak&zip=53703').body.data;
ctx.assert(found.length === 1, 'expected one customer, found ' + found.length);
const pending = ctx.api('GET', '/orders?customer_id=' + found[0].id + '&status=pending').body.data;
ctx.assert(pending.length === 1, 'expected one pending order, found ' + pending.length);
const gift = methods(found[0].email).find((m) => m.kind === 'gift_card');
const olds = [variant('T-Shirt', 'color: blue, size: M'), variant('Water Bottle', 'capacity: 750ml, material: glass')];
const news = [variant('T-Shirt', 'color: red, size: M'), variant('Water Bottle', 'capacity: 1000ml, material: steel')];
const r = post(pending[0], '/items/modify', { item_ids: olds.map((v) => v.id).join(','), new_item_ids: news.map((v) => v.id).join(','), payment_method_id: gift.id });
ctx.assert(r.status === 200, 'item change failed: ' + JSON.stringify(r.body));`),
    decoys: [
      {
        why: 'pays the difference with the credit card although the customer asked for the gift card',
        script: fn(`${TASK_PRELUDE}
const o = order('#W8827340');
post(o, '/items/modify', {
  item_ids: variant('T-Shirt', 'color: blue, size: M').id + ',' + variant('Water Bottle', 'capacity: 750ml, material: glass').id,
  new_item_ids: variant('T-Shirt', 'color: red, size: M').id + ',' + variant('Water Bottle', 'capacity: 1000ml, material: steel').id,
  payment_method_id: kind('tomas.novak6672@example.com', 'credit_card').id,
});`),
      },
      {
        why: 'changes only the bottle with the gift card and skips the T-shirt',
        script: fn(`${TASK_PRELUDE}
const o = order('#W8827340');
post(o, '/items/modify', { item_ids: variant('Water Bottle', 'capacity: 750ml, material: glass').id, new_item_ids: variant('Water Bottle', 'capacity: 1000ml, material: steel').id, payment_method_id: kind('tomas.novak6672@example.com', 'gift_card').id });`),
      },
    ],
  },
};

const world = {
  format: 1,
  meta: {
    name: 'retail_tau2',
    description:
      'An online retail store after the tau2-bench retail domain: customers with payment methods, products with variants, and orders that can be cancelled, modified, returned or exchanged under status guards.',
    resembles: 'tau2-bench retail domain (sierra-research/tau2-bench, commit 5bfa7e3)',
    source: 'hand',
    seed: 7,
    clock: { start: '2026-03-02T09:00:00.000Z' },
  },
  entities,
  routes,
  actions,
  jobs: {},
  fixtures: {},
  seed,
  tests,
  tasks,
};

const report = checkWorld(world);
for (const w of report.warnings) process.stderr.write(`warning ${w.code} ${w.path.join('.')}: ${w.found}\n`);
if (!report.ok) {
  for (const i of report.issues) process.stderr.write(`${i.code} ${i.path.join('.')}: expected ${i.expected}, found ${i.found}. ${i.hint}\n`);
  process.exit(1);
}
await saveWorld(OUT, report.world);
process.stderr.write(`wrote ${OUT}/world.yaml\n`);
