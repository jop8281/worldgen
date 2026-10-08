# Rollback drill 2, 2026-10-08 (YOS-236): episode exports survive

This is the same drill as [rollback-drill](../2026-10-08-rollback-drill/README.md), shortened. It ran after fixing container bug 2: the `bun` user could not create `/app/eval`, so every playground episode in the container failed. The image now creates `/app/eval/episodes` owned by `bun`. `scripts/studio-deploy.sh` mounts it as a third volume, `<prefix>-episodes`, and `backup` and `restore` include it.

The rules were the same as the first drill:
- one approved image build, under `nice`;
- scratch container `worldgen-studio-drill`, volumes `drill-a7-*`, `127.0.0.1:8797` and a random scratch token;
- no `LLM_KEY`, no paid call, no Boat;
- every drill image and volume removed afterwards.

The other Studio on this machine (`worldgen-studio` on :8787) was not touched.

## Images

| | Build sha | Image id |
|---|---|---|
| N (this branch) | `8a3a2d3e6a63f2772650d15208f7862609c81ee8` | `sha256:d58cc2eb521e951a4d186199f55924471dc6f86d4677a5cd2eb53210f6937973` |
| N+1 (the image already deployed here, older than N) | `564b5377477f3650899fc88625d7dbdc0da4b9b6` | `sha256:32027ba3ec6d80476f2e3589c2add6841eff375409bc982637cd675997b39305` |

## Results

| Step | Result | Wall time |
|---|---|---|
| Build and deploy N | healthy, `/api/health` build `8a3a2d3e…` | 5.4 s |
| A noop episode on N | `20261008T042720Z-noop-cbf63b`: exit 0, `done`, score 0, model null, engine `8a3a2d3e…` (the build sha) | about 9 s |
| Back up | 3.4 MB. 207 files, 11 of them the episode's export (`dataset.jsonl`, `manifest.json`, logs, private episode states, verifier record, frozen world) | 0.5 s |
| Forward to N+1 | healthy, build `564b5377…`, and the job record is still in `.studio-runs.json` | 3.7 s |
| Down, restore | every file in the three volumes has the backup's sha256: manifest-A.txt equals manifest-B.txt (207 files, the 11 episode files included) | 0.2 s + 0.5 s |
| Roll back to N | healthy, build `8a3a2d3e…`. N reads the export again: `done`, score 0 (job-after.json) | 3.8 s |

A full rollback (down, restore, start) took 4.5 s. The Docker VM process's resident size went from 3.61 GB to a **peak of 3.91 GB**, sampled every 2 s, which gave 3 samples during the build.

## What is still not covered

N+1 is older than N, as in the first drill, so this proves the swap, backup and restore across two real images, not an upgrade. The ledger volume stayed empty, because nothing was paid. The drill script is the first drill's, with the episodes volume added to the manifest, the cleanup and the after-rollback read. `drill.log` is its output.
