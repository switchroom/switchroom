/**
 * Tests for cron-side token resolution (issue #226).
 *
 * Covers:
 *   - createBrokerClient WITH agent slug reads token file on init
 *   - createBrokerClient WITHOUT agent slug → no token field in request
 *   - Token file present but unreadable (EACCES) → warn + no token
 *   - Token file present and valid → token included in get/list requests
 *   - Token present but broker returns grant-expired → VaultTokenRejectedError thrown
 *   - Token present but broker returns grant-revoked → VaultTokenRejectedError thrown
 *   - No token → broker denied → GetResult "denied" (no throw)
 *
 * Uses a real VaultBroker on a tmp socket (via _testSecrets / _testGrantsDb)
 * for round-trip tests, and stubs the file system for unit-level token-read tests.
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Database } from "bun:sqlite";
import { VaultBroker } from "./server.js";
import {
  createBrokerClient,
  readVaultTokenFile,
  vaultTokenFilePath,
  VaultTokenRejectedError,
} from "./client.js";
import { encodeRequest, decodeResponse, type BrokerResponse } from "./protocol.js";
import type { VaultEntry } from "../vault.js";
import { createAuditLogger, type AuditEntry } from "./audit-log.js";
import { migrateGrantsSchema, mintGrant } from "../grants.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEST_SECRETS: Record<string, VaultEntry> = {
  foo: { kind: "string", value: "bar-value" },
  baz: { kind: "binary", value: "aGVsbG8=" },
};

function cloneSecrets(): Record<string, VaultEntry> {
  return JSON.parse(JSON.stringify(TEST_SECRETS));
}

function makeMinimalConfig() {
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "test", forum_chat_id: "123" },
    vault: {
      path: "~/.switchroom/vault.enc",
      broker: { socket: "~/.switchroom/vault-broker.sock", enabled: true },
    },
    agents: {},
  } as any;
}

function makeInMemoryGrantsDb(): Database {
  const db = new Database(":memory:");
  migrateGrantsSchema(db);
  return db;
}

// ─── Unit tests: readVaultTokenFile ──────────────────────────────────────────

describe("readVaultTokenFile", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "token-read-test-"));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    vi.restoreAllMocks();
  });

  it("returns null when file does not exist (ENOENT) — silent, no stderr", () => {
    const stderrSpy = vi.spyOn(process.stderr, "write");
    // Point at a slug whose token file does not exist
    const slug = "no-such-agent-" + Date.now();
    const result = readVaultTokenFile(slug);
    expect(result).toBeNull();
    expect(stderrSpy).not.toHaveBeenCalled();
  });

  it("returns the first line trimmed when file exists and is readable", () => {
    // Write a token file where the path is under a real home-relative location.
    // We can't easily override homedir(), so we test the helper function
    // directly by writing to the expected path and cleaning up.
    const slug = "test-agent-" + Date.now();
    const tokenPath = vaultTokenFilePath(slug);
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    const fakeToken = "vg_abcdef.supersecretvalue";
    fs.writeFileSync(tokenPath, fakeToken + "\nextra line\n", { mode: 0o600 });
    try {
      const result = readVaultTokenFile(slug);
      expect(result).toBe(fakeToken);
    } finally {
      try { fs.rmSync(path.dirname(tokenPath), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("returns null and warns on EACCES (unreadable file)", () => {
    // Write a token file then chmod it to 000
    const slug = "test-agent-acces-" + Date.now();
    const tokenPath = vaultTokenFilePath(slug);
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, "vg_acces.token\n", { mode: 0o600 });
    fs.chmodSync(tokenPath, 0o000);

    const stderrMsgs: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(
      (msg: string | Uint8Array) => { stderrMsgs.push(String(msg)); return true; },
    );

    try {
      const result = readVaultTokenFile(slug);
      // On Linux this should return null and warn
      // (root would still read it; skip assertion on UID=0)
      if (process.getuid?.() !== 0) {
        expect(result).toBeNull();
        expect(stderrMsgs.some((m) => m.includes("Warning"))).toBe(true);
        expect(stderrMsgs.some((m) => m.includes("Falling through"))).toBe(true);
      }
    } finally {
      fs.chmodSync(tokenPath, 0o600);
      try { fs.rmSync(path.dirname(tokenPath), { recursive: true, force: true }); } catch { /* ignore */ }
      stderrSpy.mockRestore();
    }
  });

  it("returns null for empty token file", () => {
    const slug = "test-agent-empty-" + Date.now();
    const tokenPath = vaultTokenFilePath(slug);
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, "\n", { mode: 0o600 });
    try {
      const result = readVaultTokenFile(slug);
      expect(result).toBeNull();
    } finally {
      try { fs.rmSync(path.dirname(tokenPath), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ─── Unit tests: createBrokerClient — hasToken / no-slug ─────────────────────

describe("createBrokerClient — token discovery", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("hasToken=false when no agent slug provided", () => {
    const client = createBrokerClient();
    expect(client.hasToken).toBe(false);
  });

  it("hasToken=false when slug provided but file doesn't exist", () => {
    const slug = "no-such-agent-" + Date.now();
    const client = createBrokerClient(slug);
    expect(client.hasToken).toBe(false);
  });

  it("hasToken=true when slug provided and token file exists", () => {
    const slug = "test-agent-hastok-" + Date.now();
    const tokenPath = vaultTokenFilePath(slug);
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, "vg_abc123.secret\n", { mode: 0o600 });
    try {
      const client = createBrokerClient(slug);
      expect(client.hasToken).toBe(true);
    } finally {
      try { fs.rmSync(path.dirname(tokenPath), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("accepts agentSlug via opts object", () => {
    const slug = "test-agent-optsslug-" + Date.now();
    const tokenPath = vaultTokenFilePath(slug);
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, "vg_optstest.secret\n", { mode: 0o600 });
    try {
      const client = createBrokerClient({ agentSlug: slug });
      expect(client.hasToken).toBe(true);
    } finally {
      try { fs.rmSync(path.dirname(tokenPath), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ─── Integration tests: get/list with token via real broker ──────────────────

describe("createBrokerClient — get/list with valid token (issue #226)", () => {
  let broker: VaultBroker;
  let socketPath: string;
  let tmpDir: string;
  let grantsDb: Database;
  let prevNonLinuxFlag: string | undefined;

  beforeEach(async () => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "client-token-test-"));
    socketPath = path.join(tmpDir, "test.sock");

    grantsDb = makeInMemoryGrantsDb();

    broker = new VaultBroker({
      _testSecrets: cloneSecrets(),
      _testConfig: makeMinimalConfig(),
      _testGrantsDb: grantsDb,
    });
    await broker.start(socketPath, undefined, undefined);
  });

  afterEach(() => {
    broker.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevNonLinuxFlag === undefined) {
      delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    } else {
      process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
    }
  });

  it("client WITH token: get returns secret (token included in request)", async () => {
    const { token } = await mintGrant(grantsDb, "myagent", ["foo"], null);

    // Write token to a slug-based file so createBrokerClient can find it
    const slug = "myagent-" + Date.now();
    const tokenPath = vaultTokenFilePath(slug);
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
    try {
      const client = createBrokerClient(slug, { socket: socketPath });
      expect(client.hasToken).toBe(true);

      const result = await client.get("foo");
      expect(result.kind).toBe("ok");
      if (result.kind === "ok") {
        expect(result.entry).toEqual({ kind: "string", value: "bar-value" });
      }
    } finally {
      try { fs.rmSync(path.dirname(tokenPath), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("client WITHOUT token: get falls through to peercred (no token field in request)", async () => {
    // No slug → no token → peercred path. On Linux this means denied.
    const client = createBrokerClient({ socket: socketPath });
    expect(client.hasToken).toBe(false);

    const result = await client.get("foo");
    if (process.platform === "linux") {
      // Peercred path: denied (test process isn't a known cron unit)
      expect(result.kind).toBe("denied");
    } else {
      // Non-Linux: no peercred gate — key is returned directly
      expect(result.kind).toBe("ok");
    }
  });

  it("client WITH token: list returns keys", async () => {
    const { token } = await mintGrant(grantsDb, "myagent", ["foo", "baz"], null);

    const slug = "myagent-list-" + Date.now();
    const tokenPath = vaultTokenFilePath(slug);
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, token + "\n", { mode: 0o600 });
    try {
      const client = createBrokerClient(slug, { socket: socketPath });
      const keys = await client.list();
      expect(Array.isArray(keys)).toBe(true);
      expect(keys).toContain("foo");
    } finally {
      try { fs.rmSync(path.dirname(tokenPath), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

// ─── Integration tests: hard-fail on revoked/expired token ───────────────────

describe("createBrokerClient — token rejected (grant-expired / grant-revoked)", () => {
  let broker: VaultBroker;
  let socketPath: string;
  let tmpDir: string;
  let grantsDb: Database;
  let prevNonLinuxFlag: string | undefined;

  beforeEach(async () => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "client-token-reject-test-"));
    socketPath = path.join(tmpDir, "test.sock");

    grantsDb = makeInMemoryGrantsDb();

    broker = new VaultBroker({
      _testSecrets: cloneSecrets(),
      _testConfig: makeMinimalConfig(),
      _testGrantsDb: grantsDb,
    });
    await broker.start(socketPath, undefined, undefined);
  });

  afterEach(() => {
    broker.stop();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    if (prevNonLinuxFlag === undefined) {
      delete process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    } else {
      process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = prevNonLinuxFlag;
    }
    vi.restoreAllMocks();
  });

  it("throws VaultTokenRejectedError(grant-expired) and writes to stderr — does NOT silently fall back", async () => {
    const { token, id } = await mintGrant(grantsDb, "myagent", ["foo"], 3600);
    // Backdate the expiry
    const past = Math.floor(Date.now() / 1000) - 100;
    grantsDb.run("UPDATE vault_grants SET expires_at = ? WHERE id = ?", [past, id]);

    const slug = "myagent-expired-" + Date.now();
    const tokenPath = vaultTokenFilePath(slug);
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, token + "\n", { mode: 0o600 });

    const stderrMsgs: string[] = [];
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(
      (msg: string | Uint8Array) => { stderrMsgs.push(String(msg)); return true; },
    );

    try {
      const client = createBrokerClient(slug, { socket: socketPath });

      await expect(client.get("foo")).rejects.toThrow(VaultTokenRejectedError);
      await expect(client.get("foo")).rejects.toMatchObject({ reason: "grant-expired" });

      // Stderr must mention the error so the operator knows
      expect(stderrMsgs.some((m) => m.includes("[vault-broker] ERROR"))).toBe(true);
      expect(stderrMsgs.some((m) => m.includes("grant-expired"))).toBe(true);
    } finally {
      try { fs.rmSync(path.dirname(tokenPath), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("throws VaultTokenRejectedError(grant-revoked) after revocation — does NOT silently fall back", async () => {
    const { token, id } = await mintGrant(grantsDb, "myagent", ["foo"], null);

    // Verify it works before revocation
    const slug = "myagent-revoked-" + Date.now();
    const tokenPath = vaultTokenFilePath(slug);
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, token + "\n", { mode: 0o600 });

    // Use raw rpc to revoke without going through client (avoids confusion)
    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ path: socketPath });
      let buf = "";
      sock.on("error", reject);
      sock.on("data", (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        if (buf.includes("\n")) { sock.destroy(); resolve(); }
      });
      sock.on("connect", () => {
        sock.write(encodeRequest({ v: 1, op: "revoke_grant", id }));
      });
    });

    const stderrMsgs: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(
      (msg: string | Uint8Array) => { stderrMsgs.push(String(msg)); return true; },
    );

    try {
      const client = createBrokerClient(slug, { socket: socketPath });

      await expect(client.get("foo")).rejects.toThrow(VaultTokenRejectedError);
      await expect(client.get("foo")).rejects.toMatchObject({ reason: "grant-revoked" });
      expect(stderrMsgs.some((m) => m.includes("grant-revoked"))).toBe(true);
    } finally {
      try { fs.rmSync(path.dirname(tokenPath), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  // #226 review-fix: list() must hard-fail on token rejection, not return null silently.
  it("list() throws VaultTokenRejectedError(grant-expired) — same hard-fail as get()", async () => {
    const { token, id } = await mintGrant(grantsDb, "myagent", ["foo"], 3600);
    const past = Math.floor(Date.now() / 1000) - 100;
    grantsDb.run("UPDATE vault_grants SET expires_at = ? WHERE id = ?", [past, id]);

    const slug = "myagent-list-expired-" + Date.now();
    const tokenPath = vaultTokenFilePath(slug);
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true });
    fs.writeFileSync(tokenPath, token + "\n", { mode: 0o600 });

    const stderrMsgs: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(
      (msg: string | Uint8Array) => { stderrMsgs.push(String(msg)); return true; },
    );

    try {
      const client = createBrokerClient(slug, { socket: socketPath });

      await expect(client.list()).rejects.toThrow(VaultTokenRejectedError);
      await expect(client.list()).rejects.toMatchObject({ reason: "grant-expired" });
      expect(stderrMsgs.some((m) => m.includes("grant-expired"))).toBe(true);
    } finally {
      try { fs.rmSync(path.dirname(tokenPath), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
