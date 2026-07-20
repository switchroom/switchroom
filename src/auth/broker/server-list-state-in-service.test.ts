/**
 * `list-state` in-service classification (retired-account display, PR1).
 *
 * The bug: a disabled/retired Anthropic account — removed from `fallback_order`
 * and every per-agent / consumer pin — still had its credentials on disk, so the
 * account views listed it as "available". `list-state` now stamps each account
 * with `in_service` = membership in the fleet's routing set (active ∪
 * fallback_order ∪ agent `auth.override` ∪ consumer pins). An account absent from
 * that set reports `in_service: false` → the renderers show RETIRED.
 *
 * `entitlement_blocked` is DEFINED here (schema + wire) but PR2 populates it; a
 * pre-PR2 broker must report every account `entitlement_blocked: false`, which
 * these tests pin.
 *
 * Tmpdir-isolation strategy mirrors server-active-override.test.ts (never
 * touches ~/.switchroom).
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";

import { AuthBroker } from "./server.js";
import { decodeResponse, encodeRequest } from "./protocol.js";
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
  const tmp = mkdtempSync(join(tmpdir(), "auth-broker-list-state-in-service-"));
  const home = join(tmp, "home");
  const agentsDir = join(home, ".switchroom", "agents");
  const stateDir = join(home, ".switchroom", "state", "auth-broker");
  const socketRoot = join(tmp, "run", "switchroom", "auth-broker");
  mkdirSync(home, { recursive: true });
  mkdirSync(agentsDir, { recursive: true });
  const h: Harness = { tmp, home, agentsDir, stateDir, socketRoot };
  harnesses.push(h);
  return h;
}

afterEach(() => {
  for (const h of harnesses) {
    try { rmSync(h.tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  harnesses = [];
});

interface ConfigShape {
  active?: string;
  fallback_order?: string[];
  agents?: Record<string, { auth?: { override?: string } }>;
  consumers?: Array<{ name: string; account?: string }>;
}

function makeConfig(h: Harness, overrides: ConfigShape = {}): SwitchroomConfig {
  return ({
    switchroom: { version: 1, agents_dir: h.agentsDir },
    telegram: {},
    agents: overrides.agents ?? {},
    auth: {
      active: overrides.active,
      fallback_order: overrides.fallback_order,
      consumers: overrides.consumers,
    },
  } as unknown) as SwitchroomConfig;
}

async function rpc(socketPath: string, req: object): Promise<unknown> {
  return await new Promise<unknown>((resolveP, rejectP) => {
    const c = net.createConnection(socketPath);
    let buf = "";
    let settled = false;
    const settle = (v: unknown, err?: Error): void => {
      if (settled) return;
      settled = true;
      try { c.destroy(); } catch { /* ignore */ }
      if (err) rejectP(err); else resolveP(v);
    };
    c.on("connect", () => {
      c.write(encodeRequest(req as Parameters<typeof encodeRequest>[0]));
    });
    c.on("data", (chunk) => {
      buf += chunk.toString("utf-8");
      const nl = buf.indexOf("\n");
      if (nl !== -1) {
        try { settle(decodeResponse(buf.slice(0, nl))); } catch (err) { settle(null, err as Error); }
      }
    });
    c.on("error", (err) => settle(null, err));
    setTimeout(() => settle(null, new Error("rpc timeout")), 3000);
  });
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

interface AccountRow {
  label: string;
  in_service?: boolean;
  entitlement_blocked?: boolean;
}

async function listAccountsState(h: Harness, agent: string): Promise<AccountRow[]> {
  const resp = await rpc(join(h.socketRoot, agent, "sock"), {
    v: 1, id: "ls", op: "list-state",
  }) as { ok: boolean; data: { accounts: AccountRow[] } };
  expect(resp.ok).toBe(true);
  return resp.data.accounts;
}

describe("list-state — in_service classification", () => {
  it("marks the active, fallback, agent-override, and consumer-pinned accounts in-service; a stored-but-unlisted account RETIRED", async () => {
    const h = makeHarness();
    // Five stored accounts on disk. `retired` is removed from every config list.
    seedAccount(h, "active-acct");
    seedAccount(h, "fallback-acct");
    seedAccount(h, "agent-pin");
    seedAccount(h, "consumer-pin");
    seedAccount(h, "retired");
    mkdirSync(join(h.agentsDir, "worker"), { recursive: true });

    const config = makeConfig(h, {
      active: "active-acct",
      fallback_order: ["active-acct", "fallback-acct"],
      agents: { worker: { auth: { override: "agent-pin" } } },
      consumers: [{ name: "sidecar", account: "consumer-pin" }],
    });
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
    });
    await broker.start();
    try {
      const accounts = await listAccountsState(h, "worker");
      const byLabel = new Map(accounts.map((a) => [a.label, a]));

      // Every account the config still routes to → in_service TRUE.
      expect(byLabel.get("active-acct")?.in_service).toBe(true);
      expect(byLabel.get("fallback-acct")?.in_service).toBe(true);
      expect(byLabel.get("agent-pin")?.in_service).toBe(true);
      expect(byLabel.get("consumer-pin")?.in_service).toBe(true);

      // The account dropped from every list → in_service FALSE (RETIRED). This
      // is the bug: its credentials are still on disk, but it must not read as
      // available.
      expect(byLabel.get("retired")?.in_service).toBe(false);
    } finally {
      broker.stop();
    }
  });

  it("reports entitlement_blocked=false for every account (PR1 leaves it un-populated)", async () => {
    const h = makeHarness();
    seedAccount(h, "active-acct");
    seedAccount(h, "retired");
    mkdirSync(join(h.agentsDir, "worker"), { recursive: true });
    const config = makeConfig(h, {
      active: "active-acct",
      fallback_order: ["active-acct"],
      agents: { worker: {} },
    });
    const broker = new AuthBroker(config, {
      home: h.home, stateDir: h.stateDir, socketRoot: h.socketRoot, disableRefreshLoop: true,
    });
    await broker.start();
    try {
      const accounts = await listAccountsState(h, "worker");
      for (const a of accounts) {
        expect(a.entitlement_blocked).toBe(false);
      }
    } finally {
      broker.stop();
    }
  });
});
