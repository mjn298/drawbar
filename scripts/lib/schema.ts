export const KNOWLEDGE_TYPES = [
  "learned", "decision", "pattern", "fact", "investigation", "deviation",
] as const;
export type KnowledgeType = (typeof KNOWLEDGE_TYPES)[number];

export interface Entry {
  key: string;
  type: KnowledgeType;
  content: string;
  source: string;
  tags: string[];
  ts: number;
  issue: string | null;
  files: string[];
}

export type Validated = { ok: true; entry: Entry } | { ok: false; error: string };

function asStringArray(v: unknown): string[] {
  if (v == null) return [];
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === "string");
}

export function validateEntry(obj: unknown): Validated {
  if (typeof obj !== "object" || obj === null) {
    return { ok: false, error: "entry is not an object" };
  }
  const o = obj as Record<string, unknown>;

  if (typeof o.key !== "string" || o.key.trim() === "") {
    return { ok: false, error: "missing or empty key" };
  }
  if (typeof o.type !== "string" || !KNOWLEDGE_TYPES.includes(o.type as KnowledgeType)) {
    return { ok: false, error: `invalid type: ${String(o.type)}` };
  }
  if (typeof o.content !== "string" || o.content.trim() === "") {
    return { ok: false, error: "missing or empty content" };
  }
  let ts: number;
  if (o.ts === undefined || o.ts === null) {
    ts = Math.floor(Date.now() / 1000);
  } else if (typeof o.ts === "number" && Number.isFinite(o.ts)) {
    ts = o.ts;
  } else {
    return { ok: false, error: "ts must be a number" };
  }

  const entry: Entry = {
    key: o.key,
    type: o.type as KnowledgeType,
    content: o.content,
    source: typeof o.source === "string" && o.source !== "" ? o.source : "agent",
    tags: asStringArray(o.tags),
    ts,
    issue: typeof o.issue === "string" && o.issue !== "" ? o.issue : null,
    files: asStringArray(o.files),
  };
  return { ok: true, entry };
}

export function parseLine(line: string): { ok: true; entry: Entry } | { ok: false; error: string } {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return { ok: false, error: "invalid JSON" };
  }
  return validateEntry(obj);
}

export function normalizeKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
