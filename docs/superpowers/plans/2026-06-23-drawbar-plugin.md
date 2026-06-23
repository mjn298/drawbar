# drawbar Plugin (Prompt Layer) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the built `kb` tool into an installable Claude Code plugin — five commands (`setup/design/plan/work/learn`), two review agents, a knowledge skill, and a manifest — implementing the lean, Linear-native design→plan→work→learn workflow.

**Architecture:** A Claude Code plugin manifest (`.claude-plugin/plugin.json`) auto-discovers command/agent/skill markdown from their conventional directories. The `kb` tool is exposed on PATH as `drawbar-kb` via a `package.json` `bin` entry installed with `bun link` (a live symlink to `scripts/kb.ts` — no version drift). Commands are short single-flow prompts following `preflight → inline KB recall → do the work → write back to Linear/KB`. A `scripts/plugin.test.ts` integrity test guards the manifest, bin wiring, and frontmatter of every command/agent file; behavioral correctness is verified by a manual end-to-end smoke run.

**Tech Stack:** Claude Code plugin format (markdown commands/agents/skills + `plugin.json`), Bun (`bin` + `bun link`, `bun test`), the `drawbar-kb` CLI (built in Plan 1), the Linear MCP.

## Global Constraints

- Five commands, exact names: `drawbar-setup`, `drawbar-design`, `drawbar-plan`, `drawbar-work`, `drawbar-learn`. Two agents: `design-reviewer`, `code-reviewer`. One skill: `drawbar-knowledge`.
- The CLI is invoked as **`drawbar-kb`** (never the bundled `scripts/kb.ts` path). `package.json` declares `"bin": { "drawbar-kb": "scripts/kb.ts" }`.
- Per-project data dir: `<project>/.drawbar/memory/` (i.e. `"$PWD/.drawbar/memory"`).
- **Preflight** opens every command except `setup`: if `drawbar-kb` is missing OR `.drawbar/memory/` is absent, stop and tell the user to run `/drawbar-setup`.
- **Inline recall**: `drawbar-design`, `drawbar-plan`, `drawbar-work` each call `drawbar-kb recall …` near the top, before doing their work.
- **Linear**: team `PCO`, project `DRAWBAR`, statuses move `Todo → In Progress → Done`. Spec → parent issue description; stories → ordered sub-issues; decisions/summaries → comments. **Linear MCP absent → warn and continue** (local work + KB writes still flow; skip Linear write-backs).
- **Single-writer rule**: review agents *return findings only*; the command owns all Linear writes.
- **Knowledge types** (6): `learned`, `decision`, `pattern`, `fact`, `investigation`, `deviation`. Mistakes are logged as `learned` entries whose content begins `MUST-CHECK:`.
- `drawbar-kb add` reads the entry as JSON from **stdin** (never shell-interpolated).
- Plugin root is referenced via the `${CLAUDE_PLUGIN_ROOT}` environment variable.

### File map

```
.claude-plugin/plugin.json          # manifest
package.json                        # + bin: { "drawbar-kb": "scripts/kb.ts" }
commands/
  drawbar-setup.md                  # link CLI, init KB, optional import, verify Linear
  drawbar-design.md                 # spec → Linear parent issue description
  drawbar-plan.md                   # stories → ordered sub-issues
  drawbar-work.md                   # implement next Todo story, TDD
  drawbar-learn.md                  # curate lessons into the KB
agents/
  design-reviewer.md                # adversarial design critique before lock
  code-reviewer.md                  # work-phase diff review
skills/drawbar-knowledge/SKILL.md   # how to drive drawbar-kb
scripts/plugin.test.ts              # structural integrity test (grows per task)
scripts/kb.ts + scripts/lib/…       # Plan 1 (built)
```

---

## Task 1: Bin wiring, plugin manifest, integrity test

**Files:**
- Modify: `package.json` (add `bin`)
- Modify: `scripts/kb.ts` (add shebang line 1)
- Create: `.claude-plugin/plugin.json`
- Test: `scripts/plugin.test.ts`

**Interfaces:**
- Consumes: the existing `scripts/kb.ts` from Plan 1.
- Produces: `scripts/plugin.test.ts` with a `frontmatter(path)` helper and two growing arrays `COMMANDS`/`AGENTS` that later tasks extend; the `drawbar-kb` bin; the plugin manifest.

- [ ] **Step 1: Write the failing test**

`scripts/plugin.test.ts`:
```ts
import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");

export function frontmatter(path: string): Record<string, string> {
  const txt = readFileSync(path, "utf8");
  const m = txt.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm: Record<string, string> = {};
  for (const line of m[1]!.split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, "");
  }
  return fm;
}

describe("plugin manifest & bin", () => {
  test("plugin.json is valid and names drawbar", () => {
    const p = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
    expect(p.name).toBe("drawbar");
    expect(typeof p.description).toBe("string");
    expect(p.description.length).toBeGreaterThan(0);
  });

  test("package.json links the drawbar-kb bin to scripts/kb.ts", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.bin?.["drawbar-kb"]).toBe("scripts/kb.ts");
  });

  test("kb.ts has a bun shebang so it can run as a bin", () => {
    const first = readFileSync(join(root, "scripts/kb.ts"), "utf8").split("\n")[0];
    expect(first).toBe("#!/usr/bin/env bun");
  });
});

// Extended by later tasks: append command/agent base names as their files are added.
const COMMANDS: string[] = [];
const AGENTS: string[] = [];

describe("command frontmatter", () => {
  for (const name of COMMANDS) {
    test(`${name} has valid frontmatter`, () => {
      const fm = frontmatter(join(root, "commands", `${name}.md`));
      expect(fm.name).toBe(name);
      expect((fm.description ?? "").length).toBeGreaterThan(0);
    });
  }
});

describe("agent frontmatter", () => {
  for (const name of AGENTS) {
    test(`${name} has valid frontmatter`, () => {
      const fm = frontmatter(join(root, "agents", `${name}.md`));
      expect(fm.name).toBe(name);
      expect((fm.description ?? "").length).toBeGreaterThan(0);
    });
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test scripts/plugin.test.ts`
Expected: FAIL — `.claude-plugin/plugin.json` does not exist; the manifest and bin tests fail.

- [ ] **Step 3: Add the bin entry to `package.json`**

Edit `package.json` so it contains a `bin` field (keep the existing `name`, `version`, `scripts`, etc.):
```json
{
  "name": "drawbar",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "bin": { "drawbar-kb": "scripts/kb.ts" },
  "scripts": {
    "test": "bun test",
    "kb": "bun run scripts/kb.ts"
  }
}
```

- [ ] **Step 4: Add a shebang as the first line of `scripts/kb.ts`**

Insert as the new line 1 (everything else shifts down, unchanged):
```ts
#!/usr/bin/env bun
```

- [ ] **Step 5: Create the plugin manifest**

`.claude-plugin/plugin.json`:
```json
{
  "name": "drawbar",
  "version": "0.1.0",
  "description": "Lean, Linear-native design→plan→work→learn workflow with a per-project compounding knowledge base.",
  "author": { "name": "mjn" }
}
```

- [ ] **Step 6: Run the integrity test, then the full suite**

Run: `bun test scripts/plugin.test.ts`
Expected: PASS — manifest, bin, and shebang tests green.

Run: `bun test`
Expected: PASS — all Plan 1 tests (42) still pass; the shebang on `scripts/kb.ts` does not break importing `run` from `./kb` (Bun strips shebang lines on load). If the full suite regresses, the shebang broke module loading — stop and report it.

- [ ] **Step 7: Commit**

```bash
git add package.json scripts/kb.ts .claude-plugin/plugin.json scripts/plugin.test.ts
git commit -m "feat: add plugin manifest, drawbar-kb bin wiring, and integrity test"
```

---

## Task 2: `/drawbar-setup` command

**Files:**
- Create: `commands/drawbar-setup.md`
- Modify: `scripts/plugin.test.ts` (add `"drawbar-setup"` to `COMMANDS`)

**Interfaces:**
- Consumes: `frontmatter`, the `COMMANDS` loop from Task 1.
- Produces: the setup command. It is the only command WITHOUT the preflight (it creates the preconditions).

- [ ] **Step 1: Extend the integrity test (failing)**

In `scripts/plugin.test.ts`, change the `COMMANDS` array to:
```ts
const COMMANDS: string[] = ["drawbar-setup"];
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test scripts/plugin.test.ts`
Expected: FAIL — `commands/drawbar-setup.md` does not exist; `frontmatter` returns `{}` and `fm.name` is undefined.

- [ ] **Step 3: Write the command**

`commands/drawbar-setup.md`:
```md
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test scripts/plugin.test.ts`
Expected: PASS — `drawbar-setup` frontmatter valid.

- [ ] **Step 5: Commit**

```bash
git add commands/drawbar-setup.md scripts/plugin.test.ts
git commit -m "feat: add /drawbar-setup command"
```

---

## Task 3: `/drawbar-design` command

**Files:**
- Create: `commands/drawbar-design.md`
- Modify: `scripts/plugin.test.ts` (add `"drawbar-design"` to `COMMANDS`)

**Interfaces:**
- Consumes: the `COMMANDS` loop; the `drawbar-kb recall` CLI; the Linear MCP (`get_issue`, `save_issue`, `save_comment`); the `design-reviewer` agent (built in Task 7 — referenced by name).
- Produces: the design command.

- [ ] **Step 1: Extend the integrity test (failing)**

Change `COMMANDS` to:
```ts
const COMMANDS: string[] = ["drawbar-setup", "drawbar-design"];
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test scripts/plugin.test.ts`
Expected: FAIL — `commands/drawbar-design.md` missing.

- [ ] **Step 3: Write the command**

`commands/drawbar-design.md`:
```md
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test scripts/plugin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add commands/drawbar-design.md scripts/plugin.test.ts
git commit -m "feat: add /drawbar-design command"
```

---

## Task 4: `/drawbar-plan` command

**Files:**
- Create: `commands/drawbar-plan.md`
- Modify: `scripts/plugin.test.ts` (add `"drawbar-plan"` to `COMMANDS`)

**Interfaces:**
- Consumes: the `COMMANDS` loop; `drawbar-kb recall`; the Linear MCP (`get_issue`, `save_issue` with `parentId`, `save_comment`).
- Produces: the plan command, which writes ordered story sub-issues using the locked story template.

- [ ] **Step 1: Extend the integrity test (failing)**

Change `COMMANDS` to:
```ts
const COMMANDS: string[] = ["drawbar-setup", "drawbar-design", "drawbar-plan"];
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test scripts/plugin.test.ts`
Expected: FAIL — `commands/drawbar-plan.md` missing.

- [ ] **Step 3: Write the command**

`commands/drawbar-plan.md`:
```md
---
name: drawbar-plan
description: Decompose a locked design (a Linear parent issue) into good, testable, ordered story sub-issues using the Locked/Discretion template.
argument-hint: "<PCO-id of the parent issue>"
---

# drawbar plan

Turn the locked spec into a sequence of small, testable stories. Each story is a Linear sub-issue under the parent.

## Preflight

```bash
command -v drawbar-kb >/dev/null 2>&1 || { echo "drawbar-kb not found — run /drawbar-setup"; exit 1; }
[ -d "$PWD/.drawbar/memory" ] || { echo "no .drawbar/memory — run /drawbar-setup"; exit 1; }
```

## 1. Load the locked spec

`$ARGUMENTS` is the parent issue id. Load it with the Linear MCP `get_issue` (description + comments). This is the spec you are decomposing.

## 2. Recall MUST-CHECK constraints

Detect the story's stack from the spec (languages, frameworks). Then:

```bash
drawbar-kb recall "MUST-CHECK <stack keywords>" --dir "$PWD/.drawbar/memory" --json
```

Every `MUST-CHECK:` entry returned becomes a validation rule the stories must honor.

## 3. Decompose into ordered stories

Break the work into sequential stories (small enough to implement and review independently). For each, write a sub-issue description using this exact template:

```
## What
[Clear description of what to implement.]

## Context
[Relevant findings, constraints, patterns from the spec and recall.]

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

## 4. Cross-check (warning-only)

Before creating issues, verify each story: all template sections present; acceptance criteria are testable; every recalled `MUST-CHECK:` is covered by a Locked decision; scope is reasonable for one sitting. Report any gaps as warnings.

## 5. Create the sub-issues

**Gate:** show the user the ordered story list and get confirmation. Then create each as a Linear sub-issue (`save_issue` with `parentId` = the parent, status `Todo`) in dependency order. Log a `DECISION:` comment on the parent noting the plan is ready.

If the Linear MCP is unavailable, present the stories to the user and note they were not written to Linear. Stop here.

## 6. Report

Print the parent id and the ordered child ids/titles. Next: `/drawbar-work <PCO-id>`.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test scripts/plugin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add commands/drawbar-plan.md scripts/plugin.test.ts
git commit -m "feat: add /drawbar-plan command"
```

---

## Task 5: `/drawbar-work` command

**Files:**
- Create: `commands/drawbar-work.md`
- Modify: `scripts/plugin.test.ts` (add `"drawbar-work"` to `COMMANDS`)

**Interfaces:**
- Consumes: the `COMMANDS` loop; `drawbar-kb recall` and `drawbar-kb add`; the Linear MCP (`list_issues` with `parentId`, `save_issue`, `list_comments`, `save_comment`); the `code-reviewer` agent (Task 7).
- Produces: the work command.

- [ ] **Step 1: Extend the integrity test (failing)**

Change `COMMANDS` to:
```ts
const COMMANDS: string[] = ["drawbar-setup", "drawbar-design", "drawbar-plan", "drawbar-work"];
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test scripts/plugin.test.ts`
Expected: FAIL — `commands/drawbar-work.md` missing.

- [ ] **Step 3: Write the command**

`commands/drawbar-work.md`:
```md
---
name: drawbar-work
description: Implement the next Todo story under a Linear parent issue, test-first, with a code review and fix loop, capturing lessons as you go.
argument-hint: "<PCO-id of the parent issue>"
---

# drawbar work

Implement the next ready story sequentially, following TDD.

## Preflight

```bash
command -v drawbar-kb >/dev/null 2>&1 || { echo "drawbar-kb not found — run /drawbar-setup"; exit 1; }
[ -d "$PWD/.drawbar/memory" ] || { echo "no .drawbar/memory — run /drawbar-setup"; exit 1; }
```

## 1. Pick the next story

`$ARGUMENTS` is the parent issue id. List its sub-issues with the Linear MCP `list_issues` (`parentId` = parent). Take the first story in dependency order whose status is `Todo`. If none are `Todo`, report that all stories are done or in progress and stop.

## 2. Recall + read comments

```bash
drawbar-kb recall "<story title and files>" --dir "$PWD/.drawbar/memory" --json
```

Also read any new comments on the story (`list_comments`) — the user may have left direction. Honor every Locked decision and `MUST-CHECK:` that applies.

## 3. Implement, test-first

Move the story to `In Progress` (`save_issue`). Then follow TDD: write a failing test for the next behavior, run it (RED), implement the minimal code, run it (GREEN), repeat. Run the project's full test suite before considering the story done.

## 4. Review and fix loop

Dispatch the `code-reviewer` agent with the story's diff and its acceptance criteria. Fix every Critical/Important finding it returns, then re-review until clean.

## 5. Capture lessons (inline)

As you hit anything worth remembering (a gotcha, a pattern, a decision, or a mistake), write it to the KB. Pipe a JSON object on stdin (never shell-interpolate content):

```bash
echo '{"key":"<kebab-key>","type":"<learned|decision|pattern|fact|investigation|deviation>","content":"<the lesson>","source":"agent","tags":["..."],"issue":"<PCO-id>","files":["<path>"]}' \
  | drawbar-kb add --dir "$PWD/.drawbar/memory"
```

For a mistake to guard against in future, use type `learned` with content beginning `MUST-CHECK:`.

## 6. Close out

Commit referencing the story id (e.g. `feat: … (PCO-123)`). Post a short summary comment on the story (`save_comment`) and move it to `Done` (`save_issue`).

If the Linear MCP is unavailable, do the implementation and KB capture locally, skip the Linear status/comment updates, and tell the user.

## 7. Report

Print the story id, what shipped, and which stories remain `Todo`. Re-run `/drawbar-work <PCO-id>` for the next one.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test scripts/plugin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add commands/drawbar-work.md scripts/plugin.test.ts
git commit -m "feat: add /drawbar-work command"
```

---

## Task 6: `/drawbar-learn` command

**Files:**
- Create: `commands/drawbar-learn.md`
- Modify: `scripts/plugin.test.ts` (add `"drawbar-learn"` to `COMMANDS`)

**Interfaces:**
- Consumes: the `COMMANDS` loop; `drawbar-kb add`; the Linear MCP (`get_issue` — optional, for context).
- Produces: the learn command.

- [ ] **Step 1: Extend the integrity test (failing)**

Change `COMMANDS` to:
```ts
const COMMANDS: string[] = ["drawbar-setup", "drawbar-design", "drawbar-plan", "drawbar-work", "drawbar-learn"];
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test scripts/plugin.test.ts`
Expected: FAIL — `commands/drawbar-learn.md` missing.

- [ ] **Step 3: Write the command**

`commands/drawbar-learn.md`:
```md
---
name: drawbar-learn
description: Curate durable lessons from the current session's work into the knowledge base. Runs standalone or as the tail of /drawbar-work.
argument-hint: "[PCO-id for attribution]"
---

# drawbar learn

Distill what was learned into durable, queryable knowledge.

## Preflight

```bash
command -v drawbar-kb >/dev/null 2>&1 || { echo "drawbar-kb not found — run /drawbar-setup"; exit 1; }
[ -d "$PWD/.drawbar/memory" ] || { echo "no .drawbar/memory — run /drawbar-setup"; exit 1; }
```

## 1. Review the session

Look over the session's diffs, decisions, and dead-ends. If `$ARGUMENTS` is a Linear issue id, load it (`get_issue`) for attribution and context.

## 2. Extract entries

Pull out durable lessons — not transient narration. Use the right type:
- `learned` — a lesson or gotcha. For a mistake to guard against in future, begin the content with `MUST-CHECK:`.
- `decision` — a choice made and why.
- `pattern` — a reusable approach.
- `fact` — a stable constraint about the system.
- `investigation` — what a dig turned up.
- `deviation` — where you departed from the plan and why.

## 3. Write each entry (safe, deduped)

Pipe a JSON object on stdin per entry (content is never shell-interpolated):

```bash
echo '{"key":"<kebab-key>","type":"<type>","content":"<lesson>","source":"agent","tags":["..."],"issue":"<PCO-id or empty>","files":["<path>"]}' \
  | drawbar-kb add --dir "$PWD/.drawbar/memory"
```

`drawbar-kb add` validates and dedupes by key — re-adding an identical entry is a no-op (`{"written":false}`).

## 4. Report

List the entries written (key + type) and the new `drawbar-kb stats` totals.
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test scripts/plugin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add commands/drawbar-learn.md scripts/plugin.test.ts
git commit -m "feat: add /drawbar-learn command"
```

---

## Task 7: Review agents (`design-reviewer`, `code-reviewer`)

**Files:**
- Create: `agents/design-reviewer.md`
- Create: `agents/code-reviewer.md`
- Modify: `scripts/plugin.test.ts` (set `AGENTS = ["design-reviewer", "code-reviewer"]`)

**Interfaces:**
- Consumes: the `AGENTS` loop; `drawbar-kb recall` (design-reviewer checks the design against logged MUST-CHECKs).
- Produces: the two agent definitions referenced by `/drawbar-design` and `/drawbar-work`.

- [ ] **Step 1: Extend the integrity test (failing)**

Change the `AGENTS` array to:
```ts
const AGENTS: string[] = ["design-reviewer", "code-reviewer"];
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test scripts/plugin.test.ts`
Expected: FAIL — the two `agents/*.md` files do not exist.

- [ ] **Step 3: Write `agents/design-reviewer.md`**

```md
---
name: design-reviewer
description: Adversarially reviews a proposed feature design before it is locked — architecture soundness, simplicity/YAGNI, security, and conflicts with logged MUST-CHECK knowledge. Returns categorized findings; does not write to Linear.
tools: Read, Grep, Glob, Bash
---

You are a skeptical principal engineer reviewing a feature design BEFORE any code is written. Your job is to catch problems while they are cheap to fix.

## Inputs you are given
- The proposed spec / approach.
- The project's `.drawbar/memory` path.

## What to do
1. Query the knowledge base for prior constraints relevant to this design:
   `drawbar-kb recall "MUST-CHECK <stack/area>" --dir "<path>" --json`
   Every `MUST-CHECK:` entry that applies is a hard requirement — flag any design that ignores one.
2. Review across these lenses:
   - **Architecture** — Are the boundaries sound? Will this scale and stay maintainable? Is anything load-bearing left unspecified?
   - **Simplicity / YAGNI** — Is anything over-built? Could a simpler design meet the same goal?
   - **Security** — Auth, tenant isolation, data exposure, injection surfaces.
   - **Testability** — Can the acceptance criteria actually be tested?
3. Default to skepticism: if a risk is plausible, raise it.

## Output (return to the caller — do NOT write to Linear)
- **Critical (must fix before lock):** [findings]
- **Important (should fix):** [findings]
- **Minor (nice to have):** [findings]
- **MUST-CHECK coverage:** which logged constraints apply and whether the design honors them.

For each finding: what's wrong, why it matters, and a concrete fix. Acknowledge genuine strengths briefly first.
```

- [ ] **Step 4: Write `agents/code-reviewer.md`**

```md
---
name: code-reviewer
description: Reviews the diff for one implemented story against its acceptance criteria and for code quality. Returns categorized findings; does not write to Linear.
tools: Read, Grep, Glob, Bash
---

You are a senior code reviewer gating one story's implementation. This is task-scoped: verify the diff matches the story (nothing more, nothing less) and is well-built.

## Inputs you are given
- The story's description (What / Decisions / Testing / Validation / Files).
- The diff under review (a base..head range or a diff file).

## What to do
1. **Spec compliance** — Compare the diff to the story:
   - Missing: acceptance criteria or required behavior not implemented.
   - Extra: scope creep / unrequested features.
   - Misunderstood: the right feature built wrong.
   Honor every Locked decision; flag any violation.
2. **Code quality** — separation of concerns, error handling (no swallowed errors), edge cases, DRY without premature abstraction.
3. **Tests** — Do new tests verify real behavior (not mocks)? Are the story's edge cases covered? Is the test output clean? A test that asserts nothing is a finding.

Inspect code outside the diff only to evaluate a concrete, named risk. Do not crawl the codebase. Read-only — do not modify anything.

## Output (return to the caller — do NOT write to Linear)
- **Spec compliance:** ✅ compliant | ❌ issues (with file:line)
- **Critical (must fix):** [findings]
- **Important (should fix):** [findings]
- **Minor:** [findings]

For each finding: file:line, what's wrong, why it matters, how to fix. Acknowledge strengths briefly first.
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test scripts/plugin.test.ts`
Expected: PASS — both agent frontmatters valid.

- [ ] **Step 6: Commit**

```bash
git add agents/design-reviewer.md agents/code-reviewer.md scripts/plugin.test.ts
git commit -m "feat: add design-reviewer and code-reviewer agents"
```

---

## Task 8: `drawbar-knowledge` skill

**Files:**
- Create: `skills/drawbar-knowledge/SKILL.md`
- Modify: `scripts/plugin.test.ts` (add a skill-frontmatter test)

**Interfaces:**
- Consumes: `frontmatter` from Task 1.
- Produces: the reference skill describing how to drive `drawbar-kb`.

- [ ] **Step 1: Add the failing test**

Append to `scripts/plugin.test.ts` (after the agent describe block):
```ts
describe("skill", () => {
  test("drawbar-knowledge skill has valid frontmatter", () => {
    const fm = frontmatter(join(root, "skills/drawbar-knowledge/SKILL.md"));
    expect(fm.name).toBe("drawbar-knowledge");
    expect((fm.description ?? "").length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test scripts/plugin.test.ts`
Expected: FAIL — `skills/drawbar-knowledge/SKILL.md` missing.

- [ ] **Step 3: Write the skill**

`skills/drawbar-knowledge/SKILL.md`:
```md
---
name: drawbar-knowledge
description: How to read from and write to the drawbar knowledge base via the drawbar-kb CLI — the entry schema, the six types, the MUST-CHECK convention, recall, and safe writes. Use when a drawbar command needs to recall prior lessons or record new ones.
---

# drawbar knowledge base

The knowledge base is a per-project, append-only JSONL store (`<project>/.drawbar/memory/knowledge.jsonl`) indexed by SQLite FTS5, driven by the `drawbar-kb` CLI. The JSONL is the git-tracked source of truth; the index rebuilds automatically.

## Entry schema

```json
{"key":"<kebab-case-unique>","type":"<type>","content":"<the knowledge>","source":"agent","tags":["..."],"ts":<unix seconds, optional>,"issue":"<PCO-id or null>","files":["<path>"]}
```

Required: `key`, `type`, `content`. `source` defaults to `agent`; `tags`/`files` default to `[]`; `issue` defaults to `null`; `ts` defaults to now.

## The six types

- `learned` — a lesson or gotcha. A mistake to guard against begins its content with `MUST-CHECK:`.
- `decision` — a choice and its rationale.
- `pattern` — a reusable approach.
- `fact` — a stable constraint about the system.
- `investigation` — what a dig uncovered.
- `deviation` — a departure from plan and why.

## Recall (read)

```bash
drawbar-kb recall "<query>" --dir "$PWD/.drawbar/memory" --json \
  [--type <type>] [--tag <tag>] [--file <path>] [--since <unix>] [--limit <n>] [--all]
```

Ranked by relevance (FTS5 BM25), deduped by key (latest wins). `--all` includes archived entries. Recall before designing, planning, or implementing so you reuse prior lessons and honor `MUST-CHECK:` constraints.

## Write (safe, deduped)

Always pipe the entry as JSON on **stdin** — never interpolate content into the shell:

```bash
echo '<json entry>' | drawbar-kb add --dir "$PWD/.drawbar/memory"
```

`add` validates the entry and round-trips it through JSON before appending; it fails loudly on invalid input and is a no-op for an identical key+content (`{"written":false}`).

## Other commands

- `drawbar-kb stats [--json]` — counts by type, active vs archived.
- `drawbar-kb reindex` — rebuild the FTS index from the JSONL.
- `drawbar-kb archive --days <n>` — age out entries older than N days.
- `drawbar-kb import <legacy.jsonl>` — one-time import of a legacy corpus (repairs corruption, reports every dropped line).
```

- [ ] **Step 4: Run the test, then the full suite**

Run: `bun test scripts/plugin.test.ts`
Expected: PASS — skill frontmatter valid.

Run: `bun test`
Expected: PASS — full suite green (Plan 1's 42 + the integrity tests).

- [ ] **Step 5: Commit**

```bash
git add skills/drawbar-knowledge/SKILL.md scripts/plugin.test.ts
git commit -m "feat: add drawbar-knowledge skill"
```

---

## Task 9: README setup docs + manual end-to-end smoke verification

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: the whole plugin.
- Produces: install/usage docs and a verified end-to-end run.

- [ ] **Step 1: Write the README**

Replace `README.md` with install + usage docs:
```md
# drawbar

A lean, Linear-native design → plan → work → learn workflow for Claude Code, with a per-project compounding knowledge base.

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
/drawbar-design <feature | PCO-id>         # spec → Linear parent issue
/drawbar-plan <PCO-id>                     # ordered story sub-issues
/drawbar-work <PCO-id>                     # implement next story, TDD
/drawbar-learn [PCO-id]                    # curate lessons into the KB
```

Knowledge lives in `<project>/.drawbar/memory/` (the JSONL is committed; the SQLite index is gitignored). Query it directly anytime:

```bash
drawbar-kb recall "dynamodb tenancy" --dir "$PWD/.drawbar/memory" --json
drawbar-kb stats --dir "$PWD/.drawbar/memory"
```
```

- [ ] **Step 2: Verify the bin links and runs (manual)**

```bash
cd /Users/mjn/workplace/drawbar && bun link
command -v drawbar-kb && drawbar-kb stats --dir "$(mktemp -d)/.drawbar/memory" --json
```
Expected: `drawbar-kb` resolves on PATH and prints `{"active":0,"archived":0,"byType":{}}`. If not found, run `export PATH="$(bun pm bin -g):$PATH"` and retry.

- [ ] **Step 3: Smoke-run the KB loop end to end (manual)**

```bash
SCRATCH=$(mktemp -d); MEM="$SCRATCH/.drawbar/memory"
echo '{"key":"smoke-mustcheck","type":"learned","content":"MUST-CHECK: always filter DynamoDB queries by JWT companyId","source":"user","ts":1,"tags":["security"],"issue":"PCO-1","files":["api/handler.ts"]}' | drawbar-kb add --dir "$MEM"
drawbar-kb recall "MUST-CHECK dynamodb" --dir "$MEM" --json
drawbar-kb stats --dir "$MEM" --json
```
Expected: the entry is added (`{"written":true,...}`), recall returns it ranked, and stats shows `active:1`, `learned:1`. This confirms the recall→MUST-CHECK loop the commands depend on.

- [ ] **Step 4: Verify plugin integrity and full suite**

Run: `bun test`
Expected: PASS — Plan 1 tests plus the full plugin integrity suite (manifest, bin, all five commands, both agents, the skill).

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: add drawbar install and usage README"
```

- [ ] **Step 6: Smoke-run a real feature through the commands (manual, requires Linear)**

In a scratch project with the plugin installed and Linear connected, run `/drawbar-setup`, then `/drawbar-design` on a tiny throwaway feature, `/drawbar-plan` the resulting issue, `/drawbar-work` one story, and `/drawbar-learn`. Confirm: the spec lands as the parent issue description; stories are created as ordered `Todo` sub-issues; a story moves `Todo → In Progress → Done`; a knowledge entry is written tagged with the issue id. Record any rough edges as follow-up issues.

---

## Self-Review

**Spec coverage (Plan 2 section of the design spec):**
- `bin` + `bun link`, no drift → Task 1 (bin) + Task 9 (link verification + README).
- Plugin manifest + auto-discovery → Task 1.
- Preflight on every command but setup → Tasks 3–6 (embedded); setup creates preconditions → Task 2.
- Inline recall in design/plan/work → Tasks 3, 4, 5.
- Five commands → Tasks 2–6. Story template (Locked/Discretion) → Task 4. recall→MUST-CHECK loop → Task 4 (plan) + Task 7 (design-reviewer).
- Linear write-backs (spec→parent description, stories→sub-issues, decisions/summaries→comments) + MCP-absent handling → Tasks 3, 4, 5.
- Two thin agents + single-writer rule (agents return findings, never write Linear) → Task 7.
- `drawbar-knowledge` skill → Task 8.
- Testing = structural integrity + manual smoke run → Task 1 harness (grown through Task 8) + Task 9.
- Open items (Bun global-bin PATH note; plugin.json fields) → resolved in Task 2/Task 9 (PATH note) and Task 1 (concrete plugin.json).

**Placeholder scan:** No TBD/TODO. Every command/agent/skill file is given in full. The `<…>` markers inside command bodies (e.g. `<key terms from the feature>`) are runtime substitutions the agent fills per invocation — intended prompt content, not plan gaps.

**Type/name consistency:** Command names, agent names, and the skill name match the Global Constraints and the integrity-test arrays exactly. `drawbar-kb` subcommands (`recall`, `add`, `stats`, `import`, `reindex`, `archive`) and flags (`--dir`, `--json`, `--type`, `--tag`, `--file`, `--since`, `--limit`, `--all`, `--days`) match the Plan 1 CLI. The entry schema (`key/type/content/source/tags/ts/issue/files`) matches the built `Entry` type.
