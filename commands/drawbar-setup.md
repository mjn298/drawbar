---
name: drawbar-setup
description: One-time drawbar setup for the current project — link the kb CLI, record the Linear team, initialize the knowledge base, optionally import legacy knowledge, and verify Linear access.
argument-hint: "[path to legacy knowledge.jsonl]"
---

# drawbar setup

Set up drawbar in the current project. Run once per machine to link the CLI, and once per project to record the team and create the knowledge base. Work through the steps in order and report a short summary at the end.

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

## 2. Record the Linear team in the repo-local config

drawbar hardcodes no team. Ask the user which Linear team this repo files against, confirm the value against `list_teams`, and write it to the repo-local config. Record whatever `list_teams` matches — the team's name or its id — rather than assuming the issue-id prefix is accepted as a lookup key.

```bash
drawbar-kb context
```

That prints the resolved root, config path, knowledge-store path, team and project, each tagged with where it came from. Create the config file at the printed `config` path if it does not exist yet:

```json
{
  "team": "<TEAM>"
}
```

Both other keys are optional. `project` is a *default* Linear project for repos that have a standing one — most repos leave it out and pass `--project` per invocation instead. `memoryDir` is covered in step 3.

Re-run `drawbar-kb context` and confirm `team` now reports `(config)`. A malformed config is refused outright rather than ignored, so a typo surfaces here and not three commands later.

## 3. Initialize the project knowledge base

```bash
drawbar-kb stats --json
```

This creates the store (and its `.gitignore` for `index.db`) at the path `drawbar-kb context` reported, and confirms it reads. A fresh project reports `{"active":0,...}`.

**The store belongs to the repository, not to the working directory.** The path resolves from the **main worktree root** — the parent of the shared `.git` directory — so every linked worktree of the repo reads and writes the *same* store. This is why the path is never `$PWD/.drawbar/memory`: a session running inside `repo/worktrees/feature-x` would otherwise get its own empty store, recall nothing, and write every lesson somewhere no later session looks.

Ask the user whether they want the store in source control:

- **Tracked (default).** Leave `memoryDir` unset. The store lives at `<root>/.drawbar/memory`; commit `knowledge.jsonl` and the whole team shares the accumulated knowledge. Add the `merge=union` attributes described in the README so concurrent branches do not conflict on it.
- **Untracked.** Set `memoryDir` in the config to a path outside the repo (`~/.drawbar/<repo>` works), or set `DRAWBAR_MEMORY_DIR` in the shell profile for a machine-wide choice that no config file records. The knowledge stays local to the machine.

## 4. Offer legacy import (optional)

If the user passed a path to a legacy `knowledge.jsonl` as `$ARGUMENTS`, import it:

```bash
drawbar-kb import "$ARGUMENTS"
```

Show the report. Confirm `imported + dropped == total` and surface the dropped lines — drawbar never drops knowledge silently.

## 5. Confirm Linear access

Verify the Linear MCP is connected and that the team recorded in step 2 is reachable, along with the statuses the workflow moves through (`Todo → In Progress`). If the MCP is unavailable, note that Linear write-backs will be skipped, but local work and the knowledge base still function.

## 6. Report

Summarize: CLI linked (path), team recorded, knowledge base initialized (resolved path, active count, tracked or not), legacy import result (if any), Linear reachable (yes/no). Then point the user at `/drawbar-design <feature>`.
