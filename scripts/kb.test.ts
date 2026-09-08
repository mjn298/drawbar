import { test, expect, describe, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run, parseFlags } from "./kb";
import { readEntries, readArchiveEntries, ensureDir } from "./lib/store";
import { buildIndex } from "./lib/fts";
import { KNOWLEDGE_TYPES } from "./lib/schema";

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

describe("parseFlags (unit)", () => {
  test("a bare -- ends option parsing; everything after is positional (PCO-402 LD14)", () => {
    const { positionals, flags } = parseFlags(["--", "--weird"]);
    expect(positionals).toEqual(["--weird"]);
    expect(Object.keys(flags)).toEqual([]);
  });

  test("a bare -- ends option parsing even mid-argv, and later -- tokens are literal positionals", () => {
    const { positionals, flags } = parseFlags(["--dir", "x", "--", "--dir", "--"]);
    expect(flags.dir).toBe("x");
    expect(positionals).toEqual(["--dir", "--"]);
  });
});

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

// The per-command flag sets from the story's "Per-command flag sets (authoritative)" table.
const EXPECTED_FLAGS: Record<string, string[]> = {
  add: [],
  recall: ["type", "tag", "file", "since", "limit", "json", "all"],
  reindex: [],
  stats: ["json"],
  archive: ["days", "key", "dry-run"],
  compact: ["dry-run"],
  import: [],
  context: ["json"],
  path: [],
};
const ALL_COMMANDS = Object.keys(EXPECTED_FLAGS);

describe("flag table for every command (PCO-402)", () => {
  for (const cmd of ALL_COMMANDS) {
    test(`${cmd} --help prints usage on stdout, exits 0, and creates nothing`, async () => {
      const missing = join(dir, "missing");
      const { code, out } = await cli([cmd, "--help", "--dir", missing]);
      expect(code).toBe(0);
      expect(out).toContain("usage:");
      expect(existsSync(missing)).toBe(false);
    });

    test(`${cmd} -h prints usage on stdout, exits 0, and creates nothing`, async () => {
      const missing = join(dir, "missing");
      const { code, out } = await cli([cmd, "-h", "--dir", missing]);
      expect(code).toBe(0);
      expect(out).toContain("usage:");
      expect(existsSync(missing)).toBe(false);
    });

    test(`generated usage for ${cmd} names every flag in its row`, async () => {
      const missing = join(dir, "missing");
      const { out } = await cli([cmd, "--help", "--dir", missing]);
      for (const flag of EXPECTED_FLAGS[cmd]!) {
        expect(out, `usage for ${cmd} is missing --${flag}`).toContain(`--${flag}`);
      }
      expect(out).toContain("--dir");
      expect(out).toContain("--project");
      expect(out).toContain("--help");
    });

    test(`generated usage for ${cmd} names -h alongside --help (PCO-402 fix pass)`, async () => {
      const missing = join(dir, "missing");
      const { out } = await cli([cmd, "--help", "--dir", missing]);
      // Bare `.toContain("-h")` would pass vacuously: "--help" itself contains the substring
      // "-h". Require -h as its own token, not embedded inside --help.
      expect(out).toMatch(/(^|[\s[|])-h([\s\]|]|$)/);
    });
  }

  test("top-level usage names -h alongside --help (PCO-402 fix pass)", async () => {
    const { out } = await cli(["--help"]);
    expect(out).toMatch(/(^|[\s[|])-h([\s\]|]|$)/);
  });

  test("--help and help print the top-level listing on stdout, exit 0, and create nothing", async () => {
    for (const args of [["--help"], ["help"]]) {
      const missing = join(dir, "missing");
      const { code, out } = await cli([...args, "--dir", missing]);
      expect(code).toBe(0);
      expect(out).toContain("usage:");
      for (const cmd of ALL_COMMANDS) expect(out).toContain(cmd);
      expect(existsSync(missing)).toBe(false);
    }
  });

  // A genuinely bare invocation takes no arguments at all, so it cannot also carry --dir --
  // it never reaches resolveContext, so nothing is at risk of being created regardless.
  test("a bare invocation (no args at all) prints the top-level listing on stdout, exit 0", async () => {
    const { code, out } = await cli([]);
    expect(code).toBe(0);
    expect(out).toContain("usage:");
    for (const cmd of ALL_COMMANDS) expect(out).toContain(cmd);
  });

  test("bogus --help prints the same top-level listing on stderr, exits 1", async () => {
    const missing = join(dir, "missing");
    const { code, out, err } = await cli(["bogus", "--help", "--dir", missing]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("usage:");
    expect(existsSync(missing)).toBe(false);
  });

  test("archive -h resolves the command before printing help, so it gets archive's own usage", async () => {
    const { out } = await cli(["archive", "-h", "--dir", dir]);
    expect(out).toContain("--key");
    expect(out).toContain("--dry-run");
  });

  test("recall -- -h treats -h after -- as a literal query term, not a help flag", async () => {
    const { code, out } = await cli(["recall", "--dir", dir, "--", "-h"]);
    expect(code).toBe(0);
    expect(out).not.toContain("usage:");
  });

  test("archive --help | cat is not truncated by process.exit in the import.meta.main block", async () => {
    const proc = Bun.spawnSync(
      ["bash", "-c", `bun run ${JSON.stringify(join(import.meta.dir, "kb.ts"))} archive --help --dir ${JSON.stringify(dir)} | cat`],
    );
    const out = proc.stdout.toString();
    expect(out).toContain("usage:");
    expect(out).toContain("--dry-run");
  });

  test("stats --days 30 is rejected: --days is not a stats flag", async () => {
    expect(await run(["stats", "--dir", dir, "--days", "30"])).toBe(1);
  });

  // toBe(1) alone pins *a* failure, not *which*: a wrong-flag message, or one routed to
  // stdout, would leave that assertion green. Pin the exact stderr text and an empty stdout.
  test("stats --days 30 names the unknown flag on stderr, and stdout is empty (PCO-402 fix pass)", async () => {
    const { code, out, err } = await cli(["stats", "--dir", dir, "--days", "30"]);
    expect(code).toBe(1);
    expect(err).toBe("stats: unknown flag --days\n");
    expect(out).toBe("");
  });

  test(`recall --json "content" is rejected: --json is boolean-typed and does not take a value`, async () => {
    expect(await run(["recall", "--dir", dir, "--json", "content"])).toBe(1);
  });

  test("recall --json content names --json does-not-take-a-value on stderr, and stdout is empty (PCO-402 fix pass)", async () => {
    const { code, out, err } = await cli(["recall", "--dir", dir, "--json", "content"]);
    expect(code).toBe(1);
    expect(err).toBe("recall: --json does not take a value\n");
    expect(out).toBe("");
  });

  test("stats --dir with no value is rejected", async () => {
    expect(await run(["stats", "--dir"])).toBe(1);
  });

  test("stats --dir with no value names --dir requires-a-value on stderr, and stdout is empty (PCO-402 fix pass)", async () => {
    const { code, out, err } = await cli(["stats", "--dir"]);
    expect(code).toBe(1);
    expect(err).toBe("stats: --dir requires a value\n");
    expect(out).toBe("");
  });

  test("recall --type fakt is rejected", async () => {
    expect(await run(["recall", "x", "--dir", dir, "--type", "fakt"])).toBe(1);
  });

  test("recall --type fakt names the allowed --type values on stderr, and stdout is empty (PCO-402 fix pass)", async () => {
    const { code, out, err } = await cli(["recall", "x", "--dir", dir, "--type", "fakt"]);
    expect(code).toBe(1);
    expect(err).toBe(`recall: --type must be one of: ${KNOWLEDGE_TYPES.join(", ")}\n`);
    expect(out).toBe("");
  });

  test("recall accepts every KNOWLEDGE_TYPES value for --type", async () => {
    for (const t of KNOWLEDGE_TYPES) {
      expect(await run(["recall", "x", "--dir", dir, "--type", t])).toBe(0);
    }
  });

  test("archive 30 (a typo for --days 30) is rejected and archives nothing", async () => {
    const p = ensureDir(dir);
    const old = Math.floor(Date.now() / 1000) - 100 * 86400;
    writeFileSync(p.active, JSON.stringify({ key: "old", type: "fact", content: "c", source: "user", tags: [], ts: old, issue: null, files: [] }) + "\n");
    expect(await run(["archive", "30", "--dir", dir])).toBe(1);
    expect(readEntries(dir).length).toBe(1);
  });

  test("archive 30 names the unexpected-argument(s) message on stderr, and stdout is empty (PCO-402 fix pass)", async () => {
    const { code, out, err } = await cli(["archive", "30", "--dir", dir]);
    expect(code).toBe(1);
    expect(err).toBe("archive: unexpected argument(s): 30\n");
    expect(out).toBe("");
  });

  test("import with zero paths is rejected", async () => {
    expect(await run(["import", "--dir", dir])).toBe(1);
  });

  test("import with two paths is rejected", async () => {
    expect(await run(["import", "a.jsonl", "b.jsonl", "--dir", dir])).toBe(1);
  });

  test('import "" is rejected: run() returns 1, it does not reject (PCO-402 fix pass)', async () => {
    // A test that only checks a subprocess exit code would not catch a rejected promise --
    // `run` must RETURN 1 here, not throw, since positionals=[""] satisfies exact-arity-1.
    expect(await run(["import", "", "--dir", dir])).toBe(1);
  });

  // These three pin the exact stderr text so the import case's try/catch around importLegacy
  // (which also returns 1 for ENOENT/EISDIR) cannot mask the arity or empty-path guards firing
  // above/before it (PCO-402 fix pass).
  test("import with zero paths names the arity failure on stderr, and stdout is empty (PCO-402 fix pass)", async () => {
    const { code, out, err } = await cli(["import", "--dir", dir]);
    expect(code).toBe(1);
    expect(err).toBe("import: expected exactly 1 argument(s), got 0\n");
    expect(out).toBe("");
  });

  test("import with two paths names the arity failure on stderr, and stdout is empty (PCO-402 fix pass)", async () => {
    const { code, out, err } = await cli(["import", "a.jsonl", "b.jsonl", "--dir", dir]);
    expect(code).toBe(1);
    expect(err).toBe("import: expected exactly 1 argument(s), got 2\n");
    expect(out).toBe("");
  });

  test('import "" names the empty-path guard on stderr, not an ENOENT message (PCO-402 fix pass)', async () => {
    const { code, out, err } = await cli(["import", "", "--dir", dir]);
    expect(code).toBe(1);
    expect(err).toBe("import: <path> must not be empty\n");
    expect(out).toBe("");
  });

  test("import against an unreadable path returns 1 instead of throwing (PCO-402 fix pass)", async () => {
    expect(await run(["import", join(dir, "nonexistent.jsonl"), "--dir", dir])).toBe(1);
  });

  test("import against a directory path returns 1 instead of throwing (PCO-402 fix pass)", async () => {
    expect(await run(["import", dir, "--dir", dir])).toBe(1);
  });

  test("archive against a directory with no knowledge.jsonl exits 1", async () => {
    expect(await run(["archive", "--dir", dir])).toBe(1);
  });

  test("archive against a directory with no knowledge.jsonl names the store path on stderr, and stdout is empty (PCO-402 fix pass)", async () => {
    const { code, out, err } = await cli(["archive", "--dir", dir]);
    expect(code).toBe(1);
    expect(err).toBe(`archive: no knowledge store found at ${dir}\n`);
    expect(out).toBe("");
  });

  test("compact against a directory with no knowledge.jsonl exits 1", async () => {
    expect(await run(["compact", "--dir", dir])).toBe(1);
  });

  test("compact against a directory with no knowledge.jsonl names the store path on stderr, and stdout is empty (PCO-402 fix pass)", async () => {
    const { code, out, err } = await cli(["compact", "--dir", dir]);
    expect(code).toBe(1);
    expect(err).toBe(`compact: no knowledge store found at ${dir}\n`);
    expect(out).toBe("");
  });

  test("archive (days-based) against a NONEXISTENT dir refuses without creating it (LD18, PCO-402 fix pass)", async () => {
    const missing = join(dir, "missing");
    expect(await run(["archive", "--dir", missing])).toBe(1);
    expect(existsSync(missing)).toBe(false);
  });

  test("compact against a NONEXISTENT dir refuses without creating it (LD18, PCO-402 fix pass)", async () => {
    const missing = join(dir, "missing");
    expect(await run(["compact", "--dir", missing])).toBe(1);
    expect(existsSync(missing)).toBe(false);
  });

  test("stats --json against a nonexistent directory still creates it and reports zero entries", async () => {
    const missing = join(dir, "missing");
    const { code, out } = await cli(["stats", "--dir", missing, "--json"]);
    expect(code).toBe(0);
    expect(existsSync(missing)).toBe(true);
    expect(JSON.parse(out)).toEqual({ active: 0, archived: 0, duplicateKeys: 0, byType: {} });
  });

  test("context against a nonexistent directory answers without creating it", async () => {
    const missing = join(dir, "missing");
    const { code } = await cli(["context", "--dir", missing]);
    expect(code).toBe(0);
    expect(existsSync(missing)).toBe(false);
  });

  test("path against a nonexistent directory answers without creating it", async () => {
    const missing = join(dir, "missing");
    const { code, out } = await cli(["path", "--dir", missing]);
    expect(code).toBe(0);
    expect(out.trim()).toBe(missing);
    expect(existsSync(missing)).toBe(false);
  });

  // Positive coverage: every live invocation in the Read set's grep, one row per command.
  test("path (bare) exits 0", async () => {
    expect(await run(["path", "--dir", dir])).toBe(0);
  });

  test("context and context --json exit 0", async () => {
    expect(await run(["context", "--dir", dir])).toBe(0);
    expect(await run(["context", "--dir", dir, "--json"])).toBe(0);
  });

  test("stats and stats --json exit 0", async () => {
    expect(await run(["stats", "--dir", dir])).toBe(0);
    expect(await run(["stats", "--dir", dir, "--json"])).toBe(0);
  });

  test("reindex --dir exits 0", async () => {
    expect(await run(["reindex", "--dir", dir])).toBe(0);
  });

  test('recall "<query>" --dir --json exits 0', async () => {
    expect(await run(["recall", "some query", "--dir", dir, "--json"])).toBe(0);
  });

  test("recall with every documented filter flag exits 0", async () => {
    expect(await run([
      "recall", "q", "--dir", dir,
      "--type", "fact", "--tag", "t", "--file", "f.ts", "--since", "0", "--limit", "5", "--all",
    ])).toBe(0);
  });

  test("add --dir reads stdin and exits 0", async () => {
    const entry = JSON.stringify({ key: "row-cov", type: "fact", content: "c", ts: 1 });
    const { code } = await cli(["add", "--dir", dir], entry);
    expect(code).toBe(0);
  });

  test('import "<path>" exits 0 against a real legacy file', async () => {
    const legacy = join(dir, "legacy.jsonl");
    writeFileSync(legacy, JSON.stringify({ key: "legacy-1", type: "fact", content: "c", ts: 1 }) + "\n");
    expect(await run(["import", legacy, "--dir", dir])).toBe(0);
  });

  test("archive --days <n> exits 0", async () => {
    await cli(["add", "--dir", dir], JSON.stringify({ key: "a1", type: "fact", content: "c", ts: 1 }));
    expect(await run(["archive", "--dir", dir, "--days", "90"])).toBe(0);
  });

  test("compact and compact --dry-run exit 0", async () => {
    await cli(["add", "--dir", dir], JSON.stringify({ key: "c1", type: "fact", content: "c", ts: 1 }));
    expect(await run(["compact", "--dir", dir, "--dry-run"])).toBe(0);
    expect(await run(["compact", "--dir", dir])).toBe(0);
  });
});
