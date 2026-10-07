# YOS-137: fixed-denominator offline eval analysis

The existing summary remains unchanged. A separate pure analyzer consumes an explicit
expected manifest plus current-layout case/event evidence. Missing or malformed expected
records remain failures in the success denominator; duplicates are not silently deduplicated
and unexpected records are surfaced. Outcome validity is separate from metric coverage.

Terminal time and cost are independently nullable; absent values are never priced as zero
or reconstructed from partial attempts. Attempts count complete logged events with boundary,
sequence and step-count checks. Coverage denominators include every expected case. Percentiles
use nearest-rank over the measured subset and are labeled accordingly. No report claims
improvement from a single run or an incomplete subset.

The offline script reads current `case.json` and phase `events.jsonl` paths without running
WorldGen, a model, a world or Boat. Hidden history, including YOS-136 `.attempts`, is ignored;
this work has no dependency on the history layout. It does not change configuration, efforts,
pricing, caps, provider transport, engine behavior, the eval CLI or existing summaries.

Factory evidence and the tests-first record live outside the checkout in `evidence/YOS-137`.
The coordinator owns publication and aggregate verification. Parent YOS-54 paid tuning stays
open; this change provides measurement analysis only.
