# WorldGen report: Bakery order and pickup system (Square for Restaurants / Toast-style bakery ordering)

A bakery sells products with limited daily stock. Customers place pickup orders that reserve stock; staff move orders through production, ready and pickup. Cancelling a placed order restores stock, and ready orders not collected within 24 hours expire.

## What was built

Entities (3):

- `product`: 12 seeded rows
- `customer`: 10 seeded rows
- `bakery_order`: 32 seeded rows

Routes (9):

- `list_products`: GET /products
- `get_product`: GET /products/{id}
- `create_product`: POST /products
- `update_product`: PATCH /products/{id}
- `list_customers`: GET /customers
- `get_customer`: GET /customers/{id}
- `create_customer`: POST /customers
- `list_orders`: GET /orders
- `get_order`: GET /orders/{id}

Actions (6):

- `place_order`: POST /orders
- `start_production`: POST /orders/{id}/start_production
- `mark_ready`: POST /orders/{id}/mark_ready
- `pick_up`: POST /orders/{id}/pick_up
- `cancel_order`: POST /orders/{id}/cancel
- `restock_product`: POST /products/{id}/restock

Jobs (1):

- `expire_ready_orders`: every 1h

## Assumed and why

- One order holds one product and quantity.
  - Why: Action inputs are scalar, so multi-line orders would need a line-item entity; kept simple.
- Currency is USD in cents.
  - Why: No currency specified.
- Clock starts 2026-10-09T08:00:00Z with tick 0s; seeded history is before it, pickup dates are future.
  - Why: Deterministic time; explicit advances only.
- Stock is reserved at order placement and restored only on cancel; expired orders do not restore stock.
  - Why: Perishable goods; simple inventory model.
- No payments, delivery or ingredient inventory.
  - Why: Request just says an app for a bakery; ordering and pickup is the core stateful flow.
- Stock and status are readonly and change only through actions.
  - Why: Rules cannot be bypassed via PATCH.

## Questions asked of the input

- Is this for in-store pickup orders or also delivery?
  - Default answer: Pickup only.
- Should orders contain multiple products?
  - Default answer: No, one product and quantity per order.
- Is inventory per day or running stock?
  - Default answer: Running stock decremented at order placement.
- How long may ready orders wait?
  - Default answer: 24 hours, then they expire.

## Left out

- Payments and refunds
  - Why: Not specified; keeps the world focused on fulfillment.
- Delivery, recipes, ingredient inventory, staff scheduling
  - Why: Beyond a minimal bakery order desk.
- Multi-item orders
  - Why: Would require line items; simplified.

## Proof

The engine check passed: 5 world tests, 2 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_1d6687c6203681be42dd0e8427947f80588e43340c811456ae3b16d4fff78d3d`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| restock_low_bread | easy | 1.000 | 0.000 | 0.000, 0.000 | n/a | declared (1); mutants 4/8 | `tid_b47e7a2ca0cd8989c6bffed04bb61d941386325b6a5c3c64f15cfac0d10d1991` |
| cancel_customer_placed_order | medium | 1.000 | 0.000 | 0.000, 0.000, 0.000 | n/a | declared (2); mutants 4/8 | `tid_49fad1e36d8f52e3198f17c9732c9498bdf43ae056a95dfcd852f9265c7f7685` |
| prepare_saturday_orders | hard | 1.000 | 0.000 | 0.429, 0.000, 0.000 | 0.857 | declared (1); mutants 4/8 | `tid_fa10158530716472b785cdec7bdc576238422fe399f5d780584bbf2cf3151762` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `restock_low_bread` 0.000: restocks the similarly named 'Seeded Sourdough' product instead of 'Country Sourdough'
- `restock_low_bread` 0.000: restocks the right product but by 10 units instead of the requested 24
- `cancel_customer_placed_order` 0.000: cancels Maria Lopez's other placed order (for a different product) instead of the Cinnamon Roll one
- `cancel_customer_placed_order` 0.000: cancels every placed order of Maria Lopez, including the one for another product that should stay
- `cancel_customer_placed_order` 0.000: confuses the similarly named customer Mario Lopez and cancels his placed Cinnamon Roll order
- `prepare_saturday_orders` 0.429: reads only the first page of three matching orders and processes just those, missing the rest
- `prepare_saturday_orders` 0.000: starts production on the matching orders but never marks them ready
- `prepare_saturday_orders` 0.000: processes every placed order regardless of pickup date, touching orders for other days

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| restock_low_bread | easy | 1 | none | none | none declared |
| cancel_customer_placed_order | medium | 2 | none | bakery_order | distractors: met; state: met; state: met; state: met |
| prepare_saturday_orders | hard | 7 | bakery_order | bakery_order | hard: met; paging: met; distractors: met; state: met |

## Fidelity

Not checked. The input gave no source spec or frozen reference of Bakery order and pickup system (Square for Restaurants / Toast-style bakery ordering), so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.

## Run

Mode: create from description. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 0.92 | 0.1088 |
| model | 1 | 0.26 | 0.0804 |
| workflow | 1 | 0.27 | 0.0897 |
| seed | 1 | 0.66 | 0.1282 |
| tasks | 2 | 1.83 | 0.3559 |
| Total | 6 | 3.94 | 0.7629 |

Run total: 3.95 minutes, $0.7629.
