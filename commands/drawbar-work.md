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
KB=$(drawbar-kb path) || { echo "drawbar context unresolvable — run /drawbar-setup"; exit 1; }
[ -d "$KB" ] || { echo "no knowledge base at $KB — run /drawbar-setup"; exit 1; }
command -v linear >/dev/null 2>&1 || echo "WARNING: no \`linear\` CLI — every review will report spec_source: \"brief\" and no story can come back clean"
```

`drawbar-kb path` resolves the store from the main worktree root, which is the only reason this command works at all from a linked worktree — and stories are implemented in worktrees constantly. `$PWD/.drawbar/memory` there is an empty directory that recalls nothing and swallows every lesson written to it. Use `$KB`, and hand `$KB` (absolute, as printed) to every agent you dispatch.

The `linear` warning is a warning and not an exit on purpose: a brief-sourced review is degraded but
honest, and §6 already refuses to treat it as a clean pass. What the operator must never have to
guess is *why* every story came back caveated — "this machine has no CLI" and "this story has real
caveats" are the same output without this line.

## 1. Pick the story

`$ARGUMENTS` is a Linear issue id. Load it with the Linear MCP `get_issue`, then handle either shape:

- **It has sub-issues** → list them (`list_issues` with `parentId`) and take the next child in dependency order whose status is `Todo`. If none are `Todo`, report that all children are done or in progress and stop.
- **It has no sub-issues** → the issue *itself* is the story to implement.

This is the common case for a single ticket — a leaf story id is just as valid as a parent.

## 2. Recall + read comments

```bash
drawbar-kb recall "<story title and files>" --dir "$KB" --json
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

### Provenance — what you may assert as fact

Before you write a factual claim someone else will act on, ask the one question with a
mechanical answer:

**Did I read the thing that answers this question, in this session?**

- **Yes** → assert it, and cite `file:line`.
- **No** → do not assert it. Write it as an instruction to check.

The test is **per-question, not per-file**. A search that answered one question licenses
nothing about a different one in the same file: grepping `ruleSets` opens the schema and still
says nothing about whether a rule carries an `id`. Record what each read *established*, not
which paths you touched.

**Point at the evidence, not the conclusion.** Instead of "location rules have no `id`, keep
`key={index}`", write "I have not read the rule schema — check `BaseRuleSchema` in
`shared/types/locationGroup.ts` and match whichever is correct." The second is shorter, and it
produces the right result even when your belief is wrong. That is the whole trick: a belief
written as evidence-plus-instruction is self-correcting, while the same belief written as a
decision is binding — and an agent told it is a hard requirement will build it faithfully.

The brief must hand the agent everything it needs to work without you:

- The story's **description and acceptance criteria** (What / Decisions / Testing / Validation / Files).
- Every **Locked** decision and `MUST-CHECK:` recalled in step 2 — verbatim; they are hard requirements.
- The **`$KB`** path from preflight, verbatim and absolute (for recall and inline lesson capture). Never a path built from the agent's own `$PWD` — a subagent's working directory is not guaranteed to be yours.
- A **`## Read set`** — one line per read, naming what it established and what it did not. Your
  own conclusions go here as evidence with `file:line`, never in the Locked list. Anything you
  assert that no entry backs is the defect step 5 looks for.

  ```
  ## Read set
  - shared/types/locationGroup.ts — grepped `ruleSets` only; rule id-ness NOT established
  - pages/Organization/GroupDetail.tsx — full read
  ```
- The instruction to work in red→green increments, **show the RED run**, and return a verifiable report — not to commit, push, open a PR, change Linear status, or run reviews. Those are yours.

For a story large enough to split into independent, non-conflicting slices, you may dispatch more than one `story-implementer` in parallel — but only when the slices don't touch the same files. Most stories are one agent.

## 5. Verify completion (gate — before any review)

When the implementer returns, **you verify its work before review begins.** Do not take "done" on trust:

- Read the report **and** the actual diff (`git diff`) — confirm they match, and that nothing landed that the story did not ask for.
- Confirm each **RED run was actually shown** (failing-then-passing output), not just claimed.
- Re-run the **tests covering the change plus typecheck and lint yourself**, and confirm they are green.
- **Mutation-test the load-bearing guards**: neuter each one and confirm a specific test fails. A guard whose deletion leaves the suite green is not tested, however many tests surround it — and this catches the failure mode a green suite is blind to, including guards that pass for the wrong reason.
- Check **every acceptance criterion** is met and no Locked / `MUST-CHECK:` constraint was violated or silently worked around.
- Read the report's **brief claims the implementer found to be false** — the item the implementer keeps separate from what it worked around. These are about the brief *you* wrote, so the pull is to quietly correct the wording and carry on; do not. Where one changes what the story should have done, send the story back. An unreported false claim goes straight into the next brief.

  **Write the correction to the KB, never the claim.** Record the corrected truth **positively phrased** — "`BaseRuleSchema` carries `id: uuidSchema.optional()` (`shared/types/locationGroup.ts:74`)" — plus a `MUST-CHECK:` for the *research habit* that produced the error, phrased so it stands alone: "MUST-CHECK: establish a schema property by opening the schema; usage at a call site does not establish it." **Do not write the false claim to the knowledge base in any form, including as a negation.** A stored "rules are NOT id-less" still contains the false proposition, recall is keyword-matched rather than meaning-matched, and the entry arrives in a later session as one line stripped of the framing that made it a correction. You do not need the falsehood to prevent it recurring — you need the truth to be easier to recall than the guess was to make.

If anything is missing, wrong, or unverifiable, **send it back**: re-dispatch `story-implementer` with the specific gaps. Only start the review loop once you have verified the story is complete and green. This gate is the point of splitting the roles — the implementer builds, the lead confirms.

## 6. Review and fix loop

Dispatch **two reviewers in parallel** on the story's diff, in a single message:

- `code-reviewer` — spec compliance, code quality, and tests (pass it the acceptance criteria).
- `security-reviewer` — security only: committed secrets/credentials, authz/tenant isolation, injection, data exposure (pass it `$KB` so it can recall `MUST-CHECK security` constraints).

Pass both the project directory as `$PROJECT_DIR`: each pins the commit it read with `git -C "$PROJECT_DIR" rev-parse HEAD`, and a subagent's working directory is not guaranteed to be the project's. Tell both that the diff they are reading is **uncommitted** — step 4 told the implementer not to commit and step 8 is where the first commit happens — so the sha they capture names the commit this work sits on top of and none of the work itself, which is exactly what their own contract says to report and to say plainly.

They are independent on purpose: a single reviewer juggling spec + quality + tests under-weights security, which is how a committed credential slips through. Merge both reviews — by `dedup_key`, not by hand: two findings sharing one `dedup_key` are one finding, and every collapse you make is named in the report so a duplicate is never dropped silently.

**A malformed reviewer report is not an approval — treat it as a failed review.** A report is malformed when it omits `spec_source`, omits `reviewed_sha`, carries a finding without a `dedup_key`, or — from the security-reviewer alone, whose contract is the only one that defines the field — returns an empty `findings` list alongside an empty or absent `checked`. `agents/security-reviewer.md` says that last payload is malformed and that its caller must treat it as one; **you are that caller**, and this is where that obligation is discharged. An empty finding list from a reviewer that cannot say what it read is indistinguishable from a reviewer that never ran, so it does not count toward the two reviews this step requires: do not open a PR on the strength of it, and stop and tell the user which reviewer returned what.

**A reviewer reporting `spec_source: "brief"` reviewed a summary, not the spec.** It could not reach Linear, so an AMENDED banner, a superseded section, or a struck decision in the story's description was invisible to it and the design it approved may already have been replaced. Say so in your report and in the PR body; never treat that review as a clean pass.

**Fixes are implementation — delegate the substantive ones.** For findings that need a test or non-trivial logic, re-dispatch `story-implementer` **in fix mode**: hand it the findings and tell it this is a fix pass (address them, add a regression test red→green for any real bug/security finding, report just that — not the full story matrix). Then **re-run the step 5 verification gate** on its fixes and re-review.

**A fix pass carries Critical and Important findings only.** Minors do not go in. Batch them into a single cleanup pass at the end, or drop them — say which. This is the single biggest lever on how long a story takes: a brief carrying twenty-odd items is not a fix pass, it is a second story, and it will be implemented like one.

**Keep the brief proportional.** State the findings, the reproduction, and the expected fix. Then state the constraint explicitly: *only* these findings, no refactors, no relocating shared helpers, no new abstractions, nothing opportunistic — `story-implementer`'s fix mode says the same thing, and the two need to agree. Code added during a fix pass is the least-reviewed code in the change; it lands after the reviewers have read the diff. On this project, scope-expanding fix passes have introduced Criticals worse than the ones they closed.

**Verification between rounds is scoped, not a full re-derivation.** Re-running everything the implementer already ran is near-zero yield. What actually catches problems:

- **Reproduce each Critical yourself** — before the fix (confirm the finding is real) and after (confirm it is closed). Reviewers are wrong often enough that this is not optional.
- **Mutation-test the changed guards** — neuter each one and confirm a specific test fails. This is the highest-value check available to you: it catches guards that are dead, vacuous, or passing for the wrong reason, including in your own fixes.
- **One full suite run**, and confirm the diff matches the report.

**Cap the loop, and escalate with a cost estimate.** If a second review round finds new Criticals — especially ones introduced by the previous fix pass — stop and go to the user before starting a third. Report what has been found, what it has cost so far, and the options: keep iterating, ship with the finding documented, or have you apply the fix directly. A loop that keeps finding real Criticals is not evidence the loop is working; it is usually evidence the story was too big or the briefs are too broad, and that is the user's call to make, not yours.

Small, obvious one-line corrections you may apply directly rather than round-tripping an agent — that latitude is for trivia only (a rename, a typo, a missing null-check with no behavior to test), not for anything a reviewer would want to see a test for. (Keep this loop — it catches real issues before the PR.)

## 7. Capture lessons (inline)

The implementer captures lessons it hits while building. As the lead, add anything **you** learn during verification or the review loop (a review finding worth generalizing, a gotcha the gate caught). Pipe a JSON object on stdin (never shell-interpolate content):

```bash
echo '{"key":"<kebab-key>","type":"<learned|decision|pattern|fact|investigation|deviation>","content":"<the lesson>","source":"agent","tags":["..."],"issue":"<issue-id>","files":["<path>"]}' \
  | drawbar-kb add --dir "$KB"
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
