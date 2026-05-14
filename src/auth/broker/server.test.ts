/**
 * auth-broker server — integration-style tests against a tmpdir.
 *
 * Strategy: socket paths live under `/tmp/auth-broker-test-<random>/...`
 * (NOT `/run/...` — those need root, and we want to run unprivileged).
 * `socketRoot` is the override knob. Identity classification still uses
 * the canonical regex (`/run/switchroom/auth-broker/<n>/sock`), so we
 * exercise classify() in peercred.test.ts and exercise listener bindings
 * here by talking to a real net.Socket directly against the broker's
 * listener using `socketPath` directly — bypassing classify by passing
 * the bound identity through the connection handler.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  const tmp = mkdtempSync(join(tmpdir(), "auth-broker-test-"));
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

/**
 * Build a SwitchroomConfig good enough for the broker. We cast — the
 * broker only reaches into `auth.*`, `agents`, and `switchroom.agents_dir`.
 */
function makeConfig(h: Harness, overrides: Partial<{
  active: string;
  fallback_order: string[];
  admin_agents: string[];
  consumers: Array<{ name: string; account: string; uid?: number }>;
  agents: Record<string, { auth?: { override?: string } }>;
}> = {}): SwitchroomConfig {
  return ({
    switchroom: { version: 1, agents_dir: h.agentsDir },
    telegram: {},
    agents: overrides.agents ?? {},
    auth: {
      active: overrides.active,
      fallback_order: overrides.fallback_order,
      admin_agents: overrides.admin_agents,
      consumers: overrides.consumers,
    },
  } as unknown) as SwitchroomConfig;
}

/** Open a UDS, send one request, read one response, close. */
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
        const line = buf.slice(0, nl);
        try { settle(decodeResponse(line)); } catch (err) { settle(null, err as Error); }
      }
    });
    c.on("error", (err) => settle(null, err));
    setTimeout(() => settle(null, new Error("rpc timeout")), 3000);
  });
}

/** Seed account credentials at the broker's expected location. */
function seedAccount(h: Harness, label: string, opts: { expiresAt?: number; refreshToken?: string } = {}): void {
  writeAccountCredentials(
    label,
    {
      claudeAiOauth: {
        accessToken: `at-${label}`,
        refreshToken: opts.refreshToken ?? `rt-${label}`,
        expiresAt: opts.expiresAt ?? Date.now() + 24 * 60 * 60 * 1000,
        scopes: ["user:inference"],
        subscriptionType: "max",
      },
    },
    h.home,
  );
}

/* ─── Tests ──────────────────────────────────────────────────── */

describe("AuthBroker — startup + listeners", () => {
  it("binds a listener per agent and per consumer when start() runs", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      consumers: [{ name: "hindsight", account: "default" }],
      agents: { ziggy: {}, clerk: {} },
    });
    seedAccount(h, "default");
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const state = broker._state();
    expect(state.listeners.sort()).toEqual([
      join(h.socketRoot, "clerk", "sock"),
      join(h.socketRoot, "hindsight", "sock"),
      join(h.socketRoot, "ziggy", "sock"),
    ]);
    broker.stop();
  });

  it("writes the healthy marker after listeners bind", async () => {
    const h = makeHarness();
    const config = makeConfig(h, { active: "default", agents: { ziggy: {} } });
    seedAccount(h, "default");
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const marker = join(h.stateDir, "healthy");
    expect(readFileSync(marker, "utf-8")).toMatch(/^\d+/);
    broker.stop();
  });

  it("refuses to start with a consumer named like an agent", () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      consumers: [{ name: "ziggy", account: "default" }],
      agents: { ziggy: {} },
    });
    expect(() =>
      new AuthBroker(config, {
        home: h.home,
        stateDir: h.stateDir,
        socketRoot: h.socketRoot,
      }),
    ).toThrow(/CONFIG_INVALID/);
  });
});

describe("AuthBroker — get-credentials", () => {
  it("returns the agent's effective account credentials", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      agents: { ziggy: {} },
    });
    seedAccount(h, "default", { expiresAt: 9_999_999_999_999 });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1,
      id: "1",
      op: "get-credentials",
    });
    expect(resp).toMatchObject({ ok: true, data: { account: "default" } });
    broker.stop();
  });

  it("honours per-agent override", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      agents: { ziggy: { auth: { override: "secondary" } } },
    });
    seedAccount(h, "default");
    seedAccount(h, "secondary");
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1,
      id: "1",
      op: "get-credentials",
    }) as { ok: boolean; data: { account: string } };
    expect(resp.ok).toBe(true);
    expect(resp.data.account).toBe("secondary");
    broker.stop();
  });
});

describe("AuthBroker — admin gating", () => {
  it("forbids set-active from a non-admin agent", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      agents: { ziggy: {} },
    });
    seedAccount(h, "default");
    seedAccount(h, "secondary");
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1,
      id: "1",
      op: "set-active",
      account: "secondary",
    });
    expect(resp).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });
    broker.stop();
  });

  it("permits set-active from an admin agent and fans out", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { ziggy: {}, clerk: {} },
    });
    seedAccount(h, "default");
    seedAccount(h, "secondary");
    // Seed agent dirs so fanout has somewhere to write.
    mkdirSync(join(h.agentsDir, "ziggy"), { recursive: true });
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "1",
      op: "set-active",
      account: "secondary",
    }) as { ok: boolean; data: { active: string; fanned: string[] } };
    expect(resp.ok).toBe(true);
    expect(resp.data.active).toBe("secondary");
    expect(resp.data.fanned.sort()).toEqual(["clerk", "ziggy"]);
    // Verify mirror file contents
    const mirror = readFileSync(join(h.agentsDir, "ziggy", ".claude", ".credentials.json"), "utf-8");
    expect(mirror).toContain("at-secondary");
    broker.stop();
  });
});

describe("AuthBroker — mark-exhausted", () => {
  it("marks the caller's account exhausted and persists quota", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      fallback_order: ["default", "secondary"],
      agents: { ziggy: {} },
    });
    seedAccount(h, "default");
    seedAccount(h, "secondary");
    mkdirSync(join(h.agentsDir, "ziggy"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const until = Date.now() + 60_000;
    const resp = await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1, id: "1", op: "mark-exhausted", until,
    }) as { ok: boolean; data: { account: string; rolled: string[] } };
    expect(resp.ok).toBe(true);
    expect(resp.data.account).toBe("default");
    expect(resp.data.rolled).toContain("ziggy");
    // Persisted to disk
    const quota = JSON.parse(readFileSync(join(h.stateDir, "quota.json"), "utf-8"));
    expect(quota["default"].exhausted_until).toBe(until);
    // Agent mirror now holds the secondary account creds.
    const mirror = readFileSync(join(h.agentsDir, "ziggy", ".claude", ".credentials.json"), "utf-8");
    expect(mirror).toContain("at-secondary");
    broker.stop();
  });
});

describe("AuthBroker — add-account / rm-account", () => {
  it("admin can add a new account; non-admin cannot", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { ziggy: {}, clerk: {} },
    });
    seedAccount(h, "default");
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const denied = await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1, id: "1", op: "add-account",
      label: "third",
      credentials: { claudeAiOauth: { accessToken: "at-third", refreshToken: "rt-third", expiresAt: Date.now() + 99_999_999 } },
    });
    expect(denied).toMatchObject({ ok: false, error: { code: "FORBIDDEN" } });

    const ok = await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1, id: "2", op: "add-account",
      label: "third",
      credentials: { claudeAiOauth: { accessToken: "at-third", refreshToken: "rt-third", expiresAt: Date.now() + 99_999_999 } },
    });
    expect(ok).toMatchObject({ ok: true, data: { label: "third" } });
    broker.stop();
  });

  it("refuses to add an existing account without replace:true", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { clerk: {} },
    });
    seedAccount(h, "default");
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const denied = await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1, id: "1", op: "add-account", label: "default",
      credentials: { claudeAiOauth: { accessToken: "at-x", refreshToken: "rt-x", expiresAt: Date.now() + 99_999 } },
    });
    expect(denied).toMatchObject({ ok: false, error: { code: "ACCOUNT_ALREADY_EXISTS" } });

    const ok = await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1, id: "2", op: "add-account", label: "default", replace: true,
      credentials: { claudeAiOauth: { accessToken: "at-x", refreshToken: "rt-x", expiresAt: Date.now() + 99_999 } },
    });
    expect(ok).toMatchObject({ ok: true });
    broker.stop();
  });
});

describe("AuthBroker — list-state", () => {
  it("returns active, fallback_order, accounts, agents, consumers", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      fallback_order: ["default", "secondary"],
      admin_agents: ["clerk"],
      consumers: [{ name: "hindsight", account: "default" }],
      agents: { ziggy: {}, clerk: {} },
    });
    seedAccount(h, "default", { expiresAt: 9_999_999_999_999 });
    seedAccount(h, "secondary", { expiresAt: 9_999_999_999_998 });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    const resp = await rpc(join(h.socketRoot, "ziggy", "sock"), {
      v: 1, id: "1", op: "list-state",
    }) as { ok: boolean; data: {
      active: string;
      fallback_order: string[];
      accounts: Array<{ label: string }>;
      agents: Array<{ name: string }>;
      consumers: Array<{ name: string }>;
    } };
    expect(resp.ok).toBe(true);
    expect(resp.data.active).toBe("default");
    expect(resp.data.fallback_order).toEqual(["default", "secondary"]);
    expect(resp.data.accounts.map((a) => a.label).sort()).toEqual(["default", "secondary"]);
    expect(resp.data.agents.map((a) => a.name).sort()).toEqual(["clerk", "ziggy"]);
    expect(resp.data.consumers.map((c) => c.name)).toEqual(["hindsight"]);
    broker.stop();
  });
});

describe("AuthBroker — drift detection", () => {
  it("seeds sha-index after add-account so a subsequent boot doesn't trip", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { clerk: {} },
    });
    seedAccount(h, "default");
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1, id: "1", op: "add-account", label: "fresh",
      credentials: { claudeAiOauth: { accessToken: "at-f", refreshToken: "rt-f", expiresAt: Date.now() + 99_999 } },
    });
    broker.stop();
    // New broker reads sha-index; on-disk file matches, so it boots cleanly.
    const broker2 = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker2.start();
    expect(broker2._state().shaIndex["fresh"]).toMatch(/^[0-9a-f]{64}$/);
    broker2.stop();
  });

  it("detects drift when a tracked account's bytes change behind the broker", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { clerk: {} },
    });
    seedAccount(h, "default");
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    // Force a sha-index entry by add-account --replace.
    await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1, id: "1", op: "add-account", label: "default", replace: true,
      credentials: { claudeAiOauth: { accessToken: "at-rev", refreshToken: "rt-rev", expiresAt: Date.now() + 99_999 } },
    });
    broker.stop();
    // Corrupt the on-disk file behind the broker's back.
    const credsPath = join(h.home, ".switchroom", "accounts", "default", "credentials.json");
    writeFileSync(credsPath, '{"claudeAiOauth":{"accessToken":"tampered"}}\n');
    // Boot a new broker — we expect process.exit(1) via DRIFT_DETECTED.
    // Stub process.exit so the test can observe rather than die.
    const original = process.exit;
    let exitCode: number | null = null;
    (process as unknown as { exit: (n?: number) => never }).exit = (n?: number) => {
      exitCode = n ?? 0;
      throw new Error("test-exit");
    };
    try {
      const broker2 = new AuthBroker(config, {
        home: h.home,
        stateDir: h.stateDir,
        socketRoot: h.socketRoot,
        disableRefreshLoop: true,
        skipHealthyMarker: true,
      });
      await expect(broker2.start()).rejects.toThrow(/test-exit/);
      expect(exitCode).toBe(1);
    } finally {
      process.exit = original;
    }
  });
});

describe("AuthBroker — refresh tick + threshold-violation", () => {
  it("refreshes a near-expiry account via the injected fetcher", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      agents: { ziggy: {} },
    });
    seedAccount(h, "default", { expiresAt: Date.now() + 30 * 60 * 1000 }); // 30min — under threshold
    mkdirSync(join(h.agentsDir, "ziggy"), { recursive: true });

    let calls = 0;
    const fetcher = async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: "at-new",
            refresh_token: "rt-new",
            expires_in: 8 * 60 * 60,
            token_type: "Bearer",
          }),
      };
    };
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      fetcher,
      disableRefreshLoop: true,
    });
    await broker.start();
    await broker._tick();
    expect(calls).toBe(1);
    const credsAfter = readFileSync(
      join(h.home, ".switchroom", "accounts", "default", "credentials.json"),
      "utf-8",
    );
    expect(credsAfter).toContain("at-new");
    // The mirror fans out to ziggy.
    const mirror = readFileSync(join(h.agentsDir, "ziggy", ".claude", ".credentials.json"), "utf-8");
    expect(mirror).toContain("at-new");
    broker.stop();
  });

  it("increments threshold-violations when on-disk expiresAt changes behind us", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      agents: { ziggy: {} },
    });
    seedAccount(h, "default", { expiresAt: Date.now() + 30 * 60 * 1000 });
    mkdirSync(join(h.agentsDir, "ziggy"), { recursive: true });
    let calls = 0;
    const fetcher = async () => {
      calls++;
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: "at-r" + calls,
            refresh_token: "rt-r" + calls,
            expires_in: 8 * 60 * 60,
            token_type: "Bearer",
          }),
      };
    };
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      fetcher,
      disableRefreshLoop: true,
    });
    await broker.start();
    await broker._tick();
    // Tamper with on-disk expiresAt to simulate claude refreshing.
    const credsPath = join(h.home, ".switchroom", "accounts", "default", "credentials.json");
    const parsed = JSON.parse(readFileSync(credsPath, "utf-8"));
    parsed.claudeAiOauth.expiresAt = parsed.claudeAiOauth.expiresAt + 1; // mutate
    writeFileSync(credsPath, JSON.stringify(parsed, null, 2) + "\n");
    await broker._tick();
    expect(broker._state().thresholdViolations["default"]).toBeGreaterThanOrEqual(1);
    broker.stop();
  });
});

describe("AuthBroker — claude-compatibility", () => {
  // Claude Code (2.x) reads OAuth credentials from `<configDir>/.credentials.json`
  // (DOTFILE). The broker writes the per-agent mirror at exactly that path.
  // Pre-RFC-H, both the deleted fanoutAccountToAgents and the very first
  // cut of this broker wrote to `credentials.json` (no dot) and got away
  // with it ONLY because start.sh.hbs also exported CLAUDE_CODE_OAUTH_TOKEN
  // from the legacy .oauth-token, so claude never read the on-disk mirror.
  // RFC H §7.4 deletes that env-injection path. The mirror MUST live at
  // the dotfile path or agents lose auth on first restart.
  //
  // This test pins the dotfile contract so a future "simplify the
  // filename" refactor can't silently undo it.
  it("writes the per-agent mirror to .credentials.json (dotfile — claude reads this path)", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "default",
      admin_agents: ["clerk"],
      agents: { ziggy: {}, clerk: {} },
    });
    seedAccount(h, "default");
    seedAccount(h, "secondary");
    mkdirSync(join(h.agentsDir, "ziggy"), { recursive: true });
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();
    await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "1",
      op: "set-active",
      account: "secondary",
    });
    const fs = await import("node:fs");
    // Dotfile path EXISTS — claude can read it.
    expect(fs.existsSync(join(h.agentsDir, "ziggy", ".claude", ".credentials.json"))).toBe(true);
    // Non-dot path DOES NOT exist — the broker doesn't double-write.
    expect(fs.existsSync(join(h.agentsDir, "ziggy", ".claude", "credentials.json"))).toBe(false);
    broker.stop();
  });
});

describe("AuthBroker — historical-bug regressions (2026-05-14 fanout incident)", () => {
  // Both bugs lived in the deleted account-refresh.ts:fanoutAccountToAgents
  // path. They surfaced when an operator flipped the fleet's primary Claude
  // account: `auth promote` EACCESed under user-mode (Bug 1), the operator
  // re-ran under sudo (which wrote root-owned files), then
  // `auth refresh-accounts` iterated every label and last-write-wins
  // overwrote the primary mirror (Bug 2). Net effect: agents silently
  // locked themselves out at next restart. The broker architecture closes
  // both vectors structurally — these tests pin that closure.

  it("Bug 1: per-agent mirror is chowned to the per-agent UID, never left as root", async () => {
    // The broker container runs as root and writes per-agent credentials.json.
    // Without an explicit chown, the file would land as root:root 0600 and
    // the agent (running as 10001–10999) couldn't read it. server.ts:953-956
    // calls `chownSync(targetPath, uid, uid)` where uid = allocateAgentUid().
    // We can't run as root in the test (so chownSync is a best-effort no-op
    // under dev — see the catch block), but we CAN verify the call is made
    // and reaches the right UID by spying on chownSync indirectly:
    // statSync(targetPath).uid will equal the test runner's UID in dev mode
    // (broker tried to chown to per-agent UID but lacked CAP_CHOWN). In
    // production with CAP_CHOWN, it would equal allocateAgentUid("ziggy").
    //
    // The pin: read the broker's source to confirm the chown call exists
    // with the right argument shape — a structural assertion that survives
    // a future "just remove the chown, it's a no-op in dev" refactor.
    const fs = await import("node:fs");
    const url = await import("node:url");
    const path = await import("node:path");
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const serverSrc = fs.readFileSync(path.join(here, "server.ts"), "utf-8");
    // Must chown the mirror file to allocateAgentUid(agentName), not leave
    // it root-owned. The exact pattern (a chownSync call against the
    // freshly-written .credentials.json path inside mirrorAccountToAgent)
    // is what closes Bug 1.
    expect(serverSrc).toMatch(/mirrorAccountToAgent[\s\S]{0,1600}allocateAgentUid/);
    expect(serverSrc).toMatch(/mirrorAccountToAgent[\s\S]{0,1600}chownSync\(targetPath/);
  });

  it("Bug 2: refresh tick writes ONLY the agent's effective account, not last-iterated label", async () => {
    // Pre-broker, refreshAllAccounts iterated every enabled account and
    // fanned each one out to every agent — last-write wins, alphabetic
    // sort destroys the YAML primary. Post-broker, fanoutForAgent computes
    // `agent.auth.override ?? auth.active` and writes EXACTLY THAT.
    // Iteration order doesn't exist as a concept.
    //
    // Setup: three accounts, ken < me < pixsoul (the exact alphabetic
    // order that caused the original incident — pixsoul sorted last).
    // Two agents, one on fleet active (= "ken"), one with override = "me".
    // Run a full refresh tick. Verify each agent's mirror is its own
    // declared account, not pixsoul's.
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "ken.thompson@outlook.com.au",
      fallback_order: [
        "ken.thompson@outlook.com.au",
        "me@kenthompson.com.au",
        "pixsoul@gmail.com",
      ],
      agents: {
        ziggy: {}, // inherits fleet active = ken
        lawgpt: { auth: { override: "me@kenthompson.com.au" } },
      },
    });
    // Seed all three accounts with near-expiry creds so the tick attempts
    // a refresh against each. The exact alphabetic ordering of the labels
    // is what triggered the original last-write-wins. With pixsoul iterating
    // last, the pre-broker code would have ended with pixsoul's creds in
    // every agent. The broker MUST write ken to ziggy and me to lawgpt.
    const nearExpiry = Date.now() + 30 * 60 * 1000; // 30 min — under threshold
    seedAccount(h, "ken.thompson@outlook.com.au", { expiresAt: nearExpiry });
    seedAccount(h, "me@kenthompson.com.au", { expiresAt: nearExpiry });
    seedAccount(h, "pixsoul@gmail.com", { expiresAt: nearExpiry });
    mkdirSync(join(h.agentsDir, "ziggy"), { recursive: true });
    mkdirSync(join(h.agentsDir, "lawgpt"), { recursive: true });
    // Stub fetcher that returns predictable per-label access tokens. The
    // body matters: each agent's mirror should contain the token of the
    // RIGHT account, not the last-iterated one.
    const fetcher = async (_url: unknown, init: unknown) => {
      // Body is application/json; refresh_token field carries
      // "rt-<label>" (set by seedAccount). Parse to recover the label.
      const body = (init as { body?: string })?.body ?? "{}";
      const parsed = JSON.parse(body) as { refresh_token?: string };
      const rt = parsed.refresh_token ?? "";
      const label = rt.replace(/^rt-/, "");
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            access_token: `at-refreshed-${label}`,
            refresh_token: `rt-rotated-${label}`,
            expires_in: 8 * 60 * 60,
            token_type: "Bearer",
          }),
      };
    };
    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      fetcher: fetcher as never,
      disableRefreshLoop: true,
    });
    await broker.start();
    await broker._tick();

    const ziggyMirror = readFileSync(
      join(h.agentsDir, "ziggy", ".claude", ".credentials.json"),
      "utf-8",
    );
    const lawgptMirror = readFileSync(
      join(h.agentsDir, "lawgpt", ".claude", ".credentials.json"),
      "utf-8",
    );

    // ziggy should have ken's refreshed token (fleet active).
    expect(ziggyMirror).toContain("at-refreshed-ken.thompson@outlook.com.au");
    expect(ziggyMirror).not.toContain("at-refreshed-pixsoul@gmail.com");
    expect(ziggyMirror).not.toContain("at-refreshed-me@kenthompson.com.au");

    // lawgpt should have me's refreshed token (override).
    expect(lawgptMirror).toContain("at-refreshed-me@kenthompson.com.au");
    expect(lawgptMirror).not.toContain("at-refreshed-pixsoul@gmail.com");
    expect(lawgptMirror).not.toContain("at-refreshed-ken.thompson@outlook.com.au");

    broker.stop();
  });
});
