// F8/S8 (PCO-353): the step 6 ("## 6. Capture and sync knowledge") sync loop, extracted whole
// out of `commands/drawbar-ship.md`'s bash fence and put behind tests, same house style as
// `scripts/lib/ship-config.ts`:
//
//   - `syncKnowledge` — the tolerant retry loop: stage, commit-if-staged, assert a clean
//     precondition, rebase, push, and (only on a genuine push REJECTION) retry. Halts
//     non-zero, with a distinct reason, on everything else — including exhaustion, which is
//     the exact F8 regression this module exists to close (the old bash's `break` fired only
//     on success, so total failure was silently indistinguishable from a clean sync).
//   - `knowledgePreflight` — Locked 16's three assertions on the KNOWLEDGE repo (not the
//     project repo Preflight already checked): dirty-tree, `merge=union` on both KB files,
//     and an assert-or-create of `.drawbar/runs/.gitignore`.
//
// `commands/drawbar-ship.md` §6 (and its Preflight section) delegate WHOLE to this module's
// CLI — there is no second, hand-copied bash implementation of any of the checks below
// (single-implementation-site regression discipline; see scripts/plugin.test.ts).
//
// --- why inline KB writes stay, and the sync becomes tolerant instead (Locked 15) ---------
//
// The story-lead and implementer write KB entries INLINE, mid-run, via `drawbar-kb add`. That
// means the knowledge repo's working tree is dirty at unpredictable times — not a bug, the
// whole point of writing lessons down as you hit them rather than batching them for later.
// The old bash treated ANY dirtiness as fatal to the rebase and never re-staged inside its
// retry loop, so a mid-run inline write landed AFTER the one `git add` at the top was
// invisible to every retry. This module re-stages on EVERY attempt (see `syncKnowledge`'s
// per-attempt order) specifically so a mid-run write is picked up by a later attempt, and
// treats the untracked-file case as never-dirty (`--untracked-files=no`) so a lesson written
// to disk but not yet staged by drawbar-kb doesn't itself trip the precondition.
//
// --- `merge=union`, a concurrent supersede, and why the sync does NOT halt on it -----------
//
// `.gitattributes` sets `merge=union` on both `knowledge.jsonl` and `knowledge.archive.jsonl`
// — a rebase/merge on either file CONCATENATES both sides rather than raising a textual
// conflict, which is what lets this loop resolve a routine two-sided APPEND (the overwhelmingly
// common case: two different agents each append a new line) with no human in the loop.
//
// `store.ts`'s `appendEntry`, though, does NOT always append — a correction to an existing
// key's knowledge (any field but `ts` differing) SUPERSEDES: it rewrites `knowledge.jsonl` IN
// FULL (`writeActiveAtomic`) and appends the prior copy to `knowledge.archive.jsonl`. A full
// rewrite is not an append, and `merge=union` has no concept of "this same line changed on both
// sides" — it just keeps BOTH versions, active and superseded, rather than erroring. So a
// supersede that races a concurrent supersede of the SAME key on the other side of a pull
// produces a knowledge.jsonl carrying the key twICE (both versions, not a conflict) rather than
// a rebase failure.
//
// DECIDED: detect this and REPORT it, never halt on it. Turning a benign, self-inflicted union
// artifact into a night-ending halt is precisely the failure mode Locked 16's `check-attr`
// assertion (asserting union is actually configured, so a concurrent append genuinely does
// self-resolve rather than raising a real conflict this loop has no strategy for) exists to
// prevent. `syncKnowledge` counts duplicate keys in the ACTIVE store after a successful push
// and reports the count on stdout (`duplicateKeys`) plus a loud stderr warning naming an
// ATTENDED `drawbar-kb compact` run as the remedy — union is still the right choice for the
// append-dominated normal case; compact is what an operator runs by hand, occasionally, to
// clean up the rare collided-supersede case.
//
// --- never `archive`/`compact` in the loop --------------------------------------------------
//
// `drawbar-kb recall` searches ACTIVE entries only, so anything moved to the archive vanishes
// from every future recall silently — no error, no warning, just knowledge that stops existing
// as far as the tool is concerned. A stray `archive` once moved over a thousand entries out of
// reach in a single unattended command. This module calls `add` (via `store.ts`'s
// `appendEntry`, for the report's `lessons[]`), `recall`'s own machinery indirectly through
// `readEntries` (for the duplicate-key count), and `reindex` (via `fts.ts`'s `buildIndex`,
// LAST, only after a successful push — `index.db` is gitignored and derived, and a pull can
// bring in entries the local index has never seen). Nothing in this file calls
// `archiveOlderThan` or `compactActive`, and nothing ever should — a test asserts their names
// never appear in any git call-log entry either.
//
// --- lessons[] reconcile — the documented winner (Locked 15) -------------------------------
//
// `syncKnowledge` accepts the report's `lessons[]` (KB entry objects) and applies each one via
// `store.ts`'s `appendEntry`, keyed by `key` — exactly the same upsert semantics every other
// `drawbar-kb add` call gets, never re-derived or fought here. Per `store.ts:45-95`
// (`sameKnowledge`/`appendEntry`, already verified by the lead): a re-add of IDENTICAL
// knowledge (every field but `ts` matching an existing entry with the same key) is a silent
// no-op (`{written:false, superseded:false}`); a re-add that changes any other field SUPERSEDES
// the prior copy in place, archiving the old one. DOCUMENTED WINNER: the report's lesson is
// applied AFTER whatever inline entries already landed during the run, so when the two
// disagree, the REPORT's version supersedes the inline one — last write wins BY CONTENT, not by
// which was written to disk first. This module does not compare, dedupe, or pre-filter
// `lessons[]` against what is already on disk; it delegates the whole decision to
// `appendEntry`.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { appendEntry, readEntries, storePaths } from "./store";
import { buildIndex } from "./fts";
import type { Entry } from "./schema";
import { isCleanAbsolutePath, isNonEmptyTrimmed, sanitizeForOutput } from "./ship-config";
import type { Runner } from "./ship-config";

// --- push-rejection classification (Locked 15) ----------------------------------------------
//
// Only a genuine push REJECTION may retry — anything else (auth failure, network down
// mid-push, a repo that no longer exists) halts immediately, distinct reason, not retried.
// Matched case-insensitively against the real `git push` failure's stderr. One named export so
// a test can assert on it directly, and each pattern is commented with why it's here:
export const PUSH_REJECTION_PATTERNS: RegExp[] = [
  // The literal marker git prints ahead of the per-ref update line on an ordinary rejection
  // (`! [rejected]        main -> main (fetch first)`).
  /\[rejected\]/i,
  // The reason git gives inline on that same per-ref line for a non-fast-forward push.
  /non-fast-forward/i,
  // The hint git appends to its rejection ("... Updates were rejected because the remote
  // contains work that you do not have locally. ... (e.g., 'git pull ...') before pushing
  // again. ... hint: ... 'git pull') — "fetch first" is the shorter, stable substring of that
  // hint across git versions.
  /fetch first/i,
  // The one-line summary git prints once, above the per-ref detail, on the same class of
  // rejection.
  /updates were rejected/i,
];

export function isPushRejection(stderr: string): boolean {
  return PUSH_REJECTION_PATTERNS.some((re) => re.test(stderr));
}

// --- syncKnowledge ---------------------------------------------------------------------------

export interface SyncKnowledgeInput {
  envDir: string;
  kbDir: string;
  message: string;
  // The report's lessons[], applied via appendEntry — see the module-top comment block for the
  // documented winner. Never compared/deduped/pre-filtered here.
  lessons: Entry[];
  git: Runner;
  // Locked 5: injectable so tests never actually wait out a real backoff.
  sleep: (ms: number) => Promise<void>;
  // Discretion: 3 attempts is plenty for a rebase racing another agent's ordinary append.
  maxAttempts?: number;
}

export type SyncReason =
  | "invalid_env_dir"
  | "invalid_kb_dir"
  | "invalid_message"
  | "add_failed"
  | "diff_failed"
  | "commit_failed"
  | "status_failed"
  // Precondition failure (step 3) — NOT retried. Runs AFTER stage+commit precisely so the KB
  // files this attempt just wrote are never self-reported as dirty.
  | "dirty_precondition"
  // Step 4 — NOT retried.
  | "pull_failed"
  // Step 5, a push failure that is not a rejection shape — NOT retried.
  | "push_failed"
  // The F8 regression: attempts exhausted with every push failure classified as a rejection.
  | "attempts_exhausted";

export type SyncResult =
  | { ok: true; attempts: number; staged: string[]; duplicateKeys: number }
  | { ok: false; reason: SyncReason; detail?: string; attempts: number };

const RETRY_SLEEP_MS = 1000;
const DEFAULT_MAX_ATTEMPTS = 3;

// Number of KEYS (not extra copies) that appear more than once in the ACTIVE store — the
// signature a collided concurrent supersede (see the module-top comment block) leaves behind.
// Same definition `drawbar-kb stats` (scripts/kb.ts) already uses.
function countDuplicateKeys(dir: string): number {
  const active = readEntries(dir);
  const counts = new Map<string, number>();
  for (const e of active) counts.set(e.key, (counts.get(e.key) ?? 0) + 1);
  let duplicates = 0;
  for (const c of counts.values()) if (c > 1) duplicates++;
  return duplicates;
}

// Per-attempt order is load-bearing (Locked 15) — see the numbered steps in the inline
// comments below; do not reorder.
export async function syncKnowledge(input: SyncKnowledgeInput): Promise<SyncResult> {
  const { envDir, kbDir, message, lessons, git, sleep } = input;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  if (!isCleanAbsolutePath(envDir)) return { ok: false, reason: "invalid_env_dir", detail: envDir, attempts: 0 };
  if (!isCleanAbsolutePath(kbDir)) return { ok: false, reason: "invalid_kb_dir", detail: kbDir, attempts: 0 };
  if (!isNonEmptyTrimmed(message)) return { ok: false, reason: "invalid_message", attempts: 0 };

  // Apply lessons[] BEFORE the retry loop starts — see the module-top comment block
  // ("lessons[] reconcile") for the documented winner. Delegated whole to appendEntry; never
  // compared/deduped/pre-filtered here.
  for (const lesson of lessons) {
    appendEntry(kbDir, lesson);
  }

  const p = storePaths(kbDir);
  const activeRel = relative(envDir, p.active);
  const archiveRel = relative(envDir, p.archive);

  let attempts = 0;
  let lastStaged: string[] = [activeRel];
  for (let i = 1; i <= maxAttempts; i++) {
    attempts = i;

    // 1. Stage — INSIDE the loop, every attempt, so a mid-run inline write (or a supersede
    // that only just created the archive file) is picked up by a later attempt. `git add` on a
    // path that does not exist fails (exit 128), which would look like a sync failure — so the
    // archive is staged only when it actually exists on disk (checked fresh each attempt,
    // never cached from before the loop). Tested both present and absent.
    const archiveExists = existsSync(p.archive);
    const stagePaths = archiveExists ? [activeRel, archiveRel] : [activeRel];
    lastStaged = stagePaths;
    const addRes = git(["-C", envDir, "add", "--", ...stagePaths]);
    if (addRes.code !== 0) {
      return { ok: false, reason: "add_failed", detail: addRes.stderr, attempts };
    }

    // 2. Commit only if something is actually staged. `git diff --cached --quiet` exits 0
    // (nothing staged) or 1 (something staged); anything else is a genuine git failure, not a
    // "clean" reading. A commit with nothing staged is not a failure — skipped, not attempted.
    const diffRes = git(["-C", envDir, "diff", "--cached", "--quiet"]);
    if (diffRes.code !== 0 && diffRes.code !== 1) {
      return { ok: false, reason: "diff_failed", detail: diffRes.stderr, attempts };
    }
    if (diffRes.code === 1) {
      const commitRes = git(["-C", envDir, "commit", "-m", message]);
      if (commitRes.code !== 0) {
        return { ok: false, reason: "commit_failed", detail: commitRes.stderr, attempts };
      }
    }

    // 3. Dirty precondition — runs AFTER stage+commit precisely so the KB files this attempt
    // just wrote are never self-reported as dirty. `--untracked-files=no`: an untracked file
    // must never be read as dirty (a previous attempted fix counted untracked files, which
    // do not block a rebase — that was wrong). NOT retried: distinct reason, halt now.
    const statusRes = git(["-C", envDir, "status", "--porcelain", "--untracked-files=no"]);
    if (statusRes.code !== 0) {
      return { ok: false, reason: "status_failed", detail: statusRes.stderr, attempts };
    }
    if (statusRes.stdout.trim().length > 0) {
      return { ok: false, reason: "dirty_precondition", detail: statusRes.stdout, attempts };
    }

    // 4. Rebase. NOT retried: distinct reason, halt now.
    const pullRes = git(["-C", envDir, "pull", "--rebase"]);
    if (pullRes.code !== 0) {
      return { ok: false, reason: "pull_failed", detail: pullRes.stderr, attempts };
    }

    // 5. Push.
    const pushRes = git(["-C", envDir, "push"]);
    if (pushRes.code === 0) {
      // `reindex` runs LAST, only after a successful push — `index.db` is gitignored and
      // derived, and a pull (step 4) can bring in entries the local index has never seen.
      // Never `archive`/`compact` — see the module-top comment block.
      buildIndex(kbDir);
      return {
        ok: true,
        attempts,
        staged: lastStaged.map((s) => basename(s)),
        duplicateKeys: countDuplicateKeys(kbDir),
      };
    }
    // Only a genuine rejection shape retries — anything else halts now, after exactly this one
    // attempt (a call-log spy proves no second attempt happens).
    if (!isPushRejection(pushRes.stderr ?? "")) {
      return { ok: false, reason: "push_failed", detail: pushRes.stderr, attempts };
    }
    if (i < maxAttempts) {
      await sleep(RETRY_SLEEP_MS);
    }
  }

  // 6. Attempts exhausted with only rejections — the F8 regression. Halt loud, never fall
  // through silently the way the old bash's `break`-only-on-success loop did.
  return { ok: false, reason: "attempts_exhausted", attempts };
}

// --- knowledgePreflight (Locked 16) -----------------------------------------------------------

export interface PreflightInput {
  envDir: string;
  kbDir: string;
  git: Runner;
  // Injectable filesystem seams for the assert-or-create step — same discipline the rest of
  // this repo uses for injected I/O boundaries; no internal defaulting (defaults live at the
  // CLI entry point, matching every other MainDeps-style module here).
  existsSync: (p: string) => boolean;
  writeFileSync: (p: string, content: string) => void;
  mkdirSync: (p: string, opts: { recursive: boolean }) => void;
}

export type PreflightReason =
  | "invalid_env_dir"
  | "invalid_kb_dir"
  | "status_failed"
  | "knowledge_repo_dirty"
  | "check_attr_failed"
  | "check_attr_not_union";

export type PreflightResult = { ok: true; gitignoreCreated: boolean } | { ok: false; reason: PreflightReason; detail?: string };

// `git check-attr merge -- <path>` prints exactly `<path>: merge: <value>` on one line for one
// requested path. Anything else (a parse miss, or a value other than the literal `union` —
// including `unspecified`, which is what an UNCOVERED path or a missing `.gitattributes`
// line reports) is refused by the caller.
function parseCheckAttrValue(stdout: string): string | null {
  const line = stdout.trim().split("\n")[0] ?? "";
  const marker = ": merge: ";
  const idx = line.lastIndexOf(marker);
  if (idx === -1) return null;
  return line.slice(idx + marker.length).trim();
}

// The live reference this content is copied from is a checked-out `.drawbar/runs/.gitignore`
// (97 bytes) — never committed itself (the run-state files under it are local scratch), which
// is exactly why an operator's very first run of this command can find it absent.
const RUNS_GITIGNORE_CONTENT =
  "# /drawbar-ship run state (T0 story snapshots). Local scratch — never committed.\n*\n!.gitignore\n";

// Order below is deliberate (Locked 16): dirty-tree first (cheapest, and the precondition
// `syncKnowledge` itself re-checks), then `merge=union` on BOTH knowledge files (checked as two
// separate calls, one per path, so a failure on the SECOND path is provably reachable — not
// short-circuited away by the first path's success), then the assert-or-create last.
export function knowledgePreflight(input: PreflightInput): PreflightResult {
  const { envDir, kbDir, git, existsSync: exists, writeFileSync: writeFile, mkdirSync: mkdir } = input;

  if (!isCleanAbsolutePath(envDir)) return { ok: false, reason: "invalid_env_dir", detail: envDir };
  if (!isCleanAbsolutePath(kbDir)) return { ok: false, reason: "invalid_kb_dir", detail: kbDir };

  // 1. Knowledge repo dirty — same untracked-tolerant rule syncKnowledge's own precondition
  // uses. Without this, a preflight that passes while the KB is genuinely mid-write (a
  // tracked-file change never staged) tells nothing about whether step 6's rebase will hold.
  const statusRes = git(["-C", envDir, "status", "--porcelain", "--untracked-files=no"]);
  if (statusRes.code !== 0) {
    return { ok: false, reason: "status_failed", detail: statusRes.stderr };
  }
  if (statusRes.stdout.trim().length > 0) {
    return { ok: false, reason: "knowledge_repo_dirty", detail: statusRes.stdout };
  }

  // 2. `merge=union` on both paths. Both are checked (not just the active file) because this
  // story starts staging the archive too — without union on it, a concurrent archive-append
  // races into the same rebase failure the active file used to.
  const p = storePaths(kbDir);
  const checks: Array<{ label: string; rel: string }> = [
    { label: "knowledge.jsonl", rel: relative(envDir, p.active) },
    { label: "knowledge.archive.jsonl", rel: relative(envDir, p.archive) },
  ];
  for (const { label, rel } of checks) {
    const attrRes = git(["-C", envDir, "check-attr", "merge", "--", rel]);
    if (attrRes.code !== 0) {
      return { ok: false, reason: "check_attr_failed", detail: `${label}: ${attrRes.stderr}` };
    }
    const value = parseCheckAttrValue(attrRes.stdout);
    if (value !== "union") {
      return { ok: false, reason: "check_attr_not_union", detail: `${label}: ${value ?? "unparseable"}` };
    }
  }

  // 3. `.drawbar/runs/.gitignore` — assert-or-create. Absence is a first-run condition, not a
  // failure: created here, reported as a success (`gitignoreCreated: true`), never refused.
  const runsDir = join(envDir, ".drawbar", "runs");
  const gitignorePath = join(runsDir, ".gitignore");
  if (exists(gitignorePath)) {
    return { ok: true, gitignoreCreated: false };
  }
  mkdir(runsDir, { recursive: true });
  writeFile(gitignorePath, RUNS_GITIGNORE_CONTENT);
  return { ok: true, gitignoreCreated: true };
}

// --- CLI entry point ---------------------------------------------------------------------
//
// `commands/drawbar-ship.md` §6 delegates the whole sync here:
//   echo '{"lessons":[...]}' | bun run .../kb-sync.ts sync --env-dir <abs> --dir <kb abs>
//     --message <commit msg>
// and Preflight delegates the knowledge-repo checks:
//   bun run .../kb-sync.ts preflight --env-dir <abs> --dir <kb abs>

type FlagMap = Record<string, string | true>;

// MUST-CHECK cli-flag-boolean-true-fails-open: a flag with no consumable value binds boolean
// `true`, not a string — the caller below refuses that explicitly, never silently treats it as
// absent and defaults. Repeated and unknown flags refuse outright too. Same discipline
// ship-config.ts's `parseCliArgs` uses, generalized here to more than one flag.
function parseFlags(args: string[], allowed: readonly string[]): { ok: true; flags: FlagMap } | { ok: false; error: string } {
  const flags: FlagMap = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!allowed.includes(a)) return { ok: false, error: `unknown flag: ${a}` };
    if (Object.prototype.hasOwnProperty.call(flags, a)) return { ok: false, error: `${a} specified more than once` };
    const next = args[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      flags[a] = next;
      i++;
    } else {
      flags[a] = true;
    }
  }
  return { ok: true, flags };
}

// MUST-CHECK path-from-mutable-state-into-git-C-is-code-execution: `isCleanAbsolutePath` below
// is a SHAPE check only — absolute, no `..` segment — it says nothing about WHOSE repository
// `--env-dir` names. It does not, by itself, make the `git -C envDir` calls above safe against
// a value from agent-writable state. The trust root for `--env-dir` is `commands/drawbar-ship.md`'s
// own derivation from Preflight's already-validated `resolved_config` (itself checked against
// the operator-authored config file by `ship-config.ts`'s `validateShipConfig`) — this CLI
// trusts its caller to have done that.
export type SyncCliParse = { ok: true; envDir: string; dir: string; message: string } | { ok: false; error: string };

export function parseSyncCliArgs(args: string[]): SyncCliParse {
  const parsed = parseFlags(args, ["--env-dir", "--dir", "--message"]);
  if (!parsed.ok) return parsed;
  const { flags } = parsed;
  for (const name of ["--env-dir", "--dir", "--message"]) {
    if (!(name in flags)) return { ok: false, error: `${name} is required` };
    if (flags[name] === true) return { ok: false, error: `${name} requires a value` };
    if (flags[name] === "") return { ok: false, error: `${name} value must not be empty` };
  }
  const envDir = flags["--env-dir"] as string;
  const dir = flags["--dir"] as string;
  const message = flags["--message"] as string;
  if (!isCleanAbsolutePath(envDir)) return { ok: false, error: "--env-dir must be a clean absolute path" };
  if (!isCleanAbsolutePath(dir)) return { ok: false, error: "--dir must be a clean absolute path" };
  if (!isNonEmptyTrimmed(message)) return { ok: false, error: "--message must be a non-empty string" };
  return { ok: true, envDir, dir, message };
}

export type PreflightCliParse = { ok: true; envDir: string; dir: string } | { ok: false; error: string };

export function parsePreflightCliArgs(args: string[]): PreflightCliParse {
  const parsed = parseFlags(args, ["--env-dir", "--dir"]);
  if (!parsed.ok) return parsed;
  const { flags } = parsed;
  for (const name of ["--env-dir", "--dir"]) {
    if (!(name in flags)) return { ok: false, error: `${name} is required` };
    if (flags[name] === true) return { ok: false, error: `${name} requires a value` };
    if (flags[name] === "") return { ok: false, error: `${name} value must not be empty` };
  }
  const envDir = flags["--env-dir"] as string;
  const dir = flags["--dir"] as string;
  if (!isCleanAbsolutePath(envDir)) return { ok: false, error: "--env-dir must be a clean absolute path" };
  if (!isCleanAbsolutePath(dir)) return { ok: false, error: "--dir must be a clean absolute path" };
  return { ok: true, envDir, dir };
}

function isLessonsPayload(v: unknown): v is { lessons: Entry[] } {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  return Array.isArray(obj.lessons) && obj.lessons.every((e) => typeof e === "object" && e !== null);
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

export interface MainDeps {
  argv?: string[];
  readStdin?: () => Promise<string>;
  git?: Runner;
  sleep?: (ms: number) => Promise<void>;
  writeStdout?: (s: string) => void;
  writeStderr?: (s: string) => void;
  existsSync?: (p: string) => boolean;
  writeFileSync?: (p: string, content: string) => void;
  mkdirSync?: (p: string, opts: { recursive: boolean }) => void;
}

export async function main(deps: MainDeps = {}): Promise<number> {
  const argv = deps.argv ?? process.argv.slice(2);
  const readStdin = deps.readStdin ?? (() => new Response(Bun.stdin.stream()).text());
  const git = deps.git ?? makeRealRunner("git");
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const writeStdout = deps.writeStdout ?? ((s: string) => { process.stdout.write(s); });
  const writeStderr = deps.writeStderr ?? ((s: string) => { process.stderr.write(s); });
  const existsSyncDep = deps.existsSync ?? existsSync;
  const writeFileSyncDep = deps.writeFileSync ?? writeFileSync;
  const mkdirSyncDep = deps.mkdirSync ?? mkdirSync;

  const [cmd, ...rest] = argv;

  if (cmd === "sync") {
    const parsed = parseSyncCliArgs(rest);
    if (!parsed.ok) {
      writeStderr(`refused: ${parsed.error}\n`);
      return 1;
    }
    let stdinText: string;
    try {
      stdinText = await readStdin();
    } catch {
      writeStderr("refused: could not read lessons from stdin\n");
      return 1;
    }
    let lessons: Entry[];
    try {
      const raw: unknown = JSON.parse(stdinText);
      if (!isLessonsPayload(raw)) {
        writeStderr('refused: stdin must be {"lessons":[...]}\n');
        return 1;
      }
      lessons = raw.lessons;
    } catch {
      writeStderr("refused: stdin is not valid JSON\n");
      return 1;
    }

    let result: SyncResult;
    try {
      result = await syncKnowledge({ envDir: parsed.envDir, kbDir: parsed.dir, message: parsed.message, lessons, git, sleep });
    } catch (err) {
      // A malformed lessons[] entry is rejected by store.ts's appendEntry with a thrown
      // Error — caught here as a named refusal rather than an uncaught crash.
      writeStderr(`refused: invalid lessons entry: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }

    if (!result.ok) {
      writeStderr(`refused: ${result.reason}${result.detail !== undefined ? `: ${JSON.stringify(sanitizeForOutput(result.detail))}` : ""}\n`);
      writeStdout(JSON.stringify(result) + "\n");
      return 1;
    }
    if (result.duplicateKeys > 0) {
      // Loud, but does NOT fail the sync — see the module-top comment block on why a
      // collided-supersede union artifact is benign and self-inflicted, never a halt reason.
      writeStderr(
        `warning: duplicateKeys=${result.duplicateKeys} — the active store has one or more keys with more than one ` +
          "copy (a union-merge artifact of a concurrent supersede, not corruption). Resolve with an ATTENDED " +
          "`drawbar-kb compact` run; kb-sync never runs archive or compact itself.\n",
      );
    }
    writeStdout(JSON.stringify(result) + "\n");
    return 0;
  }

  if (cmd === "preflight") {
    const parsed = parsePreflightCliArgs(rest);
    if (!parsed.ok) {
      writeStderr(`refused: ${parsed.error}\n`);
      return 1;
    }
    const result = knowledgePreflight({
      envDir: parsed.envDir,
      kbDir: parsed.dir,
      git,
      existsSync: existsSyncDep,
      writeFileSync: writeFileSyncDep,
      mkdirSync: mkdirSyncDep,
    });
    if (!result.ok) {
      writeStderr(`refused: ${result.reason}${result.detail !== undefined ? `: ${JSON.stringify(sanitizeForOutput(result.detail))}` : ""}\n`);
      writeStdout(JSON.stringify(result) + "\n");
      return 1;
    }
    writeStdout(JSON.stringify(result) + "\n");
    return 0;
  }

  writeStderr(
    "usage: kb-sync.ts sync --env-dir <abs> --dir <abs> --message <msg>\n" +
      "       kb-sync.ts preflight --env-dir <abs> --dir <abs>\n",
  );
  return 1;
}

if (import.meta.main) {
  // Copies ship-config.ts's `.catch` rationale verbatim: without it, an unexpected throw
  // anywhere in main() not already caught internally becomes an UNHANDLED PROMISE REJECTION
  // instead of a named refusal + non-zero exit.
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`refused: unexpected error: ${JSON.stringify(message)}\n`);
      process.exit(1);
    });
}
