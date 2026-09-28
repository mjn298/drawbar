---
name: drawbar-plan
description: Decompose a locked design (a Linear parent issue) into good, testable, ordered story sub-issues.
argument-hint: "<issue-id of the parent issue> [--project <linear project>]"
---

# drawbar plan

Turn the locked spec into a sequence of small, testable stories. Each story is a Linear sub-issue under the parent.

## Preflight

```bash
command -v drawbar-kb >/dev/null 2>&1 || { echo "drawbar-kb not found — run /drawbar-setup"; exit 1; }
KB=$(drawbar-kb path) || { echo "drawbar context unresolvable — run /drawbar-setup"; exit 1; }
[ -d "$KB" ] || { echo "no knowledge base at $KB — run /drawbar-setup"; exit 1; }
```

`drawbar-kb path` resolves the store from the main worktree root, so a linked worktree reads the same knowledge as the main checkout. Use `$KB` from here on, never `$PWD/.drawbar/memory`.

## 1. Load the locked spec

`$ARGUMENTS` is the parent issue id, optionally followed by `--project <linear project>`. Load the parent with the Linear MCP `get_issue` (description + comments). This is the spec you are decomposing.

Sub-issues inherit neither team nor project automatically. Take both from the parent you just loaded; where `--project` is given it overrides the parent's project, and where the parent has no project, fall back to `project` from `drawbar-kb context --json` before asking the user.

## 2. Recall MUST-CHECK constraints

Detect the story's stack from the spec (languages, frameworks). Then:

```bash
drawbar-kb recall "MUST-CHECK <stack keywords>" --dir "$KB" --json
```

A `MUST-CHECK:` that applies to a story goes into that story's `## Locked` section, verbatim. One that does not apply is left out.

## 3. Decompose into ordered stories

### Provenance — what you may assert as fact

- Assert something about the code only if you read the thing that answers it in this session, and say where: the file and the symbol, never a line number. The test is per question, not per file.
- Otherwise write it as an instruction to check, pointing at the evidence: "verify `BaseRuleSchema` in `shared/types/locationGroup.ts` and match whichever is correct." A belief written as a decision gets built even when it is wrong.
- Before telling anyone to copy or mirror something, say in one line what differs between the source's container and the destination's, or that nothing does.


A false claim in a ticket outlives a false claim in a brief: nobody re-reads it, and it sits in
the backlog until someone implements it exactly as written.

### How to write it

**Plain and short.** A story should land in one read. A ticket nobody finishes reading is a
ticket nobody follows.

- Short sentences, one idea each. If a sentence needs a second read, rewrite it.
- No jargon, no buzzwords, no invented compounds, no metaphors. Say "makes it slower", not
  "introduces latency overhead". Real names of things — `companyId`, oRPC, Zod — are fine;
  the padding around them is not.
- Say it once. Don't restate the goal in What, then Context, then Testing.
- Bullets over paragraphs in What, Testing, Files.
- Cut any sentence that doesn't change what the implementer does. Motivation, background, and
  "why this matters" belong in the parent spec, not in every child.
- A section with nothing to say gets one line, or `None`. Don't pad it.

The template below is the required shape, not a word count. Most sections are one to five
lines.

Break the work into sequential stories (small enough to implement and review independently). For each, write a sub-issue description using this exact template:

```
## What
[What to implement. A paragraph or a short list.]

## Context
[What the implementer needs from the spec and from recall. Nothing that is already in What.]

## Locked
[Inherited from the parent's Locked decisions, plus any MUST-CHECK that applies. Verbatim. Do not re-debate.]

## Assumptions
[What you believe about the current code, each naming the file and symbol to verify. Where a read established nothing about a question, say so.]

## Testing
[Specific test cases and edge cases. The acceptance criteria, as testable statements.]

## Files
[Paths this story touches.]

## Dependencies
[Earlier stories that must land first.]
```

### What may be Locked

Only these may be Locked: the parent's Locked decisions, and `MUST-CHECK:` entries recalled from the knowledge base. Both are copied verbatim.

Your own conclusions from reading code this session may NOT be Locked. They are evidence, not decisions, and they go in `## Assumptions` naming the file and symbol. Anything not Locked is the implementer's call; there is no Discretion list to write.

## 4. Cross-check (warning-only)

Before creating issues, verify each story: all template sections present; the tests are specific enough to write; scope is reasonable for one sitting; no code reference anchored to a line number; nothing in `## Locked` that the parent did not lock; and the description passes a read-aloud test — plain words, nothing restated, nothing padded. Report any gaps as warnings.

## 5. Create the sub-issues

**Gate:** show the user the ordered story list and get confirmation. Then create each as a Linear sub-issue (`save_issue` with `parentId` = the parent, status `Todo`) in dependency order.

If the Linear MCP is unavailable, present the stories to the user and note they were not written to Linear. Stop here.

## 6. Report

Print the parent id and the ordered child ids/titles. Next: `/drawbar-work <issue-id>`.
