import { test, expect, describe } from "bun:test";
import { readFileSync, mkdtempSync, writeFileSync, existsSync, mkdirSync, symlinkSync, rmSync, realpathSync } from "node:fs";
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

  test("Codex manifest matches the Claude plugin version and exposes skills", () => {
    const codex = JSON.parse(readFileSync(join(root, ".codex-plugin/plugin.json"), "utf8"));
    const claude = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
    expect(codex.name).toBe("drawbar");
    expect(codex.version).toBe(claude.version);
    expect(codex.skills).toBe("./skills/");
    expect(codex.interface.displayName).toBe("drawbar");
  });

  test("Codex marketplace points to the installable compatibility package", () => {
    const marketplace = JSON.parse(readFileSync(join(root, ".agents/plugins/marketplace.json"), "utf8"));
    const plugin = marketplace.plugins.find((entry: { name: string }) => entry.name === "drawbar");
    expect(marketplace.name).toBe("drawbar");
    expect(plugin?.source).toEqual({ source: "local", path: "./plugins/drawbar" });
    expect(plugin?.policy).toEqual({ installation: "AVAILABLE", authentication: "ON_INSTALL" });
    expect(readFileSync(join(root, "plugins/drawbar/.codex-plugin/plugin.json"), "utf8")).toBe(
      readFileSync(join(root, ".codex-plugin/plugin.json"), "utf8"),
    );
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

  for (const name of ["drawbar-setup", "drawbar-design", "drawbar-plan", "drawbar-work", "drawbar-learn", "drawbar-ship"]) {
    test(`${name} provides a Codex skill entry point`, () => {
      const fm = frontmatter(join(root, "skills", name, "SKILL.md"));
      expect(fm.name).toBe(name);
      expect((fm.description ?? "").length).toBeGreaterThan(0);
    });
  }
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
    // PCO-372/373 (fix pass): the two reviewer agent docs. Same precedent as I10 above — they are
    // shipped, permanently public, and agent-editable prose, and this is the first change to port
    // another team's retrospective incident detail INTO them (the modal harness, the PII blacklist
    // regex, the 17-row block), which is exactly the material the scrub exists to keep generic.
    // They were outside every rule until now. No live leak was found in either (verified against
    // all three ALL_FILES rules before adding); this closes the gap so the next story appending
    // retrospective prose to a reviewer doc is scanned too — public git history is not reversible,
    // so the coverage has to land before the leak, not after. Deliberately NOT added to the
    // owner/repo slug rule below: like knowledge.jsonl and this file, they are prose-heavy and
    // produce many ordinary word "/" word matches ("SQL/NoSQL", "debug/verbose", "Critical/
    // Important"), and an allowlist covering those would be unbounded — see MUST-CHECK
    // leak-scan-self-reference-needs-per-rule-file-scope.
    "agents/code-reviewer.md",
    "agents/security-reviewer.md",
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

  // Scan COVERAGE is itself unpinned without this. Every assertion above is generated per file in
  // the list, so dropping a file from the list deletes its tests and turns the suite green with
  // less coverage than before — a silent revert no red catches, and the exact shape of defect
  // PCO-372's rubric exists to name. Scoped to the two reviewer docs this fix pass added (the
  // first files to carry ported retrospective incident detail); the rest of the list is asserted
  // by its own longstanding tests, and widening this to every agent doc is a separate story.
  test("both reviewer agent docs stay inside the leak scan's file list", () => {
    for (const f of ["agents/code-reviewer.md", "agents/security-reviewer.md"]) {
      expect(ALL_FILES, `${f} must stay covered by the leak regression scan`).toContain(f);
      expect(existsSync(join(root, f))).toBe(true);
    }
  });
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



describe("version reconcile", () => {
  test("plugin.json and package.json report the same semver, and it isn't vacuously undefined", () => {
    const plugin = JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8"));
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    // Without this, `expect(pkg.version).toBe(plugin.version)` alone passes vacuously if
    // both `version` keys are missing (undefined === undefined).
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.version).toBe(plugin.version);
  });

  // The reconcile above pins the two files EQUAL, which any matching pair satisfies — including
  // a pair nobody meant to change. Pinning the value makes a bump a deliberate edit to a named
  // test rather than a side effect, and gives PCO-397's replay something to check the loaded
  // plugin against: the cache is keyed by plugin.json's version, so a replay run against a stale
  // build would pass confidently while exercising none of the new rules.
  test("the shipped version is 0.6.0 (Locked means the operator chose it; MUST-CHECK is rare; prose pins retired)", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    expect(pkg.version).toBe("0.6.0");
  });
});

describe("plugin tree symlink integrity (PCO-402)", () => {
  // Every .ts under plugins/drawbar/ must be a git symlink (index mode 120000) to the root
  // copy, never a real file: a real copy silently drifts out of sync with what actually ships.
  // plugins/drawbar/.codex-plugin/plugin.json is the one deliberate exception, covered by its
  // own byte-parity assertion above ("Codex marketplace points to the installable compatibility
  // package") -- this test is scoped to .ts files and does not touch it.
  test("every .ts file under plugins/drawbar/ is a git symlink, not a real file", () => {
    const res = Bun.spawnSync(["git", "ls-files", "-s", "plugins/drawbar"], { cwd: root });
    expect(res.exitCode).toBe(0);
    const lines = res.stdout.toString().trim().split("\n").filter((l) => l.length > 0);
    const tsEntries = lines
      .map((l) => {
        const [mode, , , ...pathParts] = l.split(/\s+/);
        return { mode: mode!, path: pathParts.join(" ") };
      })
      .filter((e) => e.path.endsWith(".ts"));
    // Guards against the assertion below passing vacuously if the tree ever stops containing
    // any tracked .ts files at all (e.g. a mass rename), which would make every() true on [].
    expect(tsEntries.length, "expected at least one tracked .ts file under plugins/drawbar/").toBeGreaterThan(0);
    for (const e of tsEntries) {
      expect(e.mode, `${e.path} is mode ${e.mode}, expected 120000 (a symlink)`).toBe("120000");
      // Mode 120000 alone is equally true of a symlink pointing at nothing: also require the
      // link to actually resolve, so a wrong relative depth (`../../../` vs `../../../../`) fails.
      expect(existsSync(join(root, e.path)), `${e.path} is a symlink but does not resolve`).toBe(true);
    }
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

  // PCO-371: §4's four inputs are written by the agent into the working tree (a deterministic
  // path, because the agent has to know where to write before the fence runs) instead of a
  // `mktemp -d`. The fence sweeps them with an EXIT trap on every path, but a run killed between
  // the Write calls and the fence leaves a PR body on disk — so the directory carries the same
  // self-ignoring `.gitignore` `.drawbar/runs/` does.
  test(".drawbar/tmp/.gitignore actually ignores everything but itself", () => {
    const txt = readNonEmpty(join(root, ".drawbar/tmp/.gitignore"));
    expect(txt).toMatch(/^\*$/m);
    expect(txt).toMatch(/^!\.gitignore$/m);
  });

  // Verified for real against git, not just by reading the pattern: the four paths §4 names are
  // the four that must never be stageable.
  test("git check-ignore really ignores each of §4's four written inputs", () => {
    for (const leaf of ["inputs.json", "branch", "title", "body"]) {
      const res = Bun.spawnSync(["git", "check-ignore", "-q", `.drawbar/tmp/ship/${leaf}`], { cwd: root });
      expect(res.exitCode, `.drawbar/tmp/ship/${leaf} is not ignored — a PR body could be committed`).toBe(0);
    }
    // The ignore file itself must stay tracked, or the protection travels with nobody.
    const self = Bun.spawnSync(["git", "check-ignore", "-q", ".drawbar/tmp/.gitignore"], { cwd: root });
    expect(self.exitCode, "the .gitignore must NOT ignore itself").not.toBe(0);
  });

  // PCO-371 fix pass, IMPORTANT: "exists on disk" is not "ships". The file was UNTRACKED when it
  // was first written, so the two tests above — which read it off the working tree — were green
  // whether or not it was ever committed, and the change under review would have landed without
  // it. `--error-unmatch` asks the INDEX, which is the only thing that travels.
  test(".drawbar/tmp/.gitignore is tracked by git, not merely present in the working tree", () => {
    const res = Bun.spawnSync(["git", "ls-files", "--error-unmatch", ".drawbar/tmp/.gitignore"], { cwd: root });
    expect(res.exitCode, ".drawbar/tmp/.gitignore is not tracked — it would not ship with the plugin").toBe(0);
    // The sibling it mirrors, asserted alongside so a passing run proves the check can distinguish
    // the two states rather than that `ls-files` happens to succeed for everything.
    expect(Bun.spawnSync(["git", "ls-files", "--error-unmatch", ".drawbar/runs/.gitignore"], { cwd: root }).exitCode).toBe(0);
    expect(
      Bun.spawnSync(["git", "ls-files", "--error-unmatch", ".drawbar/tmp/ship/body"], { cwd: root }).exitCode,
      "a §4 input is tracked — the ignore file is not doing its job",
    ).not.toBe(0);
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

  // The ONE ```json block in §4 — the inputs document the agent fills in and writes with the
  // Write tool. Raw, so a pin on it is a pin on the literal text the agent reads. It is data, not
  // shell: nothing about it is ever parsed by a shell, which is the whole point of PCO-371.
  function inputsTemplate(): string {
    const blocks = [...rawSection("## 4.", "## 5.").matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(blocks.length, "§4 must carry exactly one ```json inputs template").toBe(1);
    expect(blocks[0]!.length, "§4's inputs template is suspiciously short — did it get gutted?").toBeGreaterThan(80);
    return blocks[0]!;
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

  // --- §4's inputs directory, for real ---------------------------------------------------------
  // PCO-371's fix pass made both gates `$PWD`-relative: the directory gate compares
  // `readlink -f "$IN_DIR"` against `$PWD_REAL/.drawbar/tmp/ship`. A harness that set
  // `IN_DIR=<some mkdtemp>` would therefore be refused before reaching anything it meant to test,
  // and every "…was accepted" assertion below it would pass vacuously. So the fixtures build the
  // real tree and `cd` into it, and the shipped `IN_DIR=` line is used verbatim.
  const INPUT_LEAVES = ["inputs.json", "branch", "title", "body"] as const;
  function shipTree(): { cwd: string; dir: string } {
    const cwd = mkdtempSync(join(tmpdir(), "drawbar-cwd-"));
    const dir = join(cwd, ".drawbar", "tmp", "ship");
    mkdirSync(dir, { recursive: true });
    for (const leaf of INPUT_LEAVES) writeFileSync(join(dir, leaf), "x\n");
    return { cwd, dir };
  }
  function gateScript(cwd: string, tail: string[]): string {
    const dirGate = markedBlock("# --- inputs directory gate", "# --- end inputs directory gate");
    return [`cd '${cwd}'`, oneLine(code(), "IN_DIR=", "§4's inputs directory"), dirGate, ...tail].join("\n");
  }
  function gitInit(cwd: string): void {
    expect(
      Bun.spawnSync(["git", "init", "-q"], { cwd }).exitCode,
      "could not init a repository — the tracked-input case would be vacuous",
    ).toBe(0);
  }

  // Carries an arbitrary literal into a bash variable without this test file itself becoming
  // the injection vector: a QUOTED heredoc, exactly the mechanism §4's fence uses.
  function assignLiteral(name: string, value: string): string {
    return `${name}=$(cat <<'TEST_LITERAL_SENTINEL'\n${value}\nTEST_LITERAL_SENTINEL\n)`;
  }


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


  // The whole fence, parsed by bash. Only possible BECAUSE §4 no longer carries a fill-in slot:
  // with the heredocs gone there is no `<...>` placeholder left, so what the doc ships is what the
  // operator's shell runs, and a syntax error in it — an unbalanced quote in the cleanup trap, a
  // `case` missing its `esac` — is now catchable here instead of at 3am with a PR half-opened.
  test("CRITICAL 2: §4's fence is complete, substitution-free bash — it parses as-is", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "drawbar-parse-")), "section4.sh");
    writeFileSync(path, fence());
    const proc = Bun.spawn(["bash", "-n", path], { stdout: "pipe", stderr: "pipe" });
    const err = await new Response(proc.stderr).text();
    expect(await proc.exited, `§4's fence does not parse as bash:\n${err}`).toBe(0);
  });


  // PCO-371 fix pass. Two findings meet here. (1) The agent must know an ABSOLUTE path before §4's
  // fence runs and no shell state crosses two Bash tool calls, so Preflight prints it rather than
  // leaving it to be inferred. (2) The four inputs now live inside a git working tree that
  // `drawbar-story-lead` stages with `git add -A`, so a run that dies between the Write calls and
  // §4 leaves a PR body — carrying issue ids and team prefixes — stageable into the NEXT story's
  // commit and pushed to a public PR. The ignore file must therefore exist in whatever repository
  // the operator runs from, created BEFORE anything is written there: §4 is too late, because §4
  // is exactly what a killed run never reaches.
  test("CRITICAL 2: Preflight creates §4's inputs directory with its ignore file, and prints the path", async () => {
    const pf = preflightFence();
    const mk = oneLine(pf, "mkdir -p ", "Preflight's inputs-directory creation");
    const ign = oneLine(pf, "printf '%s\\n' '*' '!.gitignore'", "Preflight's inputs-directory ignore file");
    const say = oneLine(pf, 'echo "SHIP_CWD:', "Preflight's cwd announcement");
    expect(mk).toBe(
      `mkdir -p "$PWD/.drawbar/tmp/" || { echo "FATAL: cannot create $PWD/.drawbar/tmp/ — refusing."; exit 1; }`,
    );
    expect(ign).toBe(
      `printf '%s\\n' '*' '!.gitignore' > "$PWD/.drawbar/tmp/.gitignore" || ` +
        `{ echo "FATAL: cannot write $PWD/.drawbar/tmp/.gitignore — refusing."; exit 1; }`,
    );
    // The path the agent is told to Write under, printed from `$PWD` and not from anything the
    // repository under review can influence.
    expect(say).toBe('echo "SHIP_CWD: $PWD"');
    const lines = pf.split("\n");
    expect(lines.indexOf(mk), "the ignore file is written before its directory exists").toBeLessThan(lines.indexOf(ign));
    // Executed, against real git rather than by reading the pattern: what Preflight WRITES must
    // actually ignore all four inputs, and must not ignore itself.
    // Resolved at creation. `cd` keeps the LOGICAL path, so `$PWD` echoes back whatever it was
    // handed — and on macOS `$TMPDIR` sits under the `/var` -> `/private/var` symlink, so an
    // unresolved `mkdtemp` path and its `realpath` are two different strings for one directory.
    // Handing `cd` an already-resolved path makes the two agree on every platform.
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), "drawbar-pf-")));
    gitInit(cwd);
    const { exitCode, output } = await runScript([`cd '${cwd}'`, mk, ign, say].join("\n"));
    expect(exitCode, `Preflight's scaffolding did not run: ${output}`).toBe(0);
    expect(output.trim(), "SHIP_CWD did not print the working directory").toBe(`SHIP_CWD: ${realpathSync(cwd)}`);
    for (const leaf of INPUT_LEAVES) {
      expect(
        Bun.spawnSync(["git", "check-ignore", "-q", `.drawbar/tmp/ship/${leaf}`], { cwd }).exitCode,
        `${leaf} is not ignored by the file Preflight writes — a killed run leaves it stageable`,
      ).toBe(0);
    }
    expect(
      Bun.spawnSync(["git", "check-ignore", "-q", ".drawbar/tmp/.gitignore"], { cwd }).exitCode,
      "the ignore file Preflight writes ignores itself",
    ).not.toBe(0);
  });


  // Executed. The gate is what makes a deterministic, reusable path safe: it refuses unless all
  // four inputs are there as regular files, so a story whose inputs were not all rewritten is
  // refused instead of silently inheriting the PREVIOUS story's branch, title or body — and it
  // refuses a symlink, so a pre-planted one cannot redirect the read.
  test("CRITICAL 2: the shipped inputs-file gate refuses a missing input and a symlinked one (run for real)", async () => {
    const gate = markedBlock("# --- inputs file gate", "# --- end inputs file gate");
    const paths = ["INPUTS", "BRANCH_FILE", "PR_TITLE_FILE", "PR_BODY_FILE"].map((n) =>
      oneLine(code(), `${n}=`, `§4's ${n} path`),
    );
    async function runGate(prepare: (dir: string, cwd: string) => void): Promise<number> {
      const { cwd, dir } = shipTree();
      prepare(dir, cwd);
      const { exitCode } = await runScript(gateScript(cwd, [...paths, gate, "echo GATE_OK"]));
      return exitCode;
    }
    // All four present as regular files — the accept path, so the refusals below are not vacuous.
    expect(await runGate(() => {})).toBe(0);
    for (const leaf of INPUT_LEAVES) {
      expect(await runGate((dir) => rmSync(join(dir, leaf))), `a missing ${leaf} was accepted`).not.toBe(0);
      // The symlink TARGET is a real regular file, so `-f` alone is satisfied and only the
      // `! -L` conjunct can refuse. A dangling symlink would fail `-f` too and prove nothing —
      // dropping `! -L` would survive that (MUST-CHECK vacuous-assertion-needs-preseed-state).
      expect(
        await runGate((dir) => {
          writeFileSync(join(dir, "decoy"), "planted\n");
          rmSync(join(dir, leaf));
          symlinkSync(join(dir, "decoy"), join(dir, leaf));
        }),
        `a symlinked ${leaf} was accepted`,
      ).not.toBe(0);
      // PCO-371 fix pass, CRITICAL: a ZERO-BYTE input passed every conjunct of the original gate.
      // An empty `body` opens a PR with no review-provenance line and no `## Unresolved findings`
      // section at all, on the unattended path, with `PR_OPENED:` still printed and the stack
      // entry still recorded — the disclosure IMPORTANT 9 and PCO-375 exist to guarantee gone
      // silently. Asserted per input, so `-s` on `body` alone is not enough.
      expect(await runGate((dir) => writeFileSync(join(dir, leaf), "")), `an empty ${leaf} was accepted`).not.toBe(0);
      // PCO-371 fix pass, IMPORTANT: file-NESS is not provenance. A branch under review can COMMIT
      // four ordinary regular files at these names; they satisfy `-f`, `-s` and `! -L` on the very
      // first run, before any EXIT trap has ever fired, and the fence would then consume
      // attacker-authored `arg`/`story`/`teams` — which name the state file, pick the base, and
      // reach `ship-config.ts validate` on stdin. Refused exactly as a tracked `$CONFIG` is.
      expect(
        await runGate((dir, cwd) => {
          gitInit(cwd);
          expect(
            Bun.spawnSync(["git", "add", "-f", join(dir, leaf)], { cwd }).exitCode,
            `could not stage ${leaf} — the tracked-input case would be vacuous`,
          ).toBe(0);
        }),
        `a git-tracked ${leaf} was accepted`,
      ).not.toBe(0);
    }
    // A directory in place of a file is refused too — `-f` is doing that work, not `-e`.
    expect(
      await runGate((dir) => {
        rmSync(join(dir, "body"));
        mkdirSync(join(dir, "body"));
      }),
    ).not.toBe(0);
    // …and the untracked accept path is re-proved INSIDE a real repository, so the tracked
    // refusals above are the tracking and not merely the presence of a `.git` directory.
    expect(await runGate((_dir, cwd) => gitInit(cwd)), "an untracked input inside a repo was refused").toBe(0);
  });

  // Executed. PCO-371 fix pass, CRITICAL: `-L` on the four LEAF paths cannot see a symlink on an
  // intermediate component. `IN_DIR` is entirely predictable, so a branch under review can commit
  // `.drawbar/tmp/ship` as a DIRECTORY SYMLINK (git stores mode 120000 and it survives checkout),
  // and both the agent's Write step and the EXIT trap's `rm -f` follow it: four fixed-name files
  // truncated, then unlinked, at any absolute path, under the operator's identity, every run.
  test("CRITICAL 2: the shipped directory gate refuses a symlinked path component, before the trap is armed", async () => {
    const dirGate = markedBlock("# --- inputs directory gate", "# --- end inputs directory gate");
    const c = code();
    const paths = ["INPUTS", "BRANCH_FILE", "PR_TITLE_FILE", "PR_BODY_FILE"].map((n) =>
      oneLine(c, `${n}=`, `§4's ${n} path`),
    );
    const trapLine = oneLine(c, "trap ", "§4's inputs cleanup trap");
    const gate = markedBlock("# --- inputs file gate", "# --- end inputs file gate");
    // The whole prelude, in shipped order: directory gate, paths, trap, file gate.
    const tail = [...paths, trapLine, gate, "echo GATE_OK"];
    // Accept path: a real directory, so every refusal below is not vacuous.
    {
      const { cwd } = shipTree();
      expect((await runScript(gateScript(cwd, tail))).exitCode, "a genuine inputs directory was refused").toBe(0);
    }
    // Refusal path: `ship` is a symlink to a directory of the attacker's choosing, holding four
    // real regular files. Every conjunct of the FILE gate is satisfied — only the directory gate
    // can refuse this — and the victim's files must still be there afterwards, which is what
    // proves the gate runs before the trap that would have swept them.
    {
      const { cwd, dir } = shipTree();
      const victim = join(cwd, "victim");
      mkdirSync(victim);
      for (const leaf of INPUT_LEAVES) writeFileSync(join(victim, leaf), "operator's own file\n");
      rmSync(dir, { recursive: true });
      symlinkSync(victim, dir);
      const { exitCode } = await runScript(gateScript(cwd, tail));
      expect(exitCode, "a symlinked inputs DIRECTORY was accepted").not.toBe(0);
      for (const leaf of INPUT_LEAVES) {
        expect(existsSync(join(victim, leaf)), `the cleanup trap unlinked ${leaf} through the symlink`).toBe(true);
      }
    }
    // …and the same for a symlink one level up, which `readlink -f` on the leaf directory alone
    // would resolve past.
    {
      const { cwd } = shipTree();
      const victim = join(cwd, "elsewhere");
      mkdirSync(join(victim, "ship"), { recursive: true });
      for (const leaf of INPUT_LEAVES) writeFileSync(join(victim, "ship", leaf), "operator's own file\n");
      rmSync(join(cwd, ".drawbar", "tmp"), { recursive: true });
      symlinkSync(victim, join(cwd, ".drawbar", "tmp"));
      expect((await runScript(gateScript(cwd, tail))).exitCode, "a symlinked `tmp` component was accepted").not.toBe(0);
      for (const leaf of INPUT_LEAVES) {
        expect(existsSync(join(victim, "ship", leaf)), `the cleanup trap unlinked ${leaf}`).toBe(true);
      }
    }
    // A checkout REACHED through a symlink is not refused — both sides are `readlink -f`-resolved,
    // so the gate rejects a redirected component, not an operator whose home is a symlink.
    {
      const { cwd } = shipTree();
      const alias = join(mkdtempSync(join(tmpdir(), "drawbar-alias-")), "link");
      symlinkSync(cwd, alias);
      expect((await runScript(gateScript(alias, tail))).exitCode, "a symlink-reached checkout was refused").toBe(0);
    }
    // The gate is armed BEFORE the trap in the shipped fence, by LINE index — a comment naming
    // the trap sits above it, so a substring search would report the wrong order.
    const fenceLines = fence().split("\n");
    const dirGateAt = fenceLines.findIndex((l) => l.startsWith("# --- inputs directory gate"));
    expect(dirGateAt, "the inputs directory gate marker is not in the fence").toBeGreaterThan(-1);
    expect(dirGateAt, "the directory gate runs after the trap that would delete through the symlink").toBeLessThan(
      fenceLines.indexOf(trapLine),
    );
    // …and it is the equality against the recomputed path doing the work, not a bare `-d`.
    expect(dirGate).toContain('[ "$IN_REAL" = "$PWD_REAL/.drawbar/tmp/ship" ] ||');
  });

  // Executed. The EXIT trap is the other half of what `mktemp -d` used to give for free: a fresh
  // directory per story. With a fixed path, staleness is the new failure mode — story N+1 opening
  // a PR with story N's title because one Write was skipped — so the four files are removed
  // however the block ends, and the gate above then refuses the next story outright.
  test("CRITICAL 2: the shipped EXIT trap removes all four inputs on both the success and the refusal path", async () => {
    const c = code();
    const trapLine = oneLine(c, "trap ", "§4's inputs cleanup trap");
    expect(trapLine).toBe(`trap 'rm -f "$INPUTS" "$BRANCH_FILE" "$PR_TITLE_FILE" "$PR_BODY_FILE"' EXIT`);
    // It is armed BEFORE the gate that can exit, or a refusal leaves the inputs behind for the
    // next story to inherit. Compared by LINE index over the fence, not by `indexOf("trap ")` over
    // its text: the comment above the trap explains it by name, so a substring search finds the
    // explanation and reports the right order however the code is actually arranged.
    const fenceLines = fence().split("\n");
    const trapAt = fenceLines.indexOf(trapLine);
    const gateAt = fenceLines.findIndex((l) => l.startsWith("# --- inputs file gate"));
    expect(trapAt, "the cleanup trap line is not in the fence").toBeGreaterThan(-1);
    expect(gateAt, "the inputs file gate marker is not in the fence").toBeGreaterThan(-1);
    expect(trapAt, "the cleanup trap is armed after the gate that can exit").toBeLessThan(gateAt);
    const paths = ["INPUTS", "BRANCH_FILE", "PR_TITLE_FILE", "PR_BODY_FILE"].map((n) =>
      oneLine(c, `${n}=`, `§4's ${n} path`),
    );
    const gate = markedBlock("# --- inputs file gate", "# --- end inputs file gate");
    async function survivors(tail: string, missing?: string): Promise<string[]> {
      const { cwd, dir } = shipTree();
      if (missing) rmSync(join(dir, missing));
      await runScript(gateScript(cwd, [...paths, trapLine, gate, tail]));
      return INPUT_LEAVES.filter((leaf) => existsSync(join(dir, leaf)));
    }
    expect(await survivors("exit 0"), "an input survived the success path").toEqual([]);
    // The refusal path: `title` was never written, the gate exits 1, and the three that WERE
    // written must still be swept — otherwise the next story inherits them.
    expect(await survivors("exit 0", "title"), "an input survived the gate's refusal").toEqual([]);
  });


  // Executed, against the doc's OWN read lines: a hostile branch value cannot reach `arg` or
  // `story`. The test writes the two files the way the agent's Write calls do (through a quoted
  // heredoc HERE, so this test file is not itself the injection vector — the shipped doc has
  // none) and then runs the shipped read block verbatim.
  test("CRITICAL 2: a branch value carrying JSON syntax cannot override arg or story (run for real)", async () => {
    const read = markedBlock("# --- read the written inputs", "# --- end read the written inputs");
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

});

// --- Mechanical invariants -------------------------------------------------------------------
// These check shipped docs against code, git state, or a shape a grep can hold. Tests that pinned
// the wording of a prompt were retired: they could only catch a sentence being deleted, never a
// sentence being wrong, and they made every prompt edit a test edit.

function shippedDocs(): string[] {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const out: string[] = [];
  for (const dir of ["commands", "agents"]) {
    for (const f of readdirSync(join(root, dir))) {
      if (f.endsWith(".md")) out.push(join(dir, f));
    }
  }
  for (const d of readdirSync(join(root, "skills"))) {
    const skill = join("skills", d, "SKILL.md");
    if (existsSync(join(root, skill))) out.push(skill);
  }
  expect(shippedDocsCount(out)).toBeGreaterThan(0);
  return out;
}
function shippedDocsCount(docs: string[]): number {
  return docs.length;
}

describe("shipped docs agree with the code they describe", () => {
  test("ship §0's state-file schema declares exactly run-state.ts's REQUIRED_KEYS", () => {
    assertOccursOnce("## 0.");
    assertOccursOnce("## 1.");
    const txt = readNonEmpty(join(root, "commands/drawbar-ship.md"));
    const start = txt.indexOf("## 0.");
    const s0 = txt.slice(start, txt.indexOf("## 1.", start));
    const codeBlock = s0.match(/```\n\{[\s\S]*?\n\}\n```/);
    expect(codeBlock, "no fenced JSON schema block found in §0").not.toBeNull();
    const topLevelKeys = [...codeBlock![0].matchAll(/^ {2}"(\w+)":/gm)].map((m) => m[1]!);
    expect(new Set(topLevelKeys)).toEqual(new Set(REQUIRED_KEYS));
  });

  test("every bash fence in a shipped doc parses with bash -n", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drawbar-fences-"));
    let seen = 0;
    for (const rel of shippedDocs()) {
      const txt = readNonEmpty(join(root, rel));
      const fences = [...txt.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]!);
      for (const [i, body] of fences.entries()) {
        // A fence carrying a `<placeholder>` is a template the agent fills in, not a script.
        if (/<[a-z][^>\n]*>/.test(body)) continue;
        seen++;
        const path = join(dir, `${rel.replace(/[\/.]/g, "_")}_${i}.sh`);
        writeFileSync(path, body);
        const proc = Bun.spawn(["bash", "-n", path], { stdout: "pipe", stderr: "pipe" });
        const err = await new Response(proc.stderr).text();
        expect(await proc.exited, `${rel} fence #${i} does not parse as bash:\n${err}`).toBe(0);
      }
    }
    expect(seen, "no substitution-free bash fences found — the scan is vacuous").toBeGreaterThan(5);
  });
});

describe("no shipped instruction hardcodes a team, a project, or a per-worktree store path", () => {
  // `$PWD/.drawbar/memory` may be NAMED in order to forbid it; it may not be USED.
  test("no shipped doc instructs an agent to use $PWD/.drawbar/memory", () => {
    const offenders: string[] = [];
    for (const rel of shippedDocs()) {
      for (const line of readNonEmpty(join(root, rel)).split("\n")) {
        if (/--dir\s+"?\$PWD\/\.drawbar\/memory|=\s*"?\$PWD\/\.drawbar\/memory|-d\s+"\$PWD\/\.drawbar\/memory"/.test(line)) {
          offenders.push(`${rel}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, "resolve the store with `drawbar-kb path`").toEqual([]);
  });

  test("no shipped doc names the authoring workspace's team or project as the one to file against", () => {
    const offenders: string[] = [];
    for (const rel of shippedDocs()) {
      for (const line of readNonEmpty(join(root, rel)).split("\n")) {
        if (/team\s+\*\*PCO\*\*|project\s+\*\*DRAWBAR\*\*|\bPCO-id\b/.test(line)) {
          offenders.push(`${rel}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, "the team comes from .drawbar/config.json; the project comes from --project").toEqual([]);
  });

  test("the shipped example config documents every key the resolver accepts", () => {
    const example = JSON.parse(readNonEmpty(join(root, ".drawbar/config.example.json"))) as Record<string, unknown>;
    expect(Object.keys(example).sort()).toEqual(["memoryDir", "project", "team"]);
  });
});

describe("nothing in the pipeline merges or re-parents a story", () => {
  // Built from parts so this file never contains the needle it scans for.
  const ghPrMerge = new RegExp(["gh", "pr", "merge"].join("\\s+"), "i");

  test("`gh pr merge` appears in no tracked file outside the KB, the historical specs, and this file", () => {
    const proc = Bun.spawnSync(["git", "ls-files"], { cwd: root });
    expect(proc.exitCode).toBe(0);
    const files = proc.stdout
      .toString()
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .filter((l) => !l.startsWith(".drawbar/memory/") && !l.startsWith("docs/superpowers/") && l !== "scripts/plugin.test.ts")
      .map((rel) => join(root, rel))
      .filter((abs) => existsSync(abs));
    expect(files.length, "the scan covered too few files to mean anything").toBeGreaterThan(20);
    const offenders = files.filter((f) => ghPrMerge.test(readFileSync(f, "utf8")));
    expect(offenders).toEqual([]);
  });

  test("no shipped doc hardcodes --base main", () => {
    const offenders: string[] = [];
    for (const rel of shippedDocs()) {
      for (const line of readNonEmpty(join(root, rel)).split("\n")) {
        if (/--base\s+"?main"?\b/.test(line)) offenders.push(`${rel}: ${line.trim()}`);
      }
    }
    expect(offenders, "the base is $BASE_BRANCH from resolve-base, never the repo default").toEqual([]);
  });
});

describe("agents are handed the resolved store", () => {
  test("every drawbar-kb recall/add invocation in an agent doc passes --dir \"$KB\"", () => {
    const { readdirSync } = require("node:fs") as typeof import("node:fs");
    const agents = readdirSync(join(root, "agents")).filter((f) => f.endsWith(".md"));
    const offenders: string[] = [];
    let seen = 0;
    for (const f of agents) {
      for (const line of readNonEmpty(join(root, "agents", f)).split("\n")) {
        if (!/drawbar-kb\s+(recall|add)\b/.test(line)) continue;
        seen++;
        if (!line.includes('--dir "$KB"')) offenders.push(`agents/${f}: ${line.trim()}`);
      }
    }
    expect(seen, "no drawbar-kb invocations found — this scan is vacuous").toBeGreaterThan(2);
    expect(offenders, "hand the resolved store through as `$KB`, never a placeholder").toEqual([]);
  });
});

describe("durable text is anchored by symbol, not line number", () => {
  // Reviewers are the deliberate exception: they read one pinned sha and report the same sitting.
  test("no ticket-writing doc instructs the author to write a `file:line` anchor", () => {
    const AUTHORS = [
      "commands/drawbar-design.md",
      "commands/drawbar-plan.md",
      "commands/drawbar-work.md",
      "commands/drawbar-ship.md",
      "agents/drawbar-story-lead.md",
      "agents/story-implementer.md",
    ];
    for (const rel of AUTHORS) {
      for (const line of readNonEmpty(join(root, rel)).split("\n")) {
        // A line forbidding the shape names it in order to forbid it.
        if (/\bno |never |not |carries no |forbid|named here beside/i.test(line)) continue;
        expect(line, `${rel}: ${line.trim()}`).not.toContain("file:line");
      }
    }
  });
});
