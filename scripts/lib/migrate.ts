import { readFileSync } from "node:fs";
import { validateEntry, type Entry } from "./schema";
import { appendEntry, ensureDir } from "./store";
import { buildIndex } from "./fts";

export interface ImportReport {
  total: number;
  imported: number;
  dropped: number;
  droppedLines: { line: number; reason: string }[];
}

export function importLegacy(oldPath: string, dir: string): ImportReport {
  ensureDir(dir);
  const report: ImportReport = { total: 0, imported: 0, dropped: 0, droppedLines: [] };
  const lines = readFileSync(oldPath, "utf8").split("\n");

  lines.forEach((line, i) => {
    if (line.trim() === "") return;
    report.total++;
    const lineNo = i + 1;

    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line) as Record<string, unknown>;
    } catch {
      report.dropped++;
      report.droppedLines.push({ line: lineNo, reason: "invalid JSON" });
      return;
    }

    // Remap legacy lavra type aliases onto drawbar's schema. The lavra corpus
    // used a `must-check` type; drawbar expresses the same thing as a `learned`
    // entry whose content begins `MUST-CHECK:`. Preserve these — they are the
    // constraints the planning/compounding loop depends on.
    let { type, content } = obj as { type?: unknown; content?: unknown };
    if (type === "must-check") {
      type = "learned";
      if (typeof content === "string" && !/^\s*must-check:/i.test(content)) {
        content = "MUST-CHECK: " + content;
      }
    }

    // Map legacy bead -> issue; default files.
    const candidate = {
      ...obj,
      type,
      content,
      issue: obj.issue ?? obj.bead ?? null,
      files: obj.files ?? [],
    };
    const v = validateEntry(candidate);
    if (!v.ok) {
      report.dropped++;
      report.droppedLines.push({ line: lineNo, reason: v.error });
      return;
    }
    appendEntry(dir, v.entry as Entry);
    report.imported++;
  });

  buildIndex(dir);
  return report;
}
