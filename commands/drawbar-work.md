---
name: drawbar-work
description: Implement the next Todo story under a Linear parent issue, test-first, with a code review and fix loop, capturing lessons as you go.
argument-hint: "<PCO-id of the parent issue>"
---

# drawbar work

Implement the next ready story sequentially, following TDD.

## Preflight

```bash
command -v drawbar-kb >/dev/null 2>&1 || { echo "drawbar-kb not found — run /drawbar-setup"; exit 1; }
[ -d "$PWD/.drawbar/memory" ] || { echo "no .drawbar/memory — run /drawbar-setup"; exit 1; }
```

## 1. Pick the next story

`$ARGUMENTS` is the parent issue id. List its sub-issues with the Linear MCP `list_issues` (`parentId` = parent). Take the first story in dependency order whose status is `Todo`. If none are `Todo`, report that all stories are done or in progress and stop.

## 2. Recall + read comments

```bash
drawbar-kb recall "<story title and files>" --dir "$PWD/.drawbar/memory" --json
```

Also read any new comments on the story (`list_comments`) — the user may have left direction. Honor every Locked decision and `MUST-CHECK:` that applies.

## 3. Implement, test-first

Move the story to `In Progress` (`save_issue`). Then follow TDD: write a failing test for the next behavior, run it (RED), implement the minimal code, run it (GREEN), repeat. Run the project's full test suite before considering the story done.

## 4. Review and fix loop

Dispatch the `code-reviewer` agent with the story's diff and its acceptance criteria. Fix every Critical/Important finding it returns, then re-review until clean.

## 5. Capture lessons (inline)

As you hit anything worth remembering (a gotcha, a pattern, a decision, or a mistake), write it to the KB. Pipe a JSON object on stdin (never shell-interpolate content):

```bash
echo '{"key":"<kebab-key>","type":"<learned|decision|pattern|fact|investigation|deviation>","content":"<the lesson>","source":"agent","tags":["..."],"issue":"<PCO-id>","files":["<path>"]}' \
  | drawbar-kb add --dir "$PWD/.drawbar/memory"
```

For a mistake to guard against in future, use type `learned` with content beginning `MUST-CHECK:`.

## 6. Close out

Commit referencing the story id (e.g. `feat: … (PCO-123)`). Post a short summary comment on the story (`save_comment`) and move it to `Done` (`save_issue`).

If the Linear MCP is unavailable, do the implementation and KB capture locally, skip the Linear status/comment updates, and tell the user.

## 7. Report

Print the story id, what shipped, and which stories remain `Todo`. Re-run `/drawbar-work <PCO-id>` for the next one.
