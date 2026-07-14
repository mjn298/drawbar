import { mkdirSync, existsSync, readFileSync, appendFileSync, writeFileSync, renameSync } from "node:fs";
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

export function readArchiveEntries(dir: string): Entry[] {
  return readFile(storePaths(dir).archive);
}

// Two entries carry the same knowledge if every field but `ts` matches. A
// re-add with only a fresh timestamp is a no-op; a correction to *any* other
// field (issue, tags, files, type, source) must supersede — comparing content
// alone would silently drop metadata-only corrections.
function sameKnowledge(a: Entry, b: Entry): boolean {
  const eq = (x: string[], y: string[]) => x.length === y.length && x.every((v, i) => v === y[i]);
  return a.key === b.key && a.type === b.type && a.content === b.content &&
    a.source === b.source && a.issue === b.issue && eq(a.tags, b.tags) && eq(a.files, b.files);
}

function writeActiveAtomic(p: StorePaths, entries: Entry[]): void {
  const contents = entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length ? "\n" : "");
  const tmp = p.active + ".tmp";
  writeFileSync(tmp, contents);
  renameSync(tmp, p.active);
}

export function appendEntry(dir: string, entry: Entry): { written: boolean; superseded: boolean } {
  const v = validateEntry(entry);
  if (!v.ok) throw new Error(`refusing to write invalid entry: ${v.error}`);

  // Safe-write: round-trip through JSON before touching disk.
  const line = JSON.stringify(v.entry);
  const roundTrip = parseLine(line);
  if (!roundTrip.ok) throw new Error(`entry failed JSON round-trip: ${roundTrip.error}`);

  const p = ensureDir(dir);
  const existing = readFile(p.active);
  const matches = existing.filter((e) => e.key === v.entry.key);

  if (matches.length === 0) {
    appendFileSync(p.active, line + "\n");
    return { written: true, superseded: false };
  }

  if (matches.length === 1 && sameKnowledge(matches[0]!, v.entry)) {
    return { written: false, superseded: false };
  }

  // Same key already present (once or, from pre-existing damage, more than
  // once) with changed knowledge: upsert in place at the first occurrence's
  // position, archive every superseded copy.
  const firstIdx = existing.findIndex((e) => e.key === v.entry.key);
  const rest = existing.filter((e) => e.key !== v.entry.key);
  const next = [...rest.slice(0, firstIdx), v.entry, ...rest.slice(firstIdx)];
  // Archive before rewriting active: a crash in between then leaves a
  // recoverable duplicate rather than losing the superseded copy outright.
  for (const e of matches) appendFileSync(p.archive, JSON.stringify(e) + "\n");
  writeActiveAtomic(p, next);
  return { written: true, superseded: true };
}

export function compactActive(dir: string, opts: { dryRun?: boolean } = {}): {
  scanned: number; keys: number; removed: number;
} {
  const p = ensureDir(dir);
  const active = readFile(p.active);

  const byKey = new Map<string, Entry>();
  for (const e of active) {
    const cur = byKey.get(e.key);
    // Later line wins on a ts tie, consistent with the recall tie-break.
    if (!cur || e.ts >= cur.ts) byKey.set(e.key, e);
  }

  const kept = new Set(byKey.values());
  const losers = active.filter((e) => !kept.has(e));
  const scanned = active.length;
  const keys = byKey.size;
  const removed = losers.length;
  if (removed === 0 || opts.dryRun) return { scanned, keys, removed };

  // Preserve first-occurrence position for each surviving key.
  const seen = new Set<string>();
  const next: Entry[] = [];
  for (const e of active) {
    if (seen.has(e.key)) continue;
    seen.add(e.key);
    next.push(byKey.get(e.key)!);
  }
  for (const e of losers) appendFileSync(p.archive, JSON.stringify(e) + "\n");
  writeActiveAtomic(p, next);
  return { scanned, keys, removed };
}

export function archiveOlderThan(dir: string, cutoffTs: number): { archived: number } {
  const p = ensureDir(dir);
  const active = readEntries(dir); // active only
  const old = active.filter((e) => e.ts < cutoffTs);
  const keep = active.filter((e) => e.ts >= cutoffTs);
  if (old.length === 0) return { archived: 0 };

  for (const e of old) appendFileSync(p.archive, JSON.stringify(e) + "\n");
  writeActiveAtomic(p, keep);
  return { archived: old.length };
}
