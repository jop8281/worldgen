# YOS-226 live check: the gym prompt at the A-48 limits

One create on the YOS-100 rehearsal's unseen 01-gym prompt, on `dispatch/yos226-reserve` (A-330 on top of stabilize b2b980f9), at $5 and 15 minutes, through `claude -p` with `claude-sonnet-5-5`:

```sh
bun run worldgen "Something like Mindbody for a gym: members, classes and bookings. Agents sign people up and handle cancellations." --out <scratch>/gen-gym-1
```

| step | attempts | ms | $ |
| -- | -- | -- | -- |
| plan (medium) | 1 accepted | 76,475 | 0.341 |
| model (high) | 1 accepted | 21,983 | 0.315 |
| workflow (medium) | 1 accepted | 49,552 | 0.407 |
| seed (medium) | 1 accepted | 65,209 | 0.376 |
| tasks (high) | 1 accepted | 220,060 | 0.636 |

Done in 434.0 s for $2.075, with 3 verified tasks: `gym-1/REPORT.md`, `gym-1/capsule.json`, `gym-1/events.jsonl`. The rehearsal run on the same prompt stopped at 12.4 minutes.

The run made no backtrack, so it does not exercise A-330. It finished with 466 s left, where even the old tasks reserve would leave a seed repair 246 s. The backtrack path is proven by the call-for-call replay of the rehearsal run in `code/test/worldgen.test.ts`.
