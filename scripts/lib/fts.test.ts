import { test, expect, describe, beforeEach } from "bun:test";
import { mkdtempSync, existsSync, utimesSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { appendEntry, storePaths, ensureDir, archiveOlderThan } from "./store";
import { buildIndex, ensureFreshIndex, toMatchQuery } from "./fts";
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

describe("toMatchQuery", () => {
  test("joins multiple tokens with OR, each quoted", () => {
    expect(toMatchQuery("a b")).toBe('"a" OR "b"');
  });

  test("empty query produces an empty match string", () => {
    expect(toMatchQuery("")).toBe("");
  });

  test("punctuation-only query produces an empty match string", () => {
    expect(toMatchQuery("!!! ---")).toBe("");
  });
});

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

  // LD3: an empty or punctuation-only query keeps today's behavior exactly
  // (no MATCH clause, all entries by ts DESC) — punctuation must not be
  // mistaken for a real query term.
  test("punctuation-only query behaves exactly like an empty query", () => {
    const r = recall(dir, "!!! ---");
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
    // Cutoff of 6 archives only "gone" (ts 5); "auth"/"db"/"db2" (ts 10-30)
    // stay active. Archiving everything (as a higher cutoff would) leaves
    // zero active rows, which can't distinguish "the archived = 0 filter
    // works" from "the active set happens to be empty."
    appendEntry(dir, entry({ key: "gone", content: "archived away content", ts: 5 }));
    archiveOlderThan(dir, 6);
    buildIndex(dir);
    expect(recall(dir, "archived away").map((e) => e.key)).toEqual([]);
    expect(recall(dir, "archived away", { includeArchive: true }).map((e) => e.key)).toEqual(["gone"]);
  });

  describe("multi-token queries (OR semantics)", () => {
    test("returns hits whose matching tokens are spread across different entries", () => {
      // "oauth" only appears in "auth"; "dynamodb" appears in "db" and "db2".
      // Under AND-join this whole query would need both tokens in one row and
      // return []; under OR it must return the union.
      const r = recall(dir, "oauth dynamodb");
      expect(r.map((e) => e.key).sort()).toEqual(["auth", "db", "db2"]);
    });

    test("one irrelevant token must not zero out matches for the other token", () => {
      const r = recall(dir, "dynamodb zzzznotpresent");
      expect(r.map((e) => e.key).sort()).toEqual(["db", "db2"]);
    });

    test("an entry matching a rarer query token ranks above one matching only a common token", () => {
      // "dynamodb" appears in both "db" and "db2" (common in this fixture, so
      // its IDF is ~0); "design" appears only in "db2" (rare, so its IDF
      // dominates bm25). "db2" ranks first because it matches the rare term
      // "design", not because it matches two tokens instead of one — bm25
      // weights term rarity (IDF), not the count of matched query tokens.
      const r = recall(dir, "dynamodb design");
      expect(r.map((e) => e.key)).toEqual(["db2", "db"]);
    });

    // Pins the corrected understanding above: bm25 ranks by term rarity, not
    // by how many query tokens an entry matches.
    //
    // IMPORTANT — do not edit these fixture strings casually. `one_rare` and
    // `two_common` are held to the SAME word count (6) deliberately, so
    // bm25's document-length normalization is controlled out and cannot
    // explain the outcome; only IDF can. `filler1..filler4` each add one more
    // occurrence of "alpha" or "beta" (on top of the one inside
    // `two_common`) so df(alpha) = df(beta) = 3 against this fixture's N,
    // pushing their IDF well below zeta's (df = 1) — a comfortable margin,
    // not a knife-edge one. This was verified with an out-of-suite probe
    // that swept `two_common`'s word count from 1 to 20 against this exact
    // fixture (same seeded `auth`/`db`/`db2` rows, same filler entries):
    // `one_rare` ranked first in every case. Shrinking or removing a filler
    // entry, or changing word counts, invalidates that margin — rerun an
    // equivalent sweep before touching them.
    test("an entry matching one rare token ranks above one matching two common tokens, at equal document length", () => {
      appendEntry(dir, entry({ key: "one_rare", content: "zeta appears only here today now", ts: 40 }));
      appendEntry(dir, entry({ key: "two_common", content: "alpha beta filler words here too", ts: 41 }));
      appendEntry(dir, entry({ key: "filler1", content: "alpha unrelated content padding", ts: 42 }));
      appendEntry(dir, entry({ key: "filler2", content: "beta unrelated content padding", ts: 43 }));
      appendEntry(dir, entry({ key: "filler3", content: "alpha more padding words", ts: 44 }));
      appendEntry(dir, entry({ key: "filler4", content: "beta more padding words", ts: 45 }));
      const r = recall(dir, "alpha beta zeta");
      // filler1..filler4 are structurally symmetric (same word count, one
      // occurrence each of alpha/beta) and so bm25-tie exactly; this is the
      // one place in the suite where the exact-tie -> `ts DESC` tie-break
      // (see `recall`'s ORDER BY) is actually exercised, ordering them
      // newest-first (45, 44, 43, 42). Do not "simplify" this expectation
      // with a `.sort()` — that would stop pinning the tie-break.
      expect(r.map((e) => e.key)).toEqual([
        "one_rare", "two_common", "filler4", "filler3", "filler2", "filler1",
      ]);
    });

    // Deliberately mirrors "returns entries matching the query, ranked"
    // above — an LD4 regression guard living in the multi-token describe
    // block so single-token behavior is proven unchanged right alongside
    // the OR-join tests that touch the same code path.
    test("single-token recall is unchanged", () => {
      const r = recall(dir, "dynamodb");
      expect(r.map((e) => e.key).sort()).toEqual(["db", "db2"]);
    });

    test("a query matching nothing at all still returns []", () => {
      // Positive pre-state probe: the store is non-empty, so an empty
      // result below is because nothing matched, not because the fixture
      // was never populated.
      expect(recall(dir, "").length).toBeGreaterThan(0);
      const r = recall(dir, "zzzznotpresent alsomissing");
      expect(r).toEqual([]);
    });

    test("type filter composes correctly with a multi-token query", () => {
      const r = recall(dir, "oauth dynamodb", { type: "decision" });
      expect(r.map((e) => e.key)).toEqual(["db2"]);
    });

    test("limit composes with a multi-token query", () => {
      // "oauth" is the rarer token (present in only one entry), so bm25 ranks
      // "auth" first; limit 1 must return exactly that top-ranked hit.
      const full = recall(dir, "oauth dynamodb");
      const r = recall(dir, "oauth dynamodb", { limit: 1 });
      expect(r.length).toBe(1);
      expect(r[0]!.key).toBe(full[0]!.key);
      expect(r[0]!.key).toBe("auth");
    });

    test("since composes with a multi-token query", () => {
      const r = recall(dir, "oauth dynamodb", { since: 25 });
      expect(r.map((e) => e.key)).toEqual(["db2"]);
    });

    test("tag filter composes with a multi-token query", () => {
      const r = recall(dir, "oauth dynamodb", { tag: "auth" });
      expect(r.map((e) => e.key)).toEqual(["auth"]);
    });

    test("file filter composes with a multi-token query", () => {
      const r = recall(dir, "oauth companyId", { file: "pipeline/index.ts" });
      expect(r.map((e) => e.key)).toEqual(["db"]);
    });

    test("archived entries stay excluded by default with a multi-token query, appear with includeArchive", () => {
      // Cutoff of 6 archives only "gone" (ts 5); "auth" (ts 10) stays active.
      appendEntry(dir, entry({ key: "gone", content: "archived away oauth", ts: 5 }));
      archiveOlderThan(dir, 6);
      buildIndex(dir);
      expect(recall(dir, "archived oauth").map((e) => e.key).sort()).toEqual(["auth"]);
      expect(recall(dir, "archived oauth", { includeArchive: true }).map((e) => e.key).sort())
        .toEqual(["auth", "gone"]);
    });

    test("dedupe-by-key still keeps the latest ts under a multi-token query", () => {
      appendEntry(dir, entry({ key: "auth", type: "pattern", content: "oauth login token refresh updated", tags: ["auth"], ts: 99 }));
      const r = recall(dir, "oauth dynamodb");
      const authRows = r.filter((e) => e.key === "auth");
      expect(authRows.length).toBe(1);
      expect(authRows[0]!.ts).toBe(99);
    });
  });
});
