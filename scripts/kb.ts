import { join } from "node:path";
import { validateEntry } from "./lib/schema";
import { appendEntry, readEntries, archiveOlderThan, ensureDir } from "./lib/store";
import { buildIndex, recall, type RecallFilters } from "./lib/fts";
import type { KnowledgeType } from "./lib/schema";

interface Flags { [k: string]: string | boolean; }

function parseNonNegInt(raw: string): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseFlags(args: string[]): { positionals: string[]; flags: Flags } {
  const positionals: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) { flags[name] = next; i++; }
      else flags[name] = true;
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

function resolveDir(flags: Flags): string {
  const d = typeof flags.dir === "string" ? flags.dir : join(process.cwd(), ".drawbar", "memory");
  ensureDir(d);
  return d;
}

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

export async function run(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  const { positionals, flags } = parseFlags(rest);
  const dir = resolveDir(flags);

  switch (cmd) {
    case "add": {
      const raw = await readStdin();
      let obj: unknown;
      try { obj = JSON.parse(raw); } catch { process.stderr.write("add: stdin is not valid JSON\n"); return 1; }
      const v = validateEntry(obj);
      if (!v.ok) { process.stderr.write(`add: invalid entry: ${v.error}\n`); return 1; }
      const res = appendEntry(dir, v.entry);
      buildIndex(dir);
      process.stdout.write(JSON.stringify({ written: res.written, key: v.entry.key }) + "\n");
      return 0;
    }
    case "recall": {
      const query = positionals.join(" ");
      const filters: RecallFilters = {};
      if (typeof flags.type === "string") filters.type = flags.type as KnowledgeType;
      if (typeof flags.tag === "string") filters.tag = flags.tag;
      if (typeof flags.file === "string") filters.file = flags.file;
      if (typeof flags.since === "string") {
        const n = parseNonNegInt(flags.since);
        if (n === null) { process.stderr.write("recall: --since must be a non-negative number\n"); return 1; }
        filters.since = n;
      }
      if (typeof flags.limit === "string") {
        const n = parseNonNegInt(flags.limit);
        if (n === null) { process.stderr.write("recall: --limit must be a non-negative number\n"); return 1; }
        filters.limit = n;
      }
      if (flags.all === true) filters.includeArchive = true;
      const results = recall(dir, query, filters);
      if (flags.json === true) {
        process.stdout.write(JSON.stringify(results, null, 2) + "\n");
      } else {
        for (const e of results) {
          process.stdout.write(`[${e.type.toUpperCase().slice(0, 5)}] ${e.key}\n  ${e.content.slice(0, 200)}\n  issue=${e.issue} tags=${e.tags.join(",")}\n\n`);
        }
      }
      return 0;
    }
    case "reindex": {
      buildIndex(dir);
      process.stdout.write("index rebuilt\n");
      return 0;
    }
    case "stats": {
      const all = readEntries(dir, { includeArchive: true });
      const active = readEntries(dir);
      const byType: Record<string, number> = {};
      for (const e of active) byType[e.type] = (byType[e.type] ?? 0) + 1;
      const stats = { active: active.length, archived: all.length - active.length, byType };
      process.stdout.write((flags.json === true ? JSON.stringify(stats, null, 2) : JSON.stringify(stats)) + "\n");
      return 0;
    }
    case "archive": {
      const days = typeof flags.days === "string" ? Number(flags.days) : 90;
      const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
      const res = archiveOlderThan(dir, cutoff);
      buildIndex(dir);
      process.stdout.write(JSON.stringify(res) + "\n");
      return 0;
    }
    case "import": {
      const src = positionals[0];
      if (!src) { process.stderr.write("import: missing <path>\n"); return 1; }
      const { importLegacy } = await import("./lib/migrate");
      const report = importLegacy(src, dir);
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return 0;
    }
    default:
      process.stderr.write("usage: kb <add|recall|reindex|stats|archive|import> [--dir <path>] [...]\n");
      return cmd ? 1 : 0;
  }
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
