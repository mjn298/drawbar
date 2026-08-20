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

- **Yes** → assert it, and say where — the file and the symbol in it.
- **No** → do not assert it. Write it as an instruction to check.

**Name the file and the symbol. Never a line number.** Write `BaseRuleSchema` in
`shared/types/locationGroup.ts` — not `shared/types/locationGroup.ts:74`. Line numbers go stale
the moment anyone edits above them, and this text outlives the tree it was written against; a
symbol name still finds the code a month later. (Review findings are the exception: a reviewer
names a line against the sha it pinned, and reports it the same sitting.)

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

**Before instructing a copy or mirror, state what differs between the source's container and
the destination's container.** One line. If nothing differs, say so. Reading both sides is not
enough and never was: the one time this failed, both files had been read in full and the
sentence naming the difference was simply never written, so "match X exactly" shipped a
component that rendered flush against a panel border. The reference tells you what the code
says; only the comparison tells you what it will *do* where it lands. A `match X exactly` with
no difference line beside it is unwriteable.

**Prefer falsification over confirmation.** Search for the counter-example, not the example. If
a claim cannot be falsified cheaply, downgrade it to an instruction: "check whether X, and match
accordingly" rather than "X is true, do Y."


A false claim in a ticket outlives a false claim in a brief: nobody re-reads it, and it sits in
the backlog until someone implements it exactly as written.

### How to write it

**Plain and short.** A story should land in one read. A ticket nobody finishes reading is a
ticket nobody follows.

- Short sentences, one idea each. If a sentence needs a second read, rewrite it.
- No jargon, no buzzwords, no invented compounds, no metaphors. Say "makes it slower", not
  "introduces latency overhead". Real names of things — `companyId`, oRPC, Zod — are fine;
  the padding around them is not.
- Say it once. Don't restate the goal in What, then Context, then Validation.
- Bullets over paragraphs in What, Testing, Validation, Files.
- Cut any sentence that doesn't change what the implementer does. Motivation, background, and
  "why this matters" belong in the parent spec, not in every child.
- A section with nothing to say gets one line, or `None`. Don't pad it.

The template below is the required shape, not a word count. Most sections are one to five
lines.

Break the work into sequential stories (small enough to implement and review independently). For each, write a sub-issue description using this exact template:

```
## What
[Clear description of what to implement.]

## Context
[Relevant findings, constraints, patterns from the spec and recall. Your own conclusions
about how the code behaves live here, each naming the file and symbol, and the question it
answered.]

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
not decisions — they belong in `## Context`, naming the file and symbol, backed by a
`## Read set` entry.
Neither `### Locked` nor `### Discretion` fits them: `Discretion` means the implementer chooses,
and an observation is not a choice.

This narrows `Locked`; it does not soften it. What still qualifies stays absolute.

## 4. Cross-check (warning-only)

Before creating issues, verify each story: all template sections present; acceptance criteria are testable; every recalled `MUST-CHECK:` is covered by a Locked decision; scope is reasonable for one sitting; no code reference anchored to a line number; and the description passes a read-aloud test — plain words, nothing restated, nothing padded. Report any gaps as warnings.

## 5. Create the sub-issues

**Gate:** show the user the ordered story list and get confirmation. Then create each as a Linear sub-issue (`save_issue` with `parentId` = the parent, status `Todo`) in dependency order. Log a `DECISION:` comment on the parent noting the plan is ready.

If the Linear MCP is unavailable, present the stories to the user and note they were not written to Linear. Stop here.

## 6. Report

Print the parent id and the ordered child ids/titles. Next: `/drawbar-work <issue-id>`.
