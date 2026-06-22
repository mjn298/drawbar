import { existsSync, statSync } from "node:fs";
import { Database } from "bun:sqlite";
import { readEntries, storePaths, ensureDir } from "./store";
import type { Entry, KnowledgeType } from "./schema";

const CREATE_SQL = `
CREATE VIRTUAL TABLE kb USING fts5(
  key, type, content, tags, files, issue,
  ts UNINDEXED, raw UNINDEXED,
  tokenize = 'porter unicode61'
);`;

export function buildIndex(dir: string): void {
  const p = ensureDir(dir);
  const db = new Database(p.indexDb);
  try {
    db.run("DROP TABLE IF EXISTS kb;");
    db.run(CREATE_SQL);
    const insert = db.prepare(
      "INSERT INTO kb (key, type, content, tags, files, issue, ts, raw) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const tx = db.transaction((entries: Entry[]) => {
      for (const e of entries) {
        insert.run(
          e.key, e.type, e.content, e.tags.join(" "), e.files.join(" "),
          e.issue ?? "", e.ts, JSON.stringify(e),
        );
      }
    });
    tx(readEntries(dir, { includeArchive: true }));
  } finally {
    db.close();
  }
}

export function ensureFreshIndex(dir: string): void {
  const p = storePaths(dir);
  if (!existsSync(p.indexDb)) return buildIndex(dir);

  const dbMtime = statSync(p.indexDb).mtimeMs;
  const activeMtime = existsSync(p.active) ? statSync(p.active).mtimeMs : 0;
  const archiveMtime = existsSync(p.archive) ? statSync(p.archive).mtimeMs : 0;
  if (Math.max(activeMtime, archiveMtime) > dbMtime) buildIndex(dir);
}

export interface RecallFilters {
  type?: KnowledgeType;
  tag?: string;
  file?: string;
  since?: number;
  limit?: number;
  includeArchive?: boolean;
}

// FTS5 MATCH is picky about punctuation; quote each token defensively.
function toMatchQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}]+/gu) ?? [];
  return tokens.map((t) => `"${t}"`).join(" ");
}

export function recall(dir: string, query: string, filters: RecallFilters = {}): Entry[] {
  ensureFreshIndex(dir);
  const p = storePaths(dir);
  const db = new Database(p.indexDb, { readonly: true });
  try {
    const where: string[] = [];
    const params: (string | number)[] = [];

    const match = toMatchQuery(query);
    const hasQuery = match.length > 0;
    if (hasQuery) {
      where.push("kb MATCH ?");
      params.push(match);
    }
    if (filters.type) { where.push("type = ?"); params.push(filters.type); }
    if (filters.tag) { where.push("tags LIKE ?"); params.push(`%${filters.tag}%`); }
    if (filters.file) { where.push("files LIKE ?"); params.push(`%${filters.file}%`); }
    if (typeof filters.since === "number") { where.push("ts >= ?"); params.push(filters.since); }

    const order = hasQuery ? "ORDER BY bm25(kb) ASC, ts DESC" : "ORDER BY ts DESC";
    const sql =
      `SELECT raw, ts, ${hasQuery ? "bm25(kb)" : "0"} AS rank FROM kb` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ${order}`;

    const rows = db.query(sql).all(...params) as { raw: string; ts: number; rank: number }[];

    // Dedupe by key, keeping the latest ts; preserve query ranking order.
    const best = new Map<string, { entry: Entry; rank: number }>();
    for (const row of rows) {
      const entry = JSON.parse(row.raw) as Entry;
      const cur = best.get(entry.key);
      if (!cur || entry.ts > cur.entry.ts) best.set(entry.key, { entry, rank: row.rank });
    }

    const deduped = [...best.values()];
    deduped.sort((a, b) => (hasQuery ? a.rank - b.rank : b.entry.ts - a.entry.ts));

    const limit = filters.limit ?? 20;
    return deduped.slice(0, limit).map((x) => x.entry);
  } finally {
    db.close();
  }
}
