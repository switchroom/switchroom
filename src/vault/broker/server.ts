/**
 * vault-broker server — Unix socket daemon that holds the decrypted vault
 * in memory and serves secrets to authorized cron scripts.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ SECURITY DESIGN                                                         │
 * │                                                                         │
 * │ Data socket   ~/.switchroom/vault-broker.sock     mode 0600             │
 * │   Serves get / list / status / lock requests.                           │
 * │   Caller is identified via peercred (Linux: ss + /proc).               │
 * │   Each get request goes through ACL before returning any secret.        │
 * │                                                                         │
 * │ Unlock socket ~/.switchroom/vault-broker.unlock.sock  mode 0600         │
 * │   Accepts ONE plaintext line per connection: the vault passphrase.      │
 * │   This is NOT JSON-framed and NOT part of the data protocol.            │
 * │   Only the same UID may connect (enforced by socket file mode 0600 and  │
 * │   confirmed by peercred when available).                                │
 * │   Responds with "OK\n" on success, "ERR <message>\n" on failure.        │
 * │   The passphrase NEVER crosses the data socket.                         │
 * │                                                                         │
 * │ sd_notify     NOTIFY_SOCKET env var (abstract unix socket)              │
 * │   When set, sends "READY=1\n" after both sockets are listening.         │
 * │   No external dependency — implemented inline.                          │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

import * as net from "node:net";
import { mkdirSync, chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import * as os from "node:os";
import * as path from "node:path";
import type { SwitchroomConfig } from "../../config/schema.js";
import { openVault, type VaultEntry } from "../vault.js";
import { resolvePath } from "../../config/loader.js";
import { identify, type PeerInfo } from "./peercred.js";
import { checkAcl, checkEntryScope, agentSlugFromPeer, parseCronUnit } from "./acl.js";
import {
  decodeRequest,
  encodeResponse,
  errorResponse,
  entryResponse,
  MAX_FRAME_BYTES,
  type BrokerStatus,
} from "./protocol.js";
import { createAuditLogger, callerFromPeer, type AuditLogger } from "./audit-log.js";
import { Database } from "bun:sqlite";
import { mintGrant, validateGrant, revokeGrant, listGrants, migrateGrantsSchema } from "../grants.js";
import { openGrantsDb } from "../grants-db.js";

const PID_FILE_DEFAULT = "~/.switchroom/vault-broker.pid";

/** Options accepted by the test-only constructor path. */
export interface BrokerTestOpts {
  /**
   * If provided, the broker starts with these pre-loaded secrets instead of
   * reading from a vault file. Bypasses the passphrase/KDF entirely.
   * DO NOT use outside tests.
   */
  _testSecrets?: Record<string, VaultEntry>;
  /**
   * If provided, use this config instead of loading from configPath.
   */
  _testConfig?: SwitchroomConfig;
  /**
   * If provided, replaces the real `identify()` call on every connection.
   * Returns the PeerInfo the broker should treat as the caller's identity,
   * or null to simulate "unidentified" (broker denies).
   *
   * Without this hook, Linux unit tests can only ever exercise the deny
   * path — the test process isn't a switchroom-…-cron-… cgroup, so the
   * real identify() correctly returns null. Stubbing here lets us cover
   * the happy path (allowed cron unit) without spinning up systemd-run.
   *
   * Production codepath is unchanged: when this is undefined the broker
   * calls the real `identify()`. DO NOT set outside tests.
   */
  _testIdentify?: (socketPath: string, socket: net.Socket) => PeerInfo | null;
  /**
   * If provided, replaces the real audit logger. Use in tests to inject a
   * logger that writes to a tmp file instead of ~/.switchroom/vault-audit.log.
   * DO NOT set outside tests.
   */
  _testAuditLogger?: AuditLogger;
  /**
   * If provided, use this Database handle for the grants DB instead of
   * opening ~/.switchroom/vault-grants.db. Use an in-memory SQLite DB in tests.
   * DO NOT set outside tests.
   */
  _testGrantsDb?: Database;
}

export class VaultBroker {
  private secrets: Record<string, VaultEntry> | null = null;
  private config: SwitchroomConfig | null = null;
  private startedAt: number = Date.now();
  private server: net.Server | null = null;
  private unlockServer: net.Server | null = null;
  private socketPath: string = "";
  private unlockSocketPath: string = "";
  private vaultPath: string = "";
  private auditLogger: AuditLogger;
  private grantsDb: Database;

  constructor(private readonly testOpts: BrokerTestOpts = {}) {
    // Defence-in-depth: BrokerTestOpts is exported (so vitest can construct
    // brokers with seeded state and a stubbed identify()), but each field
    // bypasses a security boundary — secrets pre-load, config injection,
    // and forged peer identity. None of the production callers set these
    // (see src/cli/vault-broker.ts), so we hard-fail outside test runners.
    // vitest sets NODE_ENV=test by default; production builds do not.
    const usingTestOpt =
      testOpts._testSecrets !== undefined ||
      testOpts._testConfig !== undefined ||
      testOpts._testIdentify !== undefined ||
      testOpts._testAuditLogger !== undefined ||
      testOpts._testGrantsDb !== undefined;
    if (usingTestOpt && process.env.NODE_ENV !== "test") {
      throw new Error(
        "VaultBroker: BrokerTestOpts (_testSecrets/_testConfig/_testIdentify/_testAuditLogger/_testGrantsDb) " +
          "must not be set outside tests. Set NODE_ENV=test if you really mean it.",
      );
    }

    // Use the injected logger for tests; create the real one for production.
    // The real logger's path defaults to ~/.switchroom/vault-audit.log.
    this.auditLogger = testOpts._testAuditLogger ?? createAuditLogger();

    // Open (or inject) the grants database. In tests we use :memory: via the
    // _testGrantsDb knob. In production we open the canonical disk path at
    // construction time so the DB handle is ready before the first request.
    if (testOpts._testGrantsDb !== undefined) {
      this.grantsDb = testOpts._testGrantsDb;
    } else {
      this.grantsDb = openGrantsDb();
    }
  }

  /**
   * Start the broker — bind both sockets, write PID file, notify systemd.
   *
   * @param socketPath   Path for the data socket. Created mode 0600.
   * @param configPath   Path to switchroom.yaml (or undefined to auto-detect).
   * @param vaultPath    Path to the encrypted vault file.
   */
  async start(
    socketPath: string,
    configPath: string | undefined,
    vaultPath?: string,
  ): Promise<void> {
    // Linux-only by design (issue #129). The broker's ACL is a cgroup-based
    // identity check on the calling cron systemd unit; that primitive only
    // exists on Linux. On macOS / WSL the only access control would be the
    // socket's file mode (0600), which we don't consider sufficient for
    // multi-cron secret routing. Fail-fast with an actionable message
    // instead of silently degrading.
    //
    // Opt-out for dev / tests: SWITCHROOM_BROKER_ALLOW_NON_LINUX=1.
    if (
      process.platform !== "linux" &&
      process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX !== "1"
    ) {
      throw new Error(
        `vault-broker is Linux-only (running on ${process.platform}). ` +
        `The broker's ACL relies on cgroup-based systemd unit identification, ` +
        `which is not available on this platform. ` +
        `Use 'switchroom vault get --no-broker' for direct vault access. ` +
        `If you need to run the broker for development on this platform, ` +
        `set SWITCHROOM_BROKER_ALLOW_NON_LINUX=1 — but understand that the ` +
        `broker will accept any same-user caller without per-cron ACL enforcement.`,
      );
    }

    this.socketPath = resolve(socketPath);
    this.unlockSocketPath = this.socketPath.replace(/\.sock$/, ".unlock.sock");
    this.startedAt = Date.now();

    // Load config
    if (this.testOpts._testConfig) {
      this.config = this.testOpts._testConfig;
    } else {
      const { loadConfig } = await import("../../config/loader.js");
      this.config = loadConfig(configPath);
    }

    // Resolve vault path from config or override
    if (vaultPath) {
      this.vaultPath = resolve(vaultPath);
    } else {
      this.vaultPath = resolvePath(this.config.vault?.path ?? "~/.switchroom/vault.enc");
    }

    // Pre-load secrets if test opts provided
    if (this.testOpts._testSecrets !== undefined) {
      this.secrets = { ...this.testOpts._testSecrets };
    }

    // Ensure parent directory exists and is mode 0700
    const parentDir = dirname(this.socketPath);
    mkdirSync(parentDir, { recursive: true });
    try {
      chmodSync(parentDir, 0o700);
    } catch {
      // May fail if directory already has correct perms from another process
    }

    // Remove stale sockets
    for (const p of [this.socketPath, this.unlockSocketPath]) {
      if (existsSync(p)) {
        try { unlinkSync(p); } catch { /* ignore */ }
      }
    }

    // Bind data socket
    await this._bindDataSocket();

    // Bind unlock socket
    await this._bindUnlockSocket();

    // Write PID file
    this._writePidFile();

    // Notify systemd if NOTIFY_SOCKET is set
    this._sdNotify("READY=1\n");

    // Auto-unlock from $CREDENTIALS_DIRECTORY if the credential was injected
    // by systemd LoadCredentialEncrypted= (opt-in via vault.broker.autoUnlock).
    this._tryAutoUnlockFromCredentials();

    if (process.platform !== "linux") {
      // Reachable only when SWITCHROOM_BROKER_ALLOW_NON_LINUX=1 was set
      // (the start() guard above would have thrown otherwise). Log a loud
      // warning so dev runs can't be confused with production semantics.
      process.stderr.write(
        `[vault-broker] WARNING: running on ${process.platform} with ` +
        `SWITCHROOM_BROKER_ALLOW_NON_LINUX=1 — peercred ACL is disabled. ` +
        `Access control is socket file mode 0600 ONLY. Do not use this ` +
        `configuration for production secrets.\n`,
      );
    }
  }

  /**
   * Unlock the vault using the given passphrase.
   * Throws VaultError on bad passphrase or unreadable vault.
   */
  unlockFromPassphrase(passphrase: string): void {
    const secrets = openVault(passphrase, this.vaultPath);
    this.secrets = secrets;
    // Overwrite the passphrase string in place (best-effort; JS strings are
    // immutable but we ensure the reference is dropped immediately).
    // The caller should also zero their copy.
  }

  /**
   * Lock the broker — wipe in-memory secrets and null the reference.
   */
  lock(): void {
    if (this.secrets !== null) {
      // Best-effort overwrite of string values before GC
      for (const [, entry] of Object.entries(this.secrets)) {
        try {
          if (entry.kind === "string" || entry.kind === "binary") {
            // Strings are immutable in JS — we can't zero the underlying bytes.
            // We drop the reference and rely on GC. This is a known limitation
            // documented in the security design notes.
            (entry as { value: string }).value = "";
          }
        } catch { /* best-effort */ }
      }
      this.secrets = null;
    }
  }

  /**
   * Stop the broker — lock, close both sockets, exit.
   */
  stop(): void {
    this.lock();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (this.unlockServer) {
      this.unlockServer.close();
      this.unlockServer = null;
    }
    // Clean up socket files
    for (const p of [this.socketPath, this.unlockSocketPath]) {
      if (p && existsSync(p)) {
        try { unlinkSync(p); } catch { /* ignore */ }
      }
    }
    // Remove PID file
    try {
      const pidPath = resolvePath(PID_FILE_DEFAULT);
      if (existsSync(pidPath)) unlinkSync(pidPath);
    } catch { /* ignore */ }
  }

  /**
   * Get the current status (for testing / status RPC).
   */
  getStatus(): BrokerStatus {
    return {
      unlocked: this.secrets !== null,
      keyCount: this.secrets !== null ? Object.keys(this.secrets).length : 0,
      uptimeSec: (Date.now() - this.startedAt) / 1000,
    };
  }

  /**
   * Test-only: return direct reference to the internal secrets map.
   * Used by server tests to verify lock() zeroes state.
   */
  _getSecretsRef(): Record<string, VaultEntry> | null {
    return this.secrets;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  private _bindDataSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        this._handleDataConnection(socket);
      });

      server.on("error", (err) => {
        reject(err);
      });

      server.listen(this.socketPath, () => {
        try {
          chmodSync(this.socketPath, 0o600);
        } catch { /* ignore */ }
        this.server = server;
        resolve();
      });
    });
  }

  private _bindUnlockSocket(): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = net.createServer((socket) => {
        this._handleUnlockConnection(socket);
      });

      server.on("error", (err) => {
        reject(err);
      });

      server.listen(this.unlockSocketPath, () => {
        try {
          chmodSync(this.unlockSocketPath, 0o600);
        } catch { /* ignore */ }
        this.unlockServer = server;
        resolve();
      });
    });
  }

  private _handleDataConnection(socket: net.Socket): void {
    // Identify peer immediately on accept (Linux only). Pass the accepted
    // socket so identify() can use SO_PEERCRED via bun:ffi (bun runtime) or
    // pin its ss-output lookup to the server-side fd's inode (node runtime).
    // Without the socket, identify() falls back to the legacy first-row-wins
    // ss lookup which has a documented concurrency hazard. See issue #129.
    let peer: PeerInfo | null = null;
    if (process.platform === "linux") {
      peer = this.testOpts._testIdentify
        ? this.testOpts._testIdentify(this.socketPath, socket)
        : identify(this.socketPath, socket);
    }

    let buffer = "";

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");

      // Guard against oversized buffers (>64 KiB without a newline)
      if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
        const resp = encodeResponse(
          errorResponse("BAD_REQUEST", "Frame exceeds 64 KiB limit"),
        );
        socket.write(resp);
        socket.destroy();
        return;
      }

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trimEnd();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line) continue;

        this._handleRequest(socket, peer, line);
      }
    });

    socket.on("error", () => {
      socket.destroy();
    });
  }

  private async _handleRequest(
    socket: net.Socket,
    peer: import("./peercred.js").PeerInfo | null,
    line: string,
  ): Promise<void> {
    let req: ReturnType<typeof import("./protocol.js").decodeRequest>;
    try {
      req = decodeRequest(line);
    } catch (err) {
      const resp = encodeResponse(
        errorResponse(
          "BAD_REQUEST",
          err instanceof Error ? err.message : "Malformed request",
        ),
      );
      socket.write(resp);
      return;
    }

    // Derive audit identity fields from peer (already computed by peercred at
    // connection accept time — do NOT re-derive here).
    const auditPid = peer?.pid ?? process.pid;
    const auditCaller = peer !== null ? callerFromPeer(peer) : `pid:${process.pid}`;
    const auditCgroup = peer?.systemdUnit ?? undefined;

    // Handle each op
    if (req.op === "status") {
      // status is an informational op — not audited (no secret access, no ACL decision)
      const status = this.getStatus();
      socket.write(
        encodeResponse({ ok: true, status }),
      );
      return;
    }

    if (req.op === "lock") {
      this.lock();
      this.auditLogger.write({
        ts: new Date().toISOString(),
        op: "lock",
        caller: auditCaller,
        pid: auditPid,
        cgroup: auditCgroup,
        result: "allowed",
      });
      socket.write(encodeResponse({ ok: true, locked: true }));
      return;
    }

    if (req.op === "list") {
      if (this.secrets === null) {
        socket.write(encodeResponse(errorResponse("LOCKED", "Vault is locked")));
        return;
      }

      // ── Token-based list (capability grant) ────────────────────────────
      // When a token is provided, return only keys the grant covers (those
      // that exist in the vault). Bypasses peercred ACL — token IS the auth.
      if (req.token !== undefined) {
        // For list, we validate against a sentinel key ("*") to just check
        // the token signature/expiry/revocation status, then filter by
        // key_allow. We validate directly by checking any allowed key.
        const dotIdx = req.token.indexOf(".");
        const grantId = dotIdx !== -1 ? req.token.slice(0, dotIdx) : undefined;

        // Look up the grant row to get key_allow without checking a specific key
        // We validate the token against a non-existent key to get the grant row,
        // but we need to handle "grant-key-not-allowed" specially for list.
        // Instead, validate against the first known vault key (or a dummy check).
        // Simplest: attempt validateGrant with a placeholder, accept ok or key-not-allowed
        // (both mean token itself is valid). Only reject expired/revoked/invalid.
        const sentinelKey = Object.keys(this.secrets)[0] ?? "__list_check__";
        const tokenCheck = await validateGrant(this.grantsDb, req.token, sentinelKey);

        // If the token is invalid/expired/revoked, deny
        if (!tokenCheck.ok && tokenCheck.reason !== "grant-key-not-allowed") {
          this.auditLogger.write({
            ts: new Date().toISOString(),
            op: "list",
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: `denied:${tokenCheck.reason}`,
            method: "grant",
            grant_id: grantId,
          });
          socket.write(encodeResponse(errorResponse("DENIED", tokenCheck.reason)));
          return;
        }

        // Token is valid (ok or key-not-allowed means auth is fine).
        // Get the key_allow list from the grant row.
        const grantRow = tokenCheck.ok
          ? tokenCheck.grant
          : this.grantsDb
              .query<{ key_allow: string }, [string]>(
                "SELECT key_allow FROM vault_grants WHERE id = ?",
              )
              .get(grantId ?? "");

        const allowedKeys: string[] = grantRow
          ? (typeof (grantRow as { key_allow: string[] | string }).key_allow === "string"
              ? JSON.parse((grantRow as { key_allow: string }).key_allow)
              : (grantRow as { key_allow: string[] }).key_allow)
          : [];

        // Filter to keys that exist in the vault AND are allowed by the grant
        const visibleKeys = allowedKeys.filter((k) => k in this.secrets!);

        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "list",
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: `allowed:${visibleKeys.length}`,
          method: "grant",
          grant_id: grantId,
        });
        socket.write(encodeResponse({ ok: true, keys: visibleKeys }));
        return;
      }

      // ── Peercred path (no token) ────────────────────────────────────────
      // Issue #129 review: `list` previously skipped peercred entirely, so
      // any same-UID caller could enumerate vault key names without proving
      // identity. Inconsistent with `get`, which requires peer != null on
      // Linux. Apply the same Linux peercred gate here so cron units can
      // still list (for diagnostics) but a non-cron same-UID caller can't.
      // On non-Linux the socket-file mode 0600 remains the only gate.
      if (process.platform === "linux" && peer === null) {
        const reason = "Unable to identify caller (peercred unavailable); denying on Linux";
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "list",
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: `denied:${reason}`,
        });
        socket.write(
          encodeResponse(
            errorResponse(
              "DENIED",
              reason,
            ),
          ),
        );
        return;
      }

      // Two gates apply to `list`, BOTH must pass for a key to be visible:
      //   1. Per-key ACL (#207): the caller's cron unit must be allowed to
      //      read the key under its `schedule.secrets` allowlist.
      //   2. Per-entry scope (#8): the entry's allow/deny lists must permit
      //      the caller's agent slug.
      //
      // Reviewer-flagged bypass for #8: this PR's worker REPLACED gate 1
      // with gate 2 (rather than adding gate 2 ON TOP of gate 1). That
      // allowed an agent without an ACL claim on key X to still enumerate
      // X's name as long as X had no scope set. Now both gates fire.
      //
      // Interactive sessions (peer===null on non-Linux, or no config) skip
      // gate 1 (no identity to gate on) but still apply gate 2 with a null
      // slug — a deny list with literal-null entries would still take
      // effect; an allow list of named agents would block (null is not in
      // any named list). The socket file mode 0600 is the outer gate for
      // that case.
      const listAgentSlug = peer !== null ? agentSlugFromPeer(peer) : null;
      let visibleKeys: string[];
      if (peer !== null && this.config !== null) {
        visibleKeys = Object.entries(this.secrets)
          .filter(
            ([key, entry]) =>
              checkAcl(peer, this.config!, key).allow &&
              checkEntryScope(entry.scope, listAgentSlug).allow,
          )
          .map(([k]) => k);
      } else {
        visibleKeys = Object.entries(this.secrets)
          .filter(([, entry]) => checkEntryScope(entry.scope, listAgentSlug).allow)
          .map(([k]) => k);
      }

      // Audit the visible key count (#207). A bare "allowed" hides the case
      // where an identified cron unit's filter narrows to zero keys — almost
      // certainly a misconfiguration, but invisible in the log without the
      // count. `allowed:N` lets an operator grep for `result: "allowed:0"`.
      this.auditLogger.write({
        ts: new Date().toISOString(),
        op: "list",
        caller: auditCaller,
        pid: auditPid,
        cgroup: auditCgroup,
        result: `allowed:${visibleKeys.length}`,
      });
      socket.write(encodeResponse({ ok: true, keys: visibleKeys }));
      return;
    }

    if (req.op === "get") {
      if (this.secrets === null) {
        socket.write(encodeResponse(errorResponse("LOCKED", "Vault is locked")));
        return;
      }

      // ── Token-based access (capability grant) ────────────────────────────
      // When the request includes a token field, validate via the grants module
      // and bypass the peercred ACL entirely. Token IS the auth.
      if (req.token !== undefined) {
        const grantResult = await validateGrant(this.grantsDb, req.token, req.key);
        if (grantResult.ok) {
          const grantId = grantResult.grant.id;
          const entry = this.secrets[req.key];
          if (entry === undefined) {
            this.auditLogger.write({
              ts: new Date().toISOString(),
              op: "get",
              key: req.key,
              caller: auditCaller,
              pid: auditPid,
              cgroup: auditCgroup,
              result: "error:UNKNOWN_KEY",
              method: "grant",
              grant_id: grantId,
            });
            socket.write(
              encodeResponse(errorResponse("UNKNOWN_KEY", `Key not found: ${req.key}`)),
            );
            return;
          }
          this.auditLogger.write({
            ts: new Date().toISOString(),
            op: "get",
            key: req.key,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: "allowed",
            method: "grant",
            grant_id: grantId,
          });
          socket.write(encodeResponse(entryResponse(entry)));
          return;
        } else {
          // Token present but invalid — extract grant_id for audit (ID portion only)
          const dotIdx = req.token.indexOf(".");
          const grantId = dotIdx !== -1 ? req.token.slice(0, dotIdx) : undefined;
          const denyReason = grantResult.reason; // e.g. "grant-expired"
          this.auditLogger.write({
            ts: new Date().toISOString(),
            op: "get",
            key: req.key,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: `denied:${denyReason}`,
            method: "grant",
            grant_id: grantId,
          });
          socket.write(
            encodeResponse(errorResponse("DENIED", denyReason)),
          );
          return;
        }
      }

      // ── Peercred ACL path (no token) ────────────────────────────────────
      if (peer !== null && this.config !== null) {
        const aclResult = checkAcl(peer, this.config, req.key);
        if (!aclResult.allow) {
          this.auditLogger.write({
            ts: new Date().toISOString(),
            op: "get",
            key: req.key,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: `denied:${aclResult.reason}`,
          });
          socket.write(
            encodeResponse(
              errorResponse("DENIED", aclResult.reason),
            ),
          );
          return;
        }
      } else if (process.platform === "linux" && peer === null) {
        // On Linux, peercred unavailable → fail-closed
        const reason = "Unable to identify caller (peercred unavailable); denying on Linux";
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "get",
          key: req.key,
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: `denied:${reason}`,
        });
        socket.write(
          encodeResponse(
            errorResponse(
              "DENIED",
              reason,
            ),
          ),
        );
        return;
      }
      // On non-Linux: ACL is skipped (socket file mode 0600 is the guard)

      const entry = this.secrets[req.key];
      if (entry === undefined) {
        // Key not found — still audited (caller was allowed but key doesn't exist)
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "get",
          key: req.key,
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: "error:UNKNOWN_KEY",
        });
        socket.write(
          encodeResponse(errorResponse("UNKNOWN_KEY", `Key not found: ${req.key}`)),
        );
        return;
      }

      // Per-entry scope check (issue #8) — runs AFTER cron-unit ACL passes.
      const getAgentSlug = peer !== null ? agentSlugFromPeer(peer) : null;
      const scopeResult = checkEntryScope(entry.scope, getAgentSlug);
      if (!scopeResult.allow) {
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "get",
          key: req.key,
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: `denied:${scopeResult.reason}`,
        });
        socket.write(
          encodeResponse(
            errorResponse("DENIED", scopeResult.reason),
          ),
        );
        return;
      }

      // Successful get — log only the key name, NEVER the value
      this.auditLogger.write({
        ts: new Date().toISOString(),
        op: "get",
        key: req.key,
        caller: auditCaller,
        pid: auditPid,
        cgroup: auditCgroup,
        result: "allowed",
      });
      socket.write(encodeResponse(entryResponse(entry)));
      return;
    }

    // ── Grant management ops ─────────────────────────────────────────────────
    //
    // #225 review-fix: gate mint_grant / list_grants / revoke_grant on the
    // caller NOT being a cron unit. The intent is "operator-only" — these
    // ops mint capability tokens that grant cron access, so a cron itself
    // must not be able to call them (otherwise a hijacked cron could mint
    // tokens for sibling agents and exfiltrate their keys).
    //
    // Rule:
    //   - peer === null on Linux → deny (fail-closed identity).
    //   - peer with cron-pattern systemdUnit → deny (cron context).
    //   - peer with no systemdUnit OR non-cron systemdUnit → allow
    //     (operator interactive session, or a deliberately-allowed
    //     management agent).
    //
    // Non-Linux dev mode (SWITCHROOM_BROKER_ALLOW_NON_LINUX=1): peer is null
    // but identity is bypassed everywhere — accept the same dev-mode
    // exception used by `get`/`list` so test harnesses can exercise the path.
    const isGrantMgmtOp =
      req.op === "mint_grant" ||
      req.op === "list_grants" ||
      req.op === "revoke_grant";
    if (isGrantMgmtOp) {
      const allowNonLinux = process.env.SWITCHROOM_BROKER_ALLOW_NON_LINUX === "1";
      if (peer === null && !allowNonLinux) {
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: req.op,
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: "denied:peercred-unavailable",
        });
        socket.write(
          encodeResponse(errorResponse("DENIED", "peercred unavailable; cannot verify operator identity")),
        );
        return;
      }
      if (peer !== null && peer.systemdUnit !== null) {
        const parsed = parseCronUnit(peer.systemdUnit);
        if (parsed !== null) {
          this.auditLogger.write({
            ts: new Date().toISOString(),
            op: req.op,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: "denied:cron-cannot-manage-grants",
          });
          socket.write(
            encodeResponse(
              errorResponse(
                "DENIED",
                "Grant management ops are operator-only; cron units cannot mint, list, or revoke grants",
              ),
            ),
          );
          return;
        }
      }
    }

    if (req.op === "mint_grant") {
      // Parse ttl_seconds into a duration for mintGrant
      const { agent, keys, ttl_seconds, description } = req;
      let mintResult: Awaited<ReturnType<typeof mintGrant>>;
      try {
        mintResult = await mintGrant(this.grantsDb, agent, keys, ttl_seconds, description);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "mint_grant",
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: `error:${msg}`,
        });
        socket.write(encodeResponse(errorResponse("INTERNAL", `Failed to mint grant: ${msg}`)));
        return;
      }

      // Write token file atomically at ~/.switchroom/agents/<agent>/.vault-token
      // (mode 0600).
      //
      // #225 review-fix: write-then-rename so a cron racing the mint
      // never reads a partial token. The previous direct writeFileSync left
      // a one-syscall window where the cron could open the file between
      // creation and the bytes being committed. Rename is atomic on Linux
      // for same-filesystem moves.
      try {
        const tokenDir = path.join(os.homedir(), ".switchroom", "agents", agent);
        mkdirSync(tokenDir, { recursive: true });
        const tokenPath = path.join(tokenDir, ".vault-token");
        const tmpPath = `${tokenPath}.tmp.${process.pid}`;
        writeFileSync(tmpPath, mintResult.token, { mode: 0o600 });
        renameSync(tmpPath, tokenPath);
      } catch (err) {
        // Non-fatal: the token is still returned. File write is best-effort.
        process.stderr.write(
          `[vault-broker] mint_grant: failed to write token file for agent ${agent}: ` +
          `${(err as Error).message}\n`
        );
      }

      this.auditLogger.write({
        ts: new Date().toISOString(),
        op: "mint_grant",
        caller: auditCaller,
        pid: auditPid,
        cgroup: auditCgroup,
        result: "allowed",
        method: "grant",
        grant_id: mintResult.id,
      });
      socket.write(
        encodeResponse({
          ok: true,
          token: mintResult.token,
          id: mintResult.id,
          expires_at: mintResult.expires_at,
        }),
      );
      return;
    }

    if (req.op === "list_grants") {
      const grants = listGrants(this.grantsDb, req.agent);
      this.auditLogger.write({
        ts: new Date().toISOString(),
        op: "list_grants",
        caller: auditCaller,
        pid: auditPid,
        cgroup: auditCgroup,
        result: `allowed:${grants.length}`,
      });
      // Strip revoked_at before sending (not part of the GrantMeta wire schema)
      const grantMetas = grants.map(({ id, agent_slug, key_allow, expires_at, created_at, description }) => ({
        id,
        agent_slug,
        key_allow,
        expires_at,
        created_at,
        description,
      }));
      socket.write(encodeResponse({ ok: true, grants: grantMetas }));
      return;
    }

    if (req.op === "revoke_grant") {
      const { id } = req;
      const revoked = revokeGrant(this.grantsDb, id);

      // Best-effort: find and remove any token file for this grant ID.
      // We don't know which agent it belonged to without querying — query the
      // revoked row (revoked_at is now set) to get the agent slug.
      try {
        const row = this.grantsDb
          .query<{ agent_slug: string }, [string]>(
            "SELECT agent_slug FROM vault_grants WHERE id = ?",
          )
          .get(id);
        if (row) {
          const tokenPath = path.join(
            os.homedir(),
            ".switchroom",
            "agents",
            row.agent_slug,
            ".vault-token",
          );
          if (existsSync(tokenPath)) {
            try { unlinkSync(tokenPath); } catch { /* best-effort */ }
          }
        }
      } catch { /* best-effort */ }

      this.auditLogger.write({
        ts: new Date().toISOString(),
        op: "revoke_grant",
        caller: auditCaller,
        pid: auditPid,
        cgroup: auditCgroup,
        result: revoked ? "allowed" : "error:not-found",
        method: "grant",
        grant_id: id,
      });
      socket.write(encodeResponse({ ok: true, revoked }));
      return;
    }

    // Exhaustive check — should not reach here
    socket.write(
      encodeResponse(
        errorResponse("BAD_REQUEST", `Unknown op: ${(req as { op: string }).op}`),
      ),
    );
  }

  private _handleUnlockConnection(socket: net.Socket): void {
    // Same UID check for unlock socket. On Linux: verify via peercred,
    // pinned to this connection's fd (issue #129).
    // On other OSes: rely on socket file mode 0600.
    let unlockPeer: PeerInfo | null = null;
    if (process.platform === "linux") {
      unlockPeer = this.testOpts._testIdentify
        ? this.testOpts._testIdentify(this.unlockSocketPath, socket)
        : identify(this.unlockSocketPath, socket);
      if (unlockPeer === null) {
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "unlock",
          caller: `pid:${process.pid}`,
          pid: process.pid,
          result: "denied:unable to verify caller identity",
        });
        socket.write("ERR unable to verify caller identity\n");
        socket.destroy();
        return;
      }
    }

    const auditPid = unlockPeer?.pid ?? process.pid;
    const auditCaller = unlockPeer !== null ? callerFromPeer(unlockPeer) : `pid:${process.pid}`;
    const auditCgroup = unlockPeer?.systemdUnit ?? undefined;

    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) {
        // Guard against massive input
        if (Buffer.byteLength(buffer, "utf8") > 4096) {
          socket.write("ERR passphrase too long\n");
          socket.destroy();
          buffer = "";
        }
        return;
      }

      // Take exactly the first line as the passphrase
      const passphrase = buffer.slice(0, newlineIdx).trimEnd();
      // Immediately drop the rest (don't process further input)
      buffer = "";

      if (!passphrase) {
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "unlock",
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: "denied:passphrase cannot be empty",
        });
        socket.write("ERR passphrase cannot be empty\n");
        socket.destroy();
        return;
      }

      try {
        this.unlockFromPassphrase(passphrase);
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "unlock",
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: "allowed",
        });
        socket.write("OK\n");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Audit-log secret-leak guard (#206 review):
        // openVault() bubbles up errors from the underlying KDF/cipher
        // library. If that library ever embeds ciphertext bytes, key
        // material, or passphrase context in its error message, putting
        // `msg` verbatim into the audit log would defeat the very thing
        // the log exists to record (who pulled what — never the value).
        //
        // Audit gets a constant string. The raw msg still travels to
        // stderr (operator diagnostics) and to the client (so the user
        // can see WHY their unlock failed) — those surfaces are not the
        // append-only public-record audit channel.
        process.stderr.write(`vault broker: unlock error: ${msg}\n`);
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "unlock",
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: "error:decryption failed",
        });
        socket.write(`ERR ${msg}\n`);
      } finally {
        socket.destroy();
      }
    });

    socket.on("error", () => {
      socket.destroy();
    });
  }

  private _writePidFile(): void {
    try {
      const pidPath = resolvePath(PID_FILE_DEFAULT);
      writeFileSync(pidPath, String(process.pid) + "\n", { mode: 0o600 });
    } catch { /* non-fatal */ }
  }

  /**
   * Attempt to auto-unlock from $CREDENTIALS_DIRECTORY/vault-passphrase.
   * Called once at startup after sd_notify READY=1. Any failure is non-fatal —
   * the broker stays alive and interactive unlock via the unlock socket remains
   * available as a fallback.
   */
  private _tryAutoUnlockFromCredentials(): void {
    const dir = process.env.CREDENTIALS_DIRECTORY;
    if (!dir) return;
    const credPath = `${dir}/vault-passphrase`;
    let passphrase: string;
    try {
      passphrase = readFileSync(credPath, "utf8").replace(/\n+$/, "");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        process.stderr.write(
          `[vault-broker] note: CREDENTIALS_DIRECTORY set but vault-passphrase ` +
          `not present; staying locked\n`
        );
        return;
      }
      process.stderr.write(
        `[vault-broker] auto-unlock read failed: ${(err as Error).message}; ` +
        `falling back to interactive\n`
      );
      return;
    }
    try {
      this.unlockFromPassphrase(passphrase);
      process.stderr.write(
        `[vault-broker] auto-unlocked from $CREDENTIALS_DIRECTORY/vault-passphrase\n`
      );
    } catch (err) {
      process.stderr.write(
        `[vault-broker] auto-unlock failed: ${(err as Error).message}; ` +
        `falling back to interactive\n`
      );
    }
    // Drop the local reference. (Cannot guarantee GC, but no other ref retained.)
    passphrase = "";
  }

  private _sdNotify(message: string): void {
    const notifySocket = process.env.NOTIFY_SOCKET;
    if (!notifySocket) return;

    // The NOTIFY_SOCKET may be an abstract socket (starts with "@") or a
    // path socket. We implement sd_notify inline without dependencies.
    try {
      const socketPath = notifySocket.startsWith("@")
        ? "\0" + notifySocket.slice(1)
        : notifySocket;
      const client = net.createConnection({ path: socketPath });
      client.on("connect", () => {
        client.write(message);
        client.destroy();
      });
      client.on("error", () => {
        // Non-fatal — sd_notify failure doesn't block startup
      });
    } catch { /* non-fatal */ }
  }
}

// ─── Top-level graceful shutdown ─────────────────────────────────────────────

let _globalBroker: VaultBroker | null = null;

export function registerShutdownHandlers(broker: VaultBroker): void {
  _globalBroker = broker;
  const shutdown = (): void => {
    if (_globalBroker) {
      _globalBroker.stop();
      _globalBroker = null;
    }
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
