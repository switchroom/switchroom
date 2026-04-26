/**
 * peercred — Linux peer-credential identification for Unix socket connections.
 *
 * On Linux, identifies the calling process by:
 *   1. Running `ss -xpn state connected src <socket-path>` to enumerate
 *      connected peers and parse the `users:(("name",pid=NNN,fd=NN))` column.
 *   2. Reading `/proc/<pid>/status` to get the caller's real UID.
 *   3. Reading `/proc/<pid>/exe` (symlink) to get the caller's executable path.
 *   4. Reading `/proc/<pid>/cgroup` to find the systemd unit name, which is
 *      used as the primary identity signal for ACL decisions.
 *
 * The cgroup identity (`systemdUnit`) is the authoritative identity for cron
 * scripts. systemd writes the cgroup as root when it starts the unit, and
 * processes cannot change their own cgroup from userspace — making it
 * unspoofable. The exe path is retained for the interactive-CLI fallback only.
 *
 * Limitation: when multiple clients are simultaneously connected to the same
 * socket, `ss` returns all of them. This implementation picks the first
 * connected entry — the server calls `identify()` immediately on accept,
 * before the next connection can appear, which makes the single-client
 * assumption hold in practice for cron scripts (each is a short-lived
 * one-shot process). If more than one entry appears, a WARN is emitted to
 * stderr.
 *
 * Security model:
 *   - Fail-closed: any parse error, missing /proc entry, or UID mismatch
 *     returns null (the caller should treat null as "unidentified" and deny).
 *   - On non-Linux platforms this module returns null immediately — the
 *     Unix socket's file mode 0600 is the sole access control in that case.
 *
 * This module is the single seam for OS-specific process identification.
 * Keep it small, pure, and independently testable.
 */

import { execFileSync, type ExecFileSyncOptions } from "node:child_process";
import { readFileSync, readlinkSync } from "node:fs";

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
    //   netid state recv-q send-q local-addr local-port peer-addr peer-port [users:(...)]
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
 * Identify the peer on the other end of a Unix domain socket connection.
 *
 * @param socketPath - Absolute path to the listening socket.
 * @param execFileSync_ - Injectable for testing (default: Node's execFileSync).
 * @returns PeerInfo or null (unidentified / non-Linux / error).
 */
export function identify(
  socketPath: string,
  execFileSyncOverride?: (
    file: string,
    args: readonly string[],
    opts: ExecFileSyncOptions,
  ) => Buffer | string,
): PeerInfo | null {
  if (process.platform !== "linux") {
    // macOS / other: degrade to UID-only (socket file mode 0600 is the guard)
    return null;
  }

  const runner = execFileSyncOverride ?? execFileSync;

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
  const clientPids = findClientPids(rows, socketPath);
  if (clientPids.length === 0) return null;

  if (clientPids.length > 1) {
    // Multiple simultaneous connections — warn but use the first.
    // This is documented as a known limitation.
    process.stderr.write(
      `[vault-broker] peercred: ${clientPids.length} connected peers found for ${socketPath}; ` +
        `using pid=${clientPids[0]}. Multiple simultaneous connections reduce identification accuracy.\n`,
    );
  }

  const pid = clientPids[0];

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

  const systemdUnit = readSystemdUnit(pid);

  return { uid, pid, exe, systemdUnit };
}
