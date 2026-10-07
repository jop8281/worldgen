# Spec calls: engine-clock

- Jobs fire at `start + k * every` for k >= 1 (anchored to the clock start, never to `from`). Why: A-17 gives no anchor, and anchoring to `from` would make firing times depend on how advances are chunked. Reversible: yes.
- A job's first firing is one interval after `start`, not at `start`. Why: matches acceptance 3, where from == start excludes start itself. Reversible: yes.
- A zero interval (`0s`) is rejected with RangeError in `dueJobs`. Why: it would never terminate. `check.ts` should also report it as an issue (follow-up for the check unit). Reversible: yes.
- Malformed durations and unparsable ISO strings throw RangeError rather than returning NaN. Why: NaN would silently poison time. Reversible: yes.
- Ties are ordered by code-unit comparison of job names, not `localeCompare`. Why: determinism across host locales. Reversible: yes.
- `fromIso` accepts only ISO 8601 with seconds and an explicit `Z` or +-HH:MM offset (fractional seconds optional); everything else throws RangeError. Why: `new Date(string)` parses zone-less and free-form strings in the host timezone, which would break determinism. `toIso` always emits the `.sssZ` form. Reversible: yes.
- `dueJobs` requires safe-integer `start`, `from`, `to`, and throws RangeError if one call would return more than `MAX_DUE_FIRINGS` (100000) firings. `parseDuration` throws RangeError when the result is not a safe integer. Why: bounds time and memory. Reversible: yes.
