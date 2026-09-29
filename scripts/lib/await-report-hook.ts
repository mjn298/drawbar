// The SubagentStop hook logic backing hooks/hooks.json's guard on drawbar-story-lead. Verified
// against the real Claude Code docs (https://code.claude.com/docs/en/hooks.md,
// "SubagentStop Hook Reference", fetched 2026-09-28): a SubagentStop hook's input JSON includes
// `agent_type` (the agent's declared name, e.g. `"drawbar-story-lead"`), `agent_id`, and
// `last_assistant_message`, plus the common fields `session_id`, `transcript_path`, `cwd`.
// Blocking works via top-level `{"decision": "block", "reason": "..."}` in the hook's stdout
// JSON (exit 0), or via exit code 2 with the reason on stderr; either prevents the subagent
// from stopping. Neither mechanism is documented as loop-proof — a hook that blocks every time
// its own condition is unmet can loop forever, so this hook's condition must eventually be
// satisfiable, which is why it looks for "was await-report invoked at all after the async
// launch" rather than anything stronger (e.g. "did the report file end up non-empty") — the
// lead calling await-report and getting a real timeout is a legitimate way to stop.
//
// What this hook CANNOT see reliably: the docs (same page, "Important Caveat") say the
// transcript file is written asynchronously and may lag the in-memory conversation, so the
// very last message of the stopping turn might not be in it yet. That only matters for
// deciding "is the CURRENT turn's stop safe", and this hook only inspects PAST tool calls
// (the async launch and any subsequent await-report invocation), which by definition already
// completed and were flushed before the turn that is now stopping — so the lag caveat does not
// undermine this specific check. What it also cannot see: whether `await-report`'s eventual
// output was actually read as the sub-agent's report, versus discarded — this hook, like the
// lead's own prose used to, trusts that a called tool's result was used.

const ASYNC_LAUNCH_MARKER = /async agent launched/i;
const AWAIT_REPORT_MARKER = /\bawait-report\b/;
// Plugin agents are namespaced as "<plugin-name>:<agent-name>" at runtime (observed directly:
// this plugin's own Agent tool listing names it "drawbar:drawbar-story-lead", not the bare
// "drawbar-story-lead" that agents/drawbar-story-lead.md's frontmatter `name:` gives it) — so
// match on a suffix rather than requiring one exact string, to be namespace-agnostic.
const GUARDED_AGENT_TYPE_SUFFIX = "drawbar-story-lead";

function isGuardedAgentType(agentType: string | undefined): boolean {
  if (!agentType) return false;
  return agentType === GUARDED_AGENT_TYPE_SUFFIX || agentType.endsWith(`:${GUARDED_AGENT_TYPE_SUFFIX}`);
}

export interface GuardDecision {
  block: boolean;
  reason?: string;
}

interface ParsedEntry {
  index: number;
  raw: Record<string, unknown>;
}

function parseLines(lines: string[]): ParsedEntry[] {
  const out: ParsedEntry[] = [];
  lines.forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const raw = JSON.parse(line);
      if (raw && typeof raw === "object") out.push({ index, raw: raw as Record<string, unknown> });
    } catch {
      // Malformed lines are skipped rather than failing the whole scan — a single truncated
      // write at the tail of an in-progress transcript must not crash the guard.
    }
  });
  return out;
}

/** Extracts any plain-text content from a transcript entry, from either an assistant message's
 *  text blocks, a tool_use's stringified input, or a user-role tool_result's content. */
function entryText(entry: ParsedEntry): string {
  const message = entry.raw.message as Record<string, unknown> | undefined;
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => {
      if (!b || typeof b !== "object") return "";
      const block = b as Record<string, unknown>;
      if (typeof block.text === "string") return block.text;
      if (typeof block.content === "string") return block.content;
      if (Array.isArray(block.content)) {
        return block.content.map((c) => (c && typeof c === "object" && typeof (c as Record<string, unknown>).text === "string" ? (c as Record<string, unknown>).text : "")).join("\n");
      }
      if (block.input) return JSON.stringify(block.input);
      return "";
    })
    .join("\n");
}

/**
 * Scans a lead's own transcript for an `Agent` dispatch whose result was the async-launch
 * placeholder, with no LATER tool call anywhere in the transcript mentioning `await-report`.
 * Returns the block reason for the first such unmatched dispatch found, or null if every async
 * dispatch (if any) was followed by an await-report call, or there were no async dispatches.
 */
export function findUnawaitedAsyncDispatch(lines: string[]): string | null {
  const entries = parseLines(lines);

  const asyncDispatchIndexes = entries.filter((e) => ASYNC_LAUNCH_MARKER.test(entryText(e))).map((e) => e.index);
  if (asyncDispatchIndexes.length === 0) return null;

  const lastAsyncIndex = Math.max(...asyncDispatchIndexes);
  const awaitedAfter = entries.some((e) => e.index > lastAsyncIndex && AWAIT_REPORT_MARKER.test(entryText(e)));
  if (awaitedAfter) return null;

  return "a sub-agent's report is outstanding: run `await-report <dir> <role>`";
}

/**
 * Top-level SubagentStop decision. `agentType` is the hook input's `agent_type` field; only
 * drawbar-story-lead is guarded — every other subagent (reviewers, implementers, anything else)
 * passes through untouched, because they don't themselves dispatch further sub-agents via the
 * Agent tool in this plugin's design.
 */
export function decide(agentType: string | undefined, transcriptLines: string[]): GuardDecision {
  if (!isGuardedAgentType(agentType)) return { block: false };
  const reason = findUnawaitedAsyncDispatch(transcriptLines);
  if (reason) return { block: true, reason };
  return { block: false };
}
