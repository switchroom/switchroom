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
import { mkdirSync, chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import type { SwitchroomConfig } from "../../config/schema.js";
import { openVault, type VaultEntry } from "../vault.js";
import { resolvePath } from "../../config/loader.js";
import { identify, type PeerInfo } from "./peercred.js";
import { checkAcl, checkEntryScope, agentSlugFromPeer } from "./acl.js";
import {
  decodeRequest,
  encodeResponse,
  errorResponse,
  entryResponse,
  MAX_FRAME_BYTES,
  type BrokerStatus,
} from "./protocol.js";
import { createAuditLogger, callerFromPeer, type AuditLogger } from "./audit-log.js";

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
      testOpts._testAuditLogger !== undefined;
    if (usingTestOpt && process.env.NODE_ENV !== "test") {
      throw new Error(
        "VaultBroker: BrokerTestOpts (_testSecrets/_testConfig/_testIdentify/_testAuditLogger) " +
          "must not be set outside tests. Set NODE_ENV=test if you really mean it.",
      );
    }

    // Use the injected logger for tests; create the real one for production.
    // The real logger's path defaults to ~/.switchroom/vault-audit.log.
    this.auditLogger = testOpts._testAuditLogger ?? createAuditLogger();
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

  private _handleRequest(
    socket: net.Socket,
    peer: import("./peercred.js").PeerInfo | null,
    line: string,
  ): void {
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

      // ACL check
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
