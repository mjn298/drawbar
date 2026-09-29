import { test, expect, describe } from "bun:test";
import { awaitReport, recoverFromTranscripts, lastAssistantText, reportPath, type FsDeps } from "./await-report";

// A tiny in-memory filesystem so these tests control time deterministically instead of racing
// real sleeps and real mtimes — the same seam shape as scripts/lib/stack.ts's injected Runner.
function makeFakeFs(opts: { files?: Record<string, string>; mtimes?: Record<string, number> } = {}): FsDeps & { setFile: (p: string, c: string) => void; advance: (ms: number) => void } {
  const files = new Map<string, string>(Object.entries(opts.files ?? {}));
  const mtimes = new Map<string, number>(Object.entries(opts.mtimes ?? {}));
  let clock = 0;
  const sleeps: number[] = [];
  return {
    // A path "exists" if it's a known file, or a known directory prefix of one (this fake has
    // no real directories, only file keys, so treat any prefix of a file path as present).
    exists: (p) => files.has(p) || [...files.keys()].some((f) => f.startsWith(p.endsWith("/") ? p : p + "/")),
    readFile: (p) => {
      if (!files.has(p)) throw new Error(`ENOENT: ${p}`);
      return files.get(p)!;
    },
    listDir: (root) => [...files.keys()].filter((p) => p.startsWith(root)),
    statMtimeMs: (p) => mtimes.get(p) ?? 0,
    sleepMs: async (ms) => {
      sleeps.push(ms);
      clock += ms;
    },
    nowMs: () => clock,
    setFile: (p, c) => files.set(p, c),
    advance: (ms) => { clock += ms; },
  };
}

function transcriptLine(role: "user" | "assistant", text: string): string {
  if (role === "user") return JSON.stringify({ type: "user", message: { role: "user", content: text } });
  return JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
}

describe("reportPath", () => {
  test("joins dir and role with no double slash", () => {
    expect(reportPath("/tmp/reports/", "implementer")).toBe("/tmp/reports/implementer.md");
    expect(reportPath("/tmp/reports", "implementer")).toBe("/tmp/reports/implementer.md");
  });
});

describe("awaitReport", () => {
  test("returns immediately when the report file already has content", async () => {
    const fs = makeFakeFs({ files: { "/r/implementer.md": "done: added the feature" } });
    const res = await awaitReport(fs, { reportsDir: "/r", role: "implementer", budgetSeconds: 60, transcriptSearchRoot: "/transcripts" });
    expect(res.ok).toBe(true);
    expect(res.source).toBe("report-file");
    expect(res.text).toContain("added the feature");
  });

  test("polls until the file appears within the budget", async () => {
    const fs = makeFakeFs();
    // Simulate the file landing after the fake clock advances past 2 polls, by having
    // sleepMs itself write the file on its second call.
    let calls = 0;
    const originalSleep = fs.sleepMs;
    fs.sleepMs = async (ms) => {
      calls++;
      await originalSleep(ms);
      if (calls === 2) fs.setFile("/r/reviewer.md", "review: looks good");
    };
    const res = await awaitReport(fs, { reportsDir: "/r", role: "reviewer", budgetSeconds: 60, transcriptSearchRoot: "/transcripts", pollIntervalMs: 5000 });
    expect(res.ok).toBe(true);
    expect(res.source).toBe("report-file");
    expect(res.text).toBe("review: looks good");
  });

  test("recovers from a matching sub-agent transcript when the file never appears", async () => {
    const lines = [
      transcriptLine("user", "As your last action, write your full final report to the file `implementer.md` inside /r (Write, or a quoted heredoc through Bash)"),
      transcriptLine("assistant", "working on it"),
      transcriptLine("assistant", "Final report: implemented the widget, tests pass."),
    ].join("\n");
    const fs = makeFakeFs({
      files: { "/transcripts/session1/subagents/agent-a1.jsonl": lines },
      mtimes: { "/transcripts/session1/subagents/agent-a1.jsonl": 100 },
    });
    const res = await awaitReport(fs, { reportsDir: "/r", role: "implementer", budgetSeconds: 1, transcriptSearchRoot: "/transcripts", pollIntervalMs: 10 });
    expect(res.ok).toBe(true);
    expect(res.source).toBe("recovered-transcript");
    expect(res.text).toContain("implemented the widget, tests pass.");
    expect(res.text).toContain("recovered from transcript");
  });

  test("exits non-zero (ok: false) when the file never appears and no transcript matches", async () => {
    const fs = makeFakeFs({
      files: { "/transcripts/session1/subagents/unrelated.jsonl": [
        transcriptLine("user", "some other dispatch entirely, mentions /other/dir"),
        transcriptLine("assistant", "unrelated final text"),
      ].join("\n") },
    });
    const res = await awaitReport(fs, { reportsDir: "/r", role: "implementer", budgetSeconds: 1, transcriptSearchRoot: "/transcripts", pollIntervalMs: 10 });
    expect(res.ok).toBe(false);
    expect(res.source).toBe("none");
    expect(res.detail).toContain("timed out");
  });
});

describe("recoverFromTranscripts", () => {
  test("picks the most recently modified matching transcript when several match", () => {
    const older = [
      transcriptLine("user", "report to /r/implementer.md"),
      transcriptLine("assistant", "older attempt, ignore"),
    ].join("\n");
    const newer = [
      transcriptLine("user", "report to /r/implementer.md"),
      transcriptLine("assistant", "final: newer and correct"),
    ].join("\n");
    const fs = makeFakeFs({
      files: {
        "/t/s1/subagents/a-old.jsonl": older,
        "/t/s2/subagents/a-new.jsonl": newer,
      },
      mtimes: {
        "/t/s1/subagents/a-old.jsonl": 100,
        "/t/s2/subagents/a-new.jsonl": 999,
      },
    });
    const res = recoverFromTranscripts(fs, "/t", "/r", "implementer");
    expect(res?.text).toBe("final: newer and correct");
  });

  test("does not match a transcript for a different role sharing the same reportsDir", () => {
    const reviewerTranscript = [
      transcriptLine("user", "report to /r/reviewer.md"),
      transcriptLine("assistant", "reviewer's own report"),
    ].join("\n");
    const fs = makeFakeFs({
      files: { "/t/s1/subagents/a1.jsonl": reviewerTranscript },
      mtimes: { "/t/s1/subagents/a1.jsonl": 100 },
    });
    const res = recoverFromTranscripts(fs, "/t", "/r", "implementer");
    expect(res).toBeNull();
  });

  test("returns null when the search root does not exist", () => {
    const fs = makeFakeFs();
    expect(recoverFromTranscripts(fs, "/nope", "/r", "implementer")).toBeNull();
  });
});

describe("lastAssistantText", () => {
  test("returns the last non-empty assistant text block, skipping tool-only assistant turns", () => {
    const lines = [
      transcriptLine("assistant", "first"),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Read", input: {} }] } }),
      transcriptLine("assistant", "final answer"),
    ];
    expect(lastAssistantText(lines)).toBe("final answer");
  });

  test("returns null when there is no assistant text at all", () => {
    expect(lastAssistantText([transcriptLine("user", "hi")])).toBeNull();
  });

  test("tolerates malformed JSON lines", () => {
    const lines = ["not json at all", transcriptLine("assistant", "ok")];
    expect(lastAssistantText(lines)).toBe("ok");
  });
});
