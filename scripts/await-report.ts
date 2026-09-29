#!/usr/bin/env bun
// CLI wrapper around scripts/lib/await-report.ts. See that module's header comment for why
// this exists: a drawbar-story-lead must never end its turn to wait for a dispatched
// sub-agent's report, and this replaces the inline zsh polling loop that instruction used to
// spell out (drawbar-story-lead.md previously carried the loop directly; it now just calls
// this). One call stays comfortably under the Bash tool's 10-minute cap; the lead re-invokes
// it if the role's total time budget hasn't run out yet.
//
// Usage: await-report <REPORTS_DIR> <role> [budget-seconds]
//   Exit 0 and print the report text (from the file or, on timeout, recovered from the
//   sub-agent's own transcript) to stdout, prefixed with a one-line `# source: ...` marker.
//   Exit 1 with a message on stderr if nothing was found at all.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { awaitReport, type FsDeps } from "./lib/await-report";

function findSubagentDirs(root: string): string[] {
  // Sub-agent transcripts live at ~/.claude/projects/<encoded-cwd>/<session-id>/subagents/*.jsonl.
  // We don't know our own encoded-cwd reliably (it can differ from a literal path encoding in
  // some harness builds), so scan every project dir's subagents folders rather than guess one.
  const out: string[] = [];
  if (!existsSync(root)) return out;
  for (const projectDir of readdirSync(root)) {
    const projectPath = join(root, projectDir);
    let sessionDirs: string[];
    try {
      sessionDirs = readdirSync(projectPath);
    } catch {
      continue;
    }
    for (const sessionDir of sessionDirs) {
      const subagentsPath = join(projectPath, sessionDir, "subagents");
      if (existsSync(subagentsPath)) out.push(subagentsPath);
    }
  }
  return out;
}

function listJsonlFiles(dirs: string[]): string[] {
  const out: string[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) if (e.endsWith(".jsonl")) out.push(join(dir, e));
  }
  return out;
}

// listDir here returns absolute file paths (not directory names) for every candidate
// transcript under the given projects root, since awaitReport's contract just wants "every
// *.jsonl this dispatch could be in" and lets transcriptMatchesDispatch pick the real one.
const realFs: FsDeps = {
  exists: (p) => existsSync(p),
  readFile: (p) => readFileSync(p, "utf8"),
  listDir: (projectsRoot) => listJsonlFiles(findSubagentDirs(projectsRoot)),
  statMtimeMs: (p) => statSync(p).mtimeMs,
  sleepMs: (ms) => new Promise((r) => setTimeout(r, ms)),
  nowMs: () => Date.now(),
};

export async function run(argv: string[], fs: FsDeps = realFs): Promise<number> {
  const [reportsDir, role, budgetArg] = argv;
  if (!reportsDir || !role) {
    process.stderr.write("usage: await-report <REPORTS_DIR> <role> [budget-seconds]\n");
    return 1;
  }
  const budgetSeconds = budgetArg ? Number(budgetArg) : 480; // stays under the 540s the lead's old loop used, well under the 600s Bash cap
  if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0) {
    process.stderr.write("await-report: budget-seconds must be a positive number\n");
    return 1;
  }

  const result = await awaitReport(fs, {
    reportsDir,
    role,
    budgetSeconds,
    // The search root is ignored by our realFs.listDir (it walks all of ~/.claude/projects
    // itself), but the parameter stays so tests can point it at a synthetic directory.
    transcriptSearchRoot: join(homedir(), ".claude", "projects"),
  });

  if (result.ok) {
    process.stdout.write(`# source: ${result.source}${result.path ? ` (${result.path})` : ""}\n`);
    process.stdout.write(`${result.text}\n`);
    return 0;
  }
  process.stderr.write(`await-report: ${result.detail}\n`);
  return 1;
}

if (import.meta.main) {
  run(process.argv.slice(2)).then((code) => process.exit(code));
}
