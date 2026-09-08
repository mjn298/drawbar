#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { validateEntry, KNOWLEDGE_TYPES } from "./lib/schema";
import { appendEntry, readEntries, archiveOlderThan, archiveByKeys, compactActive, ensureDir, storePaths } from "./lib/store";
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
// POSIX `--`: the first bare `--` token ends option parsing for good, so a query term
// (or path) that happens to start with `--` is never mistaken for a flag name.
export function parseFlags(args: string[], repeatable: readonly string[] = []): { positionals: string[]; flags: Flags } {
  const positionals: string[] = [];
  // Null-prototype: a plain `{}` lets `--__proto__ x` hit Object.prototype's setter and vanish as
  // an own property, so it never reaches validateFlags' Object.keys loop and bypasses the allowlist.
  const flags: Flags = Object.create(null);
  let endOfOptions = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!endOfOptions && a === "--") { endOfOptions = true; continue; }
    if (!endOfOptions && a.startsWith("--")) {
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

// `-h` is recognized only as an exact argv token appearing strictly before the first literal
// `--`: after end-of-options every token (including a literal "-h") is data, never a flag. `-h`
// never becomes `flags.h` -- parseFlags only reacts to `--`-prefixed tokens -- so this is the
// only place any command sees it.
function hasHelpShort(argv: string[]): boolean {
  for (const a of argv) {
    if (a === "--") return false;
    if (a === "-h") return true;
  }
  return false;
}

const REPEATABLE_FLAGS: readonly string[] = ["key"];

type FlagType = "string" | "boolean";
// `validate` runs only once a string-typed flag's raw value has passed the type check (never
// called for a boolean flag, and never for a missing/`true` value) -- it expresses a domain
// narrower than "is a string" (digits-only, or one of KNOWLEDGE_TYPES) and returns the message
// to report, or null if the value is acceptable.
interface FlagSpec { name: string; type: FlagType; validate?: (raw: string) => string | null; }
type Arity = { kind: "none" } | { kind: "any" } | { kind: "exact"; count: number };
interface CommandSpec { flags: readonly FlagSpec[]; arity: Arity; requiresStore: boolean; }

function nonNegIntValidate(raw: string): string | null {
  // Reuses parseNonNegInt itself rather than re-deriving the digits-only rule, so the two can
  // never drift: this is the same check archive/recall relied on before the table existed.
  return parseNonNegInt(raw) === null ? "must be a non-negative integer (digits only)" : null;
}

function knowledgeTypeValidate(raw: string): string | null {
  return (KNOWLEDGE_TYPES as readonly string[]).includes(raw)
    ? null
    : `must be one of: ${KNOWLEDGE_TYPES.join(", ")}`;
}

// `--dir` and `--project` are valid on every command; every row starts with these two.
const GLOBAL_FLAGS: readonly FlagSpec[] = [
  { name: "dir", type: "string" },
  { name: "project", type: "string" },
];
function withGlobals(flags: readonly FlagSpec[]): readonly FlagSpec[] {
  return [...GLOBAL_FLAGS, ...flags];
}

const DAYS: FlagSpec = { name: "days", type: "string", validate: nonNegIntValidate };
const KEY: FlagSpec = { name: "key", type: "string" };
const DRY_RUN: FlagSpec = { name: "dry-run", type: "boolean" };
const TYPE: FlagSpec = { name: "type", type: "string", validate: knowledgeTypeValidate };
const TAG: FlagSpec = { name: "tag", type: "string" };
const FILE: FlagSpec = { name: "file", type: "string" };
const SINCE: FlagSpec = { name: "since", type: "string", validate: nonNegIntValidate };
const LIMIT: FlagSpec = { name: "limit", type: "string", validate: nonNegIntValidate };
const JSON_FLAG: FlagSpec = { name: "json", type: "boolean" };
const ALL_FLAG: FlagSpec = { name: "all", type: "boolean" };

// The one authoritative source for: which flags a command accepts (and their types), its
// positional arity, whether it requires an existing store, AND (via commandUsage/topUsage below)
// its usage text -- so a new flag lands here once, and validation, help, and the unknown-flag
// error can never disagree about what's allowed. Insertion order here is also display order.
const COMMANDS: Record<string, CommandSpec> = {
  add: { flags: withGlobals([]), arity: { kind: "none" }, requiresStore: false },
  recall: { flags: withGlobals([TYPE, TAG, FILE, SINCE, LIMIT, JSON_FLAG, ALL_FLAG]), arity: { kind: "any" }, requiresStore: false },
  reindex: { flags: withGlobals([]), arity: { kind: "none" }, requiresStore: false },
  stats: { flags: withGlobals([JSON_FLAG]), arity: { kind: "none" }, requiresStore: false },
  archive: { flags: withGlobals([DAYS, KEY, DRY_RUN]), arity: { kind: "none" }, requiresStore: true },
  compact: { flags: withGlobals([DRY_RUN]), arity: { kind: "none" }, requiresStore: true },
  import: { flags: withGlobals([]), arity: { kind: "exact", count: 1 }, requiresStore: false },
  context: { flags: withGlobals([JSON_FLAG]), arity: { kind: "none" }, requiresStore: false },
  path: { flags: withGlobals([]), arity: { kind: "none" }, requiresStore: false },
};

// hasOwnProperty guard: COMMANDS is a plain object literal, so a bare `[cmd]` lookup for
// cmd="constructor" (or "toString" etc.) resolves to the inherited Object.prototype member
// instead of undefined -- letting a typo'd command name silently pass an "is this known" check.
function getCommand(cmd: string): CommandSpec | undefined {
  return Object.prototype.hasOwnProperty.call(COMMANDS, cmd) ? COMMANDS[cmd] : undefined;
}

// Runs once per invocation, immediately after help/unknown-command resolution and before any
// I/O (resolveContext, ensureDir, store reads/writes): a typo'd, mistyped, or malformed flag is
// rejected even when the active config is malformed, rather than losing the race to a later I/O
// failure or silently defaulting (PCO-339/400's `--days`/`--dry-run` type-confusion bugs).
function validateFlags(cmd: string, spec: CommandSpec, flags: Flags): string | null {
  const byName = new Map(spec.flags.map((f) => [f.name, f] as const));
  for (const name of Object.keys(flags)) {
    const fspec = byName.get(name);
    if (!fspec) return `${cmd}: unknown flag --${name}`;
    const raw = flags[name]!;
    const values = Array.isArray(raw) ? raw : [raw];
    for (const v of values) {
      if (fspec.type === "string" && v === true) return `${cmd}: --${name} requires a value`;
      if (fspec.type === "boolean" && typeof v === "string") return `${cmd}: --${name} does not take a value`;
      if (fspec.type === "string" && typeof v === "string" && fspec.validate) {
        const msg = fspec.validate(v);
        if (msg) return `${cmd}: --${name} ${msg}`;
      }
    }
  }
  return null;
}

function validateArity(cmd: string, positionals: string[], arity: Arity): string | null {
  if (arity.kind === "any") return null;
  if (arity.kind === "none") {
    return positionals.length > 0 ? `${cmd}: unexpected argument(s): ${positionals.join(" ")}` : null;
  }
  return positionals.length === arity.count
    ? null
    : `${cmd}: expected exactly ${arity.count} argument(s), got ${positionals.length}`;
}

function flagUsage(f: FlagSpec): string {
  if (f.type === "boolean") return `[--${f.name}]`;
  return REPEATABLE_FLAGS.includes(f.name) ? `[--${f.name} <value> ...]` : `[--${f.name} <value>]`;
}

function positionalUsage(arity: Arity): string {
  if (arity.kind === "any") return " [query terms...]";
  if (arity.kind === "exact") return " <path>".repeat(arity.count);
  return "";
}

// Derived from COMMANDS, not stored beside it: a flag added to a row is documented for free,
// and a row can never drift out of sync with what validateFlags actually accepts.
function commandUsage(cmd: string, spec: CommandSpec): string {
  const parts = [...spec.flags.map(flagUsage), "[--help|-h]"].join(" ");
  return `usage: kb ${cmd} ${parts}${positionalUsage(spec.arity)}\n`;
}

function topUsage(): string {
  const names = Object.keys(COMMANDS);
  return (
    `usage: kb <${names.join("|")}> [--dir <path>] [--project <name>] [--help|-h]\n` +
    `run "kb <command> --help" for that command's flags\n`
  );
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
  const { positionals, flags } = parseFlags(rest, REPEATABLE_FLAGS);
  const helpRequested = "help" in flags || hasHelpShort(argv);
  const knownSpec = cmd !== undefined ? getCommand(cmd) : undefined;

  // Bare invocation, the literal word "help", "--help", or "-h" as the command itself: the
  // top-level listing, unconditionally, before any I/O.
  if (cmd === undefined || cmd === "help" || cmd === "--help" || cmd === "-h") {
    process.stdout.write(topUsage());
    return 0;
  }

  // An unknown command is a hard error regardless of --help/-h alongside it -- "bogus --help"
  // is still "bogus", not a request for help. Resolved before validateFlags/arity so a typo'd
  // command name never has to pass through a table row that doesn't exist for it.
  if (!knownSpec) {
    process.stderr.write(topUsage());
    return 1;
  }

  // Known command + help intent: exit 0 with THIS command's usage regardless of what else is
  // wrong with the invocation (LD18) -- resolved before validateFlags so `archive --help
  // --bogus` still succeeds instead of losing to the unknown-flag error.
  if (helpRequested) {
    process.stdout.write(commandUsage(cmd, knownSpec));
    return 0;
  }

  const flagError = validateFlags(cmd, knownSpec, flags);
  if (flagError) { process.stderr.write(flagError + "\n"); return 1; }
  const arityError = validateArity(cmd, positionals, knownSpec.arity);
  if (arityError) { process.stderr.write(arityError + "\n"); return 1; }

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
  if (!resolved.ok) { process.stderr.write(`${cmd}: ${resolved.detail}\n`); return 1; }
  const context: DrawbarContext = resolved.context;
  const dir = context.memoryDir;
  // Scoped to archive/compact only (LD17): stats --json's documented side effect of creating
  // the store, and context/path's deliberate no-create-on-read, must both keep working. Checked
  // once per requiresStore command, but only where a pure input error (archive's --key/--days
  // mutual exclusion, an empty --key) does not already apply -- those fire regardless of
  // whether a store exists, so they are decided inside their own case below instead.
  const storeMissing = knownSpec.requiresStore && !existsSync(storePaths(dir).active);

  // LD18: a refusal must never touch the filesystem, and `ensureDir` creates the directory plus
  // a `.gitignore`. So it must not run ahead of a storeMissing refusal. The `--key` path is the
  // exception: its own input errors (mutual exclusion, empty key, missing key) win over
  // storeMissing and are decided in the case below, so it still needs the directory.
  const archiveKeyPath = cmd === "archive" && flags.key !== undefined;
  const skipEnsureDirForRefusal = storeMissing && !archiveKeyPath;
  if (!READ_ONLY_COMMANDS.includes(cmd) && !skipEnsureDirForRefusal) ensureDir(dir);

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
      if (typeof flags.since === "string") filters.since = parseNonNegInt(flags.since)!;
      if (typeof flags.limit === "string") filters.limit = parseNonNegInt(flags.limit)!;
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

      // The --key path never reaches here: an empty store just makes every requested key
      // "missing", which the branch above already reports. Only the days-based default -- the
      // one that would otherwise silently "archive" zero rows from nothing -- needs the guard.
      if (storeMissing) { process.stderr.write(`archive: no knowledge store found at ${dir}\n`); return 1; }
      const days = typeof flags.days === "string" ? parseNonNegInt(flags.days)! : 90;
      const cutoff = Math.floor(Date.now() / 1000) - days * 86400;
      const res = archiveOlderThan(dir, cutoff, { dryRun });
      if (!dryRun) buildIndex(dir);
      // "keys" would be the whole store on a real day-based run, so it's dry-run only.
      const out = dryRun ? { archived: res.archived, dryRun, keys: res.keys } : { archived: res.archived, dryRun };
      process.stdout.write(JSON.stringify(out) + "\n");
      return 0;
    }
    case "compact": {
      if (storeMissing) { process.stderr.write(`compact: no knowledge store found at ${dir}\n`); return 1; }
      const res = compactActive(dir, { dryRun: flags["dry-run"] === true });
      if (flags["dry-run"] !== true) buildIndex(dir);
      process.stdout.write(JSON.stringify(res) + "\n");
      return 0;
    }
    case "import": {
      const src = positionals[0]!; // arity validated to be exactly 1 above
      if (src === "") { process.stderr.write("import: <path> must not be empty\n"); return 1; }
      const { importLegacy } = await import("./lib/migrate");
      let report;
      try {
        report = importLegacy(src, dir);
      } catch (err) {
        // A missing file, a directory, or any other unreadable path must return an exit code
        // like every other input error, not reject the promise `run` returns.
        process.stderr.write(`import: ${err instanceof Error ? err.message : String(err)}\n`);
        return 1;
      }
      process.stdout.write(JSON.stringify(report, null, 2) + "\n");
      return 0;
    }
    default:
      // Unreachable: cmd passed the `!knownSpec` check above, so it names one of the cases.
      process.stderr.write(topUsage());
      return 1;
  }
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
