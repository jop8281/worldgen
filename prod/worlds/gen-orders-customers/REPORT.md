# WorldGen report: Shopify-style Admin orders and customers API (order lifecycle: pending, paid, shipped, delivered, cancelled, refunded)

A small storefront back office. Customers (18) place orders (72) that move through a payment and fulfilment lifecycle. Agents list and filter orders, then pay, ship, deliver, cancel or refund them. A nightly job cancels stale unpaid orders. Seed rows come from the two imported CSV fixtures, with ids and timestamps kept as given.

## What was built

Entities (2):

- `customer`: 18 seeded rows
- `shop_order`: 72 seeded rows

Routes (9):

- `list_customers`: GET /customers
- `get_customer`: GET /customers/{id}
- `create_customer`: POST /customers
- `update_customer`: PATCH /customers/{id}
- `list_orders`: GET /orders
- `list_customer_orders`: GET /customers/{customer_id}/orders
- `get_order`: GET /orders/{id}
- `create_order`: POST /orders
- `update_order`: PATCH /orders/{id}

Actions (5):

- `pay_order`: POST /orders/{id}/pay
- `ship_order`: POST /orders/{id}/ship
- `deliver_order`: POST /orders/{id}/deliver
- `cancel_order`: POST /orders/{id}/cancel
- `refund_order`: POST /orders/{id}/refund

Jobs (1):

- `cancel_stale_pending`: every 1d

## Assumed and why

- The real product is a Shopify-style Admin API for orders and customers, with a simplified single-currency model.
  - Why: The data has customers, orders with cents totals, a status lifecycle and a shipped_at time. That matches a storefront order API.
- The order entity is named shop_order, with idPrefix ord and path /orders.
  - Why: A bare name like order collides with SQL keywords, and the idPrefix keeps the CSV ids (ord_0001) valid.
- Customer idPrefix is cus, so the CSV ids cus_0001 are kept. Imported ids and timestamps are preserved by the seed.
  - Why: Orders reference customers by those ids, and tasks and tests need them stable.
- total_cents is a money field in USD, in integer minor units, named total_cents. The currency is an enum with the single value USD.
  - Why: The CSV has total_cents as an int and one currency. Keeping both columns matches the source, and money fixes the unit.
- The status field is a state machine: pending to paid or cancelled. paid to shipped, cancelled or refunded. shipped to delivered or refunded. delivered to refunded. cancelled and refunded are final.
  - Why: The CSV lists six statuses but no transitions. This is the usual order flow, and a cancelled order cannot be refunded because it was never charged.
- The note is modelled as a nullable free-text string (maxLength 200), not an enum.
  - Why: The profiler guessed an enum from 4 values, but delivery notes are free text, and one value contains quotes. The fixtures still load unchanged.
- customer.country is a string with the pattern ^[A-Z]{2}$, and plan is a string, not an enum. Known plans come from the CSV (3 values, such as pro).
  - Why: The profile says 'string', and the full plan list is unknown. A strict enum could reject real rows.
- Status, shipped_at and total_cents are readonly for plain create and update. Only the lifecycle actions change status and shipped_at. A create route always starts an order as pending.
  - Why: This forces agents to use the real actions, and it lets a grader tell a proper ship from a raw PATCH.
- Refund and cancel do not track money movement or stock.
  - Why: The data has no payment, inventory or line-item tables. Status is the only record of them.
- A job named cancel_stale_pending runs daily. It cancels pending orders more than 7 days older than engine time. Clock tick stays at the default 0s, so time moves only in tests.
  - Why: A realistic time-driven rule gives the world a job. Tasks cannot advance the clock, so they stay deterministic.
- The clock starts at 2026-04-08T09:00:00Z, after the latest placed_at and shipped_at in the CSV. The list page size is 25.
  - Why: All seeded rows must be in the past. 72 orders then give 3 pages, so paging matters.
- Customer lists use pageSize 10 (18 customers gives 2 pages). Customer sort and search are on name and email.
  - Why: With only 18 customers, a default 25 would never page.

## Questions asked of the input

- Which real product should this mirror?
  - Default answer: A Shopify-style Admin orders and customers API.
- What are the allowed order status transitions?
  - Default answer: pending to paid or cancelled. paid to shipped, cancelled or refunded. shipped to delivered or refunded. delivered to refunded. cancelled and refunded are final.
- Should the delivery note be a closed enum or free text?
  - Default answer: Free text, nullable, up to 200 characters. The 4 CSV values load as they are.
- Is customer.plan a closed set of values?
  - Default answer: No. It is a plain string, because only 3 values were seen.
- Should the world track payments, stock or refund amounts?
  - Default answer: No. Status changes only.
- Should anything happen with time?
  - Default answer: Yes. A daily job cancels pending orders older than 7 days. The clock starts at 2026-02-01T09:00:00Z and only moves when a test advances it.
- Should the CSV ids and timestamps be kept?
  - Default answer: Yes. Ids, refs, totals and timestamps load as given, and the clock starts after the latest one.
- Can clients set status or shipped_at directly?
  - Default answer: No. These are readonly, and only the actions change them.

## Left out

- Payments, card capture, payment gateways and real refund amounts
  - Why: The data holds only an order total and status. Pay and refund are state changes only.
- Line items, products, inventory and stock reservation
  - Why: The CSV has only an item_count and no product tables.
- Shipping carriers, tracking numbers, rates and addresses
  - Why: The data has only shipped_at. Nothing else about shipping is imported.
- Taxes, discounts, partial refunds and multiple currencies
  - Why: All orders are USD and have one total.
- Authentication, webhooks and customer deletion
  - Why: They add no graded behaviour for this order lifecycle, and orders restrict customer deletion.

## Proof

The engine check passed: 6 world tests, 0 warnings. Each row is one engine TaskVerdict.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix |
|---|---|---|---|---|---|
| ship_ada_paid_order | easy | 1.000 | 0.000 | 0.000, 0.000 | n/a |
| cancel_customer_unpaid_orders | medium | 1.000 | 0.000 | 0.000, 0.000, 0.500, 0.000 | 0.500 |
| refund_large_gb_pro_orders | hard | 1.000 | 0.000 | 0.333, 0.000, 0.000, 0.000, 0.000 | 0.667 |

Decoys:

- `ship_ada_paid_order` 0.000: ships the first paid order in the store instead of looking up Ada Lovelace's order
- `ship_ada_paid_order` 0.000: ships Ada's paid order correctly, then also changes its item_count
- `cancel_customer_unpaid_orders` 0.000: tries to cancel every order of the customer, including the paid one, which is a change the task did not ask for
- `cancel_customer_unpaid_orders` 0.000: cancels every pending order in the store instead of only that customer's
- `cancel_customer_unpaid_orders` 0.500: cancels only the first pending order of the customer and stops
- `cancel_customer_unpaid_orders` 0.000: cancels every pending order of the customer correctly, then also changes one order's item_count
- `refund_large_gb_pro_orders` 0.333: reads only page 1 of the unfiltered orders list and so misses the targets on later pages
- `refund_large_gb_pro_orders` 0.000: ignores the customer plan and refunds every delivered order over $100
- `refund_large_gb_pro_orders` 0.000: ignores the $100 limit and refunds every delivered order of team customers, including small ones
- `refund_large_gb_pro_orders` 0.000: also refunds shipped orders of team customers over $100, not only delivered ones
- `refund_large_gb_pro_orders` 0.000: refunds every matching order correctly, then also changes one refunded order item_count

## Run

Mode: create from csv. Model: claude-sonnet-5-5. Budget: $3.50.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 0.68 | 0.0697 |
| model | 1 | 0.22 | 0.0849 |
| workflow | 1 | 0.81 | 0.1557 |
| seed | 2 | 0.30 | 0.2110 |
| tasks | 1 | 1.04 | 0.1871 |
| Total | 6 | 3.05 | 0.7084 |

Run total: 3.06 minutes, $0.7084.

## Post-generation clock correction

The original run used January 5 as world time while importing order history through April 7. Public API play could ship an imported order before it was placed and still receive full credit. The current world and plan now start at April 8, 2026 at 09:00 UTC, after the imported history. Imported CSV ids and timestamps are unchanged. A chronology test covers all imported orders, and the shipping task grader requires shipping to follow placement. The daily-job test retains its seven-day boundary and younger-order assertions with dates aligned to this clock.

This is a post-generation artifact correction. The original run events, model, duration and cost totals above remain historical evidence; no new model run is claimed.
