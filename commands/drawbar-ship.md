---
name: drawbar-ship
description: Unattended overnight burn-down of a Linear parent's stories — delegate each story to an Opus story-lead, sync knowledge, and move to the next. Never merges; the operator reviews and merges. One story per invocation; drive it with /loop.
argument-hint: "<TEAM>-#### parent issue id, or a single story id"
---

# drawbar ship

Take one story from `Todo` up to the point a human takes over, then stop. It never
merges — the operator reviews and merges. Driven by
`/loop /drawbar-ship <TEAM>-####` it burns a parent down overnight; invoked bare it does
exactly one story, which is the right way to run it attended.

**You are a thin orchestrator.** The implementation and the review loop all happen inside a
dispatched `drawbar-story-lead` agent, so its diffs, test output and review bodies never
enter your context. You hold only: the snapshot, the Linear writes, the KB push,
and the burn-down.

**You own every Linear write.** The story-lead has no Linear tools at all. That is
deliberate and mechanical: it is why a story agent cannot set a completion status.

**This extends `/drawbar-work` past its hand-off point** — that command opens a PR and
stops, because humans own everything downstream of code-is-up-for-review. This one keeps
going instead of stopping there: it picks the next story, delegates it, and advances,
story after story — but it never merges the PR it opens.

Sequential only. **Never** run two stories concurrently — they are dependency-ordered, and
story N assumes N−1 is on `main`.

## Preflight (halt on any failure)

> The config's validated `repo` identity below is what anchors every `gh` call at the right
> target; this repo is public, so treat that identity as accident containment, not a security
> boundary.

```bash
command -v drawbar-kb >/dev/null || { echo "no drawbar-kb — run /drawbar-setup"; exit 1; }
command -v gh        >/dev/null && gh auth status >/dev/null 2>&1 || { echo "gh not authed"; exit 1; }

# MUST-CHECK repo-anchor-guard-is-what-gates-an-unfixed-vulnerability: fail closed if the
# plugin root isn't set — nothing below can find ship-config.ts without it. Same guard
# drawbar-story-lead §7 uses.
: "${CLAUDE_PLUGIN_ROOT:?CLAUDE_PLUGIN_ROOT must be set}"

# Locked 17: CONFIG comes from config, resolved EXPLICITLY. No walking up to a parent
# directory, and no probing for a sibling knowledge-repo checkout anywhere in this file —
# both are gone for good; every downstream value comes from the validated config instead.
CONFIG="${DRAWBAR_SHIP_CONFIG:-$PWD/.drawbar/ship.config.json}"
# Cross-reference: this fallback duplicates ship-config.ts's `resolveConfigPath` — keep both
# in sync if the default location or the env-var name ever changes.
[ -f "$CONFIG" ] || { echo "FATAL: no config at $CONFIG — copy .drawbar/ship.config.example.json, fill in real values, and either place the copy there or set DRAWBAR_SHIP_CONFIG to point at it."; exit 1; }

# MUST-CHECK config-file-must-not-be-tracked-by-git (Important 8, fix pass 2): the mechanism
# this replaced read its config from EXPORTED ENV VARS — only the operator's own shell could
# set those. $CONFIG is now a file inside a working directory, and any repository can carry
# one in its tree (`.drawbar/` is an established convention adopting projects commit); a
# contributor PR adding `.drawbar/ship.config.json` is easy to miss, and the operator's next
# run from that repo root loads it with no prompt. The repo-anchor guard alone does not stop
# this — `repo` matching projectDir's remote says nothing about whether the CONFIG FILE ITSELF
# was planted. A planted config still controls envDir (where $KB and the run-state file get
# written) and team; `requiredChecks` is validated and persisted too, but currently
# unenforced — no consumer reads it — pending a later story.
# Enforce the invariant the `.gitignore` line already encodes: a real ship
# config is NEVER tracked by git. Fails closed on a genuine tracked hit; a `git` failure
# (e.g. $CONFIG's directory isn't a repo at all) is not itself the vulnerability this guards
# against, so it does not need special-casing here.
git -C "$(dirname "$CONFIG")" ls-files --error-unmatch "$CONFIG" >/dev/null 2>&1 \
  && { echo "FATAL: $CONFIG is tracked by git — a committed ship config is never trusted. Untrack it (git rm --cached) and keep it out of version control."; exit 1; } \
  || true

# Fetch the Linear facts THIS AGENT SESSION can see via MCP — ship-config.ts has no Linear
# tools of its own, only the session driving this command does — and hand them to the
# validator as JSON on stdin, the same convention `drawbar-kb add` uses:
#   list_teams -> feeds "teams": [...]
# Assemble `{"teams":[...]}` and pipe it in. All four Locked-18 assertions —
# repo identity, projectDir/envDir separation, team resolution, and baseBranch being the
# repo's actual default branch — run inside ship-config.ts; they are never reimplemented here
# in bash.
RESOLVED=$(echo "$LINEAR_FACTS_JSON" | bun run "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ship-config.ts" validate --config "$CONFIG") \
  || { echo "FATAL: ship-config validation refused — see stderr above for the specific reason."; exit 1; }
# Expected stdout on a pass (the `resolved_config` payload — every field present, none null):
#   {"envDir":"/abs/path/to/knowledge-repo","projectDir":"/abs/path/to/code-repo",
#    "repo":"<org>/<repo>","team":"<TEAM>","baseBranch":"main",
#    "requiredChecks":["<check>"],"observed":{"projectDirRemote":"<org>/<repo>",
#    "envDirRemote":"<org>/<knowledge-repo>","defaultBranch":"main"}}

# --- derive from the resolved config -----------------------------------------------------
ENV_DIR=$(echo "$RESOLVED" | jq -r '.envDir // empty')
PROJECT_DIR=$(echo "$RESOLVED" | jq -r '.projectDir // empty')
REPO=$(echo "$RESOLVED" | jq -r '.repo // empty')
BASE_BRANCH=$(echo "$RESOLVED" | jq -r '.baseBranch // empty')

# MUST-CHECK repo-anchor-guard-is-what-gates-an-unfixed-vulnerability: quote every one of
# these, and assert each is non-empty and NOT the literal string "null" before anything below
# depends on it — jq's `// empty` already collapses a JSON `null` to `""`, but a value that
# somehow arrives as the STRING "null" (a malformed `resolved_config`) must not silently
# satisfy a downstream substring/case guard either.
for v in ENV_DIR PROJECT_DIR REPO BASE_BRANCH; do
  val="${!v}"
  [ -n "$val" ] && [ "$val" != "null" ] || { echo "FATAL: $v is empty or null after validation — refusing."; exit 1; }
done
KB="$ENV_DIR/.drawbar/memory"
# --- end derive from the resolved config -------------------------------------------------

[ -d "$PROJECT_DIR/.git" ] || { echo "FATAL: no git repo at $PROJECT_DIR"; exit 1; }

# This repo is public. NEVER a bare `gh repo view`: $ENV_DIR is itself a git repo with a
# GitHub remote, so from that cwd it resolves to the WRONG repository and every `gh pr` call
# would silently target it, succeed, find no matching PR, and never satisfy the gate. The
# validated $REPO above — resolved and checked by ship-config.ts, never re-derived here — is
# what anchors every downstream `gh` call at the actually-configured project repo instead.

# Locked 16 (S8, PCO-353, F8): the checks above cover $PROJECT_DIR — nothing above ever looks at
# the KNOWLEDGE repo ($ENV_DIR), which is the one step 6's rebase actually depends on being
# clean, `merge=union`-covered, and carrying a `.drawbar/runs/.gitignore`. Delegated whole to
# `kb-sync.ts preflight` — no second, hand-copied bash implementation of any of its three
# assertions here (single-implementation-site regression discipline).
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/lib/kb-sync.ts" preflight --env-dir "$ENV_DIR" --dir "$KB" \
  || { echo "FATAL: kb-sync.ts preflight refused — see stderr above for the specific reason."; exit 1; }
```

Dirty `$PROJECT_DIR` tree → **do not halt blindly**; go to *Crash recovery* below. A dirty tree
is the signature of a crashed run, and halting on it means every crash costs a human.

Confirm the Linear MCP answers (`list_issue_statuses` for team **<TEAM>**). If unavailable,
**halt** — §1's pick rule and the blocker gate both read issue status, and neither can
function without it.

**Assert-or-create the `found-in-review` label.** Step 3 mandates it; it did not exist
until 2026-07-27, so earlier runs silently dropped it (<TEAM>-L1 and <TEAM>-L2 carry no labels).
`list_issue_labels` for the team; create it if missing. Never assume it exists.

## 0. Snapshot the story list (first invocation only)

State file: `$ENV_DIR/.drawbar/runs/<ARG>.json` (gitignored, absolute). If absent, create
it in the PINNED schema below (Locked 12) — `scripts/lib/run-state.ts`'s `parseRunState`
rejects any other shape loudly, structural-only, never silently tolerating an unknown key:

```
{
  "arg": "<the id this run was invoked with>",
  "invoked_as": "parent" | "leaf",
  "started_at": "<ISO timestamp>",
  "order_rationale": "<how the snapshot below was topologically sorted>",
  "snapshot": ["<story id>", ...],
  "stories_done": [],
  "in_flight": null,
  "stack": [],
  "subissues_filed": [],
  "resolved_config": { /* Preflight's $RESOLVED, verbatim — ship-config.ts's ResolvedConfig */ }
}
```

The canonical story-list key is **`snapshot`** — never `stories`. Persist `resolved_config`
at this point too (T0), copying Preflight's already-validated `$RESOLVED` verbatim: it is
`scripts/lib/ship-config.ts`'s `ResolvedConfig` shape (the six configured keys plus
`observed`), never a second hand-copied shape.

The shape of `snapshot`/`invoked_as` depends on what you were invoked with:

- **`$ARGUMENTS` is a parent** (has sub-issues) → `list_issues` with `parentId`; record
  every child whose status is `Todo`.
- **`$ARGUMENTS` is a leaf story** (no sub-issues) → a single-story snapshot containing
  just that id. Record `"invoked_as": "leaf"` so later steps and any resume know not to
  look for siblings.

**Then topologically sort the snapshot by `blockedBy` relations among its own members**, and
persist that order. `list_issues` returns creation/update order, not dependency order, so
without this the run order is whatever the API happens to hand back.

> This is not theoretical. For <TEAM>-P the API returned <TEAM>-A first and <TEAM>-C before
> <TEAM>-B — and <TEAM>-C is `blockedBy` <TEAM>-B. Picking <TEAM>-C first would hit the
> step 1 blocker rule and **halt the entire night** on a blocker that was merely later in
> the same queue.

Members with no relation between them keep their `list_issues` order — a stable tiebreak,
not a judgment call.

**Locked 11 — an empty relation set is not evidence of independence.** Establish each
member's dependencies from **both** Linear's `blockedBy` relations **and** its own
`## Dependencies` prose section, never from relations alone: "no edges returned" from the
relation query is not the same fact as "no edges exist." Independence must be **stated**, not
inferred from silence: a member counts as independent only when both sources give a positive
artifact saying so — the relation query actually returned (even an empty result) **and** the
issue carries a `## Dependencies` section (even one that states "none"). A member with **no**
`## Dependencies` section at all halts, and a member whose relation query **errored** halts
too — neither is evidence of independence, both are missing evidence.

Distinguish the two by the **tool result itself**, not by its contents: a call that returned a
result object — even one carrying an empty relation list — is a positive artifact; a call that
raised an error, timed out, or returned no result object at all is a failed read. Record which
of the two you observed for each member, so the halt condition is something you can actually
evaluate rather than infer. An unrecordable premise is not a gate. If dependency information
cannot be established for a snapshot member from either source, **halt and notify**.

This halt applies to a **multi-member** snapshot, where ordering is what is being established.
A single-member snapshot (`"invoked_as": "leaf"`) has no ordering to establish and does not
halt on a missing section. Note the interaction with step 3: sub-issues this command files
carry no `## Dependencies` section of their own, so step 3 writes one — otherwise a triaged
finding becomes a `Todo` child, joins the next parent run's snapshot, and halts it.

If the relations contain a cycle, halt and notify too: that is a planning error no unattended
run should paper over.

Also record `started_at` and `stories_done: []`.

**This snapshot is the entire scope of the run.** Sub-issues filed *during* the run are
deliberately **not** added to it.

> Why: the termination condition is "no `Todo` children left," but each story's review can
> file more. Without a snapshot the loop may never end. More importantly, a bug found at
> 2am has had none of the planning every snapshotted story went through — no spec, no
> `Locked` decisions, no acceptance criteria. Implementing it unattended is exactly the
> case where there is nobody to ask.
>
> One real exception has occurred: <TEAM>-#### was created mid-run as a **hard prerequisite**
> that made its parent story physically unshippable (two CI gates contradicted each other).
> If a discovered issue blocks the *current* story outright, you may work it — but say so
> in the notification, and add it to the snapshot explicitly so the record matches reality.

## 1. Pick the story, and clear its blockers

Next id in the snapshot not in `stories_done`, whose Linear status is still `Todo`.
Snapshot exhausted → go to *Finishing the run*.

**Blocker rule.** A `blockedBy` relation is resolved by exactly one of the following three
clauses — but they do not all mean the same thing. Clauses 1-2 **clear** the blocker: the
gate is satisfied, proceed with the current story. Clause 3 is different in kind, not just in
number: it means your **pick** was wrong, not that the blocker cleared — its outcome is
**re-pick, never proceed**.

1. the blocker is `Done` / `Rolled Out`, **or**
2. the blocker **has children** and all of its non-`Unplanned` children are `Done`, **or**
3. **(re-pick, not a clearance)** the **unsatisfied** blocker is **itself a member of this
   snapshot** and not yet in `stories_done`. Membership is **exact, case-sensitive equality**
   against the `snapshot[]` array in the run-state file — a partial, prefix, or
   case-insensitive match is **not** membership. The topological sort in step 0 was wrong, or
   a relation was added mid-run. **Re-sort and continue**: re-sort the snapshot, **persist**
   the new order and `order_rationale` to the state file (step 0 already requires the order
   be persisted — a crash after an unpersisted re-sort would resume on the stale order), then
   return to the **top of this step** and re-pick. The re-sort re-runs step 0's sort **in
   full, including its cycle check** — a relation added mid-run is exactly what introduces a
   cycle, and step 0's halt is the only thing that catches one. **Terminator:** **halt and
   notify** if any story is picked twice within this step — not merely if the re-sort leaves
   the pick unchanged. Comparing against the immediately-previous pick alone misses a
   two-cycle: a mid-run `A blockedBy B` plus `B blockedBy A` yields X→Y→X→Y, where every
   re-sort *does* change the pick and a previous-pick-only terminator never fires.

Otherwise **halt and notify**. Never proceed past a blocker with `Todo` or `In Progress`
children. An **unsatisfied** blocker **outside** the snapshot always halts — clause 3 never
applies to it: clause 3 only ever re-picks, it can never itself clear a blocker, so a blocker
genuinely outside the snapshot can only ever reach this halt.

> Clause 2 exists because a real run hit a blocker sitting in `Unplanned` whose seven
> children were all `Done` — a tracking issue, not live work. A literal gate ends the night
> on bookkeeping; ignoring blockers ships on a real gap. This is the judgment nobody is
> awake to make, so it is written down instead.

## 2. Delegate the whole story

**Before dispatching, `in_flight` is the authoritative duplicate-dispatch guard (Locked
13).** Check the state file: a non-null `in_flight` means a dispatch may already be running.

- If `now - in_flight.agent_dispatched_at` is **within** 2x the heartbeat (see below), this
  is a fresh, live dispatch — **no-op, do not dispatch a second agent at all, for ANY story,
  while `in_flight` is non-null.** The guard is per-run, not per-story: `in_flight` names one
  story-lead dispatch at a time regardless of which story it names, so a different story
  never justifies a second dispatch either.
- If it **exceeds** 2x the heartbeat (strict `>` — exactly 2x is still fresh, a deliberate
  boundary choice), the prior dispatch is presumed crashed — go to *Crash recovery* instead
  of no-op'ing forever. (The repo probe used there is a crash-recovery tool only, with a
  blind window between dispatch and first commit — it read "indistinguishable from never
  started" one minute after a live dispatch, so it must never gate a fresh in-window check.)
- If `in_flight` is `null`, proceed to dispatch below.

`scripts/lib/run-state.ts` (`dispatchVerdict` / `maybeDispatch`) implements this verdict as a
pure function with an injected clock — follow the same boundary and ordering as
`dispatchVerdict` / `maybeDispatch` here rather than reimplementing the logic ad hoc.

**Post a `save_comment` on the story before dispatching** — that implementation is starting,
with the branch name and timestamp. A crashed run that never commits leaves *no* record of
intent otherwise; this comment is what makes a crash recoverable. Move the story to
`In Progress`.

**Write `in_flight` at dispatch, and re-arm the heartbeat (F13).** Set
`in_flight: {story, agent_dispatched_at: <now>}` in the state file, where `<now>` is a **UTC
ISO 8601 instant** — the exact form `new Date().toISOString()` produces (e.g.
`2026-07-28T03:14:15.000Z`). Never a bare `YYYY-MM-DD HH:MM:SS` or any other non-ISO form:
those parse as LOCAL time, not UTC, so the same literal timestamp means a different instant
depending on the machine's timezone — silently corrupting every later staleness comparison.
The heartbeat is **2700-3600 seconds** (45-60 minutes) and is **re-armed at every dispatch** —
this dispatch's `agent_dispatched_at` is what the 2x-heartbeat staleness check above measures
from, which is exactly what makes that threshold well-defined rather than a moving target.

Then dispatch **one** `drawbar-story-lead` agent (Opus). The brief must carry:

- the story id, full description, and acceptance criteria
- every `Locked` decision and `MUST-CHECK:` verbatim
- `$KB` (absolute), `$PROJECT_DIR`, `$REPO`, `$BASE_BRANCH`, and the branch name — prefer
  Linear's `gitBranchName` from `get_issue`, which guarantees the PR auto-links
- that it must **not** merge and has no Linear authority

It returns the JSON report in its §8: `{status, pr, branch, mutation_pairs, out_of_scope,
lessons, summary}`. **Do not ask it for the diff.** If you find yourself wanting one, the
split is not working.

`status: parked` → skip to *Parking a story*.

## 3. File out-of-scope findings as sub-issues

**Mandatory, not discretionary.** For each entry in `out_of_scope`, `save_issue` a new
sub-issue under the same parent: title naming the bug not the symptom; description with
file:line, what is wrong, why it is out of scope here, and the PR that surfaced it; status
`Unplanned`; label `found-in-review`. Never file it `Todo` — `Unplanned → Todo` is the human
triage gate, and this command has no authority to walk a finding through it unattended.

**Give every filed sub-issue a `## Dependencies` section**, stating `none — filed from review
of <PR>` when it has none. Step 0 halts on a snapshot member that carries no such section, and
a finding filed here becomes exactly that member once a human triages it `Unplanned → Todo`.
Omitting the section here is a halt on some later night, in a different command, with nothing
pointing back to this step.

Not added to the snapshot — they wait for the next run.

> The reviewer agents explicitly "return categorized findings; do not write to Linear," and
> the story-lead has no Linear tools. If you skip this, the finding dies with the session.

## 4. Open the stacked PR

The story-lead's own §6 already runs `gh pr create` against `$BASE_BRANCH` — the configured
base, correct only for the first story of a run. That call is a **transitional duplicate**:
this step opens the PR that actually anchors the stack, and the story-lead's own PR creation
is **removed entirely once R4 (PCO-367) lands**, closing this overlap for good.

This step resolves the base by delegating to `stack.ts` — never re-derived in bash — and
opens the PR with an explicit `--base <base>` flag; `--base` is never omitted (Locked A): the
default would silently fall back to the repo's default branch, producing a PR whose diff
carries every earlier story's work too — green, plausible, and near-impossible to spot in
the morning.

**Deliberately not specified here: the executable fence.** This section's stacked-PR-opening
logic — resolving the base, asserting chain integrity, and calling `gh pr create` — is
deferred to **PCO-370** and must land together with **R4 (PCO-367)**; nobody should hand-write
a substitute here in the meantime. Two reasons block it today: the story-lead currently cuts
every branch from `main`, so a recorded chain would refuse `branch_moved` from the third story
onward; and the story-lead still opens its own PR, so a second `gh pr create` here would
collide with it for story 1.

`FLAGGED` comes from the story-lead's §8 report `status` field — written against the `ok |
flagged` contract R4 (PCO-367) lands (today's story-lead still reports `ready_to_merge |
parked`; this step is already written against the contract its successor is landing). On a
**flagged** story, the PR body carries an `## Unresolved findings` section, built before
`gh pr create` runs, never appended after. That section names each out-of-scope finding by
its filed sub-issue id and title only — never the finding body, `file:line`, or a quoted
source excerpt; the full write-up already lives in the sub-issue §3 filed for it, and
republishing it in a public PR body announces an unpatched detail to every repo watcher
before the operator's morning review.

**These two outcomes differ in kind, not merely in degree — the header below names which one
you're in; never file this under one shared "satisfied if any of the following" list.**

**Outcome A — no PR could be opened (halt, distinct from flagged).** A refusal at any of the
three required checks — assert-chain refusing, resolve-base refusing, or `gh pr create`
itself failing — means the chain has no anchor to stack the next story on. This is never the
flagged case: go to *Parking a story*, with `parked_reason` naming which call refused.

**Outcome B — the PR opened.** Record `{story, branch, pr, base, flagged}` in the run state's
`stack` array — `pr` as a JSON number (a positive integer, never the string form) and
`flagged` as a JSON boolean — then continue to §5.

## 5. Post the summary comment, leave In Progress

Post a `save_comment` on the story: what shipped, the PR link, the stack position (this
story's place in the run's stack, e.g. "position 3 of the run, based on `<BASE>`"), the
sub-issues filed in §3, and the story-lead's `mutation_pairs`.

**Leave the story `In Progress`. No status transition of any kind** — never `Done`, `Ready
for QA`, `Ready for Rollout`, `Rolled Out`, or any completed-type status. The operator's own
review and merge is the only thing that ever moves it past `In Progress`; this step never
does.

## 6. Capture and sync knowledge

Inline KB writes made mid-run by the story-lead or implementer (`drawbar-kb add`) are **not**
waited for or batched here — they are already on disk by the time this step runs. This step
commits whatever is on disk (inline writes included) plus the report's own `lessons[]`,
tolerantly retries against a concurrent push, and halts loud on genuine exhaustion rather than
continuing silently (F8: the old loop's `break` fired only on success, so total failure once
printed nothing and execution continued anyway).

```bash
RESOLVED="<Preflight's resolved_config JSON>"     # separate Bash invocation from Preflight's — no shell state survives across tool calls, so re-declared
ENV_DIR=$(echo "$RESOLVED" | jq -r '.envDir // empty')
[ -n "$ENV_DIR" ] && [ "$ENV_DIR" != "null" ] || { echo "FATAL: ENV_DIR is empty or null after validation — refusing."; exit 1; }
KB="$ENV_DIR/.drawbar/memory"
: "${CLAUDE_PLUGIN_ROOT:?CLAUDE_PLUGIN_ROOT must be set}"
STORY="<TEAM>-####"      # the story this iteration shipped

# The report's `lessons` array, as JSON — the same shape `drawbar-kb add` accepts per entry,
# wrapped in {"lessons":[...]}. `kb-sync.ts` reconciles each one against whatever is already on
# disk by KEY, via store.ts's appendEntry — never re-derived or fought here.
LESSONS_JSON='{"lessons":<the report'"'"'s lessons array, JSON>}'

# Fail CLOSED on every one of: a non-zero exit from the module itself, or unparseable/empty
# stdout.
SYNC_JSON=$(echo "$LESSONS_JSON" | bun run "${CLAUDE_PLUGIN_ROOT}/scripts/lib/kb-sync.ts" sync \
              --env-dir "$ENV_DIR" --dir "$KB" --message "kb: $STORY sync")
SYNC_EXIT=$?
[ "$SYNC_EXIT" -eq 0 ] || { echo "REFUSING: kb-sync.ts sync exited $SYNC_EXIT — see stderr above ($SYNC_JSON)"; exit 1; }
SYNC_OK=$(echo "$SYNC_JSON" | jq -r 'if (type=="object" and has("ok")) then .ok else "unparseable" end' 2>/dev/null)
[ "$SYNC_OK" = "true" ] || { echo "REFUSING: kb-sync.ts sync was not ok ($SYNC_JSON)"; exit 1; }
```

`kb-sync.ts` owns the whole sequence — stage (both `knowledge.jsonl` and
`knowledge.archive.jsonl`), commit-if-staged, assert a clean precondition, rebase, push,
retry-only-on-a-genuine-rejection, and `reindex` **last**, only after a successful push
(`index.db` is gitignored and derived, and the rebase can bring in entries the local index has
never seen). A non-zero `duplicateKeys` on a successful sync is a benign union-merge artifact
of a concurrent supersede, not a failure — it is reported on stdout and warned on stderr, with
an ATTENDED `drawbar-kb compact` named as the remedy; see the module's own top-of-file comment
for the full reasoning. There is no second, hand-copied bash implementation of any of this here
(single-implementation-site regression discipline).

> **Never run `drawbar-kb archive` or `compact` here.** Both mutate the store with no
> confirmation and no output that reads as destructive; `recall` searches active entries
> only, so archived knowledge vanishes silently. A stray `archive` moved over a thousand
> entries out of reach in one command. `add` / `recall` / `reindex` only.

## 7. Advance

Append the story to `stories_done`. `in_flight` is **not** cleared here — §5 (post the
summary comment) does not clear it either; it is cleared only by *Parking a story* and
*Crash recovery* below. `PushNotification`
one line: story id, PR link, sub-issues filed. `ScheduleWakeup`
for the next story (under `/loop`), or report and finish.

## Parking a story

`status: parked`, a guard refusal, a blocked blocker, or any hard failure: leave the PR
open, leave the story `In Progress`, **clear `in_flight` in the state file** (`in_flight:
null` — Locked 13: a parked story is not an in-progress dispatch), `PushNotification` the
reason, and **`ScheduleWakeup({stop: true})`**.

**Halt — never skip.** Stories are dependency-ordered; building N+1 on a gap produces work
that looks like progress and is not.

## Crash recovery

The most likely overnight failure is not a clean halt — it is a dead session with a state
file present, a dirty tree, a branch mid-story, no PR, and no Linear comment. Preflight
must route here rather than dying. **A stale `in_flight`** (step 2's duplicate-dispatch
guard: `now - in_flight.agent_dispatched_at` exceeding 2x the heartbeat) **routes here too**
— that is Locked 13's whole point: a crashed run must not deadlock every later invocation by
leaving `in_flight` permanently "fresh" from a no-op's point of view.

1. **Read the state file** for the story that was in flight (`in_flight.story`, or — if
   `in_flight` is somehow already null — the last id not in `stories_done`).
2. **Read that story's Linear comments** — step 2's start comment names the branch and time.
3. **Establish where it got to**, in this order: is there an open PR for the branch? a
   pushed branch? local commits? only uncommitted changes? (The repo probe used here is a
   crash-recovery tool ONLY — it has a blind window between dispatch and first commit,
   demonstrated when it read "indistinguishable from never started" one minute after a live
   dispatch. Never use it to gate the fresh-in-window no-op check in step 2.)
4. **Resume at the earliest incomplete step.** Uncommitted work is *not* discarded — it is
   the crashed run's output. Commit it on the story branch first so it is inspectable, then
   re-dispatch the story-lead pointing at that branch, **re-writing `in_flight`** with the new
   dispatch time exactly as step 2 does for a fresh dispatch.
5. If the tree is dirty but the state file names **no** in-flight story, halt and notify —
   that is unexplained, and unexplained state is not something to resolve unattended.
6. If recovery instead determines the story is unrecoverable and must be halted outright,
   **clear `in_flight`** (`in_flight: null`) before halting — same as *Parking a story*.

> Discipline that makes this work: commit each verified increment (the story-lead's §2), and
> post the start comment *before* dispatching. A crashed run once left two hours of work as
> uncommitted files with no record of intent.

## Finishing the run

Snapshot exhausted: run **`/drawbar-learn`** once across the whole run for cross-story
curation, sync the KB as in step 6, `PushNotification` with parent id / PR links / parked,
then `ScheduleWakeup({stop: true})`.

## Hard rules

- Sequential. One story per invocation. Never parallel.
- Halt on failure; never skip a story.
- `--base` comes from `scripts/lib/stack.ts`'s `resolveBase`: the configured `baseBranch` for
  the first story of a run, the previous story's recorded branch for every story after that
  (Locked A). The run never merges.
- Never `--no-verify`, never force-push, never commit to `main` directly.
- **Never set `Done` / `Ready For QA` / `Ready for Rollout` / `Rolled Out`** — and never
  grant a subagent Linear authority.
- Never run `drawbar-kb archive` or `compact`.
- Filing out-of-scope findings as sub-issues is mandatory.
- Never accept a story whose `mutation_pairs` are empty.

## Operator notes

- **A config file must exist before running.** Copy `.drawbar/ship.config.example.json`,
  fill in real `envDir` / `projectDir` / `repo` / `team` / `baseBranch` /
  `requiredChecks` values, and either save it at `<cwd>/.drawbar/ship.config.json` or point
  `DRAWBAR_SHIP_CONFIG` at it. Preflight fails closed on a missing file, and
  `ship-config.ts` fails closed on every one of the four Locked-18 assertions (repo identity,
  `projectDir`/`envDir` separation, team resolution, `baseBranch` being
  the repo default) — a copied-but-unedited example is refused outright (see the
  `scaffolding` describe in `scripts/plugin.test.ts`).
- **The example config's placeholder values are deliberately invalid** — this repo is
  public, so a config that "just works" out of the box would be a one-file opt-in past the
  repo-identity containment the config exists to provide.
- Nothing in this command probes `$PWD` or a parent directory for `.drawbar/memory` or a
  project checkout — `$ENV_DIR`, `$PROJECT_DIR`, `$REPO`, `$BASE_BRANCH` and `$KB` all come
  from the validated config, resolved absolutely, regardless of the directory you run from.
- Code git work targets `$PROJECT_DIR`; the knowledge sync targets `$ENV_DIR`. Separate repos.
- **A real ship config must never be tracked by git** (Important 8, fix pass 2). Preflight
  refuses outright if `$CONFIG` is tracked in its own repository — the config now lives as a
  file inside a working directory rather than exported env vars, and any repository's tree
  (including a contributor PR) can otherwise plant one. Keep it untracked, as `.gitignore`
  already enforces for the default path.
- **Ship-config refusal text must be paraphrased, never pasted**, into a KB entry or a Linear
  comment. Refusal `detail` strings echo absolute paths and the real repo slug, and the
  slug leak-scan rule is deliberately out of scope for `knowledge.jsonl` (prose there produces
  too many false-positive "word / word" matches to allowlist) — pasting a refusal verbatim
  would leak it unscanned.
- Session must survive the night: `caffeinate -is`.
- Permissions must be pre-approved or the loop stalls until morning. Run
  `/fewer-permission-prompts` first.
- Cost: one story measured at ~840k subagent tokens (~270k test authoring, ~127k code
  review, ~115k security review, ~330k fix rounds). A 6–8 story night is several million.
- **Review depth is always full** — both reviewers, every story, no exceptions. This is a
  decision, not an oversight: reviewer cost scales with diff size, so a small story is
  already cheap, and the stories where a downgrade would save real money are exactly the
  large backend/security-touching ones that most need two independent lenses. Do not add a
  depth dial without a measured reason to.
