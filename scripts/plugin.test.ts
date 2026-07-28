import { test, expect, describe } from "bun:test";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = join(import.meta.dir, "..");

// Reads a file and asserts it is non-empty before returning its text — a grep
// assertion against a missing/empty file is vacuously true, which defeats the
// point of a preservation test. See MUST-CHECK vacuous-assertion-needs-preseed-state.
function readNonEmpty(path: string): string {
  const txt = readFileSync(path, "utf8");
  expect(txt.length).toBeGreaterThan(0);
  return txt;
}

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
const COMMANDS: string[] = ["drawbar-setup", "drawbar-design", "drawbar-plan", "drawbar-work", "drawbar-learn", "drawbar-ship"];
const AGENTS: string[] = ["design-reviewer", "code-reviewer", "security-reviewer", "drawbar-story-lead", "story-implementer"];

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

describe("skill", () => {
  test("drawbar-knowledge skill has valid frontmatter", () => {
    const fm = frontmatter(join(root, "skills/drawbar-knowledge/SKILL.md"));
    expect(fm.name).toBe("drawbar-knowledge");
    expect((fm.description ?? "").length).toBeGreaterThan(0);
  });
});

// PCO-347 fix pass: this repo is public. The ported files were produced by redacting a
// private upstream workspace (team prefixes, CI workflow filenames, absolute paths, and
// repo slugs replaced with `<placeholder>` forms), not by a byte-identical copy — so a
// byte-identity test against that workspace would be permanently false, and would couple
// the suite to a path that does not exist in CI, on any other machine, or once that
// workspace is gone. This test instead asserts the *shape* of a leaked identifier is
// absent, rather than naming the specific identifiers that were once here — naming them
// in a public, permanent test file would itself be the leak the scrub exists to prevent.
//
// Scanned files: the two ported runbook docs, PLUS the KB JSONL and this test file itself
// (PCO-347 review finding: those two are exactly where the worst leaks landed, and a scan
// limited to the docs misses anything an agent later appends to either). Rule scope differs
// per file below — see each rule's comment for why.
describe("ported files carry no private-org identifiers (leak regression)", () => {
  const DOC_FILES = ["commands/drawbar-ship.md", "agents/drawbar-story-lead.md"];
  const SELF_FILES = [".drawbar/memory/knowledge.jsonl", "scripts/plugin.test.ts"];
  // I10 (PCO-349 fix pass): these three files are new, shipped, permanently-public — the
  // same category DOC_FILES/SELF_FILES exist to cover — but were outside every rule's scope
  // until now. No live leak was found in them (the only high-entropy literal is this repo's
  // own public commit sha, cited as fixture provenance); this closes the coverage gap so a
  // future edit to any of them is scanned too.
  const NEW_PUBLIC_FILES = [
    "scripts/lib/coderabbit.ts",
    "scripts/lib/coderabbit.test.ts",
    "scripts/lib/fixtures/f14-historical-cr-ready.sh",
  ];
  const ALL_FILES = [...DOC_FILES, ...SELF_FILES, ...NEW_PUBLIC_FILES];

  // Shape-based rules only: a pattern that describes what a concrete identifier looks like,
  // never a literal naming one. This is strictly weaker at catching a bare unstructured word
  // (e.g. a lone codename) than a denylist of known names would be — accepted trade-off,
  // because a denylist requires writing the name into this public file to check for it.
  //
  // Data-driven so S3's de-hardcoding work (ship-config.ts) can extend this list without
  // touching the test body.
  const FORBIDDEN_PATTERNS: { name: string; files: string[]; test: (txt: string) => boolean }[] = [
    {
      // Any concrete issue id (an uppercase team prefix, a hyphen, then 2+ digits).
      // Placeholders are written `<TEAM>-###` / `<TEAM>-####`, which cannot match: `#` is
      // not `\d`. "PCO-" is excluded: it is this repo's OWN public issue tracker prefix,
      // already present in git history (e.g. real commit messages on `main`) — it is not a
      // leaked private-org identifier, and knowledge.jsonl legitimately cites it in every
      // entry's `issue` field.
      name: "concrete issue id (team-prefix + digits shape, excluding this repo's own PCO- ids)",
      files: ALL_FILES,
      test: (txt) => /\b(?!PCO-)[A-Z]{2,6}-\d{2,}\b/.test(txt),
    },
    {
      // Any concrete workflow/config filename ending .yml/.yaml. The placeholder
      // `<ci-workflow>.yml` cannot match: `[\w-]` does not include `<` or `>`, so the class
      // cannot span the placeholder brackets. (No literal example filename is given here —
      // this comment is itself scanned, and a real-looking example would trip its own rule.)
      name: "concrete workflow/config filename (*.yml / *.yaml shape)",
      files: ALL_FILES,
      test: (txt) => /\b[\w-]+\.ya?ml\b/.test(txt),
    },
    {
      // An absolute macOS/Linux home-directory path. (No literal example is given in this
      // comment for the same self-scanning reason as above.)
      name: "absolute home-directory path",
      files: ALL_FILES,
      test: (txt) => /\/Users\//.test(txt),
    },
    {
      // Concrete `owner/repo` GitHub slugs, scanned on EVERY line (not just lines
      // mentioning a GitHub remote/CLI operation — a prior version scoped to trigger lines
      // and a leak with no trigger word on its line went undetected; see the regression
      // test below). Every slug found must be either placeholder-form (starts with `<`) or
      // on the reviewed allowlist of benign non-placeholder matches enumerated below.
      //
      // Scoped to DOC_FILES only: knowledge.jsonl and this test file are prose-heavy and
      // produce large numbers of ordinary word "/" word matches (e.g. "and/or",
      // "archive/compact") that are not GitHub slugs at all — an allowlist covering those
      // would be unbounded and would stop being reviewable. The issue-id, filename,
      // absolute-path, and literal-vocabulary rules above/below still cover those two files.
      name: "concrete owner/repo GitHub slug not on the reviewed benign allowlist",
      files: DOC_FILES,
      test: (txt) => {
        const slugCandidate = /(?<![\w/])[\w.<>-]+\/[\w.<>-]+(?![\w/])/g;
        // Every non-placeholder slug-shaped match currently in DOC_FILES, reviewed by hand
        // and confirmed benign (paths, generic API vocabulary — none is an org/repo slug).
        const ALLOWLIST = new Set([
          "drawbar/memory",
          ".drawbar/memory",
          "ENV_DIR/<repo>",
          "PROJECT_DIR/.git",
          "creation/update",
          "failing/cancelled",
          "backend/security-touching",
          "Critical/Important",
          "head/statuses",
        ]);
        for (const line of txt.split("\n")) {
          for (const m of line.match(slugCandidate) ?? []) {
            if (m.startsWith("<")) continue; // placeholder form
            if (ALLOWLIST.has(m)) continue; // reviewed benign
            return true;
          }
        }
        return false;
      },
    },
    // Plain literals kept only for strings that are generic GitHub/API vocabulary and
    // identify no one. Scoped to DOC_FILES + knowledge.jsonl, NOT this test file: this
    // rule's own implementation must contain the literal string to check for it, so
    // self-scanning plugin.test.ts against it is a paradox, not a leak.
    {
      name: 'literal "repository_dispatch"',
      files: [...DOC_FILES, ".drawbar/memory/knowledge.jsonl"],
      test: (txt) => txt.includes("repository_dispatch"),
    },
    {
      name: 'literal "workflow_dispatch"',
      files: [...DOC_FILES, ".drawbar/memory/knowledge.jsonl"],
      test: (txt) => txt.includes("workflow_dispatch"),
    },
  ];

  // The KB archive is created on demand: `drawbar-kb archive` moves aged entries here, and
  // a supersede (re-adding an existing key) moves the PREVIOUS version here too. That makes
  // it the file most likely to retain pre-scrub text the active store no longer shows.
  // PCO-347 hit exactly that: superseding four entries to redact them left the unredacted
  // originals sitting here, untracked and not covered by .drawbar/memory/.gitignore — one
  // `git add -A` from re-publishing the very text the supersede removed. Scanned whenever it
  // exists; its absence is a legitimate state and is asserted explicitly, so a skip is
  // visible in the run rather than a silent pass (MUST-CHECK vacuous-assertion-needs-preseed-state).
  const ARCHIVE = ".drawbar/memory/knowledge.archive.jsonl";
  for (const rule of FORBIDDEN_PATTERNS.filter((r) =>
    r.files.includes(".drawbar/memory/knowledge.jsonl"),
  )) {
    test(`${ARCHIVE} (when present) has no ${rule.name}`, () => {
      const path = join(root, ARCHIVE);
      if (!existsSync(path)) {
        expect(existsSync(path)).toBe(false); // archive absent — nothing to scan
        return;
      }
      expect(rule.test(readNonEmpty(path))).toBe(false);
    });
  }

  for (const rule of FORBIDDEN_PATTERNS) {
    for (const file of rule.files) {
      test(`${file} does not contain ${rule.name}`, () => {
        // Assert non-empty first (readNonEmpty) — a missing/empty file would make the
        // absence assertion below vacuously true. See MUST-CHECK
        // vacuous-assertion-needs-preseed-state.
        const txt = readNonEmpty(join(root, file));
        expect(rule.test(txt)).toBe(false);
      });
    }
  }
});

describe("repo-identity preflight guard fails closed", () => {
  // Extract the EXPECTED_REPO guard from the actual preflight bash block in the shipped
  // doc, rather than hand-reimplementing it — a hand probe that drifts from the real
  // source would defeat the point. See MUST-CHECK
  // verification-harness-must-replicate-full-fixture.
  function extractGuard(): string {
    const txt = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    const sectionStart = txt.indexOf("## Preflight (halt on any failure)");
    expect(sectionStart).toBeGreaterThan(-1);
    const fenceStart = txt.indexOf("```bash", sectionStart);
    const fenceEnd = txt.indexOf("```", fenceStart + 7);
    expect(fenceStart).toBeGreaterThan(-1);
    expect(fenceEnd).toBeGreaterThan(fenceStart);
    const block = txt.slice(fenceStart + 7, fenceEnd);
    const guardStart = block.indexOf("# EXPECTED_REPO");
    expect(guardStart).toBeGreaterThan(-1);
    const esacIdx = block.indexOf("esac", guardStart);
    expect(esacIdx).toBeGreaterThan(-1);
    return block.slice(guardStart, esacIdx + "esac".length);
  }

  async function runGuard(env: Record<string, string>): Promise<{ code: number; output: string }> {
    const script = extractGuard();
    const proc = Bun.spawn(["bash", "-c", script], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { code, output: out + err };
  }

  test("refuses when EXPECTED_REPO is unset", async () => {
    const { code, output } = await runGuard({ REPO: "org/repo" });
    expect(code).not.toBe(0);
    expect(output).toContain("EXPECTED_REPO is unset");
  });

  test("refuses when EXPECTED_REPO is set but empty", async () => {
    const { code, output } = await runGuard({ REPO: "org/repo", EXPECTED_REPO: "" });
    expect(code).not.toBe(0);
    expect(output).toContain("EXPECTED_REPO is unset");
  });

  test("refuses when REPO does not match a configured EXPECTED_REPO", async () => {
    const { code, output } = await runGuard({ REPO: "someone-else/other-repo", EXPECTED_REPO: "org/repo" });
    expect(code).not.toBe(0);
    expect(output).toContain("expected repo");
  });

  test("passes when REPO matches a configured EXPECTED_REPO", async () => {
    const { code } = await runGuard({ REPO: "org/repo", EXPECTED_REPO: "org/repo" });
    expect(code).toBe(0);
  });
});

// PCO-347 fix pass, Critical 1: `STORY=<TEAM>-####` in the merge block was UNQUOTED — bash
// parses `<` and `>` as redirection there, silently assigning STORY="" and turning the
// downstream branch-identity guard's `case *"$STORY"*` pattern into `**`, which matches any
// branch. Quoting the assignment AND asserting STORY is non-empty are independent fixes;
// this harness proves the second one actually gates an unrelated branch when STORY is empty
// (a hand-run repro of the parsing bug alone is not a regression test).
describe("merge guard fails closed when STORY is unset", () => {
  // Extract from the lc() self-test through just before the real `gh pr merge` call, so the
  // guard logic (lc self-test, STORY non-empty assertion, branch/base/state checks) runs for
  // real while the destructive final command never executes. Mirrors extractGuard() above:
  // pulled from the actual shipped doc, not hand-reimplemented.
  function extractMergeGuard(): string {
    const txt = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    const sectionStart = txt.indexOf("## 4. Merge");
    expect(sectionStart, "'## 4. Merge' heading not found").toBeGreaterThan(-1);
    const fenceStart = txt.indexOf("```bash", sectionStart);
    const fenceEnd = txt.indexOf("```", fenceStart + 7);
    expect(fenceStart).toBeGreaterThan(-1);
    expect(fenceEnd).toBeGreaterThan(fenceStart);
    const block = txt.slice(fenceStart + 7, fenceEnd);
    const guardStart = block.indexOf("lc() {");
    expect(guardStart, "lc() self-test not found in the merge block").toBeGreaterThan(-1);
    const mergeIdx = block.indexOf("gh pr merge -R");
    expect(mergeIdx, "'gh pr merge -R' not found after the guard").toBeGreaterThan(guardStart);
    return block.slice(guardStart, mergeIdx);
  }

  // Fake `gh` on PATH so the guard runs without a real PR or network access. Only `pr view`
  // is needed here: the extracted fragment starts after the `gh pr checks` line, and the
  // STORY-empty case never reaches `gh pr view` at all (the assertion fires first).
  function makeFakeGh(env: { branch?: string; base?: string; state?: string }): string {
    const dir = mkdtempSync(join(tmpdir(), "drawbar-gh-stub-"));
    const gh = join(dir, "gh");
    writeFileSync(
      gh,
      `#!/usr/bin/env bash\n` +
        `if [ "$1" = "pr" ] && [ "$2" = "view" ]; then\n` +
        `  echo "${env.branch ?? "user/other-branch"} ${env.base ?? "main"} ${env.state ?? "OPEN"}"\n` +
        `fi\n`
    );
    chmodSync(gh, 0o755);
    return dir;
  }

  async function runMergeGuard(
    env: Record<string, string>,
    ghEnv: { branch?: string; base?: string; state?: string } = {}
  ): Promise<{ code: number; output: string }> {
    const script = extractMergeGuard();
    const binDir = makeFakeGh(ghEnv);
    const proc = Bun.spawn(["bash", "-c", script], {
      // Combined stdout+stderr: `echo` writes to stdout by default, and a test reading only
      // stderr sees an empty string on a correctly-failing guard. See MUST-CHECK
      // bash-echo-goes-to-stdout-not-stderr.
      env: { PATH: `${binDir}:${process.env.PATH ?? ""}`, ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { code, output: out + err };
  }

  test("refuses an unrelated branch when STORY is empty", async () => {
    const { code, output } = await runMergeGuard(
      { STORY: "", PR: "1", REPO: "org/repo" },
      { branch: "attacker/unrelated-branch" }
    );
    expect(code).not.toBe(0);
    expect(output).toContain("STORY unset");
  });

  test("passes when STORY matches the PR's branch", async () => {
    const { code } = await runMergeGuard(
      { STORY: "ABC-1", PR: "1", REPO: "org/repo" },
      { branch: "someone/abc-1-slug" }
    );
    expect(code).toBe(0);
  });
});

// PCO-349 — the CodeRabbit completion predicate (F14 fix) and its TIMEOUT-parks fix.
// Anchored on the ACTUAL shipped markdown throughout, never a paraphrase or a
// hand-reconstructed stand-in — see MUST-CHECK
// verification-harness-must-replicate-full-fixture and l23-preservation-tests-need-anchor-not-just-header.
describe("CodeRabbit verdict predicate — single implementation, TIMEOUT parks (PCO-349)", () => {
  // Extracts the §7 bash fence from the real shipped agent file, exactly like
  // extractGuard()/extractMergeGuard() above.
  function extractSection7Fence(): string {
    const txt = readNonEmpty(join(root, "agents/drawbar-story-lead.md"));
    const sectionStart = txt.indexOf("## 7. Drive it green");
    expect(sectionStart, "'## 7. Drive it green' heading not found").toBeGreaterThan(-1);
    const fenceStart = txt.indexOf("```bash", sectionStart);
    const fenceEnd = txt.indexOf("```", fenceStart + 7);
    expect(fenceStart).toBeGreaterThan(-1);
    expect(fenceEnd).toBeGreaterThan(fenceStart);
    return txt.slice(fenceStart + 7, fenceEnd);
  }

  // Extracts just the wait loop (`while :; do` ... matching `done`), so a test can drive it
  // to its TIMEOUT branch without waiting out a real DEADLINE=+3600s — the DEADLINE value
  // itself is supplied by the test's environment instead of the doc's own computation line.
  function extractWaitLoop(): string {
    const block = extractSection7Fence();
    const loopStart = block.indexOf("while :; do");
    expect(loopStart, "'while :; do' not found in §7").toBeGreaterThan(-1);
    // Anchored on "\ndone", not bare "done" — the latter matches anywhere, including inside
    // a word (e.g. a future "abandoned"/"undone" in the loop body would truncate the
    // extraction silently). A closing `done` is always alone on its own line.
    const doneIdx = block.indexOf("\ndone", loopStart);
    expect(doneIdx, "'done' not found closing the §7 wait loop").toBeGreaterThan(loopStart);
    return block.slice(loopStart, doneIdx + "\ndone".length) + '\necho "STATUS=$STATUS"\n';
  }

  function makeFakeBin(dir: string, name: string, script: string): void {
    const path = join(dir, name);
    writeFileSync(path, script);
    chmodSync(path, 0o755);
  }

  // C2: the only test that previously executed §7's bash always fed `gh pr checks` a "false"
  // answer, so the `if` body — the `bun run`, the `jq` parse, the ready branch, the
  // rate-limited branch — was never executed by any test. Measured mutation survivors this
  // closes: `if [ "$OK" = "true" ]` -> `!= "false"` (turns every infrastructure failure into
  // STATUS=ready), deleting the `bun run …coderabbit.ts` line entirely, and
  // "rate_limited" -> "ratelimited".
  function makeFakeGhForVerdict(statusesJson: string): string {
    const dir = mkdtempSync(join(tmpdir(), "drawbar-cr-verdict-stub-"));
    makeFakeBin(
      dir,
      "gh",
      `#!/usr/bin/env bash\n` +
        `if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then\n` +
        `  echo "true"\n` +
        `elif [[ "$2" == repos/*/pulls/* ]]; then\n` +
        `  echo '{"head":{"sha":"deadbeef00"}}' | jq -r "$4"\n` +
        `elif [[ "$2" == repos/*/commits/*/statuses ]]; then\n` +
        `  cat <<'STATUSES_EOF'\n${statusesJson}\nSTATUSES_EOF\n` +
        `fi\n`,
    );
    return dir;
  }

  async function runWaitLoop(env: Record<string, string>): Promise<{ code: number; output: string }> {
    const script = extractWaitLoop();
    const proc = Bun.spawn(["bash", "-c", script], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { code, output: out + err }; // see MUST-CHECK bash-echo-goes-to-stdout-not-stderr
  }

  test("§7 reaches STATUS=ready on a real 'Review completed' verdict, driven through the actual coderabbit.ts module", async () => {
    const binDir = makeFakeGhForVerdict(
      JSON.stringify([
        { context: "CodeRabbit", state: "success", description: "Review completed", updated_at: "2026-07-28T18:06:18Z" },
      ]),
    );
    const { output } = await runWaitLoop({
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      REPO: "org/repo",
      PR: "1",
      CLAUDE_PLUGIN_ROOT: root,
      DEADLINE: String(Math.floor(Date.now() / 1000) + 3600),
    });
    expect(output).toContain("STATUS=ready");
    expect(output).not.toContain("TIMEOUT");
  });

  test("§7 parks (does not merge) on a real 'Review rate limited' verdict, before the deadline", async () => {
    const binDir = makeFakeGhForVerdict(
      JSON.stringify([
        { context: "CodeRabbit", state: "success", description: "Review rate limited", updated_at: "2026-07-28T18:06:18Z" },
      ]),
    );
    const { output } = await runWaitLoop({
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      REPO: "org/repo",
      PR: "1",
      CLAUDE_PLUGIN_ROOT: root,
      DEADLINE: String(Math.floor(Date.now() / 1000) + 3600),
    });
    expect(output).toContain("STATUS=parked");
    expect(output).not.toContain("STATUS=ready");
    // Parked immediately by the rate-limited branch, not by burning the hour-long deadline.
    expect(output).not.toContain("TIMEOUT");
  });

  test("§7 parks immediately (never STATUS=ready) when the module is unavailable, rather than silently waiting out the deadline", async () => {
    const binDir = makeFakeGhForVerdict(
      JSON.stringify([
        { context: "CodeRabbit", state: "success", description: "Review completed", updated_at: "2026-07-28T18:06:18Z" },
      ]),
    );
    const emptyRoot = mkdtempSync(join(tmpdir(), "drawbar-cr-no-module-"));
    const { output } = await runWaitLoop({
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      REPO: "org/repo",
      PR: "1",
      // Set but wrong: no scripts/lib/coderabbit.ts under here, so `bun run` fails and VERDICT
      // is unparseable JSON — this must park via the "VERDICT_UNAVAILABLE" branch (I3),
      // never reach STATUS=ready, and never have to wait out the hour-long deadline either.
      CLAUDE_PLUGIN_ROOT: emptyRoot,
      DEADLINE: String(Math.floor(Date.now() / 1000) + 3600),
    });
    expect(output).toContain("STATUS=parked");
    expect(output).toContain("VERDICT_UNAVAILABLE");
    expect(output).not.toContain("STATUS=ready");
    expect(output).not.toContain("TIMEOUT");
  });

  test("§7's TIMEOUT path yields STATUS=parked, not a silent pass-through", async () => {
    const script = extractWaitLoop();
    const binDir = mkdtempSync(join(tmpdir(), "drawbar-cr-stub-"));
    // Always reports "not all checks concluded" so the loop never takes the ready branch —
    // it falls straight to the deadline check, which we've already put in the past.
    makeFakeBin(binDir, "gh", `#!/usr/bin/env bash\necho "false"\n`);
    const proc = Bun.spawn(["bash", "-c", script], {
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        REPO: "org/repo",
        PR: "1",
        CLAUDE_PLUGIN_ROOT: root,
        // Already elapsed — the loop must hit TIMEOUT on its first iteration, not sleep 60s.
        DEADLINE: "1",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const combined = out + err; // see MUST-CHECK bash-echo-goes-to-stdout-not-stderr
    expect(combined).toContain("TIMEOUT");
    expect(combined).toContain("STATUS=parked");
    // Must NOT be indistinguishable from a pass.
    expect(combined).not.toContain("STATUS=ready");
  });

  // PCO-349 fix pass 3, Important 3: `: "${CLAUDE_PLUGIN_ROOT:?...}"` was only ever "caught"
  // by the misleading line-number-pinned I6 allowlist (see Important 2) — replacing it with
  // `true` (line count preserved) left all 217 tests green. Runs the real §7 loop with
  // CLAUDE_PLUGIN_ROOT unset and asserts the guard fails the whole script closed: non-zero
  // exit, never STATUS=ready.
  test("§7's wait loop fails closed (never STATUS=ready) when CLAUDE_PLUGIN_ROOT is unset", async () => {
    const script = extractWaitLoop();
    const proc = Bun.spawn(["bash", "-c", script], {
      // Deliberately omit CLAUDE_PLUGIN_ROOT — Bun.spawn's `env` fully replaces the child's
      // environment rather than merging with the parent's, so this reliably leaves it unset
      // regardless of what the test runner's own process happens to have.
      env: {
        PATH: process.env.PATH ?? "",
        REPO: "org/repo",
        PR: "1",
        DEADLINE: String(Math.floor(Date.now() / 1000) + 3600),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    expect(code).not.toBe(0);
    expect(out + err).toContain("CLAUDE_PLUGIN_ROOT must be set");
    expect(out).not.toContain("STATUS=ready");
  });

  // PCO-349 fix pass 3, Important 1: a well-formed but infrastructure-broken verdict
  // (`fetch_failed` — e.g. `gh` missing from PATH) passed the `case "$OK" in true|false)`
  // guard (REASON isn't unparseable, it's a real string) and fell all the way through to the
  // ordinary poll-until-deadline path — indistinguishable from "CodeRabbit hasn't finished
  // yet" until the full hour elapsed. Fixed by bounding consecutive fetch_failed iterations.
  // `sleep` is stubbed to a no-op alongside `gh` so 3+ iterations complete near-instantly —
  // DEADLINE is set short (not the real 3600s) so the PRE-fix behavior (silently burning the
  // whole duration) is observable in a bounded test.
  function makeFakeGhAlwaysFetchFailed(): string {
    const dir = mkdtempSync(join(tmpdir(), "drawbar-cr-fetchfail-stub-"));
    makeFakeBin(
      dir,
      "gh",
      `#!/usr/bin/env bash\n` +
        `if [ "$1" = "pr" ] && [ "$2" = "checks" ]; then\n` +
        `  echo "true"\n` +
        `elif [[ "$2" == repos/*/pulls/* ]]; then\n` +
        `  exit 1\n` + // every head-sha lookup fails -> checkPr always returns fetch_failed
        `fi\n`,
    );
    makeFakeBin(dir, "sleep", `#!/usr/bin/env bash\n:\n`); // no-op: don't actually pause
    return dir;
  }

  test("§7 parks with a distinct reason after repeated fetch_failed verdicts, rather than burning the full deadline on an infrastructure failure", async () => {
    const binDir = makeFakeGhAlwaysFetchFailed();
    const { output } = await runWaitLoop({
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      REPO: "org/repo",
      PR: "1",
      CLAUDE_PLUGIN_ROOT: root,
      // Short deadline: if the fix's bounded-retry park doesn't fire, the loop falls through
      // to this deadline instead — proving the pre-fix module actually reaches TIMEOUT here,
      // not merely hanging for an unrelated reason.
      DEADLINE: String(Math.floor(Date.now() / 1000) + 5),
    });
    expect(output).toContain("STATUS=parked");
    expect(output).toContain("FETCH_FAILED_REPEATED");
    expect(output).not.toContain("STATUS=ready");
    // The whole point: parked BEFORE the deadline, not by falling through to it.
    expect(output).not.toContain("TIMEOUT");
  });

  // Real F14 input, not a plausible reconstruction: pinned as a checked-in fixture rather
  // than resolved via `git show HEAD` — HEAD is a moving ref, and the moment this story's
  // fix commit lands, HEAD holds the FIXED agent file, which would silently invert this test
  // (see scripts/lib/fixtures/f14-historical-cr-ready.sh for full provenance, and MUST-CHECK
  // regression-guard-must-be-tested-against-the-real-historical-input).
  function extractHistoricalCrReady(): string {
    const txt = readNonEmpty(join(root, "scripts/lib/fixtures/f14-historical-cr-ready.sh"));
    const start = txt.indexOf("cr_ready() {");
    expect(start, "historical cr_ready() not found in the pinned fixture").toBeGreaterThan(-1);
    const end = txt.indexOf("\n}", start);
    expect(end).toBeGreaterThan(start);
    return txt.slice(start, end + 2);
  }

  test("the historical .state-only predicate passes the real F14 input (state=success, description=\"Review rate limited\") — proving the bug existed", async () => {
    const crReady = extractHistoricalCrReady();
    const binDir = mkdtempSync(join(tmpdir(), "drawbar-cr-hist-"));
    // Fake `gh api` that runs the SAME jq expression the real predicate passes via --jq,
    // against a real F14-shaped payload — so the historical jq filter itself decides the
    // output, not a value we chose to make the test pass.
    makeFakeBin(
      binDir,
      "gh",
      `#!/usr/bin/env bash\n` +
        `if [[ "$2" == repos/*/pulls/* ]]; then\n` +
        `  echo '{"head":{"sha":"deadbeef00"}}' | jq -r "$4"\n` +
        `elif [[ "$2" == repos/*/commits/*/statuses ]]; then\n` +
        `  echo '[{"context":"CodeRabbit","state":"success","description":"Review rate limited","updated_at":"2026-07-28T18:06:18Z"}]' | jq -r "$4"\n` +
        `fi\n`
    );
    const script = `REPO=org/repo\nPR=1\n${crReady}\ncr_ready; echo "EXIT=$?"\n`;
    const proc = Bun.spawn(["bash", "-c", script], {
      env: { PATH: `${binDir}:${process.env.PATH ?? ""}` },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    expect(out + err).toContain("EXIT=0"); // the bug: rate-limited was treated as ready
  });

  test("coderabbitVerdict refuses the identical real F14 input", async () => {
    const { coderabbitVerdict } = await import("./lib/coderabbit");
    const verdict = coderabbitVerdict({
      headSha: "deadbeef00",
      statuses: [
        {
          context: "CodeRabbit",
          state: "success",
          description: "Review rate limited",
          sha: "deadbeef00",
          updated_at: "2026-07-28T18:06:18Z",
        },
      ],
    });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("rate_limited");
  });

  // I6: the old version of this test only scanned three hardcoded paths with a TS-only
  // regex (`description === "Review completed"`), so a hand-rolled bash/jq duplicate of the
  // predicate inserted into §7 — e.g.
  // `--jq '[.[] | select(.context=="CodeRabbit" and .state=="success" and
  // .description=="Review completed")] | length'` — used `==`, not `===`, and a NEW file
  // wasn't scanned at all either way. Both slipped past silently. Fixed by grepping the
  // whole repo (not a fixed file list) for both the phrase AND the jq-shaped context
  // comparison, then asserting the exact multiset of (file, matched-line-content) pairs
  // found is covered by a reviewed allowlist — any new occurrence anywhere fails loudly for
  // a human to triage, rather than needing a smarter regex to anticipate every future
  // duplicate's syntax.
  //
  // Scoped to the runbook/implementation surfaces (commands/, agents/, skills/, scripts/)
  // and excludes `*.test.ts`: test fixtures legitimately construct dozens of literal
  // `"Review completed"` status objects as data, which is not an implementation site and
  // would make this allowlist churn on every unrelated test edit. A duplicate predicate
  // placed in a test file wouldn't execute in production, which is the risk this guard
  // targets. Scan root is `scripts` (not just `scripts/lib`) so a duplicate landing in any
  // future `scripts/*.ts` (e.g. a de-hardcoded ship-config module) is not invisible.
  //
  // PCO-349 fix pass 3, Important 2: keyed on (file, TRIMMED line content) rather than
  // (file, line number) — the previous line-number key broke on ANY line-shifting edit to an
  // allowlisted file (a one-line insert anywhere above an allowlisted line, or a one-line
  // deletion, both fail this test for the wrong reason: "new duplicate predicate?" when
  // nothing moved but the line number). A `Map<key, count>` MULTISET, not a `Set`: keying on
  // content alone would let a genuine second, identical copy of an allowlisted line silently
  // pass (both instances share the same key), which a line-number Set would have caught by
  // virtue of the two copies naturally landing on different line numbers. This is also
  // STRICTLY STRONGER against a different mutation: editing an allowlisted line to weaken it
  // (e.g. loosening `description === "Review completed"`) changes its content, so it no
  // longer matches its allowlist key and now fails loudly too — a line-number key would have
  // stayed silent on that edit (see the two proofs below the assertions).
  test("the CodeRabbit completion predicate has no occurrence outside the reviewed allowlist (I6)", () => {
    const proc = Bun.spawnSync(
      [
        "grep",
        "-rn",
        "-E",
        'Review completed|context=="CodeRabbit"|context === "CodeRabbit"',
        "commands",
        "agents",
        "skills",
        "scripts",
        "--include=*.md",
        "--include=*.ts",
        "--include=*.sh",
        "--exclude=*.test.ts",
      ],
      { cwd: root },
    );
    // grep exits 0 (matches found) or 1 (no matches) on success; anything else means the
    // grep itself broke (bad cwd, renamed dir) rather than the repo being clean — a broken
    // grep must not silently pass as "found nothing to check".
    expect(proc.exitCode, `grep failed to run: ${proc.stderr.toString()}`).toBeLessThanOrEqual(1);
    const lines = proc.stdout.toString().split("\n").filter((l) => l.length > 0);
    const matches = lines.map((l) => {
      const firstColon = l.indexOf(":");
      const secondColon = l.indexOf(":", firstColon + 1);
      return { file: l.slice(0, firstColon), content: l.slice(secondColon + 1).trim() };
    });
    const keyOf = (m: { file: string; content: string }) => `${m.file} ${m.content}`;

    // Non-vacuity: assert the scan actually found the known-good implementation's real
    // CONTENT, not merely a non-empty grep at some line number (a content assertion survives
    // the very line-shifting edit this fix exists to tolerate).
    expect(
      matches.some((m) => m.file === "scripts/lib/coderabbit.ts" && m.content.includes('description === "Review completed"')),
      "scan did not find the module's own allowlist check — broken grep, not a clean repo",
    ).toBe(true);

    // Multiset: file+content -> how many occurrences are reviewed-and-allowed there.
    const ALLOWLIST = new Map<string, number>([
      // The module implementation: the single-winner allowlist check, and the tie-break
      // allowlist check (Critical 1's fail-closed-on-ties fix) — both are the one real
      // implementation, not a second copy.
      ["scripts/lib/coderabbit.ts if (latest.state === \"success\" && latest.description === \"Review completed\") {", 1],
      ["scripts/lib/coderabbit.ts (w) => shaMatchesHead(w, headSha) && w.state === \"success\" && w.description === \"Review completed\",", 1],
      // I5's endpoint-injection-guard comment, discussing the predicate, not implementing it.
      ["scripts/lib/coderabbit.ts // (success, \"Review completed\") into a universal ok:true oracle. Validated at the CLI", 1],
      // Appendix measured-evidence table row and amendment prose (Locked 23).
      ["commands/drawbar-ship.md Review completed    success   18:06:18", 1],
      ["commands/drawbar-ship.md `description=\"Review completed\"` — against the current head sha, taking the MAX `updated_at`", 1],
      ["commands/drawbar-ship.md tie between `Review completed` and any other CodeRabbit status therefore can never pass;", 1],
      // §7's prose describing the predicate before the bash fence.
      ["agents/drawbar-story-lead.md longer sorts. Operator-relevant consequence: a same-second tie between `Review completed` and", 1],
      ["agents/drawbar-story-lead.md bug. Only the exact allowlisted pair (`state=success`, `description=\"Review completed\"`)", 1],
      // The pinned historical (pre-fix) fixture's OLD `.state`-only jq expression.
      ["scripts/lib/fixtures/f14-historical-cr-ready.sh --jq 'map(select(.context==\"CodeRabbit\")) | first | .state // \"none\"' 2>/dev/null)", 1],
    ]);

    const actualCounts = new Map<string, number>();
    for (const m of matches) actualCounts.set(keyOf(m), (actualCounts.get(keyOf(m)) ?? 0) + 1);

    for (const m of matches) {
      const key = keyOf(m);
      const allowed = ALLOWLIST.get(key) ?? 0;
      const actual = actualCounts.get(key)!;
      expect(
        actual <= allowed,
        `unreviewed occurrence at ${m.file} (content: ${JSON.stringify(m.content)}) — new duplicate predicate, or an allowlisted line duplicated beyond its reviewed count?`,
      ).toBe(true);
    }
  });

  test("the old .state-only bash predicate is gone from both markdown files", () => {
    const shipTxt = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    const leadTxt = readNonEmpty(join(root, "agents/drawbar-story-lead.md"));
    for (const txt of [shipTxt, leadTxt]) {
      expect(txt).not.toContain("cr_ready()");
      expect(txt).not.toContain('map(select(.context=="CodeRabbit")) | first | .state');
      expect(txt).not.toContain('case "$st" in success|failure|error');
    }
  });

  // I8: `expect(txt).toContain("scripts/lib/coderabbit.ts")` against the WHOLE file matched
  // the prose paragraph above the fence too — which is exactly why deleting the `bun run`
  // invocation line (C2 mutation 2) left this test green. Anchor on the fence itself and
  // assert the actual invocation shape, which also enforces that call sites reference
  // `${CLAUDE_PLUGIN_ROOT}` (nothing else currently checks that).
  test("§7's bash fence actually invokes the shared module via ${CLAUDE_PLUGIN_ROOT}, not just mentions it in prose", () => {
    const fence = extractSection7Fence();
    expect(fence).toContain('bun run "${CLAUDE_PLUGIN_ROOT}/scripts/lib/coderabbit.ts" verdict --repo "$REPO" --pr "$PR"');
  });

  test("the drawbar-ship.md measured-evidence Appendix survives, amended not deleted (Locked 23)", () => {
    const txt = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    // The original measured evidence is untouched...
    expect(txt).toContain("## Appendix — why the CodeRabbit gate is shaped the way it is");
    expect(txt).toContain("Review completed    success   18:06:18");
    expect(txt).toContain("Verified in the first real run: concluded `success` in ~3 minutes and re-armed per head sha.");
    // ...and the amendment says the signal is right but `.state` alone is not the predicate.
    expect(txt).toContain("Amendment (F14)");
    expect(txt).toContain("is not the right *predicate*");
  });

  describe("no @coderabbitai command is ever issued (Locked 7)", () => {
    // I7: the old detector only matched `review|full review`, missing CodeRabbit's other
    // commands (`resolve`, `pause`, `resume`, `summary`, `plan`, `configuration`, "generate
    // docstrings") — a reviewer added `gh pr comment ... --body "@coderabbitai resolve"` to
    // §7 and the suite stayed green. It also exempted any line starting with `#`, but in
    // markdown `#` is a HEADING, not a comment — a line like
    // "## Step 3: post @coderabbitai review" is a real instruction an LLM reading the
    // runbook would follow, and the old exemption skipped it. Fixed by matching
    // "@coderabbitai" followed by whitespace then any non-space token (broad enough to catch
    // any command, known or future) and dropping the "#"-line exemption entirely — a mention
    // that is genuinely just prose (e.g. backtick-wrapped, `` `@coderabbitai` command ``) has
    // no whitespace immediately after the handle and so does not match on its own, with no
    // special-casing required.
    function isCommandIssuingMention(line: string): boolean {
      return /@coderabbitai\s+\S/.test(line);
    }

    test("the detector actually catches a real invocation shape (positive control)", () => {
      expect(isCommandIssuingMention('gh pr comment "$PR" --body "@coderabbitai full review"')).toBe(true);
      expect(isCommandIssuingMention("@coderabbitai review")).toBe(true);
    });

    test("the detector catches CodeRabbit's other commands too, not just review/full review (I7)", () => {
      expect(isCommandIssuingMention('gh pr comment -R "$REPO" "$PR" --body "@coderabbitai resolve"')).toBe(true);
      expect(isCommandIssuingMention("@coderabbitai pause")).toBe(true);
      expect(isCommandIssuingMention("@coderabbitai generate docstrings")).toBe(true);
    });

    test("the detector catches a command-issuing markdown HEADING, which the old '#'-line exemption wrongly skipped (I7)", () => {
      expect(isCommandIssuingMention("## Step 3: post @coderabbitai review")).toBe(true);
    });

    test("the detector does not flag a comment merely discussing the rule (negative control)", () => {
      expect(isCommandIssuingMention("# no `@coderabbitai` command is ever issued")).toBe(false);
    });

    test("commands/, agents/, scripts/, skills/ contain no command-issuing @coderabbitai invocation", () => {
      // Exclude this test file itself: its own positive/negative-control fixtures above
      // necessarily contain the literal invocation shape being checked for — scanning them
      // would be self-referential, not a real finding. See MUST-CHECK
      // leak-scan-self-reference-needs-per-rule-file-scope.
      const proc = Bun.spawnSync(
        ["grep", "-rn", "--exclude=plugin.test.ts", "@coderabbitai", "commands", "agents", "scripts", "skills"],
        { cwd: root },
      );
      // grep exits 0 (found) or 1 (no matches); anything else means it errored (bad cwd,
      // renamed dir) rather than the repo being clean of mentions, so must not silently
      // assert nothing.
      expect(proc.exitCode, `grep failed to run: ${proc.stderr.toString()}`).toBeLessThanOrEqual(1);
      const out = proc.stdout.toString();
      const lines = out.split("\n").filter((l) => l.length > 0);
      const locations = lines.map((l) => {
        const firstColon = l.indexOf(":");
        const secondColon = l.indexOf(":", firstColon + 1);
        return l.slice(0, secondColon);
      });
      // Assert the grep actually ran and found the one known-benign mention — otherwise a
      // silently broken grep (wrong cwd, exit code swallowed) would make every assertion
      // below vacuously pass. PCO-349 fix pass 3, Important 2: content-keyed, not
      // line-number-keyed — a line-shifting edit anywhere above this benign mention moved it
      // from :143 to :152 with nothing wrong, and the OLD line-number pin reported "grep
      // found no @coderabbitai mentions at all — broken grep, not a clean repo", which was
      // flatly false (the grep ran fine and found the line; only its number moved).
      expect(
        lines.some((l) => l.includes("agents/drawbar-story-lead.md") && l.includes("no `@coderabbitai` command")),
        "grep found no @coderabbitai mentions at all — broken grep, not a clean repo",
      ).toBe(true);
      for (const line of lines) {
        const firstColon = line.indexOf(":");
        const secondColon = line.indexOf(":", firstColon + 1);
        const content = line.slice(secondColon + 1);
        expect(isCommandIssuingMention(content), `command-issuing mention found: ${line}`).toBe(false);
      }
    });
  });
});

describe("version reconcile", () => {
  test("plugin.json and package.json report the same semver, and it isn't vacuously undefined", () => {
    const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    // Without this, `expect(pkg.version).toBe(plugin.version)` alone passes vacuously if
    // both `version` keys are missing (undefined === undefined).
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.version).toBe(plugin.version);
  });
});

describe("scaffolding", () => {
  test(".gitattributes sets merge=union on both KB JSONL paths", () => {
    const txt = readNonEmpty(join(root, ".gitattributes"));
    expect(txt).toContain(".drawbar/memory/knowledge.jsonl         merge=union");
    expect(txt).toContain(".drawbar/memory/knowledge.archive.jsonl merge=union");
  });

  test(".drawbar/runs/.gitignore actually ignores everything but itself", () => {
    const txt = readNonEmpty(join(root, ".drawbar/runs/.gitignore"));
    // A file with unrelated content (e.g. just "# todo") would satisfy a bare
    // non-empty/existence check while letting run-state JSON get committed.
    expect(txt).toMatch(/^\*$/m);
    expect(txt).toMatch(/^!\.gitignore$/m);
  });
});

// L23 preservation harness — reused unchanged by S3 to prove de-hardcoding
// does not eat these seven rules. Each anchor is a distinctive, verbatim
// substring from the upstream source, not an incidental match.
describe("Locked 23 — preserved verbatim (grep-assertable, or hash-pinned for one block)", () => {
  test("preflight assert-or-creates the found-in-review label", () => {
    const txt = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    expect(txt).toContain("Assert-or-create the `found-in-review` label.");
  });

  test("thin-orchestrator rule: do not ask the story-lead for the diff", () => {
    const txt = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    expect(txt).toContain("Do not ask it for the diff.");
  });

  test("non-empty mutation_pairs is a hard refusal", () => {
    const txt = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    expect(txt).toContain("Never accept a story whose `mutation_pairs` are empty.");
  });

  test("review depth is always full", () => {
    const txt = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    expect(txt).toContain("Review depth is always full");
  });

  test("the two independent reviewers are dispatched in parallel", () => {
    const txt = readNonEmpty(join(root, "agents/drawbar-story-lead.md"));
    expect(txt).toContain(
      "Dispatch **`code-reviewer`** and **`security-reviewer`** in parallel, in one message."
    );
  });

  test("drawbar-kb archive/compact is prohibited in both its sites", () => {
    const txt = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    // Anchor without the trailing period matches both the inline warning in step 6 and the
    // "Hard rules" restatement. Either alone still catches deletion of the rule, but a
    // single `toContain` also still passes if one of the two sites is deleted — so pin the
    // occurrence count instead of just presence.
    const anchor = "Never run `drawbar-kb archive` or `compact`";
    const occurrences = txt.split(anchor).length - 1;
    expect(occurrences).toBe(2);
  });

  test("drawbar-story-lead section 4 (mutation gate) is preserved in full", () => {
    const txt = readNonEmpty(join(root, "agents/drawbar-story-lead.md"));
    const start = txt.indexOf("## 4. Mutation gate — tests must actually pin behavior");
    expect(start, "'## 4. Mutation gate' heading not found — was it renamed or deleted?").toBeGreaterThan(-1);
    const end = txt.indexOf("## 5.", start);
    expect(end, "'## 5.' heading not found after §4 — was §5 renamed or renumbered?").toBeGreaterThan(start);
    // Hash the whole block — including load-bearing sentences with no anchor of their own
    // (e.g. "Record every `mutation → failing test` pair; it goes in your report.", the
    // only sentence tying §4 to the `mutation_pairs` field that drawbar-ship.md hard-refuses
    // on). "In full" means the whole block matches, not just a few excerpted sentences.
    const block = txt.slice(start, end);
    const hash = createHash("sha256").update(block).digest("hex");
    // Regenerate after an INTENTIONAL edit to §4 with:
    //   node -e 'const fs=require("fs"),c=require("crypto");const t=fs.readFileSync("agents/drawbar-story-lead.md","utf8");const s=t.indexOf("## 4. Mutation gate — tests must actually pin behavior");const e=t.indexOf("## 5.",s);console.log(c.createHash("sha256").update(t.slice(s,e)).digest("hex"))'
    expect(
      hash,
      "§4 body hash changed — if this is an intentional edit, regenerate with the one-liner in the comment above; if not, something silently altered §4."
    ).toBe("e3e06c41f1f3e83c490c7046f6b59287d02ec0d97d8ebb34170063f3f2d93858");
  });
});
