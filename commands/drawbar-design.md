---
name: drawbar-design
description: Deeply design and architect a feature, then write the locked spec as a Linear parent issue's description. Input is a free-text feature description or an existing Linear issue id.
argument-hint: "<feature description | PCO-id>"
---

# drawbar design

Produce a spec good enough that `/drawbar-plan` and `/drawbar-work` are mechanical. The locked spec lives as the Linear **parent issue** description.

## Preflight

```bash
command -v drawbar-kb >/dev/null 2>&1 || { echo "drawbar-kb not found — run /drawbar-setup"; exit 1; }
[ -d "$PWD/.drawbar/memory" ] || { echo "no .drawbar/memory — run /drawbar-setup"; exit 1; }
```

## 1. Resolve the input

`$ARGUMENTS` is either a feature description or a Linear issue id (e.g. `PCO-123`). If it looks like an issue id, load it with the Linear MCP `get_issue` and read its description **and existing comments** — the user may have left direction there. Otherwise treat it as a new feature.

## 2. Recall prior knowledge

```bash
drawbar-kb recall "<key terms from the feature>" --dir "$PWD/.drawbar/memory" --json
```

Surface relevant prior decisions, patterns, and any `MUST-CHECK:` entries for this area. Carry them into the design so you do not re-debate settled questions or repeat known mistakes.

## 3. Refine scope (interactive)

Ask questions ONE at a time. Explore purpose, constraints, and success criteria. Investigate the codebase (read the actual files) before proposing anything. **Gate:** confirm scope with the user before designing.

## 4. Propose approaches

Present 2–3 approaches with trade-offs and a recommendation. **Gate:** the user picks an approach.

## 5. Adversarial design review (before lock)

Dispatch the `design-reviewer` agent with the proposed spec and approach. It checks architecture soundness, simplicity/YAGNI, security, and the design against logged `MUST-CHECK:` entries, and returns findings. Address Critical/Important findings; note the rest.

## 6. Lock the spec to Linear

Write the final spec as the parent issue's description via the Linear MCP (`save_issue` — create a new issue in team **PCO** / project **DRAWBAR** if this started from free text, else update the existing one). The spec must be detailed enough that implementation makes zero judgment calls: goal, constraints, locked decisions, architecture, and acceptance criteria.

Log each key decision as a comment (`save_comment`) prefixed `DECISION:`.

If the Linear MCP is unavailable, present the spec to the user and tell them it was not written to Linear (no silent loss). Stop here.

## 7. Report

Print the parent issue id and a one-line summary. Next: `/drawbar-plan <PCO-id>`.
