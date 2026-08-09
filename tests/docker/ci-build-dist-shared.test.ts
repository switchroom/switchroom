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
import { spawnSync } from "node:child_process";
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

/** The `path:` of build-dist's upload, normalised to a list (it is multi-line). */
function uploadPaths(): string[] {
  const upload = (jobs["build-dist"].steps ?? []).find(
    (s) =>
      typeof s.uses === "string" && s.uses.includes("actions/upload-artifact"),
  );
  return String(upload?.with?.path ?? "")
    .split("\n")
    .map((p) => p.trim())
    .filter(Boolean);
}

/**
 * The Dockerfiles the dependent legs build, read off the job matrix rather
 * than hardcoded — a leg added to the matrix is covered automatically.
 */
function dependentDockerfiles(): string[] {
  const out = new Set<string>();
  for (const leg of DEPENDENT_LEGS) {
    const images = (
      jobs[leg] as {
        strategy?: { matrix?: { image?: { name?: string; file?: string }[] } };
      }
    ).strategy?.matrix?.image;
    for (const entry of images ?? []) {
      if (entry.file) out.add(entry.file);
    }
  }
  expect(
    out.size,
    "expected to discover dependent Dockerfiles from the build-dependents matrix",
  ).toBeGreaterThan(0);
  return [...out];
}

/** Every COPY source path in a Dockerfile (skipping `COPY --from=` stage/image copies). */
function copySources(dockerfile: string): string[] {
  const text = readFileSync(resolve(root, dockerfile), "utf8");
  const srcs: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!/^COPY\s/i.test(line)) continue;
    const tokens = line.split(/\s+/).slice(1);
    // `--from=` copies pull from another stage or image, not the build
    // context, so the artifact is irrelevant to them.
    if (tokens.some((t) => t.startsWith("--from="))) continue;
    const args = tokens.filter((t) => !t.startsWith("--"));
    // Last arg is the destination; everything before it is a source.
    srcs.push(...args.slice(0, -1));
  }
  return srcs;
}

/**
 * True when git ignores the path — i.e. it is a build output absent from a
 * fresh checkout, so it can only reach the build context via the artifact.
 * Uses git itself rather than a hand-maintained pattern list: `.gitignore`'s
 * bare `dist/` matches at ANY depth, which is precisely why
 * `telegram-plugin/dist` is in the same boat as `dist` and easy to miss.
 */
function isGitIgnored(p: string): boolean {
  const check = (probe: string): boolean => {
    const r = spawnSync("git", ["check-ignore", "-q", "--no-index", probe], {
      cwd: root,
    });
    if (r.error) throw r.error;
    // 0 = ignored, 1 = not ignored, anything else = git failed.
    if (r.status !== 0 && r.status !== 1) {
      throw new Error(
        `git check-ignore failed for ${probe} (status ${r.status})`,
      );
    }
    return r.status === 0;
  };
  // Probe the bare path AND the directory form. A directory-only pattern
  // (`dist/`, with the trailing slash) does NOT match the bare string
  // `telegram-plugin/dist` when that directory is absent from disk — which
  // it always is in CI, since it is a build output. Without the trailing-
  // slash probe this helper silently reports every such COPY source as
  // "tracked" and the coverage assertion below becomes a no-op.
  return check(p) || check(p.endsWith("/") ? p : `${p}/`);
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
    expect(uploadPaths()).toContain("dist/");
    // if-no-files-found: error — a build that emitted nothing must fail
    // the job loudly, not hand an empty artifact to the image legs.
    expect(upload!.with?.["if-no-files-found"]).toBe("error");
  });

  // The bug this assertion exists for: the artifact originally shipped
  // ONLY `dist/`, but `npm run build` also emits `telegram-plugin/dist/`
  // (scripts/build.mjs shells telegram-plugin/scripts/build.mjs) and
  // Dockerfile.agent COPYs it. Both trees are gitignored, so neither is in
  // the leg's checkout — the agent leg died with a bare
  // `failed to compute cache key: "/telegram-plugin/dist": not found`.
  //
  // Rather than hardcode the two known trees, DERIVE the requirement from
  // the Dockerfiles: every COPY source that git ignores is, by definition,
  // absent from the checkout and must therefore arrive via the artifact.
  // That catches the next build output someone adds a COPY for, not just
  // this one.
  it("the dist-built artifact covers every gitignored path the dependent Dockerfiles COPY from", () => {
    // Compare slash-normalised: an artifact path is written `dist/` but the
    // Dockerfile COPYs `telegram-plugin/dist` (no trailing slash), and the
    // two spellings denote the same tree.
    const trim = (s: string) => s.replace(/\/+$/, "");
    const paths = uploadPaths();
    const roots = paths.map(trim);
    const uncovered: string[] = [];

    for (const dockerfile of dependentDockerfiles()) {
      for (const src of copySources(dockerfile)) {
        if (!isGitIgnored(src)) continue; // in the checkout already
        const s = trim(src);
        const covered = roots.some((r) => s === r || s.startsWith(`${r}/`));
        if (!covered) uncovered.push(`${dockerfile}: COPY ${src}`);
      }
    }

    expect(
      uncovered,
      `these Dockerfile COPY sources are build outputs (gitignored) but are not in the ` +
        `dist-built artifact, so the build leg will fail with "not found":\n  ` +
        `${uncovered.join("\n  ")}\nArtifact paths: ${JSON.stringify(paths)}`,
    ).toEqual([]);
  });

  it("the dependent legs unpack the artifact at the workspace root", () => {
    // The artifact spans two trees, so upload-artifact roots it at their
    // least common ancestor (the workspace). Downloading into `dist/`
    // would nest it as `dist/dist/...` + `dist/telegram-plugin/dist/...`
    // and every COPY would miss.
    for (const leg of DEPENDENT_LEGS) {
      const dl = steps(leg).find(
        (s) =>
          typeof s.uses === "string" &&
          s.uses.includes("actions/download-artifact") &&
          s.with?.name === "dist-built",
      );
      expect(dl, `${leg} must download dist-built`).toBeTruthy();
      expect(dl!.with?.path, `${leg} must unpack at the workspace root`).toBe(
        ".",
      );
    }
  });

  it("each leg's post-download verify step checks exactly the uploaded trees", () => {
    // The verify step exists so a missing tree fails with a readable error
    // instead of a cryptic buildx `not found`. That only holds if its list
    // tracks the upload paths — a tree added to the artifact but not to the
    // verify loop is unguarded, and one dropped from the artifact but left
    // in the loop makes the step fail spuriously. Pin them together.
    const expected = uploadPaths()
      .map((p) => p.replace(/\/+$/, ""))
      .sort();
    for (const leg of DEPENDENT_LEGS) {
      const verify = steps(leg).find((s) =>
        /Verify build outputs/i.test(s.name ?? ""),
      );
      expect(verify, `${leg} must verify the download landed`).toBeTruthy();
      const loop = /for d in ([^;\n]+); do/.exec(verify!.run ?? "");
      expect(loop, `${leg}'s verify step must iterate the expected trees`)
        .toBeTruthy();
      expect(loop![1].trim().split(/\s+/).sort()).toEqual(expected);
    }
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
