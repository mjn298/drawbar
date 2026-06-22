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
