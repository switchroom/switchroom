/**
 * KEN-131 (stage 3 of KEN-128) — auto-update release check + watcher-mode
 * resolution. Pure decision logic with stubbed fetch / config / image
 * probes; no docker, no network.
 */

import { describe, it, expect, vi } from "vitest";
import {
  makeAutoUpdateCheck,
  resolveReleaseWatcherMode,
  versionedImageRef,
} from "../../src/host-control/auto-update-check.js";

const IMAGE = "ghcr.io/switchroom/switchroom-agent:latest";

function makeCheck(opts: {
  latest?: string;
  pin?: string | undefined;
  imageExists?: boolean;
}) {
  const imageExists = vi.fn(async () => opts.imageExists ?? true);
  const check = makeAutoUpdateCheck({
    imageRef: IMAGE,
    getCurrentPin: () => opts.pin,
    fetchLatestVersion: async () => opts.latest ?? "1.2.3",
    imageExists,
    log: () => {},
  });
  return { check, imageExists };
}

describe("versionedImageRef", () => {
  it("replaces the tag", () => {
    expect(versionedImageRef(IMAGE, "v1.2.3")).toBe(
      "ghcr.io/switchroom/switchroom-agent:v1.2.3",
    );
  });
  it("appends when no tag present", () => {
    expect(versionedImageRef("ghcr.io/x/y", "v1.2.3")).toBe("ghcr.io/x/y:v1.2.3");
  });
  it("does not mistake a registry port for a tag", () => {
    expect(versionedImageRef("reg.local:5000/x/y:latest", "v9.9.9")).toBe(
      "reg.local:5000/x/y:v9.9.9",
    );
  });
});

describe("makeAutoUpdateCheck", () => {
  it("reports available with the vX.Y.Z target when latest is newer than the pin", async () => {
    const { check } = makeCheck({ latest: "1.2.3", pin: "v1.2.2" });
    await expect(check()).resolves.toEqual({ available: true, version: "v1.2.3" });
  });

  it("is NOT available when the pin already equals latest (quiesces after a green roll)", async () => {
    const { check } = makeCheck({ latest: "1.2.3", pin: "v1.2.3" });
    await expect(check()).resolves.toMatchObject({ available: false });
  });

  it("is NOT available on a downgrade (pin newer than published)", async () => {
    const { check } = makeCheck({ latest: "1.2.3", pin: "v1.3.0" });
    await expect(check()).resolves.toMatchObject({ available: false });
  });

  it("never fights an explicit non-semver (sha) pin", async () => {
    const { check } = makeCheck({ latest: "1.2.3", pin: "sha-abcdef1" });
    await expect(check()).resolves.toMatchObject({ available: false });
  });

  it("bootstraps when no pin exists yet", async () => {
    const { check } = makeCheck({ latest: "1.2.3", pin: undefined });
    await expect(check()).resolves.toEqual({ available: true, version: "v1.2.3" });
  });

  it("defers when the vX.Y.Z image is not pullable yet (publish beat the image build)", async () => {
    const { check, imageExists } = makeCheck({
      latest: "1.2.3",
      pin: "v1.2.2",
      imageExists: false,
    });
    await expect(check()).resolves.toMatchObject({ available: false });
    expect(imageExists).toHaveBeenCalledWith(
      "ghcr.io/switchroom/switchroom-agent:v1.2.3",
    );
  });

  it("does not even probe the image when nothing is newer", async () => {
    const { check, imageExists } = makeCheck({ latest: "1.2.3", pin: "v1.2.3" });
    await check();
    expect(imageExists).not.toHaveBeenCalled();
  });

  it("propagates a fetch failure (watcher surfaces it as check_failed)", async () => {
    const check = makeAutoUpdateCheck({
      imageRef: IMAGE,
      getCurrentPin: () => "v1.0.0",
      fetchLatestVersion: async () => {
        throw new Error("registry down");
      },
      imageExists: async () => true,
    });
    await expect(check()).rejects.toThrow("registry down");
  });
});

describe("resolveReleaseWatcherMode", () => {
  it("is OFF by default — no release block, no host_control block", () => {
    expect(resolveReleaseWatcherMode({})).toEqual({ mode: "off" });
  });

  it("is OFF with a release block that does not set auto_update (default-off, behaviour unchanged)", () => {
    expect(
      resolveReleaseWatcherMode({ release: { pin: "v1.2.3" } as never }),
    ).toEqual({ mode: "off" });
    expect(
      resolveReleaseWatcherMode({ release: { auto_update: false } }),
    ).toEqual({ mode: "off" });
  });

  it("selects auto_update when release.auto_update is true", () => {
    expect(
      resolveReleaseWatcherMode({ release: { auto_update: true } }),
    ).toEqual({ mode: "auto_update" });
  });

  it("keeps the legacy #1743 watcher when only auto_release_check is enabled", () => {
    expect(
      resolveReleaseWatcherMode({
        host_control: { auto_release_check: { enabled: true } },
      }),
    ).toEqual({ mode: "legacy" });
  });

  it("auto_update wins when both knobs are set (safer pipeline)", () => {
    expect(
      resolveReleaseWatcherMode({
        release: { auto_update: true },
        host_control: { auto_release_check: { enabled: true } },
      }),
    ).toEqual({ mode: "auto_update" });
  });
});
