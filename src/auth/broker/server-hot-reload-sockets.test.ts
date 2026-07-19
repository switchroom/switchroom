/**
 * auth-broker — hot-reload socket teardown + stale-identity rejection (H2).
 *
 * Privilege-retention fix. Before this change, `handleRequest` re-classified
 * the socket path against the current config but fell back to the bind-time
 * `boundIdentity` when classify returned null:
 *
 *   classify(sockPath, configToShape(this.config)) ?? boundIdentity
 *
 * So an agent REMOVED (or demoted) via SIGHUP reload could keep riding its
 * still-open connection's bound identity — which may carry `admin: true` —
 * and continue serving privileged requests. Two defenses are pinned here:
 *
 *   1. Per-request guard: classify null → FORBIDDEN error frame + a
 *      `stale-identity-rejected` audit row, no fallback to boundIdentity.
 *   2. Proactive teardown: reload()/stop() destroy the live sockets of
 *      listeners that were REMOVED or RE-CLASSIFIED, while leaving retained
 *      agents' sockets intact (client.ts lazily reconnects on next send, so
 *      a spurious destroy would cost a valid agent a failed in-flight request).
 *
 * The "admin demoted → non-admin" case is a REGRESSION PIN only: per-request
 * re-classify already demoted it pre-fix, so it does not count as fix coverage.
 * The load-bearing test is "removed agent cannot ride the bound identity".
 *
 * Same tmpdir-isolation strategy as server.test.ts (never ~/.switchroom).
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";

import { AuthBroker } from "./server.js";
import { decodeResponse, encodeRequest } from "./protocol.js";
import type { Response } from "./protocol.js";
import type { SwitchroomConfig } from "../../config/schema.js";
import { writeAccountCredentials } from "../account-store.js";

/* ─── Test harness ─────────────────────────────────────────────────────────── */

interface Harness {
  tmp: string;
  home: string;
  agentsDir: string;
  stateDir: string;
  socketRoot: string;
}

let harnesses: Harness[] = [];

function makeHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "auth-broker-hot-reload-sockets-"));
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

function makeConfig(
  h: Harness,
  opts: { active?: string; agents?: Record<string, { admin?: boolean }> } = {},
): SwitchroomConfig {
  const agents: Record<string, object> = { ...(opts.agents ?? {}) };
  for (const name of Object.keys(agents)) {
    mkdirSync(join(h.agentsDir, name), { recursive: true });
  }
  return {
    switchroom: { version: 1, agents_dir: h.agentsDir },
    telegram: {},
    agents,
    auth: { active: opts.active },
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

/** A persistent connection: one socket kept open across multiple requests. */
class PersistentConn {
  private sock: net.Socket;
  private buf = "";
  private waiters: Array<(r: Response) => void> = [];
  closed = false;

  constructor(socketPath: string) {
    this.sock = net.createConnection(socketPath);
    this.sock.on("data", (chunk: Buffer) => {
      this.buf += chunk.toString("utf-8");
      let nl: number;
      while ((nl = this.buf.indexOf("\n")) !== -1) {
        const line = this.buf.slice(0, nl);
        this.buf = this.buf.slice(nl + 1);
        if (!line.trim()) continue;
        const w = this.waiters.shift();
        if (w) w(decodeResponse(line));
      }
    });
    this.sock.on("close", () => { this.closed = true; });
    this.sock.on("error", () => { /* observed via close */ });
  }

  async ready(): Promise<void> {
    await new Promise<void>((res, rej) => {
      this.sock.once("connect", () => res());
      this.sock.once("error", (e) => rej(e));
    });
  }

  /** Send a request and resolve with the next response frame (3s cap). */
  request(req: object): Promise<Response> {
    return new Promise<Response>((res, rej) => {
      const timer = setTimeout(() => rej(new Error("request timeout")), 3000);
      this.waiters.push((r) => { clearTimeout(timer); res(r); });
      this.sock.write(encodeRequest(req as Parameters<typeof encodeRequest>[0]));
    });
  }

  /** Resolve once the server closes this connection (2s cap). */
  waitClosed(): Promise<boolean> {
    if (this.closed) return Promise.resolve(true);
    return new Promise<boolean>((res) => {
      const timer = setTimeout(() => res(false), 2000);
      this.sock.once("close", () => { clearTimeout(timer); res(true); });
    });
  }

  destroy(): void { try { this.sock.destroy(); } catch { /* ignore */ } }
}

function readAuditRows(h: Harness): Record<string, unknown>[] {
  const auditPath = join(h.stateDir, "audit.jsonl");
  try {
    const text = readFileSync(auditPath, "utf-8").trim();
    if (!text) return [];
    return text.split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

const agentSock = (h: Harness, name: string): string =>
  join(h.socketRoot, name, "sock");

function newBroker(h: Harness, config: SwitchroomConfig): AuthBroker {
  return new AuthBroker(config, {
    home: h.home,
    stateDir: h.stateDir,
    socketRoot: h.socketRoot,
    disableRefreshLoop: true,
  });
}

/* ─── Tests ────────────────────────────────────────────────────────────────── */

describe("AuthBroker — hot-reload socket teardown + stale-identity rejection", () => {
  it("removed agent cannot ride its bound identity across a reload (socket torn down)", async () => {
    const h = makeHarness();
    seedAccount(h, "acct");
    const broker = newBroker(
      h,
      makeConfig(h, { active: "acct", agents: { alpha: { admin: true } } }),
    );
    await broker.start();
    try {
      const conn = new PersistentConn(agentSock(h, "alpha"));
      await conn.ready();

      // Baseline: the admin agent gets credentials before the reload.
      const before = await conn.request({ v: 1, id: "1", op: "get-credentials" });
      expect(before.ok).toBe(true);

      // Reload a config WITHOUT alpha — the agent has been removed.
      await broker.reload(makeConfig(h, { active: "acct", agents: {} }));

      // The removed agent's live connection must be torn down: it can no
      // longer serve the admin bound identity. Pre-fix this socket stayed
      // open and a follow-up get-credentials succeeded (privilege retention).
      const wasClosed = await conn.waitClosed();
      expect(wasClosed).toBe(true);

      conn.destroy();
    } finally {
      broker.stop();
    }
  });

  it("a stale (classify-null) request is rejected FORBIDDEN and audited", async () => {
    // White-box exercise of the per-request guard in isolation from the
    // proactive teardown: mutate the live config so classify() returns null
    // for a still-open, still-tracked socket, then send a request. This is
    // the defense-in-depth path (had teardown missed a socket).
    const h = makeHarness();
    seedAccount(h, "acct");
    const broker = newBroker(
      h,
      makeConfig(h, { active: "acct", agents: { alpha: { admin: true } } }),
    );
    await broker.start();
    try {
      const conn = new PersistentConn(agentSock(h, "alpha"));
      await conn.ready();
      const ok = await conn.request({ v: 1, id: "1", op: "get-credentials" });
      expect(ok.ok).toBe(true);

      // Drop alpha from the broker's live config WITHOUT tearing the socket
      // down, so classify() now returns null for this connection.
      (broker as unknown as { config: SwitchroomConfig }).config = makeConfig(h, {
        active: "acct",
        agents: {},
      });

      const resp = await conn.request({ v: 1, id: "2", op: "get-credentials" });
      expect(resp.ok).toBe(false);
      if (!resp.ok) {
        expect(resp.error.code).toBe("FORBIDDEN");
      }

      const rejected = readAuditRows(h).filter(
        (r) => r["op"] === "stale-identity-rejected",
      );
      expect(rejected.length).toBeGreaterThan(0);
      expect(rejected.at(-1)!["peer"]).toBe("agent:alpha");
      expect(rejected.at(-1)!["ok"]).toBe(false);

      conn.destroy();
    } finally {
      broker.stop();
    }
  });

  it("a retained agent's connection keeps working across a reload", async () => {
    const h = makeHarness();
    seedAccount(h, "acct");
    const broker = newBroker(
      h,
      makeConfig(h, {
        active: "acct",
        agents: { alpha: {}, beta: {} },
      }),
    );
    await broker.start();
    try {
      const beta = new PersistentConn(agentSock(h, "beta"));
      await beta.ready();
      const before = await beta.request({ v: 1, id: "1", op: "get-credentials" });
      expect(before.ok).toBe(true);

      // Reload dropping alpha but KEEPING beta with an unchanged identity.
      await broker.reload(makeConfig(h, { active: "acct", agents: { beta: {} } }));

      // beta's socket must NOT have been destroyed — the same connection
      // still serves credentials after the reload.
      expect(beta.closed).toBe(false);
      const after = await beta.request({ v: 1, id: "2", op: "get-credentials" });
      expect(after.ok).toBe(true);

      beta.destroy();
    } finally {
      broker.stop();
    }
  });

  it("REGRESSION PIN: an admin agent demoted via reload can no longer run admin ops", async () => {
    // Not fix coverage — per-request re-classify already demoted pre-fix.
    // Kept so a future refactor can't silently re-grant admin to a demoted
    // agent. Uses fresh connections (rpc-style) so the check is independent
    // of socket teardown.
    const h = makeHarness();
    seedAccount(h, "acct");
    seedAccount(h, "other");
    const broker = newBroker(
      h,
      makeConfig(h, { active: "acct", agents: { alpha: { admin: true } } }),
    );
    await broker.start();
    try {
      // Admin agent can set-active while admin.
      const c1 = new PersistentConn(agentSock(h, "alpha"));
      await c1.ready();
      const asAdmin = await c1.request({
        v: 1, id: "1", op: "set-active", account: "other",
      });
      expect(asAdmin.ok).toBe(true);
      c1.destroy();

      // Demote alpha to a non-admin agent via reload.
      await broker.reload(
        makeConfig(h, { active: "other", agents: { alpha: {} } }),
      );

      // A fresh connection classifies as a non-admin agent → set-active FORBIDDEN.
      const c2 = new PersistentConn(agentSock(h, "alpha"));
      await c2.ready();
      const asDemoted = await c2.request({
        v: 1, id: "2", op: "set-active", account: "acct",
      });
      expect(asDemoted.ok).toBe(false);
      if (!asDemoted.ok) {
        expect(asDemoted.error.code).toBe("FORBIDDEN");
      }
      c2.destroy();
    } finally {
      broker.stop();
    }
  });

  it("stop() tears down live connections (no leaked open handles)", async () => {
    const h = makeHarness();
    seedAccount(h, "acct");
    const broker = newBroker(
      h,
      makeConfig(h, { active: "acct", agents: { alpha: {} } }),
    );
    await broker.start();

    const conn = new PersistentConn(agentSock(h, "alpha"));
    await conn.ready();
    const ok = await conn.request({ v: 1, id: "1", op: "get-credentials" });
    expect(ok.ok).toBe(true);

    broker.stop();

    // The open client connection must be closed by stop() — a leaked socket
    // would keep the event loop alive after shutdown.
    const wasClosed = await conn.waitClosed();
    expect(wasClosed).toBe(true);
    conn.destroy();
  });
});
