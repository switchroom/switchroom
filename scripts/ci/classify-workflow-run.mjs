#!/usr/bin/env node
/**
 * Half-ship gate, leg 1: "did the OTHER tag-triggered workflow succeed for
 * THIS exact tag and commit?" (#3654)
 *
 * A `v*` tag fires `docker-images`, `release` and (historically)
 * `npm-publish` as independent workflows with nothing cross-gating them, so
 * a tag could publish to npm — the one IRREVERSIBLE leg — while the image
 * build or the binary build went red. This script is the deterministic
 * answer to "is docker-images green for this tag?", used by:
 *
 *   - `.github/workflows/release.yml`   → the `images-gate` job (polls)
 *   - `.github/workflows/npm-publish.yml` → its own preflight (single shot)
 *
 * SHAPE: pure classification, no network. The caller fetches
 * `GET /repos/{repo}/actions/workflows/{file}/runs?head_sha=<sha>` with
 * `gh api` (which owns auth + retries) and pipes the JSON in on stdin. That
 * keeps every decision in this file unit-testable against fixtures
 * (tests/release-gate-scripts.test.ts) instead of behind an HTTP mock.
 *
 * WHY head_branch MATTERS AND head_sha ALONE IS NOT ENOUGH: a release tag
 * points at a commit that was ALSO pushed to main, so the main-push run and
 * the tag run share `head_sha`. Only `head_branch` separates them — on a tag
 * push GitHub sets `head_branch` to the tag name. Matching on sha alone would
 * happily accept the main-push run (which does not publish `:vX.Y.Z` images)
 * as proof the tag build succeeded. That is the exact false-green this gate
 * exists to prevent.
 *
 * WHY event IS NOT FILTERED: a `workflow_dispatch` re-run of docker-images on
 * the tag ref (`gh workflow run docker-images.yml --ref vX.Y.Z`) is the
 * documented recovery lever, and it produces a legitimately green run with
 * `head_branch` = the tag. Requiring `event == 'push'` would reject a real
 * recovery and force a pointless re-tag.
 *
 * FAIL-CLOSED BY CONSTRUCTION: "no matching run" is PENDING, never success.
 * An empty/garbled payload (transient API trouble) is PENDING too, so the
 * caller retries; the caller's deadline is what converts sustained pending
 * into a hard failure. Nothing here can turn "I could not tell" into "green".
 *
 * Exit codes (the caller's control flow depends on all three):
 *   0 — a matching run completed with conclusion `success`
 *   2 — pending: no matching run yet, or it is still running, or input was
 *       unusable. Caller should retry until its own deadline.
 *   1 — definitive failure: a matching run completed with any other
 *       conclusion. Caller should stop; retrying cannot change it.
 */

/**
 * Pick the run that belongs to this tag at this commit.
 *
 * @param {unknown} payload parsed `…/runs` response (or an array of runs)
 * @param {{tag: string, sha: string}} want
 * @returns {Record<string, any> | null} newest matching run, or null
 */
export function selectRun(payload, { tag, sha }) {
  const runs = Array.isArray(payload)
    ? payload
    : Array.isArray(payload?.workflow_runs)
      ? payload.workflow_runs
      : null;
  if (!runs) return null;

  const matches = runs.filter(
    (r) => r && typeof r === "object" && r.head_branch === tag && r.head_sha === sha,
  );
  if (matches.length === 0) return null;

  // Multiple matches are possible if a tag was deleted and re-pushed. Take
  // the most recently STARTED one: an older green run must never vouch for a
  // newer red one. `id` is monotonic and is the tie-break when timestamps are
  // absent or equal.
  const startedAt = (r) => Date.parse(r.run_started_at ?? r.created_at ?? "") || 0;
  return matches.reduce((best, r) => {
    const d = startedAt(r) - startedAt(best);
    if (d !== 0) return d > 0 ? r : best;
    return Number(r.id ?? 0) > Number(best.id ?? 0) ? r : best;
  });
}

/**
 * Reduce a run to the gate's verdict.
 *
 * Deliberately an allow-list on `conclusion === 'success'`, not a deny-list
 * on `'failure'`. GitHub emits `cancelled`, `timed_out`, `action_required`,
 * `neutral`, `skipped` and `startup_failure` too; a deny-list would wave all
 * of those through as green.
 *
 * @param {Record<string, any> | null} run
 * @returns {{state: 'pending'|'success'|'failed', detail: string}}
 */
export function classify(run) {
  if (!run) return { state: "pending", detail: "no matching run yet" };
  if (run.status !== "completed") {
    return { state: "pending", detail: `run ${run.id} status=${run.status}` };
  }
  if (run.conclusion === "success") {
    return { state: "success", detail: `run ${run.id} concluded success` };
  }
  return { state: "failed", detail: `run ${run.id} concluded ${String(run.conclusion)}` };
}

/** Map a verdict to this script's documented exit code. */
export const EXIT = { success: 0, failed: 1, pending: 2 };

/* c8 ignore start — CLI wiring, covered end-to-end by spawnSync tests. */
async function main() {
  const tag = process.env.EXPECT_TAG ?? "";
  const sha = process.env.EXPECT_SHA ?? "";
  if (!tag || !sha) {
    console.error("::error::classify-workflow-run: EXPECT_TAG and EXPECT_SHA are both required");
    // Missing configuration is a HARD failure, not pending: retrying an
    // unconfigured gate would spin until the deadline and hide the real bug.
    process.exit(1);
  }

  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf-8").trim();

  let payload = null;
  if (raw.length > 0) {
    try {
      payload = JSON.parse(raw);
    } catch {
      console.error("::notice::classify-workflow-run: unparseable payload — treating as pending");
      process.exit(EXIT.pending);
    }
  }

  const run = selectRun(payload, { tag, sha });
  const { state, detail } = classify(run);
  const where = `${tag} @ ${sha.slice(0, 7)}`;
  if (state === "success") console.log(`gate: ${where} — ${detail}`);
  else if (state === "failed") console.error(`::error::gate: ${where} — ${detail}`);
  else console.log(`gate: ${where} — pending (${detail})`);
  if (run?.html_url) console.log(run.html_url);
  process.exit(EXIT[state]);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
/* c8 ignore stop */
