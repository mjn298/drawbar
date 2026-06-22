import { existsSync, statSync } from "node:fs";
import { Database } from "bun:sqlite";
import { readEntries, storePaths, ensureDir } from "./store";
import type { Entry } from "./schema";

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
