import { test, expect, describe } from "bun:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import type { ResolvedConfig, Runner } from "./ship-config";
import type { RunState, StackEntry } from "./run-state";
import { resolveBase, assertChainIntact, parseCliArgs, main, type MainDeps } from "./stack";

// Placeholder-id scheme (this repo is PUBLIC — see run-state.test.ts's own comment): every
// story id below is lowercase ("story-a", "story-b"), which cannot trip the leak-regression
// rule in scripts/plugin.test.ts (uppercase team-prefix shape only).
//
// MUST-CHECK de-hardcode-test-fixture-must-vary-the-old-value: `baseBranch` is deliberately
// "trunk" — NOT "main" — and every recorded branch name is deliberately NOT base-shaped
// ("story-a-branch", not e.g. "main" or "trunk"). A fixture where the configured base and a
// predecessor branch share a string cannot distinguish Locked A (base = predecessor branch)
// from a silently re-hardcoded default (base = config.baseBranch every time).
const VALID_RESOLVED_CONFIG: ResolvedConfig = {
  envDir: "/tmp/fixture-env-dir",
  projectDir: "/tmp/fixture-project-dir",
  repo: "acme/widgets",
  team: "PLAT",
  baseBranch: "trunk",
  requiredChecks: ["build"],
  observed: {
    projectDirRemote: "acme/widgets",
    envDirRemote: "acme/knowledge-base",
    defaultBranch: "trunk",
  },
};

const STORY_A_ENTRY: StackEntry = { story: "story-a", branch: "story-a-branch", pr: 1, base: "trunk", flagged: false };
const STORY_B_ENTRY: StackEntry = { story: "story-b", branch: "story-b-branch", pr: 2, base: "story-a-branch", flagged: false };
const STORY_C_ENTRY: StackEntry = { story: "story-c", branch: "story-c-branch", pr: 3, base: "story-b-branch", flagged: false };

const BASE_RUN_STATE: Pick<RunState, "snapshot" | "stack" | "resolved_config"> = {
  snapshot: ["story-a", "story-b"],
  stack: [],
  resolved_config: VALID_RESOLVED_CONFIG,
};

describe("resolveBase — Locked A: story N's base is story N-1's branch, never the configured base, for N>1", () => {
  test("the first story of a run resolves to the configured baseBranch", () => {
    const result = resolveBase(BASE_RUN_STATE, "story-a", { baseBranch: "trunk" });
    expect(result).toEqual({ ok: true, base: "trunk", rule: "config_base" });
  });

  test("the Nth story resolves to the (N-1)th story's recorded branch, NOT the configured baseBranch", () => {
    const state = { ...BASE_RUN_STATE, stack: [STORY_A_ENTRY] };
    const result = resolveBase(state, "story-b", { baseBranch: "trunk" });
    expect(result).toEqual({ ok: true, base: "story-a-branch", rule: "previous_story_branch" });
    // The point of Locked A, asserted directly: the resolved base is NOT the configured one.
    expect((result as { base: string }).base).not.toBe("trunk");
  });

  // CRITICAL 1 mutant-kill: a 2-entry stack cannot distinguish "the LAST entry's branch" from
  // "the FIRST entry's branch" (index 0 IS index length-1 at length 1, and i-1 IS 0 at the
  // only non-zero index of a 2-entry chain). A 3-entry stack can: `stack[0]!` and
  // `stack[stack.length - 1]!` disagree here, and only the latter is Locked A.
  test("a 3-entry stack resolves the NEXT story's base to the THIRD entry's branch, not the first entry's (CRITICAL 1)", () => {
    const state = {
      ...BASE_RUN_STATE,
      snapshot: [...BASE_RUN_STATE.snapshot, "story-c", "story-d"],
      stack: [STORY_A_ENTRY, STORY_B_ENTRY, STORY_C_ENTRY],
    };
    const result = resolveBase(state, "story-d", { baseBranch: "trunk" });
    expect(result).toEqual({ ok: true, base: "story-c-branch", rule: "previous_story_branch" });
    expect((result as { base: string }).base).not.toBe(STORY_A_ENTRY.branch);
  });
});

describe("resolveBase — named refusals, never a silent default, when the state is inconsistent", () => {
  test("storyId that is empty after trimming is refused", () => {
    const result = resolveBase(BASE_RUN_STATE, "   ", { baseBranch: "trunk" });
    expect(result).toEqual({ ok: false, reason: "invalid_story_id", detail: "storyId must be a non-empty trimmed string" });
  });

  test("storyId not a member of the run's snapshot is refused", () => {
    const result = resolveBase(BASE_RUN_STATE, "story-not-in-snapshot", { baseBranch: "trunk" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("story_not_in_snapshot");
  });

  test("storyId that already has a stack entry is refused (resolving a base for it again is inconsistent)", () => {
    const state = { ...BASE_RUN_STATE, stack: [STORY_A_ENTRY] };
    const result = resolveBase(state, "story-a", { baseBranch: "trunk" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("story_already_stacked");
  });

  // The state is inconsistent whether or not this is the first story — the check must not be
  // skippable by resolving story 1.
  test("config.baseBranch diverging from the run's persisted resolved_config.baseBranch is refused, neither side picked silently", () => {
    const result = resolveBase(BASE_RUN_STATE, "story-a", { baseBranch: "some-other-branch" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("base_branch_config_drift");
  });

  test("a config.baseBranch that is git-argv-injection shaped is refused even when it matches resolved_config.baseBranch", () => {
    const state = { ...BASE_RUN_STATE, resolved_config: { ...VALID_RESOLVED_CONFIG, baseBranch: "--upload-pack=x" } };
    const result = resolveBase(state, "story-a", { baseBranch: "--upload-pack=x" });
    expect(result).toEqual({ ok: false, reason: "invalid_base_branch_shape", detail: "--upload-pack=x" });
  });

  // Constructed directly, bypassing `parseRunState` (which would itself refuse this shape at
  // read time) — `resolveBase` is a pure function callers can invoke with hand-built state, so
  // it must independently refuse a git-argv-injection-shaped predecessor branch rather than
  // trusting the caller already validated it.
  test("a predecessor branch that is git-argv-injection shaped is refused, independent of parseRunState", () => {
    const malformedPredecessor = { ...STORY_A_ENTRY, branch: "--upload-pack=x" };
    const state = { ...BASE_RUN_STATE, stack: [malformedPredecessor] };
    const result = resolveBase(state, "story-b", { baseBranch: "trunk" });
    expect(result).toEqual({ ok: false, reason: "invalid_predecessor_branch_shape", detail: "--upload-pack=x" });
  });
});

// --- assertChainIntact -----------------------------------------------------------------

const PROJECT_DIR = "/tmp/fixture-project-dir";
const VALID_CHAIN_STATE: Pick<RunState, "stack" | "resolved_config"> = {
  stack: [STORY_A_ENTRY, STORY_B_ENTRY],
  resolved_config: VALID_RESOLVED_CONFIG,
};

// A spy `git` runner. Real-git argv/exit-code assumptions this fake encodes are verified
// against a live git 2.50.1 (not merely asserted by another fake) — see the comment on
// `assertChainIntact`'s `merge-base --is-ancestor` handling in stack.ts:
//   - `rev-parse --verify --quiet refs/heads/<missing>` exits 1, no stdout; any OTHER
//     non-zero exit (128 observed for a missing/corrupt repo) is a genuine git ERROR, distinct
//     from "missing" (IMPORTANT 1).
//   - `merge-base --is-ancestor <base> <branch>` exits 0 when `base` IS an ancestor, exits 1
//     when it genuinely is NOT (including two unrelated histories), and exits 128 for a
//     fatal git error (e.g. a bogus ref) — 1 and 128 must route to distinct reasons.
function makeGitRunner(
  opts: {
    missingRefs?: Set<string>;
    gitErrorRefs?: Set<string>;
    ancestorExit?: (base: string, branch: string) => number;
  } = {},
): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = (argv) => {
    calls.push(argv);
    if (argv[2] === "rev-parse") {
      const ref = argv[argv.length - 1]!;
      if (opts.gitErrorRefs?.has(ref)) return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
      if (opts.missingRefs?.has(ref)) return { code: 1, stdout: "", stderr: "" };
      return { code: 0, stdout: "deadbeefcafe\n", stderr: "" };
    }
    if (argv[2] === "merge-base") {
      // CRITICAL 2 regression, enforced on EVERY call through this one shared fake (not a
      // one-off test): both arguments must be fully `refs/heads/`-qualified, matching the two
      // `rev-parse` calls above. A bare name here would let git's ref disambiguation order
      // (`refs/tags/<x>` resolved ahead of `refs/heads/<x>`) answer the ancestry question
      // about a DIFFERENT object than the one just verified to exist — a `git tag` of the same
      // name would silently defeat the whole check.
      expect(argv.length, `merge-base argv must be exactly 6 elements, got: ${argv.join(" ")}`).toBe(6);
      expect(argv[4], "merge-base's base argument must be refs/heads/-qualified").toMatch(/^refs\/heads\//);
      expect(argv[5], "merge-base's branch argument must be refs/heads/-qualified").toMatch(/^refs\/heads\//);
      const base = argv[4]!.slice("refs/heads/".length);
      const branch = argv[5]!.slice("refs/heads/".length);
      const code = opts.ancestorExit ? opts.ancestorExit(base, branch) : 0;
      return { code, stdout: "", stderr: code !== 0 && code !== 1 ? "fatal: Not a valid object name" : "" };
    }
    return { code: 1, stdout: "", stderr: `unexpected git invocation: ${argv.join(" ")}` };
  };
  return { run, calls };
}

describe("assertChainIntact — refuses when a recorded predecessor branch is missing or has moved", () => {
  test("an empty stack has nothing to verify — ok, and no git call is ever made", () => {
    const { run, calls } = makeGitRunner();
    const result = assertChainIntact({ stack: [], resolved_config: VALID_RESOLVED_CONFIG }, PROJECT_DIR, run);
    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([]);
  });

  test("a fully intact 2-entry chain is ok, and every git call is anchored with an explicit -C <projectDir> (MUST-CHECK injected-runner-no-cwd)", () => {
    const { run, calls } = makeGitRunner();
    const result = assertChainIntact(VALID_CHAIN_STATE, PROJECT_DIR, run);
    expect(result).toEqual({ ok: true });
    expect(calls.length).toBeGreaterThan(0);
    for (const argv of calls) {
      expect(argv[0]).toBe("-C");
      expect(argv[1]).toBe(PROJECT_DIR);
    }
  });

  test("entry[0].base not matching the run's configured baseBranch is a chain-link mismatch, with NO git call made first (call-counter spy)", () => {
    const badFirst: StackEntry = { ...STORY_A_ENTRY, base: "some-other-branch" };
    const { run, calls } = makeGitRunner();
    const result = assertChainIntact({ stack: [badFirst], resolved_config: VALID_RESOLVED_CONFIG }, PROJECT_DIR, run);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("chain_link_mismatch");
    expect(calls).toEqual([]);
  });

  test("entry[i>0].base not matching entry[i-1].branch is a chain-link mismatch, with NO git call made (call-counter spy)", () => {
    const badSecond: StackEntry = { ...STORY_B_ENTRY, base: "not-story-a-branch" };
    const { run, calls } = makeGitRunner();
    const result = assertChainIntact({ stack: [STORY_A_ENTRY, badSecond], resolved_config: VALID_RESOLVED_CONFIG }, PROJECT_DIR, run);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("chain_link_mismatch");
    // The first entry is intact, so its git calls DID happen — the spy proves the SECOND
    // entry's defect was caught before ITS git calls, not that git was never called at all.
    expect(calls.length).toBe(3);
  });

  // CRITICAL 1 mutant-kill: a 2-entry chain cannot distinguish `stack[i-1].branch` from
  // `stack[0].branch` (they are the same entry at the only non-zero index). Sets `base`
  // wrongly to entry[0]'s branch — a mutant computing `expectedBase` from `stack[0]` always
  // would see this as MATCHING and never report a mismatch at all; the correct implementation
  // (which compares against `stack[i-1]`, i.e. entry[1]) still catches it.
  test("entry[2].base wrongly set to entry[0]'s branch (not entry[1]'s) is caught as a chain-link mismatch naming index 2 (CRITICAL 1)", () => {
    const badThird: StackEntry = { ...STORY_C_ENTRY, base: STORY_A_ENTRY.branch };
    const { run, calls } = makeGitRunner();
    const result = assertChainIntact(
      { stack: [STORY_A_ENTRY, STORY_B_ENTRY, badThird], resolved_config: VALID_RESOLVED_CONFIG },
      PROJECT_DIR,
      run,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("chain_link_mismatch");
    expect(result.detail).toContain("stack[2]");
    // Entries 0 and 1 are both fully intact — their git calls (3 each) DID happen; the
    // mismatch at index 2 is caught before ITS git calls.
    expect(calls.length).toBe(6);
  });

  test("a relative (non-absolute) projectDir is refused before any git call (call-counter spy)", () => {
    const { run, calls } = makeGitRunner();
    const result = assertChainIntact(VALID_CHAIN_STATE, "relative/dir", run);
    expect(result).toEqual({ ok: false, reason: "invalid_project_dir", detail: "relative/dir" });
    expect(calls).toEqual([]);
  });

  test("a projectDir carrying a '..' segment is refused before any git call (call-counter spy)", () => {
    const { run, calls } = makeGitRunner();
    const result = assertChainIntact(VALID_CHAIN_STATE, "/tmp/../../etc", run);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_project_dir");
    expect(calls).toEqual([]);
  });

  // Constructed directly, bypassing `parseRunState` — same discipline as resolveBase's
  // independent predecessor-shape check above (MUST-CHECK
  // endpoint-injection-not-just-command-injection): every ref value reaching a `git` argv is
  // gated by `isValidRefName` before any runner call, regardless of caller trust.
  //
  // Round-2 review (Minor 5): `base` is deliberately ALSO mismatched here, so this entry is
  // defective in two ways at once. Only the shape-check-first ordering yields
  // `invalid_ref_shape`; if the `chain_link_mismatch` comparison were moved back above the
  // `isValidRefName` gate, this test would see `chain_link_mismatch` instead — which is
  // exactly the regression that would start echoing an unvalidated ref value into a refusal
  // detail. Without the mismatched `base`, swapping the two blocks left the suite green.
  test("a stack entry with a git-argv-injection-shaped branch is refused before any git call for that entry (call-counter spy)", () => {
    const malformed: StackEntry = { ...STORY_A_ENTRY, branch: "--upload-pack=x", base: "some-other-branch" };
    const { run, calls } = makeGitRunner();
    const result = assertChainIntact({ stack: [malformed], resolved_config: VALID_RESOLVED_CONFIG }, PROJECT_DIR, run);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_ref_shape");
    expect(calls).toEqual([]);
  });

  test("a missing branch (rev-parse --verify --quiet fails) is a named branch_missing refusal", () => {
    const { run } = makeGitRunner({ missingRefs: new Set([`refs/heads/${STORY_A_ENTRY.branch}`]) });
    const result = assertChainIntact({ stack: [STORY_A_ENTRY], resolved_config: VALID_RESOLVED_CONFIG }, PROJECT_DIR, run);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("branch_missing");
  });

  test("a missing base (rev-parse --verify --quiet fails) is a named base_missing refusal, distinct from branch_missing", () => {
    // entry[0].base ("trunk") is deliberately a DIFFERENT ref from entry[0].branch
    // ("story-a-branch") — marking only the base missing proves the two checks are
    // independent, not that "any missing ref" collapses to one reason.
    const { run } = makeGitRunner({ missingRefs: new Set([`refs/heads/${STORY_A_ENTRY.base}`]) });
    const result = assertChainIntact({ stack: [STORY_A_ENTRY], resolved_config: VALID_RESOLVED_CONFIG }, PROJECT_DIR, run);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("base_missing");
  });

  // IMPORTANT 1: verified against real git 2.50.1 — `rev-parse --verify --quiet` on a
  // MISSING ref exits 1, but a broken/deleted/moved `projectDir` (not a git repository at
  // all) makes the SAME call exit 128. Collapsing both to "missing" tells the operator a
  // branch doesn't exist when the real problem is the repository itself.
  test("a genuine git error from rev-parse on the BRANCH check (exit 128) is git_failed, distinct from branch_missing", () => {
    const { run } = makeGitRunner({ gitErrorRefs: new Set([`refs/heads/${STORY_A_ENTRY.branch}`]) });
    const result = assertChainIntact({ stack: [STORY_A_ENTRY], resolved_config: VALID_RESOLVED_CONFIG }, PROJECT_DIR, run);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("git_failed");
  });

  test("a genuine git error from rev-parse on the BASE check (exit 128) is git_failed, distinct from base_missing", () => {
    const { run } = makeGitRunner({ gitErrorRefs: new Set([`refs/heads/${STORY_A_ENTRY.base}`]) });
    const result = assertChainIntact({ stack: [STORY_A_ENTRY], resolved_config: VALID_RESOLVED_CONFIG }, PROJECT_DIR, run);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("git_failed");
  });

  test("base no longer an ancestor of branch (merge-base --is-ancestor exits 1) is a named branch_moved refusal", () => {
    const { run } = makeGitRunner({ ancestorExit: () => 1 });
    const result = assertChainIntact({ stack: [STORY_A_ENTRY], resolved_config: VALID_RESOLVED_CONFIG }, PROJECT_DIR, run);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("branch_moved");
  });

  // Verified against real git: `merge-base --is-ancestor` exits 128 (not 1) on a genuine git
  // error such as a bogus ref — this must NOT be misread as "moved," which would silently
  // mask a broken repository as an ordinary rebase.
  test("a genuine git error from merge-base --is-ancestor (exit 128) is git_failed, distinct from branch_moved", () => {
    const { run } = makeGitRunner({ ancestorExit: () => 128 });
    const result = assertChainIntact({ stack: [STORY_A_ENTRY], resolved_config: VALID_RESOLVED_CONFIG }, PROJECT_DIR, run);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("git_failed");
  });
});

// --- CLI: `resolve-base --state <path> --story <id>` and `assert-chain --state <path>` -----

describe("parseCliArgs — flag type enforcement in both directions, per subcommand", () => {
  test("resolve-base parses well-formed --state and --story", () => {
    const result = parseCliArgs("resolve-base", ["--state", "/tmp/run.json", "--story", "story-a"]);
    expect(result).toEqual({ ok: true, state: "/tmp/run.json", story: "story-a" });
  });

  test("assert-chain parses a well-formed --state and --project-dir, with no --story required", () => {
    const result = parseCliArgs("assert-chain", ["--state", "/tmp/run.json", "--project-dir", "/tmp/proj"]);
    expect(result).toEqual({ ok: true, state: "/tmp/run.json", projectDir: "/tmp/proj" });
  });

  // CRITICAL 3: `--project-dir` is the operator-supplied trust root for `assert-chain`'s only
  // git call — required, not optional, so a caller cannot silently fall back to the
  // agent-writable state-file copy by omitting it.
  test("assert-chain without --project-dir refuses", () => {
    const result = parseCliArgs("assert-chain", ["--state", "/tmp/run.json"]);
    expect(result.ok).toBe(false);
  });

  test("--project-dir with no consumable value (boolean true) refuses", () => {
    const result = parseCliArgs("assert-chain", ["--state", "/tmp/run.json", "--project-dir"]);
    expect(result.ok).toBe(false);
  });

  test("--project-dir with an empty string value refuses", () => {
    const result = parseCliArgs("assert-chain", ["--state", "/tmp/run.json", "--project-dir", ""]);
    expect(result.ok).toBe(false);
  });

  test("a repeated --project-dir flag refuses", () => {
    const result = parseCliArgs("assert-chain", ["--state", "a", "--project-dir", "x", "--project-dir", "y"]);
    expect(result.ok).toBe(false);
  });

  // `resolve-base` makes no git call at all — `--project-dir` would do nothing there, so it
  // is refused outright rather than silently accepted-but-ignored.
  test("resolve-base carrying an unexpected --project-dir refuses", () => {
    const result = parseCliArgs("resolve-base", ["--state", "/tmp/run.json", "--story", "story-a", "--project-dir", "/tmp/proj"]);
    expect(result.ok).toBe(false);
  });

  test("resolve-base without --story refuses", () => {
    const result = parseCliArgs("resolve-base", ["--state", "/tmp/run.json"]);
    expect(result.ok).toBe(false);
  });

  test("resolve-base without --state refuses", () => {
    const result = parseCliArgs("resolve-base", ["--story", "story-a"]);
    expect(result.ok).toBe(false);
  });

  test("assert-chain without --state refuses", () => {
    const result = parseCliArgs("assert-chain", []);
    expect(result.ok).toBe(false);
  });

  test("assert-chain carrying an unexpected --story refuses", () => {
    const result = parseCliArgs("assert-chain", ["--state", "/tmp/run.json", "--story", "story-a"]);
    expect(result.ok).toBe(false);
  });

  test("--state with no consumable value (boolean true) refuses", () => {
    const result = parseCliArgs("assert-chain", ["--state"]);
    expect(result.ok).toBe(false);
  });

  test("--state with an empty string value refuses", () => {
    const result = parseCliArgs("assert-chain", ["--state", ""]);
    expect(result.ok).toBe(false);
  });

  test("--story with no consumable value (boolean true) refuses", () => {
    const result = parseCliArgs("resolve-base", ["--state", "/tmp/run.json", "--story"]);
    expect(result.ok).toBe(false);
  });

  test("--story with an empty string value refuses", () => {
    const result = parseCliArgs("resolve-base", ["--state", "/tmp/run.json", "--story", ""]);
    expect(result.ok).toBe(false);
  });

  test("an unknown flag refuses", () => {
    const result = parseCliArgs("assert-chain", ["--bogus", "x"]);
    expect(result.ok).toBe(false);
  });

  test("a repeated --state flag refuses", () => {
    const result = parseCliArgs("assert-chain", ["--state", "a", "--state", "b"]);
    expect(result.ok).toBe(false);
  });

  test("a repeated --story flag refuses", () => {
    const result = parseCliArgs("resolve-base", ["--state", "a", "--story", "x", "--story", "y"]);
    expect(result.ok).toBe(false);
  });
});

const VALID_RUN_STATE: RunState = {
  arg: "story-a",
  invoked_as: "parent",
  started_at: "2026-01-01T00:00:00Z",
  order_rationale: "no relations among snapshot members",
  snapshot: ["story-a", "story-b"],
  stories_done: [],
  in_flight: null,
  stack: [STORY_A_ENTRY],
  subissues_filed: [],
  resolved_config: VALID_RESOLVED_CONFIG,
};

describe("main() — CLI entry, fully injectable", () => {
  function happyResolveBaseDeps(overrides: Partial<MainDeps> = {}): MainDeps {
    return {
      argv: ["resolve-base", "--state", "/tmp/run.json", "--story", "story-b"],
      readState: () => JSON.stringify(VALID_RUN_STATE),
      git: () => ({ code: 0, stdout: "", stderr: "" }),
      writeStderr: () => {},
      ...overrides,
    };
  }

  test("resolve-base: writes the resolveBase verdict to stdout and returns 0 on success", async () => {
    let written = "";
    const code = await main(happyResolveBaseDeps({ writeStdout: (s) => { written += s; } }));
    expect(code).toBe(0);
    expect(JSON.parse(written)).toEqual({ ok: true, base: STORY_A_ENTRY.branch, rule: "previous_story_branch" });
  });

  test("resolve-base: a business-logic refusal (e.g. unknown story) still writes JSON to stdout, but returns non-zero", async () => {
    let written = "";
    const code = await main(
      happyResolveBaseDeps({
        argv: ["resolve-base", "--state", "/tmp/run.json", "--story", "not-in-snapshot"],
        writeStdout: (s) => { written += s; },
      }),
    );
    expect(code).toBe(1);
    expect(JSON.parse(written)).toEqual({ ok: false, reason: "story_not_in_snapshot", detail: "not-in-snapshot is not a member of this run's snapshot" });
  });

  // Round-2 review (Minor 2): the flag is passed in a normalization-EQUIVALENT but textually
  // DISTINCT form (`<dir>/.`), so `resolve()` equality still holds while the two values stay
  // tellable apart. That is what lets the `argv[1]` assertion below pin CRITICAL 3's actual
  // invariant — that the OPERATOR-supplied flag, never the agent-writable state-file copy, is
  // what reaches `git -C`. With both sides spelled identically the assertion was vacuous:
  // swapping in `projectDirFromState` left the suite green.
  test("assert-chain: --project-dir agreeing with resolved_config.projectDir writes the assertChainIntact verdict, anchoring git at the FLAG value", async () => {
    let written = "";
    const gitCalls: string[][] = [];
    const flagDir = `${VALID_RESOLVED_CONFIG.projectDir}/.`;
    const code = await main({
      argv: ["assert-chain", "--state", "/tmp/run.json", "--project-dir", flagDir],
      readState: () => JSON.stringify(VALID_RUN_STATE),
      git: (argv) => { gitCalls.push(argv); return { code: 0, stdout: "", stderr: "" }; },
      writeStdout: (s) => { written += s; },
      writeStderr: () => {},
    });
    expect(code).toBe(0);
    expect(JSON.parse(written)).toEqual({ ok: true });
    expect(gitCalls.length).toBeGreaterThan(0);
    for (const argv of gitCalls) {
      expect(argv[0]).toBe("-C");
      // The FLAG's literal text, not the state file's copy — the two resolve() to the same
      // directory here, so only the literal distinguishes which one was threaded through.
      expect(argv[1]).toBe(flagDir);
      expect(argv[1]).not.toBe(VALID_RESOLVED_CONFIG.projectDir);
    }
  });

  // CRITICAL 3: `resolved_config.projectDir` lives in the agent-writable state file. A decoy
  // value there must never reach `git -C` — the operator-supplied `--project-dir` flag is the
  // trust root, and disagreement refuses BEFORE the git runner is ever invoked (call-counter
  // spy, MUST-CHECK call-counter-spy-proves-dispatch-path-not-entered).
  test("assert-chain: --project-dir disagreeing with resolved_config.projectDir refuses project_dir_untrusted with ZERO git calls", async () => {
    let written = "";
    const gitCalls: string[][] = [];
    const code = await main({
      argv: ["assert-chain", "--state", "/tmp/run.json", "--project-dir", "/tmp/decoy-repo"],
      readState: () => JSON.stringify(VALID_RUN_STATE),
      git: (argv) => { gitCalls.push(argv); return { code: 0, stdout: "", stderr: "" }; },
      writeStdout: (s) => { written += s; },
      writeStderr: () => {},
    });
    expect(code).toBe(1);
    const verdict = JSON.parse(written);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("project_dir_untrusted");
    expect(verdict.detail).toContain("/tmp/decoy-repo");
    expect(verdict.detail).toContain(VALID_RESOLVED_CONFIG.projectDir);
    expect(gitCalls).toEqual([]);
  });

  test("assert-chain: a missing --project-dir is a usage refusal with EMPTY stdout, never reaching readState", async () => {
    let called = false;
    let written = "";
    const code = await main({
      argv: ["assert-chain", "--state", "/tmp/run.json"],
      readState: () => { called = true; return JSON.stringify(VALID_RUN_STATE); },
      git: () => ({ code: 0, stdout: "", stderr: "" }),
      writeStdout: (s) => { written += s; },
      writeStderr: () => {},
    });
    expect(code).toBe(1);
    expect(written).toBe("");
    expect(called).toBe(false);
  });

  test("resolve-base: --project-dir is refused as a usage error, with EMPTY stdout", async () => {
    let written = "";
    const code = await main(
      happyResolveBaseDeps({
        argv: ["resolve-base", "--state", "/tmp/run.json", "--story", "story-b", "--project-dir", "/tmp/proj"],
        writeStdout: (s) => { written += s; },
      }),
    );
    expect(code).toBe(1);
    expect(written).toBe("");
  });

  // IMPORTANT 3: `stack[i].story` is never ref-shape-checked, only `parseRunState`'s
  // CONTROL_CHAR_SHAPE-gated `isNonEmptyTrimmed` — which deliberately ADMITS invisible/bidi
  // Unicode (RLM, a bidi-isolate, and a BOM below). A `chain_link_mismatch` detail interpolates
  // `entry.story` directly; this must never survive unsanitized into the stdout verdict an
  // agent reads back.
  test("an invisible-Unicode payload in a stack entry's story id is sanitized before it reaches stdout", async () => {
    const poisoned: StackEntry = { ...STORY_A_ENTRY, story: "story-a‏​﻿", base: "some-other-branch" };
    const state: RunState = { ...VALID_RUN_STATE, stack: [poisoned] };
    let written = "";
    const code = await main({
      argv: ["assert-chain", "--state", "/tmp/run.json", "--project-dir", VALID_RESOLVED_CONFIG.projectDir],
      readState: () => JSON.stringify(state),
      git: () => ({ code: 0, stdout: "", stderr: "" }),
      writeStdout: (s) => { written += s; },
      writeStderr: () => {},
    });
    expect(code).toBe(1);
    expect(written).not.toContain("‏");
    expect(written).not.toContain("​");
    expect(written).not.toContain("﻿");
    const verdict = JSON.parse(written);
    expect(verdict.reason).toBe("chain_link_mismatch");
    expect(verdict.detail).toContain("�");
  });

  // Round-2 review (IMPORTANT 1): the test above pinned only the `chain_link_mismatch` route,
  // leaving the OTHER two `writeStdout` sites' sanitization unpinned — deleting either
  // `sanitizeChainOrBaseDetail` call left the whole suite green, so IMPORTANT 3 could reopen
  // silently. One test per remaining site, each driving a genuinely reachable payload.

  // `project_dir_untrusted` is itself fix-pass code (the CRITICAL 3 trust-root refusal), and it
  // interpolates `resolved_config.projectDir` — an agent-writable state-file value that
  // `parseRunState` admits with invisible/bidi Unicode intact (CONTROL_CHAR_SHAPE deliberately
  // does not cover ZWSP/ALM/BOM) and that `isCleanAbsolutePath` passes.
  test("an invisible-Unicode payload in the state's projectDir is sanitized before it reaches the project_dir_untrusted verdict", async () => {
    const poisonedDir = "/tmp/fixture-project-dir​؜﻿";
    const state: RunState = {
      ...VALID_RUN_STATE,
      resolved_config: { ...VALID_RESOLVED_CONFIG, projectDir: poisonedDir },
    };
    let written = "";
    const gitCalls: string[][] = [];
    const code = await main({
      argv: ["assert-chain", "--state", "/tmp/run.json", "--project-dir", VALID_RESOLVED_CONFIG.projectDir],
      readState: () => JSON.stringify(state),
      git: (argv) => { gitCalls.push(argv); return { code: 0, stdout: "", stderr: "" }; },
      writeStdout: (s) => { written += s; },
      writeStderr: () => {},
    });
    expect(code).toBe(1);
    // Pre-state: the payload really did survive parseRunState, or this test proves nothing.
    expect(state.resolved_config.projectDir).toContain("​");
    expect(written).not.toContain("​");
    expect(written).not.toContain("؜");
    expect(written).not.toContain("﻿");
    const verdict = JSON.parse(written);
    expect(verdict.reason).toBe("project_dir_untrusted");
    expect(verdict.detail).toContain("�");
    // The trust-root refusal must precede every git call.
    expect(gitCalls).toEqual([]);
  });

  // `--story` arrives from argv and is never control-char-checked anywhere; the
  // `story_not_in_snapshot` detail interpolates it straight into the stdout verdict.
  test("an invisible-Unicode payload in --story is sanitized before it reaches the resolve-base verdict", async () => {
    let written = "";
    const code = await main(
      happyResolveBaseDeps({
        argv: ["resolve-base", "--state", "/tmp/run.json", "--story", "story-x​‏"],
        writeStdout: (s) => { written += s; },
      }),
    );
    expect(code).toBe(1);
    expect(written).not.toContain("​");
    expect(written).not.toContain("‏");
    const verdict = JSON.parse(written);
    expect(verdict.reason).toBe("story_not_in_snapshot");
    expect(verdict.detail).toContain("�");
  });

  test("an unreadable state file is refused with EMPTY stdout (a CLI-level failure, not a business verdict)", async () => {
    let written = "";
    const code = await main(
      happyResolveBaseDeps({
        readState: () => { throw new Error("ENOENT"); },
        writeStdout: (s) => { written += s; },
      }),
    );
    expect(code).toBe(1);
    expect(written).toBe("");
  });

  test("a state file that fails parseRunState is refused with EMPTY stdout", async () => {
    let written = "";
    const code = await main(
      happyResolveBaseDeps({
        readState: () => JSON.stringify({ ...VALID_RUN_STATE, extra_field: "x" }),
        writeStdout: (s) => { written += s; },
      }),
    );
    expect(code).toBe(1);
    expect(written).toBe("");
  });

  test("a bad CLI invocation (unknown subcommand) is refused with EMPTY stdout, never reaching readState", async () => {
    let called = false;
    let written = "";
    const code = await main({
      argv: ["bogus-command"],
      readState: () => { called = true; return "{}"; },
      writeStdout: (s) => { written += s; },
      writeStderr: () => {},
    });
    expect(code).toBe(1);
    expect(written).toBe("");
    expect(called).toBe(false);
  });
});

// CLI end-to-end: every misuse case exits non-zero with EMPTY stdout — none of these paths
// reach `assertChainIntact`'s real git call, so they hold even with `git` absent from PATH
// (PATH trimmed to bun's own directory only — MUST-CHECK
// path-scrubbed-proof-must-not-hide-the-runner-itself, form 1: the unit file itself needs
// nothing else).
describe("CLI end-to-end: every misuse case exits non-zero with no stdout", () => {
  const bunDir = dirname(process.execPath);
  const scriptPath = join(import.meta.dir, "stack.ts");

  function runCli(args: string[]): Promise<{ code: number; out: string; err: string }> {
    const proc = Bun.spawn(["bun", "run", scriptPath, ...args], {
      env: { PATH: bunDir },
      stdout: "pipe",
      stderr: "pipe",
    });
    return (async () => {
      const out = await new Response(proc.stdout).text();
      const err = await new Response(proc.stderr).text();
      const code = await proc.exited;
      return { code, out, err };
    })();
  }

  test("no subcommand at all — non-zero, empty stdout", async () => {
    const { code, out, err } = await runCli([]);
    expect(code).not.toBe(0);
    expect(out).toBe("");
    expect(err.length).toBeGreaterThan(0);
  });

  test("resolve-base with no --story — non-zero, empty stdout", async () => {
    const { code, out } = await runCli(["resolve-base", "--state", "/tmp/whatever.json"]);
    expect(code).not.toBe(0);
    expect(out).toBe("");
  });

  test("a missing state file — non-zero, empty stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stack-cli-"));
    const missing = join(dir, "does-not-exist.json");
    expect(existsSync(missing)).toBe(false);
    // `--project-dir` is required by parseCliArgs, but this misuse case is meant to exercise
    // the READ-STATE failure specifically — supply a well-formed value so the flow reaches it,
    // rather than refusing earlier on the flag's own absence.
    const { code, out, err } = await runCli(["assert-chain", "--state", missing, "--project-dir", "/tmp/whatever-project-dir"]);
    expect(code).not.toBe(0);
    expect(out).toBe("");
    expect(err.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a state file that fails parseRunState (bad JSON) — non-zero, empty stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stack-cli-"));
    const statePath = join(dir, "run.json");
    writeFileSync(statePath, "{ not json");
    const { code, out, err } = await runCli(["assert-chain", "--state", statePath, "--project-dir", "/tmp/whatever-project-dir"]);
    expect(code).not.toBe(0);
    expect(out).toBe("");
    expect(err.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  // IMPORTANT 2: every misuse case above returns before `assertChainIntact`'s real git call is
  // ever reached, so the PATH-scrubbed proof above is VACUOUS on the git-calling path —
  // `makeRealRunner`'s try/catch (stack.ts:340-352) had zero coverage. This is the other proof
  // form (MUST-CHECK path-scrubbed-proof-must-not-hide-the-runner-itself, form 2): a genuinely
  // valid, single-entry run-state that DOES reach the real git call, with `git` absent from
  // PATH. Pinned together with IMPORTANT 1: the verdict must be `git_failed`, never the FALSE
  // `branch_missing` a naive "any non-zero exit means missing" read would produce.
  test("git absent from PATH: assert-chain surfaces git_failed on stdout, not a false branch_missing (IMPORTANT 1 + 2)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "stack-cli-"));
    const statePath = join(dir, "run.json");
    writeFileSync(statePath, JSON.stringify(VALID_RUN_STATE));
    const proc = Bun.spawn(
      ["bun", "run", scriptPath, "assert-chain", "--state", statePath, "--project-dir", VALID_RESOLVED_CONFIG.projectDir],
      { env: { PATH: bunDir }, stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(1);
    const verdict = JSON.parse(out);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe("git_failed");
    rmSync(dir, { recursive: true, force: true });
  });
});

// Source-anchored: proves the REAL shipped entry point wires a `.catch` onto
// `main().then(...)` — see ship-config.ts's identical regression test for why this matters
// (MUST-CHECK wrap-injected-runner-spawn-in-try-catch's sibling concern at the promise level).
describe("the real CLI entry point wires .catch onto main().then(...) (source-anchored)", () => {
  test("import.meta.main wiring exists in the shipped file", () => {
    const txt = readFileSync(join(import.meta.dir, "stack.ts"), "utf8");
    const entryStart = txt.indexOf("if (import.meta.main)");
    expect(entryStart, "'if (import.meta.main)' entry point not found").toBeGreaterThan(-1);
    const entry = txt.slice(entryStart);
    expect(entry).toMatch(/main\(\)\s*\.then\(\(code\)\s*=>\s*process\.exit\(code\)\)\s*\.catch\(/);
    expect(entry).toContain("process.exit(1)");
  });
});
