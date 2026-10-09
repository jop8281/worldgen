# WorldGen report: Stripe API (2024-06-20) customers resource: list, create, retrieve, update and delete customers

A Stripe-style customers API. Agents list customers with Stripe cursor paging (limit, starting_after, ending_before, newest first, has_more) and an email filter, create customers from a free-form set of optional fields, retrieve and update them with POST /v1/customers/{id}, and delete them, which returns Stripe's DeletedCustomer body. Errors use Stripe's invalid_request_error shape. Every 404 on a customer (retrieve, update, delete) now answers code resource_missing with message 'No such customer: <id>' and param customer. A new customer has delinquent false (not null) and currency null, as in Stripe. Charges and refunds are not mirrored because the spec subset keeps only /v1/customers. Tasks test paging, precise targeting among near-duplicate rows, and collateral-free updates and deletes.

## What was built

Entities (1):

- `customer`: 60 seeded rows

Routes (1):

- `list_customers`: GET /v1/customers

Actions (4):

- `create_customer`: POST /v1/customers
- `update_customer`: POST /v1/customers/{id}
- `delete_customer`: DELETE /v1/customers/{id}
- `get_customer`: GET /v1/customers/{id}

Jobs: none.

## Changes

- field_changed `entities.customer.fields.delinquent.default`
- field_changed `entities.customer.fields.delinquent.nullable`
- field_added `entities.customer.fields.status`
- item_removed `routes.get_customer` (destructive)
- item_added `actions.get_customer`
- item_changed `tests.create_and_retrieve_customer.description`
- snippet_changed `tests.create_and_retrieve_customer.script`
- item_added `tests.get_customer_resource_missing`

## Assumed and why

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

## Questions asked of the input

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

## Left out

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

## Proof

The engine check passed: 5 world tests, 1 warning. Each row is one engine TaskVerdict.

World id (WID): `wid_edf565274ff4f3c136cbeeb6fd76361206cc292d7d11fba57d2f5c2f8191c667`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| update_northwind_contact | easy | 1.000 | 0.000 | 0.000, 0.500, 0.000 | n/a | legacy; mutants 3/8 | `tid_33ce630311d82cfb9df466e13f7a31204cb3a7b4fac40938a99904ab161bb858` |
| delete_older_duplicate_acme | medium | 1.000 | 0.000 | 0.000, 0.000, 0.000 | n/a | legacy; mutants 2/8 | `tid_44ef0f7fd939b54d30328ca05546ed2f91c3d31d053235f5936f64211f57029e` |
| mark_registered_nonprofits_exempt | hard | 1.000 | 0.000 | 0.400, 0.000, 0.000 | 0.800 | legacy; mutants 3/8 | `tid_a6da0cab72a631250baa78ffe248ca294bd5b9be6fade670321505355e66036c` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `update_northwind_contact` 0.000: updates the lookalike customer 'Northwind Trading' instead of 'Northwind Traders'
- `update_northwind_contact` 0.500: updates only the email and forgets the phone
- `update_northwind_contact` 0.000: sets the email and phone correctly but also overwrites the description
- `delete_older_duplicate_acme` 0.000: deletes the newer Acme Corp, which comes first in the newest-first list
- `delete_older_duplicate_acme` 0.000: deletes both Acme Corp records instead of only the older one
- `delete_older_duplicate_acme` 0.000: deletes the older record and then edits the newer one's description
- `mark_registered_nonprofits_exempt` 0.400: reads only the first page of 25 customers and so misses the registered nonprofits on later pages
- `mark_registered_nonprofits_exempt` 0.000: matches any description containing 'nonprofit' and so also changes the lookalike customers
- `mark_registered_nonprofits_exempt` 0.000: sets tax_exempt on the right customers but also clears their descriptions

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| update_northwind_contact | easy | 1 | none | none | none declared |
| delete_older_duplicate_acme | medium | 1 | none | none | none declared |
| mark_registered_nonprofits_exempt | hard | 5 | customer | none | hard: met |

## Run

Mode: iterate from change_request. Model: claude-sonnet-5-5. Budget: $4.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 0.97 | 0.3202 |
| model | 2 | 0.23 | 0.3924 |
| workflow | 1 | 0.10 | 0.2766 |
| seed | 1 | 0.11 | 0.2736 |
| tasks | 1 | 0.08 | 0.2724 |
| Total | 6 | 1.49 | 1.5352 |

Run total: 1.51 minutes, $1.5352.
