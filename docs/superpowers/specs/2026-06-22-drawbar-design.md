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
2. **Task tracking:** Linear via the Linear MCP. Sequential model — a parent issue plus
   **ordered** sub-issues, moved through `Todo → In Progress → Done`. No dependency graph.
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

### `/drawbar-design <feature | PCO-id>` → locked spec as parent issue description

1. Refine scope interactively — one question at a time.
2. Investigate the codebase; **recall** relevant KB knowledge (prior decisions, patterns,
   MUST-CHECKs for this area).
3. Propose 2–3 approaches + a recommendation.
4. **Adversarial design review** — one review subagent critiques architecture / simplicity /
   security *before* lock.
5. Gates: scope confirm → approach pick → final lock. On lock, write the spec as the Linear
   parent issue description and log key decisions as comments.

### `/drawbar-plan <PCO-id>` → ordered story sub-issues

1. Read the locked parent spec.
2. **KB recall → MUST-CHECK constraints** for the detected stack become validation rules.
3. Decompose into sequential stories. Each sub-issue uses the **harvested template**:
   `What / Context / Decisions(Locked + Discretion) / Testing / Validation / Files /
   Dependencies / References`.
4. **Cross-check pass (warning-only):** every story has all sections, testable acceptance
   criteria, MUST-CHECK coverage, and sane scope.
5. Gate: user reviews the story list → create sub-issues in order.

### `/drawbar-work <PCO-id>` → implement next story, TDD

1. Take the next `Todo` sub-issue **in order** (sequential; no ready-graph).
2. **Session-start recall**: surface KB entries relevant to this story's files/topic; read new
   Linear comments.
3. `In Progress` → **TDD** (failing test → implement → green) → code-review subagent + fix loop.
4. **Inline knowledge capture** as lessons emerge. Commit referencing `PCO-id`; post a summary
   comment; set `Done`.

### `/drawbar-learn [PCO-id]` → curate lessons (also runs inline during work)

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

- Exact Linear status names in team PCO (`Todo` / `In Progress` / `Done` vs custom states).
- Whether session-start recall is a plugin `SessionStart` hook or invoked inline by `/drawbar-work`.
