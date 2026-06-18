import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { VERSION as BUILD_INFO_VERSION } from "../build-info.js";

/**
 * The displayed switchroom version, resolved at runtime from the shipped
 * `package.json` (authoritative) with the compiled build-info `VERSION` as a
 * fallback.
 *
 * Why not just build-info `VERSION`: `src/build-info.ts` is git-tracked and the
 * release process reverts it (`git checkout HEAD -- src/build-info.ts`), so the
 * committed value drifts (it was `0.15.3` in the v0.15.40 tree). The agent
 * image COPYs a prebuilt `dist/cli/switchroom.js`, and a stale build-info baked
 * into that bundle — or a build-cache layer serving an older dist — made
 * `switchroom --version` report the wrong release in-container (v0.15.40 image
 * reported 0.15.39, 2026-06-18). `package.json` is the single source of truth
 * (npm publish always includes it; the agent image COPYs it next to the
 * bundle), so we read it from the bundle's own directory tree first and only
 * fall back to the baked constant when no package.json is reachable.
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

/** Authoritative switchroom version for `--version` / health output. */
export const SWITCHROOM_VERSION: string =
  readPackageVersion() ?? BUILD_INFO_VERSION;
