/**
 * Tests for the vault-broker durability section — the new doctor
 * probes that catch deployment-shape regressions in the broker
 * bind-mount + auto-unlock chain.
 *
 * Each test pins the verdict shape for one regression class. The
 * inode-equality probe injects mock stat functions so we don't
 * need a real broker container; the broker-unlocked probe injects
 * a status function for the same reason.
 *
 * Coverage map (cross-reference to the wedge cluster this session):
 *
 *   - "broker unlocked (state)" → catches the v0.13.27 wedge class
 *     IF the broker had been silently locked. (In practice the
 *     wedge let the broker stay unlocked; that probe is
 *     belt-and-braces.)
 *   - "vault-grants.db inode-equality" → catches the v0.13.32
 *     regression class deterministically.
 *   - "vault-audit.log inode-equality" → catches the equivalent
 *     #1025 regression class.
 *   - "auto-unlock blob present" → catches operator-config
 *     drift (forgot to run `enable-auto-unlock`).
 *   - "machine-id passthrough" → catches the broker boot error
 *     "Cannot derive machine-bound key".
 */

import { describe, expect, it } from "vitest";

import {
  probeBindMountInode,
  formatBindMountResult,
  probeBrokerUnlocked,
  type BindMountStatResult,
} from "./doctor-vault-broker-durability.js";

describe("probeBindMountInode — inode-equality bind-mount probe", () => {
  it("returns ok when host and broker inodes + sizes match", () => {
    const r = probeBindMountInode("/host/path", "/broker/path", {
      statHost: () => ({ ino: 12345n, size: 57344 }),
      statBroker: () => ({ kind: "ok-with-stat", ino: "12345", size: 57344 }) as never,
    });
    expect(r.kind).toBe("ok");
  });

  it("returns mismatch when inodes differ (the regression class)", () => {
    const r = probeBindMountInode("/host/path", "/broker/path", {
      statHost: () => ({ ino: 12345n, size: 57344 }),
      // Different inode means the broker is operating on its
      // container-local ephemeral file, not the bind-mounted host
      // file. This is exactly the v0.13.32 grants-DB regression.
      statBroker: () => ({ kind: "ok-with-stat", ino: "99999", size: 4096 }) as never,
    });
    expect(r.kind).toBe("mismatch");
    if (r.kind === "mismatch") {
      expect(r.hostInode).toBe("12345");
      expect(r.brokerInode).toBe("99999");
      expect(r.hostSize).toBe(57344);
      expect(r.brokerSize).toBe(4096);
    }
  });

  it("returns host-missing when the host file is absent", () => {
    const r = probeBindMountInode("/host/path", "/broker/path", {
      statHost: () => null,
      statBroker: () =>
        ({ kind: "ok-with-stat", ino: "1", size: 0 }) as never,
    });
    expect(r.kind).toBe("host-missing");
  });

  it("returns broker-unreachable when docker exec fails", () => {
    const r = probeBindMountInode("/host/path", "/broker/path", {
      statHost: () => ({ ino: 1n, size: 0 }),
      statBroker: () => ({ kind: "broker-unreachable" }),
    });
    expect(r.kind).toBe("broker-unreachable");
  });
});

describe("formatBindMountResult — verdict shapes", () => {
  it("ok → status ok with same-inode detail", () => {
    const r = formatBindMountResult(
      "probe",
      "/h",
      "/b",
      { kind: "ok" } as BindMountStatResult,
    );
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("same inode");
  });

  it("mismatch → status fail with both inodes in detail + fix hint", () => {
    const r = formatBindMountResult(
      "probe",
      "/h",
      "/b",
      {
        kind: "mismatch",
        hostInode: "111",
        brokerInode: "222",
        hostSize: 100,
        brokerSize: 50,
      } as BindMountStatResult,
    );
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("111");
    expect(r.detail).toContain("222");
    // Operator-facing diagnostic must name the failure mode they
    // see in production: ephemeral container-local file.
    expect(r.detail).toContain("ephemeral");
    expect(r.fix).toContain("apply");
  });

  it("host-missing → status warn (apply hasn't run yet)", () => {
    const r = formatBindMountResult(
      "probe",
      "/h",
      "/b",
      { kind: "host-missing", hostPath: "/h" } as BindMountStatResult,
    );
    expect(r.status).toBe("warn");
  });

  it("broker-unreachable → status skip (don't false-fail)", () => {
    const r = formatBindMountResult(
      "probe",
      "/h",
      "/b",
      { kind: "broker-unreachable" } as BindMountStatResult,
    );
    expect(r.status).toBe("skip");
  });

  it("broker-stat-failed → status warn with broker error", () => {
    const r = formatBindMountResult(
      "probe",
      "/h",
      "/b",
      {
        kind: "broker-stat-failed",
        msg: "stat: cannot stat '/b': No such file",
      } as BindMountStatResult,
    );
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("No such file");
  });
});

describe("probeBrokerUnlocked — runtime state, not just config", () => {
  it("ok when broker reports unlocked + key count", () => {
    const r = probeBrokerUnlocked({
      statusProbe: () => ({ unlocked: true, keyCount: 78 }),
    });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("78");
  });

  it("fail when broker reports locked (the silent-auto-unlock-failure class)", () => {
    const r = probeBrokerUnlocked({
      statusProbe: () => ({ unlocked: false, keyCount: 0 }),
    });
    expect(r.status).toBe("fail");
    // Operator-facing diagnostic must name the most common causes
    // so the fix message lands without further investigation.
    expect(r.detail).toMatch(/machine-id|blob|passphrase/);
    expect(r.fix).toContain("enable-auto-unlock");
  });

  it("skip when broker container unreachable", () => {
    const r = probeBrokerUnlocked({
      statusProbe: () => null,
    });
    expect(r.status).toBe("skip");
  });
});
