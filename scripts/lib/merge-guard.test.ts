import { test, expect, describe } from "bun:test";
import { mergeVerdict, recordMergeSha, lc, main, type VerdictInput, type MainDeps } from "./merge-guard";
import type { ResolvedConfig, Runner } from "./ship-config";

// A structurally-valid resolved_config used as the shared happy-path fixture — placeholder
// org/repo shape, same discipline ship-config.test.ts and run-state.test.ts use, so this file
// (itself leak-scanned — see scripts/plugin.test.ts) never trips the issue-id/slug rules.
const VALID_RESOLVED: ResolvedConfig = {
  envDir: "/tmp/fixture-env-dir",
  projectDir: "/tmp/fixture-project-dir",
  repo: "acme/widgets",
  team: "PLAT",
  baseBranch: "main",
  mergedStatus: "Pre-QA",
  requiredChecks: ["build"],
  observed: {
    projectDirRemote: "acme/widgets",
    envDirRemote: "acme/widgets-kb",
    defaultBranch: "main",
  },
};

const HAPPY_VIEW = { code: 0, stdout: "user/abc-1-slug main OPEN 5\n" };
const HAPPY_CHECKS = {
  code: 0,
  stdout: JSON.stringify([
    { name: "build", bucket: "pass" },
    { name: "CodeRabbit", bucket: "pass" },
  ]),
};
// Fix pass (Critical 3): the PR-diff refusal now reads from the files API
// (`gh api repos/<repo>/pulls/<pr>/files`), not `gh pr diff --name-only` — see the module
// comment on `SHIP_CONFIG_BASENAME` for why (rename-source visibility, `gh pr diff`'s 300-file
// cap). Fixture content is unchanged (a newline-separated file list) since that is exactly
// what `.[] | .filename, (.previous_filename // empty)` produces.
const HAPPY_FILES = { code: 0, stdout: "src/index.ts\nREADME.md\n" };

type GhResponses = {
  view?: { code: number; stdout: string; stderr?: string };
  checks?: { code: number; stdout: string; stderr?: string };
  files?: { code: number; stdout: string; stderr?: string };
  // Important F: `gh repo view <repo> --json defaultBranchRef` — the INDEPENDENTLY observed
  // default branch mergeVerdict now conjoins with `resolvedConfig.baseBranch` (see the
  // "independently-observed default branch" describe block below). Defaults to "main" so every
  // existing fixture (which all use VALID_RESOLVED's baseBranch:"main") keeps passing without
  // being touched; the two TRUNK_RESOLVED tests override it explicitly.
  repoView?: { code: number; stdout: string; stderr?: string };
};

const DEFAULT_REPO_VIEW = { code: 0, stdout: "main\n" };

// Keyed by argv[0]/argv[1] ("pr view" | "pr checks" | "repo view") and argv[0] === "api" for
// the files-API call — a call-counter spy, so refusal tests can assert the guard genuinely
// evaluated the fixture and stopped early, per MUST-CHECK vacuous-assertion-needs-preseed-state.
function makeGhSpy(responses: GhResponses): { gh: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: Runner = (argv) => {
    calls.push(argv);
    if (argv[0] === "pr" && argv[1] === "view" && responses.view) return responses.view;
    if (argv[0] === "pr" && argv[1] === "checks" && responses.checks) return responses.checks;
    if (argv[0] === "repo" && argv[1] === "view") return responses.repoView ?? DEFAULT_REPO_VIEW;
    if (argv[0] === "api" && responses.files) return responses.files;
    return { code: 1, stdout: "", stderr: `unexpected gh call in test fixture: ${argv.join(" ")}` };
  };
  return { gh, calls };
}

function happyGhSpy(): { gh: Runner; calls: string[][] } {
  return makeGhSpy({ view: HAPPY_VIEW, checks: HAPPY_CHECKS, files: HAPPY_FILES });
}

function baseInput(overrides: Partial<VerdictInput>, gh: Runner): VerdictInput {
  return {
    story: "ABC-1",
    pr: "42",
    repo: "acme/widgets",
    resolvedConfig: VALID_RESOLVED,
    snapshot: ["ABC-1"],
    gh,
    ...overrides,
  };
}

describe("mergeVerdict — identity / base / state / snapshot (existing behaviour, now pinned)", () => {
  test("branch names the story case-insensitively -> ok", () => {
    const { gh } = happyGhSpy();
    const v = mergeVerdict(baseInput({}, gh));
    expect(v).toEqual({ ok: true });
  });

  test("branch not naming the story -> refuse, and never reaches checks/files (guard actually evaluated the fixture)", () => {
    const { gh, calls } = makeGhSpy({ view: { code: 0, stdout: "someone/unrelated-branch main OPEN 5\n" } });
    const v = mergeVerdict(baseInput({}, gh));
    expect(v).toEqual({ ok: false, reason: "branch_identity_mismatch", detail: "someone/unrelated-branch" });
    expect(calls.length).toBe(1); // only the `view` call — checks/files never reached
  });

  test("base is not baseBranch -> refuse", () => {
    const { gh, calls } = makeGhSpy({ view: { code: 0, stdout: "user/abc-1-slug develop OPEN 5\n" } });
    const v = mergeVerdict(baseInput({}, gh));
    expect(v).toEqual({ ok: false, reason: "base_mismatch", detail: "develop" });
    expect(calls.length).toBe(1);
  });

  test("PR state is not OPEN -> refuse", () => {
    const { gh, calls } = makeGhSpy({ view: { code: 0, stdout: "user/abc-1-slug main CLOSED 5\n" } });
    const v = mergeVerdict(baseInput({}, gh));
    expect(v).toEqual({ ok: false, reason: "pr_not_open", detail: "CLOSED" });
    expect(calls.length).toBe(1);
  });

  test("story not in the snapshot -> refuse, before any gh call at all (proves it isn't a network failure in disguise)", () => {
    const { gh, calls } = happyGhSpy();
    const v = mergeVerdict(baseInput({ snapshot: ["OTHER-1", "OTHER-2"] }, gh));
    expect(v).toEqual({ ok: false, reason: "story_not_in_snapshot", detail: "ABC-1" });
    expect(calls.length).toBe(0);
  });

  test("story present among OTHER snapshot members (non-trivial fixture) still passes the snapshot gate", () => {
    const { gh } = happyGhSpy();
    const v = mergeVerdict(baseInput({ snapshot: ["OTHER-1", "ABC-1", "OTHER-2"] }, gh));
    expect(v).toEqual({ ok: true });
  });

  // lc() self-test equivalent (Preserve decision): the bash guard this replaces asserted
  // `[ "$(lc ABC-1)" = "abc-1" ]` inline before trusting the identity comparison at all. `lc`
  // is exported here so that exact one-line assertion survives the extraction verbatim,
  // rather than only being provable indirectly through mergeVerdict's behavior.
  test("lc() lowercases — the self-test the old bash guard ran inline", () => {
    expect(lc("ABC-1")).toBe("abc-1");
  });

  test("identity comparison is genuinely case-insensitive in BOTH directions, not vacuously true", () => {
    // story lowercase, branch uppercase — only passes if the fold runs both ways.
    const { gh: gh1 } = makeGhSpy({ view: { code: 0, stdout: "user/ABC-1-SLUG main OPEN 5\n" }, checks: HAPPY_CHECKS, files: HAPPY_FILES });
    expect(mergeVerdict(baseInput({ story: "abc-1", snapshot: ["abc-1"] }, gh1))).toEqual({ ok: true });

    // A near-miss (different digits) must still be refused — proves the match isn't "always
    // true regardless of case," which a vacuous fold could otherwise hide.
    const { gh: gh2 } = makeGhSpy({ view: { code: 0, stdout: "user/ABC-2-SLUG main OPEN 5\n" } });
    const v2 = mergeVerdict(baseInput({ story: "abc-1", snapshot: ["abc-1"] }, gh2));
    expect(v2.ok).toBe(false);
  });

  // Important G: branch identity was an UNBOUNDED substring test (`includes`) — story "ABC-1"
  // also matches a branch for a DIFFERENT story whose id starts with the same digit(s) followed
  // by more digits, a routine, non-adversarial collision (not the suffix-attack case Round 1
  // pinned; this is a correctness bug on ordinary Linear auto-generated branch names).
  // Delimiter-bounded on both sides, while still allowing arbitrary prefixes/suffixes around
  // the story id. (Fixture ids below are deliberately lowercase and multi-digit — this file is
  // itself leak-scanned for concrete uppercase issue-id shapes; a lowercase branch segment
  // doesn't match that rule, and `mergeVerdict` compares case-insensitively anyway.)
  test("Important G: story 'ABC-1' does not match a branch for a DIFFERENT, longer story id sharing its leading digit (unbounded substring collision)", () => {
    const { gh, calls } = makeGhSpy({ view: { code: 0, stdout: "user/abc-12-other-slug main OPEN 5\n" } });
    const v = mergeVerdict(baseInput({}, gh));
    expect(v).toEqual({ ok: false, reason: "branch_identity_mismatch", detail: "user/abc-12-other-slug" });
    expect(calls.length).toBe(1);
  });

  test("Important G: an arbitrary PREFIX before the story id still matches (delimiter-bounded, not anchored)", () => {
    const { gh } = makeGhSpy({ view: { code: 0, stdout: "attacker-prefix/abc-1 main OPEN 5\n" }, checks: HAPPY_CHECKS, files: HAPPY_FILES });
    const v = mergeVerdict(baseInput({}, gh));
    expect(v).toEqual({ ok: true });
  });

  test("Important G: the ordinary Linear-generated branch shape (user/<story>-slug) still matches", () => {
    const { gh } = makeGhSpy({ view: { code: 0, stdout: "user/abc-1-slug main OPEN 5\n" }, checks: HAPPY_CHECKS, files: HAPPY_FILES });
    const v = mergeVerdict(baseInput({}, gh));
    expect(v).toEqual({ ok: true });
  });

  test("Important G: story 'ABC-1' does not match a branch for a DIFFERENT, longer story id sharing its leading digit, three digits long", () => {
    const { gh } = makeGhSpy({ view: { code: 0, stdout: "user/abc-100-slug main OPEN 5\n" } });
    const v = mergeVerdict(baseInput({}, gh));
    expect(v).toEqual({ ok: false, reason: "branch_identity_mismatch", detail: "user/abc-100-slug" });
  });
});

// Fix pass, I6: every fixture above (and below) pins baseBranch:"main" — a mutation
// hardcoding the base comparison to the literal "main" survives all of them. These two cases
// discriminate in BOTH directions, restoring the coverage the deleted plugin.test.ts fixtures
// had (they used "trunk").
describe("mergeVerdict — baseBranch is genuinely parameterized, not hardcoded to 'main' (I6)", () => {
  const TRUNK_RESOLVED: ResolvedConfig = {
    ...VALID_RESOLVED,
    baseBranch: "trunk",
    observed: { ...VALID_RESOLVED.observed, defaultBranch: "trunk" },
  };

  test("a non-'main' configured baseBranch ('trunk') that the PR's actual base agrees with -> ok", () => {
    const { gh } = makeGhSpy({
      view: { code: 0, stdout: "user/abc-1-slug trunk OPEN 5\n" },
      checks: HAPPY_CHECKS,
      files: HAPPY_FILES,
      repoView: { code: 0, stdout: "trunk\n" },
    });
    const v = mergeVerdict(baseInput({ resolvedConfig: TRUNK_RESOLVED }, gh));
    expect(v).toEqual({ ok: true });
  });

  test("a non-'main' configured baseBranch ('trunk') whose PR base is actually 'main' -> refuse base_mismatch (proves the comparison isn't hardcoded to \"main\")", () => {
    const { gh } = makeGhSpy({ view: { code: 0, stdout: "user/abc-1-slug main OPEN 5\n" } });
    const v = mergeVerdict(baseInput({ resolvedConfig: TRUNK_RESOLVED }, gh));
    expect(v).toEqual({ ok: false, reason: "base_mismatch", detail: "main" });
  });
});

describe("mergeVerdict — checks (AC L19)", () => {
  function checksInput(checks: { name: string; bucket: string }[], requiredChecks: string[]): { input: VerdictInput; calls: string[][] } {
    const { gh, calls } = makeGhSpy({
      view: HAPPY_VIEW,
      checks: { code: 0, stdout: JSON.stringify(checks) },
      files: HAPPY_FILES,
    });
    return {
      input: baseInput({ resolvedConfig: { ...VALID_RESOLVED, requiredChecks } }, gh),
      calls,
    };
  }

  test("a requiredChecks entry absent -> refuse, having actually fetched and inspected the checks list", () => {
    const { input, calls } = checksInput([{ name: "lint", bucket: "pass" }, { name: "CodeRabbit", bucket: "pass" }], ["build"]);
    const v = mergeVerdict(input);
    expect(v).toEqual({ ok: false, reason: "required_check_missing", detail: "build" });
    // proves the guard fetched the real checks list rather than refusing on an empty one
    expect(calls.some((c) => c[1] === "checks")).toBe(true);
  });

  // Bucket "skipping" (a path-filtered workflow that ran zero jobs) is neither pass NOR one of
  // the fail/cancel/pending buckets C1 gates on below — it must still fail the requiredChecks
  // loop, since "skipping" is not "pass".
  test("a requiredChecks entry present but bucket is 'skipping' (a path-filtered workflow) -> refuse required_check_missing", () => {
    const { input } = checksInput([{ name: "build", bucket: "skipping" }, { name: "CodeRabbit", bucket: "pass" }], ["build"]);
    const v = mergeVerdict(input);
    expect(v).toEqual({ ok: false, reason: "required_check_missing", detail: "build" });
  });

  // The F19 vacuity case: every requiredChecks name IS satisfied, but the only check that
  // ever ran is CodeRabbit itself — zero evidence any real CI ran.
  test("only CodeRabbit checks present -> refuse, even though the (misconfigured) requiredChecks name is satisfied", () => {
    const { input } = checksInput([{ name: "CodeRabbit", bucket: "pass" }], ["CodeRabbit"]);
    const v = mergeVerdict(input);
    expect(v).toEqual({ ok: false, reason: "checks_only_coderabbit" });
  });

  test("all required present + pass + a non-CodeRabbit check -> ok", () => {
    const { input } = checksInput([{ name: "build", bucket: "pass" }, { name: "CodeRabbit", bucket: "pass" }], ["build"]);
    const v = mergeVerdict(input);
    expect(v).toEqual({ ok: true });
  });

  // MINOR fix pass: requiredChecks was never tested with 2+ entries — a `.slice(0,1)` mutation
  // on the loop's iterable survived every existing fixture (all single-entry).
  test("requiredChecks with 2+ entries: every one of them must be present+pass, not just the first", () => {
    const { input } = checksInput([{ name: "build", bucket: "pass" }, { name: "lint", bucket: "pass" }, { name: "CodeRabbit", bucket: "pass" }], ["build", "lint"]);
    expect(mergeVerdict(input)).toEqual({ ok: true });

    const { input: missingSecond } = checksInput([{ name: "build", bucket: "pass" }, { name: "CodeRabbit", bucket: "pass" }], ["build", "lint"]);
    expect(mergeVerdict(missingSecond)).toEqual({ ok: false, reason: "required_check_missing", detail: "lint" });
  });

  // Defined, tested, non-swallowed behaviour for `gh pr checks` exiting non-zero — this is
  // what happens on a pending review, not merely a hypothetical.
  test("gh pr checks exits non-zero -> refuse with a distinct, non-swallowed reason (never || true)", () => {
    const { gh } = makeGhSpy({ view: HAPPY_VIEW, checks: { code: 1, stdout: "", stderr: "gh: secondary rate limit" } });
    const v = mergeVerdict(baseInput({}, gh));
    expect(v).toEqual({ ok: false, reason: "checks_fetch_failed", detail: "gh: secondary rate limit" });
  });

  // Minor (fix pass 2): a `gh pr checks` response that exits 0 but isn't valid JSON (or isn't a
  // JSON array) used to be swallowed into an empty checks array by `parseChecks`, surfacing
  // downstream as `required_check_missing: <first requiredChecks name>` — the wrong diagnosis
  // (reads as "the check is missing", not "the response was malformed").
  test("Minor: gh pr checks returning unparseable JSON refuses with the distinct checks_parse_failed reason, not required_check_missing", () => {
    const { gh } = makeGhSpy({ view: HAPPY_VIEW, checks: { code: 0, stdout: "not json" } });
    const v = mergeVerdict(baseInput({}, gh));
    expect(v).toEqual({ ok: false, reason: "checks_parse_failed" });
  });

  test("Minor: gh pr checks returning valid JSON that isn't an array refuses with checks_parse_failed", () => {
    const { gh } = makeGhSpy({ view: HAPPY_VIEW, checks: { code: 0, stdout: JSON.stringify({ not: "an array" }) } });
    const v = mergeVerdict(baseInput({}, gh));
    expect(v).toEqual({ ok: false, reason: "checks_parse_failed" });
  });

  // Minor (fix pass 2): the bucket gate used to be a DENYLIST (only fail/cancel/pending
  // refused) — any future `gh` bucket this module has never seen, or a malformed entry
  // `parseChecks` coerces to bucket `""`, passed straight through as advisory-only. Flipped to
  // an allowlist: anything outside {pass, skipping, pending} now refuses too.
  test("Minor: an unrecognized check bucket (not pass/skipping/pending/fail/cancel) refuses closed, not open (denylist -> allowlist)", () => {
    const { input } = checksInput([{ name: "build", bucket: "pass" }, { name: "mystery", bucket: "neutral" }], ["build"]);
    const v = mergeVerdict(input);
    expect(v).toEqual({ ok: false, reason: "checks_failing", detail: "mystery" });
  });

  test("Minor: a malformed check entry coerced to bucket \"\" by parseChecks refuses closed, not open", () => {
    const { gh } = makeGhSpy({
      view: HAPPY_VIEW,
      checks: { code: 0, stdout: JSON.stringify([{ name: "build", bucket: "pass" }, { bucket: 42 }]) },
      files: HAPPY_FILES,
    });
    const v = mergeVerdict(baseInput({}, gh));
    expect(v.ok).toBe(false);
  });

  // Minor (fix pass 2): `hasRealPassingCheck`'s `c.name.length > 0` clause was untested —
  // deleting it survives every other fixture (all named checks). A `pass`-bucket entry with an
  // EMPTY name must not count as the "real, non-CodeRabbit, genuinely passing" check the
  // anti-vacuity guard requires.
  test("Minor: a pass-bucket check with an empty name does not satisfy the anti-vacuity guard on its own", () => {
    const { input } = checksInput([{ name: "", bucket: "pass" }, { name: "CodeRabbit", bucket: "pass" }], ["CodeRabbit"]);
    const v = mergeVerdict(input);
    expect(v).toEqual({ ok: false, reason: "checks_only_coderabbit" });
  });
});

// Critical 1: the old §4 bash had a GLOBAL gate above the requiredChecks loop — ANY check
// (not just ones named in requiredChecks) reporting fail/cancel/pending refused the merge.
// The extraction dropped this along with its tests; a check outside requiredChecks (CodeQL,
// secret scanning, an org-level required workflow) became purely advisory.
describe("mergeVerdict — no fail/cancel/pending check anywhere, not just among requiredChecks (Critical 1)", () => {
  test("a passing required check plus an UNRELATED failing check -> refuse checks_failing (reproduces the reported bypass)", () => {
    const { input } = (() => {
      const { gh } = makeGhSpy({
        view: HAPPY_VIEW,
        checks: { code: 0, stdout: JSON.stringify([{ name: "build", bucket: "pass" }, { name: "lint", bucket: "fail" }]) },
        files: HAPPY_FILES,
      });
      return { input: baseInput({}, gh) };
    })();
    expect(mergeVerdict(input)).toEqual({ ok: false, reason: "checks_failing", detail: "lint" });
  });

  test("a passing required check plus an UNRELATED cancelled check -> refuse checks_failing (reproduces the reported bypass)", () => {
    const { gh } = makeGhSpy({
      view: HAPPY_VIEW,
      checks: { code: 0, stdout: JSON.stringify([{ name: "build", bucket: "pass" }, { name: "e2e", bucket: "cancel" }]) },
      files: HAPPY_FILES,
    });
    expect(mergeVerdict(baseInput({}, gh))).toEqual({ ok: false, reason: "checks_failing", detail: "e2e" });
  });

  test("a passing required check plus an UNRELATED still-pending check -> refuse checks_still_pending", () => {
    const { gh } = makeGhSpy({
      view: HAPPY_VIEW,
      checks: { code: 0, stdout: JSON.stringify([{ name: "build", bucket: "pass" }, { name: "e2e", bucket: "pending" }]) },
      files: HAPPY_FILES,
    });
    expect(mergeVerdict(baseInput({}, gh))).toEqual({ ok: false, reason: "checks_still_pending", detail: "e2e" });
  });

  test("multiple bad checks -> detail names all of them, comma-joined", () => {
    const { gh } = makeGhSpy({
      view: HAPPY_VIEW,
      checks: { code: 0, stdout: JSON.stringify([{ name: "build", bucket: "pass" }, { name: "lint", bucket: "fail" }, { name: "e2e", bucket: "cancel" }]) },
      files: HAPPY_FILES,
    });
    expect(mergeVerdict(baseInput({}, gh))).toEqual({ ok: false, reason: "checks_failing", detail: "lint,e2e" });
  });
});

// Critical 2: the F19 anti-vacuity guard itself was vacuous — no bucket constraint, and
// exact-name-match against CODERABBIT_CONTEXT. Both reproductions below are the reported
// bypasses; a genuinely-passing, non-CodeRabbit-prefixed check is now required.
describe("mergeVerdict — the anti-vacuity guard requires a genuinely PASSING non-CodeRabbit check (Critical 2)", () => {
  test("a path-filtered workflow reporting bucket 'skipping' does NOT satisfy the anti-vacuity guard (reproduces the reported bypass)", () => {
    const { gh } = makeGhSpy({
      view: HAPPY_VIEW,
      checks: { code: 0, stdout: JSON.stringify([{ name: "CodeRabbit", bucket: "pass" }, { name: "build", bucket: "skipping" }]) },
      files: HAPPY_FILES,
    });
    const v = mergeVerdict(baseInput({ resolvedConfig: { ...VALID_RESOLVED, requiredChecks: ["CodeRabbit"] } }, gh));
    expect(v).toEqual({ ok: false, reason: "checks_only_coderabbit" });
  });

  test("a CodeRabbit-context variant that isn't byte-identical (colon-suffixed) still counts as CodeRabbit — prefix match, not exact (reproduces the reported bypass)", () => {
    const { gh } = makeGhSpy({
      view: HAPPY_VIEW,
      checks: {
        code: 0,
        stdout: JSON.stringify([
          { name: "CodeRabbit", bucket: "pass" },
          { name: "CodeRabbit: pro review", bucket: "pass" },
        ]),
      },
      files: HAPPY_FILES,
    });
    const v = mergeVerdict(baseInput({ resolvedConfig: { ...VALID_RESOLVED, requiredChecks: ["CodeRabbit"] } }, gh));
    expect(v).toEqual({ ok: false, reason: "checks_only_coderabbit" });
  });
});

// Critical B (fix pass 2): `gh api .../pulls/<pr>/files --paginate` silently truncates at
// GitHub's server-side 3000-file cap — no error, no non-`next` Link header oddity visible to
// `--paginate`, just a short list and exit 0. An attacker who can open the gated PR (the exact
// threat model this module's own comment cites) pads the diff past 3000 files, sorted so the
// real payload (ship.config.json, a new workflow) never appears in the truncated page, and both
// Locked-18 refusals go silent. `gh pr view --json changedFiles` is the independent, truthful
// total the truncated list itself cannot lie about — refuse before ever trusting the files list
// once that total reaches the cap.
describe("mergeVerdict — diff-too-large-to-verify (Critical B: 3000-file pagination cap)", () => {
  function padFiles(n: number): string {
    // Valid git path chars that sort AHEAD of `.` (`!"#$%&'()*+,-`), so a real attacker's pad
    // files genuinely could crowd out a `.drawbar/ship.config.json` or `.github/workflows/**`
    // entry on the truncated page — this fixture reproduces that ordering, not a convenient one.
    return Array.from({ length: n }, (_, i) => `!pad-${i}`).join("\n") + "\n";
  }

  test("pre-fix reproduction: a truncated 3000-file list with the real payload absent must NOT read as a clean diff (documents the fail-open the lead reproduced)", () => {
    // This fixture is what the truncated files API genuinely returns once a PR exceeds the
    // 3000-file cap: exit 0, and neither ship.config.json nor a workflow path anywhere in the
    // (truncated) list. Without the changedFiles refusal below, mergeVerdict reads this as ok.
    const { gh } = makeGhSpy({
      view: { code: 0, stdout: "user/abc-1-slug main OPEN 3000\n" },
      checks: HAPPY_CHECKS,
      files: { code: 0, stdout: padFiles(3000) },
    });
    const v = mergeVerdict(baseInput({}, gh));
    // The fix: this must refuse, not silently pass on a diff it can no longer fully see.
    expect(v).toEqual({ ok: false, reason: "diff_too_large_to_verify", detail: "3000" });
  });

  test("changedFiles at exactly the 3000 cap -> refuse before ever fetching the files list", () => {
    const { gh, calls } = makeGhSpy({ view: { code: 0, stdout: "user/abc-1-slug main OPEN 3000\n" }, checks: HAPPY_CHECKS });
    const v = mergeVerdict(baseInput({}, gh));
    expect(v).toEqual({ ok: false, reason: "diff_too_large_to_verify", detail: "3000" });
    expect(calls.some((c) => c[0] === "api")).toBe(false);
  });

  test("changedFiles just under the cap (2999) -> the files list is still trusted and evaluated normally", () => {
    const { gh } = makeGhSpy({ view: { code: 0, stdout: "user/abc-1-slug main OPEN 2999\n" }, checks: HAPPY_CHECKS, files: HAPPY_FILES });
    const v = mergeVerdict(baseInput({}, gh));
    expect(v).toEqual({ ok: true });
  });
});

describe("mergeVerdict — config diff (AC L18)", () => {
  test("PR diff touches ship.config.json -> refuse", () => {
    const { gh, calls } = makeGhSpy({ view: HAPPY_VIEW, checks: HAPPY_CHECKS, files: { code: 0, stdout: "src/index.ts\n.drawbar/ship.config.json\n" } });
    const v = mergeVerdict(baseInput({}, gh));
    expect(v).toEqual({ ok: false, reason: "config_diff_touches_ship_config" });
    // proves it actually fetched and inspected the real files list, not an empty one
    expect(calls.some((c) => c[0] === "api")).toBe(true);
  });

  test("PR diff does not touch ship.config.json -> ok", () => {
    const { gh } = makeGhSpy({ view: HAPPY_VIEW, checks: HAPPY_CHECKS, files: { code: 0, stdout: "src/index.ts\nREADME.md\n" } });
    const v = mergeVerdict(baseInput({}, gh));
    expect(v).toEqual({ ok: true });
  });

  test("gh api pulls/files exits non-zero -> refuse with a distinct reason, never silently pass through", () => {
    const { gh } = makeGhSpy({ view: HAPPY_VIEW, checks: HAPPY_CHECKS, files: { code: 1, stdout: "", stderr: "gh: not found" } });
    const v = mergeVerdict(baseInput({}, gh));
    expect(v).toEqual({ ok: false, reason: "diff_fetch_failed", detail: "gh: not found" });
  });

  // Critical 3(a): git collapses a delete+add into the DESTINATION only under `--name-only`.
  // The files API exposes both `.filename` (destination) and `.previous_filename` (source) —
  // this proves the guard catches the case where only the SOURCE path was ship.config.json.
  test("a rename whose SOURCE path (previous_filename) was ship.config.json is still caught (Critical 3a: rename hides the source under --name-only)", () => {
    const { gh } = makeGhSpy({ view: HAPPY_VIEW, checks: HAPPY_CHECKS, files: { code: 0, stdout: ".drawbar/other.json\n.drawbar/ship.config.json\n" } });
    const v = mergeVerdict(baseInput({}, gh));
    expect(v).toEqual({ ok: false, reason: "config_diff_touches_ship_config" });
  });

  // Critical 3(b): the operator platform is darwin (case-insensitive filesystem) — a
  // case-variant basename checks out over the same inode.
  test("a case-variant basename is still caught (Critical 3b: case-insensitive filesystem bypass)", () => {
    const { gh } = makeGhSpy({ view: HAPPY_VIEW, checks: HAPPY_CHECKS, files: { code: 0, stdout: ".drawbar/Ship.Config.json\n" } });
    const v = mergeVerdict(baseInput({}, gh));
    expect(v).toEqual({ ok: false, reason: "config_diff_touches_ship_config" });
  });

  // Critical 3(c): `resolveConfigPath` (ship-config.ts) honours `DRAWBAR_SHIP_CONFIG` for ANY
  // basename — a diff touching the actually-effective config file (not the hardcoded default
  // basename) must still be caught when the caller supplies it.
  test("a custom-named config file is still caught when the effective config path is supplied (Critical 3c: basename is the wrong key)", () => {
    const { gh } = makeGhSpy({ view: HAPPY_VIEW, checks: HAPPY_CHECKS, files: { code: 0, stdout: ".drawbar/custom-config.json\n" } });
    const v = mergeVerdict(baseInput({ configPath: "/abs/fixture/.drawbar/custom-config.json" }, gh));
    expect(v).toEqual({ ok: false, reason: "config_diff_touches_ship_config" });
  });

  // The configPath field must only ADD a match, never narrow the default — a diff touching
  // the default basename is still caught even when a (non-matching) configPath is supplied.
  test("the default ship.config.json basename is still caught even when a different configPath is also supplied", () => {
    const { gh } = makeGhSpy({ view: HAPPY_VIEW, checks: HAPPY_CHECKS, files: { code: 0, stdout: ".drawbar/ship.config.json\n" } });
    const v = mergeVerdict(baseInput({ configPath: "/abs/fixture/.drawbar/custom-config.json" }, gh));
    expect(v).toEqual({ ok: false, reason: "config_diff_touches_ship_config" });
  });

  // Important 5: `requiredChecks` is attacker-definable for a same-repo PR, since GitHub runs
  // workflow DEFINITIONS from the PR branch — extend the refusal to any diff touching
  // `.github/workflows/**`. (No `.yml`/`.yaml` extension in the fixture path — this file is
  // itself leak-scanned for concrete workflow filenames; the prefix match doesn't need one.)
  test("a diff touching .github/workflows/** is refused (Important 5: requiredChecks names are attacker-definable via a new workflow)", () => {
    const { gh } = makeGhSpy({ view: HAPPY_VIEW, checks: HAPPY_CHECKS, files: { code: 0, stdout: ".github/workflows/probe\n" } });
    const v = mergeVerdict(baseInput({}, gh));
    expect(v).toEqual({ ok: false, reason: "config_diff_touches_dot_github" });
  });

  // Important C (fix pass 2): `.github/workflows/**` alone doesn't close the class this refusal
  // exists for — a required workflow that does `uses: ./.github/actions/foo` can have that
  // COMPOSITE ACTION rewritten to `exit 0` while the workflow file itself, and the required
  // check's passing name, never change. Widened to the whole `.github/` prefix.
  // No .yml/.yaml extension in the fixture path — this file is itself leak-scanned for
  // concrete workflow/config filenames; the prefix match doesn't need one.
  test("a diff touching a composite action under .github/actions/** (not .github/workflows/**) is still refused (Important C: workflows-only prefix doesn't close the class)", () => {
    const { gh } = makeGhSpy({ view: HAPPY_VIEW, checks: HAPPY_CHECKS, files: { code: 0, stdout: ".github/actions/probe/action-definition\n" } });
    const v = mergeVerdict(baseInput({}, gh));
    expect(v).toEqual({ ok: false, reason: "config_diff_touches_dot_github" });
  });

  test("a diff touching CODEOWNERS under .github/ is refused too (fail-closed on the whole prefix, not just workflows/actions)", () => {
    const { gh } = makeGhSpy({ view: HAPPY_VIEW, checks: HAPPY_CHECKS, files: { code: 0, stdout: ".github/CODEOWNERS\n" } });
    const v = mergeVerdict(baseInput({}, gh));
    expect(v).toEqual({ ok: false, reason: "config_diff_touches_dot_github" });
  });
});

describe("mergeVerdict — resolved_config re-assert at merge (AC L18)", () => {
  test("a structurally invalid resolved_config -> refuse, before any gh call at all", () => {
    const { gh, calls } = happyGhSpy();
    const broken = { ...VALID_RESOLVED, baseBranch: "" } as unknown as ResolvedConfig; // empty_string violates parseShipConfig
    const v = mergeVerdict(baseInput({ resolvedConfig: broken }, gh));
    expect(v).toEqual({ ok: false, reason: "invalid_resolved_config" });
    expect(calls.length).toBe(0);
  });

  test("resolved_config missing the observed block -> refuse", () => {
    const { gh, calls } = happyGhSpy();
    const { observed, ...withoutObserved } = VALID_RESOLVED;
    const v = mergeVerdict(baseInput({ resolvedConfig: withoutObserved as unknown as ResolvedConfig }, gh));
    expect(v).toEqual({ ok: false, reason: "invalid_resolved_config" });
    expect(calls.length).toBe(0);
  });

  // Important 1: `baseBranch` reached `git fetch` as an unvalidated refspec/option downstream
  // (recordMergeSha's `--base`, sourced from this same resolvedConfig). Both reproductions the
  // lead ran against the real module are pinned here, refused before any gh call.
  test("Important 1: resolvedConfig.baseBranch shaped as a forced refspec is refused before any gh call", () => {
    const { gh, calls } = happyGhSpy();
    const tampered: ResolvedConfig = { ...VALID_RESOLVED, baseBranch: "+refs/heads/attacker:refs/remotes/origin/main" };
    const v = mergeVerdict(baseInput({ resolvedConfig: tampered }, gh));
    expect(v).toEqual({ ok: false, reason: "invalid_base_branch_shape", detail: "+refs/heads/attacker:refs/remotes/origin/main" });
    expect(calls.length).toBe(0);
  });

  test("Important 1: resolvedConfig.baseBranch shaped as a git option flag is refused before any gh call", () => {
    const { gh, calls } = happyGhSpy();
    const tampered: ResolvedConfig = { ...VALID_RESOLVED, baseBranch: "--upload-pack=id" };
    const v = mergeVerdict(baseInput({ resolvedConfig: tampered }, gh));
    expect(v).toEqual({ ok: false, reason: "invalid_base_branch_shape", detail: "--upload-pack=id" });
    expect(calls.length).toBe(0);
  });

  // Important 2: neither `repo` nor `resolvedConfig.baseBranch === observed.defaultBranch` was
  // ever asserted — a resolvedConfig tampered between T0 and merge time could name a repo it
  // never validated, or carry a baseBranch that disagrees with its own truthful `observed`.
  test("Important 2: resolvedConfig.repo disagreeing with the verdict's own repo is refused (repo_mismatch)", () => {
    const { gh, calls } = happyGhSpy();
    const tampered: ResolvedConfig = { ...VALID_RESOLVED, repo: "attacker/evil" };
    const v = mergeVerdict(baseInput({ resolvedConfig: tampered }, gh));
    expect(v).toEqual({ ok: false, reason: "repo_mismatch", detail: "attacker/evil" });
    expect(calls.length).toBe(0);
  });

  test("Important 2: resolvedConfig.baseBranch disagreeing with resolvedConfig.observed.defaultBranch is refused (base_branch_not_default)", () => {
    const { gh, calls } = happyGhSpy();
    const tampered: ResolvedConfig = { ...VALID_RESOLVED, baseBranch: "attacker-branch" };
    const v = mergeVerdict(baseInput({ resolvedConfig: tampered }, gh));
    expect(v).toEqual({ ok: false, reason: "base_branch_not_default", detail: "attacker-branch" });
    expect(calls.length).toBe(0);
  });
});

// Important F (fix pass 2): `base_branch_not_default`'s ONLY check was
// `resolvedConfig.baseBranch !== resolvedConfig.observed.defaultBranch` — both fields of the
// SAME caller-supplied object. A caller who tampers with the run-state file can edit both
// together (baseBranch: "attacker-branch", observed.defaultBranch: "attacker-branch") and the
// tautology is satisfied by construction; the PR's actual base then only needs to equal that
// same forged value, so all checks pass a merge into a branch that was never the repo's real
// default. Conjoined below with an INDEPENDENTLY observed `gh repo view` call, the same
// discipline `validateShipConfig`'s own Assertion 5 uses at T0.
describe("mergeVerdict — independently-observed default branch (Important F)", () => {
  test("a resolvedConfig internally self-consistent (baseBranch === observed.defaultBranch) but disagreeing with the REAL observed default branch is still refused", () => {
    const tampered: ResolvedConfig = {
      ...VALID_RESOLVED,
      baseBranch: "attacker-branch",
      observed: { ...VALID_RESOLVED.observed, defaultBranch: "attacker-branch" },
    };
    const { gh, calls } = makeGhSpy({
      view: { code: 0, stdout: "user/abc-1-slug attacker-branch OPEN 5\n" },
      checks: HAPPY_CHECKS,
      files: HAPPY_FILES,
      repoView: { code: 0, stdout: "main\n" }, // the repo's REAL default, per gh, disagrees
    });
    const v = mergeVerdict(baseInput({ resolvedConfig: tampered }, gh));
    expect(v).toEqual({ ok: false, reason: "base_branch_not_default", detail: "attacker-branch" });
    expect(calls.some((c) => c[0] === "repo" && c[1] === "view")).toBe(true);
  });

  test("gh repo view failing -> refuse with a distinct, non-swallowed reason", () => {
    const { gh } = makeGhSpy({
      view: HAPPY_VIEW,
      repoView: { code: 1, stdout: "", stderr: "gh: secondary rate limit" },
    });
    const v = mergeVerdict(baseInput({}, gh));
    expect(v).toEqual({ ok: false, reason: "default_branch_fetch_failed", detail: "gh: secondary rate limit" });
  });

  test("the independent check genuinely runs on the happy path too (proves it isn't dead code that only fires on the failure fixtures above)", () => {
    const { gh, calls } = happyGhSpy();
    const v = mergeVerdict(baseInput({}, gh));
    expect(v).toEqual({ ok: true });
    expect(calls.some((c) => c[0] === "repo" && c[1] === "view")).toBe(true);
  });
});

// --- recordMergeSha (AC L10) --------------------------------------------------------------

const FULL_SHA_A = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"; // 40 hex chars, the merge commit
const HEAD_SHA = "0123456789abcdef0123456789abcdef01234567"; // a DIFFERENT 40-char sha — the PR head

// Critical A: real calls are `["-C", dir, "fetch", ...]` — matched on argv[2], not argv[0].
function makeGitSpy(fetchOk = true): { git: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const git: Runner = (argv) => {
    calls.push(argv);
    if (argv[0] === "-C" && argv[2] === "fetch") {
      return fetchOk ? { code: 0, stdout: "" } : { code: 1, stdout: "", stderr: "git: could not fetch" };
    }
    return { code: 1, stdout: "", stderr: "unexpected git call in test fixture" };
  };
  return { git, calls };
}

// Tri-state ancestor stub matching AncestorCheck — every recordMergeSha test below that only
// needs "yes, it's an ancestor" and doesn't otherwise care about `dir`/`sha`/`ref` uses this.
function alwaysAncestor(): { status: "yes" } {
  return { status: "yes" };
}

// `gh pr view --json mergeCommit` — never `.head.sha` / `headRefOid`. A spy that fails the
// test outright if the fence ever asks for the head sha proves the module captures the MERGE
// commit, never the PR head, rather than merely happening to return a different value.
function makeGhMergeCommitSpy(mergeCommitOid: string, code = 0): { gh: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const gh: Runner = (argv) => {
    calls.push(argv);
    const joined = argv.join(" ");
    if (joined.includes("head.sha") || joined.includes("headRefOid")) {
      throw new Error(`recordMergeSha must never query the PR head sha — got: ${joined}`);
    }
    if (argv[1] === "view" && argv.includes("mergeCommit")) {
      return code === 0 ? { code: 0, stdout: mergeCommitOid + "\n" } : { code, stdout: "", stderr: "gh: not found" };
    }
    return { code: 1, stdout: "", stderr: `unexpected gh call in test fixture: ${joined}` };
  };
  return { gh, calls };
}

// Critical A (fix pass 2): the lead reproduced `git fetch`/`git merge-base` running in the
// ambient CWD — no `cwd` on the injected runner's `Bun.spawnSync`, and §4 never derives or
// passes a project directory. Ancestry then refuses on EVERY story (a fresh checkout's CWD is
// never a checkout of `resolvedConfig.repo`), AFTER `gh pr merge` has already run. `dir` closes
// this: the caller must supply the project checkout path, and every git call is anchored there
// via `-C`, proven here by asserting the argv itself literally carries `["-C", dir, ...]`.
const FIXTURE_PROJECT_DIR = "/tmp/fixture-project-dir";

describe("recordMergeSha — merge_sha capture (AC L10)", () => {
  test("Critical A: git fetch and git merge-base are anchored at `dir` via `-C`, not the ambient CWD", () => {
    const { gh } = makeGhMergeCommitSpy(FULL_SHA_A);
    const gitCalls: string[][] = [];
    const git: Runner = (argv) => {
      gitCalls.push(argv);
      return { code: 0, stdout: "" };
    };
    const isAncestor = (dir: string, sha: string, ref: string) => {
      expect(dir).toBe(FIXTURE_PROJECT_DIR);
      return { status: "yes" as const };
    };
    const result = recordMergeSha({
      repo: "acme/widgets",
      pr: "42",
      baseBranch: "main",
      dir: FIXTURE_PROJECT_DIR,
      gh,
      git,
      isAncestor,
    });
    expect(result).toEqual({ ok: true, mergeSha: FULL_SHA_A });
    expect(gitCalls).toEqual([["-C", FIXTURE_PROJECT_DIR, "fetch", "origin", "--", "main"]]);
  });

  test("Critical A: an invalid (relative) dir refuses before any git/gh call at all", () => {
    const { gh, calls: ghCalls } = makeGhMergeCommitSpy(FULL_SHA_A);
    const { git, calls: gitCalls } = makeGitSpy(true);
    const result = recordMergeSha({
      repo: "acme/widgets",
      pr: "42",
      baseBranch: "main",
      dir: "relative/not/absolute",
      gh,
      git,
      isAncestor: () => ({ status: "yes" as const }),
    });
    expect(result).toEqual({ ok: false, reason: "invalid_dir", detail: "relative/not/absolute" });
    expect(ghCalls.length).toBe(0);
    expect(gitCalls.length).toBe(0);
  });

  // Sub-fix: `git merge-base --is-ancestor` uses exit 1 for "not an ancestor" and >1 for a
  // genuine evaluation failure (e.g. one of the two shas/refs is unknown to this checkout,
  // which is exactly what "pointed at the wrong repo" looks like). Collapsing exit 128 into
  // "not an ancestor" diagnoses a wrong-repo/wrong-checkout misconfiguration as an ordinary,
  // expected refusal instead of the distinct operational failure it actually is.
  test("Sub-fix: git merge-base --is-ancestor exiting >1 (cannot evaluate) is a distinct ancestry_check_failed, not sha_not_ancestor", () => {
    const { gh } = makeGhMergeCommitSpy(FULL_SHA_A);
    const git: Runner = (argv) => {
      if (argv[2] === "fetch") return { code: 0, stdout: "" };
      if (argv[2] === "merge-base") return { code: 128, stdout: "", stderr: "fatal: Not a valid commit name origin/main" };
      return { code: 1, stdout: "", stderr: "unexpected" };
    };
    const isAncestor = (dir: string, sha: string, ref: string) => {
      const res = git(["-C", dir, "merge-base", "--is-ancestor", sha, ref]);
      if (res.code === 0) return { status: "yes" as const };
      if (res.code === 1) return { status: "no" as const };
      return { status: "error" as const, detail: res.stderr };
    };
    const result = recordMergeSha({
      repo: "acme/widgets",
      pr: "42",
      baseBranch: "main",
      dir: FIXTURE_PROJECT_DIR,
      gh,
      git,
      isAncestor,
    });
    expect(result).toEqual({
      ok: false,
      reason: "ancestry_check_failed",
      detail: "fatal: Not a valid commit name origin/main",
    });
  });

  test("a full 40-char sha that IS an ancestor -> ok, with fetch running before the ancestor test", () => {
    const { gh } = makeGhMergeCommitSpy(FULL_SHA_A);
    const { git, calls: gitCalls } = makeGitSpy(true);
    const order: string[] = [];
    const isAncestor = (dir: string, sha: string, ref: string) => {
      order.push(`isAncestor(${sha},${ref})`);
      return { status: "yes" as const };
    };
    const gitWithOrderTracking: Runner = (argv) => {
      if (argv[0] === "-C" && argv[2] === "fetch") order.push("fetch");
      return git(argv);
    };
    const result = recordMergeSha({
      repo: "acme/widgets",
      pr: "42",
      baseBranch: "main",
      dir: FIXTURE_PROJECT_DIR,
      gh,
      git: gitWithOrderTracking,
      isAncestor,
    });
    expect(result).toEqual({ ok: true, mergeSha: FULL_SHA_A });
    expect(gitCalls.length).toBe(1); // fetch actually ran, not skipped
    expect(order).toEqual(["fetch", `isAncestor(${FULL_SHA_A},origin/main)`]); // fetch precedes the ancestor test
  });

  // Fix pass, I6: pinned discriminator for the OTHER hardcoded-"main" trap — `origin/${baseBranch}`
  // was only ever asserted as `origin/main` in every existing fixture; a mutation hardcoding the
  // ref to the literal `"origin/main"` survived. This uses a distinct baseBranch ("release").
  test("I6: the ancestor ref is built from the ACTUAL baseBranch, not hardcoded to origin/main", () => {
    const { gh } = makeGhMergeCommitSpy(FULL_SHA_A);
    const { git } = makeGitSpy(true);
    const seenRefs: string[] = [];
    const isAncestor = (_dir: string, _sha: string, ref: string) => {
      seenRefs.push(ref);
      return { status: "yes" as const };
    };
    const result = recordMergeSha({ repo: "acme/widgets", pr: "42", baseBranch: "release", dir: FIXTURE_PROJECT_DIR, gh, git, isAncestor });
    expect(result).toEqual({ ok: true, mergeSha: FULL_SHA_A });
    expect(seenRefs).toEqual(["origin/release"]);
  });

  test("an abbreviated sha (8 chars, as one legacy file recorded) -> refuse, and isAncestor is never called", () => {
    const { gh } = makeGhMergeCommitSpy("a1b2c3d4");
    const { git } = makeGitSpy(true);
    let ancestorCalls = 0;
    const isAncestor = () => { ancestorCalls++; return { status: "yes" as const }; };
    const result = recordMergeSha({ repo: "acme/widgets", pr: "42", baseBranch: "main", dir: FIXTURE_PROJECT_DIR, gh, git, isAncestor });
    expect(result).toEqual({ ok: false, reason: "sha_shape_invalid", detail: "a1b2c3d4" });
    expect(ancestorCalls).toBe(0);
  });

  test("an abbreviated sha (9 chars, as the OTHER legacy file recorded) -> refuse", () => {
    const { gh } = makeGhMergeCommitSpy("a1b2c3d4e");
    const { git } = makeGitSpy(true);
    const result = recordMergeSha({ repo: "acme/widgets", pr: "42", baseBranch: "main", dir: FIXTURE_PROJECT_DIR, gh, git, isAncestor: alwaysAncestor });
    expect(result).toEqual({ ok: false, reason: "sha_shape_invalid", detail: "a1b2c3d4e" });
  });

  test("captures the MERGE COMMIT oid, not the PR head sha — the two differ under a squash-merge fixture", () => {
    const { gh, calls } = makeGhMergeCommitSpy(FULL_SHA_A);
    const { git } = makeGitSpy(true);
    const result = recordMergeSha({ repo: "acme/widgets", pr: "42", baseBranch: "main", dir: FIXTURE_PROJECT_DIR, gh, git, isAncestor: alwaysAncestor });
    // Minor (fix pass 2): the prior `expect(result.ok && result.mergeSha).not.toBe(HEAD_SHA)`
    // line was vacuous whenever `ok` were false (`false && x` is `false`, which trivially
    // `!== HEAD_SHA`). Deleted rather than narrowed — the `toEqual` above already pins the
    // exact value (`FULL_SHA_A`, the fixture's distinct merge-commit sha, never `HEAD_SHA`)
    // strictly more precisely than a `.not.toBe` ever could.
    expect(result).toEqual({ ok: true, mergeSha: FULL_SHA_A });
    expect(calls.some((c) => c.join(" ").includes("mergeCommit"))).toBe(true);
  });

  test("ancestry is checked AT RECORD TIME: a non-ancestor sha fails here, not later", () => {
    const { gh } = makeGhMergeCommitSpy(FULL_SHA_A);
    const { git } = makeGitSpy(true);
    let ancestorCalls = 0;
    const isAncestor = () => { ancestorCalls++; return { status: "no" as const }; };
    const result = recordMergeSha({ repo: "acme/widgets", pr: "42", baseBranch: "main", dir: FIXTURE_PROJECT_DIR, gh, git, isAncestor });
    expect(result).toEqual({ ok: false, reason: "sha_not_ancestor", detail: FULL_SHA_A });
    expect(ancestorCalls).toBe(1); // the ancestor test actually ran — not skipped/short-circuited
  });

  test("git fetch origin <baseBranch> failing -> refuse before ever calling gh or isAncestor", () => {
    const { gh, calls: ghCalls } = makeGhMergeCommitSpy(FULL_SHA_A);
    const { git } = makeGitSpy(false);
    let ancestorCalls = 0;
    const isAncestor = () => { ancestorCalls++; return { status: "yes" as const }; };
    const result = recordMergeSha({ repo: "acme/widgets", pr: "42", baseBranch: "main", dir: FIXTURE_PROJECT_DIR, gh, git, isAncestor });
    expect(result).toEqual({ ok: false, reason: "fetch_failed", detail: "git: could not fetch" });
    expect(ghCalls.length).toBe(0);
    expect(ancestorCalls).toBe(0);
  });

  test("gh pr view failing -> refuse with a distinct reason", () => {
    const { gh } = makeGhMergeCommitSpy(FULL_SHA_A, 1);
    const { git } = makeGitSpy(true);
    const result = recordMergeSha({ repo: "acme/widgets", pr: "42", baseBranch: "main", dir: FIXTURE_PROJECT_DIR, gh, git, isAncestor: alwaysAncestor });
    expect(result).toEqual({ ok: false, reason: "gh_view_failed", detail: "gh: not found" });
  });

  test("endpoint-injection guard: invalid repo shape refuses before any runner call", () => {
    const { gh, calls: ghCalls } = makeGhMergeCommitSpy(FULL_SHA_A);
    const { git, calls: gitCalls } = makeGitSpy(true);
    const result = recordMergeSha({ repo: "../../etc", pr: "42", baseBranch: "main", dir: FIXTURE_PROJECT_DIR, gh, git, isAncestor: alwaysAncestor });
    expect(result).toEqual({ ok: false, reason: "invalid_repo_shape", detail: "../../etc" });
    expect(ghCalls.length).toBe(0);
    expect(gitCalls.length).toBe(0);
  });

  test("endpoint-injection guard: invalid pr shape (non-digits) refuses before any runner call", () => {
    const { gh, calls: ghCalls } = makeGhMergeCommitSpy(FULL_SHA_A);
    const { git, calls: gitCalls } = makeGitSpy(true);
    const result = recordMergeSha({ repo: "acme/widgets", pr: "42; rm -rf /", baseBranch: "main", dir: FIXTURE_PROJECT_DIR, gh, git, isAncestor: alwaysAncestor });
    expect(result.ok).toBe(false);
    expect(ghCalls.length).toBe(0);
    expect(gitCalls.length).toBe(0);
  });

  // Important 1: `baseBranch` reached `git fetch` as an unvalidated refspec/option — both
  // reproductions the lead ran against the real module, mirroring the existing `../../etc` /
  // `42; rm -rf /` shape-guard style above. `git` must never be called with either.
  test("Important 1: baseBranch shaped as a forced refspec is refused before git fetch ever runs", () => {
    const { gh, calls: ghCalls } = makeGhMergeCommitSpy(FULL_SHA_A);
    const { git, calls: gitCalls } = makeGitSpy(true);
    const result = recordMergeSha({
      repo: "acme/widgets",
      pr: "42",
      baseBranch: "+refs/heads/attacker:refs/remotes/origin/main",
      dir: FIXTURE_PROJECT_DIR,
      gh,
      git,
      isAncestor: alwaysAncestor,
    });
    expect(result).toEqual({ ok: false, reason: "invalid_base_branch", detail: "+refs/heads/attacker:refs/remotes/origin/main" });
    expect(gitCalls.length).toBe(0);
    expect(ghCalls.length).toBe(0);
  });

  test("Important 1: baseBranch shaped as a git option flag (--upload-pack=...) is refused before git fetch ever runs", () => {
    const { gh, calls: ghCalls } = makeGhMergeCommitSpy(FULL_SHA_A);
    const { git, calls: gitCalls } = makeGitSpy(true);
    const result = recordMergeSha({ repo: "acme/widgets", pr: "42", baseBranch: "--upload-pack=id", dir: FIXTURE_PROJECT_DIR, gh, git, isAncestor: alwaysAncestor });
    expect(result).toEqual({ ok: false, reason: "invalid_base_branch", detail: "--upload-pack=id" });
    expect(gitCalls.length).toBe(0);
    expect(ghCalls.length).toBe(0);
  });
});

// --- CLI boundary (MUST-CHECK endpoint-injection-not-just-command-injection) --------------

function collectOutput() {
  let stdout = "";
  let stderr = "";
  return {
    writeStdout: (s: string) => { stdout += s; },
    writeStderr: (s: string) => { stderr += s; },
    get stdout() { return stdout; },
    get stderr() { return stderr; },
  };
}

function verdictStdin(overrides: Partial<{ resolvedConfig: ResolvedConfig; snapshot: string[] }> = {}): () => Promise<string> {
  const body = { resolvedConfig: VALID_RESOLVED, snapshot: ["ABC-1"], ...overrides };
  return () => Promise.resolve(JSON.stringify(body));
}

describe("CLI main() — endpoint-injection boundary", () => {
  test("verdict: an invalid --repo shape refuses with NON-ZERO exit and NO stdout at all (not even ok:false JSON)", async () => {
    const out = collectOutput();
    const code = await main({
      argv: ["verdict", "--repo", "../../etc", "--pr", "42", "--story", "ABC-1"],
      readStdin: verdictStdin(),
      ...out,
    });
    expect(code).not.toBe(0);
    expect(out.stdout).toBe("");
  });

  test("verdict: an invalid --pr shape refuses with NON-ZERO exit and NO stdout at all", async () => {
    const out = collectOutput();
    const code = await main({
      argv: ["verdict", "--repo", "acme/widgets", "--pr", "42; rm -rf /", "--story", "ABC-1"],
      readStdin: verdictStdin(),
      ...out,
    });
    expect(code).not.toBe(0);
    expect(out.stdout).toBe("");
  });

  test("record-merge-sha: an invalid --repo shape refuses with NON-ZERO exit and NO stdout at all", async () => {
    const out = collectOutput();
    const code = await main({ argv: ["record-merge-sha", "--repo", "a/b/c", "--pr", "42", "--base", "main"], ...out });
    expect(code).not.toBe(0);
    expect(out.stdout).toBe("");
  });

  // Round-3 security review, Important 1. `--dir` reaches `git -C <dir>` — the most dangerous
  // sink this CLI has, because running git inside a repository whose `.git` configuration an
  // attacker controls is arbitrary code execution. It therefore gets the same both-boundaries
  // treatment `--repo`/`--pr` already had, including the no-stdout rule: a caller grepping
  // stdout for a verdict must never find one synthesized from an unvalidated argument.
  for (const bad of ["relative/path", "/a/../b", ""]) {
    test(`record-merge-sha: a --dir of ${JSON.stringify(bad)} refuses with NON-ZERO exit, NO stdout, and no git call`, async () => {
      const out = collectOutput();
      const gitCalls: string[][] = [];
      const code = await main({
        argv: ["record-merge-sha", "--repo", "org/repo", "--pr", "42", "--base", "main", "--dir", bad],
        gh: () => ({ code: 0, stdout: "0123456789abcdef0123456789abcdef01234567\n" }),
        git: (argv: string[]) => {
          gitCalls.push(argv);
          return { code: 0, stdout: "" };
        },
        isAncestor: () => ({ status: "yes" }) as never,
        ...out,
      });
      expect(code).not.toBe(0);
      expect(out.stdout).toBe("");
      // Proves the refusal is the shape guard, not a downstream failure wearing the same result.
      expect(gitCalls).toEqual([]);
    });
  }

  // Round-3 security review, Important 2. A PR's `headRefName` is named by whoever opened it and
  // flows into a refusal `detail` that an agent reads back. `JSON.stringify` escapes C0/DEL,
  // backslash and quote and NOTHING else, so bidi overrides and zero-width characters used to
  // pass through completely intact — able to reorder or hide text in the transcript. They are
  // replaced with U+FFFD on the way out instead.
  test("a refusal detail carrying bidi/zero-width characters is sanitized before it reaches stderr", async () => {
    const out = collectOutput();
    const hostileBranch = "user/⁦evil⁩‮reversed​";
    await main({
      // Must match VALID_RESOLVED.repo, or the repo_mismatch guard refuses first and the branch
      // identity check — the one that carries the hostile detail — is never reached.
      argv: ["verdict", "--repo", "acme/widgets", "--pr", "1", "--story", "ABC-1"],
      readStdin: verdictStdin(),
      gh: (argv: string[]) => {
        if (argv[0] === "repo") return { code: 0, stdout: "main\n" };
        if (argv[1] === "view") return { code: 0, stdout: `${hostileBranch} main OPEN 3\n` };
        return { code: 0, stdout: "[]" };
      },
      git: () => ({ code: 0, stdout: "" }),
      ...out,
    });
    expect(out.stderr).toContain("branch_identity_mismatch");
    for (const ch of ["⁦", "⁩", "‮", "​"]) {
      expect(out.stderr).not.toContain(ch);
    }
    expect(out.stderr).toContain("�");
  });
});

describe("CLI main() — full round trip, in-process (no real gh/git spawned)", () => {
  test("verdict: happy path writes {ok:true} and exits 0", async () => {
    const out = collectOutput();
    const gh = happyGhSpy().gh;
    const code = await main({
      argv: ["verdict", "--repo", "acme/widgets", "--pr", "42", "--story", "ABC-1"],
      readStdin: verdictStdin(),
      gh,
      ...out,
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ ok: true });
  });

  test("verdict: a refusal writes the JSON verdict and exits non-zero", async () => {
    const out = collectOutput();
    const { gh } = makeGhSpy({ view: { code: 0, stdout: "someone/unrelated main OPEN 5\n" } });
    const code = await main({
      argv: ["verdict", "--repo", "acme/widgets", "--pr", "42", "--story", "ABC-1"],
      readStdin: verdictStdin(),
      gh,
      ...out,
    });
    expect(code).not.toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ ok: false, reason: "branch_identity_mismatch", detail: "someone/unrelated" });
  });

  // Important 3 / 4: a refusal's reason must be operator-visible on stderr (the fence's own
  // guard fires on the module's non-zero exit before the stdout JSON is ever inspected), and
  // any control-char-carrying detail must be JSON-escaped, never written raw.
  test("Important 3/4: a refusal writes 'refused: <reason>: <JSON-escaped detail>' to stderr, not just the bare detail", async () => {
    const out = collectOutput();
    const { gh } = makeGhSpy({ view: { code: 0, stdout: "someone/unrelated main OPEN 5\n" } });
    await main({
      argv: ["verdict", "--repo", "acme/widgets", "--pr", "42", "--story", "ABC-1"],
      readStdin: verdictStdin(),
      gh,
      ...out,
    });
    expect(out.stderr).toContain("refused: branch_identity_mismatch");
    expect(out.stderr).toContain(JSON.stringify("someone/unrelated"));
  });

  test("verdict: malformed stdin JSON refuses without ever calling gh", async () => {
    const out = collectOutput();
    const { gh, calls } = happyGhSpy();
    const code = await main({
      argv: ["verdict", "--repo", "acme/widgets", "--pr", "42", "--story", "ABC-1"],
      readStdin: () => Promise.resolve("not json"),
      gh,
      ...out,
    });
    expect(code).not.toBe(0);
    expect(calls.length).toBe(0);
  });

  test("verdict: --story missing refuses before ever reading stdin", async () => {
    const out = collectOutput();
    let stdinCalls = 0;
    const code = await main({
      argv: ["verdict", "--repo", "acme/widgets", "--pr", "42"],
      readStdin: () => { stdinCalls++; return Promise.resolve("{}"); },
      ...out,
    });
    expect(code).not.toBe(0);
    expect(stdinCalls).toBe(0);
  });

  test("record-merge-sha: happy path writes {ok:true,mergeSha} and exits 0", async () => {
    const { gh } = makeGhMergeCommitSpy(FULL_SHA_A);
    const { git } = makeGitSpy(true);
    const out = collectOutput();
    const code = await main({
      argv: ["record-merge-sha", "--repo", "acme/widgets", "--pr", "42", "--base", "main", "--dir", FIXTURE_PROJECT_DIR],
      gh,
      git,
      isAncestor: alwaysAncestor,
      ...out,
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ ok: true, mergeSha: FULL_SHA_A });
  });

  test("record-merge-sha: --dir missing refuses with a named reason, never falling back to the ambient CWD", async () => {
    const { gh } = makeGhMergeCommitSpy(FULL_SHA_A);
    const { git, calls: gitCalls } = makeGitSpy(true);
    const out = collectOutput();
    const code = await main({
      argv: ["record-merge-sha", "--repo", "acme/widgets", "--pr", "42", "--base", "main"],
      gh,
      git,
      isAncestor: alwaysAncestor,
      ...out,
    });
    expect(code).not.toBe(0);
    expect(out.stderr).toContain("--dir is required");
    expect(gitCalls.length).toBe(0);
  });

  test("record-merge-sha: a refusal writes the JSON result and exits non-zero", async () => {
    const { gh } = makeGhMergeCommitSpy("abbrev8c");
    const { git } = makeGitSpy(true);
    const out = collectOutput();
    const code = await main({
      argv: ["record-merge-sha", "--repo", "acme/widgets", "--pr", "42", "--base", "main", "--dir", FIXTURE_PROJECT_DIR],
      gh,
      git,
      isAncestor: alwaysAncestor,
      ...out,
    });
    expect(code).not.toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ ok: false, reason: "sha_shape_invalid", detail: "abbrev8c" });
  });
});
