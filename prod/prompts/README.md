# Prompts

The hiring team's prompts for the live run go here, one file per prompt, exactly as received. Nothing in this folder is edited, tuned or reformatted. `bun run live ../prod/prompts` runs WorldGen on each one and writes [../LIVE-RUN.md](../LIVE-RUN.md). The day's checklist is [research/live-run-runbook.md](../../research/live-run-runbook.md).

## File names

`NN` is the order received, with at least two digits. The slug is lowercase kebab-case and names the software, such as `03-dental-clinic`. A prompt's world lands in `prod/worlds/gen-<slug>/`.

| Input | Files | WorldGen is run as |
|---|---|---|
| A description | `<NN>-<slug>.txt`, the text as sent | `bun run worldgen "<text>"` |
| An OpenAPI spec | `<NN>-<slug>.openapi.yaml` (or `.yml`, `.json`), and an optional `<NN>-<slug>.args` holding flags such as `--only /v1/refunds` | `bun run worldgen --openapi <file> <args>` |
| CSV files | a folder `<NN>-<slug>/` with every CSV as sent | `bun run worldgen --csv <files>` |
| A change request on that prompt's world | `<NN>-<slug>.change.txt`, next to the prompt it changes | `iterate` on the world the first run saved |
| A clarification from the team | `<NN>-<slug>.v2.txt`, a new description. The original stays, and both are run | a second run into `prod/worlds/gen-<slug>-v2/` |

README.md and dotfiles are ignored. Any other file is an intake problem: `bun run live` lists it and runs nothing until it is fixed.

## Rules

- Commit the intake before running anything, so the history shows that nothing was tuned to the prompts: `git add ../prod/prompts && git commit -m "Intake: hiring-team prompts as received"`.
- Never edit a prompt. If it is ambiguous, WorldGen makes a call and writes it down in the world's `plan.yaml` and `REPORT.md`.
- An input with a real credential is not committed. Ask the team for a scrubbed copy. WorldGen also redacts secrets from what the model sees.
- Check the intake without a model call: `bun run live ../prod/prompts --dry-run`.
