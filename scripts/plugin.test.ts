import { test, expect, describe } from "bun:test";
import { readFileSync, mkdtempSync, writeFileSync, existsSync, mkdirSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseShipConfig, validateShipConfig, isValidRefName, type Runner } from "./lib/ship-config";
import { REQUIRED_KEYS, parseRunState } from "./lib/run-state";

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
  // Starts at the `readlink -f` resolution, not at the `git -C` line: resolving every symlinked
  // component is PART of this guard, not a neighbour of it. A committed directory symlink
  // otherwise defeats the refusal outright — `git -C` chdirs through the link, the absolute
  // pathspec matches nothing in the index, `--error-unmatch` exits 1, and the guard reads "not
  // tracked" for a config the branch under review committed. Extracting from `git -C` alone left
  // that bypass untested (and the standalone runs below would not exercise the resolution at all).
  function extractTrackedConfigGuard(): string {
    const block = preflightBlock();
    const guardStart = block.indexOf('CONFIG_REAL=$(readlink -f "$CONFIG")');
    expect(guardStart, "tracked-config guard's path resolution not found in Preflight").toBeGreaterThan(-1);
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

  // MUST-CHECK config-file-must-not-be-tracked-by-git, the bypass half: a COMMITTED DIRECTORY
  // SYMLINK. The branch under review adds `real/ship.config.json` plus `.drawbar -> real`, so the
  // config IS committed, but `git -C "$(dirname …)"` chdirs through the link and the absolute
  // pathspec matches nothing in the index — `--error-unmatch` exits 1 and the `&& { … } || true`
  // shape reads "not tracked". The planted config's `projectDir` then reaches `--project-dir` and
  // `git -C`, and its `envDir` reaches `git -C … pull --rebase` (a fetch: the `core.sshCommand`
  // execution sink of MUST-CHECK path-from-mutable-state-into-git-C-is-code-execution).
  test("refuses (for real) when the config is committed behind a directory symlink", async () => {
    const dir = initRealGitRepo();
    mkdirSync(join(dir, "real"), { recursive: true });
    writeFileSync(join(dir, "real/ship.config.json"), '{"projectDir":"/attacker"}');
    symlinkSync("real", join(dir, ".drawbar"));
    Bun.spawnSync(["git", "add", "-A"], { cwd: dir });
    Bun.spawnSync(["git", "commit", "-q", "-m", "plant config behind a symlink"], { cwd: dir });
    const cfgPath = join(dir, ".drawbar/ship.config.json");
    const { code, output } = await runScript(`CONFIG='${cfgPath}'\n` + extractTrackedConfigGuard(), {});
    expect(code, `the planted config was accepted: ${output}`).not.toBe(0);
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
    // A single-level dirname of the SYMLINK-RESOLVED config path (`readlink -f "$CONFIG"`), which
    // is what makes the tracked-config guard below ask git about the real path instead of chdiring
    // through a planted directory symlink. Still not a walk-up-to-find-the-repo probe.
    expect(block).toContain('dirname "$CONFIG_REAL"'); // the ONE legitimate reference
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

  // Fix pass 2, Important 3: the producer (this bullet, ship §2) and the consumer must agree on
  // what the brief carries. As shipped, only the consumer side named $BASE_BRANCH — the
  // producer's "brief must carry" list still named just $KB, $PROJECT_DIR, $REPO and the branch
  // name, so a story-lead built from this brief alone had no base to work from and would fail
  // mid-story, after the implementation was already done.
  //
  // PCO-369 (R6): this comment used to name the consumer as "agents/drawbar-story-lead.md, which
  // runs `gh pr create --base "$BASE_BRANCH"` in §6" — false since R4. The story-lead opens no
  // PR at all; its §6 is commit-and-push, and $BASE_BRANCH is consumed by §2's checkout of the
  // base it was handed. The agreement this test enforces is unchanged; only the description of
  // where the value lands was stale.
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
// PCO-370 (R3b) landed §4's executable fence, so three tests that lived here were RETIRED with
// their written reasons — each existed only to hold the gap open, and each is now false:
//
//   - "documents the story-lead's own PR creation as a transitional duplicate removed by R4
//     (PCO-367)" — R4 landed (04b3077). The story-lead opens no PR at all, so there is no
//     duplicate to document and no future removal to promise.
//   - "states the executable fence is deliberately not specified, deferred to PCO-370
//     alongside R4, and forbids hand-writing a substitute" — the fence IS specified now, and
//     both blockers that paragraph named ("the story-lead currently cuts every branch from
//     `main`", "the story-lead still opens its own PR") no longer exist.
//   - "§4 contains no bash fence at all" — the absence check whose whole purpose was to keep a
//     substitute from creeping in before PCO-370. Its inverse (exactly ONE fence, whose every
//     load-bearing line is pinned) lives in the PCO-370 describe below.
//
// Everything still pinned here is PROSE. The fence's own pins are in the PCO-370 describe, on
// literal invocation lines extracted from the raw fence, per MUST-CHECK
// prose-pins-dont-cover-the-bash-fence-they-describe.
//
// Every pin below is on a CONTIGUOUS, whitespace-normalized phrase (never independent
// tokens) per MUST-CHECK pco352-fixpass-prose-gate-mutation-must-cover-rephrase-not-only-delete:
// a phrase demoted to a parenthetical aside, or a qualifier weakened, must fail the same test
// a deletion does.
describe("PCO-366 R3: ship §4/§5 — open the stacked PR, leave In Progress, pin the prose", () => {
  // Raw slice (whitespace intact). Every pin in THIS describe normalizes on top of it; the
  // raw form is what the PCO-370 describe below needs for its literal-invocation-line pins.
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
  function s5(): string {
    return normalizedSlice("## 5.", "## 6.");
  }

  test("§4 pins the stack.ts delegation and the explicit --base flag as one contiguous phrase", () => {
    expect(s4()).toContain(
      "resolves the base by delegating to `stack.ts` — never re-derived in bash — and " +
        "opens the PR with an explicit `--base <base>` flag",
    );
  });

  // Replaces the retired "transitional duplicate" pin (see the describe comment above): R4
  // landed, so the claim §4 must now carry is that it is the SOLE opener, with the 422 that
  // makes a second opener unshippable. One contiguous phrase — rewording "only thing in the
  // whole run" to a softer "generally" must fail this exactly as a deletion does.
  test("§4 claims sole ownership of PR creation and names the 422 collision that forbids a second opener", () => {
    expect(s4()).toContain(
      "**This step is the only thing in the whole run that opens a pull request.** The " +
        "story-lead's own §6 pushes its branch and stops there — it opens none. Were both to " +
        "open one, they would submit the identical head+base pair on the run's first story, " +
        "GitHub would refuse the second with a 422",
    );
  });

  test("§4 states the flagged field is consumed against the ok | flagged contract, as a JSON boolean", () => {
    expect(s4()).toContain(
      "`FLAGGED` comes from the story-lead's §7 report `status` field, on the `ok | flagged` " +
        "contract: `flagged` becomes the JSON boolean `true`, `ok` becomes `false`",
    );
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
  //
  // PCO-370 (R3b), finding 13: widened from "each out-of-scope finding" to "each surviving
  // finding". §3 now files a sub-issue for every surviving `findings[]` entry too, which is
  // what makes an id available to render — without that, this rule was unsatisfiable for the
  // very entries a `flagged` story is flagged FOR.
  test("§4 restricts '## Unresolved findings' to sub-issue ids and titles only, never the finding body/file:line/quoted source", () => {
    expect(s4()).toContain(
      "names each surviving finding by its filed sub-issue id and title only — never the " +
        "finding body, `file:line`, or a quoted source excerpt",
    );
  });

  // MUST-CHECK pco352-fixpass-satisfies-the-gate-header-must-not-cover-a-repick-clause: the
  // "no PR opened" and "PR opened" outcomes differ in KIND, not degree — never one shared
  // "satisfied if any of the following" header.
  test("§4's outcomes are marked as differing in kind, not filed under one shared header", () => {
    expect(s4()).toContain(
      "These three outcomes differ in kind, not merely in degree — the header below names " +
        "which one you're in; never file this under one shared \"satisfied if any of the " +
        "following\" list.",
    );
    // Each outcome owns one output prefix, so an operator (or an unattended agent) reading a
    // refusal line can tell which outcome it is in without inferring it.
    expect(s4()).toContain(
      "`NO_PR:` is Outcome A, `PR_UNRECORDED:` is Outcome C, `PR_OPENED:` is Outcome B.",
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
        "form) and `flagged` as a JSON boolean — which is what the fence's `jq --argjson` " +
        "builds and what its closing `assert-chain` re-read proves round-trips, then continue " +
        "to §5.",
    );
  });

  // PCO-370 fix pass, finding "no operator instruction for `the PR is open but recording it
  // failed`": six refusals sat AFTER `gh pr create` succeeded, four of them saying only
  // "refusing." and one prefixed `NO_PR:` while its own text said a PR stays open. Outcome A
  // defines NO_PR as a refusal at one of the three required checks, so an unattended agent at
  // 3am had no rule for this state at all: the story is parked with the wrong reason, the PR is
  // orphaned, and a retry hits the 422 §4's opening paragraph warns about. Pinned as one
  // contiguous phrase so softening it fails exactly as deleting it does.
  test("§4's Outcome C covers 'the PR opened but the run state does not record it', and forbids a retry", () => {
    expect(s4()).toContain(
      "**Outcome C — the PR opened but the run state does not record it (halt).** Every " +
        "refusal after `gh pr create` returns — an unreadable or non-integer PR number, a " +
        "`FLAGGED` that is not a JSON literal, an entry that cannot be built, appended, or " +
        "written, or a round-trip that fails — is prefixed `PR_UNRECORDED:` and leaves a real " +
        "pull request open with nothing in the `stack` array pointing at it. It is not Outcome " +
        "A: no `NO_PR:` line is printed, because a PR exists. Go to *Parking a story*, and make " +
        "`parked_reason` say that the PR is open and unrecorded, with its URL. **Never re-run " +
        "this step for that story**",
    );
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

// PCO-370 (R3b): §4's EXECUTABLE stacked-PR fence. R3 (PCO-366) landed §4's narrative and
// deliberately left the fence out; this describe pins the fence, and with it the fourteen
// review findings that landed alongside it.
//
// Discipline, per MUST-CHECK prose-pins-dont-cover-the-bash-fence-they-describe (as amended):
// every constraint naming a CLI flag or a specific derivation is pinned on the LITERAL
// INVOCATION LINE, extracted from the RAW (non-whitespace-normalized) fence — never on the
// prose beside it, and never as two independent `toContain` tokens that a reworded comment
// alone would satisfy. That vacuous shape is exactly what let a reviewer swap
// `RESOLVED=$(... ship-config.ts validate ...)` for `RESOLVED=$(jq -c ".resolved_config"
// "$STATE")` with the whole suite green. Where a guard can be executed, it is: extracted from
// the shipped doc by its own marker comments and run for real (MUST-CHECK
// verification-harness-must-replicate-full-fixture), never reimplemented here.
describe("PCO-370 R3b: §4's executable stacked-PR fence", () => {
  const SHIP = "commands/drawbar-ship.md";
  const AGENT = "agents/drawbar-story-lead.md";

  function shipDoc(): string {
    return readNonEmpty(join(root, SHIP));
  }

  // MUST-CHECK doc-fence-slice-marker-must-not-appear-in-comments: assert each slice marker
  // occurs EXACTLY once before slicing on it — `assertOccursOnce` is the module-level helper.
  function rawSection(startMarker: string, endMarker: string): string {
    assertOccursOnce(startMarker);
    assertOccursOnce(endMarker);
    const txt = shipDoc();
    const start = txt.indexOf(startMarker);
    const end = txt.indexOf(endMarker, start);
    expect(end, `'${endMarker}' not found after '${startMarker}'`).toBeGreaterThan(start);
    return txt.slice(start, end);
  }

  // MUST-CHECK doc-grep-assertion-must-normalize-whitespace — for PROSE only.
  function section(startMarker: string, endMarker: string): string {
    return rawSection(startMarker, endMarker).replace(/\s+/g, " ");
  }

  // The ONE bash fence in §4, raw. Every pin below keys off this.
  function fence(): string {
    const fences = [...rawSection("## 4.", "## 5.").matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(fences.length, "§4 must carry exactly one bash fence").toBe(1);
    expect(fences[0]!.length, "§4's fence is suspiciously short — did it get gutted?").toBeGreaterThan(2000);
    return fences[0]!;
  }

  // The fence with COMMENT lines removed. Every "must NOT contain" assertion runs against
  // this: §4's comments legitimately name the forbidden constructs in order to forbid them
  // (`never `jq '.resolved_config' "$STATE"``), so an absence check over the raw text would be
  // satisfiable only by deleting the explanation — the opposite of the intent.
  function code(): string {
    return fence()
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");
  }

  // Preflight's own fence — the source of truth §4's re-derived guards are compared AGAINST,
  // so the two can never drift into "similar but not the same". Mirrors the extraction the
  // PCO-348 describe above performs, anchored on the Preflight heading so §4's fence can never
  // be picked up by accident.
  function preflightFence(): string {
    const txt = shipDoc();
    const sectionStart = txt.indexOf("## Preflight (halt on any failure)");
    expect(sectionStart, "Preflight heading not found").toBeGreaterThan(-1);
    const fenceStart = txt.indexOf("```bash", sectionStart);
    const fenceEnd = txt.indexOf("```", fenceStart + 7);
    expect(fenceEnd).toBeGreaterThan(fenceStart);
    return txt.slice(fenceStart + 7, fenceEnd);
  }

  // Exactly one line starting with `prefix`, returned verbatim. "Exactly one" is load-bearing:
  // a SECOND assignment of the same variable further down silently overwrites the pinned one,
  // and a `toContain` on the first would never notice.
  function oneLine(block: string, prefix: string, label: string): string {
    const hits = block.split("\n").filter((l) => l.startsWith(prefix));
    expect(
      hits.length,
      `${label}: expected exactly one line starting with ${JSON.stringify(prefix)}, found ${hits.length}`,
    ).toBe(1);
    return hits[0]!;
  }

  // A marker-bounded guard block, extracted from the shipped doc so it can be RUN. The marker
  // comments in §4 are an intentional test seam, the same one Preflight's
  // `# --- derive from the resolved config` markers are.
  function markedBlock(startMarker: string, endMarker: string): string {
    const f = fence();
    for (const m of [startMarker, endMarker]) {
      const n = f.split(m).length - 1;
      expect(n, `'${m}' must occur exactly once in §4's fence, found ${n}`).toBe(1);
    }
    const start = f.indexOf(startMarker);
    const end = f.indexOf(endMarker, start);
    expect(end, `'${endMarker}' not found after '${startMarker}' in §4's fence`).toBeGreaterThan(start);
    return f.slice(start, end);
  }

  // The CONTENT of one quoted heredoc in §4's fence — i.e. the instruction the agent actually
  // fills in. This text is not a comment, so `code()` keeps it, but nothing pinned it: the
  // `## Unresolved findings` rendering rule could be rewritten to emit `file:line` and the whole
  // suite stayed green, because the only pin on that rule lived in §4's PROSE (MUST-CHECK
  // prose-pins-dont-cover-the-bash-fence-they-describe, applied to a heredoc rather than a
  // command line).
  function heredocBody(sentinel: string): string {
    const f = fence();
    const opener = `<<'${sentinel}'\n`;
    const open = f.indexOf(opener);
    expect(open, `heredoc ${sentinel} is not opened in quoted form`).toBeGreaterThan(-1);
    const start = open + opener.length;
    const end = f.indexOf(`\n${sentinel}\n`, start);
    expect(end, `heredoc ${sentinel} is never terminated`).toBeGreaterThan(start);
    const body = f.slice(start, end);
    expect(body.length, `heredoc ${sentinel} is suspiciously empty`).toBeGreaterThan(30);
    return body;
  }

  async function runScript(script: string, env: Record<string, string> = {}): Promise<{ exitCode: number; output: string }> {
    const proc = Bun.spawn(["bash", "-c", script], {
      env: { PATH: process.env.PATH ?? "", ...env },
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    return { exitCode: await proc.exited, output: out + err };
  }

  // Carries an arbitrary literal into a bash variable without this test file itself becoming
  // the injection vector: a QUOTED heredoc, exactly the mechanism §4's fence uses.
  function assignLiteral(name: string, value: string): string {
    return `${name}=$(cat <<'TEST_LITERAL_SENTINEL'\n${value}\nTEST_LITERAL_SENTINEL\n)`;
  }

  test("§4 carries exactly one bash fence, and it is substantial", () => {
    expect(fence().length).toBeGreaterThan(2000);
  });

  // --- CRITICAL 1: the trust root is a FRESH ship-config.ts validate ------------------------
  //
  // The R3 pin asserted only that the fence CONTAINED the tokens `ship-config.ts` and
  // `validate` as two independent substrings — satisfiable by a comment. Pinned on the literal
  // invocation line instead, and cross-derived from Preflight's own line so the two cannot
  // drift into two different "fresh validates".
  test("CRITICAL 1: $RESOLVED comes from one literal ship-config.ts validate invocation, byte-identical to Preflight's", () => {
    const line = oneLine(fence(), "RESOLVED=", "§4's RESOLVED assignment");
    expect(line).toBe(
      'RESOLVED=$(echo "$LINEAR_FACTS_JSON" | bun run "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ship-config.ts" validate --config "$CONFIG") \\',
    );
    // Cross-derived: Preflight's line is the canonical one; §4's must be the same call, not a
    // lookalike. Mutating either side alone fails this.
    expect(line).toBe(oneLine(preflightFence(), "RESOLVED=", "Preflight's RESOLVED assignment"));
  });

  // The NEGATIVE half of Critical 1, and the exact mutation MUST-CHECK
  // r3-must-not-source-project-dir-from-pasted-run-state exists to close: sourcing $RESOLVED
  // (and therefore --project-dir) from the agent-writable run-state file makes stack.ts's
  // equality guard a tautology about the attacker's own directory.
  test("CRITICAL 1: $RESOLVED is never sourced from the run-state file, and --project-dir comes from it", () => {
    const c = code();
    const line = oneLine(fence(), "RESOLVED=", "§4's RESOLVED assignment");
    expect(line).not.toContain("$STATE");
    expect(line).not.toContain("runs/");
    expect(line).not.toContain("resolved_config");
    // Nothing in the executable body reads `resolved_config` at all — that key exists only in
    // the state file, and every legitimate mention of it in §4 is a comment.
    expect(c).not.toContain("resolved_config");
    // PROJECT_DIR is derived from $RESOLVED, and it is what every assert-chain call is anchored
    // on. Both invocations, pinned as literal lines.
    expect(c).toContain(`PROJECT_DIR=$(echo "$RESOLVED" | jq -r '.projectDir // empty')`);
    const chainCalls = c.split("\n").filter((l) => l.includes("stack.ts\" assert-chain"));
    expect(chainCalls.length, "§4 must call assert-chain exactly twice (before, and to round-trip after)").toBe(2);
    for (const call of chainCalls) {
      expect(call).toContain(`--project-dir "$PROJECT_DIR"`);
      expect(call).not.toContain("jq");
    }
  });

  // --- CRITICAL 4: $CONFIG is re-resolved from $PWD, so Preflight's guards run again ---------
  //
  // Byte-identical to Preflight's, derived from Preflight rather than hand-copied here, so
  // "the same guard" is a fact the test establishes instead of a claim a comment makes.
  test("CRITICAL 4: §4 re-runs BOTH of Preflight's $CONFIG guards verbatim", () => {
    const f = fence();
    const pf = preflightFence();
    expect(oneLine(f, 'CONFIG="${DRAWBAR_SHIP_CONFIG', "§4's CONFIG resolution")).toBe(
      oneLine(pf, 'CONFIG="${DRAWBAR_SHIP_CONFIG', "Preflight's CONFIG resolution"),
    );
    expect(oneLine(f, '[ -f "$CONFIG" ]', "§4's config-file-existence guard")).toBe(
      oneLine(pf, '[ -f "$CONFIG" ]', "Preflight's config-file-existence guard"),
    );
    // The symlink resolution the tracked-config guard asks git about is part of the guard: a
    // committed directory symlink otherwise makes `--error-unmatch` exit 1 for a config that IS
    // committed, and the refusal never fires. Pinned as a literal line on BOTH sides, so §4's copy
    // cannot keep the `git -C` line while quietly dropping the resolution it depends on.
    expect(oneLine(f, "CONFIG_REAL=", "§4's config path resolution")).toBe(
      oneLine(pf, "CONFIG_REAL=", "Preflight's config path resolution"),
    );
    expect(oneLine(f, "CONFIG_REAL=", "§4's config path resolution")).toBe(
      `CONFIG_REAL=$(readlink -f "$CONFIG") || { echo "FATAL: cannot resolve $CONFIG to a real path — refusing."; exit 1; }`,
    );
    // …and it runs BEFORE the guard that consumes it.
    expect(f.indexOf("CONFIG_REAL=")).toBeLessThan(f.indexOf("ls-files --error-unmatch"));
    // The tracked-config refusal spans three lines (continuation, refusal, `|| true`).
    const trackedPrefix = 'git -C "$(dirname "$CONFIG_REAL")" ls-files --error-unmatch';
    function trackedGuard(block: string, label: string): string {
      const lines = block.split("\n");
      const start = lines.findIndex((l) => l.startsWith(trackedPrefix));
      expect(start, `${label}: tracked-config guard not found`).toBeGreaterThan(-1);
      const end = lines.findIndex((l, i) => i >= start && l.trim() === "|| true");
      expect(end, `${label}: tracked-config guard's '|| true' not found`).toBeGreaterThan(start);
      return lines.slice(start, end + 1).join("\n");
    }
    expect(trackedGuard(f, "§4")).toBe(trackedGuard(pf, "Preflight"));
    // And the guards run BEFORE the validate whose --config they protect.
    expect(f.indexOf(trackedPrefix)).toBeLessThan(f.indexOf("RESOLVED="));
  });

  // --- CRITICAL 3 / IMPORTANT 6: nothing carries across a Bash tool call --------------------
  //
  // MUST-CHECK cross-fence-shell-state-must-be-rederived-for-every-consumed-var and
  // cross-invocation-guard-applies-per-variable-not-per-fence. A generic detector, not a
  // hand-listed set: every uppercase variable the fence CONSUMES must have been ASSIGNED
  // earlier in the same fence, or be one of the three ambient values the runbook deliberately
  // inherits. This is what closes IMPORTANT 6 ($LINEAR_FACTS_JSON consumed, never bound) for
  // good rather than for one variable.
  const AMBIENT_ALLOWLIST = new Set([
    "CLAUDE_PLUGIN_ROOT", // guarded by the `:?` line at the top of the fence
    "DRAWBAR_SHIP_CONFIG", // the operator's own env override, consumed via `:-` with a default
    "PWD", // shell builtin
    "LC_ALL", // assigned inside the ref-name gate's subshell, never read
  ]);

  function unboundVariables(script: string): string[] {
    const bound = new Set<string>(AMBIENT_ALLOWLIST);
    const unbound: string[] = [];
    for (const line of script.split("\n")) {
      const assignments = [...line.matchAll(/\b([A-Z][A-Z0-9_]*)=/g)].map((m) => ({ name: m[1]!, at: m.index! }));
      for (const ref of line.matchAll(/\$\{?([A-Z][A-Z0-9_]*)/g)) {
        const name = ref[1]!;
        if (bound.has(name)) continue;
        if (assignments.some((a) => a.name === name && a.at < ref.index!)) continue;
        unbound.push(name);
      }
      for (const a of assignments) bound.add(a.name);
    }
    return [...new Set(unbound)];
  }

  test("the unbound-variable detector actually detects (positive control)", () => {
    expect(unboundVariables('echo "$LINEAR_FACTS_JSON"')).toEqual(["LINEAR_FACTS_JSON"]);
    expect(unboundVariables('X=1\necho "$X"')).toEqual([]);
    expect(unboundVariables('Y=$(f); echo "$Y"')).toEqual([]);
    expect(unboundVariables('echo "$Y"; Y=1')).toEqual(["Y"]);
    expect(unboundVariables(': "${CLAUDE_PLUGIN_ROOT:?x}"')).toEqual([]);
    expect(unboundVariables('echo "${REPO}"')).toEqual(["REPO"]);
  });

  test("CRITICAL 3 / IMPORTANT 6: every variable §4's fence consumes is bound earlier in the same fence", () => {
    expect(unboundVariables(code())).toEqual([]);
  });

  // Every literal-invocation pin below is extracted with `oneLine`, which anchors on
  // `startsWith` — so an INDENTED re-assignment inside a block
  // (`if [ -z "$BASE" ]; then BASE=$(git rev-parse …); fi`) silently overwrites the pinned value
  // while every one of those pins still passes. Asserted here once, generically, for the whole
  // derived set: exactly one assignment each, at any indentation.
  test("CRITICAL 1/3 + Locked A: every value §4's fence derives is assigned exactly once, at any indentation", () => {
    const c = code();
    const DERIVED = [
      "ARG", "STORY", "BRANCH", "FLAGGED", "LINEAR_FACTS_JSON",
      "IN_DIR", "INPUTS", "BRANCH_FILE", "PR_TITLE_FILE", "PR_BODY_FILE",
      "CONFIG", "CONFIG_REAL", "RESOLVED", "ENV_DIR", "PROJECT_DIR", "REPO", "STATE",
      "CHAIN_JSON", "CHAIN_OK", "CHAIN_REASON",
      "BASE_JSON", "BASE", "BASE_REASON",
      "PR_URL", "PR", "ENTRY", "NEXT_STATE",
      "VERIFY_JSON", "VERIFY_OK", "VERIFY_REASON",
    ];
    for (const name of DERIVED) {
      const hits = [...c.matchAll(new RegExp(`(?:^|[\\s;{(])${name}=`, "gm"))];
      expect(hits.length, `${name} must be assigned exactly once in §4's fence, found ${hits.length}`).toBe(1);
    }
  });

  test("CRITICAL 3: the not-empty / not-\"null\" assert loop covers the WHOLE derived set, per variable", () => {
    const derive = markedBlock("# --- derive from the resolved config (§4)", "# --- end derive from the resolved config (§4)");
    const derived = [...derive.matchAll(/^([A-Z][A-Z0-9_]*)=\$\(echo "\$RESOLVED" \| jq -r '\.[A-Za-z]+ \/\/ empty'\)$/gm)].map(
      (m) => m[1]!,
    );
    expect(derived.length, "no `jq -r` derivations from $RESOLVED found").toBeGreaterThan(2);
    const loop = derive.match(/^for v in ([A-Z0-9_ ]+); do$/m);
    expect(loop, "the derive block's assert loop is missing").not.toBeNull();
    expect([...loop![1]!.trim().split(/\s+/)].sort()).toEqual([...derived].sort());
    expect(derive).toContain(
      '[ -n "$val" ] && [ "$val" != "null" ] || { echo "FATAL: $v is empty or null after validation — refusing."; exit 1; }',
    );
  });

  test("CRITICAL 3: the derive block really refuses an empty projectDir (extracted from the doc, run for real)", async () => {
    const derive = markedBlock("# --- derive from the resolved config (§4)", "# --- end derive from the resolved config (§4)");
    const { exitCode, output } = await runScript(
      `RESOLVED='{"envDir":"/tmp/e","projectDir":"","repo":"acme/widgets"}'\n` + derive,
    );
    expect(exitCode).not.toBe(0);
    expect(output).toContain("PROJECT_DIR is empty or null");
  });

  test("CRITICAL 3: the derive block really refuses a repo that arrives as the literal string null", async () => {
    const derive = markedBlock("# --- derive from the resolved config (§4)", "# --- end derive from the resolved config (§4)");
    const { exitCode, output } = await runScript(
      `RESOLVED='{"envDir":"/tmp/e","projectDir":"/tmp/p","repo":null}'\n` + derive,
    );
    expect(exitCode).not.toBe(0);
    expect(output).toContain("REPO is empty or null");
  });

  test("CRITICAL 3: the inputs assert loop covers every value read out of the inputs heredoc", () => {
    const c = code();
    const read = [...c.matchAll(/^([A-Z][A-Z0-9_]*)=\$\(jq -[rc] .*"\$INPUTS"\)$/gm)].map((m) => m[1]!);
    expect(read.length, "no values read out of the inputs heredoc").toBeGreaterThan(3);
    const loop = c.match(/^for v in ([A-Z0-9_ ]+); do$/m);
    expect(loop, "the inputs assert loop is missing").not.toBeNull();
    expect([...loop![1]!.trim().split(/\s+/)].sort()).toEqual([...read].sort());
  });

  // Per-CONJUNCT, not merely per-variable. The derive loop's body was pinned as a literal while
  // the inputs loop's was not, so dropping `&& [ "$val" != "null" ]` from the inputs loop alone
  // survived: a value arriving as the STRING "null" then satisfies the surviving `-n` check and
  // flows on into `--head` / the stack entry. Both loop bodies are pinned here, generically, so
  // a third loop cannot be added without one.
  test('CRITICAL 3: BOTH assert loops keep the not-empty AND not-"null" conjuncts, and refuse by exiting', () => {
    const bodies = [...code().matchAll(/^for v in [A-Z0-9_ ]+; do\n  val="\$\{!v\}"\n  ([^\n]*)$/gm)].map((m) => m[1]!);
    expect(bodies.length, "expected exactly two `for v in …; do` assert loops in §4's fence").toBe(2);
    for (const body of bodies) {
      expect(body, `an assert loop body is not the two-conjunct fail-closed form: ${body}`).toMatch(
        /^\[ -n "\$val" \] && \[ "\$val" != "null" \] \|\| \{ echo "FATAL: [^"]*"; exit 1; \}$/,
      );
    }
  });

  // The two inputs that are TYPE-checked at the source rather than merely asserted non-empty,
  // each pinned as its literal read line. `flagged` reaches `jq --argjson` (where the string
  // "true" would produce a string in the stack entry) and `teams` reaches `ship-config.ts
  // validate`'s `isLinearFacts` contract on stdin. Only `FLAGGED`'s check was pinned before, so
  // relaxing `teams` to a bare `{teams:.teams}` — or widening the accepted type — survived.
  test("CRITICAL 3 / IMPORTANT 6: `flagged` and `teams` are TYPE-checked where they are read", () => {
    const c = code();
    expect(c).toContain(
      `FLAGGED=$(jq -r 'if (.flagged|type)=="boolean" then (.flagged|tostring) else empty end' "$INPUTS")`,
    );
    expect(c).toContain(
      `LINEAR_FACTS_JSON=$(jq -c 'if (.teams|type)=="array" then {teams:.teams} else empty end' "$INPUTS")`,
    );
    // …and the heredoc that supplies them says so, so the agent filling it in cannot satisfy the
    // placeholder with a quoted string and be refused only at runtime.
    expect(heredocBody("DRAWBAR_INPUTS_SENTINEL")).toContain(
      '"flagged": <the report `status`: flagged -> true, ok -> false; a JSON boolean, never a string>',
    );
  });

  // The inputs heredoc is parsed by `jq` before ANY value is read out of it, so a heredoc the
  // agent filled in wrongly halts at one guard instead of yielding five empty reads. Deleting
  // this line, or downgrading its refusal to a warning, both survived before this pin.
  test("CRITICAL 3: the inputs heredoc is proved to be valid JSON before any value is read out of it", () => {
    const c = code();
    const line = oneLine(c, "jq -e . ", "§4's inputs-JSON validity gate");
    expect(line).toBe(
      `jq -e . "$INPUTS" >/dev/null 2>&1 || { echo "FATAL: the inputs heredoc is not valid JSON — refusing."; exit 1; }`,
    );
    expect(c.indexOf(line), "the validity gate must precede the first read out of $INPUTS").toBeLessThan(
      c.indexOf(`ARG=$(jq -r '.arg // empty' "$INPUTS")`),
    );
  });

  // --- CRITICAL 2: report text never reaches a command line ---------------------------------
  test("CRITICAL 2: gh pr create is one literal invocation with --repo/--base/--head and --body-file", () => {
    const line = oneLine(fence(), "PR_URL=", "§4's gh pr create invocation");
    expect(line).toBe(
      'PR_URL=$(gh pr create --repo "$REPO" --base "$BASE" --head "$BRANCH" --title "$(cat "$PR_TITLE_FILE")" --body-file "$PR_BODY_FILE") \\',
    );
    const c = code();
    // `--body` (the inline form) must not exist anywhere: it is the one flag that would take
    // report text as an argv element.
    expect(c).not.toMatch(/--body(?!-file)\b/);
    // …and no title/body/branch text is ever interpolated from a variable into the argv.
    expect(c).not.toMatch(/--title "\$[A-Z]/);
  });

  test("CRITICAL 2: every agent-substituted value arrives through a QUOTED heredoc with a unique sentinel", () => {
    const c = code();
    const sentinels = [
      "DRAWBAR_INPUTS_SENTINEL",
      "DRAWBAR_BRANCH_SENTINEL",
      "DRAWBAR_PR_TITLE_SENTINEL",
      "DRAWBAR_PR_BODY_SENTINEL",
    ];
    expect(new Set(sentinels).size, "sentinels must be distinct").toBe(sentinels.length);
    for (const s of sentinels) {
      // Quoted form only — `<<SENTINEL` and `<<"SENTINEL"` both EXPAND, which is the whole bug.
      expect(c, `${s} must be opened as a quoted heredoc`).toContain(`<<'${s}'`);
      expect(c).not.toContain(`<<${s}`);
      expect(c).not.toContain(`<<"${s}"`);
      // Exactly two occurrences: the opener and the terminator. A third means the sentinel is
      // no longer unique to its own block.
      expect(c.split(s).length - 1, `${s} must occur exactly twice (open + terminate)`).toBe(2);
    }
    expect(c).toMatch(/^cat > "\$INPUTS" <<'DRAWBAR_INPUTS_SENTINEL'$/m);
    expect(c).toMatch(/^cat > "\$BRANCH_FILE" <<'DRAWBAR_BRANCH_SENTINEL'$/m);
    expect(c).toMatch(/^cat > "\$PR_TITLE_FILE" <<'DRAWBAR_PR_TITLE_SENTINEL'$/m);
    expect(c).toMatch(/^cat > "\$PR_BODY_FILE" <<'DRAWBAR_PR_BODY_SENTINEL'$/m);
    // Every one of those files lives under the `mktemp -d` directory, pinned as its own literal
    // line: a fixed, world-guessable path lets a local user pre-plant a symlink at it, and each
    // `cat >` redirect FOLLOWS symlinks — truncating an arbitrary file the operator can write, and
    // substituting the very body the fence then hands to `gh --body-file`. Only the `||` guard's
    // shape was pinned before, so swapping `mktemp -d` for `/tmp/<fixed>` survived.
    expect(oneLine(c, "IN_DIR=", "§4's temp-dir creation")).toBe(
      'IN_DIR=$(mktemp -d) || { echo "FATAL: mktemp -d failed — refusing."; exit 1; }',
    );
    for (const [name, leaf] of [
      ["INPUTS", "inputs.json"],
      ["BRANCH_FILE", "branch"],
      ["PR_TITLE_FILE", "title"],
      ["PR_BODY_FILE", "body"],
    ] as [string, string][]) {
      expect(oneLine(c, `${name}=`, `§4's ${name} path`)).toBe(`${name}="\${IN_DIR}/${leaf}"`);
    }
    // Nothing is assigned by interpolating a placeholder: no `<...>` on the right of an `=`.
    for (const line of c.split("\n")) {
      expect(line, `placeholder interpolated into an assignment: ${line}`).not.toMatch(/^[A-Z][A-Z0-9_]*=["']?</);
    }
  });

  // CRITICAL: a quoted heredoc stops at the first line EQUAL TO ITS TERMINATOR, and the three
  // terminators are fixed literals published in this public repository. A report line reading
  // exactly `DRAWBAR_PR_BODY_SENTINEL` therefore closes the heredoc and everything after it is
  // parsed as shell — arbitrary command execution in an unattended session holding an
  // authenticated `gh`, with the written file left looking correct. §4's safety argument used to
  // be stated unconditionally ("inside a QUOTED heredoc nothing expands and no command runs"),
  // and nothing anywhere required the substituted value to be free of the terminator. A check
  // inside the fence is not a fix: by the time it runs, the injected commands have already run —
  // so the requirement is a HALT the agent performs before substituting, pinned here as one
  // contiguous phrase, and the fence's own comment must not restate the claim unconditionally.
  test("CRITICAL 2: §4 halts on a substituted value that contains a line equal to a heredoc terminator", () => {
    const flat = section("## 4.", "## 5.");
    expect(flat).toContain(
      "**Before you substitute anything, check every value for a line equal to the terminator " +
        "you are pasting it under, and halt the run if you find one** — park the story with that " +
        "as the reason, and never rewrite, escape, or truncate the value to make it fit.",
    );
    expect(flat).toContain(
      "A quoted heredoc protects the value's `\"`, `$` and backticks, but it still ends at the " +
        "first line equal to its terminator, and these terminators are fixed literals published " +
        "in this repository",
    );
    expect(flat).toContain(
      "A check inside the fence cannot save you here: by the time any line of it runs, the " +
        "injected commands have already run.",
    );
    // The fence's own comment carries the same qualification, so the executable block cannot be
    // read as promising unconditional safety on its own.
    expect(fence().replace(/\s+/g, " ")).toContain(
      "The one thing a quoted heredoc does # NOT protect against is a substituted line equal " +
        "to the terminator itself — that closes the # heredoc and the rest is parsed as shell, so " +
        "the halt instruction above this fence is part of # the guarantee, not an aside, and no " +
        "check placed here could replace it.",
    );
  });

  // CRITICAL: JSON KEY injection. `branch` used to be pasted between two `"` inside the
  // hand-assembled inputs document. A `"` in it does not produce invalid JSON that `jq -e .`
  // refuses — it APPENDS keys, and jq resolves duplicate keys last-wins, so any key declared
  // above it (`arg`, which names the state file; `story`, which picks the base) is silently
  // overridden while both shape gates still pass, because they see only the laundered values.
  // A key whitelist is no defence: the injected document has exactly the same key set. So the
  // untrusted value never enters a JSON document at all.
  test("CRITICAL 2: the branch name never enters the inputs JSON document — it has its own heredoc file", () => {
    const c = code();
    const inputs = heredocBody("DRAWBAR_INPUTS_SENTINEL");
    expect(inputs, "`branch` is a key in the hand-assembled JSON document again").not.toContain("branch");
    expect(c).not.toContain(`jq -r '.branch`);
    expect(oneLine(c, "BRANCH=", "§4's BRANCH read")).toBe('BRANCH=$(cat "$BRANCH_FILE")');
    // Every value still inside the document is one the repository under review cannot author, and
    // the comment above the heredoc says so — pinned as one contiguous phrase.
    expect(fence().replace(/\s+/g, " ")).toContain(
      "# `branch` is NOT a key in this document: it derives from the repository under review, " +
        "and a `\"` # in a value pasted between two `\"` here appends keys rather than breaking " +
        "the parse — jq takes # the LAST of a duplicate key, so an injected `\"arg\"`/`\"story\"` " +
        "silently wins and aims $STATE, # assert-chain and resolve-base at a different run. Only " +
        "values the repository under review # cannot author live in here.",
    );
  });

  // Executed, against the doc's OWN read lines: a hostile branch value cannot reach `arg` or
  // `story` any more. The test writes the two files exactly as the agent's heredocs do (a quoted
  // heredoc, so this test file is not itself the injection vector) and then runs the shipped
  // read block verbatim.
  test("CRITICAL 2: a branch value carrying JSON syntax cannot override arg or story (run for real)", async () => {
    const read = markedBlock("# --- read the substituted inputs", "# --- end read the substituted inputs");
    const hostile = 'feature/x", "story": "PCO-111", "arg": "PCO-111';
    const dir = mkdtempSync(join(tmpdir(), "drawbar-inputs-"));
    const script = [
      `INPUTS='${join(dir, "inputs.json")}'`,
      `BRANCH_FILE='${join(dir, "branch")}'`,
      `cat > "$INPUTS" <<'TEST_INPUTS_SENTINEL'`,
      `{ "arg": "PCO-363", "story": "PCO-363", "teams": [{"key":"PCO"}], "flagged": false }`,
      `TEST_INPUTS_SENTINEL`,
      `cat > "$BRANCH_FILE" <<'TEST_BRANCH_SENTINEL'`,
      hostile,
      `TEST_BRANCH_SENTINEL`,
      read,
      `printf 'ARG=%s\\nSTORY=%s\\nBRANCH=%s\\n' "$ARG" "$STORY" "$BRANCH"`,
    ].join("\n");
    const { exitCode, output } = await runScript(script);
    expect(exitCode, `the shipped read block failed: ${output}`).toBe(0);
    expect(output).toContain("ARG=PCO-363\n");
    expect(output).toContain("STORY=PCO-363\n");
    expect(output).toContain(`BRANCH=${hostile}\n`);
    // …and that same value is then refused outright by the ref-name gate, so it never reaches
    // `--head` or the stack entry either.
    const gate = markedBlock("# --- branch ref-name shape gate", "# --- end branch ref-name shape gate");
    const gated = await runScript(assignLiteral("BRANCH", hostile) + "\n" + gate);
    expect(gated.exitCode, "the hostile branch value passed the ref-name gate").not.toBe(0);
  });

  test("CRITICAL 2: $BRANCH is ref-name shape-gated before it reaches --head or the stack entry", () => {
    const f = fence();
    const c = code();
    expect(c).toContain(
      `( LC_ALL=C; [[ "$BRANCH" =~ ^[A-Za-z0-9][/A-Za-z0-9._-]*$ ]] ) || { echo "FATAL: BRANCH is not a valid git ref name — refusing."; exit 1; }`,
    );
    expect(c).toContain(
      `case "$BRANCH" in *..*|*"@{"*|*.lock) echo "FATAL: BRANCH is not a valid git ref name — refusing."; exit 1;; esac`,
    );
    const gateEnd = f.indexOf("# --- end branch ref-name shape gate");
    expect(gateEnd).toBeGreaterThan(-1);
    expect(f.indexOf("gh pr create"), "the ref-name gate must precede gh pr create").toBeGreaterThan(gateEnd);
    expect(f.indexOf("--arg branch"), "the ref-name gate must precede the stack entry").toBeGreaterThan(gateEnd);
  });

  // Differential, executed: the shipped bash gate and ship-config.ts's `isValidRefName` must
  // agree on every case. A gate that merely "looks similar" to REF_NAME_SHAPE is what lets a
  // branch through that `isValidStackEntry` will then reject, bricking the state file after
  // the PR is already open.
  test("CRITICAL 2: the shipped $BRANCH gate agrees with ship-config.ts's isValidRefName, case by case", async () => {
    const gate = markedBlock("# --- branch ref-name shape gate", "# --- end branch ref-name shape gate");
    const CASES = [
      "mike/pco-370-fence",
      "a",
      "a_b",
      "HEAD",
      "feature.x-1",
      "refs/heads/x",
      "-lead",
      "--head",
      "a..b",
      "x.lock",
      "a@{0}",
      "",
      "a b",
      'a" $(id) "b',
      "a;id",
      "a$b",
      "a`id`b",
      "café",
      "a\nb",
    ];
    let accepted = 0;
    for (const value of CASES) {
      const { exitCode } = await runScript(assignLiteral("BRANCH", value) + "\n" + gate);
      const bashAccepts = exitCode === 0;
      expect(bashAccepts, `bash gate vs isValidRefName disagree on ${JSON.stringify(value)}`).toBe(isValidRefName(value));
      if (bashAccepts) accepted++;
    }
    // Not vacuous in either direction: some cases pass, some fail.
    expect(accepted, "every case was refused — the harness is not exercising the accept path").toBeGreaterThan(3);
    expect(accepted).toBeLessThan(CASES.length);
  });

  // MUST-CHECK endpoint-injection-not-just-command-injection: `$ARG` is interpolated into the
  // state-file PATH (`$ENV_DIR/.drawbar/runs/$ARG.json`), so it is gated to a single safe path
  // segment before `$STATE` is built from it. Deleting this gate — and, separately, dropping the
  // `*/*` or the `*..*` branch from it — all survived until this pin.
  test("CRITICAL 2: $ARG is path-segment gated before it is interpolated into the state-file path", () => {
    const c = code();
    expect(oneLine(c, 'case "$ARG" in', "§4's ARG path-segment gate")).toBe(
      `case "$ARG" in ''|*/*|*'\\'*|*..*) echo "FATAL: ARG is not a safe path segment — refusing."; exit 1;; esac`,
    );
    const f = fence();
    expect(
      f.indexOf('STATE="$ENV_DIR'),
      "the ARG gate must precede the state-file path it protects",
    ).toBeGreaterThan(f.indexOf('case "$ARG" in'));
  });

  // Differential, executed, against run-state.ts's own `arg` validation (reached through the
  // exported `parseRunState`, never a hand-copied predicate): a gate that admits a traversal
  // segment writes the run state to a path `parseRunState` then refuses to read back.
  // Whitespace/control-character cases are deliberately absent — `isNonEmptyTrimmed` refuses
  // those upstream of the path-segment shape, and this bash gate does not re-implement that half.
  test("CRITICAL 2: the shipped $ARG gate agrees with parseRunState's arg validation, case by case", async () => {
    const gate = oneLine(code(), 'case "$ARG" in', "§4's ARG path-segment gate");
    const CASES = ["PCO-370", "a", "PCO-363.1", "-x", "", "a/b", "../x", "x/..", "a..b", "..", "a\\b"];
    let accepted = 0;
    for (const value of CASES) {
      const { exitCode } = await runScript(assignLiteral("ARG", value) + "\n" + gate);
      const bashAccepts = exitCode === 0;
      const parsed = parseRunState(JSON.stringify({ ...FIXTURE_RUN_STATE, arg: value }));
      expect(bashAccepts, `ARG gate vs parseRunState disagree on ${JSON.stringify(value)}`).toBe(parsed.ok);
      if (bashAccepts) accepted++;
    }
    // Not vacuous in either direction.
    expect(accepted, "every case was refused — the harness is not exercising the accept path").toBeGreaterThan(2);
    expect(accepted).toBeLessThan(CASES.length);
  });

  // --- Locked A: `resolve-base` is the ONLY producer of $BASE --------------------------------
  //
  // §4's PROSE says the base is "never re-derived in bash", and `gh pr create`'s literal line
  // pins `--base "$BASE"` — but nothing pinned where `$BASE` itself comes from. Re-deriving it
  // from `git symbolic-ref origin/HEAD`, from `git rev-parse --abbrev-ref HEAD`, or from the
  // agent-writable state file all left the suite green while `--base` stayed present: Locked A's
  // exact failure mode (a PR whose diff carries every earlier story's work) with the flag intact.
  test("Locked A: $BASE comes only from resolve-base's verdict, never re-derived in bash or read from the state", () => {
    const c = code();
    expect(oneLine(c, "BASE_JSON=", "§4's resolve-base invocation")).toBe(
      'BASE_JSON=$(bun run "${CLAUDE_PLUGIN_ROOT}/scripts/lib/stack.ts" resolve-base --state "$STATE" --story "$STORY")',
    );
    const line = oneLine(c, "BASE=", "§4's BASE derivation");
    expect(line).toBe(
      `BASE=$(printf '%s' "\${BASE_JSON:-null}" | jq -r 'if (type=="object" and .ok==true) then .base else empty end' 2>/dev/null)`,
    );
    // The verdict is only read on `ok == true`: `.base // empty` alone would accept the `.base`
    // of a REFUSAL payload, which is how a resolve-base failure becomes a silent wrong base.
    expect(line).toContain('.ok==true');
    // Nothing else may produce it.
    expect(line).not.toMatch(/\bgit\b/);
    expect(line).not.toContain("$STATE");
    expect(line).not.toContain("BASE_BRANCH");
    // …and the refusal is fail-closed on both empty and the literal string "null".
    expect(c).toContain(
      `[ -n "$BASE" ] && [ "$BASE" != "null" ] || { BASE_REASON=$(printf '%s' "\${BASE_JSON:-null}" | jq -r '.reason // "unreadable-verdict"' 2>/dev/null); echo "NO_PR: resolve-base refused ($BASE_REASON) — park the story; paraphrase, never paste, the detail on stderr."; exit 1; }`,
    );
    // `resolve-base` runs BEFORE the PR is opened, and `$BASE` reaches nothing but `--base`.
    const f = fence();
    expect(f.indexOf("gh pr create")).toBeGreaterThan(f.indexOf("resolve-base"));
  });

  // --- IMPORTANT 9: the PR body's own rendering instruction ----------------------------------
  //
  // §4's prose restricting `## Unresolved findings` to sub-issue id + title was pinned; the
  // heredoc that actually TELLS the agent what to write was not. Rewriting it to render
  // `file:line` and the finding body left the suite green — the finding-9 disclosure with the
  // prose pin still passing.
  test("IMPORTANT 9: the PR-body heredoc itself restricts '## Unresolved findings' to sub-issue id + title", () => {
    const body = heredocBody("DRAWBAR_PR_BODY_SENTINEL");
    expect(body.replace(/\s+/g, " ")).toContain(
      "On a flagged story it is written out here with its `## Unresolved findings` section " +
        "already in it, listing each surviving finding as `<SUB-ISSUE-ID> — <sub-issue title>` " +
        "and nothing else: never the finding body, never a `file:line`, never a quoted source " +
        "excerpt.",
    );
  });

  // --- IMPORTANT 7: the PR number is a validated positive integer ---------------------------
  test("IMPORTANT 7: the PR number comes from `gh pr view --json number`, digits-gated, never basename", () => {
    const c = code();
    // Every refusal here is AFTER `gh pr create` returned, so each one says the PR is open and
    // names Outcome C — `FATAL: … refusing.` said nothing about the pull request it left behind.
    expect(oneLine(c, "PR=$(", "§4's PR number derivation")).toBe(
      `PR=$(gh pr view "$PR_URL" --repo "$REPO" --json number -q .number) || { echo "PR_UNRECORDED: gh pr create left no readable PR number — the PR is open; park the story with that reason (Outcome C) and repair the run state by hand."; exit 1; }`,
    );
    expect(c).toContain(
      `case "$PR" in ''|*[!0-9]*) echo "PR_UNRECORDED: PR number is not digits-only — the PR is open; park the story with that reason (Outcome C) and repair the run state by hand."; exit 1;; esac`,
    );
    expect(c).toContain(
      `[ "$PR" -gt 0 ] || { echo "PR_UNRECORDED: PR number is not a positive integer — the PR is open; park the story with that reason (Outcome C) and repair the run state by hand."; exit 1; }`,
    );
    expect(c).not.toContain("basename");
  });

  test("IMPORTANT 7: the shipped PR-number gate refuses everything that is not a positive integer (run for real)", async () => {
    // The `gh pr view` line is dropped and $PR supplied directly — the two GUARD lines are what
    // is under test, extracted from the doc rather than restated here.
    const guard = markedBlock("# --- pr number shape gate", "# --- end pr number shape gate")
      .split("\n")
      .filter((l) => !l.startsWith("PR=$("))
      .join("\n");
    expect(guard).toContain("digits-only");
    for (const [value, ok] of [
      ["42", true],
      ["1", true],
      ["0", false],
      ["-1", false],
      ["", false],
      ["1.5", false],
      ["12a", false],
      ["4 2", false],
      ["$(id)", false],
    ] as [string, boolean][]) {
      const { exitCode } = await runScript(assignLiteral("PR", value) + "\n" + guard);
      expect(exitCode === 0, `PR gate verdict wrong for ${JSON.stringify(value)}`).toBe(ok);
    }
  });

  // --- CRITICAL 5: the stack entry round-trips through parseRunState ------------------------
  test("CRITICAL 5: the stack entry is built with --argjson for `pr` and `flagged`, never --arg", () => {
    const line = oneLine(code(), "ENTRY=$(jq -nc", "§4's stack-entry construction");
    expect(line).toContain('--argjson pr "$PR"');
    expect(line).toContain('--argjson flagged "$FLAGGED"');
    expect(line).not.toMatch(/--arg pr\b/);
    expect(line).not.toMatch(/--arg flagged\b/);
    expect(line).toContain("{story:$story,branch:$branch,pr:$pr,base:$base,flagged:$flagged}");
    // `flagged` is type-checked where it is READ, too — a string "true" never gets that far.
    expect(code()).toContain(
      `FLAGGED=$(jq -r 'if (.flagged|type)=="boolean" then (.flagged|tostring) else empty end' "$INPUTS")`,
    );
    // …and re-gated to the two JSON literals immediately before `--argjson` consumes it. Deleting
    // this gate, or widening it to a catch-all `*)`, survived until this pin: `--argjson flagged`
    // with anything else either aborts `jq` mid-run or lands a non-boolean in the state file.
    const c = code();
    expect(c).toContain(
      `case "$FLAGGED" in true|false) ;; *) echo "PR_UNRECORDED: FLAGGED must be the JSON literal true or false — the PR is open; park the story with that reason (Outcome C) and repair the run state by hand."; exit 1;; esac`,
    );
    expect(c.indexOf('case "$FLAGGED" in'), "the FLAGGED literal gate must precede the stack entry").toBeLessThan(
      c.indexOf("ENTRY=$(jq -nc"),
    );
    // …and the APPEND line one line later, which was entirely unpinned: `--argjson entry` ->
    // `--arg entry` puts a JSON *string* into `stack` (permanently unreadable by `parseRunState`,
    // with the PR already open), and `.stack += [$entry]` -> `.stack = [$entry]` silently drops
    // every earlier story from the chain. Both survived a pin that covered only the `ENTRY=` line.
    expect(oneLine(c, "NEXT_STATE=", "§4's run-state append")).toBe(
      `NEXT_STATE=$(jq -c --argjson entry "$ENTRY" '.stack += [$entry]' "$STATE") || { echo "PR_UNRECORDED: could not append the stack entry to the run state — the PR is open; park the story with that reason (Outcome C) and repair the run state by hand."; exit 1; }`,
    );
    expect(oneLine(c, "printf '%s\\n' \"$NEXT_STATE\"", "§4's run-state write")).toBe(
      `printf '%s\\n' "$NEXT_STATE" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE" || { echo "PR_UNRECORDED: could not write the run state — the PR is open; park the story with that reason (Outcome C) and repair the run state by hand."; exit 1; }`,
    );
  });

  // Executed: the shipped stack-entry block really refuses a `FLAGGED` that is not a JSON
  // literal, rather than building an entry `isValidStackEntry` rejects on the next read.
  test("CRITICAL 5: the shipped stack-entry block refuses a non-literal FLAGGED (run for real)", async () => {
    const block = markedBlock("# --- stack entry", "# --- end stack entry");
    for (const [value, ok] of [
      ["true", true],
      ["false", true],
      ["yes", false],
      ["True", false],
      ["", false],
      ["1", false],
      ['"true"', false],
    ] as [string, boolean][]) {
      const script = [
        assignLiteral("STORY", "PCO-370"),
        assignLiteral("BRANCH", "mike/pco-370-fence"),
        assignLiteral("BASE", "main"),
        assignLiteral("PR", "4242"),
        assignLiteral("FLAGGED", value),
        block,
      ].join("\n");
      const { exitCode } = await runScript(script);
      expect(exitCode === 0, `FLAGGED gate verdict wrong for ${JSON.stringify(value)}`).toBe(ok);
    }
  });

  // A `ResolvedConfig`-shaped payload and the pinned run-state schema, the minimum
  // `parseRunState` accepts — so the ONLY thing under test below is the entry the shipped
  // fence builds.
  const FIXTURE_RESOLVED_CONFIG = {
    envDir: "/tmp/env-repo",
    projectDir: "/tmp/project-repo",
    repo: "acme/widgets",
    team: "PCO",
    baseBranch: "main",
    requiredChecks: ["build"],
    observed: { projectDirRemote: "acme/widgets", envDirRemote: "acme/knowledge", defaultBranch: "main" },
  };
  const FIXTURE_RUN_STATE = {
    arg: "PCO-363",
    invoked_as: "parent" as const,
    started_at: "2026-07-29T00:00:00.000Z",
    order_rationale: "fixture",
    snapshot: ["PCO-370"],
    stories_done: [],
    in_flight: null,
    stack: [] as unknown[],
    subissues_filed: [],
    resolved_config: FIXTURE_RESOLVED_CONFIG,
  };

  async function buildEntry(mutate: (block: string) => string = (b) => b): Promise<unknown> {
    const block = mutate(markedBlock("# --- stack entry", "# --- end stack entry"));
    const script = [
      assignLiteral("STORY", "PCO-370"),
      assignLiteral("BRANCH", "mike/pco-370-fence"),
      assignLiteral("BASE", "main"),
      assignLiteral("PR", "4242"),
      assignLiteral("FLAGGED", "true"),
      block,
      `printf '%s' "$ENTRY"`,
    ].join("\n");
    const { exitCode, output } = await runScript(script);
    expect(exitCode, `stack-entry block failed: ${output}`).toBe(0);
    return JSON.parse(output);
  }

  test("CRITICAL 5: the entry the shipped fence builds round-trips through parseRunState", async () => {
    const entry = (await buildEntry()) as Record<string, unknown>;
    expect(typeof entry.pr, "pr must be a JSON number").toBe("number");
    expect(typeof entry.flagged, "flagged must be a JSON boolean").toBe("boolean");
    const parsed = parseRunState(JSON.stringify({ ...FIXTURE_RUN_STATE, stack: [entry] }));
    expect(parsed.ok, parsed.ok ? "" : `parseRunState refused: ${parsed.reason} (${parsed.detail})`).toBe(true);
  });

  // Executed, end to end over the shipped APPEND: build the entry with the doc's own block, then
  // append it to a real state file with the doc's own `NEXT_STATE=` / write lines, and read the
  // result back through `parseRunState`. This is the step the reviewer's e2e run left as
  // `[{…}, "{\"story\":…}"]` — permanently unreadable by its own tooling, with an orphan PR open —
  // because only the `ENTRY=` line was pinned. It also proves `+=` keeps the earlier story.
  test("CRITICAL 5: the shipped append writes a state parseRunState reads back, earlier stack entries intact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drawbar-append-"));
    const statePath = join(dir, "PCO-363.json");
    const earlier = { story: "PCO-369", branch: "mike/pco-369", pr: 41, base: "main", flagged: false };
    writeFileSync(statePath, JSON.stringify({ ...FIXTURE_RUN_STATE, stack: [earlier] }));
    const script = [
      assignLiteral("STORY", "PCO-370"),
      assignLiteral("BRANCH", "mike/pco-370-fence"),
      assignLiteral("BASE", "mike/pco-369"),
      assignLiteral("PR", "4242"),
      assignLiteral("FLAGGED", "true"),
      `STATE='${statePath}'`,
      markedBlock("# --- stack entry", "# --- end stack entry"),
      oneLine(code(), "NEXT_STATE=", "§4's run-state append"),
      oneLine(code(), "printf '%s\\n' \"$NEXT_STATE\"", "§4's run-state write"),
    ].join("\n");
    const { exitCode, output } = await runScript(script);
    expect(exitCode, `the shipped append failed: ${output}`).toBe(0);
    const parsed = parseRunState(readFileSync(statePath, "utf8"));
    expect(parsed.ok, parsed.ok ? "" : `parseRunState refused the appended state: ${parsed.reason}`).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.state.stack).toEqual([earlier, { story: "PCO-370", branch: "mike/pco-370-fence", pr: 4242, base: "mike/pco-369", flagged: true }]);
  });

  // The control that makes the test above mean something: `--arg entry` (a JSON string in the
  // `stack` array) and `.stack = [$entry]` (every earlier story dropped) are exactly what the
  // append must never do — run for real against the same fixture.
  test("CRITICAL 5 control: --arg entry / .stack = [] on the append produce a state parseRunState rejects or a lost chain", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drawbar-append-ctl-"));
    const earlier = { story: "PCO-369", branch: "mike/pco-369", pr: 41, base: "main", flagged: false };
    async function runAppend(mutate: (l: string) => string): Promise<string> {
      const statePath = join(dir, `${Math.random().toString(36).slice(2)}.json`);
      writeFileSync(statePath, JSON.stringify({ ...FIXTURE_RUN_STATE, stack: [earlier] }));
      const script = [
        assignLiteral("STORY", "PCO-370"),
        assignLiteral("BRANCH", "mike/pco-370-fence"),
        assignLiteral("BASE", "mike/pco-369"),
        assignLiteral("PR", "4242"),
        assignLiteral("FLAGGED", "true"),
        `STATE='${statePath}'`,
        markedBlock("# --- stack entry", "# --- end stack entry"),
        mutate(oneLine(code(), "NEXT_STATE=", "§4's run-state append")),
        oneLine(code(), "printf '%s\\n' \"$NEXT_STATE\"", "§4's run-state write"),
      ].join("\n");
      const { exitCode, output } = await runScript(script);
      expect(exitCode, `the mutated append failed to run: ${output}`).toBe(0);
      return readFileSync(statePath, "utf8");
    }
    const asString = parseRunState(await runAppend((l) => l.replace("--argjson entry", "--arg entry")));
    expect(asString.ok).toBe(false);
    if (!asString.ok) expect(asString.reason).toBe("invalid_stack_entry");
    const clobbered = parseRunState(await runAppend((l) => l.replace(".stack += [$entry]", ".stack = [$entry]")));
    expect(clobbered.ok).toBe(true);
    if (clobbered.ok) expect(clobbered.state.stack.length, "the earlier story survived a `.stack =` overwrite").toBe(1);
  });

  // The control that makes the round-trip test above mean something: the natural bash transcription
  // (`--arg`, producing strings) is exactly what `parseRunState` rejects — with EMPTY stdout
  // from stack.ts, so the operator would see only a bare `refused ()`.
  test("CRITICAL 5 control: swapping --argjson for --arg produces a state parseRunState rejects", async () => {
    const entry = (await buildEntry((b) => b.replace(/--argjson pr /, "--arg pr ").replace(/--argjson flagged /, "--arg flagged "))) as Record<
      string,
      unknown
    >;
    expect(typeof entry.pr).toBe("string");
    const parsed = parseRunState(JSON.stringify({ ...FIXTURE_RUN_STATE, stack: [entry] }));
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.reason).toBe("invalid_stack_entry");
  });

  test("CRITICAL 5: the fence re-reads the state through assert-chain AFTER writing it", () => {
    const c = code();
    const writeAt = c.indexOf("NEXT_STATE=");
    expect(writeAt, "the state write is missing").toBeGreaterThan(-1);
    const lastChain = c.lastIndexOf('stack.ts" assert-chain');
    expect(lastChain, "no assert-chain call after the write — nothing proves the entry round-trips").toBeGreaterThan(writeAt);
    expect(c).toMatch(
      /^VERIFY_OK=\$\(printf '%s' "\$\{VERIFY_JSON:-null\}" \| jq -r 'if \(type=="object" and \.ok==true\) then "true" else "false" end' 2>\/dev\/null\)$/m,
    );
  });

  // --- IMPORTANT 8: refusal text is paraphrased, never pasted -------------------------------
  test("IMPORTANT 8: no echo in the fence interpolates a verdict JSON, and `.detail` is never read", () => {
    const c = code();
    const echoes = [...c.matchAll(/echo "[^"]*"/g)].map((m) => m[0]);
    expect(echoes.length, "no echoes found — the extraction is broken").toBeGreaterThan(8);
    // The three VERDICT JSONs are what carry `.detail`, and none of them may reach an echo.
    // Named individually rather than matched as `/_JSON/`: `$LINEAR_FACTS_JSON` is legitimately
    // echoed, because `ship-config.ts validate` reads the Linear facts on STDIN, so a blanket
    // `_JSON` refusal would either fail on that line or have to be softened until it stopped
    // covering the verdicts — which are the whole point of finding 8.
    for (const verdict of ["CHAIN_JSON", "BASE_JSON", "VERIFY_JSON"]) {
      for (const e of echoes) {
        expect(e, `an echo carries the raw ${verdict} verdict: ${e}`).not.toContain(verdict);
      }
    }
    // The one permitted `_JSON` echo is the validator's stdin, and it must STAY a pipe: if it
    // ever becomes operator-facing output the trailing `|` disappears, and that is the mutation
    // this assertion exists to catch.
    const jsonEchoes = echoes.filter((e) => /_JSON/.test(e));
    expect(jsonEchoes, "exactly one echo may carry a JSON payload — the validator's stdin").toEqual([
      'echo "$LINEAR_FACTS_JSON"',
    ]);
    expect(c).toContain('echo "$LINEAR_FACTS_JSON" | bun run');
    // The `echo "…"` extraction above is necessary but NOT sufficient: it misses `printf 'x %s'
    // "$CHAIN_JSON"` entirely, and its `[^"]*` stops at the first inner quote, so
    // `echo "refused ($(printf '%s' "$CHAIN_JSON"))"` slips through as a truncated match. Both
    // mutations survived. So the containment is asserted on the VARIABLE instead of on the output
    // command: every textual reference to a verdict JSON, anywhere in the executable body, must
    // be either its own `X_JSON=$(bun run … stack.ts …)` assignment or a
    // `printf '%s' "${X_JSON:-null}" | jq -r '…' 2>/dev/null` read. Nothing else — no output
    // command, present or future — can reach one.
    // The two filters — and ONLY these two — a verdict JSON may be read with. A wildcard
    // `jq -r '…'` in this position let `jq -r '.'` through, which renders the WHOLE verdict object
    // (`.detail`, absolute paths, the real repo slug) into the operator-visible `NO_PR:` echo
    // while `not.toContain(".detail")` never fires, because `.detail` is not named.
    const ALLOWED_FILTERS = [
      `.reason // "unreadable-verdict"`,
      `if (type=="object" and .ok==true) then "true" else "false" end`,
      `if (type=="object" and .ok==true) then .base else empty end`,
    ];
    for (const verdict of ["CHAIN_JSON", "BASE_JSON", "VERIFY_JSON"]) {
      const filters = ALLOWED_FILTERS.map((f) => f.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
      const allowedRead = new RegExp(`printf '%s' "\\$\\{${verdict}:-null\\}" \\| jq -r '(?:${filters})' 2>/dev/null`, "g");
      let sites = 0;
      for (const rawLine of c.split("\n")) {
        if (!rawLine.includes(verdict)) continue;
        sites++;
        const residue = rawLine
          .replace(new RegExp(`^${verdict}=\\$\\(bun run "\\$\\{CLAUDE_PLUGIN_ROOT\\}/scripts/lib/stack\\.ts" `), "")
          .replace(allowedRead, "");
        expect(
          residue,
          `${verdict} reaches something other than its stack.ts assignment or a '%s'|jq read: ${rawLine}`,
        ).not.toContain(verdict);
      }
      // Not vacuous: the assignment plus at least the verdict-check and the refusal read.
      expect(sites, `no references to ${verdict} found — the scan is broken`).toBeGreaterThan(2);
    }
    // `.detail` carries absolute paths and the real repo slug; nothing in §4 reads it at all.
    expect(c).not.toContain(".detail");
    // Every verdict refusal derives `.reason`, and only `.reason`.
    const reasons = [...c.matchAll(/([A-Z][A-Z0-9_]*_REASON)=\$\(printf '%s' "\$\{[A-Z_]+_JSON:-null\}" \| jq -r '\.reason \/\/ "unreadable-verdict"' 2>\/dev\/null\)/g)];
    expect(reasons.length, "expected one `.reason`-only derivation per verdict-bearing refusal").toBe(3);
    // …and each refusal site maps to exactly one documented outcome, by count. `NO_PR:` is
    // Outcome A, whose definition is "a refusal at any of the three required checks", so there are
    // exactly THREE of them — assert-chain, resolve-base, `gh pr create`. Every refusal AFTER the
    // PR exists is Outcome C, prefixed `PR_UNRECORDED:` and stating that the PR is open; `> 3`
    // tolerated five NO_PR sites against three documented checks, two of them for a state in which
    // a pull request is already open.
    const noPr = [...c.matchAll(/echo "NO_PR: [^"]*"/g)].map((m) => m[0]);
    expect(noPr.length, "NO_PR: must mark exactly the three required checks of Outcome A").toBe(3);
    for (const site of noPr) {
      expect(site, `a NO_PR: site claims a PR is open — that is Outcome C: ${site}`).not.toContain("PR is open");
    }
    const unrecorded = [...c.matchAll(/echo "PR_UNRECORDED: [^"]*"/g)].map((m) => m[0]);
    expect(unrecorded.length, "every post-create refusal must be an Outcome C site").toBe(8);
    for (const site of unrecorded) {
      expect(site, `an Outcome C site does not say the PR is open: ${site}`).toContain(
        "— the PR is open; park the story with that reason (Outcome C) and repair the run state by hand.",
      );
    }
    // Ordering is what makes the split meaningful. The boundary is the first line that can only
    // run once `gh pr create` RETURNED successfully — the PR-number read — not the create call
    // itself, whose own `|| { … }` refusal is the third of Outcome A's checks.
    const create = c.indexOf("gh pr create");
    const postCreate = c.indexOf('PR=$(gh pr view');
    expect(create).toBeGreaterThan(-1);
    expect(postCreate).toBeGreaterThan(create);
    for (const site of noPr) {
      expect(c.indexOf(site), `a NO_PR: site sits after the PR exists: ${site}`).toBeLessThan(postCreate);
    }
    for (const site of unrecorded) {
      expect(c.indexOf(site), `a PR_UNRECORDED: site sits before gh pr create: ${site}`).toBeGreaterThan(create);
    }
    // No refusal after the PR exists may fall back to the bare `FATAL: … refusing.` form, which
    // says nothing about the pull request it leaves behind.
    for (const line of c.slice(postCreate).split("\n")) {
      expect(line, `a post-create refusal says only "refusing": ${line}`).not.toMatch(/echo "FATAL:/);
    }
  });

  // --- Bash discipline ----------------------------------------------------------------------
  test("guards are `positive || { … exit 1; }`, with the ONE verbatim-from-Preflight exception", () => {
    // The tracked-config refusal is `negative && { … } || true` in Preflight and is copied
    // BYTE-IDENTICALLY (asserted above) — rewording it would defeat the point of reusing it.
    // Everything else in the fence must use the positive form.
    const lines = fence().split("\n");
    const start = lines.findIndex((l) => l.startsWith('git -C "$(dirname "$CONFIG_REAL")" ls-files --error-unmatch'));
    expect(start).toBeGreaterThan(-1);
    const end = lines.findIndex((l, i) => i >= start && l.trim() === "|| true");
    // Comment lines are dropped before the check: bash discipline governs CODE, and the prose
    // beside this very guard quotes the `&& { … } || true` shape it is explaining. Matching the
    // explanation instead of the code is MUST-CHECK
    // doc-fence-slice-marker-must-not-appear-in-comments in its other direction.
    const rest = [...lines.slice(0, start), ...lines.slice(end + 1)]
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
    expect(rest).not.toMatch(/&&\s*\{/);
    // …and the exception really was sliced out, rather than the slice silently covering the
    // whole fence because a marker moved. Asserted on the SIZE of the removal, not only on what
    // survives it: the guard is exactly three lines (continuation, refusal, `|| true`), so a
    // marker that moved and swallowed the rest of the fence fails here rather than quietly
    // shrinking the text the `&&` check runs over.
    expect(end - start, "the sliced-out exception is not the three-line tracked-config guard").toBe(2);
    expect(rest.length, "the slice removed too much — nothing left to check").toBeGreaterThan(2000);
    expect(rest).toContain("|| { echo");
    // EVERY `||` is a refusal that EXITS. `|| { echo` as a substring is satisfied by one
    // conforming guard anywhere in the fence, so downgrading a specific guard to
    // `|| echo "WARN…"` survived it — and a warning that does not exit lets the fence continue
    // with the very value the guard exists to reject (an unvalidated $BRANCH straight into
    // `--head`, or an unmade $IN_DIR into four `cat >` redirects).
    const refusals = [...lines.slice(0, start), ...lines.slice(end + 1)].filter(
      (l) => !l.trimStart().startsWith("#") && l.includes("||"),
    );
    expect(refusals.length, "no `||` guards found — the extraction is broken").toBeGreaterThan(10);
    for (const line of refusals) {
      expect(line.slice(line.indexOf("||")), `a '||' guard that does not refuse-and-exit: ${line}`).toMatch(
        /^\|\|\s*\{.*exit 1;\s*\}$/,
      );
    }
    // No `mapfile`/`readarray`, and no `set -e`-style implicit reliance.
    expect(fence()).not.toMatch(/\b(mapfile|readarray)\b/);
  });

  // --- Findings 10 / 11 / 12: nothing stale is left pointing at a world that no longer exists
  test("findings 10-12: every retired R3 claim is gone from the runbook", () => {
    const txt = shipDoc();
    for (const stale of [
      "transitional duplicate",
      "removed entirely once R4",
      "Deliberately not specified here",
      "deferred to **PCO-370**",
      "ready_to_merge",
      "the story-lead currently cuts every branch from",
      "the story-lead still opens its own PR",
      "story-lead's §8",
      "Same guard drawbar-story-lead",
    ]) {
      expect(txt.replace(/\s+/g, " "), `stale claim still present: ${stale}`).not.toContain(stale);
    }
  });

  test("finding 11: every story-lead section cross-reference in the runbook resolves to a real heading in the agent", () => {
    const ship = shipDoc().replace(/\s+/g, " ");
    const agent = readNonEmpty(join(root, AGENT));
    const refs = [...ship.matchAll(/story-lead(?:'s)?[^.\n]{0,30}?§\*{0,2}(\d+)/g)].map((m) => m[1]!);
    expect(refs.length, "no story-lead section cross-references matched — the pattern is broken").toBeGreaterThan(1);
    for (const n of new Set(refs)) {
      expect(agent, `the runbook cites the story-lead's §${n}, which has no '## ${n}.' heading`).toContain(`## ${n}.`);
    }
    // The specific one finding 11 names: the report is §7 after R4, and it is what FLAGGED reads.
    expect(ship).toContain("`FLAGGED` comes from the story-lead's §7 report `status` field");
  });

  test("finding 12: Preflight's CLAUDE_PLUGIN_ROOT comment points at sections that really carry the guard", () => {
    const marker = ': "${CLAUDE_PLUGIN_ROOT:?CLAUDE_PLUGIN_ROOT must be set}"';
    const pf = preflightFence();
    const commentStart = pf.indexOf("# MUST-CHECK repo-anchor-guard-is-what-gates-an-unfixed-vulnerability: fail closed");
    expect(commentStart, "the CLAUDE_PLUGIN_ROOT guard comment not found").toBeGreaterThan(-1);
    const comment = pf.slice(commentStart, pf.indexOf(marker, commentStart));
    // The cross-reference it used to carry would be FALSE: the agent names CLAUDE_PLUGIN_ROOT
    // nowhere at all, so there is no "same guard" over there to point at.
    expect(readNonEmpty(join(root, AGENT))).not.toContain("CLAUDE_PLUGIN_ROOT");
    expect(comment).not.toMatch(/story-lead §\d/);
    // What it points at instead — §4 and §6 of THIS file — must actually carry the same line.
    expect(comment).toContain("§4 and §6");
    expect(fence()).toContain(marker);
    expect(rawSection("## 6.", "## 7.")).toContain(marker);
  });

  // --- Finding 13: §3 files a sub-issue for every surviving findings[] entry ------------------
  test("finding 13: §3 files one sub-issue per surviving findings[] entry, which is what gives §4 an id to render", () => {
    const s3 = section("## 3.", "## 4.");
    expect(s3).toContain(
      "**File one sub-issue for every surviving `findings[]` entry too**, under the same rules " +
        "— status `Unplanned`, label `found-in-review`, a `## Dependencies` section — and " +
        "record its id alongside the `out_of_scope` ones.",
    );
    expect(s3).toContain(
      "with no sub-issue filed here there is no id for §4 to render, so a flagged story's " +
        "surviving findings would be unpublishable and would die with the session exactly as " +
        "an unfiled `out_of_scope` entry does.",
    );
  });

  // Finding 13's other half: §3 now files sub-issues for unfixed SECURITY findings, and §4
  // publishes `<SUB-ISSUE-ID> — <sub-issue title>` verbatim in a public PR body while forbidding
  // `file:line` there. §3's only title rule was "name the bug not the symptom", so a fully
  // §3-compliant title like "path traversal in scripts/lib/stack.ts:165" landed verbatim on a
  // public PR — finding 9's disclosure reopened one indirection up, and newly reachable because
  // before this diff only `out_of_scope` findings were named in that section. Constrained where
  // the title is CREATED, and pinned as one contiguous phrase so a softening rephrase fails
  // exactly as a deletion does.
  test("finding 13: §3 forbids file:line/paths/quoted source in a sub-issue TITLE, because §4 publishes it", () => {
    expect(section("## 3.", "## 4.")).toContain(
      "**The title of every sub-issue filed here carries no `file:line`, no path, and no quoted " +
        "source** — those go in the body only, and this rule outranks any wording that reads as " +
        "encouraging them, because §4 publishes the title verbatim in a public PR body while " +
        "forbidding exactly those three things there.",
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
    // it to "usually opens … generally owns every Linear write" with everything else still green.
    //
    // PCO-369 (R6): this sentence used to read "owns the merge" — false under Locked F, and the
    // last surviving claim in either file that anything in the pipeline merges. The caller does
    // not own a merge; the OPERATOR does, and no code in this plugin performs or checks one. The
    // replacement is pinned here, and its absence is pinned by the Locked-F test below.
    expect(txt).toContain(
      "Your caller opens the stacked pull request, and owns every Linear write, the " +
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

// --- PCO-371 R7: §6 re-runs BOTH of Preflight's $CONFIG guards, verbatim -----------------------
//
// §6 newly re-resolves `CONFIG="${DRAWBAR_SHIP_CONFIG:-$PWD/.drawbar/ship.config.json}"` and hands
// it to kb-sync.ts as the TRUST ROOT for an arbitrary-code-execution sink (`git -C $ENV_DIR`), but
// shipped with only `[ -f ]` and `readlink -f` — the tracked-config refusal was missing. §4's own
// comment states the consequence for exactly this scenario: "Dropping them lets a branch under
// review plant `.drawbar/ship.config.json` and feed its own `projectDir` into `--project-dir` and
// `git -C`; an equality guard does not help, because both sides then agree — on the attacker's
// directory."
//
// "Preflight already checked" is not an answer: §6 is a separate Bash tool call whose `$PWD` need
// not match Preflight's, it runs AFTER §4/§5's branch work (so a config can appear mid-run), and
// crash-recovery paths re-enter mid-runbook. MUST-CHECK config-file-must-not-be-tracked-by-git and
// MUST-CHECK cross-invocation-guard-applies-per-variable-not-per-fence.
//
// Derived from Preflight's text rather than hand-copied here, exactly like the §4 pin above, so
// "the same guard" is a fact this test establishes instead of a claim a comment makes.
describe("PCO-371 R7: §6's $CONFIG guards are Preflight's, byte-identically", () => {
  function shipDoc(): string {
    return readNonEmpty(join(root, "commands/drawbar-ship.md"));
  }

  // The ONE bash fence in §6.
  function sectionSixFence(): string {
    for (const m of ["## 6. Capture and sync knowledge", "## 7. Advance"]) assertOccursOnce(m);
    const txt = shipDoc();
    const start = txt.indexOf("## 6. Capture and sync knowledge");
    const end = txt.indexOf("## 7. Advance", start);
    expect(end, "§7 heading not found after §6").toBeGreaterThan(start);
    const fences = [...txt.slice(start, end).matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(fences.length, "§6 must carry exactly one bash fence").toBe(1);
    return fences[0]!;
  }

  function preflightFenceR7(): string {
    const txt = shipDoc();
    const sectionStart = txt.indexOf("## Preflight (halt on any failure)");
    expect(sectionStart, "Preflight heading not found").toBeGreaterThan(-1);
    const fenceStart = txt.indexOf("```bash", sectionStart);
    const fenceEnd = txt.indexOf("```", fenceStart + 7);
    expect(fenceEnd).toBeGreaterThan(fenceStart);
    return txt.slice(fenceStart + 7, fenceEnd);
  }

  // Exactly one line starting with `prefix` — a SECOND assignment further down would silently
  // overwrite the pinned one, and a `toContain` on the first would never notice.
  function oneLineR7(block: string, prefix: string, label: string): string {
    const hits = block.split("\n").filter((l) => l.startsWith(prefix));
    expect(hits.length, `${label}: expected exactly one line starting with ${JSON.stringify(prefix)}, found ${hits.length}`).toBe(1);
    return hits[0]!;
  }

  const trackedPrefix = 'git -C "$(dirname "$CONFIG_REAL")" ls-files --error-unmatch';

  function trackedGuard(block: string, label: string): string {
    const lines = block.split("\n");
    const start = lines.findIndex((l) => l.startsWith(trackedPrefix));
    expect(start, `${label}: tracked-config guard not found`).toBeGreaterThan(-1);
    const end = lines.findIndex((l, i) => i >= start && l.trim() === "|| true");
    expect(end, `${label}: tracked-config guard's '|| true' not found`).toBeGreaterThan(start);
    return lines.slice(start, end + 1).join("\n");
  }

  test("CRITICAL: §6 carries the tracked-config refusal at all", () => {
    // The pin the R5 diff added (kb-sync.test.ts, "§6 re-declares CONFIG") only asserted that the
    // string `CONFIG_REAL` appears, so it passed with BOTH guards absent. This is the assertion
    // that does not.
    const f = sectionSixFence();
    expect(f).toContain(trackedPrefix);
  });

  test("all four lines are Preflight's, byte for byte", () => {
    const f = sectionSixFence();
    const pf = preflightFenceR7();
    expect(oneLineR7(f, 'CONFIG="${DRAWBAR_SHIP_CONFIG', "§6's CONFIG resolution")).toBe(
      oneLineR7(pf, 'CONFIG="${DRAWBAR_SHIP_CONFIG', "Preflight's CONFIG resolution"),
    );
    expect(oneLineR7(f, '[ -f "$CONFIG" ]', "§6's config-file-existence guard")).toBe(
      oneLineR7(pf, '[ -f "$CONFIG" ]', "Preflight's config-file-existence guard"),
    );
    // The symlink resolution is part of the guard, not a convenience: a committed directory symlink
    // otherwise makes `--error-unmatch` exit 1 for a config that IS committed, and the refusal
    // never fires. Pinned on both sides so §6 cannot keep the `git -C` line while dropping the
    // resolution it depends on.
    expect(oneLineR7(f, "CONFIG_REAL=", "§6's config path resolution")).toBe(
      oneLineR7(pf, "CONFIG_REAL=", "Preflight's config path resolution"),
    );
    expect(trackedGuard(f, "§6")).toBe(trackedGuard(pf, "Preflight"));
  });

  test("the guards run BEFORE the two things that consume $CONFIG_REAL", () => {
    const f = sectionSixFence();
    expect(f.indexOf("CONFIG_REAL=")).toBeLessThan(f.indexOf(trackedPrefix));
    // ...and before the kb-sync invocation whose --config-path they protect.
    const syncCall = f.indexOf('kb-sync.ts" sync');
    expect(syncCall, "§6's kb-sync sync invocation not found").toBeGreaterThan(-1);
    expect(f.indexOf(trackedPrefix)).toBeLessThan(syncCall);
  });

  test("§6 states that DRAWBAR_SHIP_CONFIG must be EXPORTED, because the module re-derives the anchor", () => {
    // kb-sync.ts's trust root refuses a `--config-path` that disagrees with what
    // `resolveConfigPath` derives from the environment IT inherits — so a DRAWBAR_SHIP_CONFIG that
    // is set but not exported makes every run refuse `config_path_not_anchored`. That operational
    // consequence has to be written down where the operator will see it.
    const f = sectionSixFence();
    expect(f).toContain("EXPORTED");
  });
});

// --- PCO-369 R6: the documentation pass -------------------------------------------------------
//
// R1 deleted the merge machinery, R2 replaced `merged: {}` with `stack: [...]`, R3/R3b rewrote
// ship §4/§5, and R4 rewrote the story-lead and renumbered its report §8 -> §7. Each left the
// two docs internally consistent only where its own diff happened to reach. R6 reconciles the
// rest: every cross-reference between the two files, every trace of prose describing a merge,
// and the three things the redesign assumed a reader knew but neither file ever stated — how a
// base is chosen, what `flagged` means, and Locked F.
//
// Every prose pin below is ONE CONTIGUOUS whitespace-normalized phrase, per MUST-CHECK
// pco352-fixpass-prose-gate-mutation-must-cover-rephrase-not-only-delete: demoting a hard
// conjunct to a parenthetical, or weakening a qualifier, must fail the same test a deletion
// does. Claims that name a flag or a derivation are pinned on the literal invocation line, per
// MUST-CHECK prose-pins-dont-cover-the-bash-fence-they-describe.
describe("PCO-369 R6: cross-references reconciled, the stack model documented, Locked F stated", () => {
  const SHIP = "commands/drawbar-ship.md";
  const AGENT = "agents/drawbar-story-lead.md";

  function shipRaw(): string {
    return readNonEmpty(join(root, SHIP));
  }
  function agentRaw(): string {
    return readNonEmpty(join(root, AGENT));
  }
  const ship = () => shipRaw().replace(/\s+/g, " ");
  const agent = () => agentRaw().replace(/\s+/g, " ");

  // `## N.` heading map for one doc: N -> heading text after the number. Duplicate numbers are
  // refused outright — `indexOf`-based slicing elsewhere in this file silently picks the FIRST
  // occurrence, so a duplicated number is a defect in its own right.
  function numberedHeadings(raw: string, label: string): Map<number, string> {
    const out = new Map<number, string>();
    for (const m of raw.matchAll(/^##\s+(\d+)\.\s*(.+)$/gm)) {
      const n = Number(m[1]);
      expect(out.has(n), `${label}: duplicate '## ${n}.' heading`).toBe(false);
      out.set(n, m[2]!.trim());
    }
    expect(out.size, `${label}: no numbered headings found — the regex or the doc is broken`).toBeGreaterThan(3);
    return out;
  }

  // Sentences of a whitespace-normalized doc. Used to attribute each `§N` reference — and each
  // merge word — to the sentence that makes the claim, rather than to a fixed-width character
  // window: a window wide enough to catch "story-lead" also catches an unrelated "caller's" from
  // the paragraph above, which mis-files an own-file reference as a cross-file one.
  //
  // The trailing-markup class is load-bearing, and mutation proved it so. Both docs end a great
  // many sentences inside `**bold**`, and a plain `(?<=[.!?])\s+` never splits after one: the
  // lookbehind sees `*`, not `.`. Reintroducing the exact merge prose R6 removed ("…owns the
  // merge, every Linear write…") therefore left the attribution scan below GREEN, because the
  // offending sentence was glued to the bolded "**You do not open the pull request, you do not
  // merge…**" ahead of it and inherited that sentence's denial.
  function sentences(norm: string): string[] {
    return norm.split(/(?<=[.!?][*`"'）)\]]{0,3})\s+/);
  }

  function sectionRefs(raw: string): { n: number; sentence: string }[] {
    const out: { n: number; sentence: string }[] = [];
    for (const sentence of sentences(raw.replace(/\s+/g, " "))) {
      for (const m of sentence.matchAll(/§(\d+)/g)) out.push({ n: Number(m[1]), sentence });
    }
    return out;
  }

  // --- Cross-reference integrity ------------------------------------------------------------

  // Enumerated, not inferred. Each entry is a reference in one doc that points into the OTHER
  // doc; the phrase is pinned verbatim (so deleting or rewording the reference fails here), the
  // number is resolved against the target doc's real headings, and `title` asserts the heading
  // it lands on actually carries what the reference claims. R4 renumbered the story-lead's
  // report §8 -> §7 and deleted the old §7 ("Drive it green") entirely, so every one of these
  // was a candidate for pointing at the wrong thing.
  const CROSS_REFS: { from: "ship" | "agent"; phrase: string; n: number; title: string }[] = [
    { from: "ship", phrase: "It returns the JSON report in its §7", n: 7, title: "Report" },
    {
      from: "ship",
      phrase: "The story-lead's own §6 pushes its branch and stops there",
      n: 6,
      title: "Commit and push",
    },
    {
      from: "ship",
      phrase: "`FLAGGED` comes from the story-lead's §7 report `status` field",
      n: 7,
      title: "Report",
    },
    {
      from: "ship",
      phrase: "commit each verified increment (the story-lead's §2)",
      n: 2,
      title: "Branch and implement",
    },
    {
      from: "agent",
      phrase: "Your caller's §4 opens the stacked pull request",
      n: 4,
      title: "Open the stacked PR",
    },
  ];

  test("every enumerated cross-doc §-reference is present verbatim and resolves to a heading carrying what it claims", () => {
    const docs = {
      ship: { norm: ship(), headings: numberedHeadings(shipRaw(), SHIP) },
      agent: { norm: agent(), headings: numberedHeadings(agentRaw(), AGENT) },
    };
    for (const ref of CROSS_REFS) {
      const source = docs[ref.from];
      const target = docs[ref.from === "ship" ? "agent" : "ship"];
      expect(source.norm, `${ref.from}: cross-reference '${ref.phrase}' is missing`).toContain(ref.phrase);
      const heading = target.headings.get(ref.n);
      expect(heading, `'${ref.phrase}' points at §${ref.n}, which is not a heading in the target doc`).toBeDefined();
      expect(
        heading,
        `'${ref.phrase}' points at §${ref.n}, whose heading is '${heading}' — it must carry '${ref.title}'`,
      ).toContain(ref.title);
    }
  });

  // The complement of the pin above: any §-reference NOT enumerated as a cross-doc one must
  // resolve inside its own doc. This is what catches an orphan — a pointer left behind by a
  // renumbering, aimed at a section number that no longer exists.
  test("every other §-reference in either doc resolves to a numbered heading in that same doc", () => {
    for (const [label, raw] of [[SHIP, shipRaw()], [AGENT, agentRaw()]] as const) {
      const headings = numberedHeadings(raw, label);
      const refs = sectionRefs(raw);
      expect(refs.length, `${label}: no §-references found — the extractor is broken`).toBeGreaterThan(3);
      let ownFile = 0;
      for (const ref of refs) {
        if (CROSS_REFS.some((c) => ref.sentence.includes(c.phrase))) continue;
        ownFile++;
        expect(
          headings.has(ref.n),
          `${label}: §${ref.n} is referenced but is not a heading in this doc — orphaned reference in: ${ref.sentence.slice(0, 160)}`,
        ).toBe(true);
      }
      expect(ownFile, `${label}: every reference was classified as cross-doc — the classifier is broken`).toBeGreaterThan(3);
    }
  });

  // The pin above is a heading-EXISTS check, and that is not enough. Three stories in a row have
  // introduced a stale cross-reference, and the shape that survived R6's own first mutation pass
  // was a reference redirected to a REAL BUT WRONG section: "the sub-issue §3 filed for it" ->
  // "§1", "because §2 routes it straight to Parking a story" -> "§1", "§1's pick rule" -> "§3",
  // "the §5 comment" -> "§7". Every one of those still resolves to a heading that exists, so the
  // existence check stays green while the runbook now points a reader at the wrong step.
  //
  // OWN_REFS closes that hole for every own-doc reference the two files make. Each entry pins the
  // referring phrase VERBATIM, including its `§n` — so a redirect stops matching — and separately
  // asserts the heading `n` resolves to carries `title`, so RENUMBERING the target without
  // updating the reference fails too. `ns` is a list because several phrases name more than one
  // section at once ("(§4 and §6)", "§6 runs AFTER §4/§5's branch work").
  const OWN_REFS: { doc: "ship" | "agent"; anchor: string; ns: { n: number; title: string }[] }[] = [
    // --- commands/drawbar-ship.md, referring to itself ---------------------------------------
    { doc: "ship", anchor: "`resolve-base` verb, invoked in §4 —", ns: [{ n: 4, title: "Open the stacked PR" }] },
    { doc: "ship", anchor: "the run **parks and halts** (§4, Outcome A)", ns: [{ n: 4, title: "Open the stacked PR" }] },
    {
      doc: "ship",
      anchor: "in THIS file (§4 and §6) re-declares this same guard",
      ns: [{ n: 4, title: "Open the stacked PR" }, { n: 6, title: "Capture and sync knowledge" }],
    },
    { doc: "ship", anchor: "**halt** — §1's pick rule and the blocker gate", ns: [{ n: 1, title: "Pick the story" }] },
    { doc: "ship", anchor: "it opens none; §4 below is what opens the PR", ns: [{ n: 4, title: "Open the stacked PR" }] },
    {
      doc: "ship",
      anchor: "and §4's `## Unresolved findings` section is allowed to name a finding",
      ns: [{ n: 4, title: "Open the stacked PR" }],
    },
    { doc: "ship", anchor: "there is no id for §4 to render", ns: [{ n: 4, title: "Open the stacked PR" }] },
    {
      doc: "ship",
      anchor: "because §4 publishes the title verbatim in a public PR body",
      ns: [{ n: 4, title: "Open the stacked PR" }],
    },
    {
      doc: "ship",
      anchor: "because §2 routes it straight to *Parking a story*",
      ns: [{ n: 2, title: "Delegate the whole story" }],
    },
    {
      doc: "ship",
      anchor: "the full write-up already lives in the sub-issue §3 filed for it",
      ns: [{ n: 3, title: "File out-of-scope findings as sub-issues" }],
    },
    {
      doc: "ship",
      anchor: "the explicit-assignment convention §6 uses for $LESSONS_JSON",
      ns: [{ n: 6, title: "Capture and sync knowledge" }],
    },
    { doc: "ship", anchor: "# --- derive from the resolved config (§4)", ns: [{ n: 4, title: "Open the stacked PR" }] },
    {
      doc: "ship",
      anchor: "# --- end derive from the resolved config (§4)",
      ns: [{ n: 4, title: "Open the stacked PR" }],
    },
    {
      doc: "ship",
      anchor: "pasted into `parked_reason`, the §5 comment, or a KB entry",
      ns: [{ n: 5, title: "Post the summary comment" }],
    },
    { doc: "ship", anchor: "round-trips, then continue to §5.", ns: [{ n: 5, title: "Post the summary comment" }] },
    {
      doc: "ship",
      anchor: "the sub-issues filed in §3, and the story-lead's `mutation_pairs`",
      ns: [{ n: 3, title: "File out-of-scope findings as sub-issues" }],
    },
    {
      doc: "ship",
      anchor: "§6 runs AFTER §4/§5's branch work",
      ns: [
        { n: 6, title: "Capture and sync knowledge" },
        { n: 4, title: "Open the stacked PR" },
        { n: 5, title: "Post the summary comment" },
      ],
    },
    {
      doc: "ship",
      anchor: "not** cleared here — §5 (post the summary comment) does not clear it either",
      ns: [{ n: 5, title: "Post the summary comment" }],
    },
    // Crash recovery's step 4 (fix pass): the already-stacked resume target. The reference and
    // the exemption are one claim — a story whose PR is already recorded resolves no new base and
    // rejoins the run at the summary-comment step, not at the PR-opening one.
    {
      doc: "ship",
      anchor: "resolve **no** new base for it, and resume at §5 (post the summary comment)",
      ns: [{ n: 5, title: "Post the summary comment" }],
    },
    // --- agents/drawbar-story-lead.md, referring to itself -----------------------------------
    { doc: "agent", anchor: "Make it the report in §7, nothing else.", ns: [{ n: 7, title: "Report" }] },
    {
      doc: "agent",
      anchor: "goes into the implementer's brief in §2 verbatim",
      ns: [{ n: 2, title: "Branch and implement" }],
    },
    {
      doc: "agent",
      anchor: "then re-run §3 and §4 on the fixes",
      ns: [{ n: 3, title: "Verification gate" }, { n: 4, title: "Mutation gate" }],
    },
    {
      doc: "agent",
      anchor:
        "The verify gate (§3) or the mutation gate (§4) could not be satisfied, or a Critical " +
        "finding survived the one fix pass (§5).",
      ns: [
        { n: 3, title: "Verification gate" },
        { n: 4, title: "Mutation gate" },
        { n: 5, title: "exactly one fix pass" },
      ],
    },
  ];

  test("every own-doc §-reference is enumerated, present verbatim, and lands on a heading carrying what it claims", () => {
    const headings = { ship: numberedHeadings(shipRaw(), SHIP), agent: numberedHeadings(agentRaw(), AGENT) };
    let checked = 0;
    for (const ref of OWN_REFS) {
      const norm = ref.doc === "ship" ? ship() : agent();
      const count = norm.split(ref.anchor).length - 1;
      expect(count, `${ref.doc}: own-doc reference '${ref.anchor}' must occur exactly once, found ${count}`).toBe(1);
      for (const { n, title } of ref.ns) {
        const heading = headings[ref.doc].get(n);
        expect(heading, `${ref.doc}: '${ref.anchor}' names §${n}, which is not a heading in that doc`).toBeDefined();
        expect(
          heading,
          `${ref.doc}: '${ref.anchor}' names §${n}, whose heading is '${heading}' — it must carry '${title}'`,
        ).toContain(title);
        checked++;
      }
    }
    expect(checked, "OWN_REFS is empty or the loop is broken").toBeGreaterThan(20);
  });

  // Completeness, and the reason the pin above is worth anything: strike every ENUMERATED
  // reference — cross-doc and own-doc — out of each doc, and no `§` may remain. So a NEW
  // reference must be enumerated (with its target heading asserted) before the suite goes green,
  // and a redirected one shows up here as an unenumerated leftover even if someone also edits its
  // OWN_REFS anchor to match.
  test("no §-reference in either doc is left unenumerated", () => {
    for (const [label, doc] of [[SHIP, "ship"], [AGENT, "agent"]] as const) {
      let norm = doc === "ship" ? ship() : agent();
      const total = [...norm.matchAll(/§\d+/g)].length;
      expect(total, `${label}: no §-references found — the extractor is broken`).toBeGreaterThan(5);
      for (const c of CROSS_REFS.filter((c) => c.from === doc)) norm = norm.split(c.phrase).join("");
      for (const o of OWN_REFS.filter((o) => o.doc === doc)) norm = norm.split(o.anchor).join("");
      const leftovers = [...norm.matchAll(/§\d+/g)].map((m) => {
        const at = m.index ?? 0;
        return norm.slice(Math.max(0, at - 70), at + 40);
      });
      expect(leftovers, `${label}: §-reference(s) not enumerated in CROSS_REFS or OWN_REFS`).toEqual([]);
    }
  });

  // A reference into the story-lead is the one most likely to be stale, because R4 both deleted
  // a section and renumbered another onto its number. Every §-number ATTRIBUTED to the other doc
  // — "the story-lead's §6", "in its §7", "your caller's §4" — must be one of the enumerated,
  // resolved cross-references above; an unenumerated one would be checked against the WRONG doc
  // by the test above and could pass by coincidence whenever both docs happen to have that
  // number. Keyed on the possessive attachment rather than on the sentence merely mentioning the
  // other agent: ship §3 legitimately says "the story-lead's one fix pass … and §4's `##
  // Unresolved findings` section", where the §4 is ship's own.
  const ATTRIBUTED_REF = /(?:story-lead(?:'s)?(?:\s+own)?|caller(?:'s)?(?:\s+own)?|in its)\s+§(\d+)/g;

  test("the attributed-reference pattern keys on possession, not on a sentence mentioning the other agent", () => {
    const hits = (s: string) => [...s.matchAll(ATTRIBUTED_REF)].map((m) => m[1]);
    expect(hits("The story-lead's own §6 pushes its branch")).toEqual(["6"]);
    expect(hits("It returns the JSON report in its §7")).toEqual(["7"]);
    expect(hits("Your caller's §4 opens the stacked pull request")).toEqual(["4"]);
    expect(hits("the story-lead's one fix pass, and §4's `## Unresolved findings` section")).toEqual([]);
    expect(hits("re-run §3 and §4 on the fixes")).toEqual([]);
  });

  test("no unenumerated cross-doc §-reference survives in either doc", () => {
    for (const [label, raw, from] of [
      [SHIP, shipRaw(), "ship"],
      [AGENT, agentRaw(), "agent"],
    ] as const) {
      let attributed = 0;
      for (const ref of sectionRefs(raw)) {
        for (const m of ref.sentence.matchAll(ATTRIBUTED_REF)) {
          if (Number(m[1]) !== ref.n) continue;
          attributed++;
          expect(
            CROSS_REFS.some((c) => c.from === from && ref.sentence.includes(c.phrase)),
            `${label}: unenumerated cross-doc reference to §${ref.n}: ${ref.sentence.slice(0, 160)}`,
          ).toBe(true);
        }
      }
      expect(attributed, `${label}: no attributed cross-doc references found — the pattern is broken`).toBeGreaterThan(0);
    }
  });

  // R4 deleted the story-lead's old §7 (the CI poll) and renumbered §8 -> §7. Two absence pins
  // that a stale pointer would trip: no doc may reference a §8 at all, and the runbook may not
  // describe the story-lead as polling CI or driving a branch green.
  test("no §8 reference survives in either doc, and neither describes the story-lead polling CI", () => {
    for (const [label, norm] of [[SHIP, ship()], [AGENT, agent()]] as const) {
      expect(norm, `${label}: §8 no longer exists in either doc`).not.toMatch(/§[89]\b/);
      expect(norm, `${label}: the CI-polling step was deleted by R4`).not.toMatch(/drive it green|drive the branch green/i);
    }
    // And the runbook must not have picked the deleted responsibility back up itself.
    expect(ship()).not.toMatch(/gh\s+(?:pr\s+checks|run\s+(?:watch|list))/i);
  });

  // --- No prose describing a merge -----------------------------------------------------------

  // Attribution scan, not a bare absence check: both docs legitimately say a great deal about
  // merging — that the OPERATOR merges, and that this tooling never does. What must not survive
  // is a sentence attributing a merge to the tooling. Every sentence carrying a merge word must
  // therefore carry one of the reviewed tokens below; the exact sentence R6 removed ("Your
  // caller opens the stacked pull request, owns the merge, …") carries none of them, which the
  // self-test on this scan proves.
  const MERGE_WORD = /\bmerg(?:e|es|ed|ing|eable|e-state)\b/i;
  function mergeSentenceIsAttributed(s: string): boolean {
    return (
      /operator/i.test(s) || // attributed to the human who actually does it
      /\bnever\b|\bnot\b|\bno\b|\bnothing\b/i.test(s) || // an explicit denial
      /out[- ]of[- ]order/i.test(s) || // about a merge the operator got wrong
      /merge=union|union-merge/i.test(s) || // the KB repo's gitattributes, unrelated
      /merged findings/i.test(s) || // the review fix pass's merged finding list
      /mergeable/i.test(s) // "keeping the stack mergeable is the operator's job"
    );
  }

  // Splitter self-test: proves the trailing-markup class actually separates a claim from a
  // bolded denial ahead of it. Without this, the scan below is satisfiable by placing the
  // offending sentence after any `**…**` sentence containing "not".
  test("the sentence splitter separates a claim from a bolded sentence ahead of it", () => {
    expect(
      sentences(
        "**You do not open the pull request, you do not merge.** Your caller owns the merge, every Linear write.",
      ),
    ).toEqual([
      "**You do not open the pull request, you do not merge.**",
      "Your caller owns the merge, every Linear write.",
    ]);
    // A period inside a sentence must not split it.
    expect(sentences("Run `stack.ts resolve-base` first. Then open it.")).toEqual([
      "Run `stack.ts resolve-base` first.",
      "Then open it.",
    ]);
  });

  test("the merge-attribution scan flags a sentence that gives the tooling a merge", () => {
    // The literal claim R6 deleted from the story-lead — the last one in either file.
    expect(
      mergeSentenceIsAttributed(
        "Your caller opens the stacked pull request, owns the merge, every Linear write, the knowledge-base push, and the burn-down state.",
      ),
    ).toBe(false);
    expect(mergeSentenceIsAttributed("Then merge the PR once the required checks pass.")).toBe(false);
    expect(mergeSentenceIsAttributed("§4 merges the story and advances.")).toBe(false);
    // ...and does not flag the true statements both docs make.
    expect(mergeSentenceIsAttributed("It never merges — the operator reviews and merges.")).toBe(true);
    expect(
      mergeSentenceIsAttributed("Merging out of order leaves later PRs showing a diff against a base that has moved."),
    ).toBe(true);
  });

  test("no sentence in either doc attributes a merge to this tooling", () => {
    for (const [label, norm] of [[SHIP, ship()], [AGENT, agent()]] as const) {
      const withMerge = sentences(norm).filter((s) => MERGE_WORD.test(s));
      expect(withMerge.length, `${label}: no merge-word sentences found — the scan is vacuous`).toBeGreaterThan(3);
      const offenders = withMerge.filter((s) => !mergeSentenceIsAttributed(s)).map((s) => s.slice(0, 160));
      expect(offenders, `${label}: merge attributed to the tooling`).toEqual([]);
    }
  });

  // The specific false claim R1's deletions left in the runbook's opening: with the stack, story
  // N is based on N−1's BRANCH — nothing is ever on the default branch during a run. Pinned in
  // both directions so the replacement cannot be re-weakened to the old one.
  test("the runbook's sequential-only rule states the stack relationship, not a merge to the default branch", () => {
    const txt = ship();
    expect(txt).not.toMatch(/assumes N.{0,3}1 is on/);
    expect(txt).toContain(
      "they are dependency-ordered, and story N is based on story N−1's branch, which does not " +
        "exist until N−1 has finished.",
    );
  });

  // --- The stack model is documented ---------------------------------------------------------

  function stackModel(): string {
    for (const m of ["## The stack model", "## Preflight (halt on any failure)"]) assertOccursOnce(m);
    const txt = shipRaw();
    const start = txt.indexOf("## The stack model");
    const end = txt.indexOf("## Preflight (halt on any failure)", start);
    expect(end, "Preflight heading not found after the stack model section").toBeGreaterThan(start);
    return txt.slice(start, end).replace(/\s+/g, " ");
  }

  test("the runbook carries a stack-model section, ahead of Preflight", () => {
    const txt = shipRaw();
    expect(txt.indexOf("## The stack model")).toBeGreaterThan(-1);
    expect(txt.indexOf("## The stack model")).toBeLessThan(txt.indexOf("## Preflight (halt on any failure)"));
    expect(stackModel().length, "the stack-model section is suspiciously short").toBeGreaterThan(1500);
  });

  // The section's opening claim: what a stack IS, and that it is required rather than a
  // stylistic preference. Deleting this paragraph left the length floor above satisfied and every
  // other stack-model pin green, so the one paragraph that answers "why stack at all" was
  // free to remove.
  test("the stack model defines the stack itself, and says dependency ordering makes it required not incidental", () => {
    expect(stackModel()).toContain(
      "Each story becomes one pull request, and the pull requests form a **stack**: every PR is " +
        "based on the one before it, so each diff shows only its own story's changes and every " +
        "branch is buildable on its own. Stories are dependency-ordered, so this is required " +
        "rather than incidental — story N+1 generally does not compile against the configured " +
        "base at all.",
    );
  });

  test("the stack model states how a base is chosen — configured baseBranch first, previous story's branch after (Locked A)", () => {
    expect(stackModel()).toContain(
      "**How a base is chosen (Locked A).** The base is the configured `baseBranch` for the " +
        "**first** story of a run, and the **previous story's branch** for every story after it.",
    );
  });

  // Names a derivation, so it is pinned on the literal producer invocation rather than on the
  // prose around it (MUST-CHECK prose-pins-dont-cover-the-bash-fence-they-describe): the claim
  // is that ONE named verb produces the value and bash never re-derives it.
  test("the stack model names `resolve-base` as the sole producer and forbids re-deriving the base in bash", () => {
    expect(stackModel()).toContain(
      "Exactly one thing produces that value — `scripts/lib/stack.ts`'s `resolve-base` verb, " +
        "invoked in §4 — and it is **never re-derived in bash**, never lifted out of the " +
        "run-state file by hand, and never left to a default.",
    );
  });

  // WHY `resolve-base` is the sole producer, kept attached to the rule. Without it "never
  // re-derived in bash" reads as a style rule rather than the validation boundary it is, and the
  // reason a value copied out of `stack[]` is untrusted (the run state is agent-writable) is the
  // whole argument. Deleting this sentence left every other base pin green.
  test("the stack model gives the reason resolve-base is the sole producer: shape-gating, over agent-writable run state", () => {
    expect(stackModel()).toContain(
      "`resolve-base` is the only producer that shape-gates the branch name with " +
        "`isValidRefName`; the run state it reads is agent-writable, so a base copied straight " +
        "out of `stack[]` carries no validation at all.",
    );
  });

  // The half of Locked A that constrains the OTHER agent: the story-lead consumes a base and
  // never produces one. Deleting it leaves the runbook silent on whether the story-lead may
  // resolve its own base — which is exactly the re-derivation the rule above forbids.
  test("the stack model states the story-lead is handed its base and never resolves one", () => {
    expect(stackModel()).toContain(
      "The story-lead is **handed** its base and cuts from it; it never resolves one.",
    );
  });

  test("the stack model names the consequence of an omitted --base: a diff carrying every earlier story's work", () => {
    expect(stackModel()).toContain(
      "Omitting `--base` is the same failure from the other side: `gh` would fall back to the " +
        "repo's default branch, producing a PR whose diff carries every earlier story's work " +
        "too — green, plausible, and near-impossible to spot in the morning.",
    );
  });

  test("the stack model states that flagged opens the PR anyway and the stack continues on top of it", () => {
    const body = stackModel();
    expect(body).toContain(
      "A `flagged` story is one whose single fix pass left Important findings alive. **The PR " +
        "opens anyway**, annotated with an `## Unresolved findings` section, and **the stack " +
        "continues on top of it** — the next story is based on this story's branch exactly as " +
        "if it had come back clean.",
    );
  });

  // The rationale for opening a flagged PR rather than halting on it. This is the sentence that
  // stops a later reader "fixing" flagged into a halt, so it is pinned alongside the rule.
  test("the stack model justifies why flagged opens the PR rather than costing the night's throughput", () => {
    expect(stackModel()).toContain(
      "A story that is 90% right belongs in front of the operator at 8am, annotated, rather than " +
        "costing the rest of the night's throughput.",
    );
  });

  test("the stack model distinguishes 'no PR could be opened' in kind from flagged, and says it parks and halts", () => {
    expect(stackModel()).toContain(
      "**\"No PR could be opened\" differs in kind from `flagged`, not in degree.** With no pull " +
        "request there is no branch for the next story to base on, so the chain has no anchor " +
        "and the run **parks and halts** (§4, Outcome A).",
    );
  });

  test("the stack model states the operator's morning contract: review bottom-up and merge bottom-up, in order", () => {
    expect(stackModel()).toContain(
      "**The operator's contract in the morning: review bottom-up and merge bottom-up, in order.**",
    );
    // The reason, kept attached. "in order" without it is an unexplained instruction, and an
    // unexplained instruction is the one an operator in a hurry overrides. Deleting these two
    // sentences left the bolded header pin above green on its own.
    expect(stackModel()).toContain(
      "The stack was built bottom-up, so only the bottom PR's diff is meaningful against the " +
        "configured base; every PR above it is meaningful only once the one below has landed. " +
        "Reviewing or merging out of order reads a diff against a base that has moved.",
    );
  });

  // Locked F, in three parts, each of which a reader could act wrongly on if it were softened:
  // the three things the command never does, whose job the stack is, and — the part the design
  // document is emphatic about — that the missing out-of-order-merge detection is a CONTRACT and
  // not a gap somebody should file a follow-up for.
  test("Locked F is stated without hedging: never merges, never verifies a merge, never inspects whether one happened", () => {
    expect(stackModel()).toContain(
      "**Locked F — `drawbar-ship` never merges, never verifies a merge, and never inspects " +
        "whether one happened.** Keeping the stack mergeable is the operator's job.",
    );
  });

  test("Locked F states that out-of-order-merge detection and repair does not exist, is not planned, and is not a gap to file", () => {
    expect(stackModel()).toContain(
      "**No detection or repair of out-of-order merges exists or is planned** — that is a " +
        "contract, not a gap awaiting a follow-up, so do not file one for it.",
    );
    // The reason, kept attached: without it "not planned" reads as an oversight rather than a
    // consequence of the deletion this whole redesign is.
    expect(stackModel()).toContain(
      "Building it back would re-introduce exactly the merge-state gating this design deleted",
    );
    // And the remedy, which is what makes "not planned" actionable rather than merely a refusal:
    // a reader who hits an out-of-order merge is told what to do about it. Deleting this sentence
    // left the "exists or is planned" pin green while removing the only answer the doc offers.
    expect(stackModel()).toContain(
      "If a stack does get merged out of order, the recovery is a human rebase, and this command " +
        "has no opinion about it.",
    );
  });

  // --- Crash recovery re-establishes the base ------------------------------------------------

  function crashRecovery(): string {
    for (const m of ["## Crash recovery", "## Finishing the run"]) assertOccursOnce(m);
    const txt = shipRaw();
    const start = txt.indexOf("## Crash recovery");
    const end = txt.indexOf("## Finishing the run", start);
    expect(end, "'## Finishing the run' not found after '## Crash recovery'").toBeGreaterThan(start);
    return txt.slice(start, end).replace(/\s+/g, " ");
  }

  test("Crash recovery names its new responsibility — the stack base, not merely the in-flight story", () => {
    expect(crashRecovery()).toContain(
      "**Recovery re-establishes the stack base, not merely the in-flight story.**",
    );
  });

  // The consequence has to sit WHERE THE RECOVERY STEPS ARE, not only in the stack-model
  // section: a resumed run resolving the wrong base is the one crash failure that produces no
  // error at all, and an operator reading only this section would otherwise never learn it.
  test("Crash recovery names the wrong-base consequence: a PR whose diff carries another story's work", () => {
    expect(crashRecovery()).toContain(
      "a resumed run that resolves the wrong base opens a pull request whose diff carries " +
        "another story's work — green, plausible, and near-impossible to spot in the morning.",
    );
  });

  // Names two derivations (`assert-chain`, `resolve-base`), so the pin carries both literal verb
  // invocations rather than the prose around them.
  test("Crash recovery re-establishes the base via assert-chain and a fresh resolve-base, never from the checked-out branch", () => {
    const body = crashRecovery();
    expect(body).toContain(
      "Every other resume re-establishes the base *here*, through the fence below, never from the " +
        "branch that happens to be checked out and never re-derived in bash: `stack.ts " +
        "assert-chain` confirms every recorded predecessor branch still exists and still points " +
        "where the `stack` array says, then a fresh `stack.ts resolve-base` produces the base for " +
        "this story.",
    );
    expect(body).toContain(
      "Any other refusal from either call **parks the story**: refuse rather than guess",
    );
  });

  // --- Fix pass: step 4 must not park a recoverable run ---------------------------------------
  //
  // `resolveBase` refuses `story_already_stacked` whenever the story already has a `stack[]`
  // entry (scripts/lib/stack.ts). §7 does not clear `in_flight`, so a crash between the PR
  // opening and Advance leaves a CORRECT state that Preflight routes to Crash recovery. An
  // unconditional "a refusal from either call parks the story" therefore ends the night over a
  // run that only lost its tail. The exemption is one claim — step 3's finding, the reason it is
  // correct rather than broken, that no new base is resolved, and the named reason code — so it
  // is pinned as one contiguous phrase and a hedge ("may mean", "usually") breaks it.
  test("Crash recovery step 4 exempts the already-stacked story instead of parking it", () => {
    const body = crashRecovery();
    expect(body).toContain(
      "One state skips this step: if step 3 found the PR already open **and** the `stack` array " +
        "already records this story, the PR-opening step completed and only the tail of the run " +
        "was lost. That state is correct, not broken — resolve **no** new base for it, and " +
        "resume at §5 (post the summary comment). `resolve-base` refuses `story_already_stacked` " +
        'for exactly that state, and that one reason means "already stacked", never "park".',
    );
    // ...and the fence has to act on it, not merely describe it: the `case` arm is what an
    // unattended agent actually follows. Pinned on the literal branch, per MUST-CHECK
    // prose-pins-dont-cover-the-bash-fence-they-describe.
    const f = crashFence();
    expect(f).toContain(
      "story_already_stacked) echo \"ALREADY_STACKED: the PR is already recorded — resume at the " +
        'summary comment; resolve no base.";;',
    );
    // The generic park arm must still be the DEFAULT, so the exemption cannot widen into
    // "any refusal is fine".
    expect(f).toContain(
      '*) echo "PARK: resolve-base refused ($BASE_REASON) — park the story; paraphrase, never ' +
        'paste, the detail on stderr."; exit 1;;',
    );
  });

  // --- Fix pass (CRITICAL): the SECOND assert-chain site needs the same trust root -----------
  //
  // MUST-CHECK r3-must-not-source-project-dir-from-pasted-run-state is scoped verbatim to "R3
  // (PCO-366) and any later consumer of stack.ts assert-chain", and `--project-dir` is only a
  // trust root when its value comes from a FRESH `ship-config.ts validate` in the SAME bash
  // block. §4's pin (`CRITICAL 1`) reads a §4-scoped fence, so Crash recovery's new invocation
  // landed outside it with the suite green — MUST-CHECK
  // defense-applied-at-n-sites-needs-a-test-at-each-site in its documented form. This pin is
  // WHOLE-DOCUMENT: every `assert-chain` invocation anywhere in the runbook, in any section
  // added later, must sit in a fence that also carries the validate line and must anchor on
  // `$PROJECT_DIR`.
  // A fence nested inside a numbered list item is indented, so every pin that compares its lines
  // to an unindented fence's must strip the COMMON indent — not a fixed number of spaces, which
  // would leave continuation lines off by however much they are further indented.
  function dedent(block: string): string {
    const lines = block.split("\n");
    const indents = lines.filter((l) => l.trim().length > 0).map((l) => l.match(/^[ \t]*/)![0].length);
    const common = indents.length === 0 ? 0 : Math.min(...indents);
    return lines.map((l) => l.slice(common)).join("\n");
  }

  function shipBashFences(): { body: string; at: number }[] {
    const txt = shipRaw();
    const out: { body: string; at: number }[] = [];
    for (const m of txt.matchAll(/[ \t]*```bash\n([\s\S]*?)[ \t]*```/g)) {
      out.push({ body: m[1]!, at: m.index ?? 0 });
    }
    expect(out.length, "no bash fences found in the runbook — the extractor is broken").toBeGreaterThan(3);
    return out;
  }

  const VALIDATE_LINE =
    'RESOLVED=$(echo "$LINEAR_FACTS_JSON" | bun run "${CLAUDE_PLUGIN_ROOT}/scripts/lib/ship-config.ts" validate --config "$CONFIG")';

  test("EVERY assert-chain invocation in the runbook sits in a fence with a fresh ship-config validate and --project-dir \"$PROJECT_DIR\"", () => {
    const fences = shipBashFences();
    const txt = shipRaw();
    // Every invocation line, wherever it is — including one in no fence at all, which is the
    // shape this diff introduced.
    const allCalls = txt.split("\n").filter((l) => l.includes('stack.ts" assert-chain'));
    expect(allCalls.length, "no assert-chain invocations found — the extractor is broken").toBeGreaterThan(2);
    let seen = 0;
    for (const { body } of fences) {
      const calls = body.split("\n").filter((l) => l.includes('stack.ts" assert-chain'));
      if (calls.length === 0) continue;
      seen += calls.length;
      const dedented = dedent(body);
      expect(
        dedented,
        "a fence invoking assert-chain must derive --project-dir from a FRESH ship-config validate in the SAME block (MUST-CHECK r3-must-not-source-project-dir-from-pasted-run-state)",
      ).toContain(VALIDATE_LINE);
      expect(dedented, "the fence must derive $PROJECT_DIR from $RESOLVED, not from the run state").toContain(
        `PROJECT_DIR=$(echo "$RESOLVED" | jq -r '.projectDir // empty')`,
      );
      // The state file's own copy is never read in the executable body — that key exists only
      // there, and every legitimate mention of it in this runbook is a comment.
      const bodyNoComments = dedented
        .split("\n")
        .filter((l) => !l.trimStart().startsWith("#"))
        .join("\n");
      expect(bodyNoComments, "no executable line may read the run state's resolved_config").not.toContain(
        "resolved_config",
      );
      for (const call of calls) {
        expect(call).toContain(`--project-dir "$PROJECT_DIR"`);
        expect(call).not.toContain("jq");
      }
    }
    // Completeness: no invocation may sit outside a bash fence, free-hand, with the flags left
    // to an unattended agent to invent.
    expect(
      seen,
      `every assert-chain invocation must live inside a bash fence — ${allCalls.length} found in the doc, ${seen} inside fences`,
    ).toBe(allCalls.length);
  });

  // The fence Crash recovery gained, extracted on its own so the pins below are about IT and not
  // about §4's.
  function crashFence(): string {
    const txt = shipRaw();
    const start = txt.indexOf("## Crash recovery");
    const end = txt.indexOf("## Finishing the run", start);
    const fences = [...txt.slice(start, end).matchAll(/[ \t]*```bash\n([\s\S]*?)[ \t]*```/g)].map((m) => m[1]!);
    expect(fences.length, "Crash recovery must carry exactly one bash fence").toBe(1);
    return dedent(fences[0]!);
  }

  // The fence with COMMENT lines removed — every "must NOT contain" assertion runs against this,
  // for the reason §4's `code()` helper spells out: the comments legitimately name the forbidden
  // constructs (`.detail`, `jq '.resolved_config' "$STATE"`) in order to forbid them, so an
  // absence check over the raw text would be satisfiable only by deleting the explanation.
  function crashCode(): string {
    return crashFence()
      .split("\n")
      .filter((l) => !l.trimStart().startsWith("#"))
      .join("\n");
  }

  test("Crash recovery's fence re-runs BOTH of Preflight's $CONFIG guards, byte-identically", () => {
    const f = crashFence();
    const txt = shipRaw();
    const pfStart = txt.indexOf("## Preflight (halt on any failure)");
    const fenceStart = txt.indexOf("```bash", pfStart);
    const pf = txt.slice(fenceStart + 7, txt.indexOf("```", fenceStart + 7));
    const one = (block: string, prefix: string, label: string): string => {
      const hits = block.split("\n").filter((l) => l.startsWith(prefix));
      expect(hits.length, `${label}: expected exactly one line starting with ${JSON.stringify(prefix)}, found ${hits.length}`).toBe(1);
      return hits[0]!;
    };
    for (const prefix of ['CONFIG="${DRAWBAR_SHIP_CONFIG', '[ -f "$CONFIG" ]', "CONFIG_REAL="]) {
      expect(one(f, prefix, `Crash recovery's ${prefix}`)).toBe(one(pf, prefix, `Preflight's ${prefix}`));
    }
    const trackedPrefix = 'git -C "$(dirname "$CONFIG_REAL")" ls-files --error-unmatch';
    const guard = (block: string, label: string): string => {
      const lines = block.split("\n");
      const s = lines.findIndex((l) => l.startsWith(trackedPrefix));
      expect(s, `${label}: tracked-config guard not found`).toBeGreaterThan(-1);
      const e = lines.findIndex((l, i) => i >= s && l.trim() === "|| true");
      expect(e, `${label}: tracked-config guard's '|| true' not found`).toBeGreaterThan(s);
      return lines.slice(s, e + 1).join("\n");
    };
    expect(guard(f, "Crash recovery")).toBe(guard(pf, "Preflight"));
    // The guards must precede the validate they protect, and the validate must precede the
    // assert-chain that consumes its output. Order is the whole point.
    expect(f.indexOf("CONFIG_REAL=")).toBeLessThan(f.indexOf(trackedPrefix));
    expect(f.indexOf(trackedPrefix)).toBeLessThan(f.indexOf(VALIDATE_LINE));
    expect(f.indexOf(VALIDATE_LINE)).toBeLessThan(f.indexOf('stack.ts" assert-chain'));
    // $STATE is built from the VALIDATED envDir, never from a path already in context.
    expect(f).toContain('STATE="$ENV_DIR/.drawbar/runs/$ARG.json"');
  });

  // The prose half: the reason the fence exists at all has to be readable, and the forbidden
  // shortcut has to be named. Proven against a hedging rephrase ("prefer the fresh validate",
  // "the run state is usually fine") as well as deletion.
  test("Crash recovery names the fresh validate as --project-dir's only trust root, and forbids the run-state copy", () => {
    const body = crashRecovery();
    expect(body).toContain(
      "**`--project-dir` is a trust root, and this fence is the only sanctioned way to produce " +
        "one.** MUST-CHECK `r3-must-not-source-project-dir-from-pasted-run-state`: the value " +
        "handed to `--project-dir` comes from the fresh `ship-config.ts validate` inside this " +
        "block and from nowhere else — never `jq '.resolved_config' \"$STATE\"`, and never the " +
        "`resolved_config` that step 1 has already read into context.",
    );
    expect(body).toContain(
      "The state file is agent-writable, so a `--project-dir` taken from it turns `stack.ts`'s " +
        "equality guard into a tautology about whatever directory that file names, and hands " +
        "`git -C` a repository an attacker chose.",
    );
    expect(body).toContain(
      "Both of Preflight's guards therefore run again here, verbatim.",
    );
    expect(body).not.toMatch(/prefer the fresh validate|usually fine|where convenient|if convenient/i);
  });

  // --- Fix pass: the paraphrase rule is a Hard rule, and covers stack.ts too -----------------
  //
  // §4's fence comment claims "the Hard rules require refusal text be paraphrased rather than
  // pasted into `parked_reason`, the §5 comment, or a KB entry" — but the only paraphrase rule in
  // the file was an OPERATOR NOTE scoped to ship-config. Crash recovery's step 4 adds a third
  // refusal-producing call path, and `assert-chain`'s `detail` names both an absolute
  // `projectDir` and a branch. Public repo: MUST-CHECK drawbar-repo-is-public-scrub-before-porting.
  test("Hard rules carry the paraphrase-never-paste rule, scoped to every guard and every sink", () => {
    const rules = hardRules();
    expect(rules).toContain(
      "- **Any guard refusal text — `ship-config.ts`, `stack.ts`, `kb-sync.ts` alike — must be " +
        "paraphrased, never pasted**, into `parked_reason`, a Linear comment, or a KB entry. Echo " +
        "the verdict's `.reason` and nothing else: a `detail` carries absolute paths and the real " +
        "repo slug, and this repo is public.",
    );
    // The hedges that would leave the bullet recognisable while removing the rule.
    expect(rules).not.toMatch(/where possible|try not to paste|generally paraphrase/i);
  });

  test("the Operator notes paraphrase rule is not scoped to ship-config alone", () => {
    const notes = operatorNotesR6();
    expect(notes).toContain(
      "- **Any guard refusal text must be paraphrased, never pasted**, into a KB entry or a " +
        "Linear comment — `stack.ts`'s verdicts exactly as much as `ship-config.ts`'s, and a " +
        "`parked_reason` exactly as much as a comment.",
    );
    expect(notes).toContain(
      "Refusal `detail` strings echo absolute paths and the real repo slug (`assert-chain`'s name " +
        "a predecessor branch and the `projectDir` it was asked about)",
    );
    // The pre-fix wording, which left stack.ts verdicts and `parked_reason` uncovered.
    expect(notes).not.toContain("**Ship-config refusal text must be paraphrased");
  });

  // Every refusal echo in Crash recovery's fence extracts `.reason` and nothing else — the same
  // structural protection §4 has. A `.detail` reaching stdout is what gets pasted.
  test("Crash recovery's fence echoes .reason only, never .detail", () => {
    const f = crashFence();
    expect(crashCode(), "no executable line may read a verdict's `.detail`").not.toContain(".detail");
    const echoes = f.split("\n").filter((l) => l.includes("PARK:") || l.includes("ALREADY_STACKED:"));
    expect(echoes.length, "Crash recovery's refusal echoes not found").toBeGreaterThan(2);
    for (const e of echoes) {
      expect(e, `refusal echo must not interpolate a detail: ${e.slice(0, 120)}`).not.toContain("_DETAIL");
    }
    for (const verb of ["CHAIN", "BASE"]) {
      expect(f).toContain(
        `${verb}_REASON=$(printf '%s' "\${${verb}_JSON:-null}" | jq -r '.reason // "unreadable-verdict"' 2>/dev/null)`,
      );
    }
  });

  // Renumbering guard for this very edit: the section gained a step, so the list must still run
  // 1..7 with no repeat or gap, and the two steps that cross-reference step 2 must still say 2.
  test("Crash recovery's numbered steps run in sequence with no gap or repeat", () => {
    const raw = (() => {
      const txt = shipRaw();
      const start = txt.indexOf("## Crash recovery");
      return txt.slice(start, txt.indexOf("## Finishing the run", start));
    })();
    const steps = [...raw.matchAll(/^(\d+)\. /gm)].map((m) => Number(m[1]));
    expect(steps.length, "crash-recovery steps not found").toBeGreaterThan(5);
    expect(steps).toEqual(steps.map((_, i) => i + 1));
    // The resume step must point at the base the new step established, not re-derive one.
    expect(crashRecovery()).toContain("re-dispatch the story-lead pointing at that branch and at the base step 4 re-established");
  });

  // --- Hard rules and Operator notes, in a world with no merge -------------------------------

  function hardRules(): string {
    for (const m of ["## Hard rules", "## Operator notes"]) assertOccursOnce(m);
    const txt = shipRaw();
    const start = txt.indexOf("## Hard rules");
    const end = txt.indexOf("## Operator notes", start);
    expect(end, "'## Operator notes' not found after '## Hard rules'").toBeGreaterThan(start);
    return txt.slice(start, end).replace(/\s+/g, " ");
  }

  function operatorNotesR6(): string {
    assertOccursOnce("## Operator notes");
    const txt = shipRaw();
    return txt.slice(txt.indexOf("## Operator notes")).replace(/\s+/g, " ");
  }

  test("Hard rules state Locked F as a rule, not only as narrative", () => {
    expect(hardRules()).toContain(
      "**Locked F: never merge, never verify a merge, and never inspect whether one happened.** " +
        "There is no merge step, no merge check, and no out-of-order-merge detection or repair " +
        "anywhere in this command, and none is planned. The operator merges, bottom-up and in " +
        "order.",
    );
  });

  test("Hard rules pin the base rule on resolve-base and forbid re-deriving or omitting it", () => {
    expect(hardRules()).toContain(
      "`--base` comes from `scripts/lib/stack.ts`'s `resolveBase`, invoked as `stack.ts " +
        "resolve-base`: the configured `baseBranch` for the first story of a run, the previous " +
        "story's recorded branch for every story after that (Locked A). Never re-derive it in " +
        "bash, never read it out of the run-state file by hand, and never omit `--base`.",
    );
  });

  test("Hard rules keep flagged and no-PR distinct in kind", () => {
    expect(hardRules()).toContain(
      "A `flagged` story still gets its PR and the stack still continues on top of it; a story " +
        "with **no** PR parks and halts the run, because the chain has no anchor.",
    );
  });

  test("Operator notes state the morning contract: review bottom-up and merge bottom-up, in order", () => {
    expect(operatorNotesR6()).toContain(
      "**In the morning: review bottom-up and merge bottom-up, in order.**",
    );
    expect(operatorNotesR6()).toContain(
      "Only the bottom PR's diff is meaningful against the configured base; every PR above it " +
        "becomes meaningful as the one below it lands.",
    );
  });

  test("Operator notes tell the operator the stack's mergeability is theirs and nothing here checks it", () => {
    expect(operatorNotesR6()).toContain(
      "**Keeping the stack mergeable is yours, and nothing here checks it.** Per Locked F this " +
        "command never merges, never verifies a merge, and never inspects whether one happened " +
        "— there is no detection or repair of an out-of-order merge, and none is planned.",
    );
    // The sentence that stops a reader filing the "gap" as a bug. Pinned separately because it
    // is the end of the bullet, which is exactly where an escape hatch gets appended.
    expect(operatorNotesR6()).toContain(
      "This is a contract rather than a missing feature, so it is not something to file.",
    );
  });

  test("Operator notes explain a flagged PR is one to review, and that a parked story ends the stack", () => {
    expect(operatorNotesR6()).toContain(
      "**A `flagged` PR is a PR to review, not a failure.** Its `## Unresolved findings` section " +
        "names each surviving finding by sub-issue id and title; the write-ups are in those " +
        "Linear sub-issues, deliberately not in the public PR body.",
    );
    // MUST-CHECK pco352-fixpass-satisfies-the-gate-header-must-not-cover-a-repick-clause: the
    // bolded header above must NOT stand in for the clause that follows it. The operator-facing
    // half of the flagged-vs-no-PR distinction is this sentence, and it was the one place the two
    // outcomes could still be collapsed with the whole suite green — rewriting the tail to "the
    // same case, one notch further along" left every other flagged/no-PR pin (stack model, Hard
    // rules) untouched, because each reads a different slice of the file. Pinned in kind, and
    // the "same scale / same case / degrees" collapse refused by name.
    expect(operatorNotesR6()).toContain(
      "A story that could not open a PR at all is the other case entirely: the run parked and " +
        "stopped there, so the stack ends at the story below it.",
    );
    const notes = operatorNotesR6();
    expect(notes, "flagged and no-PR must never be presented as degrees of one outcome").not.toMatch(
      /(?:same (?:scale|case|outcome)|one notch|degrees of the same|both degraded)/i,
    );
  });

  // --- The two §1 Recall pins deferred from R4 -----------------------------------------------

  // R4's mutation gate found both of these and deliberately left them for R6. Both are in the
  // story-lead's §1, and both were entirely unpinned: the suite stayed green with the rule
  // weakened to "Prefer `$KB` as given where convenient", and green again with the MUST-CHECK
  // recall line deleted from the fence outright.
  function agentSectionOne(raw = false): string {
    const txt = agentRaw();
    for (const m of ["## 1. Recall", "## 2. Branch and implement"]) {
      const count = txt.split(m).length - 1;
      expect(count, `'${m}' must occur exactly once in ${AGENT}, found ${count}`).toBe(1);
    }
    const start = txt.indexOf("## 1. Recall");
    const end = txt.indexOf("## 2. Branch and implement", start);
    expect(end, "'## 2.' not found after '## 1. Recall'").toBeGreaterThan(start);
    const slice = txt.slice(start, end);
    return raw ? slice : slice.replace(/\s+/g, " ");
  }

  test("§1 pins the absolute-$KB rule, including the relative path it forbids and why", () => {
    expect(agentSectionOne()).toContain(
      "Use `$KB` exactly as given — it is absolute. Never `$PWD/.drawbar/memory`: you may be " +
        "running from a directory that has no `.drawbar`, and the path would silently point " +
        "nowhere.",
    );
  });

  // The weakening this pin exists to catch, asserted directly: a "prefer / where convenient"
  // rephrase leaves the imperative recognisable to a human skimming the diff while removing the
  // rule, and a relative KB path points nowhere silently rather than failing.
  test("§1's $KB rule is an imperative, never softened to a preference", () => {
    const body = agentSectionOne();
    expect(body).not.toMatch(/prefer\s+`?\$KB/i);
    expect(body).not.toMatch(/where convenient|if convenient|where possible/i);
    expect(body).toContain("Never `$PWD/.drawbar/memory`");
  });

  // Pinned on the LITERAL invocation line extracted from §1's raw fence, not on prose beside it
  // (MUST-CHECK prose-pins-dont-cover-the-bash-fence-they-describe): the claim names a query, a
  // flag and an output format, and deleting the line is exactly the mutation that stayed green.
  test("§1's fence carries BOTH recall invocations, literally, including the MUST-CHECK one", () => {
    const raw = agentSectionOne(true);
    const fences = [...raw.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(fences.length, "§1 must carry exactly one bash fence").toBe(1);
    const lines = fences[0]!.split("\n").filter((l) => l.trim().length > 0);
    expect(lines).toEqual([
      'drawbar-kb recall "<story title and files>" --dir "$KB" --json',
      'drawbar-kb recall "MUST-CHECK <stack>" --dir "$KB" --json',
    ]);
  });

  // Why the pin above matters more than a missing step usually does. MUST-CHECK
  // lead-brief-that-drops-a-recalled-must-check-manufactures-the-violation: the implementer
  // builds what the brief says, so a MUST-CHECK recalled and then omitted from the brief is not
  // merely unenforced — the brief instructs the violation. That has already shipped an ACE sink
  // in this repo (PCO-365).
  test("§1 states that every recalled MUST-CHECK goes into the implementer's brief, and why omitting one manufactures the violation", () => {
    const body = agentSectionOne();
    expect(body).toContain(
      "**Both recalls are mandatory, and every MUST-CHECK the second one returns goes into the " +
        "implementer's brief in §2 verbatim.**",
    );
    expect(body).toContain(
      "A MUST-CHECK you recalled and then left out of the brief is worse than one you never " +
        "recalled at all: the implementer builds what the brief says, so the brief actively " +
        "manufactures the violation rather than merely failing to prevent it.",
    );
    // Fix pass: the incident citation has to be TRUE, because a lead obeying a false one draws
    // the wrong lesson. On PCO-365 the entry was in the KB and the recall's query terms never
    // surfaced it — the brief instructed the sink, but not by dropping something it had seen. The
    // earlier wording ("an arbitrary-code-execution sink that the recalled entry named exactly")
    // told a lead that transcription is the whole risk and query shape is not.
    expect(body).toContain(
      "A brief that instructed exactly this has already shipped an arbitrary-code-execution sink " +
        "in this repo; the entry forbidding it was in the knowledge base but the recall's query " +
        "terms never surfaced it, so a recall that misses an entry and a brief that drops one " +
        "fail in the same direction.",
    );
    expect(body, "the entry was never surfaced by that recall — claiming otherwise is false").not.toContain(
      "that the recalled entry named exactly",
    );
  });

  // --- The story-lead's own no-merge statement -----------------------------------------------

  test("the story-lead states that nothing in the pipeline merges, and that the operator merges bottom-up", () => {
    const txt = agent();
    expect(txt).toContain(
      "**Nothing in this pipeline merges anything.** Your caller never merges, never verifies a " +
        "merge, and never inspects whether one happened; the operator reviews the stack in the " +
        "morning and merges it bottom-up by hand.",
    );
    // The consequence for the agent itself — the reason this paragraph is in the agent file and
    // not only in the runbook.
    expect(txt).toContain(
      "So there is no merge for you to prepare for, wait on, or leave room for: your work ends " +
        "at a pushed branch.",
    );
  });

  test("the story-lead no longer says its caller owns the merge", () => {
    expect(agent()).not.toContain("owns the merge");
  });
});
