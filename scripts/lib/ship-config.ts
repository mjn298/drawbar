// Portability config for `/drawbar-ship`. Locked 17: `$ENV_DIR` (and every other
// environment-specific value the runbooks used to hardcode or probe via `$PWD`) comes from
// a validated config file, never from a parent-directory probe. This module owns two
// distinct jobs, kept as two separate exported functions per the house style in
// scripts/lib/coderabbit.ts:
//
//   - `parseShipConfig` — STRUCTURAL validation only (shape, types, exact key set). Never
//     touches the filesystem or any external tool, and never silently defaults a value.
//   - `validateShipConfig` — the pure verdict function implementing Locked 18's five
//     preflight assertions, with `git`/`gh` as injected `Runner`s (same signature
//     coderabbit.ts uses) so the whole module is testable with `gh` and `git` absent from
//     PATH. `linear` is injected DATA, not a runner: the Linear MCP is only reachable from
//     the agent session, not from bash/TS, so the runbook fetches the facts and hands them
//     in as JSON on stdin (see the CLI entry point below).
//
// `commands/drawbar-ship.md`'s Preflight section pipes the Linear facts into
// `bun run .../ship-config.ts validate --config <path>` and reads `resolved_config` off
// stdout with `jq` — see that file for the exact invocation and the expected-output shape.

import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { isValidRepo } from "./coderabbit";

export interface ShipConfig {
  envDir: string;
  projectDir: string;
  repo: string;
  team: string;
  baseBranch: string;
  mergedStatus: string;
  requiredChecks: string[];
}

// Exactly these seven keys — no more, no fewer. Declared once so the missing/unknown-key
// checks in `parseShipConfig` and the CLI's JSON.stringify of `ResolvedConfig` cannot drift
// from each other.
const REQUIRED_KEYS = ["envDir", "projectDir", "repo", "team", "baseBranch", "mergedStatus", "requiredChecks"] as const;
type RequiredKey = (typeof REQUIRED_KEYS)[number];
const STRING_KEYS: readonly RequiredKey[] = ["envDir", "projectDir", "repo", "team", "baseBranch", "mergedStatus"];

export type ParseReason =
  | "invalid_json"
  | "not_object"
  | "missing_key"
  | "unknown_key"
  | "wrong_type"
  | "empty_string"
  | "invalid_required_checks"
  | "invalid_required_checks_entry";

export type ParseResult = { ok: true; config: ShipConfig } | { ok: false; reason: ParseReason; detail: string };

// Structural validation ONLY — never resolves a git remote, never calls `gh`, never checks
// whether `envDir`/`projectDir` exist on disk. That is `validateShipConfig`'s job. Every
// rejection path returns its own named `reason` plus a human-readable `detail`; nothing here
// ever falls through to a default value for a missing/malformed field.
export function parseShipConfig(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "invalid_json", detail: "config is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, reason: "not_object", detail: "config root must be a JSON object" };
  }
  const obj = parsed as Record<string, unknown>;

  for (const key of REQUIRED_KEYS) {
    if (!(key in obj)) {
      return { ok: false, reason: "missing_key", detail: `missing required key: ${key}` };
    }
  }
  const known: readonly string[] = REQUIRED_KEYS;
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      return { ok: false, reason: "unknown_key", detail: `unknown key: ${key}` };
    }
  }
  for (const key of STRING_KEYS) {
    const value = obj[key];
    if (typeof value !== "string") {
      return { ok: false, reason: "wrong_type", detail: `${key} must be a string` };
    }
    if (value.length === 0) {
      return { ok: false, reason: "empty_string", detail: `${key} must not be an empty string` };
    }
  }
  const requiredChecks = obj.requiredChecks;
  if (!Array.isArray(requiredChecks) || requiredChecks.length === 0) {
    return { ok: false, reason: "invalid_required_checks", detail: "requiredChecks must be a non-empty array" };
  }
  for (const entry of requiredChecks) {
    if (typeof entry !== "string" || entry.length === 0) {
      return {
        ok: false,
        reason: "invalid_required_checks_entry",
        detail: "every requiredChecks entry must be a non-empty string",
      };
    }
  }

  return {
    ok: true,
    config: {
      envDir: obj.envDir as string,
      projectDir: obj.projectDir as string,
      repo: obj.repo as string,
      team: obj.team as string,
      baseBranch: obj.baseBranch as string,
      mergedStatus: obj.mergedStatus as string,
      requiredChecks: requiredChecks as string[],
    },
  };
}

// Linear facts, injected as DATA (not a runner) — see the module comment above.
export interface LinearFacts {
  teams: string[];
  statuses: { name: string; type: string }[];
}

// Same injected-runner shape as scripts/lib/coderabbit.ts's `Runner`.
export type Runner = (argv: string[]) => { code: number; stdout: string; stderr?: string };

export interface ValidateInput {
  config: ShipConfig;
  linear: LinearFacts;
  git: Runner;
  gh: Runner;
}

export type Reason =
  | "invalid_repo_shape"
  | "project_dir_path_invalid"
  | "env_dir_path_invalid"
  | "git_failed"
  | "project_dir_equals_env_dir"
  | "project_dir_same_remote_as_env_dir"
  | "repo_is_env_dir_remote"
  | "repo_mismatch"
  | "team_not_found"
  | "merged_status_not_found"
  | "merged_status_wrong_type"
  | "gh_failed"
  | "base_branch_not_default";

export type ValidateResult = { ok: true; resolved: ResolvedConfig } | { ok: false; reason: Reason; detail?: string };

// Strips the two accepted remote-URL prefixes and a trailing `.git`, exactly like the sed
// expression the old preflight block used — so a config authored against either form of the
// remote (`git@github.com:` SSH or `https://github.com/` HTTPS) compares equal.
function normalizeRemote(url: string): string {
  return url
    .trim()
    .replace(/^git@github\.com:/, "")
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "");
}

// A relative path, or any path carrying a literal `..` segment, is refused outright — never
// resolved against a runner. `path.isAbsolute` alone would accept `/a/../b`, which is
// absolute but still path-traversal-shaped, so the segment check is independent of it.
//
// Exported (fix pass, IMPORTANT 6) so run-state.ts's `parseRunState` can reuse this exact
// check on `resolved_config.envDir`/`projectDir` rather than a second, hand-copied
// implementation of the same shape check — this repo has a single-implementation-site
// regression test that scans for duplicated predicates.
export function isCleanAbsolutePath(p: string): boolean {
  if (!isAbsolute(p)) return false;
  const segments = p.split(/[\\/]+/).filter((s) => s.length > 0);
  return !segments.includes("..");
}

// The `resolved_config` payload S5's run-state persists. Carries the seven configured
// values plus the OBSERVED facts validation resolved along the way (the projectDir's and
// envDir's actual git remotes, and the repo's actual default branch), so a later step (S5,
// at merge time) can re-assert them without re-running discovery from scratch. Documented
// again, with the exact shape, in commands/drawbar-ship.md's Preflight section — keep both
// in sync if this shape ever changes.
export interface ResolvedConfig extends ShipConfig {
  observed: {
    projectDirRemote: string;
    envDirRemote: string;
    defaultBranch: string;
  };
}

export function resolvedConfig(
  config: ShipConfig,
  observed: { projectDirRemote: string; envDirRemote: string; defaultBranch: string },
): ResolvedConfig {
  return { ...config, observed };
}

// The pure verdict function implementing Locked 18's five preflight assertions. Order below
// is deliberate, not incidental: the endpoint-injection guard (repo shape) and the two path
// guards run BEFORE any runner is invoked at all (proven by a call-counter spy in tests).
// The env-dir/project-dir remote comparisons run before the repo-vs-projectDir comparison
// specifically so each of the three distinct refusal reasons around them
// (`project_dir_equals_env_dir`, `project_dir_same_remote_as_env_dir`,
// `repo_is_env_dir_remote`) stays independently REACHABLE: once `repo === projectDirRemote`
// has already been established, `projectDirRemote === envDirRemote` and `repo === envDirRemote`
// become the same fact, so whichever of those two checks ran second would be permanently
// dead code. Checking both env-dir comparisons before the repo/projectDir comparison avoids
// that trap.
export function validateShipConfig({ config, linear, git, gh }: ValidateInput): ValidateResult {
  // Endpoint-injection guard (drawbar MUST-CHECK endpoint-injection-not-just-command-injection):
  // `repo` ends up in a `gh repo view <repo>` argument below. Refuse a malformed shape before
  // any injected runner is ever called — a segment-level check (not a whole-string character
  // class) so a two-segment repo whose segment IS `..` is still caught. Reuses
  // scripts/lib/coderabbit.ts's `isValidRepo` rather than a second implementation of the
  // same shape check.
  if (!isValidRepo(config.repo)) {
    return { ok: false, reason: "invalid_repo_shape", detail: config.repo };
  }
  if (!isCleanAbsolutePath(config.projectDir)) {
    return { ok: false, reason: "project_dir_path_invalid", detail: config.projectDir };
  }
  if (!isCleanAbsolutePath(config.envDir)) {
    return { ok: false, reason: "env_dir_path_invalid", detail: config.envDir };
  }

  const projectRemoteRes = git(["-C", config.projectDir, "remote", "get-url", "origin"]);
  if (projectRemoteRes.code !== 0) {
    return {
      ok: false,
      reason: "git_failed",
      detail: projectRemoteRes.stderr || `git remote lookup failed for projectDir ${config.projectDir}`,
    };
  }
  const projectDirRemote = normalizeRemote(projectRemoteRes.stdout);

  const envRemoteRes = git(["-C", config.envDir, "remote", "get-url", "origin"]);
  if (envRemoteRes.code !== 0) {
    return {
      ok: false,
      reason: "git_failed",
      detail: envRemoteRes.stderr || `git remote lookup failed for envDir ${config.envDir}`,
    };
  }
  const envDirRemote = normalizeRemote(envRemoteRes.stdout);

  // Assertion 2, path-equality half: normalized absolute paths. `resolve()` alone already
  // strips any trailing slash (verified: `resolve("/tmp/a/b/") === resolve("/tmp/a/b")`), so
  // there is no separate trailing-slash-stripping step here — one used to exist as dead code
  // (Minor fix pass 2: `stripTrailingSlash` was applied AFTER `resolve()` had already
  // normalized its input, so it could never observe a trailing slash; deleted rather than
  // pinned with a fixture that would only prove `resolve()`'s own behavior).
  const normProjectDir = resolve(config.projectDir);
  const normEnvDir = resolve(config.envDir);
  if (normProjectDir === normEnvDir) {
    return { ok: false, reason: "project_dir_equals_env_dir", detail: normProjectDir };
  }

  // Assertion 2, same-remote half: independent of the path check above — two differently
  // named worktrees of the same repo would pass the path check but must still refuse here.
  if (projectDirRemote === envDirRemote) {
    return { ok: false, reason: "project_dir_same_remote_as_env_dir", detail: envDirRemote };
  }

  // Assertion 2's other clause: `repo` must not equal the knowledge repo's remote either —
  // pointing `repo` at the knowledge repo directly (rather than merely aliasing projectDir
  // to it) is the same misconfiguration by a different route.
  if (config.repo === envDirRemote) {
    return { ok: false, reason: "repo_is_env_dir_remote", detail: envDirRemote };
  }

  // Assertion 1: `repo` must match the projectDir's actual remote.
  if (config.repo !== projectDirRemote) {
    return {
      ok: false,
      reason: "repo_mismatch",
      detail: `configured repo ${config.repo} does not match projectDir's remote ${projectDirRemote}`,
    };
  }

  // Assertion 3: `team` resolves.
  if (!linear.teams.includes(config.team)) {
    return { ok: false, reason: "team_not_found", detail: config.team };
  }

  // Assertion 4: `mergedStatus` exists and is type `started`. Two distinct reasons —
  // "does not exist at all" is a different operator mistake from "exists but is the wrong
  // kind of status" (e.g. pointed at a `completed`-type status by accident).
  const statusEntry = linear.statuses.find((s) => s.name === config.mergedStatus);
  if (!statusEntry) {
    return { ok: false, reason: "merged_status_not_found", detail: config.mergedStatus };
  }
  if (statusEntry.type !== "started") {
    return {
      ok: false,
      reason: "merged_status_wrong_type",
      detail: `${config.mergedStatus} has type ${statusEntry.type}, not started`,
    };
  }

  // Assertion 5: `baseBranch` must equal the repo's actual default branch — CodeRabbit only
  // reviews default-branch PRs, so any other configured value silently parks every story.
  const defaultBranchRes = gh(["repo", "view", config.repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
  if (defaultBranchRes.code !== 0) {
    return { ok: false, reason: "gh_failed", detail: defaultBranchRes.stderr || "gh repo view failed" };
  }
  const defaultBranch = defaultBranchRes.stdout.trim();
  if (config.baseBranch !== defaultBranch) {
    return {
      ok: false,
      reason: "base_branch_not_default",
      detail: `configured baseBranch ${config.baseBranch} does not match repo default ${defaultBranch}`,
    };
  }

  return { ok: true, resolved: resolvedConfig(config, { projectDirRemote, envDirRemote, defaultBranch }) };
}

// Pure. `env.DRAWBAR_SHIP_CONFIG` when set and non-empty; otherwise `<cwd>/.drawbar/ship.config.json`.
// Locked 17: there is NO parent-directory probing here or anywhere else in this module — an
// empty-string env var falls back to the cwd-relative default rather than producing a bare
// (and therefore wrong) relative path.
//
// Cross-reference (Minor, fix pass 2): `commands/drawbar-ship.md`'s Preflight section
// duplicates this exact default via `CONFIG="${DRAWBAR_SHIP_CONFIG:-$PWD/.drawbar/ship.config.json}"`
// (bash has no way to call into this TS module for the fallback). Keep both in sync if the
// default location or the env-var name ever changes.
export function resolveConfigPath(env: Record<string, string | undefined>, cwd: string): string {
  const fromEnv = env.DRAWBAR_SHIP_CONFIG;
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv;
  return join(cwd, ".drawbar/ship.config.json");
}

// --- CLI entry point --------------------------------------------------------------------
//
// `bun run ship-config.ts validate [--config <path>]`, reading the Linear facts JSON
// (`{teams:[...], statuses:[{name,type},...]}`) on stdin — same convention as
// `drawbar-kb add`. See commands/drawbar-ship.md's Preflight section for the exact
// invocation and the expected stdout shape.

export type CliParse = { ok: true; config: string | undefined } | { ok: false; error: string };

// Flag type enforcement in BOTH directions (drawbar MUST-CHECKs
// cli-flag-boolean-true-fails-open and compact-dry-run-string-value-fails-open): `--config`
// with no consumable value binds boolean `true`, not a string — refused explicitly, never
// silently treated as "absent" and defaulted. An empty-string value is refused too. A
// repeated or unknown flag refuses outright; nothing here ever falls through to a default.
export function parseCliArgs(args: string[]): CliParse {
  let seenConfig = false;
  let config: string | true | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--config") {
      if (seenConfig) return { ok: false, error: "--config specified more than once" };
      seenConfig = true;
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        config = next;
        i++;
      } else {
        config = true;
      }
    } else {
      return { ok: false, error: `unknown flag: ${a}` };
    }
  }
  if (config === true) return { ok: false, error: "--config requires a value" };
  if (config === "") return { ok: false, error: "--config value must not be empty" };
  return { ok: true, config };
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

function isLinearFacts(v: unknown): v is LinearFacts {
  if (typeof v !== "object" || v === null) return false;
  const obj = v as Record<string, unknown>;
  if (!Array.isArray(obj.teams) || !obj.teams.every((t) => typeof t === "string")) return false;
  if (!Array.isArray(obj.statuses)) return false;
  return obj.statuses.every(
    (s) => typeof s === "object" && s !== null && typeof (s as any).name === "string" && typeof (s as any).type === "string",
  );
}

// Every real I/O boundary is injectable, defaulting to the real implementation — the same
// shape as `Runner` (`git`/`gh`) already established above, extended to cover argv/env/cwd,
// the config-file read, stdin, and the final stdout write. This is what lets a test drive
// main() all the way to a genuine success (or a genuine mid-flight throw) entirely in-process,
// without spawning a subprocess or mutating global `process.argv`/`PATH`. `writeStdout` in
// particular exists so a test can prove main()'s promise genuinely REJECTS when the final
// write fails (e.g. EPIPE from a consuming `jq` dying early) — which is exactly why the
// `.catch` at the bottom of this file is load-bearing, not decoration.
export interface MainDeps {
  argv?: string[];
  env?: Record<string, string | undefined>;
  cwd?: string;
  readConfig?: (path: string) => string;
  readStdin?: () => Promise<string>;
  git?: Runner;
  gh?: Runner;
  writeStdout?: (s: string) => void;
  writeStderr?: (s: string) => void;
}

export async function main(deps: MainDeps = {}): Promise<number> {
  const argv = deps.argv ?? process.argv.slice(2);
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const readConfig = deps.readConfig ?? ((p: string) => readFileSync(p, "utf8"));
  const readStdin = deps.readStdin ?? (() => new Response(Bun.stdin.stream()).text());
  const git = deps.git ?? makeRealRunner("git");
  const gh = deps.gh ?? makeRealRunner("gh");
  const writeStdout = deps.writeStdout ?? ((s: string) => { process.stdout.write(s); });
  const writeStderr = deps.writeStderr ?? ((s: string) => { process.stderr.write(s); });

  const [cmd, ...rest] = argv;
  if (cmd !== "validate") {
    writeStderr("usage: ship-config.ts validate [--config <path>]\n");
    return 1;
  }

  const parsedArgs = parseCliArgs(rest);
  if (!parsedArgs.ok) {
    writeStderr(`refused: ${parsedArgs.error}\n`);
    return 1;
  }
  const configPath = parsedArgs.config ?? resolveConfigPath(env, cwd);

  let configText: string;
  try {
    configText = readConfig(configPath);
  } catch {
    writeStderr(
      `refused: config file not found or unreadable: ${configPath} — copy .drawbar/ship.config.example.json and fill in real values\n`,
    );
    return 1;
  }

  const parsedConfig = parseShipConfig(configText);
  if (!parsedConfig.ok) {
    writeStderr(`refused: config ${parsedConfig.reason} (${parsedConfig.detail})\n`);
    return 1;
  }

  let stdinText: string;
  try {
    stdinText = await readStdin();
  } catch {
    writeStderr("refused: could not read Linear facts from stdin\n");
    return 1;
  }

  let linear: LinearFacts;
  try {
    const raw: unknown = JSON.parse(stdinText);
    if (!isLinearFacts(raw)) {
      writeStderr('refused: stdin is not valid Linear facts JSON ({"teams":[...],"statuses":[{"name":...,"type":...}]})\n');
      return 1;
    }
    linear = raw;
  } catch {
    writeStderr("refused: stdin is not valid JSON\n");
    return 1;
  }

  const result = validateShipConfig({
    config: parsedConfig.config,
    linear,
    git,
    gh,
  });
  if (!result.ok) {
    writeStderr(`refused: ${result.reason}${result.detail ? ` (${result.detail})` : ""}\n`);
    return 1;
  }
  writeStdout(JSON.stringify(result.resolved) + "\n");
  return 0;
}

if (import.meta.main) {
  // MUST-CHECK (Minor, fix pass 2): without `.catch`, an unexpected throw anywhere in
  // main() not already caught internally (e.g. EPIPE when a consuming `jq` dies early on the
  // final stdout write) becomes an UNHANDLED PROMISE REJECTION instead of a named refusal —
  // see the `MainDeps.writeStdout` seam above and its regression test for proof main()
  // genuinely rejects in that case.
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`refused: unexpected error: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
