import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./await-report";
import type { FsDeps } from "./lib/await-report";

// CLI-level tests exercise `run()` against the same injected FsDeps the library uses, so no
// real ~/.claude/projects or real sleeps are touched — see scripts/lib/await-report.test.ts
// for the pure-function coverage this builds on.
function fakeFsWith(files: Record<string, string>): FsDeps {
  const map = new Map(Object.entries(files));
  let clock = 0;
  return {
    exists: (p) => map.has(p) || [...map.keys()].some((f) => f.startsWith(p.endsWith("/") ? p : p + "/")),
    readFile: (p) => {
      if (!map.has(p)) throw new Error(`ENOENT: ${p}`);
      return map.get(p)!;
    },
    listDir: (root) => [...map.keys()].filter((p) => p.startsWith(root) && p.endsWith(".jsonl")),
    statMtimeMs: () => 0,
    // Advances a fake clock instead of really sleeping, so a "no report ever appears" test
    // reaches its budget deadline instantly rather than burning real wall-clock time.
    sleepMs: async (ms) => { clock += ms; },
    nowMs: () => clock,
  };
}

describe("await-report CLI", () => {
  test("rejects missing arguments", async () => {
    const code = await run([]);
    expect(code).toBe(1);
  });

  test("rejects a non-numeric budget", async () => {
    const code = await run(["/r", "implementer", "not-a-number"]);
    expect(code).toBe(1);
  });

  test("exits 0 and prints the report when the file is already present", async () => {
    const fs = fakeFsWith({ "/r/implementer.md": "done" });
    const code = await run(["/r", "implementer", "10"], fs);
    expect(code).toBe(0);
  });

  test("exits 1 when nothing is found within the budget", async () => {
    const fs = fakeFsWith({});
    const code = await run(["/r", "implementer", "1"], fs);
    expect(code).toBe(1);
  });
});

// One end-to-end test against the REAL filesystem (a temp dir), to catch anything the fake
// FsDeps papers over — e.g. actual mtime comparisons and actual JSON.parse on real files.
describe("await-report CLI against a real temp directory", () => {
  test("finds a report file written to a real mktemp -d directory", async () => {
    const dir = mkdtempSync(join(tmpdir(), "await-report-e2e-"));
    try {
      writeFileSync(join(dir, "implementer.md"), "real file, real report");
      const code = await run([dir, "implementer", "5"]);
      expect(code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("exits non-zero against a real empty directory with a tiny budget", async () => {
    const dir = mkdtempSync(join(tmpdir(), "await-report-e2e-empty-"));
    try {
      const code = await run([dir, "implementer", "1"]);
      expect(code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
