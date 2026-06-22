import { test, expect, describe, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { storePaths, ensureDir, readEntries, appendEntry, archiveOlderThan } from "./store";
import type { Entry } from "./schema";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-store-"));
});

function entry(over: Partial<Entry> = {}): Entry {
  return {
    key: "k1", type: "fact", content: "hello", source: "user",
    tags: [], ts: 100, issue: null, files: [], ...over,
  };
}

describe("ensureDir", () => {
  test("creates the dir and a .gitignore that ignores index.db", () => {
    const p = ensureDir(dir);
    expect(existsSync(p.dir)).toBe(true);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("index.db");
  });
});

describe("appendEntry + readEntries", () => {
  test("appends then reads back one entry", () => {
    appendEntry(dir, entry());
    const all = readEntries(dir);
    expect(all.length).toBe(1);
    expect(all[0]!.key).toBe("k1");
  });

  test("appends multiple entries in order", () => {
    appendEntry(dir, entry({ key: "a", ts: 1 }));
    appendEntry(dir, entry({ key: "b", ts: 2 }));
    expect(readEntries(dir).map((e) => e.key)).toEqual(["a", "b"]);
  });

  test("is idempotent for identical key+content", () => {
    expect(appendEntry(dir, entry()).written).toBe(true);
    expect(appendEntry(dir, entry()).written).toBe(false);
    expect(readEntries(dir).length).toBe(1);
  });

  test("appends a new revision when content changes for same key", () => {
    appendEntry(dir, entry({ content: "v1", ts: 1 }));
    appendEntry(dir, entry({ content: "v2", ts: 2 }));
    expect(readEntries(dir).length).toBe(2);
  });

  test("throws on an invalid entry instead of writing", () => {
    const bad = { ...entry(), type: "bogus" } as unknown as Entry;
    expect(() => appendEntry(dir, bad)).toThrow();
    expect(existsSync(storePaths(dir).active)).toBe(false);
  });

  test("readEntries skips corrupt lines without throwing", () => {
    const p = ensureDir(dir);
    writeFileSync(p.active, '{"bad json\n' + JSON.stringify(entry({ key: "ok" })) + "\n");
    const all = readEntries(dir);
    expect(all.map((e) => e.key)).toEqual(["ok"]);
  });
});

describe("archiveOlderThan", () => {
  test("moves old entries to archive and keeps recent ones active", () => {
    appendEntry(dir, entry({ key: "old", ts: 10 }));
    appendEntry(dir, entry({ key: "new", ts: 200 }));

    const res = archiveOlderThan(dir, 100);
    expect(res.archived).toBe(1);

    expect(readEntries(dir).map((e) => e.key)).toEqual(["new"]);
    expect(readEntries(dir, { includeArchive: true }).map((e) => e.key).sort())
      .toEqual(["new", "old"]);
  });

  test("is a no-op when nothing is old enough", () => {
    appendEntry(dir, entry({ key: "a", ts: 500 }));
    expect(archiveOlderThan(dir, 100).archived).toBe(0);
    expect(readEntries(dir).length).toBe(1);
  });
});
