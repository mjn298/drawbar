---
name: drawbar-work
description: Implement a Linear story (a leaf issue, or the next Todo story under a parent) test-first, with an upstream-dependency gate, a code-review/fix loop, and inline knowledge capture. Opens a PR and leaves the story In Progress for review.
argument-hint: "<issue-id — a story, or a parent whose next Todo story to implement>"
---

# drawbar work

Implement one story, test-first. The agent takes a story from `Todo` to `In Progress`, implements it, opens a PR, and hands off — it never marks work Done or moves it through QA/rollout; humans own everything downstream of "code is up for review."

## Preflight

```bash
command -v drawbar-kb >/dev/null 2>&1 || { echo "drawbar-kb not found — run /drawbar-setup"; exit 1; }
[ -d "$PWD/.drawbar/memory" ] || { echo "no .drawbar/memory — run /drawbar-setup"; exit 1; }
```

## 1. Pick the story

`$ARGUMENTS` is a Linear issue id. Load it with the Linear MCP `get_issue`, then handle either shape:

- **It has sub-issues** → list them (`list_issues` with `parentId`) and take the next child in dependency order whose status is `Todo`. If none are `Todo`, report that all children are done or in progress and stop.
- **It has no sub-issues** → the issue *itself* is the story to implement.

This is the common case for a single ticket — a leaf story id is just as valid as a parent.

## 2. Recall + read comments

```bash
drawbar-kb recall "<story title and files>" --dir "$PWD/.drawbar/memory" --json
```

Also read any comments on the story (`list_comments`) — the user may have left direction. Honor every Locked decision and `MUST-CHECK:` that applies.

## 3. Verify prerequisites are landed (gate)

Before writing any code, confirm the story isn't building on an incomplete base:

- Identify prerequisite work named in the story description or in its Linear relations (blocked-by / "depends on", referenced issue ids, linked PRs).
- For each: verify it is **merged / Done** (`get_issue` for an issue id; `gh pr view <url> --json state,merged` for a PR link).
- **If any prerequisite is unmet, stop and report it** ("blocked by `<id/PR>` — not yet merged"). Do not implement against a base that doesn't exist yet — it produces code that won't compile or that silently builds on stale schema.

## 4. Implement, test-first

Move the story to `In Progress` (`save_issue`). Then work in red→green increments. **The RED run is mandatory and must be shown** — per behavior:

- [ ] **(a)** Write the failing test for the next behavior.
- [ ] **(b)** Run it and **paste the failing output** — confirm it fails for the expected reason (not a typo/import error).
- [ ] **(c)** Write the minimal code to pass.
- [ ] **(d)** Run it and **paste the passing output**.

Repeat until the story's acceptance criteria are met.

**Test scope — defer to the project, don't over-run.** Read the project's `CLAUDE.md` for its test-cost guidance. By default run only the **tests covering your change** (the targeted file or unit scope) plus **typecheck and lint**. Do not run the full suite locally unless the project says to — rely on pre-push hooks and CI for integration coverage.

## 5. Review and fix loop

Dispatch the `code-reviewer` agent with the story's diff and its acceptance criteria. Fix every Critical/Important finding it returns, then re-review until clean. (Keep this loop — it catches real issues before the PR.)

## 6. Capture lessons (inline)

As you hit anything worth remembering (a gotcha, a pattern, a decision, or a mistake), write it to the KB. Pipe a JSON object on stdin (never shell-interpolate content):

```bash
echo '{"key":"<kebab-key>","type":"<learned|decision|pattern|fact|investigation|deviation>","content":"<the lesson>","source":"agent","tags":["..."],"issue":"<issue-id>","files":["<path>"]}' \
  | drawbar-kb add --dir "$PWD/.drawbar/memory"
```

For a mistake to guard against in future, use type `learned` with content beginning `MUST-CHECK:`.

## 7. Close out — PR, leave In Progress

1. Commit referencing the story id (e.g. `feat: … (ABC-123)`), on a feature branch whose name includes the id so Linear auto-links the PR.
2. Push the branch and **open a PR** (`gh pr create`) — title/body referencing the issue id. **Do NOT merge it.** You are handing off for review.
3. **Leave the story `In Progress`.** An attached PR is the signal that it's in review — do not advance the status. **Never** set `Done`, `Ready for QA`, `Ready for Rollout`, `Rolled Out`, or any QA/rollout/completion status; those are owned by humans and QA downstream.
4. Post a short summary comment on the story (`save_comment`) with what shipped and the PR link.

If the Linear MCP is unavailable, do the implementation, KB capture, commit and PR locally; skip the Linear comment/status updates and tell the user.

## 8. Report

Print the story id, what shipped, the PR link, and — if you worked a child under a parent — which sibling stories remain `Todo`. Re-run `/drawbar-work <issue-id>` for the next one.
