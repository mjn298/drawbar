import { test, expect, describe, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  storePaths, ensureDir, readEntries, appendEntry, archiveOlderThan,
  readArchiveEntries, compactActive, archiveByKeys,
} from "./store";
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

  test("fresh .gitignore also ignores the archive file", () => {
    ensureDir(dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toContain("knowledge.archive.jsonl");
  });

  test("leaves an existing .gitignore untouched", () => {
    writeFileSync(join(dir, ".gitignore"), "custom\n");
    ensureDir(dir);
    expect(readFileSync(join(dir, ".gitignore"), "utf8")).toBe("custom\n");
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

  test("is idempotent when only ts differs (a plain re-add)", () => {
    expect(appendEntry(dir, entry({ ts: 100 })).written).toBe(true);
    expect(appendEntry(dir, entry({ ts: 999 }))).toEqual({ written: false, superseded: false });
    expect(readEntries(dir).length).toBe(1);
  });

  test("supersedes on a metadata-only correction (same content, changed issue)", () => {
    appendEntry(dir, entry({ content: "same", issue: "PAS-3305", ts: 1 }));
    const res = appendEntry(dir, entry({ content: "same", issue: "PAS-3271", ts: 2 }));
    expect(res).toEqual({ written: true, superseded: true });
    expect(readEntries(dir).length).toBe(1);
    expect(readEntries(dir)[0]!.issue).toBe("PAS-3271");
    expect(readArchiveEntries(dir).map((e) => e.issue)).toEqual(["PAS-3305"]);
  });

  test("supersedes when only tags change", () => {
    appendEntry(dir, entry({ content: "same", tags: ["a"], ts: 1 }));
    expect(appendEntry(dir, entry({ content: "same", tags: ["a", "b"], ts: 2 })).superseded).toBe(true);
    expect(readEntries(dir)[0]!.tags).toEqual(["a", "b"]);
  });

  test("upserts in place when content changes for same key, archiving the old copy", () => {
    appendEntry(dir, entry({ content: "v1", ts: 1 }));
    const res = appendEntry(dir, entry({ content: "v2", ts: 2 }));
    expect(res).toEqual({ written: true, superseded: true });
    expect(readEntries(dir).length).toBe(1);
    expect(readEntries(dir)[0]!.content).toBe("v2");
    expect(readArchiveEntries(dir).map((e) => e.content)).toEqual(["v1"]);
  });

  test("reports written:true, superseded:false for a brand new key", () => {
    expect(appendEntry(dir, entry())).toEqual({ written: true, superseded: false });
  });

  test("upsert preserves line position in the active file", () => {
    appendEntry(dir, entry({ key: "a", content: "a1", ts: 1 }));
    appendEntry(dir, entry({ key: "b", content: "b1", ts: 2 }));
    appendEntry(dir, entry({ key: "c", content: "c1", ts: 3 }));
    appendEntry(dir, entry({ key: "b", content: "b2", ts: 4 }));
    expect(readEntries(dir).map((e) => e.key)).toEqual(["a", "b", "c"]);
    expect(readEntries(dir).find((e) => e.key === "b")!.content).toBe("b2");
  });

  test("collapses pre-existing duplicate lines for a key on next upsert", () => {
    const p = ensureDir(dir);
    writeFileSync(
      p.active,
      [
        JSON.stringify(entry({ key: "a", content: "a1", ts: 1 })),
        JSON.stringify(entry({ key: "a", content: "a2", ts: 2 })),
        JSON.stringify(entry({ key: "b", content: "b1", ts: 3 })),
      ].join("\n") + "\n",
    );
    const res = appendEntry(dir, entry({ key: "a", content: "a3", ts: 4 }));
    expect(res).toEqual({ written: true, superseded: true });
    expect(readEntries(dir).map((e) => e.key)).toEqual(["a", "b"]);
    expect(readEntries(dir).find((e) => e.key === "a")!.content).toBe("a3");
    expect(readArchiveEntries(dir).map((e) => e.content).sort()).toEqual(["a1", "a2"]);
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

  test("leaves no temp file behind and keeps the active file intact", () => {
    appendEntry(dir, entry({ key: "old", ts: 10 }));
    appendEntry(dir, entry({ key: "keep", ts: 200 }));
    archiveOlderThan(dir, 100);
    expect(existsSync(storePaths(dir).active + ".tmp")).toBe(false);
    expect(readEntries(dir).map((e) => e.key)).toEqual(["keep"]);
  });

  test("--dry-run reports what would move but changes nothing on disk", () => {
    appendEntry(dir, entry({ key: "old", ts: 10 }));
    appendEntry(dir, entry({ key: "new", ts: 200 }));
    const activeBefore = readFileSync(storePaths(dir).active, "utf8");
    expect(existsSync(storePaths(dir).archive)).toBe(false);

    const res = archiveOlderThan(dir, 100, { dryRun: true });
    expect(res.archived).toBe(1);
    expect(res.keys).toEqual(["old"]);

    expect(readFileSync(storePaths(dir).active, "utf8")).toBe(activeBefore);
    expect(existsSync(storePaths(dir).archive)).toBe(false);
  });
});

describe("archiveByKeys", () => {
  test("moves exactly the named entries and leaves others active", () => {
    appendEntry(dir, entry({ key: "a", ts: 1 }));
    appendEntry(dir, entry({ key: "b", ts: 2 }));
    appendEntry(dir, entry({ key: "c", ts: 3 }));

    const res = archiveByKeys(dir, ["b"]);
    expect(res.archived).toBe(1);
    expect(res.keys).toEqual(["b"]);
    expect(res.missing).toEqual([]);

    expect(readEntries(dir).map((e) => e.key)).toEqual(["a", "c"]);
    expect(readArchiveEntries(dir).map((e) => e.key)).toEqual(["b"]);
  });

  test("archives nothing and reports the missing key when it matches no active row", () => {
    appendEntry(dir, entry({ key: "a", ts: 1 }));
    const activeBefore = readFileSync(storePaths(dir).active, "utf8");
    expect(existsSync(storePaths(dir).archive)).toBe(false);

    const res = archiveByKeys(dir, ["nope"]);
    expect(res.archived).toBe(0);
    expect(res.keys).toEqual([]);
    expect(res.missing).toEqual(["nope"]);

    expect(readFileSync(storePaths(dir).active, "utf8")).toBe(activeBefore);
    expect(existsSync(storePaths(dir).archive)).toBe(false);
  });

  test("mixed present/missing keys archives nothing (fail closed)", () => {
    appendEntry(dir, entry({ key: "a", ts: 1 }));
    appendEntry(dir, entry({ key: "b", ts: 2 }));
    const activeBefore = readFileSync(storePaths(dir).active, "utf8");
    expect(existsSync(storePaths(dir).archive)).toBe(false);

    const res = archiveByKeys(dir, ["a", "nope"]);
    expect(res.archived).toBe(0);
    expect(res.missing).toEqual(["nope"]);

    expect(readFileSync(storePaths(dir).active, "utf8")).toBe(activeBefore);
    expect(existsSync(storePaths(dir).archive)).toBe(false);
  });

  test("moves every duplicate row for a key that matches more than one", () => {
    const p = ensureDir(dir);
    writeFileSync(
      p.active,
      [
        JSON.stringify(entry({ key: "a", content: "a1", ts: 1 })),
        JSON.stringify(entry({ key: "a", content: "a2", ts: 2 })),
        JSON.stringify(entry({ key: "b", content: "b1", ts: 3 })),
      ].join("\n") + "\n",
    );

    const res = archiveByKeys(dir, ["a"]);
    expect(res.archived).toBe(2);
    expect(readEntries(dir).map((e) => e.key)).toEqual(["b"]);
    expect(readArchiveEntries(dir).map((e) => e.content).sort()).toEqual(["a1", "a2"]);
  });

  test("a repeated identical requested key behaves as one request", () => {
    appendEntry(dir, entry({ key: "a", ts: 1 }));
    appendEntry(dir, entry({ key: "b", ts: 2 }));

    const res = archiveByKeys(dir, ["a", "a"]);
    expect(res.archived).toBe(1);
    expect(res.keys).toEqual(["a"]);
    expect(readEntries(dir).map((e) => e.key)).toEqual(["b"]);
  });

  test("--dry-run reports the match but changes nothing on disk", () => {
    appendEntry(dir, entry({ key: "a", ts: 1 }));
    appendEntry(dir, entry({ key: "b", ts: 2 }));
    const activeBefore = readFileSync(storePaths(dir).active, "utf8");
    expect(existsSync(storePaths(dir).archive)).toBe(false);

    const res = archiveByKeys(dir, ["a"], { dryRun: true });
    expect(res.archived).toBe(1);
    expect(res.keys).toEqual(["a"]);
    expect(res.missing).toEqual([]);

    expect(readFileSync(storePaths(dir).active, "utf8")).toBe(activeBefore);
    expect(existsSync(storePaths(dir).archive)).toBe(false);
  });

  test("dry-run with a missing key changes nothing and reports it missing", () => {
    appendEntry(dir, entry({ key: "a", ts: 1 }));
    const activeBefore = readFileSync(storePaths(dir).active, "utf8");

    const res = archiveByKeys(dir, ["nope"], { dryRun: true });
    expect(res.archived).toBe(0);
    expect(res.missing).toEqual(["nope"]);
    expect(readFileSync(storePaths(dir).active, "utf8")).toBe(activeBefore);
    expect(existsSync(storePaths(dir).archive)).toBe(false);
  });

  test("empty store: any requested key is reported missing, nothing archived", () => {
    const res = archiveByKeys(dir, ["anything"]);
    expect(res.archived).toBe(0);
    expect(res.missing).toEqual(["anything"]);
    expect(existsSync(storePaths(dir).archive)).toBe(false);
  });

  test("empty key list is a no-op: active file untouched, no archive created", () => {
    const p = ensureDir(dir);
    // A malformed line would be silently dropped by a rewrite; an empty
    // request must not touch the file at all.
    writeFileSync(
      p.active,
      '{"bad json\n' + JSON.stringify(entry({ key: "a" })) + "\n",
    );
    const activeBefore = readFileSync(storePaths(dir).active, "utf8");

    const res = archiveByKeys(dir, []);
    expect(res).toEqual({ archived: 0, keys: [], missing: [] });
    expect(readFileSync(storePaths(dir).active, "utf8")).toBe(activeBefore);
    expect(existsSync(storePaths(dir).archive)).toBe(false);
  });

  test("every entry matches: whole store moves to archive", () => {
    appendEntry(dir, entry({ key: "a", ts: 1 }));
    appendEntry(dir, entry({ key: "b", ts: 2 }));

    const res = archiveByKeys(dir, ["a", "b"]);
    expect(res.archived).toBe(2);
    expect(res.keys.sort()).toEqual(["a", "b"]);
    expect(readEntries(dir).length).toBe(0);
    expect(readArchiveEntries(dir).map((e) => e.key).sort()).toEqual(["a", "b"]);
  });
});

describe("compactActive", () => {
  function writeRawActive(lines: Entry[]) {
    const p = ensureDir(dir);
    writeFileSync(p.active, lines.map((e) => JSON.stringify(e)).join("\n") + "\n");
  }

  test("collapses duplicate keys to newest-per-key, later line wins on ts tie", () => {
    writeRawActive([
      entry({ key: "a", content: "a1", ts: 1 }),
      entry({ key: "b", content: "b1", ts: 5 }),
      entry({ key: "a", content: "a2", ts: 5 }),
      entry({ key: "a", content: "a3", ts: 5 }),
    ]);
    const res = compactActive(dir);
    expect(res).toEqual({ scanned: 4, keys: 2, removed: 2 });
    expect(readEntries(dir).map((e) => e.key)).toEqual(["a", "b"]);
    expect(readEntries(dir).find((e) => e.key === "a")!.content).toBe("a3");
    expect(readArchiveEntries(dir).map((e) => e.content).sort()).toEqual(["a1", "a2"]);
  });

  test("is a no-op on a clean store", () => {
    appendEntry(dir, entry({ key: "a", ts: 1 }));
    appendEntry(dir, entry({ key: "b", ts: 2 }));
    const res = compactActive(dir);
    expect(res).toEqual({ scanned: 2, keys: 2, removed: 0 });
    expect(readEntries(dir).map((e) => e.key)).toEqual(["a", "b"]);
    expect(readArchiveEntries(dir).length).toBe(0);
  });

  test("--dry-run reports the same numbers but changes nothing on disk", () => {
    writeRawActive([
      entry({ key: "a", content: "a1", ts: 1 }),
      entry({ key: "a", content: "a2", ts: 2 }),
    ]);
    const before = readFileSync(storePaths(dir).active, "utf8");
    const res = compactActive(dir, { dryRun: true });
    expect(res).toEqual({ scanned: 2, keys: 1, removed: 1 });
    expect(readFileSync(storePaths(dir).active, "utf8")).toBe(before);
    expect(readArchiveEntries(dir).length).toBe(0);
  });
});
