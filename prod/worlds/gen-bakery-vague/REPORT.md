# WorldGen report: Square-for-Restaurants / Toast-style bakery management app: pre-orders and pickup, product catalog, recipes and ingredient stock, and daily production batches

A single-shop bakery back office. Customers place pickup orders (including pre-orders for a future pickup time). Staff confirm orders, mark them ready and hand them over. The kitchen runs production batches that consume ingredients, per each product's recipe, and add finished stock. Ingredient stock is tracked against reorder levels, and jobs expire uncollected orders and flag low stock.

## What was built

Entities (7):

- `customer`: 60 seeded rows
- `product`: 41 seeded rows
- `ingredient`: 30 seeded rows
- `recipe_line`: 135 seeded rows
- `bakery_order`: 140 seeded rows
- `order_line`: 334 seeded rows
- `production_batch`: 70 seeded rows

Routes (17):

- `list_products`: GET /products
- `get_product`: GET /products/{id}
- `create_product`: POST /products
- `update_product`: PATCH /products/{id}
- `list_ingredients`: GET /ingredients
- `get_ingredient`: GET /ingredients/{id}
- `list_recipe_lines`: GET /products/{product_id}/recipe
- `list_customers`: GET /customers
- `get_customer`: GET /customers/{id}
- `create_customer`: POST /customers
- `update_customer`: PATCH /customers/{id}
- `list_orders`: GET /orders
- `get_order`: GET /orders/{id}
- `list_order_lines`: GET /orders/{order_id}/lines
- `list_batches`: GET /batches
- `get_batch`: GET /batches/{id}
- `create_batch`: POST /batches

Actions (10):

- `create_ingredient`: POST /ingredients
- `add_recipe_line`: POST /products/{id}/recipe
- `place_order`: POST /orders
- `confirm_order`: POST /orders/{id}/confirm
- `mark_order_ready`: POST /orders/{id}/ready
- `complete_pickup`: POST /orders/{id}/pickup
- `cancel_order`: POST /orders/{id}/cancel
- `complete_batch`: POST /batches/{id}/complete
- `cancel_batch`: POST /batches/{id}/cancel
- `restock_ingredient`: POST /ingredients/{id}/restock

Jobs (2):

- `expire_uncollected_orders`: every 1h
- `flag_low_stock`: every 1h

## Assumed and why

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

## Questions asked of the input

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

## Left out

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

## Proof

The engine check passed: 8 world tests, 0 warnings. Each row is one engine TaskVerdict.

| Task | Difficulty | Solution | Noop | Decoys | Best prefix |
|---|---|---|---|---|---|
| mark_marias_order_ready | easy | 1.000 | 0.000 | 0.000, 0.000 | n/a |
| bake_croissants_after_restock | medium | 1.000 | 0.000 | 0.000, 0.000, 0.000, 0.000 | 0.000 |
| cancel_tomorrows_orders_for_discontinued_product | hard | 1.000 | 0.000 | 0.750, 0.000, 0.000, 0.000, 0.500, 0.000 | 0.750 |

Decoys:

- `mark_marias_order_ready` 0.000: marks some other customer's confirmed order ready instead of looking up Maria Lopez's order
- `mark_marias_order_ready` 0.000: marks Maria's order ready and then also completes the pickup, moving it past ready
- `bake_croissants_after_restock` 0.000: restocks the missing butter but never completes the batch
- `bake_croissants_after_restock` 0.000: restocks far more butter than is missing (5000) before completing, so the ingredient stock is wrong
- `bake_croissants_after_restock` 0.000: restocks every low-stock ingredient instead of only the missing one, then completes the batch
- `bake_croissants_after_restock` 0.000: restocks and completes the croissant batch correctly, then also renames the Butter Croissant product
- `cancel_tomorrows_orders_for_discontinued_product` 0.750: reads only the first page of confirmed orders, so it misses matching confirmed orders on page 2
- `cancel_tomorrows_orders_for_discontinued_product` 0.000: ignores the product and cancels every placed or confirmed order due tomorrow
- `cancel_tomorrows_orders_for_discontinued_product` 0.000: ignores the pickup date and cancels every placed or confirmed order containing the discontinued products
- `cancel_tomorrows_orders_for_discontinued_product` 0.000: also cancels ready orders containing the products that are due today or tomorrow
- `cancel_tomorrows_orders_for_discontinued_product` 0.500: checks only the first line of each order, so it misses orders where the discontinued product is a later line
- `cancel_tomorrows_orders_for_discontinued_product` 0.000: cancels the right orders correctly, then also renames the Baguette product

## Run

Mode: create from description. Model: claude-sonnet-5-5 over the claude -p transport. Budget: $3.50.

| Step | Attempts | Minutes | $ |
|---|---|---|---|
| plan | 1 | 0.64 | 0.0669 |
| model | 1 | 0.67 | 0.1323 |
| workflow | 2 | 3.47 | 0.5475 |
| seed | 3 | 4.63 | 0.7668 |
| tasks | 1 | 2.86 | 0.3984 |
| Total | 8 | 12.27 | 1.9119 |

Backtracks:

- `seed` to `workflow`: 3 issues

Run total: 12.32 minutes, $1.9119.

## Post-generation plan schema correction

The saved plan now explicitly records the existing world clock, 2026-01-05T09:00:00.000Z with tick 0s. This adds the clock required by the current typed plan schema. It does not regenerate the world or change seed data, tasks, original generation attempts, costs or timing. It establishes schema validity and plan/world clock agreement; it does not independently establish seed chronology or domain fidelity.
