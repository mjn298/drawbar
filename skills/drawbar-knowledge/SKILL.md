---
name: drawbar-knowledge
description: How to read from and write to the drawbar knowledge base via the drawbar-kb CLI — the entry schema, the six types, the MUST-CHECK convention, recall, and safe writes. Use when a drawbar command needs to recall prior lessons or record new ones.
---

# drawbar knowledge base

The knowledge base is a per-project, append-only JSONL store (`<project>/.drawbar/memory/knowledge.jsonl`) indexed by SQLite FTS5, driven by the `drawbar-kb` CLI. The JSONL is the git-tracked source of truth; the index rebuilds automatically.

## Entry schema

```json
{"key":"<kebab-case-unique>","type":"<type>","content":"<the knowledge>","source":"agent","tags":["..."],"ts":<unix seconds, optional>,"issue":"<PCO-id or null>","files":["<path>"]}
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
drawbar-kb recall "<query>" --dir "$PWD/.drawbar/memory" --json \
  [--type <type>] [--tag <tag>] [--file <path>] [--since <unix>] [--limit <n>] [--all]
```

Ranked by relevance (FTS5 BM25), deduped by key (latest wins). Archived entries are excluded by default; `--all` includes them. Recall before designing, planning, or implementing so you reuse prior lessons and honor `MUST-CHECK:` constraints.

## Write (safe, upserted)

Always pipe the entry as JSON on **stdin** — never interpolate content into the shell:

```bash
echo '<json entry>' | drawbar-kb add --dir "$PWD/.drawbar/memory"
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
