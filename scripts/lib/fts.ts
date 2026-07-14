import { existsSync, statSync } from "node:fs";
import { Database } from "bun:sqlite";
import { readEntries, readArchiveEntries, storePaths, ensureDir } from "./store";
import type { Entry, KnowledgeType } from "./schema";

const CREATE_SQL = `
CREATE VIRTUAL TABLE kb USING fts5(
  key, type, content, tags, files, issue,
  ts UNINDEXED, raw UNINDEXED, archived UNINDEXED,
  tokenize = 'porter unicode61'
);`;

// Bump whenever CREATE_SQL changes. index.db is gitignored and survives an
// upgrade, so a stale-schema index must be detected and rebuilt — otherwise
// queries against new columns fail with "no such column".
const SCHEMA_VERSION = 2;

export function buildIndex(dir: string): void {
  const p = ensureDir(dir);
  const db = new Database(p.indexDb);
  try {
    db.run("DROP TABLE IF EXISTS kb;");
    db.run(CREATE_SQL);
    db.run(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    const insert = db.prepare(
      "INSERT INTO kb (key, type, content, tags, files, issue, ts, raw, archived) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    const tx = db.transaction((entries: Entry[], archived: number) => {
      for (const e of entries) {
        insert.run(
          e.key, e.type, e.content, e.tags.join(" "), e.files.join(" "),
          e.issue ?? "", e.ts, JSON.stringify(e), archived,
        );
      }
    });
    // Archive first, then active, so rowids ascend with recency and a
    // ts-tie in the dedupe tie-break favors the active copy.
    tx(readArchiveEntries(dir), 1);
    tx(readEntries(dir), 0);
  } finally {
    db.close();
  }
}

// Number of rows in the FTS index, or 0 if the table is missing/corrupt
// (in which case the index needs rebuilding anyway).
function indexRowCount(indexDb: string): number {
  let db: Database | null = null;
  try {
    db = new Database(indexDb, { readonly: true });
    const row = db.query("SELECT count(*) AS n FROM kb").get() as { n: number } | null;
    return row?.n ?? 0;
  } catch {
    return 0;
  } finally {
    db?.close();
  }
}

// Schema version stamped into the index, or 0 if missing/unreadable.
function indexSchemaVersion(indexDb: string): number {
  let db: Database | null = null;
  try {
    db = new Database(indexDb, { readonly: true });
    const row = db.query("PRAGMA user_version").get() as { user_version: number } | null;
    return row?.user_version ?? 0;
  } catch {
    return 0;
  } finally {
    db?.close();
  }
}

export function ensureFreshIndex(dir: string): void {
  const p = storePaths(dir);
  if (!existsSync(p.indexDb)) return buildIndex(dir);

  // An index left over from an older schema is stale no matter how fresh its
  // mtime looks — querying it would throw on the columns it lacks.
  if (indexSchemaVersion(p.indexDb) !== SCHEMA_VERSION) return buildIndex(dir);

  const dbMtime = statSync(p.indexDb).mtimeMs;
  const activeMtime = existsSync(p.active) ? statSync(p.active).mtimeMs : 0;
  const archiveMtime = existsSync(p.archive) ? statSync(p.archive).mtimeMs : 0;
  if (Math.max(activeMtime, archiveMtime) > dbMtime) return buildIndex(dir);

  // Self-heal: the index looks fresh by mtime but is empty while the store has
  // entries — e.g. an index built when the JSONL was empty, then the JSONL was
  // populated by a git checkout that left an older-looking mtime. Without this,
  // recall silently returns [] against a non-empty store. Rebuild.
  if (indexRowCount(p.indexDb) === 0 && readEntries(dir, { includeArchive: true }).length > 0) {
    buildIndex(dir);
  }
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
    if (!filters.includeArchive) where.push("archived = 0");
    if (filters.type) { where.push("type = ?"); params.push(filters.type); }
    if (filters.tag) { where.push("tags LIKE ?"); params.push(`%${filters.tag}%`); }
    if (filters.file) { where.push("files LIKE ?"); params.push(`%${filters.file}%`); }
    if (typeof filters.since === "number") { where.push("ts >= ?"); params.push(filters.since); }

    const order = hasQuery ? "ORDER BY bm25(kb) ASC, ts DESC" : "ORDER BY ts DESC";
    const sql =
      `SELECT rowid, raw, ts, ${hasQuery ? "bm25(kb)" : "0"} AS rank FROM kb` +
      (where.length ? ` WHERE ${where.join(" AND ")}` : "") +
      ` ${order}`;

    const rows = db.query(sql).all(...params) as { rowid: number; raw: string; ts: number; rank: number }[];

    // Dedupe by key, keeping the latest ts; a ts tie is broken by the
    // greater rowid (never let an older/first row win). Preserve query
    // ranking order.
    const best = new Map<string, { entry: Entry; rank: number; ts: number; rowid: number }>();
    for (const row of rows) {
      const entry = JSON.parse(row.raw) as Entry;
      const cur = best.get(entry.key);
      if (!cur || row.ts > cur.ts || (row.ts === cur.ts && row.rowid > cur.rowid)) {
        best.set(entry.key, { entry, rank: row.rank, ts: row.ts, rowid: row.rowid });
      }
    }

    const deduped = [...best.values()];
    deduped.sort((a, b) => (hasQuery ? a.rank - b.rank : b.entry.ts - a.entry.ts));

    const limit = filters.limit ?? 20;
    return deduped.slice(0, limit).map((x) => x.entry);
  } finally {
    db.close();
  }
}
