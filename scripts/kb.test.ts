import { test, expect, describe, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./kb";
import { readEntries, readArchiveEntries, ensureDir } from "./lib/store";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-cli-"));
});

// Run the CLI with stdin text by invoking the binary through Bun so stdin is real.
async function cli(args: string[], stdin = ""): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", "run", join(import.meta.dir, "kb.ts"), ...args], {
    stdin: stdin ? new TextEncoder().encode(stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { code, out, err };
}

describe("run (in-process)", () => {
  test("reindex on an empty dir exits 0", async () => {
    expect(await run(["reindex", "--dir", dir])).toBe(0);
  });

  test("stats --json reports zero entries on an empty dir", async () => {
    // stats prints to stdout; here we just assert the exit code path.
    expect(await run(["stats", "--dir", dir, "--json"])).toBe(0);
  });

  test("recall rejects a non-numeric --limit", async () => {
    expect(await run(["recall", "x", "--dir", dir, "--limit", "abc"])).toBe(1);
  });

  test("recall rejects a negative --since", async () => {
    expect(await run(["recall", "x", "--dir", dir, "--since", "-5"])).toBe(1);
  });
});

describe("cli (subprocess, real stdin)", () => {
  test("add reads a JSON entry from stdin and persists it", async () => {
    const entry = JSON.stringify({
      key: "cli-1", type: "fact", content: "added via stdin", ts: 1, source: "user",
    });
    const { code } = await cli(["add", "--dir", dir], entry);
    expect(code).toBe(0);
    expect(readEntries(dir).map((e) => e.key)).toEqual(["cli-1"]);
  });

  test("recall --json finds a previously added entry", async () => {
    const entry = JSON.stringify({ key: "cli-2", type: "pattern", content: "needle haystack", ts: 2 });
    await cli(["add", "--dir", dir], entry);
    const { code, out } = await cli(["recall", "needle", "--dir", dir, "--json"]);
    expect(code).toBe(0);
    expect(out).toContain("cli-2");
  });

  test("add rejects malformed stdin with a non-zero exit", async () => {
    const { code } = await cli(["add", "--dir", dir], "{ not valid json");
    expect(code).not.toBe(0);
  });

  test("add accepts an entry without ts (defaults it)", async () => {
    const entry = JSON.stringify({ key: "no-ts", type: "learned", content: "works without ts" });
    const { code } = await cli(["add", "--dir", dir], entry);
    expect(code).toBe(0);
    const rows = readEntries(dir);
    expect(rows.map((e) => e.key)).toContain("no-ts");
    expect(rows.find((e) => e.key === "no-ts")!.ts).toBeGreaterThan(0);
  });

  test("add reports superseded:true on a changed-content re-add", async () => {
    const v1 = JSON.stringify({ key: "dup", type: "fact", content: "v1", ts: 1 });
    const v2 = JSON.stringify({ key: "dup", type: "fact", content: "v2", ts: 2 });
    const first = await cli(["add", "--dir", dir], v1);
    expect(JSON.parse(first.out)).toEqual({ written: true, superseded: false, key: "dup" });
    const second = await cli(["add", "--dir", dir], v2);
    expect(JSON.parse(second.out)).toEqual({ written: true, superseded: true, key: "dup" });
  });

  test("stats reports duplicateKeys", async () => {
    const p = ensureDir(dir);
    writeFileSync(
      p.active,
      [
        JSON.stringify({ key: "a", type: "fact", content: "a1", source: "user", tags: [], ts: 1, issue: null, files: [] }),
        JSON.stringify({ key: "a", type: "fact", content: "a2", source: "user", tags: [], ts: 2, issue: null, files: [] }),
        JSON.stringify({ key: "b", type: "fact", content: "b1", source: "user", tags: [], ts: 3, issue: null, files: [] }),
      ].join("\n") + "\n",
    );
    const { code, out } = await cli(["stats", "--dir", dir]);
    expect(code).toBe(0);
    expect(JSON.parse(out).duplicateKeys).toBe(1);
  });

  test("compact collapses duplicates and moves losers to the archive", async () => {
    const p = ensureDir(dir);
    writeFileSync(
      p.active,
      [
        JSON.stringify({ key: "a", type: "fact", content: "a1", source: "user", tags: [], ts: 1, issue: null, files: [] }),
        JSON.stringify({ key: "a", type: "fact", content: "a2", source: "user", tags: [], ts: 2, issue: null, files: [] }),
        JSON.stringify({ key: "b", type: "fact", content: "b1", source: "user", tags: [], ts: 3, issue: null, files: [] }),
      ].join("\n") + "\n",
    );
    const { code, out } = await cli(["compact", "--dir", dir]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ scanned: 3, keys: 2, removed: 1 });
    expect(readEntries(dir).map((e) => e.key)).toEqual(["a", "b"]);
    expect(readEntries(dir).find((e) => e.key === "a")!.content).toBe("a2");
    expect(readArchiveEntries(dir).map((e) => e.content)).toEqual(["a1"]);
  });

  test("compact is a no-op on a clean store", async () => {
    await cli(["add", "--dir", dir], JSON.stringify({ key: "a", type: "fact", content: "a1", ts: 1 }));
    const { code, out } = await cli(["compact", "--dir", dir]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ scanned: 1, keys: 1, removed: 0 });
  });

  test("compact --dry-run changes nothing on disk", async () => {
    const p = ensureDir(dir);
    writeFileSync(
      p.active,
      [
        JSON.stringify({ key: "a", type: "fact", content: "a1", source: "user", tags: [], ts: 1, issue: null, files: [] }),
        JSON.stringify({ key: "a", type: "fact", content: "a2", source: "user", tags: [], ts: 2, issue: null, files: [] }),
      ].join("\n") + "\n",
    );
    const { code, out } = await cli(["compact", "--dir", dir, "--dry-run"]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ scanned: 2, keys: 1, removed: 1 });
    expect(readEntries(dir).map((e) => e.content)).toEqual(["a1", "a2"]);
    expect(readArchiveEntries(dir).length).toBe(0);
  });

  test("usage string mentions compact for an unknown command", async () => {
    const { code, err } = await cli(["bogus", "--dir", dir]);
    expect(code).toBe(1);
    expect(err).toContain("compact");
  });
});
