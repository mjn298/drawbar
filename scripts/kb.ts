#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { validateEntry } from "./lib/schema";
import { appendEntry, readEntries, archiveOlderThan, archiveByKeys, compactActive, ensureDir } from "./lib/store";
import { buildIndex, recall, type RecallFilters } from "./lib/fts";
import { resolveContext, type DrawbarContext, type ResolveInput } from "./lib/project-config";
import type { Runner } from "./lib/ship-config";
import type { KnowledgeType } from "./lib/schema";

type FlagValue = string | boolean;
interface Flags { [k: string]: FlagValue | FlagValue[]; }

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

// `repeatable` names flags that collect every occurrence into an array instead of
// last-wins overwrite. Only used by callers that need `--key k1 --key k2` semantics.
function parseFlags(args: string[], repeatable: readonly string[] = []): { positionals: string[]; flags: Flags } {
  const positionals: string[] = [];
  // Null-prototype: a plain `{}` lets `--__proto__ x` hit Object.prototype's setter and vanish as
  // an own property, so it never reaches validateFlags' Object.keys loop and bypasses the allowlist.
  const flags: Flags = Object.create(null);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith("--")) {
      const name = a.slice(2);
      const next = args[i + 1];
      let value: FlagValue;
      if (next !== undefined && !next.startsWith("--")) { value = next; i++; }
      else value = true;
      if (repeatable.includes(name)) {
        const arr = (flags[name] as FlagValue[] | undefined) ?? [];
        arr.push(value);
        flags[name] = arr;
      } else {
        flags[name] = value;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags };
}

const REPEATABLE_FLAGS: readonly string[] = ["key"];

type FlagType = "string" | "boolean";
interface FlagSpec { name: string; type: FlagType; }

// Declarative allowlist for the mutating commands. Each row names a flag and whether it takes
// a value ("string") or is presence-only ("boolean") -- the type drives validateFlags below.
// Adding a row for another command later is a table entry, not a restructure.
const COMMAND_FLAG_TABLE: Record<string, readonly FlagSpec[]> = {
  archive: [
    { name: "dir", type: "string" },
    { name: "project", type: "string" },
    { name: "days", type: "string" },
    { name: "key", type: "string" },
    { name: "dry-run", type: "boolean" },
  ],
  compact: [
    { name: "dir", type: "string" },
    { name: "project", type: "string" },
    { name: "dry-run", type: "boolean" },
  ],
};

// Runs once per invocation, immediately after parseFlags and before any I/O (resolveContext,
// ensureDir, store reads/writes): a typo'd or mistyped flag must be rejected even when the
// active config is malformed, rather than losing the race to a later I/O failure.
// Commands with no table entry are unvalidated here (S3 scope).
function validateFlags(cmd: string, flags: Flags): string | null {
  // hasOwnProperty guard: COMMAND_FLAG_TABLE is a plain object literal, so a bare `[cmd]` lookup
  // for cmd="constructor" (or "toString" etc.) resolves to the inherited Object.prototype member
  // instead of undefined, passing the `!table` check and crashing on `table.map` below.
  const table = Object.prototype.hasOwnProperty.call(COMMAND_FLAG_TABLE, cmd) ? COMMAND_FLAG_TABLE[cmd] : undefined;
  if (!table) return null;
  const types = new Map(table.map((f) => [f.name, f.type] as const));
  for (const name of Object.keys(flags)) {
    const type = types.get(name);
    if (type === undefined) return `${cmd}: unknown flag --${name}`;
    const value = flags[name]!;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (type === "string" && v === true) return `${cmd}: --${name} requires a value`;
      if (type === "boolean" && typeof v === "string") return `${cmd}: --${name} does not take a value`;
    }
  }
  return null;
}

const USAGE = "usage: kb <add|recall|reindex|stats|archive|compact|import|context|path> [--dir <path>] [--project <name>] [...]\n" +
  "  archive: [--days <n> | --key <k> [--key <k> ...]] [--dry-run]\n" +
  "  compact: [--dry-run]\n" +
  "  --help: show this message\n";

async function readStdin(): Promise<string> {
  return await new Response(Bun.stdin.stream()).text();
}

// `context` and `path` are the two READ-ONLY commands: they answer "where would the store be"
// without creating it, so a command's preflight can distinguish "not set up yet" from "set up
// somewhere else". Every other command is about to touch the store, so it gets `ensureDir`.
const READ_ONLY_COMMANDS: readonly string[] = ["context", "path"];

export async function run(argv: string[], deps: RunDeps = {}): Promise<number> {
  const [cmd, ...rest] = argv;
  const { positionals, flags } = parseFlags(rest, REPEATABLE_FLAGS);

  // Before everything else, including the malformed-config path resolveContext can hit:
  // `--help` must exit 0 regardless of what else is wrong with the invocation. Gate on presence,
  // not value: `--help` followed by a bare word binds that word (a string), not `true`, and it
  // must still trigger help rather than falling through to validation.
  if (cmd === "--help" || "help" in flags) { process.stdout.write(USAGE); return 0; }

  if (cmd !== undefined) {
    const flagError = validateFlags(cmd, flags);
    if (flagError) { process.stderr.write(flagError + "\n"); return 1; }
  }

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
      const dryRun = flags["dry-run"] === true;
      const keyFlag = flags.key as string[] | undefined; // validateFlags already rejected any `true` element

      if (keyFlag !== undefined && flags.days !== undefined) {
        process.stderr.write("archive: --key and --days are mutually exclusive\n");
        return 1;
      }

      if (keyFlag !== undefined) {
        if (keyFlag.some((k) => k === "")) { process.stderr.write("archive: --key must not be empty\n"); return 1; }
        const res = archiveByKeys(dir, keyFlag, { dryRun });
        if (res.missing.length > 0) {
          process.stderr.write(`archive: no matching entries for key(s): ${res.missing.join(", ")}\n`);
          return 1;
        }
        if (!dryRun) buildIndex(dir);
        process.stdout.write(JSON.stringify({ archived: res.archived, dryRun, keys: res.keys }) + "\n");
        return 0;
      }

      let days = 90;
      if (typeof flags.days === "string") {
        const n = parseNonNegInt(flags.days);
        if (n === null) { process.stderr.write("archive: --days must be a non-negative integer (digits only)\n"); return 1; }
        days = n;
      }
      const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
      const res = archiveOlderThan(dir, cutoff, { dryRun });
      if (!dryRun) buildIndex(dir);
      // "keys" would be the whole store on a real day-based run, so it's dry-run only.
      const out = dryRun ? { archived: res.archived, dryRun, keys: res.keys } : { archived: res.archived, dryRun };
      process.stdout.write(JSON.stringify(out) + "\n");
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
      process.stderr.write(USAGE);
      return cmd ? 1 : 0;
  }
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
