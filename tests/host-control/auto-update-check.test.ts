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
  channel?: string | undefined;
  latchedPin?: string | null;
  imageExists?: boolean;
}) {
  const imageExists = vi.fn(async () => opts.imageExists ?? true);
  const logs: string[] = [];
  const check = makeAutoUpdateCheck({
    imageRef: IMAGE,
    getCurrentPin: () => opts.pin,
    getCurrentChannel: () => opts.channel,
    getLatchedPin: () => opts.latchedPin ?? null,
    fetchLatestVersion: async () => opts.latest ?? "1.2.3",
    imageExists,
    log: (m) => logs.push(m),
  });
  return { check, imageExists, logs };
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

  // Persisting a pin DELETES release.channel (schema mutual exclusion), so
  // an unattended roll on a dev/rc fleet would silently move it to stable
  // AND erase the operator's channel choice. Suppress instead.
  it("never rolls unattended while a non-latest release.channel is set", async () => {
    for (const channel of ["dev", "rc"]) {
      const { check, imageExists } = makeCheck({
        latest: "1.2.3",
        pin: undefined,
        channel,
      });
      await expect(check()).resolves.toEqual({
        available: false,
        version: "v1.2.3",
      });
      expect(imageExists).not.toHaveBeenCalled();
    }
  });

  it("channel: latest does not suppress (it is what the auto-update path tracks)", async () => {
    const { check } = makeCheck({
      latest: "1.2.3",
      pin: undefined,
      channel: "latest",
    });
    await expect(check()).resolves.toEqual({
      available: true,
      version: "v1.2.3",
    });
  });

  // Without this the pin never advances after a failed roll, so every tick
  // re-reports "available", re-enters applyFn, is refused by the latch, and
  // appends another apply_failed telemetry row — forever.
  it("does not re-report a LATCHED failed version as available", async () => {
    const { check, imageExists } = makeCheck({
      latest: "1.2.3",
      pin: "v1.2.2",
      latchedPin: "v1.2.3",
    });
    await expect(check()).resolves.toEqual({
      available: false,
      version: "v1.2.3",
    });
    expect(imageExists).not.toHaveBeenCalled();
  });

  it("a latch on an OLDER version does not block a newer release", async () => {
    const { check } = makeCheck({
      latest: "1.2.4",
      pin: "v1.2.2",
      latchedPin: "v1.2.3",
    });
    await expect(check()).resolves.toEqual({
      available: true,
      version: "v1.2.4",
    });
  });

  it("logs an indefinite suppression reason ONCE, not on every tick", async () => {
    const { check, logs } = makeCheck({
      latest: "1.2.3",
      pin: undefined,
      channel: "dev",
    });
    await check();
    await check();
    await check();
    expect(logs.filter((m) => m.includes("release.channel"))).toHaveLength(1);
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
