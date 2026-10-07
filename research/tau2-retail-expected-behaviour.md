# tau2 retail: expected behaviour for the description case

This is the hand-checked oracle for the description case. A-54 (user decision U-9) makes tau2 retail the description input, and `research/benchmark-reuse.md` sets the plan: give WorldGen the retail policy, replay tau2's gold actions against the generated world, and compare end states. This note fixes the ground truth that comparison measures against.

Everything below was read from **sierra-research/tau2-bench at commit `5bfa7e3`** (main, 2026-10-06), MIT licence:

- `data/tau2/domains/retail/policy.md`
- `src/tau2/domains/retail/data_model.py` and `tools.py`
- `data/tau2/domains/retail/tasks.json` and `split_tasks.json`
- `data/tau2/domains/retail/db.json`
- `src/tau2/evaluator/evaluator.py` and `evaluator_env.py`

How claims are marked:

- **[repo]**: confirmed in those files. A file and line or a quote is given.
- **[world]**: our decision.
- **[unconfirmed]**: not checked against the repo. I did not read the tau-bench or tau2 papers, so nothing here leans on them.

## 1. The domain [repo]

**Database counts:** 50 products, 500 users, 1,000 orders. The order statuses in `db.json` are pending 423, delivered 373, processed 102 and cancelled 102.

| Object | Fields (`data_model.py`) | Id shape |
|---|---|---|
| User | `user_id`, `name` {first_name, last_name}, `address` {address1, address2, city, country, state, zip}, `email`, `payment_methods` (dict by id), `orders` (list of order ids) | `sofia_li_9219` |
| Payment method | `source` is one of `credit_card` (`brand`, `last_four`), `paypal`, or `gift_card` (`balance`: float) | `credit_card_8105988`, `gift_card_3491931`, `paypal_8194385` |
| Product | `product_id`, `name`, `variants` (dict by item id) | 10-digit string |
| Variant (item) | `item_id`, `options` (dict, for example `{color: blue, size: M}`), `available` bool, `price` float | 10-digit string. The policy says: "Product ID and Item ID have no relations and should not be confused!" |
| Order | `order_id`, `user_id`, `address`, `items` [{name, product_id, item_id, price, options}], `status`, `fulfillments` [{tracking_id[], item_ids[]}], `payment_history` [{transaction_type payment\|refund, amount, payment_method_id}], and optional `cancel_reason`, `exchange_items`, `exchange_new_items`, `exchange_payment_method_id`, `exchange_price_difference`, `return_items`, `return_payment_method_id` | `#W4689314` (the leading `#` is part of the id) |

**Order statuses** (`OrderStatus`): `processed`, `pending`, `pending (item modified)`, `delivered`, `cancelled`, `exchange requested`, `return requested`.

**Cancel reasons** (`CancelReason`): `no longer needed`, `ordered by mistake`.

All times are EST, 24-hour (policy, "Domain basic"). Prices are floats rounded to 2 decimals with `round(x, 2)` in the tools.

## 2. Policy rules

| # | Rule (policy.md) | Enforced by a tool? |
|---|---|---|
| P1 | Authenticate the user first: find the user id by email, or by name + zip, "even when the user already provides the user id" | **No.** It is conversational, and no tool checks it. |
| P2 | Help one user per conversation, and deny requests about other users | No |
| P3 | Before any write, list the details and get an explicit "yes" | No |
| P4 | One tool call at a time. Transfer to a human only when out of scope, then send the fixed message. | No |
| P5 | Cancel only `pending` orders. The reason must be `no longer needed` or `ordered by mistake`. | Yes: `cancel_pending_order` |
| P6 | Modify (address, payment, items) only pending orders | Yes, but see Q1 |
| P7 | Modify payment: a single method that differs from the original. A gift card needs a balance that covers the total. | Yes |
| P8 | Modify items: only once. Same product, a different available variant. The price difference is paid or refunded through a given method, and a gift card needs enough balance. Status becomes "pending (items modifed)" [sic]. | Yes, with the status string `pending (item modified)` |
| P9 | Return only `delivered` orders. The refund goes to the original payment method or an existing gift card. Status becomes `return requested`. | Yes |
| P10 | Exchange only `delivered` orders. Same product, an available variant. The difference is paid or refunded through a given method, and a gift card needs enough balance. Status becomes `exchange requested`. | Yes |
| P11 | Exchange or modify-items "can only be called once per order" | Yes, indirectly: the status change blocks a second call |
| P12 | A cancel refunds the total to the original method: "immediately if it is gift card, otherwise in 5 to 7 business days" | Yes: gift-card balances are credited at once. For other methods only a `refund` row is written. |

### Where code and policy disagree (code is what tau2 grades) [repo]

- **Q1.** `modify_pending_order_address` and `modify_pending_order_payment` guard with `"pending" in order.status` (`_is_pending_order`, `tools.py:132-138`). So they also accept `pending (item modified)`. The policy says the order cannot be modified after an items change. `cancel_pending_order` and `modify_pending_order_items` use `== "pending"`.
- **Q2.** In `modify_pending_order_items`, the second loop writes `item.price = variant.price` and `item.options = variant.options` using `variant` left over from the **last** iteration of the first loop. With 2 or more items, every modified item gets the last new variant's price and options. The payment difference is still computed per item. This affects 5 tasks (2 in the test split).
- **Q3.** `cancel_pending_order` writes a refund for **every** `payment_history` entry, refunds included, and credits gift cards for each. After `modify_pending_order_payment`, which adds a payment and a refund row, a cancel would over-refund. Only 1 task uses modify-payment.
- **Q4.** Exchange and return write no payment rows and change no balance. They record request fields only. Modify-items writes a payment row and moves gift-card balances at once.
- **Q5.** Exchange does not reject `new_item_id == item_id`. Modify-items does.
- **Q6.** Task 38's `known_info` gives the email `daikisanchez1479@example.com`, but the DB holds `daiki.sanchez1479@example.com`. So lookup by email fails there, and name + zip (46236) is the path that works.

## 3. Write actions and their guards [repo: `tools.py`]

Each guard is checked in the order shown. On failure tau2 raises `ValueError(<message>)` and the DB is unchanged. The last column is the error a faithful world returns.

| Tool | Guards and messages | Effects | Faithful world error |
|---|---|---|---|
| `cancel_pending_order(order_id, reason)` | "Order not found". Status `== pending`, else "Non-pending order cannot be cancelled". Reason in the two values, else "Invalid reason". | For each payment row: append a `refund` of the same amount to the same method, and credit gift cards (`round(.., 2)`). Status becomes `cancelled`, and `cancel_reason` is set. | 404, 409, 400 |
| `modify_pending_order_address(order_id, address1, address2, city, state, country, zip)` | "Order not found". `"pending" in status`, else "Non-pending order cannot be modified" (Q1). | `order.address` is replaced. The status is unchanged. | 404, 409 |
| `modify_pending_order_payment(order_id, payment_method_id)` | Order found. `"pending" in status` (Q1). "Payment method not found". Exactly one row and it is a `payment`, else "There should be exactly one payment for a pending order". A different method, else "The new payment method should be different from the current one". A gift card needs balance >= amount, else "Insufficient gift card balance to pay for the order". | Appends `payment(new)` and `refund(old)`. A new gift card is debited and an old gift card credited. | 404, 409, 404, 409, 409, 409 |
| `modify_pending_order_items(order_id, item_ids[], new_item_ids[], payment_method_id)` | Status `== pending`. Every old id is in the order, counting duplicates, else "<id> not found". The lengths match. new != old ("The new item id should be different from the old item id"). Each new variant is of the same product (`_get_variant`, "Variant not found") and available ("New item … not found or available"). The method exists. A gift card needs balance >= diff. | Appends `payment` if diff > 0, else `refund` of `abs(diff)`. A gift card's balance becomes balance - diff. Items are rewritten (Q2). Status becomes `pending (item modified)`. | 409, 404, 400, 400, 404/409, 409 |
| `return_delivered_order_items(order_id, item_ids[], payment_method_id)` | Status `== delivered`, else "Non-delivered order cannot be returned". The method exists, and it is a gift card or equal to `payment_history[0].payment_method_id`, else "Payment method should be the original payment method". The items exist, counting duplicates ("Some item not found"). | Status becomes `return requested`. `return_items = sorted(item_ids)`, and `return_payment_method_id` is set. No money moves (Q4). | 409, 400, 404 |
| `exchange_delivered_order_items(order_id, item_ids[], new_item_ids[], payment_method_id)` | Status `== delivered`. The items exist, counting duplicates. The lengths match. The new variants are of the same product and available. A gift card needs balance >= diff. | Status becomes `exchange requested`. `exchange_items` and `exchange_new_items` are sorted, and `exchange_payment_method_id` and `exchange_price_difference` (rounded) are set. No money moves. | 409, 404, 400, 404/409, 409 |
| `modify_user_address(user_id, …)` | "User not found" | Replaces the user's default address | 404 |

The reads are `find_user_id_by_email`, `find_user_id_by_name_zip`, `get_user_details`, `get_order_details`, `get_product_details`, `get_item_details` and `list_all_product_types`. `calculate` and `transfer_to_human_agents` are generic tools.

## 4. How a generated world should line up

There are two inputs, and the expectations differ:

- **(a)** `policy.md` as the description (the `benchmark-reuse.md` plan).
- **(b)** a one-line description such as "a retail store's customer-service backend with orders, returns and exchanges".

### Required shape in the engine's format [world]

The engine stores scalar values only and needs snake_case state names. So a faithful world normalises tau2's nested JSON like this:

| tau2 | World | Note |
|---|---|---|
| User (+ name, address) | `user` with flattened `first_name`, `last_name`, `address1` … `zip`, and `email` unique | |
| payment_methods dict | `payment_method` (user ref, `source` enum [credit_card, paypal, gift_card], `brand`, `last_four`, `balance` money nullable) | gift-card balance in integer cents |
| Product, Variant | `product`; `variant` (product ref, `options` canonical string such as `color=blue;size=M`, `available` bool, `price` money) | options as a sorted key=value string, because objects are not engine values |
| Order | `order` (user ref, flattened address, **`status` state**, `cancel_reason` enum nullable, `exchange_payment_method` ref nullable, `exchange_price_difference` money nullable, `return_payment_method` ref nullable) | |
| Order.items[] | `order_item` (order ref, variant ref, product ref, `price` money, `options` string, `position` int, `exchange_to` variant ref nullable, `return_requested` bool) | tau2's sorted id lists are rebuilt from these rows when comparing |
| payment_history[] | `payment` (order ref, `seq` int, `transaction_type` enum, `amount` money, `payment_method` ref) | append-only, ordered by `seq` |
| fulfillments[] | `fulfillment` and `fulfillment_item` | read-only in every tool |

Status machine: `pending`, `pending_item_modified`, `processed`, `delivered`, `cancelled`, `exchange_requested`, `return_requested`, with initial `pending`.

```yaml
transitions: { pending: [pending_item_modified, cancelled, processed],
               pending_item_modified: [processed],
               processed: [delivered], delivered: [exchange_requested, return_requested],
               cancelled: [], exchange_requested: [], return_requested: [] }
```

- **Fulfilment moves.** No tau2 tool moves an order from pending to processed to delivered; that happens outside the agent's scope. The engine still needs every state reachable, and behaviourally reachable, not just in seed (the lesson from the helpdesk note). So the world adds a `fulfilment` job [world]. Jobs fire only when the admin advances the clock, so it never runs during a task and cannot change a tau2 comparison.
- **Same-state writes:** address and payment modifies keep the state, and the store does not check same-state writes [engine]. They are allowed in `pending`, and, matching Q1, also in `pending_item_modified`. Whether to copy Q1 is a choice. The faithful-to-code choice is to allow it, and section 6 counts it either way.

### What must match (otherwise the world fails the yardstick)

1. **Guards P5 to P11, with the same outcome:** the same calls succeed, and the same calls fail with the DB unchanged. The exact message text need not match, but each failure maps to the HTTP status in section 3.
2. **Money effects:** refund rows on cancel, gift-card crediting on cancel (immediate), and gift-card debit and credit on modify-items and modify-payment. Amounts are in cents, equal to `round(tau2 float × 100)`.
3. **Return and exchange record requests without moving money** (Q4).
4. **Items:** the same product on modify and exchange, availability required, counts with duplicates respected.
5. **Ids are kept verbatim** (`#W…`, `sofia_li_9219`, 10-digit item ids) as unique key fields, so gold arguments can be replayed without a mapping table.

### Acceptable differences (they go in the report, not counted as failures)

- REST routes and JSON instead of Python tools, with one route per tool and the same argument names.
- Integer cents instead of floats.
- Flattened objects and the snake_case status names.
- Not copying the quirks Q2 and Q3. A world that prices each modified item correctly is **better** than tau2. The comparison excludes `order_item.price` and `options` on the 5 multi-item modify tasks, and payment rows on the one modify-payment task.
- The added fulfilment job and the transitions from pending to processed to delivered.
- P1 to P4 (authentication, one user, confirmation, one tool call at a time, human transfer). These are dialogue rules, and an end-state engine cannot grade them. The world may expose the two `find_user_id_*` reads, and should.
- With input (b): a different but equivalent vocabulary (`refund` vs `return`, `shipped` vs `processed`), provided an alias map is written in the plan. Missing modify-payment or modify-address is tolerated, and counted as "tool not expressible".

### Not acceptable

- Cancelling an order that is not pending.
- Returning or exchanging an order that is not delivered.
- A refund to a non-original, non-gift-card method.
- A gift-card overdraft.
- Changing the product type on exchange.
- A second items-modify on the same order.
- Inventing statuses that the tau2 tools write differently, such as a cancel landing in `refunded`.
- A stricter state machine that blocks a gold action list.

## 5. Three graded tasks, modelled on tau2 test tasks

These run on a **tau-seeded** variant of the world: the eval adapter (YOS-51) loads `db.json` into the world's fixtures, so the ids below are tau2's own. Each grader is binary to match tau2's DB check, and partial credit applies only where several writes are needed. The collateral gate (`ctx.changes()`) gives 0 for any other change. tau2's `nl_assertions` are dropped (11 test-split tasks have them; see section 6).

### Task 1 (easy), from tau2 task 38: cancel a pending order

> Customer Daiki Sanchez, zip 46236, wants to cancel the order they just placed because they no longer need it.

- The truth [repo, `db.json`]:
  - Two users are named Daiki Sanchez: `daiki_sanchez_3253` (46236 Indianapolis) and `daiki_sanchez_2422` (43240 Columbus).
  - The 46236 user has one order, `#W9348897`, which is `pending`. It is paid 1166.98 by `credit_card_8853416`.
- The gold write: `cancel_pending_order("#W9348897", "no longer needed")`.
- Grader: 1 if the order is `cancelled`, `cancel_reason = no longer needed`, and a new `refund` row of 116698 cents goes to `credit_card_8853416`. No gift card changes. Otherwise 0.
- Decoy (a), "uses the reason ordered by mistake": the order is cancelled, but the grader scores 0, as tau2 would (the hashes differ).
- Decoy (b), "follows the customer's fallback from tau2 task 38 and downgrades the items instead of cancelling": `modify_pending_order_items` on `#W9348897` to cheaper variants, paid by `credit_card_8853416`. That succeeds and leaves the order `pending_item_modified`, so it scores 0. (Matching by name only cannot be a decoy here: `daiki_sanchez_2422` has no orders.)

### Task 2 (medium), from tau2 task 51: return to the original card despite a wrong order number

> Sofia Li of San Antonio (78260) wants to return the digital camera she received and be refunded to the original payment method. She thinks the order is #W8855135 but isn't sure.

- The truth [repo]:
  - `#W8855135` is `pending` and has no camera.
  - The camera (item `5996159312`, 2895.55) is in `#W4689314`, which is `delivered` and was paid by `credit_card_8105988`.
  - There are three Sofia Lis, and only `sofia_li_9219` lives at 78260.
- The gold write: `return_delivered_order_items("#W4689314", ["5996159312"], "credit_card_8105988")`.
- Grader: 1 if `#W4689314` is `return_requested`, its only `return_requested` item is `5996159312`, and the return method is `credit_card_8105988`. No payment rows and no balance changes. Otherwise 0.
- Decoy (a), "trusts the guessed order number and, unable to return it, cancels it": `#W8855135` becomes `cancelled`. The gate gives 0.
- Decoy (b), "returns to the user's other card": `credit_card_3951670` is rejected (P9), with no successful write. That makes it trivial, so it is listed only as a guard test, not as a decoy.
- Decoy (c), "returns every item of the first delivered order found": `#W3916020` gets `return_requested`. The gate gives 0.

### Task 3 (hard), from tau2 task 55: cancel what has not shipped, return what has

> Amelia Silva of Philadelphia (amelia.silva7872@example.com) wants to cancel every order that hasn't shipped yet because she no longer needs it, and return every item from every delivered order, refunded to her gift card.

- The truth [repo]: `amelia_silva_7726` has 6 orders:

  | Order | Status | Detail |
  |---|---|---|
  | `#W4836353` | pending | 1429.81, paid by gift card |
  | `#W7342738` | pending | 1030.40, paid by gift card |
  | `#W4597054` | delivered | 4 items |
  | `#W7773202` | delivered | 1 item |
  | `#W2586676` | cancelled | |
  | `#W5400801` | cancelled | |

  `gift_card_3491931` has a balance of 73.00.
- The gold writes:
  1. Cancel `#W4836353` with reason "no longer needed".
  2. Cancel `#W7342738` with reason "no longer needed".
  3. Return `#W4597054` items [5669664287, 4900990404, 9862136885, 6777246137] to `gift_card_3491931`.
  4. Return `#W7773202` item [8277474082] to `gift_card_3491931`.
- End balance: 73.00 + 1429.81 + 1030.40 = **2533.21**. The returns add nothing (Q4).
- Grader: the gate first. Then a quarter point for each of the 4 order outcomes that is fully right. The gift-card balance must equal 253321 cents for either cancel to count. Every strict prefix scores below 1, and noop scores 0.
- Decoy (a), "cancels but forgets the returns": scores 0.5.
- Decoy (b), "returns only the items it remembers": it leaves out the water bottle `6777246137` from `#W4597054`, so it scores 0.75.
- Decoy (c), "refunds returns to the 'original' method when it means the order's first payment": the original method *is* the gift card here, so this is a non-decoy. Listed so nobody adds it.
- Decoy (d), "uses ordered by mistake as the reason": both cancels score 0, so it scores 0.5.

## 6. Comparing our grader with tau2's end-state check [repo: `evaluator_env.py:118-129`, `evaluator.py:223-256`]

- **tau2:** replay the gold actions on a fresh environment, hash the agent's DB and the user's DB on both sides, and set `db_reward` to 1.0 only if both hashes match. The final reward is the product of the bases in `reward_basis`: DB × NL_ASSERTION, and others when listed. So tau2 is all-or-nothing over the **whole DB**.
- **Ours:** a grader snippet scores 0 to 1 over the end state, with a collateral gate over `ctx.changes()`.

How to compare (YOS-51):

1. **Project.** Convert the world's end state back into tau2's shape (section 4 table): cents to `amount / 100`, rebuild the sorted `exchange_*` and `return_items` lists, and map the snake_case statuses back.
2. **Expected.** Run tau2's gold list through tau2's own tools on `db.json`, or reuse the Harbor tau3 adapter's oracle.
3. **Equality.** Compare the projected world DB with the expected DB, field by field, excluding the section 4 exclusions (Q2 and Q3). Report `db_equal` per task. This is the analogue of tau2's `db_match`.
4. **Grader agreement.** For each task where our world has a graded task, check that `our_score == 1` exactly when `db_equal`. Any disagreement is a grader bug on one side. List it.
5. **Expressibility.** Report how many of the 40 test tasks' gold lists the world can replay at all (every write maps to a route), how many end `db_equal`, and pass^k with tau2's `comb(successes, k) / comb(trials, k)` (`benchmark-reuse.md`). 4 of the 40 test tasks have no write, so they trivially match on DB.
6. **What we cannot compare.** The 11 test tasks with `nl_assertions` are compared on DB only, and the report says so.

## 7. Open points

1. Q1 (copy the code's looser pending check, or the policy's stricter one?). The recommendation is to copy the code, because gold lists come from the code.
2. Whether to copy Q2 and Q3 at all. The recommendation is no, with the comparison exclusions above.
3. Task 1 decoy (b) needs at least one item of `#W9348897` with a cheaper available variant of the same product. That was not checked. YOS-51 should check it and swap the decoy if it fails.
4. Contamination: mark the case `known` in `eval/suite.yaml`, per `benchmark-reuse.md`. It never counts as unseen-prompt evidence.
