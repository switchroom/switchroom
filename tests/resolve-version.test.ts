import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { SWITCHROOM_VERSION } from "../src/cli/resolve-version.js";
import { VERSION as BUILD_INFO_VERSION } from "../src/build-info.js";

const pkgVersion = JSON.parse(
  readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"),
).version as string;

describe("SWITCHROOM_VERSION", () => {
  it("resolves to the authoritative package.json version", () => {
    // resolve-version walks up from its own dir (src/cli) to the repo
    // package.json — so the displayed version tracks package.json, not the
    // (frequently stale, git-reverted) build-info constant.
    expect(SWITCHROOM_VERSION).toBe(pkgVersion);
  });

  it("does NOT silently report a stale build-info VERSION when they differ", () => {
    // Regression for the v0.15.40 image reporting 0.15.39 (build-info lagged
    // package.json). If build-info has drifted from package.json, the resolved
    // version must follow package.json, not build-info.
    if (BUILD_INFO_VERSION !== pkgVersion) {
      expect(SWITCHROOM_VERSION).toBe(pkgVersion);
      expect(SWITCHROOM_VERSION).not.toBe(BUILD_INFO_VERSION);
    } else {
      // build-info happens to match (fresh build) — both agree, trivially fine.
      expect(SWITCHROOM_VERSION).toBe(BUILD_INFO_VERSION);
    }
  });
});
