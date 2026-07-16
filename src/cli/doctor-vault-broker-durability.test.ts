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
  probeKernelDbDurability,
  probeGrantsWalDivergence,
  probeOrphanVaultTokens,
  type BindMountStatResult,
  type BrokerStatResult,
  type BrokerFileStat,
} from "./doctor-vault-broker-durability.js";
import { GRANTS_DB_CONTAINER_PATH } from "../vault/grants-db-path.js";
import type { SwitchroomConfig } from "../config/schema.js";

function fakeConfig(agents: string[]): SwitchroomConfig {
  const map: Record<string, unknown> = {};
  for (const a of agents) map[a] = {};
  return { agents: map } as unknown as SwitchroomConfig;
}

describe("probeBindMountInode — inode-equality bind-mount probe", () => {
  it("returns ok when host and broker inodes + sizes match", () => {
    const r = probeBindMountInode("/host/path", "/broker/path", {
      statHost: () => ({ ino: 12345n, size: 57344 }),
      statBroker: (): BrokerStatResult => ({
        kind: "ok-with-stat",
        ino: "12345",
        size: 57344,
      }),
    });
    expect(r.kind).toBe("ok");
  });

  it("returns mismatch when inodes differ (the regression class)", () => {
    const r = probeBindMountInode("/host/path", "/broker/path", {
      statHost: () => ({ ino: 12345n, size: 57344 }),
      // Different inode means the broker is operating on its
      // container-local ephemeral file, not the bind-mounted host
      // file. This is exactly the v0.13.32 grants-DB regression.
      statBroker: (): BrokerStatResult => ({
        kind: "ok-with-stat",
        ino: "99999",
        size: 4096,
      }),
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
      statBroker: (): BrokerStatResult => ({
        kind: "ok-with-stat",
        ino: "1",
        size: 0,
      }),
    });
    expect(r.kind).toBe("host-missing");
  });

  it("returns broker-unreachable when docker exec fails", () => {
    const r = probeBindMountInode("/host/path", "/broker/path", {
      statHost: () => ({ ino: 1n, size: 0 }),
      statBroker: (): BrokerStatResult => ({ kind: "broker-unreachable" }),
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

describe("probeKernelDbDurability — approval-kernel approvals bind mount", () => {
  // The probe targets the directory (/state/approvals host<->container)
  // rather than the kernel.db file, because kernel.db is created lazily
  // on the first allow_always decision. Directory inode equality is the
  // robust signal that the compose bind mount is wired correctly.

  const home = "/home/operator";

  it("ok when host dir and kernel dir inodes match (mount wired)", () => {
    const r = probeKernelDbDurability(home, {
      statHost: () => ({ ino: 55555n, size: 4096 }),
      statBroker: (): BrokerStatResult => ({
        kind: "ok-with-stat",
        ino: "55555",
        size: 4096,
      }),
    });
    expect(r.status).toBe("ok");
    expect(r.name).toContain("approval-kernel");
    expect(r.name).toContain("allow_always");
    expect(r.detail).toContain("allow_always decisions persist");
  });

  it("fail when inodes differ (mount not wired — the ephemerality regression)", () => {
    // Different inode means the kernel is operating on an ephemeral
    // container-local directory — the regression class this probe catches.
    const r = probeKernelDbDurability(home, {
      statHost: () => ({ ino: 11111n, size: 4096 }),
      statBroker: (): BrokerStatResult => ({
        kind: "ok-with-stat",
        ino: "99999",
        size: 4096,
      }),
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("ephemeral");
    expect(r.detail).toContain("allow_always");
    // Remediation hint must name the fix: apply + kernel recreate.
    expect(r.fix).toContain("switchroom apply");
    expect(r.fix).toContain("approval-kernel");
  });

  it("skip when kernel container is not running (empty fleet, not broken)", () => {
    const r = probeKernelDbDurability(home, {
      statHost: () => ({ ino: 1n, size: 4096 }),
      statBroker: (): BrokerStatResult => ({ kind: "broker-unreachable" }),
    });
    expect(r.status).toBe("skip");
    expect(r.detail).toContain("approval-kernel");
    expect(r.detail).toContain("unreachable");
  });

  it("warn when host approvals directory is absent (apply hasn't run yet)", () => {
    // host-missing → warn, not fail. Directory is pre-created by
    // `switchroom apply`; missing means apply hasn't run on this install yet.
    const r = probeKernelDbDurability(home, {
      statHost: () => null,
      statBroker: (): BrokerStatResult => ({
        kind: "ok-with-stat",
        ino: "1",
        size: 4096,
      }),
    });
    expect(r.status).toBe("warn");
    expect(r.fix).toContain("switchroom apply");
  });

  it("warn on transient docker exec error (no false fail)", () => {
    // broker-stat-failed degrades to warn, not fail — no false alarms
    // when docker exec has a transient error.
    const r = probeKernelDbDurability(home, {
      statHost: () => ({ ino: 1n, size: 4096 }),
      statBroker: (): BrokerStatResult => ({
        kind: "broker-stat-failed",
        msg: "permission denied",
      }),
    });
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("approval-kernel stat failed");
    expect(r.detail).toContain("permission denied");
  });

  it("probe name clearly identifies the allow_always durability concern", () => {
    const r = probeKernelDbDurability(home, {
      statHost: () => ({ ino: 1n, size: 4096 }),
      statBroker: (): BrokerStatResult => ({ kind: "broker-unreachable" }),
    });
    expect(r.name).toContain("approval-kernel");
    expect(r.name).toContain("allow_always");
  });
});

describe("probeGrantsWalDivergence — WAL checkpoint state (#3289)", () => {
  const main = GRANTS_DB_CONTAINER_PATH;
  const wal = `${main}-wal`;

  it("skips when the broker container is unreachable", () => {
    const r = probeGrantsWalDivergence(() => ({ kind: "unreachable" }));
    expect(r.status).toBe("skip");
  });

  it("ok when there is no grants DB yet (empty fleet)", () => {
    const r = probeGrantsWalDivergence((p) =>
      p === main ? { kind: "missing" } : { kind: "missing" },
    );
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("no grants DB");
  });

  it("ok when the -wal sidecar is absent (fully checkpointed)", () => {
    const r = probeGrantsWalDivergence((p) =>
      p === main
        ? { kind: "ok", mtime: 1000, size: 4096 }
        : { kind: "missing" },
    );
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("no -wal sidecar");
  });

  it("ok when the -wal is present but truncated to 0 bytes", () => {
    const r = probeGrantsWalDivergence((p) =>
      p === main
        ? { kind: "ok", mtime: 1000, size: 4096 }
        : { kind: "ok", mtime: 1200, size: 0 },
    );
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("truncated");
  });

  it("warns when a NON-empty -wal is newer than the main DB (un-checkpointed grants)", () => {
    const r = probeGrantsWalDivergence((p) =>
      p === main
        ? { kind: "ok", mtime: 1000, size: 4096 }
        : { kind: "ok", mtime: 2000, size: 32768 },
    );
    expect(r.status).toBe("warn");
    expect(r.detail).toContain("un-checkpointed");
    expect(r.fix).toBeTruthy();
  });

  it("ok when a non-empty -wal is NOT newer than main", () => {
    const r = probeGrantsWalDivergence((p): BrokerFileStat =>
      p === wal
        ? { kind: "ok", mtime: 500, size: 32768 }
        : { kind: "ok", mtime: 1000, size: 4096 },
    );
    expect(r.status).toBe("ok");
  });
});

describe("probeOrphanVaultTokens — #1737 / #3289 orphan-token detector", () => {
  it("ok when no agent holds a vault-token", () => {
    const r = probeOrphanVaultTokens(fakeConfig(["a", "b"]), {
      readTokenId: () => null,
    });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("nothing to orphan-check");
  });

  it("ok when every token references a live grant row", () => {
    const r = probeOrphanVaultTokens(fakeConfig(["a", "b"]), {
      readTokenId: (agent) => `vg_${agent}id`,
      grantIdExists: () => true,
    });
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("all reference a live grant");
  });

  it("FAILS when a token references a grant id absent from the DB", () => {
    const r = probeOrphanVaultTokens(fakeConfig(["clerk"]), {
      readTokenId: () => "vg_5e1991",
      grantIdExists: (id) => id !== "vg_5e1991",
    });
    expect(r.status).toBe("fail");
    expect(r.detail).toContain("clerk=vg_5e1991");
    expect(r.detail).toContain("DENIES");
  });

  it("skips when the grants DB can't be read on the host", () => {
    const r = probeOrphanVaultTokens(fakeConfig(["a"]), {
      readTokenId: () => "vg_x",
      grantIdExists: () => null,
    });
    expect(r.status).toBe("skip");
  });
});
