# WorldGen plan: Square-for-Restaurants / Toast-style bakery management app: pre-orders and pickup, product catalog, recipes and ingredient stock, and daily production batches

A single-shop bakery back office. Customers place pickup orders (including pre-orders for a future pickup time). Staff confirm orders, mark them ready and hand them over. The kitchen runs production batches that consume ingredients, per each product's recipe, and add finished stock. Ingredient stock is tracked against reorder levels, and jobs expire uncollected orders and flag low stock.

- Revision: 2
- Verdict: proceed
- Clock: starts 2026-01-05T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `customer` | A person who orders from the bakery, with contact details and a loyalty tier. | name, email, phone, loyalty_tier |
| `product` | A sellable bakery item such as a sourdough loaf or croissant, with price and finished stock on hand. | name, category, price, stock_on_hand, par_level, active, contains_allergens |
| `ingredient` | A raw material such as flour or butter, with stock and a reorder level. | name, unit, stock_qty, reorder_level, low_stock |
| `recipe_line` | One ingredient quantity needed to produce one unit of a product. | product_id, ingredient_id, qty_per_unit |
| `bakery_order` | A pickup order from a customer with a status lifecycle and a total computed from its lines. | customer_id, status, pickup_at, total, placed_at, ready_at, note |
| `order_line` | A product and quantity on an order, with the unit price captured at order time. | order_id, product_id, quantity, unit_price |
| `production_batch` | A planned or completed bake of a quantity of one product. Completing it consumes ingredients and adds product stock. | product_id, quantity, status, scheduled_for, completed_at, baker_name |

## Workflows

### order_lifecycle (bakery_order)
- States: placed, confirmed, ready, picked_up, cancelled
- Actions: place_order, confirm_order, mark_order_ready, complete_pickup, cancel_order
- Rules:
  - placed -> confirmed or cancelled. confirmed -> ready or cancelled. ready -> picked_up or cancelled. picked_up and cancelled are final.
  - place_order needs at least one line. Every product must exist and be active, and every quantity must be at least 1. total is the sum of quantity times unit_price.
  - confirm_order needs product.stock_on_hand to cover every line, otherwise 409 insufficient_stock naming the product. It decrements stock_on_hand per line.
  - cancel_order from confirmed or ready adds the line quantities back to stock_on_hand. Cancelling a placed order changes no stock.
  - mark_order_ready sets ready_at to now. complete_pickup is allowed only from ready.
  - pickup_at must be in the future when an order is placed.
### production_batch_lifecycle (production_batch)
- States: planned, completed, cancelled
- Actions: complete_batch, cancel_batch
- Rules:
  - planned -> completed or cancelled. Both are final.
  - complete_batch needs each recipe ingredient stock_qty to cover quantity times qty_per_unit, otherwise 409 insufficient_ingredients naming the ingredient.
  - complete_batch subtracts the ingredients, adds quantity to product.stock_on_hand, sets completed_at, and refreshes low_stock on the ingredients it touched.
  - A product with no recipe lines cannot be batched (422 no_recipe).
### ingredient_stock (ingredient)
- States: ok, low
- Actions: restock_ingredient
- Rules:
  - low_stock is true when stock_qty is at or below reorder_level. It is a derived bool, not a state machine.
  - restock_ingredient adds a positive quantity and recomputes low_stock.

## Jobs

- `expire_uncollected_orders` runs every 1h: A ready order whose ready_at is more than 24 hours old becomes cancelled and its reserved stock goes back to product.stock_on_hand.
- `flag_low_stock` runs every 1h: Recompute ingredient.low_stock as stock_qty <= reorder_level for every ingredient.

## Acceptance tests

None. The plan records no acceptance test.

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_products` | GET | /products | List products, filtered by category and active, searchable by name, sortable by price and stock. |
| `get_product` | GET | /products/{id} | Read one product. |
| `create_product` | POST | /products | Add a product to the catalog. |
| `update_product` | PATCH | /products/{id} | Edit price, par level or active flag. stock_on_hand is readonly and changes only through batches and orders. |
| `list_ingredients` | GET | /ingredients | List ingredients, filtered by low_stock. |
| `get_ingredient` | GET | /ingredients/{id} | Read one ingredient. |
| `list_recipe_lines` | GET | /products/{product_id}/recipe | List the recipe lines of a product. |
| `list_customers` | GET | /customers | List customers, filtered by loyalty_tier, searchable by name and email. |
| `get_customer` | GET | /customers/{id} | Read one customer. |
| `create_customer` | POST | /customers | Register a customer. |
| `update_customer` | PATCH | /customers/{id} | Edit customer contact details. |
| `list_orders` | GET | /orders | List orders, filtered by status and customer_id, sortable by pickup_at and created_at. |
| `get_order` | GET | /orders/{id} | Read one order. |
| `list_order_lines` | GET | /orders/{order_id}/lines | List the lines of an order. |
| `place_order` | POST | /orders | Action. Create an order with its lines in one call, price the lines from the current product price and compute the total. Starts in placed. |
| `list_batches` | GET | /batches | List production batches, filtered by status and product_id, sortable by scheduled_for. |
| `get_batch` | GET | /batches/{id} | Read one batch. |
| `create_batch` | POST | /batches | Plan a production batch. It starts as planned. |
| `confirm_order` | POST | /orders/{id}/confirm | Action. Confirm a placed order and reserve finished stock. |
| `mark_order_ready` | POST | /orders/{id}/ready | Action. Mark a confirmed order ready for pickup. |
| `complete_pickup` | POST | /orders/{id}/pickup | Action. Hand a ready order to the customer. |
| `cancel_order` | POST | /orders/{id}/cancel | Action. Cancel a placed, confirmed or ready order and release reserved stock. |
| `complete_batch` | POST | /batches/{id}/complete | Action. Finish a planned batch: consume recipe ingredients and add product stock. |
| `cancel_batch` | POST | /batches/{id}/cancel | Action. Cancel a planned batch with no stock effect. |
| `restock_ingredient` | POST | /ingredients/{id}/restock | Action. Add a delivered quantity to an ingredient and refresh its low_stock flag. |

## Seed

- Rows per entity: customer: 60, product: 40, ingredient: 30, recipe_line: 130, bakery_order: 140, order_line: 340, production_batch: 70
- Mix: Orders: placed 15%, confirmed 25%, ready 10%, picked_up 40%, cancelled 10%. Batches: planned 30%, completed 62%, cancelled 8%. Products across bread, pastry, cake, cookie and drink categories, about 90% active. About a fifth of ingredients are below their reorder level. Loyalty tiers: none 55%, regular 35%, gold 10%. Reserved stock matches the confirmed and ready orders. Order totals equal the sum of their lines. Seed has a few named anchors: customer Maria Lopez with a confirmed custom cake order, a croissant product with a planned batch that is short of butter, and several confirmed orders for tomorrow's pickup. Realistic names and prices, no placeholder text. Seed rows predate the clock start.

## Tasks

- `mark_marias_order_ready` (easy): Mark Maria Lopez's confirmed custom cake order ready for pickup. The agent looks up the customer, finds her confirmed order and calls the ready action. Nothing else changes.
  - Decoy idea: Completes pickup instead of marking ready, or PATCHes status directly, or marks a different Maria's order.
- `bake_croissants_after_restock` (medium): The planned croissant batch cannot complete because butter is short. Restock butter by the missing amount and complete that batch. Do not touch other batches or ingredients.
  - Decoy idea: Restocks butter but never completes the batch, completes the wrong product's batch, or restocks far too many unrelated ingredients.
- `cancel_tomorrows_orders_for_discontinued_product` (hard): A product was discontinued. Cancel every placed or confirmed order due for pickup tomorrow that contains it, across all result pages. Orders already ready or picked up and orders without the product stay untouched. Reserved stock of the other products must be released correctly.
  - Decoy idea: Reads only page 1 of orders, cancels all orders for tomorrow regardless of product, cancels orders for the wrong day, or cancels ready orders too.

## Open questions

- Which real product should this mirror?
  - Default answer: A Square/Toast-style order and inventory API plus a simple production-planning module.
- Is it one bakery location or several?
  - Default answer: One location.
- Is it pickup only, or does it also deliver?
  - Default answer: Pickup only.
- Should payments be modeled?
  - Default answer: No. Orders carry a total, but nothing is charged.
- Should ingredient stock be tracked against recipes?
  - Default answer: Yes. Completing a batch consumes recipe ingredients and adds product stock.
- Should confirming an order reserve stock?
  - Default answer: Yes. Confirming decrements stock_on_hand and cancelling gives it back.
- Which currency applies?
  - Default answer: USD.

## Assumptions

- One shop, one currency (USD), no multi-location inventory.
  - Why: The input gives no detail about scale. A single shop is the simplest realistic default.
- Mirrors a Square/Toast-style order and inventory API, combined with a simple production-planning module.
  - Why: No named product was given. Bakeries need orders, stock and baking schedules.
- Orders are pickup only, with no delivery, and there is no real payment processing.
  - Why: Keeps the lifecycle small and deterministic.
- Order entity is named bakery_order, with prefix ord.
  - Why: Avoids clashing with the SQL word 'order'.
- Confirming an order reserves finished stock by decrementing product.stock_on_hand. Cancelling before pickup puts it back.
  - Why: Makes the product, order and batch workflows interact in a checkable way.
- Stock fields (stock_on_hand, stock_qty, status, totals) are readonly and change only through actions or jobs.
  - Why: Stops agents from bypassing the workflow with a plain PATCH.
- Order total is computed on place_order from the lines and the current product price. Prices captured in order_line do not change later.
  - Why: Mirrors real point-of-sale behavior and keeps totals consistent.
- Time is explicit. Jobs fire only when the clock advances.
  - Why: The engine default for deterministic worlds.
- Allergen info is a simple text or enum field on product and is not enforced in workflows.
  - Why: Informational only, since compliance logic is out of scope.
- The ingredient_stock workflow declares a descriptive lifecycle, because ok and low are derived from the low_stock flag and not held in a state field. Nothing in the world changes and all seed counts stay as they are.
  - Why: The change request asks for a plan-only revision.

## Out of scope

- Real payments, refunds, tips, tax calculation
  - Why: Needs a payment processor model. Not needed for the stock and order workflows.
- Delivery, couriers and addresses
  - Why: Pickup only keeps the scope small.
- Staff scheduling, payroll, authentication and roles
  - Why: Not part of the bakery order and production core.
- Supplier purchase orders and invoicing
  - Why: Restocking is a single direct action instead.
- Multi-location inventory and shelf-life/waste tracking
  - Why: One shop is enough to exercise the workflows.

## Changes

None. The plan changes no existing item.
