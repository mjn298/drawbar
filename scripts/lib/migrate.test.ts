import { test, expect, describe, beforeEach } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importLegacy } from "./migrate";
import { readEntries } from "./store";

let dir: string;
const fixture = join(import.meta.dir, "fixtures", "legacy-corrupt.jsonl");
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "kb-migrate-"));
});

describe("importLegacy", () => {
  test("imports the valid entries and drops the corrupt ones", () => {
    const report = importLegacy(fixture, dir);
    expect(report.total).toBe(5);
    expect(report.imported).toBe(2);
    expect(report.dropped).toBe(3);
    expect(report.imported + report.dropped).toBe(report.total); // no silent loss
  });

  test("reports each dropped line with its number and a reason", () => {
    const report = importLegacy(fixture, dir);
    const lines = report.droppedLines.map((d) => d.line).sort((a, b) => a - b);
    expect(lines).toEqual([2, 3, 5]);
    for (const d of report.droppedLines) expect(d.reason.length).toBeGreaterThan(0);
  });

  test("maps the legacy bead field onto issue", () => {
    importLegacy(fixture, dir);
    const byKey = Object.fromEntries(readEntries(dir).map((e) => [e.key, e]));
    expect(byKey["learned-a"]!.issue).toBe("hourly-1g0");
    expect(byKey["learned-a"]!.files).toEqual([]);
  });
});
