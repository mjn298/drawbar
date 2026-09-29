#!/usr/bin/env bun
// SubagentStop hook entry point, wired up in hooks/hooks.json. Reads the hook input JSON from
// stdin (Claude Code's documented contract for hook scripts), reads the stopping subagent's own
// transcript, and either allows the stop (exit 0, no output) or blocks it (JSON `{"decision":
// "block", "reason": ...}` on stdout, exit 0 — the documented non-exit-2 blocking path) when a
// drawbar-story-lead is stopping with a dispatched sub-agent's async report still outstanding.
// See scripts/lib/await-report-hook.ts for the decision logic and its sourcing.

import { readFileSync } from "node:fs";
import { decide } from "./lib/await-report-hook";

interface HookInput {
  agent_type?: string;
  transcript_path?: string;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

export function decideFromInput(input: HookInput): { block: boolean; reason?: string } {
  if (!input.transcript_path) return { block: false };
  let text: string;
  try {
    text = readFileSync(input.transcript_path, "utf8");
  } catch {
    // Can't read the transcript at all: fail open. A guard that crashes the stop pipeline on a
    // missing/unreadable file is worse than one that occasionally misses a real violation.
    return { block: false };
  }
  const lines = text.split("\n");
  return decide(input.agent_type, lines);
}

async function main(): Promise<number> {
  let input: HookInput;
  try {
    input = JSON.parse(await readStdin());
  } catch {
    return 0; // malformed/absent input: fail open, never block on a parse error
  }
  const result = decideFromInput(input);
  if (result.block) {
    process.stdout.write(JSON.stringify({ decision: "block", reason: result.reason }) + "\n");
  }
  return 0; // always exit 0 — blocking is expressed via the JSON decision, not exit code 2
}

if (import.meta.main) {
  main().then((code) => process.exit(code));
}
