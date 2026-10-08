# Rollback drill, 2026-10-08 (YOS-236)

worldgen-a7 ran this for the master, worldgen-f8 (job J48b). The drill ran the deployed Studio image N, took a backup, moved to a different image N+1 on the same volumes, then returned to N with `restore` and `rollback`. It ran on one shared Mac, with Docker 29.8.2 and an 8 GB VM.

It used scratch names only: container `worldgen-studio-drill`, volumes `drill-a7-*`, image repository `worldgen-studio-drill` (`STUDIO_IMAGE`), port `127.0.0.1:8797` and a random scratch `WORLDGEN_STUDIO_TOKEN`. There was no `LLM_KEY`, no paid call, no Boat and no public port. The other Studio on this machine (`worldgen-studio` on :8787) was not touched, and it stayed up and healthy throughout.

## Images

| | Image | Build sha | Image id |
|---|---|---|---|
| N | `worldgen-studio-drill:a6ff03b8…` (this branch) | `a6ff03b87700f465b0c631fa352f2a4cfb04304a` | `sha256:3b8971b9972f5aaa085349dce2e5e9cc356ee506e4a94a78fea1b3db7359ff31` |
| N+1 | `worldgen-studio:564b5377…`, tagged into the drill repository | `564b5377477f3650899fc88625d7dbdc0da4b9b6` (old-repository PR #524) | `sha256:32027ba3ec6d80476f2e3589c2add6841eff375409bc982637cd675997b39305` |

The job allowed one image build plus one rebuild, so N+1 is the image already deployed on this machine, and it is older than N. The move is to a different image and sha. It proves the container swap, the backup and the restore, and that the data survives both moves. It does not test an upgrade path.

## Timings and memory

| Step | Command | Wall time |
|---|---|---|
| Build and deploy N | `nice -n 15 scripts/studio-deploy.sh up` | 4.7 s (most layers came from the build cache) |
| Back up | `scripts/studio-deploy.sh backup backup.tgz` | 0.5 s (3.2 MB) |
| Forward to N+1 | `scripts/studio-deploy.sh rollback 564b5377…` | 3.7 s |
| Back to N: down | `scripts/studio-deploy.sh down` | 0.2 s |
| Back to N: restore | `scripts/studio-deploy.sh restore backup.tgz` | 0.4 s |
| Back to N: start | `scripts/studio-deploy.sh rollback a6ff03b8…` | 3.5 s |

The whole rollback (down, restore, start) took 4.1 s. The Docker VM process (`com.apple.Virtualization.VirtualMachine`) had a resident size of 3.74 GB before the build and **3.89 GB at its peak**. It was sampled every 2 s, which gave 3 samples. The first build, `b54012f3` at 7.7 s, could not record a job (finding 1). It was fixed and rebuilt once. Its memory samples were not kept.

## Results

| Check | Result |
|---|---|
| N healthy, `/api/health` build | `a6ff03b8…`, 25 worlds (health-1-N.json) |
| A job is recorded on N | `20261008T042100Z-noop-6af049`, kind episode, in `.studio-runs.json`. It finished with exit 1 (finding 2, job-N.json) |
| Backup | 196 files, all in the worlds volume. The ledger volume was empty, because no call was paid for |
| N+1 healthy, build | `564b5377…`, 25 worlds (health-2-N1.json) |
| The job record is on N+1's volumes | yes |
| After `down` and `restore`, every file in both volumes | the sha256 the backup had: manifest-A.txt equals manifest-B.txt (196 files) |
| N healthy again, build | `a6ff03b8…` (health-3-N.json) |
| N's API lists the job after the rollback | yes |

## Findings

1. **Fixed here.** The Studio image has no git, so every `POST /api/episodes` in the container answered 500. The engine commit now falls back to the build sha (`WORLDGEN_BUILD_SHA`).
2. **Not fixed: it needs another build.** The `bun` user cannot create `/app/eval`, so in the container an episode's child fails with `EACCES: permission denied, mkdir '/app/eval'`. The job's record survives, but the episode's export does not. The episode directory is not on a volume, so exports would not survive a container swap anyway. The fix is to create `/app/eval/episodes` owned by `bun` in `Dockerfile.studio`, and to mount it as a third volume that `backup` and `restore` include.

## The drill script

The script that ran, with its scratch path elided. `drill.log` is its output. The token was generated in the script, reached curl only through a mode-600 header file, and was deleted at the end.

```bash
#!/bin/bash
# YOS-236 rollback drill. Scratch names only; never touches the worldgen-studio container on :8787.
set -euo pipefail
S=<scratch>
OUT=$S/drill; rm -rf "$OUT"; mkdir -p "$OUT"
cd /Users/yossieliaz/wt/yos236-drill
export STUDIO_IMAGE=worldgen-studio-drill STUDIO_CONTAINER=worldgen-studio-drill STUDIO_PORT=8797 STUDIO_VOLUME_PREFIX=drill-a7
unset LLM_KEY 2>/dev/null || true
export WORLDGEN_STUDIO_TOKEN="$(openssl rand -hex 24)"
( umask 077; printf 'authorization: Bearer %s\n' "$WORLDGEN_STUDIO_TOKEN" > "$OUT/auth" )
URL=http://127.0.0.1:8797
OLD=564b5377477f3650899fc88625d7dbdc0da4b9b6
D=scripts/studio-deploy.sh
N=$(git rev-parse HEAD)
VMPID=$(pgrep -f com.apple.Virtualization.VirtualMachine | head -1)
log() { echo "[$(date -u +%H:%M:%S)Z] $*"; }
now() { python3 -c 'import time; print(time.time())'; }
timed() { local t0; t0=$(now); "$@"; python3 -c "import sys; print('   took %.1f s' % ($(now) - $t0))"; }
manifest() { docker run --rm --entrypoint sh -v drill-a7-worlds:/v/worlds:ro -v drill-a7-ledger:/v/ledger:ro "$1" -c 'cd /v && find . -type f | sort | xargs sha256sum'; }
runstore_has() { docker run --rm --entrypoint sh -v drill-a7-worlds:/w:ro "$1" -c 'cat /w/.studio-runs.json' | grep -c "\"$2\"" || true; }

log "N=$N  N+1(old)=$OLD  vm pid=$VMPID"
log "1. build and deploy N (one build, nice)"
( while :; do ps -o rss= -p "$VMPID" >> "$OUT/vm-rss-kb.txt" 2>/dev/null; sleep 2; done ) & SAMPLER=$!
timed nice -n 15 bash $D up
kill $SAMPLER 2>/dev/null || true
log "   N image $(docker image inspect $STUDIO_IMAGE:$N --format '{{.Id}}')"
curl -fsS $URL/api/health | tee "$OUT/health-1-N.json"; echo

log "2. record a job on N: one free noop episode"
curl -fsS -H @"$OUT/auth" -H 'content-type: application/json' -X POST $URL/api/episodes \
  -d '{"world":"helpdesk","task":"assign_newest_acme_ticket","agent":"noop","budgetUsd":0.01,"maxTurns":3}' > "$OUT/job-start.json"
RUN=$(python3 -c "import json;print(json.load(open('$OUT/job-start.json'))['runId'])")
log "   job $RUN"
for _ in $(seq 1 120); do
  curl -fsS -H @"$OUT/auth" "$URL/api/episodes/$RUN" > "$OUT/job-N.json"
  python3 -c "import json,sys; sys.exit(0 if json.load(open('$OUT/job-N.json')).get('running') is False else 1)" && break
  sleep 1
done
python3 -c "import json; d=json.load(open('$OUT/job-N.json')); e=d.get('episode') or {}; print('   exit', d.get('exitCode'), 'stop', e.get('stop_reason'), 'score', e.get('score'), 'model', e.get('model'), 'engine', e.get('engine_commit'))"
log "   runstore records it: $(runstore_has $STUDIO_IMAGE:$N $RUN) line(s)"

log "3. back up N's volumes"
timed bash $D backup "$OUT/backup.tgz"
manifest $STUDIO_IMAGE:$N > "$OUT/manifest-A.txt"; log "   manifest A: $(wc -l < "$OUT/manifest-A.txt") files, $(shasum -a 256 "$OUT/manifest-A.txt" | cut -c1-16)"

log "4. forward to N+1 = existing image $OLD (tagged into the drill repo, no build)"
docker tag worldgen-studio:$OLD $STUDIO_IMAGE:$OLD
timed bash $D rollback $OLD
log "   N+1 image $(docker image inspect $STUDIO_IMAGE:$OLD --format '{{.Id}}')"
curl -fsS $URL/api/health | tee "$OUT/health-2-N1.json"; echo
log "   runstore still records the job on N+1's volumes: $(runstore_has $STUDIO_IMAGE:$N $RUN) line(s)"

log "5. roll back to N: down, restore, rollback N"
timed bash $D down
timed bash $D restore "$OUT/backup.tgz"
manifest $STUDIO_IMAGE:$N > "$OUT/manifest-B.txt"; log "   manifest B: $(wc -l < "$OUT/manifest-B.txt") files, $(shasum -a 256 "$OUT/manifest-B.txt" | cut -c1-16)"
if diff -q "$OUT/manifest-A.txt" "$OUT/manifest-B.txt" >/dev/null; then log "   manifest A == manifest B: every file has the backup's sha256"; else log "   MANIFEST DIFFERS"; diff "$OUT/manifest-A.txt" "$OUT/manifest-B.txt" | head; fi
timed bash $D rollback $N
curl -fsS $URL/api/health | tee "$OUT/health-3-N.json"; echo
curl -fsS -H @"$OUT/auth" "$URL/api/episodes" > "$OUT/episodes-after.json"
log "   N lists the job after rollback: $(python3 -c "import json; print([e.get('stop') for e in json.load(open('$OUT/episodes-after.json'))['episodes'] if e.get('runId')=='$RUN'])")"

log "6. clean up scratch: container, volumes, drill tags"
bash $D down
docker volume rm drill-a7-worlds drill-a7-ledger >/dev/null
docker rmi $STUDIO_IMAGE:$OLD >/dev/null
log "   vm rss samples (KB): $(sort -n "$OUT/vm-rss-kb.txt" | head -1) min, $(sort -n "$OUT/vm-rss-kb.txt" | tail -1) max, $(wc -l < "$OUT/vm-rss-kb.txt") samples"
rm -f "$OUT/auth"
log "done"
```
