import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { classifySpec, findSourceGuardSpecCandidates, listSpecFiles, parseArgs, main } from "./find-source-guard-specs";

// --- classifySpec: the pure verdict function -----------------------------------------------

describe("classifySpec", () => {
  test("flags a spec that walks a src/ tree with readdirSync and reads each file", () => {
    const content = `
      const SRC_ROOT = join(import.meta.dirname, "..", "..", "..", "src");
      for (const entry of readdirSync(dir)) { walk(join(dir, entry.name)); }
      const source = readFileSync(join(SRC_ROOT, relativePath), "utf8");
    `;
    const c = classifySpec("backend/tests/unit/pos/vendorInventory.spec.ts", content);
    expect(c).not.toBeNull();
    expect(c!.reasons.some((r) => r.includes("src-rooted"))).toBe(true);
  });

  test("flags a spec via a literal .../src/... path even with no SRC_ROOT constant", () => {
    const content = `
      import { readFileSync } from "node:fs";
      const MAPPERS_PATH = path.join(__dirname, "../../../src/clients/toast/mappers.ts");
      const source = readFileSync(MAPPERS_PATH, "utf8");
    `;
    const c = classifySpec("backend/tests/unit/clients/toast-mappers.importGraph.spec.ts", content);
    expect(c).not.toBeNull();
  });

  test("flags a spec on filename alone when it also reads the filesystem", () => {
    const content = `
      import { readFileSync } from "node:fs";
      const raw = readFileSync(CONFIG_PATH, "utf8");
    `;
    const c = classifySpec("backend/tests/unit/jobs/some.importGraph.spec.ts", content);
    expect(c).not.toBeNull();
    expect(c!.reasons.some((r) => r.includes("filename suggests"))).toBe(true);
  });

  test("does not flag a *.guard.spec.ts file that never touches the filesystem", () => {
    // terminationSchedulingClock.guard.spec.ts in `hourly`: the name matches, but it tests
    // runtime guard behavior against in-memory fixtures, not the source tree. Filename alone
    // must never be sufficient.
    const content = `
      test("clocks reject a shift outside the window", async ({ expect }) => {
        expect(isWithinWindow(shift)).toBe(false);
      });
    `;
    const c = classifySpec("backend/tests/unit/terminationSchedulingClock.guard.spec.ts", content);
    expect(c).toBeNull();
  });

  test("does not flag an ordinary spec that reads a JSON fixture with no src reference", () => {
    const content = `
      import { readFileSync } from "node:fs";
      const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    `;
    const c = classifySpec("backend/tests/unit/jobs/syncworker-factory-snapshot.spec.ts", content);
    expect(c).toBeNull();
  });

  test("does not flag a spec that neither reads the filesystem nor matches a keyword", () => {
    const content = `test("adds two numbers", ({ expect }) => { expect(1 + 1).toBe(2); });`;
    const c = classifySpec("backend/tests/unit/math.spec.ts", content);
    expect(c).toBeNull();
  });
});

// --- findSourceGuardSpecCandidates: the batch form ------------------------------------------

describe("findSourceGuardSpecCandidates", () => {
  test("returns only the files that classify as candidates, in input order", () => {
    const files = [
      { path: "a.spec.ts", content: `readFileSync(join(SRC_ROOT, "x"), "utf8")` },
      { path: "b.spec.ts", content: `test("no fs here", () => {})` },
      { path: "c.spec.ts", content: `readFileSync(join(SRC_DIR, "y"), "utf8")` },
    ];
    const candidates = findSourceGuardSpecCandidates(files);
    expect(candidates.map((c) => c.path)).toEqual(["a.spec.ts", "c.spec.ts"]);
  });

  test("an empty input yields an empty result, not an error", () => {
    expect(findSourceGuardSpecCandidates([])).toEqual([]);
  });
});

// --- listSpecFiles: the real filesystem walk ------------------------------------------------

describe("listSpecFiles", () => {
  function fixtureTree(): string {
    const root = mkdtempSync(join(tmpdir(), "source-guard-fixture-"));
    mkdirSync(join(root, "tests", "unit", "jobs"), { recursive: true });
    mkdirSync(join(root, "tests", "unit", "pos"), { recursive: true });
    mkdirSync(join(root, "node_modules", "some-dep"), { recursive: true });
    mkdirSync(join(root, "worktrees", "rk-0928-stale", "tests", "unit", "jobs"), { recursive: true });
    mkdirSync(join(root, ".git"), { recursive: true });
    writeFileSync(join(root, "tests", "unit", "jobs", "pos-dispatch-no-vendor-literal.spec.ts"), "readFileSync(SRC_ROOT)");
    writeFileSync(join(root, "tests", "unit", "pos", "vendorInventory.spec.ts"), "readdirSync(SRC_ROOT)");
    writeFileSync(join(root, "tests", "unit", "pos", "notASpec.ts"), "readFileSync(SRC_ROOT)");
    writeFileSync(join(root, "node_modules", "some-dep", "fake.spec.ts"), "readFileSync(SRC_ROOT)");
    writeFileSync(join(root, "worktrees", "rk-0928-stale", "tests", "unit", "jobs", "pos-dispatch-no-vendor-literal.spec.ts"), "readFileSync(SRC_ROOT)");
    writeFileSync(join(root, ".git", "hooks-marker.spec.ts"), "readFileSync(SRC_ROOT)");
    return root;
  }

  test("finds *.spec.ts files recursively, skipping node_modules, worktrees, and dot-directories", () => {
    const root = fixtureTree();
    try {
      const found = listSpecFiles(root).map((p) => p.replace(root, "").replaceAll("\\", "/"));
      expect(found.sort()).toEqual([
        "/tests/unit/jobs/pos-dispatch-no-vendor-literal.spec.ts",
        "/tests/unit/pos/vendorInventory.spec.ts",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a missing root does not throw — it yields no files", () => {
    expect(listSpecFiles(join(tmpdir(), "does-not-exist-" + Date.now()))).toEqual([]);
  });
});

// --- parseArgs --------------------------------------------------------------------------------

describe("parseArgs", () => {
  test("accepts exactly one root argument", () => {
    expect(parseArgs(["/some/root"])).toEqual({ ok: true, root: "/some/root" });
  });

  test("refuses zero arguments", () => {
    const r = parseArgs([]);
    expect(r.ok).toBe(false);
  });

  test("refuses more than one argument", () => {
    const r = parseArgs(["/a", "/b"]);
    expect(r.ok).toBe(false);
  });
});

// --- main: the CLI wrapper, fully injected -----------------------------------------------------

describe("main", () => {
  function capture() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      writeStdout: (s: string) => out.push(s),
      writeStderr: (s: string) => err.push(s),
    };
  }

  test("prints each candidate's path (relative to cwd) and its reasons", () => {
    const cap = capture();
    const code = main({
      argv: ["/repo"],
      cwd: "/repo",
      listFiles: () => ["/repo/tests/unit/jobs/pos-dispatch-no-vendor-literal.spec.ts"],
      readFile: () => `readFileSync(join(SRC_ROOT, "x"), "utf8")`,
      writeStdout: cap.writeStdout,
      writeStderr: cap.writeStderr,
    });
    expect(code).toBe(0);
    expect(cap.out[0]).toBe("tests/unit/jobs/pos-dispatch-no-vendor-literal.spec.ts\n");
    expect(cap.out.some((l) => l.includes("src-rooted"))).toBe(true);
  });

  test("reports plainly when nothing matches, rather than printing nothing", () => {
    const cap = capture();
    const code = main({
      argv: ["/repo"],
      cwd: "/repo",
      listFiles: () => [],
      readFile: () => "",
      writeStdout: cap.writeStdout,
      writeStderr: cap.writeStderr,
    });
    expect(code).toBe(0);
    expect(cap.out).toEqual(["no candidates found\n"]);
  });

  test("refuses with no root argument and writes nothing to stdout", () => {
    const cap = capture();
    const code = main({ argv: [], cwd: "/repo", writeStdout: cap.writeStdout, writeStderr: cap.writeStderr });
    expect(code).toBe(1);
    expect(cap.out).toEqual([]);
    expect(cap.err[0]).toContain("refused:");
  });
});
