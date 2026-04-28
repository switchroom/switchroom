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
 *   audit.write({ ts, op, key, caller, pid, cgroup, result });
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/** Operations the broker can perform. */
export type AuditOp = "get" | "set" | "delete" | "list" | "unlock" | "lock" | "mint_grant" | "list_grants" | "revoke_grant";

/**
 * One audit log entry.
 * `key` is omitted for ops that don't target a specific key (e.g. unlock, lock, list).
 * `cgroup` is undefined when peercred couldn't resolve the caller's systemd unit.
 */
export interface AuditEntry {
  /** ISO-8601 timestamp, e.g. "2026-04-28T14:33:00.123Z" */
  ts: string;
  /** Operation name */
  op: AuditOp;
  /** Vault key name — NEVER the secret value */
  key?: string;
  /** Human-readable caller identity: cgroup unit name or "pid:<n>" */
  caller: string;
  /** PID of the calling process */
  pid: number;
  /** Raw cgroup unit name if available, e.g. "switchroom-myagent-cron-0.service" */
  cgroup?: string;
  /** Outcome: "allowed", "denied:<reason>", or "error:<detail>" */
  result: string;
  /**
   * Access method — "peercred" for the normal cron-unit path, "grant" when
   * a capability token was used. Omitted for ops that don't involve secret
   * access (lock, unlock, status).
   */
  method?: "peercred" | "grant";
  /**
   * Grant ID (e.g. "vg_a1b2c3") when method === "grant". Never contains
   * the secret half — only the ID prefix is logged.
   */
  grant_id?: string;
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
 * Derive a friendly caller string from a PeerInfo-like object.
 * Prefers the cgroup unit name; falls back to "pid:<n>".
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
  const logPath = opts.path ?? defaultAuditLogPath();

  return {
    write(entry: AuditEntry): void {
      // Build the JSON line. Control characters are not a concern for the
      // fields we log (ISO timestamps, key names, unit names, pid numbers),
      // but JSON.stringify handles them correctly anyway.
      const line = JSON.stringify(entry) + "\n";

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
