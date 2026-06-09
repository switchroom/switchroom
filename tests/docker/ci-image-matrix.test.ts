/**
 * Pin the .github/workflows/docker-images.yml build matrix to cover
 * EVERY Dockerfile under docker/ that publishes a switchroom-* image.
 *
 * Background — PR #1266 added docker/Dockerfile.hindsight but did not
 * add it to the CI matrix, so no `ghcr.io/<owner>/switchroom-hindsight`
 * tag was ever published. Operators following the canonical setup path
 * (`switchroom setup` → `startHindsight()`) hit a broken `docker pull`
 * because the image src/setup/hindsight.ts:HINDSIGHT_IMAGE points at
 * doesn't exist on GHCR.
 *
 * Going forward: any new Dockerfile under docker/ MUST be reflected
 * in the matrix, OR explicitly opted out via DOCKER_MATRIX_OPT_OUT
 * below. Failing this test forces the author to make the choice.
 */

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Dockerfiles that intentionally don't ship as `switchroom-<name>` GHCR
 * tags. Add the bare name (the part after `Dockerfile.`) here with a
 * one-line reason. Reviewers can then audit at a glance whether the
 * opt-out is legitimate.
 */
const DOCKER_MATRIX_OPT_OUT: Record<string, string> = {
  // base is built in its own job (build-base) and consumed by every
  // dependent via BASE_IMAGE — it doesn't ship as a separate
  // switchroom-* tag.
  base: "built as build-base; consumed via BASE_IMAGE arg",
  // uat-runner is the sandboxed self-hosted UAT host image (#2236); it is
  // built/consumed by the UAT CI workflow, not published as a per-version
  // fleet GHCR tag, so it is intentionally outside the docker-images matrix.
  "uat-runner": "CI-only sandboxed UAT host runner (#2236); not a published fleet image",
};

function dockerfileNames(): string[] {
  const dir = resolve(root, "docker");
  return readdirSync(dir)
    .filter((f) => f.startsWith("Dockerfile.") && !f.endsWith(".bak"))
    .map((f) => f.slice("Dockerfile.".length));
}

function matrixNames(): Set<string> {
  const yml = readFileSync(
    resolve(root, ".github/workflows/docker-images.yml"),
    "utf8",
  );
  const found = new Set<string>();
  // Two valid coverage shapes:
  //   1. matrix entry: `- { name: agent, file: docker/Dockerfile.agent }`
  //   2. standalone job that references `file: docker/Dockerfile.<name>`
  //      via a `docker/build-push-action` step (e.g. `build-hindsight`,
  //      added in PR #1310 because hindsight extends upstream rather
  //      than switchroom-base, so it doesn't fit the dependents matrix).
  for (const m of yml.matchAll(/- \{\s*name:\s*([\w-]+)\s*,\s*file:\s*docker\/Dockerfile\.[\w-]+\s*\}/g)) {
    found.add(m[1] as string);
  }
  for (const m of yml.matchAll(/file:\s*docker\/Dockerfile\.([\w-]+)/g)) {
    found.add(m[1] as string);
  }
  return found;
}

describe("CI image matrix coverage", () => {
  it("every docker/Dockerfile.* is either in the matrix or opted-out", () => {
    const names = dockerfileNames();
    const matrix = matrixNames();
    const missing: string[] = [];
    for (const n of names) {
      if (matrix.has(n)) continue;
      if (n in DOCKER_MATRIX_OPT_OUT) continue;
      missing.push(n);
    }
    expect(missing).toEqual([]);
  });

  it("every matrix entry's `file:` actually exists on disk", () => {
    const yml = readFileSync(
      resolve(root, ".github/workflows/docker-images.yml"),
      "utf8",
    );
    const dir = new Set(
      readdirSync(resolve(root, "docker")).map((f) => `docker/${f}`),
    );
    const missing: string[] = [];
    for (const m of yml.matchAll(/file:\s*(docker\/Dockerfile\.[\w-]+)/g)) {
      const path = m[1] as string;
      if (!dir.has(path)) missing.push(path);
    }
    expect(missing).toEqual([]);
  });

  it("hindsight is in the matrix (regression — PR #1266 omitted it)", () => {
    expect(matrixNames().has("hindsight")).toBe(true);
  });
});
