import { test, expect, describe, beforeEach } from "bun:test";
import {
  mkdtempSync, existsSync, writeFileSync, readFileSync, appendFileSync, chmodSync, mkdirSync, symlinkSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import {
  syncKnowledge,
  knowledgePreflight,
  isPushRejection,
  PUSH_REJECTION_PATTERNS,
  parseSyncCliArgs,
  parsePreflightCliArgs,
  main,
  type SyncKnowledgeInput,
  type MainDeps,
} from "./kb-sync";
import { appendEntry, readEntries, readArchiveEntries, storePaths, ensureDir } from "./store";
import type { Entry } from "./schema";
import type { Runner } from "./ship-config";

// Same fixture shape store.test.ts uses.
function entry(over: Partial<Entry> = {}): Entry {
  return {
    key: "k1", type: "fact", content: "hello", source: "agent",
    tags: [], ts: 100, issue: null, files: [], ...over,
  };
}

let envDir: string;
let kbDir: string;

beforeEach(() => {
  envDir = mkdtempSync(join(tmpdir(), "kb-sync-env-"));
  kbDir = join(envDir, ".drawbar", "memory");
});

// --- git call-log spy ------------------------------------------------------------------------
//
// Keyed by argv[2] (the subcommand — every call this module makes is anchored `-C <envDir>
// <subcommand> ...`, MUST-CHECK injected-runner-no-cwd-silently-inherits-caller-directory).
// `push` is driven by a QUEUE so a test can script attempt 1 rejected, attempt 2 succeeding,
// etc. — the last entry repeats if the queue is exhausted.
// `stdout` is optional here purely for fixture-literal convenience (most fixtures only care
// about `code`/`stderr`) — `toRunnerResp` below is what guarantees every value this spy
// actually RETURNS satisfies `Runner`'s `stdout: string` (never `undefined`), so the fake
// runner's declared type is never looser than the real one it stands in for.
type GitResp = { code: number; stdout?: string; stderr?: string };
const OK: GitResp = { code: 0, stdout: "", stderr: "" };
const STAGED: GitResp = { code: 1, stdout: "", stderr: "" }; // diff --cached --quiet: 1 = staged
const CLEAN_STATUS: GitResp = { code: 0, stdout: "", stderr: "" };
const UNION_ATTR: GitResp = { code: 0, stdout: "path: merge: union\n", stderr: "" };

function toRunnerResp(r: GitResp): { code: number; stdout: string; stderr?: string } {
  return { code: r.code, stdout: r.stdout ?? "", stderr: r.stderr };
}

// `git check-ignore -q` exit codes, verified against real git 2.43.0 (see the module's own
// comment at the call site): 0 = ignored, 1 = NOT ignored, 128 = error. The fixture default is
// NOT_IGNORED, matching a normally-configured knowledge repo.
const NOT_IGNORED: GitResp = { code: 1, stdout: "", stderr: "" };
const IGNORED: GitResp = { code: 0, stdout: "", stderr: "" };

// R7: `ls-files --error-unmatch <config>` is the tracked-config guard inside
// `assertEnvDirTrusted`. Exit 0 means the config IS tracked (refuse); the fixture default is
// NOT_TRACKED, matching a correctly-untracked operator config.
const NOT_TRACKED: GitResp = { code: 1, stdout: "", stderr: "error: pathspec did not match any file(s) known to git" };
const TRACKED: GitResp = { code: 0, stdout: ".drawbar/ship.config.json\n", stderr: "" };

// The one git call the trust root makes: anchored at the CONFIG's directory, not at envDir. Every
// call-log assertion that is about the envDir-anchored sequence filters it out through this, so
// "the trust root's own call" and "the sequence under test" can never be confused for each other.
function isTrustRootCall(argv: string[]): boolean {
  return argv[2] === "ls-files";
}

function makeGitSpy(overrides: {
  add?: GitResp;
  diff?: GitResp;
  commit?: GitResp;
  status?: GitResp;
  pull?: GitResp;
  pushQueue?: GitResp[];
  checkAttr?: GitResp | ((argv: string[]) => GitResp);
  checkIgnore?: GitResp | ((argv: string[]) => GitResp);
  lsFiles?: GitResp;
} = {}): { git: Runner; calls: string[][] } {
  const calls: string[][] = [];
  let pushIdx = 0;
  const pushQueue = overrides.pushQueue ?? [OK];
  const git: Runner = (argv) => {
    calls.push(argv);
    const sub = argv[2];
    if (sub === "ls-files") return toRunnerResp(overrides.lsFiles ?? NOT_TRACKED);
    if (sub === "check-ignore") {
      if (typeof overrides.checkIgnore === "function") return toRunnerResp(overrides.checkIgnore(argv));
      return toRunnerResp(overrides.checkIgnore ?? NOT_IGNORED);
    }
    if (sub === "add") return toRunnerResp(overrides.add ?? OK);
    if (sub === "diff") return toRunnerResp(overrides.diff ?? STAGED);
    if (sub === "commit") return toRunnerResp(overrides.commit ?? OK);
    if (sub === "status") return toRunnerResp(overrides.status ?? CLEAN_STATUS);
    if (sub === "pull") return toRunnerResp(overrides.pull ?? OK);
    if (sub === "push") {
      const r = pushQueue[Math.min(pushIdx, pushQueue.length - 1)]!;
      pushIdx++;
      return toRunnerResp(r);
    }
    if (sub === "check-attr") {
      if (typeof overrides.checkAttr === "function") return toRunnerResp(overrides.checkAttr(argv));
      return toRunnerResp(overrides.checkAttr ?? UNION_ATTR);
    }
    return { code: 1, stdout: "", stderr: `unexpected git call in fixture: ${argv.join(" ")}` };
  };
  return { git, calls };
}

function noopSleep(): (ms: number) => Promise<void> {
  return async () => {};
}

// R5/F5: `syncKnowledge` now stages only paths that actually EXIST on disk (`git add` on a
// missing pathspec exits 128). A test that wants a stage+commit to happen must therefore put
// the file there — the fake runner cannot stand in for the filesystem here. These two helpers
// are the single site that does it, so the same fact is stated once.
function seedActive(): void {
  ensureDir(kbDir);
  appendFileSync(storePaths(kbDir).active, JSON.stringify(entry({ key: "seeded-active" })) + "\n");
}

function seedArchive(): void {
  ensureDir(kbDir);
  appendFileSync(storePaths(kbDir).archive, JSON.stringify(entry({ key: "seeded-superseded" })) + "\n");
}

// --- the R5/F2 trust root -----------------------------------------------------------------
//
// Both verbs now require `--config-path` and refuse unless the operator-authored config's
// `envDir` EQUALS the `--env-dir` they were handed. These helpers supply a config that agrees,
// so every pre-existing test keeps exercising the path it was written for.
// R7 hardened the trust root: `--config-path` must resolve to the path this process's own
// `$DRAWBAR_SHIP_CONFIG`/cwd resolve to, and the config must not be tracked by git. `trustDeps`
// supplies a matching anchor plus an IDENTITY `realpath` (so unit tests need no file on disk);
// `mainTrustDeps` does the same for main(), through the `env` seam so the real `resolveConfigPath`
// runs. The real `realpathSync` default and the real anchor are exercised end to end by the
// subprocess tests near the bottom of this file, which write a genuine config to disk.
const CONFIG_PATH = "/abs/env/.drawbar/ship.config.json";

function shipConfigText(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    envDir, // the test's real envDir — agrees with --env-dir by default
    projectDir: "/abs/project",
    repo: "org/repo",
    team: "PCO",
    baseBranch: "main",
    requiredChecks: ["build"],
    ...over,
  });
}

function trustDeps(
  over: {
    configPath?: string;
    expectedConfigPath?: string;
    readConfig?: (p: string) => string;
    realpath?: (p: string) => string;
  } = {},
) {
  return {
    configPath: over.configPath ?? CONFIG_PATH,
    expectedConfigPath: over.expectedConfigPath ?? CONFIG_PATH,
    readConfig: over.readConfig ?? (() => shipConfigText()),
    realpath: over.realpath ?? ((p: string) => p),
  };
}

// The main()-level equivalent: the anchor arrives through `env`, so main()'s own call to
// ship-config.ts's `resolveConfigPath` is what is under test, not a hand-passed value.
function mainTrustDeps(over: { readConfig?: (p: string) => string } = {}): Partial<MainDeps> {
  return {
    readConfig: over.readConfig ?? (() => shipConfigText()),
    env: { DRAWBAR_SHIP_CONFIG: CONFIG_PATH },
    realpath: (p: string) => p,
  };
}

// --- the injected-filesystem fake for knowledgePreflight's assert-or-create ------------------
//
// Hoisted to module scope so the R5/F2 trust-root tests below can drive `knowledgePreflight`
// too, rather than a second near-copy of the same fake.
//
// R5/F4 M9: this fake used to accept `writeFileSync` unconditionally, so DELETING the
// `mkdirSync` call in `knowledgePreflight` left the suite green — while on a real first run with
// `.drawbar/runs/` absent, the real `writeFileSync` throws ENOENT. It now models the
// filesystem's actual ordering constraint: a write into a directory that was never created
// throws, exactly as node's does. `mkdirOpts` is recorded too, because `{recursive:true}` is
// load-bearing (on a first run `.drawbar` itself may not exist either).
function fakeFs(existing: Set<string> = new Set(), opts: { failWrite?: string } = {}) {
  const written: Record<string, string> = {};
  const mkdirCalls: string[] = [];
  const mkdirOpts: Array<{ recursive: boolean }> = [];
  const dirs = new Set<string>();
  return {
    existsSync: (p: string) => existing.has(p),
    writeFileSync: (p: string, c: string) => {
      if (!dirs.has(dirname(p))) {
        throw new Error(`ENOENT: no such file or directory, open '${p}'`);
      }
      if (opts.failWrite !== undefined) throw new Error(opts.failWrite);
      written[p] = c;
      existing.add(p);
    },
    mkdirSync: (p: string, o: { recursive: boolean }) => {
      mkdirCalls.push(p);
      mkdirOpts.push(o);
      dirs.add(p);
    },
    written,
    mkdirCalls,
    mkdirOpts,
  };
}

function baseInput(overrides: Partial<SyncKnowledgeInput> = {}, git: Runner): SyncKnowledgeInput {
  return {
    envDir,
    kbDir,
    message: "kb: test sync (PCO-353)",
    lessons: [],
    git,
    sleep: noopSleep(),
    ...trustDeps(),
    ...overrides,
  };
}

// --- 1. F8 regression: attempts exhausted -> non-zero EXIT, driven through main() -----------

describe("F8 regression: push rejected on every attempt halts with a non-zero EXIT", () => {
  test("main() returns a non-zero exit code, and the JSON reason is attempts_exhausted", async () => {
    const { git } = makeGitSpy({ pushQueue: [{ code: 1, stderr: "! [rejected] main -> main (fetch first)" }] });
    let stdout = "";
    let stderr = "";
    const deps: MainDeps = {
      argv: ["sync", "--env-dir", envDir, "--dir", kbDir, "--message", "kb: test (PCO-353)", "--config-path", CONFIG_PATH],
      readStdin: async () => JSON.stringify({ lessons: [] }),
      ...mainTrustDeps(),
      git,
      sleep: noopSleep(),
      writeStdout: (s) => { stdout += s; },
      writeStderr: (s) => { stderr += s; },
    };
    const code = await main(deps);
    expect(code).not.toBe(0);
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("attempts_exhausted");
    expect(parsed.attempts).toBe(3);
    expect(stderr).toContain("attempts_exhausted");
  });
});

// --- 2. dirty tree is a precondition failure, not a retry ------------------------------------

describe("dirty tree precondition — halts, never retries, never reaches pull/push", () => {
  test("reason is dirty_precondition, and pull/push were never invoked", async () => {
    const { git, calls } = makeGitSpy({ status: { code: 0, stdout: " M some-other-file.txt\n", stderr: "" } });
    const result = await syncKnowledge(baseInput({}, git));
    expect(result).toMatchObject({ ok: false, reason: "dirty_precondition", attempts: 1 });
    expect(calls.some((c) => c[2] === "pull")).toBe(false);
    expect(calls.some((c) => c[2] === "push")).toBe(false);
    // Only one attempt occurred — add/diff/commit/status happened once each, not per-retry.
    expect(calls.filter((c) => c[2] === "status").length).toBe(1);
  });
});

// --- 3. untracked files are ignored for the rebase precondition ------------------------------

describe("untracked files never read as dirty", () => {
  test("the status call actually carries --untracked-files=no, and an untracked file on disk does not block the sync", async () => {
    ensureDir(kbDir);
    writeFileSync(join(kbDir, "untracked-scratch.txt"), "not tracked, not staged\n");
    const { git, calls } = makeGitSpy(); // CLEAN_STATUS: the runner reports no dirt
    const result = await syncKnowledge(baseInput({}, git));
    expect(result.ok).toBe(true);
    const statusCall = calls.find((c) => c[2] === "status")!;
    expect(statusCall).toBeDefined();
    expect(statusCall).toContain("--untracked-files=no");
  });
});

// --- 4. re-staging happens inside the loop, once per attempt ---------------------------------

describe("re-staging happens inside the loop", () => {
  test("`add` is called once per attempt, and a write that appears mid-run (during the retry sleep) is staged on the NEXT attempt", async () => {
    seedActive(); // so attempt 1 has something to stage at all (R5/F5)
    const { git, calls } = makeGitSpy({ pushQueue: [{ code: 1, stderr: "[rejected]" }, OK] });
    let sleepCalls = 0;
    const sleep = async () => {
      sleepCalls++;
      // Simulate a concurrent inline `drawbar-kb add` landing during the backoff window —
      // this is what puts a new file (the archive) on disk BETWEEN attempt 1 and attempt 2.
      ensureDir(kbDir);
      appendFileSync(storePaths(kbDir).archive, JSON.stringify(entry({ key: "superseded" })) + "\n");
    };
    const result = await syncKnowledge(baseInput({ sleep }, git));
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(sleepCalls).toBe(1);
    const addCalls = calls.filter((c) => c[2] === "add");
    expect(addCalls.length).toBe(2); // once per attempt, not once total
    expect(addCalls[0]!.some((a) => a.endsWith("knowledge.archive.jsonl"))).toBe(false);
    expect(addCalls[1]!.some((a) => a.endsWith("knowledge.archive.jsonl"))).toBe(true);
  });
});

// --- 5. only push rejections retry ------------------------------------------------------------

describe("only a genuine push-rejection shape retries", () => {
  const rejectionSamples: Array<{ label: string; stderr: string }> = [
    { label: "[rejected]", stderr: "! [rejected]        main -> main (fetch first)" },
    { label: "non-fast-forward", stderr: "error: failed to push some refs\nhint: non-fast-forward" },
    { label: "fetch first", stderr: "hint: Updates were rejected because the remote contains work; fetch first" },
    { label: "Updates were rejected", stderr: "! [rejected]\nUpdates were rejected because the tip of your branch is behind" },
  ];

  for (const sample of rejectionSamples) {
    test(`retries and succeeds on attempt 2 for stderr shape: ${sample.label}`, async () => {
      // Also pins PUSH_REJECTION_PATTERNS is the single site classifying this shape.
      expect(PUSH_REJECTION_PATTERNS.some((re) => re.test(sample.stderr))).toBe(true);
      expect(isPushRejection(sample.stderr)).toBe(true);
      const { git } = makeGitSpy({ pushQueue: [{ code: 1, stderr: sample.stderr }, OK] });
      const result = await syncKnowledge(baseInput({}, git));
      expect(result).toMatchObject({ ok: true, attempts: 2 });
    });
  }

  test("a non-rejection push failure halts after exactly ONE attempt (call-log spy)", async () => {
    const { git, calls } = makeGitSpy({ pushQueue: [{ code: 1, stderr: "remote: Permission denied (publickey)" }] });
    const result = await syncKnowledge(baseInput({}, git));
    expect(result).toMatchObject({ ok: false, reason: "push_failed", attempts: 1 });
    expect(calls.filter((c) => c[2] === "push").length).toBe(1);
  });
});

// --- 6. a key already present is not double-added (delegates whole to appendEntry) -----------

describe("a key already present is not double-added", () => {
  test("re-adding identical knowledge via lessons[] is a no-op — pre-state is non-zero, post-state still exactly one copy, ts unchanged", async () => {
    appendEntry(kbDir, entry({ key: "already-here", ts: 1000 }));
    const preState = readEntries(kbDir);
    expect(preState.length).toBeGreaterThan(0); // MUST-CHECK vacuous-assertion-needs-preseed-state
    expect(preState.filter((e) => e.key === "already-here").length).toBe(1);

    const { git } = makeGitSpy();
    const identicalLesson = entry({ key: "already-here", ts: 9999 }); // fresh ts only
    const result = await syncKnowledge(baseInput({ lessons: [identicalLesson] }, git));
    expect(result.ok).toBe(true);

    const post = readEntries(kbDir).filter((e) => e.key === "already-here");
    expect(post.length).toBe(1);
    // ts is UNCHANGED from the original seed — proves appendEntry took the no-op path
    // ({written:false, superseded:false}), not a rewrite with the lesson's fresh ts.
    expect(post[0]!.ts).toBe(1000);
  });
});

// --- 7. lessons[] reconciled by key, documented winner asserted ------------------------------

describe("lessons[] reconcile: the report's version supersedes an inline entry with the same key", () => {
  test("report content survives in active at the original position; the prior inline copy lands in the archive", async () => {
    appendEntry(kbDir, entry({ key: "other-1", content: "unrelated", ts: 1 }));
    appendEntry(kbDir, entry({ key: "target", content: "inline content", ts: 2 }));
    appendEntry(kbDir, entry({ key: "other-2", content: "unrelated too", ts: 3 }));

    const { git } = makeGitSpy();
    const reportLesson = entry({ key: "target", content: "report content wins", ts: 4 });
    const result = await syncKnowledge(baseInput({ lessons: [reportLesson] }, git));
    expect(result.ok).toBe(true);

    const active = readEntries(kbDir);
    expect(active.map((e) => e.key)).toEqual(["other-1", "target", "other-2"]); // position preserved
    const target = active.find((e) => e.key === "target")!;
    expect(target.content).toBe("report content wins"); // the report's version, not the inline one

    const archived = readArchiveEntries(kbDir);
    expect(archived.some((e) => e.key === "target" && e.content === "inline content")).toBe(true);
  });
});

// --- 8/9. staging the archive: present -> staged; absent -> not staged, and no failure -------

describe("staging the archive", () => {
  test("knowledge.archive.jsonl IS staged on the attempt after a supersede wrote to it", async () => {
    appendEntry(kbDir, entry({ key: "target", content: "v1" }));
    const { git, calls } = makeGitSpy();
    const result = await syncKnowledge(
      baseInput({ lessons: [entry({ key: "target", content: "v2" })] }, git),
    );
    expect(result.ok).toBe(true);
    expect(existsSync(storePaths(kbDir).archive)).toBe(true); // pre-condition: the supersede really wrote it
    const addCall = calls.find((c) => c[2] === "add")!;
    expect(addCall.some((a) => a.endsWith("knowledge.archive.jsonl"))).toBe(true);
  });

  test("archive absent — staging does not fail, and the archive path is not in argv", async () => {
    const { git, calls } = makeGitSpy();
    // A brand-new key is a plain append, never a supersede — the archive file is never created.
    const result = await syncKnowledge(baseInput({ lessons: [entry({ key: "brand-new" })] }, git));
    expect(result.ok).toBe(true);
    expect(existsSync(storePaths(kbDir).archive)).toBe(false);
    const addCall = calls.find((c) => c[2] === "add")!;
    expect(addCall.some((a) => a.endsWith("knowledge.archive.jsonl"))).toBe(false);
  });
});

// --- 8b. R5/F1: a GITIGNORED knowledge path is skipped, never handed to `git add` ------------
//
// `git add -- <ignored path>` exits 1 ("The following paths are ignored by one of your
// .gitignore files"), which the loop maps to `add_failed` and halts. Wherever
// `knowledge.archive.jsonl` is gitignored, EVERY sync after the first supersede halted
// permanently. Exit codes verified against real git 2.43.0: 0 = ignored, 1 = not ignored,
// 128 = error.

describe("R5/F1: a gitignored knowledge path is filtered out of the stage list", () => {
  test("present and NOT ignored -> the archive IS staged", async () => {
    seedActive();
    seedArchive();
    const { git, calls } = makeGitSpy({ checkIgnore: NOT_IGNORED });
    const result = await syncKnowledge(baseInput({}, git));
    expect(result.ok).toBe(true);
    const addCall = calls.find((c) => c[2] === "add")!;
    expect(addCall.some((a) => a.endsWith("knowledge.archive.jsonl"))).toBe(true);
  });

  test("present and IGNORED -> the archive is NOT staged, and the sync still SUCCEEDS", async () => {
    seedActive();
    seedArchive();
    expect(existsSync(storePaths(kbDir).archive)).toBe(true); // non-vacuous: it really is on disk
    const { git, calls } = makeGitSpy({
      // Only the archive is ignored; the active file is not.
      checkIgnore: (argv) => (argv.some((a) => a.endsWith("knowledge.archive.jsonl")) ? IGNORED : NOT_IGNORED),
    });
    const result = await syncKnowledge(baseInput({}, git));
    expect(result.ok).toBe(true); // the whole point of F1: no permanent halt
    const addCall = calls.find((c) => c[2] === "add")!;
    expect(addCall.some((a) => a.endsWith("knowledge.archive.jsonl"))).toBe(false);
    expect(addCall.some((a) => a.endsWith("knowledge.jsonl"))).toBe(true); // active still staged
    // And the commit is scoped to the same surviving list, never to the ignored path.
    const commitCall = calls.find((c) => c[2] === "commit")!;
    expect(commitCall.some((a) => a.endsWith("knowledge.archive.jsonl"))).toBe(false);
  });

  test("check-ignore is asked WITHOUT --no-index, so a tracked-but-pattern-matched file still stages", async () => {
    // Verified against real git 2.43.0: for a TRACKED file that a .gitignore pattern matches,
    // plain `check-ignore -q` exits 1 (not ignored) while `--no-index` exits 0. Plain
    // check-ignore therefore mirrors `git add`'s own index-aware behaviour exactly, so
    // skipping on exit 0 can never drop a tracked file's real change. Passing --no-index
    // would reintroduce exactly that silent drop.
    seedActive();
    seedArchive();
    const { git, calls } = makeGitSpy();
    await syncKnowledge(baseInput({}, git));
    const ignoreCalls = calls.filter((c) => c[2] === "check-ignore");
    expect(ignoreCalls.length).toBeGreaterThan(0);
    for (const c of ignoreCalls) expect(c).not.toContain("--no-index");
  });

  test("check-ignore erroring (128) halts with check_ignore_failed BEFORE any add", async () => {
    seedActive(); // there must be a candidate for check-ignore to be asked about at all
    const { git, calls } = makeGitSpy({ checkIgnore: { code: 128, stderr: "fatal: not a git repository" } });
    const result = await syncKnowledge(baseInput({}, git));
    expect(result).toMatchObject({ ok: false, reason: "check_ignore_failed", attempts: 1 });
    expect(calls.some((c) => c[2] === "add")).toBe(false);
    expect(calls.some((c) => c[2] === "push")).toBe(false);
  });
});

// --- 8c. R5/F5: a MISSING knowledge path is filtered out too, on both paths -------------------
//
// `git add -- <missing path>` exits 128 (`fatal: pathspec ... did not match any files`). The
// archive already had an existence guard; `knowledge.jsonl` did not — so a freshly scaffolded
// knowledge repo with no `knowledge.jsonl` yet plus an empty `lessons[]` halted `add_failed`.

describe("R5/F5: a missing knowledge path is filtered out of the stage list", () => {
  test("NEITHER file on disk -> stage+commit are SKIPPED entirely, and the sync SUCCEEDS", async () => {
    // A scaffolded knowledge repo: the memory dir may not even exist yet, and lessons[] is empty
    // so nothing creates the active file either.
    expect(existsSync(storePaths(kbDir).active)).toBe(false); // non-vacuous precondition
    expect(existsSync(storePaths(kbDir).archive)).toBe(false);
    const { git, calls } = makeGitSpy();
    const result = await syncKnowledge(baseInput({}, git));
    expect(result).toMatchObject({ ok: true, staged: [] });
    // Nothing to stage means nothing to add, nothing to ask about, and nothing to commit —
    // rather than an `add_failed` halt.
    expect(calls.some((c) => c[2] === "add")).toBe(false);
    expect(calls.some((c) => c[2] === "check-ignore")).toBe(false);
    expect(calls.some((c) => c[2] === "diff")).toBe(false);
    expect(calls.some((c) => c[2] === "commit")).toBe(false);
    // The rest of the sequence still runs: the precondition, the rebase, and the push. (The
    // trust root's own `ls-files` call is filtered out — it is anchored at the CONFIG's directory,
    // not at envDir, and has its own tests below.)
    expect(calls.filter((c) => !isTrustRootCall(c)).map((c) => c[2])).toEqual(["status", "pull", "push"]);
  });

  test("active ABSENT but archive present -> only the archive is staged, no halt", async () => {
    ensureDir(kbDir);
    appendFileSync(storePaths(kbDir).archive, JSON.stringify(entry({ key: "superseded" })) + "\n");
    expect(existsSync(storePaths(kbDir).active)).toBe(false);
    const { git, calls } = makeGitSpy();
    const result = await syncKnowledge(baseInput({}, git));
    expect(result).toMatchObject({ ok: true, staged: ["knowledge.archive.jsonl"] });
    const addCall = calls.find((c) => c[2] === "add")!;
    expect(addCall.filter((a) => a.endsWith(".jsonl"))).toEqual([
      addCall.find((a) => a.endsWith("knowledge.archive.jsonl"))!,
    ]);
  });

  test("both present -> both staged", async () => {
    ensureDir(kbDir);
    appendFileSync(storePaths(kbDir).active, JSON.stringify(entry({ key: "a" })) + "\n");
    appendFileSync(storePaths(kbDir).archive, JSON.stringify(entry({ key: "b" })) + "\n");
    const { git } = makeGitSpy();
    const result = await syncKnowledge(baseInput({}, git));
    expect(result).toMatchObject({ ok: true, staged: ["knowledge.jsonl", "knowledge.archive.jsonl"] });
  });
});

// --- 8d. R5/F6: the diff and the commit are both SCOPED to the KB paths -----------------------
//
// Real git 2.43.0, verified by running it rather than assumed (see the module's own comment at
// the commit call site for the full set of semantics):
//   - unrelated file staged by someone else + `git diff --cached --quiet` (unscoped) -> exit 1,
//     so the old loop believed IT had something to commit;
//   - `git commit -m msg` (unscoped) then swept that unrelated file into the KB commit;
//   - `git status --porcelain -uno` was CLEAN afterwards, so the dirty precondition saw
//     nothing wrong — and the sweep was PUSHED.
// Scoping both calls to the KB paths closes it: the scoped diff reports 0 (nothing of OURS is
// staged), no commit is attempted, and the precondition then trips on the foreign staged file.

describe("R5/F6: diff --cached and commit are both scoped to the KB pathspec", () => {
  test("both calls carry `--` followed by exactly the staged paths", async () => {
    seedActive();
    seedArchive();
    const { git, calls } = makeGitSpy();
    const result = await syncKnowledge(baseInput({}, git));
    expect(result.ok).toBe(true);

    const addCall = calls.find((c) => c[2] === "add")!;
    const stagedPaths = addCall.slice(addCall.indexOf("--") + 1);
    expect(stagedPaths.length).toBe(2); // non-vacuous: there really are paths to compare against

    for (const sub of ["diff", "commit"]) {
      const call = calls.find((c) => c[2] === sub)!;
      expect(call).toBeDefined();
      const sep = call.indexOf("--");
      expect(sep).toBeGreaterThan(-1); // the pathspec separator is present at all
      expect(call.slice(sep + 1)).toEqual(stagedPaths); // ...and scopes to the SAME paths
    }
  });

  test("the archive being filtered out narrows the commit pathspec too (not a fixed literal)", async () => {
    // MUST-CHECK de-hardcode-test-fixture-must-vary-the-old-value: the assertion above would
    // also pass if the pathspec were hardcoded to both paths. Here only ONE path survives the
    // filter, so a hardcoded two-path pathspec fails.
    seedActive();
    const { git, calls } = makeGitSpy();
    const result = await syncKnowledge(baseInput({}, git));
    expect(result.ok).toBe(true);
    const commitCall = calls.find((c) => c[2] === "commit")!;
    const pathspec = commitCall.slice(commitCall.indexOf("--") + 1);
    expect(pathspec.length).toBe(1);
    expect(pathspec[0]!.endsWith("knowledge.jsonl")).toBe(true);
  });

  // A stateful fake that reproduces the four observed real-git behaviours above, so the fix is
  // proven by OUTCOME and not only by argv shape. Without the pathspec on either call this
  // fake pushes a commit containing someone else's file — exactly the reported bug.
  function makeSweepFake(): { git: Runner; calls: string[][]; state: { commits: number; pushes: number } } {
    const calls: string[][] = [];
    const state = { commits: 0, pushes: 0 };
    let unrelatedStaged = true; // staged by someone else, before this sync ever ran
    const git: Runner = (argv) => {
      calls.push(argv);
      const sub = argv[2];
      const scoped = argv.includes("--") && argv.indexOf("--") < argv.length - 1;
      if (sub === "check-ignore") return { code: 1, stdout: "" };
      if (sub === "add") return { code: 0, stdout: "" };
      if (sub === "diff") {
        // Nothing of OURS is staged; only the foreign file is. A scoped diff sees nothing (0);
        // an unscoped diff sees the foreign file and reports "something staged" (1).
        return { code: scoped ? 0 : 1, stdout: "" };
      }
      if (sub === "commit") {
        state.commits++;
        // `git commit -- <paths>` implies --only: it commits ONLY those paths and leaves other
        // index entries staged. An unscoped commit sweeps the foreign file in and clears it.
        if (!scoped) unrelatedStaged = false;
        return { code: 0, stdout: "" };
      }
      if (sub === "status") return { code: 0, stdout: unrelatedStaged ? "M  unrelated.txt\n" : "" };
      if (sub === "pull") return { code: 0, stdout: "" };
      if (sub === "push") { state.pushes++; return { code: 0, stdout: "" }; }
      return { code: 1, stdout: "", stderr: `unexpected: ${argv.join(" ")}` };
    };
    return { git, calls, state };
  }

  test("a foreign staged file is NEVER committed or pushed — the precondition trips instead", async () => {
    seedActive();
    const { git, calls, state } = makeSweepFake();
    const result = await syncKnowledge(baseInput({}, git));
    expect(result).toMatchObject({ ok: false, reason: "dirty_precondition", attempts: 1 });
    expect(result.ok === false && result.detail).toContain("unrelated.txt");
    expect(state.commits).toBe(0); // no commit was attempted at all
    expect(state.pushes).toBe(0); // and nothing was pushed
    expect(calls.some((c) => c[2] === "push")).toBe(false);
  });
});

// --- 10. duplicateKeys detection: reported, warned, does NOT halt ----------------------------

describe("duplicateKeys — reported and warned, never a halt", () => {
  test("a genuinely duplicated key in the active store is counted, warned on stderr, and ok stays true", async () => {
    ensureDir(kbDir);
    const active = storePaths(kbDir).active;
    // Simulate the union-merge artifact directly — two DIFFERING copies of the same key,
    // exactly what a collided concurrent supersede leaves behind (see the module comment).
    appendFileSync(active, JSON.stringify(entry({ key: "dup", content: "version A", ts: 1 })) + "\n");
    appendFileSync(active, JSON.stringify(entry({ key: "dup", content: "version B", ts: 2 })) + "\n");
    const preState = readEntries(kbDir);
    expect(preState.filter((e) => e.key === "dup").length).toBe(2); // pre-seeded, non-vacuous

    let stdout = "";
    let stderr = "";
    const { git } = makeGitSpy();
    const deps: MainDeps = {
      argv: ["sync", "--env-dir", envDir, "--dir", kbDir, "--message", "kb: test (PCO-353)", "--config-path", CONFIG_PATH],
      readStdin: async () => JSON.stringify({ lessons: [] }),
      ...mainTrustDeps(),
      git,
      sleep: noopSleep(),
      writeStdout: (s) => { stdout += s; },
      writeStderr: (s) => { stderr += s; },
    };
    const code = await main(deps);
    expect(code).toBe(0); // does NOT halt
    const parsed = JSON.parse(stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.duplicateKeys).toBe(1); // one KEY duplicated (two copies), not two
    expect(stderr).toContain("compact");
  });
});

// --- 11. reindex runs last, only after a successful push --------------------------------------

describe("reindex ordering", () => {
  test("index.db is created on a successful sync", async () => {
    const { git } = makeGitSpy();
    const result = await syncKnowledge(baseInput({ lessons: [entry()] }, git));
    expect(result.ok).toBe(true);
    expect(existsSync(join(kbDir, "index.db"))).toBe(true);
  });

  test("index.db is NOT created when the sync halts (dirty precondition)", async () => {
    const { git } = makeGitSpy({ status: { code: 0, stdout: " M x\n", stderr: "" } });
    const result = await syncKnowledge(baseInput({}, git));
    expect(result.ok).toBe(false);
    expect(existsSync(join(kbDir, "index.db"))).toBe(false);
  });

  test("index.db is NOT created when attempts are exhausted", async () => {
    const { git } = makeGitSpy({ pushQueue: [{ code: 1, stderr: "[rejected]" }] });
    const result = await syncKnowledge(baseInput({}, git));
    expect(result.ok).toBe(false);
    expect(existsSync(join(kbDir, "index.db"))).toBe(false);
  });
});

// --- 12. archive/compact never invoked, success and failure paths ----------------------------

describe("drawbar-kb archive/compact are never invoked (Locked prohibition)", () => {
  const FORBIDDEN = new Set(["archive", "compact"]);

  test("success path: every git call's subcommand is in the allowed set", async () => {
    const { git, calls } = makeGitSpy();
    const result = await syncKnowledge(baseInput({ lessons: [entry()] }, git));
    expect(result.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(FORBIDDEN.has(c[2]!)).toBe(false);
  });

  test("failure path (dirty precondition): every git call's subcommand is in the allowed set", async () => {
    const { git, calls } = makeGitSpy({ status: { code: 0, stdout: " M x\n", stderr: "" } });
    const result = await syncKnowledge(baseInput({}, git));
    expect(result.ok).toBe(false);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) expect(FORBIDDEN.has(c[2]!)).toBe(false);
  });

  test("the module's own source never calls compactActive( or archiveOlderThan(", () => {
    const src = readFileSync(join(import.meta.dir, "kb-sync.ts"), "utf8");
    expect(src).not.toContain("compactActive(");
    expect(src).not.toContain("archiveOlderThan(");
  });
});

// --- 11b. R5/F4: the retry loop's core, mutant by mutant --------------------------------------
//
// Nine mutations of `syncKnowledge`'s per-attempt sequence used to leave the suite entirely
// green: deleting the commit branch, inverting the `diffRes.code === 1` test, deleting any one of
// the five error guards, moving the dirty precondition ahead of stage+commit, and deleting the
// `mkdir` in `knowledgePreflight`. The two structural gaps behind all nine were that NO test
// asserted a commit happens at all, and NO test asserted call ORDER. Both are closed here; M9
// (the `mkdir`) is closed in the preflight section below, because it is a real production bug
// rather than only a test gap.

describe("R5/F4: a commit actually happens, and only when something is staged", () => {
  test("M1: the commit is issued, carrying -m and the message verbatim", async () => {
    seedActive();
    const { git, calls } = makeGitSpy({ diff: STAGED });
    const result = await syncKnowledge(baseInput({ message: "kb: PCO-368 sync" }, git));
    expect(result.ok).toBe(true);
    const commitCalls = calls.filter((c) => c[2] === "commit");
    expect(commitCalls.length).toBe(1); // deleting the commit branch entirely makes this 0
    expect(commitCalls[0]).toContain("-m");
    expect(commitCalls[0]).toContain("kb: PCO-368 sync");
  });

  test("M2a: nothing staged (diff exits 0) -> NO commit is attempted, and the sync still succeeds", async () => {
    seedActive();
    const { git, calls } = makeGitSpy({ diff: { code: 0, stdout: "", stderr: "" } });
    const result = await syncKnowledge(baseInput({}, git));
    expect(result.ok).toBe(true);
    expect(calls.some((c) => c[2] === "commit")).toBe(false);
  });

  test("M2b: something staged (diff exits 1) -> exactly one commit", async () => {
    // The pair M2a/M2b is what kills an inverted `diffRes.code === 1`: whichever way the
    // comparison is flipped, one of the two fails.
    seedActive();
    const { git, calls } = makeGitSpy({ diff: STAGED });
    await syncKnowledge(baseInput({}, git));
    expect(calls.filter((c) => c[2] === "commit").length).toBe(1);
  });
});

describe("R5/F4: every error guard in the per-attempt sequence has its own named reason", () => {
  // M3-M7. Each fixture fails exactly ONE call and leaves every other call succeeding, so
  // deleting that call's guard would let the attempt run to a successful push and report
  // `ok: true` — which is precisely how all five mutants used to survive.
  const guards: Array<{ mutant: string; over: Parameters<typeof makeGitSpy>[0]; reason: string; detail?: string }> = [
    { mutant: "M3", over: { add: { code: 1, stderr: "fatal: add exploded" } }, reason: "add_failed", detail: "add exploded" },
    { mutant: "M4", over: { diff: { code: 128, stderr: "fatal: diff exploded" } }, reason: "diff_failed", detail: "diff exploded" },
    { mutant: "M5", over: { commit: { code: 1, stderr: "fatal: commit exploded" } }, reason: "commit_failed", detail: "commit exploded" },
    // stdout is deliberately EMPTY: a status that fails with no output must be read as
    // `status_failed`, never silently as "clean". Deleting the guard reports ok:true.
    { mutant: "M6", over: { status: { code: 128, stdout: "", stderr: "fatal: status exploded" } }, reason: "status_failed", detail: "status exploded" },
    { mutant: "M7", over: { pull: { code: 1, stderr: "fatal: pull exploded" } }, reason: "pull_failed", detail: "pull exploded" },
  ];

  for (const g of guards) {
    test(`${g.mutant}: ${g.reason} is reported, the sync is NOT ok, and nothing is pushed`, async () => {
      seedActive();
      const { git, calls } = makeGitSpy(g.over);
      const result = await syncKnowledge(baseInput({}, git));
      expect(result).toMatchObject({ ok: false, reason: g.reason, attempts: 1 });
      if (g.detail !== undefined) expect(result.ok === false && result.detail).toContain(g.detail);
      // None of these five is a rejection, so none of them retries either.
      expect(calls.some((c) => c[2] === "push")).toBe(false);
      expect(existsSync(join(kbDir, "index.db"))).toBe(false); // and no reindex
    });
  }
});

describe("R5/F4 / M8: the per-attempt call ORDER is asserted, not merely the call set", () => {
  test("stage+commit precede the dirty precondition, which precedes pull then push", async () => {
    // The load-bearing ordering claim in the module's own comment: the precondition runs AFTER
    // stage+commit precisely so the KB files this attempt just wrote are never self-reported as
    // dirty. Moved ahead of stage+commit, the loop trips `dirty_precondition` on its own writes
    // — and every pre-R5 test still passed, because none of them looked at order.
    seedActive();
    seedArchive();
    const { git, calls } = makeGitSpy();
    const result = await syncKnowledge(baseInput({}, git));
    expect(result.ok).toBe(true);
    expect(calls.filter((c) => !isTrustRootCall(c)).map((c) => c[2])).toEqual([
      "check-ignore", // one per candidate path...
      "check-ignore",
      "add",
      "diff",
      "commit",
      "status", // ...and the precondition only AFTER this attempt's own commit
      "pull",
      "push",
    ]);
  });

  test("the order holds on a retry too — the whole sequence repeats, not just the push", async () => {
    seedActive();
    const { git, calls } = makeGitSpy({ pushQueue: [{ code: 1, stderr: "[rejected]" }, OK] });
    const result = await syncKnowledge(baseInput({}, git));
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    const perAttempt = ["check-ignore", "add", "diff", "commit", "status", "pull", "push"];
    // The trust root runs ONCE, before the loop — so its call is not part of `perAttempt`.
    expect(calls.filter((c) => isTrustRootCall(c)).length).toBe(1);
    expect(calls.filter((c) => !isTrustRootCall(c)).map((c) => c[2])).toEqual([...perAttempt, ...perAttempt]);
  });

  test("every call is anchored with an explicit -C <envDir>, never an ambient cwd", async () => {
    // MUST-CHECK injected-runner-no-cwd-silently-inherits-caller-directory.
    seedActive();
    seedArchive();
    const { git, calls } = makeGitSpy();
    await syncKnowledge(baseInput({}, git));
    expect(calls.length).toBeGreaterThan(0);
    const envCalls = calls.filter((c) => !isTrustRootCall(c));
    expect(envCalls.length).toBeGreaterThan(0);
    for (const c of envCalls) {
      expect(c[0]).toBe("-C");
      expect(c[1]).toBe(envDir);
    }
    // R7: the trust root's own call is anchored too — at the CONFIG's directory, deliberately, and
    // never at the not-yet-vouched-for envDir. Asserted rather than merely excluded above, so
    // "filtered out" can never become "unchecked".
    const trustCalls = calls.filter((c) => isTrustRootCall(c));
    expect(trustCalls.length).toBe(1);
    expect(trustCalls[0]![0]).toBe("-C");
    expect(trustCalls[0]![1]).toBe(dirname(CONFIG_PATH));
    expect(trustCalls[0]![1]).not.toBe(envDir);
  });
});

// --- 12b. R5/F2: the envDir trust root, enforced INSIDE the module ---------------------------
//
// `--env-dir` reaches `git -C` on every call this module makes. Before R5 its only guard was
// `isCleanAbsolutePath`, a SHAPE check that says nothing about WHOSE repository the value
// names, and the claimed trust root (drawbar-ship.md §6 deriving it from Preflight's validated
// `resolved_config`) did not exist: §6 derived ENV_DIR from a prose placeholder the model fills
// in, checked only non-emptiness, and never referenced $CONFIG at all.
//
// The check now lives in the MODULE, on BOTH verbs, so a caller that skips the runbook cannot
// skip the check — and it runs before ANY git call, proven below by a call-counter spy rather
// than by inspection (MUST-CHECK call-counter-spy-proves-dispatch-path-not-entered).

describe("R5/F2: --env-dir must equal the configured envDir, checked before any git call", () => {
  // MUST-CHECK path-scrubbed-proof-must-not-hide-the-runner-itself: this counter is the runner.
  // It counts every invocation and returns a SUCCESS, so a refusal cannot be mistaken for the
  // spy having made the sync fail some other way.
  function countingGit(): { git: Runner; count: () => number } {
    let n = 0;
    return { git: (() => { n++; return { code: 0, stdout: "" }; }) as Runner, count: () => n };
  }

  const cases: Array<{ label: string; over: Parameters<typeof trustDeps>[0]; reason: string; detailHas: string }> = [
    {
      label: "envDir disagrees with --env-dir",
      over: { readConfig: () => shipConfigText({ envDir: "/some/other/knowledge-repo" }) },
      reason: "env_dir_not_in_config",
      detailHas: "/some/other/knowledge-repo",
    },
    {
      label: "the config file cannot be read",
      over: { readConfig: () => { throw new Error("ENOENT: no such file or directory"); } },
      reason: "config_unreadable",
      detailHas: CONFIG_PATH,
    },
    {
      label: "the config is structurally invalid (delegated to parseShipConfig)",
      over: { readConfig: () => JSON.stringify({ envDir: "/x", projectDir: "/y" }) },
      reason: "config_invalid",
      // parseShipConfig's OWN reason/detail, verbatim — proof this module never grew a second,
      // envDir-only parser of its own.
      detailHas: "missing required key: repo",
    },
    {
      label: "the config is not JSON at all",
      over: { readConfig: () => "not json {{{" },
      reason: "config_invalid",
      detailHas: "invalid_json",
    },
    {
      label: "the config's own envDir is shape-invalid",
      over: { readConfig: () => shipConfigText({ envDir: "/abs/../escaped" }) },
      reason: "config_invalid",
      detailHas: "/abs/../escaped",
    },
  ];

  for (const c of cases) {
    test(`sync refuses (${c.reason}) when ${c.label} — and makes ZERO git calls`, async () => {
      const { git, count } = countingGit();
      const result = await syncKnowledge(
        baseInput({ ...trustDeps(c.over), lessons: [entry({ key: "must-not-be-written" })] }, git),
      );
      expect(result).toMatchObject({ ok: false, reason: c.reason, attempts: 0 });
      expect(result.ok === false && result.detail).toContain(c.detailHas);
      expect(count()).toBe(0); // no git call happened at all — not merely no push
      // The refusal also precedes the store mutation: lessons[] was NOT applied.
      expect(existsSync(storePaths(kbDir).active)).toBe(false);
    });

    test(`preflight refuses (${c.reason}) when ${c.label} — and makes ZERO git calls`, () => {
      const { git, count } = countingGit();
      const fs = fakeFs(new Set([join(envDir, ".drawbar", "runs", ".gitignore")]));
      const result = knowledgePreflight({ envDir, kbDir, git, ...fs, ...trustDeps(c.over) });
      expect(result).toMatchObject({ ok: false, reason: c.reason });
      expect(result.ok === false && result.detail).toContain(c.detailHas);
      expect(count()).toBe(0);
    });
  }

  test("a config whose envDir EQUALS --env-dir lets the sync proceed", async () => {
    // MUST-CHECK de-hardcode-test-fixture-must-vary-the-old-value: the refusals above would all
    // still pass if the check were `return refuse()` unconditionally. This is the other half.
    seedActive();
    const { git, calls } = makeGitSpy();
    const result = await syncKnowledge(baseInput({}, git));
    expect(result.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });

  test("a trailing slash on --env-dir is not a refusal (both sides normalized, not string-compared)", async () => {
    seedActive();
    const { git } = makeGitSpy();
    const result = await syncKnowledge(
      baseInput({ readConfig: () => shipConfigText({ envDir: envDir + "/" }) }, git),
    );
    expect(result.ok).toBe(true);
  });

  test("the module's source contains no second config parser — parseShipConfig is imported", () => {
    // Single-implementation-site discipline: the one thing that must never happen here is a
    // hand-rolled `JSON.parse(configText).envDir` shortcut past parseShipConfig's validation.
    const src = readFileSync(join(import.meta.dir, "kb-sync.ts"), "utf8");
    expect(src).toContain("parseShipConfig");
    expect(src).not.toMatch(/JSON\.parse\([a-zA-Z]*[Cc]onfig/);
  });
});

// --- 12c. R5/F2: --config-path is REQUIRED on both verbs -------------------------------------

describe("R5/F2: --config-path is required on both verbs", () => {
  test("sync: omitting --config-path refuses", () => {
    const result = parseSyncCliArgs(["--env-dir", "/tmp/a", "--dir", "/tmp/b", "--message", "m"]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("--config-path");
  });

  test("preflight: omitting --config-path refuses", () => {
    const result = parsePreflightCliArgs(["--env-dir", "/tmp/a", "--dir", "/tmp/b"]);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toContain("--config-path");
  });

  test("sync: --config-path with no value (boolean true) refuses", () => {
    const result = parseSyncCliArgs(["--env-dir", "/tmp/a", "--dir", "/tmp/b", "--message", "m", "--config-path"]);
    expect(result.ok).toBe(false);
  });

  test("sync: a relative --config-path refuses", () => {
    const result = parseSyncCliArgs([
      "--env-dir", "/tmp/a", "--dir", "/tmp/b", "--message", "m", "--config-path", "rel/ship.json",
    ]);
    expect(result.ok).toBe(false);
  });

  test("sync: a well-formed invocation parses and carries configPath through", () => {
    const result = parseSyncCliArgs([
      "--env-dir", "/tmp/a", "--dir", "/tmp/b", "--message", "kb: x", "--config-path", "/tmp/ship.json",
    ]);
    expect(result).toEqual({ ok: true, envDir: "/tmp/a", dir: "/tmp/b", message: "kb: x", configPath: "/tmp/ship.json" });
  });

  test("preflight: a well-formed invocation parses and carries configPath through", () => {
    const result = parsePreflightCliArgs(["--env-dir", "/tmp/a", "--dir", "/tmp/b", "--config-path", "/tmp/ship.json"]);
    expect(result).toEqual({ ok: true, envDir: "/tmp/a", dir: "/tmp/b", configPath: "/tmp/ship.json" });
  });

  test("main(): sync without --config-path exits non-zero, empty stdout, and never touches git or stdin", async () => {
    let stdout = "";
    let gitCalled = false;
    const code = await main({
      argv: ["sync", "--env-dir", envDir, "--dir", kbDir, "--message", "kb: x"],
      git: (() => { gitCalled = true; return OK; }) as Runner,
      readStdin: async () => { throw new Error("stdin must never be read on a shape refusal"); },
      writeStdout: (s) => { stdout += s; },
      writeStderr: () => {},
    });
    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expect(gitCalled).toBe(false);
  });

  test("main(): preflight with a MISMATCHED config refuses env_dir_not_in_config, zero git calls", async () => {
    let stdout = "";
    let stderr = "";
    let gitCalls = 0;
    const code = await main({
      argv: ["preflight", "--env-dir", envDir, "--dir", kbDir, "--config-path", CONFIG_PATH],
      git: (() => { gitCalls++; return OK; }) as Runner,
      ...mainTrustDeps({ readConfig: () => shipConfigText({ envDir: "/a/different/repo" }) }),
      writeStdout: (s) => { stdout += s; },
      writeStderr: (s) => { stderr += s; },
    });
    expect(code).not.toBe(0);
    expect(JSON.parse(stdout).reason).toBe("env_dir_not_in_config");
    expect(stderr).toContain("env_dir_not_in_config");
    expect(gitCalls).toBe(0);
  });

  test("the usage line names --config-path on both verbs", async () => {
    let stderr = "";
    await main({ argv: ["bogus"], writeStdout: () => {}, writeStderr: (s) => { stderr += s; } });
    const lines = stderr.trim().split("\n");
    expect(lines.length).toBe(2);
    for (const line of lines) expect(line).toContain("--config-path");
  });
});

// --- 12d. R5/F2: the runbook actually PASSES the flag the module now requires -----------------

describe("R5/F2: commands/drawbar-ship.md invokes both verbs with --config-path", () => {
  // Making `--config-path` required is a breaking change to the CLI contract. Without this pin,
  // the module refuses and the shipped runbook halts on every run — green tests and a broken
  // command. Both fences also have to re-declare $CONFIG, since no shell state survives between
  // Bash tool calls.
  const shipMd = readFileSync(join(import.meta.dir, "..", "..", "commands", "drawbar-ship.md"), "utf8");

  for (const verb of ["preflight", "sync"]) {
    test(`the ${verb} invocation carries --config-path`, () => {
      // Each invocation is a backslash-continued multi-line command; join continuations first so
      // the flag is found even when it sits on the next physical line.
      const joined = shipMd.replace(/\\\n\s*/g, " ");
      // `bun run` narrows this to real invocations — prose and `echo "REFUSING: kb-sync.ts sync
      // exited ..."` lines also mention the verb and must not be mistaken for one.
      const invocations = joined
        .split("\n")
        .filter((l: string) => l.includes("bun run") && l.includes(`kb-sync.ts" ${verb} `));
      expect(invocations.length).toBeGreaterThan(0); // non-vacuous: the invocation exists at all
      for (const line of invocations) expect(line).toContain("--config-path");
    });
  }

  test("§6 re-declares CONFIG rather than assuming Preflight's shell state survived", () => {
    const sectionSix = shipMd.slice(shipMd.indexOf("## 6. Capture and sync knowledge"));
    expect(sectionSix).toContain("DRAWBAR_SHIP_CONFIG");
    expect(sectionSix).toContain("CONFIG_REAL");
  });
});

// --- 13. preflight -----------------------------------------------------------------------------

describe("knowledgePreflight", () => {
  test("dirty knowledge repo -> fail", () => {
    const { git } = makeGitSpy({ status: { code: 0, stdout: " M knowledge.jsonl\n", stderr: "" } });
    const fs = fakeFs(new Set([join(envDir, ".drawbar", "runs", ".gitignore")]));
    const result = knowledgePreflight({ envDir, kbDir, git, ...fs, ...trustDeps() });
    expect(result).toMatchObject({ ok: false, reason: "knowledge_repo_dirty" });
  });

  // Symmetrical with syncKnowledge's own "untracked files never read as dirty" test — Locked
  // 16's preflight dirty check must use the SAME untracked-tolerant rule syncKnowledge's own
  // precondition uses, not merely happen to behave the same way today.
  test("the status call actually carries --untracked-files=no", () => {
    const { git, calls } = makeGitSpy(); // CLEAN_STATUS: the runner reports no dirt
    const fs = fakeFs(new Set([join(envDir, ".drawbar", "runs", ".gitignore")]));
    const result = knowledgePreflight({ envDir, kbDir, git, ...fs, ...trustDeps() });
    expect(result.ok).toBe(true);
    const statusCall = calls.find((c) => c[2] === "status")!;
    expect(statusCall).toBeDefined();
    expect(statusCall).toContain("--untracked-files=no");
  });

  test("check-attr reporting anything but union on the ACTIVE path -> fail, naming it", () => {
    const { git } = makeGitSpy({
      checkAttr: (argv) => (argv.some((a) => a.endsWith("knowledge.jsonl")) ? { code: 0, stdout: "p: merge: unspecified\n" } : UNION_ATTR),
    });
    const fs = fakeFs(new Set([join(envDir, ".drawbar", "runs", ".gitignore")]));
    const result = knowledgePreflight({ envDir, kbDir, git, ...fs, ...trustDeps() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("check_attr_not_union");
      expect(result.detail).toContain("knowledge.jsonl");
    }
  });

  test("check-attr reporting anything but union on the ARCHIVE path -> fail, naming it (proves BOTH paths are checked)", () => {
    const { git } = makeGitSpy({
      checkAttr: (argv) => (argv.some((a) => a.endsWith("knowledge.archive.jsonl")) ? { code: 0, stdout: "p: merge: unspecified\n" } : UNION_ATTR),
    });
    const fs = fakeFs(new Set([join(envDir, ".drawbar", "runs", ".gitignore")]));
    const result = knowledgePreflight({ envDir, kbDir, git, ...fs, ...trustDeps() });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("check_attr_not_union");
      expect(result.detail).toContain("knowledge.archive.jsonl");
    }
  });

  test("missing .drawbar/runs/.gitignore -> CREATED, reported as success (not a failure)", () => {
    const { git } = makeGitSpy();
    const fs = fakeFs(new Set()); // absent
    const result = knowledgePreflight({ envDir, kbDir, git, ...fs, ...trustDeps() });
    expect(result).toEqual({ ok: true, gitignoreCreated: true });
    const gitignorePath = join(envDir, ".drawbar", "runs", ".gitignore");
    expect(fs.written[gitignorePath]).toBeDefined();
    expect(fs.written[gitignorePath]!.length).toBeGreaterThan(0);
    expect(fs.written[gitignorePath]).toContain("!.gitignore");
  });

  test("present .drawbar/runs/.gitignore -> left alone", () => {
    const { git } = makeGitSpy();
    const gitignorePath = join(envDir, ".drawbar", "runs", ".gitignore");
    const fs = fakeFs(new Set([gitignorePath]));
    const result = knowledgePreflight({ envDir, kbDir, git, ...fs, ...trustDeps() });
    expect(result).toEqual({ ok: true, gitignoreCreated: false });
    expect(Object.keys(fs.written).length).toBe(0);
  });

  // --- R5/F4 M9: the mkdir is load-bearing, and a write failure is a REASON, not a throw ------

  test("M9: the runs dir is created (recursively) BEFORE the .gitignore is written", () => {
    const { git } = makeGitSpy();
    const fs = fakeFs(new Set()); // absent, so the assert-or-create path runs
    const runsDir = join(envDir, ".drawbar", "runs");
    const result = knowledgePreflight({ envDir, kbDir, git, ...fs, ...trustDeps() });
    expect(result).toEqual({ ok: true, gitignoreCreated: true });
    expect(fs.mkdirCalls).toEqual([runsDir]);
    // `recursive` matters: on a genuine first run `.drawbar` itself does not exist either.
    expect(fs.mkdirOpts).toEqual([{ recursive: true }]);
    // The fake now throws ENOENT on a write into an uncreated directory, so this passing at all
    // is the proof the mkdir happened first — deleting it turns this into a failure rather than
    // a silent pass.
    expect(fs.written[join(runsDir, ".gitignore")]).toBeDefined();
  });

  test("M9: a write failure returns a NAMED reason, never an uncaught throw", () => {
    // On a real first run the old code let `writeFileSync`'s ENOENT propagate straight past
    // `PreflightResult` to the CLI's top-level `.catch` — a crash rather than a verdict. Any
    // write failure (ENOENT, EACCES, a full disk) is now a refusal with a reason.
    const { git } = makeGitSpy();
    const fs = fakeFs(new Set(), { failWrite: "EACCES: permission denied, open '.gitignore'" });
    let result: ReturnType<typeof knowledgePreflight>;
    expect(() => {
      result = knowledgePreflight({ envDir, kbDir, git, ...fs, ...trustDeps() });
    }).not.toThrow();
    expect(result!).toMatchObject({ ok: false, reason: "runs_gitignore_write_failed" });
    expect(result!.ok === false && result!.detail).toContain("EACCES");
  });

  test("M9: main() reports that write failure as a refusal with a non-zero exit, not a crash", async () => {
    let stdout = "";
    let stderr = "";
    const { git } = makeGitSpy();
    const code = await main({
      argv: ["preflight", "--env-dir", envDir, "--dir", kbDir, "--config-path", CONFIG_PATH],
      git,
      ...mainTrustDeps(),
      existsSync: () => false,
      mkdirSync: () => {},
      writeFileSync: () => { throw new Error("ENOSPC: no space left on device"); },
      writeStdout: (s) => { stdout += s; },
      writeStderr: (s) => { stderr += s; },
    });
    expect(code).not.toBe(0);
    expect(JSON.parse(stdout).reason).toBe("runs_gitignore_write_failed");
    expect(stderr).toContain("runs_gitignore_write_failed");
  });

  test("real reference content matches the shipped .gitignore fixture byte-for-byte", () => {
    // Cross-checks against the live checked-out reference this module's constant was copied
    // from, so the two can never silently drift.
    const { git } = makeGitSpy();
    const fs = fakeFs(new Set());
    knowledgePreflight({ envDir, kbDir, git, ...fs, ...trustDeps() });
    const written = fs.written[join(envDir, ".drawbar", "runs", ".gitignore")]!;
    expect(written).toBe("# /drawbar-ship run state (T0 story snapshots). Local scratch — never committed.\n*\n!.gitignore\n");
    expect(Buffer.byteLength(written, "utf8")).toBe(97);
  });
});

// --- 14. CLI flag discipline --------------------------------------------------------------------

describe("parseSyncCliArgs — flag discipline", () => {
  test("--env-dir with no value (boolean true) refuses", () => {
    const result = parseSyncCliArgs(["--env-dir", "--dir", "/tmp/a", "--message", "m"]);
    expect(result.ok).toBe(false);
  });

  test("a repeated flag refuses", () => {
    const result = parseSyncCliArgs(["--env-dir", "/tmp/a", "--env-dir", "/tmp/b", "--dir", "/tmp/c", "--message", "m"]);
    expect(result.ok).toBe(false);
  });

  test("an unknown flag refuses", () => {
    const result = parseSyncCliArgs(["--bogus", "x", "--env-dir", "/tmp/a", "--dir", "/tmp/b", "--message", "m"]);
    expect(result.ok).toBe(false);
  });

  test("a relative --env-dir refuses", () => {
    const result = parseSyncCliArgs(["--env-dir", "relative/path", "--dir", "/tmp/b", "--message", "m"]);
    expect(result.ok).toBe(false);
  });

  test("a --dir carrying a .. segment refuses", () => {
    const result = parseSyncCliArgs(["--env-dir", "/tmp/a", "--dir", "/tmp/../etc", "--message", "m"]);
    expect(result.ok).toBe(false);
  });

  test("a well-formed invocation parses", () => {
    const result = parseSyncCliArgs([
      "--env-dir", "/tmp/a", "--dir", "/tmp/b", "--message", "kb: x", "--config-path", "/tmp/ship.config.json",
    ]);
    expect(result).toEqual({
      ok: true, envDir: "/tmp/a", dir: "/tmp/b", message: "kb: x", configPath: "/tmp/ship.config.json",
    });
  });
});

describe("parsePreflightCliArgs — flag discipline", () => {
  test("--dir with no value (boolean true) refuses", () => {
    const result = parsePreflightCliArgs(["--env-dir", "/tmp/a", "--dir"]);
    expect(result.ok).toBe(false);
  });

  test("a repeated flag refuses", () => {
    const result = parsePreflightCliArgs(["--dir", "/tmp/a", "--dir", "/tmp/b", "--env-dir", "/tmp/c"]);
    expect(result.ok).toBe(false);
  });

  test("an unknown flag refuses", () => {
    const result = parsePreflightCliArgs(["--env-dir", "/tmp/a", "--dir", "/tmp/b", "--nope", "x"]);
    expect(result.ok).toBe(false);
  });

  test("a relative --dir refuses", () => {
    const result = parsePreflightCliArgs(["--env-dir", "/tmp/a", "--dir", "relative"]);
    expect(result.ok).toBe(false);
  });
});

describe("main() end-to-end: every misuse case exits non-zero with empty stdout", () => {
  test("sync: missing --message — non-zero, empty stdout, never touches git or stdin", async () => {
    let stdout = "";
    let gitCalled = false;
    const code = await main({
      argv: ["sync", "--env-dir", envDir, "--dir", kbDir],
      git: (() => { gitCalled = true; return OK; }) as Runner,
      readStdin: async () => { throw new Error("stdin must never be read on a shape refusal"); },
      writeStdout: (s) => { stdout += s; },
      writeStderr: () => {},
    });
    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expect(gitCalled).toBe(false);
  });

  test("unknown verb — non-zero, empty stdout", async () => {
    let stdout = "";
    const code = await main({ argv: ["bogus-verb"], writeStdout: (s) => { stdout += s; }, writeStderr: () => {} });
    expect(code).not.toBe(0);
    expect(stdout).toBe("");
  });
});

// --- 15. real-runner ENOENT is caught (git genuinely absent from PATH) -----------------------

describe("real runner: a missing git binary fails closed, not an uncaught throw", () => {
  // MUST-CHECK path-scrubbed-proof-must-not-hide-the-runner-itself: PATH is scrubbed down to
  // bun's OWN directory — `git` is genuinely gone, but the interpreter under test is still
  // reachable, so a pass here means the module fails closed rather than the harness failing to
  // start. Every git call in these subprocesses goes through the REAL `makeRealRunner`, whose
  // try/catch turns the missing binary into code 127.
  //
  // R5/F2: these are also the only tests that exercise the trust root through a REAL
  // `readFileSync`, so a genuine `ship.config.json` is written to disk here.
  function writeRealConfig(): string {
    const configPath = join(envDir, "ship.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        envDir,
        projectDir: join(envDir, "project-elsewhere"),
        repo: "org/repo",
        team: "PCO",
        baseBranch: "main",
        requiredChecks: ["build"],
      }),
    );
    return configPath;
  }

  // `err` is returned as well as `out` because main()'s DEFAULT `writeStderr` is itself a seam
  // with no other coverage — every in-process test injects its own. See the "the refusal reaches
  // the real stderr" test below.
  // R7: `DRAWBAR_SHIP_CONFIG` is exported into the subprocess because it IS the trust root's
  // anchor — the module re-derives the expected config path from the environment it inherits, via
  // ship-config.ts's own `resolveConfigPath`, and refuses a `--config-path` that disagrees. These
  // subprocesses are therefore the only place the REAL anchor and the REAL `realpathSync` default
  // are exercised; every in-process test injects an identity `realpath`.
  async function runScrubbed(
    args: string[],
    stdinText?: string,
    envOver: Record<string, string> = {},
  ): Promise<{ code: number; out: string; err: string }> {
    const bunDir = dirname(process.execPath);
    const scriptPath = join(import.meta.dir, "kb-sync.ts");
    const configIdx = args.indexOf("--config-path");
    const proc = Bun.spawn(["bun", "run", scriptPath, ...args], {
      env: {
        PATH: bunDir,
        ...(configIdx === -1 ? {} : { DRAWBAR_SHIP_CONFIG: args[configIdx + 1]! }),
        ...envOver,
      },
      stdin: stdinText === undefined ? "ignore" : new TextEncoder().encode(stdinText),
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    return { code: await proc.exited, out, err };
  }

  test("preflight against a real subprocess with PATH holding only bun's own directory", async () => {
    const configPath = writeRealConfig();
    const { code, out } = await runScrubbed([
      "preflight", "--env-dir", envDir, "--dir", kbDir, "--config-path", configPath,
    ]);
    expect(code).not.toBe(0);
    const parsed = JSON.parse(out); // throws if the CLI crashed instead of writing well-formed JSON
    expect(parsed.ok).toBe(false);
    // Reaching `status_failed` proves the real config file was read and the trust root PASSED —
    // a trust-root refusal would have reported one of its own three reasons instead.
    expect(parsed.reason).toBe("status_failed");
  });

  test("sync against a real subprocess with PATH scrubbed: the new check-ignore call fails closed too", async () => {
    const configPath = writeRealConfig();
    seedActive(); // so there IS a candidate, making check-ignore the first git call of the loop
    const { code, out } = await runScrubbed(
      ["sync", "--env-dir", envDir, "--dir", kbDir, "--message", "kb: scrubbed", "--config-path", configPath],
      JSON.stringify({ lessons: [] }),
    );
    expect(code).not.toBe(0);
    const parsed = JSON.parse(out);
    expect(parsed.ok).toBe(false);
    // R5/F1's new call is reached and its non-0/1 branch (127 from the real runner's ENOENT
    // catch) is taken — never an uncaught throw, and never mistaken for "not ignored".
    expect(parsed.reason).toBe("check_ignore_failed");
  });

  test("sync against a real subprocess: a MISMATCHED real config file refuses before any git call", async () => {
    const configPath = join(envDir, "ship.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        envDir: "/somewhere/else/entirely",
        projectDir: "/abs/project",
        repo: "org/repo",
        team: "PCO",
        baseBranch: "main",
        requiredChecks: ["build"],
      }),
    );
    const { code, out } = await runScrubbed(
      ["sync", "--env-dir", envDir, "--dir", kbDir, "--message", "kb: scrubbed", "--config-path", configPath],
      JSON.stringify({ lessons: [] }),
    );
    expect(code).not.toBe(0);
    expect(JSON.parse(out).reason).toBe("env_dir_not_in_config");
  });

  // --- R6 seam sweep: main()'s DEFAULT writeStderr ------------------------------------------
  //
  // Every in-process test injects its own `writeStderr`, so `deps.writeStderr ?? process.stderr`
  // had no coverage at all: replacing that default with a no-op left the whole suite green while
  // the shipped CLI stopped telling the operator anything. Only a real subprocess can see it.
  // --- R7/T1: the anchor and the real `realpathSync`, through a real subprocess ---------------
  test("R7/T1: a real config file at a NON-anchored path is refused before any git call", async () => {
    // The real `realpathSync` default AND the real `resolveConfigPath(process.env, process.cwd())`
    // — every in-process test injects an identity `realpath` and a hand-built anchor, so this is
    // the only place both defaults run together. Both files really exist and both parse; only the
    // ANCHOR disagrees, which is precisely the reproduced attack (a config the caller supplied
    // rather than the one this environment names).
    const named = join(envDir, "named-ship.config.json");
    const anchored = join(envDir, "anchored-ship.config.json");
    for (const p of [named, anchored]) {
      writeFileSync(p, JSON.stringify({
        envDir, projectDir: join(envDir, "project-elsewhere"), repo: "org/repo",
        team: "PCO", baseBranch: "main", requiredChecks: ["build"],
      }));
    }
    const { code, out } = await runScrubbed(
      ["sync", "--env-dir", envDir, "--dir", kbDir, "--message", "kb: x", "--config-path", named],
      JSON.stringify({ lessons: [] }),
      { DRAWBAR_SHIP_CONFIG: anchored },
    );
    expect(code).not.toBe(0);
    expect(JSON.parse(out).reason).toBe("config_path_not_anchored");
  });

  test("R7/T1: the SAME real config, now anchored, gets past the trust root", async () => {
    // MUST-CHECK de-hardcode-test-fixture-must-vary-the-old-value: only the anchor changes between
    // this test and the one above. Reaching `check_ignore_failed` (git is genuinely absent) is the
    // proof the trust root PASSED — a trust-root refusal reports one of its own reasons instead.
    const configPath = writeRealConfig();
    seedActive();
    const { code, out } = await runScrubbed(
      ["sync", "--env-dir", envDir, "--dir", kbDir, "--message", "kb: x", "--config-path", configPath],
      JSON.stringify({ lessons: [] }),
      { DRAWBAR_SHIP_CONFIG: configPath },
    );
    expect(code).not.toBe(0);
    expect(JSON.parse(out).reason).toBe("check_ignore_failed");
  });

  test("a refusal reaches the REAL stderr through main()'s default writeStderr", async () => {
    const configPath = writeRealConfig();
    const { code, err } = await runScrubbed([
      "preflight", "--env-dir", envDir, "--dir", kbDir, "--config-path", configPath,
    ]);
    expect(code).not.toBe(0);
    expect(err).toContain("refused: status_failed");
  });
});

// --- 16. R6 seam sweep: the DEFAULT seams main() binds when no dep is injected ----------------
//
// Every seam above is exercised through an injected fake. The DEFAULTS main() falls back to are
// a separate thing, and a mutation sweep found three of them uncovered: `makeRealRunner("git")`
// could name any binary at all, and the `mkdirSync`/`writeFileSync` deps could be wired to each
// other's parameter, with the suite staying green in every case.
//
// The proof is a real subprocess whose PATH holds exactly two directories: bun's own (so the
// interpreter under test can start) and a temp dir holding a SHIM the test writes itself, named
// `git`. MUST-CHECK path-scrubbed-proof-must-not-hide-the-runner-itself is satisfied in the
// stronger direction here — real git is still genuinely absent and nothing in this test needs it,
// but the shim answers ONLY if the default runner spawns a binary literally named `git`. Rename
// that binary in kb-sync.ts and the shim is unreachable, the runner's ENOENT catch returns 127,
// and this test fails.

describe("R6: main()'s default seams are wired to the real thing (git shim, real git still absent)", () => {
  // /bin/sh by absolute path, and only shell builtins inside — the shim needs no PATH lookup of
  // its own, so it works in the scrubbed environment.
  function writeGitShim(dir: string, logPath: string, mergeAttr: string): string {
    const shim = join(dir, "git");
    writeFileSync(
      shim,
      "#!/bin/sh\n" +
        `echo "$*" >> ${JSON.stringify(logPath)}\n` +
        // argv is always `-C <dir> <subcommand> ...` — MUST-CHECK
        // injected-runner-no-cwd-silently-inherits-caller-directory means $3 is the subcommand.
        'case "$3" in\n' +
        "  ls-files) exit 1 ;;\n" + // R7 trust root: the config is NOT tracked
        "  status) exit 0 ;;\n" + // clean tree
        `  check-attr) echo "$6: merge: ${mergeAttr}" ; exit 0 ;;\n` +
        "  check-ignore) exit 1 ;;\n" + // R7: neither knowledge path is gitignored
        '  *) echo "shim: unexpected subcommand $3" >&2 ; exit 99 ;;\n' +
        "esac\n",
    );
    chmodSync(shim, 0o755);
    return shim;
  }

  async function runWithShim(
    args: string[],
    mergeAttr = "union",
  ): Promise<{ code: number; out: string; err: string; log: string[] }> {
    const shimDir = mkdtempSync(join(tmpdir(), "kb-sync-shim-"));
    const logPath = join(shimDir, "calls.log");
    writeGitShim(shimDir, logPath, mergeAttr);
    const bunDir = dirname(process.execPath);
    const configIdx = args.indexOf("--config-path");
    const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "kb-sync.ts"), ...args], {
      env: {
        PATH: `${shimDir}:${bunDir}`,
        ...(configIdx === -1 ? {} : { DRAWBAR_SHIP_CONFIG: args[configIdx + 1]! }),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    const log = existsSync(logPath) ? readFileSync(logPath, "utf8").trim().split("\n").filter((l) => l.length > 0) : [];
    return { code, out, err, log };
  }

  test("preflight succeeds end to end: the default runner spawns `git`, and the default fs seams do the real work", async () => {
    const configPath = join(envDir, "ship.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        envDir, projectDir: join(envDir, "project-elsewhere"), repo: "org/repo",
        team: "PCO", baseBranch: "main", requiredChecks: ["build"],
      }),
    );
    const runsDir = join(envDir, ".drawbar", "runs");
    const gitignorePath = join(runsDir, ".gitignore");
    expect(existsSync(runsDir)).toBe(false); // non-vacuous: neither the dir nor the file exists yet

    const { code, out, log } = await runWithShim([
      "preflight", "--env-dir", envDir, "--dir", kbDir, "--config-path", configPath,
    ]);

    // A verdict the shim alone can produce. With the default runner naming any other binary the
    // spawn ENOENTs to 127 and this is `status_failed` with a non-zero exit instead.
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ ok: true, gitignoreCreated: true });

    // The shim really was invoked, with the calls this verb makes. The trust root's `ls-files`
    // comes FIRST and is anchored at the config's directory; everything after it is `-C <envDir>`.
    expect(log.length).toBe(6); // ls-files, status, check-attr x2, check-ignore x2
    expect(log[0]).toBe(`-C ${envDir} ls-files --error-unmatch ${configPath}`);
    expect(log[1]).toBe(`-C ${envDir} status --porcelain --untracked-files=no`);
    expect(log[2]).toContain("check-attr merge --");
    expect(log[2]).toContain("knowledge.jsonl");
    expect(log[3]).toContain("knowledge.archive.jsonl");
    expect(log[4]).toContain("check-ignore -q --");
    expect(log[5]).toContain("knowledge.archive.jsonl");
    for (const line of log) expect(line.startsWith(`-C ${envDir} `)).toBe(true);

    // ...and the DEFAULT mkdirSync/writeFileSync/existsSync seams did the real work on the real
    // filesystem. Wired to each other's parameter, the mkdir writes a file where the runs dir
    // belongs, the write ENOENTs, and this is `runs_gitignore_write_failed` instead.
    expect(existsSync(gitignorePath)).toBe(true);
    expect(readFileSync(gitignorePath, "utf8")).toBe(
      "# /drawbar-ship run state (T0 story snapshots). Local scratch — never committed.\n*\n!.gitignore\n",
    );
  });

  test("preflight reports the shim's own refusal, so the runner's stdout/exit code are genuinely read", async () => {
    // MUST-CHECK de-hardcode-test-fixture-must-vary-the-old-value: the test above would also pass
    // if the module ignored the runner and hardcoded `ok: true`. Here the shim's `check-attr`
    // answer is the only thing that changed, and the verdict has to change with it.
    const configPath = join(envDir, "ship.config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        envDir, projectDir: join(envDir, "project-elsewhere"), repo: "org/repo",
        team: "PCO", baseBranch: "main", requiredChecks: ["build"],
      }),
    );
    // The same shim, with its `check-attr` answer changed to `unspecified`.
    const { code, out, log } = await runWithShim(
      ["preflight", "--env-dir", envDir, "--dir", kbDir, "--config-path", configPath],
      "unspecified",
    );
    expect(log.length).toBeGreaterThan(0); // the shim was reached at all
    expect(code).not.toBe(0);
    expect(JSON.parse(out).reason).toBe("check_attr_not_union");
  });
});

// --- 17. R6 seam sweep: the remaining uncovered seams ----------------------------------------
//
// A mutation sweep over EVERY injected seam (`git`, `sleep`, `existsSync`, `writeFileSync`,
// `mkdirSync`, `readConfig`, `readStdin`, `writeStdout`, `writeStderr`, `argv`) found the
// following mutants alive. Each block below is the test that kills one.

describe("R6 seam `sleep`: the backoff SCHEDULE is pinned, not merely that a sleep happens", () => {
  // Three mutants survived here: sleeping after the FINAL attempt too (a pointless extra second
  // before reporting exhaustion), an off-by-one that drops one backoff, and `sleep(0)` — no
  // backoff at all, so a retry races the very rebase it is waiting on. Nothing asserted the count
  // or the duration, only that the injected sleep was reached at all.
  function recordingSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
    const waits: number[] = [];
    return { sleep: async (ms: number) => { waits.push(ms); }, waits };
  }

  test("three exhausted attempts sleep exactly TWICE — between attempts, never after the last — for a full second each", async () => {
    seedActive();
    const { git, calls } = makeGitSpy({ pushQueue: [{ code: 1, stderr: "[rejected]" }] });
    const { sleep, waits } = recordingSleep();
    const result = await syncKnowledge(baseInput({ sleep }, git));
    expect(result).toMatchObject({ ok: false, reason: "attempts_exhausted", attempts: 3 });
    expect(calls.filter((c) => c[2] === "push").length).toBe(3); // non-vacuous: three real attempts
    // N attempts have N-1 gaps. A third entry means the loop waited after the last push for
    // nothing; a single entry means one retry fired with no backoff at all; `0` means the backoff
    // is nominal only.
    expect(waits).toEqual([1000, 1000]);
  });

  test("a sync that succeeds on the first attempt never sleeps at all", async () => {
    seedActive();
    const { git } = makeGitSpy();
    const { sleep, waits } = recordingSleep();
    const result = await syncKnowledge(baseInput({ sleep }, git));
    expect(result).toMatchObject({ ok: true, attempts: 1 });
    expect(waits).toEqual([]);
  });

  test("one retry then success sleeps exactly once", async () => {
    seedActive();
    const { git } = makeGitSpy({ pushQueue: [{ code: 1, stderr: "[rejected]" }, OK] });
    const { sleep, waits } = recordingSleep();
    const result = await syncKnowledge(baseInput({ sleep }, git));
    expect(result).toMatchObject({ ok: true, attempts: 2 });
    expect(waits).toEqual([1000]);
  });
});

describe("R6 input `maxAttempts`: the caller-supplied cap is honoured, not the module default", () => {
  test("attempts and push calls both track the supplied maxAttempts", async () => {
    // The `maxAttempts` input had NO test at all: replacing `input.maxAttempts ?? DEFAULT` with a
    // bare `DEFAULT` left the suite green. MUST-CHECK
    // de-hardcode-test-fixture-must-vary-the-old-value: none of the values below is the default
    // 3, so a re-hardcoding to the default fails on every one of them.
    seedActive();
    for (const max of [1, 2, 5]) {
      const { git, calls } = makeGitSpy({ pushQueue: [{ code: 1, stderr: "[rejected]" }] });
      const result = await syncKnowledge(baseInput({ maxAttempts: max, sleep: noopSleep() }, git));
      expect(result).toMatchObject({ ok: false, reason: "attempts_exhausted", attempts: max });
      expect(calls.filter((c) => c[2] === "push").length).toBe(max);
    }
  });
});

describe("R6 seams `mkdirSync`/`writeFileSync`: main() wires each to its OWN parameter", () => {
  test("mkdirSync receives the runs DIRECTORY, writeFileSync receives the .gitignore FILE", async () => {
    // Swapping the two in main()'s knowledgePreflight call left the suite green: the one existing
    // main()-level test made writeFileSync throw and mkdirSync a no-op, so a swap still produced
    // the same `runs_gitignore_write_failed`. Distinct recording spies are what tell them apart.
    const mkdirs: Array<[string, { recursive: boolean }]> = [];
    const writes: Array<[string, string]> = [];
    const { git } = makeGitSpy();
    let stdout = "";
    const code = await main({
      argv: ["preflight", "--env-dir", envDir, "--dir", kbDir, "--config-path", CONFIG_PATH],
      git,
      ...mainTrustDeps(),
      existsSync: () => false, // so the assert-or-create path runs
      mkdirSync: (p: string, o: { recursive: boolean }) => { mkdirs.push([p, o]); },
      writeFileSync: (p: string, c: string) => { writes.push([p, c]); },
      writeStdout: (s) => { stdout += s; },
      writeStderr: () => {},
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ ok: true, gitignoreCreated: true });
    const runsDir = join(envDir, ".drawbar", "runs");
    expect(mkdirs).toEqual([[runsDir, { recursive: true }]]);
    expect(writes.length).toBe(1);
    expect(writes[0]![0]).toBe(join(runsDir, ".gitignore"));
    expect(writes[0]![1]).toContain("!.gitignore");
  });
});

describe("R6: refusal details are SANITIZED before reaching stderr", () => {
  // `sanitizeForOutput` could be dropped from either verb's refusal path with the suite staying
  // green — every stderr assertion only looked for the reason NAME. JSON.stringify already escapes
  // C0 controls, so the load-bearing half of the sanitizer is the invisible/bidi block below,
  // which JSON.stringify passes through untouched. A hostile filename in `git status`'s output
  // must not be able to reorder or hide lines in the text an agent reads back.
  const HOSTILE = " M evil‮name​.txt\n";

  test("sync: a hostile filename in the dirty-precondition detail is scrubbed on stderr", async () => {
    let stdout = "";
    let stderr = "";
    const { git } = makeGitSpy({ status: { code: 0, stdout: HOSTILE, stderr: "" } });
    const code = await main({
      argv: ["sync", "--env-dir", envDir, "--dir", kbDir, "--message", "kb: x", "--config-path", CONFIG_PATH],
      readStdin: async () => JSON.stringify({ lessons: [] }),
      ...mainTrustDeps(),
      git,
      sleep: noopSleep(),
      writeStdout: (s) => { stdout += s; },
      writeStderr: (s) => { stderr += s; },
    });
    expect(code).not.toBe(0);
    expect(JSON.parse(stdout).reason).toBe("dirty_precondition");
    expect(stderr).toContain("dirty_precondition");
    expect(stderr).not.toContain("‮"); // RIGHT-TO-LEFT OVERRIDE
    expect(stderr).not.toContain("​"); // ZERO WIDTH SPACE
    expect(stderr).toContain("�"); // ...replaced, not merely dropped
    expect(stderr).toContain("name"); // and the legible text survives intact
  });

  test("preflight: a hostile filename in the dirty-repo detail is scrubbed on stderr", async () => {
    let stdout = "";
    let stderr = "";
    const { git } = makeGitSpy({ status: { code: 0, stdout: HOSTILE, stderr: "" } });
    const fs = fakeFs(new Set([join(envDir, ".drawbar", "runs", ".gitignore")]));
    const code = await main({
      argv: ["preflight", "--env-dir", envDir, "--dir", kbDir, "--config-path", CONFIG_PATH],
      ...mainTrustDeps(),
      git,
      existsSync: fs.existsSync,
      mkdirSync: fs.mkdirSync,
      writeFileSync: fs.writeFileSync,
      writeStdout: (s) => { stdout += s; },
      writeStderr: (s) => { stderr += s; },
    });
    expect(code).not.toBe(0);
    expect(JSON.parse(stdout).reason).toBe("knowledge_repo_dirty");
    expect(stderr).toContain("knowledge_repo_dirty");
    expect(stderr).not.toContain("‮");
    expect(stderr).not.toContain("​");
    expect(stderr).toContain("�");
    expect(stderr).toContain("name");
  });
});

describe("R6: check-attr's value is read from the LAST marker, not the first", () => {
  test("a path that itself contains `: merge: ` still parses as union", () => {
    // `parseCheckAttrValue` uses lastIndexOf deliberately — git prints `<path>: merge: <value>`
    // and the PATH comes first. Switched to indexOf, the parser reads the rest of the path as the
    // attribute value and refuses a correctly-configured repo; nothing caught that.
    const { git } = makeGitSpy({
      checkAttr: { code: 0, stdout: "odd: merge: dir/knowledge.jsonl: merge: union\n" },
    });
    const fs = fakeFs(new Set([join(envDir, ".drawbar", "runs", ".gitignore")]));
    const result = knowledgePreflight({ envDir, kbDir, git, ...fs, ...trustDeps() });
    expect(result).toEqual({ ok: true, gitignoreCreated: false });
  });
});

describe("R6: a valueless flag is refused on its OWN terms, distinctly from an empty value", () => {
  // MUST-CHECK cli-flag-boolean-true-fails-open. Collapsing the boolean-`true` branch into the
  // empty-string branch still refuses today, so every `expect(result.ok).toBe(false)` stayed
  // green — the two branches are only provably distinct once the messages are pinned.
  test("parseSyncCliArgs distinguishes `--config-path` with no value from `--config-path \"\"`", () => {
    expect(parseSyncCliArgs(["--env-dir", "/tmp/a", "--dir", "/tmp/b", "--message", "m", "--config-path"]))
      .toEqual({ ok: false, error: "--config-path requires a value" });
    expect(parseSyncCliArgs(["--env-dir", "/tmp/a", "--dir", "/tmp/b", "--message", "m", "--config-path", ""]))
      .toEqual({ ok: false, error: "--config-path value must not be empty" });
  });

  test("parsePreflightCliArgs distinguishes them too", () => {
    expect(parsePreflightCliArgs(["--env-dir", "/tmp/a", "--dir", "/tmp/b", "--config-path"]))
      .toEqual({ ok: false, error: "--config-path requires a value" });
    expect(parsePreflightCliArgs(["--env-dir", "/tmp/a", "--dir", "/tmp/b", "--config-path", ""]))
      .toEqual({ ok: false, error: "--config-path value must not be empty" });
  });
});

describe("R6: every pathspec is RELATIVE to the -C directory, never absolute", () => {
  test("check-ignore, add, diff and commit all name repo-relative paths", async () => {
    // The paths are computed with `relative(envDir, ...)` on purpose: every call is anchored
    // `-C <envDir>`, so the pathspec is interpreted inside THAT repo. Handing git absolute paths
    // instead happens to work while kbDir sits under envDir and silently stops being a
    // repo-relative pathspec when it does not — and every existing assertion used
    // `.endsWith("knowledge.jsonl")`, which cannot tell the two apart.
    seedActive();
    seedArchive();
    const { git, calls } = makeGitSpy();
    const result = await syncKnowledge(baseInput({}, git));
    expect(result.ok).toBe(true);

    const expected = [
      relative(envDir, storePaths(kbDir).active),
      relative(envDir, storePaths(kbDir).archive),
    ];
    expect(expected).toEqual([".drawbar/memory/knowledge.jsonl", ".drawbar/memory/knowledge.archive.jsonl"]);

    for (const sub of ["add", "diff", "commit"]) {
      const call = calls.find((c) => c[2] === sub)!;
      expect(call).toBeDefined();
      expect(call.slice(call.indexOf("--") + 1)).toEqual(expected);
    }
    const ignoreCalls = calls.filter((c) => c[2] === "check-ignore");
    expect(ignoreCalls.map((c) => c[c.length - 1])).toEqual(expected);
    // The trust root's `ls-files` names the CONFIG file, which is absolute by contract and by
    // design — it is not a pathspec inside envDir — so it is excluded here and asserted separately.
    for (const c of calls.filter((x) => !isTrustRootCall(x))) {
      for (const a of c.slice(3)) expect(isAbsolute(a)).toBe(false);
    }
  });
});

describe("R6 seam `sleep`: main()'s DEFAULT binding is a real timer, not a no-op", () => {
  // The one test in this file that spends real wall-clock time (~1s, a single backoff). It earns
  // that cost: `deps.sleep ?? (ms => setTimeout(...))` was the last seam with no coverage at all,
  // because every other test injects its own sleep. Replacing that default with `async () => {}`
  // — retries firing instantly, racing the very rebase they are waiting on — left the entire
  // suite green, and so did a default that ignored `ms` and waited 1ms. One retry is the cheapest
  // observation that tells a real timer from either.
  test("a single retry through main() really waits out RETRY_SLEEP_MS", async () => {
    seedActive();
    const { git, calls } = makeGitSpy({ pushQueue: [{ code: 1, stderr: "[rejected]" }, OK] });
    let stdout = "";
    const started = Date.now();
    const code = await main({
      argv: ["sync", "--env-dir", envDir, "--dir", kbDir, "--message", "kb: x", "--config-path", CONFIG_PATH],
      readStdin: async () => JSON.stringify({ lessons: [] }),
      ...mainTrustDeps(),
      git, // deliberately NO `sleep` — the default is what is under test
      writeStdout: (s) => { stdout += s; },
      writeStderr: () => {},
    });
    const elapsed = Date.now() - started;
    expect(code).toBe(0);
    expect(JSON.parse(stdout).attempts).toBe(2); // non-vacuous: a retry genuinely happened
    expect(calls.filter((c) => c[2] === "push").length).toBe(2);
    // Exactly one backoff of RETRY_SLEEP_MS. The lower bound absorbs timer coarseness while still
    // failing a 1ms or zero wait; the upper bound keeps this a measurement of the delay rather
    // than an assertion that merely *some* time passed.
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(5000);
  });
});

// --- 18. R7/T1: the trust root is no longer a TAUTOLOGY ---------------------------------------
//
// R5 required `--config-path` and compared the config's `envDir` to `--env-dir`. Both values came
// from the same argv, so the equality proved nothing: reproduced against the real CLI with no
// fakes, a caller wrote its own `{"envDir":"<hostile dir>"}` config, named it as its own trust
// root, and a `reference-transaction` hook in that directory executed on the commit this loop
// makes. Verbatim the corollary in MUST-CHECK path-from-mutable-state-into-git-C-is-code-execution:
// "if the new observation is anchored at a path taken from the same untrusted object, the tautology
// just moved one indirection deeper."
//
// Two checks close it, and neither is an equality between two argv values: the config must resolve
// to the path THIS PROCESS's own `$DRAWBAR_SHIP_CONFIG`/cwd resolve to, and it must not be tracked
// by git.

describe("R7/T1: --config-path must be the path this environment's own config resolution names", () => {
  // MUST-CHECK call-counter-spy-proves-dispatch-path-not-entered: returns SUCCESS, so a refusal
  // can never be mistaken for the spy failing the run some other way.
  function countingGit(): { git: Runner; calls: string[][] } {
    const calls: string[][] = [];
    return { git: ((argv: string[]) => { calls.push(argv); return { code: 0, stdout: "" }; }) as Runner, calls };
  }

  test("THE REPRODUCED ACE: a config the caller wrote itself, named as its own trust root, is refused", async () => {
    // The exact shape of the reproduction. `--env-dir` names the attacker's repository, and the
    // config handed to `--config-path` agrees with it perfectly — because the attacker wrote both.
    // What it cannot do is BE this environment's ship config.
    const hostile = mkdtempSync(join(tmpdir(), "kb-sync-hostile-"));
    const plantedConfig = join(hostile, "planted-ship.config.json");
    const { git, calls } = countingGit();
    const result = await syncKnowledge({
      envDir: hostile,
      kbDir: join(hostile, ".drawbar", "memory"),
      message: "kb: pwn",
      lessons: [entry({ key: "must-not-be-written" })],
      git,
      sleep: noopSleep(),
      configPath: plantedConfig,
      expectedConfigPath: CONFIG_PATH, // what the ENVIRONMENT says, and the attacker cannot set
      realpath: (p: string) => p,
      readConfig: () => JSON.stringify({
        envDir: hostile, projectDir: "/abs/project", repo: "org/repo",
        team: "PCO", baseBranch: "main", requiredChecks: ["build"],
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: "config_path_not_anchored", attempts: 0 });
    expect(result.ok === false && result.detail).toContain(plantedConfig);
    // No `git -C <hostile>` of any kind — the ACE sink is never reached...
    expect(calls.length).toBe(0);
    // ...and lessons[] never reached the store either.
    expect(existsSync(join(hostile, ".drawbar", "memory", "knowledge.jsonl"))).toBe(false);
  });

  test("preflight refuses the same planted config, also with zero git calls", () => {
    const hostile = mkdtempSync(join(tmpdir(), "kb-sync-hostile-pf-"));
    const { git, calls } = countingGit();
    const fs = fakeFs(new Set([join(hostile, ".drawbar", "runs", ".gitignore")]));
    const result = knowledgePreflight({
      envDir: hostile,
      kbDir: join(hostile, ".drawbar", "memory"),
      git,
      ...fs,
      ...trustDeps({
        configPath: join(hostile, "planted.json"),
        readConfig: () => JSON.stringify({
          envDir: hostile, projectDir: "/abs/project", repo: "org/repo",
          team: "PCO", baseBranch: "main", requiredChecks: ["build"],
        }),
      }),
    });
    expect(result).toMatchObject({ ok: false, reason: "config_path_not_anchored" });
    expect(calls.length).toBe(0);
  });

  test("the anchored config path IS accepted — the check is not simply `always refuse`", async () => {
    // MUST-CHECK de-hardcode-test-fixture-must-vary-the-old-value: the refusals above would all
    // still pass against `return refuse()`. This is the other half.
    seedActive();
    const { git, calls } = makeGitSpy();
    const result = await syncKnowledge(baseInput({}, git));
    expect(result.ok).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
  });

  test("the comparison is symlink-resolved, so the runbook's `readlink -f` form is accepted", async () => {
    // The shipped fence passes `$(readlink -f "$CONFIG")` while `$DRAWBAR_SHIP_CONFIG` may be
    // relative or itself a symlink. A raw string comparison would refuse the shipped invocation —
    // this is what proves the module accepts the two spellings of one file.
    seedActive();
    const configDir = mkdtempSync(join(tmpdir(), "kb-sync-cfgdir-"));
    const realConfig = join(configDir, "real-ship.config.json");
    const linkedConfig = join(configDir, "linked-ship.config.json");
    writeFileSync(realConfig, shipConfigText());
    symlinkSync(realConfig, linkedConfig);
    const { git } = makeGitSpy();
    const result = await syncKnowledge(
      baseInput(
        {
          // Two DIFFERENT literals for the same file, exactly as the runbook produces.
          configPath: realConfig,
          expectedConfigPath: linkedConfig,
          realpath: realpathSync, // the real thing, not the identity stub
          readConfig: () => shipConfigText(),
        },
        git,
      ),
    );
    expect(result.ok).toBe(true);
  });

  test("a config path that cannot be resolved at all refuses config_path_unresolvable, naming which side", () => {
    const fs = fakeFs(new Set([join(envDir, ".drawbar", "runs", ".gitignore")]));
    const { git, calls } = countingGit();
    const flagSide = knowledgePreflight({
      envDir, kbDir, git, ...fs,
      ...trustDeps({ realpath: (p: string) => { if (p === CONFIG_PATH) throw new Error("ENOENT: no such file"); return p; } }),
    });
    expect(flagSide).toMatchObject({ ok: false, reason: "config_path_unresolvable" });
    expect(flagSide.ok === false && flagSide.detail).toContain("--config-path");

    const otherAnchor = "/abs/elsewhere/ship.config.json";
    const anchorSide = knowledgePreflight({
      envDir, kbDir, git, ...fs,
      ...trustDeps({
        expectedConfigPath: otherAnchor,
        realpath: (p: string) => { if (p === otherAnchor) throw new Error("ENOENT: no such file"); return p; },
      }),
    });
    expect(anchorSide).toMatchObject({ ok: false, reason: "config_path_unresolvable" });
    expect(anchorSide.ok === false && anchorSide.detail).toContain("expected config");
    expect(calls.length).toBe(0);
  });

  test("main() derives the anchor from $DRAWBAR_SHIP_CONFIG, via ship-config.ts's own resolveConfigPath", async () => {
    seedActive();
    const { git } = makeGitSpy();
    let stdout = "";
    // Matching: the env names exactly the config the flag names.
    const okCode = await main({
      argv: ["sync", "--env-dir", envDir, "--dir", kbDir, "--message", "kb: x", "--config-path", CONFIG_PATH],
      readStdin: async () => JSON.stringify({ lessons: [] }),
      git, sleep: noopSleep(), ...mainTrustDeps(),
      writeStdout: (s) => { stdout += s; }, writeStderr: () => {},
    });
    expect(okCode).toBe(0);
    expect(JSON.parse(stdout).ok).toBe(true);

    // Diverging: the env names a DIFFERENT config. The flag value is unchanged.
    stdout = "";
    let gitCalls = 0;
    const badCode = await main({
      argv: ["sync", "--env-dir", envDir, "--dir", kbDir, "--message", "kb: x", "--config-path", CONFIG_PATH],
      readStdin: async () => JSON.stringify({ lessons: [] }),
      git: (() => { gitCalls++; return OK; }) as Runner,
      sleep: noopSleep(),
      readConfig: () => shipConfigText(),
      env: { DRAWBAR_SHIP_CONFIG: "/abs/somewhere/else/ship.config.json" },
      realpath: (p: string) => p,
      writeStdout: (s) => { stdout += s; }, writeStderr: () => {},
    });
    expect(badCode).not.toBe(0);
    expect(JSON.parse(stdout).reason).toBe("config_path_not_anchored");
    expect(gitCalls).toBe(0);
  });

  test("with $DRAWBAR_SHIP_CONFIG unset the anchor is <cwd>/.drawbar/ship.config.json — and it tracks cwd", async () => {
    // MUST-CHECK de-hardcode-test-fixture-must-vary-the-old-value: TWO different cwds, so an
    // anchor hardcoded to either one (or to the module's own directory) fails on the other.
    seedActive();
    for (const fakeCwd of ["/abs/first/project", "/abs/second/project"]) {
      const { git } = makeGitSpy();
      let stdout = "";
      const code = await main({
        argv: [
          "sync", "--env-dir", envDir, "--dir", kbDir, "--message", "kb: x",
          "--config-path", join(fakeCwd, ".drawbar/ship.config.json"),
        ],
        readStdin: async () => JSON.stringify({ lessons: [] }),
        git, sleep: noopSleep(),
        readConfig: () => shipConfigText(),
        env: {}, // no DRAWBAR_SHIP_CONFIG at all
        cwd: fakeCwd,
        realpath: (p: string) => p,
        writeStdout: (s) => { stdout += s; }, writeStderr: () => {},
      });
      expect(code).toBe(0);
      expect(JSON.parse(stdout).ok).toBe(true);
    }
    // ...and the OTHER cwd's path is refused for a given cwd, so the two are genuinely coupled.
    const { git } = makeGitSpy();
    let stdout = "";
    const code = await main({
      argv: [
        "sync", "--env-dir", envDir, "--dir", kbDir, "--message", "kb: x",
        "--config-path", "/abs/second/project/.drawbar/ship.config.json",
      ],
      readStdin: async () => JSON.stringify({ lessons: [] }),
      git, sleep: noopSleep(),
      readConfig: () => shipConfigText(),
      env: {}, cwd: "/abs/first/project", realpath: (p: string) => p,
      writeStdout: (s) => { stdout += s; }, writeStderr: () => {},
    });
    expect(code).not.toBe(0);
    expect(JSON.parse(stdout).reason).toBe("config_path_not_anchored");
  });

});

describe("R7/T1: a config TRACKED by git is refused — the repo's own config-file-must-not-be-tracked-by-git", () => {
  test("ls-files --error-unmatch exiting 0 refuses config_is_tracked, before any envDir call", async () => {
    seedActive();
    const { git, calls } = makeGitSpy({ lsFiles: TRACKED });
    const result = await syncKnowledge(baseInput({}, git));
    expect(result).toMatchObject({ ok: false, reason: "config_is_tracked", attempts: 0 });
    expect(result.ok === false && result.detail).toContain(CONFIG_PATH);
    // Exactly ONE git call happened: the guard's own, anchored at the CONFIG's directory. Nothing
    // was asked of `envDir` at all.
    expect(calls.length).toBe(1);
    expect(calls[0]!.slice(0, 4)).toEqual(["-C", dirname(CONFIG_PATH), "ls-files", "--error-unmatch"]);
    expect(calls.some((c) => c[1] === envDir)).toBe(false);
  });

  test("preflight refuses it too", () => {
    const { git } = makeGitSpy({ lsFiles: TRACKED });
    const fs = fakeFs(new Set([join(envDir, ".drawbar", "runs", ".gitignore")]));
    const result = knowledgePreflight({ envDir, kbDir, git, ...fs, ...trustDeps() });
    expect(result).toMatchObject({ ok: false, reason: "config_is_tracked" });
  });

  test("a git FAILURE on the guard proceeds — the same fail-open shape the runbook's `|| true` has", async () => {
    // MUST-CHECK de-hardcode-test-fixture-must-vary-the-old-value, and the reason this is not a
    // fail-closed check: the ordinary case is a config that lives outside any repository at all
    // (128), and the PATH-scrubbed case is a missing `git` binary (the real runner's 127). Turning
    // either into a halt would refuse operators this guard was never aimed at. ONLY exit 0 refuses.
    seedActive();
    for (const failure of [
      { code: 128, stderr: "fatal: not a git repository" },
      { code: 127, stderr: "ENOENT: no such file or directory, posix_spawn 'git'" },
      { code: 1, stderr: "error: pathspec did not match any file(s) known to git" },
    ]) {
      const { git } = makeGitSpy({ lsFiles: failure });
      const result = await syncKnowledge(baseInput({}, git));
      expect(result.ok, `lsFiles code ${failure.code} must not halt the sync`).toBe(true);
    }
  });
});

// --- 19. R7/T2: `--dir` (kbDir) must live inside the vouched-for envDir ------------------------
//
// kbDir was the second path taken from the same mutable state, with only `isCleanAbsolutePath` on
// it. Reproduced against the real CLI: `--dir <two directories outside a trusted envDir>` created
// that whole tree and wrote an attacker-chosen `knowledge.jsonl` into it before the first git call
// failed. It is also the source of every git pathspec, via `relative(envDir, ...)`.

describe("R7/T2: kbDir outside the configured envDir is refused before anything is written", () => {
  test("sync refuses kb_dir_not_in_env_dir, writes NOTHING, and makes zero git calls", async () => {
    const outside = join(dirname(envDir), `${basenameOf(envDir)}-outside`, "deep", "nested");
    expect(existsSync(outside)).toBe(false); // non-vacuous precondition
    const { git, calls } = makeGitSpy();
    const result = await syncKnowledge(
      baseInput({ kbDir: outside, lessons: [entry({ key: "must-not-be-written" })] }, git),
    );
    expect(result).toMatchObject({ ok: false, reason: "kb_dir_not_in_env_dir", attempts: 0 });
    expect(result.ok === false && result.detail).toContain(outside);
    // The repro's own evidence, inverted: `appendEntry` does `mkdirSync(dir,{recursive:true})` and
    // then appends, so a refusal that came too late would leave this whole tree behind.
    expect(existsSync(outside)).toBe(false);
    // Nothing was asked of envDir. The trust root's own `ls-files` (at the CONFIG's directory) is
    // the only call, because containment is checked immediately after it.
    expect(calls.filter((c) => !isTrustRootCall(c)).length).toBe(0);
  });

  test("preflight refuses it too", () => {
    const outside = join(dirname(envDir), `${basenameOf(envDir)}-outside`, "memory");
    const { git } = makeGitSpy();
    const fs = fakeFs(new Set([join(envDir, ".drawbar", "runs", ".gitignore")]));
    const result = knowledgePreflight({ envDir, kbDir: outside, git, ...fs, ...trustDeps() });
    expect(result).toMatchObject({ ok: false, reason: "kb_dir_not_in_env_dir" });
  });

  test("a SIBLING whose path merely starts with the envDir string is refused (not a prefix match)", async () => {
    // `/tmp/env-evil` starts with `/tmp/env` — a bare `startsWith` on the raw string admits it.
    // The containment check appends the separator for exactly this case.
    const sibling = `${envDir}-evil`;
    mkdirSync(sibling, { recursive: true });
    const { git } = makeGitSpy();
    const result = await syncKnowledge(baseInput({ kbDir: sibling }, git));
    expect(result).toMatchObject({ ok: false, reason: "kb_dir_not_in_env_dir" });
  });

  test("kbDir EQUAL to envDir, and kbDir nested under it, are both accepted", async () => {
    // MUST-CHECK de-hardcode-test-fixture-must-vary-the-old-value: the refusals above would pass
    // against an unconditional refusal, and the equal-path case would fail a naive
    // `startsWith(envDir + sep)` that forgot it.
    for (const dir of [envDir, join(envDir, ".drawbar", "memory"), join(envDir, "a", "b", "c")]) {
      const { git } = makeGitSpy();
      const result = await syncKnowledge(baseInput({ kbDir: dir }, git));
      expect(result.ok, `kbDir ${dir} must be accepted`).toBe(true);
    }
  });

  test("the check is made against the CONFIG's envDir, not the argv one", async () => {
    // `assertEnvDirTrusted` returns the parsed config and R5 discarded it; this is what gives that
    // payload a consumer. With `--env-dir` and the config agreeing (they must, or the trust root
    // refuses first) the two are the same directory — so the observable difference is that the
    // refusal DETAIL names the configured value.
    const outside = join(dirname(envDir), `${basenameOf(envDir)}-outside`);
    const { git } = makeGitSpy();
    const result = await syncKnowledge(
      baseInput({ kbDir: outside, readConfig: () => shipConfigText({ envDir: envDir + "/" }) }, git),
    );
    expect(result).toMatchObject({ ok: false, reason: "kb_dir_not_in_env_dir" });
    expect(result.ok === false && result.detail).toContain(envDir + "/");
  });
});

// --- 20. R7/T3: a gitignored knowledge.jsonl is never a SILENT success -------------------------
//
// R5/F1 made the loop SKIP an ignored knowledge path rather than halt. Right for
// `knowledge.archive.jsonl`; for `knowledge.jsonl` it is permanent silent data loss — `stagePaths`
// is empty, stage+commit are skipped whole, and every run returns `{ok:true, staged:[]}` forever
// while §6 (which checks only `.ok == "true"`) reads a clean ship. Probed against the real module:
// `{"ok":true,"attempts":1,"staged":[],...}` with calls `check-ignore,status,pull,push` — no add,
// no commit, exit 0. Made visible two ways: preflight refuses it outright, and a successful sync
// reports it and warns loudly.

describe("R7/T3: knowledgePreflight refuses a gitignored knowledge path", () => {
  const gitignorePresent = () => fakeFs(new Set([join(envDir, ".drawbar", "runs", ".gitignore")]));

  test("the ACTIVE path ignored -> refused, naming it", () => {
    const { git } = makeGitSpy({
      checkIgnore: (argv) => (argv.some((a) => a.endsWith("/knowledge.jsonl")) ? IGNORED : NOT_IGNORED),
    });
    const result = knowledgePreflight({ envDir, kbDir, git, ...gitignorePresent(), ...trustDeps() });
    expect(result).toMatchObject({ ok: false, reason: "knowledge_path_ignored" });
    expect(result.ok === false && result.detail).toContain("knowledge.jsonl");
  });

  test("the ARCHIVE path ignored -> refused too, naming it (proves BOTH paths are checked)", () => {
    const { git } = makeGitSpy({
      checkIgnore: (argv) => (argv.some((a) => a.endsWith("knowledge.archive.jsonl")) ? IGNORED : NOT_IGNORED),
    });
    const result = knowledgePreflight({ envDir, kbDir, git, ...gitignorePresent(), ...trustDeps() });
    expect(result).toMatchObject({ ok: false, reason: "knowledge_path_ignored" });
    expect(result.ok === false && result.detail).toContain("knowledge.archive.jsonl");
  });

  test("check-ignore erroring fails CLOSED here — preflight exists to assert, so it must not guess", () => {
    const { git } = makeGitSpy({ checkIgnore: { code: 128, stderr: "fatal: not a git repository" } });
    const result = knowledgePreflight({ envDir, kbDir, git, ...gitignorePresent(), ...trustDeps() });
    expect(result).toMatchObject({ ok: false, reason: "check_ignore_failed" });
  });

  test("NEITHER ignored -> the preflight still passes (the check is not `always refuse`)", () => {
    const { git, calls } = makeGitSpy({ checkIgnore: NOT_IGNORED });
    const result = knowledgePreflight({ envDir, kbDir, git, ...gitignorePresent(), ...trustDeps() });
    expect(result).toEqual({ ok: true, gitignoreCreated: false });
    // Two calls, one per path, so a failure on the second is provably reachable.
    expect(calls.filter((c) => c[2] === "check-ignore").length).toBe(2);
  });
});

describe("R7/T3: a sync that skipped an ignored path SAYS SO — on stdout and loudly on stderr", () => {
  test("the ACTIVE path ignored: ok stays true, but `ignored` names it and `staged` is empty", async () => {
    seedActive();
    const { git, calls } = makeGitSpy({ checkIgnore: IGNORED });
    const result = await syncKnowledge(baseInput({}, git));
    // Still tolerant — reintroducing the halt would reintroduce R5/F1's permanent brick.
    expect(result).toMatchObject({ ok: true, staged: [], ignored: ["knowledge.jsonl"] });
    expect(calls.some((c) => c[2] === "add")).toBe(false);
  });

  test("the archive ignored while the active file is staged: `ignored` names only the archive", async () => {
    // MUST-CHECK de-hardcode-test-fixture-must-vary-the-old-value: `ignored` hardcoded to the
    // active path, or to both paths, fails here.
    seedActive();
    seedArchive();
    const { git } = makeGitSpy({
      checkIgnore: (argv) => (argv.some((a) => a.endsWith("knowledge.archive.jsonl")) ? IGNORED : NOT_IGNORED),
    });
    const result = await syncKnowledge(baseInput({}, git));
    expect(result).toMatchObject({ ok: true, staged: ["knowledge.jsonl"], ignored: ["knowledge.archive.jsonl"] });
  });

  test("nothing ignored -> `ignored` is empty and main() prints NO warning", async () => {
    seedActive();
    const { git } = makeGitSpy({ checkIgnore: NOT_IGNORED });
    let stdout = "";
    let stderr = "";
    const code = await main({
      argv: ["sync", "--env-dir", envDir, "--dir", kbDir, "--message", "kb: x", "--config-path", CONFIG_PATH],
      readStdin: async () => JSON.stringify({ lessons: [] }),
      git, sleep: noopSleep(), ...mainTrustDeps(),
      writeStdout: (s) => { stdout += s; }, writeStderr: (s) => { stderr += s; },
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout).ignored).toEqual([]);
    expect(stderr).not.toContain("ignored=");
  });

  test("main(): an ignored knowledge.jsonl produces a LOUD stderr warning on the otherwise-successful sync", async () => {
    seedActive();
    const { git } = makeGitSpy({ checkIgnore: IGNORED });
    let stdout = "";
    let stderr = "";
    const code = await main({
      argv: ["sync", "--env-dir", envDir, "--dir", kbDir, "--message", "kb: x", "--config-path", CONFIG_PATH],
      readStdin: async () => JSON.stringify({ lessons: [] }),
      git, sleep: noopSleep(), ...mainTrustDeps(),
      writeStdout: (s) => { stdout += s; }, writeStderr: (s) => { stderr += s; },
    });
    // The exit code stays 0 on purpose — the halt is preflight's job, not the sync's.
    expect(code).toBe(0);
    expect(JSON.parse(stdout).ignored).toEqual(["knowledge.jsonl"]);
    expect(stderr).toContain("ignored=knowledge.jsonl");
    expect(stderr).toContain("preflight"); // ...and it names the remedy
  });
});

// --- 21. R7/T4: the STDOUT copy of a refusal is sanitized too ----------------------------------
//
// `detail` was sanitized on stderr and written RAW to stdout: `JSON.stringify` escapes only
// C0/DEL/quote/backslash, so the whole invisible/bidi class `sanitizeForOutput` exists for passed
// straight through. Reproduced against the real CLI — stdout carried `e2 80 ae` (U+202E) and
// `e2 80 8b` (U+200B) inside `detail` while stderr correctly carried `ef bf bd`. §6 echoes that
// stdout back into agent-read output, which is the reordering/hiding vector this closes.

describe("R7/T4: refusal and success JSON on stdout are sanitized, not merely stringified", () => {
  const RTL = "‮";
  const ZWSP = "​";

  test("sync: a hostile dirty-precondition detail is scrubbed on STDOUT as well as stderr", async () => {
    let stdout = "";
    let stderr = "";
    const { git } = makeGitSpy({ status: { code: 0, stdout: ` M evil${RTL}name${ZWSP}.txt\n`, stderr: "" } });
    const code = await main({
      argv: ["sync", "--env-dir", envDir, "--dir", kbDir, "--message", "kb: x", "--config-path", CONFIG_PATH],
      readStdin: async () => JSON.stringify({ lessons: [] }),
      git, sleep: noopSleep(), ...mainTrustDeps(),
      writeStdout: (s) => { stdout += s; }, writeStderr: (s) => { stderr += s; },
    });
    expect(code).not.toBe(0);
    // Still well-formed JSON the runbook's `jq` can read, and still legible.
    const parsed = JSON.parse(stdout);
    expect(parsed.reason).toBe("dirty_precondition");
    expect(parsed.detail).toContain("name");
    expect(stdout).not.toContain(RTL);
    expect(stdout).not.toContain(ZWSP);
    expect(stdout).toContain("�"); // replaced, not merely dropped
    expect(stderr).not.toContain(RTL);
  });

  test("preflight: same, on its own refusal path", async () => {
    let stdout = "";
    const { git } = makeGitSpy({ status: { code: 0, stdout: ` M evil${RTL}name${ZWSP}.txt\n`, stderr: "" } });
    const fs = fakeFs(new Set([join(envDir, ".drawbar", "runs", ".gitignore")]));
    const code = await main({
      argv: ["preflight", "--env-dir", envDir, "--dir", kbDir, "--config-path", CONFIG_PATH],
      git, ...mainTrustDeps(),
      existsSync: fs.existsSync, mkdirSync: fs.mkdirSync, writeFileSync: fs.writeFileSync,
      writeStdout: (s) => { stdout += s; }, writeStderr: () => {},
    });
    expect(code).not.toBe(0);
    expect(JSON.parse(stdout).reason).toBe("knowledge_repo_dirty");
    expect(stdout).not.toContain(RTL);
    expect(stdout).not.toContain(ZWSP);
    expect(stdout).toContain("�");
  });

  test("no unsanitized stdout write survives anywhere in the module", async () => {
    // The regression pin, not a second behavioural case. There were TWO refusal paths writing a
    // bare `JSON.stringify(result)` and the diff that introduced the sanitizer on stderr left both
    // untouched — a per-verb behavioural test cannot notice a THIRD one being added later. Both
    // verbs now go through one `emit` helper, and this forbids the shape that bypassed it.
    const src = readFileSync(join(import.meta.dir, "kb-sync.ts"), "utf8");
    expect(src).not.toMatch(/writeStdout\(JSON\.stringify/);
    expect(src).toMatch(/writeStdout\(sanitizeForOutput\(JSON\.stringify/);
    // ...and exactly one site does it, so "both verbs" is structural rather than duplicated.
    expect(src.split("writeStdout(sanitizeForOutput(").length - 1).toBe(1);
    // The success path emits through it too. Nothing hostile can reach `staged`/`ignored` today
    // (they carry fixed basenames), so this is asserted structurally rather than with a fixture
    // that would only be proving `JSON.stringify`'s own behaviour.
    let stdout = "";
    seedActive();
    const { git } = makeGitSpy();
    const code = await main({
      argv: ["sync", "--env-dir", envDir, "--dir", kbDir, "--message", "kb: x", "--config-path", CONFIG_PATH],
      readStdin: async () => JSON.stringify({ lessons: [] }),
      git, sleep: noopSleep(), ...mainTrustDeps(),
      writeStdout: (s) => { stdout += s; }, writeStderr: () => {},
    });
    expect(code).toBe(0);
    expect(JSON.parse(stdout).ok).toBe(true);
  });
});

// --- 22. R7: two recorded-reasoning corrections, pinned -----------------------------------------
//
// In this repo the recorded reasoning IS part of the artifact, so a comment that asserts something
// false about git's behaviour is a defect in its own right. Both of these were wrong and were
// re-verified against real git 2.43.0 before being rewritten.

describe("R7: the commit call site records the mid-REBASE case, not just the mid-merge one", () => {
  test("the partial-commit note no longer claims unreachability, and names the rebase behaviour", () => {
    const src = readFileSync(join(import.meta.dir, "kb-sync.ts"), "utf8");
    // Verified: mid-merge `git commit -m x -- <path>` exits 128 ("cannot do a partial commit
    // during a merge"); mid-rebase (after this module's own non-retried `pull_failed` wedged the
    // tree with `UU`) the same command exits 0 on the detached HEAD, while the UNSCOPED form exits
    // 128. And the dirty precondition cannot catch it, because it runs after the commit.
    expect(src).toContain("mid-REBASE tree");
    expect(src).toContain("detached HEAD");
    expect(src).toContain("`pull_failed` is what LEAVES one behind");
    // R5's two false claims, pinned as the exact sentences they were, so neither can come back.
    expect(src).not.toContain("Also unreachable: this loop only ever commits BEFORE its");
    expect(src).not.toContain("a mid-merge\n      //      tree would be caught by the dirty precondition");
  });
});

describe("R7: the envDir equality is deliberately resolve(), and realpath was REJECTED with a reason", () => {
  test("a differing literal that resolves to the same directory via a symlink is still refused", () => {
    // This is the empirical reason realpath was not adopted for this comparison. Both sides of the
    // equality are the same KIND of value, so realpath applies the identical transformation to
    // each and cannot distinguish them — a symlink standing AT the configured envDir resolves to
    // its target on both sides and passes either way. The only thing realpath would change is
    // making the check LOOSER: it would newly ADMIT the case below, which resolve() refuses.
    const target = mkdtempSync(join(tmpdir(), "kb-sync-target-"));
    const link = join(dirname(target), `${basenameOf(target)}-link`);
    symlinkSync(target, link);
    expect(realpathSync(link)).toBe(realpathSync(target)); // same directory by realpath...
    const { git, calls } = makeGitSpy();
    const result = knowledgePreflight({
      envDir: link,
      kbDir: join(link, ".drawbar", "memory"),
      git,
      ...fakeFs(new Set([join(link, ".drawbar", "runs", ".gitignore")])),
      ...trustDeps({ readConfig: () => shipConfigText({ envDir: target }) }),
    });
    // ...and still refused, because the two literals differ. A realpath comparison would admit it.
    expect(result).toMatchObject({ ok: false, reason: "env_dir_not_in_config" });
    expect(calls.length).toBe(0);
    const src = readFileSync(join(import.meta.dir, "kb-sync.ts"), "utf8");
    expect(src).toContain("DELIBERATELY NOT `realpath` on these two");
  });
});

// A local `basename` — the module under test imports node's, and this file deliberately does not,
// so a stray import can never make an argv assertion pass for the wrong reason.
function basenameOf(p: string): string {
  return p.slice(p.lastIndexOf("/") + 1);
}
