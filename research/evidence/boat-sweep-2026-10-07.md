# Boat sandbox sweep, 2026-10-07

worldgen-27 ran this sweep at 07:40 PDT on 2026-10-07, from a checkout of `stabilize/main` at `33f158a7`. The log below is copied verbatim from its run. It holds no key, because `BOAT_API_KEY` came only from the environment. The sandbox ids are torn down.

For each world, from `code/`, the sweep ran these steps:

1. `npx tsx src/cli/sandbox.ts up ../prod/worlds/<world> --backend boat --size small --ttl 900`, which prints the sandbox id and the world URL.
2. `curl <url>/openapi.json`, logged as `paths=`, the number of paths in the document.
3. `curl <url><first list path>`, the first GET path with no `{param}`, logged as `GET<path>=` with the HTTP status.
4. `curl <url>/_world/state` on the world port, logged as `admin_on_world_port=`. A 404 means the world port refused the admin route. `000` means curl got no HTTP response within 20 seconds.
5. `npx tsx src/cli/sandbox.ts down <id>`, logged as `down_rc=`.

It ran helpdesk first as a pilot, then the other 24 worlds in 3 parallel lanes. `UP_FAIL` lines are worlds that did not come up. The two `retry` lines at the end reran them one at a time.

```
helpdesk id=bx_qf7pks8s paths=13 GET/tickets=200 admin_on_world_port=404 down_rc=0 secs=47
gen-repair-desk id=bx_qq9j9yux paths=7 GET/technicians=200 admin_on_world_port=404 down_rc=0 secs=46
gen-bakery-vague id=bx_dvv2afd5 paths=20 GET/products=200 admin_on_world_port=404 down_rc=0 secs=50
gen-library-loans UP_FAIL rc=1 admin http://127.0.0.1:4001
gen-retail-tau2-known id=bx_zhpj5cdp paths=19 GET/users=200 admin_on_world_port=404 down_rc=0 secs=49
gen-billing-dunning id=bx_9h8kyddt paths=20 GET/plans=200 admin_on_world_port=404 down_rc=0 secs=70
gen-linear-backlog id=bx_u8w6qgnh paths=23 GET/issues=200 admin_on_world_port=404 down_rc=0 secs=58
gen-bookmarks id=bx_q3ttfhx3 paths=29 GET/users=200 admin_on_world_port=404 down_rc=0 secs=36
gen-shipments UP_FAIL rc=1 admin http://127.0.0.1:4001
gen-clinic-appointments id=bx_j3vxpkgr paths=14 GET/doctors=200 admin_on_world_port=404 down_rc=0 secs=51
gen-stripe-charges id=bx_ff2n6r8d paths=8 GET/v1/charges=200 admin_on_world_port=404 down_rc=0 secs=46
gen-orders id=bx_u25a5cz3 paths=11 GET/orders=200 admin_on_world_port=000 down_rc=0 secs=74
gen-course-enrollments id=bx_wzbgyx9h paths=8 GET/courses=200 admin_on_world_port=404 down_rc=0 secs=35
gen-orders-customers id=bx_qkxn3r8h paths=10 GET/customers=200 admin_on_world_port=404 down_rc=0 secs=47
gen-stripe-customers id=bx_mhryqczv paths=2 GET/v1/customers=200 admin_on_world_port=404 down_rc=0 secs=60
gen-helpdesk id=bx_c2g3tkz4 paths=14 GET/tickets=200 admin_on_world_port=404 down_rc=0 secs=48
gen-todo-projects id=bx_fk8t44dm paths=13 GET/projects=200 admin_on_world_port=404 down_rc=0 secs=42
gen-petstore id=bx_7se55yk4 paths=11 GET/pet/findByStatus=200 admin_on_world_port=404 down_rc=0 secs=60
gen-hotel-booking id=bx_9gv4euts paths=15 GET/room_types=200 admin_on_world_port=404 down_rc=0 secs=44
gen-petstore-refunds id=bx_wpgqvh6q paths=17 GET/pet/findByStatus=200 admin_on_world_port=404 down_rc=0 secs=32
gen-warehouse-inventory id=bx_q59nuupm paths=20 GET/suppliers=200 admin_on_world_port=404 down_rc=0 secs=40
gen-insurance-claims id=bx_xru3cep2 paths=25 GET/claims=200 admin_on_world_port=404 down_rc=0 secs=52
retail-tau2 id=bx_g9fma9zf paths=18 GET/customers=200 admin_on_world_port=404 down_rc=0 secs=40
gen-refunds id=bx_ajegjwft paths=5 GET/v1/refunds=200 admin_on_world_port=404 down_rc=0 secs=44
gen-rental-fleet id=bx_rzvnyb3q paths=22 GET/branches=200 admin_on_world_port=404 down_rc=0 secs=60
gen-shipments retry id=bx_syn54xzp GET/shipments=200 down ok (first try failed under 3 parallel lanes)
gen-library-loans retry id=bx_s2j5qpvg openapi=200 down ok
```
