---
name: drawbar-learn
description: Curate durable lessons from the current session's work into the knowledge base. Runs standalone or as the tail of /drawbar-work.
argument-hint: "[issue-id for attribution]"
---

# drawbar learn

Distill what was learned into durable, queryable knowledge.

## Preflight

```bash
command -v drawbar-kb >/dev/null 2>&1 || { echo "drawbar-kb not found — run /drawbar-setup"; exit 1; }
KB=$(drawbar-kb path) || { echo "drawbar context unresolvable — run /drawbar-setup"; exit 1; }
[ -d "$KB" ] || { echo "no knowledge base at $KB — run /drawbar-setup"; exit 1; }
```

`drawbar-kb path` resolves the store from the main worktree root, so lessons learned in a linked worktree land in the repository's one store. Use `$KB`, never `$PWD/.drawbar/memory`.

## 1. Review the session

Look over the session's diffs, decisions, and dead-ends. If `$ARGUMENTS` is a Linear issue id, load it (`get_issue`) for attribution and context.

## 2. Extract entries

Pull out durable lessons — not transient narration. Use the right type:
- `learned` — a lesson or gotcha. For a mistake to guard against in future, begin the content with `MUST-CHECK:`.
- `decision` — a choice made and why.
- `pattern` — a reusable approach.
- `fact` — a stable constraint about the system.
- `investigation` — what a dig turned up.
- `deviation` — where you departed from the plan and why.

## 3. Write each entry (safe, deduped)

Pipe a JSON object on stdin per entry (content is never shell-interpolated):

```bash
echo '{"key":"<kebab-key>","type":"<type>","content":"<lesson>","source":"agent","tags":["..."],"issue":"<issue-id or empty>","files":["<path>"]}' \
  | drawbar-kb add --dir "$KB"
```

`drawbar-kb add` validates and **upserts** by key — one entry per key, so a correction always wins over what it corrects. Re-adding an unchanged entry is a no-op (`{"written":false,"superseded":false,...}`). Changing any field under an existing key replaces that key's line in place and archives the old copy (`{"written":true,"superseded":true,...}`).

## 4. Report

List the entries written (key + type) and the new `drawbar-kb stats` totals.
