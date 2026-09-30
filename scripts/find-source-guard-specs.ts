// A helper for building a project's `sourceGuardSpecs` config list (see
// `scripts/lib/project-config.ts`), not something drawbar runs itself. A repo-wide guard spec —
// one that scans the PROJECT'S SOURCE TREE for a forbidden pattern (a vendor string literal
// where only a dispatch decision belongs, a direct read of a column an import graph says should
// route through one registry) rather than testing a story's own behavior — fails in CI even when
// a drawbar-story-lead's test selection, built from the story diff, never had a reason to pick it
// up. Two such misses in one hour on the `hourly` project (a vendor-literal guard and an
// import-graph spec) are what this tool exists to stop happening a third time.
//
// This module is deliberately NOT an oracle. It proposes candidates by content; a human (or an
// agent under human review) still reads each one and decides whether it belongs in the project's
// config. `classifySpec` is the pure verdict function; everything below it is the filesystem walk
// and CLI wrapper around it.

import { readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";

export interface Candidate {
  path: string;
  reasons: string[];
}

// Signal 1: the spec reads a real file off disk at all, rather than only exercising imported
// modules in memory. Necessary but nowhere near sufficient on its own — most `*.spec.ts` files
// in a typical project call `readFileSync` to load a JSON fixture, which says nothing about
// whether the spec scans SOURCE.
const FS_READ = /\breadFileSync\s*\(|\breaddirSync\s*\(/g;
// Non-global sibling for a plain existence check — `FS_READ` itself is stateful (`lastIndex`)
// and must never be `.test()`-ed directly outside `readsSrcTree`'s own loop.
const HAS_FS_READ = /\breadFileSync\s*\(|\breaddirSync\s*\(/;

// A path-shaped literal that walks into a `src` directory: either the standalone segment
// `"src"` (the common `join(..., "src")` idiom) or a longer literal with `/src/` (or `\src\`)
// embedded in it, e.g. `"../../../src/clients/toast/mappers.ts"`.
const SRC_PATH_LITERAL = /["'](?:src|[^"'\n]*[\\/]src[\\/][^"'\n]*)["']/;

// A `const` (or `let`) declaration whose right-hand side is built from a src-rooted path
// literal — the `SRC_ROOT = join(..., "src")` / `MAPPERS_PATH = path.join(__dirname,
// "../../../src/x.ts")` idiom. Captures the declared name so a later `readFileSync(NAME, ...)`
// can be recognized even though the literal itself is nowhere near that call site.
const SRC_CONST_DECL = new RegExp(
  `\\b(?:const|let)\\s+([A-Za-z_$][A-Za-z0-9_$]*)\\s*(?::[^=\\n]+)?=[^;\\n]*${SRC_PATH_LITERAL.source}`,
  "g",
);

// A conventionally-named source-root identifier (`SRC_ROOT`, `SRC_DIR`, `SRC_PATH`, or any
// `*_SRC` constant such as `BACKEND_SRC`) counts as a src reference at its use site even without
// a local declaration in view — the name itself is the convention this project family uses, and
// a call site built from one is reading from wherever that constant points.
const CONVENTIONAL_SRC_NAME = /\b(?:SRC_ROOT|SRC_DIR|SRC_PATH|[A-Z][A-Z0-9_]*_SRC)\b/;

function declaredSrcConstants(content: string): Set<string> {
  const names = new Set<string>();
  let m: RegExpExecArray | null;
  SRC_CONST_DECL.lastIndex = 0;
  while ((m = SRC_CONST_DECL.exec(content))) names.add(m[1]!);
  return names;
}

// Signal 2: an actual `readFileSync`/`readdirSync` call site whose argument expression is built
// from a source-tree root — either the src-rooted literal directly (`readFileSync("../../../src
// /x.ts")`), or a variable this file itself declared from one (`readFileSync(SRC_ROOT, ...)`).
// Scoped to the CALL SITE'S OWN argument text, not "does this file contain `/src/` anywhere" —
// a file that merely `import`s something from `../../../src/...` elsewhere, and separately
// `readFileSync`s an unrelated JSON fixture, must not count. A 200-character window after each
// call's opening paren is generous enough to cover a `join(...)` wrapping the path without
// pulling in unrelated code past the call.
function readsSrcTree(content: string): boolean {
  const srcConsts = declaredSrcConstants(content);
  FS_READ.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FS_READ.exec(content))) {
    const window = content.slice(m.index, m.index + 220);
    if (SRC_PATH_LITERAL.test(window) || CONVENTIONAL_SRC_NAME.test(window)) return true;
    for (const name of srcConsts) {
      if (new RegExp(`\\b${name}\\b`).test(window)) return true;
    }
  }
  return false;
}

// Signal 3: the filename itself names the kind of check this config field exists for. On its own
// this is the weakest signal (a file named `*.guard.spec.ts` may test runtime guard behavior with
// no source-scanning at all — see `terminationSchedulingClock.guard.spec.ts` in `hourly`, which
// this tool must NOT surface without signal 1 also being true) — it only strengthens a candidate
// that also reads the filesystem.
const NAME_KEYWORD = /guard|census|import-?graph|architecture/i;

// Pure: given one file's path and content, says whether it looks like a source-guard spec and
// why. Returns `null` rather than a `reasons: []` candidate — a file that reads fs but matches
// neither signal 2 nor signal 3 is not a candidate, it is silence.
export function classifySpec(path: string, content: string): Candidate | null {
  const reasons: string[] = [];
  if (readsSrcTree(content)) {
    reasons.push("a readFileSync/readdirSync call site reads a path built from a src-rooted literal or constant");
  }
  if (HAS_FS_READ.test(content) && NAME_KEYWORD.test(basename(path))) {
    reasons.push("filename suggests a guard, census, import-graph, or architecture check, and the file reads the filesystem");
  }
  if (reasons.length === 0) return null;
  return { path, reasons };
}

export function findSourceGuardSpecCandidates(files: Array<{ path: string; content: string }>): Candidate[] {
  const out: Candidate[] = [];
  for (const file of files) {
    const candidate = classifySpec(file.path, file.content);
    if (candidate) out.push(candidate);
  }
  return out;
}

// --- filesystem walk ---------------------------------------------------------------------------
//
// Skips `node_modules`, dot-directories (`.git`, `.drawbar`, ...), and any directory literally
// named `worktrees` — a project that keeps drawbar-ship's linked worktrees inside its own tree
// (as `hourly` does) would otherwise yield the same spec once per worktree.
const SKIP_DIR_NAMES = new Set(["node_modules", "worktrees"]);

export function listSpecFiles(root: string, namePattern: RegExp = /\.spec\.ts$/): string[] {
  const out: string[] = [];
  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || SKIP_DIR_NAMES.has(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile() && namePattern.test(entry.name)) {
        out.push(full);
      }
    }
  }
  walk(root);
  return out;
}

// Real filesystem read, injectable so `main` can be driven in-process in tests exactly like
// `scripts/lib/ship-config.ts`'s `MainDeps` pattern.
export interface MainDeps {
  argv?: string[];
  cwd?: string;
  listFiles?: (root: string, namePattern?: RegExp) => string[];
  readFile?: (path: string) => string;
  writeStdout?: (s: string) => void;
  writeStderr?: (s: string) => void;
}

export function parseArgs(args: string[]): { ok: true; root: string } | { ok: false; error: string } {
  if (args.length === 0) return { ok: false, error: "usage: find-source-guard-specs.ts <root-dir>" };
  if (args.length > 1) return { ok: false, error: `unexpected extra argument: ${args[1]}` };
  return { ok: true, root: args[0]! };
}

export function main(deps: MainDeps = {}): number {
  const argv = deps.argv ?? process.argv.slice(2);
  const cwd = deps.cwd ?? process.cwd();
  const listFiles = deps.listFiles ?? listSpecFiles;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  const writeStdout = deps.writeStdout ?? ((s: string) => { process.stdout.write(s); });
  const writeStderr = deps.writeStderr ?? ((s: string) => { process.stderr.write(s); });

  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    writeStderr(`refused: ${parsed.error}\n`);
    return 1;
  }

  const root = parsed.root;
  const paths = listFiles(root);
  const files = paths.map((p) => ({ path: p, content: readFile(p) }));
  const candidates = findSourceGuardSpecCandidates(files);

  if (candidates.length === 0) {
    writeStdout("no candidates found\n");
    return 0;
  }
  for (const c of candidates) {
    writeStdout(`${relative(cwd, c.path)}\n`);
    for (const reason of c.reasons) writeStdout(`  - ${reason}\n`);
  }
  return 0;
}

if (import.meta.main) {
  process.exit(main());
}
