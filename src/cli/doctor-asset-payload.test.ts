/**
 * `switchroom doctor` × the shipped-asset payload (#4163).
 *
 * The outcomes that matter: a static-binary install with a missing or skewed
 * payload goes RED (it cannot scaffold, or scaffolds from the wrong release),
 * and a contributor's checkout does NOT — the assets are inside the package
 * there and there is no payload to verify.
 */

import { describe, it, expect } from "vitest";
import { runAssetPayloadChecks } from "./doctor-asset-payload.js";

const BUNFS = "/$bunfs/root";
const SEA = { bundleDir: BUNFS, execPath: "/usr/local/bin/switchroom", env: {} };
const SHARE = "/usr/local/share/switchroom";

describe("runAssetPayloadChecks", () => {
  it("is OK when the payload matches the running CLI", () => {
    const [r] = runAssetPayloadChecks({
      cliVersion: "0.19.44",
      probe: { ...SEA, exists: (p) => p.startsWith(SHARE) },
      readText: () => '{"version":"v0.19.44"}',
    });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("v0.19.44");
  });

  it("FAILS on skew — the failure that otherwise looks like a working install", () => {
    const [r] = runAssetPayloadChecks({
      cliVersion: "0.19.44",
      probe: { ...SEA, exists: (p) => p.startsWith(SHARE) },
      readText: () => '{"version":"v0.19.28"}',
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("v0.19.28");
    expect(r.fix).toBe("switchroom update");
  });

  it("FAILS when nothing was installed at all", () => {
    const [r] = runAssetPayloadChecks({
      cliVersion: "0.19.44",
      probe: { ...SEA, exists: () => false },
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("no shipped-asset payload");
    expect(r.fix).toBe("switchroom update");
  });

  it("FAILS when the manifest is unreadable rather than assuming agreement", () => {
    const [r] = runAssetPayloadChecks({
      cliVersion: "0.19.44",
      probe: { ...SEA, exists: (p) => p.startsWith(SHARE) },
      readText: () => "{ truncated",
    });
    expect(r.status).toBe("fail");
  });

  it("SKIPS for an npm/dev install — assets ship inside the package, no manifest", () => {
    // Getting this wrong would leave doctor permanently red for every
    // contributor, which is how a check stops being read.
    const [r] = runAssetPayloadChecks({
      cliVersion: "0.19.44",
      probe: {
        bundleDir: "/srv/switchroom/dist/cli",
        execPath: "/usr/bin/node",
        env: {},
        exists: (p) => p === "/srv/switchroom/profiles",
      },
    });
    expect(r.status).toBe("skip");
    expect(r.detail).toContain("/srv/switchroom/profiles");
  });

  it("SKIPS inside the agent/hostd Docker image", () => {
    const [r] = runAssetPayloadChecks({
      cliVersion: "0.19.44",
      probe: {
        bundleDir: "/opt/switchroom",
        execPath: "/usr/bin/node",
        env: {},
        exists: (p) => p === "/opt/switchroom/profiles",
      },
    });
    expect(r.status).toBe("skip");
  });

  it("SKIPS when an operator has pointed SWITCHROOM_PROFILES_ROOT somewhere", () => {
    const [r] = runAssetPayloadChecks({
      cliVersion: "0.19.44",
      probe: {
        ...SEA,
        env: { SWITCHROOM_PROFILES_ROOT: "/srv/custom/profiles" },
        exists: () => false,
      },
    });
    expect(r.status).toBe("skip");
  });
});
