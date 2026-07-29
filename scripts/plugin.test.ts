import { test, expect, describe } from "bun:test";
import { readFileSync, mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseShipConfig, validateShipConfig, type Runner } from "./lib/ship-config";
import { REQUIRED_KEYS } from "./lib/run-state";

const root = join(import.meta.dir, "..");

// Reads a file and asserts it is non-empty before returning its text — a grep
// assertion against a missing/empty file is vacuously true, which defeats the
// point of a preservation test. See MUST-CHECK vacuous-assertion-needs-preseed-state.
function readNonEmpty(path: string): string {
  const txt = readFileSync(path, "utf8");
  expect(txt.length).toBeGreaterThan(0);
  return txt;
}

// Every top-level `## N.` heading in commands/drawbar-ship.md must occur exactly once — a
// marker occurring more than once makes `indexOf` silently pick the FIRST occurrence, which
// can truncate or mis-scope a slice built from it without any assertion noticing. Shared by
// every describe below that slices this doc.
function assertOccursOnce(marker: string): void {
  const txt = readNonEmpty(join(root, "commands/drawbar-ship.md"));
  const count = txt.split(marker).length - 1;
  expect(count, `'${marker}' must occur exactly once in the doc, found ${count}`).toBe(1);
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
    // PCO-365 (R2): the stack module and its tests — same lowercase-fixture-id discipline as
    // run-state.test.ts. The leak scan errors on a missing path, so both must exist on disk.
    "scripts/lib/stack.ts",
    "scripts/lib/stack.test.ts",
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
        // IMPORTANT 6 (fix pass): eight entries — "head/statuses", "failing/cancelled",
        // "S6/PCO-351", "gone/closed", "RESOLVED/SNAPSHOT", "empty/unset", "park/notify",
        // "ENV_DIR/<repo>" — were removed here after both reviewers independently measured
        // zero remaining occurrences in the files this rule scans. Every entry here is a
        // permanent exemption in the one rule that would catch a real committed org/repo
        // slug; an entry with zero live occurrences is pure unreviewed surface, not a
        // reviewed exemption.
        const ALLOWLIST = new Set([
          "drawbar/memory",
          ".drawbar/memory",
          "PROJECT_DIR/.git",
          "creation/update",
          "backend/security-touching",
          "Critical/Important",
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
          // PCO-351 (S6) addition — a prose word/word pair. Not an org/repo slug. (A fix pass
          // removed a third entry, "5/7." — the section cross-reference it allowlisted was
          // reworded to "step 5" to avoid the slash entirely, rather than widen this
          // allowlist for a bare `<digit>/<digit>.` shape that could otherwise mask an
          // unrelated leak later.)
          "unparseable/empty",
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
  // controls envDir (where $KB and the run-state file get written) and team even though the
  // repo-anchor guard holds; `requiredChecks` is validated and persisted too, but currently
  // unenforced — no consumer reads it — pending a later story. Enforce the invariant the
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

  test("passes (for real) on a well-formed resolved payload, deriving all four values plus $KB", async () => {
    const script =
      `RESOLVED='{"envDir":"/tmp/e","projectDir":"/tmp/p","repo":"acme/widgets","baseBranch":"main"}'\n` +
      extractDeriveGuard() +
      `\necho "OK $ENV_DIR $PROJECT_DIR $REPO $BASE_BRANCH $KB"`;
    const { code, output } = await runScript(script, {});
    expect(code).toBe(0);
    expect(output).toContain("OK /tmp/e /tmp/p acme/widgets main /tmp/e/.drawbar/memory");
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

// IMPORTANT 2 (fix pass): `LinearFacts` is `{ teams: string[] }` — the Preflight comment
// telling the agent what to assemble on stdin must name that exact shape, not a `statuses`
// field ship-config.ts's `isLinearFacts` has never accepted. Pinned against the validator's
// own refusal string (extracted from source, not hand-copied) so the two cannot drift again.
describe("Preflight's Linear-facts stdin shape matches ship-config.ts's isLinearFacts contract (IMPORTANT 2)", () => {
  test("the assemble comment names exactly the shape isLinearFacts's refusal message names, with no stale `statuses` field", () => {
    const shipConfigSrc = readNonEmpty(join(root, "scripts/lib/ship-config.ts"));
    const m = shipConfigSrc.match(/refused: stdin is not valid Linear facts JSON \((\{"teams":\[\.\.\.\]\})\)/);
    expect(m, "isLinearFacts refusal message not found in ship-config.ts").not.toBeNull();
    const expectedShape = m![1]!;

    const doc = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    const start = doc.indexOf("# Fetch the Linear facts");
    expect(start, "'Fetch the Linear facts' comment not found in Preflight").toBeGreaterThan(-1);
    const end = doc.indexOf("RESOLVED=$(echo", start);
    expect(end, "RESOLVED= assignment not found after the fetch comment").toBeGreaterThan(start);
    const assembleComment = doc.slice(start, end);

    expect(assembleComment).toContain(`Assemble \`${expectedShape}\``);
    expect(assembleComment).not.toContain("statuses");
    expect(assembleComment).not.toContain("list_issue_statuses");
  });

  test("the list_issue_statuses connectivity check names a real consumer, not the deleted status-transition rationale", () => {
    const doc = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    // This command never performs a status transition — that claim is false and must be gone.
    expect(doc).not.toContain("status transitions are how the next iteration knows what is done");
    const idx = doc.indexOf("list_issue_statuses` for team");
    expect(idx, "list_issue_statuses connectivity check not found").toBeGreaterThan(-1);
    const sentence = doc.slice(idx, doc.indexOf("\n\n", idx));
    // §1's pick rule and the blocker gate are what actually read issue status.
    expect(sentence).toMatch(/pick|blocker/i);
  });
});

// PCO-367 (R4) deleted the story-lead's §7 "Drive it green" section outright, and with it
// the drive-it-green bash fence this file used to extract and drive against a stubbed `gh`.
// The story-lead opens no PR, so it has no PR to poll: there is nothing left to wait on until
// the caller's §4 runs. The absence of the section, its fence, and its two parking reasons is
// asserted in the R4 describe near the bottom of this file — nothing here replaces the removed
// harness, because the behavior it covered no longer exists anywhere in the plugin.

// Fix pass (mutation-gate hole): no existing test asserted anything about the literal
// `--base` text, so a mutation replacing `--base "$BASE_BRANCH"` with a bare `--base main`
// was invisible to the suite. PCO-367 (R4) removed PR creation from the story-lead entirely,
// so only the command side keeps a positive pin here; the story-lead side is now an absence
// check (see the R4 describe). Anchored on files first proven non-empty via readNonEmpty, per
// MUST-CHECK vacuous-assertion-needs-preseed-state.
describe("PCO-348 fix pass: --base parameterization is not silently re-hardcoded", () => {
  test("agents/drawbar-story-lead.md never hardcodes a --base main anywhere", () => {
    const txt = readNonEmpty(join(root, "agents/drawbar-story-lead.md"));
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


// Fix pass 2: Operator notes document the two new rules this pass introduced.
describe("Operator notes document fix pass 2's new rules", () => {
  function operatorNotes(): string {
    const txt = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    const start = txt.indexOf("## Operator notes");
    expect(start, "'## Operator notes' heading not found").toBeGreaterThan(-1);
    // PCO-364 (R1): the CodeRabbit-gate Appendix that used to bound this section from below
    // is deleted along with the gate itself — Operator notes is now the LAST section in the
    // doc, so this slices to end-of-file rather than to a now-nonexistent heading.
    return txt.slice(start);
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

// IMPORTANT 5 (fix pass): four comments asserted behavior deleted along with the merge path
// and CodeRabbit gating. Each pins the false claim's absence, not just a positive replacement
// — a reader must never be told a merge gate, a report-site clear, a merge-time re-assertion,
// or a merge exist when none do.
describe("stale comments corrected after the merge path's removal (IMPORTANT 5)", () => {
  test("commands/drawbar-ship.md no longer claims requiredChecks neuters a merge gate that does not exist", () => {
    const doc = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    expect(doc).not.toContain("neuters the merge gate");
    expect(doc.toLowerCase()).toContain("requiredchecks");
    expect(doc.toLowerCase()).toMatch(/requiredchecks[^.]*unenforced/);
  });

  test("scripts/plugin.test.ts's mirrored tracked-config comment does not imply requiredChecks is enforced", () => {
    const src = readNonEmpty(join(root, "scripts/plugin.test.ts"));
    const start = src.indexOf("Fix pass 2, Important 8 (security): a ship config is never read from EXPORTED ENV VARS");
    expect(start, "the mirrored tracked-config comment was not found").toBeGreaterThan(-1);
    const end = src.indexOf("function initRealGitRepo", start);
    expect(end, "end of the mirrored comment (initRealGitRepo) not found").toBeGreaterThan(start);
    const comment = src.slice(start, end);
    expect(comment.toLowerCase()).toContain("unenforced");
  });

  test("run-state.ts's clearInFlight comment names the surviving call sites, not the deleted step 5/three-test claim", () => {
    const src = readNonEmpty(join(root, "scripts/lib/run-state.ts"));
    expect(src).not.toContain("report (step 5/7)");
    expect(src).not.toContain("the three tests in run-state.test.ts");
  });

  test("ship-config.ts's ResolvedConfig comment does not claim a merge-time re-assertion step exists today", () => {
    const src = readNonEmpty(join(root, "scripts/lib/ship-config.ts"));
    // Whitespace-normalized: the source comment wraps across lines, so a literal substring
    // check would miss it depending on where the line break falls.
    const start = src.indexOf("export interface ResolvedConfig");
    expect(start, "ResolvedConfig interface not found").toBeGreaterThan(-1);
    const commentStart = src.lastIndexOf("// The `resolved_config` payload", start);
    expect(commentStart, "ResolvedConfig's leading comment not found").toBeGreaterThan(-1);
    const comment = src.slice(commentStart, start).replace(/\s+/g, " ");
    expect(comment).not.toMatch(/\(S5,\s*at merge time\)/);
    expect(comment.toLowerCase()).toContain("no consumer");
  });

  test("commands/drawbar-ship.md's Finishing the run section does not claim anything is merged", () => {
    const doc = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    const start = doc.indexOf("## Finishing the run");
    expect(start, "'## Finishing the run' heading not found").toBeGreaterThan(-1);
    const end = doc.indexOf("## Hard rules", start);
    expect(end, "'## Hard rules' heading not found").toBeGreaterThan(start);
    const section = doc.slice(start, end);
    expect(section).not.toContain("merged / parked");
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
      ["baseBranch", "envDir", "projectDir", "repo", "requiredChecks", "team"].sort(),
    );

    const calls: string[][] = [];
    const spy: Runner = (argv) => {
      calls.push(argv);
      return { code: 0, stdout: "", stderr: "" };
    };
    const result = validateShipConfig({
      config: parsed.config,
      linear: { teams: [] },
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
// PCO-364 (R1): retitled — Locked 13 originally named THREE narrative sites (report, park,
// halt); the "report" site lived entirely inside §5, which is now deleted along with the
// merge/CodeRabbit machinery it served (this command is left with a documented gap where §4
// and §5 were, per this story's brief — R3/R4 restores the report step and its in_flight
// clear). Only the two surviving sites are asserted here.
describe("in_flight is cleared at the two surviving Locked-13 narrative sites in commands/drawbar-ship.md (IMPORTANT 5)", () => {
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
    const end = txt.indexOf(endMarker, start);
    expect(end, `'${endMarker}' heading not found after '${startMarker}'`).toBeGreaterThan(start);
    return txt.slice(start, end).replace(/\s+/g, " ");
  }

  test("'Parking a story' clears in_flight", () => {
    const parkSection = section("## Parking a story", "## Crash recovery");
    expect(parkSection).toContain("clear `in_flight` in the state file");
    expect(parkSection).toContain("in_flight: null");
  });

  test("the halt branch of 'Crash recovery' clears in_flight", () => {
    const crashSection = section("## Crash recovery", "## Finishing the run");
    expect(crashSection).toContain("must be halted outright");
    expect(crashSection).toContain("**clear `in_flight`** (`in_flight: null`) before halting");
  });

  // REGRESSION (Important 4, PCO-364 R1): §7 used to falsely claim the deleted §5 already
  // cleared `in_flight` on report. Pin the honest gap statement and reject the false claim's
  // reintroduction.
  test("'## 7. Advance' states the report-site in_flight gap honestly, not the false §5 claim", () => {
    const advanceSection = section("## 7. Advance", "## Parking a story");
    expect(advanceSection).not.toContain("step 5 already cleared it");
    expect(advanceSection).toContain("`in_flight` is **not** cleared here");
  });
});

// Fix-pass discipline. These rules exist because a story's review loop ran three rounds, and
// each fix pass introduced a Critical into the code IT had just written — culminating in an
// arbitrary-code-execution sink created by plumbing that no finding had asked for. The cause was
// briefs carrying twenty-plus items (Criticals through Minors) into a single "fix pass", which is
// a second story wearing a fix pass's name. Pinned here, keyed on CONTENT rather than position,
// so the constraint cannot be quietly dropped in an edit — same discipline as the Locked-13
// narrative-site block above.
describe("fix-pass scope discipline is documented in both the command and the agent", () => {
  function normalized(relPath: string): string {
    return readNonEmpty(join(root, relPath)).replace(/\s+/g, " ");
  }

  test("drawbar-work's review loop restricts a fix pass to Critical and Important findings", () => {
    const txt = normalized("commands/drawbar-work.md");
    expect(txt).toContain("Critical and Important findings only");
    expect(txt).toContain("Minors do not go in");
  });

  test("drawbar-work tells the lead to cap the loop and escalate to the user with a cost estimate", () => {
    const txt = normalized("commands/drawbar-work.md");
    expect(txt).toContain("stop and go to the user before starting a third");
    expect(txt).toContain("what it has cost so far");
  });

  test("drawbar-work's verification gate requires mutation-testing the guards, not just a green suite", () => {
    const txt = normalized("commands/drawbar-work.md");
    expect(txt).toContain("Mutation-test the load-bearing guards");
    expect(txt).toContain("neuter each one and confirm a specific test fails");
  });

  test("story-implementer's fix mode forbids refactors and unrequested abstractions", () => {
    const txt = normalized("agents/story-implementer.md");
    expect(txt).toContain("Change only what the findings name");
    expect(txt).toContain("Refactoring code the findings did not name");
    expect(txt).toContain("Introducing a new abstraction");
  });

  test("story-implementer's fix mode requires asking rather than expanding scope and disclosing after", () => {
    const txt = normalized("agents/story-implementer.md");
    expect(txt).toContain("say so in your report and ask");
    // Substring stops before the markdown emphasis that wraps "no finding named" — normalizing
    // whitespace does not strip `**`, and which words an author bolds is an editorial accident.
    expect(txt).toContain("anything you changed that");
    expect(txt).toContain("no finding named");
  });

  test("story-implementer is told to write comments as invariants, not as a narration of its own process", () => {
    const txt = normalized("agents/story-implementer.md");
    expect(txt).toContain("Your reasoning process is not part of the code");
    // The three narration shapes this repo's comments actually accumulated: review
    // provenance, what an earlier draft did, and who found it.
    expect(txt).toContain("Review provenance");
    expect(txt).toContain("What an earlier draft did");
    expect(txt).toContain("Who found it or how");
    // Bounded so this cannot be satisfied by a blanket "no comments" rule, which would lose
    // the load-bearing ones.
    expect(txt).toContain("why it is load-bearing");
    expect(txt).toContain("Do not make a separate pass to rewrite comments you are not otherwise touching");
  });
});

// PCO-352 (S7): H1 — the blocker gate the configured merged-but-not-QA'd status mandates and step 1's original
// two-clause rule could never accept, by construction — is fixed by rewriting the rule as four
// prose clauses. Also: unavailable dependency information halts (Locked 11), and out-of-scope
// findings are filed `Unplanned`, not `Todo` (Locked 14). All three assertions below key on
// CONTENT within a bounded slice of the doc, never on the whole file, so a legitimate
// `Unplanned`/`Todo` occurrence elsewhere (e.g. clause 2's non-`Unplanned` children wording)
// can never make an assertion here vacuous.
describe("PCO-352 S7: blocker gate clauses, Locked-11 halt, Unplanned filing", () => {
  function shipDoc(): string {
    return readNonEmpty(join(root, "commands/drawbar-ship.md"));
  }

  // Slices between two headings, asserting both are found and in order, mirroring the
  // established `section()` helper above — kept local here rather than hoisted, since this
  // describe is the only consumer and a shared helper across describes has previously made a
  // marker rename in one place silently break an unrelated describe elsewhere in this file.
  //
  // Whitespace-normalized (single spaces), same discipline as the established `section()`
  // helper elsewhere in this file: these are hard-wrapped prose paragraphs, so which words
  // land on which markdown line is an editorial accident, not a property worth pinning.
  function slice(startMarker: string, endMarker: string): string {
    assertOccursOnce(startMarker);
    assertOccursOnce(endMarker);
    const txt = shipDoc();
    const start = txt.indexOf(startMarker);
    expect(start, `'${startMarker}' heading not found`).toBeGreaterThan(-1);
    const end = txt.indexOf(endMarker, start);
    expect(end, `'${endMarker}' heading not found after '${startMarker}'`).toBeGreaterThan(start);
    const body = txt.slice(start, end).replace(/\s+/g, " ");
    // MUST-CHECK vacuous-assertion-needs-preseed-state: a slice that turned out empty would
    // make every "does not contain" assertion below vacuously true. `> 0` alone was DEAD CODE
    // (fix pass, Important 9.3): the `toBeGreaterThan(start)` assert on `end` two lines up
    // already throws whenever `end <= start`, so reaching this line means `end > start`, which
    // makes `body.length >= 1` unconditional — `> 0` here could never fire. A floor set below
    // the smallest real section (`## 3.` -> `## 4.` is ~733 chars normalized) but well above
    // "near-empty" is what actually catches a genuinely gutted section.
    expect(body.length).toBeGreaterThan(200);
    return body;
  }

  // MUST-CHECK doc-fence-slice-marker-must-not-appear-in-comments: a marker that occurs more
  // than once makes `indexOf` silently pick the FIRST occurrence, which can truncate or
  // mis-scope the slice without any assertion above ever noticing. Each `## N.` heading here
  // is a top-level markdown heading and must be unique in the whole document — assert that
  // BEFORE slicing, not merely trust it. (`assertOccursOnce` is the module-level helper above.)

  describe("step 3 files out-of-scope findings as Unplanned, never Todo (Locked 14)", () => {
    // PCO-366 (R3) restored "## 4." and "## 5." between §3 and §6 — this slice now also
    // covers their content, which is fine: the assertions below key on Unplanned/Todo
    // content, neither of which §4/§5 introduce.
    function step3(): string {
      return slice("## 3.", "## 6.");
    }

    test("names Unplanned as the sub-issue status", () => {
      expect(step3()).toContain("status `Unplanned`");
    });

    test("no longer instructs status Todo", () => {
      const s3 = step3();
      // Positive marker present first (vacuous-assertion guard) — Unplanned is asserted above
      // too, but re-asserted here so this test fails independently of the one above if someone
      // deletes only this test's premise.
      expect(s3).toContain("Unplanned");
      expect(s3).not.toContain("status `Todo`");
    });
  });

  describe("step 1's blocker rule carries its three clauses (Locked 9)", () => {
    function step1(): string {
      return slice("## 1.", "## 2.");
    }

    test("clause 1: Done / Rolled Out", () => {
      expect(step1()).toContain("`Done` / `Rolled Out`");
    });

    test("clause 2: children all Done", () => {
      const s1 = step1();
      expect(s1).toContain("has children");
      expect(s1).toContain("non-`Unplanned` children are `Done`");
    });

    test("clause 3: re-sort and continue for an in-snapshot blocker not yet in stories_done", () => {
      const s1 = step1();
      // Pinned as ONE phrase: a bare toContain("stories_done") is satisfied by unrelated
      // prose elsewhere in this slice, so deleting the conjunct used to stay green.
      expect(s1).toContain(
        "the **unsatisfied** blocker is **itself a member of this snapshot** and not yet in `stories_done`",
      );
      expect(s1).toContain("**Re-sort and continue**");
    });

    // Critical 4 (fix pass): clause 3 sat inside the "satisfies the gate" list, reading as
    // fail-open. Its outcome must be unambiguous: re-pick, never "blocker cleared, proceed".
    test("Critical 4: clause 3's outcome is explicitly marked re-pick, not a clearance", () => {
      const s1 = step1();
      expect(s1).toContain("**(re-pick, not a clearance)**");
      expect(s1).toContain("re-pick, never proceed");
    });

    test("Critical 4: clause 3 persists the re-sorted order and order_rationale before re-picking", () => {
      const s1 = step1();
      expect(s1).toContain("re-sort the snapshot, **persist** the new order and `order_rationale` to the state file");
    });

    test("Critical 4: clause 3 has a terminator that halts rather than livelocking when the re-sort doesn't change the pick", () => {
      const s1 = step1();
      expect(s1).toContain("**Terminator:**");
      expect(s1).toContain(
        "**halt and notify** if any story is picked twice within this step — not merely if the re-sort leaves the pick unchanged",
      );
      expect(s1).toContain("in full, including its cycle check");
    });

    // Important 8 (fix pass): clause 3's snapshot-membership test was unspecified — a partial,
    // prefix, or case-insensitive match must not count as membership.
    test("Important 8: clause 3 membership is exact, case-sensitive equality against snapshot[], never partial/prefix/case-insensitive", () => {
      const s1 = step1();
      expect(s1).toContain("exact, case-sensitive equality");
      expect(s1).toContain("`snapshot[]` array");
      expect(s1).toContain("is **not** membership");
    });

    // Important 9.1 (fix pass): the fail-closed default was completely unpinned — deleting the
    // whole sentence left the suite green. Pin it as ONE contiguous sentence, not separate
    // token checks.
    test("Important 9.1: the fail-closed default sentence is pinned in full, not merely its tokens", () => {
      const s1 = step1();
      expect(s1).toContain(
        "Otherwise **halt and notify**. Never proceed past a blocker with `Todo` or `In Progress` children.",
      );
    });

    // Important 6 (fix pass): "A blocker outside the snapshot always halts" used to live
    // inside the (now-deleted) exception paragraph, scoped to that exception. It now sits
    // right after the general "Otherwise halt and notify", where the plain reading is an
    // absolute rule contradicting clauses 1-3. Fixed wording: "unsatisfied" + explicit
    // "clause 3 never applies to it".
    test("Important 6: only an UNSATISFIED blocker outside the snapshot always halts — the sentence no longer reads as absolute", () => {
      const s1 = step1();
      expect(s1).toContain(
        "An **unsatisfied** blocker **outside** the snapshot always halts — clause 3 never applies to it",
      );
    });

    // Minor (the one deletion in this fix pass): the clause-4 blockquote duplicated the
    // <TEAM>-C/<TEAM>-B anecdote already at step 0 AND disagreed with it (counterfactual there,
    // history here). Deleted, not reworded — the clause-2 blockquote survives untouched.
    test("Minor: the duplicate/disagreeing clause-4 blockquote anecdote is deleted", () => {
      const s1 = step1();
      expect(s1).not.toContain("Clause 3 is the fix for a real false halt");
      // Clause-2's blockquote must still be present — this is a deletion of ONE blockquote,
      // not both.
      expect(s1).toContain("Clause 2 exists because a real run hit a blocker sitting in");
    });
  });

  describe("step 0 records the Locked-11 both-sources dependency rule", () => {
    function step0(): string {
      return slice("## 0.", "## 1.");
    }

    test("reads both Linear relations and each member's Dependencies prose", () => {
      const s0 = step0();
      expect(s0).toContain("blockedBy");
      expect(s0).toContain("## Dependencies");
    });

    test("an empty relation set is not evidence of independence, and unestablishable dependency info halts", () => {
      const s0 = step0();
      expect(s0.toLowerCase()).toContain("not evidence of independence");
      expect(s0).toContain("If dependency information cannot be established for a snapshot member from either source, **halt and notify**");
    });

    test("the pre-existing cycle-halt sentence still survives adjacent to the new rule", () => {
      const s0 = step0();
      expect(s0).toContain("relations");
      expect(s0).toContain("contain a cycle, halt and notify");
    });

    // Important 7 (fix pass): Locked 11 said "no edges returned" != "no edges exist" but never
    // said what a member with NEITHER a blockedBy relation NOR a ## Dependencies section means
    // — the natural (wrong) reading is "both silent, therefore independent". Require a
    // positive artifact instead: independence must be STATED, not inferred from silence.
    test("Important 7: a member with no ## Dependencies section at all halts — independence must be stated, not inferred", () => {
      const s0 = step0();
      expect(s0).toContain("Independence must be **stated**, not");
      expect(s0).toContain("`## Dependencies` section at all halts");
    });

    test("Important 7: a member whose relation query ERRORED (not merely returned empty) halts too", () => {
      const s0 = step0();
      expect(s0).toContain("relation query **errored** halts");
    });

    // Round-2 security review: the rule originally called an errored query "indistinguishable"
    // from a genuine empty result IN THE SAME SENTENCE that made erroring the halt condition —
    // an unevaluatable premise, whose only available reading ("empty, therefore returned,
    // therefore independent") is the exact fail-open Locked 11 exists to close. The
    // discriminator must be observable, and recorded.
    test("Locked 11's halt is evaluatable: the discriminator is the tool result itself, and it is recorded", () => {
      const s0 = step0();
      expect(s0).toContain("Distinguish the two by the **tool result itself**, not by its contents");
      expect(s0).toContain("a call that returned a result object — even one carrying an empty relation list — is a positive artifact");
      expect(s0).toContain("Record which");
      expect(s0).toContain("An unrecordable premise is not a gate.");
      expect(s0).not.toContain("indistinguishable");
    });

    // Round-2 code review (I1): step 0's halt collided with step 3's own sub-issue template —
    // a found-in-review issue carries no `## Dependencies` section, so once a human triages it
    // Unplanned -> Todo it becomes a snapshot member that halts the NEXT run. Two-sided fix:
    // scope the halt to multi-member snapshots, and make step 3 emit the section.
    test("I1: the missing-section halt is scoped to multi-member snapshots, so a leaf run does not halt on it", () => {
      const s0 = step0();
      expect(s0).toContain("This halt applies to a **multi-member** snapshot");
      expect(s0).toContain('A single-member snapshot (`"invoked_as": "leaf"`) has no ordering to establish and does not');
    });

    test("I1: step 3 emits a ## Dependencies section on every sub-issue it files", () => {
      const s3 = slice("## 3.", "## 6.");
      expect(s3).toContain("**Give every filed sub-issue a `## Dependencies` section**");
      expect(s3).toContain("Step 0 halts on a snapshot member that carries no such section");
    });
  });

  // PCO-365 (R2): §0 tells the runbook to CREATE the state file in this exact shape — left
  // out of sync with `parseRunState`'s pinned schema, the runbook would create a file
  // `parseRunState` refuses on its very next read. Extracted (never JSON.parse'd — the block
  // is not valid JSON: it carries placeholder values, a `|` enum, and an inline comment) and
  // compared against the exported `REQUIRED_KEYS` set so doc and parser can never drift again.
  describe("step 0's state-file schema JSON block matches run-state.ts's REQUIRED_KEYS exactly", () => {
    // `slice()` collapses all whitespace to single spaces (see its own comment above) — fine
    // for prose containment checks, but it destroys the line structure this test needs to
    // find top-level (two-space-indented) keys without descending into `resolved_config`'s
    // nested shape. Reads the RAW doc text directly instead.
    test("declares exactly REQUIRED_KEYS — no more, no fewer — and never the legacy `merged` key", () => {
      assertOccursOnce("## 0.");
      assertOccursOnce("## 1.");
      const txt = shipDoc();
      const start = txt.indexOf("## 0.");
      const end = txt.indexOf("## 1.", start);
      const s0Raw = txt.slice(start, end);
      const codeBlock = s0Raw.match(/```\n\{[\s\S]*?\n\}\n```/);
      expect(codeBlock, "no fenced JSON schema block found in §0").not.toBeNull();
      const topLevelKeys = [...codeBlock![0].matchAll(/^ {2}"(\w+)":/gm)].map((m) => m[1]!);
      expect(new Set(topLevelKeys)).toEqual(new Set(REQUIRED_KEYS));
      expect(topLevelKeys).not.toContain("merged");
      expect(topLevelKeys).toContain("stack");
    });
  });
});

// PCO-352 (S7), Locked 4: the blocker gate stays PROSE. No `scripts/lib/` module implementing
// it (or the topological sort) may be added by this story — anywhere under `scripts/`.
//
// scripts/lib/ modules are split by provenance:
//   - PRE_EXISTING (predate this epic; the KB CLI): store.ts, schema.ts, fts.ts, migrate.ts
//   - EPIC_ADDED (added one story at a time): ship-config.ts, run-state.ts, kb-sync.ts
// PCO-364 (R1) removed coderabbit.ts and merge-guard.ts from EPIC_ADDED — deleted, not left
// dormant (Locked E), along with the merge path and CodeRabbit gating they implemented. Never
// asserting `length === N`: a literal count would be wrong again the moment any future story
// adds or removes a module — this test instead asserts every module actually on disk is a
// member of the UNION of the two sets above (readdirSync, never a hardcoded snapshot list),
// and separately confirms no blocker-gate/topo-sort-shaped module exists anywhere.
describe("PCO-352 S7 Locked 4: no blocker-gate/topo-sort module is added; scripts/lib/ stays within its known set", () => {
  const PRE_EXISTING = new Set(["store.ts", "schema.ts", "fts.ts", "migrate.ts"]);
  const EPIC_ADDED = new Set(["ship-config.ts", "run-state.ts", "kb-sync.ts", "stack.ts"]);

  function libModules(): string[] {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    return readdirSync(join(root, "scripts/lib"))
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  }

  test("every non-test .ts module in scripts/lib/ is pre-existing or one of the epic-added modules", () => {
    const modules = libModules();
    expect(modules.length).toBeGreaterThan(0);
    for (const m of modules) {
      expect(PRE_EXISTING.has(m) || EPIC_ADDED.has(m), `unexpected module scripts/lib/${m} — not in the known set`).toBe(true);
    }
  });

  test("every epic-added module present on disk has a co-located test file", () => {
    const { existsSync } = require("node:fs") as typeof import("node:fs");
    const modules = new Set(libModules());
    for (const m of EPIC_ADDED) {
      if (!modules.has(m)) continue; // defensive: every EPIC_ADDED module is on disk as of PCO-353 (S8), but the loop tolerates a future one still being absent mid-epic
      const testFile = m.replace(/\.ts$/, ".test.ts");
      expect(existsSync(join(root, "scripts/lib", testFile)), `missing ${testFile} for scripts/lib/${m}`).toBe(true);
    }
  });

  test("no blocker-gate or topo-sort module exists anywhere under scripts/ (Locked 4)", () => {
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs");
    const offenders: string[] = [];
    const shapeRe = /blocker|topo/i;
    function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        const p = join(dir, entry);
        const st = statSync(p);
        if (st.isDirectory()) {
          walk(p);
        } else if (shapeRe.test(entry)) {
          offenders.push(p);
        }
      }
    }
    walk(join(root, "scripts"));
    expect(offenders).toEqual([]);
  });
});

// PCO-364 (R1): the story's own acceptance criteria — the merge path and CodeRabbit gating
// must be demolished, not merely made unreachable. Two independent whole-tree scans, not a
// hardcoded file list (a hardcoded list only ever proves the FILES IT NAMES are clean, never
// that nothing new reintroduced the pattern elsewhere).
//
// Scoped to `git ls-files` (every file actually TRACKED by this repo) rather than a raw
// filesystem walk: this sandbox carries local, gitignored artifacts under `.drawbar/memory/`
// (a derived `index.db`, and an on-demand `knowledge.archive.jsonl`) that vary by machine and
// are not part of the shipped repo at all — a raw `readdirSync` walk would scan them anyway
// and make this test's outcome depend on incidental local state. `git ls-files` also means
// `.git/` and `node_modules/` (the two directories the story names to skip) are excluded for
// free — git never tracks either.
describe("PCO-364 R1: the merge path and CodeRabbit gating are gone from the repo", () => {
  function trackedFiles(): string[] {
    const proc = Bun.spawnSync(["git", "ls-files"], { cwd: root });
    expect(proc.exitCode, `git ls-files failed: ${proc.stderr.toString()}`).toBe(0);
    return proc.stdout
      .toString()
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((rel) => join(root, rel));
  }

  // `git ls-files` reflects the INDEX, not the working tree — an ordinary `git reset`, a
  // fresh checkout, or a partial stage leaves it naming paths that no longer exist on disk.
  // A tracked-but-deleted path has no content and so cannot carry the pattern being scanned
  // for; skip it deliberately here rather than let `readFileSync` throw. Returns only the
  // files actually read, so a caller can assert on how many were scanned — a scan that skips
  // nearly everything and finds zero offenders is not a verdict.
  function scan(files: string[]): { path: string; text: string }[] {
    const out: { path: string; text: string }[] = [];
    for (const file of files) {
      if (!existsSync(file)) continue; // tracked in the index, absent from the working tree
      out.push({ path: file, text: readFileSync(file, "utf8") });
    }
    return out;
  }

  // Fails loudly if a prefix filter or the `file.slice(root.length + 1)` path arithmetic
  // collapses the scanned set to near-nothing — zero offenders out of a handful of files
  // scanned proves nothing about whether the pattern is actually gone.
  function assertScannedMeaningfully(scanned: { path: string }[], label: string, minimum: number): void {
    expect(
      scanned.length,
      `${label}: only ${scanned.length} files scanned — filter or path arithmetic likely broken`,
    ).toBeGreaterThan(minimum);
  }

  // The one deliberate, named exclusion for BOTH scans below: a dated historical design
  // record that legitimately names `gh pr merge`, `merge-guard.ts`, and `coderabbit.ts` as
  // the things being deleted by this very story — excluded by exact path, never a broad
  // `docs/**` glob (which would also swallow a genuine future reintroduction under `docs/`).
  const DESIGN_SPEC = join(root, "docs/superpowers/specs/2026-07-29-stacked-pr-redesign-design.md");

  // Second deliberate, named exclusion: the knowledge base itself. `knowledge.jsonl` is an
  // APPEND-ONLY historical record of past decisions/lessons (superseded, never rewritten —
  // this repo's own KB tooling enforces exactly that discipline), and several committed
  // entries legitimately cite `gh pr merge`/`merge-guard`/`coderabbit` as facts about PCO-351
  // and prior stories. Scrubbing those citations would be rewriting history, not demolition —
  // out of scope for this story. Excluded by directory prefix (not a single exact path) since
  // `knowledge.archive.jsonl` can carry the same superseded history once archived.
  const KB_DIR = join(root, ".drawbar/memory") + "/";

  // IMPORTANT 4a (fix pass): both scans below share this file set — every tracked file minus
  // the two named exclusions and this test file itself. A prior version of scan 2 additionally
  // filtered to `SCAN_PREFIXES = ["commands/","agents/","scripts/","skills/","docs/"]`, which
  // left `README.md` (the most user-facing doc) and every top-level dotfile/manifest
  // unscanned — the AC is "no dangling references in ANY doc". No prefix filter here at all.
  function scannableFiles(): string[] {
    return trackedFiles().filter(
      (file) => file !== DESIGN_SPEC && !file.startsWith(KB_DIR) && file !== join(root, "scripts/plugin.test.ts"),
    );
  }

  // Built from parts, not a literal, so this scanning file's OWN source never contains the
  // needle it is searching for — see MUST-CHECK leak-scan-self-reference-needs-per-rule-file-scope.
  // Matches flexible whitespace and any casing (IMPORTANT 4b: `gh  pr  merge` reformatting or
  // `gh PR merge` previously evaded a literal `.includes("gh pr merge")` check).
  function ghPrMergePattern(): RegExp {
    return new RegExp(["gh", "pr", "merge"].join("\\s+"), "i");
  }

  test("the gh-pr-merge pattern matches reformatted/recased occurrences (Important 4b)", () => {
    const re = ghPrMergePattern();
    expect(re.test("gh pr merge")).toBe(true);
    expect(re.test("gh  pr  merge")).toBe(true);
    expect(re.test("gh PR merge")).toBe(true);
    expect(re.test("gh\tpr\nmerge")).toBe(true);
    expect(re.test("ghpermerge")).toBe(false);
  });

  test("`gh pr merge` appears nowhere in the repo", () => {
    const scanned = scan(scannableFiles());
    assertScannedMeaningfully(scanned, "`gh pr merge` scan", 20);
    const pattern = ghPrMergePattern();
    const offenders = scanned.filter((f) => pattern.test(f.text)).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  test("`merge-guard` and `coderabbit` are not referenced from any doc, agent, or module", () => {
    const NEEDLES = ["merge-guard", "coderabbit"];
    const scanned = scan(scannableFiles());
    assertScannedMeaningfully(scanned, "`merge-guard`/`coderabbit` scan", 20);
    // IMPORTANT 4a regression: proves README.md — unscanned under the old prefix filter — is
    // actually part of this scan now.
    expect(scanned.some((f) => f.path === join(root, "README.md"))).toBe(true);
    const offenders = scanned.filter((f) => NEEDLES.some((n) => f.text.toLowerCase().includes(n))).map((f) => f.path);
    expect(offenders).toEqual([]);
  });

  // PCO-366 (R3): §4's new PR-opening prose is exactly the kind of place `gh pr merge` could
  // sneak back in unnoticed. Same precedent as the README.md membership assertion above:
  // prove the file is actually a member of the scanned set, so a future exclusion-list
  // change can't silently swallow it.
  test("commands/drawbar-ship.md is a member of the gh-pr-merge scanned set", () => {
    const scanned = scan(scannableFiles());
    expect(scanned.some((f) => f.path === join(root, "commands/drawbar-ship.md"))).toBe(true);
  });

  // REGRESSION (Critical 1): `git ls-files` names the index, not the working tree, so an
  // ordinary `git reset` leaves it listing a path gone from disk. Proves `scan()` skips that
  // path instead of letting `readFileSync` throw.
  test("scan() survives a tracked-but-deleted path instead of throwing", () => {
    const realFile = join(root, "package.json");
    const deletedFile = join(root, "scripts/lib/does-not-exist-on-disk.test.ts");
    expect(existsSync(deletedFile)).toBe(false);
    let scanned: { path: string; text: string }[] = [];
    expect(() => {
      scanned = scan([realFile, deletedFile]);
    }).not.toThrow();
    expect(scanned.map((f) => f.path)).toEqual([realFile]);
  });

  // REGRESSION (Critical 2): a filter that collapses the scanned set to near-nothing must
  // fail loudly rather than let a zero-offender scan read as a clean verdict.
  test("assertScannedMeaningfully rejects a collapsed scanned set", () => {
    expect(() => assertScannedMeaningfully([], "test scan", 20)).toThrow();
    expect(() => assertScannedMeaningfully([{ path: "a" }, { path: "b" }], "test scan", 20)).toThrow();
    expect(() => assertScannedMeaningfully(Array(21).fill({ path: "x" }), "test scan", 20)).not.toThrow();
  });

  // The frontmatter `description` and the opening prose are the most-read text in the file —
  // the description is what surfaces in the command listing, where a stale "then merge" is a
  // promise the command no longer keeps. Pinned as claims, not as exact sentences, so R3/R6
  // can still rewrite the wording around them.
  test("the command never advertises itself as merging", () => {
    const txt = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    const frontmatter = txt.slice(0, txt.indexOf("\n---", 4));
    expect(frontmatter).toMatch(/never merges/i);
    expect(frontmatter).not.toMatch(/then merge|merged-but-not-QA/i);
    // Anchor on a line-start heading: a bare "## " also matches the `####` inside the
    // frontmatter's `argument-hint`, which silently truncates this slice to the frontmatter
    // and leaves every assertion below it vacuous.
    const firstHeading = txt.indexOf("\n## ");
    expect(firstHeading, "no line-start '## ' heading found").toBeGreaterThan(0);
    const opening = txt.slice(0, firstHeading);
    expect(opening.length).toBeGreaterThan(500);
    expect(opening).toMatch(/never merges/i);
    expect(opening).not.toMatch(/merged on `main`/);
  });
});

// PCO-365 (R2) IMPORTANT 5: the runbook's own Hard rules used to instruct "Never stack",
// contradicting Locked A (the whole point of scripts/lib/stack.ts). Fails loudly if that
// literal is ever reintroduced anywhere tracked, not just in the one file it was found in.
describe("PCO-365 R2 IMPORTANT 5: 'Never stack' is gone from the runbook's Hard rules", () => {
  test("the string `Never stack` appears nowhere in the repo", () => {
    const proc = Bun.spawnSync(["git", "ls-files"], { cwd: root });
    expect(proc.exitCode, `git ls-files failed: ${proc.stderr.toString()}`).toBe(0);
    const files = proc.stdout
      .toString()
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && l !== "scripts/plugin.test.ts")
      .map((rel) => join(root, rel));
    let scanned = 0;
    const offenders: string[] = [];
    for (const file of files) {
      if (!existsSync(file)) continue; // tracked in the index, absent from the working tree
      const text = readFileSync(file, "utf8");
      scanned++;
      if (text.includes("Never stack")) offenders.push(file);
    }
    expect(scanned, "scan collapsed to near-nothing — filter likely broken").toBeGreaterThan(20);
    expect(offenders).toEqual([]);
  });
});

// PCO-366 (R3): §4/§5 were a documented gap left by R1 (the runbook jumped §3 -> §6). §4
// becomes "open the stacked PR" (delegating base resolution and chain integrity to
// stack.ts, never re-deriving either in bash); §5 becomes "post the summary comment, leave
// In Progress" with no status transition of any kind.
//
// The executable fence that would resolve the base, assert chain integrity, and call `gh pr
// create` is deliberately NOT specified in §4 — see MUST-CHECK
// prose-cannot-hold-an-evidence-protocol-split-the-story and PCO-370 (sequenced with R4 /
// PCO-367). Nothing below pins fenced bash content; every assertion here is a prose pin, plus
// one absence check proving no fence has crept back in.
//
// Every pin below is on a CONTIGUOUS, whitespace-normalized phrase (never independent
// tokens) per MUST-CHECK pco352-fixpass-prose-gate-mutation-must-cover-rephrase-not-only-delete:
// a phrase demoted to a parenthetical aside, or a qualifier weakened, must fail the same test
// a deletion does.
describe("PCO-366 R3: ship §4/§5 — open the stacked PR, leave In Progress, pin the prose", () => {
  // Raw slice (whitespace intact) — the no-bash-fence absence check below needs the literal
  // ``` markers, which whitespace normalization would otherwise leave undisturbed anyway, but
  // keeping this raw keeps the intent explicit.
  function rawSlice(startMarker: string, endMarker: string): string {
    assertOccursOnce(startMarker);
    assertOccursOnce(endMarker);
    const txt = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    const start = txt.indexOf(startMarker);
    expect(start, `'${startMarker}' heading not found`).toBeGreaterThan(-1);
    const end = txt.indexOf(endMarker, start);
    expect(end, `'${endMarker}' heading not found after '${startMarker}'`).toBeGreaterThan(start);
    return txt.slice(start, end);
  }

  // Whitespace-normalized — for prose phrase pins, same discipline as the established
  // `section()` helper elsewhere in this file: markdown hard-wraps prose, so which words
  // land on which line is an editorial accident, never itself worth pinning.
  function normalizedSlice(startMarker: string, endMarker: string): string {
    return rawSlice(startMarker, endMarker).replace(/\s+/g, " ");
  }

  function s4(): string {
    return normalizedSlice("## 4.", "## 5.");
  }
  function s4Raw(): string {
    return rawSlice("## 4.", "## 5.");
  }
  function s5(): string {
    return normalizedSlice("## 5.", "## 6.");
  }

  test("§4 pins the stack.ts delegation and the explicit --base flag as one contiguous phrase", () => {
    expect(s4()).toContain(
      "resolves the base by delegating to `stack.ts` — never re-derived in bash — and " +
        "opens the PR with an explicit `--base <base>` flag",
    );
  });

  test("§4 documents the story-lead's own PR creation as a transitional duplicate removed by R4 (PCO-367)", () => {
    expect(s4()).toContain(
      "That call is a **transitional duplicate**: this step opens the PR that actually " +
        "anchors the stack, and the story-lead's own PR creation is **removed entirely once " +
        "R4 (PCO-367) lands**",
    );
  });

  test("§4 states the flagged field is consumed against the ok | flagged contract R4 (PCO-367) lands", () => {
    expect(s4()).toContain("written against the `ok | flagged` contract R4 (PCO-367) lands");
  });

  test("§4's flagged-PR-body pin: an Unresolved findings section, built before gh pr create runs, never appended after", () => {
    expect(s4()).toContain(
      "the PR body carries an `## Unresolved findings` section, built before `gh pr create` " +
        "runs, never appended after",
    );
  });

  // Fix pass (5c): §3 already files each out-of-scope finding as a Linear sub-issue carrying
  // the full write-up. Republishing file:line / the finding body / a quoted source excerpt in
  // a PUBLIC PR body announces an unpatched detail to every repo watcher before the operator's
  // morning review, so §4 restricts the section to sub-issue ids and titles only.
  test("§4 restricts '## Unresolved findings' to sub-issue ids and titles only, never the finding body/file:line/quoted source", () => {
    expect(s4()).toContain(
      "names each out-of-scope finding by its filed sub-issue id and title only — never the " +
        "finding body, `file:line`, or a quoted source excerpt",
    );
  });

  // MUST-CHECK pco352-fixpass-satisfies-the-gate-header-must-not-cover-a-repick-clause: the
  // "no PR opened" and "PR opened" outcomes differ in KIND, not degree — never one shared
  // "satisfied if any of the following" header.
  test("§4's two outcomes are marked as differing in kind, not filed under one shared header", () => {
    expect(s4()).toContain(
      "These two outcomes differ in kind, not merely in degree — the header below names " +
        "which one you're in; never file this under one shared \"satisfied if any of the " +
        "following\" list.",
    );
  });

  test("§4's 'no PR opened' outcome names the three required checks and is a halt distinct from flagged, with no anchor for the chain", () => {
    expect(s4()).toContain(
      "**Outcome A — no PR could be opened (halt, distinct from flagged).** A refusal at any " +
        "of the three required checks — assert-chain refusing, resolve-base refusing, or " +
        "`gh pr create` itself failing — means the chain has no anchor to stack the next " +
        "story on.",
    );
  });

  // Fix pass (5a): reviewer mutation-proved that replacing Outcome B with "Continue to §5."
  // left the suite green — nothing pinned it at all. Pinned as one contiguous phrase covering
  // the record statement, its {story, branch, pr, base, flagged} shape, and the JSON types
  // run-state.ts's isValidStackEntry actually requires (`pr: number`, `flagged: boolean`),
  // which nothing previously stated in prose.
  test("§4's Outcome B records {story, branch, pr, base, flagged} in the stack array, with pr a JSON number and flagged a JSON boolean", () => {
    expect(s4()).toContain(
      "**Outcome B — the PR opened.** Record `{story, branch, pr, base, flagged}` in the run " +
        "state's `stack` array — `pr` as a JSON number (a positive integer, never the string " +
        "form) and `flagged` as a JSON boolean — then continue to §5.",
    );
  });

  // MUST-CHECK prose-cannot-hold-an-evidence-protocol-split-the-story: the deferred fence's
  // absence must be a WRITTEN reason, not silence, so a future reader does not hand-write a
  // substitute. Deleting the block, or keeping a block that no longer names PCO-370 or the
  // do-not-hand-write instruction, must fail this — it is one contiguous phrase, not
  // independent tokens.
  test("§4 states the executable fence is deliberately not specified, deferred to PCO-370 alongside R4, and forbids hand-writing a substitute", () => {
    expect(s4()).toContain(
      "**Deliberately not specified here: the executable fence.** This section's stacked-PR-" +
        "opening logic — resolving the base, asserting chain integrity, and calling `gh pr " +
        "create` — is deferred to **PCO-370** and must land together with **R4 (PCO-367)**; " +
        "nobody should hand-write a substitute here in the meantime.",
    );
  });

  // Mutation-proof against a trivial fence creeping back in while PCO-370 is still open —
  // re-adding even a one-line ```bash``` fence must fail this.
  test("§4 contains no bash fence at all — the executable PR-opening logic is deferred to PCO-370", () => {
    expect(s4Raw()).not.toMatch(/```/);
  });

  test("§5 pins 'Leave the story In Progress. No status transition of any kind' as one contiguous phrase", () => {
    expect(s5()).toContain("**Leave the story `In Progress`. No status transition of any kind**");
  });

  test("§5 pins the never-a-completed-status prohibition as one contiguous phrase", () => {
    expect(s5()).toContain(
      "never `Done`, `Ready for QA`, `Ready for Rollout`, `Rolled Out`, or any completed-type status",
    );
  });

  // Fix pass (5b): replaces four independent toContain calls — satisfiable, per MUST-CHECK
  // pco352-fixpass-prose-gate-mutation-must-cover-rephrase-not-only-delete, by rewriting §5 to
  // say "Omit the stack position... omit the sub-issues... omit the mutation_pairs" while still
  // matching all four fragments — with one contiguous phrase across the whole enumeration.
  test("§5's comment names what shipped, the PR link, stack position, sub-issues filed, and mutation_pairs as one contiguous phrase", () => {
    expect(s5()).toContain(
      "what shipped, the PR link, the stack position (this story's place in the run's " +
        "stack, e.g. \"position 3 of the run, based on `<BASE>`\"), the sub-issues filed in " +
        "§3, and the story-lead's `mutation_pairs`.",
    );
  });
});

// PCO-367 (R4): the story-lead becomes a function of a base branch that returns a two-state
// verdict. Five changes, each pinned below:
//   1. §2 cuts the story branch from the SUPPLIED base branch, never the repo default —
//      `$BASE_BRANCH` now means "the base this story stacks on", i.e. the previous story's
//      branch for every story after the first.
//   2. §6 opens no pull request at all. The caller's §4 is the only step that may: leaving
//      both would submit the identical head+base pair on the run's first story, GitHub
//      refuses the second with a 422, and the run parks on story 1 every night.
//   3. §7 "Drive it green" is deleted outright, with its CHECKS_FAILED / TIMEOUT parking
//      reasons — an agent that opens no PR has no PR to poll. The report renumbers §8 -> §7.
//   4. The report returns `ok | flagged | parked` and carries the findings that SURVIVED the
//      one fix pass.
//   5. Exactly one bounded fix pass; a second is explicitly prohibited.
//
// Every prose pin below is one CONTIGUOUS, whitespace-normalized phrase, never two
// independent tokens, per MUST-CHECK
// pco352-fixpass-prose-gate-mutation-must-cover-rephrase-not-only-delete: a hard conjunct
// demoted to a parenthetical, or a qualifier weakened, must fail the same test a deletion
// does. Every pin here was mutation-proved by REPHRASING the target, not only deleting it.
//
// Per MUST-CHECK prose-pins-dont-cover-the-bash-fence-they-describe, the base-branch checkout
// is pinned on the literal invocation lines, never on the paragraph beside them.
describe("PCO-367 R4: the story-lead takes a base branch, opens no PR, returns ok | flagged", () => {
  const AGENT = "agents/drawbar-story-lead.md";

  function agentDoc(): string {
    return readNonEmpty(join(root, AGENT));
  }

  // Mirrors the file-level `assertOccursOnce` helper (which is hardcoded to
  // commands/drawbar-ship.md) for the agent doc: a marker occurring more than once makes
  // `indexOf` silently pick the FIRST occurrence, which can truncate or mis-scope a slice
  // without any assertion noticing.
  function rawSection(startMarker: string, endMarker: string | null): string {
    const txt = agentDoc();
    for (const marker of endMarker === null ? [startMarker] : [startMarker, endMarker]) {
      const count = txt.split(marker).length - 1;
      expect(count, `'${marker}' must occur exactly once in ${AGENT}, found ${count}`).toBe(1);
    }
    const start = txt.indexOf(startMarker);
    expect(start, `'${startMarker}' not found in ${AGENT}`).toBeGreaterThan(-1);
    if (endMarker === null) return txt.slice(start);
    const end = txt.indexOf(endMarker, start);
    expect(end, `'${endMarker}' not found after '${startMarker}' in ${AGENT}`).toBeGreaterThan(start);
    return txt.slice(start, end);
  }

  // Whitespace-normalized, per MUST-CHECK doc-grep-assertion-must-normalize-whitespace:
  // markdown hard-wraps prose, so which words land on which line is an editorial accident.
  function section(startMarker: string, endMarker: string | null): string {
    return rawSection(startMarker, endMarker).replace(/\s+/g, " ");
  }

  const received = () => section("## What you receive", "## 1.");
  const s2 = () => section("## 2.", "## 3.");
  const s4 = () => section("## 4.", "## 5.");
  const s5 = () => section("## 5.", "## 6.");
  const s6 = () => section("## 6.", "## 7.");
  const report = () => section("## 7.", null);
  const reportRaw = () => rawSection("## 7.", null);

  // --- Change 1: the story-lead is a function of the base branch it is handed --------------

  // A default-branch RE-PARENT in ANY of the spellings the file's own style would produce:
  // bare, quoted, `-b`-prefixed, or via a remote-tracking ref. A bare /checkout\s+main\b/ was
  // proved vacuous by mutation — `git checkout "main"` (the quoting every other argument in
  // this file uses) walked straight through it.
  //
  // Fix pass (R4 review, Important): the verb alternation is the second half of that lesson.
  // Pinning the token `checkout` pins a spelling, not the act the headline R4 guarantee is
  // about ("cut from the supplied base, never the repo default"). Mutation proved it vacuous
  // a second time: inserting `git -C "$PROJECT_DIR" reset --hard main` immediately above the
  // `checkout -b "$BRANCH"` line — which re-parents every story onto the repo default, the
  // exact failure §2 describes — left all 533 tests green. `prCreationPattern()` below already
  // uses this shape for the two spellings of PR creation; this mirrors it.
  const DEFAULT_BRANCH_REPARENT =
    /(?:checkout|switch|reset\s+--hard|rebase|merge)\s+(?:-b\s+)?["']?(?:origin\/)?(?:main|master)\b/i;

  test("the default-branch re-parent pattern matches every verb and spelling that re-parents a branch", () => {
    for (const spelling of [
      "checkout main",
      'checkout "main"',
      "checkout 'main'",
      "checkout origin/main",
      "checkout master",
      "switch main",
      'switch "main"',
      "reset --hard main",
      'reset --hard "origin/main"',
      "rebase main",
      "rebase origin/master",
      "merge main",
      "MERGE MASTER",
    ]) {
      expect(DEFAULT_BRANCH_REPARENT.test(spelling), `must match: ${spelling}`).toBe(true);
    }
    for (const miss of [
      'checkout "$BASE_BRANCH"',
      "checkout maintenance-branch",
      'rebase "$BASE_BRANCH"',
      'merge "$BASE_BRANCH"',
      "merge mainline-tool",
      "reset --soft main",
    ]) {
      expect(DEFAULT_BRANCH_REPARENT.test(miss), `must not match: ${miss}`).toBe(false);
    }
  });

  // Line-anchored against the RAW section, not the whitespace-normalized one, and requiring the
  // fail-closed guard on the same line. Proved by mutation: a plain `toContain` was satisfied by
  // `# git -C "$PROJECT_DIR" checkout "$BASE_BRANCH"` sitting above a real checkout of something
  // else — the tokens survived inside a comment while the actual invocation was gone.
  test("§2 checks out the supplied base branch and cuts the story branch from it (literal, uncommented invocation lines, guarded fail-closed)", () => {
    const raw = rawSection("## 2.", "## 3.");
    expect(raw).toMatch(/^git -C "\$PROJECT_DIR" checkout "\$BASE_BRANCH" \|\| \{ [^\n]*exit 1; \}$/m);
    expect(raw).toMatch(/^git -C "\$PROJECT_DIR" checkout -b "\$BRANCH"$/m);
    // Bash discipline: guards are `positive || { …; exit 1; }`, never `negative && { … }`.
    expect(raw).not.toMatch(/&&\s*\{/);
  });

  // The whitelist form of the pin above: it is not enough that the right checkout is present,
  // nothing else may be checked out. Catches a default-branch checkout ADDED alongside the
  // correct one, in any spelling, and catches the comment-out mutation from a second angle.
  // Fix pass (R4 review, Important): enumerates every re-parenting VERB, not just `checkout` —
  // `reset --hard`, `rebase` and `merge` re-parent the branch just as thoroughly and were all
  // outside this whitelist.
  test("§2 re-parents onto nothing but $BASE_BRANCH and the new story branch", () => {
    const raw = rawSection("## 2.", "## 3.");
    // Scoped to the EXECUTABLE fence, per MUST-CHECK
    // prose-pins-dont-cover-the-bash-fence-they-describe: §2's prose deliberately names
    // `git checkout .` and `git checkout --detach` as the fail-open spellings the shape gate
    // exists to refuse, and `git checkout -- <file>` as a file revert — illustrations, not
    // instructions. The whole-section absence check below (DEFAULT_BRANCH_REPARENT) still
    // covers the prose for any default-branch ref.
    const fences = [...raw.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
    expect(fences.length, "§2 must carry exactly one bash fence").toBe(1);
    const targets = [
      ...fences[0]!.matchAll(/(?:checkout|switch|reset\s+--hard|rebase|merge)\s+(?:-b\s+)?(\S+)/g),
    ].map((m) => m[1]);
    expect(targets).toEqual(['"$BASE_BRANCH"', '"$BRANCH"']);
  });

  // Fix pass (R4 review, Important): the pull was the one fail-OPEN step in a fence whose whole
  // thesis is fail-closed. Mutation proved the hole from both sides — deleting the
  // `pull --ff-only` line outright left all 533 tests green, and nothing asserted the pull was
  // guarded at all. $BASE_BRANCH is now a story branch the operator may have rebased, so a
  // non-fast-forward is the realistic case, and an ignored one cuts $BRANCH from a stale local
  // base: the silent re-parenting this section exists to prevent.
  test("§2's base-branch pull is guarded fail-closed, like the checkout above it", () => {
    const raw = rawSection("## 2.", "## 3.");
    expect(raw).toMatch(/^git -C "\$PROJECT_DIR" pull --ff-only \|\| \{ [^\n]*exit 1; \}$/m);
  });

  // Fix pass (R4 review, Critical): `git checkout` accepts options and pathspecs, not only
  // branch names, so the `|| { …; exit 1; }` guard on the line below fails OPEN on a
  // $BASE_BRANCH that is not a branch. Verified on git 2.43.0: `git checkout .` reverts the
  // working tree and exits 0; `git checkout --detach` detaches HEAD and exits 0. Either walks
  // through the guard, and `checkout -b "$BRANCH"` then cuts the story branch from whatever
  // HEAD happens to be. The shape gate must therefore run BEFORE anything is checked out —
  // ordering is asserted, not just presence.
  test("§2 fails closed on $BASE_BRANCH's ref shape before anything is checked out", () => {
    const raw = rawSection("## 2.", "## 3.");
    const guard = raw.indexOf('rev-parse --verify --quiet "refs/heads/$BASE_BRANCH"');
    expect(guard, "no refs/heads shape gate on $BASE_BRANCH in §2").toBeGreaterThan(-1);
    expect(
      raw.slice(guard),
      "the shape gate is not chained fail-closed",
    ).toMatch(/^[\s\S]{0,400}?\|\| \{ [^\n]*exit 1; \}/);
    const checkout = raw.indexOf('git -C "$PROJECT_DIR" checkout "$BASE_BRANCH"');
    expect(checkout, "the base-branch checkout must come AFTER the shape gate").toBeGreaterThan(guard);
  });

  test("§2 keeps the imperative that the story branch is cut from nowhere else", () => {
    expect(s2()).toContain(
      "**Check out `$BASE_BRANCH` and cut `$BRANCH` from it.** Never from any other starting point.",
    );
  });

  // Carried-over rules inside the sections R4 rewrote. They are not R4 changes, but a rewrite
  // is exactly when carried-over prose gets quietly softened, and mutation confirmed every one
  // of these could be weakened to "when convenient" with the suite still green.
  test("§2 keeps the commit-each-increment rule and the delegation constraints on the implementer", () => {
    const body = s2();
    expect(body).toContain(
      "**Commit each verified increment before doing anything destructive.**",
    );
    expect(body).toContain(
      "Require it to show the RED run, and tell it not to commit, push, open a pull request, " +
        "or run reviews.",
    );
  });

  test("§2 does not re-parent onto the repo default branch", () => {
    expect(s2()).not.toMatch(DEFAULT_BRANCH_REPARENT);
  });

  test("no default-branch re-parent survives anywhere in the agent file", () => {
    expect(agentDoc()).not.toMatch(DEFAULT_BRANCH_REPARENT);
  });

  test("'What you receive' redefines $BASE_BRANCH as the base this story stacks on, not the repo default", () => {
    expect(received()).toContain(
      "**`$BASE_BRANCH` is the base this story stacks on — for every story after the first " +
        "it is the previous story's branch, and it is NOT the repo's default branch.**",
    );
  });

  // Fix pass (R4 review, Critical): R4 deleted the only statement of $BASE_BRANCH's provenance
  // ("already validated by Preflight to be the repo's actual default") in the same diff that
  // added the first git consumer of it, and replaced it with "for every story after the first
  // it is the previous story's branch" — naming no producer and no validator. The only
  // validated producer is `resolveBase`, gated by `isValidRefName`; the only other place the
  // value lives is the agent-writable run-state `stack[]`, which is exactly the shape
  // MUST-CHECK r3-must-not-source-project-dir-from-pasted-run-state warns about.
  test("'What you receive' pins where $BASE_BRANCH must come from — a fresh resolve-base call, never the run-state file", () => {
    const body = received();
    expect(body).toContain(
      "**`$BASE_BRANCH` must reach you from a fresh `stack.ts resolve-base` call made in the " +
        "dispatching bash block, never lifted out of the run-state file by hand.**",
    );
    expect(body).toContain(
      "`resolve-base` is the only producer that shape-gates the value with `isValidRefName`, " +
        "and the run state it reads is agent-writable",
    );
  });

  test("'What you receive' keeps the cut-from-what-you-are-handed rule and its re-parenting consequence", () => {
    expect(received()).toContain(
      "Cut from whatever you are handed and nothing else: substituting the repo default " +
        "silently re-parents the story, and the pull request your caller opens then carries " +
        "every earlier story's diff too",
    );
  });

  // The frontmatter description is what the dispatcher reads when it picks this agent, and the
  // opening line is what the agent reads first. Proved necessary by mutation: reverting both to
  // their R3 wording ("branch from main … open the PR, drive CI green") left every other pin in
  // this describe green.
  test("the frontmatter description and the opening line state the R4 contract: supplied base, no PR, ok | flagged", () => {
    const fm = agentDoc().match(/^---\n([\s\S]*?)\n---\n/);
    expect(fm, "agent file must open with a YAML frontmatter block").not.toBeNull();
    const desc = fm![1].replace(/\s+/g, " ");
    expect(desc).toContain("branch from the supplied base");
    expect(desc).toContain("Returns a compact structured report carrying an ok | flagged verdict.");
    expect(desc).toContain("Opens no PR, never merges, never touches Linear.");
    expect(desc).not.toMatch(/open the PR|drive CI green|branch from main/i);

    expect(agentDoc().replace(/\s+/g, " ")).toContain(
      "You orchestrate exactly one story, from the base branch you are handed to a pushed " +
        "branch whose tests are verified, mutation-gated, and reviewed.",
    );
  });

  test("the old, now-false 'validated by Preflight to be the repo's actual default' description of $BASE_BRANCH is gone", () => {
    expect(agentDoc()).not.toContain("already validated by Preflight");
    expect(agentDoc()).not.toContain("the repo's\nactual default");
    expect(agentDoc().replace(/\s+/g, " ")).not.toContain("the configured base branch, already validated");
  });

  // --- Change 2: no PR creation anywhere ---------------------------------------------------

  // Built from parts and matched with flexible whitespace / any casing, mirroring
  // `ghPrMergePattern` above: a reflow to `gh  pr  create` or a recased `gh PR create` must
  // not evade this. The `gh api … pulls` alternatives exist because mutation proved a
  // `gh pr create`-only pattern vacuous: the REST spelling of the same act — POSTing to
  // `pulls` — reintroduced PR creation with the whole suite still green.
  function prCreationPattern(): RegExp {
    return new RegExp(
      [
        ["gh", "pr", "create"].join("\\s+"),
        ["gh", "api"].join("\\s+") + "[^\\n]*\\bpulls\\b",
        "--method\\s+POST[^\\n]*\\bpulls\\b",
      ].join("|"),
      "i",
    );
  }

  test("the pr-creation pattern matches reformatted/recased occurrences and the REST spelling", () => {
    const re = prCreationPattern();
    for (const hit of [
      "gh pr create",
      "gh  pr  create",
      "gh PR create",
      "gh\tpr\ncreate",
      'gh api "repos/$REPO/pulls" -f head="$BRANCH"',
      "gh api --method POST pulls",
    ]) {
      expect(re.test(hit), `must match: ${hit}`).toBe(true);
    }
    for (const miss of ["ghprcreate", "gh pr view", "gh api rate_limit"]) {
      expect(re.test(miss), `must not match: ${miss}`).toBe(false);
    }
  });

  test("no pull-request creation — `gh pr create` or the REST equivalent — appears anywhere in the agent file", () => {
    expect(prCreationPattern().test(agentDoc())).toBe(false);
  });

  test("§6 is commit + push only, and says in one contiguous phrase that pushing is where the story-lead's work ends", () => {
    const body = s6();
    expect(body).toContain('git -C "$PROJECT_DIR" push -u origin "$BRANCH"');
    expect(body).toContain(
      "**You open no pull request — pushing the branch is where your work ends.**",
    );
  });

  test("§6 names the concrete duplicate-PR failure (identical head+base pair, 422, run parks on story 1)", () => {
    expect(s6()).toContain(
      "both steps would submit the identical head+base pair on the run's first story, " +
        "GitHub would refuse the second with a 422, and the run would park on story 1 every " +
        "night.",
    );
  });

  // Standing regression guard: no CodeRabbit gating was ever supposed to survive R1, and this
  // rewrite is exactly the kind of edit that could reintroduce a stale reference to it. This
  // already passes — it is here to keep passing.
  test("no CodeRabbit reference survives anywhere in the agent file", () => {
    // Spacing-tolerant: mutation proved `toContain("coderabbit")` blind to "Code Rabbit".
    expect(agentDoc()).not.toMatch(/code\s*rabbit/i);
  });

  test("§6 says the caller's §4 is the ONLY step that may open the pull request", () => {
    expect(s6()).toContain(
      "opens the stacked pull request against the base *it* resolves, and it is the only " +
        "step that may.",
    );
  });

  // --- Change 3: §7 "Drive it green" is gone ----------------------------------------------

  test("the 'Drive it green' section and its CI-polling fence are gone", () => {
    const txt = agentDoc();
    expect(txt).not.toMatch(/drive it green/i);
    // Any CI-polling invocation, not just the one the deleted section happened to use:
    // mutation proved that a `gh run watch` section titled "Get the branch to green" walked
    // through a `gh pr checks`-only pin.
    expect(txt).not.toMatch(/gh\s+(?:pr\s+checks|run\s+(?:watch|list|view))/i);
    expect(txt).not.toMatch(/--watch\b/);
  });

  // Structural companion to the pin above: the section skeleton is fixed, so no section can be
  // interposed, renumbered, retitled, or dropped without failing here. A deleted CI-polling
  // step that comes back under any new name or number lands in this list.
  test("the agent file's section skeleton is exactly the seven R4 sections, in order", () => {
    const headings = [...agentDoc().matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
    expect(headings).toEqual([
      "What you receive",
      "1. Recall",
      "2. Branch and implement",
      "3. Verification gate",
      "4. Mutation gate — tests must actually pin behavior",
      "5. Review, and exactly one fix pass",
      "6. Commit and push",
      "7. Report — your entire final message",
    ]);
  });

  test("neither CHECKS_FAILED nor TIMEOUT survives as a parking reason", () => {
    const txt = agentDoc();
    expect(txt).not.toContain("CHECKS_FAILED");
    expect(txt).not.toContain("TIMEOUT");
  });

  test("the report section is renumbered to §7, and no §8 remains", () => {
    const txt = agentDoc();
    expect(txt).toContain("## 7. Report — your entire final message");
    expect(txt).not.toContain("## 8.");
    // The opening prose must point at the renumbered section, not the deleted §8.
    expect(txt).toContain("Make it the report in §7, nothing else.");
  });

  // --- Change 4: the ok | flagged | parked contract ----------------------------------------

  // Every field is pinned, not just the two the story changed. The cautionary tale this whole
  // describe exists for is a payload silently emptied under a green suite; a schema pin that
  // names only the fields someone remembered to think about is the same hole. Mutation proved
  // `base` (an R4 addition), `parked_reason`, `mutation_pairs` and `summary` were all deletable
  // with zero failures.
  test("the report schema declares `ok | flagged | parked` and carries its full payload", () => {
    const body = report();
    expect(body).toContain('"status": "ok | flagged | parked"');
    expect(body).toContain('"findings": [{"severity": "Critical | Important"');
    expect(body).not.toContain("ready_to_merge");

    expect(body).toContain('"story": "<TEAM>-####"');
    expect(body).toContain('"branch": "<user>/<team>-####-slug"');
    // `base` is the R4 addition: the report must name the branch actually cut from, so a
    // re-parented story is visible to the caller rather than inferred.
    expect(body).toContain('"base": "<the $BASE_BRANCH you cut from>"');
    expect(body).toContain('"parked_reason": null');
    expect(body).toContain('"mutation_pairs": [{"mutation": "...", "failing_test": "..."}]');
    expect(body).toContain('"out_of_scope": [{"title": "..."');
    expect(body).toContain('"lessons": [{"key": "kebab-key"');
    expect(body).toContain('"summary": "two or three sentences"');
  });

  test("`ok` gets its own header naming its defining property — the fix pass closed everything", () => {
    expect(report()).toContain("**`ok` — the fix pass closed everything, and nothing survives.**");
  });

  // Fix pass (R4 review, Important): `flagged` is scoped to surviving IMPORTANTS. A surviving
  // Critical parks instead (§5) — see the Critical-parks pins below.
  test("`flagged` gets its own header, and its downstream outcome (still pushed, caller still opens the PR, findings travel) is one contiguous phrase", () => {
    const body = report();
    expect(body).toContain(
      "**`flagged` — Important findings survived the one fix pass.**",
    );
    expect(body).toContain(
      "The branch is still pushed and your caller still opens the pull request; the " +
        "surviving findings travel in `findings` so your caller can decide how to surface them.",
    );
  });

  // Fix pass (R4 review, Critical): the sentence this replaces read "…so your caller's §4 can
  // write them into the pull request body", which instructs the caller to do the one thing its
  // own pinned rule forbids. commands/drawbar-ship.md §4 restricts `## Unresolved findings` to
  // "each out-of-scope finding by its filed sub-issue id and title only — never the finding
  // body, `file:line`, or a quoted source excerpt" (pinned verbatim earlier in this file),
  // precisely because a public PR body opened before any human review announces an unpatched
  // detail to every repo watcher. `findings[]` entries cannot even use that safe form: ship
  // §3 files sub-issues for `out_of_scope` ONLY, so there is no sub-issue id to name them by.
  // The story-lead therefore states the constraint and leaves the rendering rule to PCO-370.
  test("§7's flagged paragraph no longer authorizes the caller to republish finding bodies in the public pull request", () => {
    const body = report();
    expect(body).not.toContain("can write them into the pull request body");
    expect(body).toContain(
      "**`detail` is for your caller's eyes, not for verbatim republication:** it carries " +
        "`file:line` and the specifics of a defect nobody has patched, the pull request is " +
        "public, and it is opened before any human has reviewed the story.",
    );
  });

  test("`parked` gets its own header and means the story could not be completed at all", () => {
    const body = report();
    expect(body).toContain("**`parked` — the story could not be completed at all.**");
    expect(body).toContain(
      "The verify gate (§3) or the mutation gate (§4) could not be satisfied, or a Critical " +
        "finding survived the one fix pass (§5). There is no branch to stack the next story on",
    );
  });

  // MUST-CHECK pco352-fixpass-satisfies-the-gate-header-must-not-cover-a-repick-clause: `ok`
  // and `flagged` have DIFFERENT downstream outcomes, so they must never sit under one shared
  // "satisfied if any of the following" header. Three independent assertions, because each
  // catches a different mutation:
  //   (a) the prohibition itself, as one contiguous phrase;
  //   (b) STRUCTURAL — each verdict starts its own top-level paragraph, so neither can have
  //       been demoted to a bullet under a shared lead-in;
  //   (c) OCCURRENCE-COUNTED — "any of the following" appears exactly once in the whole file,
  //       and that one occurrence is inside the prohibition. Introducing a real shared header
  //       makes it two and fails here even if (a) and (b) were somehow still satisfied.
  test("the report states the three statuses differ in kind and forbids one shared header, as one contiguous phrase", () => {
    expect(report()).toContain(
      "The three statuses differ in kind, not in degree, and each gets its own header " +
        'below. Never collapse them into one shared "satisfied if any of the following" list',
    );
  });

  test("`ok` and `flagged` each start their own top-level paragraph — neither is a bullet under a shared lead-in", () => {
    const raw = reportRaw();
    expect(raw).toContain("\n\n**`ok` —");
    expect(raw).toContain("\n\n**`flagged` —");
    expect(raw).not.toMatch(/^\s*[-*]\s*\*\*`ok`/m);
    expect(raw).not.toMatch(/^\s*[-*]\s*\*\*`flagged`/m);
  });

  test("'any of the following' occurs exactly once in the agent file, and only inside the prohibition", () => {
    const txt = agentDoc().replace(/\s+/g, " ");
    const occurrences = txt.split("any of the following").length - 1;
    expect(
      occurrences,
      "a second 'any of the following' means a real shared header was introduced",
    ).toBe(1);
    expect(txt).toContain('Never collapse them into one shared "satisfied if any of the following" list');
  });

  // --- Change 5: exactly one fix pass, second round prohibited -----------------------------

  test("§5 pins 'exactly one fix pass, Critical and Important only' as one contiguous phrase", () => {
    expect(s5()).toContain(
      "**Exactly one fix pass runs, and it carries Critical and Important findings only.**",
    );
  });

  // Fix pass (R4 review, Important): the surviving-finding consequence is now SEVERITY-SPLIT.
  // The prior §5 read "Loop until both come back clean", which is what kept an unfixed
  // Critical out of a pushed branch and an open PR; the one-pass cap removed that control, and
  // its replacement must be fail-CLOSED for the severity that was being gated (MUST-CHECK
  // repo-anchor-guard-is-what-gates-an-unfixed-vulnerability), not allow-all.
  test("§5 states the second-fix-pass prohibition as its own sentence, with the severity-split consequence attached", () => {
    const body = s5();
    expect(body).toContain("**A second fix pass is prohibited.**");
    expect(body).toContain(
      "Findings that survive the first one do not earn another attempt: they travel in the " +
        "report's `findings` array, where your caller picks them up — a surviving Important " +
        "sets `status: flagged`, a surviving Critical sets `status: parked`.",
    );
    // The paragraph's closing sentence is the one that removes the agent's discretion, and it
    // was the unpinned end of the paragraph: mutation swapped it for "If a Critical finding
    // survives, run one more fix pass rather than flagging" — a clean inversion of the rule,
    // suite still green — because the two assertions above sit earlier in the same paragraph.
    expect(body).toContain(
      "Re-dispatching the reviewers for a second round is not a judgment call you get to make.",
    );
    // And no later sentence may hand it back: an escape hatch APPENDED to the paragraph leaves
    // every contiguous-phrase pin above satisfied.
    expect(body).not.toMatch(/\b(run|dispatch|allow)\b[^.]{0,80}\b(a second|another|one more)\b[^.]{0,40}\b(pass|round)\b(?![^.]{0,40}\bnot\b)/i);
  });

  // Fix pass (R4 review, Important): the one-pass cap, as shipped, let a Critical the single
  // pass failed to close reach a pushed branch and an open public PR — and every later story
  // stacks on that branch (ship.md Hard rules: base is "the previous story's recorded
  // branch"), so the defect is inherited by the whole chain and reaches the operator as a
  // merge-ready stack. `parked` is the fail-closed replacement: ship.md's *Parking a story*
  // halts the run rather than stacking on it.
  test("§5 parks a surviving Critical instead of flagging it — the one-pass cap never ships an unpatched Critical", () => {
    const body = s5();
    expect(body).toContain("**A surviving Critical parks the story — it is never `flagged`.**");
    expect(body).toContain(
      "Do not push, and leave your caller no pull request to open: set `status: parked` with " +
        "`parked_reason` naming the surviving Critical, and carry the finding in `findings`.",
    );
    // The reason the bound is safe to keep — pinned so a later edit cannot quietly re-file a
    // Critical under `flagged` while leaving the header above intact.
    expect(body).toContain(
      "An Important that outlives the one fix pass is a note on an open pull request; a " +
        "Critical is an unpatched defect on a branch every later story would stack on.",
    );
  });

  test("§5 no longer instructs an unbounded loop", () => {
    expect(s5()).not.toContain("Loop until both come back clean");
    expect(s5()).not.toMatch(/loop until/i);
  });

  test("§5 requires Minors to be batched or dropped, and named either way", () => {
    expect(s5()).toContain(
      "Minors are batched into a single follow-up note or dropped outright, and either way " +
        "every Minor is named in your report's `summary`",
    );
  });

  // --- Anti-regression for this very rewrite ------------------------------------------------

  test("the §4 mutation gate survived the rewrite (heading, both enumeration rules, and the mutation_pairs tie-in)", () => {
    const body = s4();
    expect(body).toContain("## 4. Mutation gate — tests must actually pin behavior");
    expect(body).toContain("**Per `Locked` decision:** mutate the source to violate it. A *named* test must fail.");
    expect(body).toContain("mutate **each independently**");
    expect(body).toContain("Record every `mutation → failing test` pair; it goes in your report.");
    expect(body).toContain("If a mutation produces no failure, that is a missing test. Send it back before review.");
  });

  test("the §5 dual review survived the rewrite — both reviewers, in parallel, in one message", () => {
    const body = s5();
    expect(body).toContain(
      "Dispatch **`code-reviewer`** and **`security-reviewer`** in parallel, in one message.",
    );
    expect(body).toContain(
      "Give the code reviewer the acceptance criteria; give the security reviewer `$KB`.",
    );
    // The fix pass's own quality bar, carried over into the rewritten §5.
    expect(body).toContain(
      "require a red→green regression test for any real bug or security finding, then re-run " +
        "§3 and §4 on the fixes",
    );
  });

  test("§7 keeps the no-diffs-no-logs rule that makes the context split work", () => {
    expect(report()).toContain(
      "No diffs, no test logs, no review bodies — your caller must not need them.",
    );
  });

  test("the §3 verification gate survived the rewrite", () => {
    const body = section("## 3.", "## 4.");
    expect(body).toContain("Confirm the RED runs were shown, not claimed.");
    expect(body).toContain("Re-run the covering tests plus typecheck and lint yourself.");
  });

  test("the no-merge / no-Linear-tools boundary at the top survived the rewrite", () => {
    const txt = agentDoc().replace(/\s+/g, " ");
    expect(txt).toContain(
      "**You do not open the pull request, you do not merge, and you do not have Linear tools.**",
    );
    expect(txt).toContain(
      "it is the boundary that keeps a story agent from ever setting a completion status.",
    );
    // The sentence that assigns each of those responsibilities to the caller. Mutation weakened
    // it to "usually opens … generally owns the merge" with everything else still green.
    expect(txt).toContain(
      "Your caller opens the stacked pull request, owns the merge, every Linear write, the " +
        "knowledge-base push, and the burn-down state.",
    );
    expect(txt).toContain("Your final message IS your return value.");
  });

  // Producer/consumer agreement, same shape as the "Important 3" test above: commands/
  // drawbar-ship.md §2 documents what the story-lead hands back, and the agent's §7 is what
  // actually defines it. R4 changed that shape (gained `base` and `findings`, lost `pr`,
  // renumbered §8 → §7) and both files were edited — but nothing pinned the caller's copy, so
  // reverting it to the stale `§8: {status, pr, …}` wording left the suite fully green. The
  // field list is DERIVED from ship.md and checked against the agent, so the two cannot drift
  // in either direction.
  test("commands/drawbar-ship.md documents the story-lead's return shape as its §7, and every field it names exists in that schema", () => {
    const ship = readNonEmpty(join(root, "commands/drawbar-ship.md")).replace(/\s+/g, " ");
    const m = ship.match(/It returns the JSON report in its §(\d+): `\{([^}]*)\}`/);
    expect(m, "ship.md §2 must document the story-lead's return shape").not.toBeNull();

    expect(m![1], "the story-lead's report section is §7 after R4").toBe("7");
    const fields = m![2].split(",").map((f) => f.trim());
    expect(fields).toContain("base");
    expect(fields).toContain("findings");
    expect(fields).toContain("status");
    expect(fields).not.toContain("pr");

    const schema = report();
    for (const field of fields) {
      expect(schema, `ship.md names '${field}', which must exist in the agent's §7 schema`)
        .toContain(`"${field}":`);
    }
    // And the caller must say why `pr` is absent, so nobody "fixes" the omission later.
    expect(ship).toContain("It carries no `pr` — it opens none; §4 below is what opens the PR");
  });

  test("the out_of_scope collection rule survived the rewrite into §5", () => {
    expect(s5()).toContain("Collect them for `out_of_scope` in your report");
    expect(s5()).toContain("Your caller files them in Linear.");
  });
});
