/**
 * Guard: dist/ is built ONCE (in build-dist) and shared with the
 * dependent image legs as the `dist-built` artifact — no leg rebuilds
 * it, and build-base (which COPYs nothing from the context) builds no
 * dist at all.
 *
 * Why this test exists: the whole point of the build-dist job is to
 * collapse N identical `npm run build` invocations into one. A future
 * edit that re-adds a `Build dist/` step to a matrix leg (or drops the
 * `download-artifact` step so the leg's `COPY dist/` picks up a stale or
 * empty tree) would silently undo the saving OR — worse — produce an
 * image built from no dist. Both are invisible on a green run: the
 * former just wastes minutes, the latter only fails at docker-build
 * time on a push. Assert the shape directly.
 *
 * Companion to tests/ci-buildx-warm-pull.test.ts and
 * tests/ci-merge-queue-triggers.test.ts, which guard other structural
 * invariants of the same workflow.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Step {
  name?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
}
interface Job {
  needs?: string | string[];
  if?: unknown;
  steps?: Step[];
}

const wf = parse(
  readFileSync(resolve(root, ".github/workflows/docker-images.yml"), "utf8"),
) as { jobs: Record<string, Job> };
const jobs = wf.jobs;

function needsOf(job: Job): string[] {
  if (!job.needs) return [];
  return Array.isArray(job.needs) ? job.needs : [job.needs];
}
function steps(name: string): Step[] {
  const j = jobs[name];
  expect(j, `job ${name} must exist`).toBeTruthy();
  return j.steps ?? [];
}
function runsNpmBuild(job: Job): boolean {
  return (job.steps ?? []).some((s) => /\bnpm run build\b/.test(s.run ?? ""));
}
function downloadsDist(job: Job): boolean {
  return (job.steps ?? []).some(
    (s) =>
      typeof s.uses === "string" &&
      s.uses.includes("actions/download-artifact") &&
      s.with?.name === "dist-built",
  );
}

const DEPENDENT_LEGS = ["build-dependents", "build-dependents-push"];

describe("docker-images — dist/ is built once and shared", () => {
  it("build-dist exists, builds dist/, and uploads the dist-built artifact", () => {
    const j = jobs["build-dist"];
    expect(j, "build-dist job must exist").toBeTruthy();
    expect(runsNpmBuild(j)).toBe(true);
    const upload = (j.steps ?? []).find(
      (s) =>
        typeof s.uses === "string" &&
        s.uses.includes("actions/upload-artifact"),
    );
    expect(upload, "build-dist must upload an artifact").toBeTruthy();
    expect(upload!.with?.name).toBe("dist-built");
    expect(upload!.with?.path).toBe("dist/");
    // if-no-files-found: error — a build that emitted nothing must fail
    // the job loudly, not hand an empty artifact to the image legs.
    expect(upload!.with?.["if-no-files-found"]).toBe("error");
  });

  it("EXACTLY one job runs `npm run build` — dist is not rebuilt anywhere else", () => {
    const builders = Object.keys(jobs).filter((n) => runsNpmBuild(jobs[n]));
    expect(builders).toEqual(["build-dist"]);
  });

  for (const leg of DEPENDENT_LEGS) {
    it(`${leg} downloads dist-built and does NOT rebuild dist/`, () => {
      const j = jobs[leg];
      expect(j, `${leg} must exist`).toBeTruthy();
      expect(downloadsDist(j)).toBe(true);
      expect(runsNpmBuild(j)).toBe(false);
    });

    it(`${leg} needs build-dist`, () => {
      expect(needsOf(jobs[leg])).toContain("build-dist");
    });

    it(`${leg} restores exec bits on the downloaded bundles`, () => {
      // upload-artifact zips and strips POSIX exec bits; the runtime
      // execs the bundled CLIs and a Dockerfile COPY preserves the
      // stripped mode, so the leg MUST chmod them back before building.
      const chmod = steps(leg).some((s) =>
        /chmod \+x dist\/cli/.test(s.run ?? ""),
      );
      expect(chmod).toBe(true);
    });
  }

  it("build-base builds NO dist and does not consume the artifact (Dockerfile.base COPYs nothing)", () => {
    const j = jobs["build-base"];
    expect(runsNpmBuild(j)).toBe(false);
    expect(downloadsDist(j)).toBe(false);
    expect(needsOf(j)).not.toContain("build-dist");
  });

  it("images-ok aggregates build-dist so a dist-build failure blocks the sentinel", () => {
    expect(needsOf(jobs["images-ok"])).toContain("build-dist");
  });

  it("build-dist runs on every event except a PR with no image changes", () => {
    // The union of the two dependent legs' gates: skip only when it's a
    // PR that touched no image inputs (where no leg runs).
    const cond = String(jobs["build-dist"].if);
    expect(cond).toContain("github.event_name != 'pull_request'");
    expect(cond).toContain("needs.changes.outputs.images == 'true'");
  });

  it("build-dist's if is a status expression (!cancelled) so a skipped `changes` doesn't skip it", () => {
    // `changes` is skipped on tag / dispatch / merge_group (no diff
    // base). Without a status function in the if, that skip PROPAGATES
    // through `needs: changes` and skips build-dist — which would skip
    // the merge_group validation legs and, on a TAG push, skip the whole
    // publish path (merge-dependents needs build-dependents-push needs
    // build-dist). build-base carries `!cancelled()` for exactly this
    // reason; build-dist must too. Regression is invisible on PRs.
    expect(String(jobs["build-dist"].if)).toContain("!cancelled()");
  });
});
