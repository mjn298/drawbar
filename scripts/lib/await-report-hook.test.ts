import { test, expect, describe } from "bun:test";
import { decide, findUnawaitedAsyncDispatch } from "./await-report-hook";

function assistantText(text: string): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
}

function toolResult(text: string): string {
  // Shape of a user-role tool_result entry as Claude Code writes it to the transcript.
  return JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: text }] } });
}

function toolUseAgent(input: Record<string, unknown> = {}): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Agent", input }] } });
}

function bashCall(command: string): string {
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: { command } }] } });
}

describe("findUnawaitedAsyncDispatch", () => {
  test("returns null when there was never an async dispatch", () => {
    const lines = [assistantText("dispatching a fresh agent"), toolResult("full report text, not async")];
    expect(findUnawaitedAsyncDispatch(lines)).toBeNull();
  });

  test("blocks when an async launch has no later await-report call", () => {
    const lines = [
      toolUseAgent({ description: "implement the story" }),
      toolResult("Async agent launched"),
      assistantText("ok, I'll wrap up now"),
    ];
    const reason = findUnawaitedAsyncDispatch(lines);
    expect(reason).not.toBeNull();
    expect(reason).toContain("await-report");
  });

  test("passes when the async launch is followed by an await-report call", () => {
    const lines = [
      toolUseAgent({ description: "implement the story" }),
      toolResult("Async agent launched"),
      bashCall("await-report /tmp/reports.XXXX implementer 480"),
    ];
    expect(findUnawaitedAsyncDispatch(lines)).toBeNull();
  });

  test("blocks when only an EARLIER await-report call exists, before a later async launch", () => {
    const lines = [
      bashCall("await-report /tmp/reports.XXXX implementer 480"),
      toolUseAgent({ description: "dispatch reviewer" }),
      toolResult("Async agent launched"),
    ];
    const reason = findUnawaitedAsyncDispatch(lines);
    expect(reason).not.toBeNull();
  });

  test("tolerates malformed lines interspersed with valid ones", () => {
    const lines = ["{not json", toolUseAgent(), toolResult("Async agent launched"), "", bashCall("await-report /r implementer")];
    expect(findUnawaitedAsyncDispatch(lines)).toBeNull();
  });
});

describe("decide", () => {
  const blockingTranscript = [toolUseAgent(), toolResult("Async agent launched")];
  const cleanTranscript = [toolUseAgent(), toolResult("Async agent launched"), bashCall("await-report /r implementer")];

  test("blocks a bare 'drawbar-story-lead' agent type with an unawaited dispatch", () => {
    const res = decide("drawbar-story-lead", blockingTranscript);
    expect(res.block).toBe(true);
    expect(res.reason).toContain("await-report");
  });

  test("blocks the namespaced 'drawbar:drawbar-story-lead' agent type the same way", () => {
    const res = decide("drawbar:drawbar-story-lead", blockingTranscript);
    expect(res.block).toBe(true);
  });

  test("allows a drawbar-story-lead whose dispatch was awaited", () => {
    const res = decide("drawbar:drawbar-story-lead", cleanTranscript);
    expect(res.block).toBe(false);
  });

  test("never blocks an unrelated agent type, even with an unawaited async dispatch", () => {
    const res = decide("drawbar:code-reviewer", blockingTranscript);
    expect(res.block).toBe(false);
  });

  test("never blocks when agent_type is missing", () => {
    const res = decide(undefined, blockingTranscript);
    expect(res.block).toBe(false);
  });
});
