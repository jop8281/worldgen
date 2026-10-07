# WorldGen report: Retail customer-service backend in the style of the tau-bench retail domain, backed by a Shopify-like order and refund model (orders, line items, variants, payment methods, gift cards, refunds)

An online store's support backend. Customers have saved payment methods (credit card, PayPal, gift card with a balance). Products have variants (size and color) with their own price and stock. Orders move pending -> shipped -> delivered. A pending order can be cancelled, or have its address, payment method or items changed (items only once, only to another variant of the same product). A delivered order can have items returned or exchanged for another variant of the same product. Money goes back to the original payment method or to one of the user's gift cards, and every refund is recorded. Every state change goes through an action that enforces these rules. A job issues refunds that are waiting and completes return and exchange requests.

## What was built

Entities (7):

- `user`: 60 seeded rows
- `payment_method`: 132 seeded rows
- `product`: 30 seeded rows
- `variant`: 240 seeded rows
- `order`: 160 seeded rows
- `order_item`: 361 seeded rows
- `refund`: 30 seeded rows

Routes (12):

- `list_users`: GET /users
- `get_user`: GET /users/{id}
- `list_payment_methods`: GET /users/{user_id}/payment_methods
- `list_products`: GET /products
- `get_product`: GET /products/{id}
- `list_product_variants`: GET /products/{product_id}/variants
- `get_variant`: GET /variants/{id}
- `list_orders`: GET /orders
- `get_order`: GET /orders/{id}
- `list_order_items`: GET /orders/{order_id}/items
- `list_refunds`: GET /refunds
- `get_refund`: GET /refunds/{id}

Actions (7):

- `cancel_order`: POST /orders/{id}/cancel
- `modify_pending_order_address`: POST /orders/{id}/address
- `modify_pending_order_payment`: POST /orders/{id}/payment
- `modify_pending_order_items`: POST /orders/{id}/modify_items
- `return_delivered_order_items`: POST /orders/{id}/return
- `exchange_delivered_order_items`: POST /orders/{id}/exchange
- `update_user_address`: POST /users/{id}/address

Jobs (2):

- `issue_pending_refunds`: every 6h
- `complete_return_and_exchange_requests`: every 1d

## Assumed and why

- Money is USD in cents, using the money type.
  - Why: The input names no currency. The tau-bench retail domain is dollar-based.
- The lookup is by email or name through list search. There is no login.
  - Why: Support-rep tools identify the customer before acting. This avoids an auth layer.
- Orders have states pending, shipped, delivered, cancelled, return_requested, exchange_requested, returned and exchanged. Plain create/update routes are not exposed for orders, so every transition goes through an action.
  - Why: The state machine is the core of the world. A PATCH on status would skip the business rules.
- The gift card is a payment_method with kind=gift_card and a balance. The credit_card and paypal kinds have a null balance.
  - Why: This matches tau-bench. One entity covers 'original payment method' and 'gift card' refunds.
- Item modification is allowed once per pending order (items_modified flag). Variants must belong to the same product and be available.
  - Why: The input says 'modified' and 'exchanged for another variant of the same product'. The one-shot rule gives agents a real trap.
- Return and exchange requests mark the order and its items. The job later moves the order to returned or exchanged and restocks. A refund row is created at request time.
  - Why: This gives a visible intermediate state and a place for a time-based job.
- The refund kinds are cancellation, return and exchange_difference. The status is pending or issued. A gift card refund is issued instantly, and other refunds are issued by a job after 24 hours.
  - Why: Agents must choose the destination correctly. The pending-to-issued difference lets graders check the destination without time travel.
- Exchange price differences: if the new item costs more, the user is charged on the chosen payment method. A gift card needs enough balance, and it is debited. If the new item costs less, an exchange_difference refund is created.
  - Why: This gives hard tasks a rule to get wrong, and the money stays consistent.
- The order total equals the sum of quantity times unit_price over its items. The actions keep this true.
  - Why: The seed and actions must agree on totals, or the seed.totals_mismatch warning fires.
- The clock starts at 2026-10-06T09:00:00Z with a 1s tick. Seeded delivered orders are 1 to 40 days old.
  - Why: Today is 2026-10-06. Tasks cannot advance time, so time-dependent facts come from the seed.
- Seed data is deterministic and handwritten. Anchor users with known names exist for the tasks. Names and products are realistic, not lorem ipsum.
  - Why: Tasks must be solvable by discovery through search and paging.

## Questions asked of the input

- Which real system should this mirror?
  - Default answer: A tau-bench-style retail support API on a Shopify-like order model, with no real vendor API fidelity.
- Is there authentication, or does the agent act as a support rep who looks users up by email or name?
  - Default answer: No auth. The agent is a support rep and finds users with GET /users?q=<email or name>.
- Can a pending order's items be modified more than once?
  - Default answer: No. Modifying items is allowed once per pending order. After that, items_modified is true and further modifications get 409.
- What counts as a valid item modification or exchange?
  - Default answer: The new variant must belong to the same product as the old one, be available, and differ from the old one. The price difference is charged to or refunded to a payment method the user picks. A gift card must have enough balance.
- Where can refunds go?
  - Default answer: Only to the order's original payment method or to a gift card the user owns. A refund to a gift card is issued instantly and credits the balance. Other refunds start pending and the job issues them after 24 hours.
- Can a delivered order be partly returned?
  - Default answer: Yes, by listing order item ids. Each item can be returned or exchanged once. An order has one open return or exchange request at a time, and one action per order, not both.
- Are returned goods put back into stock?
  - Default answer: Yes for exchanges, where the new variant's stock goes down and the old one's goes up. Returns restock when the job completes the return. Cancellations restock immediately.
- Do shipped orders accept changes?
  - Default answer: No. Only pending orders can be cancelled or modified, and only delivered orders can be returned or exchanged.
- Are cancellation reasons restricted?
  - Default answer: Yes. The reason is 'no longer needed' or 'ordered by mistake'.
- Is there a human transfer or escalation path?
  - Default answer: No. Out of scope.
- What currency?
  - Default answer: USD in integer cents.

## Left out

- Authentication, sessions and identity checks
  - Why: The agent acts as a support rep, and identity checks add no state-machine behavior to test.
- Real payment processing, card networks and payment gateways
  - Why: Payment methods and refunds are ledger rows, and the money moves only as modeled.
- Shipping carriers, tracking numbers and delivery scheduling
  - Why: The shipped to delivered step only needs to exist in the seed. No task depends on carrier logic.
- Transfer to a human agent, tickets and chat history
  - Why: The input describes order and refund operations only.
- Catalog management (creating or editing products and variants) and checkout
  - Why: The agent works on existing orders, so the catalog is read-only.
- Taxes, shipping fees, discounts and coupon codes
  - Why: The total is the sum of the items, which keeps the money rules checkable.
- Partial quantity returns (returning 1 of 3 units of one line)
  - Why: Returns and exchanges work on whole line items to keep refund math simple.

## Proof

The engine check passed: 14 world tests, 2 warnings. Each row is one engine TaskVerdict.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix |
|---|---|---|---|---|---|
| cancel_pending_order_mistake | easy | 1.000 | 0.000 | 0.000, 0.000, 0.000 | n/a |
| exchange_delivered_jacket_to_gift_card_diff | medium | 1.000 | 0.000 | 0.000, 0.000, 0.000 | n/a |
| return_and_cancel_across_orders | hard | 1.000 | 0.000 | 0.667, 0.000, 0.500, 0.000, 0.500 | 0.833 |
| modify_pending_items_once | medium | 1.000 | 0.000 | 0.000, 0.000, 0.000, 0.000 | n/a |

Decoys:

- `cancel_pending_order_mistake` 0.000: cancels the pending standing desk order of the other Yusuf Rossi, who lives in Denver
- `cancel_pending_order_mistake` 0.000: cancels the right order but with the reason 'no longer needed' instead of 'ordered by mistake'
- `cancel_pending_order_mistake` 0.000: only changes the shipping address of the right order instead of cancelling it
- `exchange_delivered_jacket_to_gift_card_diff` 0.000: picks size L in a different color (green) instead of the same color as the jacket she owns
- `exchange_delivered_jacket_to_gift_card_diff` 0.000: settles the price difference on the credit card instead of the gift card, so the gift card balance does not drop
- `exchange_delivered_jacket_to_gift_card_diff` 0.000: exchanges the jacket from her older delivered order (green, size XL) instead of the order with the size M jacket
- `return_and_cancel_across_orders` 0.667: reads only the first page of Priya's orders, so it misses the target orders on page 2
- `return_and_cancel_across_orders` 0.000: returns every item of the delivered orders instead of only the wireless mouse items
- `return_and_cancel_across_orders` 0.500: refunds the returned mouse items to the original payment method instead of the gift card
- `return_and_cancel_across_orders` 0.000: cancels every pending order of Priya, with or without a wireless mouse
- `return_and_cancel_across_orders` 0.500: cancels the pending mouse orders with the reason 'ordered by mistake' instead of 'no longer needed'
- `modify_pending_items_once` 0.000: swaps to the full-size layout but with a different switch type (not the same switch as the original)
- `modify_pending_items_once` 0.000: swaps both the keyboard and the USB-C hub in one call, although the hub should stay as it is
- `modify_pending_items_once` 0.000: modifies the hub in a first call and then tries the keyboard in a second call, which is refused with 409, so the keyboard never changes
- `modify_pending_items_once` 0.000: swaps to the correct keyboard variant but settles the price difference on the gift card, which debits its balance

## Run

Mode: create from description. Model: claude-sonnet-5-5 over the claude -p transport. Budget: $3.50.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 1.08 | 0.1002 |
| model | 1 | 0.55 | 0.0933 |
| workflow | 1 | 2.92 | 0.3712 |
| seed | 1 | 4.76 | 0.5835 |
| tasks | 1 | 3.31 | 0.5362 |
| Total | 5 | 12.62 | 1.6844 |

Run total: 12.64 minutes, $1.6844.

## Post-generation clock correction

The saved world now honors the plan's explicit 2026-10-06T09:00:00Z clock and one-second tick. The typed plan now records that clock. Relative order, refund and user dates are reseeded by the existing scripts; no seed or grader code is changed. Native engine checks and task proofs are rerun rather than changing graders. This correction is after generation and does not change the historical attempts, costs or timing above.
