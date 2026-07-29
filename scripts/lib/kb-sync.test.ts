import { test, expect, describe, beforeEach } from "bun:test";
import { mkdtempSync, existsSync, writeFileSync, readFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

function makeGitSpy(overrides: {
  add?: GitResp;
  diff?: GitResp;
  commit?: GitResp;
  status?: GitResp;
  pull?: GitResp;
  pushQueue?: GitResp[];
  checkAttr?: GitResp | ((argv: string[]) => GitResp);
} = {}): { git: Runner; calls: string[][] } {
  const calls: string[][] = [];
  let pushIdx = 0;
  const pushQueue = overrides.pushQueue ?? [OK];
  const git: Runner = (argv) => {
    calls.push(argv);
    const sub = argv[2];
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

function baseInput(overrides: Partial<SyncKnowledgeInput> = {}, git: Runner): SyncKnowledgeInput {
  return {
    envDir,
    kbDir,
    message: "kb: test sync (PCO-353)",
    lessons: [],
    git,
    sleep: noopSleep(),
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
      argv: ["sync", "--env-dir", envDir, "--dir", kbDir, "--message", "kb: test (PCO-353)"],
      readStdin: async () => JSON.stringify({ lessons: [] }),
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
      argv: ["sync", "--env-dir", envDir, "--dir", kbDir, "--message", "kb: test (PCO-353)"],
      readStdin: async () => JSON.stringify({ lessons: [] }),
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

// --- 13. preflight -----------------------------------------------------------------------------

describe("knowledgePreflight", () => {
  function fakeFs(existing: Set<string> = new Set()) {
    const written: Record<string, string> = {};
    const mkdirCalls: string[] = [];
    return {
      existsSync: (p: string) => existing.has(p),
      writeFileSync: (p: string, c: string) => { written[p] = c; existing.add(p); },
      mkdirSync: (p: string) => { mkdirCalls.push(p); },
      written,
      mkdirCalls,
    };
  }

  test("dirty knowledge repo -> fail", () => {
    const { git } = makeGitSpy({ status: { code: 0, stdout: " M knowledge.jsonl\n", stderr: "" } });
    const fs = fakeFs(new Set([join(envDir, ".drawbar", "runs", ".gitignore")]));
    const result = knowledgePreflight({ envDir, kbDir, git, ...fs });
    expect(result).toMatchObject({ ok: false, reason: "knowledge_repo_dirty" });
  });

  // Symmetrical with syncKnowledge's own "untracked files never read as dirty" test — Locked
  // 16's preflight dirty check must use the SAME untracked-tolerant rule syncKnowledge's own
  // precondition uses, not merely happen to behave the same way today.
  test("the status call actually carries --untracked-files=no", () => {
    const { git, calls } = makeGitSpy(); // CLEAN_STATUS: the runner reports no dirt
    const fs = fakeFs(new Set([join(envDir, ".drawbar", "runs", ".gitignore")]));
    const result = knowledgePreflight({ envDir, kbDir, git, ...fs });
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
    const result = knowledgePreflight({ envDir, kbDir, git, ...fs });
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
    const result = knowledgePreflight({ envDir, kbDir, git, ...fs });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("check_attr_not_union");
      expect(result.detail).toContain("knowledge.archive.jsonl");
    }
  });

  test("missing .drawbar/runs/.gitignore -> CREATED, reported as success (not a failure)", () => {
    const { git } = makeGitSpy();
    const fs = fakeFs(new Set()); // absent
    const result = knowledgePreflight({ envDir, kbDir, git, ...fs });
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
    const result = knowledgePreflight({ envDir, kbDir, git, ...fs });
    expect(result).toEqual({ ok: true, gitignoreCreated: false });
    expect(Object.keys(fs.written).length).toBe(0);
  });

  test("real reference content matches the shipped .gitignore fixture byte-for-byte", () => {
    // Cross-checks against the live checked-out reference this module's constant was copied
    // from, so the two can never silently drift.
    const { git } = makeGitSpy();
    const fs = fakeFs(new Set());
    knowledgePreflight({ envDir, kbDir, git, ...fs });
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
    const result = parseSyncCliArgs(["--env-dir", "/tmp/a", "--dir", "/tmp/b", "--message", "kb: x"]);
    expect(result).toEqual({ ok: true, envDir: "/tmp/a", dir: "/tmp/b", message: "kb: x" });
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
  test("preflight against a real subprocess with PATH holding only bun's own directory", async () => {
    const bunDir = dirname(process.execPath);
    const scriptPath = join(import.meta.dir, "kb-sync.ts");
    const proc = Bun.spawn(
      ["bun", "run", scriptPath, "preflight", "--env-dir", envDir, "--dir", kbDir],
      { env: { PATH: bunDir }, stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).not.toBe(0);
    const parsed = JSON.parse(out); // throws if the CLI crashed instead of writing well-formed JSON
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("status_failed");
  });
});
