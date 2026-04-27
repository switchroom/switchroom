/**
 * Integration test: broker client round-trip.
 *
 * Starts a real broker with seeded in-memory secrets on a tmp socket and
 * exercises the client's status / get / lock paths.
 *
 * Note: On Linux, peercred ACL kicks in and the test process (not a
 * recognized cron unit) will be denied for `get`. That is the broker's
 * intended behavior — interactive callers don't go through the broker;
 * they use `switchroom vault get --no-broker` (or auto-fallback).
 * See issue #129. On non-Linux, the broker has no peercred and serves
 * any same-user caller, so the round-trip succeeds.
 */

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { VaultBroker } from "../vault/broker/server.js";
import type { VaultEntry } from "../vault/vault.js";

const TEST_SECRETS: Record<string, VaultEntry> = {
  my_token: { kind: "string", value: "super-secret-value" },
};

function makeBrokerConfig(socketPath: string) {
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "test", forum_chat_id: "123" },
    vault: {
      path: "~/.switchroom/vault.enc",
      broker: {
        socket: socketPath,
        enabled: true,
      },
    },
    agents: {},
  } as any;
}

describe("vault get → broker integration", () => {
  let broker: VaultBroker;
  let tmpDir: string;
  let socketPath: string;
  let prevNonLinuxFlag: string | undefined;

  beforeAll(async () => {
    // The broker is Linux-only by design (issue #129); opt into the
    // non-Linux dev escape hatch so this test can boot a broker on
    // whatever the runner happens to be. No-op on Linux.
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-int-test-"));
    socketPath = path.join(tmpDir, "test-data.sock");

    broker = new VaultBroker({
      _testSecrets: { ...TEST_SECRETS },
      _testConfig: makeBrokerConfig(socketPath),
    });
    await broker.start(socketPath, undefined, undefined);
  });

  afterAll(() => {
    broker.stop();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch { /* ignore */ }
    if (prevNonLinuxFlag === undefined) {
      delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    } else {
      process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
    }
  });

  it("broker is reachable and reports unlocked status", async () => {
    const { statusViaBroker } = await import("../vault/broker/client.js");
    const status = await statusViaBroker({ socket: socketPath });
    expect(status).not.toBeNull();
    expect(status?.unlocked).toBe(true);
    expect(status?.keyCount).toBe(1);
  });

  it("getViaBroker returns the secret value (or null on Linux ACL deny)", async () => {
    const { getViaBroker } = await import("../vault/broker/client.js");
    const entry = await getViaBroker("my_token", { socket: socketPath });
    if (process.platform !== "linux") {
      // No peercred on non-Linux: the broker serves any same-user caller,
      // so the round-trip succeeds and we get the seeded value back.
      expect(entry).not.toBeNull();
      expect(entry?.kind).toBe("string");
      if (entry?.kind === "string") {
        expect(entry.value).toBe("super-secret-value");
      }
    } else {
      // Linux: peercred identifies us as not-a-cron-unit, ACL denies.
      // Correct behavior — interactive callers are expected to use
      // `switchroom vault get --no-broker`. See issue #129.
      expect(entry).toBeNull();
    }
  });

  it("lockViaBroker returns true and vault becomes locked", async () => {
    // Reset broker to unlocked state first
    (broker as any).secrets = { ...TEST_SECRETS };

    const { lockViaBroker, statusViaBroker } = await import("../vault/broker/client.js");
    const lockResult = await lockViaBroker({ socket: socketPath });
    expect(lockResult).toBe(true);

    const status = await statusViaBroker({ socket: socketPath });
    expect(status?.unlocked).toBe(false);

    // Re-unlock for subsequent tests (set directly via test hook)
    (broker as any).secrets = { ...TEST_SECRETS };
  });
});

describe("vault-broker client: unreachable broker", () => {
  it("getViaBroker returns null for ENOENT socket", async () => {
    const { getViaBroker } = await import("../vault/broker/client.js");
    const result = await getViaBroker("key", {
      socket: "/tmp/definitely-does-not-exist-broker.sock",
      timeoutMs: 100,
    });
    expect(result).toBeNull();
  });

  it("statusViaBroker returns null for unreachable broker", async () => {
    const { statusViaBroker } = await import("../vault/broker/client.js");
    const result = await statusViaBroker({
      socket: "/tmp/definitely-does-not-exist-broker.sock",
      timeoutMs: 100,
    });
    expect(result).toBeNull();
  });

  it("lockViaBroker returns false for unreachable broker", async () => {
    const { lockViaBroker } = await import("../vault/broker/client.js");
    const result = await lockViaBroker({
      socket: "/tmp/definitely-does-not-exist-broker.sock",
      timeoutMs: 100,
    });
    expect(result).toBe(false);
  });

  // Issue #129: structured result distinguishes unreachable from denied.
  it("getViaBrokerStructured returns kind=unreachable with msg for ENOENT socket", async () => {
    const { getViaBrokerStructured } = await import("../vault/broker/client.js");
    const result = await getViaBrokerStructured("key", {
      socket: "/tmp/definitely-does-not-exist-broker.sock",
      timeoutMs: 100,
    });
    expect(result.kind).toBe("unreachable");
    if (result.kind === "unreachable") {
      // The legacy null-on-anything API loses this signal; the structured
      // version surfaces enough detail for callers to log a useful reason.
      expect(result.msg).toMatch(/socket not found|connection failed|did not respond/);
    }
  });
});

// Issue #129: the broker is Linux-only by design. On non-Linux, start()
// throws unless SWITCHROOM_BROKER_ALLOW_NON_LINUX=1 was explicitly set.
describe("VaultBroker.start non-Linux refusal", () => {
  it.skipIf(process.platform === "linux")(
    "throws a clear Linux-only error when SWITCHROOM_BROKER_ALLOW_NON_LINUX is unset",
    async () => {
      const prev = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
      delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
      try {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "broker-refusal-"));
        const sock = path.join(tmp, "x.sock");
        const broker = new VaultBroker({
          _testSecrets: {},
          _testConfig: makeBrokerConfig(sock),
        });
        await expect(broker.start(sock, undefined, undefined)).rejects.toThrow(
          /Linux-only|SWITCHROOM_BROKER_ALLOW_NON_LINUX/,
        );
        try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
      } finally {
        if (prev !== undefined) process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prev;
      }
    },
  );
});
