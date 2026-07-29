// The step 4 ("## 4. Merge") merge guards for `/drawbar-ship`, extracted whole out of
// `commands/drawbar-ship.md`'s bash fence and put behind tests (S6/PCO-351). Two pure
// verdict functions, same house style as `scripts/lib/ship-config.ts`'s `validateShipConfig`
// and `scripts/lib/coderabbit.ts`'s `checkPr` — deterministic given the injected `Runner`'s
// answers, testable with `gh`/`git` absent from PATH (Locked 5):
//
//   - `mergeVerdict` — everything that must be true BEFORE `gh pr merge` runs: identity
//     (branch names the story), base, state, snapshot membership, requiredChecks (Locked 19 —
//     closes the F19 vacuity gap), the `ship.config.json` diff refusal (Locked 18), and a
//     re-assertion of `resolved_config`'s own shape (also Locked 18).
//   - `recordMergeSha` — runs AFTER `gh pr merge`, capturing the full 40-char merge-commit
//     oid (never the PR head sha) and asserting ancestry at record time (Locked 10).
//
// `commands/drawbar-ship.md` §4 delegates the ENTIRE verdict to this module's CLI — there is
// no second, hand-copied bash implementation of any of the checks above (this repo has a
// single-implementation-site regression discipline; see scripts/plugin.test.ts).
//
// This module IS the module Locked 4 ("no sixth `scripts/lib/` module") otherwise forbids
// adding — everything above lives here, not in a new module, and this file is itself the one
// exception the lock accounts for (see coderabbit.ts's own comment on that constraint).

import { basename } from "node:path";
import { isValidPr, isValidRepo, CODERABBIT_CONTEXT } from "./coderabbit";
import { isValidResolvedConfig } from "./run-state";
import { isCleanAbsolutePath, isNonEmptyTrimmed, isValidRefName, sanitizeForOutput } from "./ship-config";
import type { ResolvedConfig, Runner } from "./ship-config";

// --- lc() case-insensitive identity comparison, and its self-test -----------------------
//
// Linear ids are uppercase (`<TEAM>-####`); the branches its GitHub integration generates
// are lowercase (`user/<team>-####-slug`) — `lc()` is what lets the identity guard compare
// them without caring which. A field report once claimed this exact guard was vacuous
// because `$1` had been stripped in the shell copy being read; git history showed every
// committed version was correct, and settling the question took an archaeology dig instead
// of one line. `lc` is exported, and `lcSelfTestPasses` below runs the same one-line
// assertion the bash version ran inline (`[ "$(lc ABC-1)" = "abc-1" ]`) as part of every
// verdict, so the same class of "silently vacuous" failure would be caught here too rather
// than trusted to TypeScript's type system alone.
export function lc(s: string): string {
  return s.toLowerCase();
}

function lcSelfTestPasses(): boolean {
  return lc("ABC-1") === "abc-1";
}

// --- shared string-validation primitive --------------------------------------------------
//
// MUST-CHECK path-segment-shape-check-must-also-reject-control-chars /
// single-implementation-site: `isNonEmptyTrimmed` (rejecting C0 control characters, including
// a literal newline, and DEL, plus whitespace-only strings) now lives ONCE in ship-config.ts
// and is imported here — this module used to carry its own byte-identical copy, and
// run-state.ts carried a third (`isNonEmptyString`); a fix pass consolidated all three into
// ship-config.ts's single canonical implementation, reused (not reimplemented) by both.
//
// --- ref-name shape guard (Important 1) ---------------------------------------------------
//
// `baseBranch` (both `resolvedConfig.baseBranch` here and `recordMergeSha`'s own `baseBranch`
// input) ends up as a positional argument to `git fetch`/`git merge-base --is-ancestor` below.
// `isValidRefName` used to be a byte-identical copy carried here; relocated to ship-config.ts
// (Minor, fix pass 2) so `validateShipConfig` can apply the SAME check at T0/preflight, not
// only here at merge time — see that module's comment for the full threat description.

// --- mergeVerdict ---------------------------------------------------------------------

export interface VerdictInput {
  story: string;
  pr: string;
  repo: string;
  resolvedConfig: ResolvedConfig;
  // Injected DATA (T0 snapshot), not fetched by this function — same discipline
  // ship-config.ts's `linear: LinearFacts` uses: the caller already has it (the run-state
  // file), so this module never re-derives it from a Linear MCP call it has no access to.
  snapshot: string[];
  // Critical 3(c): the RESOLVED effective config path (`ship-config.ts`'s `resolveConfigPath`
  // output — honours `DRAWBAR_SHIP_CONFIG` for ANY basename, not just the hardcoded default).
  // Optional and ADDITIVE only: when supplied, its basename is matched alongside the default
  // `ship.config.json` basename below, never in place of it.
  configPath?: string;
  gh: Runner;
}

export type VerdictReason =
  | "invalid_repo_shape"
  | "invalid_pr_shape"
  | "invalid_resolved_config"
  | "invalid_base_branch_shape"
  | "repo_mismatch"
  | "base_branch_not_default"
  // Important F: the independently-observed `gh repo view` call failing outright — distinct
  // from `base_branch_not_default` (the value disagreeing) and from `gh_failed`-style reasons
  // elsewhere, so an operator can tell "the fetch itself broke" from "the values disagree".
  | "default_branch_fetch_failed"
  | "lc_self_test_failed"
  | "story_unset"
  | "story_not_in_snapshot"
  | "pr_view_failed"
  | "branch_identity_mismatch"
  | "base_mismatch"
  | "pr_not_open"
  | "checks_fetch_failed"
  // Minor (fix pass 2): `parseChecks` used to swallow a JSON parse failure into `[]`, which
  // then surfaced as `required_check_missing: <first requiredChecks name>` — the wrong
  // diagnosis (looks like a missing check, not a malformed `gh pr checks` response).
  | "checks_parse_failed"
  | "checks_failing"
  | "checks_still_pending"
  | "required_check_missing"
  | "checks_only_coderabbit"
  // Critical B: `gh api .../pulls/<pr>/files --paginate` truncates SILENTLY (exit 0, a short
  // list, no error) once a PR exceeds GitHub's 3000-file server-side cap on that endpoint —
  // refused before ever trusting a files list that might have been cut off.
  | "diff_too_large_to_verify"
  | "diff_fetch_failed"
  | "config_diff_touches_ship_config"
  // Important C (fix pass 2): renamed from `config_diff_touches_workflow` — the refusal now
  // covers the whole `.github/` prefix, not only `.github/workflows/**`, so a reason still
  // named after "workflow" alone would misdescribe what actually fired.
  | "config_diff_touches_dot_github";

export type Verdict = { ok: true } | { ok: false; reason: VerdictReason; detail?: string };

const SHIP_CONFIG_BASENAME = "ship.config.json";
// Important C (fix pass 2): widened from `.github/workflows/` to the whole `.github/` prefix.
// `.github/workflows/**` alone doesn't close the class this refusal exists for — a required
// workflow that does `uses: ./.github/actions/foo` can have that COMPOSITE ACTION rewritten to
// `exit 0` while the required check keeps its passing name, and the workflow file itself never
// changes. Fail-closed anyway (the operator notes below cover the one legitimate case this
// costs); also incidentally covers CODEOWNERS and any other GitHub-consumed metadata under
// `.github/`. NOTE (comment correction, fix pass 2): this is DEFENCE IN DEPTH, not closure —
// the actual control is the target repo's own branch protection; this module can only ever see
// the PR's diff, never enforce what the repo's branch-protection settings require.
const GITHUB_PREFIX = ".github/";

// GitHub's list-PR-files endpoint (`gh api repos/<repo>/pulls/<pr>/files`) returns AT MOST this
// many entries — past the cap it simply stops emitting a `next` Link header rather than
// erroring, so `--paginate` exits 0 with a truncated list. `gh pr view --json changedFiles` is
// the independent, truthful total the truncated list itself cannot lie about.
const MAX_FILES_TO_VERIFY = 3000;

// Order below is deliberate, same reasoning ship-config.ts's `validateShipConfig` documents
// for its own ordering: the endpoint-injection guard (repo/pr shape) runs BEFORE any `gh`
// call at all (proven by a call-counter spy in tests), and every check that can be decided
// from already-in-hand DATA (resolved_config's own shape, the lc self-test, story non-empty,
// snapshot membership) runs before the first network call — so a refusal at any of those
// stages is provably not a `gh`/network failure in disguise.
export function mergeVerdict(input: VerdictInput): Verdict {
  const { story, pr, repo, resolvedConfig, snapshot, gh } = input;

  // Endpoint-injection guard (MUST-CHECK endpoint-injection-not-just-command-injection):
  // `repo`/`pr` end up in `gh pr ...` argv below — refused before any runner call at all.
  if (!isValidRepo(repo)) return { ok: false, reason: "invalid_repo_shape", detail: repo };
  if (!isValidPr(pr)) return { ok: false, reason: "invalid_pr_shape", detail: pr };

  // Locked 18: re-assert resolved_config's shape at merge time, before trusting ANY of its
  // fields below (`baseBranch`, `requiredChecks`) — a resolved_config corrupted between the
  // T0 snapshot and merge time must fail here, not leak a bad value into a later check.
  // Reuses run-state.ts's `isValidResolvedConfig` rather than a second hand-copy.
  if (!isValidResolvedConfig(resolvedConfig)) {
    return { ok: false, reason: "invalid_resolved_config" };
  }

  // Important 1: `resolvedConfig.baseBranch` reaches `git fetch`/`git merge-base` downstream
  // (via `recordMergeSha`'s `--base`, sourced from this same resolved config at the fence
  // level) — refused here, as data, before any gh call, rather than only at the git call site.
  if (!isValidRefName(resolvedConfig.baseBranch)) {
    return { ok: false, reason: "invalid_base_branch_shape", detail: resolvedConfig.baseBranch };
  }

  // Important 2, first half: `resolvedConfig` was re-asserted structurally (above) but never
  // bound to the repo this verdict is actually being computed for — a resolved_config the
  // caller didn't validate against `repo` could otherwise decide the verdict for it anyway.
  if (repo !== resolvedConfig.repo) {
    return { ok: false, reason: "repo_mismatch", detail: resolvedConfig.repo };
  }

  // Important 2, second half: `observed.defaultBranch` is precisely what preflight
  // (`validateShipConfig`, ship-config.ts) asserted `baseBranch` equals at T0 — re-assert that
  // same equality here so a `resolved_config` tampered between T0 and merge time (carrying a
  // forged `baseBranch` alongside its still-truthful `observed.defaultBranch`) cannot pass.
  //
  // Important F (fix pass 2): this alone is a TAUTOLOGY in production — both sides come from
  // the same caller-supplied `resolvedConfig` object, so a run-state file tampered to carry
  // `baseBranch: "attacker-branch"` alongside a matching, equally forged
  // `observed.defaultBranch: "attacker-branch"` satisfies this check by construction. Kept
  // here as a cheap, data-only, pre-network sanity check (catches an internally INCONSISTENT
  // resolvedConfig before any gh call at all — several tests pin exactly that), but it is no
  // longer the only guard: see the independently-observed `gh repo view` conjunction below,
  // once the story/snapshot checks below have run (Important F closes the actual gap; this
  // check alone never did).
  if (resolvedConfig.baseBranch !== resolvedConfig.observed.defaultBranch) {
    return { ok: false, reason: "base_branch_not_default", detail: resolvedConfig.baseBranch };
  }

  if (!lcSelfTestPasses()) {
    return { ok: false, reason: "lc_self_test_failed" };
  }

  if (!isNonEmptyTrimmed(story)) {
    return { ok: false, reason: "story_unset" };
  }

  if (!snapshot.includes(story)) {
    return { ok: false, reason: "story_not_in_snapshot", detail: story };
  }

  const viewRes = gh([
    "pr",
    "view",
    "-R",
    repo,
    pr,
    "--json",
    "headRefName,baseRefName,state,changedFiles",
    "--jq",
    '"\\(.headRefName) \\(.baseRefName) \\(.state) \\(.changedFiles)"',
  ]);
  if (viewRes.code !== 0) {
    return { ok: false, reason: "pr_view_failed", detail: viewRes.stderr || undefined };
  }
  const [branch, base, state, changedFilesRaw] = viewRes.stdout.trim().split(" ");
  // Important G (fix pass 2): branch identity used to be an UNBOUNDED substring test
  // (`includes`) — story "ABC-1" also matched a branch for a DIFFERENT story whose id happens
  // to start with the same digit(s) followed by more digits, a routine, non-adversarial
  // collision on ordinary Linear
  // auto-generated branch names, not merely the adversarial-suffix case a prior round pinned
  // as intentional. Delimiter-bounded on both sides instead: the story id must be flanked by
  // either a string boundary or a non-alphanumeric character before it, and by a string
  // boundary or a non-digit after it (so "abc-1-slug" matches but "abc-12-slug" does not) —
  // while still allowing arbitrary prefixes/suffixes around it, since auto-generated branch
  // names carry both.
  const idRe = new RegExp(`(^|[^a-z0-9])${escapeRegExp(lc(story))}([^0-9]|$)`);
  if (!branch || !idRe.test(lc(branch))) {
    return { ok: false, reason: "branch_identity_mismatch", detail: branch };
  }
  if (base !== resolvedConfig.baseBranch) {
    return { ok: false, reason: "base_mismatch", detail: base };
  }
  if (state !== "OPEN") {
    return { ok: false, reason: "pr_not_open", detail: state };
  }

  // Important F (fix pass 2): closes the tautology the comment above `base_branch_not_default`
  // now documents — an INDEPENDENTLY observed fact (the repo's actual default branch, fetched
  // fresh via `gh repo view`, never read off `resolvedConfig`) conjoined with the declared
  // `resolvedConfig.baseBranch`. A resolvedConfig tampered in BOTH `baseBranch` and its own
  // `observed.defaultBranch` together (defeating the tautology check above) still cannot pass
  // this one, because this one never reads `resolvedConfig.observed` at all. Positioned after
  // the story/snapshot/pr-view checks (all decidable from already-in-hand data) so the
  // "no network call before those" invariant those tests pin stays true — this is simply the
  // 2nd network call rather than the 1st.
  const defaultBranchRes = gh(["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
  if (defaultBranchRes.code !== 0) {
    return { ok: false, reason: "default_branch_fetch_failed", detail: defaultBranchRes.stderr || undefined };
  }
  if (defaultBranchRes.stdout.trim() !== resolvedConfig.baseBranch) {
    return { ok: false, reason: "base_branch_not_default", detail: resolvedConfig.baseBranch };
  }

  // Critical B (fix pass 2): `gh api .../pulls/<pr>/files --paginate` truncates SILENTLY at
  // GitHub's 3000-file server-side cap on that endpoint — exit 0, a short list, no error and no
  // absent-`next`-Link signal `--paginate` surfaces as a failure. An attacker who can open the
  // gated PR pads the diff past the cap with filenames sorted ahead of the real payload
  // (`.drawbar/ship.config.json`, `.github/workflows/**`), so both refusals below go silent on
  // a truncated read. `changedFiles`, from the SAME `gh pr view` call already made above, is
  // the independent, truthful total the truncated files list itself cannot lie about — refused
  // here, before the files list is ever fetched or trusted.
  const changedFiles = Number(changedFilesRaw);
  if (!Number.isFinite(changedFiles) || changedFiles >= MAX_FILES_TO_VERIFY) {
    return { ok: false, reason: "diff_too_large_to_verify", detail: changedFilesRaw };
  }

  // Locked 19 / AC L19: `gh pr checks > 0` is not evidence CI ran — the CodeRabbit status is
  // itself a check, and a workflow with path filters that skip everything reports zero
  // failures with zero real CI. Every `requiredChecks` name must be present with bucket
  // `pass`, AND at least one non-CodeRabbit check must exist among what actually ran.
  const checksRes = gh(["pr", "checks", "-R", repo, pr, "--json", "name,bucket"]);
  if (checksRes.code !== 0) {
    // Defined, tested behaviour for a non-zero `gh pr checks` exit — never `|| true`, never
    // silently swallowed.
    return { ok: false, reason: "checks_fetch_failed", detail: checksRes.stderr || undefined };
  }
  const parsedChecks = parseChecks(checksRes.stdout);
  if (!parsedChecks.ok) {
    // Minor (fix pass 2): a malformed/unparseable `gh pr checks` response used to silently
    // become an empty checks array, surfacing downstream as `required_check_missing: <first
    // requiredChecks name>` — the wrong diagnosis. Distinct, correctly-named reason instead.
    return { ok: false, reason: "checks_parse_failed" };
  }
  const checks = parsedChecks.checks;

  // Critical 1: the old §4 bash had a GLOBAL gate above the requiredChecks loop — ANY check
  // reporting fail/cancel refused the merge, not just ones named in `requiredChecks`. The
  // extraction dropped this along with its tests: nothing scanned for fail/cancel/pending on
  // checks OUTSIDE `requiredChecks`, so any CI signal not literally enumerated there (CodeQL,
  // secret scanning, an org-level required workflow) became purely advisory. Restored here,
  // scanning the WHOLE checks list, before the requiredChecks loop even runs.
  //
  // Minor (fix pass 2): this used to be a DENYLIST — only `fail`/`cancel` (below, `pending`
  // separately) refused, so any future `gh` bucket this module has never seen, or a malformed
  // entry `parseChecks` coerces to `""`, passed straight through as advisory-only. Flipped to
  // an ALLOWLIST: anything that is not `pass`/`skipping`/`pending` refuses under the same
  // `checks_failing` reason `fail`/`cancel` already used (an unrecognized bucket is, by
  // definition, not evidence of a genuine pass — fail closed, not open, on the unknown case).
  const bad = checks.filter((c) => c.bucket !== "pass" && c.bucket !== "skipping" && c.bucket !== "pending");
  if (bad.length > 0) {
    return { ok: false, reason: "checks_failing", detail: bad.map((c) => c.name).join(",") };
  }
  const pending = checks.filter((c) => c.bucket === "pending");
  if (pending.length > 0) {
    return { ok: false, reason: "checks_still_pending", detail: pending.map((c) => c.name).join(",") };
  }

  for (const name of resolvedConfig.requiredChecks) {
    const found = checks.some((c) => c.name === name && c.bucket === "pass");
    if (!found) {
      return { ok: false, reason: "required_check_missing", detail: name };
    }
  }
  // Locked 19 / AC L19, Critical 2: `gh pr checks > 0` is not evidence CI ran — the CodeRabbit
  // status is itself a check, and a workflow with path filters that skip everything reports a
  // check with zero failures AND zero real CI (bucket `skipping`, not `pass`). The anti-vacuity
  // guard must therefore require a check that is genuinely bucket `pass` (not merely PRESENT),
  // and must exclude CodeRabbit by PREFIX (case-insensitive), not exact-name equality — a
  // CodeRabbit status context that isn't byte-identical to the constant (`CodeRabbit: X`,
  // `CodeRabbit / review`) is still CodeRabbit. Prefix, not substring: it excludes every
  // CodeRabbit-named context while a legitimate CI job merely named e.g.
  // `coderabbit-integration-test` only ever fails CLOSED if it happens to get excluded too
  // (this guard existing to REFUSE more often on a false exclusion, never to pass on one).
  const hasRealPassingCheck = checks.some(
    (c) => c.bucket === "pass" && c.name.length > 0 && !lc(c.name).startsWith(lc(CODERABBIT_CONTEXT)),
  );
  if (!hasRealPassingCheck) {
    // The F19 vacuity case: every configured requiredChecks name can be satisfied entirely
    // by CodeRabbit-named checks (e.g. a misconfigured `requiredChecks: ["CodeRabbit"]`), or by
    // a check that merely exists without ever having passed — zero evidence any real CI ran.
    return { ok: false, reason: "checks_only_coderabbit" };
  }

  // Locked 18 / Critical 3 / Important 5: refuse a PR whose diff touches ship.config.json OR
  // any `.github/workflows/**` file — the story-lead has write access to the project repo,
  // and both control what the merge gate above actually checks (the config file directly; a
  // same-repo PR's OWN workflow definitions run from the PR branch, so `requiredChecks` names
  // are otherwise attacker-definable by adding a same-named, trivially-passing job).
  //
  // Critical 3: reads the files API (`gh api repos/<repo>/pulls/<pr>/files`), NOT
  // `gh pr diff --name-only` — three confirmed bypasses of the old `pr diff` approach:
  //   (a) a RENAME. `--name-only` shows only the rename's DESTINATION path (git collapses a
  //       delete+add into one entry at >=50% similarity, so a rename-with-modification counts
  //       too) — moving ship.config.json anywhere was invisible. The files API exposes both
  //       `.filename` (destination) and `.previous_filename` (source); both are scanned below.
  //   (b) case-sensitivity. The operator platform is darwin (case-insensitive filesystem):
  //       `.drawbar/Ship.Config.json` checks out over the same inode. Matched case-insensitively.
  //   (c) basename is the wrong key on its own. `resolveConfigPath` (ship-config.ts) honours
  //       `DRAWBAR_SHIP_CONFIG` for ANY basename — the caller-supplied `configPath` (the
  //       resolved effective config path) is matched too, additively, never in place of the
  //       hardcoded default.
  const filesRes = gh([
    "api",
    `repos/${repo}/pulls/${pr}/files`,
    "--paginate",
    "--jq",
    ".[] | .filename, (.previous_filename // empty)",
  ]);
  if (filesRes.code !== 0) {
    return { ok: false, reason: "diff_fetch_failed", detail: filesRes.stderr || undefined };
  }
  const touchedFiles = filesRes.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const configBasenames = new Set<string>([lc(SHIP_CONFIG_BASENAME)]);
  if (input.configPath) {
    configBasenames.add(lc(basename(input.configPath)));
  }
  if (touchedFiles.some((f) => configBasenames.has(lc(basename(f))))) {
    return { ok: false, reason: "config_diff_touches_ship_config" };
  }
  // Important C (fix pass 2): widened from `.github/workflows/**` to the whole `.github/`
  // prefix — see the `GITHUB_PREFIX` constant's comment for why `workflows/**` alone doesn't
  // close the class (a required workflow's composite action under `.github/actions/**` can be
  // rewritten while the workflow file, and the check's passing name, stay untouched).
  if (touchedFiles.some((f) => lc(f).startsWith(GITHUB_PREFIX))) {
    return { ok: false, reason: "config_diff_touches_dot_github" };
  }

  return { ok: true };
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Minor (fix pass 2): a malformed/unparseable `gh pr checks` response used to be swallowed
// into an empty array, indistinguishable from "genuinely zero checks reported" — the caller
// (mergeVerdict) now needs to tell those two apart to report `checks_parse_failed` rather than
// misdiagnosing it as `required_check_missing`.
function parseChecks(stdout: string): { ok: true; checks: { name: string; bucket: string }[] } | { ok: false } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false };
  }
  if (!Array.isArray(parsed)) return { ok: false };
  return {
    ok: true,
    checks: parsed
      .filter((c): c is Record<string, unknown> => typeof c === "object" && c !== null)
      .map((c) => ({
        name: typeof c.name === "string" ? c.name : "",
        bucket: typeof c.bucket === "string" ? c.bucket : "",
      })),
  };
}

// --- recordMergeSha ---------------------------------------------------------------------

// Critical A (fix pass 2): the git calls below used to run in the ambient CWD (no `cwd` on the
// injected runner's `Bun.spawnSync`, and §4 never derived or passed a project directory) —
// `git fetch`/`git merge-base` executed wherever the `Bash` tool inherited its cwd, which §4's
// own `CONFIG="${DRAWBAR_SHIP_CONFIG:-$PWD/.drawbar/ship.config.json}"` derivation implies is
// the env/knowledge repo, not `resolvedConfig.projectDir`. Ancestry then refused on EVERY
// story — a fresh checkout of the env/knowledge repo is never a checkout of the STORY repo —
// AFTER `gh pr merge` had already run (the irreversible step this whole function exists to
// verify). `dir` is the fix: every git call below is anchored at it via `-C`.
export type AncestorCheck = { status: "yes" } | { status: "no" } | { status: "error"; detail?: string };

export interface RecordMergeShaInput {
  repo: string;
  pr: string;
  baseBranch: string;
  // Critical A: the project checkout's absolute path (`resolvedConfig.projectDir`) — every
  // `git` call below runs `-C dir`, never the ambient CWD.
  dir: string;
  gh: Runner;
  git: Runner;
  // Locked 5: injected as its own seam, distinct from `git`, so a test can drive the
  // ancestry decision directly without a real `git merge-base` subprocess. Takes `dir` too
  // (Critical A), since the real implementation's own `git merge-base` call must be anchored
  // there the same way `fetch` is.
  isAncestor: (dir: string, sha: string, ref: string) => AncestorCheck;
}

export type RecordMergeShaReason =
  | "invalid_repo_shape"
  | "invalid_pr_shape"
  | "invalid_base_branch"
  // Critical A: `dir` failed the same absolute-path/no-`..`-segment shape check
  // `validateShipConfig` already applies to `projectDir`/`envDir` at T0.
  | "invalid_dir"
  | "fetch_failed"
  | "gh_view_failed"
  | "sha_shape_invalid"
  // Sub-fix (Critical A): `git merge-base --is-ancestor` uses exit 1 for "genuinely not an
  // ancestor" and any exit >1 for "could not evaluate at all" (e.g. one of the two shas/refs is
  // unknown to this checkout — exactly what "pointed at the wrong repo/checkout" looks like).
  // Collapsing >1 into `sha_not_ancestor` diagnosed a wrong-repo misconfiguration as an
  // ordinary, expected refusal instead of the distinct operational failure it actually is.
  | "ancestry_check_failed"
  | "sha_not_ancestor";

export type RecordMergeShaResult = { ok: true; mergeSha: string } | { ok: false; reason: RecordMergeShaReason; detail?: string };

// Locked 10: the full 40-char merge-commit oid — NOT the 7-40 char permissive shape
// run-state.ts's parser still accepts for reading legacy files (see that module's comment).
const FULL_MERGE_SHA_SHAPE = /^[0-9a-f]{40}$/;

// Captures `merge_sha` AFTER `gh pr merge` has already run. `git fetch origin <baseBranch>`
// always precedes the ancestor test — the squash-merged head sha is never an ancestor of the
// base, and the branch ref is deleted, so a stale local `baseBranch` would make
// `--is-ancestor` unreliable in exactly the direction that matters. Ancestry is asserted HERE
// (record time), not deferred to a later gate — a bad sha must fail at this step, not
// silently at the next story's blocker gate.
export function recordMergeSha(input: RecordMergeShaInput): RecordMergeShaResult {
  const { repo, pr, baseBranch, dir, gh, git, isAncestor } = input;

  if (!isValidRepo(repo)) return { ok: false, reason: "invalid_repo_shape", detail: repo };
  if (!isValidPr(pr)) return { ok: false, reason: "invalid_pr_shape", detail: pr };
  // Important 1: `baseBranch` becomes a positional argument to `git fetch` below — a
  // non-empty string alone is not enough (see ship-config.ts's `isValidRefName` for the two
  // concrete reproductions this closes: a forced refspec, and a `--` git option).
  if (!isNonEmptyTrimmed(baseBranch) || !isValidRefName(baseBranch)) {
    return { ok: false, reason: "invalid_base_branch", detail: baseBranch };
  }
  // Critical A: `dir` is a positional `-C` argument to every git call below — same shape
  // discipline `validateShipConfig` applies to `projectDir`/`envDir` (absolute, no `..`
  // segment), reused rather than reimplemented.
  if (typeof dir !== "string" || !isCleanAbsolutePath(dir)) {
    return { ok: false, reason: "invalid_dir", detail: String(dir) };
  }

  const fetchRes = git(["-C", dir, "fetch", "origin", "--", baseBranch]);
  if (fetchRes.code !== 0) {
    return { ok: false, reason: "fetch_failed", detail: fetchRes.stderr || undefined };
  }

  const viewRes = gh(["pr", "view", "-R", repo, pr, "--json", "mergeCommit", "--jq", ".mergeCommit.oid"]);
  if (viewRes.code !== 0) {
    return { ok: false, reason: "gh_view_failed", detail: viewRes.stderr || undefined };
  }
  const sha = viewRes.stdout.trim();
  if (!FULL_MERGE_SHA_SHAPE.test(sha)) {
    return { ok: false, reason: "sha_shape_invalid", detail: sha };
  }

  const ref = `origin/${baseBranch}`;
  const ancestorCheck = isAncestor(dir, sha, ref);
  if (ancestorCheck.status === "error") {
    return { ok: false, reason: "ancestry_check_failed", detail: ancestorCheck.detail };
  }
  if (ancestorCheck.status === "no") {
    return { ok: false, reason: "sha_not_ancestor", detail: sha };
  }

  return { ok: true, mergeSha: sha };
}

// --- CLI entry point --------------------------------------------------------------------
//
// `commands/drawbar-ship.md` §4 delegates the whole verdict here:
//   bun run .../merge-guard.ts verdict --repo <owner/repo> --pr <n> --story <id>
//     (reading `{"resolvedConfig":{...},"snapshot":[...]}` on stdin, same convention
//     `ship-config.ts validate` uses for its own Linear-facts JSON)
//   bun run .../merge-guard.ts record-merge-sha --repo <owner/repo> --pr <n> --base <branch>
//
// MUST-CHECK endpoint-injection-not-just-command-injection: `--repo`/`--pr` are validated at
// THIS boundary too (defence in depth on top of the pure functions' own checks above), and a
// shape failure here writes NOTHING to stdout — not even a JSON `ok:false` — so a caller that
// greps stdout for a verdict never sees one synthesized from an unvalidated argument.

export interface CliFlags {
  repo?: string;
  pr?: string;
  story?: string;
  base?: string;
  // Critical A: `record-merge-sha`'s project-checkout directory — see `RecordMergeShaInput.dir`.
  dir?: string;
}

export function parseCliFlags(args: string[]): CliFlags {
  const out: CliFlags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo") out.repo = args[++i];
    else if (args[i] === "--pr") out.pr = args[++i];
    else if (args[i] === "--story") out.story = args[++i];
    else if (args[i] === "--base") out.base = args[++i];
    else if (args[i] === "--dir") out.dir = args[++i];
  }
  return out;
}

function isVerdictStdin(v: unknown): v is { resolvedConfig: unknown; snapshot: unknown[]; configPath?: unknown } {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (!("resolvedConfig" in obj) || !Array.isArray(obj.snapshot) || !obj.snapshot.every((s) => typeof s === "string")) {
    return false;
  }
  // Critical 3(c): `configPath` is OPTIONAL — a caller that never plumbs it (yet) must not be
  // refused for its absence — but if present, it must be a string.
  return !("configPath" in obj) || typeof obj.configPath === "string";
}

function makeRealRunner(bin: string): Runner {
  return (argv: string[]) => {
    try {
      const proc = Bun.spawnSync([bin, ...argv], { stdout: "pipe", stderr: "pipe" });
      return { code: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
    } catch (err) {
      // MUST-CHECK wrap-injected-runner-spawn-in-try-catch: a missing binary on PATH must
      // fail closed as a normal refusal, never an uncaught throw.
      return { code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
    }
  };
}

// Sub-fix (Critical A): `git merge-base --is-ancestor` exits 0 for "is an ancestor", 1 for
// "genuinely not an ancestor", and >1 for a real evaluation failure (e.g. an unknown
// sha/ref in this checkout — exactly what "wrong repo/checkout" looks like). Mapped to the
// three-state `AncestorCheck` rather than collapsing >1 into "not an ancestor".
//
// Do NOT add `--` before the `sha`/`ref` positional arguments here — unlike most git
// subcommands, `git merge-base` treats a bare `--` as the REV/PATHSPEC separator, so adding
// one changes what this command evaluates rather than merely guarding against option-like
// values. The `isValidRefName`/`FULL_MERGE_SHA_SHAPE` shape checks upstream of every call site
// are the actual control here; a future reviewer should not "fix" this by adding one back.
function makeRealIsAncestor(git: Runner): (dir: string, sha: string, ref: string) => AncestorCheck {
  return (dir, sha, ref) => {
    const res = git(["-C", dir, "merge-base", "--is-ancestor", sha, ref]);
    if (res.code === 0) return { status: "yes" };
    if (res.code === 1) return { status: "no" };
    return { status: "error", detail: res.stderr || `git merge-base --is-ancestor exited ${res.code}` };
  };
}

export interface MainDeps {
  argv?: string[];
  readStdin?: () => Promise<string>;
  gh?: Runner;
  git?: Runner;
  isAncestor?: (dir: string, sha: string, ref: string) => AncestorCheck;
  writeStdout?: (s: string) => void;
  writeStderr?: (s: string) => void;
}

export async function main(deps: MainDeps = {}): Promise<number> {
  const argv = deps.argv ?? process.argv.slice(2);
  const readStdin = deps.readStdin ?? (() => new Response(Bun.stdin.stream()).text());
  const gh = deps.gh ?? makeRealRunner("gh");
  const git = deps.git ?? makeRealRunner("git");
  const isAncestor = deps.isAncestor ?? makeRealIsAncestor(git);
  const writeStdout = deps.writeStdout ?? ((s: string) => { process.stdout.write(s); });
  const writeStderr = deps.writeStderr ?? ((s: string) => { process.stderr.write(s); });

  const [cmd, ...rest] = argv;
  const flags = parseCliFlags(rest);

  if (cmd === "verdict") {
    if (!flags.repo || !isValidRepo(flags.repo) || !flags.pr || !isValidPr(flags.pr)) {
      // I5-style: refuse before touching stdin/gh at all, and with NO stdout output.
      writeStderr(`refused: --repo/--pr failed shape validation (repo=${JSON.stringify(flags.repo)}, pr=${JSON.stringify(flags.pr)})\n`);
      return 1;
    }
    if (!isNonEmptyTrimmed(flags.story)) {
      writeStderr("refused: --story is required and must be a non-empty string\n");
      return 1;
    }
    let stdinText: string;
    try {
      stdinText = await readStdin();
    } catch {
      writeStderr("refused: could not read verdict input from stdin\n");
      return 1;
    }
    let parsedStdin: unknown;
    try {
      parsedStdin = JSON.parse(stdinText);
    } catch {
      writeStderr("refused: stdin is not valid JSON\n");
      return 1;
    }
    if (!isVerdictStdin(parsedStdin)) {
      writeStderr('refused: stdin must be {"resolvedConfig":{...},"snapshot":["<id>",...]}\n');
      return 1;
    }
    const verdict = mergeVerdict({
      story: flags.story,
      pr: flags.pr,
      repo: flags.repo,
      resolvedConfig: parsedStdin.resolvedConfig as ResolvedConfig,
      snapshot: parsedStdin.snapshot as string[],
      configPath: typeof parsedStdin.configPath === "string" ? parsedStdin.configPath : undefined,
      gh,
    });
    // Important 3/4: the reason must be operator-visible on stderr (the fence's own guard
    // fires on the module's non-zero exit before the stdout JSON verdict is ever inspected —
    // see commands/drawbar-ship.md §4 — so `reason` alone reaching stderr, undecorated, was
    // effectively unreachable). `JSON.stringify(detail)` closes the control-char leak: `detail`
    // can carry PR-author-controlled text (a branch name, a check name) straight into
    // agent-facing prose — this is the SAME treatment the CLI already gave `--repo`/`--pr`
    // above; the inconsistency (raw string here) was the bug.
    if (!verdict.ok) {
      writeStderr(`refused: ${verdict.reason}${verdict.detail !== undefined ? `: ${JSON.stringify(sanitizeForOutput(verdict.detail))}` : ""}\n`);
    }
    writeStdout(JSON.stringify(verdict) + "\n");
    return verdict.ok ? 0 : 1;
  }

  if (cmd === "record-merge-sha") {
    if (!flags.repo || !isValidRepo(flags.repo) || !flags.pr || !isValidPr(flags.pr)) {
      writeStderr(`refused: --repo/--pr failed shape validation (repo=${JSON.stringify(flags.repo)}, pr=${JSON.stringify(flags.pr)})\n`);
      return 1;
    }
    if (!isNonEmptyTrimmed(flags.base)) {
      writeStderr("refused: --base is required and must be a non-empty string\n");
      return 1;
    }
    // Critical A: `--dir` is required — no fallback to the ambient CWD (that's the exact
    // fail-open this fix pass closes; see the module comment above `AncestorCheck`).
    // Round-3 security review, Important 1: `--dir` reaches `git -C <dir>` — the most dangerous
    // sink this CLI has — so it gets the same both-boundaries treatment `--repo`/`--pr` get, and
    // a shape failure writes NOTHING to stdout (not even an `ok:false` verdict), so a caller
    // grepping stdout can never read a verdict synthesized from an unvalidated argument.
    if (!isNonEmptyTrimmed(flags.dir)) {
      writeStderr("refused: --dir is required and must be a non-empty string\n");
      return 1;
    }
    if (!isCleanAbsolutePath(flags.dir)) {
      writeStderr(`refused: --dir must be a clean absolute path (got ${JSON.stringify(sanitizeForOutput(flags.dir))})\n`);
      return 1;
    }
    const result = recordMergeSha({ repo: flags.repo, pr: flags.pr, baseBranch: flags.base, dir: flags.dir, gh, git, isAncestor });
    if (!result.ok) {
      writeStderr(`refused: ${result.reason}${result.detail !== undefined ? `: ${JSON.stringify(sanitizeForOutput(result.detail))}` : ""}\n`);
    }
    writeStdout(JSON.stringify(result) + "\n");
    return result.ok ? 0 : 1;
  }

  writeStderr(
    "usage: merge-guard.ts verdict --repo <owner/repo> --pr <n> --story <id>\n" +
      "       merge-guard.ts record-merge-sha --repo <owner/repo> --pr <n> --base <branch> --dir <absolute-project-path>\n",
  );
  return 1;
}

if (import.meta.main) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      // Minor (fix pass 2): every other stderr write in this module JSON.stringify-wraps any
      // text that could carry attacker/environment-controlled content before it reaches an
      // agent-facing transcript — this was the one site still writing `err.message` raw.
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`refused: unexpected error: ${JSON.stringify(message)}\n`);
      process.exit(1);
    });
}
