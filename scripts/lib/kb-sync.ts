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
//   - `assertEnvDirTrusted` — the trust root BOTH of the above apply to `envDir` before their
//     first git call. See its own comment block below; it is the R5/F2 fix.
//
// --- what R5 changed (PCO-368), in one place ------------------------------------------------
//
// Four behaviours of the per-attempt sequence were wrong in ways the fake runner could not see,
// because the fake modelled neither the filesystem nor git's pathspec semantics:
//
//   F1  `git add` on a GITIGNORED path exits 1, and the loop called that `add_failed` and
//       halted. Wherever `knowledge.archive.jsonl` is gitignored, the first supersede created
//       the file and every subsequent sync halted PERMANENTLY. Both knowledge paths are now
//       filtered through `git check-ignore` first.
//   F5  `git add` on a MISSING path exits 128. The archive had an existence guard; the active
//       file did not, so a scaffolded knowledge repo with no `knowledge.jsonl` and an empty
//       `lessons[]` halted on its first sync. Both paths are filtered, and when NEITHER
//       survives, stage+commit are skipped rather than attempted.
//   F6  `git diff --cached --quiet` and `git commit -m` carried NO pathspec. With an unrelated
//       file staged by someone else the diff exited 1, the commit swept that file in, the
//       dirty precondition then saw a clean tree, and the sweep was pushed. Both calls are now
//       scoped to exactly the paths this attempt staged.
//   F4  `knowledgePreflight`'s assert-or-create dropped its `writeFileSync` failure on the
//       floor — on a real first run with `.drawbar/runs/` absent it threw ENOENT straight past
//       `PreflightResult`. The mkdir/write pair is wrapped and reports a named reason.
//
// Every git exit code relied on above was VERIFIED by running real git 2.43.0, not assumed; the
// call sites carry the observed results and the reasoning about the ambiguous cases.
//
// --- what R7 changed (PCO-371), in one place ------------------------------------------------
//
// R5's trust root was a TAUTOLOGY and the ACE sink stayed open; three other paths from the same
// mutable state were unguarded or under-reported. All four were reproduced before being fixed:
//
//   T1  `--config-path` was an arbitrary shape-clean path, so a caller supplied BOTH sides of the
//       envDir equality (write a config naming your own directory, name it as your own trust
//       root). Now the config must resolve to the path THIS PROCESS's `$DRAWBAR_SHIP_CONFIG`/cwd
//       already point at, AND must not be tracked by git. See `assertEnvDirTrusted`.
//   T2  `--dir` (kbDir) had no trust root at all — a write sink (`mkdir -p` + append) and the
//       source of every git pathspec. Now required to be INSIDE the vouched-for `envDir`, checked
//       before `appendEntry` runs. See `isInsideDir`.
//   T3  R5/F1's "skip an ignored path, do not halt" turned a gitignored `knowledge.jsonl` into
//       permanent SILENT data loss (`{ok:true, staged:[]}` forever). `knowledgePreflight` now
//       refuses it outright, and a successful sync reports `ignored[]` with a loud stderr warning.
//   T4  Refusal JSON reached STDOUT unsanitized (`JSON.stringify` escapes no invisible/bidi
//       character), while stderr was sanitized. Both are sanitized now.
//
// R7 also corrected two comments that asserted things that were not true: the mid-merge/mid-rebase
// partial-commit case at the commit call site, and the "cannot skip it" claim at the CLI entry
// point.
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

import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { appendEntry, readEntries, storePaths } from "./store";
import { buildIndex } from "./fts";
import type { Entry } from "./schema";
import { isCleanAbsolutePath, isNonEmptyTrimmed, parseShipConfig, resolveConfigPath, sanitizeForOutput } from "./ship-config";
import type { Runner, ShipConfig } from "./ship-config";

// --- the envDir trust root (R5/F2) ------------------------------------------------------------
//
// `envDir` reaches `git -C envDir` on every call either verb makes, and a path reaching `git -C`
// from mutable state is a CODE EXECUTION sink, not merely a wrong-directory bug: git reads that
// directory's own `.git/config`, so `core.sshCommand` runs on a fetch/pull and a
// `reference-transaction` hook runs on a successful ref update. `isCleanAbsolutePath` is a SHAPE
// check only (absolute, no `..` segment) — it says nothing whatever about WHOSE repository the
// value names.
//
// Before R5 the comment at the CLI entry point claimed the trust root was
// `commands/drawbar-ship.md` §6 "deriving it from Preflight's already-validated
// resolved_config". That trust root DID NOT EXIST. §6 is a separate Bash invocation from
// Preflight's — no shell state survives between tool calls — so it re-derived `ENV_DIR` from a
// prose placeholder (`RESOLVED="<Preflight's resolved_config JSON>"`) that the MODEL fills in,
// checked only that the result was non-empty and not the literal "null", and never referenced
// `$CONFIG` at all. Any value the agent's own context could be induced to produce was accepted.
//
// So the check moved INTO the module: both verbs take a REQUIRED `--config-path`, parse that
// file with `parseShipConfig` (never a second parser here), and refuse unless its `envDir`
// EQUALS the `--env-dir` they were handed. The refusal happens before any git call against
// `envDir` and before any store mutation; a call-counter spy proves it.
//
// --- R7 (PCO-371): why the equality alone was still a TAUTOLOGY -----------------------------
//
// R5 shipped that equality and claimed "a caller that skips or rewrites the runbook cannot skip
// it either". That claim was FALSE, in exactly the way the comment R5 deleted was false, and it
// was reproduced end to end against this CLI with no fakes: `--config-path` was an ordinary argv
// flag validated only for SHAPE, so a caller naming a hostile `--env-dir` simply wrote a config
// file saying `{"envDir":"<that same dir>"}` and named it as its own trust root. Both sides of
// the equality came from the same argv. A `reference-transaction` hook in the named repository
// then ran on the commit this loop makes. That is verbatim the corollary in MUST-CHECK
// `path-from-mutable-state-into-git-C-is-code-execution`: "if the new observation is anchored at
// a path taken from the same untrusted object, the tautology just moved one indirection deeper".
//
// Two checks close it, and neither is expressible as an equality between two argv values:
//
//   1. ANCHORED LOCATION. `configPath` must be the very path `ship-config.ts`'s own
//      `resolveConfigPath` derives from THIS PROCESS's environment and working directory —
//      `$DRAWBAR_SHIP_CONFIG`, or `<cwd>/.drawbar/ship.config.json`. Compared after resolving
//      symlinks on both sides, because the runbook legitimately passes the `readlink -f` form
//      while `$DRAWBAR_SHIP_CONFIG` may be relative or itself a symlink. An argv flag can no
//      longer choose WHICH file vouches for `--env-dir`; it can only name the one the process's
//      own environment already points at. (Same primitive, not a second copy of the default.)
//
//      SCOPE, stated rather than implied: this moves the trust root from argv to the process's
//      environment and working directory — the same trust root `ship-config.ts validate` and every
//      fence in `commands/drawbar-ship.md` already rest on, and what the KB entry means by "the
//      operator-authored config". It does NOT defend against a caller that can also choose the cwd
//      or export `$DRAWBAR_SHIP_CONFIG` and plant an untracked config there; that is a strictly
//      stronger capability than passing a flag, and closing it would need a trust root outside the
//      process environment entirely. The runbook's own two §6 guards are the other half here.
//   2. NOT TRACKED BY GIT. The repo's own MUST-CHECK `config-file-must-not-be-tracked-by-git`,
//      applied here with the already-injected runner: `git -C <dirname> ls-files
//      --error-unmatch <realpath>` exiting 0 means a branch under review COMMITTED the config,
//      which is the one signal that distinguishes an operator-authored config from a planted
//      one. Deliberately the SAME guard `commands/drawbar-ship.md` runs, including its
//      fail-OPEN-on-git-failure shape (only exit 0 refuses): a `git` failure — the config's
//      directory not being a repository at all is the ordinary case — is not the vulnerability
//      this guards against, so it must not become a new halt.
//
// ORDER: the tracked-config check runs LAST, after every filesystem-and-parse check above it,
// so the pure refusals still make ZERO git calls of any kind (proven by a call-counter spy), and
// so the one git call it does make is anchored at the ANCHOR-VERIFIED config path rather than at
// anything argv chose. It still precedes every `git -C envDir` call and every store mutation.
export type EnvDirTrustReason =
  | "config_path_unresolvable"
  | "config_path_not_anchored"
  | "config_unreadable"
  | "config_invalid"
  | "config_is_tracked"
  | "env_dir_not_in_config";

export type EnvDirTrustResult =
  | { ok: true; config: ShipConfig }
  | { ok: false; reason: EnvDirTrustReason; detail: string };

export interface EnvDirTrustInput {
  configPath: string;
  envDir: string;
  // The path this PROCESS's own env/cwd resolve to, via ship-config.ts's `resolveConfigPath`.
  // Injected rather than read from `process` here so this stays a pure function; main() binds it.
  expectedConfigPath: string;
  // Injected, no internal defaulting — same discipline as PreflightInput's fs seams; the real
  // `readFileSync`/`realpathSync` are bound at the CLI entry point.
  readConfig: (p: string) => string;
  realpath: (p: string) => string;
  // For the tracked-config guard only, and only against the config's own directory — never
  // against `envDir`, which nothing here has yet vouched for.
  git: Runner;
}

export function assertEnvDirTrusted(
  { configPath, envDir, expectedConfigPath, readConfig, realpath, git }: EnvDirTrustInput,
): EnvDirTrustResult {
  // Check 1 — the anchored location. Both sides symlink-resolved: the runbook passes
  // `$(readlink -f "$CONFIG")` while `$DRAWBAR_SHIP_CONFIG` may be relative or a symlink, so a
  // raw string comparison would refuse the shipped invocation.
  let configReal: string;
  let expectedReal: string;
  try {
    configReal = realpath(configPath);
  } catch (err) {
    return {
      ok: false,
      reason: "config_path_unresolvable",
      detail: `--config-path ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    expectedReal = realpath(expectedConfigPath);
  } catch (err) {
    return {
      ok: false,
      reason: "config_path_unresolvable",
      detail: `expected config ${expectedConfigPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (configReal !== expectedReal) {
    return {
      ok: false,
      reason: "config_path_not_anchored",
      detail: `--config-path ${configPath} is not this environment's ship config (${expectedConfigPath})`,
    };
  }

  let text: string;
  try {
    text = readConfig(configPath);
  } catch (err) {
    return {
      ok: false,
      reason: "config_unreadable",
      detail: `${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // Delegated WHOLE to ship-config.ts. This module must never grow its own `JSON.parse(text).envDir`
  // shortcut: that would read the one field it cares about out of a file nothing had validated,
  // reintroducing exactly the missing trust root this function exists to supply.
  const parsed = parseShipConfig(text);
  if (!parsed.ok) {
    return { ok: false, reason: "config_invalid", detail: `${parsed.reason}: ${parsed.detail}` };
  }
  // `parseShipConfig` is STRUCTURAL only — it never checks that `envDir` is a clean absolute
  // path (that is `validateShipConfig`'s job, and this module does not run it). Check it here
  // before comparing, so a config carrying a traversal-shaped envDir cannot be matched by an
  // equally traversal-shaped `--env-dir` and admitted.
  if (!isCleanAbsolutePath(parsed.config.envDir)) {
    return { ok: false, reason: "config_invalid", detail: `envDir must be a clean absolute path: ${parsed.config.envDir}` };
  }
  // Compared after `resolve()` on both sides, matching `validateShipConfig`'s own
  // projectDir/envDir comparison rather than inventing a second equality rule. Both values are
  // already known clean-absolute, so `resolve` here only collapses a trailing or doubled
  // separator — it cannot reach outside the path or consult the filesystem.
  //
  // DELIBERATELY NOT `realpath` on these two (R7 reviewed and rejected that change): both sides
  // are the same kind of value and would receive the IDENTICAL transformation, so realpath cannot
  // distinguish them — a symlink standing at the configured envDir resolves to the same target on
  // both sides and passes either way. It would only make the check LOOSER, newly admitting an
  // `--env-dir` whose literal differs from the configured one but resolves to the same directory.
  // See the R7 test that pins this reasoning.
  if (resolve(parsed.config.envDir) !== resolve(envDir)) {
    return {
      ok: false,
      reason: "env_dir_not_in_config",
      detail: `--env-dir ${envDir} is not the configured envDir ${parsed.config.envDir}`,
    };
  }

  // Check 2 — MUST-CHECK config-file-must-not-be-tracked-by-git, LAST (see the order note in the
  // block comment above). Byte-for-byte the guard `commands/drawbar-ship.md` runs, including its
  // fail-open shape: ONLY exit 0 (`--error-unmatch` matched, i.e. the path IS in the index)
  // refuses. Every other code — 1 for "not tracked", 128 for "not a repository at all", the real
  // runner's 127 for a missing `git` binary — proceeds, because a git failure here is not the
  // vulnerability this guards against and turning it into a halt would refuse every operator
  // whose config lives outside any repository.
  const trackedRes = git(["-C", dirname(configReal), "ls-files", "--error-unmatch", configReal]);
  if (trackedRes.code === 0) {
    return {
      ok: false,
      reason: "config_is_tracked",
      detail: `${configPath} is tracked by git — a committed ship config is never trusted`,
    };
  }
  return { ok: true, config: parsed.config };
}

// `kbDir` is the SECOND path this module takes from the same mutable state as `envDir`, and R5
// left it with only `isCleanAbsolutePath` — a shape check. It is a WRITE sink (`appendEntry` does
// `mkdirSync(dir,{recursive:true})` and then appends caller-supplied JSON; `buildIndex` writes
// `index.db`) and it is the source of every git pathspec via `relative(envDir, ...)`. Reproduced:
// `--dir <two directories outside a trusted envDir>` created that whole tree and wrote an
// attacker-chosen `knowledge.jsonl` into it BEFORE the first git call failed. Containment in the
// vouched-for `envDir` is what the runbook's own `KB="$ENV_DIR/.drawbar/memory"` already assumes,
// and it removes the pathspec-escape (`../../...`) surface at the same time.
function isInsideDir(parent: string, child: string): boolean {
  const p = resolve(parent);
  const c = resolve(child);
  return c === p || c.startsWith(p.endsWith(sep) ? p : p + sep);
}

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
  // R5/F2 trust root — required, not optional. See `assertEnvDirTrusted` above.
  configPath: string;
  // R7: the anchor `configPath` must agree with, and the symlink-resolving seam that compares
  // them. Both injected, no internal defaulting; main() binds them.
  expectedConfigPath: string;
  readConfig: (p: string) => string;
  realpath: (p: string) => string;
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
  // R5/F2 trust root — refused before any git call and before any store mutation.
  | EnvDirTrustReason
  // R7: `--dir` must live inside the vouched-for `envDir`. Refused before `appendEntry` can
  // mkdir-and-write anywhere else on disk. See `isInsideDir` above.
  | "kb_dir_not_in_env_dir"
  // R5/F1: `git check-ignore` itself failed (exit 128, or the real runner's 127 for a missing
  // binary) so the ignore status of a knowledge path could not be established — NOT retried.
  | "check_ignore_failed"
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
  // R7/F1-followup: `ignored` names every knowledge path `check-ignore` reported as gitignored
  // and this loop therefore SKIPPED. Skipping is right for `knowledge.archive.jsonl` (see the
  // filter's own comment) but a gitignored `knowledge.jsonl` means the sync commits no knowledge
  // AT ALL, forever, while still returning `ok: true` — which the runbook's `.ok == "true"` check
  // reads as a clean ship. Reported here and warned LOUDLY on stderr (same treatment
  // `duplicateKeys` gets, for the same reason: visible, never a silent success). The loud gate
  // that refuses outright is `knowledgePreflight`'s own check-ignore assertion.
  | { ok: true; attempts: number; staged: string[]; ignored: string[]; duplicateKeys: number }
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
  const { envDir, kbDir, message, lessons, git, sleep, configPath, expectedConfigPath, readConfig, realpath } = input;
  const maxAttempts = input.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  if (!isCleanAbsolutePath(envDir)) return { ok: false, reason: "invalid_env_dir", detail: envDir, attempts: 0 };
  if (!isCleanAbsolutePath(kbDir)) return { ok: false, reason: "invalid_kb_dir", detail: kbDir, attempts: 0 };
  if (!isNonEmptyTrimmed(message)) return { ok: false, reason: "invalid_message", attempts: 0 };

  // R5/F2: the trust root, BEFORE the first `git -C envDir` call and BEFORE `appendEntry` mutates
  // the store — an untrusted envDir must not get a `git -C` (an ACE sink) nor a knowledge write.
  // Proven by a call-counter spy, not by reading the code.
  const trust = assertEnvDirTrusted({ configPath, envDir, expectedConfigPath, readConfig, realpath, git });
  if (!trust.ok) return { ok: false, reason: trust.reason, detail: trust.detail, attempts: 0 };

  // R7: and `--dir` must be inside the envDir the config just vouched for — checked against
  // `trust.config.envDir` (the operator-authored value, not the argv one) and BEFORE the
  // `appendEntry` loop below, which would otherwise mkdir-and-write an arbitrary tree anywhere on
  // disk. See `isInsideDir`.
  if (!isInsideDir(trust.config.envDir, kbDir)) {
    return {
      ok: false,
      reason: "kb_dir_not_in_env_dir",
      detail: `--dir ${kbDir} is not inside the configured envDir ${trust.config.envDir}`,
      attempts: 0,
    };
  }

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
  // Starts EMPTY, not `[activeRel]`: R5/F5 means "nothing was staged" is a legitimate outcome
  // (neither knowledge file exists yet), and seeding this with the active path would name a file
  // as staged that was never handed to `git add`.
  //
  // R6 correction, established by mutation rather than by reading: this initializer is
  // UNOBSERVABLE, so re-seeding it is an equivalent mutant no test can kill. `lastStaged =
  // stagePaths` below runs unconditionally on every attempt, and it dominates the only read (the
  // success return); the two paths that skip the loop body entirely (`maxAttempts <= 0`) return
  // the failure variant, which carries no `staged` field at all. The property the comment above
  // actually cares about is pinned by behaviour instead — see the R5/F5 test asserting
  // `staged: []` when neither knowledge file is on disk. Keep the `[]` as the honest shape; do
  // not mistake it for a live guard.
  let lastStaged: string[] = [];
  // R7: the same shape and the same reasoning as `lastStaged` — re-derived fresh on every attempt
  // (a `.gitignore` can change mid-run), and the last attempt's value is what the success return
  // reports.
  let lastIgnored: string[] = [];
  for (let i = 1; i <= maxAttempts; i++) {
    attempts = i;

    // 1. Stage — INSIDE the loop, every attempt, so a mid-run inline write (or a supersede
    // that only just created the archive file) is picked up by a later attempt. Both filters
    // below are re-evaluated fresh on every attempt, never cached from before the loop.
    //
    // `git add` refuses two conditions that are NOT sync failures, and the loop used to map
    // both onto `add_failed` and halt:
    //   - a path that does not exist          -> exit 128 (`fatal: pathspec ... did not match`)
    //   - a path a `.gitignore` pattern covers -> exit 1  (`The following paths are ignored...`)
    // The second one (R5/F1) was the worse of the two because it is PERMANENT: wherever
    // `knowledge.archive.jsonl` is gitignored, the first supersede creates the file and every
    // sync from then on halts, forever. Both are filtered here instead.
    // R5/F5: the existence filter applies to BOTH paths, not just the archive. A freshly
    // scaffolded knowledge repo has no `knowledge.jsonl` yet, and an empty `lessons[]` never
    // creates one — that combination used to halt `add_failed` on the very first sync.
    const candidates = [
      ...(existsSync(p.active) ? [activeRel] : []),
      ...(existsSync(p.archive) ? [archiveRel] : []),
    ];
    const stagePaths: string[] = [];
    const ignoredPaths: string[] = [];
    for (const rel of candidates) {
      // `git check-ignore -q -- <path>` exit codes, VERIFIED against real git 2.43.0 rather
      // than assumed: 0 = the path IS ignored, 1 = it is NOT ignored, 128 = git itself failed
      // (not a repository, path outside the work tree, no pathspec given).
      //
      // Deliberately WITHOUT `--no-index`. Also verified against real git: for a file that is
      // TRACKED but also matched by a `.gitignore` pattern, plain `check-ignore -q` exits 1
      // (not ignored) while `--no-index` exits 0. Plain check-ignore therefore mirrors `git
      // add`'s own index-aware behaviour exactly — which is the property this filter needs,
      // since the whole point is to skip only the paths `git add` would actually refuse.
      // `--no-index` would make this filter silently drop a tracked file's real change.
      const ignoreRes = git(["-C", envDir, "check-ignore", "-q", "--", rel]);
      if (ignoreRes.code === 0) {
        // Ignored: skip it, do not halt — but RECORD it. R7: an ignored `knowledge.archive.jsonl`
        // is benign, an ignored `knowledge.jsonl` means this sync will commit nothing at all on
        // every run from now on while still reporting `ok: true`, which is the same silent
        // outcome the 128 decision below refuses to guess its way into. The record is what the
        // CLI's stderr warning and `knowledgePreflight`'s hard refusal are built on.
        ignoredPaths.push(rel);
        continue;
      }
      if (ignoreRes.code !== 1) {
        // DECIDED (the 128 case): fail closed with a DISTINCT reason rather than guessing the
        // ignore status either way. Guessing "not ignored" and letting `git add` decide would
        // report the more confusing `add_failed`; guessing "ignored" would silently stop
        // committing knowledge. Every condition that makes check-ignore exit 128 (envDir is
        // not a repository, the path is outside the work tree) is one that makes `git add`
        // fail too, so this halt costs no working sync — it only names the cause better. A
        // missing `git` binary arrives here as the real runner's 127, caught by the same
        // branch.
        return { ok: false, reason: "check_ignore_failed", detail: `${rel}: ${ignoreRes.stderr ?? ""}`, attempts };
      }
      stagePaths.push(rel);
    }
    lastStaged = stagePaths;
    lastIgnored = ignoredPaths;

    // R5/F5: with EVERY candidate filtered out (neither file exists yet, or both are ignored),
    // stage+commit are skipped WHOLE rather than halting. `git add --` with an empty pathspec
    // and `git commit -- ` with an empty pathspec are both meaningless calls, and there is
    // genuinely nothing of ours to commit — so the attempt goes straight on to the
    // precondition, the rebase and the push, which still have work to do (a pull can bring in
    // another agent's entries even when this run wrote none of its own).
    if (stagePaths.length > 0) {
      const addRes = git(["-C", envDir, "add", "--", ...stagePaths]);
      if (addRes.code !== 0) {
        return { ok: false, reason: "add_failed", detail: addRes.stderr, attempts };
      }

      // 2. Commit only if something OF OURS is actually staged. `git diff --cached --quiet`
      // exits 0 (nothing staged) or 1 (something staged); anything else is a genuine git
      // failure, not a "clean" reading. A commit with nothing staged is not a failure —
      // skipped, not attempted.
      //
      // R5/F6: BOTH calls are SCOPED to `stagePaths`. Unscoped, with an unrelated file staged
      // by someone else, the reported bug ran end to end: the unscoped diff exited 1 (so the
      // loop believed it had work), the unscoped commit swept the foreign file into the KB
      // commit, `status -uno` was then CLEAN so the precondition below saw nothing wrong, and
      // the sweep was PUSHED. Scoped, the diff reports 0, no commit is attempted, and the
      // precondition trips on the foreign file instead — fail closed.
      //
      // `git commit -- <pathspec>` semantics, VERIFIED by running real git 2.43.0 rather than
      // assumed. All five behaviours below were observed directly:
      //   1. It implies `--only`: other staged index entries are LEFT STAGED and are NOT
      //      included in the commit. (This is the fix's whole mechanism.)
      //   2. It commits the WORKING TREE content of the named paths, BYPASSING the index for
      //      them. On a partially-staged file (hunk A staged, hunk B only in the worktree) the
      //      scoped commit lands BOTH hunks, whereas an unscoped commit lands only hunk A.
      //      That is acceptable — in fact preferable — here: `git add` on these exact paths ran
      //      immediately above, so index and worktree agree, and where they DON'T (an inline
      //      `drawbar-kb add` landing in the microseconds between the add and the commit) the
      //      newer worktree content is precisely what we want committed. Committing the stale
      //      indexed copy instead would leave the file dirty and trip the precondition below.
      //   3. A pathspec matching nothing git knows about exits 1 (`error: pathspec ... did not
      //      match any file(s) known to git`), not 128.
      //   4. A pathspec with no changes exits 1 (`nothing to commit`). Unreachable here: the
      //      scoped diff above already established a staged change on these same paths.
      //   5. A partial commit is REFUSED during a MERGE (exit 128, `fatal: cannot do a partial
      //      commit during a merge`) but is ACCEPTED during a REBASE, and the difference matters
      //      because only one of those two states is reachable. Both re-verified on real git
      //      2.43.0 in R7, because R5's comment here asserted the case was "unreachable" and that
      //      step 3 below would have caught it regardless — and BOTH halves of that were wrong:
      //        - The reachable state is a mid-REBASE tree, and this module's own non-retried
      //          `pull_failed` is what LEAVES one behind. A later run against that wedged repo
      //          reaches this commit with `UU <conflicted file>` in the tree; the scoped form
      //          then SUCCEEDS (`[detached HEAD ...] kb sync`, code 0) where the unscoped form
      //          refused with 128 (`Committing is not possible because you have unmerged
      //          files`). So this is a genuine behaviour change R5 introduced, not a no-op.
      //        - It cannot be "caught by the dirty precondition below": the precondition runs
      //          AFTER this commit, deliberately (see step 3).
      //      The overall verdict is still FAIL CLOSED, which is why this stays a recorded
      //      semantic rather than a code change: the commit lands on the rebase's detached HEAD,
      //      `status` then reports the conflict, the precondition trips `dirty_precondition`, and
      //      nothing is pushed. A subsequent `git rebase --abort` makes that commit unreachable.
      //      Verified for the conflicted and the resolved-but-not-continued variants both.
      // Cases 3-5 all surface as `commit_failed` with git's own stderr in `detail` when they do
      // refuse.
      const diffRes = git(["-C", envDir, "diff", "--cached", "--quiet", "--", ...stagePaths]);
      if (diffRes.code !== 0 && diffRes.code !== 1) {
        return { ok: false, reason: "diff_failed", detail: diffRes.stderr, attempts };
      }
      if (diffRes.code === 1) {
        const commitRes = git(["-C", envDir, "commit", "-m", message, "--", ...stagePaths]);
        if (commitRes.code !== 0) {
          return { ok: false, reason: "commit_failed", detail: commitRes.stderr, attempts };
        }
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
        ignored: lastIgnored.map((s) => basename(s)),
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
  // R5/F2 trust root — required on this verb too. Preflight runs FIRST in the runbook, so if
  // only one of the two verbs carried the check this is the one an attacker would aim at.
  configPath: string;
  expectedConfigPath: string;
  readConfig: (p: string) => string;
  realpath: (p: string) => string;
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
  // R5/F2 trust root — refused before any `git -C envDir` call.
  | EnvDirTrustReason
  // R7: `--dir` must live inside the vouched-for envDir. Same reason name syncKnowledge uses.
  | "kb_dir_not_in_env_dir"
  | "status_failed"
  | "knowledge_repo_dirty"
  | "check_attr_failed"
  | "check_attr_not_union"
  // R7: a knowledge path a `.gitignore` covers. Refused HERE, loudly and once, because the sync
  // loop cannot refuse it without reintroducing the permanent halt R5/F1 removed. See the check.
  | "knowledge_path_ignored"
  | "check_ignore_failed"
  // R5/F4 M9: the assert-or-create's mkdir/write failed (ENOENT on a first run with the mkdir
  // gone, EACCES, ENOSPC). A named verdict, never an uncaught throw.
  | "runs_gitignore_write_failed";

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
// short-circuited away by the first path's success), then (R7) neither knowledge path being
// gitignored, then the assert-or-create last.
export function knowledgePreflight(input: PreflightInput): PreflightResult {
  const {
    envDir, kbDir, git, configPath, expectedConfigPath, readConfig, realpath,
    existsSync: exists, writeFileSync: writeFile, mkdirSync: mkdir,
  } = input;

  if (!isCleanAbsolutePath(envDir)) return { ok: false, reason: "invalid_env_dir", detail: envDir };
  if (!isCleanAbsolutePath(kbDir)) return { ok: false, reason: "invalid_kb_dir", detail: kbDir };

  // R5/F2: the trust root, BEFORE the first `git -C envDir` call — `git -C envDir status` on an
  // attacker-named directory already reads that repo's `.git/config`. Proven by a call-counter spy.
  const trust = assertEnvDirTrusted({ configPath, envDir, expectedConfigPath, readConfig, realpath, git });
  if (!trust.ok) return { ok: false, reason: trust.reason, detail: trust.detail };

  // R7: same containment rule syncKnowledge applies, against the same vouched-for value. This verb
  // writes only `.drawbar/runs/.gitignore` (under envDir, not kbDir), but kbDir still supplies the
  // check-attr/check-ignore pathspecs below, and refusing in one verb only would let Preflight
  // pass on a `--dir` the sync then refuses.
  if (!isInsideDir(trust.config.envDir, kbDir)) {
    return {
      ok: false,
      reason: "kb_dir_not_in_env_dir",
      detail: `--dir ${kbDir} is not inside the configured envDir ${trust.config.envDir}`,
    };
  }

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

  // 3. NEITHER knowledge path may be gitignored (R7). This is the loud, once-per-run gate for the
  // hole R5/F1's fix opened: the sync loop SKIPS an ignored path rather than halting — which is
  // right for `knowledge.archive.jsonl`, and is permanent SILENT DATA LOSS for
  // `knowledge.jsonl`. With the active path ignored the loop stages nothing, commits nothing, and
  // returns `{ok:true, staged:[]}` on every run forever, which `commands/drawbar-ship.md` §6 reads
  // as a clean ship (it checks only `.ok == "true"`). Reproduced against the real module.
  //
  // Refusing HERE rather than in the loop is what keeps both properties: a repo whose knowledge
  // files are gitignored is not a knowledge repo and is refused once, before the run does any
  // work, while the loop stays tolerant so a mid-run ignore can never resurrect R5/F1's permanent
  // halt. Both paths are checked, as two separate calls, for the same reachability reason the
  // `merge=union` loop above spells out.
  //
  // Exit codes are the ones the loop's own filter documents, verified on real git 2.43.0:
  // 0 = ignored, 1 = not ignored, 128 = git itself failed. Unlike the tracked-config guard in
  // `assertEnvDirTrusted`, this one fails CLOSED on a non-0/1 code: preflight exists to ASSERT,
  // and a git that cannot answer has not established the assertion.
  for (const { label, rel } of checks) {
    const ignoreRes = git(["-C", envDir, "check-ignore", "-q", "--", rel]);
    if (ignoreRes.code === 0) {
      return {
        ok: false,
        reason: "knowledge_path_ignored",
        detail: `${label}: ${rel} is ignored by a .gitignore pattern — the sync would silently commit no knowledge at all`,
      };
    }
    if (ignoreRes.code !== 1) {
      return { ok: false, reason: "check_ignore_failed", detail: `${label}: ${ignoreRes.stderr ?? ""}` };
    }
  }

  // 4. `.drawbar/runs/.gitignore` — assert-or-create. Absence is a first-run condition, not a
  // failure: created here, reported as a success (`gitignoreCreated: true`), never refused.
  const runsDir = join(envDir, ".drawbar", "runs");
  const gitignorePath = join(runsDir, ".gitignore");
  if (exists(gitignorePath)) {
    return { ok: true, gitignoreCreated: false };
  }
  // R5/F4 M9. The `mkdir` is NOT optional and its ORDER is load-bearing: on a genuine first run
  // `.drawbar/runs/` (and possibly `.drawbar/` itself, hence `recursive`) does not exist, and
  // `writeFileSync` into a non-existent directory throws ENOENT. Deleting the mkdir used to
  // leave the suite green because the test double accepted any write regardless of whether the
  // parent directory had ever been created — a fake that did not model the one filesystem
  // constraint this code depends on. The fake now throws exactly as node does.
  //
  // And the pair is WRAPPED: an ENOENT (or EACCES, or ENOSPC) used to propagate straight past
  // `PreflightResult` to the CLI's top-level `.catch`, turning a first-run condition into an
  // "unexpected error" crash instead of one of this function's own named verdicts.
  try {
    mkdir(runsDir, { recursive: true });
    writeFile(gitignorePath, RUNS_GITIGNORE_CONTENT);
  } catch (err) {
    return {
      ok: false,
      reason: "runs_gitignore_write_failed",
      detail: `${gitignorePath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: true, gitignoreCreated: true };
}

// --- CLI entry point ---------------------------------------------------------------------
//
// `commands/drawbar-ship.md` §6 delegates the whole sync here:
//   echo '{"lessons":[...]}' | bun run .../kb-sync.ts sync --env-dir <abs> --dir <kb abs>
//     --message <commit msg> --config-path <abs ship.config.json>
// and Preflight delegates the knowledge-repo checks:
//   bun run .../kb-sync.ts preflight --env-dir <abs> --dir <kb abs>
//     --config-path <abs ship.config.json>
//
// `--config-path` is REQUIRED on both verbs (R5/F2): it is the trust root for `--env-dir`, and
// without it neither verb will make a single git call. See `assertEnvDirTrusted` near the top of
// this file for why the trust root had to move in here from the runbook.

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
// `--env-dir` names, and it does NOT by itself make the `git -C envDir` calls above safe against
// a value from agent-writable state.
//
// CORRECTED IN R5 (this comment used to be wrong, and the wrongness was the vulnerability): it
// previously asserted that the trust root for `--env-dir` was `commands/drawbar-ship.md`'s own
// derivation from Preflight's already-validated `resolved_config`, and that "this CLI trusts its
// caller to have done that". §6 did no such thing — it re-derived ENV_DIR from a prose
// placeholder the model fills in, asserted only non-emptiness, and never referenced `$CONFIG`.
// The trust root now lives in this module (`assertEnvDirTrusted`, applied at the top of BOTH
// `syncKnowledge` and `knowledgePreflight`), which is why `--config-path` below is REQUIRED on
// both verbs rather than optional.
//
// CORRECTED AGAIN IN R7: R5's version of this note went on to claim that a caller "cannot obtain a
// git call from either verb without naming the operator-authored config". `--config-path` alone
// never established "operator-authored" — an arbitrary shape-clean path was accepted, so the
// caller supplied BOTH sides of the equality and the sink stayed open (reproduced). What makes the
// config non-arbitrary is the pair of checks documented on `assertEnvDirTrusted`: `--config-path`
// must resolve to the very file `resolveConfigPath` derives from THIS PROCESS's own
// `$DRAWBAR_SHIP_CONFIG`/cwd, and that file must not be tracked by git. Note the operational
// consequence for the runbook: `DRAWBAR_SHIP_CONFIG`, when used at all, must be EXPORTED, because
// the anchor is read from the environment this process inherits.
export type SyncCliParse =
  | { ok: true; envDir: string; dir: string; message: string; configPath: string }
  | { ok: false; error: string };

export function parseSyncCliArgs(args: string[]): SyncCliParse {
  const parsed = parseFlags(args, ["--env-dir", "--dir", "--message", "--config-path"]);
  if (!parsed.ok) return parsed;
  const { flags } = parsed;
  for (const name of ["--env-dir", "--dir", "--message", "--config-path"]) {
    if (!(name in flags)) return { ok: false, error: `${name} is required` };
    if (flags[name] === true) return { ok: false, error: `${name} requires a value` };
    if (flags[name] === "") return { ok: false, error: `${name} value must not be empty` };
  }
  const envDir = flags["--env-dir"] as string;
  const dir = flags["--dir"] as string;
  const message = flags["--message"] as string;
  const configPath = flags["--config-path"] as string;
  if (!isCleanAbsolutePath(envDir)) return { ok: false, error: "--env-dir must be a clean absolute path" };
  if (!isCleanAbsolutePath(dir)) return { ok: false, error: "--dir must be a clean absolute path" };
  if (!isNonEmptyTrimmed(message)) return { ok: false, error: "--message must be a non-empty string" };
  if (!isCleanAbsolutePath(configPath)) return { ok: false, error: "--config-path must be a clean absolute path" };
  return { ok: true, envDir, dir, message, configPath };
}

export type PreflightCliParse =
  | { ok: true; envDir: string; dir: string; configPath: string }
  | { ok: false; error: string };

export function parsePreflightCliArgs(args: string[]): PreflightCliParse {
  const parsed = parseFlags(args, ["--env-dir", "--dir", "--config-path"]);
  if (!parsed.ok) return parsed;
  const { flags } = parsed;
  for (const name of ["--env-dir", "--dir", "--config-path"]) {
    if (!(name in flags)) return { ok: false, error: `${name} is required` };
    if (flags[name] === true) return { ok: false, error: `${name} requires a value` };
    if (flags[name] === "") return { ok: false, error: `${name} value must not be empty` };
  }
  const envDir = flags["--env-dir"] as string;
  const dir = flags["--dir"] as string;
  const configPath = flags["--config-path"] as string;
  if (!isCleanAbsolutePath(envDir)) return { ok: false, error: "--env-dir must be a clean absolute path" };
  if (!isCleanAbsolutePath(dir)) return { ok: false, error: "--dir must be a clean absolute path" };
  if (!isCleanAbsolutePath(configPath)) return { ok: false, error: "--config-path must be a clean absolute path" };
  return { ok: true, envDir, dir, configPath };
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
  // R7: the two ambient values the config-path ANCHOR is derived from. Seams for the same reason
  // ship-config.ts's own MainDeps carries them — so a test can drive the anchor without mutating
  // `process`.
  env?: Record<string, string | undefined>;
  cwd?: string;
  realpath?: (p: string) => string;
  readStdin?: () => Promise<string>;
  git?: Runner;
  sleep?: (ms: number) => Promise<void>;
  writeStdout?: (s: string) => void;
  writeStderr?: (s: string) => void;
  existsSync?: (p: string) => boolean;
  writeFileSync?: (p: string, content: string) => void;
  mkdirSync?: (p: string, opts: { recursive: boolean }) => void;
  // R5/F2: the config-file read seam, so a test can drive the trust root without a real file.
  readConfig?: (p: string) => string;
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
  const readConfig = deps.readConfig ?? ((p: string) => readFileSync(p, "utf8"));
  const realpath = deps.realpath ?? ((p: string) => realpathSync(p));
  // R7: the anchor. Same primitive `ship-config.ts validate` uses for its own default, never a
  // second copy of the `$DRAWBAR_SHIP_CONFIG` / `<cwd>/.drawbar/ship.config.json` rule.
  const expectedConfigPath = resolveConfigPath(deps.env ?? process.env, deps.cwd ?? process.cwd());

  // R7: every refusal AND every verdict written to stdout goes through `sanitizeForOutput` first.
  // The refusal `detail` was already sanitized on stderr, but the stdout copy was a bare
  // `JSON.stringify(result)` — and `JSON.stringify` escapes only C0/DEL/quote/backslash, so the
  // entire invisible/bidi class the sanitizer exists for (U+202A-202E, U+200B-200F, U+2066-2069,
  // U+FEFF) passed through to stdout INTACT. Reproduced: a `--env-dir` carrying U+202E landed raw
  // (`e2 80 ae`) in stdout's `detail` while stderr correctly showed U+FFFD. §6 echoes that stdout
  // back into agent-read output, which is exactly the reordering/hiding vector this closes.
  // Sanitizing the serialized JSON (rather than each field) is safe: U+FFFD is a legal JSON string
  // character, so the document stays parseable — the runbook's `jq` still reads `.ok`.
  const emit = (value: unknown) => { writeStdout(sanitizeForOutput(JSON.stringify(value)) + "\n"); };

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
      result = await syncKnowledge({
        envDir: parsed.envDir,
        kbDir: parsed.dir,
        message: parsed.message,
        configPath: parsed.configPath,
        expectedConfigPath,
        readConfig,
        realpath,
        lessons,
        git,
        sleep,
      });
    } catch (err) {
      // A malformed lessons[] entry is rejected by store.ts's appendEntry with a thrown
      // Error — caught here as a named refusal rather than an uncaught crash.
      writeStderr(`refused: invalid lessons entry: ${err instanceof Error ? err.message : String(err)}\n`);
      return 1;
    }

    if (!result.ok) {
      writeStderr(`refused: ${result.reason}${result.detail !== undefined ? `: ${JSON.stringify(sanitizeForOutput(result.detail))}` : ""}\n`);
      emit(result);
      return 1;
    }
    if (result.ignored.length > 0) {
      // R7: loud, and does NOT fail the sync — the same treatment `duplicateKeys` gets below, for
      // the same reason. An ignored `knowledge.jsonl` in particular means this "successful" sync
      // committed no knowledge whatsoever, so the one thing this must never be is silent.
      writeStderr(
        `warning: ignored=${sanitizeForOutput(result.ignored.join(","))} — a .gitignore pattern covers ${result.ignored.length === 1 ? "this knowledge path" : "these knowledge paths"}, ` +
          "so it was NOT staged and NOT committed by this sync. An ignored knowledge.jsonl means no knowledge is being " +
          "committed at all: un-ignore it and re-run `kb-sync.ts preflight`, which refuses this outright.\n",
      );
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
    emit(result);
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
      configPath: parsed.configPath,
      expectedConfigPath,
      readConfig,
      realpath,
      git,
      existsSync: existsSyncDep,
      writeFileSync: writeFileSyncDep,
      mkdirSync: mkdirSyncDep,
    });
    if (!result.ok) {
      writeStderr(`refused: ${result.reason}${result.detail !== undefined ? `: ${JSON.stringify(sanitizeForOutput(result.detail))}` : ""}\n`);
      emit(result);
      return 1;
    }
    emit(result);
    return 0;
  }

  writeStderr(
    "usage: kb-sync.ts sync --env-dir <abs> --dir <abs> --message <msg> --config-path <abs>\n" +
      "       kb-sync.ts preflight --env-dir <abs> --dir <abs> --config-path <abs>\n",
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
