---
name: drawbar-setup
description: Set up drawbar for the current project: link the knowledge-base CLI, configure the Linear team, initialize knowledge, optionally import legacy knowledge, and verify Linear access. Use when the user asks to set up or initialize drawbar.
---

# Set up drawbar

Follow the authoritative workflow in `commands/drawbar-setup.md` in this plugin.

Codex does not use Claude slash-command variables. Treat the user's request after “set up drawbar” as the optional legacy knowledge-file argument. Where that workflow refers to `$ARGUMENTS`, use that value. Before a command that uses `${CLAUDE_PLUGIN_ROOT}`, set that variable to this installed plugin's root directory (the directory containing `package.json`); the variable name is retained solely for cross-host compatibility.

Use the connected Linear MCP tools when available. If they are unavailable, complete the local setup and clearly say that Linear write-backs cannot yet run.
