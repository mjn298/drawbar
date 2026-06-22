import { mkdirSync, existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validateEntry, parseLine, type Entry } from "./schema";

export interface StorePaths { dir: string; active: string; archive: string; indexDb: string; }

export function storePaths(dir: string): StorePaths {
  return {
    dir,
    active: join(dir, "knowledge.jsonl"),
    archive: join(dir, "knowledge.archive.jsonl"),
    indexDb: join(dir, "index.db"),
  };
}

export function ensureDir(dir: string): StorePaths {
  mkdirSync(dir, { recursive: true });
  const gi = join(dir, ".gitignore");
  if (!existsSync(gi)) writeFileSync(gi, "index.db\n");
  return storePaths(dir);
}

function readFile(path: string): Entry[] {
  if (!existsSync(path)) return [];
  const out: Entry[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const r = parseLine(line);
    if (r.ok) out.push(r.entry);
  }
  return out;
}

export function readEntries(dir: string, opts: { includeArchive?: boolean } = {}): Entry[] {
  const p = storePaths(dir);
  const active = readFile(p.active);
  if (!opts.includeArchive) return active;
  return [...readFile(p.archive), ...active];
}

export function appendEntry(dir: string, entry: Entry): { written: boolean } {
  const v = validateEntry(entry);
  if (!v.ok) throw new Error(`refusing to write invalid entry: ${v.error}`);

  // Safe-write: round-trip through JSON before touching disk.
  const line = JSON.stringify(v.entry);
  const roundTrip = parseLine(line);
  if (!roundTrip.ok) throw new Error(`entry failed JSON round-trip: ${roundTrip.error}`);

  const p = ensureDir(dir);
  const existing = readFile(p.active);
  const dup = existing.some((e) => e.key === v.entry.key && e.content === v.entry.content);
  if (dup) return { written: false };

  appendFileSync(p.active, line + "\n");
  return { written: true };
}
