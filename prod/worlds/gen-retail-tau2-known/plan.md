# WorldGen plan: Retail customer-service backend in the style of the tau-bench retail domain, backed by a Shopify-like order and refund model (orders, line items, variants, payment methods, gift cards, refunds)

An online store's support backend. Customers have saved payment methods (credit card, PayPal, gift card with a balance). Products have variants (size and color) with their own price and stock. Orders move pending -> shipped -> delivered. A pending order can be cancelled, or have its address, payment method or items changed (items only once, only to another variant of the same product). A delivered order can have items returned or exchanged for another variant of the same product. Money goes back to the original payment method or to one of the user's gift cards, and every refund is recorded. Every state change goes through an action that enforces these rules. A job issues refunds that are waiting and completes return and exchange requests.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-10-06T09:00:00.000Z, tick 1s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `user` | A customer. Support finds them by email or name. | first_name, last_name, email (unique), address_line, city, state_code, zip, country |
| `payment_method` | A saved payment method owned by a user. Gift cards carry a balance. | user_id (ref user), kind (credit_card\|paypal\|gift_card), label (e.g. Visa ending 4242), balance (money, nullable, gift cards only) |
| `product` | A catalog product such as a jacket or a mechanical keyboard. Each product has many variants. | name, category |
| `variant` | A purchasable option of a product, with its own options, price and stock. | product_id (ref product), option_summary (e.g. color blue, size L), price (money), available (bool), stock (int) |
| `order` | A purchase by a user. It has a shipping address, a payment method and a lifecycle status. | user_id (ref user), status (state), payment_method_id (ref payment_method), ship_address_line / city / state_code / zip / country, total (money), items_modified (bool, readonly), cancel_reason (enum, nullable), placed_at, delivered_at |
| `order_item` | A line item on an order. It tracks any return or exchange request. | order_id (ref order), product_id (ref product), variant_id (ref variant), quantity (int), unit_price (money), return_status (none\|return_requested\|exchange_requested\|returned\|exchanged), exchange_variant_id (ref variant, nullable) |
| `refund` | A record of money going back to a payment method, or of the extra charge on an exchange. | order_id (ref order), payment_method_id (ref payment_method), amount (money), kind (cancellation\|return\|exchange_difference), status (state: pending\|issued), issued_at |

## Workflows

### order_lifecycle (order)
- States: pending, shipped, delivered, cancelled, return_requested, exchange_requested, returned, exchanged
- Actions: cancel_order, modify_pending_order_address, modify_pending_order_payment, modify_pending_order_items, return_delivered_order_items, exchange_delivered_order_items
- Rules:
  - pending can go to shipped or cancelled. shipped goes to delivered. delivered goes to return_requested or exchange_requested. return_requested goes to returned. exchange_requested goes to exchanged. cancelled, returned and exchanged are final.
  - cancel_order only works on a pending order. The reason is 'no longer needed' or 'ordered by mistake'. It creates a cancellation refund for the full total to the original payment method, restocks the items, and sets cancel_reason.
  - modify_pending_order_address and modify_pending_order_payment only work on a pending order. The new payment method must belong to the same user and differ from the current one. A gift card must hold at least the order total.
  - modify_pending_order_items only works on a pending order that has items_modified=false. Each swap maps an order_item to a variant of the same product that is available and differs from the current one. A swap may only change the variant. Quantity stays. The price difference is settled on a payment_method_id the caller gives, which must belong to the user. If the new total is higher, a gift card needs enough balance and it is debited. If the total is lower, an exchange_difference refund is created. The order total is recomputed and items_modified is set.
  - return_delivered_order_items only works on a delivered order. It takes order_item ids and a refund destination, which is the original payment method or a gift card of the user. It marks the items return_requested, moves the order to return_requested, and creates a return refund for the sum of the returned items.
  - exchange_delivered_order_items only works on a delivered order. It takes order_item ids with a new variant for each, which must be the same product and available, and a payment_method_id for the price difference. It marks the items exchange_requested with exchange_variant_id, moves the order to exchange_requested, and handles the difference like modify_pending_order_items. The new variant's stock goes down and the old one's goes up.
  - An order with a return or exchange already requested refuses further return or exchange calls with 409.
### refund_lifecycle (refund)
- States: pending, issued
- Actions: cancel_order, return_delivered_order_items, exchange_delivered_order_items, modify_pending_order_items
- Rules:
  - A refund to a gift card is created as issued, with issued_at set, and its balance is credited immediately.
  - A refund to any other payment method is created as pending. The issue_pending_refunds job issues it after 24 hours.
  - An issued refund is final.
### user_profile (user)
- States: none
- Actions: update_user_address
- Rules:
  - update_user_address changes the user's default address only. Existing orders keep their shipping address.

## Jobs

- `issue_pending_refunds` runs every 6h: Every pending refund at least 24 hours old becomes issued with issued_at set to now. It is never credited twice, because gift card refunds are created as issued and credited at creation.
- `complete_return_and_exchange_requests` runs every 1d: A return_requested order whose last update is at least 72 hours old becomes returned, its return_requested items become returned, and the stock goes back. An exchange_requested order of the same age becomes exchanged and its items become exchanged.

## Acceptance tests

None. The plan records no acceptance test.

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_users` | GET | /users | List users. Filter by email, search by name or email. |
| `get_user` | GET | /users/{id} | Get one user with address. |
| `list_payment_methods` | GET | /users/{user_id}/payment_methods | List a user's payment methods, filterable by kind. |
| `list_products` | GET | /products | List products. Filter by category, search by name. |
| `get_product` | GET | /products/{id} | Get one product. |
| `list_product_variants` | GET | /products/{product_id}/variants | List a product's variants. Filter by available. |
| `get_variant` | GET | /variants/{id} | Get one variant. |
| `list_orders` | GET | /orders | List orders. Filter by user_id and status, sort by created_at. |
| `get_order` | GET | /orders/{id} | Get one order. |
| `list_order_items` | GET | /orders/{order_id}/items | List an order's line items. |
| `list_refunds` | GET | /refunds | List refunds. Filter by order_id, payment_method_id, kind and status. |
| `get_refund` | GET | /refunds/{id} | Get one refund. |
| `cancel_order` | POST | /orders/{id}/cancel | Cancel a pending order with a reason and refund it to the original payment method. |
| `modify_pending_order_address` | POST | /orders/{id}/address | Change a pending order's shipping address. |
| `modify_pending_order_payment` | POST | /orders/{id}/payment | Change a pending order's payment method. The new method must differ, and a gift card needs enough balance. |
| `modify_pending_order_items` | POST | /orders/{id}/modify_items | Swap items on a pending order for other variants of the same product. Allowed once per order. |
| `return_delivered_order_items` | POST | /orders/{id}/return | Request a return of delivered items, refunded to the original payment method or a gift card. |
| `exchange_delivered_order_items` | POST | /orders/{id}/exchange | Request an exchange of delivered items for other variants of the same product. |
| `update_user_address` | POST | /users/{id}/address | Change a user's default address. Orders already placed are not changed. |

## Seed

- Rows per entity: user: 60, payment_method: 130, product: 30, variant: 260, order: 160, order_item: 420, refund: 45
- Mix: Orders: about 28% pending, 14% shipped, 33% delivered, 12% cancelled, 4% return_requested, 4% exchange_requested, 3% returned, 2% exchanged. Delivered orders are 1 to 40 days old, pending orders 0 to 5 days. Payment methods per user: 1 to 3, about 45% credit card, 25% PayPal, 30% gift card, each gift card with a balance of 5 to 200 dollars. Most variants are available, with about 12% unavailable or at stock 0. Each product has 6 to 12 variants and prices span 8 to 450 dollars. Orders have 1 to 5 items, and each order total equals the sum of its items. Refunds exist for cancelled, returned and exchanged orders. Gift card refunds are issued, others are a mix of pending and issued. Several users have the same first name or last name, such as two Yusuf Rossis in different cities, and some users have 3 or more pending orders, so the search and paging are not trivial. Anchor users exist for the tasks.

## Tasks

- `cancel_pending_order_mistake` (easy): Yusuf Rossi (the one in Austin) has one pending order that contains a standing desk. Cancel it because it was ordered by mistake. The grader checks the order is cancelled with reason 'ordered by mistake', one cancellation refund exists to the original payment method for the full total, and nothing else changed.
  - Decoy idea: Cancels the pending order of the other Yusuf Rossi, who lives in a different city. Another decoy PATCHes status directly, or cancels with reason 'no longer needed'.
- `exchange_delivered_jacket_to_gift_card_diff` (medium): Mei Tanaka received a delivered order with a rain jacket in size M. She wants the same jacket in size L, in the same color, and the price difference paid with her gift card. Exchange the item. The grader checks the item points to the correct available variant (same product, size L, same color), the order is exchange_requested, the gift card balance dropped by exactly the price difference, and no other order was touched.
  - Decoy idea: Picks a different color in size L, or picks the first available variant of the product. Another decoy exchanges using the credit card instead of the gift card. Another picks the jacket from Mei's older delivered order.
- `return_and_cancel_across_orders` (hard): Priya Nair has several orders. For her pending orders, cancel every one that contains a wireless mouse, with reason 'no longer needed'. For her delivered orders, return the wireless mouse items (and only those items) with the refund going to her gift card. Do not touch other orders or items. Her order list spans more than one page. The grader checks every target pending order is cancelled, every delivered mouse item is return_requested, each return refund goes to her gift card for the sum of those items and is issued, and all other rows are unchanged. The score is the fraction of targets done, and 0 if any collateral change is found.
  - Decoy idea: Reads only the first page of orders, so it misses targets. Another returns the whole delivered order instead of only the mouse items. Another refunds to the original credit card instead of the gift card. Another cancels all of Priya's pending orders, mouse or not. Another also cancels shipped orders by PATCH.
- `modify_pending_items_once` (medium): Amara Okafor has a pending order with a mechanical keyboard in a tenkeyless layout and a USB-C hub. Change the keyboard to the full-size layout of the same model, in the same switch type, and pay or receive the difference on her PayPal. Leave the hub alone. The grader checks only the keyboard line changed, the order total is recomputed, items_modified is true, and the refund or charge went to PayPal.
  - Decoy idea: Swaps to the full-size variant with a different switch type. Another swaps both items. Another does two separate modify calls, where the second is refused with 409 and the first swap is incomplete. Another settles the difference on the gift card.

## Open questions

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

## Assumptions

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

## Out of scope

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

## Changes

None. The plan changes no existing item.
