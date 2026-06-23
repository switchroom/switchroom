/**
 * auth-broker — audit log accountKind field.
 *
 * Regression test for the live misdiagnosis described in the PR: when the
 * same email appears as both a Claude account and a Microsoft account, reading
 * the audit log gave no way to tell which kind of credential fetch fired.
 *
 * Every op that concerns an account now writes an `accountKind` field
 * ("claude" | "microsoft" | "google" | "unknown") alongside the existing
 * `account` label. This file pins:
 *
 *   - A Claude get-credentials success → accountKind: "claude"
 *   - A Microsoft get-credentials success → accountKind: "microsoft"
 *   - A Microsoft get-credentials failure (no-creds) → accountKind: "microsoft"
 *   - A Claude mark-exhausted → accountKind: "claude"
 *   - A Claude set-active → accountKind: "claude"
 *   - A Claude add-account → accountKind: "claude"
 *   - A Microsoft add-account → accountKind: "microsoft"
 *   - A Claude probe-quota → accountKind: "claude"
 *   - Ops with no account context (list-state) → no accountKind field
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as net from "node:net";

import { AuthBroker } from "./server.js";
import { decodeResponse, encodeRequest } from "./protocol.js";
import { writeAccountCredentials } from "../account-store.js";
import { writeMicrosoftAccountCredentials } from "./microsoft-storage.js";
import type { SwitchroomConfig } from "../../config/schema.js";
import type { MicrosoftCredentialsShape } from "./protocol.js";

/* ─── Test harness helpers ─────────────────────────────────────────────────── */

interface Harness {
  tmp: string;
  home: string;
  agentsDir: string;
  stateDir: string;
  socketRoot: string;
}

let harnesses: Harness[] = [];

function makeHarness(): Harness {
  const tmp = mkdtempSync(join(tmpdir(), "auth-broker-auditkind-test-"));
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
    try {
      rmSync(h.tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
  harnesses = [];
});

function makeConfig(
  h: Harness,
  opts: {
    active?: string;
    admin_agents?: string[];
    agents?: Record<string, object>;
    microsoftAccounts?: Record<string, { enabled_for?: string[] }>;
  } = {},
): SwitchroomConfig {
  const agents: Record<string, object> = { ...(opts.agents ?? {}) };
  for (const name of opts.admin_agents ?? []) {
    agents[name] = { ...(agents[name] ?? {}), admin: true };
  }
  const base: Record<string, unknown> = {
    switchroom: { version: 1, agents_dir: h.agentsDir },
    telegram: {},
    agents,
    auth: { active: opts.active },
    // Register the Microsoft provider so broker accepts provider:"microsoft".
    microsoft_workspace: {
      microsoft_client_id: "11111111-2222-3333-4444-555555555555",
    },
  };
  if (opts.microsoftAccounts) {
    base.microsoft_accounts = opts.microsoftAccounts;
  }
  return base as unknown as SwitchroomConfig;
}

/** Seed a Claude (Anthropic) account credential. */
function seedClaudeAccount(h: Harness, label: string): void {
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

/** Seed a Microsoft account credential. */
function seedMicrosoftAccount(h: Harness, account: string): void {
  const creds: MicrosoftCredentialsShape = {
    microsoftOauth: {
      accessToken: `at-ms-${account}`,
      refreshToken: `rt-ms-${account}`,
      expiresAt: Date.now() + 3600_000,
      scope: "openid profile offline_access Mail.ReadWrite",
      clientId: "11111111-2222-3333-4444-555555555555",
      accountEmail: account,
      tokenType: "Bearer",
      tenantId: "9188040d-6c67-4c5b-b112-36a304b66dad",
      accountType: "personal",
      homeAccountId: `oid-${account}.9188040d-6c67-4c5b-b112-36a304b66dad`,
    },
  };
  writeMicrosoftAccountCredentials(h.stateDir, account, creds);
}

/** Open a UDS, send one request, read one response, close. */
async function rpc(socketPath: string, req: object): Promise<unknown> {
  return new Promise<unknown>((resolveP, rejectP) => {
    const c = net.createConnection(socketPath);
    let buf = "";
    let settled = false;
    const settle = (v: unknown, err?: Error): void => {
      if (settled) return;
      settled = true;
      try { c.destroy(); } catch { /* ignore */ }
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
        const line = buf.slice(0, nl);
        try { settle(decodeResponse(line)); } catch (err) { settle(null, err as Error); }
      }
    });
    c.on("error", (err) => settle(null, err));
    setTimeout(() => settle(null, new Error("rpc timeout")), 3000);
  });
}

/** Read all audit rows from the audit log for the harness. */
function readAuditRows(h: Harness): Record<string, unknown>[] {
  const auditPath = join(h.stateDir, "audit.jsonl");
  try {
    const text = readFileSync(auditPath, "utf-8").trim();
    if (!text) return [];
    return text.split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/** Return the last audit row matching a given op. */
function lastAuditRow(
  h: Harness,
  op: string,
): Record<string, unknown> | undefined {
  return readAuditRows(h).filter((r) => r["op"] === op).at(-1);
}

/* ─── Tests ────────────────────────────────────────────────────────────────── */

describe("AuthBroker — audit log accountKind field", () => {
  it("get-credentials (Claude/Anthropic) emits accountKind: 'claude'", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "claude@example.com",
      agents: { clerk: {} },
    });
    seedClaudeAccount(h, "claude@example.com");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();

    const resp = (await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "1",
      op: "get-credentials",
    })) as { ok: boolean };
    expect(resp.ok).toBe(true);

    broker.stop();

    const row = lastAuditRow(h, "get-credentials");
    expect(row).toBeDefined();
    expect(row!["account"]).toBe("claude@example.com");
    expect(row!["accountKind"]).toBe("claude");
    expect(row!["ok"]).toBe(true);
  });

  it("get-credentials (Microsoft) emits accountKind: 'microsoft'", async () => {
    const h = makeHarness();
    // Use the same email string for both the Claude account and the Microsoft
    // account, to demonstrate that accountKind disambiguates them in the log.
    const sharedEmail = "carol@example.com";
    const config = makeConfig(h, {
      active: sharedEmail,
      agents: {
        clerk: { microsoft_workspace: { account: sharedEmail } },
      },
      microsoftAccounts: { [sharedEmail]: { enabled_for: ["clerk"] } },
    });
    // Seed both a Claude account AND a Microsoft account under the same email.
    seedClaudeAccount(h, sharedEmail);
    seedMicrosoftAccount(h, sharedEmail);
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();

    // Fetch Microsoft credentials specifically.
    const resp = (await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "2",
      op: "get-credentials",
      provider: "microsoft",
    })) as { ok: boolean };
    expect(resp.ok).toBe(true);

    broker.stop();

    // Find the Microsoft get-credentials row (the most recent one).
    const rows = readAuditRows(h).filter(
      (r) => r["op"] === "get-credentials" && r["accountKind"] === "microsoft",
    );
    expect(rows.length).toBeGreaterThan(0);
    const row = rows.at(-1)!;
    expect(row["account"]).toBe(sharedEmail);
    expect(row["accountKind"]).toBe("microsoft");
    expect(row["ok"]).toBe(true);
  });

  it("get-credentials (Microsoft) failure emits accountKind: 'microsoft'", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      agents: {
        clerk: { microsoft_workspace: { account: "lisa@hotmail.com" } },
      },
      microsoftAccounts: { "lisa@hotmail.com": { enabled_for: ["clerk"] } },
    });
    // Deliberately do NOT seed Microsoft credentials — triggers "missing-credentials".
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();

    const resp = (await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "3",
      op: "get-credentials",
      provider: "microsoft",
    })) as { ok: boolean };
    expect(resp.ok).toBe(false);

    broker.stop();

    const row = lastAuditRow(h, "get-credentials");
    expect(row).toBeDefined();
    expect(row!["accountKind"]).toBe("microsoft");
    expect(row!["ok"]).toBe(false);
    expect(row!["error"]).toBe("missing-credentials");
  });

  it("mark-exhausted emits accountKind: 'claude'", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "claude@example.com",
      agents: { clerk: {} },
    });
    seedClaudeAccount(h, "claude@example.com");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();

    const resp = (await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "4",
      op: "mark-exhausted",
      until: Date.now() + 3_600_000,
    })) as { ok: boolean };
    expect(resp.ok).toBe(true);

    broker.stop();

    const row = lastAuditRow(h, "mark-exhausted");
    expect(row).toBeDefined();
    expect(row!["account"]).toBe("claude@example.com");
    expect(row!["accountKind"]).toBe("claude");
  });

  it("set-active emits accountKind: 'claude'", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "claude@example.com",
      admin_agents: ["clerk"],
      agents: { clerk: {} },
    });
    seedClaudeAccount(h, "claude@example.com");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();

    const resp = (await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "5",
      op: "set-active",
      account: "claude@example.com",
    })) as { ok: boolean };
    expect(resp.ok).toBe(true);

    broker.stop();

    const row = lastAuditRow(h, "set-active");
    expect(row).toBeDefined();
    expect(row!["accountKind"]).toBe("claude");
  });

  it("add-account (Claude) emits accountKind: 'claude'", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      admin_agents: ["clerk"],
      agents: { clerk: {} },
    });
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();

    const resp = (await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "6",
      op: "add-account",
      label: "new@example.com",
      provider: "anthropic",
      credentials: {
        claudeAiOauth: {
          accessToken: "at-new",
          refreshToken: "rt-new",
          expiresAt: Date.now() + 3600_000,
        },
      },
    })) as { ok: boolean };
    expect(resp.ok).toBe(true);

    broker.stop();

    const row = lastAuditRow(h, "add-account");
    expect(row).toBeDefined();
    expect(row!["account"]).toBe("new@example.com");
    expect(row!["accountKind"]).toBe("claude");
  });

  it("add-account (Microsoft) emits accountKind: 'microsoft'", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      admin_agents: ["clerk"],
      agents: { clerk: {} },
    });
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
    });
    await broker.start();

    const resp = (await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "7",
      op: "add-account",
      label: "lisa@hotmail.com",
      provider: "microsoft",
      credentials: {
        microsoftOauth: {
          accessToken: "at-ms",
          refreshToken: "rt-ms",
          expiresAt: Date.now() + 3600_000,
          scope: "openid Mail.ReadWrite",
          clientId: "11111111-2222-3333-4444-555555555555",
          accountEmail: "lisa@hotmail.com",
          tokenType: "Bearer",
          tenantId: "9188040d-6c67-4c5b-b112-36a304b66dad",
          accountType: "personal",
          homeAccountId: "oid-lisa.9188040d",
        },
      },
    })) as { ok: boolean };
    expect(resp.ok).toBe(true);

    broker.stop();

    const row = lastAuditRow(h, "add-account");
    expect(row).toBeDefined();
    expect(row!["account"]).toBe("lisa@hotmail.com");
    expect(row!["accountKind"]).toBe("microsoft");
  });

  it("probe-quota emits accountKind: 'claude'", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "claude@example.com",
      admin_agents: ["clerk"],
      agents: { clerk: {} },
    });
    seedClaudeAccount(h, "claude@example.com");
    mkdirSync(join(h.agentsDir, "clerk"), { recursive: true });

    // Stub fetchQuota to avoid a real Anthropic network call.
    const stubFetchQuota = async (): Promise<import("../quota.js").QuotaResult> => ({
      ok: true,
      data: {
        fiveHourUtilizationPct: 10,
        sevenDayUtilizationPct: 5,
        fiveHourResetAt: null,
        sevenDayResetAt: null,
        representativeClaim: null,
        overageStatus: null,
        overageDisabledReason: null,
      },
    });

    const broker = new AuthBroker(config, {
      home: h.home,
      stateDir: h.stateDir,
      socketRoot: h.socketRoot,
      disableRefreshLoop: true,
      _testFetchQuota: stubFetchQuota as typeof import("../quota.js").fetchQuota,
    });
    await broker.start();

    const resp = (await rpc(join(h.socketRoot, "clerk", "sock"), {
      v: 1,
      id: "8",
      op: "probe-quota",
      accounts: ["claude@example.com"],
    })) as { ok: boolean };
    expect(resp.ok).toBe(true);

    broker.stop();

    const row = lastAuditRow(h, "probe-quota");
    expect(row).toBeDefined();
    expect(row!["account"]).toBe("claude@example.com");
    expect(row!["accountKind"]).toBe("claude");
  });

  it("list-state emits no accountKind (fleet-wide op, no provider context)", async () => {
    const h = makeHarness();
    const config = makeConfig(h, {
      active: "claude@example.com",
      agents: { clerk: {} },
    });
    seedClaudeAccount(h, "claude@example.com");
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
      id: "9",
      op: "list-state",
    });

    broker.stop();

    const row = lastAuditRow(h, "list-state");
    expect(row).toBeDefined();
    // list-state has no account-level provider context — accountKind should
    // be absent (undefined in JSON serializes as omitted key).
    expect(Object.prototype.hasOwnProperty.call(row, "accountKind")).toBe(false);
  });
});
