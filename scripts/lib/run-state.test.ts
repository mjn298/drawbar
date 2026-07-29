import { test, expect, describe } from "bun:test";
import type { ResolvedConfig } from "./ship-config";
import {
  parseRunState,
  dispatchVerdict,
  maybeDispatch,
  clearInFlight,
  isValidHeartbeatSeconds,
  HEARTBEAT_SECONDS_MIN,
  HEARTBEAT_SECONDS_MAX,
  type RunState,
} from "./run-state";

// Placeholder-id scheme (per the story's HARD CONSTRAINT): every story/issue id used below is
// LOWERCASE ("story-a", "story-b", "leaf-1"). The leak-regression rule in scripts/plugin.test.ts
// only matches an UPPERCASE team-prefix shape (`[A-Z]{2,6}-\d{2,}`), so a lowercase id can never
// trip it — verified directly against that regex before this file was written. Nothing about
// the schema defects this file pins (the `stories`-vs-`snapshot` key, and a story-id-shaped
// `invoked_as`) depends on the id being upper- or lower-case, or on it being a REAL id at all.

const VALID_RESOLVED_CONFIG: ResolvedConfig = {
  envDir: "/tmp/fixture-env-dir",
  projectDir: "/tmp/fixture-project-dir",
  repo: "acme/widgets",
  team: "PLAT",
  baseBranch: "main",
  requiredChecks: ["build"],
  observed: {
    projectDirRemote: "acme/widgets",
    envDirRemote: "acme/knowledge-base",
    defaultBranch: "main",
  },
};

// The pinned schema (Locked 12), fully populated — the shared happy-path fixture every
// rejection test below diverges from by exactly one field.
const VALID_RUN_STATE: RunState = {
  arg: "story-a",
  invoked_as: "parent",
  started_at: "2026-01-01T00:00:00Z",
  order_rationale: "no relations among snapshot members; list_issues order kept as-is",
  snapshot: ["story-a", "story-b"],
  stories_done: ["story-a"],
  in_flight: { story: "story-b", agent_dispatched_at: "2026-01-01T01:00:00Z" },
  stack: [{ story: "story-a", branch: "story-a-branch", pr: 1, base: "main", flagged: false }],
  subissues_filed: ["story-c"],
  resolved_config: VALID_RESOLVED_CONFIG,
};

describe("parseRunState — structural validation only (Locked 12)", () => {
  test("the pinned schema round-trips", () => {
    const result = parseRunState(JSON.stringify(VALID_RUN_STATE));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state).toEqual(VALID_RUN_STATE);
  });

  // The canonical story-list key is `snapshot` — a run-state carrying the OTHER observed
  // shape's key (`stories`) INSTEAD must be rejected loudly, not silently accepted with an
  // absent snapshot. Reproduced with a placeholder id; the defect is the key name, not any
  // particular value.
  //
  // Fix pass, IMPORTANT 4: the old assertion here (`reason.not.toBe("invalid_json")`) is true
  // for 12 of the 13 `ParseReason` values, so it cannot detect the regression it exists for —
  // if `snapshot` were dropped from `REQUIRED_KEYS` and the schema entirely, the stray
  // `stories` key would trip `unknown_key` and the old assertion would STILL pass, silently.
  // Pin the EXACT reason and that `detail` names the missing canonical key.
  test("a run-state using `stories` as the story-list key is rejected loudly (canonical key is `snapshot`)", () => {
    const { snapshot, ...rest } = VALID_RUN_STATE;
    const malformed = { ...rest, stories: snapshot };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("missing_key");
    expect(result.detail).toContain("snapshot");
  });

  // Fix pass, IMPORTANT 4: the case the old test's weak assertion couldn't reach — BOTH the
  // stray `stories` key and the canonical `snapshot` key present together. `snapshot` being
  // present means the missing-key check never fires; the defect here must trip `unknown_key`
  // on the stray `stories` key instead.
  test("a run-state carrying BOTH `stories` and the canonical `snapshot` key is rejected as an unknown key", () => {
    const malformed = { ...VALID_RUN_STATE, stories: VALID_RUN_STATE.snapshot };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown_key");
    expect(result.detail).toContain("stories");
  });

  // The other observed shape's defect: `invoked_as` carrying a STORY ID rather than the
  // `"parent"`/`"leaf"` enum. A placeholder id reproduces this fully — the defect is that the
  // value is a story id AT ALL, never which story it names.
  test("a run-state whose `invoked_as` carries a story id rather than \"parent\"/\"leaf\" is rejected loudly", () => {
    const malformed = { ...VALID_RUN_STATE, invoked_as: "story-a" };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_invoked_as");
  });

  test("unknown top-level keys are rejected, not silently dropped", () => {
    const malformed = { ...VALID_RUN_STATE, extra_field: "unexpected" };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("unknown_key");
    expect(result.detail).toContain("extra_field");
  });

  test("`stack` entries missing `branch` are rejected", () => {
    const malformed = {
      ...VALID_RUN_STATE,
      stack: [{ story: "story-a", pr: 1, base: "main", flagged: false }],
    };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_stack_entry");
  });

  // PCO-365 (R2): a state file written before the stacked-PR migration carries `merged`
  // instead of `stack` — this must be diagnosable as "recreate/migrate this file," not a
  // generic unknown-key complaint indistinguishable from an operator typo.
  test("a run-state carrying the legacy `merged` key (old shape, `stack` absent) is rejected with its own named reason", () => {
    const { stack, ...rest } = VALID_RUN_STATE;
    const malformed = { ...rest, merged: {} };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("legacy_merged_key");
    expect(result.detail).toContain("stacked-PR migration");
  });

  test("a run-state carrying BOTH the legacy `merged` key and the canonical `stack` key is still rejected as legacy_merged_key", () => {
    const malformed = { ...VALID_RUN_STATE, merged: {} };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("legacy_merged_key");
  });

  // Fix pass, CRITICAL 1: an unparseable `agent_dispatched_at` must be rejected with its OWN
  // named reason at parse time — never silently admitted as "just some string," which is
  // exactly what let `dispatchVerdict` fall into the unreachable-staleness-escape deadlock.
  test("in_flight.agent_dispatched_at that fails to parse as a date is rejected with its own reason (CRITICAL 1)", () => {
    const malformed = {
      ...VALID_RUN_STATE,
      in_flight: { story: "story-b", agent_dispatched_at: "not-a-date" },
    };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_in_flight_timestamp");
  });

  test("in_flight.agent_dispatched_at that parses to an invalid calendar date (month 13, etc) is rejected (CRITICAL 1)", () => {
    const malformed = {
      ...VALID_RUN_STATE,
      in_flight: { story: "story-b", agent_dispatched_at: "2026-13-45T99:99:99Z" },
    };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_in_flight_timestamp");
  });
});

// Fix pass, IMPORTANT 6 (MUST-CHECK endpoint-injection-not-just-command-injection): shape
// validation at the pure-function boundary — every one of these was previously ACCEPTED by
// `parseRunState`. `arg` is interpolated into the state-file path, `in_flight.story` is fed
// into a re-dispatch brief and Linear mutations, and `resolved_config.repo`/`envDir`/
// `projectDir` are persisted so a later step can re-derive `$REPO` for `gh` path templates
// and `cd`.
describe("parseRunState — shape validation at the pure-function boundary (IMPORTANT 6)", () => {
  test("resolved_config.repo carrying a path-traversal shape is rejected", () => {
    const malformed = {
      ...VALID_RUN_STATE,
      resolved_config: { ...VALID_RESOLVED_CONFIG, repo: "../../evil" },
    };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_resolved_config");
  });

  test("resolved_config.repo carrying a shell-injection shape is rejected", () => {
    const malformed = {
      ...VALID_RUN_STATE,
      resolved_config: { ...VALID_RESOLVED_CONFIG, repo: "; rm -rf /" },
    };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_resolved_config");
  });

  test("resolved_config.repo whose segment IS `..` (two segments, still traversal-shaped) is rejected", () => {
    const malformed = {
      ...VALID_RUN_STATE,
      resolved_config: { ...VALID_RESOLVED_CONFIG, repo: "a/.." },
    };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_resolved_config");
  });

  test("resolved_config.envDir carrying a '..' segment is rejected", () => {
    const malformed = {
      ...VALID_RUN_STATE,
      resolved_config: { ...VALID_RESOLVED_CONFIG, envDir: "/tmp/../../.." },
    };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_resolved_config");
  });

  test("resolved_config.projectDir that is relative (not absolute) is rejected", () => {
    const malformed = {
      ...VALID_RUN_STATE,
      resolved_config: { ...VALID_RESOLVED_CONFIG, projectDir: "relative/dir" },
    };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_resolved_config");
  });

  // IMPORTANT 3 (fix pass): `resolved_config.baseBranch` lives in the agent-writable
  // run-state JSON — `isValidRefName` (ship-config.ts) must gate this mutable copy the same
  // way `validateShipConfig` gates the operator-authored config at T0, not just the latter.
  test("resolved_config.baseBranch carrying a git argv-injection shape (`--upload-pack=...`) is rejected", () => {
    const malformed = {
      ...VALID_RUN_STATE,
      resolved_config: { ...VALID_RESOLVED_CONFIG, baseBranch: "--upload-pack=x" },
    };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_resolved_config");
  });

  test("resolved_config.baseBranch carrying a valid ref shape is still accepted", () => {
    const wellFormed = {
      ...VALID_RUN_STATE,
      resolved_config: { ...VALID_RESOLVED_CONFIG, baseBranch: "release/2026-07" },
    };
    const result = parseRunState(JSON.stringify(wellFormed));
    expect(result.ok).toBe(true);
  });

  test("arg carrying a path-traversal shape is rejected with its own named reason", () => {
    const malformed = { ...VALID_RUN_STATE, arg: "../../../../etc/passwd" };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_arg");
  });

  test("arg carrying a '/' (not a single path segment) is rejected", () => {
    const malformed = { ...VALID_RUN_STATE, arg: "team/story-a" };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_arg");
  });

  test("arg that is a single space (empty after trim) is rejected", () => {
    const malformed = { ...VALID_RUN_STATE, arg: " " };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_arg");
  });

  test("stack[x].branch with a git argv-injection shape is rejected", () => {
    const malformed = {
      ...VALID_RUN_STATE,
      stack: [{ story: "story-a", branch: "--upload-pack=x", pr: 1, base: "main", flagged: false }],
    };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_stack_entry");
  });

  test("stack[x].base with a git argv-injection shape is rejected", () => {
    const malformed = {
      ...VALID_RUN_STATE,
      stack: [{ story: "story-a", branch: "story-a-branch", pr: 1, base: "--upload-pack=x", flagged: false }],
    };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_stack_entry");
  });

  test("stack[x].pr = -1 is rejected", () => {
    const malformed = {
      ...VALID_RUN_STATE,
      stack: [{ story: "story-a", branch: "story-a-branch", pr: -1, base: "main", flagged: false }],
    };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_stack_entry");
  });

  test("stack[x].pr = 1.5 (non-integer) is rejected", () => {
    const malformed = {
      ...VALID_RUN_STATE,
      stack: [{ story: "story-a", branch: "story-a-branch", pr: 1.5, base: "main", flagged: false }],
    };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_stack_entry");
  });

  test("stack[x].pr = 0 is rejected", () => {
    const malformed = {
      ...VALID_RUN_STATE,
      stack: [{ story: "story-a", branch: "story-a-branch", pr: 0, base: "main", flagged: false }],
    };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_stack_entry");
  });

  test("stack[x].flagged that is not a strict boolean is rejected", () => {
    const malformed = {
      ...VALID_RUN_STATE,
      stack: [{ story: "story-a", branch: "story-a-branch", pr: 1, base: "main", flagged: "true" }],
    };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_stack_entry");
  });

  test("stack that is an object keyed by story id (the old `merged` shape) rather than an array is rejected", () => {
    const malformed = {
      ...VALID_RUN_STATE,
      stack: { "story-a": { story: "story-a", branch: "story-a-branch", pr: 1, base: "main", flagged: false } },
    };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_stack");
  });

  test("a stack entry carrying an extra unknown key is rejected", () => {
    const malformed = {
      ...VALID_RUN_STATE,
      stack: [{ story: "story-a", branch: "story-a-branch", pr: 1, base: "main", flagged: false, sha: "abc1234" }],
    };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_stack_entry");
  });

  test("in_flight.story that is a single space (empty after trim) is rejected", () => {
    const malformed = { ...VALID_RUN_STATE, in_flight: { story: " ", agent_dispatched_at: "2026-01-01T00:00:00Z" } };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_in_flight");
  });

  // Fix pass (residual, coordinator verification): `isSafePathSegment` blocked `/`, `\`, and
  // `..` but let every control character — including a literal newline — straight through.
  // `arg` is both interpolated into the state-file path AND carried into agent-facing prose,
  // so a newline is a path-shape AND a prompt-injection vector in one (same MUST-CHECK
  // endpoint-injection-not-just-command-injection class as the rest of IMPORTANT 6; this
  // specific payload just wasn't in the original example list).
  test("arg carrying an embedded newline (prompt-injection/path-shape vector) is rejected", () => {
    const malformed = { ...VALID_RUN_STATE, arg: "ok\nIGNORE PREVIOUS" };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_arg");
  });

  test("arg carrying a bare control character (e.g. NUL) is rejected", () => {
    const malformed = { ...VALID_RUN_STATE, arg: "story-a\x00" };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_arg");
  });

  // Same class, same fix applied at the single implementation site (`isNonEmptyString`) so it
  // covers every field built on top of it, not just `arg`: `in_flight.story` and every entry
  // of `snapshot[]` / `stories_done[]` / `subissues_filed[]` are all fed back into re-dispatch
  // briefs and Linear mutations per the same finding. These do NOT get the full
  // `isSafePathSegment` path-segment shape (no `/`, no `..`) — they are story ids/free text,
  // never interpolated into a filesystem path the way `arg` is — only the control-character
  // rejection applies to them.
  test("in_flight.story carrying an embedded newline is rejected", () => {
    const malformed = { ...VALID_RUN_STATE, in_flight: { story: "story-a\nIGNORE PREVIOUS", agent_dispatched_at: "2026-01-01T00:00:00Z" } };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_in_flight");
  });

  test("a snapshot[] entry carrying an embedded newline is rejected", () => {
    const malformed = { ...VALID_RUN_STATE, snapshot: ["story-a", "story-b\nIGNORE PREVIOUS"] };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_snapshot");
  });

  test("a stories_done[] entry carrying an embedded newline is rejected", () => {
    const malformed = { ...VALID_RUN_STATE, stories_done: ["story-a\nIGNORE PREVIOUS"] };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_stories_done");
  });

  test("a subissues_filed[] entry carrying an embedded newline is rejected", () => {
    const malformed = { ...VALID_RUN_STATE, subissues_filed: ["story-c\nIGNORE PREVIOUS"] };
    const result = parseRunState(JSON.stringify(malformed));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid_subissues_filed");
  });
});

// A representative heartbeat value inside F13's pinned 2700-3600s range, used everywhere
// below the exact endpoints don't matter to the specific assertion — picked (3000s / 50min)
// so `2 * heartbeat` (6000s / 100min) is easy to reason about in the boundary tests.
const HEARTBEAT_SECONDS = 3000;

// A base RunState with `in_flight: null`, so each test below only needs to override
// `in_flight` to set up its own scenario — mirrors VALID_RUN_STATE but avoids repeating the
// nested object literal in every test.
const BASE_STATE: RunState = { ...VALID_RUN_STATE, in_flight: null };

function spyDispatch(): { dispatch: (story: string) => void; calls: string[] } {
  const calls: string[] = [];
  return { dispatch: (story: string) => calls.push(story), calls };
}

// Fix pass, IMPORTANT 3: `maybeDispatch` now takes an injected `persist` writer — a
// no-op-recording spy for every call site that isn't specifically exercising the
// claim-before-dispatch ordering.
function spyPersist(): { persist: (state: RunState) => void; calls: RunState[] } {
  const calls: RunState[] = [];
  return { persist: (state: RunState) => calls.push(state), calls };
}

describe("in_flight — the authoritative duplicate-dispatch guard, with a staleness escape (Locked 13)", () => {
  test("null in_flight → dispatch proceeds", () => {
    // Pre-state: genuinely null, not merely absent from a broken fixture.
    expect(BASE_STATE.in_flight).toBeNull();
    const { dispatch, calls } = spyDispatch();
    const { persist } = spyPersist();
    const result = maybeDispatch({ state: BASE_STATE, story: "story-a", now: 0, heartbeatSeconds: HEARTBEAT_SECONDS, dispatch, persist });
    expect(result.verdict.action).toBe("dispatch");
    expect(calls).toEqual(["story-a"]);
  });

  test("a FRESH in_flight + second invocation → no-op, with the dispatch path genuinely never entered", () => {
    const dispatchedAt = "2026-01-01T00:00:00.000Z";
    const state: RunState = { ...BASE_STATE, in_flight: { story: "story-b", agent_dispatched_at: dispatchedAt } };
    // Pre-state: the fixture genuinely carries the in_flight record before the no-op is
    // asserted (MUST-CHECK vacuous-assertion-needs-preseed-state).
    expect(state.in_flight).toEqual({ story: "story-b", agent_dispatched_at: dispatchedAt });

    const now = Date.parse(dispatchedAt) + 60 * 1000; // one minute later — well within a fresh window
    const { dispatch, calls } = spyDispatch();
    const { persist } = spyPersist();
    const result = maybeDispatch({ state, story: "story-c", now, heartbeatSeconds: HEARTBEAT_SECONDS, dispatch, persist });

    expect(result.verdict).toEqual({ action: "no_op", reason: "in_flight_fresh" });
    // The call-counter spy is the actual proof the dispatch path was never entered — not
    // merely that maybeDispatch returned something falsy.
    expect(calls).toEqual([]);
    expect(result.nextState).toEqual(state); // unchanged
  });

  test("a STALE in_flight (now - agent_dispatched_at > 2x heartbeat) routes to crash recovery, not no-op", () => {
    const dispatchedAt = "2026-01-01T00:00:00.000Z";
    const state: RunState = { ...BASE_STATE, in_flight: { story: "story-b", agent_dispatched_at: dispatchedAt } };
    expect(state.in_flight).not.toBeNull(); // pre-state

    // Explicit seeded timestamp, one second past the 2x-heartbeat threshold — never wall-clock
    // (MUST-CHECK archive-days-zero-same-second-entries's seeding discipline, applied here).
    const now = Date.parse(dispatchedAt) + 2 * HEARTBEAT_SECONDS * 1000 + 1000;
    const { dispatch, calls } = spyDispatch();
    const { persist } = spyPersist();
    const result = maybeDispatch({ state, story: "story-c", now, heartbeatSeconds: HEARTBEAT_SECONDS, dispatch, persist });

    expect(result.verdict).toEqual({ action: "crash_recovery", reason: "in_flight_stale" });
    expect(calls).toEqual([]); // crash recovery is not a dispatch either
  });

  // Boundary, pinned explicitly on BOTH sides: Locked 13 says "exceeds 2x the heartbeat",
  // i.e. strict `>`. Exactly 2x is a DELIBERATE choice to still be fresh, not stale — see the
  // comment on `dispatchVerdict` in run-state.ts for the reasoning. Both timestamps are
  // seeded explicitly, never derived from wall-clock time.
  test("boundary: exactly 2x heartbeat is NOT stale (deliberate, strict `>` per Locked 13's wording)", () => {
    const dispatchedAt = "2026-01-01T00:00:00.000Z";
    const now = Date.parse(dispatchedAt) + 2 * HEARTBEAT_SECONDS * 1000; // exactly 2x, to the millisecond
    const verdict = dispatchVerdict({ in_flight: { story: "story-b", agent_dispatched_at: dispatchedAt } }, now, HEARTBEAT_SECONDS);
    expect(verdict).toEqual({ action: "no_op", reason: "in_flight_fresh" });
  });

  test("boundary: one second past 2x heartbeat IS stale", () => {
    const dispatchedAt = "2026-01-01T00:00:00.000Z";
    const now = Date.parse(dispatchedAt) + 2 * HEARTBEAT_SECONDS * 1000 + 1000;
    const verdict = dispatchVerdict({ in_flight: { story: "story-b", agent_dispatched_at: dispatchedAt } }, now, HEARTBEAT_SECONDS);
    expect(verdict).toEqual({ action: "crash_recovery", reason: "in_flight_stale" });
  });

  // Fix pass, CRITICAL 1: `dispatchVerdict` must re-check the timestamp independently of
  // `parseRunState` — callers (including these tests) can construct a `RunState` directly,
  // skipping the parser entirely. An unparseable stamp must route to crash recovery, never
  // fall through to the deadlocking `no_op / in_flight_fresh` default.
  test("dispatchVerdict independently rejects an unparseable agent_dispatched_at, routing to crash recovery (CRITICAL 1)", () => {
    const now = Date.parse("2036-01-01T00:00:00Z"); // ten years past any plausible dispatch
    const verdict = dispatchVerdict({ in_flight: { story: "story-b", agent_dispatched_at: "not-a-date" } }, now, HEARTBEAT_SECONDS);
    expect(verdict).toEqual({ action: "crash_recovery", reason: "in_flight_unreadable" });
  });

  test("dispatchVerdict rejects an unparseable calendar date (month 13) even ten years later (CRITICAL 1)", () => {
    const now = Date.parse("2036-01-01T00:00:00Z");
    const verdict = dispatchVerdict(
      { in_flight: { story: "story-b", agent_dispatched_at: "2026-13-45T99:99:99Z" } },
      now,
      HEARTBEAT_SECONDS,
    );
    expect(verdict).toEqual({ action: "crash_recovery", reason: "in_flight_unreadable" });
  });

  test("dispatchVerdict treats a future-dated agent_dispatched_at as unreadable, not permanently fresh (CRITICAL 1)", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    const verdict = dispatchVerdict(
      { in_flight: { story: "story-b", agent_dispatched_at: "2099-01-01T00:00:00Z" } },
      now,
      HEARTBEAT_SECONDS,
    );
    expect(verdict).toEqual({ action: "crash_recovery", reason: "in_flight_unreadable" });
  });

  // Fix pass, CRITICAL 2: `heartbeatSeconds` reaching the comparison unvalidated fails OPEN
  // (0/-5 falsely declare a fresh dispatch stale, triggering a duplicate agent) or deadlocks
  // (NaN never exceeds the threshold). Both must instead be a distinct, visible refusal —
  // never a silent `no_op` and never `crash_recovery` picked by accident.
  test("dispatchVerdict refuses heartbeatSeconds=0 rather than fail-open into crash_recovery (CRITICAL 2)", () => {
    const dispatchedAt = "2026-01-01T00:00:00.000Z";
    const now = Date.parse(dispatchedAt) + 60 * 1000; // one minute later — a genuinely live dispatch
    const verdict = dispatchVerdict({ in_flight: { story: "story-b", agent_dispatched_at: dispatchedAt } }, now, 0);
    expect(verdict).toEqual({ action: "refused", reason: "invalid_heartbeat_seconds" });
  });

  test("dispatchVerdict refuses a negative heartbeatSeconds (CRITICAL 2)", () => {
    const dispatchedAt = "2026-01-01T00:00:00.000Z";
    const now = Date.parse(dispatchedAt) + 60 * 1000;
    const verdict = dispatchVerdict({ in_flight: { story: "story-b", agent_dispatched_at: dispatchedAt } }, now, -5);
    expect(verdict).toEqual({ action: "refused", reason: "invalid_heartbeat_seconds" });
  });

  test("dispatchVerdict refuses a NaN heartbeatSeconds rather than deadlocking on no_op (CRITICAL 2)", () => {
    const dispatchedAt = "2026-01-01T00:00:00.000Z";
    const now = Date.parse(dispatchedAt) + 60 * 1000;
    const verdict = dispatchVerdict({ in_flight: { story: "story-b", agent_dispatched_at: dispatchedAt } }, now, NaN);
    expect(verdict).toEqual({ action: "refused", reason: "invalid_heartbeat_seconds" });
  });

  test("dispatchVerdict refuses an out-of-range heartbeatSeconds even when in_flight is null (F13's 2700-3600s range)", () => {
    const verdict = dispatchVerdict({ in_flight: null }, 0, 100);
    expect(verdict).toEqual({ action: "refused", reason: "invalid_heartbeat_seconds" });
  });

  // Minor fix: `undefined` (a genuinely absent key, as opposed to an explicit `null`) must be
  // treated the same as `null` rather than throwing a TypeError — the runbook says Preflight
  // "must route here rather than dying."
  test("dispatchVerdict treats an absent (undefined) in_flight the same as null, not a throw (Minor)", () => {
    const verdict = dispatchVerdict({} as { in_flight: null }, 0, HEARTBEAT_SECONDS);
    expect(verdict).toEqual({ action: "dispatch" });
  });

  test("dispatch re-arms in_flight with the injected `now` (F13)", () => {
    const now = Date.parse("2026-01-02T00:00:00.000Z");
    const { dispatch } = spyDispatch();
    const { persist } = spyPersist();
    const result = maybeDispatch({ state: BASE_STATE, story: "story-a", now, heartbeatSeconds: HEARTBEAT_SECONDS, dispatch, persist });
    expect(result.nextState.in_flight).toEqual({ story: "story-a", agent_dispatched_at: new Date(now).toISOString() });
  });

  // Fix pass, IMPORTANT 3: a duplicate-dispatch guard must make its claim DURABLE before
  // acting. Both orderings pinned on one shared call-log array, per the fix-pass instruction.
  test("maybeDispatch claims (persists) BEFORE dispatching — persist happens before dispatch, not after (IMPORTANT 3)", () => {
    const log: string[] = [];
    const persist = (_state: RunState) => log.push("persist");
    const dispatch = (_story: string) => log.push("dispatch");
    const now = Date.parse("2026-01-02T00:00:00.000Z");
    maybeDispatch({ state: BASE_STATE, story: "story-a", now, heartbeatSeconds: HEARTBEAT_SECONDS, dispatch, persist });
    expect(log).toEqual(["persist", "dispatch"]);
  });

  test("when dispatch throws, persist has ALREADY been called — the claim is durable even on a failed dispatch (IMPORTANT 3)", () => {
    const log: string[] = [];
    const persist = (_state: RunState) => log.push("persist");
    const dispatch = (_story: string) => {
      log.push("dispatch");
      throw new Error("dispatch boom");
    };
    const now = Date.parse("2026-01-02T00:00:00.000Z");
    expect(() =>
      maybeDispatch({ state: BASE_STATE, story: "story-a", now, heartbeatSeconds: HEARTBEAT_SECONDS, dispatch, persist }),
    ).toThrow("dispatch boom");
    expect(log).toEqual(["persist", "dispatch"]);
  });

  // Fix pass, IMPORTANT 3: an invalid `now` (e.g. NaN) must be a NAMED REFUSAL, never a throw
  // — and must never fire the dispatch side effect first. Confirmed failure mode pre-fix: the
  // dispatch already fired (calls = ["story-a"]) before `new Date(NaN).toISOString()` threw a
  // RangeError, so `in_flight` was never persisted and the next invocation would dispatch a
  // duplicate.
  test("an invalid (NaN) `now` is refused outright — never throws, and dispatch/persist are never called (IMPORTANT 3)", () => {
    const { dispatch, calls } = spyDispatch();
    const { persist, calls: persistCalls } = spyPersist();
    const result = maybeDispatch({ state: BASE_STATE, story: "story-a", now: NaN, heartbeatSeconds: HEARTBEAT_SECONDS, dispatch, persist });
    expect(result.verdict).toEqual({ action: "refused", reason: "invalid_now" });
    expect(calls).toEqual([]);
    expect(persistCalls).toEqual([]);
    expect(result.nextState).toEqual(BASE_STATE);
  });

  // Fix pass, IMPORTANT 5: this used to be THREE tests with byte-identical bodies (same seed,
  // same call to `clearInFlight`, whose whole body is `{...state, in_flight: null}`) wearing
  // three different names — they cannot fail independently, so they were one test wearing
  // three hats. `clearInFlight` itself only needs ONE unit test; the risk the AC actually
  // cares about — a runbook narrative site silently losing its clear — is now covered
  // separately by the doc assertions in scripts/plugin.test.ts (see "IMPORTANT 5" there),
  // which grep commands/drawbar-ship.md's park/halt sections directly, per the
  // established pattern at plugin.test.ts's mutation-gate-verbatim doc tests.
  test("clearInFlight clears a genuinely non-null in_flight (Locked 13)", () => {
    const state: RunState = { ...BASE_STATE, in_flight: { story: "story-a", agent_dispatched_at: "2026-01-01T00:00:00Z" } };
    expect(state.in_flight).not.toBeNull(); // pre-state (MUST-CHECK vacuous-assertion-needs-preseed-state)
    const next = clearInFlight(state);
    expect(next.in_flight).toBeNull();
  });
});

// Fix pass, Coverage: 9 of the 13 original `ParseReason` values (plus the 2 this fix pass
// added) had NO test at all — a regression in any of them could ship silently. One
// table-driven test per reason, each producing a malformed run-state via exactly one
// documented divergence from VALID_RUN_STATE, and asserting the EXACT reason it must produce.
describe("parseRunState — every ParseReason is exercised at least once (Coverage)", () => {
  const cases: { name: string; text: () => string; reason: string }[] = [
    { name: "invalid_json: not valid JSON at all", text: () => "{not valid json", reason: "invalid_json" },
    { name: "not_object: root is a JSON array", text: () => JSON.stringify([1, 2, 3]), reason: "not_object" },
    { name: "not_object: root is a bare number", text: () => JSON.stringify(42), reason: "not_object" },
    {
      name: "missing_key: a required top-level key is absent",
      text: () => {
        const { started_at, ...rest } = VALID_RUN_STATE;
        return JSON.stringify(rest);
      },
      reason: "missing_key",
    },
    {
      name: "unknown_key: an extra top-level key is present",
      text: () => JSON.stringify({ ...VALID_RUN_STATE, extra_field: "unexpected" }),
      reason: "unknown_key",
    },
    {
      name: "wrong_type: started_at is not a string",
      text: () => JSON.stringify({ ...VALID_RUN_STATE, started_at: 123 }),
      reason: "wrong_type",
    },
    {
      name: "invalid_invoked_as: invoked_as is neither \"parent\" nor \"leaf\"",
      text: () => JSON.stringify({ ...VALID_RUN_STATE, invoked_as: "story-a" }),
      reason: "invalid_invoked_as",
    },
    {
      name: "invalid_snapshot: snapshot is not a string array",
      text: () => JSON.stringify({ ...VALID_RUN_STATE, snapshot: "not-an-array" }),
      reason: "invalid_snapshot",
    },
    {
      name: "invalid_stories_done: stories_done contains a non-string entry",
      text: () => JSON.stringify({ ...VALID_RUN_STATE, stories_done: [123] }),
      reason: "invalid_stories_done",
    },
    {
      name: "invalid_in_flight: in_flight is missing a required key",
      text: () => JSON.stringify({ ...VALID_RUN_STATE, in_flight: { story: "story-b" } }),
      reason: "invalid_in_flight",
    },
    {
      name: "invalid_stack: stack is not an array",
      text: () => JSON.stringify({ ...VALID_RUN_STATE, stack: "not-an-array" }),
      reason: "invalid_stack",
    },
    {
      name: "invalid_stack_entry: a stack entry is missing branch",
      text: () => JSON.stringify({ ...VALID_RUN_STATE, stack: [{ story: "story-a", pr: 1, base: "main", flagged: false }] }),
      reason: "invalid_stack_entry",
    },
    {
      name: "legacy_merged_key: the run-state carries the pre-migration `merged` key",
      text: () => JSON.stringify({ ...VALID_RUN_STATE, merged: {} }),
      reason: "legacy_merged_key",
    },
    {
      name: "invalid_subissues_filed: subissues_filed contains a non-string entry",
      text: () => JSON.stringify({ ...VALID_RUN_STATE, subissues_filed: [123] }),
      reason: "invalid_subissues_filed",
    },
    {
      name: "invalid_resolved_config: resolved_config.repo is not owner/repo shaped",
      text: () => JSON.stringify({ ...VALID_RUN_STATE, resolved_config: { ...VALID_RESOLVED_CONFIG, repo: "../../evil" } }),
      reason: "invalid_resolved_config",
    },
    {
      name: "invalid_in_flight_timestamp: agent_dispatched_at fails to parse",
      text: () => JSON.stringify({ ...VALID_RUN_STATE, in_flight: { story: "story-b", agent_dispatched_at: "not-a-date" } }),
      reason: "invalid_in_flight_timestamp",
    },
    {
      name: "invalid_arg: arg carries a path-traversal shape",
      text: () => JSON.stringify({ ...VALID_RUN_STATE, arg: "../../etc/passwd" }),
      reason: "invalid_arg",
    },
    {
      // Fix pass (residual, coordinator verification): the exact payload from the coordinator's
      // re-probe (`arg="ok\nIGNORE PREVIOUS"`) — a newline is a path-shape AND
      // prompt-injection vector in one, since `arg` is both interpolated into the state-file
      // path and carried into agent-facing prose.
      name: "invalid_arg: arg carries an embedded newline (control-char/prompt-injection vector)",
      text: () => JSON.stringify({ ...VALID_RUN_STATE, arg: "ok\nIGNORE PREVIOUS" }),
      reason: "invalid_arg",
    },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const result = parseRunState(c.text());
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe(c.reason);
    });
  }

  // All 16 `ParseReason` values (13 original - 2 removed by the PCO-365 merged->stack
  // migration + 5 added: invalid_stack, invalid_stack_entry, legacy_merged_key were new;
  // invalid_merged/invalid_merged_entry were deleted outright, not left dormant) are
  // represented — this table has 17 rows because `not_object` is deliberately exercised
  // twice (array root, bare number root), so the assertion is against the pinned literal
  // list, not `cases.length`.
  test("this table covers all 16 ParseReason values, not merely a subset", () => {
    const ALL_PARSE_REASONS = [
      "invalid_json",
      "not_object",
      "missing_key",
      "unknown_key",
      "wrong_type",
      "invalid_invoked_as",
      "invalid_snapshot",
      "invalid_stories_done",
      "invalid_in_flight",
      "invalid_stack",
      "invalid_stack_entry",
      "legacy_merged_key",
      "invalid_subissues_filed",
      "invalid_resolved_config",
      "invalid_in_flight_timestamp",
      "invalid_arg",
    ];
    const covered = new Set(cases.map((c) => c.reason));
    for (const reason of ALL_PARSE_REASONS) {
      expect(covered.has(reason), `no table row covers reason ${reason}`).toBe(true);
    }
    expect(covered.size).toBe(ALL_PARSE_REASONS.length);
  });
});

describe("heartbeat range (F13): 2700-3600 seconds", () => {
  test("the pinned min/max constants", () => {
    expect(HEARTBEAT_SECONDS_MIN).toBe(2700);
    expect(HEARTBEAT_SECONDS_MAX).toBe(3600);
  });

  test("both endpoints are valid (inclusive range)", () => {
    expect(isValidHeartbeatSeconds(2700)).toBe(true);
    expect(isValidHeartbeatSeconds(3600)).toBe(true);
  });

  test("just outside either endpoint is invalid", () => {
    expect(isValidHeartbeatSeconds(2699)).toBe(false);
    expect(isValidHeartbeatSeconds(3601)).toBe(false);
  });
});
