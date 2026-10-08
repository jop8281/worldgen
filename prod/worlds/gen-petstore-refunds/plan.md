# WorldGen plan: Swagger Petstore (OpenAPI 3.0 sample): pets, categories and store orders with inventory by pet status, plus order refunds

A pet store where pets move available → pending → sold as customers place, approve and deliver orders. Placing an order reserves the pet, delivery sells it, and deleting an open order releases it. A customer can ask for a refund on a delivered order. A refund is requested, then approved (optionally putting the pet back on sale) or rejected. The 9 spec operations are kept under their spec paths. Extras: list orders, categories, approve and deliver actions, and the refund actions and reads. This revision declares an allows list on every task, taken from the task instruction: which entities may be created, updated or deleted, the exact fields of updates, and a where of field values that picks the target rows. Nothing else is changed.

- Revision: 3
- Verdict: proceed
- Clock: starts 2026-10-07T09:00:00.000Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `category` | Pet category such as Dogs or Cats. Spec schema Category. | name |
| `pet` | A pet listed for sale. Status is a state machine available/pending/sold. Spec field names are kept: photoUrls, category, tags, status. | name, category, photoUrls, tags, status |
| `store_order` | A purchase order for a pet. Spec schema Order. Status placed/approved/delivered. complete is true once delivered. | petId, quantity, shipDate, status, complete |
| `refund` | A refund claim on a delivered store order. Status is a state machine requested/approved/rejected. Holds the amount in USD minor units, the customer's reason, whether the pet was restocked, and the decision note and time. | orderId, amount, reason, status, restock, decision_note, decided_at |

## Workflows

### pet_lifecycle (pet)
- States: available, pending, sold
- Actions: update_pet, place_order, deliver_order, delete_order, get_inventory
- Rules:
  - Placing an order is allowed only for an available pet and moves the pet to pending. A pet that is not available is refused with 409 pet_not_available. Enforced by: place_order. Tested by: pet_create_and_fetch
  - Delivering an order moves its pet from pending to sold.
  - Deleting a placed or approved order moves its pet from pending back to available. Deleting a delivered order leaves the pet sold. Enforced by: delete_order. Tested by: delete_order_releases_pet
  - A pet with a placed or approved order stays pending: update_pet may not move it to another status (409 pet_reserved). Other status changes follow the declared transitions, and sold may return to available. Enforced by: update_pet. Tested by: update_pet_by_body_id
  - Inventory counts pets by status. Enforced by: get_inventory. Tested by: inventory_tracks_status
  - New pets are always created available, and a pet referenced by any order cannot be deleted (409 delete.restricted).
### order_fulfilment (store_order)
- States: placed, approved, delivered
- Actions: place_order, approve_order, deliver_order, delete_order
- Rules:
  - An order is created placed with complete false. Client-supplied status other than placed or complete true is refused with 422 invalid_status. Quantity must be at least 1 and petId must be an existing pet (400 input.invalid). Enforced by: place_order. Tested by: place_order_reserves_pet
  - Only a placed order can be approved. Anything else is refused with 409 invalid_state. Enforced by the data model: the store_order.status state field declares placed the only state that may move to approved, and the store refuses every other status write
  - Only an approved order can be delivered. Delivery sets complete true. Anything else is refused with 409 invalid_state. Enforced by: deliver_order. Tested by: approve_and_deliver_order
  - Unknown order ids on approve, deliver and delete answer 404 order_not_found. Enforced by: approve_order, deliver_order, delete_order. Tested by: delete_pet_restricted_by_orders
### refund_lifecycle (refund)
- States: requested, approved, rejected
- Actions: request_refund, approve_refund, reject_refund
- Rules:
  - A refund can be requested only for a delivered order. A placed or approved order is refused with 409 invalid_state, and an unknown order with 404 order_not_found. amount must be at least 1 (USD minor units) and reason must be non-blank (400 input.invalid). The refund starts requested with restock false. Enforced by: request_refund. Tested by: request_refund_on_delivered_order
  - An order may have at most one active refund, that is requested or approved. A new request while one exists is refused with 409 refund_exists. After a rejection a new request is allowed.
  - Only a requested refund can be approved. Anything else is refused with 409 invalid_state, and an unknown refund id with 404 refund_not_found. Approval sets decided_at. Enforced by the data model: the refund.status state field declares requested the only state that may move to approved, and approved and rejected are terminal
  - Approving with restock true moves the order's pet from sold back to available so it can be ordered again. If the pet is not sold the approval is refused with 409 cannot_restock and the refund stays requested. Approving with restock false (the default) leaves the pet sold. Enforced by: approve_refund. Tested by: approve_refund_restock
  - Only a requested refund can be rejected, and a non-blank note is required (400 input.invalid). Rejection sets decision_note and decided_at and leaves the order and pet unchanged. Anything else is 409 invalid_state, an unknown refund 404 refund_not_found. Enforced by: reject_refund. Tested by: reject_refund_with_note
  - An order that has any refund cannot be deleted: the refund references the order with restrict, so delete_order answers 409 delete.restricted. The order stays delivered and its pet stays sold, because a refund never changes the order status.

## Jobs

None. The plan declares no job.

## Acceptance tests

### pet_create_and_fetch
- Intent: A pet can be added with a category, always starts available, and is fetched back. Ordering it makes it pending. Bad creates and unknown ids are refused with engine codes.
- Actions: place_order
- Description: POST /pet creates an available pet (201). GET returns it. Placing an order makes it pending. Creating with status sold is refused (422 state.initial). A missing name is refused (422 field.required). GET of an unknown id is 404 row.not_found.

```js
(ctx) => {
  const cat = ctx.api('POST', '/categories', { name: 'Accept Category A' });
  ctx.assert(cat.status === 201, 'create category returned ' + cat.status + ' ' + JSON.stringify(cat.body));
  const r = ctx.api('POST', '/pet', { name: 'Accept Pet A', photoUrls: 'https://img.example/a1.jpg,https://img.example/a2.jpg', category: cat.body.id, tags: 'friendly,small' });
  ctx.assert(r.status === 201, 'create pet returned ' + r.status + ' ' + JSON.stringify(r.body));
  ctx.assert(r.body.status === 'available', 'new pet is available, got ' + r.body.status);
  ctx.assert(r.body.name === 'Accept Pet A' && r.body.category === cat.body.id && r.body.tags === 'friendly,small', 'fields stored: ' + JSON.stringify(r.body));
  const g = ctx.api('GET', '/pet/' + r.body.id);
  ctx.assert(g.status === 200 && g.body.id === r.body.id && g.body.photoUrls === r.body.photoUrls, 'get pet: ' + JSON.stringify(g));
  const ord = ctx.api('POST', '/store/orders', { petId: r.body.id, quantity: 1 });
  ctx.assert(ord.status === 200, 'order the new pet returned ' + ord.status + ' ' + JSON.stringify(ord.body));
  ctx.assert(ctx.api('GET', '/pet/' + r.body.id).body.status === 'pending', 'ordered pet is pending');
  const sold = ctx.api('POST', '/pet', { name: 'Accept Pet B', photoUrls: 'https://img.example/b.jpg', status: 'sold' });
  ctx.assert(sold.status === 422 && sold.body.type === 'state.initial', 'create sold pet: ' + JSON.stringify(sold));
  const noName = ctx.api('POST', '/pet', { photoUrls: 'https://img.example/c.jpg' });
  ctx.assert(noName.status === 422 && noName.body.type === 'field.required', 'missing name: ' + JSON.stringify(noName));
  const missing = ctx.api('GET', '/pet/pet_999999');
  ctx.assert(missing.status === 404 && missing.body.type === 'row.not_found', 'unknown pet: ' + JSON.stringify(missing));
}
```
### place_order_reserves_pet
- Intent: Placing an order creates a placed order and makes the pet pending. A second order for the same pet and invalid orders are refused.
- Actions: place_order
- Description: POST /store/orders for an available pet answers 200 with a placed, incomplete order, and the pet becomes pending. A second order is 409 pet_not_available. Unknown pet and quantity 0 are 400 input.invalid. status approved is 422 invalid_status. GET /store/orders?petId lists the order.

```js
(ctx) => {
  const mk = (n) => ctx.api('POST', '/pet', { name: n, photoUrls: 'https://img.example/' + n.replace(/ /g, '-') + '.jpg' }).body;
  const pet = mk('Accept Pet Order');
  const o = ctx.api('POST', '/store/orders', { petId: pet.id, quantity: 2, shipDate: '2026-10-20T10:00:00.000Z' });
  ctx.assert(o.status === 200, 'place order returned ' + o.status + ' ' + JSON.stringify(o.body));
  ctx.assert(o.body.status === 'placed' && o.body.complete === false && o.body.petId === pet.id && o.body.quantity === 2, 'order fields: ' + JSON.stringify(o.body));
  ctx.assert(o.body.shipDate === '2026-10-20T10:00:00.000Z', 'shipDate kept, got ' + o.body.shipDate);
  ctx.assert(ctx.api('GET', '/pet/' + pet.id).body.status === 'pending', 'pet is pending after the order');
  const again = ctx.api('POST', '/store/orders', { petId: pet.id, quantity: 1 });
  ctx.assert(again.status === 409 && again.body.type === 'pet_not_available', 'second order: ' + JSON.stringify(again));
  const unknown = ctx.api('POST', '/store/orders', { petId: 'pet_999999', quantity: 1 });
  ctx.assert(unknown.status === 400 && unknown.body.type === 'input.invalid', 'unknown pet: ' + JSON.stringify(unknown));
  const pet2 = mk('Accept Pet Order Two');
  const zero = ctx.api('POST', '/store/orders', { petId: pet2.id, quantity: 0 });
  ctx.assert(zero.status === 400 && zero.body.type === 'input.invalid', 'quantity 0: ' + JSON.stringify(zero));
  const approved = ctx.api('POST', '/store/orders', { petId: pet2.id, quantity: 1, status: 'approved' });
  ctx.assert(approved.status === 422 && approved.body.type === 'invalid_status', 'client status approved: ' + JSON.stringify(approved));
  ctx.assert(ctx.api('GET', '/pet/' + pet2.id).body.status === 'available', 'refused orders leave the pet available');
  const list = ctx.api('GET', '/store/orders?petId=' + pet.id);
  ctx.assert(list.status === 200 && list.body.data.length === 1 && list.body.data[0].id === o.body.id, 'list orders by petId: ' + JSON.stringify(list.body));
  const byStatus = ctx.api('GET', '/store/orders?petId=' + pet.id + '&status=approved');
  ctx.assert(byStatus.status === 200 && byStatus.body.data.length === 0, 'no approved order for the pet yet');
}
```
### approve_and_deliver_order
- Intent: An order moves placed to approved to delivered in order. Delivery completes the order and sells the pet. Out-of-order steps are refused.
- Actions: place_order, approve_order, deliver_order
- Description: approve moves placed to approved with the pet still pending. deliver moves approved to delivered with complete true and the pet sold. Repeating a step, approving a delivered order and delivering a placed order are 409 invalid_state. Unknown order id is 404 order_not_found.

```js
(ctx) => {
  const mk = (n) => ctx.api('POST', '/pet', { name: n, photoUrls: 'https://img.example/' + n.replace(/ /g, '-') + '.jpg' }).body;
  const pet = mk('Accept Pet Flow');
  const o = ctx.api('POST', '/store/orders', { petId: pet.id, quantity: 1 }).body;
  const a = ctx.api('POST', '/store/orders/' + o.id + '/approve', {});
  ctx.assert(a.status === 200 && a.body.status === 'approved' && a.body.complete === false, 'approve: ' + JSON.stringify(a));
  ctx.assert(ctx.api('GET', '/pet/' + pet.id).body.status === 'pending', 'pet still pending after approve');
  const a2 = ctx.api('POST', '/store/orders/' + o.id + '/approve', {});
  ctx.assert(a2.status === 409 && a2.body.type === 'invalid_state', 'approve twice: ' + JSON.stringify(a2));
  const d = ctx.api('POST', '/store/orders/' + o.id + '/deliver', {});
  ctx.assert(d.status === 200 && d.body.status === 'delivered' && d.body.complete === true, 'deliver: ' + JSON.stringify(d));
  ctx.assert(ctx.api('GET', '/pet/' + pet.id).body.status === 'sold', 'pet sold after delivery');
  const d2 = ctx.api('POST', '/store/orders/' + o.id + '/deliver', {});
  ctx.assert(d2.status === 409 && d2.body.type === 'invalid_state', 'deliver twice: ' + JSON.stringify(d2));
  const a3 = ctx.api('POST', '/store/orders/' + o.id + '/approve', {});
  ctx.assert(a3.status === 409 && a3.body.type === 'invalid_state', 'approve delivered: ' + JSON.stringify(a3));
  const pet2 = mk('Accept Pet Flow Two');
  const o2 = ctx.api('POST', '/store/orders', { petId: pet2.id, quantity: 1 }).body;
  const early = ctx.api('POST', '/store/orders/' + o2.id + '/deliver', {});
  ctx.assert(early.status === 409 && early.body.type === 'invalid_state', 'deliver a placed order: ' + JSON.stringify(early));
  ctx.assert(ctx.api('GET', '/store/orders/' + o2.id).body.status === 'placed', 'refused delivery left the order placed');
  ctx.assert(ctx.api('GET', '/pet/' + pet2.id).body.status === 'pending', 'refused delivery left the pet pending');
  const nf = ctx.api('POST', '/store/orders/ord_999999/approve', {});
  ctx.assert(nf.status === 404 && nf.body.type === 'order_not_found', 'unknown order: ' + JSON.stringify(nf));
}
```
### delete_order_releases_pet
- Intent: Deleting a placed or approved order frees its pet. Deleting a delivered order leaves the pet sold. Deleted orders are gone.
- Actions: place_order, approve_order, deliver_order, delete_order
- Description: DELETE /store/orders/{id} answers 204. A placed or approved order returns its pet to available, so it can be ordered again. A delivered order's pet stays sold. Unknown order is 404 order_not_found and the order is then 404 row.not_found on GET.

```js
(ctx) => {
  const mk = (n) => ctx.api('POST', '/pet', { name: n, photoUrls: 'https://img.example/' + n.replace(/ /g, '-') + '.jpg' }).body;
  const petA = mk('Accept Pet Del A');
  const oa = ctx.api('POST', '/store/orders', { petId: petA.id, quantity: 1 }).body;
  const da = ctx.api('DELETE', '/store/orders/' + oa.id);
  ctx.assert(da.status === 204, 'delete placed order returned ' + da.status + ' ' + JSON.stringify(da.body));
  const gone = ctx.api('GET', '/store/orders/' + oa.id);
  ctx.assert(gone.status === 404 && gone.body.type === 'row.not_found', 'deleted order is gone: ' + JSON.stringify(gone));
  ctx.assert(ctx.api('GET', '/pet/' + petA.id).body.status === 'available', 'pet A released');
  const again = ctx.api('POST', '/store/orders', { petId: petA.id, quantity: 1 });
  ctx.assert(again.status === 200, 'released pet can be ordered again: ' + JSON.stringify(again));
  const petB = mk('Accept Pet Del B');
  const ob = ctx.api('POST', '/store/orders', { petId: petB.id, quantity: 1 }).body;
  ctx.api('POST', '/store/orders/' + ob.id + '/approve', {});
  ctx.assert(ctx.api('DELETE', '/store/orders/' + ob.id).status === 204, 'delete approved order');
  ctx.assert(ctx.api('GET', '/pet/' + petB.id).body.status === 'available', 'pet B released');
  const petC = mk('Accept Pet Del C');
  const oc = ctx.api('POST', '/store/orders', { petId: petC.id, quantity: 1 }).body;
  ctx.api('POST', '/store/orders/' + oc.id + '/approve', {});
  ctx.api('POST', '/store/orders/' + oc.id + '/deliver', {});
  ctx.assert(ctx.api('DELETE', '/store/orders/' + oc.id).status === 204, 'delete delivered order');
  ctx.assert(ctx.api('GET', '/pet/' + petC.id).body.status === 'sold', 'pet C stays sold');
  const nf = ctx.api('DELETE', '/store/orders/ord_999999');
  ctx.assert(nf.status === 404 && nf.body.type === 'order_not_found', 'unknown order: ' + JSON.stringify(nf));
}
```
### delete_pet_restricted_by_orders
- Intent: A pet with an order cannot be deleted. A pet without orders can, and is then gone.
- Actions: place_order, delete_order
- Description: DELETE /pet/{id} is 409 delete.restricted while an order references the pet. After the order is deleted the pet deletes with 204 and GET is 404 row.not_found. A pet that never had an order deletes with 204.

```js
(ctx) => {
  const mk = (n) => ctx.api('POST', '/pet', { name: n, photoUrls: 'https://img.example/' + n.replace(/ /g, '-') + '.jpg' }).body;
  const pet = mk('Accept Pet Remove A');
  const o = ctx.api('POST', '/store/orders', { petId: pet.id, quantity: 1 }).body;
  const blocked = ctx.api('DELETE', '/pet/' + pet.id);
  ctx.assert(blocked.status === 409 && blocked.body.type === 'delete.restricted', 'delete pet with order: ' + JSON.stringify(blocked));
  ctx.assert(ctx.api('GET', '/pet/' + pet.id).status === 200, 'pet still exists');
  ctx.assert(ctx.api('DELETE', '/store/orders/' + o.id).status === 204, 'delete the order');
  const ok = ctx.api('DELETE', '/pet/' + pet.id);
  ctx.assert(ok.status === 204, 'delete pet after order removal returned ' + ok.status);
  const gone = ctx.api('GET', '/pet/' + pet.id);
  ctx.assert(gone.status === 404 && gone.body.type === 'row.not_found', 'pet is gone: ' + JSON.stringify(gone));
  const lone = mk('Accept Pet Remove B');
  ctx.assert(ctx.api('DELETE', '/pet/' + lone.id).status === 204, 'delete pet without orders');
}
```
### update_pet_by_body_id
- Intent: PUT /pet updates a pet identified by the body id, follows status transitions and refuses to move a reserved pet.
- Actions: update_pet, place_order
- Description: PUT /pet with id, name and photoUrls answers 200 and changes the fields. Status may go available to sold and back to available. A missing name is 400 input.invalid, an unknown id is 404 pet_not_found, and a pet with an open order cannot be moved to another status (409 pet_reserved).

```js
(ctx) => {
  const mk = (n) => ctx.api('POST', '/pet', { name: n, photoUrls: 'https://img.example/' + n.replace(/ /g, '-') + '.jpg' }).body;
  const pet = mk('Accept Pet Put');
  const u = ctx.api('PUT', '/pet', { id: pet.id, name: 'Accept Pet Put Renamed', photoUrls: 'https://img.example/new.jpg', tags: 'renamed' });
  ctx.assert(u.status === 200, 'update returned ' + u.status + ' ' + JSON.stringify(u.body));
  ctx.assert(u.body.id === pet.id && u.body.name === 'Accept Pet Put Renamed' && u.body.photoUrls === 'https://img.example/new.jpg' && u.body.tags === 'renamed' && u.body.status === 'available', 'updated fields: ' + JSON.stringify(u.body));
  const sold = ctx.api('PUT', '/pet', { id: pet.id, name: 'Accept Pet Put Renamed', photoUrls: 'https://img.example/new.jpg', status: 'sold' });
  ctx.assert(sold.status === 200 && sold.body.status === 'sold', 'mark sold: ' + JSON.stringify(sold));
  const back = ctx.api('PUT', '/pet', { id: pet.id, name: 'Accept Pet Put Renamed', photoUrls: 'https://img.example/new.jpg', status: 'available' });
  ctx.assert(back.status === 200 && back.body.status === 'available', 'sold back to available: ' + JSON.stringify(back));
  const noName = ctx.api('PUT', '/pet', { id: pet.id, photoUrls: 'https://img.example/new.jpg' });
  ctx.assert(noName.status === 400 && noName.body.type === 'input.invalid', 'missing name: ' + JSON.stringify(noName));
  const nf = ctx.api('PUT', '/pet', { id: 'pet_999999', name: 'Ghost', photoUrls: 'https://img.example/g.jpg' });
  ctx.assert(nf.status === 404 && nf.body.type === 'pet_not_found', 'unknown pet: ' + JSON.stringify(nf));
  ctx.assert(ctx.api('POST', '/store/orders', { petId: pet.id, quantity: 1 }).status === 200, 'order the pet');
  const reserved = ctx.api('PUT', '/pet', { id: pet.id, name: 'Accept Pet Put Renamed', photoUrls: 'https://img.example/new.jpg', status: 'sold' });
  ctx.assert(reserved.status === 409 && reserved.body.type === 'pet_reserved', 'reserved pet: ' + JSON.stringify(reserved));
  ctx.assert(ctx.api('GET', '/pet/' + pet.id).body.status === 'pending', 'reserved pet still pending');
}
```
### inventory_tracks_status
- Intent: The inventory map shifts by exactly one pet per status change as a pet is added, ordered, approved and delivered.
- Actions: get_inventory, place_order, approve_order, deliver_order
- Description: GET /store/inventory returns integer counts for available, pending and sold. Compared with a baseline read, adding a pet raises available by 1, ordering moves one from available to pending, approving changes nothing, and delivering moves one from pending to sold.

```js
(ctx) => {
  const inv = () => {
    const r = ctx.api('GET', '/store/inventory');
    ctx.assert(r.status === 200, 'inventory returned ' + r.status);
    for (const k of ['available', 'pending', 'sold']) ctx.assert(Number.isInteger(r.body[k]), 'inventory.' + k + ' is an integer, got ' + JSON.stringify(r.body));
    return r.body;
  };
  const base = inv();
  const pet = ctx.api('POST', '/pet', { name: 'Accept Pet Inventory', photoUrls: 'https://img.example/inv.jpg' }).body;
  const s1 = inv();
  ctx.assert(s1.available === base.available + 1 && s1.pending === base.pending && s1.sold === base.sold, 'after add: ' + JSON.stringify(s1));
  const o = ctx.api('POST', '/store/orders', { petId: pet.id, quantity: 1 }).body;
  const s2 = inv();
  ctx.assert(s2.available === base.available && s2.pending === base.pending + 1 && s2.sold === base.sold, 'after order: ' + JSON.stringify(s2));
  ctx.api('POST', '/store/orders/' + o.id + '/approve', {});
  const s3 = inv();
  ctx.assert(s3.available === s2.available && s3.pending === s2.pending && s3.sold === s2.sold, 'approve changes nothing: ' + JSON.stringify(s3));
  ctx.api('POST', '/store/orders/' + o.id + '/deliver', {});
  const s4 = inv();
  ctx.assert(s4.available === base.available && s4.pending === base.pending && s4.sold === base.sold + 1, 'after deliver: ' + JSON.stringify(s4));
}
```
### find_pets_by_status_filters
- Intent: findByStatus filters by status and category, searches by name, follows a pet as it is ordered, and refuses an unknown status.
- Actions: place_order
- Description: GET /pet/findByStatus?status=available&q=<unique name> returns the new pet, status=sold does not, category filter returns it, status=bogus is 400 query.invalid. After placing an order the pet is found under pending and no longer under available.

```js
(ctx) => {
  const cat = ctx.api('POST', '/categories', { name: 'Accept Category Find' }).body;
  const pet = ctx.api('POST', '/pet', { name: 'Zqfind Testpet 7731', photoUrls: 'https://img.example/find.jpg', category: cat.id }).body;
  const has = (r) => r.body.data.some((p) => p.id === pet.id);
  const a = ctx.api('GET', '/pet/findByStatus?status=available&q=Zqfind');
  ctx.assert(a.status === 200 && has(a), 'available search finds the pet: ' + JSON.stringify(a.body));
  const s = ctx.api('GET', '/pet/findByStatus?status=sold&q=Zqfind');
  ctx.assert(s.status === 200 && !has(s), 'sold filter does not return an available pet');
  const c = ctx.api('GET', '/pet/findByStatus?category=' + cat.id);
  ctx.assert(c.status === 200 && c.body.data.length === 1 && has(c), 'category filter returns only the new pet: ' + JSON.stringify(c.body));
  const bad = ctx.api('GET', '/pet/findByStatus?status=bogus');
  ctx.assert(bad.status === 400 && bad.body.type === 'query.invalid', 'bogus status: ' + JSON.stringify(bad));
  const cats = ctx.api('GET', '/categories?q=Accept+Category+Find');
  ctx.assert(cats.status === 200 && cats.body.data.some((x) => x.id === cat.id), 'category search finds the category');
  const ord = ctx.api('POST', '/store/orders', { petId: pet.id, quantity: 1 });
  ctx.assert(ord.status === 200, 'order the pet returned ' + ord.status + ' ' + JSON.stringify(ord.body));
  const p = ctx.api('GET', '/pet/findByStatus?status=pending&q=Zqfind');
  ctx.assert(p.status === 200 && has(p), 'ordered pet is found as pending: ' + JSON.stringify(p.body));
  const a2 = ctx.api('GET', '/pet/findByStatus?status=available&q=Zqfind');
  ctx.assert(a2.status === 200 && !has(a2), 'ordered pet is no longer available');
}
```
### request_refund_on_delivered_order
- Intent: A refund can be requested only for a delivered order, starts requested, and only one active refund per order is allowed. Bad input and unknown ids are refused.
- Actions: place_order, approve_order, deliver_order, request_refund
- Description: POST /store/orders/{id}/refunds on a placed order is 409 invalid_state. On a delivered order it answers 201 with a requested refund (restock false, decided_at null) and the pet stays sold. A second request is 409 refund_exists. amount 0, a missing reason and a blank reason are 400 input.invalid. Unknown order is 404 order_not_found. GET /refunds lists it by orderId and status, and an unknown refund id is 404 row.not_found.

```js
(ctx) => {
  const mk = (n) => ctx.api('POST', '/pet', { name: n, photoUrls: 'https://img.example/' + n.replace(/ /g, '-') + '.jpg' }).body;
  const delivered = (n) => {
    const pet = mk(n);
    const o = ctx.api('POST', '/store/orders', { petId: pet.id, quantity: 1 }).body;
    ctx.api('POST', '/store/orders/' + o.id + '/approve', {});
    ctx.api('POST', '/store/orders/' + o.id + '/deliver', {});
    return { pet, o };
  };
  const early = mk('Accept Pet Refund Early');
  const eo = ctx.api('POST', '/store/orders', { petId: early.id, quantity: 1 }).body;
  const tooEarly = ctx.api('POST', '/store/orders/' + eo.id + '/refunds', { amount: 1000, reason: 'Changed my mind' });
  ctx.assert(tooEarly.status === 409 && tooEarly.body.type === 'invalid_state', 'refund on a placed order: ' + JSON.stringify(tooEarly));
  const { pet, o } = delivered('Accept Pet Refund A');
  const r = ctx.api('POST', '/store/orders/' + o.id + '/refunds', { amount: 2500, reason: 'Pet arrived with an illness' });
  ctx.assert(r.status === 201, 'request refund returned ' + r.status + ' ' + JSON.stringify(r.body));
  ctx.assert(r.body.orderId === o.id && r.body.amount === 2500 && r.body.status === 'requested' && r.body.restock === false && r.body.decided_at === null && r.body.reason === 'Pet arrived with an illness', 'refund fields: ' + JSON.stringify(r.body));
  ctx.assert(ctx.api('GET', '/pet/' + pet.id).body.status === 'sold', 'pet stays sold after a refund request');
  ctx.assert(ctx.api('GET', '/store/orders/' + o.id).body.status === 'delivered', 'order stays delivered');
  const g = ctx.api('GET', '/refunds/' + r.body.id);
  ctx.assert(g.status === 200 && g.body.id === r.body.id, 'get refund: ' + JSON.stringify(g));
  const dup = ctx.api('POST', '/store/orders/' + o.id + '/refunds', { amount: 500, reason: 'Second try' });
  ctx.assert(dup.status === 409 && dup.body.type === 'refund_exists', 'second active refund: ' + JSON.stringify(dup));
  const { o: o2 } = delivered('Accept Pet Refund B');
  const zero = ctx.api('POST', '/store/orders/' + o2.id + '/refunds', { amount: 0, reason: 'Free' });
  ctx.assert(zero.status === 400 && zero.body.type === 'input.invalid', 'amount 0: ' + JSON.stringify(zero));
  const noReason = ctx.api('POST', '/store/orders/' + o2.id + '/refunds', { amount: 1000 });
  ctx.assert(noReason.status === 400 && noReason.body.type === 'input.invalid', 'missing reason: ' + JSON.stringify(noReason));
  const blank = ctx.api('POST', '/store/orders/' + o2.id + '/refunds', { amount: 1000, reason: '   ' });
  ctx.assert(blank.status === 400 && blank.body.type === 'input.invalid', 'blank reason: ' + JSON.stringify(blank));
  const nf = ctx.api('POST', '/store/orders/ord_999999/refunds', { amount: 1000, reason: 'Ghost order' });
  ctx.assert(nf.status === 404 && nf.body.type === 'order_not_found', 'unknown order: ' + JSON.stringify(nf));
  const list = ctx.api('GET', '/refunds?orderId=' + o.id + '&status=requested');
  ctx.assert(list.status === 200 && list.body.data.length === 1 && list.body.data[0].id === r.body.id, 'list refunds by order and status: ' + JSON.stringify(list.body));
  const none = ctx.api('GET', '/refunds?orderId=' + o2.id);
  ctx.assert(none.status === 200 && none.body.data.length === 0, 'refused requests created no refund');
  const missing = ctx.api('GET', '/refunds/rfd_999999');
  ctx.assert(missing.status === 404 && missing.body.type === 'row.not_found', 'unknown refund: ' + JSON.stringify(missing));
}
```
### approve_refund_restock
- Intent: Approving a requested refund marks it approved. With restock true the sold pet returns to available. Restocking a pet that is not sold is refused. Repeat approvals are refused.
- Actions: place_order, approve_order, deliver_order, request_refund, approve_refund
- Description: POST /refunds/{id}/approve answers 200 with status approved and decided_at set. Without restock the pet stays sold. With restock true the refund shows restock true and the pet becomes available and can be ordered again. Approving twice is 409 invalid_state, an unknown refund is 404 refund_not_found, and a new request on an order with an approved refund is 409 refund_exists. If the pet is not sold, restock true is 409 cannot_restock and the refund stays requested.

```js
(ctx) => {
  const mk = (n) => ctx.api('POST', '/pet', { name: n, photoUrls: 'https://img.example/' + n.replace(/ /g, '-') + '.jpg' }).body;
  const delivered = (n) => {
    const pet = mk(n);
    const o = ctx.api('POST', '/store/orders', { petId: pet.id, quantity: 1 }).body;
    ctx.api('POST', '/store/orders/' + o.id + '/approve', {});
    ctx.api('POST', '/store/orders/' + o.id + '/deliver', {});
    return { pet, o };
  };
  const request = (o, amount) => ctx.api('POST', '/store/orders/' + o.id + '/refunds', { amount, reason: 'Accept refund reason' }).body;
  const a = delivered('Accept Pet Approve A');
  const ra = request(a.o, 3000);
  const ap = ctx.api('POST', '/refunds/' + ra.id + '/approve', {});
  ctx.assert(ap.status === 200 && ap.body.status === 'approved' && ap.body.restock === false && typeof ap.body.decided_at === 'string', 'approve: ' + JSON.stringify(ap));
  ctx.assert(ctx.api('GET', '/pet/' + a.pet.id).body.status === 'sold', 'pet stays sold without restock');
  const twice = ctx.api('POST', '/refunds/' + ra.id + '/approve', {});
  ctx.assert(twice.status === 409 && twice.body.type === 'invalid_state', 'approve twice: ' + JSON.stringify(twice));
  const again = ctx.api('POST', '/store/orders/' + a.o.id + '/refunds', { amount: 100, reason: 'Another' });
  ctx.assert(again.status === 409 && again.body.type === 'refund_exists', 'request after approval: ' + JSON.stringify(again));
  const nf = ctx.api('POST', '/refunds/rfd_999999/approve', {});
  ctx.assert(nf.status === 404 && nf.body.type === 'refund_not_found', 'unknown refund: ' + JSON.stringify(nf));
  const b = delivered('Accept Pet Approve B');
  const rb = request(b.o, 4500);
  const apb = ctx.api('POST', '/refunds/' + rb.id + '/approve', { restock: true });
  ctx.assert(apb.status === 200 && apb.body.status === 'approved' && apb.body.restock === true, 'approve with restock: ' + JSON.stringify(apb));
  ctx.assert(ctx.api('GET', '/pet/' + b.pet.id).body.status === 'available', 'restocked pet is available');
  ctx.assert(ctx.api('GET', '/store/orders/' + b.o.id).body.status === 'delivered', 'order stays delivered');
  const reorder = ctx.api('POST', '/store/orders', { petId: b.pet.id, quantity: 1 });
  ctx.assert(reorder.status === 200, 'restocked pet can be ordered again: ' + JSON.stringify(reorder));
  const c = delivered('Accept Pet Approve C');
  const back = ctx.api('PUT', '/pet', { id: c.pet.id, name: c.pet.name, photoUrls: c.pet.photoUrls, status: 'available' });
  ctx.assert(back.status === 200 && back.body.status === 'available', 'pet put back to available by hand: ' + JSON.stringify(back));
  const rc = request(c.o, 1500);
  const bad = ctx.api('POST', '/refunds/' + rc.id + '/approve', { restock: true });
  ctx.assert(bad.status === 409 && bad.body.type === 'cannot_restock', 'restock a pet that is not sold: ' + JSON.stringify(bad));
  ctx.assert(ctx.api('GET', '/refunds/' + rc.id).body.status === 'requested', 'refused approval left the refund requested');
  const ok = ctx.api('POST', '/refunds/' + rc.id + '/approve', { restock: false });
  ctx.assert(ok.status === 200 && ok.body.status === 'approved', 'approve without restock after the refusal: ' + JSON.stringify(ok));
}
```
### reject_refund_with_note
- Intent: Rejecting a requested refund needs a note, records the decision and leaves the order and pet alone. A rejected refund cannot be decided again, and the order can be refunded anew. An order with refunds cannot be deleted.
- Actions: place_order, approve_order, deliver_order, request_refund, reject_refund, approve_refund, delete_order
- Description: POST /refunds/{id}/reject without a note is 400 input.invalid. With a note it answers 200 with status rejected, decision_note and decided_at, and the pet stays sold. Rejecting again or approving a rejected refund is 409 invalid_state. An unknown refund is 404 refund_not_found. A new request after the rejection is 201. DELETE of an order that has a refund is 409 delete.restricted and the order remains.

```js
(ctx) => {
  const mk = (n) => ctx.api('POST', '/pet', { name: n, photoUrls: 'https://img.example/' + n.replace(/ /g, '-') + '.jpg' }).body;
  const pet = mk('Accept Pet Reject');
  const o = ctx.api('POST', '/store/orders', { petId: pet.id, quantity: 1 }).body;
  ctx.api('POST', '/store/orders/' + o.id + '/approve', {});
  ctx.api('POST', '/store/orders/' + o.id + '/deliver', {});
  const r = ctx.api('POST', '/store/orders/' + o.id + '/refunds', { amount: 8000, reason: 'Pet did not match the listing' }).body;
  const noNote = ctx.api('POST', '/refunds/' + r.id + '/reject', {});
  ctx.assert(noNote.status === 400 && noNote.body.type === 'input.invalid', 'reject without note: ' + JSON.stringify(noNote));
  ctx.assert(ctx.api('GET', '/refunds/' + r.id).body.status === 'requested', 'refused rejection left the refund requested');
  const rej = ctx.api('POST', '/refunds/' + r.id + '/reject', { note: 'Outside the 14 day return window' });
  ctx.assert(rej.status === 200 && rej.body.status === 'rejected' && rej.body.decision_note === 'Outside the 14 day return window' && typeof rej.body.decided_at === 'string', 'reject: ' + JSON.stringify(rej));
  ctx.assert(ctx.api('GET', '/pet/' + pet.id).body.status === 'sold', 'pet stays sold after rejection');
  ctx.assert(ctx.api('GET', '/store/orders/' + o.id).body.status === 'delivered', 'order stays delivered');
  const twice = ctx.api('POST', '/refunds/' + r.id + '/reject', { note: 'Again' });
  ctx.assert(twice.status === 409 && twice.body.type === 'invalid_state', 'reject twice: ' + JSON.stringify(twice));
  const approveRejected = ctx.api('POST', '/refunds/' + r.id + '/approve', {});
  ctx.assert(approveRejected.status === 409 && approveRejected.body.type === 'invalid_state', 'approve a rejected refund: ' + JSON.stringify(approveRejected));
  const nf = ctx.api('POST', '/refunds/rfd_999999/reject', { note: 'Ghost' });
  ctx.assert(nf.status === 404 && nf.body.type === 'refund_not_found', 'unknown refund: ' + JSON.stringify(nf));
  const renew = ctx.api('POST', '/store/orders/' + o.id + '/refunds', { amount: 4000, reason: 'Partial refund instead' });
  ctx.assert(renew.status === 201 && renew.body.status === 'requested', 'new request after rejection: ' + JSON.stringify(renew));
  const list = ctx.api('GET', '/refunds?orderId=' + o.id + '&status=rejected');
  ctx.assert(list.status === 200 && list.body.data.length === 1 && list.body.data[0].id === r.id, 'list rejected refunds: ' + JSON.stringify(list.body));
  const del = ctx.api('DELETE', '/store/orders/' + o.id);
  ctx.assert(del.status === 409 && del.body.type === 'delete.restricted', 'delete an order with refunds: ' + JSON.stringify(del));
  ctx.assert(ctx.api('GET', '/store/orders/' + o.id).status === 200, 'order still exists');
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `add_pet` | POST | /pet | Standard create of a pet (engine answers 201). New pets are always available. |
| `update_pet` | PUT | /pet | Action. Update an existing pet by the id in the body, spec-style. Unknown id is 404 pet_not_found. A pet with an open order cannot be moved out of pending. |
| `find_pets_by_status` | GET | /pet/findByStatus | List pets filtered by status (and optionally category), searchable by name with q, cursor paged. |
| `get_pet` | GET | /pet/{id} | Fetch one pet. Unknown id is 404 row.not_found. |
| `delete_pet` | DELETE | /pet/{id} | Standard delete. Refused with 409 delete.restricted while any order references the pet. |
| `get_inventory` | GET | /store/inventory | Action. Returns a map of pet status to pet count: available, pending, sold. |
| `place_order` | POST | /store/orders | Action. Place an order for an available pet. The order starts placed and the pet becomes pending. |
| `get_order` | GET | /store/orders/{id} | Fetch one order. |
| `delete_order` | DELETE | /store/orders/{id} | Action. Delete an order, answering 204. A placed or approved order releases its pet back to available. An order that has refunds is refused with 409 delete.restricted. |
| `list_orders` | GET | /store/orders | Extra read route. List orders filtered by petId and status so agents can discover orders. |
| `approve_order` | POST | /store/orders/{id}/approve | Action. Move a placed order to approved. |
| `deliver_order` | POST | /store/orders/{id}/deliver | Action. Move an approved order to delivered, set complete true and mark the pet sold. |
| `list_categories` | GET | /categories | Extra read route. List categories, searchable by name. |
| `create_category` | POST | /categories | Extra create route for categories. |
| `request_refund` | POST | /store/orders/{id}/refunds | Action. Request a refund (amount, reason) for a delivered order. Answers 201 with a requested refund. |
| `approve_refund` | POST | /refunds/{id}/approve | Action. Approve a requested refund, optionally with restock true to put the sold pet back on sale. |
| `reject_refund` | POST | /refunds/{id}/reject | Action. Reject a requested refund with a required note. |
| `list_refunds` | GET | /refunds | Extra read route. List refunds filtered by orderId and status, cursor paged. |
| `get_refund` | GET | /refunds/{id} | Fetch one refund. Unknown id is 404 row.not_found. |

## Seed

- Rows per entity: category: 6, pet: 30, store_order: 12, refund: 5
- Mix: 30 pets: 13 available, 8 pending (4 with a placed order, 4 with an approved order), 9 sold (4 with a delivered order, 5 sold without orders). 12 orders: 4 placed, 4 approved, 4 delivered. Two pets share the name Juniper (one Cats, one Dogs), each with an approved order. Of the 4 placed orders, 2 have a shipDate before 2026-10-07 and 2 are later. One approved order also has a past shipDate. Anchor pets named Biscuit (available dog) and Rex/Rexy (similar names). Refunds: 5 rows, all on the 4 delivered orders, requested only on delivered orders, decided_at after the order and before the clock start. The delivered order of pet Pepper has a requested refund of 4000, the delivered order of the similarly named pet Pepperoni has a requested refund of 15000, a third delivered order has an approved refund of 2500 with restock false (its pet stays sold), and the delivered order of pet Mochi has two rejected refunds with notes and no active refund, so it can be refunded again.
- State mix: pet: available 45%, pending 25%, sold 30%; store_order: placed 33%, approved 34%, delivered 33%; refund: requested 40%, approved 20%, rejected 40%

## Tasks

- `order_biscuit` (easy): Place an order for 2 units of the available pet named Biscuit with shipDate 2026-10-15T12:00:00.000Z. Success is one new placed order for that pet and the pet pending. Nothing else changes. Allows (from the instruction): store_order created, where status placed, complete false, quantity 2 and petId the Biscuit pet; pet updated, fields status only, where the row is the available pet named Biscuit.
  - Decoy idea: Orders a similarly named pet (Biscuit Jr, or a non-available Biscuit) or leaves out the shipDate.
- `deliver_cat_juniper` (medium): Two pets are named Juniper, one in the Cats category and one in Dogs, and both have approved orders. Mark the order for the cat named Juniper as delivered. Success is that order delivered and complete, that pet sold, and the dog's order and pet untouched. Allows (from the instruction): store_order updated, fields status and complete only, where the row is the approved order of the cat Juniper (status approved); pet updated, fields status only, where the row is the pending pet named Juniper in the Cats category.
  - Decoy idea: Delivers the dog Juniper's order, delivers both orders, or deletes the cat's order, which frees the pet and delivers nothing.
- `release_stale_placed_orders` (hard): Delete every order that is still placed (never approved) and whose shipDate is before 2026-10-07, so their pets return to available. Leave approved and delivered orders and all future-dated placed orders alone. Success is exactly the stale placed orders deleted, their pets available, and no other row changed. Allows (from the instruction): store_order deleted, where status placed (the shipDate cutoff is checked by the grader on the exact rows); pet updated, fields status only, where status pending (the pets of those orders, moving back to available).
  - Decoy idea: Deletes every order with a past shipDate including the approved one, deletes all placed orders including future-dated ones, or deletes only the first page of matches.
- `request_refund_mochi` (easy): The customer who bought the pet named Mochi wants money back for 6000 (USD minor units) because the pet was not as described. Mochi's earlier refund requests were rejected, but file a new request for that order with a reason. Success is exactly one new requested refund of 6000 on Mochi's order, with the pet and order unchanged. Allows (from the instruction): refund created only, where status requested, amount 6000 and orderId Mochi's delivered order; no updates or deletes of any entity.
  - Decoy idea: Files the refund on the order of a similarly named pet, uses the wrong amount, or approves or edits the old rejected refunds instead of filing a new one.
- `restock_pepper_refund` (medium): A refund request is waiting for the delivered order of the pet named Pepper (not Pepperoni). Approve it and put Pepper back on sale. Success is that refund approved with restock true, Pepper available, and the Pepperoni refund, its pet and every other row untouched. Allows (from the instruction): refund updated, fields status, restock and decided_at only, where the row is the requested refund of 4000 on Pepper's order; pet updated, fields status only, where the row is the sold pet named Pepper.
  - Decoy idea: Approves Pepperoni's refund, approves Pepper's refund without restock, rejects it, or sets the pet to available by hand with update_pet instead of restocking through the refund.
- `settle_requested_refunds` (hard): Go through every refund that is still requested. Reject each one above 10000 (USD minor units) with a note that says why, and approve each one at or below 10000 without restocking. Refunds already approved or rejected stay as they are, and no pet or order changes. Success is every requested refund decided by that rule. Allows (from the instruction): refund updated, fields status, decision_note and decided_at only, where status requested (the amount threshold is checked by the grader per row); no pet or order changes and no creates or deletes.
  - Decoy idea: Handles only the first refund on the page, approves everything, rejects everything, restocks the approved pets, or re-decides the already approved and rejected refunds.

## Open questions

- Should ids be integers like the spec (int64) or prefixed strings?
  - Default answer: Prefixed strings (pet_0001, ord_0001, rfd_0001), because the engine assigns them.
- How should array fields photoUrls and tags be represented?
  - Default answer: Comma-separated text on the pet. Tag has no entity of its own.
- Does a pet have stock, so an order's quantity matters?
  - Default answer: No. A pet is one listing. Quantity is at least 1 and is stored only on the order.
- Who may set order status and complete?
  - Default answer: Only the actions (place, approve, deliver). Clients cannot set them. place_order refuses status other than placed and complete true.
- Is PUT /pet a standard update?
  - Default answer: No. It is an action that finds the pet by the id in the body, because the standard update route needs {id} in the path.
- Should deleting an open order release the pet?
  - Default answer: Yes. A placed or approved order returns the pet to available. A delivered order leaves it sold.
- Which orders can be refunded?
  - Default answer: Only delivered orders. Orders that are placed or approved are cancelled by deleting them, which already releases the pet.
- Do orders have a price, and can the refund amount be checked against it?
  - Default answer: No. The world has no prices, so the client states the amount in USD minor units (at least 1) and it is not capped.
- Can an order be refunded more than once, for example in parts?
  - Default answer: One active refund (requested or approved) per order. After a rejection a new request is allowed. Partial refunds are not summed.
- Does a refund change the order status or put the pet back on sale?
  - Default answer: The order stays delivered. The pet goes back to available only when the approver sets restock true and the pet is sold. Otherwise it stays sold.
- What happens to refunds when an order is deleted?
  - Default answer: An order with any refund cannot be deleted (409 delete.restricted), so the refund history is kept.
- How can an allows where express a range such as shipDate before a date or an amount above 10000?
  - Default answer: It cannot. The where holds equal field values only (status, names, resolved ids). The grader checks the range on the exact rows.
- Should the allows list include the pet changes that follow from an order action, such as the pet moving to pending, sold or available?
  - Default answer: Yes, as an update of the pet's status field only, because the instruction implies those effects.

## Assumptions

- Row ids are engine ids such as pet_0001, ord_0001, cat_0001 and rfd_0001, not int64. Spec path params petId and orderId become {id}. The spec's petId field on orders is kept as a ref to pet.
  - Why: The engine assigns prefixed string ids and a get, update or delete route must use {id}.
- photoUrls and tags are stored as comma-separated text. A separate Tag entity is not built. category is a ref to the category entity.
  - Why: The field types have no array or embedded object, so the closest honest form is text and a ref. The openapi checker may flag the array type of photoUrls and tags.
- Spec names stay camelCase: photoUrls, petId, shipDate. The refund's order ref follows that style and is named orderId.
  - Why: The task requires spec field names exactly as spelled, and refunds sit beside orders that use petId.
- PUT /pet, POST /store/orders, DELETE /store/orders/{id} and GET /store/inventory are actions. The other spec operations are standard routes.
  - Why: Each needs body-id lookup, cross-entity effects such as reserving or releasing a pet, an aggregate, or a 204 answer from a handler, which standard routes cannot do.
- Standard create answers 201 for POST /pet and standard delete answers 204. place_order answers 200, as the spec says. request_refund is an action and answers 201 because it creates a row.
  - Why: The engine fixes success statuses for standard routes, and the spec's 200 for order creation is kept because it is an action.
- Pet creation always starts available. A POST /pet carrying another status is refused with 422 state.initial. A pet's status changes through the declared transitions: available to pending or sold, pending to available or sold, and sold to available.
  - Why: The engine enforces the initial state of state fields, and allowing sold to return to available keeps mistakes fixable and lets a refund restock a sold pet.
- Error bodies use the proposed template { code: $status, type: $code, message: $message }. Tests assert the HTTP status plus body.type, which holds the engine or action code.
  - Why: It matches the source spec's ApiResponse (code, type, message).
- Unknown pet on PUT /pet is 404 pet_not_found, because the id is a plain string input and not a ref. Unknown petId on place_order is 400 input.invalid because it is a ref input. Unknown order on request_refund is 404 order_not_found and unknown refund on approve or reject is 404 refund_not_found, because those ids are path params read by the handler.
  - Why: The spec gives 404 for PUT /pet and 400 for an invalid order. The refund actions follow the order action conventions.
- Order quantity is an int of at least 1. Pets stay unique animals, so quantity does not affect inventory counts.
  - Why: The spec requires quantity but defines no stock logic.
- Extras beyond the spec: GET /store/orders, GET and POST /categories, the approve and deliver actions, and the refund routes (request, approve, reject, list, get). The order status steps need actions because status and complete are readonly.
  - Why: Agents must discover orders, categories and refunds, and the lifecycles need explicit transitions. The extra operations are deliberate and allowed with a warning.
- Refunds are a new entity with its own state machine requested, approved, rejected. The store_order status machine is not changed: a refunded order stays delivered. restock, decision_note and decided_at are readonly and set only by approve_refund and reject_refund. amount is money in USD with min 1.
  - Why: This adds the feature without altering the existing order and pet workflows or their tests.
- refund.orderId is a required ref to store_order with onDelete restrict. delete_order is not edited. An order with a refund therefore answers 409 delete.restricted through the engine.
  - Why: Refund history should not vanish, and the existing handler's delete already enforces the restriction.
- Approving a refund never moves the order. With restock true it moves the pet sold to available only if the pet is currently sold, otherwise 409 cannot_restock.
  - Why: A pet that was already put back on sale, or reserved again, must not be restocked twice.
- Seed refunds all sit on delivered orders. One delivered order (pet Mochi) has only rejected refunds so a task can file a new request. Existing seed counts and state mixes for pets and orders are unchanged.
  - Why: Refund tasks need unambiguous targets and an eligible order, and existing tasks must keep their seed.
- Clock starts 2026-10-07T09:00:00.000Z with tick 0s, after all seeded history. Order shipDate may lie in the future (planned) or in the past (stale placed orders). Refund decided_at lies before the clock start.
  - Why: Time must be explicit and deterministic. Tasks cannot advance the clock, so they refer to the fixed date 2026-10-07.
- No jobs are built. Refunds are not auto-expired or auto-approved.
  - Why: The spec has no time-driven behavior. Deciding refunds is a task for agents.
- Acceptance tests list only workflow actions in their actions field. Tests that mainly use standard routes (add_pet, create_category) also exercise place_order so each names at least one workflow action.
  - Why: The plan schema accepts only workflow action keys in a test's actions.
- Every task gets an allows list taken from its instruction, stated in the task intent: entity, kind (created, updated or deleted), exact fields for updates, and a where of equality field values that picks the target rows. Only the tasks change. No entity, route, action, workflow, test or seed row changes.
  - Why: The change request asks for allows on every task and nothing else.
- A where can only match equal field values, so range conditions in an instruction (shipDate before 2026-10-07, amount above or at most 10000) are not in where. The where narrows by status and the target names, and the grader checks the range on the exact rows. Refs in where (the Biscuit pet, the Cats category, Mochi's order) are filled with the seeded row ids by the tasks stage.
  - Why: The allows where has no comparison operators, and the instruction gives names, not ids.
- Side effects the instruction implies are allowed: place_order moves the pet to pending, deliver_order sets the pet sold, delete_order releases the pet, approve_refund with restock moves the pet to available. Fields set by actions (status, complete, restock, decided_at, decision_note) are listed on the updated entity.
  - Why: The allows is derived from what the instruction asks for, and these are the effects of the actions that carry it out.

## Out of scope

- Tag as its own entity and routes, and real array fields for photoUrls and tags
  - Why: The field types have no arrays. Tags are kept as text on the pet.
- Users, login, API keys and OAuth
  - Why: The 9 spec operations kept for this world are unauthenticated.
- Image upload and other spec operations that were dropped
  - Why: All 9 kept operations are covered. Binary upload has no stateful records.
- Per-pet stock and quantity-based inventory
  - Why: The spec counts pets by status only.
- Automatic order expiry or time-driven jobs
  - Why: The spec has none. The hard task has the agent do the cleanup.
- Order prices, payments, payment gateways and payout of the refund money
  - Why: The world has no prices or payments. A refund is a recorded decision with a client-stated amount.
- A refunded order status and multiple or partial refunds summed against an order total
  - Why: Keeps the order state machine unchanged. One active refund per order is enough for the workflow.
- Refund creation or editing through standard routes, and deleting refunds
  - Why: Refunds change only through the request, approve and reject actions, which protect the audit trail.
- Any change to entities, routes, actions, workflows, jobs, tests or seed rows
  - Why: The change request only adds allows lists to the tasks.

## Changes

- tasks.order_biscuit
- tasks.deliver_cat_juniper
- tasks.release_stale_placed_orders
- tasks.request_refund_mochi
- tasks.restock_pepper_refund
- tasks.settle_requested_refunds
