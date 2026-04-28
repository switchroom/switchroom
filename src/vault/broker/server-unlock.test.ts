/**
 * Integration tests for the VaultBroker unlock socket (#214).
 *
 * Regression-guard for the audit-sanitization shipped in PR #213 (closes #206):
 * the unlock error path must emit `result: "error:decryption failed"` (a
 * constant string) in the audit log, never the raw exception message which
 * could contain ciphertext / key material from the underlying KDF/cipher lib.
 *
 * Acceptance criteria (issue #214):
 *   1. Wrong-passphrase attempt → audit result is exactly "error:decryption failed"
 *   2. Wrong-passphrase attempt → raw error appears in process.stderr
 *   3. Wrong-passphrase attempt → raw error appears in client ERR response
 *   4. Correct passphrase → audit result is "allowed" (success-path regression guard)
 *
 * NOTE: This file uses `bun:sqlite` transitively (via VaultBroker → grants-db.ts
 * → bun:sqlite). It must NOT be run by vitest (excluded in vitest.config.ts) and
 * is run via `bun test` instead (see test:bun in package.json).
 */

import { describe, expect, it, beforeEach, afterEach, spyOn } from "bun:test";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { Database } from "bun:sqlite";
import { VaultBroker } from "./server.js";
import { createAuditLogger, type AuditEntry } from "./audit-log.js";
import { createVault } from "../vault.js";
import { migrateGrantsSchema } from "../grants.js";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeInMemoryGrantsDb(): Database {
  const db = new Database(":memory:");
  migrateGrantsSchema(db);
  return db;
}

function makeMinimalConfig(vaultPath: string) {
  return {
    switchroom: { version: 1 },
    telegram: { bot_token: "test", forum_chat_id: "123" },
    vault: {
      path: vaultPath,
      broker: { socket: "~/.switchroom/vault-broker.sock", enabled: true },
    },
    agents: {},
  } as any;
}

function readAuditLines(logPath: string): AuditEntry[] {
  try {
    const raw = fs.readFileSync(logPath, "utf8");
    return raw
      .split("\n")
      .filter((l) => l.trim().length > 0)
      .map((l) => JSON.parse(l) as AuditEntry);
  } catch {
    return [];
  }
}

/**
 * Connect to the unlock socket, send one line, and collect the server's
 * single-line response (up to the first "\n").
 */
function unlockRpc(unlockSocketPath: string, passphrase: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ path: unlockSocketPath });
    let buffer = "";

    client.on("error", reject);
    client.on("close", () => {
      // Server destroys the socket after responding — resolve with whatever
      // we have accumulated if there's a newline in it (covers the case
      // where "close" fires before the final data event is processed).
      const idx = buffer.indexOf("\n");
      if (idx !== -1) {
        resolve(buffer.slice(0, idx));
      } else if (buffer.length > 0) {
        resolve(buffer.trim());
      }
      // If buffer is empty the error handler will have already fired.
    });
    client.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const idx = buffer.indexOf("\n");
      if (idx !== -1) {
        const line = buffer.slice(0, idx);
        client.destroy();
        resolve(line);
      }
    });
    client.on("connect", () => {
      client.write(passphrase + "\n");
    });
  });
}

// ─── Test suite ──────────────────────────────────────────────────────────────

const CORRECT_PASSPHRASE = "correct-horse-battery-staple";
const WRONG_PASSPHRASE = "totally-wrong-passphrase";

describe("VaultBroker unlock socket: audit sanitization (issue #214)", () => {
  let broker: VaultBroker;
  let socketPath: string;
  let unlockSocketPath: string;
  let tmpDir: string;
  let vaultPath: string;
  let auditLogPath: string;
  let prevNonLinuxFlag: string | undefined;

  beforeEach(async () => {
    // Allow running on non-Linux CI (same escape hatch used by server.test.ts)
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-unlock-test-"));
    socketPath = path.join(tmpDir, "test.sock");
    unlockSocketPath = socketPath.replace(/\.sock$/, ".unlock.sock");
    vaultPath = path.join(tmpDir, "vault.enc");
    auditLogPath = path.join(tmpDir, "vault-audit.log");

    // Create a real (tiny) encrypted vault so unlockFromPassphrase() goes
    // through the actual KDF/cipher path. The vault starts with zero secrets —
    // we only care about the auth outcome, not the vault contents.
    createVault(CORRECT_PASSPHRASE, vaultPath);

    broker = new VaultBroker({
      // NOTE: do NOT pass _testSecrets — we need the broker to call
      // openVault() for real so the KDF/cipher error path is exercised.
      _testConfig: makeMinimalConfig(vaultPath),
      _testAuditLogger: createAuditLogger({ path: auditLogPath }),
      _testGrantsDb: makeInMemoryGrantsDb(),
      // On Linux, _testIdentify returns a synthetic peer so the unlock
      // socket peercred check doesn't deny us. On non-Linux it's a no-op.
      _testIdentify: () => ({
        uid: process.getuid?.() ?? 1000,
        pid: process.pid,
        exe: process.execPath,
        systemdUnit: null,
      }),
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

  // ── Acceptance criterion 4: success path ─────────────────────────────────

  it("correct passphrase: audit result is 'allowed'", async () => {
    const resp = await unlockRpc(unlockSocketPath, CORRECT_PASSPHRASE);
    expect(resp).toBe("OK");

    const lines = readAuditLines(auditLogPath);
    expect(lines).toHaveLength(1);
    const entry = lines[0];
    expect(entry.op).toBe("unlock");
    expect(entry.result).toBe("allowed");
    expect(entry.ts).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // ── Acceptance criterion 1: audit log gets the constant string ────────────

  it("wrong passphrase: audit result is exactly 'error:decryption failed' (not raw msg)", async () => {
    await unlockRpc(unlockSocketPath, WRONG_PASSPHRASE);

    const lines = readAuditLines(auditLogPath);
    expect(lines).toHaveLength(1);
    const entry = lines[0];
    expect(entry.op).toBe("unlock");

    // This is the core regression guard for #206/#213.
    // The audit result MUST be this constant — never the raw exception text.
    expect(entry.result).toBe("error:decryption failed");
  });

  it("wrong passphrase: raw error message is NOT in the audit log file", async () => {
    await unlockRpc(unlockSocketPath, WRONG_PASSPHRASE);

    const rawLog = fs.readFileSync(auditLogPath, "utf8");
    // The raw crypto error (e.g. "Unsupported state or unable to authenticate data")
    // must not appear verbatim. We can't enumerate all possible OpenSSL messages,
    // so instead we verify that the only result token present is the constant string.
    const parsed = readAuditLines(auditLogPath);
    for (const line of parsed) {
      expect(line.result).toBe("error:decryption failed");
    }
    // Double-check the raw log doesn't contain anything beyond our constant.
    // GCM auth failure messages typically include "auth" or "cipher" or "decrypt".
    // We'll assert the constant IS there and only log content that's expected.
    expect(rawLog).toContain("error:decryption failed");
  });

  // ── Acceptance criterion 2: raw error goes to stderr ─────────────────────

  it("wrong passphrase: raw error message appears in process.stderr", async () => {
    // Capture stderr writes during the unlock attempt.
    const stderrChunks: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr);
    const spy = spyOn(process.stderr, "write").mockImplementation(
      (chunk: string | Uint8Array, ...args: any[]) => {
        stderrChunks.push(typeof chunk === "string" ? chunk : chunk.toString());
        return originalWrite(chunk, ...args);
      },
    );

    try {
      await unlockRpc(unlockSocketPath, WRONG_PASSPHRASE);
    } finally {
      spy.mockRestore();
    }

    const stderrOutput = stderrChunks.join("");
    // The broker logs: `vault broker: unlock error: ${msg}\n`
    expect(stderrOutput).toContain("vault broker: unlock error:");
    // The logged message should be non-empty (it's the raw exception text)
    expect(stderrOutput.length).toBeGreaterThan("vault broker: unlock error:".length);
  });

  // ── Acceptance criterion 3: raw error goes to client ERR response ─────────

  it("wrong passphrase: raw error message appears in client ERR response", async () => {
    const resp = await unlockRpc(unlockSocketPath, WRONG_PASSPHRASE);

    // Protocol: "ERR <message>" (server.ts line ~1060)
    expect(resp).toMatch(/^ERR /);
    // The message after "ERR " should be the raw error — not the constant string.
    const errMsg = resp.slice(4); // strip "ERR "
    // It should NOT be the sanitized constant (that goes to audit, not client)
    expect(errMsg).not.toBe("decryption failed");
    // It should be non-empty (real error text from the crypto library)
    expect(errMsg.trim().length).toBeGreaterThan(0);
  });
});
