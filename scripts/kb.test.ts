import { test, expect, describe, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./kb";
import { readEntries, readArchiveEntries, ensureDir } from "./lib/store";
import { buildIndex } from "./lib/fts";

// Byte-comparison snapshot of everything on disk the store touches, for asserting a dry-run
// (or a rejected invocation) truly wrote nothing -- not knowledge.jsonl/archive alone, but
// index.db too, since a real archive rebuilds it unconditionally.
function snapshotStore(dir: string): { active: string; archive: string; indexDb: string | null } {
  const p = ensureDir(dir);
  return {
    active: existsSync(p.active) ? readFileSync(p.active, "utf8") : "",
    archive: existsSync(p.archive) ? readFileSync(p.archive, "utf8") : "",
    indexDb: existsSync(p.indexDb) ? readFileSync(p.indexDb).toString("base64") : null,
  };
}

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

  test("recall rejects non-integer --since and --limit (PCO-339)", async () => {
    expect(await run(["recall", "x", "--dir", dir, "--since", "1.5"])).toBe(1);
    expect(await run(["recall", "x", "--dir", dir, "--limit", "2.7"])).toBe(1);
  });

  test("recall still accepts --since 0 and --limit 0 (PCO-339)", async () => {
    expect(await run(["recall", "x", "--dir", dir, "--since", "0"])).toBe(0);
    expect(await run(["recall", "x", "--dir", dir, "--limit", "0"])).toBe(0);
  });

  test("archive --days 0 archives everything older than now (PCO-339)", async () => {
    const p = ensureDir(dir);
    const past = Math.floor(Date.now() / 1000) - 3600;
    writeFileSync(
      p.active,
      [
        JSON.stringify({ key: "a", type: "fact", content: "a1", source: "user", tags: [], ts: past, issue: null, files: [] }),
        JSON.stringify({ key: "b", type: "fact", content: "b1", source: "user", tags: [], ts: past, issue: null, files: [] }),
      ].join("\n") + "\n",
    );
    expect(readEntries(dir).length).toBe(2);
    expect(await run(["archive", "--dir", dir, "--days", "0"])).toBe(0);
    expect(readEntries(dir).length).toBe(0);
    expect(readArchiveEntries(dir).length).toBe(2);
  });

  test("archive --days 30 archives only entries older than 30 days (PCO-339)", async () => {
    const p = ensureDir(dir);
    const old = Math.floor(Date.now() / 1000) - 40 * 86400;
    const recent = Math.floor(Date.now() / 1000) - 10 * 86400;
    writeFileSync(
      p.active,
      [
        JSON.stringify({ key: "old", type: "fact", content: "old1", source: "user", tags: [], ts: old, issue: null, files: [] }),
        JSON.stringify({ key: "recent", type: "fact", content: "recent1", source: "user", tags: [], ts: recent, issue: null, files: [] }),
      ].join("\n") + "\n",
    );
    expect(await run(["archive", "--dir", dir, "--days", "30"])).toBe(0);
    expect(readEntries(dir).map((e) => e.key)).toEqual(["recent"]);
  });

  test("archive with no --days defaults to 90 days (PCO-339)", async () => {
    const p = ensureDir(dir);
    const old = Math.floor(Date.now() / 1000) - 100 * 86400;
    const recent = Math.floor(Date.now() / 1000) - 10 * 86400;
    writeFileSync(
      p.active,
      [
        JSON.stringify({ key: "old", type: "fact", content: "old1", source: "user", tags: [], ts: old, issue: null, files: [] }),
        JSON.stringify({ key: "recent", type: "fact", content: "recent1", source: "user", tags: [], ts: recent, issue: null, files: [] }),
      ].join("\n") + "\n",
    );
    expect(await run(["archive", "--dir", dir])).toBe(0);
    expect(readEntries(dir).map((e) => e.key)).toEqual(["recent"]);
  });

  test("archive --days with no value is rejected, not silently defaulted to 90 (PCO-339 F1)", async () => {
    const p = ensureDir(dir);
    const old = Math.floor(Date.now() / 1000) - 100 * 86400;
    writeFileSync(
      p.active,
      [JSON.stringify({ key: "old", type: "fact", content: "old1", source: "user", tags: [], ts: old, issue: null, files: [] })].join("\n") + "\n",
    );
    const code = await run(["archive", "--dir", dir, "--days"]);
    expect(code).toBe(1);
    expect(readEntries(dir).length).toBe(1);
  });

  test("archive --days swallowed by the next flag is rejected, not silently defaulted (PCO-339 F1)", async () => {
    const p = ensureDir(dir);
    const old = Math.floor(Date.now() / 1000) - 100 * 86400;
    writeFileSync(
      p.active,
      [JSON.stringify({ key: "old", type: "fact", content: "old1", source: "user", tags: [], ts: old, issue: null, files: [] })].join("\n") + "\n",
    );
    const code = await run(["archive", "--days", "--dir", dir]);
    expect(code).toBe(1);
    expect(readEntries(dir).length).toBe(1);
  });

  test("recall --since with no value is rejected, not silently ignored (PCO-339 F1)", async () => {
    expect(await run(["recall", "x", "--dir", dir, "--since"])).toBe(1);
  });

  test("recall --limit with no value is rejected, not silently ignored (PCO-339 F1)", async () => {
    expect(await run(["recall", "x", "--dir", dir, "--limit"])).toBe(1);
  });

  test("archive --days rejects malformed values and archives nothing (PCO-339)", async () => {
    const invalid = ["-1", "", " ", "abc", "1.5", "0x10", "1e3", "3."];
    for (const raw of invalid) {
      const p = ensureDir(dir);
      const past = Math.floor(Date.now() / 1000) - 3600;
      writeFileSync(
        p.active,
        [
          JSON.stringify({ key: "a", type: "fact", content: "a1", source: "user", tags: [], ts: past, issue: null, files: [] }),
          JSON.stringify({ key: "b", type: "fact", content: "b1", source: "user", tags: [], ts: past, issue: null, files: [] }),
          JSON.stringify({ key: "c", type: "fact", content: "c1", source: "user", tags: [], ts: past, issue: null, files: [] }),
        ].join("\n") + "\n",
      );
      const code = await run(["archive", "--dir", dir, "--days", raw]);
      expect(code).toBe(1);
      expect(readEntries(dir).length).toBe(3);
      expect(readArchiveEntries(dir).length).toBe(0);
    }
  });

  // Every help test below passes an explicit *nonexistent* --dir (or checks snapshotStore
  // for a seeded one): the help check runs before any I/O, so a regression in that ordering
  // must not silently start writing into a real store -- including the repo's own, since
  // spawning kb.ts without --dir falls back to process.cwd().
  test("--help prints usage on stdout, exits 0, and creates nothing (PCO-400 F4)", async () => {
    const missing = join(dir, "missing");
    const { code, out } = await cli(["--help", "--dir", missing]);
    expect(code).toBe(0);
    expect(out).toContain("usage:");
    expect(existsSync(missing)).toBe(false);
  });

  test("archive --help exits 0 even with an otherwise-invalid flag, prints usage, and creates nothing (PCO-400 F4)", async () => {
    const missing = join(dir, "missing");
    const { code, out } = await cli(["archive", "--help", "--dir", missing, "--bogus"]);
    expect(code).toBe(0);
    expect(out).toContain("usage:");
    expect(existsSync(missing)).toBe(false);
  });

  test("archive --help leaves an existing store byte-identical and prints usage (PCO-400 F4)", async () => {
    const p = ensureDir(dir);
    writeFileSync(p.active, JSON.stringify({ key: "a", type: "fact", content: "a1", source: "user", tags: [], ts: 1, issue: null, files: [] }) + "\n");
    const before = snapshotStore(dir);
    const { code, out } = await cli(["archive", "--dir", dir, "--help"]);
    expect(code).toBe(0);
    expect(out).toContain("usage:");
    expect(snapshotStore(dir)).toEqual(before);
  });

  test("recall --help hello binds a string to --help and still exits 0 with usage (PCO-400 F3)", async () => {
    const missing = join(dir, "missing");
    const { code, out } = await cli(["recall", "--dir", missing, "--help", "hello"]);
    expect(code).toBe(0);
    expect(out).toContain("usage:");
    expect(existsSync(missing)).toBe(false);
  });

  test("archive --help later binds a string to --help and still exits 0 with usage (PCO-400 F3)", async () => {
    const missing = join(dir, "missing");
    const { code, out } = await cli(["archive", "--dir", missing, "--help", "later"]);
    expect(code).toBe(0);
    expect(out).toContain("usage:");
    expect(existsSync(missing)).toBe(false);
  });

  test("archive --bogus is rejected and leaves the store untouched (PCO-400)", async () => {
    const p = ensureDir(dir);
    writeFileSync(p.active, JSON.stringify({ key: "a", type: "fact", content: "a1", source: "user", tags: [], ts: 1, issue: null, files: [] }) + "\n");
    const before = snapshotStore(dir);
    expect(await run(["archive", "--dir", dir, "--bogus"])).toBe(1);
    expect(snapshotStore(dir)).toEqual(before);
  });

  test("compact --bogus is rejected and leaves the store untouched (PCO-400)", async () => {
    const p = ensureDir(dir);
    writeFileSync(p.active, JSON.stringify({ key: "a", type: "fact", content: "a1", source: "user", tags: [], ts: 1, issue: null, files: [] }) + "\n");
    const before = snapshotStore(dir);
    expect(await run(["compact", "--dir", dir, "--bogus"])).toBe(1);
    expect(snapshotStore(dir)).toEqual(before);
  });

  test("archive --__proto__ x is rejected, names the flag on stderr, and leaves the store untouched (PCO-400 F1)", async () => {
    const p = ensureDir(dir);
    writeFileSync(
      p.active,
      [
        JSON.stringify({ key: "a", type: "fact", content: "a1", source: "user", tags: [], ts: 1, issue: null, files: [] }),
        JSON.stringify({ key: "b", type: "fact", content: "b1", source: "user", tags: [], ts: 2, issue: null, files: [] }),
      ].join("\n") + "\n",
    );
    const before = snapshotStore(dir);
    const { code, err } = await cli(["archive", "--dir", dir, "--__proto__", "x"]);
    expect(code).toBe(1);
    expect(err).toContain("--__proto__");
    expect(snapshotStore(dir)).toEqual(before);
  });

  test("archive --__proto__ with no value is rejected, names the flag on stderr, and leaves the store untouched (PCO-400 F1)", async () => {
    const p = ensureDir(dir);
    writeFileSync(p.active, JSON.stringify({ key: "a", type: "fact", content: "a1", source: "user", tags: [], ts: 1, issue: null, files: [] }) + "\n");
    const before = snapshotStore(dir);
    const { code, err } = await cli(["archive", "--dir", dir, "--__proto__"]);
    expect(code).toBe(1);
    expect(err).toContain("--__proto__");
    expect(snapshotStore(dir)).toEqual(before);
  });

  test("compact --__proto__ x is rejected, names the flag on stderr, and leaves the store untouched (PCO-400 F1)", async () => {
    const p = ensureDir(dir);
    writeFileSync(
      p.active,
      [
        JSON.stringify({ key: "a", type: "fact", content: "a1", source: "user", tags: [], ts: 1, issue: null, files: [] }),
        JSON.stringify({ key: "a", type: "fact", content: "a2", source: "user", tags: [], ts: 2, issue: null, files: [] }),
      ].join("\n") + "\n",
    );
    const before = snapshotStore(dir);
    const { code, err } = await cli(["compact", "--dir", dir, "--__proto__", "x"]);
    expect(code).toBe(1);
    expect(err).toContain("--__proto__");
    expect(snapshotStore(dir)).toEqual(before);
  });

  test("archive --dry-run --bogus: the flag rejection wins (PCO-400)", async () => {
    const p = ensureDir(dir);
    writeFileSync(p.active, JSON.stringify({ key: "a", type: "fact", content: "a1", source: "user", tags: [], ts: 1, issue: null, files: [] }) + "\n");
    const before = snapshotStore(dir);
    expect(await run(["archive", "--dir", dir, "--dry-run", "--bogus"])).toBe(1);
    expect(snapshotStore(dir)).toEqual(before);
  });

  test("compact --dry-run 1 binds a string and is rejected; no compaction runs (PCO-400)", async () => {
    const p = ensureDir(dir);
    writeFileSync(
      p.active,
      [
        JSON.stringify({ key: "a", type: "fact", content: "a1", source: "user", tags: [], ts: 1, issue: null, files: [] }),
        JSON.stringify({ key: "a", type: "fact", content: "a2", source: "user", tags: [], ts: 2, issue: null, files: [] }),
      ].join("\n") + "\n",
    );
    const before = snapshotStore(dir);
    expect(await run(["compact", "--dir", dir, "--dry-run", "1"])).toBe(1);
    expect(snapshotStore(dir)).toEqual(before);
  });

  test("plain compact --dry-run still previews (PCO-400)", async () => {
    const p = ensureDir(dir);
    writeFileSync(
      p.active,
      [
        JSON.stringify({ key: "a", type: "fact", content: "a1", source: "user", tags: [], ts: 1, issue: null, files: [] }),
        JSON.stringify({ key: "a", type: "fact", content: "a2", source: "user", tags: [], ts: 2, issue: null, files: [] }),
      ].join("\n") + "\n",
    );
    expect(await run(["compact", "--dir", dir, "--dry-run"])).toBe(0);
    expect(readEntries(dir).map((e) => e.content)).toEqual(["a1", "a2"]);
  });

  test("archive --key archives exactly the requested keys (PCO-400)", async () => {
    const p = ensureDir(dir);
    writeFileSync(
      p.active,
      [
        JSON.stringify({ key: "k1", type: "fact", content: "c1", source: "user", tags: [], ts: 1, issue: null, files: [] }),
        JSON.stringify({ key: "k2", type: "fact", content: "c2", source: "user", tags: [], ts: 2, issue: null, files: [] }),
        JSON.stringify({ key: "k3", type: "fact", content: "c3", source: "user", tags: [], ts: 3, issue: null, files: [] }),
      ].join("\n") + "\n",
    );
    expect(await run(["archive", "--dir", dir, "--key", "k1", "--key", "k2"])).toBe(0);
    expect(readEntries(dir).map((e) => e.key)).toEqual(["k3"]);
    expect(readArchiveEntries(dir).map((e) => e.key).sort()).toEqual(["k1", "k2"]);
  });

  test("archive --key reports missing keys and archives nothing, fail-closed (PCO-400)", async () => {
    const p = ensureDir(dir);
    writeFileSync(p.active, JSON.stringify({ key: "k1", type: "fact", content: "c1", source: "user", tags: [], ts: 1, issue: null, files: [] }) + "\n");
    expect(await run(["archive", "--dir", dir, "--key", "nope"])).toBe(1);
    expect(readEntries(dir).length).toBe(1);
    expect(readArchiveEntries(dir).length).toBe(0);
  });

  test("archive --key with a mix of present and missing keys archives nothing (PCO-400)", async () => {
    const p = ensureDir(dir);
    writeFileSync(
      p.active,
      [
        JSON.stringify({ key: "k1", type: "fact", content: "c1", source: "user", tags: [], ts: 1, issue: null, files: [] }),
        JSON.stringify({ key: "k2", type: "fact", content: "c2", source: "user", tags: [], ts: 2, issue: null, files: [] }),
      ].join("\n") + "\n",
    );
    expect(await run(["archive", "--dir", dir, "--key", "k1", "--key", "nope"])).toBe(1);
    expect(readEntries(dir).length).toBe(2);
    expect(readArchiveEntries(dir).length).toBe(0);
  });

  test("archive --key '' is rejected (PCO-400)", async () => {
    const p = ensureDir(dir);
    writeFileSync(p.active, JSON.stringify({ key: "k1", type: "fact", content: "c1", source: "user", tags: [], ts: 1, issue: null, files: [] }) + "\n");
    expect(await run(["archive", "--dir", dir, "--key", ""])).toBe(1);
    expect(readEntries(dir).length).toBe(1);
  });

  test("archive --key with --days is rejected (PCO-400)", async () => {
    const p = ensureDir(dir);
    writeFileSync(p.active, JSON.stringify({ key: "k1", type: "fact", content: "c1", source: "user", tags: [], ts: 1, issue: null, files: [] }) + "\n");
    expect(await run(["archive", "--dir", dir, "--key", "k1", "--days", "30"])).toBe(1);
    expect(readEntries(dir).length).toBe(1);
  });

  test("archive --key archives every row for a duplicated key (PCO-400)", async () => {
    const p = ensureDir(dir);
    writeFileSync(
      p.active,
      [
        JSON.stringify({ key: "dup", type: "fact", content: "c1", source: "user", tags: [], ts: 1, issue: null, files: [] }),
        JSON.stringify({ key: "dup", type: "fact", content: "c2", source: "user", tags: [], ts: 2, issue: null, files: [] }),
        JSON.stringify({ key: "other", type: "fact", content: "c3", source: "user", tags: [], ts: 3, issue: null, files: [] }),
      ].join("\n") + "\n",
    );
    expect(await run(["archive", "--dir", dir, "--key", "dup"])).toBe(0);
    expect(readEntries(dir).map((e) => e.key)).toEqual(["other"]);
    expect(readArchiveEntries(dir).map((e) => e.content)).toEqual(["c1", "c2"]);
  });

  test("archive --dry-run --key changes nothing on disk, including index.db (PCO-400)", async () => {
    const p = ensureDir(dir);
    writeFileSync(p.active, JSON.stringify({ key: "k1", type: "fact", content: "c1", source: "user", tags: [], ts: 1, issue: null, files: [] }) + "\n");
    buildIndex(dir); // establish a concrete index.db so "unchanged" isn't vacuously true
    const before = snapshotStore(dir);
    expect(await run(["archive", "--dir", dir, "--dry-run", "--key", "k1"])).toBe(0);
    expect(snapshotStore(dir)).toEqual(before);
  });

  test("archive --dry-run --days changes nothing on disk, including index.db (PCO-400)", async () => {
    const p = ensureDir(dir);
    const past = Math.floor(Date.now() / 1000) - 3600;
    writeFileSync(p.active, JSON.stringify({ key: "k1", type: "fact", content: "c1", source: "user", tags: [], ts: past, issue: null, files: [] }) + "\n");
    buildIndex(dir); // establish a concrete index.db so "unchanged" isn't vacuously true
    const before = snapshotStore(dir);
    expect(await run(["archive", "--dir", dir, "--dry-run", "--days", "0"])).toBe(0);
    expect(snapshotStore(dir)).toEqual(before);
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

  test("kb constructor exits 1 with usage on stderr instead of throwing (PCO-400 F2)", async () => {
    const { code, err } = await cli(["constructor", "--dir", dir]);
    expect(code).toBe(1);
    expect(err).toContain("usage:");
    expect(err).not.toContain("TypeError");
  });

  test("kb toString exits 1 with usage on stderr instead of throwing (PCO-400 F2)", async () => {
    const { code, err } = await cli(["toString", "--dir", dir]);
    expect(code).toBe(1);
    expect(err).toContain("usage:");
    expect(err).not.toContain("TypeError");
  });

  test("archive --days -1 names the flag on stderr (PCO-339)", async () => {
    const { code, err } = await cli(["archive", "--dir", dir, "--days", "-1"]);
    expect(code).toBe(1);
    expect(err).toContain("--days");
  });

  test("archive --days 1e3 names the flag on stderr (PCO-339 F4)", async () => {
    const { code, err } = await cli(["archive", "--dir", dir, "--days", "1e3"]);
    expect(code).toBe(1);
    expect(err).toContain("--days");
  });

  test("archive --days error message names integers, not just non-negative numbers (PCO-339 F3)", async () => {
    const { err } = await cli(["archive", "--dir", dir, "--days", "1.5"]);
    expect(err).toContain("non-negative integer");
    expect(err).not.toContain("non-negative number");
  });

  test("recall --since error message names integers, not just non-negative numbers (PCO-339 F3)", async () => {
    const { err } = await cli(["recall", "x", "--dir", dir, "--since", "1.5"]);
    expect(err).toContain("non-negative integer");
    expect(err).not.toContain("non-negative number");
  });

  test("recall --limit error message names integers, not just non-negative numbers (PCO-339 F3)", async () => {
    const { err } = await cli(["recall", "x", "--dir", dir, "--limit", "2.7"]);
    expect(err).toContain("non-negative integer");
    expect(err).not.toContain("non-negative number");
  });

  test("archive --help prints the full usage, including --key and --dry-run, and creates nothing (PCO-400 F4)", async () => {
    const missing = join(dir, "missing");
    const { code, out } = await cli(["archive", "--help", "--dir", missing]);
    expect(code).toBe(0);
    expect(out).toContain("usage:");
    expect(out).toContain("--key");
    expect(out).toContain("--dry-run");
    expect(existsSync(missing)).toBe(false);
  });

  test("archive --bogus names the flag on stderr (PCO-400)", async () => {
    const { code, err } = await cli(["archive", "--dir", dir, "--bogus"]);
    expect(code).toBe(1);
    expect(err).toContain("--bogus");
  });

  test("compact --bogus names the flag on stderr (PCO-400)", async () => {
    const { code, err } = await cli(["compact", "--dir", dir, "--bogus"]);
    expect(code).toBe(1);
    expect(err).toContain("--bogus");
  });

  test("archive --key with --days names both flags on stderr (PCO-400)", async () => {
    const { code, err } = await cli(["archive", "--dir", dir, "--key", "k1", "--days", "30"]);
    expect(code).toBe(1);
    expect(err).toContain("--key");
    expect(err).toContain("--days");
  });

  test("archive --key with a missing key reports it on stderr and writes nothing to stdout (PCO-400)", async () => {
    const { code, out, err } = await cli(["archive", "--dir", dir, "--key", "nope"]);
    expect(code).toBe(1);
    expect(err).toContain("nope");
    expect(out).toBe("");
  });

  test("archive --key '' names the empty-key message on stderr (PCO-400 F6)", async () => {
    const p = ensureDir(dir);
    writeFileSync(p.active, JSON.stringify({ key: "k1", type: "fact", content: "c1", source: "user", tags: [], ts: 1, issue: null, files: [] }) + "\n");
    const { code, err } = await cli(["archive", "--dir", dir, "--key", ""]);
    expect(code).toBe(1);
    expect(err).toContain("--key must not be empty");
  });

  test("archive --key real run includes the archived keys in JSON (PCO-400 F5)", async () => {
    const p = ensureDir(dir);
    writeFileSync(p.active, JSON.stringify({ key: "k1", type: "fact", content: "c1", source: "user", tags: [], ts: 1, issue: null, files: [] }) + "\n");
    const { code, out } = await cli(["archive", "--dir", dir, "--key", "k1"]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ archived: 1, dryRun: false, keys: ["k1"] });
  });

  test("archive --dry-run --key prints the archived keys in JSON (PCO-400)", async () => {
    const p = ensureDir(dir);
    writeFileSync(
      p.active,
      [
        JSON.stringify({ key: "k1", type: "fact", content: "c1", source: "user", tags: [], ts: 1, issue: null, files: [] }),
        JSON.stringify({ key: "k2", type: "fact", content: "c2", source: "user", tags: [], ts: 2, issue: null, files: [] }),
      ].join("\n") + "\n",
    );
    const { code, out } = await cli(["archive", "--dir", dir, "--dry-run", "--key", "k1"]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ archived: 1, dryRun: true, keys: ["k1"] });
  });

  test("archive --dry-run --days prints the archived keys in JSON (PCO-400)", async () => {
    const p = ensureDir(dir);
    const past = Math.floor(Date.now() / 1000) - 3600;
    writeFileSync(
      p.active,
      JSON.stringify({ key: "k1", type: "fact", content: "c1", source: "user", tags: [], ts: past, issue: null, files: [] }) + "\n",
    );
    const { code, out } = await cli(["archive", "--dir", dir, "--dry-run", "--days", "0"]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ archived: 1, dryRun: true, keys: ["k1"] });
  });

  test("archive --days real run omits keys, since it could be the whole store (PCO-400)", async () => {
    const p = ensureDir(dir);
    const past = Math.floor(Date.now() / 1000) - 3600;
    writeFileSync(
      p.active,
      JSON.stringify({ key: "k1", type: "fact", content: "c1", source: "user", tags: [], ts: past, issue: null, files: [] }) + "\n",
    );
    const { code, out } = await cli(["archive", "--dir", dir, "--days", "0"]);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ archived: 1, dryRun: false });
  });
});
