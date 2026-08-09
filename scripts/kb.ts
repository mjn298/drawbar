#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { validateEntry } from "./lib/schema";
import { appendEntry, readEntries, archiveOlderThan, compactActive, ensureDir } from "./lib/store";
import { buildIndex, recall, type RecallFilters } from "./lib/fts";
import { resolveContext, type DrawbarContext, type ResolveInput } from "./lib/project-config";
import type { Runner } from "./lib/ship-config";
import type { KnowledgeType } from "./lib/schema";

interface Flags { [k: string]: string | boolean; }

// Every real I/O boundary the resolver needs, injectable and defaulting to the real thing —
// the same seam shape `commands/drawbar-ship.md`'s module already uses, so a test can drive a
// synthetic worktree layout without spawning `git` or writing to a real repo.
export interface RunDeps {
  cwd?: string;
  env?: Record<string, string | undefined>;
  git?: Runner;
  fs?: { exists: (p: string) => boolean; read: (p: string) => string };
}

const realGit: Runner = (argv: string[]) => {
  try {
    const proc = Bun.spawnSync(["git", ...argv], { stdout: "pipe", stderr: "pipe" });
    return { code: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  } catch (err) {
    // MUST-CHECK wrap-injected-runner-spawn-in-try-catch: no git on PATH must degrade to the
    // resolver's cwd fallback, never an uncaught throw before the CLI writes anything at all.
    return { code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
};

function parseNonNegInt(raw: string): number | null {
  return /^\d+$/.test(raw) ? Number(raw) : null;
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

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

// `context` and `path` are the two READ-ONLY commands: they answer "where would the store be"
// without creating it, so a command's preflight can distinguish "not set up yet" from "set up
// somewhere else". Every other command is about to touch the store, so it gets `ensureDir`.
const READ_ONLY_COMMANDS: readonly string[] = ["context", "path"];

export async function run(argv: string[], deps: RunDeps = {}): Promise<number> {
  const [cmd, ...rest] = argv;
  const { positionals, flags } = parseFlags(rest);

  if (flags.dir === true) { process.stderr.write("--dir requires a value\n"); return 1; }
  if (flags.project === true) { process.stderr.write("--project requires a value\n"); return 1; }

  const input: ResolveInput = {
    cwd: deps.cwd ?? process.cwd(),
    env: deps.env ?? process.env,
    git: deps.git ?? realGit,
    fs: deps.fs ?? { exists: (p) => existsSync(p), read: (p) => readFileSync(p, "utf8") },
    dirFlag: typeof flags.dir === "string" ? flags.dir : undefined,
    projectFlag: typeof flags.project === "string" ? flags.project : undefined,
  };
  const resolved = resolveContext(input);
  // Fails closed on a malformed config rather than falling back to the default store: a session
  // that writes its lessons somewhere nobody reads again is worse than one that refuses to run.
  if (!resolved.ok) { process.stderr.write(`${cmd ?? "kb"}: ${resolved.detail}\n`); return 1; }
  const context: DrawbarContext = resolved.context;
  const dir = context.memoryDir;
  if (cmd !== undefined && !READ_ONLY_COMMANDS.includes(cmd)) ensureDir(dir);

  switch (cmd) {
    case "path": {
      // One absolute path on stdout and nothing else, so a shell preflight can do
      // `KB=$(drawbar-kb path)` without parsing anything.
      process.stdout.write(dir + "\n");
      return 0;
    }
    case "context": {
      if (flags.json === true) {
        process.stdout.write(JSON.stringify(context, null, 2) + "\n");
      } else {
        process.stdout.write(
          [
            `root        ${context.root} (${context.rootSource})`,
            `config      ${context.configPath}${context.configPresent ? "" : " (absent)"}`,
            `memoryDir   ${context.memoryDir} (${context.memoryDirSource})`,
            `team        ${context.team ?? "<unset>"}${context.teamSource ? ` (${context.teamSource})` : ""}`,
            `project     ${context.project ?? "<unset>"}${context.projectSource ? ` (${context.projectSource})` : ""}`,
          ].join("\n") + "\n",
        );
      }
      return 0;
    }
    case "add": {
      const raw = await readStdin();
      let obj: unknown;
      try { obj = JSON.parse(raw); } catch { process.stderr.write("add: stdin is not valid JSON\n"); return 1; }
      const v = validateEntry(obj);
      if (!v.ok) { process.stderr.write(`add: invalid entry: ${v.error}\n`); return 1; }
      const res = appendEntry(dir, v.entry);
      buildIndex(dir);
      process.stdout.write(JSON.stringify({ written: res.written, superseded: res.superseded, key: v.entry.key }) + "\n");
      return 0;
    }
    case "recall": {
      const query = positionals.join(" ");
      const filters: RecallFilters = {};
      if (typeof flags.type === "string") filters.type = flags.type as KnowledgeType;
      if (typeof flags.tag === "string") filters.tag = flags.tag;
      if (typeof flags.file === "string") filters.file = flags.file;
      if (flags.since === true) { process.stderr.write("recall: --since requires a value\n"); return 1; }
      if (typeof flags.since === "string") {
        const n = parseNonNegInt(flags.since);
        if (n === null) { process.stderr.write("recall: --since must be a non-negative integer (digits only)\n"); return 1; }
        filters.since = n;
      }
      if (flags.limit === true) { process.stderr.write("recall: --limit requires a value\n"); return 1; }
      if (typeof flags.limit === "string") {
        const n = parseNonNegInt(flags.limit);
        if (n === null) { process.stderr.write("recall: --limit must be a non-negative integer (digits only)\n"); return 1; }
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
      const countByKey = new Map<string, number>();
      for (const e of active) {
        byType[e.type] = (byType[e.type] ?? 0) + 1;
        countByKey.set(e.key, (countByKey.get(e.key) ?? 0) + 1);
      }
      const duplicateKeys = [...countByKey.values()].filter((n) => n > 1).length;
      const stats = { active: active.length, archived: all.length - active.length, duplicateKeys, byType };
      process.stdout.write((flags.json === true ? JSON.stringify(stats, null, 2) : JSON.stringify(stats)) + "\n");
      return 0;
    }
    case "archive": {
      let days = 90;
      if (flags.days === true) { process.stderr.write("archive: --days requires a value\n"); return 1; }
      if (typeof flags.days === "string") {
        const n = parseNonNegInt(flags.days);
        if (n === null) { process.stderr.write("archive: --days must be a non-negative integer (digits only)\n"); return 1; }
        days = n;
      }
      const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
      const res = archiveOlderThan(dir, cutoff);
      buildIndex(dir);
      process.stdout.write(JSON.stringify(res) + "\n");
      return 0;
    }
    case "compact": {
      const res = compactActive(dir, { dryRun: flags["dry-run"] === true });
      if (flags["dry-run"] !== true) buildIndex(dir);
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
      process.stderr.write("usage: kb <add|recall|reindex|stats|archive|compact|import|context|path> [--dir <path>] [...]\n");
      return cmd ? 1 : 0;
  }
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
