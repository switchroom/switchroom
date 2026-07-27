/**
 * `list-state` reports the SERVING account, not just the configured pin.
 *
 * The bug (operator report, 2026-07-27): the Telegram `/usage` card named
 * `auth.active` as "(active)" while the fleet had already been rolled onto a
 * different account. `softAvoidProbeRoll` (#3031 PR 2) mirrors the fallback's
 * credentials onto every rider agent and deliberately does NOT promote
 * `auth.active` ("NO durable promote"), so the pin and the account actually
 * serving diverge — and `list-state` only ever published the pin.
 *
 * These tests pin the wire contract: `active` stays the pin (nothing else may
 * regress off it) and `serving` is the account whose credentials the agents
 * are actually holding. Same tmpdir-isolation + `_testFetchQuota` seam as
 * server-soft-avoid-probe.test.ts (never touches ~/.switchroom, never hits
 * the network).
 */

import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";

import { AuthBroker } from "./server.js";
import { decodeResponse, encodeRequest } from "./protocol.js";
import type { SwitchroomConfig } from "../../config/schema.js";
import { writeAccountCredentials } from "../account-store.js";
import type { QuotaResult } from "../quota.js";

const NOW = 1_800_000_000_000;

interface Harness {
  tmp: string;
  home: string;
  agentsDir: string;
  stateDir: string;
  socketRoot: string;
}

let harnesses: Harness[] = [];

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

function seedAccount(home: string, label: string): void {
  writeAccountCredentials(
    label,
    {
      claudeAiOauth: {
        accessToken: "at-" + label,
        refreshToken: "rt-" + label,
        expiresAt: NOW + 24 * 60 * 60 * 1000,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    },
    home,
  );
}

type QuotaTable = Record<string, { fiveHour: number; sevenDay: number }>;

function quotaFor(table: QuotaTable, accessToken: string): QuotaResult {
  const label = accessToken.replace(/^at-/, "");
  const q = table[label];
  if (!q) return { ok: false, reason: "no fixture for " + label };
  return {
    ok: true,
    data: {
      fiveHourUtilizationPct: q.fiveHour,
      sevenDayUtilizationPct: q.sevenDay,
      fiveHourResetAt: null,
      sevenDayResetAt: null,
      representativeClaim: null,
      overageStatus: null,
      overageDisabledReason: null,
    },
  };
}

function makeBroker(opts: {
  active: string;
  fallbackOrder: string[];
  pct?: number;
  accounts: string[];
  quotas: QuotaTable;
}): { broker: AuthBroker; b: any; h: Harness } {
  const tmp = mkdtempSync(join(tmpdir(), "auth-broker-list-state-serving-"));
  const home = join(tmp, "home");
  const agentsDir = join(home, ".switchroom", "agents");
  const stateDir = join(home, ".switchroom", "state", "auth-broker");
  const socketRoot = join(tmp, "run", "switchroom", "auth-broker");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  mkdirSync(join(agentsDir, "ziggy"), { recursive: true });
  const h: Harness = { tmp, home, agentsDir, stateDir, socketRoot };
  harnesses.push(h);
  for (const label of opts.accounts) seedAccount(home, label);
  const config = {
    switchroom: { version: 1, agents_dir: agentsDir },
    telegram: {},
    agents: { ziggy: {} },
    auth: {
      active: opts.active,
      fallback_order: opts.fallbackOrder,
      proactive_failover_pct: opts.pct,
    },
  } as unknown as SwitchroomConfig;
  const broker = new AuthBroker(config, {
    home,
    stateDir,
    socketRoot,
    now: () => NOW,
    disableRefreshLoop: true,
    skipHealthyMarker: true,
    _testFetchQuota: async ({ accessToken }) => quotaFor(opts.quotas, accessToken),
  });
  return { broker, b: broker as any, h };
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

async function listState(h: Harness): Promise<{ active: string; serving?: string }> {
  const resp = (await rpc(join(h.socketRoot, "ziggy", "sock"), {
    v: 1, id: "ls", op: "list-state",
  })) as { ok: boolean; data: { active: string; serving?: string } };
  expect(resp.ok).toBe(true);
  return resp.data;
}

/** The access token actually mirrored onto an agent = ground truth for serving. */
function mirrorToken(h: Harness, agent: string): string | null {
  const p = join(h.agentsDir, agent, ".claude", ".credentials.json");
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")).claudeAiOauth?.accessToken ?? null;
}

describe("list-state — serving vs pinned account", () => {
  it("reports the ROLLED-TO account as serving after a soft-avoid roll, while active stays the pin", async () => {
    const { broker, b, h } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob"],
      pct: 95,
      accounts: ["alice", "bob"],
      quotas: { alice: { fiveHour: 10, sevenDay: 96 }, bob: { fiveHour: 5, sevenDay: 10 } },
    });
    await broker.start();
    try {
      // Before the roll, pin and serving agree.
      expect(await listState(h)).toMatchObject({ active: "alice", serving: "alice" });

      // The probe soft-avoids alice and pushes bob's creds onto the fleet —
      // WITHOUT promoting auth.active (the #3031 PR 2 contract).
      await broker.fleetQuotaProbeTick();
      expect(b.config.auth?.active).toBe("alice");
      // Ground truth, independent of list-state: the agent is holding bob.
      expect(mirrorToken(h, "ziggy")).toBe("at-bob");

      const state = await listState(h);
      // The pin is unchanged and still published as `active` — dashboards that
      // genuinely mean "what is pinned" must not shift under them.
      expect(state.active).toBe("alice");
      // …and `serving` names the account the fleet is actually running on.
      // This is the assertion the bug fails: pre-fix there was no `serving`
      // field at all, so every "(active)" renderer named alice.
      expect(state.serving).toBe("bob");
    } finally {
      broker.stop();
    }
  });

  it("reports serving === active when nothing has rolled", async () => {
    const { broker, h } = makeBroker({
      active: "alice",
      fallbackOrder: ["alice", "bob"],
      pct: 95,
      accounts: ["alice", "bob"],
      quotas: { alice: { fiveHour: 10, sevenDay: 12 }, bob: { fiveHour: 5, sevenDay: 10 } },
    });
    await broker.start();
    try {
      await broker.fleetQuotaProbeTick();
      const state = await listState(h);
      expect(state.active).toBe("alice");
      expect(state.serving).toBe("alice");
    } finally {
      broker.stop();
    }
  });
});
