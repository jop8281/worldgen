# eval-linear-csv (YOS-95)

- Snapshot is the Linear MCP `list_issues` for team YOS, 123 rows, frozen in the repo (from the parked branch claude/yos-95, which agreed row for row with codex draft #155). The team has since grown past 143 issues. Why: a reproducible eval input with no runtime Linear call. Reversible: yes, regenerate and update the row count.
- No Assignee column and no descriptions. The only assignee was one person, so the column held one value and no signal. Descriptions carry no T1 signal and may hold names or links. Why: no names, emails or secrets in the file. Reversible: yes.
- No Estimate column. All 143 issues in the team have a null estimate, so a column would be empty. The job listed estimate; the data has none. Reversible: yes, add it when the team uses estimates.
- Milestone is the project milestone name. Completed is completedAt, falling back to canceledAt for canceled and duplicate rows. Labels are joined with `; ` in one cell. Parent is the parent identifier, and every parent is inside the snapshot.
- Status categories: Backlog backlog, In Progress and In Review started, Done completed, Duplicate and Canceled canceled. No Status maps to unstarted here. The hand labels are in `linear-backlog.labels.csv`.
