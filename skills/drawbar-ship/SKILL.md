---
name: drawbar-ship
description: Take one drawbar Linear story to a reviewed pull request and hand it to a human for merging. Use when the user asks to ship a drawbar story or burn down a parent issue.
---

# Ship with drawbar

Follow the authoritative workflow in `commands/drawbar-ship.md` in this plugin. Treat the requested parent or story issue id as that workflow's `$ARGUMENTS`. Before a command that uses `${CLAUDE_PLUGIN_ROOT}`, set that variable to this installed plugin's root directory (the directory containing `package.json`); the variable name is retained solely for cross-host compatibility. Preserve its rule that nothing is merged automatically.
