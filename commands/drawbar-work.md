---
name: drawbar-work
description: Implement a Linear story (a leaf issue, or the next Todo story under a parent) test-first — the Opus lead delegates coding to a Sonnet agent, verifies completion, then runs a code+security review/fix loop with inline knowledge capture. Opens a PR and leaves the story In Progress for review.
argument-hint: "<issue-id — a story, or a parent whose next Todo story to implement>"
---

# drawbar work

Implement one story, test-first. The **Opus lead** orchestrates: it takes the story from `Todo` to `In Progress`, **delegates the coding to a Sonnet `story-implementer` agent**, verifies the work is complete and green, runs the review/fix loop, then opens a PR and hands off — it never marks work Done or moves it through QA/rollout; humans own everything downstream of "code is up for review." The lead verifies; it does not type the implementation.

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

## 4. Delegate implementation to a Sonnet agent

You are the lead (Opus): you orchestrate and verify, you do **not** type the implementation. Move the story to `In Progress` (`save_issue`), then dispatch the **`story-implementer`** agent (it runs on Sonnet) to build the story test-first:

```
Task(subagent_type="story-implementer", prompt="<brief>")
```

The brief must hand the agent everything it needs to work without you:

- The story's **description and acceptance criteria** (What / Decisions / Testing / Validation / Files).
- Every **Locked** decision and `MUST-CHECK:` recalled in step 2 — verbatim; they are hard requirements.
- The **`$PWD/.drawbar/memory`** path (for recall and inline lesson capture).
- The instruction to work in red→green increments, **show the RED run**, and return a verifiable report — not to commit, push, open a PR, change Linear status, or run reviews. Those are yours.

For a story large enough to split into independent, non-conflicting slices, you may dispatch more than one `story-implementer` in parallel — but only when the slices don't touch the same files. Most stories are one agent.

## 5. Verify completion (gate — before any review)

When the implementer returns, **you verify its work before review begins.** Do not take "done" on trust:

- Read the report **and** the actual diff (`git diff`) — confirm they match.
- Confirm each **RED run was actually shown** (failing-then-passing output), not just claimed.
- Re-run the **tests covering the change plus typecheck and lint yourself**, and confirm they are green.
- Check **every acceptance criterion** is met and no Locked / `MUST-CHECK:` constraint was violated or silently worked around.

If anything is missing, wrong, or unverifiable, **send it back**: re-dispatch `story-implementer` with the specific gaps. Only start the review loop once you have verified the story is complete and green. This gate is the point of splitting the roles — the implementer builds, the lead confirms.

## 6. Review and fix loop

Dispatch **two reviewers in parallel** on the story's diff, in a single message:

- `code-reviewer` — spec compliance, code quality, and tests (pass it the acceptance criteria).
- `security-reviewer` — security only: committed secrets/credentials, authz/tenant isolation, injection, data exposure (pass it the `.drawbar/memory` path so it can recall `MUST-CHECK security` constraints).

They are independent on purpose: a single reviewer juggling spec + quality + tests under-weights security, which is how a committed credential slips through. Merge both reviews.

**Fixes are implementation — delegate the substantive ones.** For findings that need a test or non-trivial logic, re-dispatch `story-implementer` **in fix mode**: hand it the merged Critical/Important findings and tell it this is a fix pass (address the findings, add a regression test red→green for any real bug/security finding, report just that — not the full story matrix). Then **re-run the step 5 verification gate** on its fixes and re-review until both reviewers come back clean.

Small, obvious one-line corrections you may apply directly rather than round-tripping an agent — that latitude is for trivia only (a rename, a typo, a missing null-check with no behavior to test), not for anything a reviewer would want to see a test for. (Keep this loop — it catches real issues before the PR.)

## 7. Capture lessons (inline)

The implementer captures lessons it hits while building. As the lead, add anything **you** learn during verification or the review loop (a review finding worth generalizing, a gotcha the gate caught). Pipe a JSON object on stdin (never shell-interpolate content):

```bash
echo '{"key":"<kebab-key>","type":"<learned|decision|pattern|fact|investigation|deviation>","content":"<the lesson>","source":"agent","tags":["..."],"issue":"<issue-id>","files":["<path>"]}' \
  | drawbar-kb add --dir "$PWD/.drawbar/memory"
```

For a mistake to guard against in future, use type `learned` with content beginning `MUST-CHECK:`.

## 8. Close out — PR, leave In Progress

1. Commit referencing the story id (e.g. `feat: … (ABC-123)`), on a feature branch whose name includes the id so Linear auto-links the PR.
2. Push the branch and **open a PR** (`gh pr create`) — title/body referencing the issue id. **Do NOT merge it.** You are handing off for review.
3. **Leave the story `In Progress`.** An attached PR is the signal that it's in review — do not advance the status. **Never** set `Done`, `Ready for QA`, `Ready for Rollout`, `Rolled Out`, or any QA/rollout/completion status; those are owned by humans and QA downstream.
4. Post a short summary comment on the story (`save_comment`) with what shipped and the PR link.

If the Linear MCP is unavailable, do the implementation, KB capture, commit and PR locally; skip the Linear comment/status updates and tell the user.

## 9. Report

Print the story id, what shipped, the PR link, and — if you worked a child under a parent — which sibling stories remain `Todo`. Re-run `/drawbar-work <issue-id>` for the next one.
