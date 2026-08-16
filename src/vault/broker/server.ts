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
import { mkdirSync, chmodSync, chownSync, existsSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { allocateAgentUid } from "../../agents/compose.js";
import { writeAgentTokenFile } from "./write-token-file.js";
import { dirname, resolve, join, basename } from "node:path";
import * as os from "node:os";
import * as path from "node:path";
import type { SwitchroomConfig } from "../../config/schema.js";
import { openVault, saveVault, VaultError, type VaultEntry } from "../vault.js";
import { inspectVaultLayout } from "../migrate-layout.js";
import { resolvePath, resolveAgentsDir } from "../../config/loader.js";
import {
  AutoUnlockDecryptError,
  DEFAULT_AUTO_UNLOCK_PATH,
  MachineIdUnavailableError,
  readAutoUnlockFile,
} from "../auto-unlock.js";
import { identify, socketPathToAgent, socketPathToIdentity, unlockSocketFor, type PeerInfo } from "./peercred.js";
import { checkAclByAgent, checkEntryScope } from "./acl.js";
import {
  AgentNameSchema,
  decodeRequest,
  encodeResponse,
  errorResponse,
  entryResponse,
  MAX_FRAME_BYTES,
  type BrokerStatus,
} from "./protocol.js";
import { createAuditLogger, callerFromPeer, type AuditLogger } from "./audit-log.js";
import { safeVaultPath } from "./test-isolation-guard.js";
import {
  readVaultStamp,
  refreshVaultIfChanged,
  zeroSecrets,
  type VaultStamp,
} from "./vault-refresh.js";
import { Database } from "bun:sqlite";
import { mintGrant, validateGrant, validateGrantForWrite, revokeGrant, listGrants, migrateGrantsSchema } from "../grants.js";
import { reapUnusableGrantToken } from "./reap-token-file.js";
import { adminOnlyKeysBeingAdded } from "../admin-only-keys.js";
import { openGrantsDb } from "../grants-db.js";
import {
  requestApproval as kernelRequestApproval,
  lookupDecision as kernelLookupDecision,
  consumeNonce as kernelConsumeNonce,
  revokeDecision as kernelRevokeDecision,
  listDecisions as kernelListDecisions,
  recordDecision as kernelRecordDecision,
  getDecision as kernelGetDecision,
  isOperatorVerifiedDecision,
  getNonce as kernelGetNonce,
  countPendingNonces,
  computeRetryAfterMs,
  MAX_PENDING_PER_AGENT,
  MAX_PENDING_GLOBAL,
} from "../approvals/kernel.js";

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
  /**
   * If provided, override the resolved vault file path. Used by the
   * drift-detection test which needs to point the broker at a tmp
   * vault file without going through `start()`'s arg-handling.
   * DO NOT set outside tests.
   */
  _testVaultPath?: string;
  /**
   * If provided, seed `this.passphrase` so passphrase-attested ops
   * (put with passphrase, mint_grant with passphrase per #1012 Phase 2)
   * can be exercised without going through the real unlock flow.
   * DO NOT set outside tests.
   */
  _testPassphrase?: string;
  /**
   * If provided, every incoming connection is treated as agent-bound
   * with this agentName, regardless of the bind path. Lets tests
   * exercise the agent-bound code paths (agent-deny gate, admin-agent
   * trust, passphrase-attestation per #1012 Phase 2) without writing
   * to `/run/switchroom/broker/<name>.sock` which a non-root test
   * process cannot create.
   *
   * Mutually exclusive with operator socket flows.
   * DO NOT set outside tests.
   */
  _testAgentName?: string;
}

export class VaultBroker {
  private secrets: Record<string, VaultEntry> | null = null;
  /**
   * The vault passphrase, retained in memory for the broker's lifetime
   * to support `op:put` (agent-driven key rotation). Without retention,
   * the broker can decrypt the vault at unlock time and serve reads from
   * the in-memory `secrets` dict, but it cannot re-encrypt to write a
   * new entry — write requires the passphrase to re-derive the AES key.
   *
   * Trade-off: a pwn of the broker process now exposes the passphrase
   * in addition to the already-exposed decrypted secrets. The marginal
   * expansion is small — an attacker who can read process memory can
   * already exfiltrate every secret; retaining the passphrase
   * additionally lets them re-encrypt the on-disk vault. We accept this
   * to enable agent-driven key rotation (e.g. OAuth refresh tokens),
   * which is the only practical way for skills like clerk's calendar
   * skill to keep their refresh-token rotation self-healing without
   * operator hand-holding.
   *
   * Zeroed on lock(); set on unlockFromPassphrase().
   */
  private passphrase: string | null = null;
  /**
   * Identity stamp (mtime + size + inode) of `this.vaultPath` as of the load that
   * produced the current `this.secrets`. Drives the stat-on-access lazy
   * reload in `_reloadSecretsIfVaultChanged()`, so an out-of-band
   * `switchroom vault set` on the host becomes visible to readers without a
   * broker restart.
   *
   * `null` means "no disk-backed load to compare against" — the broker is
   * locked, or its secrets were seeded through `_testSecrets`. The refresh
   * is a no-op in that state, so seeded-state tests never touch the disk.
   *
   * Zeroed on lock(); set on unlockFromPassphrase() and after a successful
   * op:put save (our own write must not look like a foreign one).
   */
  private vaultStamp: VaultStamp | null = null;
  /**
   * Stamp of the last vault file whose re-open FAILED (a torn/partial write
   * caught mid-flight, or a file re-encrypted under a different passphrase).
   * Holds the warning to one line per distinct bad file instead of one per
   * get, AND suppresses the re-open retry for that same file so a
   * persistently unusable vault costs no scrypt derivation per read.
   * Cleared on a successful load, on lock(), and after our own put save.
   */
  private failedVaultStamp: VaultStamp | null = null;
  private config: SwitchroomConfig | null = null;
  private startedAt: number = Date.now();
  private server: net.Server | null = null;
  private unlockServer: net.Server | null = null;
  /**
   * Phase 2a — per-agent listeners keyed by absolute socket path. Populated
   * by bindAgentSocket(); empty when the broker is in legacy single-socket
   * mode. Each listener carries the trusted agentName established at bind.
   */
  private agentServers: Map<string, { server: net.Server; agentName: string }> =
    new Map();
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
      testOpts._testGrantsDb !== undefined ||
      testOpts._testVaultPath !== undefined ||
      testOpts._testPassphrase !== undefined ||
      testOpts._testAgentName !== undefined;
    if (usingTestOpt && process.env.NODE_ENV !== "test") {
      throw new Error(
        "VaultBroker: BrokerTestOpts (_testSecrets/_testConfig/_testIdentify/_testAuditLogger/_testGrantsDb/_testVaultPath) " +
          "must not be set outside tests. Set NODE_ENV=test if you really mean it.",
      );
    }
    if (testOpts._testVaultPath !== undefined) {
      // test-isolation guard: redirect a _testVaultPath that points
      // into the real ~/.switchroom tree to an isolated tmpdir.
      this.vaultPath = safeVaultPath(testOpts._testVaultPath);
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
   * sec WS10-F3 / #1420 — whether the broker fails CLOSED on an audit-append
   * failure (deny the secret release) rather than the historical fail-OPEN
   * (release anyway, only stderr-warn). Default is fail-open for backward
   * compatibility: a broken audit volume must not brick a running fleet
   * unless the operator has explicitly opted into the stricter posture.
   *
   * Resolution order (first that is set wins):
   *   1. env `SWITCHROOM_VAULT_AUDIT_FAIL_CLOSED` ("1"/"true" → closed,
   *      "0"/"false" → open) — mirrors the SWITCHROOM_VAULT_AUDIT_* env
   *      override pattern used for rotation, lets an operator flip the mode
   *      without a config edit.
   *   2. config `vault.broker.auditFailClosed`.
   *   3. default false (fail-open).
   */
  private auditFailClosedEnabled(): boolean {
    const env = process.env.SWITCHROOM_VAULT_AUDIT_FAIL_CLOSED;
    if (env !== undefined && env !== "") {
      return env === "1" || env.toLowerCase() === "true";
    }
    return this.config?.vault?.broker?.auditFailClosed === true;
  }

  /**
   * sec WS10-F3 / #1420 — write the terminal "allowed" audit row for a secret
   * release and enforce the fail-closed decision. Returns `true` if the caller
   * may proceed to hand back the secret; when it returns `false` it has ALREADY
   * written the DENIED response onto the socket (fail-closed: the audit append
   * failed and the operator opted into denying unaudited releases). In fail-open
   * mode it always returns `true` (the row-write failure is still counted +
   * stderr-warned inside the logger).
   */
  private auditedReleaseOk(
    socket: net.Socket,
    writeAudit: (entry: import("./audit-log.js").AuditEntry) => boolean,
    entry: import("./audit-log.js").AuditEntry,
  ): boolean {
    const durable = writeAudit(entry);
    if (!durable && this.auditFailClosedEnabled()) {
      socket.write(
        encodeResponse(
          errorResponse(
            "AUDIT_UNAVAILABLE",
            "secret release denied: audit append failed and broker is in fail-closed mode (vault.broker.auditFailClosed)",
          ),
        ),
      );
      return false;
    }
    return true;
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
    this.unlockSocketPath = unlockSocketFor(this.socketPath);
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
    // test-isolation guard: under the test runner, redirect a vault
    // path that resolved into the real ~/.switchroom tree to an
    // isolated tmpdir, so a mis-isolated test can neither read nor
    // clobber the operator's live vault. No-op in production.
    this.vaultPath = safeVaultPath(this.vaultPath);

    // Pre-load secrets if test opts provided
    if (this.testOpts._testSecrets !== undefined) {
      this.secrets = { ...this.testOpts._testSecrets };
    }
    if (this.testOpts._testPassphrase !== undefined) {
      this.passphrase = this.testOpts._testPassphrase;
    }

    // Ensure parent directory exists and is mode 0700.
    //
    // Race-safe construction: we set a strict umask BEFORE mkdir and pass
    // mode:0o700 in the same syscall. mkdir(2) applies (mode & ~umask),
    // so combining umask=0o077 + mode=0o700 yields 0o700 atomically — no
    // mkdir-then-chmod window where the dir is briefly group/world-readable.
    // The trailing chmod is defence-in-depth (idempotent re-assertion if
    // the dir pre-existed with looser perms); we do NOT rely on it to
    // close the race.
    process.umask(0o077);
    const parentDir = dirname(this.socketPath);
    mkdirSync(parentDir, { recursive: true, mode: 0o700 });
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

    // Auto-unlock if configured. Tries the machine-bound blob first (the
    // default mechanism, opt-in via vault.broker.autoUnlock=true), then
    // falls back to $CREDENTIALS_DIRECTORY for power users running the
    // broker as a system unit with systemd LoadCredentialEncrypted=.
    //
    // SKIP when _testSecrets was injected: those ARE the authoritative
    // unlocked vault for this (test-only) broker. Without this guard a
    // test broker started on a real deployment host auto-unlocks from
    // the host's ~/.switchroom/vault-auto-unlock blob and silently
    // replaces the 3 injected fixtures with the real ~90-key fleet
    // vault — making the broker server tests pass in clean CI but FAIL
    // on any host where switchroom is actually deployed (a hermeticity
    // bug), and pulling the real fleet vault into a test process.
    if (this.testOpts._testSecrets === undefined) {
      this._tryAutoUnlock();
    }

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
   *
   * Defends against state-E layout divergence (plan v3 §5 companion):
   * if the broker's resolved vault path is a symlink target inside a
   * dir that ALSO contains a sibling regular `vault.enc` with
   * different content, the broker refuses to unlock with a fatal
   * error pointing at `switchroom apply`. Catches the case where an
   * older switchroom CLI wrote to the legacy path AFTER migration ran
   * (rename-replaces-symlink), leaving broker and CLI writing to
   * different files. Without this check the broker would happily
   * serve stale data until the next `apply`.
   */
  unlockFromPassphrase(passphrase: string): void {
    detectVaultLayoutDrift(this.vaultPath);
    const secrets = openVault(passphrase, this.vaultPath);
    this.secrets = secrets;
    // Retain the passphrase to enable op:put (agent-driven rotation).
    // See the doc-comment on `passphrase` above for the trade-off. The
    // caller should still zero their own copy to minimise overall
    // lifetime; the broker's retained reference is the only authorised
    // long-lived store.
    this.passphrase = passphrase;
    this.vaultStamp = this._readVaultStamp();
    this.failedVaultStamp = null;
    this._setReadinessSentinel(true);
  }

  /**
   * Stat the vault file and return its identity stamp, or null when it
   * cannot be stat'd. See `vault-refresh.ts`.
   */
  private _readVaultStamp(): VaultStamp | null {
    return readVaultStamp(this.vaultPath);
  }

  /**
   * Lazy reload — pick up an out-of-band vault write on the next read.
   *
   * Called at the top of every op that reads `this.secrets` (get / list /
   * put / preflight_access). The decision logic, and its regression test,
   * live in `./vault-refresh.ts` — that module has no `bun:sqlite` import,
   * so unlike this file it (and its test) run under vitest in CI.
   *
   * Stat-on-access, no polling and no timers; no-op when locked; a failed
   * re-open keeps serving the previously loaded secrets. `force` is the
   * SIGHUP belt-and-braces path.
   */
  private _reloadSecretsIfVaultChanged(force: boolean = false): void {
    const next = refreshVaultIfChanged(
      {
        secrets: this.secrets,
        passphrase: this.passphrase,
        loadedStamp: this.vaultStamp,
        failedStamp: this.failedVaultStamp,
      },
      { vaultPath: this.vaultPath, force, beforeOpen: detectVaultLayoutDrift },
    );
    this.secrets = next.secrets;
    this.vaultStamp = next.loadedStamp;
    this.failedVaultStamp = next.failedStamp;
  }

  /**
   * SIGHUP hot-reload — swap the cached `switchroom.yaml` so secret-ACL,
   * agent-`admin`, and approval-posture edits take effect WITHOUT a
   * container restart.
   *
   * Safe by construction: every authorization decision reads `this.config`
   * live (`checkAclByAgent`, the admin/root gate,
   * `vault.broker.{approvalAuth, postureMintAgents, adminOnlyKeys}`), so
   * swapping the one field is sufficient — there are no config-derived
   * caches to recompute.
   *
   * It ALSO force-re-reads the vault file with the retained passphrase
   * (belt-and-braces on top of the stat-on-access lazy reload), so
   * `switchroom apply` — which SIGHUPs the broker — picks up an
   * out-of-band `switchroom vault set` even on a filesystem whose
   * timestamp granularity could hide the write. It never PROMPTS: a
   * locked broker has no retained passphrase, so the re-read is a no-op
   * and the vault stays locked. `this.vaultPath` is still not re-resolved
   * and auto-unlock is not re-run, so `vault.path` and the auto-unlock
   * settings remain restart-only (mirrors the auth-broker's
   * provider-registration reload caveat). Per-agent socket listeners are
   * likewise NOT reconciled here — a new agent needs new compose
   * bind-mounts that only `apply` + `docker compose up` create.
   *
   * Caller (the SIGHUP handler) validates the config via `loadConfig`
   * first and keeps the old config on any parse failure, so a half-written
   * file never lands here.
   */
  reload(config: SwitchroomConfig): void {
    this.config = config;
    // Force, not stat-gated: a SIGHUP is an explicit "something on disk
    // changed" signal. No-op when locked; keeps the loaded secrets on a
    // failed re-open (see _reloadSecretsIfVaultChanged).
    this._reloadSecretsIfVaultChanged(true);
  }

  /**
   * Best-effort readiness sentinel for the docker healthcheck (RFC J
   * Phase 4). On unlock we touch SWITCHROOM_VAULT_BROKER_READY_PATH;
   * on lock we remove it. The compose healthcheck tests this file so
   * `docker compose ps` reflects unlocked-AND-serving — a locked
   * broker reads unhealthy instead of the bind-presence-only "healthy"
   * that masked the install-validation 2026-05-17 incident.
   *
   * MUST NOT throw: this runs inside the security-critical unlock/lock
   * paths and a sentinel I/O hiccup must never affect vault state. The
   * env var is set only by the dockerized vault-broker service; unset
   * (host/test) → no-op, so non-docker behaviour is unchanged.
   */
  private _setReadinessSentinel(ready: boolean): void {
    const p = process.env.SWITCHROOM_VAULT_BROKER_READY_PATH;
    if (!p || p.length === 0) return;
    try {
      if (ready) {
        writeFileSync(p, "", { mode: 0o600 });
      } else if (existsSync(p)) {
        unlinkSync(p);
      }
    } catch {
      /* best-effort: never let sentinel I/O affect lock/unlock */
    }
  }

  /**
   * Lock the broker — wipe in-memory secrets and null the reference.
   */
  lock(): void {
    if (this.secrets !== null) {
      // Best-effort overwrite of string values before GC — see zeroSecrets().
      zeroSecrets(this.secrets);
      this.secrets = null;
    }
    // No disk-backed load to compare against any more: a locked broker must
    // never lazily re-open the vault (that would be an unlock without a
    // passphrase). Belt-and-braces on top of the null-passphrase guard.
    this.vaultStamp = null;
    this.failedVaultStamp = null;
    // Drop the retained passphrase reference too. Same JS-string-immutability
    // caveat as the secret values above — the underlying bytes survive in the
    // string-pool until GC, but the broker's only reference is gone.
    this.passphrase = null;
    this._setReadinessSentinel(false);
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
    // Phase 2a — close per-agent listeners and unlink their socket files.
    for (const [sockPath, entry] of this.agentServers) {
      try { entry.server.close(); } catch { /* ignore */ }
      if (existsSync(sockPath)) {
        try { unlinkSync(sockPath); } catch { /* ignore */ }
      }
    }
    this.agentServers.clear();
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

  /**
   * Test-only: return direct reference to the cached config. Used by the
   * reload() test to verify a SIGHUP hot-reload swaps the live config that
   * every authorization decision reads.
   */
  _getConfigRef(): SwitchroomConfig | null {
    return this.config;
  }

  // ─── Private helpers ──────────────────────────────────────────────────────

  /**
   * Phase 2a — bind a per-agent data listener at a canonical path.
   *
   * The agent name is derived from the socket path (NOT from any caller-
   * supplied argument or wire payload) via socketPathToAgent(). If the path
   * doesn't match the canonical /run/switchroom/broker/<agent>.sock shape,
   * we refuse to bind — fail loud rather than silently fall back to "no
   * agent identity" which would weaken the ACL boundary.
   *
   * The listener stores the agentName inside the broker's agentServers map
   * and threads it through every connection's request handler. A connection
   * accepted on alice.sock can never be served bob's keys, regardless of
   * any wire-payload agent claim.
   */
  bindAgentSocket(socketPath: string): Promise<string> {
    const abs = resolve(socketPath);
    const agentName = socketPathToAgent(abs);
    if (agentName === null) {
      return Promise.reject(
        new Error(
          `bindAgentSocket: socket path '${abs}' does not match the canonical ` +
          `/run/switchroom/broker/<agent>.sock shape — refusing to bind without ` +
          `a verifiable agent identity`,
        ),
      );
    }

    return new Promise((resolveP, rejectP) => {
      // Reset the parent dir back to root:root 0700 BEFORE binding (#881).
      // Subdir-shape paths like /run/switchroom/broker/<agent>/sock have
      // a parent dir backed by a docker named volume; on a previous
      // successful bind we chowned that dir to the agent UID 10xxx 0700
      // (see post-listen chown below). On a fresh broker container — a
      // common path during v0.6 → v0.7 cutover and on any compose-config
      // change — root with cap_drop=ALL + cap_add=[CHOWN,FOWNER,
      // DAC_READ_SEARCH] does NOT hold CAP_DAC_OVERRIDE and cannot
      // unlink stale sockets or create new ones inside a 10xxx-owned
      // 0700 dir. CAP_CHOWN succeeds regardless, so chown'ing the dir
      // back to root recovers from the stale state.
      if (abs.endsWith("/sock")) {
        const dir = abs.slice(0, -"/sock".length);
        if (existsSync(dir)) {
          try { chownSync(dir, 0, 0); } catch { /* outside docker / no CAP_CHOWN */ }
          try { chmodSync(dir, 0o700); } catch { /* idempotent */ }
        }
      }
      // Remove stale socket if present.
      if (existsSync(abs)) {
        try {
          unlinkSync(abs);
        } catch (err) {
          // Don't swallow silently (#881). Surface the path + errno so
          // an operator chasing a "Failed to listen" can see *why* the
          // stale socket couldn't be cleaned up. Continue to listen()
          // either way: it will fail with the same root cause but the
          // diagnostic breadcrumb is now in the log.
          const msg = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[vault-broker] could not unlink stale socket agent=${agentName} sock=${abs}: ${msg}\n`,
          );
        }
      }
      const server = net.createServer((sock) => {
        this._handleDataConnection(sock, abs, agentName);
      });
      server.on("error", (err) => rejectP(err));
      server.listen(abs, () => {
        try { chmodSync(abs, 0o660); } catch { /* ignore */ }
        // Chown the socket (and, for subdir-shape paths, the parent dir
        // mount point) to the agent UID so a non-root agent container
        // — running as `user: <uid>:<uid>` per compose — can connect.
        // The broker runs root-in-container with cap_drop=ALL +
        // cap_add=[CHOWN, FOWNER, DAC_READ_SEARCH], so chown succeeds
        // here. Mirrors `kernel-server.ts:bindAgentSocket`. Order
        // matters: chown AFTER listen() so root could write into the
        // (still-root-owned) parent dir to create the socket node.
        // Errors swallowed for non-docker dev/test runs where CAP_CHOWN
        // isn't held (callers run as the same UID as agents).
        let agentUid: number | null = null;
        try {
          agentUid = allocateAgentUid(agentName);
          try { chownSync(abs, agentUid, agentUid); } catch { /* see above */ }
          if (abs.endsWith("/sock")) {
            const dir = abs.slice(0, -"/sock".length);
            try { chownSync(dir, agentUid, agentUid); } catch { /* see above */ }
          }
        } catch {
          // allocateAgentUid is deterministic and pure; swallow only to
          // protect the listen() callback from any unexpected throw.
        }
        this.agentServers.set(abs, { server, agentName });

        // Pair an unlock listener at the canonical sibling path
        // (`<dir>/unlock` for subdir shape, `<name>.unlock.sock` for
        // flat shape — `unlockSocketFor` is the single source of truth
        // shared with the client). Without this, an in-container
        // `vault unlock` from the agent (e.g. Telegram `/vault unlock`)
        // gets ENOENT: the client derives the unlock path from the
        // data socket but the broker would never have bound it. The
        // operator listener (`bindOperatorListener`) already pairs the
        // sockets this way; we mirror that here for per-agent peers.
        // peercred stays ON (the operator-only carve-out from #1561
        // does not apply — agents must still verify).
        const unlockAbs = unlockSocketFor(abs);
        if (existsSync(unlockAbs)) {
          try { unlinkSync(unlockAbs); } catch { /* tolerate */ }
        }
        const unlockServer = net.createServer((sock) => {
          this._handleUnlockConnection(sock, false);
        });
        unlockServer.on("error", (err) => {
          // Tear down the data listener so the broker doesn't drift
          // into a half-bound state (data up, unlock down) where the
          // documented `/vault unlock` flow keeps failing silently.
          try { server.close(); } catch { /* ignore */ }
          this.agentServers.delete(abs);
          rejectP(err);
        });
        unlockServer.listen(unlockAbs, () => {
          try { chmodSync(unlockAbs, 0o660); } catch { /* ignore */ }
          if (agentUid !== null) {
            try { chownSync(unlockAbs, agentUid, agentUid); } catch { /* dev/no CAP_CHOWN */ }
          }
          this.agentServers.set(unlockAbs, { server: unlockServer, agentName });
          resolveP(agentName);
        });
      });
    });
  }

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

  /**
   * Bind the operator listener pair (data + unlock) at a host-bound path
   * inside the broker container. Mirrors the legacy `_bindDataSocket` /
   * `_bindUnlockSocket` pair, but:
   *
   *   - Data + unlock paths are derived from the same parent dir
   *     (`/run/switchroom/broker/operator/{sock,unlock}`) so a single
   *     bind-mount surfaces both to the host operator.
   *   - Connections route through `_handleDataConnection` with
   *     `isOperator = true`, which skips peercred (the host operator's
   *     UID never matches the broker container's root UID; peercred
   *     was never going to gate this) and applies operator-mode ACL +
   *     `auditCaller="operator"`.
   *   - The data + unlock files + their parent dir are chowned to
   *     `operatorUid` so the host operator's shell can connect through
   *     the bind mount.
   *
   * Trust: the bind path is the identity (path-as-identity, same
   * model as per-agent sockets). Mode 0600 + chown keeps anyone but
   * the host operator UID from connecting in the first place.
   */
  /**
   * Re-own vault.enc to the host operator UID after a broker write.
   * The broker container is root, so saveVault → atomicWriteFileSync
   * renames a root-owned tmp into place; without this the operator's
   * `switchroom vault …` CLI fails EACCES on its own vault (the
   * broker keeps working via CAP_DAC_READ_SEARCH, masking it). Same
   * UID source + best-effort posture as the operator-socket chowns:
   * no-op when SWITCHROOM_BROKER_OPERATOR_UID is unset (legacy/tests)
   * or chown isn't permitted (non-docker dev / no CAP_CHOWN).
   * `chownSync` follows the v0.7.12+ `vault.enc -> vault/vault.enc`
   * symlink, so the underlying file is what gets re-owned.
   */
  private chownVaultToOperator(): void {
    const uidStr = process.env.SWITCHROOM_BROKER_OPERATOR_UID;
    if (uidStr === undefined) return;
    const uid = parseInt(uidStr, 10);
    if (!Number.isFinite(uid) || uid <= 0) return;
    try {
      if (existsSync(this.vaultPath)) chownSync(this.vaultPath, uid, uid);
    } catch {
      /* non-docker dev / no CAP_CHOWN — same posture as socket chowns */
    }
  }

  bindOperatorListener(socketPath: string, operatorUid: number): Promise<void> {
    const abs = resolve(socketPath);
    const identity = socketPathToIdentity(abs);
    if (identity?.kind !== "operator") {
      return Promise.reject(
        new Error(
          `bindOperatorListener: socket path '${abs}' does not match the canonical ` +
          `/run/switchroom/broker/operator/sock shape — refusing to bind`,
        ),
      );
    }
    const unlockAbs = unlockSocketFor(abs);

    // Reset the parent dir + remove stale sockets, mirroring
    // bindAgentSocket. The broker has CAP_CHOWN+FOWNER+DAC_READ_SEARCH
    // (not DAC_OVERRIDE), so a previous bind that chowned the dir to
    // operatorUid 0700 needs the dir flipped back to root before we
    // can recreate sockets in it.
    if (abs.endsWith("/sock")) {
      const dir = abs.slice(0, -"/sock".length);
      if (existsSync(dir)) {
        try { chownSync(dir, 0, 0); } catch { /* outside docker */ }
        try { chmodSync(dir, 0o700); } catch { /* idempotent */ }
      }
    }
    for (const p of [abs, unlockAbs]) {
      if (existsSync(p)) {
        try { unlinkSync(p); } catch { /* tolerate */ }
      }
    }

    return new Promise<void>((resolveP, rejectP) => {
      const dataServer = net.createServer((sock) => {
        this._handleDataConnection(sock, abs, null, true);
      });
      dataServer.on("error", (err) => rejectP(err));
      dataServer.listen(abs, () => {
        try { chmodSync(abs, 0o600); } catch { /* ignore */ }
        try { chownSync(abs, operatorUid, operatorUid); } catch { /* dev / no CAP_CHOWN */ }

        // Now bind the unlock pair. Same chown target. Pass
        // `isOperator=true` so the unlock handler applies the same
        // peercred bypass the data handler already uses on the
        // operator path — `identify()` returns null for the reserved
        // "operator" path by design (peercred.ts socketPathToIdentity),
        // so without this the host operator's `vault broker unlock`
        // fails with "ERR unable to verify caller identity".
        const unlockServer = net.createServer((sock) => {
          this._handleUnlockConnection(sock, true);
        });
        unlockServer.on("error", (err) => rejectP(err));
        unlockServer.listen(unlockAbs, () => {
          try { chmodSync(unlockAbs, 0o600); } catch { /* ignore */ }
          try { chownSync(unlockAbs, operatorUid, operatorUid); } catch { /* dev */ }

          // Chown the parent dir so the operator can list/access its
          // contents through the host bind mount.
          if (abs.endsWith("/sock")) {
            const dir = abs.slice(0, -"/sock".length);
            try { chownSync(dir, operatorUid, operatorUid); } catch { /* dev */ }
            try { chmodSync(dir, 0o700); } catch { /* idempotent */ }
          }

          // Track in agentServers for shutdown bookkeeping; operator
          // identity is recorded as a sentinel agentName so existing
          // shutdown loops walk it without special-casing.
          this.agentServers.set(abs, { server: dataServer, agentName: "__operator__" });
          this.agentServers.set(unlockAbs, { server: unlockServer, agentName: "__operator_unlock__" });
          resolveP();
        });
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

  private _handleDataConnection(
    socket: net.Socket,
    listenerSocketPath: string = this.socketPath,
    agentName: string | null = this.testOpts._testAgentName ?? null,
    /**
     * True when the connection arrived on the operator socket. Trust comes
     * from the bind path (`/run/switchroom/broker/operator/sock`) plus the
     * file mode 0600 + chown to operator UID enforced at bind time.
     * peercred is not load-bearing here (the host operator UID never
     * matches the broker container's UID, so peercred's own UID-match
     * gate would deny on Linux). Mutually exclusive with `agentName`.
     */
    isOperator: boolean = false,
  ): void {
    // Identify peer immediately on accept (Linux only). Pass the accepted
    // socket so identify() can use SO_PEERCRED via bun:ffi (bun runtime) or
    // pin its ss-output lookup to the server-side fd's inode (node runtime).
    // Without the socket, identify() falls back to the legacy first-row-wins
    // ss lookup which has a documented concurrency hazard. See issue #129.
    //
    // Phase 2a (agent-bound listener): peercred is INFORMATIONAL. The
    // trusted agent identity came from the listener's bind-time socket
    // path; peercred only gives us a peer_uid for the audit row. ACL does
    // not consult `peer` on the agent-bound path.
    let peer: PeerInfo | null = null;
    if (process.platform === "linux") {
      peer = this.testOpts._testIdentify
        ? this.testOpts._testIdentify(listenerSocketPath, socket)
        : identify(listenerSocketPath, socket);
    }

    let buffer = "";

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");

      // Guard against oversized buffers (>64 KiB without a newline).
      // `end(resp)` not `write(resp); destroy()` so the kernel flushes
      // `resp` to the peer before FIN — same race shape as #988's
      // unlock-handler fix.
      if (Buffer.byteLength(buffer, "utf8") > MAX_FRAME_BYTES) {
        const resp = encodeResponse(
          errorResponse("BAD_REQUEST", "Frame exceeds 64 KiB limit"),
        );
        socket.end(resp);
        return;
      }

      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx).trimEnd();
        buffer = buffer.slice(newlineIdx + 1);

        if (!line) continue;

        this._handleRequest(socket, peer, line, agentName, isOperator);
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
    agentName: string | null = null,
    isOperator: boolean = false,
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
    //
    // Phase 2a: when agentName is set (the listener was bound on a per-agent
    // socket), the trusted identity is the agent slug — caller becomes
    // "agent:<name>" and peercred uid + cgroup ride along as informational
    // fields so audit reviewers can correlate against the host UID table.
    const auditPid = peer?.pid ?? process.pid;
    const auditCaller = isOperator
      ? "operator"
      : agentName !== null
        ? `agent:${agentName}`
        : peer !== null
          ? callerFromPeer(peer)
          : `pid:${process.pid}`;
    const auditCgroup = peer?.systemdUnit ?? undefined;
    const auditPeerUid = peer?.uid;
    const auditAgentName = agentName ?? undefined;

    // Inject the Phase 2a fields onto every audit row from this connection
    // without rewriting every call site. The base logger ignores unknown
    // fields under JSON.stringify, so this is purely additive on the wire.
    const writeAudit = (
      entry: import("./audit-log.js").AuditEntry,
    ): boolean => {
      return this.auditLogger.write({
        ...entry,
        peer_uid: entry.peer_uid ?? auditPeerUid,
        agent_name: entry.agent_name ?? auditAgentName,
      });
    };

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

    if (req.op === "preflight_access") {
      // OPERATOR-ONLY. The {key→exists} answer is a key-existence
      // oracle; only the operator (same trust root as the vault
      // file — the operator socket is 0600 + chowned to the operator
      // UID) may use it. An agent must never probe another agent's
      // (or arbitrary) keys/ACL. `isOperator` is set ONLY by the
      // canonical operator-socket bind (peercred), never by a
      // per-agent socket, so this gate is airtight.
      if (!isOperator) {
        writeAudit({
          ts: new Date().toISOString(),
          op: "preflight_access",
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: "denied:operator-only",
        });
        socket.write(
          encodeResponse(
            errorResponse("DENIED", "preflight_access is operator-only"),
          ),
        );
        return;
      }
      // Same staleness class as `get`: this answers key-EXISTENCE and
      // per-entry scope out of `this.secrets`, so without a refresh
      // `switchroom doctor` would report a just-added key as missing.
      this._reloadSecretsIfVaultChanged();
      if (this.secrets === null) {
        // Locked → the caller (doctor) maps LOCKED to `skip`, never a
        // false fail. The broker is only locked pre-first-unlock or
        // post-auth-failure, when the fleet's crons are dead anyway.
        socket.write(
          encodeResponse(errorResponse("LOCKED", "Vault is locked")),
        );
        return;
      }
      const pfSecrets = this.secrets;
      const pfConfig = this.config;
      const results = req.keys.map((key) => {
        const exists = Object.prototype.hasOwnProperty.call(pfSecrets, key);
        // The SAME predicates the real `get` path composes, so the
        // verdict matches enforcement. NO secret value is ever read
        // or returned — only existence + the boolean ACL/scope
        // predicates. (The caller decides per provenance which to
        // apply, and preserves the "no *static* ACL — a runtime
        // grant may still cover this" caveat: a static miss here
        // does NOT prove the agent lacks access.)
        const acl =
          pfConfig !== null
            ? checkAclByAgent(pfConfig, req.agent, key)
            : { allow: false as const, reason: "broker has no config loaded" };
        const scope = checkEntryScope(pfSecrets[key]?.scope, req.agent);
        return {
          key,
          exists,
          acl_ok: acl.allow,
          ...(acl.allow ? {} : { acl_reason: acl.reason }),
          scope_ok: scope.allow,
          ...(scope.allow ? {} : { scope_reason: scope.reason }),
        };
      });
      writeAudit({
        ts: new Date().toISOString(),
        op: "preflight_access",
        caller: auditCaller,
        pid: auditPid,
        cgroup: auditCgroup,
        result: `allowed:agent=${req.agent},keys=${req.keys.length}`,
      });
      socket.write(
        encodeResponse({ ok: true, op: "preflight_access", results }),
      );
      return;
    }

    if (req.op === "list") {
      // Pick up an out-of-band `switchroom vault set` before answering.
      this._reloadSecretsIfVaultChanged();
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

        // Only an explicitly REVOKED token hard-denies (deliberate
        // operator kill-switch — don't mask it by switching auth paths).
        if (!tokenCheck.ok && tokenCheck.reason === "grant-revoked") {
          this.auditLogger.write({
            ts: new Date().toISOString(),
            op: "list",
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: `denied:grant-revoked`,
            method: "grant",
            grant_id: grantId,
          });
          socket.write(encodeResponse(errorResponse("DENIED", "grant-revoked")));
          return;
        }

        if (tokenCheck.ok || tokenCheck.reason === "grant-key-not-allowed") {
          // Token authenticates (ok, or key-not-allowed → token itself is
          // valid). Return only the keys the grant's key_allow covers.
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

        // grant-invalid / grant-expired (not revoked, not a usable token):
        // fall through to the no-token peercred/ACL list path below —
        // behave exactly as if no token were presented. No audit here
        // (#B1): the no-token path writes the single terminal row, so the
        // request still yields exactly one audit entry (#1433 hash-chain).
      }

      // ── Peercred path (no token) ────────────────────────────────────────
      // Issue #129 review: `list` previously skipped peercred entirely, so
      // any same-UID caller could enumerate vault key names without proving
      // identity. Inconsistent with `get`, which requires peer != null on
      // Linux. Apply the same Linux peercred gate here so cron units can
      // still list (for diagnostics) but a non-cron same-UID caller can't.
      // On non-Linux the socket-file mode 0600 remains the only gate.
      //
      // Phase 2a — when agentName is set, the listener's per-agent socket
      // path is the trusted identity; we don't need peercred to gate.
      // Same goes for the operator socket: the bind path + 0600 chown to
      // operator UID is the trust boundary, peercred is not load-bearing.
      //
      // #1192: identity is the socket path, so on Linux a non-operator
      // caller with NO resolved agent name is denied whether or not
      // peercred identified a peer. The legacy per-cron `checkAcl(peer,…)`
      // path (which used to serve identified-but-not-per-agent callers) is
      // gone — the in-container scheduler never produces a cron cgroup, so
      // that path only ever fail-closed anyway. Fail-closed preserved.
      if (!isOperator && agentName === null && process.platform === "linux") {
        const reason = "Unable to identify caller (no per-agent socket identity); denying on Linux";
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
      // #1192: agent identity comes solely from the socket path. On the
      // legacy/operator/non-Linux paths agentName is null and the scope
      // filter runs with a null slug (mode-0600 + bind-path are the guards).
      const listAgentSlug = agentName;
      let visibleKeys: string[];
      if (isOperator) {
        // Operator socket: no agent-keyed ACL (operator isn't an agent).
        // Only entry-scope filtering applies — keys without a scope are
        // visible; keys whose scope.allow excludes "operator" or whose
        // scope.deny includes "operator" are hidden. Default-deny on
        // cross-agent secret leakage is the right shape: an operator
        // surveying the vault sees their own / shared keys but not
        // agent-private ones unless those entries explicitly opted in
        // (allow includes "operator").
        visibleKeys = Object.entries(this.secrets)
          .filter(([, entry]) => checkEntryScope(entry.scope, "operator").allow)
          .map(([k]) => k);
      } else if (agentName !== null && this.config !== null) {
        // Phase 2a — agent identity is the listener's socket path. Gate
        // both visibility (per-agent secrets[]) and scope on that name.
        visibleKeys = Object.entries(this.secrets)
          .filter(
            ([key, entry]) =>
              checkAclByAgent(this.config!, agentName, key).allow &&
              checkEntryScope(entry.scope, agentName).allow,
          )
          .map(([k]) => k);
      } else {
        // Non-Linux / operator-less fallback: no agent identity to gate on
        // (Linux non-agent callers were already denied above). Only the
        // per-entry scope applies, with a null slug.
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
      // Pick up an out-of-band `switchroom vault set` before answering: the
      // whole point of the store is that a write is observable by readers.
      this._reloadSecretsIfVaultChanged();
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
          // sec #3084-F4: tokens are bearer capabilities, but when the
          // connection ALSO carries a bind-time socket identity
          // (`agentName` — established by socketPathToAgent, never from a
          // wire payload), cross-check it against the grant's owning agent
          // and reject a mismatch. This closes the case where a token
          // leaked to another agent's container is replayed over that
          // agent's own socket. Only enforced when an identity is present:
          // the legitimate no-bind-identity flow (agentName === null on
          // legacy / non-Linux / operator sockets) is unchanged — the
          // token remains the sole auth there, exactly as before.
          if (agentName !== null && grantResult.grant.agent_slug !== agentName) {
            this.auditLogger.write({
              ts: new Date().toISOString(),
              op: "get",
              key: req.key,
              caller: auditCaller,
              pid: auditPid,
              cgroup: auditCgroup,
              result: "denied:grant-identity-mismatch",
              method: "grant",
              grant_id: grantId,
            });
            socket.write(
              encodeResponse(errorResponse("DENIED", "grant-identity-mismatch")),
            );
            return;
          }
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
          // sec #3084-F3: enforce the per-entry scope on the token path too,
          // keyed on the grant's OWNING agent (`grant.agent_slug`). The
          // non-token ACL path checks `checkEntryScope` at line ~1456; the
          // token path historically skipped it, so an entry's
          // `scope.deny:[agent]` was silently ineffective against an
          // outstanding token. Now a deny is honoured regardless of which
          // path serves the read — defense-in-depth for per-agent scoping.
          const tokenScope = checkEntryScope(entry.scope, grantResult.grant.agent_slug);
          if (!tokenScope.allow) {
            this.auditLogger.write({
              ts: new Date().toISOString(),
              op: "get",
              key: req.key,
              caller: auditCaller,
              pid: auditPid,
              cgroup: auditCgroup,
              result: `denied:${tokenScope.reason}`,
              method: "grant",
              grant_id: grantId,
            });
            socket.write(
              encodeResponse(errorResponse("DENIED", tokenScope.reason)),
            );
            return;
          }
          // sec WS10-F3 / #1420: fail-closed guard on the release row.
          if (
            !this.auditedReleaseOk(socket, writeAudit, {
              ts: new Date().toISOString(),
              op: "get",
              key: req.key,
              caller: auditCaller,
              pid: auditPid,
              cgroup: auditCgroup,
              result: "allowed",
              method: "grant",
              grant_id: grantId,
            })
          ) {
            return;
          }
          socket.write(encodeResponse(entryResponse(entry)));
          return;
        } else if (grantResult.reason === "grant-revoked") {
          // Token recognised but explicitly REVOKED — hard-deny. Revocation
          // is a deliberate operator kill-switch; falling through to the
          // standing per-agent-socket ACL would mask that signal. (Mirrors
          // the put path's grant-revoked branch.) Only `grant-revoked`
          // hard-denies on the READ path — see the fall-through note below.
          const dotIdx = req.token.indexOf(".");
          const grantId = dotIdx !== -1 ? req.token.slice(0, dotIdx) : undefined;
          this.auditLogger.write({
            ts: new Date().toISOString(),
            op: "get",
            key: req.key,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: `denied:grant-revoked`,
            method: "grant",
            grant_id: grantId,
          });
          socket.write(
            encodeResponse(errorResponse("DENIED", "grant-revoked")),
          );
          return;
        }
        // grant-invalid / grant-expired / grant-key-not-allowed: the
        // presented token grants nothing usable. Deliberately DO NOT audit
        // or return here — fall through to the standing-ACL path below so
        // an agent that ALSO has a schedule.secrets[] grant for this key is
        // still served (an unusable token must never be MORE restrictive
        // than presenting no token). Not auditing here is load-bearing:
        // the no-token ACL path writes the single terminal row, so the
        // request still produces exactly one audit entry (preserves the
        // #1433 hash-chain). Mirrors the put precedent at the
        // validateGrantForWrite branch.
        //
        // …but DO garbage-collect the dead token file. The fall-through is
        // exactly why an orphaned `.vault-token` is harmless, and also why
        // nothing ever noticed one: pre-fix, a token whose grant row was
        // gone (or whose TTL had lapsed) stayed on disk forever — reported
        // by `switchroom doctor` as a permanent red on every run, and
        // re-validated (bcrypt) on every single `vault get`. Truncating it
        // here — at the one place a token is already proven unusable —
        // makes the next call an honest no-token call and lets the fleet
        // stop accreting orphans. Only grant-invalid / grant-expired are
        // reaped; grant-key-not-allowed means the grant is ALIVE and must
        // be kept. See reap-token-file.ts for why this truncates in place
        // rather than unlinking (bare-file bind mount ⇒ EBUSY).
        if (!grantResult.ok) {
          reapUnusableGrantToken({
            agentsDir: this.config
              ? resolveAgentsDir(this.config)
              : path.join(os.homedir(), ".switchroom", "agents"),
            agent: agentName,
            presentedToken: req.token,
            reason: grantResult.reason,
          });
        }
      }

      // ── ACL path (no token) ─────────────────────────────────────────────
      // Phase 2a: when agentName is set, the listener's per-agent socket
      // path established the identity at bind time. peercred uid is captured
      // for audit but does not gate.
      if (isOperator) {
        // Operator socket: gate solely on entry scope. Keys without a
        // scope are accessible; keys with scope must explicitly include
        // "operator" in scope.allow (or omit it from scope.deny when
        // there's no allow list). Default-deny on agent-private keys is
        // intentional — an operator surveying the box should not be
        // able to read agent-private OAuth tokens etc. without the
        // entry's scope opting them in.
        const entry = this.secrets[req.key];
        if (entry !== undefined) {
          const scopeResult = checkEntryScope(entry.scope, "operator");
          if (!scopeResult.allow) {
            writeAudit({
              ts: new Date().toISOString(),
              op: "get",
              key: req.key,
              caller: auditCaller,
              pid: auditPid,
              cgroup: auditCgroup,
              result: `denied:${scopeResult.reason}`,
            });
            socket.write(
              encodeResponse(errorResponse("DENIED", scopeResult.reason)),
            );
            return;
          }
        }
        // entry===undefined falls through to the existing UNKNOWN_KEY
        // handling further down — same as agent path.
      } else if (agentName !== null && this.config !== null) {
        const aclResult = checkAclByAgent(this.config, agentName, req.key);
        if (!aclResult.allow) {
          writeAudit({
            ts: new Date().toISOString(),
            op: "get",
            key: req.key,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: `denied:${aclResult.reason}`,
          });
          socket.write(
            encodeResponse(errorResponse("DENIED", aclResult.reason)),
          );
          return;
        }
      } else if (process.platform === "linux" && agentName === null) {
        // #1192: on Linux a non-operator caller with no resolved per-agent
        // socket identity is denied (fail-closed). Covers both peercred-
        // unavailable and the retired legacy `checkAcl(peer,…)` path.
        const reason = "Unable to identify caller (no per-agent socket identity); denying on Linux";
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

      // Per-entry scope check (issue #8) — runs AFTER the agent-level ACL
      // passes. #1192: the caller slug is the socket-path agent identity.
      const getAgentSlug = agentName;
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

      // Successful get — log only the key name, NEVER the value.
      // sec WS10-F3 / #1420: fail-closed guard on the release row.
      if (
        !this.auditedReleaseOk(socket, writeAudit, {
          ts: new Date().toISOString(),
          op: "get",
          key: req.key,
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: "allowed",
        })
      ) {
        return;
      }
      socket.write(encodeResponse(entryResponse(entry)));
      return;
    }

    // ── Put — agent-driven key rotation ─────────────────────────────────────
    //
    // Same ACL as get: an agent that can read a key via schedule.secrets[]
    // can also rotate (write) it. Refuses to introduce new keys (operator-
    // only); refuses to change an entry's `kind` (string ↔ binary). The
    // motivating use case is OAuth refresh-token rotation in skills like
    // clerk's calendar skill — the skill reads its token via broker,
    // exchanges with the IDP for a fresh access_token + possibly-new
    // refresh_token, and now needs to persist the rotation. Pre-fix the
    // skill's `_vault_set` step failed every time because vault writes
    // required the operator passphrase that agents don't have. Post-fix
    // the skill's `switchroom vault set` routes through the broker and
    // the rotation is self-healing.
    if (req.op === "put") {
      // Read-modify-write: saveVault() re-encrypts the WHOLE in-memory dict,
      // so a stale load here would silently revert an out-of-band
      // `switchroom vault set` on every other key. Refresh first.
      this._reloadSecretsIfVaultChanged();
      // Vault must be unlocked to encrypt the new value.
      if (this.secrets === null || this.passphrase === null) {
        socket.write(encodeResponse(errorResponse("LOCKED", "Vault is locked")));
        return;
      }

      // ── Operator-passphrase attestation (issue #969 P1a) ───────────────────
      //
      // When the caller forwards an operator passphrase that matches the
      // one the broker is currently unlocked with, treat the call as
      // operator-attested: bypass path-as-identity, ACL, the
      // unknown-key gate, and the kind-mismatch check (operators can
      // change storage shape). Audit logs tag method="passphrase".
      //
      // This is the path the Telegram gateway uses for one-tap
      // user-approved saves — the operator's passphrase reaches the
      // gateway via /vault unlock, and the gateway forwards it here.
      // Same threat model as the operator running `switchroom vault set`
      // directly on the host.
      let passphraseAttested = false;
      // #1115 follow-up: posture-attested PUT. Gateway under
      // telegram-id mode signals operator-tap intent via
      // attest_via_posture rather than forwarding the passphrase.
      // Same gates as mint_grant's posture path: per-agent peer +
      // broker config opt-in + broker unlocked. Mutually exclusive
      // with `passphrase`.
      const requestedPostureAttest =
        (req as { attest_via_posture?: boolean }).attest_via_posture === true;
      if (requestedPostureAttest && req.passphrase !== undefined && req.passphrase !== "") {
        writeAudit({
          ts: new Date().toISOString(),
          op: "put",
          key: req.key,
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: "denied:bad-request-both-attestations",
        });
        socket.write(
          encodeResponse(
            errorResponse(
              "BAD_REQUEST",
              "put: passphrase and attest_via_posture are mutually exclusive",
            ),
          ),
        );
        return;
      }
      if (requestedPostureAttest) {
        if (agentName === null) {
          writeAudit({
            ts: new Date().toISOString(),
            op: "put",
            key: req.key,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: "denied:posture-attest-needs-per-agent-peer",
          });
          socket.write(
            encodeResponse(errorResponse("DENIED", "put attest_via_posture is per-agent only")),
          );
          return;
        }
        const postureMode = this.config?.vault?.broker?.approvalAuth ?? "passphrase";
        if (postureMode !== "telegram-id") {
          writeAudit({
            ts: new Date().toISOString(),
            op: "put",
            key: req.key,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: "denied:telegram-id-not-enabled",
          });
          socket.write(
            encodeResponse(
              errorResponse(
                "DENIED",
                "put attest_via_posture requires vault.broker.approvalAuth: telegram-id in broker config",
              ),
            ),
          );
          return;
        }
        // Per-agent allowlist gate (#1115 follow-up rev 3) — same as
        // mint_grant. The operator must explicitly opt this agent
        // into the silent-mint path; default empty list = no agent
        // can use posture attestation. Prevents a non-trusted
        // agent's claude from writing new vault keys under
        // telegram-id without an operator tap.
        const postureAllowlist = this.config?.vault?.broker?.postureMintAgents ?? [];
        if (!postureAllowlist.includes(agentName)) {
          writeAudit({
            ts: new Date().toISOString(),
            op: "put",
            key: req.key,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: "denied:posture-agent-not-allowlisted",
          });
          socket.write(
            encodeResponse(
              errorResponse(
                "DENIED",
                `agent '${agentName}' is not on vault.broker.postureMintAgents — operator must opt this agent into posture-attested put`,
              ),
            ),
          );
          return;
        }
        passphraseAttested = true;
        writeAudit({
          ts: new Date().toISOString(),
          op: "put",
          key: req.key,
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: "allowed:posture-attested",
          method: "posture",
        });
      }
      if (req.passphrase !== undefined && req.passphrase !== "") {
        if (req.passphrase === this.passphrase) {
          passphraseAttested = true;
        } else {
          // Wrong passphrase explicitly supplied — fail closed. Don't
          // fall through to other auth paths: the caller asserted an
          // operator identity they don't actually have. Surface this
          // clearly so the user can correct (typo, stale cache, etc).
          this.auditLogger.write({
            ts: new Date().toISOString(),
            op: "put",
            key: req.key,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: "denied:passphrase-mismatch",
            method: "passphrase",
          });
          socket.write(
            encodeResponse(
              errorResponse(
                "DENIED",
                "supplied passphrase does not match the broker's unlocked passphrase",
              ),
            ),
          );
          return;
        }
      }

      // ── Write-grant fast path (issue #969 P1b) ─────────────────────────────
      //
      // When the caller presents a valid token whose `write_allow` includes
      // this key, accept the PUT WITHOUT requiring path-as-identity and
      // WITHOUT enforcing the schedule.secrets[] ACL. Write-grants are also
      // permitted to introduce new keys (this is the path that unblocks
      // agent-initiated "save this user-provided secret" — issue #968).
      //
      // The token presence + key check happens here so write-grants take
      // precedence over the legacy path-as-identity-only rules; agents that
      // also have path-as-identity ACL still get the legacy rotate path
      // below when no token is presented.
      let writeGrantId: string | null = null;
      if (req.token !== undefined && req.token !== "") {
        const v = await validateGrantForWrite(this.grantsDb, req.token, req.key);
        if (v.ok) {
          const writeGrantAgentSlug = v.grant.agent_slug;
          // sec #3084-F4 (write path): tokens are bearer capabilities, but
          // when the connection ALSO carries a bind-time socket identity
          // (`agentName` — established by socketPathToAgent, never from a
          // wire payload), cross-check it against the grant's owning agent
          // and reject a mismatch — exactly as the `get` path does at
          // ~line 1297. This closes the write equivalent of the leaked-token
          // replay: a write-grant token leaked to another agent's container
          // could otherwise be replayed over that agent's own socket to
          // overwrite/plant shared secrets, bypassing the path-as-identity
          // ACL. Only enforced when an identity is present: the legitimate
          // no-bind-identity flow (agentName === null on legacy / non-Linux /
          // operator sockets) is unchanged — the token remains the sole auth
          // there, exactly as before.
          if (agentName !== null && writeGrantAgentSlug !== agentName) {
            this.auditLogger.write({
              ts: new Date().toISOString(),
              op: "put",
              key: req.key,
              caller: auditCaller,
              pid: auditPid,
              cgroup: auditCgroup,
              result: "denied:grant-identity-mismatch",
              method: "grant",
              grant_id: v.grant.id,
            });
            socket.write(
              encodeResponse(errorResponse("DENIED", "grant-identity-mismatch")),
            );
            return;
          }
          // sec #3084-F2 (write-side twin of #3084-F3): enforce the per-entry
          // scope on the write-token path too, keyed on the grant's OWNING
          // agent (`writeGrantAgentSlug`). The get path checks this at ~1339;
          // the write path historically skipped it, so an entry's
          // `scope.deny:[agent]` was silently ineffective against an
          // outstanding write-token — the denied agent could still overwrite
          // the value. Runs after the F4 identity bind above, so it only sees
          // writes whose grant identity already matches the socket. Only
          // meaningful for rotations of an existing scoped entry (a
          // not-yet-existing key has no scope to honour); new-key creation via
          // write-grant is unaffected.
          const existingForScope = this.secrets[req.key];
          if (existingForScope !== undefined) {
            const writeScope = checkEntryScope(
              existingForScope.scope,
              writeGrantAgentSlug,
            );
            if (!writeScope.allow) {
              this.auditLogger.write({
                ts: new Date().toISOString(),
                op: "put",
                key: req.key,
                caller: auditCaller,
                pid: auditPid,
                cgroup: auditCgroup,
                result: `denied:${writeScope.reason}`,
                method: "grant",
                grant_id: v.grant.id,
              });
              socket.write(
                encodeResponse(errorResponse("DENIED", writeScope.reason)),
              );
              return;
            }
          }
          writeGrantId = v.grant.id;
        } else if (
          v.reason === "grant-expired" ||
          v.reason === "grant-revoked"
        ) {
          // Token recognized but explicitly disabled — surface a hard
          // denial. Don't fall through to peercred/path-as-identity:
          // the operator revoked this token deliberately and silently
          // accepting a different auth path would mask the signal.
          this.auditLogger.write({
            ts: new Date().toISOString(),
            op: "put",
            key: req.key,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: `denied:${v.reason}`,
            method: "grant",
          });
          socket.write(encodeResponse(errorResponse("DENIED", v.reason)));
          return;
        }
        // grant-invalid (bad token / typo) or grant-write-not-allowed —
        // fall through to path-as-identity in case the agent ALSO has
        // schedule.secrets[] coverage for this key (rotate-only).
      }

      // ── Path-as-identity rotate path (legacy) ──────────────────────────────
      if (writeGrantId === null && !passphraseAttested && agentName === null) {
        socket.write(
          encodeResponse(errorResponse("DENIED", "put requires path-as-identity, a valid write-grant token, or operator-passphrase attestation")),
        );
        return;
      }
      // Same ACL as get — schedule.secrets[] gates write too. Skipped on
      // the write-grant fast path AND the passphrase-attestation fast
      // path: in both cases the auth IS the ACL.
      if (this.config === null) {
        socket.write(
          encodeResponse(errorResponse("INTERNAL", "Broker config not loaded")),
        );
        return;
      }
      if (writeGrantId === null && !passphraseAttested) {
        const aclResult = checkAclByAgent(this.config, agentName!, req.key);
        if (!aclResult.allow) {
          this.auditLogger.write({
            ts: new Date().toISOString(),
            op: "put",
            key: req.key,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: `denied:${aclResult.reason}`,
          });
          socket.write(encodeResponse(errorResponse("DENIED", aclResult.reason)));
          return;
        }
        // sec #3143-B: enforce the per-entry `scope` on the tokenless
        // (path-as-identity) write too. The READ path-as-identity path
        // checks this (~line 1508) and the write-GRANT path checks it
        // (#3084-F2, ~line 1773), but this twin historically ran
        // `checkAclByAgent` ONLY — so an agent whose `schedule.secrets[]`
        // ACL covers a key that ALSO carries `scope.deny:[thatagent]` could
        // rotate it without a token, silently bypassing the deny. Keyed on
        // the socket-bound identity (`agentName`), same slug the read path
        // and ACL use. Only meaningful for rotations of an existing scoped
        // entry; a not-yet-existing key has no scope to honour (and the
        // path-as-identity path refuses new keys just below anyway).
        const existingForScope = this.secrets[req.key];
        if (existingForScope !== undefined) {
          const writeScope = checkEntryScope(existingForScope.scope, agentName);
          if (!writeScope.allow) {
            this.auditLogger.write({
              ts: new Date().toISOString(),
              op: "put",
              key: req.key,
              caller: auditCaller,
              pid: auditPid,
              cgroup: auditCgroup,
              result: `denied:${writeScope.reason}`,
            });
            socket.write(
              encodeResponse(errorResponse("DENIED", writeScope.reason)),
            );
            return;
          }
        }
      }
      // Refuse to introduce new keys ON THE PATH-AS-IDENTITY PATH ONLY.
      // Write-grants and passphrase-attestation explicitly permit new-key
      // creation — that's the whole point of those capabilities.
      const existing = this.secrets[req.key];
      if (existing === undefined && writeGrantId === null && !passphraseAttested) {
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "put",
          key: req.key,
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: "denied:unknown_key",
        });
        socket.write(
          encodeResponse(
            errorResponse(
              "UNKNOWN_KEY",
              `Key not found: ${req.key} (broker put cannot introduce new keys without a write-grant; ask operator to 'switchroom vault grant <agent> --write ${req.key}' or set it once via 'switchroom vault set' from the host)`,
            ),
          ),
        );
        return;
      }
      // Refuse to change the kind (string ↔ binary). The protocol union
      // already excludes 'files' from put. Agents rotating values must keep
      // the same shape. (Only applies when an entry already exists — for
      // new-key creation via write-grant or passphrase attestation, any
      // kind in the request is fine. Passphrase-attested requests CAN
      // change the kind of existing entries; that's an operator action.)
      if (
        existing !== undefined
        && existing.kind !== req.entry.kind
        && !passphraseAttested
      ) {
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "put",
          key: req.key,
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: `denied:kind_mismatch ${existing.kind}→${req.entry.kind}`,
        });
        socket.write(
          encodeResponse(
            errorResponse(
              "BAD_REQUEST",
              `kind mismatch: existing entry is '${existing.kind}', new entry is '${req.entry.kind}'`,
            ),
          ),
        );
        return;
      }
      // Update in-memory + persist. saveVault re-encrypts the full secrets
      // dict and atomic-writes the vault file. On failure (disk full, perm
      // error, encrypted-write race with another writer), the in-memory
      // state is also rolled back — otherwise the broker would serve an
      // entry that isn't on disk and the next reload would lose it.
      const previousEntry = existing;
      // sec #3143-A: merge-preserve server-side metadata (`scope`, `format`)
      // on rotation of an EXISTING entry. The wire `PutRequestSchema.entry`
      // is `{kind, value}` only — it cannot carry `scope`/`format` — so a
      // blind `this.secrets[key] = req.entry` silently ERASED the entry's
      // `scope.deny`/`scope.allow` and `format` hint on every legitimate
      // rotation. That defeated the #3084-F2/F3 write-scope durability: any
      // allowed agent's rotation stripped the deny, after which
      // checkEntryScope(undefined) → allow re-opened the key to a
      // previously-denied agent. Preserve prior metadata unless the caller
      // is the operator (passphrase attestation) — the operator IS allowed
      // to reshape an entry from a host-trusted path. New-key creation
      // (existing === undefined) has nothing to preserve.
      let nextEntry: VaultEntry = req.entry;
      if (existing !== undefined && !passphraseAttested) {
        // `format` only exists on the string/binary variants (the `files`
        // variant has none); `in` narrows it safely. `req.entry` is always
        // string|binary here, so the merged shape stays a valid VaultEntry.
        const preservedFormat =
          "format" in existing && existing.format !== undefined
            ? { format: existing.format }
            : {};
        nextEntry = {
          ...req.entry,
          ...preservedFormat,
          ...(existing.scope !== undefined ? { scope: existing.scope } : {}),
        };
      }
      this.secrets[req.key] = nextEntry;
      try {
        saveVault(this.passphrase, this.vaultPath, this.secrets);
      } catch (err: unknown) {
        // Roll back in-memory state — restore previous entry, or delete
        // if this was a write-grant new-key creation.
        if (previousEntry === undefined) {
          delete this.secrets[req.key];
        } else {
          this.secrets[req.key] = previousEntry;
        }
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "put",
          key: req.key,
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: `error:${(err as Error)?.message ?? "save failed"}`,
          ...(passphraseAttested
            ? { method: "passphrase" }
            : writeGrantId !== null
              ? { method: "grant", grant_id: writeGrantId }
              : {}),
        });
        socket.write(
          encodeResponse(
            errorResponse("INTERNAL", `Failed to persist: ${(err as Error)?.message ?? "unknown"}`),
          ),
        );
        return;
      }
      // Hand vault.enc back to the host operator UID. The broker runs
      // as root, so the saveVault → atomicWriteFileSync rename above
      // left the file root:root 0600. The broker still reads it
      // (CAP_DAC_READ_SEARCH) which masks the breakage, but the
      // operator's `switchroom vault …` CLI then fails EACCES — and it
      // silently re-broke on every persist (token rotation, /vault
      // put, auto-unlock re-persist) before this. Mirrors the
      // socket-chown pattern; no-op on legacy/test (env unset) or
      // non-docker dev (no CAP_CHOWN).
      this.chownVaultToOperator();
      // Re-stamp: the file we just wrote IS the load in memory, so the lazy
      // reload must not mistake our own write for a foreign one and re-open
      // (and re-decrypt) on the very next get.
      this.vaultStamp = this._readVaultStamp();
      this.failedVaultStamp = null;
      // Successful put — log only the key, NEVER the value. Surface the
      // auth method so audit downstream can trace which path authorized
      // the write: passphrase (operator-attested via gateway), grant
      // (capability token), or peercred (path-as-identity / cron unit).
      this.auditLogger.write({
        ts: new Date().toISOString(),
        op: "put",
        key: req.key,
        caller: auditCaller,
        pid: auditPid,
        cgroup: auditCgroup,
        result: "allowed",
        ...(passphraseAttested
          ? { method: "passphrase" }
          : writeGrantId !== null
            ? { method: "grant", grant_id: writeGrantId }
            : {}),
      });
      socket.write(encodeResponse({ ok: true, put: true, key: req.key }));
      return;
    }

    // ── Approval kernel ops (RFC B) — handled BEFORE grant-mgmt ACL ─────────
    //
    // Placement note: handling these here (rather than after grant-mgmt)
    // keeps the discriminated union narrow in the grant-mgmt block, so
    // `req.op` can be assigned to `AuditOp` without a string literal that
    // doesn't exist in that enum. The ACL semantics also differ — approval
    // ops are callable from any agent (request/lookup) plus the gateway
    // (consume/revoke/list); the cron-cannot-manage-grants rule does not
    // apply.
    if (
      req.op === "approval_request" ||
      req.op === "approval_lookup" ||
      req.op === "approval_consume" ||
      req.op === "approval_revoke" ||
      req.op === "approval_list" ||
      req.op === "approval_record"
    ) {
      await this._handleApprovalOp(socket, req);
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
    // Hoisted from the isGrantMgmtOp block so the per-op handlers
    // (list_grants at ~line 1765, mint_grant at ~line 1670) can also
    // see the attestation flag. Used for `method=passphrase` audit
    // attribution on the per-op success rows (#1058 reviewer Q10).
    let mintPassphraseAttested = false;
    if (isGrantMgmtOp) {
      // Decide trust upfront so both the agent-deny gate AND the
      // peercred/cron gates below honour it. `isAdminAgent` is the
      // admin-flagged-yaml path-as-identity equivalent of the
      // operator socket: identity comes from the bound path
      // (the per-agent socket is `/run/switchroom/broker/<name>/sock`),
      // admin-ness comes from server-side config — never from the
      // wire. Same trust posture as `isOperator`; bypasses peercred
      // for the same reason.
      const isAdminAgent =
        agentName !== null &&
        (this.config?.agents?.[agentName]?.admin === true ||
          // `root: true` (the root-tier debugging agent) is strictly
          // above admin and carries admin authority — docs/root-agent.md.
          (this.config?.agents?.[agentName] as { root?: boolean } | undefined)?.root === true);
      // ── Operator-passphrase attestation for grant-mgmt (#1012 Phase 2) ─
      //
      // When the caller forwards an operator passphrase that matches the
      // broker's currently-unlocked passphrase, treat the call as
      // operator-attested — bypass the agent-deny gate below.
      //
      // This is the path the Telegram gateway uses when an OPERATOR
      // taps [Approve] on a `vault_request_access` card in a non-admin
      // agent's chat (#1012). The operator already typed the
      // passphrase via /vault unlock and the gateway has it cached
      // per-chat; that cache is what the gateway attaches here. Same
      // trust model and threat surface as the operator-attested PUT
      // path used by `vault_request_save` (#969 P1a).
      //
      // Wrong passphrase explicitly supplied → fail closed (mirrors
      // the PUT path at line 1206-1234 so the failure surfaces clearly
      // instead of silently falling through to other auth paths).
      // (`mintPassphraseAttested` is declared outside this block —
      // see the hoist comment above the `if (isGrantMgmtOp)`.)
      if (
        // #1051: also covers list_grants. The grant-union flow needs
        // to read existing grants before minting a unioned one;
        // without this the gateway can't see the prior key list and
        // each fresh mint silently strands the previous .vault-token.
        // Read-only — adds no security regression vs the mint_grant
        // attestation that already exists for the same caller.
        (req.op === "mint_grant" || req.op === "list_grants") &&
        (req as { passphrase?: string }).passphrase !== undefined &&
        (req as { passphrase?: string }).passphrase !== ""
      ) {
        // #1115 follow-up: posture-attestation and passphrase-attestation
        // are mutually exclusive. A client sending both is confused; refuse
        // up front rather than silently picking one.
        if ((req as { attest_via_posture?: boolean }).attest_via_posture === true) {
          writeAudit({
            ts: new Date().toISOString(),
            op: req.op,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: "denied:bad-request-both-attestations",
          });
          socket.write(
            encodeResponse(
              errorResponse(
                "BAD_REQUEST",
                "mint_grant: passphrase and attest_via_posture are mutually exclusive",
              ),
            ),
          );
          return;
        }
        if ((req as { passphrase?: string }).passphrase === this.passphrase) {
          mintPassphraseAttested = true;
        } else {
          // writeAudit (not this.auditLogger.write directly) so the row
          // gets peer_uid + agent_name attribution — forensics on a
          // wrong-passphrase incident benefit from knowing which agent
          // socket the attempt came through. The PUT mismatch path
          // pre-dates writeAudit's injection helper, but new code at
          // this level uses the injected variant.
          writeAudit({
            ts: new Date().toISOString(),
            op: req.op,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: "denied:passphrase-mismatch",
            method: "passphrase",
          });
          socket.write(
            encodeResponse(
              errorResponse(
                "DENIED",
                "supplied passphrase does not match the broker's unlocked passphrase",
              ),
            ),
          );
          return;
        }
      }
      // #1115 follow-up: posture-attested grant-mgmt ops. The gateway under
      // `vault.broker.approvalAuth: telegram-id` cannot pass the
      // passphrase explicitly (it doesn't have it — that's the whole
      // point of the posture: passphrase stays in the broker). Instead
      // the gateway sets `attest_via_posture: true` on mint_grant /
      // list_grants and the broker uses ITS OWN retained passphrase as
      // the attestation — but only when (a) the broker's config has
      // `approvalAuth: telegram-id`, (b) the broker is currently
      // unlocked, and (c) the caller is a per-agent peer (operator
      // socket and admin agents have other paths and don't need this).
      // The passphrase is never sent over the wire.
      //
      // list_grants symmetry is required by the #1051 grant-union
      // flow — `performVaultAccessApproval` reads the agent's
      // existing grants before each mint so the freshly-issued
      // token covers prior keys too; without posture support on
      // list_grants, the gateway would mint single-key grants and
      // strand the agent's prior coverage.
      //
      // Audit attribution: `method=posture` so forensics can tell
      // posture-attested mints apart from passphrase- and operator-
      // attested ones.
      let mintPostureAttested = false;
      if (
        (req.op === "mint_grant" || req.op === "list_grants") &&
        (req as { attest_via_posture?: boolean }).attest_via_posture === true
      ) {
        if (agentName === null) {
          // Operator socket / unidentified peer — shouldn't be using
          // posture attestation; they have a direct path.
          writeAudit({
            ts: new Date().toISOString(),
            op: req.op,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: "denied:posture-attest-needs-per-agent-peer",
          });
          socket.write(
            encodeResponse(
              errorResponse(
                "DENIED",
                "mint_grant attest_via_posture is per-agent only",
              ),
            ),
          );
          return;
        }
        const postureMode = this.config?.vault?.broker?.approvalAuth ?? "passphrase";
        if (postureMode !== "telegram-id") {
          writeAudit({
            ts: new Date().toISOString(),
            op: req.op,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: "denied:telegram-id-not-enabled",
          });
          socket.write(
            encodeResponse(
              errorResponse(
                "DENIED",
                "mint_grant attest_via_posture requires vault.broker.approvalAuth: telegram-id in broker config",
              ),
            ),
          );
          return;
        }
        // #1115 follow-up rev 3 — reviewer-blocker fix: per-agent
        // allowlist. The earlier gate accepted "any per-agent peer"
        // (`agentName !== null`), which let claude inside any agent
        // container call mint_grant attest_via_posture with no
        // operator-tap proof. Now the operator must explicitly opt
        // each agent into the silent-mint path via
        // `vault.broker.postureMintAgents`. Default empty → no agent
        // can self-mint until the operator picks one. AND the
        // request's `agent` field must match the calling peer's
        // resolved agent name (cross-agent posture-mint refused).
        const postureAllowlist = this.config?.vault?.broker?.postureMintAgents ?? [];
        if (!postureAllowlist.includes(agentName)) {
          writeAudit({
            ts: new Date().toISOString(),
            op: req.op,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: "denied:posture-agent-not-allowlisted",
          });
          socket.write(
            encodeResponse(
              errorResponse(
                "DENIED",
                `agent '${agentName}' is not on vault.broker.postureMintAgents — operator must opt this agent into posture-attested mint`,
              ),
            ),
          );
          return;
        }
        // Agent-self-match: the request's declared `agent` MUST equal
        // the calling peer's resolved agentName. Without this, an
        // allowlisted agent could mint grants naming OTHER agents
        // (cross-agent posture mint), or list another agent's grants
        // for free reconnaissance. mint_grant has an `agent` field;
        // list_grants's `agent` is optional — when unset we coerce to
        // the calling agent rather than letting the broker default
        // to "all agents".
        const reqAgent = (req as { agent?: string }).agent;
        if (req.op === "mint_grant" && reqAgent !== agentName) {
          writeAudit({
            ts: new Date().toISOString(),
            op: req.op,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: "denied:posture-cross-agent-mint-refused",
          });
          socket.write(
            encodeResponse(
              errorResponse(
                "DENIED",
                `posture-attested mint refused: request.agent=${reqAgent ?? "<unset>"} but calling peer is ${agentName}`,
              ),
            ),
          );
          return;
        }
        if (req.op === "list_grants" && reqAgent !== undefined && reqAgent !== agentName) {
          // Explicit cross-agent list refused — same defence as
          // mint_grant's. An allowlisted agent gets to see its own
          // grants only via the posture path; if it wants to list
          // another agent's grants, it must use the operator-
          // passphrase path (which also gates on attestation).
          writeAudit({
            ts: new Date().toISOString(),
            op: req.op,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: "denied:posture-cross-agent-list-refused",
          });
          socket.write(
            encodeResponse(
              errorResponse(
                "DENIED",
                `posture-attested list refused: request.agent=${reqAgent} but calling peer is ${agentName}`,
              ),
            ),
          );
          return;
        }
        // Admin-only keys (`vault.broker.adminOnlyKeys`) can never be
        // ADDED via posture attestation — posture is agent-forgeable
        // (claude shares this per-agent socket), so a posture-minted
        // admin-only key would defeat the "operator passphrase required"
        // contract. Posture may RETAIN an admin-only key the agent
        // already holds (the gateway unions a new key with the agent's
        // existing grant keys, so a previously passphrase-granted
        // admin-only key legitimately reappears) but never ADD a new
        // one. Adding requires the passphrase path. Surface-independent:
        // this also blocks an agent crafting raw mint_grant protocol.
        if (req.op === "mint_grant") {
          const adminOnly = this.config?.vault?.broker?.adminOnlyKeys ?? [];
          if (adminOnly.length > 0) {
            const requested = [
              ...((req as { keys?: string[] }).keys ?? []),
              ...((req as { write_keys?: string[] }).write_keys ?? []),
            ];
            // The agent's current active (non-revoked, non-expired) key
            // set — both read and write — is what posture may retain.
            const nowSec = Math.floor(Date.now() / 1000);
            const existingKeys = listGrants(this.grantsDb, agentName)
              .filter((g) => g.expires_at === null || g.expires_at > nowSec)
              .flatMap((g) => [...(g.key_allow ?? []), ...(g.write_allow ?? [])]);
            const blocked = adminOnlyKeysBeingAdded(requested, existingKeys, adminOnly);
            if (blocked.length > 0) {
              writeAudit({
                ts: new Date().toISOString(),
                op: req.op,
                caller: auditCaller,
                pid: auditPid,
                cgroup: auditCgroup,
                result: "denied:posture-mint-admin-only-key",
              });
              socket.write(
                encodeResponse(
                  errorResponse(
                    "DENIED",
                    `admin-only credential(s) ${blocked.join(", ")} cannot be minted via posture ` +
                    `attestation — they require the operator passphrase (vault.broker.adminOnlyKeys)`,
                  ),
                ),
              );
              return;
            }
          }
        }
        if (this.passphrase === null) {
          writeAudit({
            ts: new Date().toISOString(),
            op: req.op,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: "denied:broker-locked",
          });
          socket.write(encodeResponse(errorResponse("LOCKED", "Broker is locked")));
          return;
        }
        // Hard-boundary gate (RFC vault-approval-hard-boundary) — flag-gated,
        // default OFF. Posture attestation alone is FORGEABLE: claude shares
        // this per-agent socket with the gateway, so it can self-mint. When
        // the flag is on, a posture-attested MINT must reference a kernel
        // decision recorded with origin='operator' — i.e. verified by the
        // host-side approval verifier on a channel claude cannot reach (a
        // per-agent-socket decision is origin='agent' → rejected here).
        // Default-off until the host verifier ships (PR ②); off ⇒ unchanged.
        if (
          req.op === "mint_grant" &&
          process.env.SWITCHROOM_REQUIRE_OPERATOR_APPROVAL_MINT === "1"
        ) {
          const decisionId = (req as { decision_id?: string }).decision_id;
          const dec =
            decisionId != null && decisionId !== ""
              ? kernelGetDecision(this.grantsDb, decisionId)
              : null;
          if (!isOperatorVerifiedDecision(dec, agentName ?? "")) {
            writeAudit({
              ts: new Date().toISOString(),
              op: req.op,
              caller: auditCaller,
              pid: auditPid,
              cgroup: auditCgroup,
              result: "denied:posture-mint-needs-operator-verified-decision",
            });
            socket.write(
              encodeResponse(
                errorResponse(
                  "DENIED",
                  "posture-attested mint requires an operator-verified approval " +
                    "(host-side tap); none referenced. See RFC vault-approval-hard-boundary.",
                ),
              ),
            );
            return;
          }
        }
        mintPostureAttested = true;
        writeAudit({
          ts: new Date().toISOString(),
          op: req.op,
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: "allowed:posture-attested",
          method: "posture",
        });
      }
      const trustedForGrantMgmt = isOperator || isAdminAgent || mintPassphraseAttested || mintPostureAttested;
      // Operator socket: trusted by path + 0600 chown; skip the cron-deny
      // and peercred-required gates below. Operator IS the operator-only
      // identity those gates were designed to verify. Audit logs reflect
      // this via auditCaller="operator" already set above.
      if (isOperator) {
        // Fall through to the grant-mgmt op handlers (mint_grant /
        // list_grants / revoke_grant) — no further gate needed.
      } else if (agentName !== null) {
        // Admin-flagged agents (yaml `admin: true`) are trusted with
        // grant-mgmt ops via their existing per-agent socket
        // (#1021 Design B). The agent already has operator-level
        // Telegram surface (`/agents`, `/vault`, `/restart`, etc.)
        // so this is a consistent expansion.
        if (isAdminAgent) {
          // Fall through to grant-mgmt handlers below. Audit log
          // already carries the agent name + cgroup attribution.
        } else if (mintPassphraseAttested) {
          // #1012 Phase 2: non-admin agent forwarded a valid operator
          // passphrase — operator-attested, trusted for grant-mgmt.
          // Same trust posture as passphrase-attested PUT (#969 P1a).
          // Audit row gets method=passphrase so forensics can tell
          // operator-attested mints apart from agent-bound ones.
          writeAudit({
            ts: new Date().toISOString(),
            op: req.op,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: "allowed:passphrase-attested",
            method: "passphrase",
          });
          // Fall through to grant-mgmt handlers below.
        } else if (mintPostureAttested) {
          // #1115 follow-up: posture-attested mint. Same trust
          // posture as passphrase-attested above, but the gateway
          // never had to handle the passphrase — the broker used
          // its own retained passphrase under telegram-id config.
          // The allowed audit row was already written upstream when
          // the posture gate accepted (see the
          // mintPostureAttested block earlier in this handler).
          // Fall through to grant-mgmt handlers below.
        } else {
          // Phase 2a: regular per-agent listeners are NEVER allowed to
          // mint, list, or revoke grants. Grant management is
          // operator-only (or admin-agent only) (or operator-attested
          // via passphrase — see #1012 branch above). A non-admin
          // agent without attestation has no business minting tokens.
          writeAudit({
            ts: new Date().toISOString(),
            op: req.op,
            caller: auditCaller,
            pid: auditPid,
            cgroup: auditCgroup,
            result: "denied:agent-cannot-manage-grants",
          });
          socket.write(
            encodeResponse(
              errorResponse(
                "DENIED",
                "Grant management ops are operator-only; agent-bound listeners cannot mint, list, or revoke grants (set `admin: true` on this agent in switchroom.yaml + restart broker, OR forward operator-passphrase attestation if intended — see vault_request_access flow)",
              ),
            ),
          );
          return;
        }
      }
      // Operator socket + admin agents bypass both gates below —
      // their identity is established by the bind path + chown, not
      // peercred. Per-agent (non-admin) connections that reach this
      // point have already been rejected above; the only callers
      // here are: (a) operator socket, (b) admin agent socket, or
      // (c) some non-agent, non-operator path (legacy / dev mode).
      if (!trustedForGrantMgmt) {
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
        // #1192: the legacy per-cron-unit grant-mgmt deny (parseCronUnit on
        // peer.systemdUnit) was removed with the rest of the dead cgroup ACL
        // path — the in-container scheduler produces no cron cgroup, so it
        // never fired. Grant-mgmt trust is gated by isOperator / admin agent /
        // passphrase attestation above and the peercred-unavailable deny here.
      }
    }

    if (req.op === "mint_grant") {
      // Parse ttl_seconds into a duration for mintGrant
      const { agent, keys, ttl_seconds, description, write_keys } = req;

      // At least one capability must be granted. The schema permits an
      // empty `keys` array (so write-only grants don't need a placeholder)
      // but a request with both empty is meaningless — reject early.
      if (keys.length === 0 && (write_keys?.length ?? 0) === 0) {
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "mint_grant",
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: "denied:no-capabilities",
        });
        socket.write(
          encodeResponse(
            errorResponse(
              "BAD_REQUEST",
              "mint_grant requires at least one of `keys` or `write_keys` to be non-empty",
            ),
          ),
        );
        return;
      }

      let mintResult: Awaited<ReturnType<typeof mintGrant>>;
      try {
        mintResult = await mintGrant(
          this.grantsDb,
          agent,
          keys,
          ttl_seconds,
          description,
          write_keys ?? [],
        );
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

      // Publish the token at ~/.switchroom/agents/<agent>/.vault-token.
      //
      // #3751: this is an IN-PLACE O_TRUNC write, deliberately NOT the
      // tmp+rename atomic-write pattern that #225 introduced here. The token
      // file is bind-mounted into this container as a bare file (see the
      // per-agent loop in src/agents/compose.ts), so it is a mountpoint:
      // `rename(2)` over it returns EBUSY and the write failed on every
      // single mint on the live fleet. In-place also preserves the inode,
      // hence the agent-UID ownership and 0600 mode that a rename silently
      // destroyed. Same constraint/remedy as the reaper in #3749. See
      // write-token-file.ts for the full rationale.
      //
      // The write is load-bearing, not best-effort: if it fails we must NOT
      // report a successful mint. A live grant row whose token never reached
      // disk is the exact inconsistency that made the original EBUSY
      // invisible for months, so roll the grant back and fail the RPC.
      try {
        const agentsDir = this.config
          ? resolveAgentsDir(this.config)
          : path.join(os.homedir(), ".switchroom", "agents");
        const { chownWarning } = writeAgentTokenFile({
          agentsDir,
          agent,
          token: mintResult.token,
        });
        if (chownWarning !== null) {
          // Non-fatal: only reachable on the create path (fresh agent / dev
          // host without CAP_CHOWN). The bytes are on disk and the token is
          // still returned over IPC; only the on-disk mirror is owner-wrong.
          process.stderr.write(
            `[vault-broker] mint_grant: ${chownWarning} (agent ${agent})\n`,
          );
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Compensating action: the grant row already exists, and its token
        // was already handed to bcrypt-hashed storage. Revoke it so no live
        // capability outlives the failed publish — validateGrant hard-denies
        // a revoked token, so the pair (grant, token file) can never be left
        // out of sync in the "grant usable, token missing" direction.
        let rolledBack = false;
        let rollbackErr: string | null = null;
        try {
          rolledBack = revokeGrant(this.grantsDb, mintResult.id);
        } catch (revokeError) {
          rollbackErr = revokeError instanceof Error ? revokeError.message : String(revokeError);
        }
        const rollbackNote = rolledBack
          ? "grant rolled back (revoked)"
          : `GRANT ROLLBACK FAILED — revoke ${mintResult.id} manually${rollbackErr ? `: ${rollbackErr}` : ""}`;
        process.stderr.write(
          `[vault-broker] mint_grant: failed to write token file for agent ${agent}: ` +
          `${msg}; ${rollbackNote}\n`
        );
        this.auditLogger.write({
          ts: new Date().toISOString(),
          op: "mint_grant",
          caller: auditCaller,
          pid: auditPid,
          cgroup: auditCgroup,
          result: `error:token-write-failed:${msg}`,
          method: "grant",
          grant_id: mintResult.id,
        });
        socket.write(
          encodeResponse(
            errorResponse(
              "INTERNAL",
              `Failed to write token file for agent ${agent}: ${msg} (${rollbackNote})`,
            ),
          ),
        );
        return;
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
      // Reviewer-flagged on #1058 (Q10): stamp `method=passphrase` on
      // the operation row when the request was operator-attested, so
      // forensics has the same attribution on the actual list op as
      // on the gate-allow row above. Without this the attestation is
      // recorded but the per-op evidence reads as ambiguous.
      this.auditLogger.write({
        ts: new Date().toISOString(),
        op: "list_grants",
        caller: auditCaller,
        pid: auditPid,
        cgroup: auditCgroup,
        result: `allowed:${grants.length}`,
        ...(mintPassphraseAttested ? { method: "passphrase" as const } : {}),
      });
      // Strip revoked_at before sending (not part of the GrantMeta wire schema)
      const grantMetas = grants.map(({ id, agent_slug, key_allow, write_allow, expires_at, created_at, description }) => ({
        id,
        agent_slug,
        key_allow,
        write_allow,
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
      //
      // Defense-in-depth (#1448 follow-up): re-validate the stored
      // agent_slug against AgentNameSchema before joining it into a
      // filesystem path. Wire validation now rejects bad slugs at write
      // time, but the grants DB could carry pre-fix rows with
      // path-traversal slugs. A bad row here would otherwise let an
      // unlink escape the agents tree.
      try {
        const row = this.grantsDb
          .query<{ agent_slug: string }, [string]>(
            "SELECT agent_slug FROM vault_grants WHERE id = ?",
          )
          .get(id);
        if (row && AgentNameSchema.safeParse(row.agent_slug).success) {
          const agentsDir = this.config
            ? resolveAgentsDir(this.config)
            : path.join(os.homedir(), ".switchroom", "agents");
          const tokenPath = path.join(agentsDir, row.agent_slug, ".vault-token");
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

    // (approval ops are dispatched earlier — see _handleApprovalOp)

    // Exhaustive check — should not reach here
    socket.write(
      encodeResponse(
        errorResponse("BAD_REQUEST", `Unknown op: ${(req as { op: string }).op}`),
      ),
    );
  }

  /**
   * Approval-kernel op dispatcher (RFC B). Handled in its own method so
   * the discriminated-union narrowing in `_handleRequest` stays clean —
   * the legacy AuditOp enum doesn't include the apv:* op names, and we
   * don't want to widen it (audit-log.ts is the vault audit log, not the
   * approval audit; the kernel writes its own approval_audit table).
   */
  private async _handleApprovalOp(
    socket: net.Socket,
    req: import("./protocol.js").BrokerRequest,
  ): Promise<void> {
    try {
      if (req.op === "approval_request") {
        // RFC §10 rate caps: per-agent max 2 concurrent pending, global max 32.
        const counts = countPendingNonces(this.grantsDb);
        const perAgentN = counts.perAgent.get(req.agent_unit) ?? 0;
        if (perAgentN >= MAX_PENDING_PER_AGENT || counts.global >= MAX_PENDING_GLOBAL) {
          const retry_after_ms = computeRetryAfterMs(
            this.grantsDb,
            perAgentN >= MAX_PENDING_PER_AGENT ? req.agent_unit : null,
          );
          socket.write(
            encodeResponse({
              ok: true,
              kind: "approval_request",
              state: "rate_limited",
              retry_after_ms,
            }),
          );
          return;
        }
        const result = kernelRequestApproval(this.grantsDb, {
          agent_unit: req.agent_unit,
          scope: req.scope,
          action: req.action,
          approver_set: req.approver_set,
          why: req.why,
          ttl_ms: req.ttl_ms,
        });
        socket.write(
          encodeResponse({
            ok: true,
            kind: "approval_request",
            state: "pending",
            request_id: result.request_id,
            expires_at: result.expires_at,
          }),
        );
        return;
      }
      if (req.op === "approval_lookup") {
        const r = kernelLookupDecision(this.grantsDb, {
          agent_unit: req.agent_unit,
          scope: req.scope,
          action: req.action,
          current_approver_set: req.current_approver_set,
        });
        const decision =
          r.state === "granted" || r.state === "denied"
            ? {
                id: r.decision.id,
                agent_unit: r.decision.agent_unit,
                scope: r.decision.scope,
                action: r.decision.action,
                decision: r.decision.decision,
                granted_at: r.decision.granted_at,
                granted_by_user_id: r.decision.granted_by_user_id,
                ttl_expires_at: r.decision.ttl_expires_at,
                last_used_at: r.decision.last_used_at,
                revoked_at: r.decision.revoked_at,
                revoke_reason: r.decision.revoke_reason,
              }
            : null;
        socket.write(encodeResponse({ ok: true, state: r.state, decision }));
        return;
      }
      if (req.op === "approval_consume") {
        const nonce = kernelConsumeNonce(this.grantsDb, req.request_id);
        if (nonce === null) {
          socket.write(encodeResponse({ ok: true, consumed: false }));
          return;
        }
        socket.write(
          encodeResponse({
            ok: true,
            consumed: true,
            agent_unit: nonce.agent_unit,
            scope: nonce.scope,
            action: nonce.action,
            why: nonce.why,
          }),
        );
        return;
      }
      if (req.op === "approval_revoke") {
        const revoked = kernelRevokeDecision(
          this.grantsDb,
          req.decision_id,
          req.actor,
          req.reason,
        );
        socket.write(encodeResponse({ ok: true, revoked }));
        return;
      }
      if (req.op === "approval_record") {
        const nonce = kernelGetNonce(this.grantsDb, req.request_id);
        if (nonce === null) {
          socket.write(encodeResponse(errorResponse("BAD_REQUEST", "unknown request_id")));
          return;
        }
        if (nonce.consumed_at === null) {
          socket.write(
            encodeResponse(
              errorResponse(
                "BAD_REQUEST",
                "nonce must be consumed before recording — call approval_consume first",
              ),
            ),
          );
          return;
        }
        const decision_id = kernelRecordDecision(this.grantsDb, {
          nonce,
          decision: req.decision,
          approver_set: req.approver_set,
          granted_by_user_id: req.granted_by_user_id,
          ttl_ms: req.ttl_ms ?? undefined,
        });
        socket.write(encodeResponse({ ok: true, decision_id }));
        return;
      }
      if (req.op === "approval_list") {
        const decisions = kernelListDecisions(this.grantsDb, { agent_unit: req.agent_unit });
        const meta = decisions.map((d) => ({
          id: d.id,
          agent_unit: d.agent_unit,
          scope: d.scope,
          action: d.action,
          decision: d.decision,
          granted_at: d.granted_at,
          granted_by_user_id: d.granted_by_user_id,
          ttl_expires_at: d.ttl_expires_at,
          last_used_at: d.last_used_at,
          revoked_at: d.revoked_at,
          revoke_reason: d.revoke_reason,
        }));
        socket.write(encodeResponse({ ok: true, decisions: meta }));
        return;
      }
      // Should not reach here — caller must have already discriminated.
      socket.write(
        encodeResponse(
          errorResponse(
            "BAD_REQUEST",
            `Unknown approval op: ${(req as { op: string }).op}`,
          ),
        ),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      socket.write(encodeResponse(errorResponse("INTERNAL", msg)));
    }
  }

  /**
   * Handle an incoming unlock connection. The first newline-terminated
   * line on the socket is taken as the vault passphrase (max 4096 bytes);
   * `unlockFromPassphrase()` then attempts decrypt. The peer is allowed
   * a single shot — buffered overflow / non-first-line content is
   * discarded and the socket is closed.
   *
   * **Trust model** (mirroring `_handleDataConnection`'s rationale):
   * when `isOperator` is true the listener is bound at the canonical
   * operator path (`/run/switchroom/broker/operator/unlock`), mode 0600,
   * chowned to the host operator UID, and bind-mounted to the host so
   * only that UID's processes can connect — kernel-enforced at the FS
   * layer. peercred is NOT load-bearing here: `identify()` returns
   * `null` for the reserved "operator" path by design
   * (`peercred.ts` `socketPathToIdentity` + reserved-name guard), so
   * running it would always deny. The bind path itself is the identity.
   * Same trust gate the data handler relies on (RFC J Phase 3) — this
   * extends it to the unlock handler, closing the gap that produced the
   * `ERR unable to verify caller identity` regression on the operator
   * unlock path. The legacy non-operator unlock callers retain the
   * peercred gate verbatim.
   */
  private _handleUnlockConnection(
    socket: net.Socket,
    isOperator: boolean = false,
  ): void {
    // Same UID check for unlock socket. On Linux: verify via peercred,
    // pinned to this connection's fd (issue #129).
    // On other OSes: rely on socket file mode 0600.
    //
    // Operator path: skip peercred entirely (see docstring above).
    // Incidentally also sidesteps the latent issue that
    // `identify(this.unlockSocketPath, ...)` hardcodes the default
    // unlock socket path even when the connection arrived on the
    // operator listener — irrelevant once we don't probe at all.
    let unlockPeer: PeerInfo | null = null;
    if (!isOperator && process.platform === "linux") {
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
        socket.end("ERR unable to verify caller identity\n");
        return;
      }
    }

    // Mirror `_handleDataConnection`'s audit convention: the operator
    // path records `caller:"operator"` (the bind-path-derived identity),
    // not a peercred-derived value (which is structurally meaningless
    // across the host↔container PID namespace boundary).
    const auditPid = isOperator
      ? process.pid
      : unlockPeer?.pid ?? process.pid;
    const auditCaller = isOperator
      ? "operator"
      : unlockPeer !== null
        ? callerFromPeer(unlockPeer)
        : `pid:${process.pid}`;
    const auditCgroup = isOperator ? undefined : unlockPeer?.systemdUnit ?? undefined;

    let buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) {
        // Guard against massive input
        if (Buffer.byteLength(buffer, "utf8") > 4096) {
          socket.end("ERR passphrase too long\n");
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
        // Use `end(line)` not `write(line); destroy()`. The latter
        // races: `destroy()` closes the socket immediately and the
        // kernel can drop the buffered response before the peer reads
        // it. The client then times out claiming "broker didn't reply"
        // even though the broker did the right thing — issue #988.
        socket.end("ERR passphrase cannot be empty\n");
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
        socket.end("OK\n");
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
        // Closes #472 finding #24 — pre-fix the wire response was
        // `ERR ${msg}` which leaked underlying error fingerprints
        // (wrong-passphrase vs wrong-KDF-param vs corrupt-ciphertext).
        // Same-UID processes that probed the unlock socket could
        // enumerate failure shapes and infer structural details
        // (which KDF, which cipher, whether the file is even a vault).
        // Stderr (operator console) and audit log keep the verbose
        // form for diagnostics; the wire surface is now constant.
        socket.end("ERR decryption failed\n");
      }
      // No finally-destroy: socket.end(line) flushes `line` then sends
      // FIN cleanly. A destroy() after end() would re-introduce the
      // race documented above.
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
   * Attempt to auto-unlock the vault at start. Called once after the sockets
   * are bound and sd_notify READY=1 has fired. Any failure is non-fatal —
   * the broker stays running and the user can unlock interactively.
   *
   * Sources, in order:
   *   1. The machine-bound auto-unlock blob written by
   *      `switchroom vault broker enable-auto-unlock` — default at
   *      ~/.switchroom/vault-auto-unlock (configurable via
   *      vault.broker.autoUnlockCredentialPath, or the
   *      SWITCHROOM_VAULT_BROKER_AUTO_UNLOCK_PATH env var the
   *      docker-compose vault-broker service injects).
   *   2. `$CREDENTIALS_DIRECTORY/vault-passphrase` — for power users who
   *      installed the broker as a system unit with systemd
   *      LoadCredentialEncrypted=. We don't ship that mode by default but
   *      the read path stays cheap so power users aren't blocked.
   */
  private _tryAutoUnlock(): void {
    if (this._tryAutoUnlockFromMachineBoundFile()) return;
    this._tryAutoUnlockFromSystemdCredentials();
  }

  /**
   * Read ~/.switchroom/vault-auto-unlock (or configured/env path), decrypt
   * with the key derived from /etc/machine-id + the per-file salt, push the
   * passphrase into unlockFromPassphrase. Returns true if we attempted —
   * regardless of success — so the caller knows whether to try other paths.
   *
   * Returns false only when auto-unlock is not configured (file path absent).
   */
  private _tryAutoUnlockFromMachineBoundFile(): boolean {
    // Resolution order:
    //   1. SWITCHROOM_VAULT_BROKER_AUTO_UNLOCK_PATH env var — set by the
    //      docker-compose vault-broker service so the in-container path
    //      (`/state/vault-auto-unlock`) overrides the host-shaped default
    //      that wouldn't resolve inside the container.
    //   2. config.vault.broker.autoUnlockCredentialPath — operator override.
    //   3. DEFAULT_AUTO_UNLOCK_PATH — the canonical host location.
    const envPath = process.env.SWITCHROOM_VAULT_BROKER_AUTO_UNLOCK_PATH;
    const configuredPath =
      (envPath && envPath.length > 0 ? envPath : undefined) ??
      this.config?.vault?.broker?.autoUnlockCredentialPath ??
      DEFAULT_AUTO_UNLOCK_PATH;
    const filePath = resolvePath(configuredPath);
    if (!existsSync(filePath)) return false;
    // A zero-length blob is semantically "nothing provisioned", not
    // "corrupt": the docker-compose bind-mount auto-materializes an
    // empty host file when ~/.switchroom/vault-auto-unlock doesn't
    // exist (non-interactive setup that didn't enable auto-unlock).
    // Treat it exactly like absent — quiet fall-through, NOT the
    // alarming "auto-unlock decrypt failed (format): malformed (wrong
    // length or version)" line that masked the real state in
    // install-validation 2026-05-17 (RFC J Phase 1 / §2.4).
    try {
      if (statSync(filePath).size === 0) return false;
    } catch {
      return false;
    }

    let passphrase: string;
    try {
      passphrase = readAutoUnlockFile(filePath);
    } catch (err) {
      if (err instanceof AutoUnlockDecryptError) {
        process.stderr.write(
          `[vault-broker] auto-unlock decrypt failed (${err.reason}): ${err.message}\n` +
          `[vault-broker] staying locked; use \`switchroom vault broker unlock\` interactively\n`,
        );
      } else if (err instanceof MachineIdUnavailableError) {
        process.stderr.write(
          `[vault-broker] auto-unlock unavailable: ${err.message}\n`,
        );
      } else {
        process.stderr.write(
          `[vault-broker] auto-unlock read failed: ${(err as Error).message}\n`,
        );
      }
      return true; // we attempted; don't fall through to systemd-creds path
    }
    try {
      this.unlockFromPassphrase(passphrase);
      process.stderr.write(`[vault-broker] auto-unlocked from ${filePath}\n`);
    } catch (err) {
      process.stderr.write(
        `[vault-broker] auto-unlock applied passphrase but vault rejected it: ` +
        `${(err as Error).message}; staying locked\n`,
      );
    }
    passphrase = "";
    return true;
  }

  /**
   * Compat path: when run as a system unit with `LoadCredentialEncrypted=`,
   * systemd materializes the decrypted credential at
   * `$CREDENTIALS_DIRECTORY/vault-passphrase`. Power users opting into that
   * setup get the same auto-unlock semantics with no further config.
   */
  private _tryAutoUnlockFromSystemdCredentials(): void {
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
          `not present; staying locked\n`,
        );
        return;
      }
      process.stderr.write(
        `[vault-broker] auto-unlock read failed: ${(err as Error).message}; ` +
        `falling back to interactive\n`,
      );
      return;
    }
    try {
      this.unlockFromPassphrase(passphrase);
      process.stderr.write(
        `[vault-broker] auto-unlocked from $CREDENTIALS_DIRECTORY/vault-passphrase\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[vault-broker] auto-unlock failed: ${(err as Error).message}; ` +
        `falling back to interactive\n`,
      );
    }
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

// ─── Vault layout drift detection (plan v3 §5 companion) ────────────────────

/**
 * Defend against state-E layout divergence: an older switchroom CLI
 * wrote to the legacy `~/.switchroom/vault.enc` path AFTER migration
 * ran, replacing the symlink with a fresh regular file. Broker and
 * CLI now write to different files; without this check the broker
 * would serve stale data unbounded.
 *
 * Reuses the canonical state machine in `migrate-layout.ts` rather
 * than re-implementing the hash-comparison logic. The check only
 * triggers when:
 *   - The resolved vault path is the canonical
 *     `<home>/.switchroom/vault/vault.enc` shape.
 *   - The state machine reports `divergent` (state E).
 *
 * Throws `VaultError` on detected drift — caller's existing VaultError
 * handling surfaces the message to logs / stderr (broker process
 * exits non-zero from the unlock failure, surfacing to the
 * compose `restart: unless-stopped` loop + healthcheck).
 */
function detectVaultLayoutDrift(vaultPath: string): void {
  // Only meaningful when the layout is the canonical
  // `<home>/.switchroom/vault/vault.enc` shape. Custom paths and
  // pre-migration single-file paths skip the check.
  const dir = dirname(vaultPath);
  if (basename(dir) !== "vault") return;
  if (basename(vaultPath) !== "vault.enc") return;
  // Re-derive the home from the path: vault/vault.enc lives at
  // <home>/.switchroom/vault/vault.enc.
  const switchroomDir = dirname(dir);
  if (basename(switchroomDir) !== ".switchroom") return;
  const home = dirname(switchroomDir);

  const result = inspectVaultLayout(home);
  if (result.kind === "divergent") {
    throw new VaultError(
      `Vault layout divergence detected at boot: ` +
      `${result.details.oldPath} and ${result.details.newPath} ` +
      `are both regular files with different content. An older switchroom ` +
      `CLI may have written to the legacy path after migration ran. ` +
      `Run \`switchroom apply\` from the host to surface the recovery recipe ` +
      `(state E refusal with literal \`mv\` commands). ` +
      `See docs/operators/state-e-recovery.md.`,
    );
  }
  // States A / B / C / D / migrated / custom-path-skipped — all fine
  // for the broker's read path.
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

// ─── Top-level entrypoint (Phase 1b — broker container CMD) ──────────────────
//
// Dockerfile.broker invokes `bun /opt/switchroom/dist/vault/broker/server.js`.
// Without a main() + entry guard, the bundle would import VaultBroker, run no
// listen call, and exit immediately (Phase 1b review blocker). We mirror the
// in-agent scheduler's pattern at src/agent-scheduler/index.ts: read env for
// socket/config/vault paths, construct a broker, register shutdown handlers,
// call start().
//
// Env contract:
//   SWITCHROOM_BROKER_SOCKET    Path to data socket. Default
//                               /run/switchroom/broker/vault-broker.sock
//                               (compose mounts /run/switchroom/broker/<agent>
//                               per-agent; the singleton broker uses the
//                               parent dir directly inside the container).
//   SWITCHROOM_BROKER_PER_AGENT_DIR   Phase 2a — when set (default
//                               /run/switchroom/broker), the broker scans
//                               this directory for files matching
//                               <agent>.sock that compose mounted in (one
//                               per agent), and binds a dedicated listener
//                               on each. Each listener uses socket-path-as-
//                               identity ACL (checkAclByAgent) instead of
//                               cgroup peercred. Falls back to legacy
//                               single-socket mode if the dir doesn't
//                               exist or is empty.
//   SWITCHROOM_CONFIG           Path to switchroom.yaml. Default unset →
//                               loadConfig() auto-detects.
//   SWITCHROOM_VAULT_PATH       Path to encrypted vault. Default from config.
//
// The broker stays alive on its open server sockets — we don't loop here.
export async function main(): Promise<void> {
  const legacySocketPath =
    process.env.SWITCHROOM_BROKER_SOCKET ??
    "/run/switchroom/broker/vault-broker.sock";
  const perAgentDir =
    process.env.SWITCHROOM_BROKER_PER_AGENT_DIR ??
    "/run/switchroom/broker";
  const configPath = process.env.SWITCHROOM_CONFIG;
  const vaultPath = process.env.SWITCHROOM_VAULT_PATH;

  // Phase 2a — enumerate per-agent socket targets that compose mounted in.
  // We accept two shapes (matching the kernel and the patterns
  // socketPathToAgent() vets):
  //   (a) regular files named <agent>.sock — pre-created by compose
  //   (b) directories named <agent> (per-agent named-volume mount points);
  //       we bind a socket at `<dir>/sock`. This is what the v0.7 compose
  //       generator emits — `broker-<name>-sock` mounts at
  //       `/run/switchroom/broker/<name>` inside the broker, and the agent
  //       sees the same file via its `/run/switchroom/broker` mount of
  //       the same volume, accessed by its env path
  //       `/run/switchroom/broker/<name>/sock`.
  //   (c) nothing (named volumes that resolve to empty dirs without the
  //       per-agent subdir mounts) — fall through to legacy single-socket.
  // The agent name is always derived from the socket path (not from a
  // wire-payload field) via socketPathToAgent(), so both shapes preserve
  // the path-as-identity invariant.
  let perAgentTargets: string[] = [];
  try {
    if (existsSync(perAgentDir)) {
      const entries = readdirSync(perAgentDir, { withFileTypes: true });
      const flat: string[] = [];
      const subdirs: string[] = [];
      for (const e of entries) {
        if (e.name.startsWith(".")) continue;
        // (a) flat file
        if (
          (e.isFile() || e.isSocket()) &&
          e.name.endsWith(".sock")
        ) {
          flat.push(resolve(perAgentDir, e.name));
          continue;
        }
        // (b) per-agent subdir — bind <subdir>/sock if the subdir name
        // parses as a valid agent identifier.
        if (e.isDirectory()) {
          const candidate = resolve(perAgentDir, e.name, "sock");
          if (socketPathToAgent(candidate) !== null) {
            subdirs.push(candidate);
          }
        }
      }
      perAgentTargets = [...flat, ...subdirs]
        .filter((p) => socketPathToAgent(p) !== null)
        .sort();
    }
  } catch (err) {
    process.stderr.write(
      `[vault-broker] per-agent enumeration failed at ${perAgentDir}: ${(err as Error).message}\n`,
    );
  }

  const broker = new VaultBroker();
  registerShutdownHandlers(broker);

  // SIGHUP — hot-reload switchroom.yaml so secret-ACL / agent-admin /
  // approval-posture edits take effect without a container restart. Mirrors
  // the auth-broker (src/auth/broker/index.ts): re-read config from disk and
  // hand it to reload(). Both the synchronous loadConfig() throw and any
  // reload failure are caught + logged, so a half-written or invalid config
  // never crashes the broker — it keeps serving the last-good config.
  process.on("SIGHUP", () => {
    void (async () => {
      try {
        const { loadConfig } = await import("../../config/loader.js");
        broker.reload(loadConfig(configPath));
        process.stdout.write("vault-broker: SIGHUP reload — config refreshed\n");
      } catch (err) {
        process.stderr.write(
          `vault-broker: SIGHUP reload failed (keeping previous config): ${(err as Error).message}\n`,
        );
      }
    })();
  });

  if (perAgentTargets.length > 0) {
    // Phase 2a path. We still need start() to load config, vault path,
    // grants DB, and bind the unlock socket — those are unchanged. We
    // pass the legacy path so the existing data socket also binds (acts
    // as the operator-control surface for unlock + grant management),
    // then layer per-agent listeners on top.
    await broker.start(legacySocketPath, configPath, vaultPath);
    process.stdout.write(
      `vault-broker: legacy socket listening on ${legacySocketPath}\n`,
    );
    for (const target of perAgentTargets) {
      try {
        const agentName = await broker.bindAgentSocket(target);
        process.stdout.write(
          `vault-broker: per-agent socket listening agent=${agentName} sock=${target}\n`,
        );
      } catch (err) {
        process.stderr.write(
          `[vault-broker] failed to bind ${target}: ${(err as Error).message}\n`,
        );
      }
    }

    // Operator listener — host-shell-reachable data + unlock pair under
    // /run/switchroom/broker/operator/{sock,unlock}, chowned to the host
    // operator UID. Skipped when the env var isn't set (legacy installs
    // and tests that don't need it).
    const operatorUidStr = process.env.SWITCHROOM_BROKER_OPERATOR_UID;
    const operatorDir = "/run/switchroom/broker/operator";
    if (operatorUidStr !== undefined && existsSync(operatorDir)) {
      const operatorUid = parseInt(operatorUidStr, 10);
      if (!Number.isFinite(operatorUid) || operatorUid <= 0) {
        process.stderr.write(
          `[vault-broker] SWITCHROOM_BROKER_OPERATOR_UID='${operatorUidStr}' is not a positive integer; skipping operator listener\n`,
        );
      } else {
        const operatorSock = `${operatorDir}/sock`;
        try {
          await broker.bindOperatorListener(operatorSock, operatorUid);
          process.stdout.write(
            `vault-broker: operator socket listening sock=${operatorSock} uid=${operatorUid}\n`,
          );
        } catch (err) {
          process.stderr.write(
            `[vault-broker] failed to bind operator listener at ${operatorSock}: ${(err as Error).message}\n`,
          );
        }
      }
    }
    return;
  }

  // Legacy single-socket fallback.
  await broker.start(legacySocketPath, configPath, vaultPath);
  process.stdout.write(
    `vault-broker: listening on ${legacySocketPath}\n`,
  );
}

// Entry guard — only run main() when this file is invoked directly as the
// broker server bundle (dist/vault/broker/server.js or src/vault/broker/
// server.ts). The naive `import.meta.url === file://${process.argv[1]}`
// guard fires spuriously when this module is bundled INTO another entry
// point (e.g. dist/cli/switchroom.js): bun's bundler rewrites
// `import.meta.url` to point at the OUTPUT bundle, so the comparison
// matches argv[1] for any CLI invocation and the broker tries to boot
// from random verbs like `issues list`. We additionally require the
// bundle filename to look like the broker entry. See PR #807 / CI fix.
if (
  import.meta.url === `file://${process.argv[1]}` &&
  /(?:^|[/\\])(?:vault[/\\]broker[/\\])?server\.(?:js|ts)$/.test(
    process.argv[1] ?? "",
  )
) {
  main().catch((err) => {
    process.stderr.write(
      `vault-broker fatal: ${err instanceof Error ? err.stack : err}\n`,
    );
    process.exit(1);
  });
}
