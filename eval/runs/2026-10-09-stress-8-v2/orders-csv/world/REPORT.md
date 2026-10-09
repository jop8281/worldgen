# WorldGen report: Shopify-style order desk (orders and customers API)

An order desk with customers and orders. Orders move through pending, paid, shipped, delivered, and can be cancelled before shipping or refunded after payment. The imported CSV fixtures (18 customers, 72 orders) are kept exactly.

## What was built

Entities (2):

- `customer`: 18 seeded rows
- `order`: 72 seeded rows

Routes (8):

- `list_orders`: GET /orders
- `get_order`: GET /orders/{id}
- `create_order`: POST /orders
- `update_order`: PATCH /orders/{id}
- `list_customers`: GET /customers
- `get_customer`: GET /customers/{id}
- `create_customer`: POST /customers
- `update_customer`: PATCH /customers/{id}

Actions (5):

- `pay_order`: POST /orders/{id}/pay
- `ship_order`: POST /orders/{id}/ship
- `deliver_order`: POST /orders/{id}/deliver
- `cancel_order`: POST /orders/{id}/cancel
- `refund_order`: POST /orders/{id}/refund

Jobs: none.

## Assumed and why

- clock.start is 2026-04-08T09:00:00Z with tick 0s
  - Why: The latest imported event is shipped_at 2026-04-07T14:00:00Z, so the start is after all history. Time moves only when explicitly advanced.
- Order status is a state field with transitions pending->paid|cancelled, paid->shipped|cancelled|refunded, shipped->delivered|refunded, delivered->refunded; cancelled and refunded are final
  - Why: This is the standard order lifecycle implied by the CSV status enum.
- Status and shipped_at are readonly on standard routes and change only through actions
  - Why: Keeps the workflow rules from being bypassed by a plain PATCH.
- Money is USD cents (total_cents), and currency is fixed to USD
  - Why: The CSV has one currency value.
- stateMix is an approximately even split across the six statuses
  - Why: The exact per-status counts come from the fixture, which is kept unchanged; the mix is a rough share within tolerance (shipped_at is set on 44% of rows).
- ship_order sets shipped_at to the engine time
  - Why: The CSV has shipped_at only for shipped orders.
- Refunds are full refunds that change only the status
  - Why: The CSV has no refund amount field.
- Acceptance tests create their own customers and orders with emails under plan-test.example.org
  - Why: The tests run before the seed exists and must not collide with seed values.

## Fields not in the input

None. The input names every field.

## Questions asked of the input

- Can an order be cancelled after it has shipped?
  - Default answer: No. Cancel is allowed only from pending or paid; after that use refund.
- Should a refund be allowed on a pending order?
  - Default answer: No. Refund needs a paid, shipped or delivered order; a pending order is cancelled instead.
- Is shipped_at set by the client or by the system?
  - Default answer: By the system when ship_order runs.
- Do refunds change the total or only the status?
  - Default answer: Only the status; refunds are full.

## Left out

- Payment processing, payment gateways and card data
  - Why: The world only records state; pay_order just marks an order paid.
- Line items, inventory, shipping carriers and tracking
  - Why: The CSV only has an item_count and shipped_at.
- Partial refunds, multiple currencies and taxes
  - Why: The CSV has no fields for them.
- Deleting customers or orders
  - Why: Order history must stay intact.

## Proof

The engine check passed: 5 world tests, 1 warning. Each row is one engine TaskVerdict.

World id (WID): `wid_471c1420cf1e8397e0d8e78ec0e94394561c9ee8b84241ff3d19d74d47dda0e9`.

Paging exemptions:

- `customer` fits on one page (18 rows), but its rows come from the input's fixtures, so the input sets its size and no task is held to paging on it.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| ship_latest_paid_order | easy | 1.000 | 0.000 | 0.000, 0.000 | n/a | declared (1); mutants 6/8 | `tid_6480f19426d255feb75a975192b5b5505234f3b564842fb163a68756507feabe` |
| refund_delivered_orders_for_country | medium | 1.000 | 0.000 | 0.000, 0.333, 0.000 | 0.667 | declared (4); mutants 5/8 | `tid_2721a91e20807970ea54b4ee008d3b30b0bf7990cf8b348e158757cabafd77fc` |
| fulfil_pending_orders_of_pro_customers | hard | 1.000 | 0.000 | 0.429, 0.143, 0.000, 0.857 | 0.857 | declared (5); mutants 6/8 | `tid_e59a0d2d86e3c3fa5e98e7e789d03c6b967d066b63f9c1d09bc8b531cb217e4c` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `ship_latest_paid_order` 0.000: ships the latest paid order of a different customer (Shafi Goldwasser) instead of Ada Lovelace
- `ship_latest_paid_order` 0.000: ships Ada's paid order but also pays and ships one of her pending orders, a collateral change
- `refund_delivered_orders_for_country` 0.000: refunds every delivered order regardless of the customer's country
- `refund_delivered_orders_for_country` 0.333: only handles Grace Hopper, the first GB customer it thinks of, and misses the delivered orders of other GB customers
- `refund_delivered_orders_for_country` 0.000: refunds the right delivered GB orders and also refunds shipped GB orders over 5000 cents
- `fulfil_pending_orders_of_pro_customers` 0.429: reads only the first page of orders, so it misses the pending pro orders on later pages
- `fulfil_pending_orders_of_pro_customers` 0.143: pays every pending pro order across all pages but never ships them
- `fulfil_pending_orders_of_pro_customers` 0.000: fulfils every pending order of pro and team customers, shipping orders of non-pro customers
- `fulfil_pending_orders_of_pro_customers` 0.857: fulfils every pending pro order across all pages but forgets to update Hedy Lamarr's country

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| ship_latest_paid_order | easy | 1 | none | none | none declared |
| refund_delivered_orders_for_country | medium | 3 | none | order | distractors: met; state: met |
| fulfil_pending_orders_of_pro_customers | hard | 7 | order | customer | hard: met; paging: met; distractors: met; state: met |

## Fidelity

Not checked. The input gave no source spec or frozen reference of Shopify-style order desk (orders and customers API), so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.

## Run

Mode: create from csv. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 2 | 1.37 | 0.4177 |
| model | 1 | 0.24 | 0.3193 |
| workflow | 1 | 0.19 | 0.3230 |
| seed | 1 | 0.11 | 0.2981 |
| tasks | 1 | 1.56 | 0.4470 |
| Total | 6 | 3.48 | 1.8051 |

Run total: 3.49 minutes, $1.8051.
