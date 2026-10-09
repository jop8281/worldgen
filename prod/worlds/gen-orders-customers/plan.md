# WorldGen plan: Shopify-style Admin orders and customers API (order lifecycle: pending, paid, shipped, delivered, cancelled, refunded)

A small storefront back office. Customers (18) place orders (72) that move through a payment and fulfilment lifecycle. Agents list and filter orders, then pay, ship, deliver, cancel or refund them. A nightly job cancels stale unpaid orders. Seed rows come from the two imported CSV fixtures, with ids and timestamps kept as given.

- Revision: 2
- Verdict: proceed
- Clock: starts 2026-04-08T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `customer` | A shopper who places orders. Imported from the customers CSV. The plan field is the subscription tier and the country is a 2-letter code. | name, email, country, plan |
| `shop_order` | An order placed by a customer, with a total in USD cents, an item count, a lifecycle status, a ship time and an optional delivery note. Imported from the orders CSV. Served under /orders. | customer_id, status, total_cents, currency, item_count, placed_at, shipped_at, note |

## Workflows

### order_lifecycle (shop_order)
- States: pending, paid, shipped, delivered, cancelled, refunded
- Actions: pay_order, ship_order, deliver_order, cancel_order, refund_order
- Rules:
  - A new order starts as pending, with shipped_at null.
  - pay_order moves pending to paid. Any other status returns 409 invalid_state.
  - ship_order moves paid to shipped and sets shipped_at to the engine time. A pending order must be paid first.
  - deliver_order moves shipped to delivered and keeps shipped_at.
  - cancel_order moves pending or paid to cancelled. A shipped, delivered, cancelled or refunded order returns 409 invalid_state. It stores an optional reason in note.
  - refund_order moves paid, shipped or delivered to refunded. A pending or cancelled order returns 409 invalid_state. It keeps shipped_at.
  - cancelled and refunded are final.
  - The cancel_stale_pending job cancels pending orders whose placed_at is more than 7 days before engine time.
  - Status, shipped_at and total_cents cannot be set by a plain POST or PATCH.

## Jobs

- `cancel_stale_pending` runs every 1d: Cancel each pending order whose placed_at is at least 7 days (10080 minutes) before engine time. Leave every other status alone. The seed has several pending orders older than 7 days, so the first run changes data.

## Acceptance tests

None. The plan records no acceptance test.

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_customers` | GET | /customers | List customers. Filter by country and plan, search name and email, sort by name or created_at. |
| `get_customer` | GET | /customers/{id} | Fetch one customer. |
| `create_customer` | POST | /customers | Create a customer. |
| `update_customer` | PATCH | /customers/{id} | Edit a customer's name, email, country or plan. |
| `list_orders` | GET | /orders | List orders. Filter by status, customer_id and currency. Search the note. Sort by placed_at, total_cents or shipped_at. Page size 25, so 72 orders span 3 pages. |
| `list_customer_orders` | GET | /customers/{customer_id}/orders | List the orders of one customer, with the same filters as /orders. |
| `get_order` | GET | /orders/{id} | Fetch one order. |
| `create_order` | POST | /orders | Create an order for a customer. It starts as pending. |
| `update_order` | PATCH | /orders/{id} | Edit the editable fields (note, item_count). Status, shipped_at and total are changed only by the lifecycle actions. |
| `pay_order` | POST | /orders/{id}/pay | Mark a pending order paid. |
| `ship_order` | POST | /orders/{id}/ship | Ship a paid order and set shipped_at to the call time. |
| `deliver_order` | POST | /orders/{id}/deliver | Mark a shipped order delivered. |
| `cancel_order` | POST | /orders/{id}/cancel | Cancel a pending or paid order. |
| `refund_order` | POST | /orders/{id}/refund | Refund a paid, shipped or delivered order. |

## Seed

- Rows per entity: customer: 18, shop_order: 72
- Mix: Load both tables from the CSV fixtures and keep the ids (cus_0001.., ord_0001..), refs, totals, placed_at and shipped_at as given. Convert the CSV status values directly. Each of the 6 order states must appear, and none may exceed 70% of the rows. Shipped_at is set (about 44% of rows) only on shipped, delivered and refunded orders, and any other status leaves it null. If the CSV breaks that rule, the seed nulls shipped_at on pending, paid and cancelled rows, or moves the status to shipped. About 8% of orders carry a delivery note. Orders spread across the 18 customers, with some customers holding 8 or more orders. Seed timestamps must not be later than meta.clock.start.

## Tasks

- `ship_ada_paid_order` (easy): Ship the one paid order of the customer Ada Lovelace (found by name, not id). It should become shipped, with shipped_at set, and nothing else changes. The seed must give Ada exactly one paid order.
  - Decoy idea: Mark it shipped with a plain PATCH (rejected, as status is readonly), or ship a paid order of a different customer with a similar name.
- `cancel_customer_unpaid_orders` (medium): Cancel every pending order of the customer with a given email (a customer with 4 or more orders in mixed states). Each cancellation must pass a reason that contains the word 'unpaid', and the instruction says so. The grader checks that each cancelled order's note contains 'unpaid', so nonsense text scores below 1. Orders in other statuses and other customers' pending orders stay untouched. The agent must look up the customer by email, list that customer's orders and filter by status.
  - Decoy idea: Cancel all of that customer's orders including paid ones (the action refuses these, so partial), or cancel every pending order in the store, or list only the first page of /orders and miss some, or cancel the right orders with a reason that does not mention 'unpaid'.
- `refund_large_gb_pro_orders` (hard): Refund every delivered order over $100 (10000 cents) that belongs to a customer in country GB on the pro plan. Orders of other countries or plans, and orders under the limit, must not change. It needs a customer lookup with filters, then orders from all 3 pages. Seed anchors place targets on page 2 and 3, and one near-miss order sits at exactly 10000 cents.
  - Decoy idea: Read only page 1 of the orders and refund only those. Refund shipped orders as well as delivered ones. Treat 'over $100' as 'at least $100' and refund the 10000-cent order. Ignore the plan and refund every GB customer's orders.

## Open questions

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
  - Default answer: Yes. A daily job cancels pending orders older than 7 days. The clock starts at 2026-04-08T09:00:00Z and only moves when a test advances it.
- Should the CSV ids and timestamps be kept?
  - Default answer: Yes. Ids, refs, totals and timestamps load as given, and the clock starts after the latest one.
- Can clients set status or shipped_at directly?
  - Default answer: No. These are readonly, and only the actions change them.

## Assumptions

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
- The required cancel reason keyword is 'unpaid', matched case-insensitively in shop_order.note.
  - Why: The task is about unpaid (pending) orders, so the word comes from the task itself and a free-text check can reject nonsense such as 'bananas'.

## Out of scope

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

## Changes

- tasks.cancel_customer_unpaid_orders
