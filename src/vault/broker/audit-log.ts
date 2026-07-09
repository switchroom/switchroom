/**
 * audit-log — append-only audit log for vault broker access.
 *
 * Every vault key access — successful or denied — leaves a record in
 * ~/.switchroom/vault-audit.log (mode 0600, newline-delimited JSON).
 *
 * Design constraints:
 *   - Sync write (no buffering, no Promises) — audit must survive a broker
 *     crash mid-request. The broker is request/response; write completes
 *     before response is sent.
 *   - O_APPEND flag — on Linux, write(2) calls with O_APPEND are atomic up
 *     to PIPE_BUF (4 KiB) bytes, so concurrent writes of short JSON lines
 *     don't interleave bytes within a line.
 *   - Mode 0600 — user-owned, not world-readable.
 *   - Path is injectable for tests (use a tmp file, not the real log).
 *   - NEVER log secret values — only key names and results.
 *   - Failures write to process.stderr — a broken audit volume must not be
 *     silent (the operator needs to notice).
 *
 * Usage:
 *   const audit = createAuditLogger();                  // default path
 *   const audit = createAuditLogger({ path: tmpFile }); // test override
 *   audit.write({ ts, op, key, caller, pid, agent_name, result });
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chainRow, seedChain, type ChainState } from "../../util/audit-hashchain.js";
import { safeAuditLogPath } from "./test-isolation-guard.js";

/** Operations the broker can perform. (PR-6: `approval_consume_record`
 *  is an additive member of the shared broker/kernel request union, so
 *  the broker's grant-mgmt `writeAudit({ op: req.op })` callsites now
 *  see it in `req.op`'s static type even though the broker never
 *  dispatches it — including it here keeps the audit-op vocabulary a
 *  superset of the wire ops and satisfies tsc with no runtime change.) */
export type AuditOp = "get" | "put" | "set" | "delete" | "list" | "unlock" | "lock" | "mint_grant" | "list_grants" | "revoke_grant" | "preflight_access" | "approval_consume_record";

/**
 * One audit log entry.
 * `key` is omitted for ops that don't target a specific key (e.g. unlock, lock, list).
 *
 * Identity model (v0.7+): agent identity is path-as-identity — the trusted
 * field is `agent_name`, derived from the per-agent socket bind path. The
 * `caller` / `cgroup` fields are legacy/informational: `cgroup` is only
 * populated on legacy systemd-mode hosts where peercred could resolve a
 * cgroup unit, and is undefined otherwise (the docker norm).
 */
export interface AuditEntry {
  /** ISO-8601 timestamp, e.g. "2026-04-28T14:33:00.123Z" */
  ts: string;
  /** Operation name */
  op: AuditOp;
  /** Vault key name — NEVER the secret value */
  key?: string;
  /**
   * Human-readable caller identity. "agent:<name>" on the v0.7+
   * path-as-identity path, "operator" on the operator socket, or the
   * legacy "<unit>.service" / "pid:<n>" fallback (see callerFromPeer).
   */
  caller: string;
  /** PID of the calling process */
  pid: number;
  /**
   * Legacy cgroup unit name, e.g. "switchroom-myagent-cron-0.service".
   * Only set on systemd-mode hosts; undefined on docker (path-as-identity).
   * Informational only — never the ACL identity.
   */
  cgroup?: string;
  /** Outcome: "allowed", "denied:<reason>", or "error:<detail>" */
  result: string;
  /**
   * Access method — "peercred" for the normal cron-unit path, "grant"
   * when a capability token was used, "passphrase" when the operator
   * passphrase was forwarded as attestation (issue #969 P1a). Omitted
   * for ops that don't involve secret access (lock, unlock, status).
   */
  method?: "peercred" | "grant" | "passphrase" | "posture";
  /**
   * Grant ID (e.g. "vg_a1b2c3") when method === "grant". Never contains
   * the secret half — only the ID prefix is logged.
   */
  grant_id?: string;
  /**
   * Phase 2a — informational SO_PEERCRED UID captured at accept(2) time.
   * Recorded on the agent-bound (socket-path-as-identity) path so an
   * operator forensically reviewing the audit log can correlate against
   * the host's UID-allocation table. NEVER used to gate ACL — agent
   * identity is the listener's socket path, full stop.
   */
  peer_uid?: number;
  /**
   * Phase 2a — agent slug derived from the listener's socket path
   * (/run/switchroom/broker/<agent>.sock). When present, this is the
   * trusted identity used for the ACL decision; cgroup is informational
   * (and typically null on the agent-bound path).
   */
  agent_name?: string;
}

export interface AuditLogger {
  write(entry: AuditEntry): void;
}

/** Options for createAuditLogger. */
export interface AuditLoggerOptions {
  /**
   * Absolute path to the audit log file.
   * Defaults to ~/.switchroom/vault-audit.log (resolved via os.homedir()).
   */
  path?: string;
  /**
   * Size-based rotation threshold in bytes (issue #2792 item B). When the
   * active log grows past this size, it is rotated to `<path>.1` (shifting
   * `.1`→`.2`, …) before the next append. `0`/`undefined` uses the default;
   * a negative value disables rotation entirely. Env override:
   * `SWITCHROOM_VAULT_AUDIT_MAX_BYTES`.
   */
  maxBytes?: number;
  /**
   * How many rotated files to retain (`<path>.1` … `<path>.<maxFiles>`).
   * The oldest is deleted when it would exceed this count. `0`/`undefined`
   * uses the default. Env override: `SWITCHROOM_VAULT_AUDIT_MAX_FILES`.
   */
  maxFiles?: number;
}

/**
 * Default rotation threshold: 32 MiB. At ~300 bytes/row this is ~100k
 * audit rows per file — a generous forensic window that still bounds the
 * active file. Conservative: rotation preserves rows (nothing is
 * truncated in place), and the hash chain continues seamlessly across the
 * rotation boundary (see createAuditLogger).
 */
export const DEFAULT_AUDIT_MAX_BYTES = 32 * 1024 * 1024;
/**
 * Default number of rotated files retained. Total on-disk audit history is
 * bounded at roughly `(maxFiles + 1) * maxBytes`. The oldest rotated file
 * is deleted past this count — that DOES discard tamper-evidence for the
 * very oldest rows, so operators who need an unbounded forensic archive
 * should raise this or ship rows off-box.
 */
export const DEFAULT_AUDIT_MAX_FILES = 5;

/**
 * Resolve the effective rotation config from options + env overrides.
 * Negative maxBytes disables rotation.
 */
function resolveRotation(opts: AuditLoggerOptions): {
  maxBytes: number;
  maxFiles: number;
} {
  const envBytes = Number(process.env.SWITCHROOM_VAULT_AUDIT_MAX_BYTES);
  const envFiles = Number(process.env.SWITCHROOM_VAULT_AUDIT_MAX_FILES);
  const maxBytes =
    opts.maxBytes !== undefined && opts.maxBytes !== 0
      ? opts.maxBytes
      : Number.isFinite(envBytes) && envBytes !== 0
        ? envBytes
        : DEFAULT_AUDIT_MAX_BYTES;
  const maxFiles =
    opts.maxFiles !== undefined && opts.maxFiles > 0
      ? opts.maxFiles
      : Number.isFinite(envFiles) && envFiles > 0
        ? envFiles
        : DEFAULT_AUDIT_MAX_FILES;
  return { maxBytes, maxFiles };
}

/**
 * Rotate the audit log: `<path>.(n-1)` → `<path>.n`, dropping the oldest
 * past `maxFiles`, then snapshot `<path>` → `<path>.1` and truncate the
 * active file back to zero bytes IN PLACE.
 *
 * Why copy-then-truncate rather than rename (issue #2953): in the deployed
 * topology the active log is bind-mounted into the broker container as a
 * SINGLE FILE (not its parent directory), which makes `<path>` a mount
 * point inside the container's mount namespace. `rename(2)` cannot replace
 * an active mount point, so `rename(<path>, <path>.1)` fails with EBUSY on
 * every attempt and the log grows unbounded. Copying the bytes out to
 * `<path>.1` and then `ftruncate`-ing the original to length 0 keeps the
 * active inode/mount point in place, so it works regardless of whether the
 * operator mounts the file or its parent directory.
 *
 * The active file is truncated (not deleted/recreated), so its inode, mode,
 * and — critically — its bind mount survive. The in-process hash chain is
 * intentionally NOT reset, so the first row appended after truncation links
 * back to the last row now living in `<path>.1` and cross-file continuity
 * holds. Best-effort: any failure is reported and rotation is skipped (the
 * current file keeps growing rather than losing data).
 *
 * NOTE: the `.1 … .maxFiles` rotated files are ordinary files created by
 * this function inside the log's directory, so shifting them with `rename`
 * is safe — only the active `<path>` is (potentially) a mount point.
 */
function rotateAuditLog(logPath: string, maxFiles: number): void {
  // Delete the oldest retained file if it exists — it would fall off the
  // window after the shift.
  const oldest = `${logPath}.${maxFiles}`;
  if (fs.existsSync(oldest)) {
    try {
      fs.unlinkSync(oldest);
    } catch (err) {
      process.stderr.write(
        `[vault-audit] ERROR: could not drop oldest rotation ${oldest}: ${(err as Error).message}\n`,
      );
    }
  }
  // Shift .(n-1) → .n for n = maxFiles down to 2. These are ordinary files
  // (never mount points), so rename is fine.
  for (let n = maxFiles - 1; n >= 1; n--) {
    const from = `${logPath}.${n}`;
    const to = `${logPath}.${n + 1}`;
    if (!fs.existsSync(from)) continue;
    try {
      fs.renameSync(from, to);
    } catch (err) {
      process.stderr.write(
        `[vault-audit] ERROR: could not rotate ${from} → ${to}: ${(err as Error).message}\n`,
      );
      return;
    }
  }
  // Finally, snapshot active → .1 by COPYING the bytes, then truncate the
  // active file in place. Copy first: if the copy fails we leave the active
  // file untouched (grow rather than lose rows). Only after the snapshot is
  // durably on stable storage do we truncate the live file back to zero
  // length.
  //
  // DURABILITY (#2955 review): `copyFileSync` returning does NOT mean the
  // bytes are on stable storage — they may sit in the page cache. Truncate
  // is an explicit data-destroying op, so without an fsync of the snapshot
  // between copy and truncate, a host-crash window loses rows AND leaves
  // the active file zeroed. fsync the `.1` snapshot (and best-effort the
  // parent dir) before truncating — matches `vault.ts`'s durability
  // discipline and makes the "safely on disk" claim below literally true.
  const snapshotPath = `${logPath}.1`;
  try {
    fs.copyFileSync(logPath, snapshotPath);
  } catch (err) {
    process.stderr.write(
      `[vault-audit] ERROR: could not snapshot active audit log ${logPath} → ${snapshotPath}: ${(err as Error).message}\n`,
    );
    return;
  }
  // Durably persist the snapshot before destroying the source. Best-effort:
  // some filesystems reject fsync, but a failed fsync here is still safer
  // than skipping it — we proceed to truncate only when the snapshot has
  // been open + flushed. If the fsync throws, leave the active file intact
  // (grow rather than risk losing rows to a truncate on an unflushed copy).
  try {
    const fd = fs.openSync(snapshotPath, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    process.stderr.write(
      `[vault-audit] ERROR: could not fsync audit snapshot ${snapshotPath}; leaving active log intact to avoid data loss: ${(err as Error).message}\n`,
    );
    return;
  }
  // Best-effort fsync of the parent dir so the snapshot's dirent update is
  // persisted (POSIX permits a post-copy crash to lose the dirent otherwise).
  // A failure here is non-fatal — the data is flushed; only the directory
  // entry update is at risk, and re-running rotation is idempotent.
  try {
    const dirFd = fs.openSync(path.dirname(snapshotPath), "r");
    try {
      fs.fsyncSync(dirFd);
    } finally {
      fs.closeSync(dirFd);
    }
  } catch {
    /* best-effort: some filesystems refuse fsync on directories */
  }
  try {
    // truncate(2) resets length to 0 while preserving the inode, mode, and
    // any bind mount at this path — unlike rename, which would fail EBUSY on
    // a single-file bind mount (issue #2953).
    fs.truncateSync(logPath, 0);
  } catch (err) {
    process.stderr.write(
      `[vault-audit] ERROR: could not truncate active audit log ${logPath}: ${(err as Error).message}\n`,
    );
  }
}

/**
 * Default log path: ~/.switchroom/vault-audit.log.
 * Resolved at call time so tests can override os.homedir() if needed,
 * but typically called once at broker startup.
 */
export function defaultAuditLogPath(): string {
  return path.join(os.homedir(), ".switchroom", "vault-audit.log");
}

/**
 * Legacy fallback — derive a caller string from a PeerInfo-like object
 * for the pre-v0.7 (non-per-agent-socket) path. Prefers the cgroup unit
 * name; falls back to "pid:<n>". On the v0.7+ path-as-identity path the
 * server uses "agent:<name>" directly and does not call this.
 */
export function callerFromPeer(peer: {
  pid: number;
  systemdUnit: string | null;
}): string {
  // Guard empty string in addition to null. A malformed cgroup hierarchy
  // can produce systemdUnit === "" — without this check the audit log
  // would record `caller: ""` instead of falling back to the pid.
  if (peer.systemdUnit !== null && peer.systemdUnit.length > 0) {
    return peer.systemdUnit;
  }
  return `pid:${peer.pid}`;
}

/**
 * Factory — returns an AuditLogger that writes to the configured path.
 *
 * The logger opens + writes + closes on every call (O_APPEND mode).
 * This is intentionally NOT a persistent open-fd design: keeping the fd open
 * across requests would prevent log rotation (logrotate moves the file while
 * the fd still points at the old inode). Re-opening per write is cheap on
 * Linux for a low-volume audit channel.
 */
export function createAuditLogger(opts: AuditLoggerOptions = {}): AuditLogger {
  // test-isolation guard: under the test runner, a would-be-production
  // path (a broker built without an explicit _testAuditLogger) is
  // redirected to a tmp file so tests can't pollute the operator's real
  // vault-audit.log. No-op in production. See test-isolation-guard.ts.
  const logPath = safeAuditLogPath(opts.path ?? defaultAuditLogPath());
  // sec WS10-F2 / #1417: per-row hash chain for tamper-evidence.
  // Seeded once from the existing log tail at broker startup; advanced
  // in-process per write (single-writer-process contract — see
  // audit-hashchain.ts). State is only committed AFTER a durable write
  // so a failed append can't desync the chain from disk.
  let chain: ChainState = seedChain(logPath);

  // Rotation config (issue #2792 item B). A negative maxBytes disables
  // rotation; the chain state is preserved across rotations so cross-file
  // tamper-evidence continuity holds.
  const rotation = resolveRotation(opts);

  return {
    write(entry: AuditEntry): void {
      // Size-based rotation check before the append. Best-effort:
      // stat failures leave the file untouched (grow rather than lose).
      if (rotation.maxBytes > 0) {
        try {
          const size = fs.statSync(logPath).size;
          if (size >= rotation.maxBytes) {
            rotateAuditLog(logPath, rotation.maxFiles);
          }
        } catch {
          // No file yet (first write) or stat error — nothing to rotate.
        }
      }
      // Build the chained JSON line. Control characters are not a
      // concern for the fields we log (ISO timestamps, key names, unit
      // names, pid numbers); JSON.stringify handles them anyway.
      const { line, next } = chainRow(
        chain,
        entry as unknown as Record<string, unknown>,
      );

      let fd: number;
      try {
        // 'a' = O_WRONLY | O_CREAT | O_APPEND — atomic appends on Linux.
        // Mode 0o600: user-only read/write.
        fd = fs.openSync(logPath, "a", 0o600);
      } catch (err) {
        process.stderr.write(
          `[vault-audit] ERROR: could not open audit log ${logPath}: ${(err as Error).message}\n`,
        );
        return;
      }

      try {
        fs.writeSync(fd, line);
        // Durable: advance the chain only now.
        chain = next;
      } catch (err) {
        process.stderr.write(
          `[vault-audit] ERROR: could not write to audit log ${logPath}: ${(err as Error).message}\n`,
        );
      } finally {
        try {
          fs.closeSync(fd);
        } catch (closeErr) {
          process.stderr.write(
            `[vault-audit] ERROR: could not close audit log fd: ${(closeErr as Error).message}\n`,
          );
        }
      }
    },
  };
}
