import { test, expect, describe } from "bun:test";
import { validateEntry, parseLine, normalizeKey, KNOWLEDGE_TYPES } from "./schema";

const good = {
  key: "pattern-load-set-check",
  type: "pattern",
  content: "Collect keys into a Set, batch-fetch, then filter.",
  source: "user",
  tags: ["dynamodb", "perf"],
  ts: 1772920559,
  issue: "PCO-123",
  files: ["pipeline/index.ts"],
};

describe("validateEntry", () => {
  test("accepts a well-formed entry", () => {
    const r = validateEntry(good);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.entry.key).toBe("pattern-load-set-check");
  });

  test("defaults optional fields", () => {
    const r = validateEntry({ key: "k", type: "fact", content: "c", ts: 1 });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.entry.source).toBe("agent");
      expect(r.entry.tags).toEqual([]);
      expect(r.entry.files).toEqual([]);
      expect(r.entry.issue).toBeNull();
    }
  });

  test("rejects an unknown type", () => {
    const r = validateEntry({ ...good, type: "bogus" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("type");
  });

  test("rejects a missing key", () => {
    const r = validateEntry({ ...good, key: "" });
    expect(r.ok).toBe(false);
  });

  test("rejects missing content", () => {
    const r = validateEntry({ key: "k", type: "fact", ts: 1 });
    expect(r.ok).toBe(false);
  });

  test("knows all six types", () => {
    expect(KNOWLEDGE_TYPES.length).toBe(6);
  });

  test("defaults ts to current unix seconds when missing", () => {
    const r = validateEntry({ key: "k", type: "fact", content: "c" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(typeof r.entry.ts).toBe("number");
      expect(r.entry.ts).toBeGreaterThan(1_700_000_000); // after 2023
    }
  });

  test("rejects a present-but-non-numeric ts", () => {
    const r = validateEntry({ key: "k", type: "fact", content: "c", ts: "soon" });
    expect(r.ok).toBe(false);
  });
});

describe("parseLine", () => {
  test("parses a valid JSONL line", () => {
    const r = parseLine(JSON.stringify(good));
    expect(r.ok).toBe(true);
  });

  test("fails on malformed JSON without throwing", () => {
    const r = parseLine('{"key": "x", bogus}');
    expect(r.ok).toBe(false);
  });

  test("fails on a line that is valid JSON but an invalid entry", () => {
    const r = parseLine('{"hello": "world"}');
    expect(r.ok).toBe(false);
  });
});

describe("normalizeKey", () => {
  test("kebab-cases and strips punctuation", () => {
    expect(normalizeKey("Load Set Check!")).toBe("load-set-check");
  });
});
