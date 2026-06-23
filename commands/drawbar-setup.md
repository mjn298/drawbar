---
name: drawbar-setup
description: One-time drawbar setup for the current project — link the kb CLI, initialize the knowledge base, optionally import legacy knowledge, and verify Linear access.
argument-hint: "[path to legacy knowledge.jsonl]"
---

# drawbar setup

Set up drawbar in the current project. Run once per machine to link the CLI, and once per project to create the knowledge base. Work through the steps in order and report a short summary at the end.

## 1. Ensure the `drawbar-kb` CLI is on PATH

```bash
if command -v drawbar-kb >/dev/null 2>&1; then
  echo "drawbar-kb already linked: $(command -v drawbar-kb)"
else
  echo "Linking drawbar-kb from the plugin..."
  (cd "${CLAUDE_PLUGIN_ROOT}" && bun link)
fi
```

If after linking `drawbar-kb` is still not found, the user's Bun global bin directory is not on PATH. Show them the fix and stop until they resolve it:

```bash
echo "Add Bun's global bin to your shell profile:"
echo "  export PATH=\"$(bun pm bin -g):\$PATH\""
```

## 2. Initialize the project knowledge base

```bash
drawbar-kb stats --dir "$PWD/.drawbar/memory" --json
```

This creates `<project>/.drawbar/memory/` (and its `.gitignore` for `index.db`) and confirms the store reads. A fresh project reports `{"active":0,...}`.

## 3. Offer legacy import (optional)

If the user passed a path to a legacy `knowledge.jsonl` (e.g. an old `.lavra/memory/knowledge.jsonl`) as `$ARGUMENTS`, import it:

```bash
drawbar-kb import "$ARGUMENTS" --dir "$PWD/.drawbar/memory"
```

Show the report. Confirm `imported + dropped == total` and surface the dropped lines — drawbar never drops knowledge silently.

## 4. Confirm Linear access

Verify the Linear MCP is connected and team **PCO** / project **DRAWBAR** are reachable (statuses `Todo → In Progress → Done`). If the MCP is unavailable, note that Linear write-backs will be skipped, but local work and the knowledge base still function.

## 5. Report

Summarize: CLI linked (path), knowledge base initialized (active count), legacy import result (if any), Linear reachable (yes/no). Then point the user at `/drawbar-design <feature>`.
