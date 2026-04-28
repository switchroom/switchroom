/**
 * Tests for resolveVaultReferencesViaBroker — structured return (issue #207).
 *
 * The function used to silently return the config unchanged when the broker
 * was denied or unreachable, making it impossible for callers to distinguish
 * the failure mode. It now returns a discriminated union so callers can act
 * on the specific reason.
 *
 * These tests use a real VaultBroker on a tmp socket (via _testSecrets and
 * _testIdentify) to exercise end-to-end paths without passphrase/KDF.
 *
 * Covers:
 *   - ok=true when all vault refs resolve via broker
 *   - ok=false reason="unreachable" when broker socket doesn't exist
 *   - ok=false reason="locked"  when broker is running but vault is locked
 *   - ok=false reason="denied"  when cron unit is not in ACL
 *   - ok=true when config has no vault refs (early exit)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { VaultBroker } from "./broker/server.js";
import {
  resolveVaultReferencesViaBroker,
  type ResolveViaBrokerResult,
} from "./resolver.js";
import type { SwitchroomConfig } from "../config/schema.js";
import type { VaultEntry } from "./vault.js";

const TEST_SECRETS: Record<string, VaultEntry> = {
  "api-key": { kind: "string", value: "sk-test-12345" },
  "other-key": { kind: "string", value: "other-value" },
};

function cloneSecrets(): Record<string, VaultEntry> {
  return JSON.parse(JSON.stringify(TEST_SECRETS));
}

/** Config with vault refs to keys that exist in TEST_SECRETS */
function makeConfigWithRefs(socketPath: string): SwitchroomConfig {
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "vault:api-key" },
    vault: {
      path: "~/.switchroom/vault.enc",
      broker: { socket: socketPath, enabled: true },
    },
    agents: {},
  } as unknown as SwitchroomConfig;
}

/** Config with NO vault refs */
function makeConfigNoRefs(socketPath: string): SwitchroomConfig {
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "plain-token" },
    vault: {
      path: "~/.switchroom/vault.enc",
      broker: { socket: socketPath, enabled: true },
    },
    agents: {},
  } as unknown as SwitchroomConfig;
}

/** ACL config that GRANTS access to "api-key" for myagent/cron-0 */
function makeAllowedAclConfig(socketPath: string): SwitchroomConfig {
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "vault:api-key" },
    vault: {
      path: "~/.switchroom/vault.enc",
      broker: { socket: socketPath, enabled: true },
    },
    agents: {
      myagent: { schedule: [{ secrets: ["api-key"] }] },
    },
  } as unknown as SwitchroomConfig;
}

/** ACL config that DENIES access (cron-0 only has "other-key", not "api-key") */
function makeDeniedAclConfig(socketPath: string): SwitchroomConfig {
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "vault:api-key" },
    vault: {
      path: "~/.switchroom/vault.enc",
      broker: { socket: socketPath, enabled: true },
    },
    agents: {
      myagent: { schedule: [{ secrets: ["other-key"] }] }, // NOT api-key
    },
  } as unknown as SwitchroomConfig;
}

const ALLOWED_PEER = {
  uid: process.getuid?.() ?? 1000,
  pid: 88888,
  exe: "/usr/bin/bash",
  systemdUnit: "switchroom-myagent-cron-0.service" as string | null,
};

const DENIED_PEER = {
  uid: process.getuid?.() ?? 1000,
  pid: 88889,
  exe: "/usr/bin/bash",
  systemdUnit: "switchroom-other-cron-0.service" as string | null, // not in config
};

// ── helpers ──────────────────────────────────────────────────────────────────

async function withBroker(
  opts: ConstructorParameters<typeof VaultBroker>[0],
  socketPath: string,
  fn: (broker: VaultBroker) => Promise<void>,
): Promise<void> {
  const broker = new VaultBroker(opts);
  await broker.start(socketPath, undefined, undefined);
  try {
    await fn(broker);
  } finally {
    broker.stop();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveVaultReferencesViaBroker (structured return, issue #207)", () => {
  let tmpDir: string;
  let socketPath: string;
  let prevNonLinuxFlag: string | undefined;

  beforeEach(() => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "resolver-broker-test-"));
    socketPath = path.join(tmpDir, "test.sock");
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevNonLinuxFlag === undefined) {
      delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    } else {
      process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
    }
  });

  it("returns { ok: true } with no vault refs in config (early exit)", async () => {
    // Broker doesn't even need to be running — no refs means no calls
    const config = makeConfigNoRefs(socketPath);
    const result = await resolveVaultReferencesViaBroker(config, {
      socket: socketPath,
      timeoutMs: 200,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.telegram.bot_token).toBe("plain-token");
    }
  });

  it("returns { ok: false, reason: 'unreachable' } when broker socket does not exist", async () => {
    const missingSocket = path.join(tmpDir, "nonexistent.sock");
    const config = makeConfigWithRefs(missingSocket);
    const result = await resolveVaultReferencesViaBroker(config, {
      socket: missingSocket,
      timeoutMs: 500,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("unreachable");
    }
  });

  it("returns { ok: false, reason: 'locked' } when broker is running but vault is locked", async () => {
    // Broker started without _testSecrets → secrets=null → vault is locked
    await withBroker(
      {
        _testConfig: makeAllowedAclConfig(socketPath),
        _testIdentify: () => ALLOWED_PEER,
      },
      socketPath,
      async (broker) => {
        // Confirm the broker is locked
        expect(broker.getStatus().unlocked).toBe(false);

        const config = makeAllowedAclConfig(socketPath);
        const result = await resolveVaultReferencesViaBroker(config, {
          socket: socketPath,
          timeoutMs: 1000,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("locked");
        }
      },
    );
  });

  it("returns { ok: false, reason: 'denied' } when cron unit is not in ACL", async () => {
    await withBroker(
      {
        _testSecrets: cloneSecrets(),
        _testConfig: makeDeniedAclConfig(socketPath),
        // Peer is allowed cron unit but config only grants "other-key" not "api-key"
        _testIdentify: () => ALLOWED_PEER,
      },
      socketPath,
      async () => {
        // Config requests "api-key" but schedule only grants "other-key"
        const config = makeDeniedAclConfig(socketPath);
        const result = await resolveVaultReferencesViaBroker(config, {
          socket: socketPath,
          timeoutMs: 1000,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("denied");
        }
      },
    );
  });

  it("returns { ok: true } with resolved config when broker grants access", async () => {
    await withBroker(
      {
        _testSecrets: cloneSecrets(),
        _testConfig: makeAllowedAclConfig(socketPath),
        _testIdentify: () => ALLOWED_PEER,
      },
      socketPath,
      async () => {
        const config = makeAllowedAclConfig(socketPath);
        const result = await resolveVaultReferencesViaBroker(config, {
          socket: socketPath,
          timeoutMs: 1000,
        });
        expect(result.ok).toBe(true);
        if (result.ok) {
          // vault:api-key should have been replaced with the actual secret
          expect(result.config.telegram.bot_token).toBe("sk-test-12345");
        }
      },
    );
  });

  it("returns { ok: false, reason: 'denied' } when peer is not a recognised cron unit", async () => {
    await withBroker(
      {
        _testSecrets: cloneSecrets(),
        _testConfig: makeAllowedAclConfig(socketPath),
        // Peer is a cron unit NOT listed in config agents
        _testIdentify: () => DENIED_PEER,
      },
      socketPath,
      async () => {
        const config = makeAllowedAclConfig(socketPath);
        const result = await resolveVaultReferencesViaBroker(config, {
          socket: socketPath,
          timeoutMs: 1000,
        });
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.reason).toBe("denied");
        }
      },
    );
  });
});
