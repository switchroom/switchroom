/**
 * peercred — Linux peer-credential identification for Unix socket connections.
 *
 * Two paths, picked at runtime:
 *
 *   1. Bun runtime — `bun:ffi` getsockopt(SO_PEERCRED) on the accepted
 *      socket fd. The kernel binds peer credentials to the connection
 *      itself, so this returns the unique caller for *this* socket — no
 *      shell-out, no inode join, no concurrency ambiguity. ~30 LOC.
 *      See `peercred-ffi.ts`.
 *
 *   2. Node fallback — `ss -xpn` parsing. Same approach as before, but
 *      issue #129 fixed the concurrency hazard: instead of "first row
 *      that matches the listening socket path wins", we now match by
 *      `serverFdInode` — the inode of the accepted server-side socket
 *      fd, obtained via `fs.fstatSync(socket._handle.fd).ino`. That
 *      gives us the unique row for this connection regardless of how
 *      many clients are connected simultaneously.
 *
 * Both paths cross-check the resolved PID's UID against the broker's UID
 * and look up its cgroup-derived systemd unit (validated against
 * systemctl-user). The cgroup identity is what the ACL gates on.
 *
 * Security model:
 *   - Fail-closed: any parse error, missing /proc entry, or UID mismatch
 *     returns null (caller treats null as "unidentified" and denies).
 *   - On non-Linux this module returns null immediately. The broker
 *     refuses to start on non-Linux unless SWITCHROOM_BROKER_ALLOW_NON_LINUX
 *     is set (see VaultBroker.start), so production never reaches that path.
 *
 * This module is the single seam for OS-specific process identification.
 * Keep it small, pure, and independently testable.
 */

import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { readFileSync, readlinkSync, fstatSync } from "node:fs";
import type { Socket } from "node:net";
import { getPeerCred } from "./peercred-ffi.js";

export interface PeerInfo {
  uid: number;
  pid: number;
  exe: string;
  /** Systemd unit name e.g. "switchroom-myagent-cron-3.service", or null if
   *  the caller is not a switchroom cron unit or cgroup is unavailable. */
  systemdUnit: string | null;
}

/**
 * One row of `ss -xpn` output for a unix-domain connection.
 *
 * `ss -xpn` lists every endpoint of every unix-domain connection — the server
 * side and the client side appear as separate rows that share an inode pair.
 *   server side: Local = SOCKET_PATH inodeA, Peer = * inodeB
 *   client side: Local = *           inodeB, Peer = * inodeA
 *
 * We need both rows to identify the client: the path filter selects the
 * server row, then we walk the client row keyed by `inodeB` to read its pid.
 */
interface SsRow {
  localAddr: string;
  localInode: string;
  peerAddr: string;
  peerInode: string;
  pid: number | null;
}

/**
 * Parse `ss -xpn` output into structured rows. Tolerant of missing fields
 * (the users:() column may be absent if the process exited mid-scan).
 */
function parseSsRows(output: string): SsRow[] {
  const rows: SsRow[] = [];
  const lines = output.split("\n");
  for (const line of lines) {
    if (!line.trim() || line.startsWith("Netid")) continue;
    // Tokenize on whitespace runs. Columns are:
    //   netid state recv-q send-q local-addr local-inode peer-addr peer-inode [users:(...)]
    // (`ss` reuses the TCP "port" header label even for unix sockets, where
    //  the trailing slot actually holds an inode number.)
    const tokens = line.split(/\s+/).filter((t) => t.length > 0);
    if (tokens.length < 8) continue;
    const localAddr = tokens[4];
    const localInode = tokens[5];
    const peerAddr = tokens[6];
    const peerInode = tokens[7];
    const usersToken = tokens.slice(8).join(" ");
    const m = usersToken.match(/users:\(\(".*?",pid=(\d+),fd=\d+\)\)/);
    const pid = m ? parseInt(m[1], 10) : null;
    rows.push({ localAddr, localInode, peerAddr, peerInode, pid });
  }
  return rows;
}

/**
 * Given parsed `ss -xpn` rows and our listening socket path, return the
 * caller-side PIDs for every active connection to that socket.
 *
 * For each row whose Local Address equals our socket, we look up the matching
 * client row via the peer-inode pair (server's peerInode === client's
 * localInode) and harvest its pid. Server-side rows are skipped because they
 * point at the broker itself.
 */
function findClientPids(rows: SsRow[], socketPath: string): number[] {
  const pids: number[] = [];
  for (const serverRow of rows) {
    if (serverRow.localAddr !== socketPath) continue;
    // Find the client row whose local inode equals our peer inode.
    for (const clientRow of rows) {
      if (clientRow.localAddr !== "*") continue;
      if (clientRow.localInode !== serverRow.peerInode) continue;
      if (clientRow.pid === null) continue;
      pids.push(clientRow.pid);
      break;
    }
  }
  return pids;
}

/**
 * Like `findClientPids`, but pinpoints the row corresponding to the
 * specific accepted server-side fd whose inode the caller already knows.
 * Eliminates the "first connected entry wins" concurrency hazard that the
 * original code documented — when N clients are connected, this returns
 * the PID of the *Nth* one corresponding to *our* fd, not whichever ss
 * happened to list first.
 *
 * Returns null when:
 *   - no server row's localInode matches `serverInode` (we may have raced
 *     with the kernel's socket bookkeeping)
 *   - the matching server row has a peerInode but no client row has that
 *     localInode (client may have already disconnected)
 *
 * Issue #129.
 */
function findClientPidByServerInode(
  rows: SsRow[],
  socketPath: string,
  serverInode: number,
): number | null {
  // SsRow.localInode is a string (parsed from ss output as-is). Stringify
  // the numeric inode from fstat once so the comparison is type-correct.
  const serverInodeStr = String(serverInode);
  for (const serverRow of rows) {
    if (serverRow.localAddr !== socketPath) continue;
    if (serverRow.localInode !== serverInodeStr) continue;
    for (const clientRow of rows) {
      if (clientRow.localAddr !== "*") continue;
      if (clientRow.localInode !== serverRow.peerInode) continue;
      if (clientRow.pid === null) continue;
      return clientRow.pid;
    }
    return null;
  }
  return null;
}

/**
 * Read the UID from /proc/<pid>/status.
 * Returns null on any I/O or parse error (process may have exited).
 */
function readUid(pid: number): number | null {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    // Uid: real effective saved fs
    const m = status.match(/^Uid:\s+(\d+)/m);
    if (!m) return null;
    return parseInt(m[1], 10);
  } catch {
    return null;
  }
}

/**
 * Read the exe path from /proc/<pid>/exe symlink.
 * Returns null on any error.
 */
function readExe(pid: number): string | null {
  try {
    return readlinkSync(`/proc/${pid}/exe`);
  } catch {
    return null;
  }
}

/**
 * Read the systemd unit name from /proc/<pid>/cgroup.
 *
 * Supports both cgroup v2 (single line starting with "0::") and cgroup v1
 * (multiple lines; the relevant controller has "name=systemd" in field 2).
 *
 * Returns the unit name (e.g. "switchroom-myagent-cron-3.service") if the
 * process is in a switchroom cron unit, or null otherwise.
 * Never throws — all errors return null.
 */
export function readSystemdUnit(pid: number): string | null {
  try {
    const content = readFileSync(`/proc/${pid}/cgroup`, "utf8");
    const lines = content.split("\n");

    for (const line of lines) {
      if (!line.trim()) continue;

      const parts = line.split(":");
      if (parts.length < 3) continue;

      const controller = parts[1];
      // cgroup v2: controller field is empty, hierarchy id is "0"
      // cgroup v1: find the name=systemd controller
      const isV2 = parts[0] === "0" && controller === "";
      const isV1Systemd = controller === "name=systemd";

      if (!isV2 && !isV1Systemd) continue;

      // The path is everything from parts[2] onward (paths may contain colons in theory)
      const cgroupPath = parts.slice(2).join(":");
      const segments = cgroupPath.split("/");
      const lastSegment = segments[segments.length - 1];

      if (!lastSegment) continue;

      // Must match the switchroom cron unit naming convention
      if (/^switchroom-[a-zA-Z0-9_-]+-cron-\d+\.service$/.test(lastSegment)) {
        return lastSegment;
      }
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Verify with systemd-user that a unit name read from /proc/<pid>/cgroup
 * actually corresponds to a unit systemd has loaded.
 *
 * Background: under cgroup v2 user delegation, a regular user owns their
 * own user@<uid>.service subtree and can `mkdir` arbitrary cgroup
 * directories within it (including paths shaped like
 * `switchroom-<agent>-cron-<i>.service`) and move their own processes in
 * via `cgroup.procs`. /proc/<pid>/cgroup then reports the spoofed name.
 * The cgroup file by itself is therefore attacker-controlled input for
 * any same-UID caller — the broker can't trust it without cross-checking
 * against systemd's authoritative view.
 *
 * `systemctl --user show <unit>` returns LoadState=not-found for any
 * name systemd-user has not loaded as a real unit. Real cron units (and
 * `systemd-run --user --unit=...` transient units) report
 * LoadState=loaded with an ActiveState we accept.
 *
 * Returns true only when the unit is loaded and currently running.
 */
export function verifySystemdUnit(
  unitName: string,
  runner: (
    file: string,
    args: readonly string[],
    opts: ExecFileSyncOptions,
  ) => Buffer | string,
): boolean {
  let raw: string;
  try {
    const out = runner(
      "systemctl",
      [
        "--user",
        "show",
        unitName,
        "--property=LoadState,ActiveState",
      ],
      { timeout: 500, encoding: "utf8" },
    );
    raw = typeof out === "string" ? out : out.toString("utf8");
  } catch {
    // systemctl not available, timeout, or returned non-zero — fail closed
    return false;
  }

  const props: Record<string, string> = {};
  for (const line of raw.split("\n")) {
    const m = line.match(/^([A-Za-z]+)=(.*)$/);
    if (m) props[m[1]] = m[2];
  }

  // not-found: spoofed cgroup with no corresponding registered unit.
  if (props.LoadState !== "loaded") return false;

  // Real cron units cycle through `activating` (Type=oneshot ExecStart
  // running) and `active`. Any other state means the unit isn't currently
  // executing the caller's script — reject.
  if (props.ActiveState !== "active" && props.ActiveState !== "activating") {
    return false;
  }

  return true;
}

/**
 * Read the inode of an open file descriptor. Used to disambiguate ss rows
 * for our specific accepted connection (issue #129). Returns null on any
 * error so the caller can fall through to less-precise matching.
 */
function readFdInode(fd: number): number | null {
  try {
    const stat = fstatSync(fd);
    // Node's Stats.ino is `number` on 32-bit inodes and falls back to
    // `bigint` only when bigint:true is requested. We never request bigint,
    // so this is safely numeric on Linux.
    return stat.ino as number;
  } catch {
    return null;
  }
}

/**
 * Extract the file descriptor from a connected `net.Socket`. Uses the
 * undocumented `_handle.fd` because Node has no public fd accessor (only
 * a setter via the constructor). The cast is intentional and isolated to
 * this one helper so the rest of peercred treats fd as a plain number.
 *
 * Returns null when the handle is missing (socket already destroyed) or
 * the fd is unset (Windows / non-fd-backed handle).
 */
function fdFromSocket(socket: Socket): number | null {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const handle = (socket as unknown as { _handle?: { fd?: number } })._handle;
  if (!handle || typeof handle.fd !== "number" || handle.fd < 0) return null;
  return handle.fd;
}

/**
 * Identify the peer on the other end of a Unix domain socket connection.
 *
 * Two-path implementation:
 *
 *   1. **Bun fast path** — when `socket` is provided AND we're on Linux
 *      AND `bun:ffi` is available, call `getsockopt(fd, SOL_SOCKET,
 *      SO_PEERCRED)` directly. The kernel binds peer creds to the
 *      connection at accept(2) time, so this gives the unique caller for
 *      this exact socket. Cleanest, fastest, no shell-out.
 *
 *   2. **Node fallback** — `ss -xpn` parsing. When `socket` is provided
 *      we now also pull the server-side fd's inode via `fstatSync` and
 *      pass it to `findClientPidByServerInode`, which selects the
 *      *exactly correct* row instead of "first row that matches
 *      socketPath". That fixes the concurrency hazard the original code
 *      documented as a "known limitation" (issue #129).
 *
 * @param socketPath - Absolute path to the listening socket.
 * @param socket - Optional connected socket from the accept() callback.
 *                 Strongly preferred — without it we fall back to the
 *                 first-row-wins lookup, which has the historical race.
 * @param execFileSyncOverride - Injectable for testing (default: Node's execFileSync).
 * @returns PeerInfo or null (unidentified / non-Linux / error).
 */
export function identify(
  socketPath: string,
  socket?: Socket,
  execFileSyncOverride?: (
    file: string,
    args: readonly string[],
    opts: ExecFileSyncOptions,
  ) => Buffer | string,
): PeerInfo | null {
  if (process.platform !== "linux") {
    // macOS / other: degrade to UID-only (socket file mode 0600 is the guard).
    // The broker also refuses to start on non-Linux unless explicitly
    // overridden, so this branch is reachable only via the dev escape hatch.
    return null;
  }

  const runner = execFileSyncOverride ?? execFileSync;

  // ── Path 1: bun:ffi SO_PEERCRED ──────────────────────────────────────────
  // Returns null under node (bun:ffi unavailable) or if getsockopt errors.
  // We then fall through to the ss-parsing path below.
  let pid: number | null = null;
  if (socket !== undefined) {
    const fd = fdFromSocket(socket);
    if (fd !== null) {
      const cred = getPeerCred(fd);
      if (cred !== null) {
        pid = cred.pid;
        // The UID from SO_PEERCRED is authoritative; record it now so we can
        // skip the /proc/<pid>/status read below if it agrees with the broker.
        // (We re-validate below for robustness.)
      }
    }
  }

  // ── Path 2: ss -xpn fallback (concurrency-safe via inode match) ──────────
  if (pid === null) {
    let ssOutput: string;
    try {
      // We need every unix endpoint to do the inode-pair lookup that maps the
      // server-side row to the client-side row. `ss` only stamps the path on
      // the server side; the connecting client appears under `Local *
      // <inode>`. A `src` or `dst` filter narrows the result before we can
      // match the pair, so we list everything and filter in user space.
      const raw = runner("ss", ["-xpn"], {
        timeout: 200,
        encoding: "utf8",
      });
      ssOutput = typeof raw === "string" ? raw : raw.toString("utf8");
    } catch {
      // ss not available or timed out — fail closed
      return null;
    }

    const rows = parseSsRows(ssOutput);

    // When we have a connected socket, pin the lookup to its server-side
    // inode. That eliminates the "first connected client wins" race the
    // original code warned about (issue #129).
    let serverInode: number | null = null;
    if (socket !== undefined) {
      const fd = fdFromSocket(socket);
      if (fd !== null) serverInode = readFdInode(fd);
    }

    if (serverInode !== null) {
      pid = findClientPidByServerInode(rows, socketPath, serverInode);
    } else {
      // Caller didn't pass the socket. Use the legacy "first row wins"
      // lookup with the same warning the original code emitted.
      const clientPids = findClientPids(rows, socketPath);
      if (clientPids.length === 0) return null;
      if (clientPids.length > 1) {
        process.stderr.write(
          `[vault-broker] peercred: ${clientPids.length} connected peers found for ${socketPath}; ` +
            `using pid=${clientPids[0]}. ` +
            `Multiple simultaneous connections reduce identification accuracy. ` +
            `(This warning means identify() was called without a socket arg — likely a stale call site.)\n`,
        );
      }
      pid = clientPids[0];
    }
  }

  if (pid === null) return null;

  const uid = readUid(pid);
  if (uid === null) {
    // Process already exited or /proc entry missing — fail closed
    return null;
  }

  // Reject if the caller UID doesn't match the broker's own UID.
  const brokerUid = typeof process.getuid === "function" ? process.getuid() : null;
  if (brokerUid !== null && uid !== brokerUid) {
    process.stderr.write(
      `[vault-broker] peercred: UID mismatch — caller uid=${uid}, broker uid=${brokerUid}; denying\n`,
    );
    return null;
  }

  const exe = readExe(pid);
  if (exe === null) {
    // Process exited before we could read exe — fail closed
    return null;
  }

  // Read the alleged unit from cgroup, then cross-check with systemd.
  // /proc/<pid>/cgroup is attacker-controlled under user delegation; only
  // a unit systemd-user actually has loaded counts.
  const cgroupClaim = readSystemdUnit(pid);
  let systemdUnit: string | null = null;
  if (cgroupClaim !== null) {
    if (verifySystemdUnit(cgroupClaim, runner)) {
      systemdUnit = cgroupClaim;
    } else {
      process.stderr.write(
        `[vault-broker] peercred: cgroup claims unit=${cgroupClaim} but systemd-user does not report it as loaded+running; treating caller as unidentified\n`,
      );
    }
  }

  return { uid, pid, exe, systemdUnit };
}
