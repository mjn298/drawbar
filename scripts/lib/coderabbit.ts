// One implementation of the CodeRabbit completion predicate for the whole repo.
// `agents/drawbar-story-lead.md` §7 calls this module rather than reimplementing any part
// of the verdict logic — see scripts/plugin.test.ts for the single-implementation-site
// regression test. `commands/drawbar-ship.md` only names this module in prose (its own
// preflight comment and the Appendix amendment); it never calls it directly.
//
// F14: keying on `.state` alone is wrong. A rate-limited review reports
// `state: "success"` with `description: "Review rate limited"` — CodeRabbit never actually
// reviewed the diff, but a `.state`-only gate treats it identically to a real pass. The
// predicate below is an ALLOWLIST of the exact (state, description) pair that means "really
// reviewed, really passed" — never a denylist of known-bad values, because a denylist
// passes on the next never-seen description CodeRabbit ships.
//
// This is the first `scripts/lib/*` module with an `import.meta.main` CLI block — the other
// library modules in this directory are pure, and CLI entry points otherwise live in
// `scripts/kb.ts`. That split is a consequence of Locked 4 (no sixth `scripts/lib/` module),
// not a new house pattern — don't copy the CLI block into the next `scripts/lib/*` addition
// without a similar reason.

export interface CodeRabbitStatus {
  context: string;
  state: string;
  description: string;
  // The commit sha this status was reported against, ALWAYS taken from the request URL —
  // this is the trusted value: it is what the request was actually scoped to.
  sha: string;
  // Independent information from the payload itself (untrusted — a caller-controlled array
  // could carry anything here), present only when the real endpoint's response includes a
  // per-entry `sha` (the real `gh api repos/{repo}/commits/{sha}/statuses` response never
  // does). PCO-349 fix pass 3, Important 7: this field must be CONJOINED with `sha`, never
  // merged into it — an earlier version let a payload-carried sha overwrite the URL-scoped
  // `sha`, which meant untrusted data could satisfy the stale_sha guard instead of only ever
  // tightening it (a caller reusing a stale, cached array of statuses could be masked by a
  // payload sha that happened to agree with the new head). Keeping the two fields separate
  // means the payload can only ever ADD a reason to refuse, never remove one.
  payloadSha?: string;
  updated_at: string;
}

export interface VerdictInput {
  headSha: string;
  statuses: CodeRabbitStatus[];
}

export type Reason =
  | "no_status"
  | "stale_sha"
  | "rate_limited"
  | "not_completed"
  | "fetch_failed"
  | "invalid_input";

export type Verdict = { ok: true } | { ok: false; reason: Reason; detail?: string };

const CODERABBIT_CONTEXT = "CodeRabbit";

// An unparseable/empty `updated_at` must fail closed: it must never win the "latest" slot
// over a genuinely-timestamped status. `fetchCodeRabbitStatuses` coerces a missing field to
// "", and a malformed or empty string both parse to `NaN` here — treat that as the oldest
// possible instant (never newest), consistent with the module's allowlist philosophy of
// refusing rather than guessing when a value is not in the recognized shape.
function parsedUpdatedAt(updatedAt: string): number {
  const t = new Date(updatedAt).getTime();
  return Number.isNaN(t) ? -Infinity : t;
}

// The sha guard: `sha` (URL-scoped, trusted) must match `headSha`, AND — if the payload
// carried its own independent `payloadSha` — that must agree too. The payload can only ever
// tighten this, never loosen it (see the CodeRabbitStatus.payloadSha field comment).
function shaMatchesHead(s: CodeRabbitStatus, headSha: string): boolean {
  return s.sha === headSha && (s.payloadSha === undefined || s.payloadSha === headSha);
}

function anyRateLimited(candidates: CodeRabbitStatus[]): boolean {
  return candidates.some((s) => s.description === "Review rate limited");
}

export function coderabbitVerdict({ headSha, statuses }: VerdictInput): Verdict {
  const crStatuses = statuses.filter((s) => s.context === CODERABBIT_CONTEXT);
  if (crStatuses.length === 0) return { ok: false, reason: "no_status" };

  const times = crStatuses.map((s) => parsedUpdatedAt(s.updated_at));
  const maxTime = times.reduce((max, t) => (t > max ? t : max), -Infinity);

  // Disqualify, don't merely de-rank: if every candidate's timestamp is unparseable (or the
  // sole candidate's is), there is no trustworthy "latest" at all — refuse outright rather
  // than let a `sort`'s stability (or any other incidental tiebreak) decide. Still surface
  // rate_limited over the generic not_completed when it applies (PCO-349 fix pass 3,
  // Important 5) — an operator needs the distinguishable, actionable reason rather than a
  // signal indistinguishable from "still in review" that a timer will never resolve.
  if (maxTime === -Infinity) {
    if (anyRateLimited(crStatuses)) return { ok: false, reason: "rate_limited" };
    return { ok: false, reason: "not_completed" };
  }

  const winners = crStatuses.filter((_, i) => times[i] === maxTime);
  // Defensive: unreachable today (crStatuses.length > 0 and maxTime !== -Infinity together
  // guarantee at least one match), but the fail-closed property below rests on this
  // invariant, and `[].every()` is vacuously true — state it explicitly rather than resting
  // on an invariant no assertion pins.
  if (winners.length === 0) return { ok: false, reason: "not_completed" };

  if (winners.length === 1) {
    const latest = winners[0]!;
    if (!shaMatchesHead(latest, headSha)) return { ok: false, reason: "stale_sha" };
    // Rate limiting is distinguished from a generic refusal so the caller can park the story
    // immediately rather than keep polling a signal that a timer will not resolve.
    if (latest.description === "Review rate limited") return { ok: false, reason: "rate_limited" };
    // The allowlist: exactly this pair, nothing else.
    if (latest.state === "success" && latest.description === "Review completed") {
      return { ok: true };
    }
    return { ok: false, reason: "not_completed" };
  }

  // A genuine tie at the maximum timestamp — GitHub's second-resolution `updated_at` makes
  // this routine, not exotic. `Array.prototype.sort`'s stability degrading "latest" to
  // "whatever order the API happened to return" is exactly the undefined-order bug this
  // module exists to kill; picking either tied element arbitrarily reintroduces it. Fail
  // closed instead: pass only if EVERY tied candidate independently agrees the review is
  // done, passed, and targets the current head.
  const allAgree = winners.every(
    (w) => shaMatchesHead(w, headSha) && w.state === "success" && w.description === "Review completed",
  );
  if (allAgree) return { ok: true };
  // Safe by construction: if allAgree were true, no winner is rate-limited (a rate-limited
  // description never satisfies the allowlist check above) — surface rate_limited over the
  // generic not_completed here too, for the same operator-actionability reason as above.
  if (anyRateLimited(winners)) return { ok: false, reason: "rate_limited" };
  return { ok: false, reason: "not_completed" };
}

// --- Injected-runner fetch layer -------------------------------------------------------
//
// Locked 5: a pure verdict function with injected runners. `Runner` is the seam: production
// code passes one that really shells out to `gh`; tests pass a fake and never touch `gh` —
// which is the proof that the injection is complete (see the "gh absent from PATH" test).

export type Runner = (argv: string[]) => { code: number; stdout: string; stderr?: string };

export function fetchPrHeadSha(repo: string, pr: string, run: Runner): string | null {
  // PCO-349 fix pass 3, Important 8: this is exported public API of a shipped plugin module,
  // not only reachable through `checkPr`'s own guard — validate here too, defence in depth
  // for any caller that invokes this pure function directly.
  if (!isValidRepo(repo) || !isValidPr(pr)) return null;
  const { code, stdout } = run(["api", `repos/${repo}/pulls/${pr}`, "--jq", ".head.sha"]);
  if (code !== 0) return null;
  const sha = stdout.trim();
  return sha.length > 0 ? sha : null;
}

// Shared parsing so `fetchCodeRabbitStatuses` and `checkPr` agree on shape coercion without
// checkPr re-fetching (and thus double-calling `gh`) through the narrow helper above.
function parseStatuses(stdout: string, sha: string): CodeRabbitStatus[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  // Tolerate a paginated response shape (array-of-arrays) as well as the normal flat array —
  // `.flat()` is a no-op on an already-flat array of objects, so this is safe either way.
  // Belt-and-suspenders: the module otherwise relies on the real endpoint returning statuses
  // newest-first for nothing load-bearing (the verdict logic above no longer trusts array
  // order at all), but an unflattened paginated response would break `.filter`/`.map` below.
  const flat = parsed.flat();
  return flat
    .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
    .map((s) => ({
      context: typeof s.context === "string" ? s.context : "",
      state: typeof s.state === "string" ? s.state : "",
      description: typeof s.description === "string" ? s.description : "",
      // `sha` is ALWAYS the URL-scoped value — see the CodeRabbitStatus.sha field comment.
      sha,
      // `payloadSha` carries the payload's own sha (independent information) when present —
      // see the CodeRabbitStatus.payloadSha field comment. Real GitHub statuses-list
      // responses never carry this field, so this is `undefined` in production.
      payloadSha: typeof s.sha === "string" && s.sha.length > 0 ? s.sha : undefined,
      updated_at: typeof s.updated_at === "string" ? s.updated_at : "",
    }))
    .filter((s) => s.context === CODERABBIT_CONTEXT);
}

export function fetchCodeRabbitStatuses(repo: string, sha: string, run: Runner): CodeRabbitStatus[] {
  // PCO-349 fix pass 3, Important 8: same defence-in-depth reasoning as fetchPrHeadSha above.
  if (!isValidRepo(repo) || !SHA_SHAPE.test(sha)) return [];
  const { code, stdout } = run(["api", `repos/${repo}/commits/${sha}/statuses`, "--paginate"]);
  if (code !== 0) return [];
  return parseStatuses(stdout, sha);
}

const PR_SHAPE = /^[0-9]+$/;
const SHA_SHAPE = /^[0-9a-f]{7,40}$/;
// `.` and `..` both match `[A-Za-z0-9._-]+`, so a naive per-character character-class check
// on the whole string lets a two-segment repo whose segment IS `..` through even though it
// carries no extra `/` — split on `/` and refuse any segment that is exactly `.` or `..`.
const REPO_SEGMENT_SHAPE = /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/;

export function isValidPr(pr: string): boolean {
  return PR_SHAPE.test(pr);
}

export function isValidRepo(repo: string): boolean {
  const parts = repo.split("/");
  return parts.length === 2 && parts.every((p) => REPO_SEGMENT_SHAPE.test(p));
}

// Fetches the current head sha and its CodeRabbit statuses, then applies the same verdict
// function above. This is the one call site that talks to `gh` at all in this module.
export function checkPr(repo: string, pr: string, run: Runner): Verdict {
  // Endpoint-injection guard (I5): `repo`/`pr` are agent-held state that can originate from a
  // public PR an attacker opened. Without shape validation, a `pr` carrying `..` segments or
  // a `repo` carrying extra path segments redirects the head-sha lookup at a DIFFERENT PR —
  // and the statuses lookup then follows that PR's sha, turning any PR that genuinely has
  // (success, "Review completed") into a universal ok:true oracle. Validated at the CLI
  // boundary too (see the CLI entry point below); this check is defence in depth for any
  // other caller of `checkPr` that skips that boundary.
  if (!isValidRepo(repo) || !isValidPr(pr)) {
    return { ok: false, reason: "invalid_input" };
  }

  const headRes = run(["api", `repos/${repo}/pulls/${pr}`, "--jq", ".head.sha"]);
  if (headRes.code !== 0) {
    return { ok: false, reason: "fetch_failed", detail: headRes.stderr || undefined };
  }
  const headSha = headRes.stdout.trim();
  if (!headSha) return { ok: false, reason: "no_status" };

  const statusRes = run(["api", `repos/${repo}/commits/${headSha}/statuses`, "--paginate"]);
  if (statusRes.code !== 0) {
    return { ok: false, reason: "fetch_failed", detail: statusRes.stderr || undefined };
  }
  const statuses = parseStatuses(statusRes.stdout, headSha);
  return coderabbitVerdict({ headSha, statuses });
}

// --- CLI entry point --------------------------------------------------------------------
//
// `agents/drawbar-story-lead.md` §7 shells out to this file directly (never reimplementing
// the predicate in bash), passing JSON on stdout so the caller can branch on `.ok` /
// `.reason` with `jq`.

function realRunner(argv: string[]): { code: number; stdout: string; stderr: string } {
  try {
    const proc = Bun.spawnSync(["gh", ...argv], { stdout: "pipe", stderr: "pipe" });
    return { code: proc.exitCode ?? 1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
  } catch (err) {
    // `gh` missing from PATH (or any other spawn-time failure) must fail closed, not throw
    // an uncaught exception — an uncaught throw here means §7's wait loop never even gets a
    // JSON verdict to `jq` on, which is indistinguishable from a hang until the deadline.
    return { code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

export function parseArgs(args: string[]): { repo?: string; pr?: string } {
  const out: { repo?: string; pr?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--repo") out.repo = args[++i];
    else if (args[i] === "--pr") out.pr = args[++i];
  }
  return out;
}

if (import.meta.main) {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== "verdict") {
    process.stderr.write("usage: coderabbit.ts verdict --repo <owner/repo> --pr <number>\n");
    process.exit(1);
  }
  const { repo, pr } = parseArgs(rest);
  if (!repo || !pr) {
    process.stderr.write("usage: coderabbit.ts verdict --repo <owner/repo> --pr <number>\n");
    process.exit(1);
  }
  // I5: refuse before any gh call, with no JSON on stdout — a caller that greps stdout for a
  // JSON verdict must never see an ok/false object synthesized from an unvalidated argument.
  if (!isValidRepo(repo) || !isValidPr(pr)) {
    process.stderr.write(`refused: --repo/--pr failed shape validation (repo=${JSON.stringify(repo)}, pr=${JSON.stringify(pr)})\n`);
    process.exit(1);
  }
  const verdict = checkPr(repo, pr, realRunner);
  // MINOR (PCO-349 fix pass 3): §7 reads only `.ok`/`.reason` via `jq` — `detail` (raw `gh`
  // stderr, which can carry request URLs/config hints) has no stdout consumer and is pure
  // exposure surface there. Keep the diagnostic, move the channel: stderr instead of the
  // stdout JSON a caller might log or pipe elsewhere.
  if (!verdict.ok && verdict.detail) {
    process.stderr.write(verdict.detail + "\n");
  }
  const forStdout = !verdict.ok ? { ok: verdict.ok, reason: verdict.reason } : verdict;
  process.stdout.write(JSON.stringify(forStdout) + "\n");
  // No `set -e` appears in any fence in this repo today (§7's wait loop tolerates a
  // non-zero exit from an ordinary "not finished yet" poll) — but a future caller wrapping
  // this in `set -e` would die on the very first iteration, since `VERDICT=$(...)`
  // propagates the substitution's exit status. Flagging here rather than adding `|| true`
  // at every call site, since the correct fix depends on the caller's control flow.
  process.exit(verdict.ok ? 0 : 1);
}
