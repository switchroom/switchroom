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

  it("returns available:true with per-model summary from a healthy /user/daily/activity body (real fetch path, openrouter rows)", async () => {
    // End-to-end handoff guard: drive the REAL fetchAndSummarizeExternalSpend
    // (no _testFetchExternalSpend seam) against a stubbed global fetch that
    // returns a healthy `/user/daily/activity` page with openrouter/* rows.
    // Locks that a live, reachable proxy yields available:true + the per-model
    // top block — the state the /usage External row needs (and rendered blank
    // in the bug). Also asserts we hit the pre-aggregated daily endpoint, not
    // the deprecated O(rows) /spend/logs handler that aborted every fetch.
    const h = makeHarness();
    seedAccount(h, "default");
    const today = new Date().toISOString().slice(0, 10);
    const realFetch = globalThis.fetch;
    let calledUrl = "";
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calledUrl = String(input);
      const body = {
        results: [
          {
            date: today,
            breakdown: {
              models: {
                "openrouter/openai/gpt-oss-120b": { metrics: { spend: 6.1 } },
                "openrouter/x-ai/grok-4": { metrics: { spend: 3.4 } },
                // subscription passthrough — excluded
                "claude-sonnet-4": { metrics: { spend: 99.0 } },
              },
            },
          },
        ],
        metadata: { page: 1, total_pages: 1, has_more: false },
      };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const config = makeConfig(h);
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
      _testLitellmMasterKey: "sk-secret-master-do-not-leak",
    });
    await broker.start();
    try {
      const sock = join(h.socketRoot, "alice", "sock");
      const resp = (await rpc(sock, {
        v: PROTOCOL_VERSION,
        id: "e2e",
        op: "get-external-spend",
        forceLive: true,
      })) as {
        ok: boolean;
        data?: {
          available?: boolean;
          day24hUsd?: number;
          day7dUsd?: number;
          top?: Array<{ label: string; usd: number }>;
        };
      };
      expect(resp.ok).toBe(true);
      expect(resp.data?.available).toBe(true);
      // openrouter/* rows summed; Claude passthrough excluded.
      expect(resp.data?.day24hUsd).toBeCloseTo(9.5, 5);
      expect(resp.data?.day7dUsd).toBeCloseTo(9.5, 5);
      const top = resp.data?.top ?? [];
      expect(top.map((t) => t.label)).toEqual(["gpt-oss-120b", "grok-4"]);
      expect(top[0]?.usd).toBeCloseTo(6.1, 5);
      // Went through the pre-aggregated daily endpoint, not the deprecated
      // O(rows) /spend/logs handler that aborted on the large table.
      expect(calledUrl).toContain("/user/daily/activity");
      expect(calledUrl).not.toContain("/spend/logs");
      // Master key never crosses the wire.
      expect(JSON.stringify(resp)).not.toContain("sk-secret-master");
    } finally {
      broker.stop();
      globalThis.fetch = realFetch;
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
