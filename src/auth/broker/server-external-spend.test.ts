/**
 * get-external-spend — broker publishes sanitized OpenRouter/$ summary;
 * master key never leaves the broker.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";

import { AuthBroker } from "./server.js";
import { decodeResponse, encodeRequest, PROTOCOL_VERSION } from "./protocol.js";
import type { SwitchroomConfig } from "../../config/schema.js";
import { writeAccountCredentials } from "../account-store.js";

interface Harness {
  tmp: string;
  home: string;
  agentsDir: string;
  stateDir: string;
  socketRoot: string;
}

let harnesses: Harness[] = [];

function makeHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "auth-broker-ext-spend-"));
  const home = join(tmp, "home");
  const agentsDir = join(home, ".switchroom", "agents");
  const stateDir = join(home, ".switchroom", "state", "auth-broker");
  const socketRoot = join(tmp, "run", "switchroom", "auth-broker");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(join(agentsDir, "alice"), { recursive: true });
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const h: Harness = { tmp, home, agentsDir, stateDir, socketRoot };
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses) {
    try {
      rmSync(h.tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  harnesses = [];
});

function makeConfig(h: Harness): SwitchroomConfig {
  return {
    switchroom: { version: 1, agents_dir: h.agentsDir },
    telegram: {},
    agents: { alice: {} },
    auth: { active: "default", fallback_order: ["default"] },
    litellm: { enabled: true, base_url: "http://litellm.test:4010" },
  } as unknown as SwitchroomConfig;
}

function seedAccount(h: Harness, label: string): void {
  writeAccountCredentials(
    label,
    {
      claudeAiOauth: {
        accessToken: `at-${label}`,
        refreshToken: `rt-${label}`,
        expiresAt: Date.now() + 24 * 60 * 60 * 1000,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    },
    h.home,
  );
}

async function rpc(socketPath: string, req: object): Promise<unknown> {
  return await new Promise((resolveP, rejectP) => {
    const c = net.createConnection(socketPath);
    let buf = "";
    let settled = false;
    const settle = (v: unknown, err?: Error) => {
      if (settled) return;
      settled = true;
      try {
        c.destroy();
      } catch {
        /* ignore */
      }
      if (err) rejectP(err);
      else resolveP(v);
    };
    c.on("connect", () => {
      c.write(encodeRequest(req as Parameters<typeof encodeRequest>[0]));
    });
    c.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        try {
          settle(decodeResponse(buf.slice(0, nl)));
        } catch (err) {
          settle(null, err as Error);
        }
      }
    });
    c.on("error", (err) => settle(null, err));
    setTimeout(() => settle(null, new Error("rpc timeout")), 3000);
  });
}

describe("get-external-spend", () => {
  it("returns available:false when master key missing", async () => {
    const h = makeHarness();
    seedAccount(h, "default");
    const config = makeConfig(h);
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
      _testLitellmMasterKey: null,
    });
    await broker.start();
    try {
      const sock = join(h.socketRoot, "alice", "sock");
      const resp = (await rpc(sock, {
        v: PROTOCOL_VERSION,
        id: "1",
        op: "get-external-spend",
      })) as { ok: boolean; data?: { available?: boolean; reason?: string } };
      expect(resp.ok).toBe(true);
      expect(resp.data?.available).toBe(false);
      expect(resp.data?.reason).toBe("master_key_unavailable");
    } finally {
      broker.stop();
    }
  });

  it("returns sanitized summary from live fetch; never echo key", async () => {
    const h = makeHarness();
    seedAccount(h, "default");
    let sawKey: string | undefined;
    const config = makeConfig(h);
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
      _testLitellmMasterKey: "sk-secret-master-do-not-leak",
      _testFetchExternalSpend: async ({ adminKey }) => {
        sawKey = adminKey;
        return {
          day24hUsd: 8.07,
          day7dUsd: 119.89,
          top: [{ label: "gpt-oss-20b", usd: 6.1 }],
        };
      },
    });
    await broker.start();
    try {
      const sock = join(h.socketRoot, "alice", "sock");
      const resp = (await rpc(sock, {
        v: PROTOCOL_VERSION,
        id: "2",
        op: "get-external-spend",
        forceLive: true,
      })) as {
        ok: boolean;
        data?: Record<string, unknown>;
      };
      expect(resp.ok).toBe(true);
      expect(resp.data?.available).toBe(true);
      expect(resp.data?.day24hUsd).toBeCloseTo(8.07, 5);
      expect(resp.data?.day7dUsd).toBeCloseTo(119.89, 5);
      expect(resp.data?.top).toEqual([{ label: "gpt-oss-20b", usd: 6.1 }]);
      expect(sawKey).toBe("sk-secret-master-do-not-leak");
      expect(JSON.stringify(resp)).not.toContain("sk-secret-master");
    } finally {
      broker.stop();
    }
  });

  it("serves durable cache when live refresh fails", async () => {
    const h = makeHarness();
    seedAccount(h, "default");
    writeFileSync(
      join(h.stateDir, "external-spend.json"),
      JSON.stringify({
        summary: {
          day24hUsd: 1,
          day7dUsd: 2,
          top: [{ label: "grok-4.5", usd: 1 }],
        },
        capturedAtMs: Date.now() - 60_000,
      }),
      { mode: 0o600 },
    );
    let fetches = 0;
    const config = makeConfig(h);
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
      _testLitellmMasterKey: "sk-x",
      _testFetchExternalSpend: async () => {
        fetches += 1;
        return null;
      },
    });
    await broker.start();
    try {
      const sock = join(h.socketRoot, "alice", "sock");
      const resp = (await rpc(sock, {
        v: PROTOCOL_VERSION,
        id: "3",
        op: "get-external-spend",
        forceLive: true,
      })) as { ok: boolean; data?: { available?: boolean; day24hUsd?: number } };
      expect(resp.ok).toBe(true);
      expect(resp.data?.available).toBe(true);
      expect(resp.data?.day24hUsd).toBe(1);
      expect(fetches).toBeGreaterThanOrEqual(1);
    } finally {
      broker.stop();
    }
  });

  it("reads master key from state-dir file when env/test override absent", async () => {
    const h = makeHarness();
    seedAccount(h, "default");
    writeFileSync(join(h.stateDir, "litellm-master-key"), "sk-from-file\n", {
      mode: 0o600,
    });
    let sawKey: string | undefined;
    const config = makeConfig(h);
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
      // undefined ⇒ fall through to file
      _testFetchExternalSpend: async ({ adminKey }) => {
        sawKey = adminKey;
        return {
          day24hUsd: 0,
          day7dUsd: 0,
          top: [],
        };
      },
    });
    await broker.start();
    try {
      const sock = join(h.socketRoot, "alice", "sock");
      const resp = (await rpc(sock, {
        v: PROTOCOL_VERSION,
        id: "4",
        op: "get-external-spend",
        forceLive: true,
      })) as { ok: boolean; data?: { available?: boolean; day24hUsd?: number } };
      expect(resp.ok).toBe(true);
      expect(resp.data?.available).toBe(true);
      expect(resp.data?.day24hUsd).toBe(0);
      expect(sawKey).toBe("sk-from-file");
      expect(JSON.stringify(resp)).not.toContain("sk-from-file");
    } finally {
      broker.stop();
    }
  });

  it("rejects malformed durable cache (dot not poison available totals)", async () => {
    const h = makeHarness();
    seedAccount(h, "default");
    writeFileSync(
      join(h.stateDir, "external-spend.json"),
      JSON.stringify({
        summary: {
          day24hUsd: "nope",
          day7dUsd: 2,
          top: [{ label: "x", usd: 1 }],
        },
        capturedAtMs: Date.now() - 1_000,
      }),
      { mode: 0o600 },
    );
    const config = makeConfig(h);
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
      _testLitellmMasterKey: null,
    });
    await broker.start();
    try {
      const sock = join(h.socketRoot, "alice", "sock");
      const resp = (await rpc(sock, {
        v: PROTOCOL_VERSION,
        id: "5",
        op: "get-external-spend",
      })) as { ok: boolean; data?: { available?: boolean; reason?: string } };
      expect(resp.ok).toBe(true);
      expect(resp.data?.available).toBe(false);
      expect(resp.data?.reason).toBe("master_key_unavailable");
    } finally {
      broker.stop();
    }
  });

});
