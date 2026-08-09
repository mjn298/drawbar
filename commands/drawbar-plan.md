---
name: drawbar-plan
description: Decompose a locked design (a Linear parent issue) into good, testable, ordered story sub-issues using the Locked/Discretion template.
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

Every `MUST-CHECK:` entry returned becomes a validation rule the stories must honor.

## 3. Decompose into ordered stories

### Provenance — what you may assert as fact

Before you write a factual claim someone else will act on, ask the one question with a
mechanical answer:

**Did I read the thing that answers this question, in this session?**

- **Yes** → assert it, and cite `file:line`.
- **No** → do not assert it. Write it as an instruction to check.

The test is **per-question, not per-file**. A search that answered one question licenses
nothing about a different one in the same file: grepping `ruleSets` opens the schema and still
says nothing about whether a rule carries an `id`. Record what each read *established*, not
which paths you touched.

**Point at the evidence, not the conclusion.** Instead of "location rules have no `id`, keep
`key={index}`", write "I have not read the rule schema — check `BaseRuleSchema` in
`shared/types/locationGroup.ts` and match whichever is correct." The second is shorter, and it
produces the right result even when your belief is wrong. That is the whole trick: a belief
written as evidence-plus-instruction is self-correcting, while the same belief written as a
decision is binding — and an agent told it is a hard requirement will build it faithfully.

A false claim in a ticket outlives a false claim in a brief: nobody re-reads it, and it sits in
the backlog until someone implements it exactly as written.

Break the work into sequential stories (small enough to implement and review independently). For each, write a sub-issue description using this exact template:

```
## What
[Clear description of what to implement.]

## Context
[Relevant findings, constraints, patterns from the spec and recall. Your own conclusions
about how the code behaves live here, each with file:line and the question it answered.]

## Read set
[One line per read: what it established, and what it did NOT. A claim in this ticket that
no entry backs is a defect.]

## Decisions
### Locked
[Inherited from the parent — MUST be honored, do not re-debate.]
### Discretion
[Where the implementing agent may choose.]

## Testing
[Specific test cases and edge cases — testable.]

## Validation
[Acceptance criteria.]

## Files
[Specific file paths this story will touch.]

## Dependencies
[Earlier stories that must be done first — defines order.]

## References
[Sources: spec sections, recalled knowledge keys, files.]
```

### What may carry the `Locked` label

`Locked` means someone decided this, and an implementing agent is told it is a hard
requirement rather than a suggestion. That authority has to come from somewhere.

**Only these may be Locked:** operator decisions, decisions inherited from the parent's
locked spec, design-review outcomes, and `MUST-CHECK:` entries recalled from the knowledge
base.

**Your own conclusions from reading code this session may NOT be Locked.** They are evidence,
not decisions — they belong in `## Context` with `file:line`, backed by a `## Read set` entry.
Neither `### Locked` nor `### Discretion` fits them: `Discretion` means the implementer chooses,
and an observation is not a choice.

This narrows `Locked`; it does not soften it. What still qualifies stays absolute.

## 4. Cross-check (warning-only)

Before creating issues, verify each story: all template sections present; acceptance criteria are testable; every recalled `MUST-CHECK:` is covered by a Locked decision; scope is reasonable for one sitting. Report any gaps as warnings.

## 5. Create the sub-issues

**Gate:** show the user the ordered story list and get confirmation. Then create each as a Linear sub-issue (`save_issue` with `parentId` = the parent, status `Todo`) in dependency order. Log a `DECISION:` comment on the parent noting the plan is ready.

If the Linear MCP is unavailable, present the stories to the user and note they were not written to Linear. Stop here.

## 6. Report

Print the parent id and the ordered child ids/titles. Next: `/drawbar-work <issue-id>`.
