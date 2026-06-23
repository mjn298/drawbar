# drawbar — Design Spec

**Date:** 2026-06-22
**Status:** Approved (design); pending implementation plan
**Linear:** team PCO — project [DRAWBAR](https://linear.app/passcom/project/drawbar-accf137e2629/overview)

## Summary

drawbar is a Claude Code plugin: a lean, **sequential** agentic SDLC pipeline with a
**per-project compounding knowledge base**. It takes the good ideas from
[lavra](https://github.com/roberto-mello/lavra) (design → plan → work → learn, knowledge
compounding) but drops beads and [linear-beads (`lb`)](https://github.com/nikvdp/linear-beads)
entirely. Task tracking is **Linear via the Linear MCP**; knowledge is a local append-only
JSONL file indexed by **SQLite FTS5**.

This is a fresh, lean build — **not** a fork of lavra. We harvest three specific high-value
ideas from lavra's prompts (see [Harvested from lavra](#harvested-from-lavra)) and leave the
rest (parallel/swarm execution, cross-command plumbing, 30-agent roster) behind.

## Goals

- Thoroughly design and architect features before building.
- Produce good, **testable** stories.
- Work on stories **sequentially**.
- Capture important lessons into a knowledge base that is **easily queried** and **compounds**
  over time into something genuinely useful.

## Non-goals (explicitly cut, YAGNI)

- Parallel / swarm execution; blocker/dependency graphs and "ready work" queries.
- `lb` / SQLite offline cache / write outbox / beads-jsonl import interop.
- Cross-project knowledge compounding (KB is per-project; the user defines the project boundary).
- A separate ship/PR command (existing push workflow covers it).
- A local mirror of the spec (Linear is the sole system of record for v1).

## Key decisions

1. **Form:** fresh lean reimplementation, harvesting specific lavra ideas — not a fork.
   (Measured: beads is wired into 39/164 lavra plugin files; the genuinely valuable,
   hard-to-rebuild content is small and concentrated, so harvesting beats inheriting the
   coupling and bloat.)
2. **Task tracking:** Linear via the Linear MCP. Sequential model. A drawbar story is a
   Linear issue — either a **leaf issue** worked directly, or the next `Todo` **child** under
   a parent (`/drawbar-design` may produce a parent with ordered sub-issues). No dependency
   graph. The implementing agent owns `Todo → In Progress` and then **hands off via a PR**,
   leaving the story `In Progress` (an attached PR = "in review"). It never sets `Done` or any
   QA/rollout/completion status — those belong to humans and vary widely by team (e.g. the PAS
   team runs `… → Pre-QA → Ready For QA → Ready for Rollout → Rolled Out → Done`).
3. **Spec home:** Linear-only. `/drawbar-design`'s output **is** the parent issue's
   description; stories are sub-issues underneath it.
4. **Knowledge recall:** SQLite **FTS5** index over an append-only `knowledge.jsonl`. The
   JSONL is the git-tracked source of truth; the index is rebuildable and gitignored.
5. **Knowledge scope:** per-project, at `<project>/.drawbar/memory/`.
6. **Collaboration spine:** Linear's comment thread. Each command reads new comments on the
   issue before acting and posts its own decisions/findings back as comments.

## Architecture

### Plugin layout (installed globally; operates on the cwd project)

```
drawbar/
  .claude-plugin/plugin.json
  commands/   drawbar-{design,plan,work,learn}.md
  skills/     drawbar-knowledge/SKILL.md      # how agents use the KB
  agents/     design-reviewer.md, code-reviewer.md
  scripts/    kb.ts                           # add|recall|reindex|stats|archive|import (Bun)
```

### Per-project data

```
<project>/.drawbar/memory/
  knowledge.jsonl          # append-only, git-tracked, source of truth
  knowledge.archive.jsonl  # aged-out entries, searchable with --all
  index.db                 # SQLite FTS5 index, gitignored, rebuildable
  .gitignore               # ignores index.db
```

## Knowledge subsystem (the heart)

### Entry schema

```json
{
  "key": "pattern-dynamodb-cross-tenant-verification-in-loops",
  "type": "pattern",
  "content": "…",
  "source": "user",
  "tags": ["security", "dynamodb"],
  "ts": 1772920559,
  "issue": "PCO-123",
  "files": ["pipeline/index.ts"]
}
```

- Keeps the existing fields from the user's current `knowledge.jsonl`.
- **`bead` → renamed `issue`**: the Linear identifier (e.g. `PCO-123`). This is the spine
  that links every lesson back to the story that produced it. Old entries' `bead` field is
  still read on import.
- **`files`** added (optional): enables file-faceted recall.
- Six knowledge types: `learned`, `decision`, `pattern`, `fact`, `investigation`, `deviation`.

### `kb.ts` CLI

**Runtime: Bun.** The KB tool (`kb.ts`) uses Bun's built-in `bun:sqlite` — synchronous,
fast, and bundles a SQLite with **FTS5**, so the tool has **zero external dependencies**.
JSON-output mode for agent calls. (Bun is also the test runner — see Testing strategy.)

| Command | Behaviour |
|---|---|
| `add`     | Validate + JSON-round-trip an entry **before** appending; dedupe by key. |
| `recall`  | FTS5 BM25 ranking + filters (`--type`, `--tag`, `--file`, `--since`), recency boost, dedupe by key (latest `ts` wins). Auto-reindex if JSONL is newer than `index.db`. |
| `reindex` | Rebuild `index.db` from the JSONL. |
| `stats`   | Counts by type / total / archived. |
| `archive` | Age out old entries to `knowledge.archive.jsonl`. |
| `import`  | One-time migration (see below). |

### Three fixes over the current system

1. **Safe writes.** Entries are written by `kb.cjs` doing real JSON encoding, never shell
   interpolation, validated by a JSON round-trip before the append. (Unescaped shell
   interpolation is what corrupted ~10% of the current corpus.)
2. **Real recall, not grep.** Replaces the current `JSON.stringify(e).includes(query)`
   substring scan with FTS5 ranking + structured filters.
3. **One CLI** with JSON output for agents.

### Migration — `kb import <old knowledge.jsonl>`

Reads the user's existing 1,898-line lavra `knowledge.jsonl`, repairs/drops the ~185 corrupt
lines (**reporting each — no silent loss**), maps `bead` → `issue`, writes a clean JSONL and
builds the index. One-time, opt-in.

## Command workflows

Across all commands, **Linear's comment thread is the collaboration spine**: each command
reads any new comments left on the issue before acting and posts its own DECISIONs / findings
back as comments.

### `/drawbar-design <feature | issue-id>` → locked spec as parent issue description

1. Refine scope interactively — one question at a time.
2. Investigate the codebase; **recall** relevant KB knowledge (prior decisions, patterns,
   MUST-CHECKs for this area).
3. Propose 2–3 approaches + a recommendation.
4. **Adversarial design review** — one review subagent critiques architecture / simplicity /
   security *before* lock.
5. Gates: scope confirm → approach pick → final lock. On lock, write the spec as the Linear
   parent issue description and log key decisions as comments.

### `/drawbar-plan <issue-id>` → ordered story sub-issues

1. Read the locked parent spec.
2. **KB recall → MUST-CHECK constraints** for the detected stack become validation rules.
3. Decompose into sequential stories. Each sub-issue uses the **harvested template**:
   `What / Context / Decisions(Locked + Discretion) / Testing / Validation / Files /
   Dependencies / References`.
4. **Cross-check pass (warning-only):** every story has all sections, testable acceptance
   criteria, MUST-CHECK coverage, and sane scope.
5. Gate: user reviews the story list → create sub-issues in order.

### `/drawbar-work <issue-id>` → implement one story, TDD

1. **Pick the story (leaf-or-parent):** load the issue; if it has sub-issues, take the next
   `Todo` child in order; if it has none, the issue *itself* is the story.
2. **Recall**: surface KB entries relevant to this story's files/topic; read Linear comments.
3. **Prerequisite gate:** verify any named prerequisite issues/PRs are merged/Done; stop and
   report if not (don't build on an incomplete base).
4. `Todo → In Progress` → **TDD** (failing test, *RED output shown*, → implement → green);
   tests scoped per the project's CLAUDE.md (targeted + typecheck + lint, not a forced full
   suite) → code-review subagent + fix loop.
5. **Inline knowledge capture** as lessons emerge. Commit referencing the issue id.
6. **Close out:** open a PR (never merge it) and **leave the story `In Progress`**; post a
   summary comment with the PR link. Never set `Done`/QA/rollout.

### `/drawbar-learn [issue-id]` → curate lessons (also runs inline during work)

Extract entries across the 6 types from the session's diffs/decisions; **mistakes become
`MUST-CHECK:` entries** (feeding the compounding loop). Safe-write to the KB, tagged with
issue + files, deduped by key.

## Harvested from lavra

Three concentrated ideas ported into the lean build (the rest of lavra is left behind):

1. **The Locked/Discretion story template** → `/drawbar-plan` sub-issue descriptions. The
   Locked vs Discretion decisions split tells the implementing agent what *not* to re-debate
   and where it has latitude.
2. **The "zero judgment calls" planning bar** → design + plan philosophy. *"Completeness over
   brevity — include every decision the agent needs so it makes zero judgment calls."* The
   output of design should be detailed enough that `/drawbar-work` is mechanical.
3. **The MUST-CHECK compounding loop** → wire the FTS5 KB into `/drawbar-plan` as a validation
   pass. Past mistakes get logged as `MUST-CHECK:` entries; every new plan is cross-validated
   against them. This is the compounding-knowledge mechanism made concrete.

## Testing strategy

TDD the one piece that is real code — `kb.ts` — using `bun test`:

- `add` validates + JSON-round-trips before append.
- `recall` ranks / filters / dedupes correctly.
- `reindex` rebuilds the index from the JSONL.
- `import` repairs corruption — its fixture **is** the 185 known-bad lines from the current corpus.
- `archive` ages out entries.

Commands, skills, and agents are prompt artifacts — verified by a smoke run on a throwaway
feature (design → plan → work → learn end to end).

## Error handling (cardinal rule: never silently corrupt the KB again)

- KB writes validate a JSON round-trip **before** appending; failures are loud.
- The index auto-rebuilds when `knowledge.jsonl` is newer than `index.db`.
- Linear MCP unavailable → warn and let local work proceed; do not hard-block.
- `kb add` is idempotent — dedupe by key.

## Open questions for the implementation plan

- ~~Exact Linear status names~~ — **Resolved (and generalized):** status names vary by team (PCO is simple `Backlog / Todo / In Progress / Done`; PAS adds a QA/rollout pipeline `Pre-QA / Ready For QA / QA Failed / Ready for Rollout / Rolled Out / Done`). So drawbar does **not** hardcode a terminal status: `/drawbar-work` takes a story `Todo → In Progress` and hands off via a PR, leaving it `In Progress`; humans own all completion/QA/rollout transitions. (Updated after the PAS-3043 dogfooding run.)
- ~~Session-start recall: hook or inline~~ — **Resolved:** inline. Each command recalls relevant lessons at the top of its flow; no `SessionStart` hook.

---

# Plan 2 — The plugin prompt layer

> Plan 1 (the `kb` tool) is built and merged. Plan 2 builds the prompt layer on top of it.
> Status: design approved 2026-06-23; pending implementation plan.

## Summary

Plan 2 turns the `kb` tool into a usable Claude Code plugin: five commands, two review
agents, a knowledge skill, and a manifest — the lean, Linear-native design→plan→work→learn
workflow from the design above, made real.

## Distribution & invocation (decided)

- **`drawbar-kb` on PATH via `bin` + `bun link`.** `package.json` gains
  `"bin": { "drawbar-kb": "scripts/kb.ts" }`; `/drawbar-setup` runs `bun link` from the
  plugin root so `drawbar-kb` is a **live symlink to `scripts/kb.ts`** — no version drift,
  and the user can run `drawbar-kb recall …` directly in a terminal. Commands invoke
  `drawbar-kb …`, never the bundled path.
- **Preflight** at the top of every command: if `drawbar-kb` is missing or
  `<project>/.drawbar/memory/` is absent, stop with "run `/drawbar-setup`".
- **Linear MCP absent → warn and continue**: local work and KB writes still flow; Linear
  write-backs are skipped with a note. Never hard-block.

## Plugin layout

```
drawbar/
  .claude-plugin/plugin.json                    # manifest (commands/agents/skills auto-discovered)
  package.json                                  # bin: { "drawbar-kb": "scripts/kb.ts" }
  commands/  drawbar-{setup,design,plan,work,learn}.md
  agents/    design-reviewer.md, code-reviewer.md
  skills/    drawbar-knowledge/SKILL.md
  scripts/   kb.ts + lib/…                       # Plan 1 (built)
```

## Command style

Each command is a short, single-flow, structured prompt — a focused checklist, not lavra's
46KB orchestrators. No swarm/parallel machinery, no cross-command brainstorm-detection
plumbing, no `session-state.md`. Pattern: **preflight → inline KB recall → do the work →
write back to Linear/KB**. Linear's comment thread is the collaboration spine: each command
reads new comments on the issue before acting and posts its own decisions/findings back.

## Commands

### `/drawbar-setup`
1. `command -v drawbar-kb`; if missing, `bun link` from `${CLAUDE_PLUGIN_ROOT}`, re-check.
2. Force-create + confirm `<project>/.drawbar/memory/` (`drawbar-kb stats --dir …`).
3. Offer legacy import (`drawbar-kb import <path>`, show the no-silent-loss report).
4. Confirm the Linear team/project (PCO / DRAWBAR) and MCP connectivity; report ready.

### `/drawbar-design <feature | issue-id>` → spec becomes the parent issue description
1. Preflight. Resolve input: free text → new feature; issue-id → `get_issue` (description + comments).
2. **Recall** `drawbar-kb recall "<feature area>"`; read existing Linear comments.
3. Interactive scope refinement (one question at a time) + codebase investigation → 2–3 approaches + recommendation.
4. **Adversarial design review**: dispatch `design-reviewer` *before* lock.
5. Gates: scope → approach → lock. On lock: write spec as the parent issue description
   (`save_issue`); log decisions as `DECISION:` comments.

### `/drawbar-plan <issue-id>` → ordered story sub-issues
1. Preflight. `get_issue` → the locked spec.
2. **Recall → MUST-CHECK**: `drawbar-kb recall "MUST-CHECK <stack>"` → constraints become validation rules.
3. Decompose into sequential stories; each sub-issue uses the template:
   `What / Context / Decisions(Locked+Discretion) / Testing / Validation / Files / Dependencies / References`.
4. **Cross-check pass** (warning-only): all sections present, testable acceptance criteria,
   MUST-CHECK coverage, sane scope.
5. Gate: review story list → `save_issue` sub-issues under the parent, in order.

### `/drawbar-work <issue-id>` → implement one story, TDD
1. Preflight. **Pick the story (leaf-or-parent):** `get_issue`; if it has sub-issues, take the
   next `Todo` child in order; if none, the issue itself is the story.
2. **Recall** for the story's files/topic; read Linear comments.
3. **Prerequisite gate:** verify named prerequisite issues/PRs are merged/Done; stop and report
   if not.
4. `Todo → In Progress`. **TDD** (failing test → *show RED output* → implement → green); test
   scope deferred to the project's CLAUDE.md (targeted + typecheck + lint, not a forced full
   suite) → dispatch `code-reviewer` + fix loop.
5. **Inline capture**: lessons → `drawbar-kb add` (stdin JSON; `issue=<issue-id>`, `files=…`).
6. **Close out:** commit referencing the issue id; open a PR (never merge); **leave the story
   `In Progress`** (attached PR = in review); post a summary comment. Never set `Done`/QA/rollout.

### `/drawbar-learn [issue-id]` → curate lessons (also runs inline during work)
Review the session's diffs/decisions; extract entries across the 6 types; **mistakes →
`MUST-CHECK:` entries**; safe-write via `drawbar-kb add`, deduped by key.

## Agents (two thin files)

- **`design-reviewer`** — adversarial critique of the proposed spec/approaches before lock.
  Lenses: architecture soundness, simplicity/YAGNI, security. Pointed at the KB so it checks
  the design against logged `MUST-CHECK:` entries. Returns categorized findings.
- **`code-reviewer`** — work-phase review of the story's diff: spec-compliance vs the story's
  acceptance criteria + code quality. Returns findings; `/drawbar-work` runs the fix loop.

**Single-writer rule:** agents *return findings*; the **command owns all Linear writes**.
Reviewers never post to Linear directly.

## `drawbar-knowledge` skill

The "how to drive `drawbar-kb`" reference the commands point at: the entry schema + 6 types,
*when* to write each, the `MUST-CHECK:` convention, how to recall, dedupe-by-key.

## Testing

Commands/agents/skill are prompt artifacts → verified by a **smoke run** of a throwaway
feature taken design→plan→work→learn against a scratch project + a disposable Linear issue.
The one mechanical check: `/drawbar-setup`'s `bun link` yields a working `drawbar-kb` on PATH.
(The tool itself already has 42 tests from Plan 1.)

## Error handling

- Preflight gates every command (`drawbar-kb` present? `.drawbar/memory/` exists? → else `/drawbar-setup`).
- Linear MCP absent → warn, keep local work + KB writes flowing, skip Linear write-backs with a note.
- KB writes already fail loudly via `drawbar-kb`'s safe-write path.

## Open items for the Plan 2 implementation plan

- The one-time PATH note for Bun's global bin directory (`bun pm bin -g`) so `drawbar-kb` resolves.
- Exact `.claude-plugin/plugin.json` fields/schema for the current Claude Code version.
