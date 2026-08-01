/**
 * The two half-ship gate scripts (#3654).
 *
 * A `v*` tag used to fire `docker-images`, `release` and `npm-publish` as
 * three independent workflows with nothing cross-gating them, so a tag could
 * publish `switchroom@X.Y.Z` to npm — which can never be un-published —
 * while the binary build was red. These two scripts are the mechanical
 * "is it actually safe to proceed?" checks that the release pipeline and
 * npm-publish both run.
 *
 * Everything here asserts an OUTCOME (a verdict / an exit code), never that
 * a code path executed. The negative cases are chosen so that the obvious
 * weakenings of each script make them fail:
 *
 *   - deny-listing `failure` instead of allow-listing `success` → the
 *     `cancelled` / `timed_out` / `skipped` / `null` cases go red
 *   - matching runs on `head_sha` alone → the "main-push run shares the
 *     tagged commit" case goes red
 *   - treating "no matching run" or a bad payload as success → the
 *     fail-closed cases go red
 *   - hard-coding the expected asset list instead of deriving it from
 *     install.sh → the "installer grew a platform" case goes red
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { selectRun, classify, EXIT as RUN_EXIT } from "../scripts/ci/classify-workflow-run.mjs";
import {
  selectRelease,
  missingAssets,
  expectedAssets,
  EXIT as REL_EXIT,
} from "../scripts/ci/assert-release-assets-complete.mjs";

const REPO = resolve(import.meta.dirname, "..");
const CLASSIFY = resolve(REPO, "scripts/ci/classify-workflow-run.mjs");
const ASSERT_RELEASE = resolve(REPO, "scripts/ci/assert-release-assets-complete.mjs");

const TAG = "v9.9.9";
const SHA = "1111111111111111111111111111111111111111";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "release-gate-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function run(script: string, stdin: string, env: Record<string, string>) {
  const r = spawnSync("node", [script], {
    cwd: REPO,
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return { code: r.status, out: `${r.stdout ?? ""}`, err: `${r.stderr ?? ""}` };
}

function mkRun(over: Record<string, unknown> = {}) {
  return {
    id: 1,
    head_branch: TAG,
    head_sha: SHA,
    event: "push",
    status: "completed",
    conclusion: "success",
    run_started_at: "2026-07-26T01:00:00Z",
    html_url: "https://example.invalid/run/1",
    ...over,
  };
}

// ───────────────────────── classify-workflow-run ─────────────────────────

describe("classify-workflow-run — which run counts", () => {
  it("accepts the run whose head_branch is the tag and head_sha is the commit", () => {
    const r = selectRun({ workflow_runs: [mkRun()] }, { tag: TAG, sha: SHA });
    expect(r?.id).toBe(1);
  });

  it("REJECTS the main-push run that shares the tagged commit", () => {
    // The regression this whole matcher exists for: a release tag points at
    // a commit that was also pushed to main, so both runs carry the same
    // head_sha. The main-push run never publishes `:vX.Y.Z` images, so
    // accepting it would be a false green on the image gate.
    const runs = [mkRun({ id: 7, head_branch: "main" })];
    expect(selectRun({ workflow_runs: runs }, { tag: TAG, sha: SHA })).toBeNull();
  });

  it("rejects a run for the same tag at a different commit", () => {
    const runs = [mkRun({ id: 8, head_sha: "2".repeat(40) })];
    expect(selectRun({ workflow_runs: runs }, { tag: TAG, sha: SHA })).toBeNull();
  });

  it("accepts a workflow_dispatch recovery run on the tag ref", () => {
    // `gh workflow run docker-images.yml --ref vX.Y.Z` is the documented
    // recovery lever; filtering on event == 'push' would reject a genuine fix.
    const runs = [mkRun({ id: 9, event: "workflow_dispatch" })];
    expect(selectRun({ workflow_runs: runs }, { tag: TAG, sha: SHA })?.id).toBe(9);
  });

  it("prefers the most recently started run when a tag was re-pushed", () => {
    const runs = [
      mkRun({ id: 1, run_started_at: "2026-07-26T01:00:00Z", conclusion: "success" }),
      mkRun({ id: 2, run_started_at: "2026-07-26T03:00:00Z", conclusion: "failure" }),
    ];
    // An older green run must never vouch for a newer red one.
    expect(selectRun({ workflow_runs: runs }, { tag: TAG, sha: SHA })?.id).toBe(2);
  });

  it("falls back to the highest id when timestamps are absent", () => {
    const runs = [
      mkRun({ id: 3, run_started_at: undefined, created_at: undefined }),
      mkRun({ id: 5, run_started_at: undefined, created_at: undefined }),
    ];
    expect(selectRun({ workflow_runs: runs }, { tag: TAG, sha: SHA })?.id).toBe(5);
  });

  it("returns null (never a run) for a malformed payload", () => {
    expect(selectRun(null, { tag: TAG, sha: SHA })).toBeNull();
    expect(selectRun({}, { tag: TAG, sha: SHA })).toBeNull();
    expect(selectRun({ workflow_runs: "nope" }, { tag: TAG, sha: SHA })).toBeNull();
  });
});

describe("classify-workflow-run — the verdict is an allow-list on success", () => {
  it("is success ONLY for a completed run concluding success", () => {
    expect(classify(mkRun()).state).toBe("success");
  });

  // Deny-listing `failure` (the tempting simplification) would wave every one
  // of these through as green.
  for (const conclusion of [
    "failure",
    "cancelled",
    "timed_out",
    "action_required",
    "neutral",
    "skipped",
    "startup_failure",
    null,
  ]) {
    it(`is FAILED for a completed run concluding ${String(conclusion)}`, () => {
      expect(classify(mkRun({ conclusion })).state).toBe("failed");
    });
  }

  it("is pending while the run is still going", () => {
    expect(classify(mkRun({ status: "in_progress", conclusion: null })).state).toBe("pending");
    expect(classify(mkRun({ status: "queued", conclusion: null })).state).toBe("pending");
  });

  it("is pending — NOT success — when no run matched at all", () => {
    expect(classify(null).state).toBe("pending");
  });
});

describe("classify-workflow-run — CLI exit codes drive the gate loop", () => {
  const env = { EXPECT_TAG: TAG, EXPECT_SHA: SHA };

  it("exits 0 on a green tag run", () => {
    const r = run(CLASSIFY, JSON.stringify({ workflow_runs: [mkRun()] }), env);
    expect(r.code).toBe(RUN_EXIT.success);
    expect(r.code).toBe(0);
  });

  it("exits 1 on a red tag run so the caller stops instead of retrying", () => {
    const r = run(CLASSIFY, JSON.stringify({ workflow_runs: [mkRun({ conclusion: "failure" })] }), env);
    expect(r.code).toBe(RUN_EXIT.failed);
    expect(r.err).toContain("::error::");
  });

  it("exits 2 (pending, keep waiting) when only the main-push run exists", () => {
    const r = run(CLASSIFY, JSON.stringify({ workflow_runs: [mkRun({ head_branch: "main" })] }), env);
    expect(r.code).toBe(RUN_EXIT.pending);
    expect(r.code).not.toBe(0);
  });

  it("exits 2 (never 0) on an empty payload — a silent API failure must not read as green", () => {
    expect(run(CLASSIFY, "", env).code).toBe(RUN_EXIT.pending);
    expect(run(CLASSIFY, "not json at all", env).code).toBe(RUN_EXIT.pending);
    expect(run(CLASSIFY, JSON.stringify({ workflow_runs: [] }), env).code).toBe(RUN_EXIT.pending);
  });

  it("exits 1 when misconfigured, rather than spinning until the deadline", () => {
    const r = run(CLASSIFY, JSON.stringify({ workflow_runs: [mkRun()] }), { EXPECT_TAG: TAG, EXPECT_SHA: "" });
    expect(r.code).toBe(1);
  });
});

// ─────────────────── assert-release-assets-complete ───────────────────

const REAL_EXPECTED = expectedAssets();

function mkRelease(assets: string[], over: Record<string, unknown> = {}) {
  return {
    id: 42,
    tag_name: TAG,
    draft: true,
    assets: assets.map((name) => ({ name, state: "uploaded" })),
    ...over,
  };
}

describe("assert-release-assets-complete — what a release must carry", () => {
  it("derives the expected set from install.sh, not from a hard-coded list", () => {
    // Same four binaries + checksums file + shipped-asset payload the
    // installer downloads. If install.sh grows a platform, this set grows with
    // it (proved below).
    expect(REAL_EXPECTED).toEqual([
      "switchroom-linux-amd64",
      "switchroom-linux-arm64",
      "switchroom-macos-amd64",
      "switchroom-macos-arm64",
      "switchroom-checksums.txt",
      "switchroom-assets.tar.gz",
    ]);
  });

  it("blocks a release that carries every binary but no asset payload (#4163)", () => {
    // The half-ship this gate exists to catch, one artifact over: four green
    // binaries and no templates is a release that installs cleanly and then
    // fails on the user's host at `switchroom apply`.
    const withoutPayload = REAL_EXPECTED.filter((a) => a !== "switchroom-assets.tar.gz");
    const missing = missingAssets(REAL_EXPECTED, mkRelease(withoutPayload));
    expect(missing).toEqual(["switchroom-assets.tar.gz"]);
  });

  it("grows the requirement when install.sh adds a platform", () => {
    const d = tmp();
    const p = join(d, "install.sh");
    const original = readFileSync(resolve(REPO, "install.sh"), "utf-8");
    const mutated = original.replace(
      /^(\s*)Linux\)(\s*)platform=linux ;;$/m,
      "$1Linux)$2platform=linux ;;\n$1FreeBSD)$2platform=freebsd ;;",
    );
    // Guard the mutation itself: if install.sh's case arm is ever reworded,
    // a silent no-op replace would leave this test asserting nothing.
    expect(mutated).not.toBe(original);
    writeFileSync(p, mutated);
    const grown = expectedAssets({ installShPath: p });
    expect(grown).toContain("switchroom-freebsd-amd64");
    expect(grown).toContain("switchroom-freebsd-arm64");
    // …and the pre-existing ones are still required.
    for (const a of REAL_EXPECTED) expect(grown).toContain(a);
  });

  it("finds a DRAFT release — the state the by-tag API endpoint hides", () => {
    const rel = selectRelease([mkRelease(REAL_EXPECTED, { draft: true })], TAG);
    expect(rel?.draft).toBe(true);
  });

  it("matches on tag_name, not on the human-editable title", () => {
    const rel = selectRelease([mkRelease([], { name: "totally different title" })], TAG);
    expect(rel?.id).toBe(42);
    expect(selectRelease([mkRelease([], { tag_name: "v0.0.1" })], TAG)).toBeNull();
  });

  it("reports exactly which assets are absent", () => {
    const rel = mkRelease(REAL_EXPECTED.filter((a) => a !== "switchroom-macos-arm64"));
    expect(missingAssets(REAL_EXPECTED, rel)).toEqual(["switchroom-macos-arm64"]);
  });

  it("does NOT count an asset whose upload never finished", () => {
    // A `state: "starting"` asset 404s on download. Counting it present
    // would let the gate pass on a release users cannot install from.
    const rel = {
      ...mkRelease(REAL_EXPECTED),
      assets: REAL_EXPECTED.map((name, i) => ({ name, state: i === 0 ? "starting" : "uploaded" })),
    };
    expect(missingAssets(REAL_EXPECTED, rel)).toEqual([REAL_EXPECTED[0]]);
  });

  it("treats a release with no assets array as missing everything", () => {
    expect(missingAssets(REAL_EXPECTED, { tag_name: TAG } as never)).toEqual(REAL_EXPECTED);
  });
});

describe("assert-release-assets-complete — CLI exit codes drive the draft gate", () => {
  const env = { EXPECT_TAG: TAG };

  it("exits 0 only when every expected asset is attached", () => {
    const r = run(ASSERT_RELEASE, JSON.stringify([mkRelease(REAL_EXPECTED)]), env);
    expect(r.code).toBe(REL_EXIT.complete);
    expect(JSON.parse(r.out).missing).toEqual([]);
  });

  it("exits 3 and names the gap when an asset is missing", () => {
    const short = REAL_EXPECTED.filter((a) => a !== "switchroom-checksums.txt");
    const r = run(ASSERT_RELEASE, JSON.stringify([mkRelease(short)]), env);
    expect(r.code).toBe(REL_EXIT.incomplete);
    expect(r.code).not.toBe(0);
    expect(JSON.parse(r.out).missing).toEqual(["switchroom-checksums.txt"]);
  });

  it("exits 4 when no release exists for the tag", () => {
    const r = run(ASSERT_RELEASE, JSON.stringify([mkRelease(REAL_EXPECTED, { tag_name: "v0.0.1" })]), env);
    expect(r.code).toBe(REL_EXIT.notFound);
    expect(JSON.parse(r.out).found).toBe(false);
  });

  it("reports the draft flag so the caller can hold a published release back", () => {
    const published = run(ASSERT_RELEASE, JSON.stringify([mkRelease([], { draft: false })]), env);
    expect(JSON.parse(published.out).draft).toBe(false);
    expect(published.code).toBe(REL_EXIT.incomplete);

    const draft = run(ASSERT_RELEASE, JSON.stringify([mkRelease([], { draft: true })]), env);
    expect(JSON.parse(draft.out).draft).toBe(true);
  });

  it("never exits 0 on unusable input", () => {
    expect(run(ASSERT_RELEASE, "{{{", env).code).toBe(REL_EXIT.badInput);
    expect(run(ASSERT_RELEASE, "[]", env).code).toBe(REL_EXIT.notFound);
    expect(run(ASSERT_RELEASE, JSON.stringify([mkRelease(REAL_EXPECTED)]), { EXPECT_TAG: "" }).code).toBe(
      REL_EXIT.badInput,
    );
  });
});
