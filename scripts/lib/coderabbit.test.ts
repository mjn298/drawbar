import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import {
  coderabbitVerdict,
  fetchPrHeadSha,
  fetchCodeRabbitStatuses,
  checkPr,
  isValidPr,
  isValidRepo,
  parseArgs,
  type CodeRabbitStatus,
  type Runner,
} from "./coderabbit";

const HEAD = "deadbeef00";

function status(overrides: Partial<CodeRabbitStatus> = {}): CodeRabbitStatus {
  return {
    context: "CodeRabbit",
    state: "success",
    description: "Review completed",
    sha: HEAD,
    updated_at: "2026-07-28T18:06:18Z",
    ...overrides,
  };
}

describe("coderabbitVerdict — the allowlist", () => {
  test("ok when state=success, description=Review completed, sha matches headSha", () => {
    const statuses = [status()];
    // Pre-seed sanity: the fixture actually carries the completed status before we
    // trust a positive verdict on it.
    expect(statuses.length).toBe(1);
    expect(statuses[0]!.description).toBe("Review completed");

    const verdict = coderabbitVerdict({ headSha: HEAD, statuses });
    expect(verdict.ok).toBe(true);
  });

  test("refuses a rate-limited review with a distinguishable reason", () => {
    const statuses = [status({ description: "Review rate limited" })];
    expect(statuses.length).toBe(1);
    expect(statuses[0]!.description).toBe("Review rate limited");

    const verdict = coderabbitVerdict({ headSha: HEAD, statuses });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("rate_limited");
  });

  test("refuses a novel, unseen description — allowlist proof, not a denylist", () => {
    const statuses = [status({ description: "Review skipped" })];
    expect(statuses.length).toBe(1);
    expect(statuses[0]!.description).toBe("Review skipped");

    const verdict = coderabbitVerdict({ headSha: HEAD, statuses });
    expect(verdict.ok).toBe(false);
  });

  test("refuses state=failure even with description=Review completed", () => {
    const statuses = [status({ state: "failure" })];
    expect(statuses.length).toBe(1);
    expect(statuses[0]!.state).toBe("failure");

    const verdict = coderabbitVerdict({ headSha: HEAD, statuses });
    expect(verdict.ok).toBe(false);
  });

  test("refuses state=pending with description=Review in progress", () => {
    const statuses = [status({ state: "pending", description: "Review in progress" })];
    expect(statuses.length).toBe(1);

    const verdict = coderabbitVerdict({ headSha: HEAD, statuses });
    expect(verdict.ok).toBe(false);
  });

  test("refuses a status whose sha is stale (targets a previous head)", () => {
    const statuses = [status({ sha: "oldsha111" })];
    expect(statuses.length).toBe(1);
    expect(statuses[0]!.sha).toBe("oldsha111");

    const verdict = coderabbitVerdict({ headSha: HEAD, statuses });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("stale_sha");
  });

  // PCO-349 fix pass 3, Important 7: the payload's own sha (untrusted, independent
  // information) may only ever TIGHTEN the guard, never loosen it — it is conjoined with
  // the URL-scoped `sha`, not merged into it.
  test("a payloadSha that agrees with headSha still passes (URL-scoped sha already matches)", () => {
    const statuses = [status({ payloadSha: HEAD })];
    const verdict = coderabbitVerdict({ headSha: HEAD, statuses });
    expect(verdict.ok).toBe(true);
  });

  test("a payloadSha that disagrees with headSha refuses with stale_sha, even though the URL-scoped sha matches", () => {
    const statuses = [status({ payloadSha: "a-different-sha" })];
    const verdict = coderabbitVerdict({ headSha: HEAD, statuses });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("stale_sha");
  });

  test("refuses when no CodeRabbit status is present", () => {
    const statuses: CodeRabbitStatus[] = [];
    const verdict = coderabbitVerdict({ headSha: HEAD, statuses });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("no_status");
  });

  test("filters out non-CodeRabbit contexts before deciding", () => {
    const statuses = [
      status({ context: "ci/build", state: "success", description: "build passed" }),
    ];
    expect(statuses.length).toBe(1);
    const verdict = coderabbitVerdict({ headSha: HEAD, statuses });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("no_status");
  });

  test("newest by updated_at wins; a stale completed behind a newer non-completed does not pass", () => {
    const statuses = [
      status({ description: "Review completed", updated_at: "2026-07-28T18:00:00Z" }),
      status({ state: "pending", description: "Review in progress", updated_at: "2026-07-28T18:05:00Z" }),
    ];
    expect(statuses.length).toBe(2);

    const verdict = coderabbitVerdict({ headSha: HEAD, statuses });
    expect(verdict.ok).toBe(false);
  });

  test("a malformed updated_at on a completed status must not beat a newer, well-formed non-completed status (fail closed, not NaN-sort)", () => {
    // Reachable from the real fetch path: fetchCodeRabbitStatuses coerces a missing
    // updated_at to "", and `new Date("")` / `new Date("not-a-timestamp")` both yield NaN.
    // A comparator that subtracts two Date#getTime() values returns NaN here, and a NaN
    // comparator result is not a defined "b is not newer than a" — the malformed entry must
    // not win the "latest" slot just because the naive arithmetic broke.
    const statuses = [
      status({ description: "Review completed", updated_at: "not-a-real-timestamp" }),
      status({
        state: "pending",
        description: "Review in progress",
        updated_at: "2026-07-28T18:05:00Z",
      }),
    ];
    expect(statuses.length).toBe(2);

    const verdict = coderabbitVerdict({ headSha: HEAD, statuses });
    expect(verdict.ok).toBe(false);
  });

  test("an empty updated_at (the real fetch path's coercion for a missing field) does not beat a newer non-completed status", () => {
    const statuses = [
      status({ description: "Review completed", updated_at: "" }),
      status({
        state: "pending",
        description: "Review in progress",
        updated_at: "2026-07-28T18:05:00Z",
      }),
    ];
    const verdict = coderabbitVerdict({ headSha: HEAD, statuses });
    expect(verdict.ok).toBe(false);
  });

  test("out-of-order statuses sort internally to the same verdict as pre-sorted input", () => {
    const sorted = [
      status({ description: "Review completed", updated_at: "2026-07-28T18:06:18Z" }),
      status({ state: "pending", description: "Review in progress", updated_at: "2026-07-28T18:03:28Z" }),
      status({ state: "pending", description: "Review queued", updated_at: "2026-07-28T18:03:26Z" }),
    ];
    const outOfOrder = [sorted[2]!, sorted[0]!, sorted[1]!];

    const a = coderabbitVerdict({ headSha: HEAD, statuses: sorted });
    const b = coderabbitVerdict({ headSha: HEAD, statuses: outOfOrder });
    expect(a).toEqual(b);
    expect(a.ok).toBe(true);
  });

  // PCO-349 fix-pass Critical 1: `Array.prototype.sort` is stable, and the old comparator
  // returned 0 for equal `updated_at` values — so a genuine tie (GitHub's second-resolution
  // timestamps make this routine) or an all-unparseable set degraded "latest" to "whatever
  // order `gh` handed back". Reproduced here as measured against the pre-fix module: both
  // orderings of a same-second tie between a stale "Review completed" and a "Review rate
  // limited" must refuse, regardless of array order.
  describe("fail-closed on ties and all-unparseable timestamps (Critical 1)", () => {
    // PCO-349 fix pass 3, Important 5: these two ties both include a rate-limited winner —
    // assert the SPECIFIC reason (not just ok===false), because the pre-fix module collapsed
    // this all the way down to "not_completed", which meant §7 polled the full hour instead
    // of parking immediately on a signal that will never resolve by waiting.
    test("same-second tie, stale Review completed first, Review rate limited second — must refuse with rate_limited", () => {
      const statuses = [
        status({ description: "Review completed", updated_at: "2026-07-28T18:06:18Z" }),
        status({ description: "Review rate limited", updated_at: "2026-07-28T18:06:18Z" }),
      ];
      const verdict = coderabbitVerdict({ headSha: HEAD, statuses });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("rate_limited");
    });

    test("same-second tie, order swapped — same refusal with rate_limited, not order-dependent", () => {
      const statuses = [
        status({ description: "Review rate limited", updated_at: "2026-07-28T18:06:18Z" }),
        status({ description: "Review completed", updated_at: "2026-07-28T18:06:18Z" }),
      ];
      const verdict = coderabbitVerdict({ headSha: HEAD, statuses });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("rate_limited");
    });

    // The three scenarios measured directly against the module in the fix-pass-3 review:
    // all three degraded to "not_completed" pre-fix, which is invisible to an operator (§7
    // only distinguishes rate_limited for the immediate-park branch) and, in the third case,
    // reachable from a real upstream field rename alone.
    test("tie: both winners are rate-limited — refuses with rate_limited", () => {
      const statuses = [
        status({ description: "Review rate limited", updated_at: "2026-07-28T18:06:18Z" }),
        status({ description: "Review rate limited", updated_at: "2026-07-28T18:06:18Z" }),
      ];
      const verdict = coderabbitVerdict({ headSha: HEAD, statuses });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("rate_limited");
    });

    test("tie: rate-limited winner tied with an in-progress winner — refuses with rate_limited", () => {
      const statuses = [
        status({ description: "Review rate limited", updated_at: "2026-07-28T18:06:18Z" }),
        status({ state: "pending", description: "Review in progress", updated_at: "2026-07-28T18:06:18Z" }),
      ];
      const verdict = coderabbitVerdict({ headSha: HEAD, statuses });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("rate_limited");
    });

    test("lone rate-limited status with an unparseable updated_at (disqualified branch) — refuses with rate_limited, not not_completed", () => {
      const statuses = [status({ description: "Review rate limited", updated_at: "not-a-timestamp" })];
      const verdict = coderabbitVerdict({ headSha: HEAD, statuses });
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("rate_limited");
    });

    test("both updated_at empty (all-unparseable) — Review completed first, Review in progress second — must refuse", () => {
      const statuses = [
        status({ description: "Review completed", updated_at: "" }),
        status({ state: "pending", description: "Review in progress", updated_at: "" }),
      ];
      const verdict = coderabbitVerdict({ headSha: HEAD, statuses });
      expect(verdict.ok).toBe(false);
    });

    test("payload with updated_at coerced to empty by the fetch layer for both entries — must refuse", () => {
      // Reachable in production: an upstream field rename (e.g. `updated_at` -> `updatedAt`)
      // makes fetchCodeRabbitStatuses coerce every status's updated_at to "" — this must not
      // silently convert every status into a winning, ok:true verdict.
      const payload = JSON.stringify([
        { context: "CodeRabbit", state: "success", description: "Review completed", updatedAt: "x" },
        { context: "CodeRabbit", state: "pending", description: "Review in progress", updatedAt: "y" },
      ]);
      const run: Runner = () => ({ code: 0, stdout: payload });
      const statuses = fetchCodeRabbitStatuses("acme/widget", HEAD, run);
      expect(statuses.length).toBe(2);
      expect(statuses.every((s) => s.updated_at === "")).toBe(true); // pre-seed sanity
      const verdict = coderabbitVerdict({ headSha: HEAD, statuses });
      expect(verdict.ok).toBe(false);
    });

    test("a single status whose only timestamp is unparseable never wins — disqualified, not de-ranked", () => {
      const statuses = [status({ description: "Review completed", updated_at: "not-a-timestamp" })];
      expect(statuses.length).toBe(1);
      const verdict = coderabbitVerdict({ headSha: HEAD, statuses });
      expect(verdict.ok).toBe(false);
    });
  });
});

// Locked 5: pure verdict function with INJECTED runners. Every one of these tests supplies
// its own fake `Runner` and never touches a real `gh` binary — the proof that the
// injection seam is complete, not merely asserted. See also the "gh absent from PATH" run
// pasted in the report, which exercises the whole suite the same way from outside bun test.
describe("injected runner — checkPr / fetchPrHeadSha / fetchCodeRabbitStatuses", () => {
  function fakeRunner(responses: Record<string, { code: number; stdout: string }>): {
    run: Runner;
    calls: string[][];
  } {
    const calls: string[][] = [];
    const run: Runner = (argv) => {
      calls.push(argv);
      for (const [key, res] of Object.entries(responses)) {
        if (argv.join(" ").includes(key)) return res;
      }
      throw new Error(`fakeRunner: unexpected argv ${JSON.stringify(argv)}`);
    };
    return { run, calls };
  }

  test("fetchPrHeadSha calls the injected runner with the pull's api path and returns the trimmed sha", () => {
    const { run, calls } = fakeRunner({
      "pulls/42": { code: 0, stdout: `${HEAD}\n` },
    });
    const sha = fetchPrHeadSha("acme/widget", "42", run);
    expect(sha).toBe(HEAD);
    expect(calls.length).toBe(1);
    expect(calls[0]!.join(" ")).toContain("repos/acme/widget/pulls/42");
  });

  test("fetchPrHeadSha returns null when the injected runner reports a non-zero exit code", () => {
    const { run } = fakeRunner({ "pulls/42": { code: 1, stdout: "" } });
    expect(fetchPrHeadSha("acme/widget", "42", run)).toBeNull();
  });

  test("fetchCodeRabbitStatuses parses JSON from the runner, filters non-CodeRabbit contexts, and stamps sha from the URL param", () => {
    const payload = JSON.stringify([
      { context: "CodeRabbit", state: "success", description: "Review completed", updated_at: "2026-07-28T18:06:18Z" },
      { context: "ci/build", state: "success", description: "build ok", updated_at: "2026-07-28T18:03:00Z" },
    ]);
    const { run, calls } = fakeRunner({ "commits/deadbeef00/statuses": { code: 0, stdout: payload } });
    const statuses = fetchCodeRabbitStatuses("acme/widget", HEAD, run);
    expect(statuses.length).toBe(1);
    expect(statuses[0]!.context).toBe("CodeRabbit");
    expect(statuses[0]!.sha).toBe(HEAD); // falls back to the URL param — this payload omits sha
    // MINOR (PCO-349 fix pass 3): `--paginate` was removable from both statuses call sites
    // with the suite staying green — pin it in the argv actually sent to the runner.
    expect(calls[0]!).toContain("--paginate");
  });

  // PCO-349 fix pass 3, Important 7: `sha` must ALWAYS stay URL-scoped (trusted — it is what
  // the request was actually scoped to). A payload-carried sha (untrusted, independent
  // information) is read into the separate `payloadSha` field instead of overwriting `sha` —
  // merging the two let untrusted data satisfy the guard rather than only ever tighten it.
  test("fetchCodeRabbitStatuses keeps sha URL-scoped and carries the payload's own sha (if any) in payloadSha", () => {
    const payload = JSON.stringify([
      { context: "CodeRabbit", state: "success", description: "Review completed", updated_at: "2026-07-28T18:06:18Z", sha: "stale-cached-sha" },
    ]);
    const { run } = fakeRunner({ "commits/deadbeef00/statuses": { code: 0, stdout: payload } });
    const statuses = fetchCodeRabbitStatuses("acme/widget", HEAD, run);
    expect(statuses.length).toBe(1);
    expect(statuses[0]!.sha).toBe(HEAD); // always URL-scoped, never overwritten by the payload
    expect(statuses[0]!.payloadSha).toBe("stale-cached-sha");
  });

  test("fetchCodeRabbitStatuses leaves payloadSha undefined when the real endpoint's payload omits sha", () => {
    const payload = JSON.stringify([
      { context: "CodeRabbit", state: "success", description: "Review completed", updated_at: "2026-07-28T18:06:18Z" },
    ]);
    const { run } = fakeRunner({ "commits/deadbeef00/statuses": { code: 0, stdout: payload } });
    const statuses = fetchCodeRabbitStatuses("acme/widget", HEAD, run);
    expect(statuses[0]!.sha).toBe(HEAD);
    expect(statuses[0]!.payloadSha).toBeUndefined();
  });

  // The bug this fix closes: merging (rather than conjoining) let an untrusted payloadSha
  // MASK a genuine URL-scoped mismatch. A caller who fetches statuses scoped to `oldSha` but
  // then evaluates them against a DIFFERENT `headSha` (a real bug — reusing a stale, cached
  // array) must still be caught, even if the payload happens to carry the new sha.
  test("a caller fetching statuses for one sha and verdicting against a different headSha is still caught, even if the payload's own sha happens to agree with the new head (no masking)", () => {
    const payload = JSON.stringify([
      { context: "CodeRabbit", state: "success", description: "Review completed", updated_at: "2026-07-28T18:06:18Z", sha: "new-head-sha" },
    ]);
    const { run } = fakeRunner({ "commits/cafefeed01/statuses": { code: 0, stdout: payload } });
    const statuses = fetchCodeRabbitStatuses("acme/widget", "cafefeed01", run);
    const verdict = coderabbitVerdict({ headSha: "new-head-sha", statuses });
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("stale_sha");
  });

  test("fetchCodeRabbitStatuses refuses gracefully (empty list) on non-JSON runner output", () => {
    const { run } = fakeRunner({ "commits/deadbeef00/statuses": { code: 0, stdout: "not json" } });
    expect(fetchCodeRabbitStatuses("acme/widget", HEAD, run)).toEqual([]);
  });

  test("checkPr composes both injected calls end to end and reaches ok", () => {
    // A real ISO timestamp, not the unparseable placeholder "t1" this fixture used to carry
    // — that placeholder was silently exercising the -Infinity/disqualified branch of the
    // Critical-1 fix rather than a genuine happy path (an unparseable-timestamp status can
    // never produce ok:true post-fix, so this fixture would now fail for the wrong reason).
    const payload = JSON.stringify([
      { context: "CodeRabbit", state: "success", description: "Review completed", updated_at: "2026-07-28T18:06:18Z" },
    ]);
    const { run, calls } = fakeRunner({
      "pulls/42": { code: 0, stdout: `${HEAD}\n` },
      "commits/deadbeef00/statuses": { code: 0, stdout: payload },
    });
    const verdict = checkPr("acme/widget", "42", run);
    expect(verdict.ok).toBe(true);
    // Both seams were actually exercised, not short-circuited.
    expect(calls.length).toBe(2);
    // MINOR (PCO-349 fix pass 3): pin --paginate on checkPr's own direct statuses call site
    // too (it does not go through fetchCodeRabbitStatuses).
    expect(calls[1]!).toContain("--paginate");
  });

  // I4: a transport failure (auth error, 404) on the head-sha seam is now distinguishable
  // from "gh succeeded but returned nothing" — both used to collapse into "no_status".
  test("checkPr reports fetch_failed (not no_status) when the head-sha seam's gh call itself fails", () => {
    const { run, calls } = fakeRunner({ "pulls/42": { code: 1, stdout: "" } });
    const verdict = checkPr("acme/widget", "42", run);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("fetch_failed");
    expect(calls.length).toBe(1); // never reached the statuses call
  });

  test("checkPr surfaces the runner's stderr as detail on a fetch_failed verdict", () => {
    const run: Runner = () => ({ code: 1, stdout: "", stderr: "gh: authentication error" });
    const verdict = checkPr("acme/widget", "42", run);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.reason).toBe("fetch_failed");
      expect(verdict.detail).toBe("gh: authentication error");
    }
  });

  test("checkPr reports fetch_failed when the statuses seam's gh call fails after a successful head-sha fetch", () => {
    const { run, calls } = fakeRunner({
      "pulls/42": { code: 0, stdout: `${HEAD}\n` },
      "commits/deadbeef00/statuses": { code: 1, stdout: "", stderr: "gh: 404" },
    });
    const verdict = checkPr("acme/widget", "42", run);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("fetch_failed");
    expect(calls.length).toBe(2);
  });

  test("checkPr still reports no_status when the head-sha seam succeeds but returns nothing (genuinely no status, not a transport failure)", () => {
    const { run } = fakeRunner({ "pulls/42": { code: 0, stdout: "" } });
    const verdict = checkPr("acme/widget", "42", run);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("no_status");
  });

  // I5: endpoint-injection guard. `repo`/`pr` are agent-held state on a public repo; a `pr`
  // carrying `..` segments or a `repo` carrying extra path segments must never reach `gh`.
  describe("endpoint-shape validation (I5)", () => {
    test("checkPr refuses a pr id with non-digit shape, without ever calling the runner", () => {
      const calls: string[][] = [];
      const run: Runner = (argv) => {
        calls.push(argv);
        throw new Error("must not be called");
      };
      const verdict = checkPr("acme/widget", "42/../99", run);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("invalid_input");
      expect(calls.length).toBe(0);
    });

    test("checkPr refuses a repo with extra path segments, without ever calling the runner", () => {
      const calls: string[][] = [];
      const run: Runner = (argv) => {
        calls.push(argv);
        throw new Error("must not be called");
      };
      const verdict = checkPr("acme/widget/../other", "42", run);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe("invalid_input");
      expect(calls.length).toBe(0);
    });

    test("isValidPr / isValidRepo accept the normal shapes", () => {
      expect(isValidPr("42")).toBe(true);
      expect(isValidRepo("acme/widget")).toBe(true);
    });

    test("isValidPr / isValidRepo refuse the injection shapes", () => {
      expect(isValidPr("42/../99")).toBe(false);
      expect(isValidPr("")).toBe(false);
      expect(isValidRepo("acme/widget/../other")).toBe(false);
      expect(isValidRepo("acme")).toBe(false);
    });

    // PCO-349 fix pass 3, Important 6: `.` and `..` both match `[A-Za-z0-9._-]+`, so a
    // two-segment repo whose segment IS `..` slipped past the old regex even though it
    // carries no extra `/`. Measured: isValidRepo("../..") / ("a/..") / ("../victim") all
    // returned true before this fix.
    test("isValidRepo refuses a `..` (or `.`) path segment even with exactly two slash-separated segments", () => {
      expect(isValidRepo("../..")).toBe(false);
      expect(isValidRepo("a/..")).toBe(false);
      expect(isValidRepo("../victim")).toBe(false);
      expect(isValidRepo("./a")).toBe(false);
      expect(isValidRepo("a/.")).toBe(false);
    });

    // PCO-349 fix pass 3, Important 8: `fetchPrHeadSha`/`fetchCodeRabbitStatuses` are exported
    // public API of a shipped plugin module — `checkPr` validates before calling either, but
    // any OTHER caller invoking these directly (skipping checkPr's guard) got no validation
    // at all. Apply the same shape refusal at the top of each pure function too.
    test("fetchPrHeadSha refuses an invalid repo or pr shape, without ever calling the runner", () => {
      const calls: string[][] = [];
      const run: Runner = (argv) => {
        calls.push(argv);
        throw new Error("must not be called");
      };
      expect(fetchPrHeadSha("acme/widget/../other", "42", run)).toBeNull();
      expect(fetchPrHeadSha("acme/widget", "42/../99", run)).toBeNull();
      expect(calls.length).toBe(0);
    });

    test("fetchCodeRabbitStatuses refuses an invalid repo shape, without ever calling the runner", () => {
      const calls: string[][] = [];
      const run: Runner = (argv) => {
        calls.push(argv);
        throw new Error("must not be called");
      };
      expect(fetchCodeRabbitStatuses("acme/widget/../other", HEAD, run)).toEqual([]);
      expect(calls.length).toBe(0);
    });

    test("fetchCodeRabbitStatuses refuses a sha that doesn't match the shape of a git commit sha, without ever calling the runner", () => {
      const calls: string[][] = [];
      const run: Runner = (argv) => {
        calls.push(argv);
        throw new Error("must not be called");
      };
      expect(fetchCodeRabbitStatuses("acme/widget", "not-a-sha!", run)).toEqual([]);
      expect(fetchCodeRabbitStatuses("acme/widget", "", run)).toEqual([]);
      expect(calls.length).toBe(0);
    });
  });

  // I9: the sha guard is only reachable if fetchCodeRabbitStatuses can independently learn a
  // different sha than the one checkPr fetched the head for — proven here via a payload that
  // carries its own (differing) sha.
  test("checkPr refuses stale_sha when the statuses payload carries a sha differing from the fetched head", () => {
    const payload = JSON.stringify([
      { context: "CodeRabbit", state: "success", description: "Review completed", updated_at: "2026-07-28T18:06:18Z", sha: "a-different-stale-sha" },
    ]);
    const { run } = fakeRunner({
      "pulls/42": { code: 0, stdout: `${HEAD}\n` },
      "commits/deadbeef00/statuses": { code: 0, stdout: payload },
    });
    const verdict = checkPr("acme/widget", "42", run);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe("stale_sha");
  });

  // I11: the statuses endpoint is not paginated by default; tolerate a paginated shape
  // (array-of-arrays) rather than relying on the real API happening to return one flat page.
  test("fetchCodeRabbitStatuses flattens an array-of-arrays (paginated) response", () => {
    const page1 = [{ context: "CodeRabbit", state: "pending", description: "Review queued", updated_at: "2026-07-28T18:03:00Z" }];
    const page2 = [{ context: "CodeRabbit", state: "success", description: "Review completed", updated_at: "2026-07-28T18:06:18Z" }];
    const payload = JSON.stringify([page1, page2]);
    const { run } = fakeRunner({ "commits/deadbeef00/statuses": { code: 0, stdout: payload } });
    const statuses = fetchCodeRabbitStatuses("acme/widget", HEAD, run);
    expect(statuses.length).toBe(2);
    const verdict = coderabbitVerdict({ headSha: HEAD, statuses });
    expect(verdict.ok).toBe(true);
  });
});

describe("CLI parseArgs (MINOR — direct coverage)", () => {
  test("parses --repo and --pr in either order", () => {
    expect(parseArgs(["--repo", "acme/widget", "--pr", "42"])).toEqual({ repo: "acme/widget", pr: "42" });
    expect(parseArgs(["--pr", "42", "--repo", "acme/widget"])).toEqual({ repo: "acme/widget", pr: "42" });
  });

  test("leaves fields undefined when absent", () => {
    expect(parseArgs([])).toEqual({});
    expect(parseArgs(["--repo", "acme/widget"])).toEqual({ repo: "acme/widget", pr: undefined });
  });

  test("usage/exit-1 on an unrecognized subcommand", async () => {
    const proc = Bun.spawn(["bun", "run", import.meta.dir + "/coderabbit.ts", "not-a-command"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).not.toBe(0);
    expect(out).toBe(""); // no JSON on stdout for a bad subcommand either
  });

  test("usage/exit-1 when --repo or --pr is missing", async () => {
    const proc = Bun.spawn(["bun", "run", import.meta.dir + "/coderabbit.ts", "verdict", "--repo", "acme/widget"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).not.toBe(0);
    expect(out).toBe("");
  });
});

// I5 (CLI boundary): endpoint-shape validation must refuse BEFORE any `gh` call, with no
// JSON at all on stdout — a caller that greps stdout for a verdict object must never
// synthesize one from an unvalidated `--repo`/`--pr`.
describe("CLI endpoint-shape validation refuses before any gh call (I5)", () => {
  test("refuses a pr id shaped like a path-traversal attempt, exit non-zero, no stdout JSON", async () => {
    const proc = Bun.spawn(
      ["bun", "run", import.meta.dir + "/coderabbit.ts", "verdict", "--repo", "acme/widget", "--pr", "42/../99"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    expect(code).not.toBe(0);
    expect(out).toBe("");
    expect(err.length).toBeGreaterThan(0); // diagnosable, not a silent refusal
  });

  test("refuses a repo id with extra path segments, exit non-zero, no stdout JSON", async () => {
    const proc = Bun.spawn(
      ["bun", "run", import.meta.dir + "/coderabbit.ts", "verdict", "--repo", "acme/widget/../other", "--pr", "42"],
      { stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).not.toBe(0);
    expect(out).toBe("");
  });
});

// PCO-349 fix pass 3 (MINOR): the CLI's own exit code was untested — `process.exit(0)`
// unconditionally survived all 217 tests pre-fix-pass. Drives the CLI end to end through a
// real `gh` stub on PATH (never the injected-runner seam), so the actual `process.exit` call
// is what's being pinned, not `checkPr`'s return value.
describe("CLI end-to-end: exit code and detail channel", () => {
  function makeFakeGh(script: string): string {
    const dir = mkdtempSync(join(tmpdir(), "drawbar-cr-cli-stub-"));
    const gh = join(dir, "gh");
    // `#!/bin/bash` (absolute path) rather than `#!/usr/bin/env bash`: the latter requires
    // `env` to resolve "bash" via PATH, which fails under the "gh absent from PATH"
    // constraint run (PATH trimmed to only bun's own directory) — the absolute shebang
    // needs no PATH lookup at all.
    writeFileSync(gh, `#!/bin/bash\n${script}\n`);
    chmodSync(gh, 0o755);
    return dir;
  }

  async function runCli(binDir: string): Promise<{ code: number; out: string; err: string }> {
    const proc = Bun.spawn(
      ["bun", "run", import.meta.dir + "/coderabbit.ts", "verdict", "--repo", "acme/widget", "--pr", "42"],
      { env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` }, stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    return { code, out, err };
  }

  test("exits 0 on an ok:true verdict", async () => {
    // No `jq` dependency: the fake `gh` echoes the sha directly rather than piping through
    // `--jq` (which coderabbit.ts's own `run(["api", ..., "--jq", ".head.sha"])` argv still
    // requests — this stub just doesn't bother honoring it, since it fully controls its own
    // output). This keeps the stub working under the "gh absent from PATH" verification run,
    // whose minimal PATH has no `jq` either.
    const binDir = makeFakeGh(
      `if [[ "$2" == repos/*/pulls/* ]]; then\n` +
        `  echo "deadbeef00"\n` +
        `elif [[ "$2" == repos/*/commits/*/statuses ]]; then\n` +
        `  echo '[{"context":"CodeRabbit","state":"success","description":"Review completed","updated_at":"2026-07-28T18:06:18Z"}]'\n` +
        `fi`,
    );
    const { code, out } = await runCli(binDir);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toEqual({ ok: true });
  });

  test("exits 1 on an ok:false verdict", async () => {
    const binDir = makeFakeGh(
      `if [[ "$2" == repos/*/pulls/* ]]; then\n` +
        `  echo "deadbeef00"\n` +
        `elif [[ "$2" == repos/*/commits/*/statuses ]]; then\n` +
        `  echo '[{"context":"CodeRabbit","state":"pending","description":"Review in progress","updated_at":"2026-07-28T18:06:18Z"}]'\n` +
        `fi`,
    );
    const { code, out } = await runCli(binDir);
    expect(code).toBe(1);
    expect(JSON.parse(out).ok).toBe(false);
    expect(JSON.parse(out).reason).toBe("not_completed"); // genuinely pending, not jq/gh breakage
  });

  // MINOR: `detail` (the raw `gh` stderr) is read only by nothing in §7 (which reads `.ok`
  // and `.reason` alone) — it is pure exposure surface on stdout, where `gh` error text
  // (request URLs, config hints) leaks into the agent transcript. Route it to stderr instead.
  test("routes fetch_failed's detail to stderr, not into the stdout JSON", async () => {
    const binDir = makeFakeGh(
      `if [[ "$2" == repos/*/pulls/* ]]; then\n` +
        `  echo "gh: authentication error for acme/widget" >&2\n` +
        `  exit 1\n` +
        `fi`,
    );
    const { code, out, err } = await runCli(binDir);
    expect(code).toBe(1);
    const parsed = JSON.parse(out);
    expect(parsed.reason).toBe("fetch_failed");
    expect(out).not.toContain("authentication error"); // not on stdout
    expect(err).toContain("authentication error"); // diagnosable on stderr instead
  });

  // PCO-349 fix pass 3, Important 4: replacing realRunner's catch body with `throw err`
  // (scripts/lib/coderabbit.ts, the spawn-failure catch) left all 217 tests green — nothing
  // pinned that a missing `gh` binary is caught and turned into a JSON verdict rather than an
  // uncaught throw that would crash the CLI before it ever writes anything to stdout. PATH is
  // trimmed to ONLY bun's own directory (no `gh` anywhere on it), so `Bun.spawnSync(["gh",
  // ...])` inside realRunner genuinely throws (ENOENT), exercising the real catch branch —
  // not an injected Runner standing in for it.
  test("a `gh` binary missing from PATH entirely produces a well-formed fetch_failed verdict on stdout, not an uncaught throw (Important 4)", async () => {
    const bunDir = dirname(process.execPath);
    const proc = Bun.spawn(
      ["bun", "run", import.meta.dir + "/coderabbit.ts", "verdict", "--repo", "acme/widget", "--pr", "42"],
      { env: { PATH: bunDir }, stdout: "pipe", stderr: "pipe" },
    );
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    expect(code).toBe(1);
    const parsed = JSON.parse(out); // throws if the CLI crashed instead of writing JSON
    expect(parsed.ok).toBe(false);
    expect(parsed.reason).toBe("fetch_failed");
  });
});
