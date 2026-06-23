# drawbar

A lean, Linear-native design → plan → work → learn workflow for Claude Code, with a per-project compounding knowledge base.

## Who it's for

drawbar is for people who love the **Beads** way of working — atomic, traceable issues and knowledge that *compounds* across sessions instead of evaporating — but who:

- **live in Linear.** Your issues stay in Linear, human-visible to the whole team: a spec is a parent issue's description, stories are ordered sub-issues, status flows `Todo → In Progress → Done`. No separate tracker, no database to babysit.
- **want a human in the loop, not full autonomy.** drawbar is a set of deliberate, reviewable steps — you sharpen scope, pick the approach, approve the plan, and review the work — rather than a fire-and-forget agent. Each command stops at the gates that matter and hands control back to you.

The knowledge base is the heart of it: every lesson, decision, and "MUST-CHECK" you capture is recalled on the next design/plan/work, so the system gets sharper the more you use it.

If you want maximum agent autonomy, drawbar will feel too hands-on. If you want an agent that drafts and proposes while *you* stay the decision-maker — and a memory that actually accumulates — that's the point.

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
/drawbar-design <feature | issue-id>       # spec → Linear parent issue
/drawbar-plan <issue-id>                    # ordered story sub-issues
/drawbar-work <issue-id>                    # implement next story, TDD
/drawbar-learn [issue-id]                   # curate lessons into the KB
```

`issue-id` is a Linear issue identifier (e.g. `ABC-123`) — your team's own prefix.

Knowledge lives in `<project>/.drawbar/memory/` (the JSONL is committed; the SQLite index is gitignored). Query it directly anytime:

```bash
drawbar-kb recall "dynamodb tenancy" --dir "$PWD/.drawbar/memory" --json
drawbar-kb stats --dir "$PWD/.drawbar/memory"
```
