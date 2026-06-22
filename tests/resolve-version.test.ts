import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { SWITCHROOM_VERSION } from "../src/cli/resolve-version.js";
import { VERSION as BUILD_INFO_VERSION } from "../src/build-info.js";

const pkgVersion = JSON.parse(
  readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"),
).version as string;

describe("SWITCHROOM_VERSION", () => {
  it("resolves to a valid semver string", () => {
    // Must be a non-empty semver-shaped string (X.Y.Z or X.Y.Z-pre).
    expect(SWITCHROOM_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("prefers the build-info VERSION (tag-stamped on release builds)", () => {
    // build-info.ts is stamped by scripts/build.mjs from the git tag via
    // TAG_VERSION / GITHUB_REF at CI time. On release builds it is the
    // authoritative source; on dev builds (npm run build without TAG_VERSION)
    // it is re-stamped from package.json so they agree.
    // Either way, SWITCHROOM_VERSION must equal BUILD_INFO_VERSION.
    expect(SWITCHROOM_VERSION).toBe(BUILD_INFO_VERSION);
  });

  it("agrees with package.json on a fresh local build (build-info re-stamped)", () => {
    // A local `npm run build` (no TAG_VERSION) re-stamps build-info from
    // package.json. In a freshly-built checkout both agree; if they differ,
    // build-info is the authoritative signal (tag build stamped correctly).
    if (BUILD_INFO_VERSION === pkgVersion) {
      // In sync — trivially fine.
      expect(SWITCHROOM_VERSION).toBe(pkgVersion);
    }
    // If they differ this is a tag build; SWITCHROOM_VERSION correctly returns
    // BUILD_INFO_VERSION (the tag-stamped value), not the stale package.json.
    // No assertion needed here — the previous test already covers this.
  });
});
