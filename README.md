# drawbar

A lean, Linear-native design → plan → work → learn workflow for Claude Code, with a per-project compounding knowledge base.

## Install

```bash
# Link the knowledge CLI onto your PATH (live symlink to scripts/kb.ts — no version drift)
cd /path/to/drawbar && bun link

# If `drawbar-kb` isn't found afterward, add Bun's global bin to PATH:
export PATH="$(bun pm bin -g):$PATH"
```

Install the plugin in Claude Code so the `/drawbar-*` commands are available.

## Use

```
/drawbar-setup [legacy knowledge.jsonl]   # once per machine + per project
/drawbar-design <feature | PCO-id>         # spec → Linear parent issue
/drawbar-plan <PCO-id>                     # ordered story sub-issues
/drawbar-work <PCO-id>                     # implement next story, TDD
/drawbar-learn [PCO-id]                    # curate lessons into the KB
```

Knowledge lives in `<project>/.drawbar/memory/` (the JSONL is committed; the SQLite index is gitignored). Query it directly anytime:

```bash
drawbar-kb recall "dynamodb tenancy" --dir "$PWD/.drawbar/memory" --json
drawbar-kb stats --dir "$PWD/.drawbar/memory"
```
