import { test, expect, describe, beforeEach } from "bun:test";
import { mkdtempSync, existsSync, utimesSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { appendEntry, storePaths, ensureDir, archiveOlderThan } from "./store";
import { buildIndex, ensureFreshIndex } from "./fts";
import type { Entry } from "./schema";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-fts-"));
});

function entry(over: Partial<Entry> = {}): Entry {
  return {
    key: "k1", type: "fact", content: "hello world", source: "user",
    tags: [], ts: 100, issue: null, files: [], ...over,
  };
}

function rowCount(dir: string): number {
  const db = new Database(storePaths(dir).indexDb);
  const n = (db.query("SELECT count(*) AS n FROM kb").get() as { n: number }).n;
  db.close();
  return n;
}

describe("buildIndex", () => {
  test("creates index.db with one row per entry", () => {
    appendEntry(dir, entry({ key: "a" }));
    appendEntry(dir, entry({ key: "b", content: "different text" }));
    buildIndex(dir);
    expect(existsSync(storePaths(dir).indexDb)).toBe(true);
    expect(rowCount(dir)).toBe(2);
  });

  test("rebuilds from scratch (no duplicate rows on second build)", () => {
    appendEntry(dir, entry());
    buildIndex(dir);
    buildIndex(dir);
    expect(rowCount(dir)).toBe(1);
  });

  test("marks active rows archived=0 and archived rows archived=1", () => {
    appendEntry(dir, entry({ key: "old", ts: 10 }));
    appendEntry(dir, entry({ key: "keep", ts: 200 }));
    archiveOlderThan(dir, 100);
    buildIndex(dir);
    const db = new Database(storePaths(dir).indexDb);
    const rows = db.query("SELECT key, archived FROM kb ORDER BY key").all() as
      { key: string; archived: number }[];
    db.close();
    expect(rows).toEqual([
      { key: "keep", archived: 0 },
      { key: "old", archived: 1 },
    ]);
  });
});

describe("ensureFreshIndex", () => {
  test("builds the index when it does not exist", () => {
    appendEntry(dir, entry());
    ensureFreshIndex(dir);
    expect(existsSync(storePaths(dir).indexDb)).toBe(true);
  });

  test("rebuilds an index left over from an older schema, even if its mtime looks fresh", () => {
    appendEntry(dir, entry({ key: "a", content: "hello upgrade world" }));
    const p = storePaths(dir);

    // An index.db as the pre-`archived` schema built it. It is gitignored, so a
    // real upgrade finds one of these on disk; recall must not throw on it.
    const old = new Database(p.indexDb);
    old.run(`CREATE VIRTUAL TABLE kb USING fts5(
      key, type, content, tags, files, issue, ts UNINDEXED, raw UNINDEXED,
      tokenize = 'porter unicode61');`);
    old.close();
    const future = new Date(Date.now() + 60_000);
    utimesSync(p.indexDb, future, future); // looks fresh by mtime

    expect(recall(dir, "upgrade").map((e) => e.key)).toEqual(["a"]);
  });

  test("rebuilds when the jsonl is newer than index.db", () => {
    appendEntry(dir, entry({ key: "a" }));
    buildIndex(dir);
    // Make the jsonl newer than the db.
    appendEntry(dir, entry({ key: "b", content: "second" }));
    const future = new Date(Date.now() + 10_000);
    utimesSync(storePaths(dir).active, future, future);
    ensureFreshIndex(dir);
    expect(rowCount(dir)).toBe(2);
  });

  test("self-heals an empty index over a non-empty store (mtime looks fresh)", () => {
    // Build an index while the store is empty.
    const p = ensureDir(dir);
    writeFileSync(p.active, "");
    buildIndex(dir);
    expect(rowCount(dir)).toBe(0);

    // The JSONL gains an entry but with an OLDER mtime than the index — as if a
    // git checkout dropped in content under an index that looks fresh by mtime.
    writeFileSync(p.active, JSON.stringify(entry({ key: "healed", content: "self heal me" })) + "\n");
    const past = new Date(Date.now() - 60_000);
    utimesSync(p.active, past, past);

    // recall calls ensureFreshIndex, which should notice the empty index over a
    // non-empty store and rebuild before querying.
    const r = recall(dir, "heal");
    expect(r.map((e) => e.key)).toContain("healed");
    expect(rowCount(dir)).toBe(1);
  });
});

import { recall } from "./fts";

describe("recall", () => {
  beforeEach(() => {
    appendEntry(dir, entry({ key: "auth", type: "pattern", content: "oauth login token refresh", tags: ["auth"], ts: 10 }));
    appendEntry(dir, entry({ key: "db", type: "fact", content: "dynamodb filter expression companyId", files: ["pipeline/index.ts"], ts: 20 }));
    appendEntry(dir, entry({ key: "db2", type: "decision", content: "use single-table dynamodb design", ts: 30 }));
  });

  test("returns entries matching the query, ranked", () => {
    const r = recall(dir, "dynamodb");
    expect(r.length).toBe(2);
    expect(r.map((e) => e.key).sort()).toEqual(["db", "db2"]);
  });

  test("filters by type", () => {
    const r = recall(dir, "dynamodb", { type: "decision" });
    expect(r.map((e) => e.key)).toEqual(["db2"]);
  });

  test("filters by tag", () => {
    const r = recall(dir, "token", { tag: "auth" });
    expect(r.map((e) => e.key)).toEqual(["auth"]);
  });

  test("filters by file", () => {
    const r = recall(dir, "companyId", { file: "pipeline/index.ts" });
    expect(r.map((e) => e.key)).toEqual(["db"]);
  });

  test("filters by since (ts >=)", () => {
    const r = recall(dir, "dynamodb", { since: 25 });
    expect(r.map((e) => e.key)).toEqual(["db2"]);
  });

  test("empty query returns all, newest first", () => {
    const r = recall(dir, "");
    expect(r.map((e) => e.key)).toEqual(["db2", "db", "auth"]);
  });

  test("dedupes by key keeping the latest ts", () => {
    appendEntry(dir, entry({ key: "auth", type: "pattern", content: "oauth login token refresh updated", tags: ["auth"], ts: 99 }));
    const r = recall(dir, "oauth");
    const authRows = r.filter((e) => e.key === "auth");
    expect(authRows.length).toBe(1);
    expect(authRows[0]!.ts).toBe(99);
  });

  // Regression: two rows for the same key sharing a ts used to let the
  // stale (first-seen) row win. appendEntry now prevents this state, so
  // construct it directly against the JSONL to prove the tie-break itself.
  test("on a ts tie between duplicate keys, the later row in the file wins (not the first)", () => {
    const p = ensureDir(dir);
    writeFileSync(
      p.active,
      [
        JSON.stringify(entry({ key: "dup", content: "stale duplicate value", ts: 50 })),
        JSON.stringify(entry({ key: "dup", content: "fresh duplicate value", ts: 50 })),
      ].join("\n") + "\n",
    );
    buildIndex(dir);
    const r = recall(dir, "duplicate");
    expect(r.length).toBe(1);
    expect(r[0]!.content).toBe("fresh duplicate value");
  });

  test("excludes archived entries by default, includes them with includeArchive", () => {
    appendEntry(dir, entry({ key: "gone", content: "archived away content", ts: 5 }));
    archiveOlderThan(dir, 100);
    buildIndex(dir);
    expect(recall(dir, "archived away").map((e) => e.key)).toEqual([]);
    expect(recall(dir, "archived away", { includeArchive: true }).map((e) => e.key)).toEqual(["gone"]);
  });
});
