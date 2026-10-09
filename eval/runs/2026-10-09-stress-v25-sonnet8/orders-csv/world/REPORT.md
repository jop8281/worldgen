# WorldGen report: Shopify-style order desk (orders and customers admin API)

An order desk where customers' orders move from pending through paid, shipped and delivered, or end cancelled or refunded. Agents read orders and customers and run the fulfilment actions. The orders and customers CSV tables are kept exactly.

## What was built

Entities (2):

- `customer`: 18 seeded rows
- `order`: 72 seeded rows

Routes (6):

- `list_orders`: GET /orders
- `get_order`: GET /orders/{id}
- `create_order`: POST /orders
- `list_customers`: GET /customers
- `get_customer`: GET /customers/{id}
- `create_customer`: POST /customers

Actions (5):

- `pay_order`: POST /orders/{id}/pay
- `ship_order`: POST /orders/{id}/ship
- `deliver_order`: POST /orders/{id}/deliver
- `cancel_order`: POST /orders/{id}/cancel
- `refund_order`: POST /orders/{id}/refund

Jobs: none.

## Assumed and why

- Clock starts 2026-04-08T09:00:00Z with tick 0s.
  - Why: It is after the latest imported event (shipped_at 2026-04-07T14:00:00Z), and time then moves only explicitly.
- Order statuses and the transitions pending->paid|cancelled, paid->shipped|cancelled|refunded, shipped->delivered, delivered->refunded, with cancelled and refunded final.
  - Why: This is the standard order lifecycle for the CSV's six status values.
- Shipped orders cannot be cancelled or refunded directly. They must be delivered first.
  - Why: It keeps refund and cancel rules simple and checkable.
- stateMix is estimated from the CSV: about 32 of 72 orders have shipped_at, which covers shipped, delivered and some refunded orders.
  - Why: The exact status counts are not given in the profile.
- The standard create_order route makes pending orders. All later transitions go through the actions, not PATCH.
  - Why: Actions set shipped_at and enforce the rules.
- No jobs.
  - Why: Time-based changes would break the idle-state checks on the tasks, and the request names none.
- customer.plan and country are strings, as in the CSV. The note enum has the four CSV values and is nullable.
  - Why: This keeps the imported values unchanged.

## Fields not in the input

None. The input names every field.

## Questions asked of the input

- Can a shipped order be cancelled or refunded?
  - Default answer: No. It must be delivered first, and then it can be refunded.
- Should pending orders expire automatically?
  - Default answer: No. There are no jobs.
- Is there an actor, such as an agent or role, that restricts who may act on an order?
  - Default answer: No. Any caller may run any action.

## Left out

- Payments, carriers and inventory
  - Why: The CSV has only orders and customers.
- Line items
  - Why: Only item_count exists in the data.
- Multi-currency orders
  - Why: All imported orders are USD.

## Proof

The engine check passed: 5 world tests, 2 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_424b71a30be4ae6e9535d71dc90deac05ddbd73fc64e6d4507abcb772c8561fa`.

Paging exemptions:

- `customer` fits on one page (18 rows), but its rows come from the input's fixtures, so the input sets its size and no task is held to paging on it.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | Collateral | TID |
|---|---|---|---|---|---|---|---|
| cancel_latest_pending | easy | 1.000 | 0.000 | 0.000, 0.000 | n/a | declared (1); mutants 3/8 | `tid_3e670db0284777e2d92314b6e24ed3467d7a384d28d48a928d8b28c3fcd3d9e6` |
| refund_top_delivered | medium | 1.000 | 0.000 | 0.500, 0.000, 0.000, 0.000 | 0.500 | declared (2); mutants 3/8 | `tid_c01885e3476f6bba822b020e361ba8dc5c14765646934a7171696367362097c9` |
| pay_and_ship_pro_pending | hard | 1.000 | 0.000 | 0.150, 0.433, 0.000, 0.850 | 0.858 | declared (5); mutants 4/8 | `tid_1175b9227960fee73f4f6938a837ddeba8c80641691755a16b2949bdefe2a199` |

Collateral: *declared (n)* means the task's `allows` contract is enforced by the engine (A-224); *legacy* means only its grader's own guards and the engine mutants judge it (YOS-156). *mutants k/8* is how many engine mutant kinds found something to probe; an unprobed kind is not a pass (A-222).

Decoys:

- `cancel_latest_pending` 0.000: Cancels the earliest-placed pending order instead of the most recent one
- `cancel_latest_pending` 0.000: Cancels the two most recently placed pending orders, one more than asked
- `refund_top_delivered` 0.500: Refunds only the single highest-total delivered order and forgets the second one
- `refund_top_delivered` 0.000: Ignores the 15 February cutoff and refunds the two highest-total delivered orders of all time
- `refund_top_delivered` 0.000: Does not check the order is delivered: refunds the two highest-total paid or delivered orders since 15 February, which hits paid orders
- `refund_top_delivered` 0.000: Stops after the second page of orders, so it never sees the highest-total delivered order on page 3 and refunds a lower one instead
- `pay_and_ship_pro_pending` 0.150: Registers the customer and pays every pro pending order but never ships them
- `pay_and_ship_pro_pending` 0.433: Reads only the first page of orders, so it pays and ships just the pro pending orders on that page and misses the rest
- `pay_and_ship_pro_pending` 0.000: Ignores the customer plan and pays and ships every pending order, including those of free and team customers
- `pay_and_ship_pro_pending` 0.850: Pays and ships every pro pending order correctly but skips registering the new customer

## Coverage

From each reference solution's trace. A hard task must change more than one row or reach a row past the first list page, and a task's declared pressure must show in its trace or the seed.

| Task | Difficulty | Rows changed | Later-page rows in | Distractor rows in | Checks |
|---|---|---|---|---|---|
| cancel_latest_pending | easy | 1 | none | none | state: met |
| refund_top_delivered | medium | 2 | order | order | paging: met; distractors: met; state: met |
| pay_and_ship_pro_pending | hard | 7 | order | customer | hard: met; paging: met; distractors: met; state: met |

## Fidelity

Not checked. The input gave no source spec or frozen reference of Shopify-style order desk (orders and customers admin API), so nothing measured how closely this world's entities, states, routes and errors match it. They are WorldGen's reading of the input; compare them with the real product before relying on them.

## Run

Mode: create from csv. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 0.79 | 0.3016 |
| model | 1 | 0.44 | 0.3184 |
| workflow | 1 | 0.22 | 0.3176 |
| seed | 1 | 0.13 | 0.2947 |
| tasks | 1 | 2.93 | 0.5557 |
| Total | 5 | 4.50 | 1.7880 |

Run total: 4.51 minutes, $1.7880.
