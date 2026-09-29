// A lead agent (drawbar-story-lead.md) dispatches sub-agents whose `Agent` tool call can come
// back as "Async agent launched" instead of the agent's report — the async agent's completion
// notice then goes to the top-level session that dispatched the LEAD, never to the lead itself,
// so a lead that ends its turn to wait sits idle for good (observed: two Clover leads stalled
// 2 to 2.5 hours on 2026-09-28/29, despite the prose in drawbar-story-lead.md already saying not
// to). This module makes the wait mechanical instead of relying on the lead remembering to loop.
//
// `awaitReport` polls a well-known file for a non-empty report. If the budget runs out before
// the file appears, it falls back to the dispatched sub-agent's OWN transcript on disk — every
// sub-agent's session is logged under `~/.claude/projects/<encoded-cwd>/**/subagents/*.jsonl`
// regardless of whether its "Async agent launched" placeholder ever resolved for the caller —
// and recovers the sub-agent's last assistant message from there. That transcript is the
// sub-agent's own words, first-hand, not a guess at what it would have said.
//
// Every I/O boundary is injected (Locked house style, see scripts/lib/stack.ts and
// scripts/lib/ship-config.ts) so tests drive this against a synthetic directory tree with no
// real filesystem timing and no real ~/.claude/projects.

export interface FsDeps {
  exists: (path: string) => boolean;
  readFile: (path: string) => string;
  listDir: (path: string) => string[];
  statMtimeMs: (path: string) => number;
  sleepMs: (ms: number) => Promise<void>;
  nowMs: () => number;
}

export interface AwaitReportResult {
  ok: boolean;
  /** Where the report text came from: the expected report file, a recovered transcript, or nowhere. */
  source: "report-file" | "recovered-transcript" | "none";
  /** The report text itself, when found. */
  text?: string;
  /** Absolute path actually written/read, when applicable. */
  path?: string;
  /** Human-readable explanation, always present so a caller can print it verbatim on failure. */
  detail: string;
}

export interface AwaitReportOptions {
  reportsDir: string;
  role: string;
  /** Total wall-clock budget for this single call, in seconds. Kept well under the Bash tool's
   *  10-minute cap so one call always returns; the lead is expected to call again on timeout. */
  budgetSeconds: number;
  /** Where to search for a recovered transcript when the report file never appears. */
  transcriptSearchRoot: string;
  pollIntervalMs?: number;
}

const DEFAULT_POLL_MS = 3000;

/** The report file this role is expected to write. */
export function reportPath(reportsDir: string, role: string): string {
  return `${reportsDir.replace(/\/+$/, "")}/${role}.md`;
}

/**
 * Polls for `<reportsDir>/<role>.md` to become non-empty. Returns as soon as it does. On
 * timeout, attempts transcript recovery (see `recoverFromTranscripts`) before giving up.
 */
export async function awaitReport(fs: FsDeps, opts: AwaitReportOptions): Promise<AwaitReportResult> {
  const path = reportPath(opts.reportsDir, opts.role);
  const deadline = fs.nowMs() + opts.budgetSeconds * 1000;
  const pollMs = opts.pollIntervalMs ?? DEFAULT_POLL_MS;

  while (fs.nowMs() < deadline) {
    if (fs.exists(path)) {
      const text = fs.readFile(path);
      if (text.trim().length > 0) {
        return { ok: true, source: "report-file", text, path, detail: `found ${path}` };
      }
    }
    await fs.sleepMs(pollMs);
  }

  // Final check right at the deadline — avoids a race where the file lands during the last sleep.
  if (fs.exists(path)) {
    const text = fs.readFile(path);
    if (text.trim().length > 0) {
      return { ok: true, source: "report-file", text, path, detail: `found ${path} at deadline` };
    }
  }

  const recovered = recoverFromTranscripts(fs, opts.transcriptSearchRoot, opts.reportsDir, opts.role);
  if (recovered) {
    const marked = `<!-- recovered from transcript: ${recovered.path} -->\n\n${recovered.text}`;
    return { ok: true, source: "recovered-transcript", text: marked, path: recovered.path, detail: `recovered from ${recovered.path}` };
  }

  return {
    ok: false,
    source: "none",
    detail: `timed out after ${opts.budgetSeconds}s waiting for ${path}, and no sub-agent transcript under ${opts.transcriptSearchRoot} mentioned ${opts.reportsDir}`,
  };
}

interface RecoveredTranscript { path: string; text: string; }

/**
 * Scans every `*.jsonl` transcript under `searchRoot` (expected: a session's
 * `subagents/` directory) for one whose FIRST user message contains `reportsDir` — that ties
 * the transcript to this specific dispatch, since `reportsDir` is a fresh `mktemp -d` per story
 * and never reused. Among matches, picks the most recently modified. Extracts that transcript's
 * last assistant text block as the recovered report.
 */
export function recoverFromTranscripts(
  fs: FsDeps,
  searchRoot: string,
  reportsDir: string,
  role: string,
): RecoveredTranscript | null {
  if (!fs.exists(searchRoot)) return null;
  const candidates = fs.listDir(searchRoot).filter((p) => p.endsWith(".jsonl"));

  let best: { path: string; mtime: number; text: string } | null = null;
  for (const path of candidates) {
    let raw: string;
    try {
      raw = fs.readFile(path);
    } catch {
      continue;
    }
    const lines = raw.split("\n").filter((l) => l.trim().length > 0);
    if (lines.length === 0) continue;

    if (!transcriptMatchesDispatch(lines, reportsDir, role)) continue;

    const lastText = lastAssistantText(lines);
    if (!lastText) continue;

    const mtime = fs.statMtimeMs(path);
    if (!best || mtime > best.mtime) best = { path, mtime, text: lastText };
  }

  return best ? { path: best.path, text: best.text } : null;
}

/**
 * True if an early user-role message in the transcript names both this reports directory AND
 * this role's filename — `reportsDir` alone is not enough to disambiguate, because one story's
 * `mktemp -d` is shared by every role dispatched for that story (implementer, both reviewers,
 * the fix-pass implementer), so several sub-agent transcripts all mention the same directory.
 */
function transcriptMatchesDispatch(lines: string[], reportsDir: string, role: string): boolean {
  // The dispatch brief is the first user message; scanning only the first few lines keeps this
  // cheap and avoids a false match from the reportsDir being echoed back later by coincidence.
  const probe = lines.slice(0, 5).join("\n");
  return probe.includes(reportsDir) && probe.includes(`${role}.md`);
}

/** Pulls the last assistant text block out of a Claude Code JSONL transcript. */
export function lastAssistantText(lines: string[]): string | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    let entry: unknown;
    try {
      entry = JSON.parse(lines[i]!);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    if (e.type !== "assistant") continue;
    const message = e.message as Record<string, unknown> | undefined;
    const content = message?.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((b): b is { type: string; text: string } => !!b && typeof b === "object" && (b as { type?: string }).type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    if (text.length > 0) return text;
  }
  return null;
}
