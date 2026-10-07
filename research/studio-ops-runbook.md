# Studio operations runbook

How to run WorldGen Studio as a container on one machine, keep its data, and prove a deploy works. This covers YOS-192 up to the sign-in line: everything stays on 127.0.0.1 until YOS-187 adds sign-in, because the studio starts paid worldgen runs and has no login.

Everything here uses two scripts, `scripts/studio-deploy.sh` (A-313) and `scripts/studio-qualify.sh` (A-314). They need Docker, curl, jq and unzip.

## Deploy

| Task | Command | Result |
|---|---|---|
| Start or upgrade | `scripts/studio-deploy.sh up` | Builds `worldgen-studio:<sha>` from this checkout, replaces the container, waits for the healthcheck, prints `studio <sha> healthy on http://127.0.0.1:8787`. About 10 s with a warm cache. |
| Stop | `scripts/studio-deploy.sh down` | Removes the container. The volumes stay, so the next `up` keeps every world, run and ledger line. |
| Health | `scripts/studio-deploy.sh health` | `{"ok":true,"build":"<sha>","runtime":"bun 1.4.2","worlds":25}`. The build is the sha the image was built from. |
| Logs | `scripts/studio-deploy.sh logs 200` | The last 200 container log lines. |

`STUDIO_PORT` picks the host port (always bound to 127.0.0.1). The container restarts on failure (`--restart unless-stopped`).

Data lives in two named volumes:

- `worldgen-studio-worlds` at `/app/prod/worlds`: every world, generated ones included, with their `runs/` evidence and `REPORT.md`. A new volume starts as a copy of the worlds shipped in the image.
- `worldgen-studio-ledger` at `/home/bun/.worldgen`: the spend ledger.

Both belong to the image's `bun` user (A-315). `up` re-applies that ownership each time, so a volume made by an older image still works.

## Back up and restore

```sh
scripts/studio-deploy.sh backup ~/backups/studio-$(date +%F).tgz   # both volumes, about 3 MB today
scripts/studio-deploy.sh down
scripts/studio-deploy.sh restore ~/backups/studio-2026-10-07.tgz    # replaces both volumes' contents
scripts/studio-deploy.sh up
```

Restore refuses to run while the container is up, so nothing writes during the swap. To rehearse without touching the live volumes, point the scripts at scratch ones:

```sh
STUDIO_VOLUME_PREFIX=drill STUDIO_PORT=18793 STUDIO_CONTAINER=studio-drill scripts/studio-deploy.sh restore <backup.tgz>
STUDIO_VOLUME_PREFIX=drill STUDIO_PORT=18793 STUDIO_CONTAINER=studio-drill scripts/studio-deploy.sh up
scripts/studio-qualify.sh http://127.0.0.1:18793
STUDIO_VOLUME_PREFIX=drill STUDIO_CONTAINER=studio-drill scripts/studio-deploy.sh down && docker volume rm drill-worlds drill-ledger
```

**Drill on 2026-10-07 (stabilize 6dba03de).** A marker run (`gen-drill-marker/runs/r1/events.jsonl`) and a ledger file were written into the live volumes, then backed up (2.8 MB, both visible in the archive). They were restored into scratch volumes, and a second container came up healthy on port 18793. The marker run and ledger file were present and owned by `bun`, the volume was writable, `/api/runs` listed the marker, and qualify passed. The scratch volumes and the marker were then removed. The first drill attempt found that the worlds volume was root-owned and unwritable, which A-315 fixes.

## Qualify a deploy

```sh
scripts/studio-qualify.sh                                   # health and an export of helpdesk that unzips with no runs/
scripts/studio-qualify.sh http://127.0.0.1:8787 --generate 2    # also one live description run, at most $2, then its export
```

It prints one PASS line per check and exits 1 on the first failure.

**Qualify on 2026-10-07.** Against the container: health and export passed. Against a loopback studio with `--generate 2`: health, export and the start passed, then the generation **stopped no_progress at $0.75**. Plan, model, workflow and seed were accepted. The tasks step failed twice with `task.pressure_unmet`: the hard task's reference never reaches a row past the first page of `bookmark_tag`, and no filtered bookmark list in the reference returns a row it leaves unchanged. The script failed as it should. The stop is a WorldGen quality issue for that prompt, not a Studio one; a passing live run through the same Studio code is #521 (petstore /store, done, $1.57).

**Generation inside the container uses the Anthropic SDK** (A-326). The image has no claude CLI and no login, so it sets `WORLDGEN_TRANSPORT=sdk`, and Studio passes `--transport sdk` to every worldgen run. The key comes only at run time, never from the image or git:

```sh
export LLM_KEY=...                                   # in your shell; studio-deploy forwards it by name (-e LLM_KEY)
scripts/studio-deploy.sh up
# or keep it in a file outside the repository:
STUDIO_ENV_FILE=~/.config/worldgen/studio.env scripts/studio-deploy.sh up    # a path inside the repo is refused
```

Without a key, a generation fails at once with no spend, and the page says why: "the worldgen process exited 2 before it logged run_finished: --transport sdk needs LLM_KEY set in the environment" (A-327). The live in-container generation is still to do: no LLM_KEY was available to the operator session on 2026-10-07, so running it is a user action. Export the key, run `up`, then `scripts/studio-qualify.sh --generate 2`.

## Not covered yet (YOS-192)

Sign-in and public exposure (YOS-187), TLS and a domain, staging and production config separation, migrations and rollback beyond restoring a backup, metrics and alerts, and a live in-container generation (needs an LLM_KEY).
