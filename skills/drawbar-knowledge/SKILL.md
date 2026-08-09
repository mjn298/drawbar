---
name: drawbar-knowledge
description: How to read from and write to the drawbar knowledge base via the drawbar-kb CLI — the entry schema, the six types, the MUST-CHECK convention, recall, and safe writes. Use when a drawbar command needs to recall prior lessons or record new ones.
---

# drawbar knowledge base

The knowledge base is a per-**repository**, append-only JSONL store (`knowledge.jsonl`) indexed by SQLite FTS5, driven by the `drawbar-kb` CLI. The JSONL is the source of truth; the index rebuilds automatically.

## Where the store is

Never assume `$PWD/.drawbar/memory`. Ask:

```bash
KB=$(drawbar-kb path)          # one absolute path, nothing else
drawbar-kb context --json      # root, config path, store, team, project, and the source of each
```

The path resolves in this order — `--dir`, then `DRAWBAR_MEMORY_DIR`, then `memoryDir` in the repo-local `.drawbar/config.json`, then `<main worktree root>/.drawbar/memory`.

The default anchors to the **main worktree root** (the parent of the shared `.git` directory), not to the working directory, so every linked worktree of a repo shares one store. `$PWD/.drawbar/memory` inside `repo/worktrees/feature-x` is a different, empty directory: recall against it returns nothing and every entry written to it is invisible to every other session. Resolve once, then pass the absolute `$KB` to any agent you dispatch — a subagent's working directory is not guaranteed to be yours.

Whether the store is committed is the project's choice: leave `memoryDir` unset to keep it at the repo root where it can be tracked, or point it outside the repo to keep it local to the machine.

## Entry schema

```json
{"key":"<kebab-case-unique>","type":"<type>","content":"<the knowledge>","source":"agent","tags":["..."],"ts":<unix seconds, optional>,"issue":"<issue-id or null>","files":["<path>"]}
```

Required: `key`, `type`, `content`. `source` defaults to `agent`; `tags`/`files` default to `[]`; `issue` defaults to `null`; `ts` defaults to now.

## The six types

- `learned` — a lesson or gotcha. A mistake to guard against begins its content with `MUST-CHECK:`.
- `decision` — a choice and its rationale.
- `pattern` — a reusable approach.
- `fact` — a stable constraint about the system.
- `investigation` — what a dig uncovered.
- `deviation` — a departure from plan and why.

## Recall (read)

```bash
drawbar-kb recall "<query>" --dir "$KB" --json \
  [--type <type>] [--tag <tag>] [--file <path>] [--since <unix>] [--limit <n>] [--all]
```

Ranked by relevance (FTS5 BM25), deduped by key (latest wins). Archived entries are excluded by default; `--all` includes them. Recall before designing, planning, or implementing so you reuse prior lessons and honor `MUST-CHECK:` constraints.

## Write (safe, upserted)

Always pipe the entry as JSON on **stdin** — never interpolate content into the shell:

```bash
echo '<json entry>' | drawbar-kb add --dir "$KB"
```

`add` validates the entry and round-trips it through JSON before appending. It **upserts**: a key holds exactly one entry in the active store, so a correction always wins over what it corrects.

- Re-adding an unchanged entry (every field but `ts` matches) is a no-op — `{"written":false,"superseded":false,"key":"..."}`.
- Changing *any* field (content, issue, tags, files, type) is a correction: the key's line is replaced in place and the old copy moves to the archive — `{"written":true,"superseded":true,"key":"..."}`.

A `superseded:true` you did not expect means you just overwrote knowledge under an existing key — check that you meant to.

## Other commands

- `drawbar-kb stats [--json]` — counts by type, active vs archived, plus `duplicateKeys` (active keys with more than one line — should always be 0).
- `drawbar-kb reindex` — rebuild the FTS index from the JSONL.
- `drawbar-kb archive --days <n>` — age out entries older than N days.
- `drawbar-kb compact [--dry-run]` — collapse any duplicate-key lines in the active store to newest-per-key, archiving the losers, then reindex. `--dry-run` reports the same counts without touching disk.
- `drawbar-kb import <legacy.jsonl>` — one-time import of a legacy corpus (repairs corruption, reports every dropped line).
- `drawbar-kb path` — the resolved store path, one absolute line, without creating it.
- `drawbar-kb context [--json]` — the full resolution: root, config path, store, team, project, and where each value came from.

Every command above accepts `--dir <path>` to override the resolved store, and it always wins.
