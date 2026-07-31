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
story N is based on story N−1's branch, which does not exist until N−1 has finished.

## The stack model

Each story becomes one pull request, and the pull requests form a **stack**: every PR is based
on the one before it, so each diff shows only its own story's changes and every branch is
buildable on its own. Stories are dependency-ordered, so this is required rather than
incidental — story N+1 generally does not compile against the configured base at all.

**How a base is chosen (Locked A).** The base is the configured `baseBranch` for the **first**
story of a run, and the **previous story's branch** for every story after it. Exactly one thing
produces that value — `scripts/lib/stack.ts`'s `resolve-base` verb, invoked in §4 — and it is
**never re-derived in bash**, never lifted out of the run-state file by hand, and never left to
a default. `resolve-base` is the only producer that shape-gates the branch name with
`isValidRefName`; the run state it reads is agent-writable, so a base copied straight out of
`stack[]` carries no validation at all. Omitting `--base` is the same failure from the other
side: `gh` would fall back to the repo's default branch, producing a PR whose diff carries every
earlier story's work too — green, plausible, and near-impossible to spot in the morning. The
story-lead is **handed** its base and cuts from it; it never resolves one.

**What `flagged` means.** A `flagged` story is one whose single fix pass left Important findings
alive. **The PR opens anyway**, annotated with an `## Unresolved findings` section, and **the
stack continues on top of it** — the next story is based on this story's branch exactly as if it
had come back clean. A story that is 90% right belongs in front of the operator at 8am,
annotated, rather than costing the rest of the night's throughput.

**"No PR could be opened" differs in kind from `flagged`, not in degree.** With no pull request
there is no branch for the next story to base on, so the chain has no anchor and the run
**parks and halts** (§4, Outcome A). Never collapse the two: `flagged` continues stacking, a
missing PR stops the night.

**The operator's contract in the morning: review bottom-up and merge bottom-up, in order.** The
stack was built bottom-up, so only the bottom PR's diff is meaningful against the configured
base; every PR above it is meaningful only once the one below has landed. Reviewing or merging
out of order reads a diff against a base that has moved.

**Locked F — `drawbar-ship` never merges, never verifies a merge, and never inspects whether one
happened.** Keeping the stack mergeable is the operator's job. **No detection or repair of
out-of-order merges exists or is planned** — that is a contract, not a gap awaiting a follow-up,
so do not file one for it. Building it back would re-introduce exactly the merge-state gating
this design deleted: nothing here can know whether a merge was clean or in order without the
gate that made the old design expensive and unwanted. If a stack does get merged out of order,
the recovery is a human rebase, and this command has no opinion about it.

## Preflight (halt on any failure)

> The config's validated `repo` identity below is what anchors every `gh` call at the right
> target; this repo is public, so treat that identity as accident containment, not a security
> boundary.

```bash
command -v drawbar-kb >/dev/null || { echo "no drawbar-kb — run /drawbar-setup"; exit 1; }
command -v gh        >/dev/null && gh auth status >/dev/null 2>&1 || { echo "gh not authed"; exit 1; }

# A WARNING, never an exit: a brief-sourced review is degraded but honest, and it is reported as such.
# Unattended, the operator's only signal is this line — without it "every story is flagged because
# this machine has no CLI" and "every story is flagged because every story has caveats" print the
# same run output, and the first is a machine problem nobody will look for.
command -v linear >/dev/null 2>&1 || echo "WARNING: no \`linear\` CLI — every review will report spec_source: \"brief\" and no story can come back clean"

# MUST-CHECK repo-anchor-guard-is-what-gates-an-unfixed-vulnerability: fail closed if the
# plugin root isn't set — nothing below can find ship-config.ts without it. Every later fence
# in THIS file (§4 and §6) re-declares this same guard, because no shell state survives across
# two Bash tool calls. The story-lead runs no such guard — it is handed absolute paths and
# invokes no plugin script — so do not cross-reference it here.
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
# A committed DIRECTORY SYMLINK would otherwise defeat this refusal outright: `git -C` chdirs
# THROUGH the symlink, git's cwd becomes the link target, and the absolute pathspec then matches
# nothing in the index (which knows the real path), so `--error-unmatch` exits 1 and the guard
# reads "not tracked" for a config the branch under review has committed. Resolve every
# symlinked component first and ask git about the real path.
CONFIG_REAL=$(readlink -f "$CONFIG") || { echo "FATAL: cannot resolve $CONFIG to a real path — refusing."; exit 1; }
git -C "$(dirname "$CONFIG_REAL")" ls-files --error-unmatch "$CONFIG_REAL" >/dev/null 2>&1 \
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
# `--config-path` is REQUIRED and is the TRUST ROOT for `--env-dir`: kb-sync.ts re-reads the
# operator-authored config itself (via ship-config.ts's `parseShipConfig`) and refuses unless
# the config's `envDir` equals the `--env-dir` it was handed — so a wrong or planted `$ENV_DIR`
# cannot reach a single `git -C` call. It also pins WHICH file may vouch (the one this
# environment's own `$DRAWBAR_SHIP_CONFIG`/`$PWD` resolve to) and re-runs the tracked-config
# refusal above with its own injected runner, so naming a planted config as its own trust root is
# refused too. `$CONFIG_REAL` (not `$CONFIG`) is passed because the flag requires a clean absolute
# path and `DRAWBAR_SHIP_CONFIG` may legitimately be relative; the module compares the two
# symlink-resolved, so both forms agree.
bun run "${CLAUDE_PLUGIN_ROOT}/scripts/lib/kb-sync.ts" preflight --env-dir "$ENV_DIR" --dir "$KB" \
    --config-path "$CONFIG_REAL" \
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

It returns the JSON report in its §7: `{status, branch, base, spec_source, reviewed_sha, head_sha,
findings, dedup, mutation_pairs, out_of_scope, lessons, summary}`. It carries no `pr` — it opens none; §4 below is what opens
the PR and learns its number. **Do not ask it for the diff.** If you find yourself wanting
one, the split is not working.

`status: parked` → skip to *Parking a story*.

## 3. File out-of-scope findings as sub-issues

**Search the parent's existing children before you file anything.** `list_issues` with the story's
parent as `parentId`, then match every `out_of_scope` and every `findings[]` entry against those
children on `dedup_key`: a child whose body carries the same `claim_hash` is the same defect already
filed from an earlier story's review, and so is a child carrying the same `file` and the same `line`
under a claim that restates it. A defect re-found by a later story is not new work — one story
re-found a defect an earlier story had already filed, and it was filed a second time.

- **On a match, `save_comment` on the existing sub-issue and file nothing new.** The comment names
  the story that re-found it, which reviewer reported it, and this story's branch — that naming is
  the point, because an uncommented match leaves the earlier sub-issue looking stale rather than
  re-confirmed. A second sub-issue for one defect splits the discussion across two ids and gets
  triaged as new work.
- **On no match, file it** under the rules below, and put the finding's `dedup_key` in the body.
  That key is what the next run matches against; a body without one is unmatchable forever after,
  and the search above degrades to nothing for every story that follows.

**Print every match and every suppression in the run output**, one line each: the `dedup_key`, the
sub-issue id it resolved to, and whether you commented or filed. The story-lead's own `dedup` array
is printed here too, so a finding the two reviewers both raised and the story-lead collapsed into
one is visible as a collapse rather than as a finding that went missing. **Nothing is dropped
silently** — a suppression nobody can see is indistinguishable from a finding that was never
reported.

**Mandatory, not discretionary.** For each entry in `out_of_scope`, `save_issue` a new
sub-issue under the same parent: title naming the bug not the symptom; description with
file:line, what is wrong, why it is out of scope here, and the PR that surfaced it; status
`Unplanned`; label `found-in-review`. Never file it `Todo` — `Unplanned → Todo` is the human
triage gate, and this command has no authority to walk a finding through it unattended.

**File one sub-issue for every surviving `findings[]` entry too**, under the same rules —
status `Unplanned`, label `found-in-review`, a `## Dependencies` section — and record its id
alongside the `out_of_scope` ones. `findings[]` carries the Critical and Important findings
that outlived the story-lead's one fix pass, unfixed **security** findings included, and §4's
`## Unresolved findings` section is allowed to name a finding by sub-issue id and title only:
with no sub-issue filed here there is no id for §4 to render, so a flagged story's surviving
findings would be unpublishable and would die with the session exactly as an unfiled
`out_of_scope` entry does. Put the finding's `detail` in the sub-issue body — a Linear issue
is not world-readable the way the pull request is, which is the whole reason the split exists.

**The title of every sub-issue filed here carries no `file:line`, no path, and no quoted
source** — those go in the body only, and this rule outranks any wording that reads as
encouraging them, because §4 publishes the title verbatim in a public PR body while forbidding
exactly those three things there. A title like "path traversal in `scripts/lib/stack.ts:165`"
satisfies "name the bug not the symptom" and still announces an unpatched detail to every repo
watcher; name the bug and its component instead.

**Give every filed sub-issue a `## Dependencies` section**, stating `none — filed from review
of <PR>` when it has none. Step 0 halts on a snapshot member that carries no such section, and
a finding filed here becomes exactly that member once a human triages it `Unplanned → Todo`.
Omitting the section here is a halt on some later night, in a different command, with nothing
pointing back to this step.

Not added to the snapshot — they wait for the next run.

> The reviewer agents explicitly "return categorized findings; do not write to Linear," and
> the story-lead has no Linear tools. If you skip this, the finding dies with the session.

## 4. Open the stacked PR

**This step is the only thing in the whole run that opens a pull request.** The story-lead's
own §6 pushes its branch and stops there — it opens none. Were both to open one, they would
submit the identical head+base pair on the run's first story, GitHub would refuse the second
with a 422, and the run would park on story 1 every night.

This step resolves the base by delegating to `stack.ts` — never re-derived in bash — and
opens the PR with an explicit `--base <base>` flag; `--base` is never omitted (Locked A): the
default would silently fall back to the repo's default branch, producing a PR whose diff
carries every earlier story's work too — green, plausible, and near-impossible to spot in
the morning.

`FLAGGED` comes from the story-lead's §7 report `status` field, on the `ok | flagged`
contract: `flagged` becomes the JSON boolean `true`, `ok` becomes `false` — a `parked` story
never reaches this step at all, because §2 routes it straight to *Parking a story*. On a
**flagged** story, the PR body carries an `## Unresolved findings` section, built before
`gh pr create` runs, never appended after. That section names each surviving finding by
its filed sub-issue id and title only — never the finding body, `file:line`, a finding's
`dedup_key` or any of its `file` / `line` / `claim_hash` fields, or a quoted source excerpt;
the full write-up already lives in the sub-issue §3 filed for it, and republishing it in a
public PR body announces an unpatched detail to every repo watcher before the operator's
morning review. The `dedup_key` is named here beside `file:line` because it is the same
location in structured form: a serializer that drops `detail` and emits the key has published
the location anyway, and a ban worded against one spelling is not a ban on the field.

**Every PR body opens with a review-provenance line, on a flagged story and a clean one alike**,
built before `gh pr create` runs: `reviewed at <reviewed_sha> from <spec_source>; N commits since`,
where `<reviewed_sha>` is what the reviewers read, `<spec_source>` is `cli` or `brief` — the source
that review actually read the spec from — and `N` is the commit count between the sha and the
story-lead's `head_sha`, all three taken from that report. The fix pass commits after the reviewers
read the diff, so every review is stale by construction and `N` is normally non-zero; stating it is
the whole point, and no second review round closes it. **State `N` even when it is zero** — an
omitted line reads exactly like a review that was never stale, which is the claim this line exists
to stop anyone making. **State `<spec_source>` even when it is `cli`** — a review that never reached
Linear is blind to an AMENDED banner, a superseded section and a struck decision, and on this
unattended path the PR body is the only place a reader can find that out; printing it only when it
is `brief` makes its absence the signal, and an absence is what nobody notices at 3am.

**Shape-check both shas before you build that line, and park the story if either refuses.**
`reviewed_sha` and `head_sha` reach you as free text from a subagent that read a branch under
review, and the story-lead's contract copies them through verbatim — nothing between there and here
has looked at them. Each must match `^[0-9a-f]{40}$`, and each must resolve in the repository this PR opens
against: `git -C "$PROJECT_DIR" cat-file -e "<sha>^{commit}"`. `N` is then
`git -C "$PROJECT_DIR" rev-list --count "<reviewed_sha>..<head_sha>"`, anchored the same way and
never derived from whatever branch happens to be checked out. A sha that is malformed, or that does
not resolve here, parks the story with that as the reason — it attests to a tree this repository
does not have, and a foreign 40-hex sha is shape-identical to a real one once it is in the PR body.
Where the two reviewers read different shas, name both, one line each.

**Nothing carries over into the fence below.** No shell state survives across two Bash tool
calls, so every value it consumes is re-derived inside it from one source of truth — a fresh
`ship-config.ts validate`, behind the same two `$CONFIG` guards Preflight runs, because
`$CONFIG` is re-resolved from `$PWD` and a branch under review can plant one. An ambient
exported `REPO` would otherwise win and aim every `gh` call at an unvalidated repository, and
an empty `$BASE` yields `--base ""`, which is Locked A's exact failure mode.

**Every value you substitute goes into a quoted heredoc, never into an assignment.** The
branch name, the PR title and the PR body all originate in text produced from the repository
under review, and you paste them in literally — so a single `"` would close a double-quoted
assignment and the `$(...)` after it would run. Inside `<<'SENTINEL'` nothing expands and
nothing executes; the fence reads the values back out with `jq -r` and `cat`.

**Before you substitute anything, check every value for a line equal to the terminator you
are pasting it under, and halt the run if you find one** — park the story with that as the
reason, and never rewrite, escape, or truncate the value to make it fit. A quoted heredoc
protects the value's `"`, `$` and backticks, but it still ends at the first line equal to its
terminator, and these terminators are fixed literals published in this repository: a report
line reading exactly `DRAWBAR_PR_BODY_SENTINEL` closes the body heredoc early and every line
after it is parsed as shell — arbitrary command execution under the operator's authenticated
`gh`, with the written file left looking entirely correct. A check inside the fence cannot
save you here: by the time any line of it runs, the injected commands have already run.

**No value that came out of the repository under review is ever pasted into a JSON document.**
The branch name gets its own heredoc file and is read back with `cat`, because a `"` in a value
pasted between two `"` inside the inputs document does not produce invalid JSON that `jq -e .`
would refuse — it appends keys, and `jq` resolves duplicate keys last-wins, so it silently
overrides any key declared above it (`arg` names the state file, `story` picks the base). Both
shape gates then pass, because they see only the laundered values. A key whitelist is not a
defence: the injected document has exactly the same key set.

```bash
: "${CLAUDE_PLUGIN_ROOT:?CLAUDE_PLUGIN_ROOT must be set}"

# EVERY agent-substituted value enters through the four QUOTED heredocs below and nowhere
# else — this is the explicit-assignment convention §6 uses for $LESSONS_JSON, hardened.
# Substituted into an ordinary double-quoted assignment, one `"` in report text closes the
# string and `$(...)`/backticks then execute; even single quotes only move the problem to `'`.
# The branch name, the title and the body all derive from the repository under review, so
# nothing here is assigned by interpolation at all: inside a QUOTED heredoc (`<<'SENTINEL'`)
# nothing expands and no command runs, and the values are read back out with `jq -r` / `cat`,
# never eval'd. A value consumed but never bound would merely halt the run every night; a
# value bound by interpolation is arbitrary code execution. The one thing a quoted heredoc does
# NOT protect against is a substituted line equal to the terminator itself — that closes the
# heredoc and the rest is parsed as shell, so the halt instruction above this fence is part of
# the guarantee, not an aside, and no check placed here could replace it.
# `mktemp -d` and not a fixed path: the four `cat >` redirects below follow symlinks, so a
# guessable directory lets a local user pre-plant one and have this fence truncate an arbitrary
# file — and substitute the body it then hands to `gh --body-file`.
IN_DIR=$(mktemp -d) || { echo "FATAL: mktemp -d failed — refusing."; exit 1; }
INPUTS="${IN_DIR}/inputs.json"
BRANCH_FILE="${IN_DIR}/branch"
PR_TITLE_FILE="${IN_DIR}/title"
PR_BODY_FILE="${IN_DIR}/body"

# `branch` is NOT a key in this document: it derives from the repository under review, and a `"`
# in a value pasted between two `"` here appends keys rather than breaking the parse — jq takes
# the LAST of a duplicate key, so an injected `"arg"`/`"story"` silently wins and aims $STATE,
# assert-chain and resolve-base at a different run. Only values the repository under review
# cannot author live in here.
cat > "$INPUTS" <<'DRAWBAR_INPUTS_SENTINEL'
{
  "arg":     "<the id THIS RUN was invoked with — it names the state file>",
  "story":   "<TEAM>-####",
  "teams":   <the list_teams result for this session, as a JSON array>,
  "flagged": <the report `status`: flagged -> true, ok -> false; a JSON boolean, never a string>
}
DRAWBAR_INPUTS_SENTINEL

cat > "$BRANCH_FILE" <<'DRAWBAR_BRANCH_SENTINEL'
<the story-lead report's `branch` field, verbatim, one line — nothing here expands>
DRAWBAR_BRANCH_SENTINEL

cat > "$PR_TITLE_FILE" <<'DRAWBAR_PR_TITLE_SENTINEL'
<the PR title, one line, verbatim — nothing here expands>
DRAWBAR_PR_TITLE_SENTINEL

cat > "$PR_BODY_FILE" <<'DRAWBAR_PR_BODY_SENTINEL'
<the PR body, verbatim — nothing here expands. Its first line is the review-provenance line
`reviewed at <reviewed_sha> from <spec_source>; N commits since`, with both shas already
shape-checked and resolved per the prose above. On a flagged story it is written out here with
its `## Unresolved findings` section already in it, listing each surviving finding as
`<SUB-ISSUE-ID> — <sub-issue title>` and nothing else: never the finding body, never a
`file:line`, never a `dedup_key` or any of its fields, never a quoted source excerpt.>
DRAWBAR_PR_BODY_SENTINEL

# --- read the substituted inputs ------------------------------------------------------------
jq -e . "$INPUTS" >/dev/null 2>&1 || { echo "FATAL: the inputs heredoc is not valid JSON — refusing."; exit 1; }
ARG=$(jq -r '.arg // empty' "$INPUTS")
STORY=$(jq -r '.story // empty' "$INPUTS")
# Read from its OWN file, never out of the inputs document: nothing about this value's text can
# reach a JSON key, and its emptiness is refused by the ref-name shape gate below.
BRANCH=$(cat "$BRANCH_FILE")
# `flagged` and `teams` are TYPE-checked at the source, not merely non-empty: `flagged` reaches
# `jq --argjson` below, where the string "true" would produce the string "true" in the stack
# entry and `isValidStackEntry` demands a strict boolean.
FLAGGED=$(jq -r 'if (.flagged|type)=="boolean" then (.flagged|tostring) else empty end' "$INPUTS")
LINEAR_FACTS_JSON=$(jq -c 'if (.teams|type)=="array" then {teams:.teams} else empty end' "$INPUTS")
for v in ARG STORY FLAGGED LINEAR_FACTS_JSON; do
  val="${!v}"
  [ -n "$val" ] && [ "$val" != "null" ] || { echo "FATAL: $v is empty, null, or the wrong JSON type in the inputs heredoc — refusing."; exit 1; }
done
# --- end read the substituted inputs --------------------------------------------------------

# $ARG is interpolated into the state-file path, so it must be a single safe path segment —
# the same shape run-state.ts's `isSafePathSegment` enforces on the value it round-trips.
case "$ARG" in ''|*/*|*'\'*|*..*) echo "FATAL: ARG is not a safe path segment — refusing."; exit 1;; esac

# --- branch ref-name shape gate ------------------------------------------------------------
# $BRANCH comes from an agent report and reaches `--head` and the stack entry. Gated HERE, at
# the top, before it can reach either. Mirrors ship-config.ts's REF_NAME_SHAPE plus its `.lock`
# refusal — i.e. exactly what run-state.ts's `isValidStackEntry` re-applies to the entry
# written below, so a branch that would brick the state file is refused before a PR is ever
# opened for it. `[[ =~ ]]` and not a `grep` pipeline: grep matches LINE by line, so a BRANCH
# carrying an embedded newline would satisfy it twice over while `isValidRefName` refuses that
# same value. `LC_ALL=C` inside the subshell keeps `A-Za-z0-9` byte ranges rather than locale
# collation ranges. (The `/` is written FIRST inside the bracket expression on purpose: this
# file is scanned for concrete GitHub org-and-repo slugs, and a slash between two word
# characters reads as one.)
( LC_ALL=C; [[ "$BRANCH" =~ ^[A-Za-z0-9][/A-Za-z0-9._-]*$ ]] ) || { echo "FATAL: BRANCH is not a valid git ref name — refusing."; exit 1; }
case "$BRANCH" in *..*|*"@{"*|*.lock) echo "FATAL: BRANCH is not a valid git ref name — refusing."; exit 1;; esac
# --- end branch ref-name shape gate ---------------------------------------------------------

# $CONFIG is re-resolved from $PWD here, so BOTH of Preflight's guards run again, verbatim.
# Dropping them lets a branch under review plant `.drawbar/ship.config.json` and feed its own
# `projectDir` into `--project-dir` and `git -C`; an equality guard does not help, because both
# sides then agree — on the attacker's directory. (The tracked-config refusal keeps Preflight's
# `&& { ... } || true` shape deliberately: it is the same guard, not a reworded copy of it, and
# it is asked about the symlink-resolved path for the reason Preflight's copy spells out.)
CONFIG="${DRAWBAR_SHIP_CONFIG:-$PWD/.drawbar/ship.config.json}"
[ -f "$CONFIG" ] || { echo "FATAL: no config at $CONFIG — copy .drawbar/ship.config.example.json, fill in real values, and either place the copy there or set DRAWBAR_SHIP_CONFIG to point at it."; exit 1; }
CONFIG_REAL=$(readlink -f "$CONFIG") || { echo "FATAL: cannot resolve $CONFIG to a real path — refusing."; exit 1; }
git -C "$(dirname "$CONFIG_REAL")" ls-files --error-unmatch "$CONFIG_REAL" >/dev/null 2>&1 \
  && { echo "FATAL: $CONFIG is tracked by git — a committed ship config is never trusted. Untrack it (git rm --cached) and keep it out of version control."; exit 1; } \
  || true

# MUST-CHECK r3-must-not-source-project-dir-from-pasted-run-state: the trust root is this FRESH
# validate, run in this block. Never `jq '.resolved_config' "$STATE"` and never anything else
# read out of `runs/` — the state file is agent-writable, and a `--project-dir` taken from it
# turns stack.ts's equality guard into a tautology about the attacker's own directory.
RESOLVED=$(echo "$LINEAR_FACTS_JSON" | bun run "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ship-config.ts" validate --config "$CONFIG") \
  || { echo "FATAL: ship-config validation refused — see stderr above for the specific reason."; exit 1; }

# --- derive from the resolved config (§4) --------------------------------------------------
ENV_DIR=$(echo "$RESOLVED" | jq -r '.envDir // empty')
PROJECT_DIR=$(echo "$RESOLVED" | jq -r '.projectDir // empty')
REPO=$(echo "$RESOLVED" | jq -r '.repo // empty')
for v in ENV_DIR PROJECT_DIR REPO; do
  val="${!v}"
  [ -n "$val" ] && [ "$val" != "null" ] || { echo "FATAL: $v is empty or null after validation — refusing."; exit 1; }
done
# --- end derive from the resolved config (§4) ----------------------------------------------
STATE="$ENV_DIR/.drawbar/runs/$ARG.json"

# Check 1 of 3 — chain integrity. `--project-dir` is the operator-authored trust root, taken
# from the fresh validate above, never from the state file's own `resolved_config` copy.
CHAIN_JSON=$(bun run "${CLAUDE_PLUGIN_ROOT}/scripts/lib/stack.ts" assert-chain --state "$STATE" --project-dir "$PROJECT_DIR")
CHAIN_OK=$(printf '%s' "${CHAIN_JSON:-null}" | jq -r 'if (type=="object" and .ok==true) then "true" else "false" end' 2>/dev/null)
# Echo the verdict's `.reason` and NOTHING else. `.detail` carries absolute paths and the real
# repo slug, this repo is public, and the Hard rules require refusal text be paraphrased rather
# than pasted into `parked_reason`, the §5 comment, or a KB entry.
[ "$CHAIN_OK" = "true" ] || { CHAIN_REASON=$(printf '%s' "${CHAIN_JSON:-null}" | jq -r '.reason // "unreadable-verdict"' 2>/dev/null); echo "NO_PR: assert-chain refused ($CHAIN_REASON) — park the story; paraphrase, never paste, the detail on stderr."; exit 1; }

# Check 2 of 3 — the base. Locked A: `resolve-base` is the only producer of this value.
BASE_JSON=$(bun run "${CLAUDE_PLUGIN_ROOT}/scripts/lib/stack.ts" resolve-base --state "$STATE" --story "$STORY")
BASE=$(printf '%s' "${BASE_JSON:-null}" | jq -r 'if (type=="object" and .ok==true) then .base else empty end' 2>/dev/null)
[ -n "$BASE" ] && [ "$BASE" != "null" ] || { BASE_REASON=$(printf '%s' "${BASE_JSON:-null}" | jq -r '.reason // "unreadable-verdict"' 2>/dev/null); echo "NO_PR: resolve-base refused ($BASE_REASON) — park the story; paraphrase, never paste, the detail on stderr."; exit 1; }

# Check 3 of 3 — open it. `--title` reads the file at RUNTIME as one quoted argument and
# `--body-file` reads it inside `gh`, so no report text is ever part of this command line.
PR_URL=$(gh pr create --repo "$REPO" --base "$BASE" --head "$BRANCH" --title "$(cat "$PR_TITLE_FILE")" --body-file "$PR_BODY_FILE") \
  || { echo "NO_PR: gh pr create failed — park the story; paraphrase, never paste, the detail on stderr."; exit 1; }

# --- pr number shape gate --------------------------------------------------------------------
# Never `basename "$PR_URL"`: unvalidated, and `isValidStackEntry` requires a positive INTEGER.
PR=$(gh pr view "$PR_URL" --repo "$REPO" --json number -q .number) || { echo "PR_UNRECORDED: gh pr create left no readable PR number — the PR is open; park the story with that reason (Outcome C) and repair the run state by hand."; exit 1; }
case "$PR" in ''|*[!0-9]*) echo "PR_UNRECORDED: PR number is not digits-only — the PR is open; park the story with that reason (Outcome C) and repair the run state by hand."; exit 1;; esac
[ "$PR" -gt 0 ] || { echo "PR_UNRECORDED: PR number is not a positive integer — the PR is open; park the story with that reason (Outcome C) and repair the run state by hand."; exit 1; }
# --- end pr number shape gate -----------------------------------------------------------------

# --- stack entry -------------------------------------------------------------------------------
# run-state.ts's `isValidStackEntry` requires `pr` to be a positive integer and `flagged` a
# strict boolean. Bash produces strings, and a string in either field makes `parseRunState`
# reject the WHOLE file on the next read — stack.ts then writes its usage error to stderr with
# EMPTY stdout, so the operator sees a bare `refused ()` and the state file is permanently
# unreadable by its own tooling. Hence `--argjson` for those two, never `--arg`.
case "$FLAGGED" in true|false) ;; *) echo "PR_UNRECORDED: FLAGGED must be the JSON literal true or false — the PR is open; park the story with that reason (Outcome C) and repair the run state by hand."; exit 1;; esac
ENTRY=$(jq -nc --arg story "$STORY" --arg branch "$BRANCH" --argjson pr "$PR" --arg base "$BASE" --argjson flagged "$FLAGGED" '{story:$story,branch:$branch,pr:$pr,base:$base,flagged:$flagged}') || { echo "PR_UNRECORDED: could not build the stack entry — the PR is open; park the story with that reason (Outcome C) and repair the run state by hand."; exit 1; }
# --- end stack entry ----------------------------------------------------------------------------

NEXT_STATE=$(jq -c --argjson entry "$ENTRY" '.stack += [$entry]' "$STATE") || { echo "PR_UNRECORDED: could not append the stack entry to the run state — the PR is open; park the story with that reason (Outcome C) and repair the run state by hand."; exit 1; }
printf '%s\n' "$NEXT_STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE" || { echo "PR_UNRECORDED: could not write the run state — the PR is open; park the story with that reason (Outcome C) and repair the run state by hand."; exit 1; }

# Round-trip what was just written through `parseRunState` — `assert-chain` parses the state
# with it and re-verifies the chain including the entry appended above. A wrong JSON type is
# caught HERE, in the step that wrote it, instead of bricking every later read.
VERIFY_JSON=$(bun run "${CLAUDE_PLUGIN_ROOT}/scripts/lib/stack.ts" assert-chain --state "$STATE" --project-dir "$PROJECT_DIR")
VERIFY_OK=$(printf '%s' "${VERIFY_JSON:-null}" | jq -r 'if (type=="object" and .ok==true) then "true" else "false" end' 2>/dev/null)
[ "$VERIFY_OK" = "true" ] || { VERIFY_REASON=$(printf '%s' "${VERIFY_JSON:-null}" | jq -r '.reason // "unreadable-verdict"' 2>/dev/null); echo "PR_UNRECORDED: the recorded stack entry did not round-trip ($VERIFY_REASON) — the PR is open; park the story with that reason (Outcome C) and repair the run state by hand."; exit 1; }

echo "PR_OPENED: $PR_URL (base $BASE)"
```

**These three outcomes differ in kind, not merely in degree — the header below names which one
you're in; never file this under one shared "satisfied if any of the following" list.** Each
one has its own prefix in the fence's output, and every refusal carries exactly one of them:
`NO_PR:` is Outcome A, `PR_UNRECORDED:` is Outcome C, `PR_OPENED:` is Outcome B.

**Outcome A — no PR could be opened (halt, distinct from flagged).** A refusal at any of the
three required checks — assert-chain refusing, resolve-base refusing, or `gh pr create`
itself failing — means the chain has no anchor to stack the next story on. This is never the
flagged case: go to *Parking a story*, with `parked_reason` naming which call refused.

**Outcome B — the PR opened.** Record `{story, branch, pr, base, flagged}` in the run state's
`stack` array — `pr` as a JSON number (a positive integer, never the string form) and
`flagged` as a JSON boolean — which is what the fence's `jq --argjson` builds and what its
closing `assert-chain` re-read proves round-trips, then continue to §5.

**Outcome C — the PR opened but the run state does not record it (halt).** Every refusal after
`gh pr create` returns — an unreadable or non-integer PR number, a `FLAGGED` that is not a JSON
literal, an entry that cannot be built, appended, or written, or a round-trip that fails — is
prefixed `PR_UNRECORDED:` and leaves a real pull request open with nothing in the `stack` array
pointing at it. It is not Outcome A: no `NO_PR:` line is printed, because a PR exists. Go to
*Parking a story*, and make `parked_reason` say that the PR is open and unrecorded, with its
URL. **Never re-run this step for that story** — the identical head+base pair is exactly the
422 collision this section's opening paragraph warns about — and never hand-edit the `stack`
array during the run: the repair belongs to the operator's morning review.

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
: "${CLAUDE_PLUGIN_ROOT:?CLAUDE_PLUGIN_ROOT must be set}"

# --- the trust root, re-derived here (separate Bash invocation from Preflight's — no shell
# --- state survives across tool calls, so $CONFIG must be re-declared, not remembered) -------
#
# $CONFIG is re-resolved from $PWD here, so BOTH of Preflight's guards run again, verbatim —
# MUST-CHECK cross-invocation-guard-applies-per-variable-not-per-fence: the re-declare-AND-assert
# discipline applies to every variable a later fence re-derives, and $CONFIG's assertion IS the
# tracked-config refusal. §6 runs AFTER §4/§5's branch work, so "Preflight already checked" does
# not cover a `.drawbar/ship.config.json` that appears mid-run, and this fence's $PWD need not be
# Preflight's. Dropping the guards lets a branch under review plant a config and feed its own
# `envDir` into `--env-dir` and `git -C`; an equality guard does not help, because both sides then
# agree — on the attacker's directory. (The tracked-config refusal keeps Preflight's
# `&& { ... } || true` shape deliberately: it is the same guard, not a reworded copy of it, and it
# is asked about the symlink-resolved path for the reason Preflight's copy spells out.)
#
# Cross-reference: this fallback duplicates ship-config.ts's `resolveConfigPath` and Preflight's
# own copy of it — keep all three in sync if the default location or the env-var name changes.
# If DRAWBAR_SHIP_CONFIG is used at all it must be EXPORTED, not merely set in this fence:
# kb-sync.ts re-derives the same default from the environment IT inherits and refuses a
# `--config-path` that disagrees.
CONFIG="${DRAWBAR_SHIP_CONFIG:-$PWD/.drawbar/ship.config.json}"
[ -f "$CONFIG" ] || { echo "FATAL: no config at $CONFIG — copy .drawbar/ship.config.example.json, fill in real values, and either place the copy there or set DRAWBAR_SHIP_CONFIG to point at it."; exit 1; }
CONFIG_REAL=$(readlink -f "$CONFIG") || { echo "FATAL: cannot resolve $CONFIG to a real path — refusing."; exit 1; }
git -C "$(dirname "$CONFIG_REAL")" ls-files --error-unmatch "$CONFIG_REAL" >/dev/null 2>&1 \
  && { echo "FATAL: $CONFIG is tracked by git — a committed ship config is never trusted. Untrack it (git rm --cached) and keep it out of version control."; exit 1; } \
  || true

RESOLVED="<Preflight's resolved_config JSON>"     # re-declared for the same reason
ENV_DIR=$(echo "$RESOLVED" | jq -r '.envDir // empty')
[ -n "$ENV_DIR" ] && [ "$ENV_DIR" != "null" ] || { echo "FATAL: ENV_DIR is empty or null after validation — refusing."; exit 1; }
# The non-emptiness check above is a typo guard, NOT a security boundary, and this fence no
# longer pretends otherwise. `$RESOLVED` is a prose placeholder THIS MODEL fills in from its own
# context, so `$ENV_DIR` is agent-held mutable state, and it reaches `git -C` inside kb-sync.ts —
# an arbitrary-code-execution sink (git reads the named directory's own repository config, which
# supplies `core.sshCommand` on a pull and a `reference-transaction` hook on a successful push). What
# actually contains that is `--config-path` below: kb-sync.ts parses $CONFIG_REAL with
# ship-config.ts's `parseShipConfig` and REFUSES unless the config's `envDir` equals the
# `--env-dir` it was handed. That equality is only worth anything because the module also pins
# WHICH file may vouch — it must be the one this environment's own $DRAWBAR_SHIP_CONFIG/$PWD
# resolve to, and it must not be tracked by git — so naming a planted config as its own trust root
# no longer works. The guards above are this fence's half of that: they refuse a tracked config
# before it is ever passed, and they are the reason a `--config-path` reaching the module has
# already been checked twice.
KB="$ENV_DIR/.drawbar/memory"
STORY="<TEAM>-####"      # the story this iteration shipped

# The report's `lessons` array, as JSON — the same shape `drawbar-kb add` accepts per entry,
# wrapped in {"lessons":[...]}. `kb-sync.ts` reconciles each one against whatever is already on
# disk by KEY, via store.ts's appendEntry — never re-derived or fought here.
LESSONS_JSON='{"lessons":<the report'"'"'s lessons array, JSON>}'

# Fail CLOSED on every one of: a non-zero exit from the module itself, or unparseable/empty
# stdout.
SYNC_JSON=$(echo "$LESSONS_JSON" | bun run "${CLAUDE_PLUGIN_ROOT}/scripts/lib/kb-sync.ts" sync \
              --env-dir "$ENV_DIR" --dir "$KB" --message "kb: $STORY sync" \
              --config-path "$CONFIG_REAL")
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

**Recovery re-establishes the stack base, not merely the in-flight story.** That is the
responsibility this section gained with the stack: a resumed run that resolves the wrong base
opens a pull request whose diff carries another story's work — green, plausible, and
near-impossible to spot in the morning. It is the one crash-resume failure that produces no
error at all, which is exactly why the base is re-established by `stack.ts` and confirmed before
anything is re-dispatched, never inferred from the branch that happens to be checked out.

1. **Read the state file** for the story that was in flight (`in_flight.story`, or — if
   `in_flight` is somehow already null — the last id not in `stories_done`).
2. **Read that story's Linear comments** — step 2's start comment names the branch and time.
3. **Establish where it got to**, in this order: is there an open PR for the branch? a
   pushed branch? local commits? only uncommitted changes? (The repo probe used here is a
   crash-recovery tool ONLY — it has a blind window between dispatch and first commit,
   demonstrated when it read "indistinguishable from never started" one minute after a live
   dispatch. Never use it to gate the fresh-in-window no-op check in step 2.)
4. **Re-establish the base before re-dispatching anything.** One state skips this step: if step
   3 found the PR already open **and** the `stack` array already records this story, the
   PR-opening step completed and only the tail of the run was lost. That state is correct, not
   broken — resolve **no** new base for it, and resume at §5 (post the summary comment).
   `resolve-base` refuses `story_already_stacked` for exactly that state, and that one reason
   means "already stacked", never "park". Every other resume re-establishes the base *here*,
   through the fence below, never from the branch that happens to be checked out and never
   re-derived in bash: `stack.ts assert-chain` confirms every recorded predecessor branch still
   exists and still points where the `stack` array says, then a fresh `stack.ts resolve-base`
   produces the base for this story. Any other refusal from either call **parks the story**:
   refuse rather than guess, because guessing here is what silently re-parents the story onto
   another story's work. Echo each verdict's `.reason` and nothing else — paraphrase, never
   paste, a `detail`.

   **`--project-dir` is a trust root, and this fence is the only sanctioned way to produce one.**
   MUST-CHECK `r3-must-not-source-project-dir-from-pasted-run-state`: the value handed to
   `--project-dir` comes from the fresh `ship-config.ts validate` inside this block and from
   nowhere else — never `jq '.resolved_config' "$STATE"`, and never the `resolved_config` that
   step 1 has already read into context. The state file is agent-writable, so a `--project-dir`
   taken from it turns `stack.ts`'s equality guard into a tautology about whatever directory that
   file names, and hands `git -C` a repository an attacker chose. Recovery is also the worst
   moment to drop the config guards: it runs with a dirty tree and the branch under review checked
   out, which is precisely the tree that can plant a config of its own. Both of Preflight's guards
   therefore run again here, verbatim.

   ```bash
   # Crash recovery re-derives its own trust roots. Variables do not survive between blocks, and
   # nothing already in this session's context is one — least of all the run state.
   ARG="<the id THIS RUN was invoked with — it names the state file>"
   STORY="<the in-flight story id established in step 1>"
   LINEAR_FACTS_RAW='{"teams":<the list_teams result for this session, as a JSON array>}'
   LINEAR_FACTS_JSON=$(printf '%s' "$LINEAR_FACTS_RAW" | jq -c 'if (.teams|type)=="array" then {teams:.teams} else empty end' 2>/dev/null)
   for v in ARG STORY LINEAR_FACTS_JSON; do
     val="${!v}"
     [ -n "$val" ] && [ "$val" != "null" ] || { echo "FATAL: $v is empty, null, or the wrong JSON type — refusing."; exit 1; }
   done
   # $ARG is interpolated into the state-file path, so it must be a single safe path segment.
   case "$ARG" in ''|*/*|*'\'*|*..*) echo "FATAL: ARG is not a safe path segment — refusing."; exit 1;; esac

   # $CONFIG is re-resolved from $PWD here, so BOTH of Preflight's guards run again, verbatim.
   # Dropping them lets the branch under review — which this procedure has checked out, in a dirty
   # tree — plant `.drawbar/ship.config.json` and feed its own `projectDir` into `--project-dir`
   # and `git -C`; an equality guard does not help, because both sides then agree.
   CONFIG="${DRAWBAR_SHIP_CONFIG:-$PWD/.drawbar/ship.config.json}"
   [ -f "$CONFIG" ] || { echo "FATAL: no config at $CONFIG — copy .drawbar/ship.config.example.json, fill in real values, and either place the copy there or set DRAWBAR_SHIP_CONFIG to point at it."; exit 1; }
   CONFIG_REAL=$(readlink -f "$CONFIG") || { echo "FATAL: cannot resolve $CONFIG to a real path — refusing."; exit 1; }
   git -C "$(dirname "$CONFIG_REAL")" ls-files --error-unmatch "$CONFIG_REAL" >/dev/null 2>&1 \
     && { echo "FATAL: $CONFIG is tracked by git — a committed ship config is never trusted. Untrack it (git rm --cached) and keep it out of version control."; exit 1; } \
     || true

   # MUST-CHECK r3-must-not-source-project-dir-from-pasted-run-state: the trust root is this FRESH
   # validate, run in this block. Never `jq '.resolved_config' "$STATE"` and never anything else
   # read out of the run state — the state file is agent-writable, and a `--project-dir` taken
   # from it turns stack.ts's equality guard into a tautology about the attacker's own directory.
   RESOLVED=$(echo "$LINEAR_FACTS_JSON" | bun run "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ship-config.ts" validate --config "$CONFIG") \
     || { echo "FATAL: ship-config validation refused — see stderr above for the specific reason."; exit 1; }

   # --- derive from the resolved config (crash recovery) --------------------------------------
   ENV_DIR=$(echo "$RESOLVED" | jq -r '.envDir // empty')
   PROJECT_DIR=$(echo "$RESOLVED" | jq -r '.projectDir // empty')
   for v in ENV_DIR PROJECT_DIR; do
     val="${!v}"
     [ -n "$val" ] && [ "$val" != "null" ] || { echo "FATAL: $v is empty or null after validation — refusing."; exit 1; }
   done
   # --- end derive from the resolved config (crash recovery) ----------------------------------
   STATE="$ENV_DIR/.drawbar/runs/$ARG.json"

   # Chain integrity. `--project-dir` is the operator-authored trust root, taken from the fresh
   # validate above, never from the state file's own `resolved_config` copy. Echo the verdict's
   # `.reason` and NOTHING else: `.detail` carries absolute paths and the real repo slug, this
   # repo is public, and the Hard rules require refusal text be paraphrased rather than pasted.
   CHAIN_JSON=$(bun run "${CLAUDE_PLUGIN_ROOT}/scripts/lib/stack.ts" assert-chain --state "$STATE" --project-dir "$PROJECT_DIR")
   CHAIN_OK=$(printf '%s' "${CHAIN_JSON:-null}" | jq -r 'if (type=="object" and .ok==true) then "true" else "false" end' 2>/dev/null)
   [ "$CHAIN_OK" = "true" ] || { CHAIN_REASON=$(printf '%s' "${CHAIN_JSON:-null}" | jq -r '.reason // "unreadable-verdict"' 2>/dev/null); echo "PARK: assert-chain refused ($CHAIN_REASON) — park the story; paraphrase, never paste, the detail on stderr."; exit 1; }

   # The base. `story_already_stacked` is the ONE refusal that is not a park: it means the
   # PR-opening step already completed for this story and the entry is recorded, so there is no
   # base to resolve and the resume point is the summary comment.
   BASE_JSON=$(bun run "${CLAUDE_PLUGIN_ROOT}/scripts/lib/stack.ts" resolve-base --state "$STATE" --story "$STORY")
   BASE=$(printf '%s' "${BASE_JSON:-null}" | jq -r 'if (type=="object" and .ok==true) then .base else empty end' 2>/dev/null)
   if [ -n "$BASE" ] && [ "$BASE" != "null" ]; then
     echo "BASE_REESTABLISHED: $BASE"
   else
     BASE_REASON=$(printf '%s' "${BASE_JSON:-null}" | jq -r '.reason // "unreadable-verdict"' 2>/dev/null)
     case "$BASE_REASON" in
       story_already_stacked) echo "ALREADY_STACKED: the PR is already recorded — resume at the summary comment; resolve no base.";;
       *) echo "PARK: resolve-base refused ($BASE_REASON) — park the story; paraphrase, never paste, the detail on stderr."; exit 1;;
     esac
   fi
   ```
5. **Resume at the earliest incomplete step.** Uncommitted work is *not* discarded — it is
   the crashed run's output. Commit it on the story branch first so it is inspectable, then
   re-dispatch the story-lead pointing at that branch and at the base step 4 re-established,
   **re-writing `in_flight`** with the new dispatch time exactly as step 2 does for a fresh
   dispatch.
6. If the tree is dirty but the state file names **no** in-flight story, halt and notify —
   that is unexplained, and unexplained state is not something to resolve unattended.
7. If recovery instead determines the story is unrecoverable and must be halted outright,
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
- `--base` comes from `scripts/lib/stack.ts`'s `resolveBase`, invoked as `stack.ts resolve-base`:
  the configured `baseBranch` for the first story of a run, the previous story's recorded branch
  for every story after that (Locked A). Never re-derive it in bash, never read it out of the
  run-state file by hand, and never omit `--base`.
- **Locked F: never merge, never verify a merge, and never inspect whether one happened.** There
  is no merge step, no merge check, and no out-of-order-merge detection or repair anywhere in
  this command, and none is planned. The operator merges, bottom-up and in order.
- A `flagged` story still gets its PR and the stack still continues on top of it; a story with
  **no** PR parks and halts the run, because the chain has no anchor. Never treat the two as
  degrees of the same outcome.
- **Any guard refusal text — `ship-config.ts`, `stack.ts`, `kb-sync.ts` alike — must be
  paraphrased, never pasted**, into `parked_reason`, a Linear comment, or a KB entry. Echo the
  verdict's `.reason` and nothing else: a `detail` carries absolute paths and the real repo slug,
  and this repo is public.
- Never `--no-verify`, never force-push, never commit to `main` directly.
- **Never set `Done` / `Ready For QA` / `Ready for Rollout` / `Rolled Out`** — and never
  grant a subagent Linear authority.
- Never run `drawbar-kb archive` or `compact`.
- Filing out-of-scope findings as sub-issues is mandatory.
- Never accept a story whose `mutation_pairs` are empty.

## Operator notes

- **In the morning: review bottom-up and merge bottom-up, in order.** The run leaves you a stack
  of open pull requests, each based on the one below it and each story left `In Progress`. Only
  the bottom PR's diff is meaningful against the configured base; every PR above it becomes
  meaningful as the one below it lands. Merging out of order leaves later PRs showing a diff
  against a base that has moved.
- **Keeping the stack mergeable is yours, and nothing here checks it.** Per Locked F this command
  never merges, never verifies a merge, and never inspects whether one happened — there is no
  detection or repair of an out-of-order merge, and none is planned. If it happens, the recovery
  is a rebase you do by hand. This is a contract rather than a missing feature, so it is not
  something to file.
- **A `flagged` PR is a PR to review, not a failure.** Its `## Unresolved findings` section names
  each surviving finding by sub-issue id and title; the write-ups are in those Linear sub-issues,
  deliberately not in the public PR body. A story that could not open a PR at all is the other
  case entirely: the run parked and stopped there, so the stack ends at the story below it.
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
- **Any guard refusal text must be paraphrased, never pasted**, into a KB entry or a Linear
  comment — `stack.ts`'s verdicts exactly as much as `ship-config.ts`'s, and a `parked_reason`
  exactly as much as a comment. Refusal `detail` strings echo absolute paths and the real repo
  slug (`assert-chain`'s name a predecessor branch and the `projectDir` it was asked about), and the
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
