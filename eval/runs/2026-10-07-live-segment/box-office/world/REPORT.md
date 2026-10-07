# WorldGen report: Ticketmaster / Eventbrite-style concert box office (reserved-seating ticketing API)

A box office for concerts with reserved seating. Events have priced sections and individual seats. A customer places a hold on a seat; the hold lasts 15 minutes and then expires and frees the seat unless the customer checks out. A customer may have at most 6 tickets per event (paid tickets plus active holds). Checkout turns the customer's live holds for one event into a paid order with tickets. A paid order can be refunded in full until 48 hours before the event starts, which frees its seats and the customer's ticket allowance.

## What was built

Entities (7):

- `customer`: 14 seeded rows
- `event`: 6 seeded rows
- `section`: 14 seeded rows
- `seat`: 60 seeded rows
- `hold`: 36 seeded rows
- `order`: 8 seeded rows
- `ticket`: 14 seeded rows

Routes (18):

- `list_customers`: GET /customers
- `get_customer`: GET /customers/{id}
- `create_customer`: POST /customers
- `list_events`: GET /events
- `get_event`: GET /events/{id}
- `create_event`: POST /events
- `update_event`: PATCH /events/{id}
- `list_sections`: GET /events/{event_id}/sections
- `get_section`: GET /sections/{id}
- `create_section`: POST /sections
- `list_seats`: GET /seats
- `get_seat`: GET /seats/{id}
- `create_seat`: POST /seats
- `list_holds`: GET /holds
- `get_hold`: GET /holds/{id}
- `list_orders`: GET /orders
- `get_order`: GET /orders/{id}
- `list_order_tickets`: GET /orders/{order_id}/tickets

Actions (4):

- `place_hold`: POST /holds
- `release_hold`: POST /holds/{id}/release
- `checkout`: POST /checkout
- `refund_order`: POST /orders/{id}/refund

Jobs (1):

- `expire_holds`: every 1m

## Assumed and why

- clock.start is 2026-10-07T09:00:00.000Z with tick 0s; time moves only through explicit advances and jobs.
  - Why: Seeded history (paid orders, expired holds) sits before the start; event dates and hold expiries are planned future times. A zero tick keeps hold expiry (exactly +15m) and the 48h boundary exactly testable.
- A hold covers exactly one seat; a customer holds several seats by placing several holds. Checkout takes customer_id and event_id and pays all of that customer's live holds on the event in one order.
  - Why: Action inputs are scalar, so a list of hold ids cannot be sent; this also mirrors a cart per event.
- The 6-ticket cap counts active holds plus valid tickets of non-refunded orders for the same customer and event, enforced at hold time and rechecked at checkout.
  - Why: Counting only paid tickets would let a customer hold more than they may buy.
- Refund is allowed when minutes between now and event starts_at is at least 48*60 (exactly 48h is allowed), always for the full order, and it is the only refund path.
  - Why: The description says 'until 48 hours before the show'; partial refunds are not mentioned.
- Hold expiry is checked by the expire_holds job every minute and also by checkout and place_hold via expires_at, so an expired hold is never paid even between job runs.
  - Why: Avoids dependence on job timing.
- Payment is simulated: checkout succeeds with no card data or payment provider.
  - Why: The value is the stateful ticketing workflow, not payment processing.
- Event status is a plain enum (on_sale, cancelled) edited with PATCH; cancelling does not auto-refund existing orders.
  - Why: Keeps the world focused on the stated rules; cancellation refunds are out of scope.
- Prices are USD in minor units on the section; tickets copy the price at checkout.
  - Why: A later price change must not change what was paid.
- Acceptance tests create everything through POST routes (customers, events, sections, seats) and rely on the clock start 2026-10-07T09:00:00.000Z; each test starts from a fresh clock. place_hold and checkout answer 201, release_hold and refund_order answer 200. Error codes used: seat_unavailable, event_not_on_sale, hold_limit_exceeded, no_active_holds, refund_window_closed, invalid_state, all 409. The expire_holds job is exercised through ctx.advance, not listed as a test action.
  - Why: Fixes the public contract the later stages must implement; acceptance test actions name only workflow actions, jobs are triggered by advancing time.
- List endpoints use cursor paging with data and next_cursor; holds has pageSize 10 and the other lists 25.
  - Why: The default API shape; a small hold page makes a paging task meaningful.

## Questions asked of the input

- Does the 6-ticket cap count active holds, or only paid tickets?
  - Default answer: Active holds plus valid paid tickets count, per customer and event.
- Is a refund allowed exactly 48 hours before the show?
  - Default answer: Yes; the window closes when fewer than 48 hours remain.
- Can part of an order be refunded?
  - Default answer: No, only the full order.
- Should the 15-minute hold be extendable or restartable?
  - Default answer: No; the hold has a fixed expiry and the customer places a new hold after it expires.
- Can one hold cover several seats?
  - Default answer: No, one hold is one seat; checkout pays all live holds of a customer for an event together.
- Does cancelling an event refund its orders?
  - Default answer: No; cancelling only stops new holds.

## Left out

- Payment processing, cards, fees and taxes
  - Why: Not stateful box-office logic; checkout is simulated.
- Seat map geometry and best-available seat selection
  - Why: Seats are plain rows addressed by id, row label and number.
- Partial or per-ticket refunds
  - Why: Refunds are full-order to keep the 48h rule clear.
- Automatic refunds on event cancellation
  - Why: A separate workflow not in the request.
- Dynamic pricing, promo codes, waitlists, ticket transfers, emails and QR codes
  - Why: Not requested.

## Proof

The engine check passed: 7 world tests, 5 warnings. Each row is one engine TaskVerdict.

World id (WID): `wid_d76b44ba60f093b8cff0444e46374b7b83019985f93fcc6a68b25d480d4a6428`.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix | TID |
|---|---|---|---|---|---|---|
| release_customer_hold | easy | 1.000 | 0.000 | 0.000, 0.000, 0.000 | n/a | `tid_2200dbbeb4d002a2c460ed511934c374c9b6f3c951a6bec0fc19a58e51278620` |
| refund_refundable_orders | medium | 1.000 | 0.000 | 0.000, 0.000, 0.000 | 0.000 | `tid_9ee73f704873377266cb54bee9bf1ecf25dd0687f1211909820c0ce91717f80b` |
| checkout_all_live_holds_for_event | hard | 1.000 | 0.000 | 0.000, 0.250, 0.000, 0.000 | 0.750 | `tid_c7537c85de8fa92771bc8a6f40324c49f4a19a9edb2d0783393a17a66a3ab763` |

Decoys:

- `release_customer_hold` 0.000: releases the first active hold on the event, which belongs to a different customer
- `release_customer_hold` 0.000: checks out Dana's hold and pays for the seat instead of releasing it
- `release_customer_hold` 0.000: releases Dana's hold but also releases another customer's active hold on the same event
- `refund_refundable_orders` 0.000: refunds only the first paid order it finds and stops
- `refund_refundable_orders` 0.000: refunds Priya's refundable orders and also refunds a refundable order of a different customer
- `refund_refundable_orders` 0.000: refunds only the orders whose event is the earliest-starting refundable one and skips the later event
- `checkout_all_live_holds_for_event` 0.000: picks the first event matching 'Harbor' (Harbor City Philharmonic) instead of Neon Harbor Live and checks out its holders
- `checkout_all_live_holds_for_event` 0.250: checks out only the first customer holding seats and stops
- `checkout_all_live_holds_for_event` 0.000: checks out every event on which each active holder has holds, not only Neon Harbor Live
- `checkout_all_live_holds_for_event` 0.000: releases the active holds on the event instead of paying for them

## Run

Mode: create from description. Model: claude-sonnet-5-5. Budget: $3.00.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 2 | 3.42 | 0.6151 |
| model | 1 | 0.67 | 0.3835 |
| workflow | 1 | 0.42 | 0.3367 |
| seed | 1 | 1.35 | 0.4052 |
| tasks | 1 | 1.58 | 0.4594 |
| Total | 6 | 7.44 | 2.1999 |

Run total: 7.48 minutes, $2.1999.
