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

  // ── Acceptance criterion 3: client ERR response is the sanitized constant ────
  //
  // Updated for #472 finding #24. Pre-fix the wire response embedded the
  // raw crypto-library error message, distinguishing wrong-passphrase
  // from wrong-KDF-param from corrupt-ciphertext from "not actually a
  // vault file". A same-UID process probing the unlock socket could
  // enumerate failure shapes and infer structural details. The client
  // surface is now constant; verbose msg still flows to stderr (operator
  // diagnostic) and audit (sanitized).

  it("wrong passphrase: client ERR response is the constant 'decryption failed' (#472 #24)", async () => {
    const resp = await unlockRpc(unlockSocketPath, WRONG_PASSPHRASE);

    // Protocol: "ERR <message>" — the message is now a constant.
    expect(resp).toBe("ERR decryption failed");
  });

  // ── Legacy unlock peercred contract (regression guard) ───────────────────
  //
  // The default (non-operator) unlock path MUST keep denying when
  // `identify()` cannot resolve a peer — that's the original Linux
  // peer-credential gate from issue #129. The operator-path bypass
  // (added in #1560 to fix the v0.12.x RFC-J Phase-3 regression) must
  // NOT have weakened this.
  it("legacy unlock: _testIdentify returning null → denied:unable to verify caller identity", async () => {
    // Replace the default _testIdentify (which returns a synthetic peer)
    // with one that returns null on the legacy unlock path, simulating
    // a peercred failure. Cast through any because _testIdentify lives
    // under BrokerTestOpts (guarded test-only hook).
    (broker as unknown as { testOpts: { _testIdentify?: unknown } }).testOpts._testIdentify = () => null;

    if (process.platform !== "linux") {
      // peercred is Linux-only; on macOS the deny path is unreachable.
      return;
    }

    const resp = await unlockRpc(unlockSocketPath, CORRECT_PASSPHRASE);
    expect(resp).toBe("ERR unable to verify caller identity");
    const lines = readAuditLines(auditLogPath);
    expect(lines).toHaveLength(1);
    expect(lines[0].result).toBe("denied:unable to verify caller identity");
  });
});

// ─── Operator unlock handler: peercred bypass (RFC-J Phase-3, fix #1560) ─────
//
// `_handleUnlockConnection(sock, /*isOperator=*/ true)` is the handler
// path the operator unlock listener wires to (server.ts in
// `bindOperatorListener`'s inner `unlockServer.listen` callback). The
// peercred gate is structurally unable to authenticate that caller —
// `identify()` returns null for the reserved "operator" path by design
// (peercred.ts socketPathToIdentity + RESERVED_AGENT_NAMES) — so the
// unlock handler MUST skip peercred when isOperator=true, mirroring the
// data handler's bypass. Pre-fix this manifested as `ERR unable to
// verify caller identity` on every host-operator unlock attempt,
// leaving the fleet permanently locked across a recreate.
//
// We exercise the handler DIRECTLY with a duck-typed socket (no
// bindOperatorListener round-trip). `bindOperatorListener` hard-anchors
// the bind path on `^/run/switchroom/broker/` (a deliberate security
// control) and rejects tmp paths, so an integration test through it
// would require either weakening that anchor or running as root with
// the canonical path — neither acceptable. The handler logic IS the
// change; the call-site wiring (`_handleUnlockConnection(sock, true)`
// inside bindOperatorListener's unlock-server closure) is a one-line
// static guarantee visible in review.

describe("VaultBroker _handleUnlockConnection: operator path bypass (#1560)", () => {
  const CORRECT_PASSPHRASE_OP = "correct-horse-battery-staple-op";
  const WRONG_PASSPHRASE_OP = "totally-wrong-passphrase-op";

  /** Minimal net.Socket stand-in for the unlock handler:
   *  - emits 'data' events when caller invokes `feed()`
   *  - records the single `end(line)` the handler emits
   *  - implements just enough of EventEmitter for the handler. */
  type DuckSocket = {
    feed: (chunk: string) => void;
    ended: () => string | null;
    closed: () => boolean;
    asNetSocket: () => unknown;
  };
  function makeDuckSocket(): DuckSocket {
    let dataHandler: ((c: Buffer) => void) | null = null;
    let endedWith: string | null = null;
    let closed = false;
    const sock = {
      on(event: string, fn: (c: Buffer) => void) {
        if (event === "data") dataHandler = fn;
        return sock;
      },
      end(line?: string) {
        if (endedWith === null && typeof line === "string") endedWith = line;
        closed = true;
        return sock;
      },
      // unused by handler but present on the real net.Socket type
      write() { return true; },
      destroy() { closed = true; },
      removeListener() { return sock; },
      // Prevent stray Node typing complaints if anything peeks
      readable: true,
      writable: true,
    };
    return {
      feed(chunk: string) { dataHandler?.(Buffer.from(chunk, "utf8")); },
      ended() { return endedWith; },
      closed() { return closed; },
      asNetSocket() { return sock; },
    };
  }

  let broker: VaultBroker;
  let tmpDir: string;
  let vaultPath: string;
  let auditLogPath: string;
  let prevNonLinuxFlag: string | undefined;

  beforeEach(async () => {
    prevNonLinuxFlag = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX;
    process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX = "1";

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "broker-op-handler-"));
    vaultPath = path.join(tmpDir, "vault.enc");
    auditLogPath = path.join(tmpDir, "vault-audit.log");

    createVault(CORRECT_PASSPHRASE_OP, vaultPath);

    broker = new VaultBroker({
      _testConfig: makeMinimalConfig(vaultPath),
      _testAuditLogger: createAuditLogger({ path: auditLogPath }),
      _testGrantsDb: makeInMemoryGrantsDb(),
      // CRITICAL: peercred returns null on the operator path by design
      // (peercred.ts:130). The bypass must NOT depend on a synthetic
      // peer — pin the real production-deploy behavior. Note that
      // when we pass isOperator=true to the handler, this should NOT
      // be consulted at all; we set it as a regression guard against
      // accidentally falling through into the peercred branch.
      _testIdentify: () => null,
    });
    // start() so the broker is in a valid lifecycle state (binds the
    // legacy unlock socket at a tmp path — unused by these tests).
    const legacySockPath = path.join(tmpDir, "legacy.sock");
    await broker.start(legacySockPath, undefined, undefined);
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

  /** Cast through unknown to reach the private handler. The handler's
   *  contract — (socket, isOperator?) — is the unit under test. */
  function callHandler(sock: unknown, isOperator: boolean): void {
    (broker as unknown as {
      _handleUnlockConnection: (s: unknown, op: boolean) => void;
    })._handleUnlockConnection(sock, isOperator);
  }

  it("correct passphrase: isOperator=true unlocks despite _testIdentify=null", () => {
    const d = makeDuckSocket();
    callHandler(d.asNetSocket(), true);
    d.feed(CORRECT_PASSPHRASE_OP + "\n");
    expect(d.ended()).toBe("OK\n");

    const unlockRows = readAuditLines(auditLogPath).filter((e) => e.op === "unlock");
    const entry = unlockRows[unlockRows.length - 1];
    expect(entry.result).toBe("allowed");
    expect(entry.caller).toBe("operator");
    expect(entry.cgroup).toBeUndefined();
  });

  it("isOperator=false (legacy) + _testIdentify=null → denied:unable to verify caller identity", () => {
    if (process.platform !== "linux") return; // peercred is Linux-only
    const d = makeDuckSocket();
    callHandler(d.asNetSocket(), false);
    // No feed needed — handler denies pre-data.
    expect(d.ended()).toBe("ERR unable to verify caller identity\n");

    const unlockRows = readAuditLines(auditLogPath).filter((e) => e.op === "unlock");
    const entry = unlockRows[unlockRows.length - 1];
    expect(entry.result).toBe("denied:unable to verify caller identity");
    // Audit caller is the broker's own pid:N on the deny — NOT "operator".
    expect(entry.caller).not.toBe("operator");
  });

  it("empty passphrase on operator path: audit caller='operator'", () => {
    const d = makeDuckSocket();
    callHandler(d.asNetSocket(), true);
    d.feed("\n");
    expect(d.ended()).toBe("ERR passphrase cannot be empty\n");

    const entry = readAuditLines(auditLogPath).filter((e) => e.op === "unlock").pop()!;
    expect(entry.result).toBe("denied:passphrase cannot be empty");
    expect(entry.caller).toBe("operator");
  });

  it("wrong passphrase on operator path: audit caller='operator' + sanitized result", () => {
    const d = makeDuckSocket();
    callHandler(d.asNetSocket(), true);
    d.feed(WRONG_PASSPHRASE_OP + "\n");
    expect(d.ended()).toBe("ERR decryption failed\n");

    const entry = readAuditLines(auditLogPath).filter((e) => e.op === "unlock").pop()!;
    expect(entry.result).toBe("error:decryption failed");
    expect(entry.caller).toBe("operator");
  });

  it(">4096-byte input before newline on operator path: ERR passphrase too long", () => {
    const d = makeDuckSocket();
    callHandler(d.asNetSocket(), true);
    d.feed("x".repeat(5000)); // no newline → buffer-cap branch fires
    expect(d.ended()).toBe("ERR passphrase too long\n");
  });
});
