# WorldGen report: Square Online / Toast-style bakery ordering API

A bakery ordering desk: a product catalogue with daily stock, customers, and pickup orders. An order is placed for one product with a pickup time, decrements stock, and moves through preparing, ready and picked_up. Cancelling a placed order restores its stock. Status changes happen only through actions, so the stock and pickup rules cannot be bypassed.

## What was built

Entities (3):

- `product`: 12 seeded rows
- `customer`: 28 seeded rows
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
- `start_preparing`: POST /orders/{id}/start
- `mark_ready`: POST /orders/{id}/ready
- `mark_picked_up`: POST /orders/{id}/pickup
- `cancel_order`: POST /orders/{id}/cancel

Jobs: none.

## Assumed and why

- Each order holds one product and a quantity, not a multi-line cart.
  - Why: The input names no cart; a single line keeps stock arithmetic exact and the world small.
- Money is integer USD cents; total = quantity times the product price at placement.
  - Why: Money fields hold minor units and the input names no currency; USD is the default.
- No payments, tips or taxes; cancellation is free and restores stock.
  - Why: The input names no payment flow, so no fee or refund is modelled.
- Time is UTC; pickup_at is any future instant, with no store opening hours or slots.
  - Why: The input names no schedule; a free pickup time is the simplest deterministic rule.
- Stock is a per-product count set by the bakery and decremented on order placement; it is not reset by a job.
  - Why: A daily reset would need a clock-driven job the input does not ask for.
- Clock starts 2026-10-09T08:00:00Z with tick 0s, so time moves only by explicit advance.
  - Why: Deterministic time after all seeded history; the date is today from the environment.
- Order status is a state field: placed to preparing, preparing to ready, ready to picked_up, and placed to cancelled.
  - Why: A bakery order moves through these steps; a cancelled order cannot be prepared.
- No authentication or per-staff permissions.
  - Why: The input names no roles; permissions would add rules the input does not ask for.

## Questions asked of the input

- Is an order for one product only, or a cart of several products?
  - Default answer: One product per order with a quantity.
- Is payment taken when an order is placed?
  - Default answer: No. Payment is out of scope; total is recorded only.
- Are pickup times limited to shop hours or slots?
  - Default answer: No. Any future instant is accepted.
- Does cancelling a placed order return its stock?
  - Default answer: Yes, the quantity returns to product stock.
- Can an order be cancelled after preparation starts?
  - Default answer: No. Only placed orders can be cancelled.

## Left out

- Payments, refunds, taxes and tips
  - Why: The input names no payment flow, and money movement is a separate system.
- Delivery and courier dispatch
  - Why: The input says pickup-style bakery ordering; delivery adds addresses and carriers.
- Multi-item carts and modifiers
  - Why: One product per order keeps stock and totals exact; carts add lines the input does not ask for.
- Authentication and staff roles
  - Why: The input names no roles.
- Loyalty, promotions and reporting
  - Why: Not named in the input.

## Proof

The engine check passed: 5 world tests, 1 warning. Each row is one engine TaskVerdict.

World id (WID): `wid_699aa07ac22ba9b37560d6c40cef48596b4a6cfb956051687e64e0ebf59e98e5`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| cancel_placed_order | easy | 1.000 | 0.000 | 0.600 | n/a | declared (2); mutants 5/8 | `tid_bfd4e2a79c4bfe656176adbfe158df7deca6882eb59832d9b39fc3a7519ca4c2` |
| pick_up_ready_order | medium | 1.000 | 0.000 | 0.000 | n/a | declared (1); mutants 4/8 | `tid_d13dd4d822ab3cbc16a2e159a7bafe2f391745817e14adb15afd18b0cdfc802a` |
| place_and_start_sourdough | hard | 1.000 | 0.000 | 0.000, 0.000 | 0.000 | declared (3); mutants 5/8 | `tid_b3348b4ca381c09e6210ae0671098f6a98d572f9cac1cda75729642d0081b54a` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `cancel_placed_order` 0.600: cancels the right order, then adds its quantity back to product stock by hand, so the stock is restored twice
- `pick_up_ready_order` 0.000: marks the oldest ready order in the list as picked up, which belongs to another customer, not Liam Carter
- `place_and_start_sourdough` 0.000: places the order on the similar Sourdough Boule product, which has more stock, and starts it
- `place_and_start_sourdough` 0.000: places the correct Sourdough Loaves order but never starts preparing it

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| cancel_placed_order | easy | 2 | none | order | distractors: met; state: met |
| pick_up_ready_order | medium | 1 | none | order | distractors: met; state: met |
| place_and_start_sourdough | hard | 2 | none | product | hard: met; distractors: met; state: met |

## Fidelity

Not checked. The input gave no source spec or frozen reference of Square Online / Toast-style bakery ordering API, so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.

## Run

Mode: create from description. Model: claude-haiku-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 1.36 | 0.0106 |
| model | 1 | 0.51 | 0.0083 |
| workflow | 1 | 0.36 | 0.0057 |
| seed | 1 | 1.18 | 0.0168 |
| tasks | 2 | 3.88 | 0.1232 |
| Total | 6 | 7.28 | 0.1647 |

Run total: 7.29 minutes, $0.1647.
