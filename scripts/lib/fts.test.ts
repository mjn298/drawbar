import { test, expect, describe, beforeEach } from "bun:test";
import { mkdtempSync, existsSync, utimesSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { appendEntry, storePaths } from "./store";
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
});

describe("ensureFreshIndex", () => {
  test("builds the index when it does not exist", () => {
    appendEntry(dir, entry());
    ensureFreshIndex(dir);
    expect(existsSync(storePaths(dir).indexDb)).toBe(true);
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
});
