import { test, expect, describe } from "bun:test";
import { readFileSync, mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { isValidRefName, type ResolvedConfig, type Runner } from "./ship-config";
import type { RunState, StackEntry } from "./run-state";
import {
  resolveBase,
  assertChainIntact,
  parseCliArgs,
  main,
  planCrashCleanup,
  baseForNextStory,
  SALVAGE_BRANCH_PREFIX,
  type MainDeps,
} from "./stack";

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
//   - `rev-list --count <base>..<branch> --` (PCO-381) exits 0 and prints the count on stdout
//     for BOTH a commitless branch ("0") and a populated one ("1"), and exits 128 for a bogus
//     ref. Unlike every other check here, the failure it detects is signalled in STDOUT, not
//     in the exit code — verified against live git 2.50.1, including that two unrelated
//     histories count as >0 (which is why `branch_moved` must be decided before this).
function makeGitRunner(
  opts: {
    missingRefs?: Set<string>;
    gitErrorRefs?: Set<string>;
    ancestorExit?: (base: string, branch: string) => number;
    revListCount?: (base: string, branch: string) => { code: number; stdout: string };
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
    if (argv[2] === "rev-list") {
      // PCO-381, enforced on EVERY call through this one shared fake: the range's two halves
      // must both be `refs/heads/`-qualified for the same reason merge-base's arguments are
      // (a same-named tag would otherwise answer a question about a different object), and the
      // `--` terminator must be present so a branch name can never be re-read as a pathspec.
      expect(argv.length, `rev-list argv must be exactly 6 elements, got: ${argv.join(" ")}`).toBe(6);
      expect(argv[3], "rev-list must ask for --count").toBe("--count");
      expect(argv[4], "rev-list's range must be refs/heads/<base>..refs/heads/<branch>").toMatch(
        /^refs\/heads\/[^.]\S*\.\.refs\/heads\/\S+$/,
      );
      expect(argv[5], "rev-list must terminate its revisions with --").toBe("--");
      const [baseRef, branchRef] = argv[4]!.split("..");
      const base = baseRef!.slice("refs/heads/".length);
      const branch = branchRef!.slice("refs/heads/".length);
      const res = opts.revListCount ? opts.revListCount(base, branch) : { code: 0, stdout: "1\n" };
      return { ...res, stderr: res.code === 0 ? "" : "fatal: ambiguous argument" };
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
    // 4 per intact entry since PCO-381 added the commit-count check (was 3).
    expect(calls.length).toBe(4);
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
    // Entries 0 and 1 are both fully intact — their git calls (4 each: two rev-parse, one
    // merge-base, one rev-list) DID happen; the mismatch at index 2 is caught before ITS git
    // calls. The count went 3 -> 4 per entry when PCO-381 added the commit-count check.
    expect(calls.length).toBe(8);
    expect(calls.filter((c) => c[2] === "rev-list").length).toBe(2);
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

// --- PCO-381 rule 1: never branch off an incomplete base ----------------------------------
//
// A branch with zero commits beyond its base is a DISTINCT failure from `branch_moved`: the
// chain is perfectly intact (the base is still an ancestor — trivially, they are the same
// commit), and every existing check above passes. It is what a dead implementer leaves behind,
// and basing the next story on it is what turns one failed story into a stack of garbage PRs.
describe("assertChainIntact — a commitless branch is its own named refusal (PCO-381)", () => {
  test("a recorded branch with zero commits beyond its base refuses branch_commitless", () => {
    const { run } = makeGitRunner({ revListCount: () => ({ code: 0, stdout: "0\n" }) });
    const result = assertChainIntact({ stack: [STORY_A_ENTRY], resolved_config: VALID_RESOLVED_CONFIG }, PROJECT_DIR, run);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("branch_commitless");
  });

  // The whole point of the story: this reason must be distinguishable from `branch_moved`, so a
  // resume can reset a commitless branch (safe, it holds nothing) without ever resetting a
  // rebased one (destructive, it holds the story's work).
  test("branch_commitless is a different reason from branch_moved, on inputs that differ only in commit count", () => {
    const { run: commitless } = makeGitRunner({ revListCount: () => ({ code: 0, stdout: "0\n" }) });
    const { run: moved } = makeGitRunner({ ancestorExit: () => 1 });
    const a = assertChainIntact({ stack: [STORY_A_ENTRY], resolved_config: VALID_RESOLVED_CONFIG }, PROJECT_DIR, commitless);
    const b = assertChainIntact({ stack: [STORY_A_ENTRY], resolved_config: VALID_RESOLVED_CONFIG }, PROJECT_DIR, moved);
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (a.ok || b.ok) return;
    expect(a.reason).not.toBe(b.reason);
    expect(a.reason).toBe("branch_commitless");
    expect(b.reason).toBe("branch_moved");
  });

  test("a branch with one commit beyond its base passes — the boundary is 0 vs 1, not 0 vs many", () => {
    const { run } = makeGitRunner({ revListCount: () => ({ code: 0, stdout: "1\n" }) });
    const result = assertChainIntact({ stack: [STORY_A_ENTRY], resolved_config: VALID_RESOLVED_CONFIG }, PROJECT_DIR, run);
    expect(result).toEqual({ ok: true });
  });

  // Ordering pin: `branch_moved` is decided BEFORE the count. Verified against real git that two
  // unrelated histories report a count > 0 — so a count-first implementation would pass a chain
  // whose base is not an ancestor at all, which is the more serious of the two defects.
  test("a branch that has BOTH moved and commits reports branch_moved, not the count verdict", () => {
    const { run } = makeGitRunner({ ancestorExit: () => 1, revListCount: () => ({ code: 0, stdout: "3\n" }) });
    const result = assertChainIntact({ stack: [STORY_A_ENTRY], resolved_config: VALID_RESOLVED_CONFIG }, PROJECT_DIR, run);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("branch_moved");
  });

  test("a genuine git error from rev-list (exit 128) is git_failed, never read as a zero count", () => {
    const { run } = makeGitRunner({ revListCount: () => ({ code: 128, stdout: "" }) });
    const result = assertChainIntact({ stack: [STORY_A_ENTRY], resolved_config: VALID_RESOLVED_CONFIG }, PROJECT_DIR, run);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("git_failed");
  });

  // `Number("")` is 0 and `Number("  ")` is 0 — an empty stdout on a zero exit would silently
  // become "commitless" under a bare `Number(...)`, diagnosing a broken git as a clean verdict.
  test.each([["", "empty stdout"], ["not-a-number\n", "non-numeric stdout"], ["1.5\n", "non-integer stdout"]])(
    "unparseable rev-list stdout (%p, %s) is git_failed, never coerced to a count",
    (stdout) => {
      const { run } = makeGitRunner({ revListCount: () => ({ code: 0, stdout: stdout as string }) });
      const result = assertChainIntact({ stack: [STORY_A_ENTRY], resolved_config: VALID_RESOLVED_CONFIG }, PROJECT_DIR, run);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe("git_failed");
    },
  );

  // The guard that actually matters for the story: story N+1 is dispatched only after the chain
  // asserts, so a commitless story N branch must refuse even when it is the LAST entry of a
  // longer, otherwise-healthy chain — not merely when it is the only one.
  test("a commitless LAST entry refuses even when every earlier entry is healthy", () => {
    const { run } = makeGitRunner({
      revListCount: (_base, branch) => ({ code: 0, stdout: branch === STORY_B_ENTRY.branch ? "0\n" : "2\n" }),
    });
    const result = assertChainIntact(VALID_CHAIN_STATE, PROJECT_DIR, run);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("branch_commitless");
    expect(result.detail).toContain(STORY_B_ENTRY.story);
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
      // `rev-list --count` (PCO-381) carries its answer in stdout, not the exit code — a blanket
      // empty stdout would now be an unparseable count and refuse `git_failed`, which would make
      // this test pass for the wrong reason on the assertions below.
      git: (argv) => {
        gitCalls.push(argv);
        return { code: 0, stdout: argv[2] === "rev-list" ? "1\n" : "", stderr: "" };
      },
      writeStdout: (s) => { written += s; },
      writeStderr: () => {},
    });
    expect(code).toBe(0);
    expect(JSON.parse(written)).toEqual({ ok: true });
    expect(gitCalls.length).toBeGreaterThan(0);
    // The new check really did run through this CLI path, not just through the unit tests.
    expect(gitCalls.some((argv) => argv[2] === "rev-list")).toBe(true);
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

// --- PCO-381 rule 2: resume must clean up after a dead agent -------------------------------
//
// The crash this exists for left a branch with ZERO commits and a 509-line untracked file in
// the tree. A naive retry runs `git checkout -b <branch>` and dies on "already exists" — so
// the resume path fails on the wreckage of the first failure instead of recovering from it.
//
// `planCrashCleanup` is a read-only observer that returns a NAMED plan; it performs no git
// write itself (the runbook executes the plan). Every observation is an injected git call, so
// Locked 5 — "tests pass with `git` absent from PATH" — still holds.
//
// Real-git assumptions encoded in this fake, verified against live git 2.50.1:
//   - `status --porcelain` exits 0 and prints one line per change, INCLUDING untracked files
//     as `?? <path>` — the crash's 509-line spec file was untracked, so a fake that only
//     modelled tracked changes would pass a plan that discards exactly the work at issue.
//   - `branch -d` (which the runbook executes, never `-D`) exits 1 and refuses on a branch
//     holding unmerged commits — the fail-closed backstop behind this plan.
function makeCleanupRunner(
  opts: {
    existingRefs?: Set<string>;
    gitErrorRefs?: Set<string>;
    porcelain?: { code: number; stdout: string };
    revListCount?: (base: string, branch: string) => { code: number; stdout: string };
  } = {},
): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const existing = opts.existingRefs ?? new Set([`refs/heads/${STORY_A_ENTRY.base}`, `refs/heads/${STORY_A_ENTRY.branch}`]);
  const run: Runner = (argv) => {
    calls.push(argv);
    if (argv[2] === "rev-parse") {
      const ref = argv[argv.length - 1]!;
      if (opts.gitErrorRefs?.has(ref)) return { code: 128, stdout: "", stderr: "fatal: not a git repository" };
      return existing.has(ref) ? { code: 0, stdout: "deadbeefcafe\n", stderr: "" } : { code: 1, stdout: "", stderr: "" };
    }
    if (argv[2] === "status") {
      expect(argv[3], "dirtiness must be read with --porcelain, whose output is stable across git versions").toBe(
        "--porcelain",
      );
      const res = opts.porcelain ?? { code: 0, stdout: "" };
      return { ...res, stderr: res.code === 0 ? "" : "fatal: not a git repository" };
    }
    if (argv[2] === "rev-list") {
      const [baseRef, branchRef] = argv[4]!.split("..");
      const res = opts.revListCount
        ? opts.revListCount(baseRef!.slice("refs/heads/".length), branchRef!.slice("refs/heads/".length))
        : { code: 0, stdout: "0\n" };
      return { ...res, stderr: res.code === 0 ? "" : "fatal: ambiguous argument" };
    }
    return { code: 1, stdout: "", stderr: `unexpected git invocation: ${argv.join(" ")}` };
  };
  return { run, calls };
}

const CRASHED_BRANCH = STORY_A_ENTRY.branch;
const CRASHED_BASE = STORY_A_ENTRY.base;
const DIRTY_TREE = { code: 0, stdout: "A  tracked.txt\n?? spec.md\n" };

describe("planCrashCleanup — names what the resume must do, and never plans to discard work", () => {
  test("a commitless branch with a dirty tree plans salvage_and_reset, naming where the work goes", () => {
    const { run } = makeCleanupRunner({ porcelain: DIRTY_TREE });
    const plan = planCrashCleanup(PROJECT_DIR, CRASHED_BRANCH, CRASHED_BASE, run);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.action).toBe("salvage_and_reset");
    expect(plan.salvageBranch).toBe(`${SALVAGE_BRANCH_PREFIX}${CRASHED_BRANCH}`);
    expect(plan.dirty).toBe(true);
    expect(plan.commits).toBe(0);
  });

  // The salvage destination must itself be a legal ref name, or the plan names a command that
  // cannot run — the failure would surface only at 3am, on the recovery path, in the dark.
  test("the salvage branch it names is a valid git ref name", () => {
    const { run } = makeCleanupRunner({ porcelain: DIRTY_TREE });
    const plan = planCrashCleanup(PROJECT_DIR, CRASHED_BRANCH, CRASHED_BASE, run);
    if (!plan.ok) throw new Error("expected a plan");
    expect(isValidRefName(plan.salvageBranch!)).toBe(true);
  });

  test("a commitless branch with a clean tree plans reset_branch — nothing to preserve, and no salvage ref invented", () => {
    const { run } = makeCleanupRunner();
    const plan = planCrashCleanup(PROJECT_DIR, CRASHED_BRANCH, CRASHED_BASE, run);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.action).toBe("reset_branch");
    expect(plan.salvageBranch).toBeNull();
    expect(plan.branchExists).toBe(true);
  });

  // The existing runbook behaviour, preserved deliberately: a branch that HAS commits is the
  // crashed run's real output. It is resumed on, never reset — resetting it is the destructive
  // mistake this whole plan exists to keep separate from the safe one.
  test("a branch with commits plans resume_on_branch, never a reset, even when the tree is dirty", () => {
    const { run } = makeCleanupRunner({ porcelain: DIRTY_TREE, revListCount: () => ({ code: 0, stdout: "4\n" }) });
    const plan = planCrashCleanup(PROJECT_DIR, CRASHED_BRANCH, CRASHED_BASE, run);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.action).toBe("resume_on_branch");
    expect(plan.commits).toBe(4);
    expect(plan.dirty).toBe(true);
    expect(plan.salvageBranch).toBeNull();
  });

  test("no branch and a clean tree plans clean_start — the crash never got as far as cutting a branch", () => {
    const { run } = makeCleanupRunner({ existingRefs: new Set([`refs/heads/${CRASHED_BASE}`]) });
    const plan = planCrashCleanup(PROJECT_DIR, CRASHED_BRANCH, CRASHED_BASE, run);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.action).toBe("clean_start");
    expect(plan.branchExists).toBe(false);
    expect(plan.commits).toBe(0);
  });

  test("no branch but a dirty tree still salvages — uncommitted work outlives the branch that was never cut", () => {
    const { run } = makeCleanupRunner({ existingRefs: new Set([`refs/heads/${CRASHED_BASE}`]), porcelain: DIRTY_TREE });
    const plan = planCrashCleanup(PROJECT_DIR, CRASHED_BRANCH, CRASHED_BASE, run);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.action).toBe("salvage_and_reset");
    expect(plan.branchExists).toBe(false);
    expect(plan.salvageBranch).toBe(`${SALVAGE_BRANCH_PREFIX}${CRASHED_BRANCH}`);
  });

  // "Never discard it silently" applied to the salvage destination itself: a second crash on
  // the same story must not overwrite the first crash's preserved work.
  test("an already-existing salvage ref refuses salvage_ref_exists rather than overwriting the earlier salvage", () => {
    const { run } = makeCleanupRunner({
      existingRefs: new Set([
        `refs/heads/${CRASHED_BASE}`,
        `refs/heads/${CRASHED_BRANCH}`,
        `refs/heads/${SALVAGE_BRANCH_PREFIX}${CRASHED_BRANCH}`,
      ]),
      porcelain: DIRTY_TREE,
    });
    const plan = planCrashCleanup(PROJECT_DIR, CRASHED_BRANCH, CRASHED_BASE, run);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe("salvage_ref_exists");
  });

  test("an existing salvage ref does NOT block a plan that was never going to salvage", () => {
    const { run } = makeCleanupRunner({
      existingRefs: new Set([
        `refs/heads/${CRASHED_BASE}`,
        `refs/heads/${CRASHED_BRANCH}`,
        `refs/heads/${SALVAGE_BRANCH_PREFIX}${CRASHED_BRANCH}`,
      ]),
      revListCount: () => ({ code: 0, stdout: "2\n" }),
    });
    const plan = planCrashCleanup(PROJECT_DIR, CRASHED_BRANCH, CRASHED_BASE, run);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.action).toBe("resume_on_branch");
  });
});

describe("planCrashCleanup — refuses before it ever reaches git, on the same trust roots as assertChainIntact", () => {
  test("a projectDir that is not a clean absolute path refuses, with no git call made", () => {
    const { run, calls } = makeCleanupRunner();
    const plan = planCrashCleanup("relative/dir", CRASHED_BRANCH, CRASHED_BASE, run);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe("invalid_project_dir");
    expect(calls).toEqual([]);
  });

  test.each([
    ["--upload-pack=x", "a git OPTION, executed by git itself"],
    ["+refs/heads/x:refs/remotes/origin/main", "a REFSPEC, not a branch name"],
  ])("a git-argv-injection-shaped branch (%p — %s) refuses invalid_ref_shape with no git call made", (branch) => {
    const { run, calls } = makeCleanupRunner();
    const plan = planCrashCleanup(PROJECT_DIR, branch as string, CRASHED_BASE, run);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe("invalid_ref_shape");
    expect(calls).toEqual([]);
  });

  test("a git-argv-injection-shaped base refuses invalid_ref_shape with no git call made", () => {
    const { run, calls } = makeCleanupRunner();
    const plan = planCrashCleanup(PROJECT_DIR, CRASHED_BRANCH, "--upload-pack=x", run);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe("invalid_ref_shape");
    expect(calls).toEqual([]);
  });

  // Resetting the tree "to the base" is meaningless if the base is gone — and a missing base is
  // exactly what a mid-run force-push or a manual branch deletion leaves behind.
  test("a missing base refuses base_missing rather than planning a reset onto a ref that is not there", () => {
    const { run } = makeCleanupRunner({ existingRefs: new Set([`refs/heads/${CRASHED_BRANCH}`]) });
    const plan = planCrashCleanup(PROJECT_DIR, CRASHED_BRANCH, CRASHED_BASE, run);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe("base_missing");
  });

  test("a git error on the base probe (exit 128) is git_failed, distinct from base_missing", () => {
    const { run } = makeCleanupRunner({ gitErrorRefs: new Set([`refs/heads/${CRASHED_BASE}`]) });
    const plan = planCrashCleanup(PROJECT_DIR, CRASHED_BRANCH, CRASHED_BASE, run);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe("git_failed");
  });

  test("a git error on the branch probe (exit 128) is git_failed, never read as 'no branch'", () => {
    const { run } = makeCleanupRunner({ gitErrorRefs: new Set([`refs/heads/${CRASHED_BRANCH}`]) });
    const plan = planCrashCleanup(PROJECT_DIR, CRASHED_BRANCH, CRASHED_BASE, run);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe("git_failed");
  });

  // A failed dirtiness read must never present as "clean". Clean is the one answer that
  // authorises deleting a branch with no salvage at all.
  test("a failing status --porcelain is git_failed, never silently treated as a clean tree", () => {
    const { run } = makeCleanupRunner({ porcelain: { code: 128, stdout: "" } });
    const plan = planCrashCleanup(PROJECT_DIR, CRASHED_BRANCH, CRASHED_BASE, run);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe("git_failed");
  });

  test("a failing rev-list is git_failed, never read as a zero count that would authorise a reset", () => {
    const { run } = makeCleanupRunner({ revListCount: () => ({ code: 128, stdout: "" }) });
    const plan = planCrashCleanup(PROJECT_DIR, CRASHED_BRANCH, CRASHED_BASE, run);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe("git_failed");
  });
});

describe("baseForNextStory — Locked A's selection rule, with one implementation site (PCO-381)", () => {
  test("an empty stack selects the configured base branch", () => {
    expect(baseForNextStory({ stack: [], resolved_config: VALID_RESOLVED_CONFIG })).toBe("trunk");
  });

  // Same CRITICAL-1 mutant `resolveBase` is pinned against: at length <= 2 the LAST entry and
  // the FIRST entry coincide, so only a 3-entry stack distinguishes them.
  test("a 3-entry stack selects the LAST entry's branch, not the first", () => {
    const selected = baseForNextStory({
      stack: [STORY_A_ENTRY, STORY_B_ENTRY, STORY_C_ENTRY],
      resolved_config: VALID_RESOLVED_CONFIG,
    });
    expect(selected).toBe(STORY_C_ENTRY.branch);
    expect(selected).not.toBe(STORY_A_ENTRY.branch);
  });

  // Single-implementation-site: `resolveBase` must ANSWER with this helper, not carry a second
  // copy of the same selection rule that can drift from it.
  test("resolveBase's answer agrees with baseForNextStory on the same state", () => {
    const state = { ...BASE_RUN_STATE, snapshot: ["story-a", "story-b"], stack: [STORY_A_ENTRY] };
    const result = resolveBase(state, "story-b", { baseBranch: "trunk" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.base).toBe(baseForNextStory(state));
  });
});

// --- CLI: `plan-cleanup --state <path> --project-dir <dir> --branch <name>` ----------------

describe("parseCliArgs — plan-cleanup's own flag contract (PCO-381)", () => {
  test("plan-cleanup parses well-formed --state, --project-dir and --branch", () => {
    const result = parseCliArgs("plan-cleanup", [
      "--state", "/tmp/run.json",
      "--project-dir", "/tmp/repo",
      "--branch", "story-a-branch",
    ]);
    expect(result).toEqual({ ok: true, state: "/tmp/run.json", projectDir: "/tmp/repo", branch: "story-a-branch" });
  });

  test.each([
    [["--state", "/tmp/run.json", "--project-dir", "/tmp/repo"], "--branch is required"],
    [["--state", "/tmp/run.json", "--branch", "story-a-branch"], "--project-dir is required"],
    [["--project-dir", "/tmp/repo", "--branch", "story-a-branch"], "--state is required"],
  ])("plan-cleanup with %p refuses: %s", (args, expected) => {
    const result = parseCliArgs("plan-cleanup", args as string[]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(expected);
  });

  // Same both-directions discipline the other two subcommands get: a flag with no consumable
  // value binds boolean `true` and must be refused, never silently treated as absent.
  test("plan-cleanup's --branch with no consumable value is refused, not read as absent", () => {
    const result = parseCliArgs("plan-cleanup", ["--state", "/tmp/run.json", "--project-dir", "/tmp/repo", "--branch"]);
    expect(result).toEqual({ ok: false, error: "--branch requires a value" });
  });

  test("plan-cleanup's --branch repeated is refused", () => {
    const result = parseCliArgs("plan-cleanup", [
      "--state", "/tmp/run.json", "--project-dir", "/tmp/repo", "--branch", "a", "--branch", "b",
    ]);
    expect(result).toEqual({ ok: false, error: "--branch specified more than once" });
  });

  test("plan-cleanup rejects --story: the crashed story's branch is named directly, never inferred from an id", () => {
    const result = parseCliArgs("plan-cleanup", [
      "--state", "/tmp/run.json", "--project-dir", "/tmp/repo", "--branch", "a", "--story", "story-a",
    ]);
    expect(result).toEqual({ ok: false, error: "--story is not valid for plan-cleanup" });
  });

  // Accepting-but-ignoring a flag invites a caller to believe it does something — the same
  // reason `--project-dir` is forbidden for resolve-base.
  test.each([
    ["resolve-base" as const, ["--state", "/tmp/run.json", "--story", "a", "--branch", "b"], "--branch is not valid for resolve-base"],
    ["assert-chain" as const, ["--state", "/tmp/run.json", "--project-dir", "/tmp/repo", "--branch", "b"], "--branch is not valid for assert-chain"],
  ])("%s rejects --branch", (cmd, args, expected) => {
    const result = parseCliArgs(cmd, args as string[]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(expected);
  });
});

describe("main() — plan-cleanup wires the state's own base in, and keeps --project-dir as the trust root", () => {
  // The base is NOT taken from a flag: it is `baseForNextStory` applied to the run's own stack,
  // so a resume cannot be pointed at an arbitrary base by whoever types the command.
  test("plan-cleanup derives the base from the run state's stack, not from an operator-supplied flag", async () => {
    let written = "";
    const gitCalls: string[][] = [];
    const stacked: RunState = { ...VALID_RUN_STATE, stack: [STORY_A_ENTRY] };
    const code = await main({
      argv: [
        "plan-cleanup",
        "--state", "/tmp/run.json",
        "--project-dir", VALID_RESOLVED_CONFIG.projectDir,
        "--branch", "story-b-branch",
      ],
      readState: () => JSON.stringify(stacked),
      git: (argv) => {
        gitCalls.push(argv);
        if (argv[2] === "rev-parse") {
          return { code: argv[argv.length - 1] === `refs/heads/${STORY_A_ENTRY.branch}` ? 0 : 1, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      writeStdout: (s) => { written += s; },
      writeStderr: () => {},
    });
    expect(code).toBe(0);
    const plan = JSON.parse(written);
    expect(plan.ok).toBe(true);
    // Locked A: story B's base is story A's BRANCH, never the configured `trunk`.
    expect(plan.base).toBe(STORY_A_ENTRY.branch);
    expect(plan.base).not.toBe(VALID_RESOLVED_CONFIG.baseBranch);
    expect(plan.action).toBe("clean_start");
  });

  test("plan-cleanup on an empty stack derives the configured base branch", async () => {
    let written = "";
    // The run's FIRST story: nothing stacked yet, so Locked A's base is the configured one.
    const firstStory: RunState = { ...VALID_RUN_STATE, stack: [] };
    const code = await main({
      argv: [
        "plan-cleanup",
        "--state", "/tmp/run.json",
        "--project-dir", VALID_RESOLVED_CONFIG.projectDir,
        "--branch", "story-a-branch",
      ],
      readState: () => JSON.stringify(firstStory),
      git: (argv) => {
        if (argv[2] === "rev-parse") {
          return { code: argv[argv.length - 1] === `refs/heads/${VALID_RESOLVED_CONFIG.baseBranch}` ? 0 : 1, stdout: "", stderr: "" };
        }
        return { code: 0, stdout: "", stderr: "" };
      },
      writeStdout: (s) => { written += s; },
      writeStderr: () => {},
    });
    expect(code).toBe(0);
    expect(JSON.parse(written).base).toBe(VALID_RESOLVED_CONFIG.baseBranch);
  });

  // CRITICAL 3, applied to the new verb: the state file is agent-writable, so its own
  // projectDir copy must never reach `git -C`. Disagreement refuses before any git call.
  test("plan-cleanup: --project-dir disagreeing with resolved_config.projectDir refuses with ZERO git calls", async () => {
    let written = "";
    const gitCalls: string[][] = [];
    const code = await main({
      argv: ["plan-cleanup", "--state", "/tmp/run.json", "--project-dir", "/tmp/decoy-repo", "--branch", "story-a-branch"],
      readState: () => JSON.stringify(VALID_RUN_STATE),
      git: (argv) => { gitCalls.push(argv); return { code: 0, stdout: "", stderr: "" }; },
      writeStdout: (s) => { written += s; },
      writeStderr: () => {},
    });
    expect(code).toBe(1);
    expect(JSON.parse(written).reason).toBe("project_dir_untrusted");
    expect(gitCalls).toEqual([]);
  });

  test("plan-cleanup anchors every git call at the FLAG's literal value, not the state file's copy", async () => {
    const gitCalls: string[][] = [];
    const flagDir = `${VALID_RESOLVED_CONFIG.projectDir}/.`;
    await main({
      argv: ["plan-cleanup", "--state", "/tmp/run.json", "--project-dir", flagDir, "--branch", "story-a-branch"],
      readState: () => JSON.stringify(VALID_RUN_STATE),
      git: (argv) => { gitCalls.push(argv); return { code: 0, stdout: argv[2] === "rev-list" ? "1\n" : "", stderr: "" }; },
      writeStdout: () => {},
      writeStderr: () => {},
    });
    expect(gitCalls.length).toBeGreaterThan(0);
    for (const argv of gitCalls) {
      expect(argv[1]).toBe(flagDir);
      expect(argv[1]).not.toBe(VALID_RESOLVED_CONFIG.projectDir);
    }
  });

  test("plan-cleanup writes a refusal verdict to stdout and exits 1 on a business refusal", async () => {
    let written = "";
    const code = await main({
      argv: [
        "plan-cleanup",
        "--state", "/tmp/run.json",
        "--project-dir", VALID_RESOLVED_CONFIG.projectDir,
        "--branch", "story-a-branch",
      ],
      readState: () => JSON.stringify(VALID_RUN_STATE),
      // Base missing: every rev-parse reports absent.
      git: () => ({ code: 1, stdout: "", stderr: "" }),
      writeStdout: (s) => { written += s; },
      writeStderr: () => {},
    });
    expect(code).toBe(1);
    expect(JSON.parse(written)).toMatchObject({ ok: false, reason: "base_missing" });
  });

  test("the usage line names all three subcommands", async () => {
    let err = "";
    const code = await main({ argv: ["bogus"], writeStderr: (s) => { err += s; }, writeStdout: () => {} });
    expect(code).toBe(1);
    expect(err).toContain("resolve-base");
    expect(err).toContain("assert-chain");
    expect(err).toContain("plan-cleanup");
  });
});
