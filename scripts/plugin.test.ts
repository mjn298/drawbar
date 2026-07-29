import { test, expect, describe } from "bun:test";
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseShipConfig, validateShipConfig, type Runner } from "./lib/ship-config";

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
    // PCO-348 (S3): the ship-config module, its tests, and the committed example config —
    // this list is data-driven precisely so S3 could extend it here without touching the
    // test body below.
    ".drawbar/ship.config.example.json",
    "scripts/lib/ship-config.ts",
    "scripts/lib/ship-config.test.ts",
    // PCO-350 (S5): the run-state module and its tests — every fixture id in the test file
    // is deliberately lowercase (e.g. "story-a"), which cannot match the issue-id rule's
    // uppercase-team-prefix shape.
    "scripts/lib/run-state.ts",
    "scripts/lib/run-state.test.ts",
    // PCO-351 (S6): the merge-guard module and its tests — every fixture id in the test file
    // is deliberately kept to a single digit (e.g. "ABC-1"), which cannot match the issue-id
    // rule's 2+-digit shape, matching ship-config.test.ts/run-state.test.ts's discipline.
    "scripts/lib/merge-guard.ts",
    "scripts/lib/merge-guard.test.ts",
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
      // Scoped to DOC_FILES plus `.drawbar/ship.config.example.json` (Important 9, fix pass
      // 2): knowledge.jsonl and this test file are prose-heavy and produce large numbers of
      // ordinary word "/" word matches (e.g. "and/or", "archive/compact") that are not GitHub
      // slugs at all — an allowlist covering those would be unbounded and would stop being
      // reviewable. The issue-id, filename, absolute-path, and literal-vocabulary rules
      // above/below still cover those two files. `ship-config.test.ts` is deliberately left
      // OUT of this rule too — it legitimately carries fixture slugs (e.g. `acme/widgets`)
      // and would need an unbounded allowlist, which MUST-CHECK
      // leak-scan-self-reference-needs-per-rule-file-scope warns against. But
      // `.drawbar/ship.config.example.json` WAS added to `NEW_PUBLIC_FILES` (so it is covered
      // by the issue-id/yml/absolute-path rules above) without ever being added HERE — the
      // one field in this repo specifically designed to hold an `<org>/<repo>` slug, and the
      // most likely place for someone to "helpfully fill in" a real value, was unscanned by
      // the one rule that would catch it.
      name: "concrete owner/repo GitHub slug not on the reviewed benign allowlist",
      files: [...DOC_FILES, ".drawbar/ship.config.example.json"],
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
          // PCO-348 (S3) additions — config-file paths, a prose word/word pair, and two
          // in-repo file references, none an org/repo slug:
          "drawbar/ship.config.json",
          ".drawbar/ship.config.example.json",
          "projectDir/envDir",
          "substring/case",
          "scripts/plugin.test.ts",
          "commands/drawbar-ship.md",
          // PCO-348 fix pass 2 (Important 8 security fix) additions — a leading-dot form of
          // the config path (preceded by a backtick, so the leading "." isn't trimmed off the
          // way it is at line 47), and a prose word/word pair. Neither is an org/repo slug.
          ".drawbar/ship.config.json",
          // PCO-351 (S6) additions — this repo's own issue-prefix/id reference, and a prose
          // word/word pair. Neither is an org/repo slug. (A fix pass removed a third entry,
          // "5/7." — the section cross-reference it allowlisted was reworded to "step 5" to
          // avoid the slash entirely, rather than widen this allowlist for a bare `<digit>/<digit>.`
          // shape that could otherwise mask an unrelated leak later.)
          "S6/PCO-351",
          "unparseable/empty",
          // PCO-351 fix pass additions — four more prose word/word pairs introduced by the
          // fix-pass edits below (SNAPSHOT's non-empty assert, the merge_sha stdout echo, and
          // the post-merge "Parking a story" carve-out). None is an org/repo slug.
          "empty/unset",
          "RESOLVED/SNAPSHOT",
          "gone/closed",
          "park/notify",
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

// PCO-348 (S3): the EXPECTED_REPO env-var guard is gone — Locked 17 replaces it with a
// config-driven preflight (no `$PWD`/parent-directory probing anywhere). This harness proves
// the two bash-level guards that replaced it fail closed for real, extracted from the actual
// shipped doc rather than hand-reimplemented — see MUST-CHECK
// verification-harness-must-replicate-full-fixture.
describe("config-driven preflight guard fails closed (PCO-348)", () => {
  function preflightBlock(): string {
    const txt = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    const sectionStart = txt.indexOf("## Preflight (halt on any failure)");
    expect(sectionStart).toBeGreaterThan(-1);
    const fenceStart = txt.indexOf("```bash", sectionStart);
    const fenceEnd = txt.indexOf("```", fenceStart + 7);
    expect(fenceStart).toBeGreaterThan(-1);
    expect(fenceEnd).toBeGreaterThan(fenceStart);
    return txt.slice(fenceStart + 7, fenceEnd);
  }

  // The CONFIG-file-existence guard: resolving `$CONFIG` and refusing if it's absent. Never
  // touches ship-config.ts / bun / gh at all, so this is testable in complete isolation.
  function extractConfigFileGuard(): string {
    const block = preflightBlock();
    const guardStart = block.indexOf('CONFIG="${DRAWBAR_SHIP_CONFIG');
    expect(guardStart, "CONFIG resolution not found in Preflight").toBeGreaterThan(-1);
    const guardEnd = block.indexOf("exit 1; }", guardStart);
    expect(guardEnd, "config-file-existence guard's exit not found").toBeGreaterThan(guardStart);
    return block.slice(guardStart, guardEnd + "exit 1; }".length);
  }

  // Fix pass 2, Important 8: the tracked-config security guard. Bounded by its own MUST-CHECK
  // comment start and the closing `exit 1; }` of its refusal, mirroring extractConfigFileGuard
  // above — extracted for real from the shipped doc, never hand-reimplemented.
  function extractTrackedConfigGuard(): string {
    const block = preflightBlock();
    const guardStart = block.indexOf("git -C \"$(dirname \"$CONFIG\")\" ls-files --error-unmatch");
    expect(guardStart, "tracked-config guard not found in Preflight").toBeGreaterThan(-1);
    // Ends at `|| true` (not merely `exit 1; }`) — that trailing clause is what keeps the
    // guard's OWN exit status 0 on the untracked/pass path when it is run standalone (in the
    // real fence, later commands overwrite $? regardless, same as the documented `[ "$seen" =
    // "0" ]` asymmetry elsewhere in this file).
    const guardEnd = block.indexOf("|| true", guardStart);
    expect(guardEnd, "tracked-config guard's trailing `|| true` not found").toBeGreaterThan(guardStart);
    return block.slice(guardStart, guardEnd + "|| true".length);
  }

  // The derive-from-$RESOLVED guard: bounded by explicit marker comments (an intentional
  // test seam, not incidental) so this can be extracted and run with a hand-built $RESOLVED
  // JSON payload supplied from outside — proving the REAL fail-closed assert loop, not a
  // reimplementation of it, without needing a real ship-config.ts invocation.
  function extractDeriveGuard(): string {
    const txt = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    const start = txt.indexOf("# --- derive from the resolved config");
    expect(start, "derive-from-resolved-config marker not found").toBeGreaterThan(-1);
    const end = txt.indexOf("# --- end derive from the resolved config", start);
    expect(end, "end-derive marker not found").toBeGreaterThan(start);
    return txt.slice(start, end);
  }

  async function runScript(script: string, env: Record<string, string>): Promise<{ code: number; output: string }> {
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

  // Minor fix pass 2: renamed from "refuses when the config file is absent, pointing at the
  // example file" — that name claimed a refusal but the body only asserted a doc substring,
  // testing no refusal at all. Folded into the real refusal test below instead, which now
  // covers both the exit behavior AND the example-file pointer in the message.
  test("refuses (for real) when the resolved config file path does not exist, and points at the example file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drawbar-preflight-cfg-"));
    const { code, output } = await runScript(extractConfigFileGuard(), {
      DRAWBAR_SHIP_CONFIG: join(dir, "does-not-exist.json"),
    });
    expect(code).not.toBe(0);
    expect(output).toContain("no config at");
    expect(output).toContain(".drawbar/ship.config.example.json");
  });

  test("passes (for real) when the resolved config file exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drawbar-preflight-cfg-"));
    const cfgPath = join(dir, "ship.config.json");
    writeFileSync(cfgPath, "{}");
    const { code } = await runScript(extractConfigFileGuard(), { DRAWBAR_SHIP_CONFIG: cfgPath });
    expect(code).toBe(0);
  });

  // Fix pass 2, Important 8 (security): a ship config is never read from EXPORTED ENV VARS
  // anymore — it's a file inside the working directory, which any repository's own tree can
  // carry (`.drawbar/` is an established convention adopting projects commit). A contributor
  // PR adding `.drawbar/ship.config.json` is easy to miss, and a planted config still
  // controls requiredChecks, envDir (where $KB and the run-state file get written), and
  // team/mergedStatus even though the repo-anchor guard holds. Enforce the invariant the
  // .gitignore line already encodes: a real ship config is NEVER tracked by git. Both cases
  // use a REAL temporary git repo, not a stubbed `git`.
  function initRealGitRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), "drawbar-tracked-cfg-"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: dir });
    Bun.spawnSync(["git", "config", "user.name", "test"], { cwd: dir });
    return dir;
  }

  test("refuses (for real, against a real temp git repo) when the config file IS tracked by git", async () => {
    const dir = initRealGitRepo();
    const cfgDir = join(dir, ".drawbar");
    mkdirSync(cfgDir, { recursive: true });
    const cfgPath = join(cfgDir, "ship.config.json");
    writeFileSync(cfgPath, "{}");
    Bun.spawnSync(["git", "add", "ship.config.json"], { cwd: cfgDir });
    Bun.spawnSync(["git", "commit", "-q", "-m", "add config"], { cwd: dir });
    const { code, output } = await runScript(`CONFIG='${cfgPath}'\n` + extractTrackedConfigGuard(), {});
    expect(code).not.toBe(0);
    expect(output).toContain("tracked by git");
  });

  test("passes (for real, against a real temp git repo) when the config file is NOT tracked by git", async () => {
    const dir = initRealGitRepo();
    const cfgDir = join(dir, ".drawbar");
    mkdirSync(cfgDir, { recursive: true });
    const cfgPath = join(cfgDir, "ship.config.json");
    writeFileSync(cfgPath, "{}"); // deliberately never `git add`ed
    const { code } = await runScript(`CONFIG='${cfgPath}'\n` + extractTrackedConfigGuard(), {});
    expect(code).toBe(0);
  });

  test("refuses (for real) when the resolved repo identity is empty", async () => {
    const script =
      `RESOLVED='{"envDir":"/tmp/e","projectDir":"/tmp/p","repo":"","baseBranch":"main"}'\n` + extractDeriveGuard();
    const { code, output } = await runScript(script, {});
    expect(code).not.toBe(0);
    expect(output).toContain("REPO is empty or null");
  });

  test("refuses (for real) when the resolved repo identity is the literal string null", async () => {
    const script =
      `RESOLVED='{"envDir":"/tmp/e","projectDir":"/tmp/p","repo":null,"baseBranch":"main"}'\n` + extractDeriveGuard();
    const { code, output } = await runScript(script, {});
    expect(code).not.toBe(0);
    expect(output).toContain("REPO is empty or null");
  });

  test("refuses (for real) when the resolved base branch is missing entirely", async () => {
    const script = `RESOLVED='{"envDir":"/tmp/e","projectDir":"/tmp/p","repo":"acme/widgets"}'\n` + extractDeriveGuard();
    const { code, output } = await runScript(script, {});
    expect(code).not.toBe(0);
    expect(output).toContain("BASE_BRANCH is empty or null");
  });

  // Fix pass 2, Important 7: a mutation narrowing the assert loop from
  // `for v in ENV_DIR PROJECT_DIR REPO BASE_BRANCH` to `for v in REPO BASE_BRANCH` left the
  // suite fully green — $ENV_DIR is what feeds $KB and the whole step-6 knowledge sync
  // (`cd "$ENV_DIR"`), so an unguarded ENV_DIR matters most of all four. Only REPO and
  // BASE_BRANCH had empty/null coverage before this fix pass; ENV_DIR and PROJECT_DIR did not.
  test("refuses (for real) when the resolved envDir is empty (Important 7)", async () => {
    const script =
      `RESOLVED='{"envDir":"","projectDir":"/tmp/p","repo":"acme/widgets","baseBranch":"main"}'\n` + extractDeriveGuard();
    const { code, output } = await runScript(script, {});
    expect(code).not.toBe(0);
    expect(output).toContain("ENV_DIR is empty or null");
  });

  test("refuses (for real) when the resolved envDir is the literal string null (Important 7)", async () => {
    const script =
      `RESOLVED='{"envDir":null,"projectDir":"/tmp/p","repo":"acme/widgets","baseBranch":"main"}'\n` + extractDeriveGuard();
    const { code, output } = await runScript(script, {});
    expect(code).not.toBe(0);
    expect(output).toContain("ENV_DIR is empty or null");
  });

  test("refuses (for real) when the resolved projectDir is empty (Important 7)", async () => {
    const script =
      `RESOLVED='{"envDir":"/tmp/e","projectDir":"","repo":"acme/widgets","baseBranch":"main"}'\n` + extractDeriveGuard();
    const { code, output } = await runScript(script, {});
    expect(code).not.toBe(0);
    expect(output).toContain("PROJECT_DIR is empty or null");
  });

  test("refuses (for real) when the resolved projectDir is the literal string null (Important 7)", async () => {
    const script =
      `RESOLVED='{"envDir":"/tmp/e","projectDir":null,"repo":"acme/widgets","baseBranch":"main"}'\n` + extractDeriveGuard();
    const { code, output } = await runScript(script, {});
    expect(code).not.toBe(0);
    expect(output).toContain("PROJECT_DIR is empty or null");
  });

  // Important 4: $MERGED_STATUS must be derived and vacuity-guarded the same way as the other
  // four resolved-config values — §5 parameterizes on it instead of hardcoding `Pre-QA`.
  test("refuses (for real) when the resolved mergedStatus is missing entirely (Important 4)", async () => {
    const script =
      `RESOLVED='{"envDir":"/tmp/e","projectDir":"/tmp/p","repo":"acme/widgets","baseBranch":"main"}'\n` +
      extractDeriveGuard();
    const { code, output } = await runScript(script, {});
    expect(code).not.toBe(0);
    expect(output).toContain("MERGED_STATUS is empty or null");
  });

  test("passes (for real) on a well-formed resolved payload, deriving all five values plus $KB", async () => {
    const script =
      `RESOLVED='{"envDir":"/tmp/e","projectDir":"/tmp/p","repo":"acme/widgets","baseBranch":"main","mergedStatus":"Pre-QA"}'\n` +
      extractDeriveGuard() +
      `\necho "OK $ENV_DIR $PROJECT_DIR $REPO $BASE_BRANCH $MERGED_STATUS $KB"`;
    const { code, output } = await runScript(script, {});
    expect(code).toBe(0);
    expect(output).toContain("OK /tmp/e /tmp/p acme/widgets main Pre-QA /tmp/e/.drawbar/memory");
  });

  test("Preflight never probes $PWD or a parent directory to discover the knowledge repo (Locked 17, AC L17)", () => {
    const block = preflightBlock();
    // The removed mechanism specifically: walking up from $PWD to a parent directory, and
    // testing for a `.drawbar/memory` directory's EXISTENCE to decide which root you're in.
    // `KB="$ENV_DIR/.drawbar/memory"` (a plain derivation from the already-validated
    // `$ENV_DIR`) legitimately still appears below and is not what this anchors against.
    // Fix pass 2, Important 8: `dirname "$CONFIG"` (the tracked-config security guard) is
    // also legitimate — a single-level dirname of the ALREADY-RESOLVED config path, not a
    // walk-up-to-find-the-repo probe. Pinned to exactly one occurrence, of exactly that
    // shape, so a future re-introduction of parent-walking `dirname` usage still fails this.
    const dirnameOccurrences = (block.match(/dirname/g) ?? []).length;
    expect(dirnameOccurrences, "unexpected number of `dirname` occurrences in Preflight").toBe(1);
    expect(block).toContain('dirname "$CONFIG"'); // the ONE legitimate reference
    expect(block).not.toMatch(/\[\s*-d\s+"?\$(PWD|ENV_DIR)\/\.drawbar\/memory"?\s*\]/);
    expect(block).toContain('KB="$ENV_DIR/.drawbar/memory"'); // the ONE legitimate reference
  });

  // MUST-CHECK bash-parameter-guard-needs-unset-var-harness-not-just-mutation: prove the
  // fail-closed `: "${CLAUDE_PLUGIN_ROOT:?...}"` guard by running the REAL extracted line
  // with the variable genuinely UNSET in the child env (Bun.spawn's `env` fully replaces the
  // child's environment, so simply omitting the key reliably leaves it unset), asserting the
  // specific `:?` message — not merely mutating the guard to `true` and checking the suite
  // stays green.
  test("CLAUDE_PLUGIN_ROOT unset aborts with the specific :? message (real fence, real unset env)", async () => {
    const block = preflightBlock();
    const marker = ': "${CLAUDE_PLUGIN_ROOT:?CLAUDE_PLUGIN_ROOT must be set}"';
    expect(block).toContain(marker);
    const { code, output } = await runScript(marker, {});
    expect(code).not.toBe(0);
    expect(output).toContain("CLAUDE_PLUGIN_ROOT must be set");
  });
});

// Important (fix pass 4): §4 re-declares $RESOLVED but, before this fix, never re-declared
// $REPO or $BASE_BRANCH — the SAME cross-invocation dependency, and $REPO in particular is a
// commonly-exported ambient env-var name. Mirrors Preflight's own derive-guard tests above:
// extracted for real via explicit marker comments (an intentional test seam), run with a
// hand-built $RESOLVED supplied from outside, proving the REAL fail-closed assert loop.
describe("§4 derives REPO and BASE_BRANCH from RESOLVED, not ambient env (Important, fix pass 4)", () => {
  function extractMergeDeriveGuard(): string {
    const txt = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    const start = txt.indexOf("# --- derive REPO, BASE_BRANCH, and PROJECT_DIR from RESOLVED");
    expect(start, "merge derive-REPO/BASE_BRANCH/PROJECT_DIR marker not found").toBeGreaterThan(-1);
    const end = txt.indexOf("# --- end derive REPO, BASE_BRANCH, and PROJECT_DIR from RESOLVED", start);
    expect(end, "merge derive-REPO/BASE_BRANCH/PROJECT_DIR end marker not found").toBeGreaterThan(start);
    return txt.slice(start, end);
  }

  async function runDerive(env: Record<string, string>): Promise<{ code: number; output: string }> {
    const proc = Bun.spawn(["bash", "-c", extractMergeDeriveGuard()], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { code, output: out + err };
  }

  test("refuses when RESOLVED carries no repo", async () => {
    const { code, output } = await runDerive({ RESOLVED: '{"baseBranch":"main"}' });
    expect(code).not.toBe(0);
    expect(output).toContain("REPO is empty or null");
  });

  test("refuses when RESOLVED's repo is the literal string \"null\"", async () => {
    const { code, output } = await runDerive({ RESOLVED: '{"repo":null,"baseBranch":"main"}' });
    expect(code).not.toBe(0);
    expect(output).toContain("REPO is empty or null");
  });

  test("refuses when RESOLVED carries no baseBranch", async () => {
    const { code, output } = await runDerive({ RESOLVED: '{"repo":"acme/widgets"}' });
    expect(code).not.toBe(0);
    expect(output).toContain("BASE_BRANCH is empty or null");
  });

  // Critical A (fix pass 2): PROJECT_DIR joined REPO/BASE_BRANCH in this same derive-and-assert
  // loop — a resolvedConfig missing it (or carrying the literal string "null") must refuse
  // here too, mirroring the coverage REPO/BASE_BRANCH already had.
  test("Critical A: refuses when RESOLVED carries no projectDir", async () => {
    const { code, output } = await runDerive({ RESOLVED: '{"repo":"acme/widgets","baseBranch":"main"}' });
    expect(code).not.toBe(0);
    expect(output).toContain("PROJECT_DIR is empty or null");
  });

  test("Critical A: refuses when RESOLVED's projectDir is the literal string \"null\"", async () => {
    const { code, output } = await runDerive({ RESOLVED: '{"repo":"acme/widgets","baseBranch":"main","projectDir":null}' });
    expect(code).not.toBe(0);
    expect(output).toContain("PROJECT_DIR is empty or null");
  });

  // The actual gap this closes: a leaked/ambient $REPO in the operator's own shell must NOT
  // silently win over the validated value carried in $RESOLVED — every §4 harness before this
  // fix pre-seeded $REPO directly as an env var (see the STORY-guard describe below), which
  // cannot tell a derived value apart from an ambient one. This test seeds NEITHER: $REPO
  // comes ONLY from $RESOLVED, proving the derivation is what actually populates it.
  test("derives REPO, BASE_BRANCH, and PROJECT_DIR from RESOLVED alone, with no ambient pre-seeded values (Important, fix pass 4)", async () => {
    const echoScript = `${extractMergeDeriveGuard()}\necho "GOT $REPO $BASE_BRANCH $PROJECT_DIR"`;
    const proc = Bun.spawn(["bash", "-c", echoScript], {
      // No REPO/BASE_BRANCH/PROJECT_DIR key at all in env — the exact unseeded pre-state the
      // gap allowed. Every one of them must come ONLY from $RESOLVED below.
      env: {
        PATH: process.env.PATH ?? "",
        RESOLVED: '{"repo":"acme/widgets","baseBranch":"trunk","projectDir":"/tmp/fixture-project-dir"}',
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(out).toContain("GOT acme/widgets trunk /tmp/fixture-project-dir");
  });

  // Poisoned-ambient-env regression: an operator's shell exports $REPO (a common name) with a
  // DIFFERENT value than the validated $RESOLVED carries. The derivation must overwrite it,
  // never silently defer to whatever was already there.
  test("an ambient REPO env var is overwritten by the value derived from RESOLVED, not trusted (Important, fix pass 4)", async () => {
    const echoScript = `${extractMergeDeriveGuard()}\necho "GOT $REPO"`;
    const proc = Bun.spawn(["bash", "-c", echoScript], {
      env: {
        PATH: process.env.PATH ?? "",
        REPO: "attacker/evil", // ambient, poisoned
        RESOLVED: '{"repo":"acme/widgets","baseBranch":"main","projectDir":"/tmp/fixture-project-dir"}',
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(0);
    expect(out).toContain("GOT acme/widgets");
    expect(out).not.toContain("attacker/evil");
  });
});

// S6/PCO-351: §4 no longer implements identity/base/state/checks/config-diff itself — the
// ENTIRE verdict is delegated to a single `bun run .../merge-guard.ts verdict` invocation
// (see scripts/lib/merge-guard.ts and its own test suite for the discriminating cases —
// per-check buckets, branch/base/state variants, degraded `gh`, the F19 CodeRabbit-only
// vacuity case, the ship.config.json diff refusal, the resolved_config re-assert, and the
// merge_sha capture/ancestry assertions). What belongs HERE, in the real shipped fence, is
// narrower and different in kind: proof that §4 actually WIRES UP the delegation correctly —
// invokes the module, fails closed on every one of {non-ok verdict, unparseable/empty module
// stdout, non-zero module exit}, never reaches `gh pr merge` on any refusal, still refuses
// when STORY/BASE_BRANCH/RESOLVED are unset/empty before anything destructive, and contains
// no `|| true` and no second hand-copied implementation of the checks that moved out.
//
// Real-fence execution throughout (extractMergeFence() below), same discipline as the
// describes this replaces: a stub `scripts/lib/merge-guard.ts` under a temp
// $CLAUDE_PLUGIN_ROOT stands in for the module (its OWN behavior is proven correct in
// scripts/lib/merge-guard.test.ts), and a marker file it writes on invocation is what proves
// "never reaches the module" for the pre-flight-style refusals, per MUST-CHECK
// vacuous-assertion-needs-preseed-state.
describe("§4 delegates the entire merge verdict to merge-guard.ts (S6/PCO-351)", () => {
  // From the derive-REPO/BASE_BRANCH marker (shared with the "§4 derives REPO and
  // BASE_BRANCH..." describe above) through just before the real `gh pr merge -R` call, so
  // the guard logic runs for real while the destructive final command never executes. Starts
  // AFTER the STORY/PR/RESOLVED/SNAPSHOT placeholder assignments — same reason the old
  // extractMergeGuard() did — so a test's own env vars for those actually take effect rather
  // than being clobbered by the literal placeholder text.
  function extractMergeFence(): string {
    const txt = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    const sectionStart = txt.indexOf("## 4. Merge");
    expect(sectionStart, "'## 4. Merge' heading not found").toBeGreaterThan(-1);
    const fenceStart = txt.indexOf("```bash", sectionStart);
    const fenceEnd = txt.indexOf("```", fenceStart + 7);
    expect(fenceStart).toBeGreaterThan(-1);
    expect(fenceEnd).toBeGreaterThan(fenceStart);
    const block = txt.slice(fenceStart + 7, fenceEnd);
    const guardStart = block.indexOf("# MUST-CHECK bash-fence-cross-invocation-state-needs-unseeded-test");
    expect(guardStart, "cross-invocation derive-guard marker not found in the merge block").toBeGreaterThan(-1);
    const mergeIdx = block.indexOf("gh pr merge -R");
    expect(mergeIdx, "'gh pr merge -R' not found after the guard").toBeGreaterThan(guardStart);
    return block.slice(guardStart, mergeIdx);
  }

  function mergeFenceText(): string {
    const txt = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    const sectionStart = txt.indexOf("## 4. Merge");
    const fenceStart = txt.indexOf("```bash", sectionStart);
    const fenceEnd = txt.indexOf("```", fenceStart + 7);
    return txt.slice(fenceStart + 7, fenceEnd);
  }

  // A stub `scripts/lib/merge-guard.ts` under a fresh temp plugin root — real `bun` executes
  // it for real (never a fake `bun` on PATH), so this proves the fence's own fail-closed
  // wiring around whatever the module answers, independent of the module's real logic. Writes
  // a marker file on invocation so a test can prove (or disprove) the module was ever reached
  // at all, distinct from merely asserting an exit code.
  function makeStubPluginRoot(opts: { stdout?: string; exitCode?: number }): { root: string; markerPath: string } {
    const dir = mkdtempSync(join(tmpdir(), "drawbar-plugin-root-"));
    const libDir = join(dir, "scripts", "lib");
    mkdirSync(libDir, { recursive: true });
    const markerPath = join(dir, "invoked.marker");
    const lines = [
      `import { writeFileSync } from "node:fs";`,
      `writeFileSync(${JSON.stringify(markerPath)}, "invoked");`,
    ];
    if (opts.stdout !== undefined) lines.push(`process.stdout.write(${JSON.stringify(opts.stdout)});`);
    lines.push(`process.exit(${opts.exitCode ?? 0});`);
    writeFileSync(join(libDir, "merge-guard.ts"), lines.join("\n") + "\n");
    return { root: dir, markerPath };
  }

  // Critical A / Important E (fix pass 2): §4 now derives PROJECT_DIR and independently
  // re-derives REPO from `git -C "$PROJECT_DIR" remote get-url origin` — a REAL git repo with a
  // matching `origin` remote, not a bare directory, so the fixture below satisfies both new
  // checks the same way a genuine `resolvedConfig.projectDir` checkout would.
  const FIXTURE_PROJECT_DIR = (() => {
    const dir = mkdtempSync(join(tmpdir(), "drawbar-fence-project-dir-"));
    Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
    Bun.spawnSync(["git", "remote", "add", "origin", "https://github.com/org/repo.git"], { cwd: dir });
    return dir;
  })();

  // Important B (fix pass 2): §4 asserts `[ -f "$CONFIG" ]` — a real file the fence's
  // `DRAWBAR_SHIP_CONFIG` can point at, distinct from the repo's own
  // `.drawbar/ship.config.json` (which does not exist in this checkout at all).
  //
  // Critical 1 (round-3 security review): the file is no longer empty. §4 now treats the
  // operator-authored config — NOT the run-state — as the trust root for `projectDir`, because
  // that path is handed to `git -C`, and running git inside a repo whose `.git` configuration an
  // attacker controls is arbitrary code execution. So the config must carry a `projectDir` and a
  // `repo` that the re-declared `$RESOLVED` agrees with, exactly as a real deployment would.
  const FIXTURE_CONFIG_PATH = (() => {
    const dir = mkdtempSync(join(tmpdir(), "drawbar-fence-config-"));
    const p = join(dir, "ship.config.json");
    writeFileSync(p, JSON.stringify({ projectDir: FIXTURE_PROJECT_DIR, repo: "org/repo" }));
    return p;
  })();

  const VALID_RESOLVED_JSON = JSON.stringify({
    repo: "org/repo",
    baseBranch: "main",
    requiredChecks: ["build"],
    projectDir: FIXTURE_PROJECT_DIR,
  });
  const VALID_SNAPSHOT_JSON = '["ABC-1"]';

  async function runFence(script: string, env: Record<string, string>): Promise<{ code: number; output: string }> {
    // Append a sentinel AFTER the extracted fragment (which itself stops just before the real
    // `gh pr merge -R` call) — its presence/absence in the output is what proves whether
    // control reached "the point where `gh pr merge` would have run" without ever running it.
    const full = `${script}\necho MERGE_REACHED`;
    const proc = Bun.spawn(["bash", "-c", full], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { code, output: out + err };
  }

  test("the shipped fence actually invokes merge-guard.ts for both the verdict and the merge_sha capture", () => {
    const block = mergeFenceText();
    expect(block).toContain('bun run "${CLAUDE_PLUGIN_ROOT}/scripts/lib/merge-guard.ts" verdict');
    expect(block).toContain('bun run "${CLAUDE_PLUGIN_ROOT}/scripts/lib/merge-guard.ts" record-merge-sha');
  });

  test("fails closed on a non-ok verdict (module exits 0, JSON has ok:false)", async () => {
    const { root, markerPath } = makeStubPluginRoot({ stdout: JSON.stringify({ ok: false, reason: "stub_refusal" }), exitCode: 0 });
    const { code, output } = await runFence(extractMergeFence(), {
      STORY: "ABC-1",
      PR: "1",
      RESOLVED: VALID_RESOLVED_JSON,
      SNAPSHOT: VALID_SNAPSHOT_JSON,
      CLAUDE_PLUGIN_ROOT: root,
      DRAWBAR_SHIP_CONFIG: FIXTURE_CONFIG_PATH,
    });
    expect(code).not.toBe(0);
    expect(output).toContain("verdict was not ok");
    expect(existsSync(markerPath)).toBe(true); // the module WAS reached — this is its own answer, not a pre-flight refusal
    expect(output).not.toContain("MERGE_REACHED");
  });

  test("fails closed on unparseable module stdout", async () => {
    const { root } = makeStubPluginRoot({ stdout: "not valid json at all", exitCode: 0 });
    const { code, output } = await runFence(extractMergeFence(), {
      STORY: "ABC-1",
      PR: "1",
      RESOLVED: VALID_RESOLVED_JSON,
      SNAPSHOT: VALID_SNAPSHOT_JSON,
      CLAUDE_PLUGIN_ROOT: root,
      DRAWBAR_SHIP_CONFIG: FIXTURE_CONFIG_PATH,
    });
    expect(code).not.toBe(0);
    expect(output).toContain("verdict was not ok");
    expect(output).not.toContain("MERGE_REACHED");
  });

  test("fails closed on empty module stdout", async () => {
    const { root } = makeStubPluginRoot({ exitCode: 0 }); // no stdout at all
    const { code, output } = await runFence(extractMergeFence(), {
      STORY: "ABC-1",
      PR: "1",
      RESOLVED: VALID_RESOLVED_JSON,
      SNAPSHOT: VALID_SNAPSHOT_JSON,
      CLAUDE_PLUGIN_ROOT: root,
      DRAWBAR_SHIP_CONFIG: FIXTURE_CONFIG_PATH,
    });
    expect(code).not.toBe(0);
    expect(output).toContain("verdict was not ok");
    expect(output).not.toContain("MERGE_REACHED");
  });

  test("fails closed on a non-zero module exit, even with syntactically valid ok:true JSON on stdout", async () => {
    const { root } = makeStubPluginRoot({ stdout: JSON.stringify({ ok: true }), exitCode: 3 });
    const { code, output } = await runFence(extractMergeFence(), {
      STORY: "ABC-1",
      PR: "1",
      RESOLVED: VALID_RESOLVED_JSON,
      SNAPSHOT: VALID_SNAPSHOT_JSON,
      CLAUDE_PLUGIN_ROOT: root,
      DRAWBAR_SHIP_CONFIG: FIXTURE_CONFIG_PATH,
    });
    expect(code).not.toBe(0);
    expect(output).toContain("merge-guard.ts verdict exited 3");
    expect(output).not.toContain("MERGE_REACHED");
  });

  test("an ok:true verdict with a zero exit lets the fence proceed to the merge step", async () => {
    const { root } = makeStubPluginRoot({ stdout: JSON.stringify({ ok: true }), exitCode: 0 });
    const { code, output } = await runFence(extractMergeFence(), {
      STORY: "ABC-1",
      PR: "1",
      RESOLVED: VALID_RESOLVED_JSON,
      SNAPSHOT: VALID_SNAPSHOT_JSON,
      CLAUDE_PLUGIN_ROOT: root,
      DRAWBAR_SHIP_CONFIG: FIXTURE_CONFIG_PATH,
    });
    expect(code).toBe(0);
    expect(output).toContain("MERGE_REACHED");
  });

  test("still refuses when STORY is unset, and never reaches merge-guard.ts at all", async () => {
    const { root, markerPath } = makeStubPluginRoot({ stdout: JSON.stringify({ ok: true }), exitCode: 0 }); // would say yes if ever asked
    const { code, output } = await runFence(extractMergeFence(), {
      STORY: "",
      PR: "1",
      RESOLVED: VALID_RESOLVED_JSON,
      SNAPSHOT: VALID_SNAPSHOT_JSON,
      CLAUDE_PLUGIN_ROOT: root,
    });
    expect(code).not.toBe(0);
    expect(output).toContain("STORY unset");
    expect(existsSync(markerPath)).toBe(false); // never reached the module
    expect(output).not.toContain("MERGE_REACHED");
  });

  // Minor (fix pass 2): §4 asserted STORY/SNAPSHOT/CLAUDE_PLUGIN_ROOT non-empty but never PR —
  // an unset $PR would otherwise reach `bun run .../merge-guard.ts verdict --pr ""`, refusing
  // there instead of failing closed before spawning `bun` at all.
  test("Minor: still refuses when PR is unset, and never reaches merge-guard.ts at all", async () => {
    const { root, markerPath } = makeStubPluginRoot({ stdout: JSON.stringify({ ok: true }), exitCode: 0 }); // would say yes if ever asked
    const { code, output } = await runFence(extractMergeFence(), {
      STORY: "ABC-1",
      PR: "",
      RESOLVED: VALID_RESOLVED_JSON,
      SNAPSHOT: VALID_SNAPSHOT_JSON,
      CLAUDE_PLUGIN_ROOT: root,
    });
    expect(code).not.toBe(0);
    expect(output).toContain("PR unset");
    expect(existsSync(markerPath)).toBe(false); // never reached the module
    expect(output).not.toContain("MERGE_REACHED");
  });

  test("still refuses when RESOLVED carries no baseBranch, and never reaches merge-guard.ts at all", async () => {
    const { root, markerPath } = makeStubPluginRoot({ stdout: JSON.stringify({ ok: true }), exitCode: 0 });
    const { code, output } = await runFence(extractMergeFence(), {
      STORY: "ABC-1",
      PR: "1",
      RESOLVED: '{"repo":"org/repo"}',
      SNAPSHOT: VALID_SNAPSHOT_JSON,
      CLAUDE_PLUGIN_ROOT: root,
    });
    expect(code).not.toBe(0);
    expect(output).toContain("BASE_BRANCH is empty or null");
    expect(existsSync(markerPath)).toBe(false);
    expect(output).not.toContain("MERGE_REACHED");
  });

  test("still refuses when RESOLVED is entirely unset, and never reaches merge-guard.ts at all", async () => {
    const { root, markerPath } = makeStubPluginRoot({ stdout: JSON.stringify({ ok: true }), exitCode: 0 });
    const script = extractMergeFence();
    const full = `STORY=ABC-1\nPR=1\nSNAPSHOT='${VALID_SNAPSHOT_JSON}'\nCLAUDE_PLUGIN_ROOT='${root}'\n${script}\necho MERGE_REACHED`;
    // RESOLVED deliberately absent from env entirely — Bun.spawn's env fully replaces the
    // child's environment, so omitting the key reliably leaves it unset (not merely empty).
    const proc = Bun.spawn(["bash", "-c", full], { env: { PATH: process.env.PATH ?? "" }, stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    expect(code).not.toBe(0);
    expect(out + err).toContain("empty or null after validation");
    expect(existsSync(markerPath)).toBe(false);
    expect(out + err).not.toContain("MERGE_REACHED");
  });

  test("the shipped fence contains no `|| true` anywhere", () => {
    expect(mergeFenceText()).not.toContain("|| true");
  });

  // Guards against a reviewer's exact worry: a second, hand-copied bash implementation of the
  // logic that moved into merge-guard.ts. None of these fragments should exist in the fence
  // any more — they are now inside scripts/lib/merge-guard.ts exclusively.
  test("the shipped fence contains no second, hand-copied implementation of identity/base/state/checks", () => {
    const block = mergeFenceText();
    expect(block).not.toContain("lc() {");
    expect(block).not.toContain("gh pr checks -R");
    // Important D (fix pass 2): a `gh pr view -R ... --json state,mergeCommit` call now
    // legitimately exists in the `gh pr merge` failure handler — a POST-FAILURE diagnostic
    // read, not a re-implementation of the identity/base/state VERDICT logic (which fetched
    // `headRefName,baseRefName,state` and made an ok/refuse DECISION from it). Scoped to that
    // specific old shape rather than banning the `gh pr view -R` substring outright.
    expect(block).not.toContain("--json headRefName,baseRefName,state");
    expect(block).not.toContain(".requiredChecks[]");
  });

  // Important 9: SNAPSHOT never had a non-empty assert — every prior fence test stubbed a
  // module that ignores stdin entirely, so a regression removing this guard would have been
  // invisible. Mirrors the STORY-unset test above.
  test("still refuses when SNAPSHOT is unset, and never reaches merge-guard.ts at all (Important 9)", async () => {
    const { root, markerPath } = makeStubPluginRoot({ stdout: JSON.stringify({ ok: true }), exitCode: 0 }); // would say yes if ever asked
    const { code, output } = await runFence(extractMergeFence(), {
      STORY: "ABC-1",
      PR: "1",
      RESOLVED: VALID_RESOLVED_JSON,
      SNAPSHOT: "",
      CLAUDE_PLUGIN_ROOT: root,
    });
    expect(code).not.toBe(0);
    expect(output).toContain("SNAPSHOT unset");
    expect(existsSync(markerPath)).toBe(false); // never reached the module
    expect(output).not.toContain("MERGE_REACHED");
  });

  // Critical 1 (round-3 security review). §4 hands $PROJECT_DIR to `git -C`, and running git
  // inside a repository whose `.git` configuration an attacker controls is arbitrary code
  // execution — reproduced on git 2.50.1 via `core.sshCommand` plus an ssh-form `origin`, where a
  // plain `git -C <evil> fetch origin -- main` executes the payload. So the run-state may not be
  // the trust root for that path: §4 reads `projectDir`/`repo` from the operator-authored config
  // file and requires $RESOLVED to agree.
  //
  // Every case below asserts the stub module's marker file is ABSENT — the refusal must land
  // before the module is ever invoked, and (more importantly) before any git process is spawned
  // against the attacker-named directory. Without these, the entire anchoring block is
  // mutation-invisible: the round-3 review demonstrated that deleting §4's whole observed-REPO
  // block left the suite at 517/517 green.
  function tamperedResolved(overrides: Record<string, unknown>): string {
    return JSON.stringify({ ...JSON.parse(VALID_RESOLVED_JSON), ...overrides });
  }

  function configAt(payload: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "drawbar-anchor-cfg-"));
    const p = join(dir, "ship.config.json");
    writeFileSync(p, JSON.stringify(payload));
    return p;
  }

  test("Critical 1: a run-state projectDir that disagrees with the config refuses before git or the module is ever reached", async () => {
    const evilDir = mkdtempSync(join(tmpdir(), "drawbar-anchor-evil-"));
    const { root, markerPath } = makeStubPluginRoot({ stdout: JSON.stringify({ ok: true }), exitCode: 0 });
    const { code, output } = await runFence(extractMergeFence(), {
      STORY: "ABC-1",
      PR: "1",
      RESOLVED: tamperedResolved({ projectDir: evilDir }),
      SNAPSHOT: VALID_SNAPSHOT_JSON,
      CLAUDE_PLUGIN_ROOT: root,
      DRAWBAR_SHIP_CONFIG: FIXTURE_CONFIG_PATH,
    });
    expect(code).not.toBe(0);
    expect(output).toContain("disagrees with");
    expect(output).toContain(evilDir);
    expect(existsSync(markerPath)).toBe(false);
    expect(output).not.toContain("MERGE_REACHED");
  });

  test("Critical 1: a run-state repo that disagrees with the config refuses before the module is ever reached", async () => {
    const { root, markerPath } = makeStubPluginRoot({ stdout: JSON.stringify({ ok: true }), exitCode: 0 });
    const { code, output } = await runFence(extractMergeFence(), {
      STORY: "ABC-1",
      PR: "1",
      // Discriminating on purpose (MUST-CHECK vacuous-assertion-needs-preseed-state): the
      // run-state's repo is the one that MATCHES the fixture checkout's real `origin`, and the
      // CONFIG names a different one. So the observed-remote check downstream would happily
      // pass here — only the run-state-vs-config agreement check can catch this. An earlier
      // version of this test used `repo: "attacker/evil"` in the run-state and passed for the
      // wrong reason: neutering the agreement check left the suite fully green.
      RESOLVED: tamperedResolved({ repo: "org/repo" }),
      SNAPSHOT: VALID_SNAPSHOT_JSON,
      CLAUDE_PLUGIN_ROOT: root,
      DRAWBAR_SHIP_CONFIG: configAt({ projectDir: FIXTURE_PROJECT_DIR, repo: "attacker/evil" }),
    });
    expect(code).not.toBe(0);
    expect(output).toContain("attacker/evil");
    expect(existsSync(markerPath)).toBe(false);
  });

  test("Critical 1: a config projectDir that is not absolute refuses", async () => {
    const { root, markerPath } = makeStubPluginRoot({ stdout: JSON.stringify({ ok: true }), exitCode: 0 });
    const { code, output } = await runFence(extractMergeFence(), {
      STORY: "ABC-1",
      PR: "1",
      RESOLVED: tamperedResolved({ projectDir: "relative/project" }),
      SNAPSHOT: VALID_SNAPSHOT_JSON,
      CLAUDE_PLUGIN_ROOT: root,
      DRAWBAR_SHIP_CONFIG: configAt({ projectDir: "relative/project", repo: "org/repo" }),
    });
    expect(code).not.toBe(0);
    expect(output).toContain("is not absolute");
    expect(existsSync(markerPath)).toBe(false);
  });

  test("Critical 1: a config projectDir carrying a .. segment refuses", async () => {
    const traversal = `${FIXTURE_PROJECT_DIR}/../elsewhere`;
    const { root, markerPath } = makeStubPluginRoot({ stdout: JSON.stringify({ ok: true }), exitCode: 0 });
    const { code, output } = await runFence(extractMergeFence(), {
      STORY: "ABC-1",
      PR: "1",
      RESOLVED: tamperedResolved({ projectDir: traversal }),
      SNAPSHOT: VALID_SNAPSHOT_JSON,
      CLAUDE_PLUGIN_ROOT: root,
      DRAWBAR_SHIP_CONFIG: configAt({ projectDir: traversal, repo: "org/repo" }),
    });
    expect(code).not.toBe(0);
    expect(output).toContain(".. segment");
    expect(existsSync(markerPath)).toBe(false);
  });

  // Important E's observed-remote check, now anchored at the CONFIG-derived projectDir. The
  // fixture checkout's real `origin` is `org/repo`, so a config declaring a different repo must
  // refuse — this is the case that was entirely uncovered before, and it needs BOTH the config
  // and the run-state to agree with each other so the mismatch is genuinely the remote's.
  test("Important E: a repo that disagrees with the project checkout's actual git remote refuses", async () => {
    const { root, markerPath } = makeStubPluginRoot({ stdout: JSON.stringify({ ok: true }), exitCode: 0 });
    const { code, output } = await runFence(extractMergeFence(), {
      STORY: "ABC-1",
      PR: "1",
      RESOLVED: tamperedResolved({ repo: "other/elsewhere" }),
      SNAPSHOT: VALID_SNAPSHOT_JSON,
      CLAUDE_PLUGIN_ROOT: root,
      DRAWBAR_SHIP_CONFIG: configAt({ projectDir: FIXTURE_PROJECT_DIR, repo: "other/elsewhere" }),
    });
    expect(code).not.toBe(0);
    expect(output).toContain("repo_mismatch");
    expect(existsSync(markerPath)).toBe(false);
  });

  test("Important E: a projectDir that is not a git repo at all refuses with the remote-lookup diagnostic", async () => {
    const notARepo = mkdtempSync(join(tmpdir(), "drawbar-anchor-notgit-"));
    const { root, markerPath } = makeStubPluginRoot({ stdout: JSON.stringify({ ok: true }), exitCode: 0 });
    const { code, output } = await runFence(extractMergeFence(), {
      STORY: "ABC-1",
      PR: "1",
      RESOLVED: tamperedResolved({ projectDir: notARepo }),
      SNAPSHOT: VALID_SNAPSHOT_JSON,
      CLAUDE_PLUGIN_ROOT: root,
      DRAWBAR_SHIP_CONFIG: configAt({ projectDir: notARepo, repo: "org/repo" }),
    });
    expect(code).not.toBe(0);
    expect(output).toContain("git remote get-url origin failed");
    expect(existsSync(markerPath)).toBe(false);
  });

  // Critical 4: `MERGE_SHA=$(...)` is a command substitution — its value never otherwise
  // leaves this Bash invocation. Without an explicit echo, step 5's instruction to record
  // `$MERGE_SHA` names a shell variable from a FINISHED tool call, which is undeliverable.
  test("Critical 4: the shipped fence echoes merge_sha=$MERGE_SHA on stdout after capturing it", () => {
    expect(mergeFenceText()).toContain('echo "merge_sha=$MERGE_SHA"');
  });

  // Important 8: `gh pr merge`'s own exit status must be checked, with a named refusal —
  // never falling through to record-merge-sha on a merge that never happened.
  test("Important 8: the shipped fence checks gh pr merge's own exit status with a named refusal", () => {
    const block = mergeFenceText();
    expect(block).toMatch(/gh pr merge -R "\$REPO" "\$PR" --squash --delete-branch\s*\\?\s*\n\s*\|\|\s*\{[^}]*REFUSING/);
  });

  // Important 7 / Critical 4: real end-to-end execution of the SHIPPED fence text, past
  // `gh pr merge` (no-op'd out — this test never hits real GitHub), through the real,
  // unstubbed `scripts/lib/merge-guard.ts` for BOTH the verdict call and the post-merge
  // `record-merge-sha` call, against a fake `gh`/`git` on PATH. This is what actually pins
  // the flag names (`--repo`/`--pr`/`--story`/`--base`), the stdin shape
  // (`resolvedConfig`/`snapshot`), and the post-merge block's existence — every prior fence
  // test substituted a stub module that ignores its own argv/stdin entirely, so a renamed flag
  // (e.g. `--story` -> `--issue`) went undetected by the whole suite.
  //
  // Important A (fix pass 2, comment correction): this comment used to claim `configPath` was
  // pinned here too — it was not. The fake `gh api` fixture below only ever emits
  // "src/index.ts", so a mutation replacing `--arg configPath "$CONFIG"` with `--arg configPath
  // ""` in the shipped fence survived the whole suite undetected. The dedicated
  // "I-A: configPath plumbing is genuinely end-to-end" test further below is what actually
  // closes that gap — it drives a custom `DRAWBAR_SHIP_CONFIG` basename through the real fence,
  // the real `ship-config.ts`-shaped `$CONFIG` derivation, the real `jq --arg configPath`, and
  // the real `merge-guard.ts`, and asserts the config-diff refusal fires on it.
  const REAL_MODULE_RESOLVED_JSON = JSON.stringify({
    envDir: "/tmp/fixture-env-dir",
    projectDir: "/tmp/fixture-project-dir",
    repo: "org/repo",
    team: "PLAT",
    baseBranch: "main",
    mergedStatus: "Pre-QA",
    requiredChecks: ["build"],
    observed: { projectDirRemote: "org/repo", envDirRemote: "org/repo-kb", defaultBranch: "main" },
  });
  // Critical 1 (round-3 security review): §4 takes `projectDir`/`repo` from the OPERATOR-AUTHORED
  // config file and requires the run-state to agree, because that path is handed to `git -C`.
  // These end-to-end tests drive a fully stubbed `git` on PATH (so the directory is never really
  // opened) and therefore use a synthetic projectDir — this config has to name that same
  // synthetic path, exactly as a real deployment's config names its real checkout.
  const REAL_MODULE_CONFIG_PATH = (() => {
    const dir = mkdtempSync(join(tmpdir(), "drawbar-fence-realcfg-"));
    const p = join(dir, "ship.config.json");
    writeFileSync(p, JSON.stringify({ projectDir: "/tmp/fixture-project-dir", repo: "org/repo" }));
    return p;
  })();

  const FIXTURE_MERGE_SHA = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

  // Fake `gh`/`git` covering every call the REAL merge-guard.ts makes across BOTH `verdict`
  // and `record-merge-sha` — dispatch by subcommand, `pr merge`'s exit controlled by
  // $MERGE_EXIT so the same fixture drives both the I7 happy path and the I8 failure path.
  // `apiOutput` is the files-list this fixture's `gh api .../pulls/<pr>/files` returns —
  // parameterized (Important A, fix pass 2) so the configPath end-to-end test below can drive
  // a diff touching a CUSTOM-basename config file through it, rather than every caller being
  // stuck with the hardcoded "src/index.ts" that never touches the configPath match at all.
  function makeFakeGhAndGitForFullMergeFence(apiOutput = "src/index.ts"): string {
    const dir = mkdtempSync(join(tmpdir(), "drawbar-full-merge-fence-"));
    const ghPath = join(dir, "gh");
    writeFileSync(
      ghPath,
      `#!/usr/bin/env bash\n` +
        `if [ "$1" = "pr" ] && [ "$2" = "view" ]; then\n` +
        // Important D (fix pass 2): the NEW post-failure diagnostic call
        // (`--json state,mergeCommit`) must be told apart from record-merge-sha's own
        // `--json mergeCommit` call — checked FIRST since it's the more specific substring.
        `  if [[ "$*" == *"state,mergeCommit"* ]]; then\n` +
        `    echo "OPEN "\n` +
        `  elif [[ "$*" == *mergeCommit* ]]; then\n` +
        `    echo "${FIXTURE_MERGE_SHA}"\n` +
        `  else\n` +
        // Critical B: the verdict's `gh pr view` now also requests `changedFiles` — a 4th
        // space-separated token, well under the 3000-file cap.
        `    echo "user/abc-1-slug main OPEN 5"\n` +
        `  fi\n` +
        // Important F: the independently-observed default-branch call.
        `elif [ "$1" = "repo" ] && [ "$2" = "view" ]; then\n` +
        `  echo "main"\n` +
        `elif [ "$1" = "pr" ] && [ "$2" = "checks" ]; then\n` +
        `  echo '[{"name":"build","bucket":"pass"},{"name":"CodeRabbit","bucket":"pass"}]'\n` +
        `elif [ "$1" = "api" ]; then\n` +
        `  echo "${apiOutput}"\n` +
        `elif [ "$1" = "pr" ] && [ "$2" = "merge" ]; then\n` +
        `  exit "\${MERGE_EXIT:-0}"\n` +
        `else\n` +
        `  echo "unexpected gh invocation in I7/I8 fixture: $*" >&2\n` +
        `  exit 1\n` +
        `fi\n`,
    );
    chmodSync(ghPath, 0o755);
    const gitPath = join(dir, "git");
    writeFileSync(
      gitPath,
      `#!/usr/bin/env bash\n` +
        // Critical A / Important E (fix pass 2): every real call is now `-C <dir> <subcommand>
        // ...` — anchored at `$3`, not `$1`. Covers both §4's own `git remote get-url origin`
        // (Important E) and merge-guard.ts's `record-merge-sha` fetch/merge-base (Critical A).
        `if [ "$1" = "-C" ]; then\n` +
        `  sub="$3"\n` +
        `  if [ "$sub" = "remote" ]; then\n` +
        `    echo "https://github.com/org/repo.git"\n` +
        `  elif [ "$sub" = "fetch" ]; then\n` +
        `    exit 0\n` +
        `  elif [ "$sub" = "merge-base" ]; then\n` +
        `    exit 0\n` +
        `  else\n` +
        `    echo "unexpected git invocation in I7/I8 fixture: $*" >&2\n` +
        `    exit 1\n` +
        `  fi\n` +
        `else\n` +
        `  echo "unexpected git invocation in I7/I8 fixture: $*" >&2\n` +
        `  exit 1\n` +
        `fi\n`,
    );
    chmodSync(gitPath, 0o755);
    return dir;
  }

  // Extracts the WHOLE §4 block (guard-start through the closing fence), unlike
  // extractMergeFence() above which deliberately stops before `gh pr merge -R` — this is what
  // lets I7/I8 exercise the real post-merge block.
  function extractFullMergeFence(): string {
    const block = mergeFenceText();
    const guardStart = block.indexOf("# MUST-CHECK bash-fence-cross-invocation-state-needs-unseeded-test");
    expect(guardStart, "cross-invocation derive-guard marker not found in the merge block").toBeGreaterThan(-1);
    return block.slice(guardStart);
  }

  test("Important 7/Critical 4: the real fence, with the real merge-guard.ts, runs the verdict AND the post-merge merge_sha capture end to end", async () => {
    const binDir = makeFakeGhAndGitForFullMergeFence();
    // Matches the WHOLE `gh pr merge ... || { ...; exit 1; }` statement (Important 8's error
    // handler is part of the same shell statement via the trailing `\` continuation) — a
    // partial replacement leaving the `||` orphaned on its own line is a bash syntax error,
    // not a semantic no-op.
    const realMergeStatement = /gh pr merge -R "\$REPO" "\$PR" --squash --delete-branch[\s\S]*?exit 1;\s*\\?\s*\n?\s*\}/;
    const script = extractFullMergeFence();
    expect(realMergeStatement.test(script), "the real `gh pr merge -R ... || { ... }` statement must still be present to replace").toBe(true);
    const noOpScript = script.replace(
      realMergeStatement,
      'true # I7 fixture: real merge replaced with a no-op — this test verifies the fence past this point, never a real GitHub merge',
    );
    const proc = Bun.spawn(["bash", "-c", `${noOpScript}\necho MERGE_SHA_STEP_REACHED`], {
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        STORY: "ABC-1",
        PR: "1",
        RESOLVED: REAL_MODULE_RESOLVED_JSON,
        SNAPSHOT: '["ABC-1"]',
        CLAUDE_PLUGIN_ROOT: root,
        MERGE_EXIT: "0",
        DRAWBAR_SHIP_CONFIG: REAL_MODULE_CONFIG_PATH,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    expect(code, `expected exit 0; got stderr:\n${err}\nstdout:\n${out}`).toBe(0);
    expect(out).toContain(`merge_sha=${FIXTURE_MERGE_SHA}`);
    expect(out).toContain("MERGE_SHA_STEP_REACHED");
  });

  // Important D (fix pass 2): the failure message was reworded — a non-zero `gh pr merge`
  // exit no longer asserts "the PR was NOT merged" as fact; it now checks `gh pr view` and
  // reports both possible outcomes. This test's fake `gh pr merge` fails WITHOUT ever having
  // merged (MERGE_EXIT=1, and the fake `gh pr view --json state,mergeCommit` echoes "OPEN "),
  // so the diagnostic should report the OPEN branch of that message.
  test("Important 8/D: a failing `gh pr merge` refuses immediately, never reaches record-merge-sha, and reports the ambiguous-merge-state diagnostic", async () => {
    const binDir = makeFakeGhAndGitForFullMergeFence();
    const script = extractFullMergeFence();
    const proc = Bun.spawn(["bash", "-c", `${script}\necho MERGE_SHA_STEP_REACHED`], {
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        STORY: "ABC-1",
        PR: "1",
        RESOLVED: REAL_MODULE_RESOLVED_JSON,
        SNAPSHOT: '["ABC-1"]',
        CLAUDE_PLUGIN_ROOT: root,
        MERGE_EXIT: "1",
        DRAWBAR_SHIP_CONFIG: REAL_MODULE_CONFIG_PATH,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    expect(code).not.toBe(0);
    expect(out + err).toContain("REFUSING: gh pr merge exited non-zero");
    expect(out + err).toContain("checked gh pr view: OPEN");
    expect(out + err).toContain("the PR was NOT merged");
    expect(out + err).not.toContain("MERGE_SHA_STEP_REACHED");
    expect(out + err).not.toContain("merge_sha=");
  });

  // Important A (fix pass 2): the WHOLE C3(c) chain — `DRAWBAR_SHIP_CONFIG` -> `$CONFIG` ->
  // stdin `configPath` -> merge-guard.ts's `configBasenames` match — had ZERO end-to-end
  // coverage. Reproduced: mutating the shipped fence's `--arg configPath "$CONFIG"` to
  // `--arg configPath ""` left the whole suite green before this test existed (see the report
  // for the mutation run). Drives a CUSTOM config basename (not the hardcoded default
  // `ship.config.json`) all the way from `DRAWBAR_SHIP_CONFIG` through the real fence and the
  // real `merge-guard.ts`, and asserts the config-diff refusal actually fires on it.
  test("Important A: configPath plumbing is genuinely end-to-end — a diff touching the DRAWBAR_SHIP_CONFIG-pointed custom-basename file is caught", async () => {
    const cfgDir = mkdtempSync(join(tmpdir(), "drawbar-configpath-e2e-"));
    const customConfigPath = join(cfgDir, "custom-ship-config.json");
    // Carries the same projectDir/repo as REAL_MODULE_RESOLVED_JSON — §4's Critical-1 trusted
    // anchors must agree before the verdict is ever reached, and this test is about the CUSTOM
    // BASENAME reaching `configPath`, not about the anchor check.
    writeFileSync(customConfigPath, JSON.stringify({ projectDir: "/tmp/fixture-project-dir", repo: "org/repo" }));
    // The fake `gh api .../pulls/<pr>/files` echoes a diff touching exactly that custom
    // basename — never the hardcoded default `ship.config.json` this fixture never uses.
    const binDir = makeFakeGhAndGitForFullMergeFence("some/dir/custom-ship-config.json");
    const script = extractMergeFence(); // stops before `gh pr merge -R` — the refusal fires inside verdict, before it
    const proc = Bun.spawn(["bash", "-c", `${script}\necho MERGE_REACHED`], {
      env: {
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        STORY: "ABC-1",
        PR: "1",
        RESOLVED: REAL_MODULE_RESOLVED_JSON,
        SNAPSHOT: '["ABC-1"]',
        CLAUDE_PLUGIN_ROOT: root,
        DRAWBAR_SHIP_CONFIG: customConfigPath,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    expect(code).not.toBe(0);
    expect(out + err).toContain("config_diff_touches_ship_config");
    expect(out + err).not.toContain("MERGE_REACHED");
  });
});

// Fix pass (mutation-gate hole): no existing test asserted anything about the literal
// `gh pr create` / Hard-rules text for `--base`, so a mutation replacing
// `--base "$BASE_BRANCH"` with a bare `--base main` was invisible to the suite. These pin
// the parameterized form and positively forbid the hardcoded one from reappearing in either
// file. Anchored on files first proven non-empty via readNonEmpty, per MUST-CHECK
// vacuous-assertion-needs-preseed-state.
describe("PCO-348 fix pass: --base parameterization is not silently re-hardcoded", () => {
  test("agents/drawbar-story-lead.md section 6 ships gh pr create with the configured base branch", () => {
    const txt = readNonEmpty(join(root, "agents/drawbar-story-lead.md"));
    expect(txt).toContain('gh pr create -R "$REPO" --base "$BASE_BRANCH"');
    expect(txt).not.toMatch(/--base\s+main\b/);
  });

  test("commands/drawbar-ship.md does not contain a hardcoded --base main", () => {
    const txt = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    expect(txt).not.toMatch(/--base\s+main\b/);
  });

  // Fix pass 2, Important 3: the producer (this bullet, §2) and the consumer
  // (agents/drawbar-story-lead.md, which runs `gh pr create --base "$BASE_BRANCH"` in §6)
  // must agree on what the brief carries. As shipped, only the consumer side named
  // $BASE_BRANCH — the producer's "brief must carry" list still named just $KB, $PROJECT_DIR,
  // $REPO and the branch name, so a story-lead built from this brief alone would run
  // `gh pr create --base ""` and fail mid-story after the implementation was already done.
  test("commands/drawbar-ship.md's 'brief must carry' list names $BASE_BRANCH, matching agents/drawbar-story-lead.md's consumption of it (Important 3)", () => {
    const txt = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    const idx = txt.indexOf("The brief must carry:");
    expect(idx, "'The brief must carry:' not found").toBeGreaterThan(-1);
    const listStart = txt.indexOf("\n-", idx); // start of the first bullet
    expect(listStart, "start of the 'brief must carry' bullet list not found").toBeGreaterThan(idx);
    const listEnd = txt.indexOf("\n\n", listStart); // blank line closing the bullet list
    expect(listEnd, "end of the 'brief must carry' bullet list not found").toBeGreaterThan(listStart);
    const bulletList = txt.slice(idx, listEnd);
    expect(bulletList).toContain("$BASE_BRANCH");
  });
});

// Fix pass 2, Important 4: `mergedStatus` was validated by ship-config.ts and carried through
// `resolved_config`, but §5 still hardcoded the literal `Pre-QA` — a dead config field, the
// same class of bug `requiredChecks` had before this same fix pass. §5 must reference the
// configured `$MERGED_STATUS` instead, while the human-owned/completed-status prohibition
// (a fixed, workspace-independent list) survives verbatim.
describe("§5 Linear status is parameterized on the configured mergedStatus, not hardcoded (Important 4)", () => {
  function section5(): string {
    const txt = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    const start = txt.indexOf("## 5.");
    expect(start, "'## 5.' heading not found").toBeGreaterThan(-1);
    const end = txt.indexOf("## 6.", start);
    expect(end, "'## 6.' heading not found after §5").toBeGreaterThan(start);
    return txt.slice(start, end);
  }

  // Important 3 (fix pass 4): the old assertion anchored on the exact byte sequence
  // `Set the story to **`Pre-QA`**` and separately checked `s5.toContain("$MERGED_STATUS")`
  // — but that second check is satisfied by the `$MERGED_STATUS` token ANYWHERE in §5 (e.g.
  // the heading), so a re-hardcode with different markdown emphasis (`Set the story to
  // `Pre-QA`` — no bold) survived undetected. Anchor POSITIVELY on the instruction line
  // itself via regex (so emphasis-style drift can't hide behind it), and separately assert
  // that §5's INSTRUCTION TEXT — §5 minus the historical blockquote, which legitimately and
  // deliberately preserves the literal `Pre-QA` as a fact about a specific past run — carries
  // no `Pre-QA` literal at all.
  test("§5 sets the story to the configured $MERGED_STATUS, not the literal 'Pre-QA'", () => {
    const s5 = section5();
    expect(s5).toMatch(/Set the story to \*\*`\$MERGED_STATUS`\*\*/);
    const instructionText = s5
      .split("\n")
      .filter((line) => !line.trimStart().startsWith(">"))
      .join("\n");
    expect(instructionText).not.toContain("Pre-QA");
  });

  test("§5's re-read-and-assert-it-stuck step asserts against $MERGED_STATUS, not the literal 'Pre-QA'", () => {
    const s5 = section5();
    expect(s5).toContain('assert `status == "$MERGED_STATUS"`');
    expect(s5).not.toContain('assert `status == "Pre-QA"`');
  });

  test("the human-/QA-owned completion-status prohibition survives verbatim and un-weakened", () => {
    const s5 = section5();
    expect(s5).toContain(
      "**Never** `Done`, `Ready For QA`, `Ready for Rollout`, or `Rolled Out` — human- and\nQA-owned. Never call `save_issue` with any `completed`-type status.",
    );
  });

  test("§5 documents that validateShipConfig's type-started assertion is what mechanically guarantees $MERGED_STATUS can never be a completion status", () => {
    const s5 = section5();
    expect(s5).toContain("validateShipConfig");
    expect(s5.toLowerCase()).toContain("type: started");
  });

  // Fix pass 3: the frontmatter `description:` — the one line users actually see in the
  // plugin's command list — still named the workspace-specific literal `Pre-QA`, the same
  // class of leftover §5's body was parameterized against above. It must describe the
  // behaviour generically (setting the configured merged-but-not-QA'd status) instead.
  test("the frontmatter description carries no hardcoded status literal (fix pass 3)", () => {
    const fm = frontmatter(join(root, "commands/drawbar-ship.md"));
    expect(fm.description).not.toContain("Pre-QA");
  });
});

// Fix pass 2: Operator notes document the two new rules this pass introduced.
describe("Operator notes document fix pass 2's new rules", () => {
  function operatorNotes(): string {
    const txt = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    const start = txt.indexOf("## Operator notes");
    expect(start, "'## Operator notes' heading not found").toBeGreaterThan(-1);
    const end = txt.indexOf("## Appendix", start);
    expect(end, "'## Appendix' heading not found after Operator notes").toBeGreaterThan(start);
    return txt.slice(start, end);
  }

  // Important 8: the tracked-config security rule must be documented for operators, not just
  // enforced silently in Preflight.
  test("documents that a real ship config must never be tracked by git", () => {
    const notes = operatorNotes();
    expect(notes).toContain("tracked by git");
  });

  // Minor: refusal `detail` strings echo absolute paths and the real repo slug — the slug
  // leak-rule is deliberately out of scope for knowledge.jsonl (see the leak-scan describe
  // above), so an operator pasting a refusal verbatim into the KB or a Linear comment would
  // leak it unscanned.
  test("documents that ship-config refusal text must be paraphrased, never pasted, into a KB entry or Linear comment", () => {
    const notes = operatorNotes();
    expect(notes.toLowerCase()).toContain("paraphrase");
    expect(notes).toContain("never");
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

  // PCO-348 (S3): the committed example config must be structurally acceptable to
  // parseShipConfig (proving its shape actually matches ShipConfig) but its PLACEHOLDER
  // values must be refused by validateShipConfig — that refusal is the fail-closed proof
  // that a copied-but-unedited example can never actually run. See MUST-CHECK
  // vacuous-assertion-needs-preseed-state: asserting "invalid" alone would be vacuous if the
  // file were simply missing/unreadable, so readNonEmpty (which asserts non-empty first) is
  // used, and the structural-parse assertion is checked before the refusal assertion.
  test(".drawbar/ship.config.example.json is structurally valid but its placeholder values are refused", () => {
    const txt = readNonEmpty(join(root, ".drawbar/ship.config.example.json"));
    const parsed = parseShipConfig(txt);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.keys(parsed.config).sort()).toEqual(
      ["baseBranch", "envDir", "mergedStatus", "projectDir", "repo", "requiredChecks", "team"].sort(),
    );

    const calls: string[][] = [];
    const spy: Runner = (argv) => {
      calls.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = validateShipConfig({
      config: parsed.config,
      linear: { teams: [], statuses: [] },
      git: spy,
      gh: spy,
    });
    expect(result.ok).toBe(false);
    // The placeholder repo `<org>/<repo>` fails shape validation before any runner call —
    // an unedited example refuses at the very first check, not deep in the pipeline.
    expect(calls.length).toBe(0);
  });

  test(".gitignore actually ignores the operator's real ship config (pattern-matched, not just non-empty)", () => {
    const txt = readNonEmpty(join(root, ".gitignore"));
    expect(txt).toMatch(/^\*\*\/\.drawbar\/ship\.config\.json$/m);
  });

  // MINOR fix pass 2: `.drawbar/ship.config.json` (no leading `**/`) contains a `/`, so git
  // anchors it to the repo root only — `sub/.drawbar/ship.config.json` was NOT ignored.
  // Verified for real against the actual repo's `.gitignore` via `git check-ignore`, both at
  // the root (unaffected by the fix) and nested (the actual gap).
  test("git check-ignore actually ignores the real ship config at any depth, not just the repo root", () => {
    const rootCase = Bun.spawnSync(["git", "check-ignore", "-q", ".drawbar/ship.config.json"], { cwd: root });
    expect(rootCase.exitCode, "root-level ship.config.json must still be ignored").toBe(0);

    const nestedCase = Bun.spawnSync(["git", "check-ignore", "-q", "sub/.drawbar/ship.config.json"], { cwd: root });
    expect(nestedCase.exitCode, "nested ship.config.json must be ignored too (the actual gap)").toBe(0);

    // The example file must stay tracked — the fix must not shadow it.
    const exampleCase = Bun.spawnSync(["git", "check-ignore", "-q", ".drawbar/ship.config.example.json"], { cwd: root });
    expect(exampleCase.exitCode, "the example file must NOT be ignored").not.toBe(0);
  });
});

// Locked 20 (as amended, PCO-348 / S3): workspace-specific REASONING about deploys is
// removed from both ported files, not merely reworded — the staging-deploy queue, the
// `cancel-in-progress: false` mechanism, and the "production is manually triggered" claim
// are all specific to the original private workspace's CI, not generic properties this
// plugin can assert. Each anchor is asserted absent from BOTH files: the phrases originated
// in commands/drawbar-ship.md, but asserting absence from agents/drawbar-story-lead.md too
// guards against either file re-accumulating the same reasoning later. Anchored on a file
// first proven non-empty (readNonEmpty), per MUST-CHECK vacuous-assertion-needs-preseed-state.
// The "dispatch-triggered" half of this claim is already covered globally by the existing
// `workflow_dispatch`/`repository_dispatch` literal-absence rules above — not re-authored here.
describe("Locked 20 — workspace-specific deploy reasoning removed (PCO-348)", () => {
  const FILES = ["commands/drawbar-ship.md", "agents/drawbar-story-lead.md"];
  const REMOVED_PHRASES = [
    { name: "staging-deploy-queue phrasing", phrase: "staging deploy" },
    { name: "cancel-in-progress: false string", phrase: "cancel-in-progress: false" },
    { name: "production-is-manually-triggered claim", phrase: "triggered manually" },
  ];
  for (const file of FILES) {
    for (const { name, phrase } of REMOVED_PHRASES) {
      test(`${file} does not contain the ${name}`, () => {
        const txt = readNonEmpty(join(root, file));
        expect(txt).not.toContain(phrase);
      });
    }
  }
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

// Fix pass (PCO-350, IMPORTANT 5): scripts/lib/run-state.test.ts used to carry THREE tests
// with byte-identical bodies (same seed, same call to `clearInFlight`) under three different
// names — one for "report," one for "park," one for "halt." They could not fail
// independently: `clearInFlight`'s whole implementation is `{...state, in_flight: null}`, so
// one unit test fully covers it (see run-state.test.ts). What the AC actually cares about —
// that each of the THREE runbook narrative sites still instructs clearing `in_flight` — was
// never tested at all; deleting any one of the three prose lines below left the old suite
// green. These doc assertions close that gap, following the established
// grep-commands/drawbar-ship.md pattern used elsewhere in this file (e.g. the §5/mutation-gate
// tests above).
describe("in_flight is cleared at all three Locked-13 narrative sites in commands/drawbar-ship.md (IMPORTANT 5)", () => {
  // Every assertion below runs against a WHITESPACE-NORMALIZED section, never the raw slice.
  // These are prose paragraphs: markdown hard-wraps them, so which words land on which line is
  // an editorial accident, not a property worth pinning. An earlier version of this block
  // asserted the literal `"in_flight:\nnull"` — i.e. it depended on the wrap falling between
  // those two tokens, and would have gone red on an ordinary reflow that changed nothing about
  // what the runbook instructs. Same lesson as MUST-CHECK
  // repo-wide-duplicate-implementation-scan-excludes-test-fixtures: key the assertion on
  // CONTENT, never on position or formatting.
  function section(startMarker: string, endMarker: string): string {
    const txt = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    const start = txt.indexOf(startMarker);
    expect(start, `'${startMarker}' heading not found`).toBeGreaterThan(-1);
    const end = txt.indexOf(endMarker, start);
    expect(end, `'${endMarker}' heading not found after '${startMarker}'`).toBeGreaterThan(start);
    return txt.slice(start, end).replace(/\s+/g, " ");
  }

  test("step 5 (report) clears in_flight", () => {
    const s5 = section("## 5.", "## 6.");
    expect(s5).toContain("Clear `in_flight` in the state file");
    expect(s5).toContain("in_flight: null");
  });

  test("'Parking a story' clears in_flight", () => {
    const parkSection = section("## Parking a story", "## Crash recovery");
    expect(parkSection).toContain("clear `in_flight` in the state file");
    expect(parkSection).toContain("in_flight: null");
  });

  // Minor (fix pass 2): the I10 "Parking a story" carve-out (a refusal AFTER `gh pr merge` has
  // already run means the PR is already merged — never re-merge, re-run record-merge-sha
  // instead) was prose-only, with nothing pinning it — a future edit could silently drop the
  // exception and the whole suite would stay green. Mirrors the sibling in_flight tests above.
  test("Minor: the I10 'Parking a story' carve-out (a post-merge refusal is not an ordinary park) is pinned", () => {
    const parkSection = section("## Parking a story", "## Crash recovery");
    expect(parkSection).toContain("Exception");
    expect(parkSection).toContain("already merged");
    expect(parkSection).toContain("Do not re-merge");
    expect(parkSection).toContain("record-merge-sha");
  });

  test("the halt branch of 'Crash recovery' clears in_flight", () => {
    const crashSection = section("## Crash recovery", "## Finishing the run");
    expect(crashSection).toContain("must be halted outright");
    expect(crashSection).toContain("**clear `in_flight`** (`in_flight: null`) before halting");
  });
});
