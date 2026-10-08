# WorldGen plan: Stripe API (2024-06-20) customers resource: list, create, retrieve, update and delete customers

A Stripe-style customers API. Agents list customers with Stripe cursor paging (limit, starting_after, ending_before, newest first, has_more) and an email filter, create customers from a free-form set of optional fields, retrieve and update them with POST /v1/customers/{id}, and delete them, which returns Stripe's DeletedCustomer body. Errors use Stripe's invalid_request_error shape. Every 404 on a customer (retrieve, update, delete) now answers code resource_missing with message 'No such customer: <id>' and param customer. A new customer has delinquent false (not null) and currency null, as in Stripe. Charges and refunds are not mirrored because the spec subset keeps only /v1/customers. Tasks test paging, precise targeting among near-duplicate rows, and collateral-free updates and deletes.

- Revision: 2
- Verdict: proceed
- Clock: starts 2026-10-07T09:00:00.000Z, tick 1s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `customer` | A Stripe customer object. All profile fields are optional and nullable, as in Stripe, except delinquent, which is a non-null bool that defaults to false. currency stays null until set (create leaves it null). Created unix timestamp, balance in minor units, tax_exempt enum. object and livemode are fixed engine-set fields that mirror the Stripe response. | name, email, description, phone, invoice_prefix, balance, currency, delinquent, tax_exempt, created, object, livemode |

## Workflows

### customer_lifecycle (customer)
- States: active, deleted
- Actions: create_customer, get_customer, update_customer, delete_customer
- Rules:
  - A customer is active from creation. Every profile field is optional, so POST /v1/customers with an empty body creates a customer with balance 0, delinquent false, currency null, tax_exempt none, livemode false and object customer.
  - Update is partial: only the fields sent change, and id, created, object and livemode never change.
  - tax_exempt is one of exempt, none, reverse. Any other value is refused with 400.
  - Delete is final and removes the row: the response is {deleted: true, id, object: customer}, and afterwards retrieve, update and delete of that id answer 404 with the Stripe error body (type invalid_request_error, code resource_missing), and the list no longer returns it.
  - Retrieve, update and delete of an unknown or deleted customer id all answer 404 with code resource_missing, message 'No such customer: <id>' and param customer, so every 404 on customers uses Stripe's resource_missing. Enforced by: get_customer, update_customer, delete_customer. Tested by: get_customer_resource_missing
  - A newly created customer has delinquent false, never null, and currency null. Enforced by: create_customer. Tested by: create_and_retrieve_customer
  - Lists are newest first by created_at. A request may name starting_after or ending_before but not both (400). limit is 1 to 100, and has_more says whether older rows remain.
  - The email filter on the list is an exact match.

## Jobs

None. The plan declares no job.

## Acceptance tests

### create_and_retrieve_customer
- Intent: Creating a customer returns a Stripe-shaped customer with delinquent false and currency null, and retrieving it returns the same record. An empty body is also valid. Retrieve of an unknown id answers Stripe's resource_missing 404.
- Actions: create_customer, get_customer
- Description: POST /v1/customers returns 200 with a cus_ id, object customer, livemode false, a numeric created, the sent fields, delinquent false and currency null. GET returns the same customer. An empty create applies the defaults. GET of an unknown id answers 404 with code resource_missing and message 'No such customer: <id>'.

```js
(ctx) => {
  const r = ctx.api('POST', '/v1/customers', { name: 'Plan Test Create', email: 'create.plan@example.test', description: 'created by acceptance test', phone: '+14155550100', tax_exempt: 'reverse', balance: 500, invoice_prefix: 'PLAN' });
  ctx.assert(r.status === 200, 'create returned ' + r.status + ' ' + JSON.stringify(r.body));
  const c = r.body;
  ctx.assert(typeof c.id === 'string' && c.id.indexOf('cus_') === 0, 'id has the cus_ prefix, got ' + c.id);
  ctx.assert(c.object === 'customer' && c.livemode === false, 'object customer and livemode false, got ' + c.object + ' ' + c.livemode);
  ctx.assert(typeof c.created === 'number' && c.created > 0, 'created is a unix time number, got ' + c.created);
  ctx.assert(c.name === 'Plan Test Create' && c.email === 'create.plan@example.test' && c.phone === '+14155550100', 'sent fields stored, got ' + JSON.stringify(c));
  ctx.assert(c.tax_exempt === 'reverse' && c.balance === 500 && c.invoice_prefix === 'PLAN' && c.description === 'created by acceptance test', 'other sent fields stored, got ' + JSON.stringify(c));
  ctx.assert(c.delinquent === false, 'a new customer has delinquent false, got ' + JSON.stringify(c.delinquent));
  ctx.assert(c.currency === null, 'a new customer has currency null, got ' + JSON.stringify(c.currency));
  const g = ctx.api('GET', '/v1/customers/' + c.id);
  ctx.assert(g.status === 200 && JSON.stringify(g.body) === JSON.stringify(c), 'retrieve returns the created customer, got ' + JSON.stringify(g));
  const e = ctx.api('POST', '/v1/customers', {});
  ctx.assert(e.status === 200, 'empty create returned ' + e.status + ' ' + JSON.stringify(e.body));
  ctx.assert(e.body.name === null && e.body.email === null && e.body.balance === 0 && e.body.tax_exempt === 'none' && e.body.object === 'customer', 'empty create defaults, got ' + JSON.stringify(e.body));
  ctx.assert(e.body.delinquent === false && e.body.currency === null, 'empty create has delinquent false and currency null, got ' + JSON.stringify(e.body));
  ctx.assert(e.body.id !== c.id, 'a new row gets a new id');
  const missing = ctx.api('GET', '/v1/customers/cus_9999999');
  ctx.assert(missing.status === 404, 'unknown customer returns 404, got ' + missing.status);
  ctx.assert(missing.body.error && missing.body.error.type === 'invalid_request_error', 'Stripe error body with type invalid_request_error, got ' + JSON.stringify(missing.body));
  ctx.assert(missing.body.error.code === 'resource_missing', 'code resource_missing, got ' + JSON.stringify(missing.body));
  ctx.assert(missing.body.error.message === 'No such customer: cus_9999999', 'message names the id, got ' + JSON.stringify(missing.body));
}
```
### get_customer_resource_missing
- Intent: Retrieve answers an unknown or deleted id with the same Stripe resource_missing 404 as update and delete.
- Actions: get_customer, create_customer, delete_customer, update_customer
- Description: GET of an existing customer returns 200. GET, update and delete of an unknown id and of a deleted id all answer 404 with code resource_missing and message 'No such customer: <id>' (param customer when the error template carries it).

```js
(ctx) => {
  const c = ctx.api('POST', '/v1/customers', { name: 'Plan Test Retrieve', email: 'retrieve.plan@example.test' }).body;
  ctx.assert(c && c.id, 'setup customer created');
  const ok = ctx.api('GET', '/v1/customers/' + c.id);
  ctx.assert(ok.status === 200 && ok.body.id === c.id && ok.body.delinquent === false, 'retrieve of an existing customer, got ' + JSON.stringify(ok));
  const check = (label, res, id) => {
    ctx.assert(res.status === 404, label + ' returns 404, got ' + res.status + ' ' + JSON.stringify(res.body));
    const err = res.body && res.body.error;
    ctx.assert(err && err.type === 'invalid_request_error', label + ' has type invalid_request_error, got ' + JSON.stringify(res.body));
    ctx.assert(err.code === 'resource_missing', label + ' has code resource_missing, got ' + JSON.stringify(res.body));
    ctx.assert(err.message === 'No such customer: ' + id, label + ' message is No such customer: ' + id + ', got ' + JSON.stringify(res.body));
    ctx.assert(err.param === undefined || err.param === 'customer', label + ' param is customer when present, got ' + JSON.stringify(err.param));
  };
  check('retrieve of an unknown id', ctx.api('GET', '/v1/customers/cus_9999999'), 'cus_9999999');
  check('update of an unknown id', ctx.api('POST', '/v1/customers/cus_9999999', { name: 'Nobody' }), 'cus_9999999');
  check('delete of an unknown id', ctx.api('DELETE', '/v1/customers/cus_9999999'), 'cus_9999999');
  const d = ctx.api('DELETE', '/v1/customers/' + c.id);
  ctx.assert(d.status === 200 && d.body.deleted === true, 'delete succeeded, got ' + JSON.stringify(d));
  check('retrieve of a deleted id', ctx.api('GET', '/v1/customers/' + c.id), c.id);
  check('update of a deleted id', ctx.api('POST', '/v1/customers/' + c.id, { name: 'Zombie' }), c.id);
  check('second delete', ctx.api('DELETE', '/v1/customers/' + c.id), c.id);
}
```
### update_customer_partial
- Intent: POST on a customer id changes only the fields sent, and refuses bad enum values and unknown ids.
- Actions: create_customer, update_customer
- Description: Update changes email, description and tax_exempt, keeps name and created, refuses an invalid tax_exempt with 400 and an unknown id with 404.

```js
(ctx) => {
  const c = ctx.api('POST', '/v1/customers', { name: 'Plan Test Update', email: 'update.before@example.test', description: 'before', tax_exempt: 'none' }).body;
  ctx.assert(c && c.id, 'setup customer created');
  const r = ctx.api('POST', '/v1/customers/' + c.id, { email: 'update.after@example.test', description: 'after', tax_exempt: 'exempt' });
  ctx.assert(r.status === 200, 'update returned ' + r.status + ' ' + JSON.stringify(r.body));
  ctx.assert(r.body.id === c.id && r.body.email === 'update.after@example.test' && r.body.description === 'after' && r.body.tax_exempt === 'exempt', 'sent fields changed, got ' + JSON.stringify(r.body));
  ctx.assert(r.body.name === 'Plan Test Update' && r.body.created === c.created && r.body.object === 'customer', 'unsent fields and created are unchanged, got ' + JSON.stringify(r.body));
  const g = ctx.api('GET', '/v1/customers/' + c.id).body;
  ctx.assert(g.email === 'update.after@example.test' && g.tax_exempt === 'exempt', 'the update persisted, got ' + JSON.stringify(g));
  const bad = ctx.api('POST', '/v1/customers/' + c.id, { tax_exempt: 'bogus' });
  ctx.assert(bad.status === 400, 'invalid tax_exempt returns 400, got ' + bad.status);
  const same = ctx.api('GET', '/v1/customers/' + c.id).body;
  ctx.assert(same.tax_exempt === 'exempt', 'the refused update changed nothing, got ' + same.tax_exempt);
  const missing = ctx.api('POST', '/v1/customers/cus_9999999', { name: 'Nobody' });
  ctx.assert(missing.status === 404, 'update of an unknown id returns 404, got ' + missing.status);
  ctx.assert(missing.body.error && missing.body.error.type === 'invalid_request_error', 'Stripe error body, got ' + JSON.stringify(missing.body));
}
```
### delete_customer_removes_row
- Intent: Deleting a customer returns the DeletedCustomer body and removes it everywhere. A second delete is a 404.
- Actions: delete_customer, create_customer, update_customer
- Description: DELETE answers {deleted: true, id, object: customer}. Afterwards GET, update and the email-filtered list no longer find it, and a second DELETE answers 404. Other customers are untouched.

```js
(ctx) => {
  const a = ctx.api('POST', '/v1/customers', { name: 'Plan Test Delete', email: 'delete.plan@example.test' }).body;
  const b = ctx.api('POST', '/v1/customers', { name: 'Plan Test Keep', email: 'keep.plan@example.test' }).body;
  ctx.assert(a && a.id && b && b.id, 'setup customers created');
  const d = ctx.api('DELETE', '/v1/customers/' + a.id);
  ctx.assert(d.status === 200, 'delete returned ' + d.status + ' ' + JSON.stringify(d.body));
  ctx.assert(d.body.deleted === true && d.body.id === a.id && d.body.object === 'customer', 'DeletedCustomer body, got ' + JSON.stringify(d.body));
  const g = ctx.api('GET', '/v1/customers/' + a.id);
  ctx.assert(g.status === 404, 'retrieve after delete returns 404, got ' + g.status);
  const u = ctx.api('POST', '/v1/customers/' + a.id, { name: 'Zombie' });
  ctx.assert(u.status === 404, 'update after delete returns 404, got ' + u.status);
  const again = ctx.api('DELETE', '/v1/customers/' + a.id);
  ctx.assert(again.status === 404, 'second delete returns 404, got ' + again.status);
  ctx.assert(again.body.error && again.body.error.type === 'invalid_request_error' && again.body.error.code === 'resource_missing', 'Stripe error body with code resource_missing, got ' + JSON.stringify(again.body));
  const l = ctx.api('GET', '/v1/customers?email=delete.plan@example.test');
  ctx.assert(l.status === 200 && l.body.data.length === 0, 'the list no longer returns the deleted customer, got ' + JSON.stringify(l.body));
  const k = ctx.api('GET', '/v1/customers/' + b.id);
  ctx.assert(k.status === 200 && k.body.name === 'Plan Test Keep', 'the other customer is untouched, got ' + JSON.stringify(k));
  const none = ctx.api('DELETE', '/v1/customers/cus_9999999');
  ctx.assert(none.status === 404, 'delete of an unknown id returns 404, got ' + none.status);
}
```
### list_customers_stripe_paging
- Intent: The list returns customers newest first with has_more, starting_after and ending_before paging and an exact email filter, and refuses both cursors together.
- Actions: create_customer
- Description: Three customers created in order come back newest first. limit=2 gives the last two and has_more true. starting_after moves to the older one. ending_before moves back. The email filter returns one match. Passing both cursors is a 400.

```js
(ctx) => {
  const a = ctx.api('POST', '/v1/customers', { name: 'Plan List A', email: 'list.a@example.test' }).body;
  const b = ctx.api('POST', '/v1/customers', { name: 'Plan List B', email: 'list.b@example.test' }).body;
  const c = ctx.api('POST', '/v1/customers', { name: 'Plan List C', email: 'list.c@example.test' }).body;
  ctx.assert(a && b && c && a.id && b.id && c.id, 'setup customers created');
  const p1 = ctx.api('GET', '/v1/customers?limit=2');
  ctx.assert(p1.status === 200 && Array.isArray(p1.body.data), 'list returns a data array, got ' + JSON.stringify(p1));
  ctx.assert(p1.body.data.length === 2 && p1.body.data[0].id === c.id && p1.body.data[1].id === b.id, 'newest first: C then B, got ' + JSON.stringify(p1.body.data.map((x) => x.id)));
  ctx.assert(p1.body.has_more === true, 'has_more is true while older customers remain, got ' + p1.body.has_more);
  const p2 = ctx.api('GET', '/v1/customers?limit=1&starting_after=' + b.id);
  ctx.assert(p2.status === 200 && p2.body.data.length === 1 && p2.body.data[0].id === a.id, 'starting_after B gives A, got ' + JSON.stringify(p2.body));
  const back = ctx.api('GET', '/v1/customers?limit=1&ending_before=' + a.id);
  ctx.assert(back.status === 200 && back.body.data.length === 1 && back.body.data[0].id === b.id, 'ending_before A gives B, got ' + JSON.stringify(back.body));
  const f = ctx.api('GET', '/v1/customers?email=list.b@example.test');
  ctx.assert(f.status === 200 && f.body.data.length === 1 && f.body.data[0].id === b.id && f.body.has_more === false, 'email filter returns exactly B, got ' + JSON.stringify(f.body));
  const both = ctx.api('GET', '/v1/customers?starting_after=' + b.id + '&ending_before=' + c.id);
  ctx.assert(both.status === 400, 'both cursors are refused with 400, got ' + both.status);
  const none = ctx.api('GET', '/v1/customers?email=nobody.plan@example.test');
  ctx.assert(none.status === 200 && none.body.data.length === 0 && none.body.has_more === false, 'an email with no match returns an empty page, got ' + JSON.stringify(none.body));
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_customers` | GET | /v1/customers | List customers, newest first, Stripe paging (limit, starting_after, ending_before, has_more), with an email filter. |
| `create_customer` | POST | /v1/customers | Create a customer (built as an action). Every field is optional, as in Stripe. Accepts balance, description, email, invoice_prefix, name, phone, tax_exempt. A new customer has delinquent false and currency null. |
| `get_customer` | GET | /v1/customers/{id} | Retrieve one customer (now built as an action, not a plain get route, so the 404 can carry Stripe's code resource_missing, message 'No such customer: <id>' and param customer). |
| `update_customer` | POST | /v1/customers/{id} | Update a customer with a partial body (built as an action). Stripe uses POST for updates. |
| `delete_customer` | DELETE | /v1/customers/{id} | Delete a customer (built as an action) and answer the DeletedCustomer body {deleted: true, id, object: customer}. |

## Seed

- Rows per entity: customer: 60
- Mix: 60 customers created over the 18 months before the clock start. tax_exempt: about 55% none, 25% exempt, 20% reverse. delinquent is always true or false, never null: about 15% true, the rest false. Balance: about 60% zero, 25% positive amounts owed, 15% negative credits. About 15% have no email and about 20% have no phone. A few anchor rows: 'Northwind Traders' (plus a lookalike 'Northwind Trading'), a duplicated 'Acme Corp' pair with the same email created months apart, and about 7 customers whose description starts 'Registered nonprofit' (spread so some sit beyond the first page of 25), plus 2 lookalike descriptions such as 'Former nonprofit, now commercial'.
- State mix: 

## Tasks

- `update_northwind_contact` (easy): Set the email of the customer named 'Northwind Traders' to billing@northwindtraders.example and its phone to +14155550142, changing nothing else. A lookalike customer 'Northwind Trading' exists.
  - Decoy idea: Updates the lookalike 'Northwind Trading' (first search hit), or updates only the email and forgets the phone, or edits the description too.
- `delete_older_duplicate_acme` (medium): Two customers named 'Acme Corp' share the same email because of a double signup. Delete the older record and keep the newer one with all its data intact. Do not touch other customers.
  - Decoy idea: Deletes the newer duplicate (first in list order), deletes both, or deletes the older one and also edits the newer one.
- `mark_registered_nonprofits_exempt` (hard): Every customer whose description starts with 'Registered nonprofit' must have tax_exempt set to exempt. Some are already exempt, some sit past the first page of the list, and lookalikes such as 'Former nonprofit, now commercial' must stay unchanged.
  - Decoy idea: Reads only the first page of 25, matches any description containing 'nonprofit' and so changes the lookalikes, or sets tax_exempt on every customer with an exempt-looking name; another decoy updates the targets but also clears their descriptions.

## Open questions

- Should metadata (map<string>) be modelled?
  - Default answer: No. It is omitted because the engine has no map field type.
- Should form-encoded bodies be accepted instead of JSON?
  - Default answer: No. JSON bodies only; the world is exercised through ctx.api.
- Should delete remove the row or only mark it deleted?
  - Default answer: Remove the row. Later reads answer 404 resource_missing and the list omits it.
- Should charges and refunds be included for realism?
  - Default answer: No. The spec subset is customers only.
- Should the list expose object and url like Stripe?
  - Default answer: No. Only data and has_more, as the engine's envelope allows.
- Should the 404 on the customer list filter or other routes change too?
  - Default answer: No. The list never answers 404 for customers. Only retrieve, update and delete address a customer by id.
- Can the error body template be changed to carry param?
  - Default answer: No. Metadata is fixed in iterate. The param 'customer' is passed through ctx.fail as update and delete already do.

## Assumptions

- Only the customer entity is modelled. Charges and refunds are not built.
  - Why: The input spec keeps only the 5 /v1/customers operations and drops the other 8.
- Clock is unchanged: start 2026-10-07T09:00:00.000Z, tick 1s. All seeded customers are created before it.
  - Why: Iterate cannot change world metadata, and the 1s tick keeps newest-first order stable.
- meta.api is unchanged: list mode stripe, dataKey data, has_more, starting_after, ending_before, error template {error:{type: invalid_request_error, code: $code, message: $message}}.
  - Why: The request changes no metadata. The 404 param 'customer' is passed through ctx.fail's extra.param exactly as update_customer and delete_customer already do, so it appears wherever the existing template shows it. Acceptance tests therefore accept param absent or 'customer'.
- get_customer is rebuilt as a workflow action (GET /v1/customers/{id}) replacing the plain get route of the same id.
  - Why: A standard get route answers with the engine's row.not_found code. Only an action handler can answer resource_missing with the message 'No such customer: <id>' and param customer, so every 404 on customers uses Stripe's resource_missing.
- The get_customer action returns the stored customer row as the 200 body, identical to what the plain route returned, and takes no input.
  - Why: Retrieve output must stay unchanged apart from the 404 shape, so existing tests, tasks and solutions that read customers keep working.
- The delinquent field becomes a non-null bool with default false (nullable false, default false). create_customer does not send or set it, so new customers get false. currency stays nullable and null on create.
  - Why: Matches Stripe, where a new customer has delinquent false and currency null until a charge or subscription sets it.
- Seeded customers get delinquent true or false only, never null (about 15% true).
  - Why: The field is no longer nullable, and the seed must satisfy the model. The existing seed already planned about 15% delinquent, so the plan's counts and tasks do not change.
- Request bodies are sent as JSON through ctx.api, not form-encoded.
  - Why: The world engine validates JSON bodies. Form encoding is only a transport detail.
- Create, update and delete stay actions named create_customer, update_customer and delete_customer. List is a plain route.
  - Why: Stripe uses POST for updates and returns a DeletedCustomer body on delete, and handlers give exact control over errors.
- The path param {customer} in the spec is named {id} in the world.
  - Why: The engine requires {id} for row routes, and the spec allows different param names.
- metadata (map<string>) is left out of the entity and the inputs.
  - Why: The field types have no string-map type, and no planned task depends on it.
- The list is not wrapped with object: list or url.
  - Why: The engine's stripe list envelope carries only data and has_more.
- Seed has 60 customers and the list route page size is 25.
  - Why: Just over a page, so paging matters and tasks can place targets on later pages.
- Acceptance tests create every row through the API with example.test emails and never read seed rows. The create test is rewritten to check delinquent false, currency null and the full resource_missing error. A new test get_customer_resource_missing covers unknown and deleted ids on get, update and delete.
  - Why: The workflow stage runs the tests before any seed exists, and the new action needs a test.
- The existing tasks are unchanged.
  - Why: They use list, update and delete, and their graders do not depend on the delinquent value or the retrieve error shape.

## Out of scope

- Charges, refunds and all other Stripe resources
  - Why: The input spec dropped them (8 of 13 operations).
- metadata map, expand and other expandable fields
  - Why: There is no map field type, and the kept operations do not need them.
- Idempotency keys, API versioning headers, basic-auth enforcement, livemode switching
  - Why: They are transport and account concerns, not customer records.
- Customer sources, subscriptions, invoices, tax IDs, address and shipping
  - Why: They are not in the kept schema subset.
- Form-encoded request parsing and the object/url list envelope fields
  - Why: The engine uses JSON bodies and a fixed list envelope.
- Changing the error body template or other world metadata
  - Why: Iterate cannot change meta.
- Setting currency on create
  - Why: Stripe leaves it null until a charge or subscription sets it. The request asks to keep it null.

## Changes

- routes.get_customer
- customer.fields.delinquent
- tests.create_and_retrieve_customer
- workflows.customer_lifecycle
- seed.customer
