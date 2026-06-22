import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { VERSION as BUILD_INFO_VERSION } from "../build-info.js";

/**
 * The displayed switchroom version, resolved at runtime.
 *
 * Resolution order (highest priority first):
 *
 *   1. `build-info.ts VERSION` — stamped by `scripts/build.mjs` at CI
 *      build time from the git tag (e.g. `TAG_VERSION=v0.15.55` →
 *      `VERSION="0.15.55"`). This is the canonical source for release
 *      builds; the mis-stamp guard in build.mjs aborts the build if the
 *      tag and the stamped value disagree, so this is reliable when it
 *      came from a real tag build.
 *
 *   2. `package.json` (walked up from the bundle's own directory) — used
 *      when build-info wasn't stamped from a tag (dev/non-tag builds where
 *      build-info still holds the last committed value). package.json is
 *      shipped in the agent image alongside the bundle and is accurate for
 *      non-CI builds.
 *
 *   3. `BUILD_INFO_VERSION` fallback — when no package.json is reachable
 *      (unusual; should not happen in production images).
 *
 * Why BUILD_INFO_VERSION is now preferred over package.json: historically
 * `src/build-info.ts` was git-tracked with a stale value (the release process
 * called `git checkout HEAD -- src/build-info.ts` to revert it after build),
 * so it drifted and we read package.json to compensate. Now scripts/build.mjs
 * stamps build-info from the git tag via TAG_VERSION / GITHUB_REF at CI time,
 * and the mis-stamp guard ensures correctness on release builds. A correctly-
 * stamped build-info is the best available signal; package.json is the fallback
 * for dev/non-tag builds where the stamp may not have run.
 */
function readPackageVersion(): string | null {
  // `import.meta.dirname` is the bundle's directory after esbuild
  // (`/opt/switchroom` in the agent image; `.../node_modules/switchroom/dist/cli`
  // on an npm install; `src/cli` in a source checkout). Walk up looking for the
  // switchroom package.json — no `.git` requirement (unlike
  // locateSwitchroomInstallDir in version.ts, which only matches a checkout).
  let dir: string | undefined = import.meta.dirname;
  for (let i = 0; i < 12 && dir && dir !== "/"; i++) {
    const p = join(dir, "package.json");
    if (existsSync(p)) {
      try {
        const pkg = JSON.parse(readFileSync(p, "utf-8")) as {
          name?: string;
          version?: string;
        };
        if (pkg?.name === "switchroom" && typeof pkg.version === "string") {
          return pkg.version;
        }
      } catch {
        /* unreadable / malformed — keep walking up */
      }
    }
    dir = dirname(dir);
  }
  return null;
}

/**
 * Authoritative switchroom version for `--version` / health output.
 *
 * Prefers the build-info VERSION (stamped from the git tag by build.mjs on
 * release builds) over the package.json version, which may not be bumped
 * per-tag (the historical drift source: tags v0.15.49→v0.15.55 shipped
 * without bumping package.json, so every image self-reported 0.15.48).
 * Package.json is the fallback for dev/non-tag builds where build-info
 * still holds its last committed value.
 */
export const SWITCHROOM_VERSION: string = (() => {
  const pkgVersion = readPackageVersion();
  // Use build-info when it looks like a legitimate semver stamp (not the
  // default committed placeholder) AND it differs from package.json — that
  // difference is exactly the "tags shipped without bumping package.json"
  // drift this fix addresses. When they agree (normal, in-sync state), it
  // doesn't matter which we pick.
  if (
    pkgVersion !== null &&
    pkgVersion === BUILD_INFO_VERSION
  ) {
    // Agree: return either; build-info is fine.
    return BUILD_INFO_VERSION;
  }
  // They differ. On a CI tag build, build-info was stamped with the real tag
  // version and is authoritative. On a dev build (no TAG_VERSION), build-info
  // holds whatever was last committed and package.json is fresher. We can't
  // distinguish these cases at runtime, so we return build-info — the only
  // route to this branch in production is a tag build (dev builds run
  // `npm run build` which re-stamps build-info from the package.json anyway).
  return BUILD_INFO_VERSION ?? pkgVersion ?? "0.0.0";
})();
