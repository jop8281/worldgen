# WorldGen plan: Stripe Billing / AWS Billing-style cloud billing console (subscriptions, invoices, credits, refunds, dunning)

A billing console where customers hold subscriptions to plans, invoices are paid, voided or written off, account credits are granted and applied, refunds go through a request and decision step, and a daily dunning job escalates overdue invoices and the subscriptions behind them.

- Revision: 1
- Verdict: proceed
- Clock: starts 2026-10-09T09:00:00Z, tick 0s

## Entities

| Entity | Purpose | Key fields |
|---|---|---|
| `customer` | A billed account holder with an account credit balance | name, email, credit_balance |
| `plan` | A priced cloud plan | name, monthly_price |
| `subscription` | A customer's subscription to a plan; status moves through dunning | customer_id, plan_id, status, current_period_end, canceled_at |
| `invoice` | A bill for a subscription with payment, refund and dunning tracking | number, customer_id, subscription_id, total, amount_paid, amount_refunded, status, due_at, attempt_count, dunning_level, memo |
| `payment_attempt` | One card charge attempt against an invoice | invoice_id, outcome, amount |
| `credit_entry` | Ledger row of account credit grants and applications | customer_id, kind, amount, invoice_id |
| `refund` | A refund request on a paid invoice, decided once | invoice_id, amount, destination, status, reason |

## Workflows

### invoice_collection (invoice)
- States: open, paid, void, uncollectible
- Actions: pay_invoice, void_invoice, apply_credit, write_off_invoice
- Rules:
  - A successful card payment marks an open invoice paid for its full total; a failed card result leaves it open, logs a failed payment attempt, and every attempt raises attempt_count. Failed payment answers 200. Enforced by: pay_invoice. Tested by: t_pay
  - Only open invoices can be paid or voided; otherwise 409 invalid_state Enforced by: pay_invoice, void_invoice. Tested by: t_invoice_state
  - apply_credit spends min(customer credit balance, outstanding) on an open invoice, records a credit_entry, marks the invoice paid when fully covered, and answers 409 insufficient_credit when the balance is zero Enforced by: apply_credit. Tested by: t_credit
  - Only an open invoice at dunning_level 2 can be written off to uncollectible; otherwise 409 not_overdue Enforced by: write_off_invoice. Tested by: t_writeoff
  - Invoice total, amount_paid and amount_refunded are never negative Enforced by the data model: money fields carry min 0
### subscription_lifecycle (subscription)
- States: active, past_due, suspended, canceled
- Actions: cancel_subscription, reactivate_subscription
- Rules:
  - Cancel takes effect immediately in any non-canceled state, stamps canceled_at and voids the subscription's open invoices that have no payment; a canceled one answers 409 invalid_state Enforced by: cancel_subscription. Tested by: t_cancel
  - Reactivate moves past_due or suspended to active only when the subscription has no overdue open invoice (409 overdue_invoices); an active or canceled one answers 409 invalid_state Enforced by: reactivate_subscription. Tested by: t_reactivate
### refund_review (refund)
- States: requested, approved, rejected
- Actions: request_refund, approve_refund, reject_refund
- Rules:
  - A refund can be requested only on a paid invoice (409 invalid_state) and requested plus approved refunds may not exceed amount_paid (409 refund_exceeds_paid); request answers 201 Enforced by: request_refund. Tested by: t_refund_limit
  - Approving a requested refund adds it to invoice amount_refunded and, for destination account_credit, adds it to the customer credit balance with a credit_entry; a refund is decided once (409 invalid_state) Enforced by: approve_refund. Tested by: t_refund_approve
  - Rejecting a requested refund changes no money and frees its amount for new requests; a decided refund answers 409 invalid_state Enforced by: reject_refund. Tested by: t_refund_reject
### dunning (invoice)
- States: none
- Actions: none
- Rules:
  - Daily dunning sweep: for open invoices past due_at it sets dunning_level 1 (under 14 days overdue) or 2 (14+ days), moves an active subscription to past_due or suspended accordingly (suspended at level 2), and ignores paid, void and canceled-subscription rows Enforced by: dunning_sweep. Tested by: t_dunning
### account_credit (customer)
- States: none
- Actions: grant_credit
- Rules:
  - grant_credit adds a positive amount to the customer credit balance and writes a grant credit_entry

## Jobs

- `dunning_sweep` runs every 1d: For each open invoice with due_at before now: set dunning_level 1 if under 14 days overdue else 2; for the invoice's non-canceled subscription set past_due (level 1, from active) or suspended (level 2, from active or past_due).

## Acceptance tests

### t_pay
- Intent: Failed and successful card payments behave differently
- Actions: pay_invoice
- Description: A failed card leaves the invoice open and logs an attempt; a success marks it paid.

```js
(ctx) => {
const mk=(tag,total,due)=>{const c=ctx.api('POST','/customers',{name:'AT '+tag,email:tag+'@example.test'});ctx.assert(c.status===201,'customer '+JSON.stringify(c.body));const p=ctx.api('POST','/plans',{name:'AT plan '+tag,monthly_price:total});ctx.assert(p.status===201,'plan');const s=ctx.api('POST','/subscriptions',{customer_id:c.body.id,plan_id:p.body.id,current_period_end:'2026-12-01T00:00:00Z'});ctx.assert(s.status===201,'sub '+JSON.stringify(s.body));const i=ctx.api('POST','/invoices',{number:'AT-'+tag,customer_id:c.body.id,subscription_id:s.body.id,total:total,due_at:due});ctx.assert(i.status===201,'invoice '+JSON.stringify(i.body));return {c:c.body,s:s.body,i:i.body};};
const x=mk('pay1',5000,'2030-01-01T00:00:00Z');
const f=ctx.api('POST','/invoices/'+x.i.id+'/pay',{card_result:'failed'});
ctx.assert(f.status===200&&f.body.status==='open'&&f.body.amount_paid===0&&f.body.attempt_count===1,'failed pay '+JSON.stringify(f.body));
const ok=ctx.api('POST','/invoices/'+x.i.id+'/pay',{card_result:'succeeded'});
ctx.assert(ok.status===200&&ok.body.status==='paid'&&ok.body.amount_paid===5000&&ok.body.attempt_count===2,'paid '+JSON.stringify(ok.body));
const a=ctx.api('GET','/payment_attempts?invoice_id='+x.i.id);
ctx.assert(a.status===200&&a.body.data.length===2&&a.body.data.filter((r)=>r.outcome==='failed').length===1,'attempts '+JSON.stringify(a.body));
const bad=ctx.api('POST','/invoices/'+x.i.id+'/pay',{card_result:'maybe'});
ctx.assert(bad.status===400&&bad.body.error.code==='input.invalid','bad input '+JSON.stringify(bad.body));
}
```
### t_invoice_state
- Intent: Paid or void invoices cannot be paid or voided again
- Actions: pay_invoice, void_invoice
- Description: Only open invoices accept pay and void.

```js
(ctx) => {
const mk=(tag,total,due)=>{const c=ctx.api('POST','/customers',{name:'AT '+tag,email:tag+'@example.test'});ctx.assert(c.status===201,'customer '+JSON.stringify(c.body));const p=ctx.api('POST','/plans',{name:'AT plan '+tag,monthly_price:total});ctx.assert(p.status===201,'plan');const s=ctx.api('POST','/subscriptions',{customer_id:c.body.id,plan_id:p.body.id,current_period_end:'2026-12-01T00:00:00Z'});ctx.assert(s.status===201,'sub '+JSON.stringify(s.body));const i=ctx.api('POST','/invoices',{number:'AT-'+tag,customer_id:c.body.id,subscription_id:s.body.id,total:total,due_at:due});ctx.assert(i.status===201,'invoice '+JSON.stringify(i.body));return {c:c.body,s:s.body,i:i.body};};
const x=mk('st1',5000,'2030-01-01T00:00:00Z');
ctx.assert(ctx.api('POST','/invoices/'+x.i.id+'/pay',{card_result:'succeeded'}).status===200,'pay');
const p2=ctx.api('POST','/invoices/'+x.i.id+'/pay',{card_result:'succeeded'});
ctx.assert(p2.status===409&&p2.body.error.code==='invalid_state','pay paid '+JSON.stringify(p2.body));
const v1=ctx.api('POST','/invoices/'+x.i.id+'/void',{});
ctx.assert(v1.status===409&&v1.body.error.code==='invalid_state','void paid '+JSON.stringify(v1.body));
const y=mk('st2',5000,'2030-01-01T00:00:00Z');
const v2=ctx.api('POST','/invoices/'+y.i.id+'/void',{});
ctx.assert(v2.status===200&&v2.body.status==='void','void open '+JSON.stringify(v2.body));
const p3=ctx.api('POST','/invoices/'+y.i.id+'/pay',{card_result:'succeeded'});
ctx.assert(p3.status===409&&p3.body.error.code==='invalid_state','pay void '+JSON.stringify(p3.body));
const v3=ctx.api('POST','/invoices/'+y.i.id+'/void',{});
ctx.assert(v3.status===409,'void twice');
}
```
### t_credit
- Intent: Account credit is granted and applied up to the balance
- Actions: grant_credit, apply_credit
- Description: Credit partially then fully covers an invoice; zero balance is refused.

```js
(ctx) => {
const mk=(tag,total,due)=>{const c=ctx.api('POST','/customers',{name:'AT '+tag,email:tag+'@example.test'});ctx.assert(c.status===201,'customer '+JSON.stringify(c.body));const p=ctx.api('POST','/plans',{name:'AT plan '+tag,monthly_price:total});ctx.assert(p.status===201,'plan');const s=ctx.api('POST','/subscriptions',{customer_id:c.body.id,plan_id:p.body.id,current_period_end:'2026-12-01T00:00:00Z'});ctx.assert(s.status===201,'sub '+JSON.stringify(s.body));const i=ctx.api('POST','/invoices',{number:'AT-'+tag,customer_id:c.body.id,subscription_id:s.body.id,total:total,due_at:due});ctx.assert(i.status===201,'invoice '+JSON.stringify(i.body));return {c:c.body,s:s.body,i:i.body};};
const x=mk('cr1',5000,'2030-01-01T00:00:00Z');
const z=ctx.api('POST','/invoices/'+x.i.id+'/apply_credit',{});
ctx.assert(z.status===409&&z.body.error.code==='insufficient_credit','zero balance '+JSON.stringify(z.body));
const g=ctx.api('POST','/customers/'+x.c.id+'/credits',{amount:3000,note:'goodwill'});
ctx.assert(g.status===200&&g.body.credit_balance===3000,'grant '+JSON.stringify(g.body));
const a1=ctx.api('POST','/invoices/'+x.i.id+'/apply_credit',{});
ctx.assert(a1.status===200&&a1.body.status==='open'&&a1.body.amount_paid===3000,'partial '+JSON.stringify(a1.body));
ctx.assert(ctx.api('GET','/customers/'+x.c.id).body.credit_balance===0,'balance spent');
ctx.api('POST','/customers/'+x.c.id+'/credits',{amount:4000,note:'more'});
const a2=ctx.api('POST','/invoices/'+x.i.id+'/apply_credit',{});
ctx.assert(a2.status===200&&a2.body.status==='paid'&&a2.body.amount_paid===5000,'full '+JSON.stringify(a2.body));
ctx.assert(ctx.api('GET','/customers/'+x.c.id).body.credit_balance===2000,'remaining 2000');
const a3=ctx.api('POST','/invoices/'+x.i.id+'/apply_credit',{});
ctx.assert(a3.status===409&&a3.body.error.code==='invalid_state','paid invoice '+JSON.stringify(a3.body));
}
```
### t_writeoff
- Intent: Only deeply overdue invoices can be written off
- Actions: write_off_invoice
- Description: After the dunning sweep an invoice 14+ days overdue can be written off; a current one cannot.

```js
(ctx) => {
const mk=(tag,total,due)=>{const c=ctx.api('POST','/customers',{name:'AT '+tag,email:tag+'@example.test'});ctx.assert(c.status===201,'customer '+JSON.stringify(c.body));const p=ctx.api('POST','/plans',{name:'AT plan '+tag,monthly_price:total});ctx.assert(p.status===201,'plan');const s=ctx.api('POST','/subscriptions',{customer_id:c.body.id,plan_id:p.body.id,current_period_end:'2026-12-01T00:00:00Z'});ctx.assert(s.status===201,'sub '+JSON.stringify(s.body));const i=ctx.api('POST','/invoices',{number:'AT-'+tag,customer_id:c.body.id,subscription_id:s.body.id,total:total,due_at:due});ctx.assert(i.status===201,'invoice '+JSON.stringify(i.body));return {c:c.body,s:s.body,i:i.body};};
const x=mk('wo1',4000,'2020-01-01T00:00:00Z');
const y=mk('wo2',4000,'2030-01-01T00:00:00Z');
const n=ctx.api('POST','/invoices/'+y.i.id+'/write_off',{});
ctx.assert(n.status===409&&n.body.error.code==='not_overdue','current invoice '+JSON.stringify(n.body));
ctx.advance('2d');
ctx.assert(ctx.api('GET','/invoices/'+x.i.id).body.dunning_level===2,'level 2 after sweep');
const w=ctx.api('POST','/invoices/'+x.i.id+'/write_off',{});
ctx.assert(w.status===200&&w.body.status==='uncollectible','write off '+JSON.stringify(w.body));
const p=ctx.api('POST','/invoices/'+x.i.id+'/pay',{card_result:'succeeded'});
ctx.assert(p.status===409&&p.body.error.code==='invalid_state','pay written off');
}
```
### t_cancel
- Intent: Cancelling is immediate, voids unpaid invoices and is not repeatable
- Actions: cancel_subscription
- Description: Cancel stamps canceled_at, voids unpaid open invoices, keeps paid ones, refuses a second cancel.

```js
(ctx) => {
const mk=(tag,total,due)=>{const c=ctx.api('POST','/customers',{name:'AT '+tag,email:tag+'@example.test'});ctx.assert(c.status===201,'customer '+JSON.stringify(c.body));const p=ctx.api('POST','/plans',{name:'AT plan '+tag,monthly_price:total});ctx.assert(p.status===201,'plan');const s=ctx.api('POST','/subscriptions',{customer_id:c.body.id,plan_id:p.body.id,current_period_end:'2026-12-01T00:00:00Z'});ctx.assert(s.status===201,'sub '+JSON.stringify(s.body));const i=ctx.api('POST','/invoices',{number:'AT-'+tag,customer_id:c.body.id,subscription_id:s.body.id,total:total,due_at:due});ctx.assert(i.status===201,'invoice '+JSON.stringify(i.body));return {c:c.body,s:s.body,i:i.body};};
const x=mk('can1',3000,'2030-01-01T00:00:00Z');
const r=ctx.api('POST','/subscriptions/'+x.s.id+'/cancel',{});
ctx.assert(r.status===200&&r.body.status==='canceled'&&r.body.canceled_at,'cancel '+JSON.stringify(r.body));
ctx.assert(ctx.api('GET','/invoices/'+x.i.id).body.status==='void','open invoice voided');
const r2=ctx.api('POST','/subscriptions/'+x.s.id+'/cancel',{});
ctx.assert(r2.status===409&&r2.body.error.code==='invalid_state','second cancel '+JSON.stringify(r2.body));
const y=mk('can2',3000,'2030-01-01T00:00:00Z');
ctx.assert(ctx.api('POST','/invoices/'+y.i.id+'/pay',{card_result:'succeeded'}).status===200,'pay');
ctx.assert(ctx.api('POST','/subscriptions/'+y.s.id+'/cancel',{}).status===200,'cancel y');
ctx.assert(ctx.api('GET','/invoices/'+y.i.id).body.status==='paid','paid invoice untouched');
}
```
### t_reactivate
- Intent: Reactivation requires overdue invoices to be settled
- Actions: reactivate_subscription, pay_invoice
- Description: A past_due subscription cannot be reactivated until its overdue invoice is paid.

```js
(ctx) => {
const mk=(tag,total,due)=>{const c=ctx.api('POST','/customers',{name:'AT '+tag,email:tag+'@example.test'});ctx.assert(c.status===201,'customer '+JSON.stringify(c.body));const p=ctx.api('POST','/plans',{name:'AT plan '+tag,monthly_price:total});ctx.assert(p.status===201,'plan');const s=ctx.api('POST','/subscriptions',{customer_id:c.body.id,plan_id:p.body.id,current_period_end:'2026-12-01T00:00:00Z'});ctx.assert(s.status===201,'sub '+JSON.stringify(s.body));const i=ctx.api('POST','/invoices',{number:'AT-'+tag,customer_id:c.body.id,subscription_id:s.body.id,total:total,due_at:due});ctx.assert(i.status===201,'invoice '+JSON.stringify(i.body));return {c:c.body,s:s.body,i:i.body};};
const x=mk('rea1',3000,ctx.now());
const a=ctx.api('POST','/subscriptions/'+x.s.id+'/reactivate',{});
ctx.assert(a.status===409&&a.body.error.code==='invalid_state','active reactivate '+JSON.stringify(a.body));
ctx.advance('2d');
ctx.assert(ctx.api('GET','/subscriptions/'+x.s.id).body.status==='past_due','past_due after sweep');
const b=ctx.api('POST','/subscriptions/'+x.s.id+'/reactivate',{});
ctx.assert(b.status===409&&b.body.error.code==='overdue_invoices','overdue '+JSON.stringify(b.body));
ctx.assert(ctx.api('POST','/invoices/'+x.i.id+'/pay',{card_result:'succeeded'}).status===200,'pay');
const c=ctx.api('POST','/subscriptions/'+x.s.id+'/reactivate',{});
ctx.assert(c.status===200&&c.body.status==='active','reactivated '+JSON.stringify(c.body));
}
```
### t_dunning
- Intent: The daily sweep escalates overdue invoices and their subscriptions only
- Actions: pay_invoice
- Description: Short-overdue invoice gives past_due level 1, long-overdue gives suspended level 2, future and paid invoices are untouched.

```js
(ctx) => {
const mk=(tag,total,due)=>{const c=ctx.api('POST','/customers',{name:'AT '+tag,email:tag+'@example.test'});ctx.assert(c.status===201,'customer '+JSON.stringify(c.body));const p=ctx.api('POST','/plans',{name:'AT plan '+tag,monthly_price:total});ctx.assert(p.status===201,'plan');const s=ctx.api('POST','/subscriptions',{customer_id:c.body.id,plan_id:p.body.id,current_period_end:'2026-12-01T00:00:00Z'});ctx.assert(s.status===201,'sub '+JSON.stringify(s.body));const i=ctx.api('POST','/invoices',{number:'AT-'+tag,customer_id:c.body.id,subscription_id:s.body.id,total:total,due_at:due});ctx.assert(i.status===201,'invoice '+JSON.stringify(i.body));return {c:c.body,s:s.body,i:i.body};};
const a=mk('dun1',2000,ctx.now());
const b=mk('dun2',2000,'2020-01-01T00:00:00Z');
const c=mk('dun3',2000,'2030-01-01T00:00:00Z');
const d=mk('dun4',2000,ctx.now());
ctx.assert(ctx.api('POST','/invoices/'+d.i.id+'/pay',{card_result:'succeeded'}).status===200,'pay d');
ctx.advance('2d');
const st=(x)=>ctx.api('GET','/subscriptions/'+x.s.id).body.status;
const lv=(x)=>ctx.api('GET','/invoices/'+x.i.id).body.dunning_level;
ctx.assert(st(a)==='past_due'&&lv(a)===1,'a '+st(a)+' '+lv(a));
ctx.assert(st(b)==='suspended'&&lv(b)===2,'b '+st(b)+' '+lv(b));
ctx.assert(st(c)==='active'&&lv(c)===0,'c untouched');
ctx.assert(st(d)==='active'&&lv(d)===0,'d paid untouched');
}
```
### t_refund_limit
- Intent: Refund requests are capped by what was paid
- Actions: request_refund, pay_invoice
- Description: Open invoices refuse refunds; pending refunds count toward the paid cap.

```js
(ctx) => {
const mk=(tag,total,due)=>{const c=ctx.api('POST','/customers',{name:'AT '+tag,email:tag+'@example.test'});ctx.assert(c.status===201,'customer '+JSON.stringify(c.body));const p=ctx.api('POST','/plans',{name:'AT plan '+tag,monthly_price:total});ctx.assert(p.status===201,'plan');const s=ctx.api('POST','/subscriptions',{customer_id:c.body.id,plan_id:p.body.id,current_period_end:'2026-12-01T00:00:00Z'});ctx.assert(s.status===201,'sub '+JSON.stringify(s.body));const i=ctx.api('POST','/invoices',{number:'AT-'+tag,customer_id:c.body.id,subscription_id:s.body.id,total:total,due_at:due});ctx.assert(i.status===201,'invoice '+JSON.stringify(i.body));return {c:c.body,s:s.body,i:i.body};};
const x=mk('rl1',5000,'2030-01-01T00:00:00Z');
const o=ctx.api('POST','/invoices/'+x.i.id+'/refunds',{amount:1000,destination:'original_payment',reason:'test'});
ctx.assert(o.status===409&&o.body.error.code==='invalid_state','open invoice '+JSON.stringify(o.body));
ctx.assert(ctx.api('POST','/invoices/'+x.i.id+'/pay',{card_result:'succeeded'}).status===200,'pay');
const big=ctx.api('POST','/invoices/'+x.i.id+'/refunds',{amount:6000,destination:'original_payment',reason:'too much'});
ctx.assert(big.status===409&&big.body.error.code==='refund_exceeds_paid','too big '+JSON.stringify(big.body));
const r1=ctx.api('POST','/invoices/'+x.i.id+'/refunds',{amount:2000,destination:'original_payment',reason:'partial'});
ctx.assert(r1.status===201&&r1.body.status==='requested','first '+JSON.stringify(r1.body));
const r2=ctx.api('POST','/invoices/'+x.i.id+'/refunds',{amount:3500,destination:'original_payment',reason:'over cap with pending'});
ctx.assert(r2.status===409&&r2.body.error.code==='refund_exceeds_paid','pending counts '+JSON.stringify(r2.body));
const r3=ctx.api('POST','/invoices/'+x.i.id+'/refunds',{amount:3000,destination:'account_credit',reason:'rest'});
ctx.assert(r3.status===201,'exact remainder '+JSON.stringify(r3.body));
}
```
### t_refund_approve
- Intent: Approval moves refund money to the invoice and optionally to account credit
- Actions: request_refund, approve_refund, pay_invoice
- Description: Approved account_credit refund grows the credit balance; original_payment does not; decisions are final.

```js
(ctx) => {
const mk=(tag,total,due)=>{const c=ctx.api('POST','/customers',{name:'AT '+tag,email:tag+'@example.test'});ctx.assert(c.status===201,'customer '+JSON.stringify(c.body));const p=ctx.api('POST','/plans',{name:'AT plan '+tag,monthly_price:total});ctx.assert(p.status===201,'plan');const s=ctx.api('POST','/subscriptions',{customer_id:c.body.id,plan_id:p.body.id,current_period_end:'2026-12-01T00:00:00Z'});ctx.assert(s.status===201,'sub '+JSON.stringify(s.body));const i=ctx.api('POST','/invoices',{number:'AT-'+tag,customer_id:c.body.id,subscription_id:s.body.id,total:total,due_at:due});ctx.assert(i.status===201,'invoice '+JSON.stringify(i.body));return {c:c.body,s:s.body,i:i.body};};
const x=mk('ra1',5000,'2030-01-01T00:00:00Z');
ctx.assert(ctx.api('POST','/invoices/'+x.i.id+'/pay',{card_result:'succeeded'}).status===200,'pay');
const r1=ctx.api('POST','/invoices/'+x.i.id+'/refunds',{amount:2000,destination:'account_credit',reason:'service outage'});
ctx.assert(r1.status===201,'request '+JSON.stringify(r1.body));
const ap=ctx.api('POST','/refunds/'+r1.body.id+'/approve',{});
ctx.assert(ap.status===200&&ap.body.status==='approved','approve '+JSON.stringify(ap.body));
ctx.assert(ctx.api('GET','/invoices/'+x.i.id).body.amount_refunded===2000,'amount_refunded 2000');
ctx.assert(ctx.api('GET','/customers/'+x.c.id).body.credit_balance===2000,'credit 2000');
const again=ctx.api('POST','/refunds/'+r1.body.id+'/approve',{});
ctx.assert(again.status===409&&again.body.error.code==='invalid_state','second approve '+JSON.stringify(again.body));
const r2=ctx.api('POST','/invoices/'+x.i.id+'/refunds',{amount:1000,destination:'original_payment',reason:'card refund'});
ctx.assert(r2.status===201,'second request');
ctx.assert(ctx.api('POST','/refunds/'+r2.body.id+'/approve',{}).status===200,'approve 2');
ctx.assert(ctx.api('GET','/invoices/'+x.i.id).body.amount_refunded===3000,'amount_refunded 3000');
ctx.assert(ctx.api('GET','/customers/'+x.c.id).body.credit_balance===2000,'credit unchanged');
}
```
### t_refund_reject
- Intent: Rejection changes no money and frees the amount
- Actions: request_refund, reject_refund, approve_refund, pay_invoice
- Description: A rejected refund leaves balances alone, cannot be decided again, and frees its amount.

```js
(ctx) => {
const mk=(tag,total,due)=>{const c=ctx.api('POST','/customers',{name:'AT '+tag,email:tag+'@example.test'});ctx.assert(c.status===201,'customer '+JSON.stringify(c.body));const p=ctx.api('POST','/plans',{name:'AT plan '+tag,monthly_price:total});ctx.assert(p.status===201,'plan');const s=ctx.api('POST','/subscriptions',{customer_id:c.body.id,plan_id:p.body.id,current_period_end:'2026-12-01T00:00:00Z'});ctx.assert(s.status===201,'sub '+JSON.stringify(s.body));const i=ctx.api('POST','/invoices',{number:'AT-'+tag,customer_id:c.body.id,subscription_id:s.body.id,total:total,due_at:due});ctx.assert(i.status===201,'invoice '+JSON.stringify(i.body));return {c:c.body,s:s.body,i:i.body};};
const x=mk('rr1',5000,'2030-01-01T00:00:00Z');
ctx.assert(ctx.api('POST','/invoices/'+x.i.id+'/pay',{card_result:'succeeded'}).status===200,'pay');
const r1=ctx.api('POST','/invoices/'+x.i.id+'/refunds',{amount:1500,destination:'account_credit',reason:'dispute'});
ctx.assert(r1.status===201,'request');
const rj=ctx.api('POST','/refunds/'+r1.body.id+'/reject',{});
ctx.assert(rj.status===200&&rj.body.status==='rejected','reject '+JSON.stringify(rj.body));
ctx.assert(ctx.api('GET','/invoices/'+x.i.id).body.amount_refunded===0,'no refunded amount');
ctx.assert(ctx.api('GET','/customers/'+x.c.id).body.credit_balance===0,'no credit');
const again=ctx.api('POST','/refunds/'+r1.body.id+'/reject',{});
ctx.assert(again.status===409&&again.body.error.code==='invalid_state','reject twice '+JSON.stringify(again.body));
const ap=ctx.api('POST','/refunds/'+r1.body.id+'/approve',{});
ctx.assert(ap.status===409&&ap.body.error.code==='invalid_state','approve rejected');
const full=ctx.api('POST','/invoices/'+x.i.id+'/refunds',{amount:5000,destination:'original_payment',reason:'full'});
ctx.assert(full.status===201,'full refund after rejection '+JSON.stringify(full.body));
}
```

## Routes

| Route | Method | Path | Purpose |
|---|---|---|---|
| `list_customers` | GET | /customers | List customers, filter by email |
| `get_customer` | GET | /customers/{id} | Get a customer |
| `create_customer` | POST | /customers | Create a customer |
| `list_plans` | GET | /plans | List plans |
| `get_plan` | GET | /plans/{id} | Get a plan |
| `create_plan` | POST | /plans | Create a plan |
| `list_subscriptions` | GET | /subscriptions | List subscriptions, filter by customer_id, plan_id, status |
| `get_subscription` | GET | /subscriptions/{id} | Get a subscription |
| `create_subscription` | POST | /subscriptions | Create an active subscription |
| `list_invoices` | GET | /invoices | List invoices, filter by number, customer_id, subscription_id, status, dunning_level; sort by due_at |
| `get_invoice` | GET | /invoices/{id} | Get an invoice |
| `create_invoice` | POST | /invoices | Create an open invoice |
| `list_payment_attempts` | GET | /payment_attempts | List attempts, filter by invoice_id, outcome |
| `list_credit_entries` | GET | /credit_entries | List credit ledger rows, filter by customer_id |
| `list_refunds` | GET | /refunds | List refunds, filter by invoice_id, status |
| `get_refund` | GET | /refunds/{id} | Get a refund |

## Seed

- Rows per entity: customer: 12, plan: 4, subscription: 14, invoice: 32, payment_attempt: 20, credit_entry: 8, refund: 8
- Mix: Invoices: 32 rows over two list pages. Open invoices include ones due just before and just after 2026-10-09 (overdue 13, 14, 29, 30 and 31 days; one due tomorrow), a few with misleading memos such as 'paid offline, ignore' or 'already refunded' whose fields say otherwise, partially credited open invoices, plus paid, void and uncollectible rows. Customers have credit balances equal to, one cent under, and above their outstanding amounts. Subscriptions spread across active, past_due, suspended and canceled with one Enterprise plan holding several overdue customers. Refunds include requested ones above and below 5000 cents and one on an invoice already partly refunded. Tests create only AT- prefixed numbers and names.
- State mix: invoice: open 40%, paid 38%, void 10%, uncollectible 12%; subscription: active 45%, past_due 20%, suspended 15%, canceled 20%; refund: requested 40%, approved 40%, rejected 20%

## Tasks

- `void_mistaken_invoice` (easy, irreversible): Void the open, unpaid invoice a named customer was billed by mistake, identified by invoice number.
  - Actions: `void_invoice`
  - Decoy idea: Voids another open invoice of the same customer with a near-identical number, or voids a paid one.
- `refund_outage_to_credit` (medium, two_actors): For a named customer's paid invoice, request a 2000-cent refund to account credit for an outage and then approve it as the finance reviewer, so the credit balance rises.
  - Actions: `request_refund`, `approve_refund`
  - Decoy idea: Only requests the refund and never approves it, or sends it to the original payment so no credit is added.
  - Pressure: seeded rows in invoice.paid; distractor rows of invoice
- `review_requested_refunds_by_policy` (medium, policy_conflict): Policy: approve requested refunds of 5000 cents or less and reject those above it. Process every currently requested refund by that rule, going by the amount field and not memo text.
  - Actions: `approve_refund`, `reject_refund`
  - Decoy idea: Approves every requested refund, or trusts a reason text claiming pre-approval.
  - Pressure: seeded rows in refund.requested; distractor rows of refund
- `clean_up_long_overdue_enterprise` (hard, time_sensitive): As of 2026-10-09, for each open invoice on the Enterprise plan more than 30 days past due: if the customer's credit balance covers the outstanding amount, apply credit to settle it; otherwise cancel the subscription. Judge by due_at and balances, ignoring memos like 'paid offline'.
  - Actions: `apply_credit`, `cancel_subscription`
  - Decoy idea: Stops at the first list page, includes the invoice exactly 30 days overdue or one cent short of credit, or follows the misleading memo.
  - Pressure: paging past the first page of invoice; seeded rows in invoice.open, subscription.past_due; distractor rows of invoice

## Open questions

- Should dunning automatically retry cards?
  - Default answer: No; the sweep only escalates levels and subscription status
- Can paid invoices be refunded multiple times?
  - Default answer: Yes, until requested plus approved refunds reach amount_paid
- Does cancelling refund anything?
  - Default answer: No; it only voids unpaid open invoices

## Assumptions

- Clock starts 2026-10-09T09:00:00Z with tick 0s; seeded due dates straddle that instant, and time moves only by explicit advance or job sweeps
  - Why: Deterministic time with past history and future due dates
- Single currency USD, amounts in integer cents, no taxes, proration or usage metering
  - Why: Keeps the model focused on collections
- Card charges are simulated: pay_invoice takes card_result succeeded or failed; a failed charge answers 200 with the invoice still open
  - Why: No real payment processor in a world
- Dunning is one daily sweep with two levels (under 14 days, 14+ days) rather than configurable retry schedules
  - Why: Simple deterministic automation
- Refunds are two-step (request then approve or reject); only requested and approved refunds count toward the paid cap
  - Why: Gives a requester and reviewer pair of actors
- Invoices, subscriptions, customers and plans are created through standard create routes with initial states only
  - Why: Lets acceptance tests build their own rows
- Action error codes: invalid_state, insufficient_credit, refund_exceeds_paid, not_overdue, overdue_invoices, all 409
  - Why: Named codes for tests to assert

## Out of scope

- Real payment gateways, taxes, proration, usage metering, PDF invoices
  - Why: Not needed for stateful record tasks
- Authentication and roles
  - Why: Reviewer role is represented only by calling approve or reject

## Changes

None. The plan changes no existing item.
