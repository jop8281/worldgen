# Factory ledger mirror

This is a copy of the factory coordinator's ledger. The coordinator's scratchpad stays the source of truth while the driver runs, so this copy can lag.

- `FACTORY.md` is the recipe each unit follows. `preferences.md` holds the standing orders every builder gets.
- `user-decisions.md` holds the user's decisions U-1 to U-11, recorded as rows A-46 to A-56 in [../decisions.md](../../decisions.md). `factory-decisions.json` holds the coordinator's own operating calls.
- `backlog.json` holds every work order (Linear YOS-n) with its scope, acceptance and verify commands.
