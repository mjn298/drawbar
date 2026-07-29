# drawbar-ship: stacked PRs, no merging

**Date:** 2026-07-29
**Status:** approved, pending implementation plan
**Supersedes:** the unattended-merge design that `drawbar-ship` was built around, and the
remaining open stories of the "harden drawbar-ship" epic.

## Problem

`drawbar-ship` was designed to burn down an epic unattended by *merging* each story: gate the
PR, merge it, set a configured merged-but-not-QA'd status, move on. Two things about that
turned out to be wrong for how this actually gets used.

**Merging unattended is not wanted.** The operator wants to review and reconcile in the
morning. An unattended merge removes the one checkpoint that matters and replaces it with a
large, load-bearing gate — `merge-guard.ts` plus §4 of the runbook is roughly 2,000 lines
whose entire job is deciding whether a merge is safe. All of it exists to substitute for a
human who would rather just look.

**Waiting on CodeRabbit serialises the night.** Each story blocks on an external review
service before it can finish. The verdict is not acted on unattended anyway.

The result is a design that spends most of its complexity and most of its wall-clock on two
things nobody wants.

## What replaces it

Each story becomes one PR, and the PRs form a stack. Nothing is merged. The operator reviews
the stack in the morning and merges bottom-up by hand.

```
pick next Todo story (dependency order)
  -> resolve stack base:  first story of the run -> config baseBranch
                          otherwise              -> previous story's branch
  -> delegate to story-lead, given that base:
        implement -> verify gate -> mutation gate
        -> dual review -> ONE bounded fix pass -> open PR with --base <base>
  -> record {story, branch, pr, base, flagged} in run state
  -> sync knowledge (kb-sync.ts, role unchanged)
  -> advance: the next story's base is THIS story's branch
```

Stories are dependency-ordered, so a true stack is required rather than incidental: story N+1
generally does not compile against `main`. Basing each PR on its predecessor means every PR's
diff shows only its own changes and every branch is buildable.

### Terminal states for a story

The "keep stacking even when a story isn't clean" rule needs a distinction the phrase itself
hides — it only works when there *is* a PR to stack on.

| Outcome | Action |
|---|---|
| Clean | Open the PR. Record it. Continue. |
| **PR opened, findings unresolved** | Open it anyway, **flagged**: unresolved findings written into the PR body and a Linear comment, `flagged: true` in run state. Continue stacking. |
| **No PR could be opened** | **Park and halt.** The chain has no anchor — there is no branch for the next story to base on. |

The middle row is the point of the redesign: a story that is 90% right is worth having in
front of the operator at 8am, annotated, rather than costing the whole night's remaining
throughput.

### Reviews

The internal dual review (`code-reviewer` + `security-reviewer`) and **one** bounded fix pass
stay. They earn their cost: on the last story run under the old design they surfaced four real
Criticals, two of which were live bugs rather than style. What goes is the CodeRabbit *wait* —
CodeRabbit may post whenever it likes, and nothing ever blocks on it.

The fix pass carries Critical and Important findings only, and exactly one round. If findings
survive it, the PR is flagged rather than iterated. Repeated fix rounds are how this project
has previously introduced Criticals worse than the ones being closed.

### Linear

The story stays `In Progress` with its PR attached. The attached PR is the signal that it is
waiting on the operator — the same convention `/drawbar-work` already uses. `mergedStatus`
leaves the config file entirely; there is no status transition to make and therefore no status
to keep in sync.

## Code changes

### New

**`scripts/lib/stack.ts`** (+ tests) — the only genuinely new logic.

- `resolveBase(runState, storyId, config)` — the branch story N should be based on: the
  configured `baseBranch` for the first story of a run, otherwise the previous story's
  recorded branch. Named refusal rather than a default when the state is inconsistent.
- `assertChainIntact(...)` — refuses when a recorded predecessor branch is missing or has
  moved.

Small, but it is precisely the logic that goes silently wrong on a crash-resume: a run that
picks the wrong base produces a PR whose diff contains another story's work, which looks
plausible and is very hard to see in the morning. Pure functions with injected runners
(Locked 5) — tests pass with `git` absent from `PATH`.

### Changed

- **`scripts/lib/run-state.ts`** — `merged: {}` becomes
  `stack: [{story, branch, pr, base, flagged}]`. The schema is pinned and validated
  structurally, so this is a real migration, not a field rename.
- **`scripts/lib/ship-config.ts`** — drop `mergedStatus` and the preflight assertion that it
  exists and is of type `started`. This changes the exact required-key set, which the parser
  enforces in both directions.
- **`commands/drawbar-ship.md`** — §4 (merge) becomes "open the stacked PR". §5
  (merged-status transition) becomes "post the summary comment, leave In Progress". Preflight
  loses the `mergedStatus` assertion and keeps the knowledge-repo checks added in S8.
- **`agents/drawbar-story-lead.md`** — accepts a base branch; opens its PR against it; drops
  the CodeRabbit wait; returns `ok | flagged` plus findings.
- **`scripts/plugin.test.ts`** — prose pins for the new §4, and an assertion that
  `gh pr merge` appears **nowhere** in the repo. This also closes a finding from the last
  review round: the runbook's §6 and Preflight changes were entirely unpinned, so the original
  bug could be reintroduced verbatim with a green suite.

### Deleted

- `scripts/lib/merge-guard.ts` and its tests (~1,800 lines).
- `scripts/lib/coderabbit.ts` and its tests — stripping the gating leaves it with no caller,
  and a dormant module is something an agent wanders into.
- §4's merge gating and §5's merged-status transition in the runbook.
- The `mergedStatus` config field and its example-config entry.

## Failure handling and recovery

**Crash recovery** gains a responsibility: re-establishing the stack base, not just the
in-flight story. A resumed run must confirm the recorded predecessor branch still exists and
still points where the state file says, and refuse rather than guess. `assertChainIntact`
exists for this.

**Out-of-order merges by the operator** are explicitly out of scope. If the operator merges a
middle PR in the morning, the remaining branches need rebasing — that is a human action, and
the tool does not attempt to detect or repair it mid-run. A later story may add detection; it
is not part of this design.

## Testing

Every module keeps the existing discipline: pure functions with injected runners, tests green
with `git` absent from `PATH` (both proof forms — a runner-only `PATH`, and a full toolchain
with `git` genuinely removed and its absence asserted).

- `stack.ts` — base resolution for the first and Nth story; refusal on a missing or moved
  predecessor; a call-counter spy proving no git call happens before validation.
- `run-state.ts` — the new `stack` shape accepted, every malformed variant refused.
- `ship-config.ts` — `mergedStatus` now refused as an unknown key; its absence accepted.
- `plugin.test.ts` — the runbook pins above, mutation-proven by actually applying the
  reversion and confirming a test fails. Prose pins must survive a **rephrase**, not only a
  deletion.

## Sequencing

| | Story | Why here |
|---|---|---|
| R1 | Strip the merge path and CodeRabbit gating | First and standalone: deleting shrinks everything downstream, and there is never a window where both paths are live |
| R2 | `stack.ts` + the run-state schema migration | The new state model, before anything writes it |
| R3 | Rewrite ship §4/§5 + the prose pins | Consumes R2 |
| R4 | Rewrite the story-lead (base branch, no CodeRabbit wait, flagged PRs) | Consumes R3's contract |
| R5 | Finish the outstanding `kb-sync.ts` Criticals under the new design | Deferred from the last run; the findings are recorded and still valid |
| R6 | Documentation pass + one attended end-to-end run | Replaces the old epic's S9/S10 |

## Carried-over findings (R5)

The last story run produced a reviewed `kb-sync.ts` with known, reproduced defects. They are
unaffected by this redesign — `kb-sync` is orthogonal to merging — and are carried into R5:

1. `git add` on a gitignored archive path exits 1, halting the sync permanently wherever the
   archive is ignored. Agreed fix: skip the archive when `git check-ignore` reports it ignored.
2. §6 hands `git -C` a path derived from agent-held state with no agreement check against the
   operator-authored config — an ACE sink. Fix: a required `--config-path`, checked inside the
   module.
3. The runbook prose is unpinned (folded into R3's pins).
4. Nine surviving mutants in the retry loop's core, including a missing `mkdir` that throws
   past the result contract on a real first run.
5. `git add` on a missing active file exits 128.
6. `git commit` with no pathspec sweeps foreign staged content into the commit and pushes it.

## Superseded work

The "harden drawbar-ship" epic is closed as superseded. Its merged stories stay merged; its
open children are closed as obsolete: the merged-status ancestry blocker clause, the merge
TOCTOU fix, and the CI-conclusion check are all gates on a merge that no longer happens.
