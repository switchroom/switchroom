/**
 * Tests for captureHostTimezone() and renderHostdComposeFile() timezone
 * injection (SWITCHROOM_HOST_TZ baking).
 *
 * These are the unit-level coverage for the "host TZ captured at install
 * time and baked into hostd env" fix. The integration path (fresh-install
 * → apply → correct zone in compose) is verified end-to-end in the
 * docker/hostd-e2e.test.ts suite; here we pin the contract at the pure-
 * function level.
 */

import { describe, it, expect } from "vitest";
import {
  captureHostTimezone,
  renderHostdComposeFile,
} from "../src/cli/hostd.js";

describe("captureHostTimezone", () => {
  it("reads /etc/timezone when present", () => {
    const tz = captureHostTimezone({
      env: {},
      readEtcTimezone: () => "Australia/Melbourne",
      readLocaltimeLink: () => "/usr/share/zoneinfo/Etc/UTC",
    });
    expect(tz).toBe("Australia/Melbourne");
  });

  it("falls back to /etc/localtime symlink when /etc/timezone is absent", () => {
    const tz = captureHostTimezone({
      env: {},
      readEtcTimezone: () => undefined,
      readLocaltimeLink: () => "/usr/share/zoneinfo/Europe/London",
    });
    expect(tz).toBe("Europe/London");
  });

  it("returns undefined when /etc/timezone is absent and /etc/localtime → container default", () => {
    // Host with no tzdata — extremely rare but possible (CI minimal image).
    const tz = captureHostTimezone({
      env: {},
      readEtcTimezone: () => undefined,
      readLocaltimeLink: () => undefined,
    });
    expect(tz).toBeUndefined();
  });

  it("ignores any pre-existing SWITCHROOM_HOST_TZ in the caller env", () => {
    // captureHostTimezone always passes env:{} to detectServerTimezone so a
    // stale SWITCHROOM_HOST_TZ from a previous run does not short-circuit the
    // real host probes.
    const tz = captureHostTimezone({
      // NOTE: we do NOT pass env here — the default {} suppresses process.env.
      readEtcTimezone: () => "Asia/Tokyo",
      readLocaltimeLink: () => "/usr/share/zoneinfo/Etc/UTC",
    });
    expect(tz).toBe("Asia/Tokyo");
  });

  it("returns undefined when /etc/localtime → Etc/UTC and no /etc/timezone (container default)", () => {
    // The key scenario: a Debian base image container with no tzdata
    // shows /etc/localtime → Etc/UTC. We must NOT treat this as a signal.
    const tz = captureHostTimezone({
      env: {},
      readEtcTimezone: () => undefined,
      readLocaltimeLink: () => "/usr/share/zoneinfo/Etc/UTC",
    });
    expect(tz).toBeUndefined();
  });

  it("accepts three-segment IANA zones from /etc/localtime", () => {
    const tz = captureHostTimezone({
      env: {},
      readEtcTimezone: () => undefined,
      readLocaltimeLink: () => "/usr/share/zoneinfo/America/Argentina/Buenos_Aires",
    });
    expect(tz).toBe("America/Argentina/Buenos_Aires");
  });
});

describe("renderHostdComposeFile — SWITCHROOM_HOST_TZ injection", () => {
  function render(hostTz: string | undefined) {
    return renderHostdComposeFile({
      hostHome: "/home/op",
      imageTag: "latest",
      hostTz,
    });
  }

  it("injects SWITCHROOM_HOST_TZ when hostTz is provided", () => {
    const yaml = render("Australia/Melbourne");
    expect(yaml).toContain("SWITCHROOM_HOST_TZ: \"Australia/Melbourne\"");
  });

  it("omits SWITCHROOM_HOST_TZ when hostTz is undefined", () => {
    const yaml = render(undefined);
    expect(yaml).not.toContain("SWITCHROOM_HOST_TZ");
  });

  it("injects SWITCHROOM_HOST_TZ after SWITCHROOM_CONFIG, before PATH", () => {
    const yaml = render("America/New_York");
    const configIdx = yaml.indexOf("SWITCHROOM_CONFIG:");
    const hostTzIdx = yaml.indexOf("SWITCHROOM_HOST_TZ:");
    const pathIdx = yaml.indexOf("PATH:");
    expect(configIdx).toBeGreaterThan(0);
    expect(hostTzIdx).toBeGreaterThan(configIdx);
    expect(pathIdx).toBeGreaterThan(hostTzIdx);
  });

  it("still emits SWITCHROOM_HOST_HOME even when hostTz is provided", () => {
    const yaml = render("Australia/Melbourne");
    expect(yaml).toContain("SWITCHROOM_HOST_HOME: /home/op");
  });

  it("handles three-segment IANA zones without escaping issues", () => {
    const yaml = render("America/Argentina/Buenos_Aires");
    expect(yaml).toContain("SWITCHROOM_HOST_TZ: \"America/Argentina/Buenos_Aires\"");
  });
});
