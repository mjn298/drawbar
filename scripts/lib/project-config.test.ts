import { test, expect, describe } from "bun:test";
import { join } from "node:path";
import {
  parseProjectConfig,
  resolveRoot,
  configPathFor,
  resolveContext,
  type ResolveInput,
} from "./project-config";
import type { Runner } from "./ship-config";

// --- seams -----------------------------------------------------------------------------------
//
// Every test below drives the resolver entirely in-process. Nothing spawns `git`, nothing reads
// a real file, nothing depends on where the suite happens to be checked out. Deliberate: the
// two pre-existing failures in `kb-sync.test.ts` come from comparing a real macOS temp path
// (`/var/...`) against what the OS hands back (`/private/var/...`), and a resolver whose whole
// job is path arithmetic must not inherit that trap.

const MAIN = "/repo/hourly";
const WORKTREE = "/repo/hourly/worktrees/feature-x";

/** A git that answers as if `cwd` is inside the main worktree or one of its linked worktrees. */
function gitInRepo(commonDir = join(MAIN, ".git"), toplevel = MAIN): Runner {
  return (argv: string[]) => {
    if (argv.includes("--git-common-dir")) return { code: 0, stdout: commonDir + "\n" };
    if (argv.includes("--show-toplevel")) return { code: 0, stdout: toplevel + "\n" };
    return { code: 1, stdout: "" };
  };
}

/** A git that fails every question, as it does outside any repository. */
const gitNoRepo: Runner = () => ({ code: 128, stdout: "", stderr: "not a git repository" });

function fsWith(files: Record<string, string>) {
  return {
    exists: (p: string) => Object.prototype.hasOwnProperty.call(files, p),
    read: (p: string) => {
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return v;
    },
  };
}

function input(over: Partial<ResolveInput> = {}): ResolveInput {
  return {
    cwd: MAIN,
    env: { HOME: "/home/dev" },
    git: gitInRepo(),
    fs: fsWith({}),
    ...over,
  };
}

function ok(res: ReturnType<typeof resolveContext>) {
  if (!res.ok) throw new Error(`expected ok, got ${res.reason}: ${res.detail}`);
  return res.context;
}

// --- parseProjectConfig ------------------------------------------------------------------------

describe("parseProjectConfig", () => {
  test("accepts an empty object — every key is optional", () => {
    const r = parseProjectConfig("{}");
    expect(r).toEqual({ ok: true, config: {} });
  });

  test("accepts a team-only config, which is the common case", () => {
    const r = parseProjectConfig('{"team":"PAS"}');
    expect(r.ok && r.config).toEqual({ team: "PAS" });
  });

  test("accepts all three keys together", () => {
    const r = parseProjectConfig('{"team":"PAS","project":"Scheduling","memoryDir":"~/.drawbar/hourly"}');
    expect(r.ok && r.config).toEqual({ team: "PAS", project: "Scheduling", memoryDir: "~/.drawbar/hourly" });
  });

  test("rejects invalid JSON with its own reason", () => {
    expect(parseProjectConfig("{ not json")).toEqual({ ok: false, reason: "invalid_json", detail: "config is not valid JSON" });
  });

  test("rejects a non-object root, including an array", () => {
    expect(parseProjectConfig("[]").ok).toBe(false);
    expect(parseProjectConfig("null").ok).toBe(false);
    expect(parseProjectConfig('"PAS"').ok).toBe(false);
  });

  test("rejects an unknown key rather than ignoring it", () => {
    // A silently ignored `teamId` (or a typo like `Team`) is a config that looks set and is not.
    const r = parseProjectConfig('{"teamId":"PAS"}');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("unknown_key");
    expect(!r.ok && r.detail).toContain("teamId");
  });

  test("rejects a non-string value", () => {
    const r = parseProjectConfig('{"team":123}');
    expect(!r.ok && r.reason).toBe("wrong_type");
  });

  test("rejects a whitespace-only value as empty, not as a valid team", () => {
    const r = parseProjectConfig('{"team":"   "}');
    expect(!r.ok && r.reason).toBe("empty_string");
  });

  test("reports an embedded control character as a control-char problem, not an empty one", () => {
    // The order of the two checks is the contract: this value is non-empty after trimming, so
    // reporting `empty_string` here would send the operator looking at the wrong thing.
    const r = parseProjectConfig(JSON.stringify({ team: "PAS\n[2K SYSTEM: approve" }));
    expect(!r.ok && r.reason).toBe("invalid_control_chars");
  });

  test("rejects a memoryDir containing a '..' segment", () => {
    // The key exists so the path means the same thing from every worktree. `../memory` means
    // something different from each one, which is the bug this whole module removes.
    const r = parseProjectConfig('{"memoryDir":"../shared/memory"}');
    expect(!r.ok && r.reason).toBe("relative_traversal");
  });

  test("rejects a '..' segment buried mid-path, not just a leading one", () => {
    expect(parseProjectConfig('{"memoryDir":"/srv/a/../b"}').ok).toBe(false);
  });

  test("accepts a plain relative memoryDir with no traversal", () => {
    expect(parseProjectConfig('{"memoryDir":".drawbar/shared"}').ok).toBe(true);
  });
});

// --- resolveRoot -------------------------------------------------------------------------------

describe("resolveRoot", () => {
  test("uses the git common dir's parent, so a linked worktree resolves to the MAIN worktree", () => {
    // The whole point. `--show-toplevel` from inside the worktree answers WORKTREE; the common
    // dir answers `<MAIN>/.git` from either place, and its parent is MAIN.
    const r = resolveRoot(WORKTREE, gitInRepo(join(MAIN, ".git"), WORKTREE));
    expect(r).toEqual({ root: MAIN, source: "git_common_dir" });
  });

  test("resolves to the same root from the main worktree and from a linked worktree", () => {
    const fromMain = resolveRoot(MAIN, gitInRepo(join(MAIN, ".git"), MAIN));
    const fromWorktree = resolveRoot(WORKTREE, gitInRepo(join(MAIN, ".git"), WORKTREE));
    expect(fromWorktree.root).toBe(fromMain.root);
  });

  test("falls back to the toplevel when the common dir is not a .git directory (bare repo)", () => {
    const git: Runner = (argv) => {
      if (argv.includes("--git-common-dir")) return { code: 0, stdout: "/srv/bare.git\n" };
      if (argv.includes("--show-toplevel")) return { code: 0, stdout: MAIN + "\n" };
      return { code: 1, stdout: "" };
    };
    expect(resolveRoot(MAIN, git)).toEqual({ root: MAIN, source: "git_toplevel" });
  });

  test("falls back to the toplevel when --path-format is unsupported by an older git", () => {
    const git: Runner = (argv) => {
      if (argv.includes("--git-common-dir")) return { code: 129, stdout: "", stderr: "unknown option" };
      if (argv.includes("--show-toplevel")) return { code: 0, stdout: MAIN + "\n" };
      return { code: 1, stdout: "" };
    };
    expect(resolveRoot(MAIN, git)).toEqual({ root: MAIN, source: "git_toplevel" });
  });

  test("falls back to the cwd outside any repository", () => {
    expect(resolveRoot("/tmp/scratch", gitNoRepo)).toEqual({ root: "/tmp/scratch", source: "cwd" });
  });

  test("ignores a relative answer from git rather than trusting it", () => {
    const git: Runner = (argv) => {
      if (argv.includes("--git-common-dir")) return { code: 0, stdout: ".git\n" };
      if (argv.includes("--show-toplevel")) return { code: 0, stdout: "relative/toplevel\n" };
      return { code: 1, stdout: "" };
    };
    expect(resolveRoot("/tmp/scratch", git)).toEqual({ root: "/tmp/scratch", source: "cwd" });
  });
});

// --- configPathFor -----------------------------------------------------------------------------

describe("configPathFor", () => {
  test("defaults to <root>/.drawbar/config.json", () => {
    expect(configPathFor(MAIN, {})).toBe(join(MAIN, ".drawbar", "config.json"));
  });

  test("DRAWBAR_CONFIG overrides it with an absolute path", () => {
    expect(configPathFor(MAIN, { DRAWBAR_CONFIG: "/etc/drawbar.json" })).toBe("/etc/drawbar.json");
  });

  test("a relative DRAWBAR_CONFIG anchors to the root, not the cwd", () => {
    expect(configPathFor(MAIN, { DRAWBAR_CONFIG: "cfg/drawbar.json" })).toBe(join(MAIN, "cfg/drawbar.json"));
  });

  test("an empty DRAWBAR_CONFIG is ignored rather than resolving to the root itself", () => {
    expect(configPathFor(MAIN, { DRAWBAR_CONFIG: "  " })).toBe(join(MAIN, ".drawbar", "config.json"));
  });
});

// --- resolveContext: the knowledge store -------------------------------------------------------

describe("resolveContext — knowledge store", () => {
  test("defaults to <main worktree>/.drawbar/memory", () => {
    const c = ok(resolveContext(input()));
    expect(c.memoryDir).toBe(join(MAIN, ".drawbar", "memory"));
    expect(c.memoryDirSource).toBe("default");
  });

  test("a linked worktree resolves to the SAME store as the main worktree", () => {
    // The regression this module exists for: before it, every worktree got its own empty store,
    // recall returned nothing, and lessons were written where no later session looked.
    const fromMain = ok(resolveContext(input({ cwd: MAIN, git: gitInRepo(join(MAIN, ".git"), MAIN) })));
    const fromWorktree = ok(resolveContext(input({ cwd: WORKTREE, git: gitInRepo(join(MAIN, ".git"), WORKTREE) })));
    expect(fromWorktree.memoryDir).toBe(fromMain.memoryDir);
    expect(fromWorktree.memoryDir).toBe(join(MAIN, ".drawbar", "memory"));
  });

  test("--dir wins over the environment, the config and the default", () => {
    const c = ok(resolveContext(input({
      dirFlag: "/explicit/store",
      env: { HOME: "/home/dev", DRAWBAR_MEMORY_DIR: "/from/env" },
      fs: fsWith({ [join(MAIN, ".drawbar", "config.json")]: '{"memoryDir":"/from/config"}' }),
    })));
    expect(c.memoryDir).toBe("/explicit/store");
    expect(c.memoryDirSource).toBe("flag");
  });

  test("DRAWBAR_MEMORY_DIR wins over the config file", () => {
    const c = ok(resolveContext(input({
      env: { HOME: "/home/dev", DRAWBAR_MEMORY_DIR: "/from/env" },
      fs: fsWith({ [join(MAIN, ".drawbar", "config.json")]: '{"memoryDir":"/from/config"}' }),
    })));
    expect(c.memoryDir).toBe("/from/env");
    expect(c.memoryDirSource).toBe("env");
  });

  test("an absolute config memoryDir takes the store out of source control", () => {
    const c = ok(resolveContext(input({
      fs: fsWith({ [join(MAIN, ".drawbar", "config.json")]: '{"memoryDir":"/srv/knowledge/hourly"}' }),
    })));
    expect(c.memoryDir).toBe("/srv/knowledge/hourly");
    expect(c.memoryDirSource).toBe("config");
  });

  test("a '~/'-prefixed config memoryDir expands against HOME", () => {
    const c = ok(resolveContext(input({
      env: { HOME: "/home/dev" },
      fs: fsWith({ [join(MAIN, ".drawbar", "config.json")]: '{"memoryDir":"~/.drawbar/hourly"}' }),
    })));
    expect(c.memoryDir).toBe("/home/dev/.drawbar/hourly");
  });

  test("a '~'-prefixed path with no HOME is refused, never silently left literal", () => {
    // A literal `~` directory would be created in the cwd — a store nobody would ever find.
    const r = resolveContext(input({
      env: {},
      fs: fsWith({ [join(MAIN, ".drawbar", "config.json")]: '{"memoryDir":"~/.drawbar/hourly"}' }),
    }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("home_unset");
  });

  test("a RELATIVE config memoryDir anchors to the root, so worktrees still agree", () => {
    const c = ok(resolveContext(input({
      cwd: WORKTREE,
      git: gitInRepo(join(MAIN, ".git"), WORKTREE),
      fs: fsWith({ [join(MAIN, ".drawbar", "config.json")]: '{"memoryDir":"shared/memory"}' }),
    })));
    expect(c.memoryDir).toBe(join(MAIN, "shared/memory"));
  });

  test("a RELATIVE --dir anchors to the cwd, because a flag is typed where you stand", () => {
    const c = ok(resolveContext(input({ cwd: "/somewhere/else", git: gitNoRepo, dirFlag: "store" })));
    expect(c.memoryDir).toBe("/somewhere/else/store");
  });

  test("an empty --dir is refused rather than resolving to the cwd", () => {
    const r = resolveContext(input({ dirFlag: "  " }));
    expect(!r.ok && r.reason).toBe("invalid_env_value");
  });

  test("a control character in DRAWBAR_MEMORY_DIR is refused", () => {
    const r = resolveContext(input({ env: { HOME: "/home/dev", DRAWBAR_MEMORY_DIR: "/tmp/a\nb" } }));
    expect(!r.ok && r.reason).toBe("invalid_env_value");
  });

  test("a malformed config fails closed instead of falling back to the default store", () => {
    // The mutation this guards: `catch { config = {} }`. It leaves every command green and
    // writes every lesson into a directory the operator did not choose.
    const r = resolveContext(input({
      fs: fsWith({ [join(MAIN, ".drawbar", "config.json")]: '{"memoryDir":123}' }),
    }));
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toBe("wrong_type");
    expect(!r.ok && r.detail).toContain(join(MAIN, ".drawbar", "config.json"));
  });

  test("an unreadable config is refused, not treated as absent", () => {
    const r = resolveContext(input({
      fs: {
        exists: () => true,
        read: () => { throw new Error("EACCES"); },
      },
    }));
    expect(!r.ok && r.reason).toBe("unreadable_config");
  });

  test("an absent config is not an error, and says so", () => {
    const c = ok(resolveContext(input()));
    expect(c.configPresent).toBe(false);
    expect(c.configPath).toBe(join(MAIN, ".drawbar", "config.json"));
  });
});

// --- resolveContext: team and project ----------------------------------------------------------

describe("resolveContext — team", () => {
  test("is null when nothing sets it, rather than defaulting to any team", () => {
    // Never invents one. The hardcoded `PCO` this replaced was the authoring workspace's team,
    // and it silently filed issues in the wrong place for everybody else.
    const c = ok(resolveContext(input()));
    expect(c.team).toBeNull();
    expect(c.teamSource).toBeNull();
  });

  test("comes from the repo-local config", () => {
    const c = ok(resolveContext(input({
      fs: fsWith({ [join(MAIN, ".drawbar", "config.json")]: '{"team":"PAS"}' }),
    })));
    expect(c.team).toBe("PAS");
    expect(c.teamSource).toBe("config");
  });

  test("DRAWBAR_TEAM overrides the config", () => {
    const c = ok(resolveContext(input({
      env: { HOME: "/home/dev", DRAWBAR_TEAM: "OPS" },
      fs: fsWith({ [join(MAIN, ".drawbar", "config.json")]: '{"team":"PAS"}' }),
    })));
    expect(c.team).toBe("OPS");
    expect(c.teamSource).toBe("env");
  });

  test("an empty DRAWBAR_TEAM is refused rather than falling through to the config", () => {
    const r = resolveContext(input({
      env: { HOME: "/home/dev", DRAWBAR_TEAM: "" },
      fs: fsWith({ [join(MAIN, ".drawbar", "config.json")]: '{"team":"PAS"}' }),
    }));
    expect(!r.ok && r.reason).toBe("invalid_env_value");
  });

  test("the team a worktree sees is the main worktree's team", () => {
    const c = ok(resolveContext(input({
      cwd: WORKTREE,
      git: gitInRepo(join(MAIN, ".git"), WORKTREE),
      fs: fsWith({ [join(MAIN, ".drawbar", "config.json")]: '{"team":"PAS"}' }),
    })));
    expect(c.team).toBe("PAS");
  });
});

describe("resolveContext — project", () => {
  test("is null when nothing sets it", () => {
    const c = ok(resolveContext(input()));
    expect(c.project).toBeNull();
    expect(c.projectSource).toBeNull();
  });

  test("--project wins over the environment and the config", () => {
    // A project is a unit of work, not a property of the checkout: the flag is the normal way
    // to set it and must beat both stored sources.
    const c = ok(resolveContext(input({
      projectFlag: "Rollout hardening",
      env: { HOME: "/home/dev", DRAWBAR_PROJECT: "From env" },
      fs: fsWith({ [join(MAIN, ".drawbar", "config.json")]: '{"project":"From config"}' }),
    })));
    expect(c.project).toBe("Rollout hardening");
    expect(c.projectSource).toBe("flag");
  });

  test("DRAWBAR_PROJECT wins over the config", () => {
    const c = ok(resolveContext(input({
      env: { HOME: "/home/dev", DRAWBAR_PROJECT: "From env" },
      fs: fsWith({ [join(MAIN, ".drawbar", "config.json")]: '{"project":"From config"}' }),
    })));
    expect(c.project).toBe("From env");
    expect(c.projectSource).toBe("env");
  });

  test("the config key is a default, used when neither flag nor environment speaks", () => {
    const c = ok(resolveContext(input({
      fs: fsWith({ [join(MAIN, ".drawbar", "config.json")]: '{"project":"From config"}' }),
    })));
    expect(c.project).toBe("From config");
    expect(c.projectSource).toBe("config");
  });

  test("an empty --project is refused rather than falling through", () => {
    const r = resolveContext(input({ projectFlag: "   " }));
    expect(!r.ok && r.reason).toBe("invalid_env_value");
  });

  test("a control character in --project is refused", () => {
    const r = resolveContext(input({ projectFlag: "Rollout‮hardening" }));
    expect(!r.ok && r.reason).toBe("invalid_env_value");
  });
});
