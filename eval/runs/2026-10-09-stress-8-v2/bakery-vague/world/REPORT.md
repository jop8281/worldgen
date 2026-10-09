# WorldGen report: Square-for-Retail / Toast-style bakery order and pickup system

A neighborhood bakery tracks its products and stock, customers, and pre-orders. Orders move from placed to baking to ready to picked up, can be cancelled before they are ready, and stock is reserved when an order is placed. A daily job cancels ready orders that nobody collected.

## What was built

Entities (3):

- `product`: 10 seeded rows
- `customer`: 12 seeded rows
- `order`: 30 seeded rows

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

Actions (5):

- `place_order`: POST /orders
- `start_baking`: POST /orders/{id}/start_baking
- `mark_ready`: POST /orders/{id}/mark_ready
- `pick_up_order`: POST /orders/{id}/pick_up
- `cancel_order`: POST /orders/{id}/cancel

Jobs (1):

- `expire_ready_orders`: every 1d

## Assumed and why

- Each order holds one product and a quantity rather than multiple line items.
  - Why: Keeps the model small while still allowing stock contention.
- Stock is reserved at order placement and returned on cancellation.
  - Why: Gives a scarce-resource rule and an irreversible-step rule agents must respect.
- Clock starts 2026-10-09T08:00:00Z with tick 0s; seeded history is before this and nothing is scheduled in the future except job runs.
  - Why: Deterministic time; the expiry job is driven by explicit advances.
- Money is USD in cents; no payments, delivery or ingredients are modelled.
  - Why: Request gives no detail; pickup-only bakery is the simplest reading.
- Ready orders are held for 2 days before auto-cancellation.
  - Why: Typical bakery freshness policy; request is silent.

## Questions asked of the input

- Is this for pre-orders with pickup, or in-store sales and delivery?
  - Default answer: Pre-orders with in-store pickup.
- Can one order contain several products?
  - Default answer: No, one product and quantity per order.
- How long is a ready order held?
  - Default answer: 2 days, then auto-cancelled.
- Is payment tracked?
  - Default answer: No, out of scope.

## Left out

- Payments, refunds and invoicing
  - Why: Not requested; adds a second domain.
- Ingredient inventory and recipes
  - Why: Request only asks for a bakery app; product stock is enough.
- Delivery and a customer-facing UI
  - Why: Control is through API records only.

## Proof

The engine check passed: 4 world tests, 2 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_3990f089a91aaea3aa011ae63367a28a12a583e4e284f4b8d1a4005c0e492a65`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| mark_ready_for_customer | easy | 1.000 | 0.000 | 0.000 | n/a | declared (1); mutants 4/8 | `tid_1ac1962a7167c9c1915918cada91f8870b60bf35879950c7643de0284ec23cc3` |
| cancel_placed_order_restock | medium | 1.000 | 0.000 | 0.500, 0.500, 0.000 | n/a | declared (2); mutants 4/8 | `tid_5a916c8974b0b6aa4906624b6629fd5a02acdc1e127fda2a33e974db995b6511` |
| fulfil_customer_placed_orders | hard | 1.000 | 0.000 | 0.700, 0.400, 0.000 | 0.700 | declared (5); mutants 5/8 | `tid_efe8c58e4d6845f3c79f6126dd048b5366cdc98b946879b4d6239597299fc513` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `mark_ready_for_customer` 0.000: marks a baking order of Maria Lopes, the customer with the near-identical name, instead of Maria Lopez
- `cancel_placed_order_restock` 0.500: leaves the order alone and raises the product stock by hand, so the order is never cancelled
- `cancel_placed_order_restock` 0.500: cancels the right order but then also adds the cookie back to stock by hand, so stock is restored twice
- `cancel_placed_order_restock` 0.000: cancels a placed order of a different customer (James Whitaker) instead of Tom Brennan's
- `fulfil_customer_placed_orders` 0.700: reads only the first page of orders, so it handles Maria Lopez but misses Lena Fischer's placed order on the later page
- `fulfil_customer_placed_orders` 0.400: starts baking the non-discontinued orders but never marks them ready, only cancelling the discontinued one
- `fulfil_customer_placed_orders` 0.000: matches every customer whose name contains Maria, so it also advances the placed orders of Maria Lopes with the near-identical name

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| mark_ready_for_customer | easy | 1 | none | order | distractors: met; state: met |
| cancel_placed_order_restock | medium | 2 | none | order | distractors: met; state: met; state: met |
| fulfil_customer_placed_orders | hard | 5 | order | order | hard: met; paging: met; distractors: met; state: met; state: met |

## Fidelity

Not checked. The input gave no source spec or frozen reference of Square-for-Retail / Toast-style bakery order and pickup system, so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.

## Run

Mode: create from description. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 0.78 | 0.0953 |
| model | 1 | 0.21 | 0.0731 |
| workflow | 1 | 0.24 | 0.0828 |
| seed | 1 | 0.35 | 0.0980 |
| tasks | 1 | 2.21 | 0.2856 |
| Total | 5 | 3.80 | 0.6349 |

Run total: 3.80 minutes, $0.6349.
