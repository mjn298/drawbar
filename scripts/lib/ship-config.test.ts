import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  parseShipConfig,
  validateShipConfig,
  resolveConfigPath,
  resolvedConfig,
  parseCliArgs,
  type ShipConfig,
  type LinearFacts,
  type Runner,
} from "./ship-config";

// A structurally-valid config used as the shared happy-path fixture. Repo/team/dir names
// are placeholder-shaped (no real org, no digit-suffixed issue-id shape) so this file — which
// is itself leak-scanned (see scripts/plugin.test.ts) — never trips the issue-id rule.
const VALID_CONFIG: ShipConfig = {
  envDir: "/tmp/fixture-env-dir",
  projectDir: "/tmp/fixture-project-dir",
  repo: "acme/widgets",
  team: "PLAT",
  baseBranch: "main",
  mergedStatus: "Pre-QA",
  requiredChecks: ["build"],
};

const VALID_LINEAR: LinearFacts = {
  teams: ["PLAT", "CORE"],
  statuses: [
    { name: "Pre-QA", type: "started" },
    { name: "Done", type: "completed" },
  ],
};

// A spy `git` runner keyed by the `-C <dir>` argument (argv[1]), so each test controls
// exactly which directory resolves to which remote — and a call counter to prove the
// endpoint-injection guard refuses BEFORE any runner is ever invoked.
function makeGitRunner(remoteByDir: Record<string, string>, failFor?: string): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = (argv) => {
    calls.push(argv);
    const dir = argv[1]!;
    if (failFor !== undefined && dir === failFor) {
      return { code: 1, stdout: "", stderr: `git: fatal: not a git repository (${dir})` };
    }
    const remote = remoteByDir[dir];
    if (remote === undefined) return { code: 1, stdout: "", stderr: `no remote configured for ${dir}` };
    return { code: 0, stdout: remote + "\n", stderr: "" };
  };
  return { run, calls };
}

function makeGhRunner(defaultBranch: string | null): { run: Runner; calls: string[][] } {
  const calls: string[][] = [];
  const run: Runner = (argv) => {
    calls.push(argv);
    if (defaultBranch === null) return { code: 1, stdout: "", stderr: "gh: not authenticated" };
    return { code: 0, stdout: defaultBranch + "\n", stderr: "" };
  };
  return { run, calls };
}

// The full set of runners that gets a config all the way to `ok: true` — every other test
// below deliberately diverges from exactly one of these fixtures to isolate one assertion.
function happyRunners() {
  const git = makeGitRunner({
    "/tmp/fixture-project-dir": "https://github.com/acme/widgets.git",
    "/tmp/fixture-env-dir": "https://github.com/acme/knowledge-base.git",
  });
  const gh = makeGhRunner("main");
  return { git, gh };
}

describe("parseShipConfig — structural validation only", () => {
  test("a valid config parses with all seven fields present", () => {
    const result = parseShipConfig(JSON.stringify(VALID_CONFIG));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.config).sort()).toEqual(
      ["baseBranch", "envDir", "mergedStatus", "projectDir", "repo", "requiredChecks", "team"].sort(),
    );
    expect(result.config).toEqual(VALID_CONFIG);
  });

  test("rejects malformed JSON", () => {
    const result = parseShipConfig("{ not json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_json");
  });

  test("rejects a non-object root (array)", () => {
    const result = parseShipConfig(JSON.stringify([1, 2, 3]));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_object");
  });

  test("rejects a non-object root (string)", () => {
    const result = parseShipConfig(JSON.stringify("hello"));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("not_object");
  });

  test("rejects a missing required key", () => {
    const { team, ...rest } = VALID_CONFIG;
    const result = parseShipConfig(JSON.stringify(rest));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing_key");
    expect(result.detail).toContain("team");
  });

  test("rejects an unknown extra key", () => {
    const result = parseShipConfig(JSON.stringify({ ...VALID_CONFIG, extra: "surprise" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown_key");
    expect(result.detail).toContain("extra");
  });

  test("rejects a misspelled required key (surfaces as the correctly-named key missing)", () => {
    const { baseBranch, ...rest } = VALID_CONFIG;
    const result = parseShipConfig(JSON.stringify({ ...rest, baseBrnch: baseBranch }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing_key");
    expect(result.detail).toContain("baseBranch");
  });

  test("rejects a wrong-typed value", () => {
    const result = parseShipConfig(JSON.stringify({ ...VALID_CONFIG, repo: 42 }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("wrong_type");
    expect(result.detail).toContain("repo");
  });

  test("rejects an empty string value", () => {
    const result = parseShipConfig(JSON.stringify({ ...VALID_CONFIG, team: "" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("empty_string");
    expect(result.detail).toContain("team");
  });

  test("rejects a non-array requiredChecks", () => {
    const result = parseShipConfig(JSON.stringify({ ...VALID_CONFIG, requiredChecks: "build" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_required_checks");
  });

  test("rejects an empty requiredChecks array", () => {
    const result = parseShipConfig(JSON.stringify({ ...VALID_CONFIG, requiredChecks: [] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_required_checks");
  });

  test("rejects a requiredChecks entry that is not a non-empty string", () => {
    const result = parseShipConfig(JSON.stringify({ ...VALID_CONFIG, requiredChecks: ["build", ""] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_required_checks_entry");
  });

  test("rejects a requiredChecks entry of the wrong type", () => {
    const result = parseShipConfig(JSON.stringify({ ...VALID_CONFIG, requiredChecks: [1] }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_required_checks_entry");
  });

  test("never silently defaults: two structurally distinct invalid configs get distinct reasons", () => {
    const missing = parseShipConfig(JSON.stringify((({ repo, ...r }) => r)(VALID_CONFIG)));
    const badType = parseShipConfig(JSON.stringify({ ...VALID_CONFIG, envDir: 1 }));
    expect(missing.ok).toBe(false);
    expect(badType.ok).toBe(false);
    if (missing.ok || badType.ok) return;
    expect(missing.reason).not.toBe(badType.reason);
  });
});

describe("validateShipConfig — the five Locked-18 assertions", () => {
  test("a fully consistent config validates ok, and resolved carries the observed facts", () => {
    const { git, gh } = happyRunners();
    const result = validateShipConfig({ config: VALID_CONFIG, linear: VALID_LINEAR, git: git.run, gh: gh.run });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.resolved.repo).toBe("acme/widgets");
    expect(result.resolved.observed.projectDirRemote).toBe("acme/widgets");
    expect(result.resolved.observed.envDirRemote).toBe("acme/knowledge-base");
    expect(result.resolved.observed.defaultBranch).toBe("main");
  });

  test("refuses when repo disagrees with the projectDir remote — reason repo_mismatch", () => {
    const git = makeGitRunner({
      "/tmp/fixture-project-dir": "https://github.com/other-org/other-repo.git",
      "/tmp/fixture-env-dir": "https://github.com/acme/knowledge-base.git",
    });
    const gh = makeGhRunner("main");
    const result = validateShipConfig({ config: VALID_CONFIG, linear: VALID_LINEAR, git: git.run, gh: gh.run });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("repo_mismatch");
    expect(gh.calls.length).toBe(0); // never gets far enough to call gh
  });

  test("refuses when projectDir equals envDir (path-equality path, independent of remotes)", () => {
    const config: ShipConfig = { ...VALID_CONFIG, projectDir: "/tmp/same-dir", envDir: "/tmp/same-dir" };
    const git = makeGitRunner({ "/tmp/same-dir": "https://github.com/acme/widgets.git" });
    const gh = makeGhRunner("main");
    const result = validateShipConfig({ config, linear: VALID_LINEAR, git: git.run, gh: gh.run });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("project_dir_equals_env_dir");
  });

  test("refuses when projectDir and envDir differ but share the same remote (same-remote path, independent of path equality)", () => {
    const config: ShipConfig = { ...VALID_CONFIG, projectDir: "/tmp/dir-a", envDir: "/tmp/dir-b", repo: "acme/unrelated" };
    const git = makeGitRunner({
      "/tmp/dir-a": "https://github.com/acme/widgets.git",
      "/tmp/dir-b": "https://github.com/acme/widgets.git",
    });
    const gh = makeGhRunner("main");
    const result = validateShipConfig({ config, linear: VALID_LINEAR, git: git.run, gh: gh.run });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("project_dir_same_remote_as_env_dir");
  });

  test("refuses when repo equals the knowledge repo's (envDir's) remote — distinct from repo_mismatch and the same-remote case", () => {
    const config: ShipConfig = { ...VALID_CONFIG, projectDir: "/tmp/dir-a", envDir: "/tmp/dir-b", repo: "acme/knowledge-base" };
    const git = makeGitRunner({
      "/tmp/dir-a": "https://github.com/other-org/other-repo.git",
      "/tmp/dir-b": "https://github.com/acme/knowledge-base.git",
    });
    const gh = makeGhRunner("main");
    const result = validateShipConfig({ config, linear: VALID_LINEAR, git: git.run, gh: gh.run });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("repo_is_env_dir_remote");
  });

  test("refuses when the team does not resolve against linear.teams", () => {
    const { git, gh } = happyRunners();
    const linear: LinearFacts = { ...VALID_LINEAR, teams: ["CORE"] };
    const result = validateShipConfig({ config: VALID_CONFIG, linear, git: git.run, gh: gh.run });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("team_not_found");
  });

  test("refuses when mergedStatus is present but not type started (a completed-type status)", () => {
    const { git, gh } = happyRunners();
    const linear: LinearFacts = {
      teams: ["PLAT"],
      statuses: [{ name: "Pre-QA", type: "completed" }],
    };
    // Pre-seed sanity: the fixture actually carries the status under test before trusting
    // the refusal — a vacuous pass could otherwise come from the status never landing.
    expect(linear.statuses.find((s) => s.name === "Pre-QA")?.type).toBe("completed");
    const result = validateShipConfig({ config: VALID_CONFIG, linear, git: git.run, gh: gh.run });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("merged_status_wrong_type");
  });

  test("refuses when mergedStatus is absent from the status list entirely (distinguishable from wrong-type)", () => {
    const { git, gh } = happyRunners();
    const linear: LinearFacts = { teams: ["PLAT"], statuses: [{ name: "Done", type: "completed" }] };
    expect(linear.statuses.some((s) => s.name === "Pre-QA")).toBe(false);
    const result = validateShipConfig({ config: VALID_CONFIG, linear, git: git.run, gh: gh.run });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("merged_status_not_found");
    expect(result.reason).not.toBe("merged_status_wrong_type");
  });

  test("refuses when baseBranch is not the repo's actual default branch", () => {
    const git = makeGitRunner({
      "/tmp/fixture-project-dir": "https://github.com/acme/widgets.git",
      "/tmp/fixture-env-dir": "https://github.com/acme/knowledge-base.git",
    });
    const gh = makeGhRunner("develop");
    const result = validateShipConfig({ config: VALID_CONFIG, linear: VALID_LINEAR, git: git.run, gh: gh.run });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("base_branch_not_default");
  });

  test("a repo carrying `..` is refused before any injected runner is called", () => {
    const git = makeGitRunner({});
    const gh = makeGhRunner("main");
    const config: ShipConfig = { ...VALID_CONFIG, repo: "acme/.." };
    const result = validateShipConfig({ config, linear: VALID_LINEAR, git: git.run, gh: gh.run });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_repo_shape");
    expect(git.calls.length).toBe(0);
    expect(gh.calls.length).toBe(0);
  });

  test("a repo carrying an extra path segment is refused before any injected runner is called", () => {
    const git = makeGitRunner({});
    const gh = makeGhRunner("main");
    const config: ShipConfig = { ...VALID_CONFIG, repo: "acme/widgets/extra" };
    const result = validateShipConfig({ config, linear: VALID_LINEAR, git: git.run, gh: gh.run });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_repo_shape");
    expect(git.calls.length).toBe(0);
    expect(gh.calls.length).toBe(0);
  });

  test("a relative projectDir path is refused outright, before any injected runner is called", () => {
    const git = makeGitRunner({});
    const gh = makeGhRunner("main");
    const config: ShipConfig = { ...VALID_CONFIG, projectDir: "relative/path" };
    const result = validateShipConfig({ config, linear: VALID_LINEAR, git: git.run, gh: gh.run });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(git.calls.length).toBe(0);
    expect(gh.calls.length).toBe(0);
  });

  test("an injected git failure refuses with git_failed, never falls through to success", () => {
    const git = makeGitRunner(
      { "/tmp/fixture-env-dir": "https://github.com/acme/knowledge-base.git" },
      "/tmp/fixture-project-dir",
    );
    const gh = makeGhRunner("main");
    const result = validateShipConfig({ config: VALID_CONFIG, linear: VALID_LINEAR, git: git.run, gh: gh.run });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("git_failed");
  });

  test("an injected gh failure refuses with gh_failed, never falls through to success", () => {
    const { git } = happyRunners();
    const gh = makeGhRunner(null);
    const result = validateShipConfig({ config: VALID_CONFIG, linear: VALID_LINEAR, git: git.run, gh: gh.run });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("gh_failed");
  });
});

describe("resolveConfigPath — pure, no parent-directory probing", () => {
  test("uses DRAWBAR_SHIP_CONFIG when set and non-empty", () => {
    const result = resolveConfigPath({ DRAWBAR_SHIP_CONFIG: "/tmp/custom/ship.config.json" }, "/tmp/cwd");
    expect(result).toBe("/tmp/custom/ship.config.json");
  });

  test("falls back to <cwd>/.drawbar/ship.config.json when unset", () => {
    const result = resolveConfigPath({}, "/tmp/cwd");
    expect(result).toBe(join("/tmp/cwd", ".drawbar/ship.config.json"));
  });

  test("falls back when DRAWBAR_SHIP_CONFIG is set but empty, not a bare relative path", () => {
    const result = resolveConfigPath({ DRAWBAR_SHIP_CONFIG: "" }, "/tmp/cwd");
    expect(result).toBe(join("/tmp/cwd", ".drawbar/ship.config.json"));
    expect(result.startsWith("/tmp/cwd")).toBe(true);
  });
});

describe("resolvedConfig — the resolved_config payload shape", () => {
  test("carries the seven configured values plus the observed remotes and default branch", () => {
    const observed = { projectDirRemote: "acme/widgets", envDirRemote: "acme/knowledge-base", defaultBranch: "main" };
    const result = resolvedConfig(VALID_CONFIG, observed);
    expect(result).toEqual({ ...VALID_CONFIG, observed });
  });
});

describe("parseCliArgs — flag type enforcement in both directions", () => {
  test("parses a well-formed --config value", () => {
    const result = parseCliArgs(["--config", "/tmp/ship.config.json"]);
    expect(result).toEqual({ ok: true, config: "/tmp/ship.config.json" });
  });

  test("no --config at all is fine (caller falls back to resolveConfigPath)", () => {
    const result = parseCliArgs([]);
    expect(result).toEqual({ ok: true, config: undefined });
  });

  test("--config with no consumable value (boolean true) refuses", () => {
    const result = parseCliArgs(["--config"]);
    expect(result.ok).toBe(false);
  });

  test("--config with an empty string value refuses", () => {
    const result = parseCliArgs(["--config", ""]);
    expect(result.ok).toBe(false);
  });

  test("an unknown flag refuses", () => {
    const result = parseCliArgs(["--bogus", "x"]);
    expect(result.ok).toBe(false);
  });

  test("a repeated --config flag refuses", () => {
    const result = parseCliArgs(["--config", "a", "--config", "b"]);
    expect(result.ok).toBe(false);
  });
});

// CLI end-to-end: every misuse case exits non-zero with EMPTY stdout — a caller piping
// stdout into `jq` must never see a partial/synthesized object. None of these paths reach
// validateShipConfig, so they hold even with `git`/`gh` absent from PATH (see the PATH
// below, trimmed to bun's own directory only — the same technique coderabbit.test.ts uses).
describe("CLI end-to-end: every misuse case exits non-zero with no stdout", () => {
  const bunDir = dirname(process.execPath);
  const scriptPath = join(import.meta.dir, "ship-config.ts");

  function runCli(
    args: string[],
    opts: { stdin?: string; env?: Record<string, string> } = {},
  ): Promise<{ code: number; out: string; err: string }> {
    const proc = Bun.spawn(["bun", "run", scriptPath, "validate", ...args], {
      env: { PATH: bunDir, ...opts.env },
      stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : undefined,
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

  test("--config with no value (boolean true) — non-zero, empty stdout", async () => {
    const { code, out, err } = await runCli(["--config"]);
    expect(code).not.toBe(0);
    expect(out).toBe("");
    expect(err.length).toBeGreaterThan(0);
  });

  test("--config with an empty string — non-zero, empty stdout", async () => {
    const { code, out } = await runCli(["--config", ""]);
    expect(code).not.toBe(0);
    expect(out).toBe("");
  });

  test("an unknown flag — non-zero, empty stdout", async () => {
    const { code, out } = await runCli(["--bogus", "x"]);
    expect(code).not.toBe(0);
    expect(out).toBe("");
  });

  test("a repeated --config flag — non-zero, empty stdout", async () => {
    const { code, out } = await runCli(["--config", "/tmp/a", "--config", "/tmp/b"]);
    expect(code).not.toBe(0);
    expect(out).toBe("");
  });

  test("a missing config file — non-zero, empty stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-config-cli-"));
    const missing = join(dir, "does-not-exist.json");
    expect(existsSync(missing)).toBe(false);
    const { code, out, err } = await runCli(["--config", missing]);
    expect(code).not.toBe(0);
    expect(out).toBe("");
    expect(err.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("unparseable stdin (with a structurally valid config file) — non-zero, empty stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-config-cli-"));
    const configPath = join(dir, "ship.config.json");
    writeFileSync(configPath, JSON.stringify(VALID_CONFIG));
    const { code, out, err } = await runCli(["--config", configPath], { stdin: "{ not json" });
    expect(code).not.toBe(0);
    expect(out).toBe("");
    expect(err.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an unparseable config file (bad JSON on disk) — non-zero, empty stdout", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ship-config-cli-"));
    const configPath = join(dir, "ship.config.json");
    writeFileSync(configPath, "{ not json");
    const { code, out, err } = await runCli(["--config", configPath], { stdin: JSON.stringify(VALID_LINEAR) });
    expect(code).not.toBe(0);
    expect(out).toBe("");
    expect(err.length).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });
});
