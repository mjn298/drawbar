---
name: drawbar-design
description: Deeply design and architect a feature, then write the locked spec as a Linear parent issue's description. Input is a free-text feature description or an existing Linear issue id.
argument-hint: "<feature description | issue-id> [--project <linear project>]"
---

# drawbar design

Produce a spec good enough that `/drawbar-plan` and `/drawbar-work` are mechanical. The locked spec lives as the Linear **parent issue** description.

## Preflight

```bash
command -v drawbar-kb >/dev/null 2>&1 || { echo "drawbar-kb not found — run /drawbar-setup"; exit 1; }
KB=$(drawbar-kb path) || { echo "drawbar context unresolvable — run /drawbar-setup"; exit 1; }
[ -d "$KB" ] || { echo "no knowledge base at $KB — run /drawbar-setup"; exit 1; }
```

`drawbar-kb path` resolves the store from the **main worktree root**, so a session running in a linked worktree reads the same knowledge as one running in the main checkout. Use `$KB` from here on and never `$PWD/.drawbar/memory`: that path is empty inside a worktree, and an empty store fails silently rather than loudly.

**Recall health probe.** A non-empty store must return hits — a silently empty `recall` guts this skill's core value ("don't re-debate settled questions"). `drawbar-kb` self-heals a stale index, but verify:

```bash
LINES=$(grep -c . "$KB/knowledge.jsonl" 2>/dev/null || echo 0)
HITS=$(drawbar-kb recall "the" --dir "$KB" --json 2>/dev/null | grep -c '"key"')
if [ "$LINES" -gt 50 ] && [ "$HITS" -eq 0 ]; then
  drawbar-kb reindex --dir "$KB" >/dev/null 2>&1
  HITS=$(drawbar-kb recall "the" --dir "$KB" --json 2>/dev/null | grep -c '"key"')
  [ "$HITS" -gt 0 ] || echo "⚠️ recall still returns 0 against a ${LINES}-line store — index broken. Use the git fallback in step 2 and report this."
fi
```

## 1. Resolve the input

`$ARGUMENTS` is either a feature description or a Linear issue id (e.g. `ABC-123`), optionally followed by `--project <linear project>`. If it looks like an issue id, load it with the Linear MCP `get_issue` and read its description **and existing comments** — the user may have left direction there. Otherwise treat it as a new feature.

Resolve where the issue will live before you start designing, so a missing team is a five-second question and not a dead end at step 6:

```bash
drawbar-kb context --json
```

- **Team** comes from `team`. drawbar hardcodes none. If it is `null`, stop and tell the user to set `team` in the repo-local `.drawbar/config.json` (or export `DRAWBAR_TEAM`) — do not guess a team and do not file into whichever one happens to come back first from `list_teams`.
- **Project** comes from `--project` if given, otherwise from `project` in the same output. A repo-local `project` is a standing default; most repos have none, and the flag is the normal way to set it. If neither speaks and this run will create a new issue, ask the user which Linear project to file under.

## 2. Recall prior knowledge

```bash
drawbar-kb recall "<key terms from the feature>" --dir "$KB" --json
```

Surface relevant prior decisions, patterns, and any `MUST-CHECK:` entries for this area. Carry them into the design so you do not re-debate settled questions or repeat known mistakes.

**Git fallback.** Where the store is tracked, the live file is `$KB/knowledge.jsonl` and the index beside it is gitignored and rebuildable. If `recall` returns nothing against a non-empty store, read the file directly (`git -C "$KB" show HEAD:./knowledge.jsonl`, or just read `$KB/knowledge.jsonl` when the store is configured outside the repo) and grep it, then rebuild the index (`drawbar-kb reindex --dir "$KB"`).

## 3. Refine scope (interactive)

Explore purpose, constraints, and success criteria. Investigate the codebase (read the actual files) before proposing anything. Batch independent, decision-shaped questions into a single `AskUserQuestion` call (up to 4); reserve one-at-a-time for genuinely exploratory threads or where a later question depends on an earlier answer. **Gate:** confirm scope with the user before designing.

## 4. Propose approaches

Present 2–3 approaches with trade-offs and a recommendation. If the user's constraints have already narrowed the space, lead with the recommended approach and briefly note the discarded alternatives and why they're out — don't manufacture a full N-way comparison. **Gate:** the user picks an approach.

## 5. Adversarial design review (before lock)

Dispatch the `design-reviewer` agent with the proposed spec and approach. It checks architecture soundness, simplicity/YAGNI, security, and the design against logged `MUST-CHECK:` entries, and returns findings. Address Critical/Important findings; note the rest.

If a finding **conflicts with a decision the user has explicitly locked**, do not resolve it unilaterally — surface it back to the user as a focused question with the reviewer's evidence and your recommendation, and let them re-decide. Don't silently override the user, and don't silently comply against strong evidence.

> **Design is iterative.** Users add or change constraints after the approach is picked. When that happens: (1) re-thread the spec so all affected sections stay consistent; (2) update any already-logged `DECISION:` comment the change invalidates; (3) re-run or re-notify the `design-reviewer` if the change is material (new surface, new security/PII implication, changed data model). The locked spec is **not** append-only.

## 5.5 Consistency check (before locking)

Grep the draft for stragglers before locking: any symbol you renamed mid-session, any decision referenced in prose but missing from `## Locked decisions`, and any `## Locked` entry without a matching acceptance criterion. Fix dangling references so the locked spec is internally consistent.

## 6. Lock the spec to Linear

Author and edit the spec as a **local draft** — a working scratchpad (repo file or scratch buffer). This is a *draft*, **not** a synced mirror: Linear remains the single source of truth; the draft is just the editing surface and is disposable once locked. Push to the Linear issue description only at genuine lock points (post-review, and after any material constraint change). Note that `save_issue` **replaces the description wholesale** — there is no partial update, so don't author by repeated full-description rewrites in Linear.

Write the final spec as the parent issue's description via the Linear MCP (`save_issue` — create a new issue in the team and project resolved in step 1 if this started from free text, else update the existing one). The spec must be detailed enough that implementation makes zero judgment calls: goal, constraints, locked decisions, architecture, and acceptance criteria.

A `## Story decomposition` section — suggested ordering and sequencing constraints (schema-PR isolation, global-surface isolation, dependency order) — is welcome here; it keeps `/drawbar-plan` mechanical. Don't enumerate per-story acceptance criteria, though — that's `/drawbar-plan`'s job. Some overlap is fine and expected.

Log each key decision as a comment (`save_comment`) prefixed `DECISION:`.

If the Linear MCP is unavailable, present the spec to the user and tell them it was not written to Linear (no silent loss). Stop here.

## 7. Report

Print the parent issue id and a one-line summary. Next: `/drawbar-plan <issue-id>`.
