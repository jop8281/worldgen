# Spec calls: fix-engine-clock

- All four findings reproduced at base (V8 rolls Feb 30 to Mar 2 and 24:00 to next day; '0s' passed the schema; huge durations passed up to MAX_SAFE_INTEGER ms). Why: probes confirmed by direct runs.
- Duration is now a zod superRefine over one shared `durationProblem` function, so the schema, `parseDuration` and `check` give the same precise message. Reversible: yes.
- Bound is MAX_DURATION_MS = 8.64e15 (inclusive). Why: Date range per acceptance 3.
- `check.ts` is unchanged: the schema layer already reports jobs.every and meta.clock.tick as schema.invalid at their paths. Why: no second validation needed.
- `meta.clock.start` with an impossible date was already rejected by z.iso.datetime; not changed (test R21 pins it).
- fromIso also rejects second 60 and offsets past 23:59. Why: consistent with minute 60.
- Duration cap is 8.64e15 minus the latest start fromIso can return (9999-12-31 plus 2 days of offset slack), about 8.3866e15 ms. Why: a Date holds +-8.64e15 ms absolute, so start + duration must stay valid for any start; '100000000d' is now rejected. Reversible: yes.
