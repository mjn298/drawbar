import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { CONTROL_CHAR_SHAPE, isCleanAbsolutePath, type Runner } from "./ship-config";

// --- what this module is for -----------------------------------------------------------------
//
// Every interactive drawbar command used to hardcode two things it had no business hardcoding:
// the Linear team (`PCO`, the authoring project's own team) and the knowledge-store path
// (`$PWD/.drawbar/memory`). The first made the plugin unusable in any other Linear workspace
// without editing the shipped prose. The second silently gave every git WORKTREE its own empty
// store: `$PWD` inside `repo/worktrees/feature-x` is not the repo root, so recall returned
// nothing and every lesson learned in a worktree was written somewhere no later session looked.
// `agents/drawbar-story-lead.md` §1 already carries a rule about exactly this failure ("Never
// `$PWD/.drawbar/memory`: you may be running from a directory that has no `.drawbar`") — this
// module is that rule made mechanical instead of advisory.
//
// Deliberately NOT used by `/drawbar-ship`. That command resolves its paths from its own
// validated `ship.config.json` (`envDir`/`projectDir`, both required absolute), and its tests
// pin closed the rule that it must never probe `$PWD` or a parent directory for a `.drawbar`
// directory. Ship keeps passing absolute `--dir` values, which still win over everything here.

// --- config file -----------------------------------------------------------------------------

// Every key is OPTIONAL, unlike `ship.config.json` where all six are required. A project that
// only wants the shared-worktree store writes `{"team":"PAS"}` and nothing else; a project that
// only wants an out-of-tree store writes `{"memoryDir":"..."}`. An absent file is not an error.
export interface ProjectConfig {
  team?: string;
  project?: string;
  memoryDir?: string;
}

const KNOWN_KEYS: readonly string[] = ["team", "project", "memoryDir"];

export type ConfigParseReason =
  | "invalid_json"
  | "not_object"
  | "unknown_key"
  | "wrong_type"
  | "empty_string"
  | "invalid_control_chars"
  | "relative_traversal";

export type ConfigParseResult =
  | { ok: true; config: ProjectConfig }
  | { ok: false; reason: ConfigParseReason; detail: string };

// A `memoryDir` may be absolute (`/srv/knowledge/hourly`), tilde-prefixed (`~/.drawbar/hourly`,
// expanded later against `HOME` — this function is pure and never reads the environment), or
// relative, in which case the RESOLVER anchors it to the repo root rather than to `$PWD`. What
// it may never contain is a `..` segment: the whole point of the key is that the path means the
// same thing from every worktree, and `../memory` means something different from each one.
function checkPathShape(key: string, value: string): { ok: true } | { ok: false; reason: ConfigParseReason; detail: string } {
  const segments = value.split(/[\\/]+/).filter((s) => s.length > 0);
  if (segments.includes("..")) {
    return {
      ok: false,
      reason: "relative_traversal",
      detail: `${key} must not contain a '..' segment — write an absolute path, a '~/'-prefixed path, or a path relative to the repo root`,
    };
  }
  return { ok: true };
}

// Structural validation ONLY. Never touches the filesystem, never reads the environment, never
// resolves a path. Mirrors `parseShipConfig`'s discipline: a named reason per rejection path and
// no silent fallback for a malformed value.
export function parseProjectConfig(text: string): ConfigParseResult {
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

  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.includes(key)) {
      return { ok: false, reason: "unknown_key", detail: `unknown key: ${key}` };
    }
  }

  const config: ProjectConfig = {};
  for (const key of KNOWN_KEYS) {
    if (!(key in obj)) continue;
    const value = obj[key];
    if (typeof value !== "string") {
      return { ok: false, reason: "wrong_type", detail: `${key} must be a string` };
    }
    // Same two-step order as `parseShipConfig`, and for the same reason: a value that is
    // non-empty but carries an embedded control character must report the control-char reason,
    // not the emptiness one.
    if (value.trim().length === 0) {
      return { ok: false, reason: "empty_string", detail: `${key} must not be an empty string` };
    }
    // `team` and `project` become Linear query arguments and agent-facing prose; `memoryDir`
    // becomes a filesystem path an agent echoes back. A control character is refused at the
    // source rather than trusted through to whichever consumer happens to print it.
    if (CONTROL_CHAR_SHAPE.test(value)) {
      return { ok: false, reason: "invalid_control_chars", detail: `${key} must not contain control characters` };
    }
    if (key === "memoryDir") {
      const shape = checkPathShape(key, value);
      if (!shape.ok) return shape;
    }
    config[key as keyof ProjectConfig] = value;
  }
  return { ok: true, config };
}

// --- repo root -------------------------------------------------------------------------------

export type RootSource = "git_common_dir" | "git_toplevel" | "cwd";
export interface RootResolution {
  root: string;
  source: RootSource;
}

// The one piece of real cleverness in this module, and the reason a worktree stops getting its
// own orphan store.
//
// `git rev-parse --show-toplevel` answers "the top of the working tree I am standing in", which
// for a linked worktree is the worktree itself — that is precisely the wrong answer here.
// `--git-common-dir` answers "the .git directory SHARED by the main worktree and every linked
// worktree", which is `<main worktree>/.git` no matter which worktree you ask from. Its parent
// is therefore the main worktree root, and every worktree of a repo agrees on it.
//
// Falls back to `--show-toplevel` when the common dir is not a `.git` directory (a bare repo, or
// a git too old for `--path-format=absolute`), and to the cwd when there is no repo at all — a
// drawbar store outside any git repo is unusual but not an error worth refusing.
export function resolveRoot(cwd: string, git: Runner): RootResolution {
  const common = git(["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.code === 0) {
    const raw = common.stdout.trim();
    if (raw.length > 0 && isAbsolute(raw) && basename(raw) === ".git") {
      return { root: dirname(raw), source: "git_common_dir" };
    }
  }
  const top = git(["-C", cwd, "rev-parse", "--show-toplevel"]);
  if (top.code === 0) {
    const raw = top.stdout.trim();
    if (raw.length > 0 && isAbsolute(raw)) return { root: raw, source: "git_toplevel" };
  }
  return { root: cwd, source: "cwd" };
}

// --- resolution ------------------------------------------------------------------------------

export type MemorySource = "flag" | "env" | "config" | "default";
export type ValueSource = "flag" | "env" | "config";

export interface DrawbarContext {
  root: string;
  rootSource: RootSource;
  configPath: string;
  configPresent: boolean;
  memoryDir: string;
  memoryDirSource: MemorySource;
  team: string | null;
  teamSource: ValueSource | null;
  project: string | null;
  projectSource: ValueSource | null;
}

export type ResolveReason =
  | ConfigParseReason
  | "unreadable_config"
  | "invalid_env_value"
  | "home_unset";

export type ResolveResult =
  | { ok: true; context: DrawbarContext }
  | { ok: false; reason: ResolveReason; detail: string };

export interface ResolveInput {
  cwd: string;
  env: Record<string, string | undefined>;
  git: Runner;
  fs: { exists: (p: string) => boolean; read: (p: string) => string };
  /** `--dir`, if the caller passed one. Wins over every other source. */
  dirFlag?: string | undefined;
  /** `--project`, if the caller passed one. Wins over every other source. */
  projectFlag?: string | undefined;
}

// `DRAWBAR_CONFIG` exists for the same reason `DRAWBAR_SHIP_CONFIG` does: an operator running
// drawbar against a checkout they do not want to add a config file to needs somewhere else to
// put it. It names a FILE, not a directory.
export function configPathFor(root: string, env: Record<string, string | undefined>): string {
  const override = env.DRAWBAR_CONFIG;
  if (typeof override === "string" && override.trim().length > 0) {
    return isAbsolute(override) ? override : resolve(root, override);
  }
  return join(root, ".drawbar", "config.json");
}

function checkEnvValue(name: string, value: string): { ok: true } | { ok: false; reason: ResolveReason; detail: string } {
  if (value.trim().length === 0) {
    return { ok: false, reason: "invalid_env_value", detail: `${name} must not be empty` };
  }
  if (CONTROL_CHAR_SHAPE.test(value)) {
    return { ok: false, reason: "invalid_env_value", detail: `${name} must not contain control characters` };
  }
  return { ok: true };
}

// A `~` or `~/...` prefix expands against `HOME`. A bare `~user` form is NOT expanded — shells
// resolve it from the password database and nothing here should pretend to.
function expandTilde(p: string, env: Record<string, string | undefined>): { ok: true; path: string } | { ok: false; reason: ResolveReason; detail: string } {
  if (p !== "~" && !p.startsWith("~/")) return { ok: true, path: p };
  const home = env.HOME;
  if (typeof home !== "string" || home.trim().length === 0 || !isAbsolute(home)) {
    return { ok: false, reason: "home_unset", detail: "a '~'-prefixed path needs HOME set to an absolute path" };
  }
  return { ok: true, path: p === "~" ? home : join(home, p.slice(2)) };
}

// Resolves everything a drawbar command needs to know about where it is: the repo root, the
// config file, the knowledge store, the Linear team, and the Linear project.
//
// Precedence is the same shape for all three resolved values — explicit flag, then environment,
// then config file, then (for the store alone) a computed default. Nothing here invents a team
// or a project: an unset one resolves to `null` and the CALLER decides whether that is fatal.
// That split matters — `/drawbar-learn` needs no team at all, while `/drawbar-design` cannot
// create an issue without one.
export function resolveContext(input: ResolveInput): ResolveResult {
  const { cwd, env, git, fs, dirFlag, projectFlag } = input;

  const { root, source: rootSource } = resolveRoot(cwd, git);
  const configPath = configPathFor(root, env);

  let config: ProjectConfig = {};
  let configPresent = false;
  if (fs.exists(configPath)) {
    configPresent = true;
    let text: string;
    try {
      text = fs.read(configPath);
    } catch {
      return { ok: false, reason: "unreadable_config", detail: `cannot read config at ${configPath}` };
    }
    const parsed = parseProjectConfig(text);
    // Fails closed. A malformed config is never treated as an absent one: silently falling back
    // to the default store after a typo in `memoryDir` is how a session writes its lessons into
    // a directory nobody reads again.
    if (!parsed.ok) return { ok: false, reason: parsed.reason, detail: `${configPath}: ${parsed.detail}` };
    config = parsed.config;
  }

  // --- knowledge store ---
  let memoryDir: string;
  let memoryDirSource: MemorySource;
  const envDir = env.DRAWBAR_MEMORY_DIR;
  if (typeof dirFlag === "string") {
    const check = checkEnvValue("--dir", dirFlag);
    if (!check.ok) return check;
    const expanded = expandTilde(dirFlag, env);
    if (!expanded.ok) return expanded;
    // A flag is typed where the operator is standing, so a relative one anchors to the cwd.
    memoryDir = resolve(cwd, expanded.path);
    memoryDirSource = "flag";
  } else if (typeof envDir === "string") {
    const check = checkEnvValue("DRAWBAR_MEMORY_DIR", envDir);
    if (!check.ok) return check;
    const expanded = expandTilde(envDir, env);
    if (!expanded.ok) return expanded;
    memoryDir = resolve(cwd, expanded.path);
    memoryDirSource = "env";
  } else if (typeof config.memoryDir === "string") {
    const expanded = expandTilde(config.memoryDir, env);
    if (!expanded.ok) return expanded;
    // A config value is written once and read from every worktree, so a relative one anchors to
    // the ROOT. Anchoring it to the cwd would reintroduce the exact per-worktree divergence this
    // module exists to remove.
    memoryDir = isAbsolute(expanded.path) ? expanded.path : resolve(root, expanded.path);
    memoryDirSource = "config";
  } else {
    memoryDir = join(root, ".drawbar", "memory");
    memoryDirSource = "default";
  }

  // Belt and braces: whatever route the value took, what leaves this function is absolute and
  // free of `..` segments, so a downstream `mkdirSync` can never be pointed above the path the
  // operator actually named.
  if (!isCleanAbsolutePath(memoryDir)) {
    return { ok: false, reason: "relative_traversal", detail: `resolved memory dir is not a clean absolute path: ${memoryDir}` };
  }

  // --- team ---
  let team: string | null = null;
  let teamSource: ValueSource | null = null;
  const envTeam = env.DRAWBAR_TEAM;
  if (typeof envTeam === "string") {
    const check = checkEnvValue("DRAWBAR_TEAM", envTeam);
    if (!check.ok) return check;
    team = envTeam;
    teamSource = "env";
  } else if (typeof config.team === "string") {
    team = config.team;
    teamSource = "config";
  }

  // --- project ---
  // The one value expected to change from one invocation to the next: a project is a unit of
  // work, not a property of the checkout. The config key is a DEFAULT for repos that happen to
  // have one, not the normal way to set it.
  let project: string | null = null;
  let projectSource: ValueSource | null = null;
  const envProject = env.DRAWBAR_PROJECT;
  if (typeof projectFlag === "string") {
    const check = checkEnvValue("--project", projectFlag);
    if (!check.ok) return check;
    project = projectFlag;
    projectSource = "flag";
  } else if (typeof envProject === "string") {
    const check = checkEnvValue("DRAWBAR_PROJECT", envProject);
    if (!check.ok) return check;
    project = envProject;
    projectSource = "env";
  } else if (typeof config.project === "string") {
    project = config.project;
    projectSource = "config";
  }

  return {
    ok: true,
    context: { root, rootSource, configPath, configPresent, memoryDir, memoryDirSource, team, teamSource, project, projectSource },
  };
}
