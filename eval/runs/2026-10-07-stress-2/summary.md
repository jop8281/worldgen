# Eval run stress-2, 2026-10-07

The whole `stress` suite of 29 cases ran on main `3ff2c3a`, which was promoted and qualified on Bun and Node. Model `claude-sonnet-5-5`, transport `claude-cli`, budget $3 and 12 min per run. Four sessions ran it in parallel lanes, one case after another within each lane. Each `lane-*/summary.md` is that lane's own scorecard, written by the eval runner. Each case directory keeps `case.json` and `events.jsonl`. Worlds, plans and attempt dumps stay out of the repo.

## Totals

**22 of 29 pass (75.9%).** 19 done and 10 stopped, of which 3 are expected refusals. 0 crashed and 0 unlogged. 30 runs, because helpdesk-add-refunds is a create plus a change. **177.7 min and $34.65**, summed from the 30 `run_finished` events. The four lane totals add up to the same figures.

| lane | cases | pass | done | stopped | min | $ |
|---|--:|--:|--:|--:|--:|--:|
| A | 7 | 7 | 6 | 1 | 45.1 | 8.29 |
| B | 7 | 5 | 5 | 2 | 48.2 | 10.36 |
| C | 7 | 5 | 5 | 2 | 51.2 | 9.21 |
| D | 8 | 5 | 3 | 5 | 33.2 | 6.79 |
| all | 29 | 22 | 19 | 10 | 177.7 | 34.65 |

Per run, over all 30 runs: time p50 6.4 min, p90 8.9 min, max 9.8 min. Cost p50 $1.27, p90 $1.64, max $1.88.

## Against the targets

| issue | target | stress-2 | met |
|---|---|---|---|
| YOS-53 | at least 70% of a fixed full suite | 22/29, 75.9% | yes |
| YOS-54 | at least 85%, or an explicit reason for each failure | 75.9%, and each of the 7 failures has a root cause below | reasons given, 85% not reached |
| YOS-54 | median run at most 10 min | p50 6.4 min | yes |
| YOS-54 | every run within 15 min | max 9.8 min | yes |

## Against stress-1b

All 14 stress-1b cases ran again here. Stress-1b passed 7 of the 14 (#395), and stress-2 passes 12. No case went from pass to fail.

| case | stress-1b result | 1b pass | stress-2 result | 2 pass |
|---|---|---|---|---|
| bakery-vague | stopped (host asleep) | no | done | yes |
| billing-dunning | done | yes | done | yes |
| clinic-appointments | done | yes | done | yes |
| helpdesk-add-refunds | stopped, budget_exhausted on the change | no | done | yes |
| helpdesk-sla | done | yes | done | yes |
| library-holds | done | yes | done | yes |
| linear-description | stopped, no_progress at seed | no | done | yes |
| orders-csv | done | yes | done | yes |
| petstore-store | stopped, stage_time_exhausted at model | no | stopped, no_progress at workflow | no |
| retail-tau2-known | done | yes | done | yes |
| stripe-partial-refunds | stopped, stage_time_exhausted at model | no | stopped, no_progress at workflow | no |
| stripe-refunds | stopped, stage_time_exhausted at model | no | done | yes |
| todo-projects | done | yes | done | yes |
| video-codec-impossible | done, should have refused | no | stopped, input_rejected at plan | yes |

## Failures by root cause

1. **The frozen acceptance tests contradict the built API (5 cases).** The plan step writes acceptance tests from the input before the model step builds the API, and later steps cannot edit them. Here the tests used the spec's own shapes, and the model step built different ones. The workflow step cannot change either side, so it repeats the same failing tests and stops `no_progress`.
   - petstore-store (B), petstore-full (D) and petstore-add-refunds (D). The tests send camelCase `petId`, `photoUrls` and `shipDate`. The world declares `pet_id` and `photo_urls`, and refuses the input with 400 `input.invalid` or 422 `field.unknown`.
   - stripe-customers (D). The test expects Stripe's 200 on create, and the world answers 201.
   - stripe-partial-refunds (B). The tests assert a list envelope and a create response shaped differently from the built ones.
2. **A frozen test assumes empty tables (1 case).** hotel-booking (C): 'refused bookings created nothing' lists the whole reservations table, and a fee test counts every folio charge. Seed rows break both. The seed step retried three times and stopped `stage_time_exhausted` at seed. Commit 7f4e156d ("send a frozen test the seed keeps failing back to plan") landed after this run, on `stabilize-next`, and was not measured here.
3. **The plan step's time share is too short for a long plan call (1 case).** rental-fleet (C): one plan call ran 288 s, used up the plan step's whole share, and stopped `stage_time_exhausted` at plan.

The 3 expected refusals pass: video-codec-impossible (A), forecast-impossible (D) and live-market-feed-impossible (D) each stop `input_rejected` at plan for $0.03, with no world written.

## All cases

Minutes and dollars come from each case's `run_finished` events. For helpdesk-add-refunds they cover both runs.

| case | lane | expect | result | stop reason | min | $ | pass |
|---|---|---|---|---|--:|--:|---|
| bakery-vague | A | done | done | - | 8.0 | 1.61 | yes |
| billing-dunning | A | done | done | - | 7.0 | 1.19 | yes |
| clinic-appointments | A | done | done | - | 8.9 | 1.62 | yes |
| helpdesk-sla | A | done | done | - | 6.5 | 1.25 | yes |
| library-holds | A | done | done | - | 8.4 | 1.41 | yes |
| todo-projects | A | done | done | - | 6.1 | 1.17 | yes |
| video-codec-impossible | A | stopped | stopped | input_rejected | 0.2 | 0.03 | yes |
| helpdesk-add-refunds | B | done | done | - | 11.0 | 2.73 | yes |
| linear-backlog-csv | B | done | done | - | 7.1 | 1.54 | yes |
| orders-csv | B | done | done | - | 5.2 | 1.27 | yes |
| petstore-store | B | done | stopped | no_progress at workflow | 3.3 | 0.66 | no |
| retail-tau2-known | B | done | done | - | 7.7 | 1.41 | yes |
| stripe-partial-refunds | B | done | stopped | no_progress at workflow | 6.4 | 1.30 | no |
| stripe-refunds | B | done | done | - | 7.5 | 1.45 | yes |
| bookmarks | C | done | done | - | 7.7 | 1.46 | yes |
| hotel-booking | C | done | stopped | stage_time_exhausted at seed | 8.9 | 1.85 | no |
| insurance-claims | C | done | done | - | 8.9 | 1.58 | yes |
| linear-description | C | done | done | - | 7.4 | 1.39 | yes |
| rental-fleet | C | done | stopped | stage_time_exhausted at plan | 4.8 | 0.54 | no |
| repair-desk | C | done | done | - | 3.7 | 0.80 | yes |
| warehouse-inventory | C | done | done | - | 9.8 | 1.60 | yes |
| course-enrollments-csv | D | done | done | - | 5.5 | 1.26 | yes |
| forecast-impossible | D | stopped | stopped | input_rejected | 0.2 | 0.03 | yes |
| live-market-feed-impossible | D | stopped | stopped | input_rejected | 0.2 | 0.03 | yes |
| petstore-add-refunds | D | done | stopped | no_progress at workflow | 5.2 | 0.95 | no |
| petstore-full | D | done | stopped | no_progress at workflow | 5.7 | 0.90 | no |
| shipments-csv | D | done | done | - | 4.6 | 1.03 | yes |
| stripe-charges | D | done | done | - | 8.4 | 1.77 | yes |
| stripe-customers | D | done | stopped | no_progress at workflow | 3.5 | 0.82 | no |

## Notes

- A fifth lane E was started for repair-desk, retail-tau2-known and stripe-partial-refunds, after a wrong count suggested they were in no lane. It was stopped 50 s in as a duplicate, and nothing from it is kept. Its attempt events recorded $0. Stopping its `bun run eval` left the `claude -p` child running until a SIGKILL, so a cancelled eval can keep a paid call alive. That finding was reported for YOS-87 and YOS-114.
- `events.jsonl` and `case.json` carry absolute paths under the operator's home directory, as earlier committed runs do. A scan for key and token patterns found none.
