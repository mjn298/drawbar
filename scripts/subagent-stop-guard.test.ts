import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideFromInput } from "./subagent-stop-guard";

// decideFromInput reads the real filesystem (it's the thin seam between the hook's stdin JSON
// and the pure logic in scripts/lib/await-report-hook.ts), so these use real temp files rather
// than an injected FsDeps — there's no polling or timing here to fake.
describe("decideFromInput", () => {
  test("blocks a drawbar-story-lead whose async dispatch was never awaited", () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-test-"));
    try {
      const transcriptPath = join(dir, "transcript.jsonl");
      const lines = [
        JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Agent", input: {} }] } }),
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "Async agent launched" }] } }),
      ];
      writeFileSync(transcriptPath, lines.join("\n"));
      const res = decideFromInput({ agent_type: "drawbar:drawbar-story-lead", transcript_path: transcriptPath });
      expect(res.block).toBe(true);
      expect(res.reason).toContain("await-report");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("allows when the transcript is missing entirely (fails open)", () => {
    const res = decideFromInput({ agent_type: "drawbar:drawbar-story-lead", transcript_path: "/nonexistent/path.jsonl" });
    expect(res.block).toBe(false);
  });

  test("allows when transcript_path is absent from the input", () => {
    const res = decideFromInput({ agent_type: "drawbar:drawbar-story-lead" });
    expect(res.block).toBe(false);
  });

  test("allows a non-lead agent type even with an unawaited dispatch on disk", () => {
    const dir = mkdtempSync(join(tmpdir(), "guard-test-"));
    try {
      const transcriptPath = join(dir, "transcript.jsonl");
      const lines = [
        JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "Async agent launched" }] } }),
      ];
      writeFileSync(transcriptPath, lines.join("\n"));
      const res = decideFromInput({ agent_type: "drawbar:code-reviewer", transcript_path: transcriptPath });
      expect(res.block).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
