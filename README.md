# drawbar

A lean, Linear-native design → plan → work → learn workflow for Claude Code, with a per-project compounding knowledge base.

Enjoy a mix of AI generated readme, and my interjections in the text below. 

## Why is it called drawbar
I just got a **[clonewheel](https://www.crumar.it/?a=showproduct&b=39)** and am digging it, a lot. Other than that, no reason. I'm following the grand tradition of software projects with inscrutable names.  

## Who it's for

drawbar is for people who love the **[Beads](https://github.com/gastownhall/beads)** way of working — atomic, traceable issues and knowledge that *compounds* across sessions instead of evaporating — but who:

- **live in Linear.** Your issues stay in Linear, visible to the whole team: a spec is a parent issue's description, stories are ordered sub-issues, status flows `Todo → In Progress → Done`. Issues aren't stored locally. I know this makes things slower and probably wastes tokens, but this works better for my and my team.
- **want a human in the loop, not full autonomy.** drawbar is a set of deliberate, reviewable steps — you sharpen scope, pick the approach, approve the plan, and review the work — rather than a fire-and-forget agent. If beads is meth, this is a glass of iced tea.

This is really just an old-school issue tracking workflow with some glue. It is not novel but it has been working well for me. 

The knowledge base is the heart of it: every lesson, decision, and "MUST-CHECK" you capture is recalled on the next design/plan/work, so the system gets sharper the more you use it.

If you want maximum agent autonomy, drawbar will feel too hands-on. If you want an agent that drafts and proposes while *you* stay the decision-maker — and a memory that actually accumulates — that's the point.

## Requirements

drawbar needs two things set up before it works:

- **[Bun](https://bun.sh)** — runs the `drawbar-kb` knowledge CLI (and the tests). Install: `curl -fsSL https://bun.sh/install | bash`.
- **The Linear MCP, connected in Claude Code** — drawbar tracks all work in Linear *through the MCP* (`mcp__…Linear…` tools must be available in your session). Without it, the design/plan/work commands can still run locally but won't write to Linear.

Plus Claude Code itself (the plugin host).

## Install

1. **Add the marketplace and install the plugin:**

   ```bash
   claude plugin marketplace add mjn298/drawbar
   claude plugin install drawbar@drawbar
   ```

   Then run `/reload-plugins` (or restart) so the `/drawbar-*` commands load.

2. **Run `/drawbar-setup` once in a project.** It links the `drawbar-kb` CLI onto your PATH (via `bun link` from the installed plugin), records your Linear team in `.drawbar/config.json`, and initializes the knowledge base.

   If `drawbar-kb` still isn't found afterward, add Bun's global bin to PATH:

   ```bash
   export PATH="$(bun pm bin -g):$PATH"
   ```

> Hacking on drawbar itself? Skip the marketplace and load the repo directly — see [Development](#development).

## Use

```
/drawbar-setup [legacy knowledge.jsonl]              # once per machine + per project
/drawbar-design <feature | issue-id> [--project P]   # spec → Linear parent issue
/drawbar-plan <issue-id> [--project P]               # ordered story sub-issues
/drawbar-work <issue-id>                             # implement next story, TDD
/drawbar-learn [issue-id]                            # curate lessons into the KB
```

`issue-id` is a Linear issue identifier (e.g. `ABC-123`) — your team's own prefix.

The `[legacy knowledge.jsonl]` argument to `/drawbar-setup` is **only** for migrating an existing **lavra** knowledge base into drawbar. If you weren't using lavra before — most people — skip it and start with a fresh, empty knowledge base.

## Project config

drawbar hardcodes no Linear team. `/drawbar-setup` writes a repo-local `.drawbar/config.json`; see `.drawbar/config.example.json` for the full shape.

```json
{ "team": "PAS" }
```

| Key | Meaning |
|---|---|
| `team` | **Required in practice.** The Linear team new issues are filed against. Without it, `/drawbar-design` stops and asks rather than guessing. |
| `project` | Optional standing Linear project. Most repos omit it and pass `--project` per invocation, because a project is a unit of work rather than a property of the checkout. |
| `memoryDir` | Optional. Moves the knowledge store off the repo root — see below. |

Environment overrides, for a machine-wide choice no config file records: `DRAWBAR_TEAM`, `DRAWBAR_PROJECT`, `DRAWBAR_MEMORY_DIR`, and `DRAWBAR_CONFIG` (points at a config file elsewhere).

## Where knowledge lives

The store is per **repository**, not per working directory. It resolves in this order — `--dir`, `DRAWBAR_MEMORY_DIR`, `memoryDir` in the config, then `<main worktree root>/.drawbar/memory`.

The default anchors to the **main worktree root** — the parent of the shared `.git` directory — so every linked worktree of the repo reads and writes the same knowledge. This is deliberate: a store resolved from `$PWD` gives each worktree its own empty one, and stories are implemented in worktrees constantly.

Whether the store is committed is your choice. Leave `memoryDir` unset to keep it at `<repo root>/.drawbar/memory`, where the JSONL can be tracked and shared with the team (the SQLite index beside it is gitignored). Set `memoryDir` to a path outside the repo — `~/.drawbar/<repo>` works — to keep it local to your machine.

Ask the CLI rather than assuming:

```bash
drawbar-kb context           # root, config, store, team, project — and where each came from
KB=$(drawbar-kb path)        # just the absolute store path
drawbar-kb recall "dynamodb tenancy" --dir "$KB" --json
drawbar-kb stats --dir "$KB"
```

## Development

Working on drawbar itself? The `kb` tool has tests:

```bash
bun test
```

**Loading your edits — two modes:**

- **Iterating fast → run the live source directly.** Launch Claude Code with `--plugin-dir` so it loads your working copy and bypasses the plugin cache entirely:

  ```bash
  claude --plugin-dir /path/to/drawbar
  ```

  Edits to commands/agents/skills take effect on `/reload-plugins` — no version bump, no reinstall. It shadows any installed copy for that session only.

- **Releasing a change through the marketplace → bump the version.** The plugin cache is **keyed by `plugin.json` version**, so editing files in place at the *same* version silently won't propagate — `/reload-plugins` keeps serving the stale cached copy. To ship a real change:

  ```bash
  # 1. bump "version" in .claude-plugin/plugin.json (e.g. 0.1.1 → 0.1.2)
  claude plugin marketplace update <marketplace>   # re-read the source
  claude plugin update drawbar@<marketplace>        # fetch the new version
  # 2. /reload-plugins (or restart) in your session
  ```

  Forgetting the version bump is the #1 "my change didn't show up" gotcha.

## Credits

drawbar stands on the shoulders of three projects:

- **[Beads](https://github.com/gastownhall/beads)** — the model that started it: atomic, dependency-aware issues and knowledge captured as you work so it compounds across sessions.
- **[linear-beads](https://github.com/nikvdp/linear-beads)** by [@nikvdp](https://github.com/nikvdp) — beads-style issue tracking with Linear as the backend. The inspiration for keeping issues in Linear (human-visible) instead of a local database.
- **[lavra](https://github.com/roberto-mello/lavra)** by [@roberto-mello](https://github.com/roberto-mello) — the design → plan → work → review → learn skill pipeline and knowledge-compounding approach that drawbar's workflow is modeled on.

drawbar is a leaner take that combines lavra's workflow with linear-beads' Linear-first tracking, around its own knowledge base — built for human-in-the-loop work.
