// The state model for the stacked-PR redesign (PCO-363), landed before anything writes it
// (PCO-365, R2). A run that resolves the wrong base produces a PR whose diff silently
// contains another story's work — plausible-looking, green, and hard to catch. This module
// exists to make that failure mode a named refusal instead.
//
// Two distinct pure verdict functions, same house style as scripts/lib/ship-config.ts and
// scripts/lib/run-state.ts (named `reason` + human `detail` on every refusal, injected
// `Runner`s so `git` is never called from ambient state, Locked 5's "tests pass with `git`
// absent from PATH" holds because every git call is injected):
//
//   - `resolveBase` — the branch a NEW story should be based on: the run's configured
//     `baseBranch` if `state.stack` is empty (this is the first story), otherwise the
//     LAST-appended stack entry's `branch` (Locked A — never the configured base, for any
//     story after the first). Pure; touches no git at all.
//   - `assertChainIntact` — re-verifies a resumed run's recorded stack against the actual
//     repository: each entry's `base` must still match Locked A's own rule (pure, no git),
//     and each entry's `branch`/`base` must still exist and the chain must still hold
//     (`base` still an ancestor of `branch`) — a rebase of a predecessor between runs is
//     exactly the crash-resume failure mode this exists to catch.
//
//     Scope (IMPORTANT 4): every git-backed check above reads LOCAL refs
//     (`refs/heads/<name>`) in the clone at `projectDir` — this module never fetches. The
//     design is about pushed branches with GitHub PRs stacked on them; a remote force-push of
//     a predecessor BETWEEN runs, with no corresponding local fetch, leaves the local ref
//     stale, so `merge-base` passes against stale history and the chain reports intact while
//     the PR on GitHub already shows a different diff. Detecting that is explicitly OUT OF
//     SCOPE for R2. Fail-closed corollary: a `--single-branch` clone taken on a branch OTHER
//     than `baseBranch` has no local `refs/heads/<baseBranch>` ref at all and would refuse
//     `base_missing` even in an otherwise healthy repository — that is the safe direction for
//     this gap to fail in. (A `--single-branch` clone taken ON `baseBranch` is unaffected:
//     verified on real git that `refs/heads/<baseBranch>` is present and `rev-parse` exits 0.)
//
// `scripts/lib/run-state.ts`'s `StackEntry` carries no `sha` — chain integrity is re-derived
// live from `git` rather than pinned to a recorded commit, so a legitimate rebase of a
// predecessor does not require a state-file rewrite.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isNonEmptyTrimmed, isValidRefName, isCleanAbsolutePath, sanitizeForOutput, type Runner, type ShipConfig } from "./ship-config";
import { parseRunState, type RunState } from "./run-state";

export type ResolveBaseReason =
  | "invalid_story_id"
  | "story_not_in_snapshot"
  | "story_already_stacked"
  | "base_branch_config_drift"
  | "invalid_base_branch_shape"
  | "invalid_predecessor_branch_shape";

export type ResolveBaseRule = "config_base" | "previous_story_branch";

export type ResolveBaseResult =
  | { ok: true; base: string; rule: ResolveBaseRule }
  | { ok: false; reason: ResolveBaseReason; detail: string };

// Locked A: story N's base is story N-1's recorded branch, NEVER the configured base branch,
// for any story after the first. `rule` on a success lets a caller (or a test) tell the two
// apart directly, rather than string-matching `base` against `config.baseBranch` — which can
// coincide by accident and would silently hide a Locked A regression.
export function resolveBase(
  runState: Pick<RunState, "snapshot" | "stack" | "resolved_config">,
  storyId: string,
  config: Pick<ShipConfig, "baseBranch">,
): ResolveBaseResult {
  if (!isNonEmptyTrimmed(storyId)) {
    return { ok: false, reason: "invalid_story_id", detail: "storyId must be a non-empty trimmed string" };
  }
  if (!runState.snapshot.includes(storyId)) {
    return { ok: false, reason: "story_not_in_snapshot", detail: `${storyId} is not a member of this run's snapshot` };
  }
  if (runState.stack.some((entry) => entry.story === storyId)) {
    return {
      ok: false,
      reason: "story_already_stacked",
      detail: `${storyId} already has a stack entry — resolving a base for it again is inconsistent state`,
    };
  }
  // A divergence between the caller's config and the run's persisted T0 config
  // (resolved_config) IS "the state is inconsistent" — picking either side silently is
  // exactly the failure mode this module exists to prevent, so both are refused rather than
  // one being trusted over the other.
  if (config.baseBranch !== runState.resolved_config.baseBranch) {
    return {
      ok: false,
      reason: "base_branch_config_drift",
      detail: `config.baseBranch (${config.baseBranch}) does not match the run's persisted resolved_config.baseBranch (${runState.resolved_config.baseBranch})`,
    };
  }
  if (!isValidRefName(config.baseBranch)) {
    return { ok: false, reason: "invalid_base_branch_shape", detail: config.baseBranch };
  }
  if (runState.stack.length === 0) {
    return { ok: true, base: config.baseBranch, rule: "config_base" };
  }
  const predecessor = runState.stack[runState.stack.length - 1]!;
  if (!isValidRefName(predecessor.branch)) {
    return { ok: false, reason: "invalid_predecessor_branch_shape", detail: predecessor.branch };
  }
  return { ok: true, base: predecessor.branch, rule: "previous_story_branch" };
}

// --- assertChainIntact --------------------------------------------------------------------

export type ChainReason =
  | "invalid_project_dir"
  | "project_dir_untrusted"
  | "chain_link_mismatch"
  | "invalid_ref_shape"
  | "branch_missing"
  | "base_missing"
  | "branch_moved"
  | "git_failed";

export type ChainResult = { ok: true } | { ok: false; reason: ChainReason; detail: string };

// Re-verifies a resumed run's recorded stack against the actual repository. Per entry, in
// order (the ref-shape gate first, pure and free — no value taken from a stack ENTRY is
// echoed into a refusal `detail`, let alone a git argv, before it is known to be shaped like
// a ref).
//
// One documented asymmetry, so this comment does not overstate its own guarantee: at `i === 0`
// the `expectedBase` compared (and echoed) below is `resolved_config.baseBranch`, which this
// function does NOT shape-check — unlike `resolveBase`, which gates it with `isValidRefName`
// before use. A malformed `baseBranch` on a hand-built state therefore reaches the
// `chain_link_mismatch` detail. It never reaches a git argv (the mismatch refuses first) and
// the CLI sanitizes every detail on the way out, so this is a comment-accuracy note rather
// than an exposure — but do not read the paragraph above as covering it.
//
//   1. (pure)  entry.branch/entry.base pass isValidRefName (MUST-CHECK
//              endpoint-injection-not-just-command-injection), independent of whether the
//              caller already validated via `parseRunState`.
//   2. (pure)  entry.base === (i===0 ? resolved_config.baseBranch : stack[i-1].branch) —
//              Locked A's own rule, free (no git call needed to answer a question the state
//              already answers).
//   3. (git)   `rev-parse --verify --quiet refs/heads/<branch>` — exit 1 means genuinely
//              missing; any OTHER non-zero exit (128 observed for a missing/corrupt repo) is
//              a git ERROR and routes to `git_failed`, never misread as "missing" (IMPORTANT 1
//              — a deleted/moved `projectDir` must not present as an ordinary absent branch).
//   4. (git)   `rev-parse --verify --quiet refs/heads/<base>` — same distinction as (3).
//   5. (git)   `merge-base --is-ancestor refs/heads/<base> refs/heads/<branch>` — both
//              arguments fully qualified (CRITICAL 2): git's ref disambiguation order puts
//              `refs/tags/<x>` ahead of `refs/heads/<x>`, so a bare name here would let a tag
//              of the SAME name silently answer the ancestry question about a different
//              object than the one just verified to exist in steps 3/4 — reproduced against
//              real git 2.50.1 (`git tag <branch-name> <other-commit>` flips a correct
//              `branch_moved` refusal to `{"ok":true}`). Verified separately: exit 0 means
//              `base` IS an ancestor of `branch`; exit 1 means it genuinely is NOT (including
//              two unrelated histories) — that is "moved," not a git error; any OTHER
//              non-zero exit (128 observed for a bogus/missing ref) is a git ERROR and must
//              route to `git_failed`, never be misread as "moved" (a broken repository must
//              not silently present as an ordinary rebase).
//
// `projectDir` is validated with `isCleanAbsolutePath` before any git call at all. The CLI
// entry point below requires it as an operator-supplied `--project-dir` flag and refuses
// outright if it disagrees with the state file's own `resolved_config.projectDir` copy
// (CRITICAL 3) — this function itself just takes it as an explicit parameter and
// re-validates independently, the same discipline `resolveBase` applies to a hand-constructed
// `RunState` bypassing `parseRunState`.
export function assertChainIntact(
  state: Pick<RunState, "stack" | "resolved_config">,
  projectDir: string,
  git: Runner,
): ChainResult {
  if (!isCleanAbsolutePath(projectDir)) {
    return { ok: false, reason: "invalid_project_dir", detail: projectDir };
  }
  for (let i = 0; i < state.stack.length; i++) {
    const entry = state.stack[i]!;
    if (!isValidRefName(entry.branch) || !isValidRefName(entry.base)) {
      return {
        ok: false,
        reason: "invalid_ref_shape",
        detail: `stack[${i}] (${entry.story}) branch/base must be a valid git ref name`,
      };
    }
    const expectedBase = i === 0 ? state.resolved_config.baseBranch : state.stack[i - 1]!.branch;
    if (entry.base !== expectedBase) {
      return {
        ok: false,
        reason: "chain_link_mismatch",
        detail: `stack[${i}] (${entry.story}).base is "${entry.base}", expected "${expectedBase}"`,
      };
    }

    const branchRes = git(["-C", projectDir, "rev-parse", "--verify", "--quiet", `refs/heads/${entry.branch}`]);
    if (branchRes.code === 1) {
      return {
        ok: false,
        reason: "branch_missing",
        detail: `stack[${i}] (${entry.story}) branch "${entry.branch}" does not exist at ${projectDir}`,
      };
    }
    if (branchRes.code !== 0) {
      return {
        ok: false,
        reason: "git_failed",
        detail: branchRes.stderr || `git rev-parse failed for refs/heads/${entry.branch} with exit code ${branchRes.code}`,
      };
    }
    const baseRes = git(["-C", projectDir, "rev-parse", "--verify", "--quiet", `refs/heads/${entry.base}`]);
    if (baseRes.code === 1) {
      return {
        ok: false,
        reason: "base_missing",
        detail: `stack[${i}] (${entry.story}) base "${entry.base}" does not exist at ${projectDir}`,
      };
    }
    if (baseRes.code !== 0) {
      return {
        ok: false,
        reason: "git_failed",
        detail: baseRes.stderr || `git rev-parse failed for refs/heads/${entry.base} with exit code ${baseRes.code}`,
      };
    }

    const ancestorRes = git([
      "-C",
      projectDir,
      "merge-base",
      "--is-ancestor",
      `refs/heads/${entry.base}`,
      `refs/heads/${entry.branch}`,
    ]);
    if (ancestorRes.code === 1) {
      return {
        ok: false,
        reason: "branch_moved",
        detail: `stack[${i}] (${entry.story}) base "${entry.base}" is no longer an ancestor of "${entry.branch}"`,
      };
    }
    if (ancestorRes.code !== 0) {
      return {
        ok: false,
        reason: "git_failed",
        detail: ancestorRes.stderr || `git merge-base --is-ancestor failed with exit code ${ancestorRes.code}`,
      };
    }
  }
  return { ok: true };
}

// Sanitizes only a refusal's `detail` before it is ever stringified for stdout (IMPORTANT 3),
// mirroring `kb-sync.ts`'s `sanitizeForOutput` boundary discipline. `parseRunState`'s
// `CONTROL_CHAR_SHAPE` deliberately admits invisible/bidi Unicode (e.g. in `stack[i].story`,
// which is never itself ref-shape-checked) that must not reach an agent-read verdict intact.
function sanitizeChainOrBaseDetail<R extends { ok: true } | { ok: false; reason: string; detail: string }>(
  result: R,
): R {
  if (result.ok) return result;
  return { ...result, detail: sanitizeForOutput(result.detail) };
}

// --- CLI entry point --------------------------------------------------------------------
//
// `bun run stack.ts resolve-base --state <path> --story <id>`
// `bun run stack.ts assert-chain --state <path> --project-dir <dir>`
//
// Both read the run-state file at `--state` and take `config` from the state's OWN
// `resolved_config` — that is what a resumed run has (R3's bash runbook re-invokes this per
// story, never carrying a separately-sourced config of its own). Both write a JSON verdict to
// stdout for `jq` to read — including a `{ok: false, reason, detail}` business refusal, which
// is a different failure class from a CLI-usage error (bad flags, unreadable/malformed state
// file): the latter write to stderr with EMPTY stdout, mirroring ship-config.ts's CLI
// end-to-end convention, so a caller piping stdout into `jq` never sees a partial object for a
// usage error, but DOES see a structured verdict for a business refusal.
//
// `assert-chain` additionally REQUIRES `--project-dir <dir>` (CRITICAL 3): `resolved_config`
// lives in the agent-writable run-state file, so handing its `projectDir` copy straight to
// `git -C` would let that file alone repoint every ancestry check at an attacker-controlled
// repository — an absolute-path-and-no-`..` shape check does not help, since it constrains
// the shape of the path, never whose repository it names. `--project-dir` is the
// operator-authored trust root instead (R3's runbook sources it from
// `ship-config.ts validate`'s own resolved output, never from the state file); the flag value
// and the state's copy must AGREE (compared via `resolve()`) before any git call, or the run
// refuses `project_dir_untrusted` with the git runner never invoked. `resolve-base` makes no
// git call at all, so `--project-dir` is forbidden there — accepting-but-ignoring it would
// invite a caller to believe it does something.

export type CliParse =
  | { ok: true; state: string; story?: string; projectDir?: string }
  | { ok: false; error: string };

// Flag type enforcement in BOTH directions (same discipline as ship-config.ts's
// `parseCliArgs`): a flag with no consumable value binds boolean `true`, refused rather than
// silently treated as absent; an empty-string value is refused; a repeated or unknown flag
// refuses outright. `--story` is required for `resolve-base` and forbidden for `assert-chain`;
// `--project-dir` is required for `assert-chain` and forbidden for `resolve-base` — the two
// subcommands' contracts differ, so this is checked per-`cmd`, not generically.
export function parseCliArgs(cmd: "resolve-base" | "assert-chain", args: string[]): CliParse {
  let seenState = false;
  let seenStory = false;
  let seenProjectDir = false;
  let state: string | true | undefined;
  let story: string | true | undefined;
  let projectDir: string | true | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--state") {
      if (seenState) return { ok: false, error: "--state specified more than once" };
      seenState = true;
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        state = next;
        i++;
      } else {
        state = true;
      }
    } else if (a === "--story") {
      if (seenStory) return { ok: false, error: "--story specified more than once" };
      seenStory = true;
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        story = next;
        i++;
      } else {
        story = true;
      }
    } else if (a === "--project-dir") {
      if (seenProjectDir) return { ok: false, error: "--project-dir specified more than once" };
      seenProjectDir = true;
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        projectDir = next;
        i++;
      } else {
        projectDir = true;
      }
    } else {
      return { ok: false, error: `unknown flag: ${a}` };
    }
  }
  if (state === true) return { ok: false, error: "--state requires a value" };
  if (state === "") return { ok: false, error: "--state value must not be empty" };
  if (state === undefined) return { ok: false, error: "--state is required" };

  if (cmd === "assert-chain") {
    if (story !== undefined) return { ok: false, error: "--story is not valid for assert-chain" };
    if (projectDir === true) return { ok: false, error: "--project-dir requires a value" };
    if (projectDir === "") return { ok: false, error: "--project-dir value must not be empty" };
    if (projectDir === undefined) return { ok: false, error: "--project-dir is required" };
    return { ok: true, state, projectDir };
  }
  // cmd === "resolve-base"
  if (projectDir !== undefined) return { ok: false, error: "--project-dir is not valid for resolve-base" };
  if (story === true) return { ok: false, error: "--story requires a value" };
  if (story === "") return { ok: false, error: "--story value must not be empty" };
  if (story === undefined) return { ok: false, error: "--story is required" };
  return { ok: true, state, story };
}

function makeRealRunner(bin: string): Runner {
  return (argv: string[]) => {
    try {
      const proc = Bun.spawnSync([bin, ...argv], { stdout: "pipe", stderr: "pipe" });
      return { code: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
    } catch (err) {
      // MUST-CHECK wrap-injected-runner-spawn-in-try-catch: a missing binary on PATH must
      // fail closed as a normal refusal, never an uncaught throw that crashes before the CLI
      // writes anything at all.
      return { code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
    }
  };
}

// Every real I/O boundary is injectable, defaulting to the real implementation — same shape
// as ship-config.ts's `MainDeps`. No `env`/`cwd`/`readConfig` seam: unlike ship-config.ts,
// `--state` is always REQUIRED (never derived from an env-var default), and there is no
// separate config file to read — `config` comes from within the state file itself. Adding
// those seams here would be unused-but-kept plumbing (Locked E, PCO-363), so they are absent
// rather than dormant.
export interface MainDeps {
  argv?: string[];
  readState?: (path: string) => string;
  git?: Runner;
  writeStdout?: (s: string) => void;
  writeStderr?: (s: string) => void;
}

export async function main(deps: MainDeps = {}): Promise<number> {
  const argv = deps.argv ?? process.argv.slice(2);
  const readState = deps.readState ?? ((p: string) => readFileSync(p, "utf8"));
  const git = deps.git ?? makeRealRunner("git");
  const writeStdout = deps.writeStdout ?? ((s: string) => { process.stdout.write(s); });
  const writeStderr = deps.writeStderr ?? ((s: string) => { process.stderr.write(s); });

  const [cmd, ...rest] = argv;
  if (cmd !== "resolve-base" && cmd !== "assert-chain") {
    writeStderr(
      "usage: stack.ts resolve-base --state <path> --story <id> | assert-chain --state <path> --project-dir <dir>\n",
    );
    return 1;
  }

  const parsedArgs = parseCliArgs(cmd, rest);
  if (!parsedArgs.ok) {
    writeStderr(`refused: ${sanitizeForOutput(parsedArgs.error)}\n`);
    return 1;
  }

  let stateText: string;
  try {
    stateText = readState(parsedArgs.state);
  } catch {
    writeStderr(`refused: state file not found or unreadable: ${sanitizeForOutput(parsedArgs.state)}\n`);
    return 1;
  }

  const parsedState = parseRunState(stateText);
  if (!parsedState.ok) {
    writeStderr(`refused: run-state ${parsedState.reason} (${sanitizeForOutput(parsedState.detail)})\n`);
    return 1;
  }

  if (cmd === "resolve-base") {
    const result = resolveBase(parsedState.state, parsedArgs.story!, { baseBranch: parsedState.state.resolved_config.baseBranch });
    writeStdout(JSON.stringify(sanitizeChainOrBaseDetail(result)) + "\n");
    return result.ok ? 0 : 1;
  }

  // cmd === "assert-chain": CRITICAL 3 — `--project-dir` (operator-supplied, required) is the
  // trust root; the state file's own `resolved_config.projectDir` copy is agent-writable and
  // is never itself passed to a git call, only compared against the flag. Both must already
  // be clean absolute paths and must resolve to the SAME path, checked before any git call.
  const projectDirFlag = parsedArgs.projectDir!;
  const projectDirFromState = parsedState.state.resolved_config.projectDir;
  if (
    !isCleanAbsolutePath(projectDirFlag) ||
    !isCleanAbsolutePath(projectDirFromState) ||
    resolve(projectDirFlag) !== resolve(projectDirFromState)
  ) {
    const result: ChainResult = {
      ok: false,
      reason: "project_dir_untrusted",
      detail: `--project-dir (${projectDirFlag}) does not match the run-state's resolved_config.projectDir (${projectDirFromState})`,
    };
    writeStdout(JSON.stringify(sanitizeChainOrBaseDetail(result)) + "\n");
    return 1;
  }

  const result = assertChainIntact(parsedState.state, projectDirFlag, git);
  writeStdout(JSON.stringify(sanitizeChainOrBaseDetail(result)) + "\n");
  return result.ok ? 0 : 1;
}

if (import.meta.main) {
  // MUST-CHECK (mirrors ship-config.ts): without `.catch`, an unexpected throw anywhere in
  // main() not already caught internally becomes an UNHANDLED PROMISE REJECTION instead of a
  // named refusal.
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`refused: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
