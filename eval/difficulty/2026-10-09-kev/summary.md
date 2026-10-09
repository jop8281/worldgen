# Kev as a difficulty predictor, 2026-10-09 (J182, A-407)

**Question:** can Kev, zero-shot, predict whether Claude Haiku 5.5 passes a WorldGen task, from the task instruction and a one-line world summary alone?

**Answer: no, not well enough to use.** Kev-0.8B never beats the trivial baseline on Brier score or accuracy. It does rank the failing tasks somewhat below the passing ones, but the evidence for that rests on 6 failing tasks.

## Setup

- **Labels:** the J175 sweep (`eval/dataset/2026-10-09-sweep/`), three Haiku passes p1–p3 over all 95 tasks of the 25 prod worlds. That's 284 graded episodes, of which 267 succeeded; infra episodes are left out. The class balance is extreme: 89 tasks always pass, and 6 fail at least once.
- **What Kev sees:** per task, the world's `meta.description` and the task's difficulty and instruction. Nothing hidden: no grader, no solution, no world file.
- **Question:** "An AI agent (Claude Haiku 5.5) gets only this world's public HTTP API and this task. Will it complete the task fully and correctly?"
  - `noul`: Kev's calibrated yes probability.
  - `choice`: pass against fail.
- **Split:** deterministic, `sha256(world/task) % 10 < 3` is held out. That gives 23 held-out tasks (69 episodes, 3 failing tasks) and 72 train tasks.
- **Baselines:** Kev is zero-shot, so the train split only sets the baselines.
  - The majority class ("pass"), for accuracy and Brier at p ∈ {0, 1}.
  - The train episode pass rate as a constant p (0.963), for Brier.
- **Metrics:**
  - Brier is computed per episode: Kev's task-level P(pass) against each graded episode.
  - Accuracy is computed per task: p ≥ 0.5 against the task's majority outcome.
  - AUC is the chance that Kev gives a passing task a higher p than a failing one; 0.5 is chance.
- **Endpoints:**
  - Kev-0.8B on one token-gated Boat VM, which d3 brought up and took down at 16:17Z.
  - Kev-4B on local loopback, for comparison.
- **Cost:** $0 model spend, plus about 30 minutes of one Boat VM.

## Results

| Model | Question | Split | Kev Brier | Base-rate Brier | Majority Brier | Kev accuracy | Majority accuracy | AUC | Beats baseline |
|---|---|---|--:|--:|--:|--:|--:|--:|---|
| Kev-0.8B | noul | held-out (23) | 0.177 | 0.122 | 0.130 | 0.78 | 0.87 | 0.80 | no |
| Kev-0.8B | noul | all 95 | 0.166 | 0.057 | 0.060 | 0.79 | 0.94 | 0.74 | no |
| Kev-0.8B | choice | held-out (23) | 0.182 | 0.122 | 0.130 | 0.70 | 0.87 | 0.80 | no |
| Kev-0.8B | choice | all 95 | 0.175 | 0.057 | 0.060 | 0.74 | 0.94 | 0.72 | no |
| Kev-4B local | choice | all 95 | 0.319 | 0.057 | 0.060 | 0.34 | 0.94 | 0.47 | no |

The tasks Haiku failed, with Kev-0.8B's P(pass):

| Task | Haiku | Split | noul | choice |
|---|---|---|--:|--:|
| gen-clinic-appointments/book_earliest_cardiology_slot | 0/3 | train | 0.44 | 0.44 |
| gen-hotel-booking/cancel_arriving_tomorrow_with_fee | 0/3 | held | 0.44 | 0.39 |
| gen-rental-fleet/triage_small_claims | 0/3 | held | 0.50 | 0.48 |
| gen-clinic-appointments/record_yesterdays_no_shows | 0/3 | held | 0.56 | 0.52 |
| gen-clinic-appointments/clear_dr_patel_calendar_for_leave | 0/3 | train | 0.61 | 0.61 |
| gen-warehouse-inventory/restock_pick_bins | 1/3 | train | 0.63 | 0.66 |

Kev's `noul` probabilities run from 0.39 to 0.87, with a median of 0.63. It gives 16 of the 89 always-passing tasks a P(pass) below 0.5.

## Reading

- **Calibration:** Kev is too pessimistic for this distribution. Haiku passes 94% of episodes, while Kev's median P(pass) is 0.63, so a constant 0.963 beats it on Brier by roughly 3×.
- **Ranking:** Kev puts 4 of the 6 failing tasks in the bottom third (AUC 0.74 to 0.80). But 6 positives give a wide interval, and the held-out AUC rests on 3 tasks. It isn't a usable "hard task" filter on this evidence.
- **Size:** Kev-0.8B does much better than local Kev-4B with the same prompt. The 4B model answered "fail" for most tasks, at chance ranking.
- **No wiring:** per A-407, Kev is not wired into the tasks stage, since it doesn't beat the baseline. Kev never grades.
- **What would change this:** a set with more failing tasks, for instance the stress worlds or harder generated tasks, so AUC can be measured with a usable interval. Or few-shot prompts that state the base rate. Both are listed as next work, not done here.

<details><summary>kev_eval.py (stdlib Python, run as <code>KEV_QUESTION=noul python3 -I kev_eval.py episodes.jsonl &lt;repo&gt; out.json &lt;endpoint&gt; &lt;token-file&gt;</code>)</summary>

```python
"""J182 (A-407): Kev zero-shot as a predictor of "will Haiku 5.5 pass this task?".

usage: python3 -I kev_eval.py <labels.jsonl> <repo-root> <out.json> [endpoint] [token]

labels.jsonl: one row per task with a world, a task id and a pass label (field names are matched loosely below).
Each task's state is its world's meta.description plus the task's difficulty and instruction, read from
<repo-root>/prod/worlds/<world>/world.yaml. The split is deterministic: sha256("world/task") % 10 < 3 is held out.
Kev is zero-shot, so the train split only sets the baselines: the majority class (accuracy, and Brier at p in {0, 1})
and the train pass rate (Brier at a constant p). Kev never grades.
"""
import hashlib, json, sys, time, urllib.request
from pathlib import Path

QUESTION_TEXT = "An AI agent (Claude Haiku 5.5) gets only this world's public HTTP API and this task. Will it complete the task fully and correctly?"
QUESTIONS = {
    "choice": {"q": {"type": "choice", "instructions": QUESTION_TEXT, "criteria": {"pass": "It completes the task fully and correctly", "fail": "It fails or completes it only partly"}}},
    "noul": {"q": {"type": "noul", "instructions": QUESTION_TEXT}},
}
KIND = __import__("os").environ.get("KEV_QUESTION", "choice")


def field(row, *names):
    for n in names:
        if n in row and row[n] is not None:
            return row[n]
    return None


def label_of(row):
    v = field(row, "passed", "pass", "label", "solved", "success", "score")
    if isinstance(v, str):
        return v.lower() in ("pass", "passed", "true", "1", "yes", "solved")
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)):
        return v >= 1
    raise ValueError(f"no pass label in {row}")


def yaml_tasks(world_yaml):
    """The task instructions, difficulties and meta.description of a world.yaml, without a YAML library (-I, stdlib only)."""
    text = world_yaml.read_text()
    desc = ""
    tasks, cur, section = {}, None, None
    for line in text.split("\n"):
        if line.startswith("  description:") and section == "meta":
            desc = line.split(":", 1)[1].strip()
        if line and not line.startswith(" "):
            section = line.rstrip(":")
            cur = None
            continue
        if section == "tasks":
            if line.startswith("  ") and not line.startswith("   ") and line.rstrip().endswith(":"):
                cur = line.strip().rstrip(":")
                tasks[cur] = {}
            elif cur and line.startswith("    instruction:"):
                tasks[cur]["instruction"] = line.split(":", 1)[1].strip().strip("'\"")
            elif cur and line.startswith("    difficulty:"):
                tasks[cur]["difficulty"] = line.split(":", 1)[1].strip()
    return desc, tasks


def ask(endpoint, token, state):
    headers = {"content-type": "application/json"}
    if token:
        headers["authorization"] = f"Bearer {token}"
    body = json.dumps({"state": state, "model": "kev-latest", "questions": QUESTIONS[KIND]}).encode()
    with urllib.request.urlopen(urllib.request.Request(endpoint, body, headers), timeout=300) as r:
        a = json.load(r)["answers"]["q"]
    return a["noul"] if KIND == "noul" else a["probabilities"]["pass"]


def brier(ps, ys):
    return sum((p - y) ** 2 for p, y in zip(ps, ys)) / len(ys)


def metrics(tasks, rate, majority):
    """Episode-level Brier (P(pass) against each graded episode) and task-level accuracy (each task's majority outcome)."""
    eps = [(t["p"], y) for t in tasks for y in t["ys"]]
    ys_ep = [y for _, y in eps]
    major = [1 if sum(t["ys"]) / len(t["ys"]) >= 0.5 else 0 for t in tasks]
    return {
        "tasks": len(tasks), "episodes": len(eps), "failing_tasks": major.count(0), "episode_pass_rate": round(sum(ys_ep) / len(ys_ep), 4),
        "kev": {"brier": round(brier([p for p, _ in eps], ys_ep), 4), "accuracy": round(sum((t["p"] >= 0.5) == bool(m) for t, m in zip(tasks, major)) / len(tasks), 4)},
        "majority": {"class": "pass" if majority else "fail", "brier": round(brier([majority] * len(ys_ep), ys_ep), 4), "accuracy": round(sum(m == majority for m in major) / len(tasks), 4)},
        "base_rate": {"p": round(rate, 4), "brier": round(brier([rate] * len(ys_ep), ys_ep), 4)},
        "kev_ranks_failures": auc([t["p"] for t in tasks], major),
    }


def auc(ps, labels):
    """P(Kev gives a passing task a higher p than a failing one): 0.5 is chance. None when one class is empty."""
    pos = [p for p, l in zip(ps, labels) if l]
    neg = [p for p, l in zip(ps, labels) if not l]
    if not pos or not neg:
        return None
    return round(sum((a > b) + 0.5 * (a == b) for a in pos for b in neg) / (len(pos) * len(neg)), 4)


def main():
    labels, root, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    endpoint = sys.argv[4] if len(sys.argv) > 4 else "http://127.0.0.1:8009/v1/systemone"
    token_file = sys.argv[5] if len(sys.argv) > 5 else ""
    token = Path(token_file).read_text().strip() if token_file else ""
    rows = [json.loads(l) for l in labels.read_text().splitlines() if l.strip()]
    worlds, tasks = {}, {}
    for r in rows:
        w, t = Path(str(field(r, "world", "world_id"))).name, field(r, "task", "task_id")
        tasks.setdefault((w, t), []).append(1 if label_of(r) else 0)
    items = []
    for (w, t), ys in sorted(tasks.items()):
        if w not in worlds:
            worlds[w] = yaml_tasks(root / "prod" / "worlds" / w / "world.yaml")
        desc, tk = worlds[w][0], worlds[w][1].get(t, {})
        state = f"World: {desc}\nTask ({tk.get('difficulty', '?')}): {tk.get('instruction', '?')}"
        held = int(hashlib.sha256(f"{w}/{t}".encode()).hexdigest(), 16) % 10 < 3
        items.append({"world": w, "task": t, "ys": ys, "held": held, "state": state})
    t0 = time.time()
    for it in items:
        it["p"] = ask(endpoint, token, it["state"])
    train = [i for i in items if not i["held"]]
    train_eps = [y for i in train for y in i["ys"]]
    rate = sum(train_eps) / len(train_eps)
    majority = 1 if rate >= 0.5 else 0
    res = {"endpoint": endpoint.split("//")[-1].split("/")[0].split(".")[0][:12] + "…", "question": KIND, "seconds": round(time.time() - t0, 1), "train_tasks": len(train), "train_episode_pass_rate": round(rate, 4),
           "held_out": metrics([i for i in items if i["held"]], rate, majority), "all_tasks": metrics(items, rate, majority),
           "rows": [{k: i[k] for k in ("world", "task", "ys", "held", "p")} for i in items]}
    for k in ("held_out", "all_tasks"):
        m = res[k]
        m["beats_baseline"] = m["kev"]["brier"] < m["base_rate"]["brier"] and m["kev"]["accuracy"] > m["majority"]["accuracy"]
    out.write_text(json.dumps(res, indent=2))
    print(json.dumps({k: v for k, v in res.items() if k != "rows"}, indent=2))


if __name__ == "__main__":
    main()
```

</details>
