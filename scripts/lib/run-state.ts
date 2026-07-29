// One implementation of the `.drawbar/runs/<ARG>.json` schema for the whole repo. Two
// legacy run-state files (from before this schema was pinned) disagreed with each other in
// two structurally incompatible ways — one used `stories` for the story-list key where the
// canonical key is `snapshot`, and the other carried a story-id-shaped string in `invoked_as`
// where the field is a two-value enum (`"parent"` | `"leaf"`). Neither shape is silently
// tolerated here: `parseRunState` is STRUCTURAL validation only (never touches the
// filesystem — the caller owns reading/writing the state file) and rejects every unknown
// shape loudly, with a named `reason` plus a human-readable `detail`, exactly like
// `parseShipConfig` in scripts/lib/ship-config.ts.
//
// This module owns two distinct jobs, kept as two separate concerns per the house style in
// scripts/lib/ship-config.ts:
//
//   - `parseRunState` — structural validation of the pinned schema (Locked 12).
//   - `dispatchVerdict` / `maybeDispatch` / `clearInFlight` — the pure verdict functions
//     implementing `in_flight` as the authoritative duplicate-dispatch guard, with a
//     staleness escape that routes to crash recovery instead of a no-op (Locked 13). `now`
//     is always injected (epoch milliseconds), never read from the clock in the verdict
//     path — the same discipline `ship-config.ts` applies to `git`/`gh` runners. Nothing in
//     this module shells out to `git` or `gh` at all, so the "tests pass with `gh`/`git`
//     absent from PATH" proof (Locked 5) holds trivially.
//
// `resolved_config` reuses `ResolvedConfig` from scripts/lib/ship-config.ts's TYPE verbatim —
// the shape that module's `validateShipConfig` produces — rather than inventing or
// hand-copying a second shape for the same six configured keys plus `observed`. Structural
// validation of `resolved_config` is layered: `parseShipConfig` checks the six configured
// keys' types/non-emptiness only (it does NOT check `repo`'s owner/repo shape or that
// `envDir`/`projectDir` are clean absolute paths — that is `validateShipConfig`'s job, which
// this module never runs, since it never shells out to `git`/`gh`). `isValidResolvedConfig`
// below layers `isValidRepo`, `isCleanAbsolutePath`, and `isValidRefName` (all
// scripts/lib/ship-config.ts) on top, closing the endpoint-injection gap those sinks would
// otherwise leave open (MUST-CHECK endpoint-injection-not-just-command-injection) — reused,
// not reimplemented, from their one canonical site each.

import {
  parseShipConfig,
  isCleanAbsolutePath,
  isNonEmptyTrimmed,
  isValidRepo,
  isValidRefName,
  type ResolvedConfig,
} from "./ship-config";

export interface InFlight {
  story: string;
  agent_dispatched_at: string;
}

export interface MergedEntry {
  pr: number;
  merge_sha: string;
  status: string;
}

// The pinned schema (Locked 12), written literally.
export interface RunState {
  arg: string;
  invoked_as: "parent" | "leaf";
  started_at: string;
  order_rationale: string;
  snapshot: string[];
  stories_done: string[];
  in_flight: InFlight | null;
  merged: Record<string, MergedEntry>;
  subissues_filed: string[];
  resolved_config: ResolvedConfig;
}

// Exactly these ten keys — no more, no fewer. Declared once so the missing/unknown-key
// checks below cannot drift from the type declaration above.
const REQUIRED_KEYS = [
  "arg",
  "invoked_as",
  "started_at",
  "order_rationale",
  "snapshot",
  "stories_done",
  "in_flight",
  "merged",
  "subissues_filed",
  "resolved_config",
] as const;

const IN_FLIGHT_KEYS = ["story", "agent_dispatched_at"] as const;
const MERGED_ENTRY_KEYS = ["pr", "merge_sha", "status"] as const;
// The three OBSERVED facts `resolvedConfig()` (ship-config.ts) attaches alongside the six
// configured keys — validated here structurally, without inventing a parallel `ResolvedConfig`
// parser: the six configured keys are validated by reusing `parseShipConfig` itself below.
const OBSERVED_KEYS = ["projectDirRemote", "envDirRemote", "defaultBranch"] as const;

export type ParseReason =
  | "invalid_json"
  | "not_object"
  | "missing_key"
  | "unknown_key"
  | "wrong_type"
  | "invalid_invoked_as"
  | "invalid_snapshot"
  | "invalid_stories_done"
  | "invalid_in_flight"
  | "invalid_merged"
  | "invalid_merged_entry"
  | "invalid_subissues_filed"
  | "invalid_resolved_config"
  | "invalid_in_flight_timestamp"
  | "invalid_arg";

export type ParseResult = { ok: true; state: RunState } | { ok: false; reason: ParseReason; detail: string };

// Fix pass (IMPORTANT 6): a whitespace-only string (e.g. a single space) is effectively
// empty and must not be admitted as a valid `arg`, `story`, `merge_sha`, or `observed` field
// — trim before checking length, everywhere this predicate is used.
//
// Fix pass (residual, coordinator verification): C0 control characters and DEL (`\x00`-`\x1f`,
// `\x7f` — including a literal newline/`\n`) were previously admitted by every field built on
// this predicate. `arg` is interpolated into the state-file path AND carried into agent-facing
// prose; `in_flight.story` and every entry of `snapshot[]` / `stories_done[]` /
// `subissues_filed[]` are fed back into re-dispatch briefs and Linear mutations — a newline in
// any of them is a path-shape and/or prompt-injection vector (MUST-CHECK
// endpoint-injection-not-just-command-injection).
//
// S6/PCO-351 fix pass (single-implementation-site): this module used to carry its own
// byte-identical copy of this exact regex/predicate — it now imports `isNonEmptyTrimmed`
// from ship-config.ts, the one canonical implementation site, rather than re-adding the same
// regex at each call site. Aliased on import: every call site in this file already reads
// `isNonEmptyString`, and renaming ~15 call sites for a pure re-export would be churn with no
// behavioral change.
const isNonEmptyString = isNonEmptyTrimmed;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((s) => isNonEmptyString(s));
}

// Fix pass (IMPORTANT 6, MUST-CHECK endpoint-injection-not-just-command-injection): `arg` is
// interpolated into the state-file path `$ENV_DIR/.drawbar/runs/<ARG>.json` — it must be a
// single safe path segment, never a path itself. No `/`, no `\`, and no `..` (which would
// still be traversal-shaped even embedded inside an otherwise-plain segment, e.g. `a..b` on
// some filesystems' handling — refused outright rather than reasoned about further). Control
// characters (including newline) are already refused by `isNonEmptyString` above — `arg`
// additionally gets the path-segment shape check here because, unlike `story`/`snapshot[]`/
// `stories_done[]`/`subissues_filed[]`, it is specifically interpolated into a filesystem path.
function isSafePathSegment(v: unknown): v is string {
  if (!isNonEmptyString(v)) return false;
  return !v.includes("/") && !v.includes("\\") && !v.includes("..");
}

const MERGE_SHA_SHAPE = /^[0-9a-f]{7,40}$/;

function fail(reason: ParseReason, detail: string): { ok: false; reason: ParseReason; detail: string } {
  return { ok: false, reason, detail };
}

// Validates a `merged` entry against exactly `{pr, merge_sha, status}` — no more, no fewer.
//
// `merge_sha` (fix pass, IMPORTANT 6): checked against a hex-shape regex
// (`/^[0-9a-f]{7,40}$/`) — NOT pinned to exactly 40 characters. The two observed fixtures
// disagreed on abbreviated-sha length (9 vs 8 chars), so pinning a specific length would
// refuse one legitimate shape or the other for no structural reason; a hex-shape check still
// closes the endpoint-injection gap (`merge_sha` used to admit `"../../HEAD"` outright).
//
// S6/PCO-351 resolution (Locked 10): this PARSE-time shape stays permissive on purpose, so
// `parseRunState` can still read the two legacy run-state files (abbreviated 8/9-char shas)
// without refusing them outright. The strict, record-TIME assertion — exactly 40 hex
// characters, and the full merge-commit oid rather than the PR head sha — belongs to whatever
// call site ever WRITES a fresh `merge_sha`. A future pass MAY choose to tighten this parser
// too once every legacy file has been migrated; until then, tightening it here would make
// `parseRunState` refuse state files it must still be able to read.
//
// `pr` (fix pass, IMPORTANT 6): must be a positive integer — `0`, negative values, and
// non-integers (`1.5`) were all previously admitted.
function isValidMergedEntry(v: unknown): v is MergedEntry {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  for (const key of MERGED_ENTRY_KEYS) {
    if (!(key in obj)) return false;
  }
  const known: readonly string[] = MERGED_ENTRY_KEYS;
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) return false;
  }
  if (typeof obj.pr !== "number" || !Number.isInteger(obj.pr) || obj.pr <= 0) return false;
  if (typeof obj.merge_sha !== "string" || !MERGE_SHA_SHAPE.test(obj.merge_sha)) return false;
  if (!isNonEmptyString(obj.status)) return false;
  return true;
}

// Reuses `parseShipConfig` for the six configured keys' types/non-emptiness (never a
// hand-copied second implementation of that shape check — see the module comment above),
// then validates the `observed` object added on top of it structurally.
//
// Fix pass (IMPORTANT 6): `parseShipConfig` alone does NOT validate `repo`'s owner/repo
// shape, that `envDir`/`projectDir` are clean absolute paths, or that `baseBranch` is a
// valid ref (that is `validateShipConfig`'s job, never run here). Layered on top, reusing
// each check's one canonical implementation site rather than a second hand-copy — all from
// scripts/lib/ship-config.ts:
//   - `repo` → `isValidRepo`
//   - `envDir` / `projectDir` → `isCleanAbsolutePath`
//   - `baseBranch` → `isValidRefName`
//
// Fix pass (IMPORTANT 3): `baseBranch` is applied here too. `resolved_config` lives in the
// agent-writable run-state JSON — `validateShipConfig` only ever re-asserts the
// operator-authored config at T0; this is the one structural check still standing on the
// mutable run-state copy.
export function isValidResolvedConfig(v: unknown): v is ResolvedConfig {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  const { observed, ...shipConfigCandidate } = obj;
  const shipConfigResult = parseShipConfig(JSON.stringify(shipConfigCandidate));
  if (!shipConfigResult.ok) return false;
  if (!isValidRepo(shipConfigResult.config.repo)) return false;
  if (!isCleanAbsolutePath(shipConfigResult.config.envDir)) return false;
  if (!isCleanAbsolutePath(shipConfigResult.config.projectDir)) return false;
  if (!isValidRefName(shipConfigResult.config.baseBranch)) return false;
  if (typeof observed !== "object" || observed === null || Array.isArray(observed)) return false;
  const obs = observed as Record<string, unknown>;
  for (const key of OBSERVED_KEYS) {
    if (!(key in obs)) return false;
  }
  const known: readonly string[] = OBSERVED_KEYS;
  for (const key of Object.keys(obs)) {
    if (!known.includes(key)) return false;
  }
  return OBSERVED_KEYS.every((key) => isNonEmptyString(obs[key]));
}

// STRUCTURAL validation ONLY — never touches the filesystem. Every rejection path returns
// its own named `reason` plus a human-readable `detail`; nothing here silently drops an
// unknown key or defaults a missing/malformed field.
export function parseRunState(text: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return fail("invalid_json", "run-state is not valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return fail("not_object", "run-state root must be a JSON object");
  }
  const obj = parsed as Record<string, unknown>;

  for (const key of REQUIRED_KEYS) {
    if (!(key in obj)) {
      return fail("missing_key", `missing required key: ${key}`);
    }
  }
  const known: readonly string[] = REQUIRED_KEYS;
  for (const key of Object.keys(obj)) {
    if (!known.includes(key)) {
      return fail("unknown_key", `unknown key: ${key}`);
    }
  }

  // IMPORTANT 6: `arg` is interpolated into the state-file path — must be a single safe path
  // segment, not merely a non-empty string.
  if (!isSafePathSegment(obj.arg)) {
    return fail("invalid_arg", "arg must be a single safe path segment: no '/', no '\\', no '..', non-empty after trimming");
  }
  if (obj.invoked_as !== "parent" && obj.invoked_as !== "leaf") {
    return fail("invalid_invoked_as", `invoked_as must be "parent" or "leaf", got ${JSON.stringify(obj.invoked_as)}`);
  }
  if (!isNonEmptyString(obj.started_at)) {
    return fail("wrong_type", "started_at must be a non-empty string");
  }
  if (!isNonEmptyString(obj.order_rationale)) {
    return fail("wrong_type", "order_rationale must be a non-empty string");
  }
  if (!isStringArray(obj.snapshot)) {
    return fail("invalid_snapshot", "snapshot must be an array of non-empty strings");
  }
  if (!isStringArray(obj.stories_done)) {
    return fail("invalid_stories_done", "stories_done must be an array of non-empty strings");
  }

  if (obj.in_flight !== null) {
    if (typeof obj.in_flight !== "object" || Array.isArray(obj.in_flight)) {
      return fail("invalid_in_flight", "in_flight must be null or {story, agent_dispatched_at}");
    }
    const inFlightObj = obj.in_flight as Record<string, unknown>;
    for (const key of IN_FLIGHT_KEYS) {
      if (!(key in inFlightObj)) {
        return fail("invalid_in_flight", `in_flight missing required key: ${key}`);
      }
    }
    const knownInFlight: readonly string[] = IN_FLIGHT_KEYS;
    for (const key of Object.keys(inFlightObj)) {
      if (!knownInFlight.includes(key)) {
        return fail("invalid_in_flight", `in_flight has unknown key: ${key}`);
      }
    }
    if (!isNonEmptyString(inFlightObj.story) || !isNonEmptyString(inFlightObj.agent_dispatched_at)) {
      return fail("invalid_in_flight", "in_flight.story and in_flight.agent_dispatched_at must be non-empty strings");
    }
    // CRITICAL 1: reject a non-parseable `agent_dispatched_at` with its OWN named reason,
    // distinct from every other in_flight defect — a degraded read must be diagnosable, never
    // conflated with the healthy path (which is what let `dispatchVerdict` deadlock forever
    // on an unreadable stamp).
    if (!Number.isFinite(Date.parse(inFlightObj.agent_dispatched_at as string))) {
      return fail("invalid_in_flight_timestamp", "in_flight.agent_dispatched_at must be a parseable date/time string");
    }
  }

  if (typeof obj.merged !== "object" || obj.merged === null || Array.isArray(obj.merged)) {
    return fail("invalid_merged", "merged must be an object keyed by story id");
  }
  for (const [storyId, entry] of Object.entries(obj.merged as Record<string, unknown>)) {
    if (!isValidMergedEntry(entry)) {
      return fail("invalid_merged_entry", `merged["${storyId}"] must be exactly {pr, merge_sha, status}`);
    }
  }

  if (!isStringArray(obj.subissues_filed)) {
    return fail("invalid_subissues_filed", "subissues_filed must be an array of non-empty strings");
  }

  if (!isValidResolvedConfig(obj.resolved_config)) {
    return fail("invalid_resolved_config", "resolved_config must match ship-config.ts's ResolvedConfig shape");
  }

  return {
    ok: true,
    state: {
      arg: obj.arg,
      invoked_as: obj.invoked_as,
      started_at: obj.started_at,
      order_rationale: obj.order_rationale,
      snapshot: obj.snapshot as string[],
      stories_done: obj.stories_done as string[],
      in_flight: obj.in_flight as InFlight | null,
      merged: obj.merged as Record<string, MergedEntry>,
      subissues_filed: obj.subissues_filed as string[],
      resolved_config: obj.resolved_config as ResolvedConfig,
    },
  };
}

// --- in_flight: the authoritative duplicate-dispatch guard, with a staleness escape --------
//
// Locked 13. `in_flight` is written at dispatch (step 2) and cleared on report, park, or halt
// (steps 5/7, "Parking a story", "Crash recovery" — see commands/drawbar-ship.md). A second
// invocation while it is still fresh must no-op WITHOUT dispatching a second agent. But a
// crashed run leaves `in_flight` set forever unless something notices — so once
// `now - agent_dispatched_at` EXCEEDS 2x the heartbeat, the correct response is to route to
// crash recovery, not to keep no-op'ing forever (F13 pins the heartbeat itself at 2700-3600s,
// re-armed at every dispatch, which is what makes "2x the heartbeat" a well-defined instant
// rather than a moving target).

// F13: the heartbeat is 2700-3600 seconds (45-60 minutes), re-armed at every dispatch — see
// `maybeDispatch` below, which sets a fresh `agent_dispatched_at` exactly when it dispatches.
export const HEARTBEAT_SECONDS_MIN = 2700;
export const HEARTBEAT_SECONDS_MAX = 3600;

export function isValidHeartbeatSeconds(seconds: number): boolean {
  return seconds >= HEARTBEAT_SECONDS_MIN && seconds <= HEARTBEAT_SECONDS_MAX;
}

export type DispatchVerdict =
  | { action: "dispatch" }
  | { action: "no_op"; reason: "in_flight_fresh" }
  | { action: "crash_recovery"; reason: "in_flight_stale" | "in_flight_unreadable" }
  | { action: "refused"; reason: "invalid_heartbeat_seconds" | "invalid_now" };

// Fix pass (CRITICAL 1): a healthy `agent_dispatched_at` is never more than a few seconds in
// the future relative to `now` — small clock skew between the writer and this verdict's
// caller, nothing more. Anything further in the future than this is not a live dispatch that
// merely looks fresh; it is an unreadable/corrupt timestamp that would otherwise stay
// PERMANENTLY "fresh" (negative elapsed never exceeds the staleness threshold), which is
// exactly the deadlock Locked 13 exists to prevent. Documented per the fix-pass instruction
// to pick and note a tolerance.
const FUTURE_TIMESTAMP_TOLERANCE_SECONDS = 5;

// Pure verdict function. `now` (epoch milliseconds) is always injected, never read from the
// clock here (Locked 5 style, applied to time the same way ship-config.ts applies it to
// `git`/`gh`).
//
// Locked 13's wording is "exceeds 2x the heartbeat" — i.e. strict `>`. Exactly 2x is
// DELIBERATELY still fresh (not stale): this is a deliberate boundary choice, pinned by tests
// on both sides of it, not an accidental off-by-one. A `>=` reading would treat the instant a
// healthy agent's next heartbeat is due as already-crashed, which is the wrong side to err on
// for a boundary that fires this rarely.
//
// Fix pass (CRITICAL 1 / CRITICAL 2): this function re-validates BOTH `heartbeatSeconds` and
// `in_flight.agent_dispatched_at` itself, independently of `parseRunState` — a caller can
// (and the tests do) construct a `RunState`-shaped value directly, skipping the parser
// entirely, so a degraded/malformed input reaching this pure function must still fail toward
// a diagnosable, named refusal rather than silently picking a side. Order: validate
// `heartbeatSeconds` first (nothing below is meaningful without it), then treat an absent
// (`undefined`) `in_flight` the same as an explicit `null` (Minor fix — a missing key must
// route to Preflight's "must route here rather than dying" discipline, not throw), then
// validate the timestamp before ever computing `elapsedSeconds` from it.
export function dispatchVerdict(state: Pick<RunState, "in_flight">, now: number, heartbeatSeconds: number): DispatchVerdict {
  if (!isValidHeartbeatSeconds(heartbeatSeconds)) {
    return { action: "refused", reason: "invalid_heartbeat_seconds" };
  }
  const inFlight = state.in_flight ?? null;
  if (inFlight === null) return { action: "dispatch" };

  const dispatchedAt = Date.parse(inFlight.agent_dispatched_at);
  if (!Number.isFinite(dispatchedAt)) {
    return { action: "crash_recovery", reason: "in_flight_unreadable" };
  }
  const elapsedSeconds = (now - dispatchedAt) / 1000;
  if (elapsedSeconds < -FUTURE_TIMESTAMP_TOLERANCE_SECONDS) {
    // A future-dated stamp beyond ordinary clock skew: treated as unreadable rather than
    // permanently fresh (CRITICAL 1) — see FUTURE_TIMESTAMP_TOLERANCE_SECONDS above.
    return { action: "crash_recovery", reason: "in_flight_unreadable" };
  }
  if (elapsedSeconds > 2 * heartbeatSeconds) {
    return { action: "crash_recovery", reason: "in_flight_stale" };
  }
  return { action: "no_op", reason: "in_flight_fresh" };
}

export interface MaybeDispatchInput {
  state: RunState;
  story: string;
  now: number;
  heartbeatSeconds: number;
  // Injected runner (Locked 5 style): the real dispatch is a `Task` tool call made by the
  // orchestrating agent session, never something this module can perform itself. Tests pass
  // a call-counter spy to prove the fresh-in_flight path genuinely never calls this.
  dispatch: (story: string) => void;
  // Fix pass (IMPORTANT 3): a duplicate-dispatch guard must make its claim DURABLE — i.e.
  // persisted — before it acts. Injected (Locked 5 style) rather than performed by this
  // module: writing the run-state file is the caller's job, same discipline `dispatch`
  // already follows. Called with the re-armed `in_flight` BEFORE `dispatch`, never after.
  persist: (state: RunState) => void;
}

export interface MaybeDispatchResult {
  verdict: DispatchVerdict;
  // Unchanged unless `verdict.action === "dispatch"`, in which case `in_flight` is re-armed
  // with the injected `now` (F13).
  nextState: RunState;
}

// Fix pass (IMPORTANT 3): claim → persist → dispatch, in that order, and the claim is built
// BEFORE any side effect at all. Two failure modes this closes:
//
//   (a) an invalid `now` (e.g. NaN) used to make it all the way to `new Date(now).toISOString()`
//       AFTER `dispatch` had already fired, throwing a RangeError with the agent already
//       dispatched and `in_flight` never persisted — the next invocation would then dispatch a
//       DUPLICATE. Refused outright, up front, before any side effect — a named refusal, not
//       a throw.
//   (b) `dispatch` throwing (e.g. the Task tool call itself failing) used to propagate before
//       `nextState` (carrying the re-armed `in_flight`) was ever returned for the caller to
//       persist — again risking a duplicate on the next invocation. `persist` is now called
//       with the durable claim BEFORE `dispatch`, so a thrown `dispatch` still leaves the
//       claim durable.
export function maybeDispatch(input: MaybeDispatchInput): MaybeDispatchResult {
  if (!Number.isFinite(input.now)) {
    return { verdict: { action: "refused", reason: "invalid_now" }, nextState: input.state };
  }
  const verdict = dispatchVerdict(input.state, input.now, input.heartbeatSeconds);
  if (verdict.action !== "dispatch") {
    return { verdict, nextState: input.state };
  }
  const nextState: RunState = {
    ...input.state,
    in_flight: { story: input.story, agent_dispatched_at: new Date(input.now).toISOString() },
  };
  input.persist(nextState);
  input.dispatch(input.story);
  return { verdict, nextState };
}

// Clears `in_flight` — called on park ("Parking a story") and on halt ("Crash recovery"),
// per Locked 13. The step-5/7 report-site clear this comment used to describe was deleted
// along with the merge path (commands/drawbar-ship.md now says explicitly the report site
// does NOT clear); one function, two surviving call sites.
export function clearInFlight(state: RunState): RunState {
  return { ...state, in_flight: null };
}
