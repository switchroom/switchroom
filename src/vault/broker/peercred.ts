/**
 * peercred — Linux peer-credential identification for Unix socket connections.
 *
 * On Linux, identifies the calling process by:
 *   1. Running `ss -xpn state connected src <socket-path>` to enumerate
 *      connected peers and parse the `users:(("name",pid=NNN,fd=NN))` column.
 *   2. Reading `/proc/<pid>/status` to get the caller's real UID.
 *   3. Reading `/proc/<pid>/exe` (symlink) to get the caller's executable path.
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
}

/**
 * Parse `users:(("name",pid=NNN,fd=NN))` columns from `ss` output.
 * Returns an array of { pid } objects for all connected clients found.
 * Empty array if none found or parse failed.
 */
function parseSsOutput(output: string): Array<{ pid: number }> {
  // Each line from `ss -xpn state connected src <path>` looks like:
  //   u_str ESTAB 0 0 /path/to.sock 12345 * 0 users:(("prog",pid=9876,fd=5))
  // The users column may be absent if the process exited before ss ran.
  const results: Array<{ pid: number }> = [];
  const lines = output.split("\n");
  for (const line of lines) {
    // Match users:((...,pid=NNN,...))
    const m = line.match(/users:\(\(".*?",pid=(\d+),fd=\d+\)\)/);
    if (m) {
      results.push({ pid: parseInt(m[1], 10) });
    }
  }
  return results;
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
    const raw = runner("ss", ["-xpn", "state", "connected", "src", socketPath], {
      timeout: 200,
      encoding: "utf8",
    });
    ssOutput = typeof raw === "string" ? raw : raw.toString("utf8");
  } catch {
    // ss not available or timed out — fail closed
    return null;
  }

  const peers = parseSsOutput(ssOutput);
  if (peers.length === 0) return null;

  if (peers.length > 1) {
    // Multiple simultaneous connections — warn but use the first.
    // This is documented as a known limitation.
    process.stderr.write(
      `[vault-broker] peercred: ${peers.length} connected peers found for ${socketPath}; ` +
        `using pid=${peers[0].pid}. Multiple simultaneous connections reduce identification accuracy.\n`,
    );
  }

  const { pid } = peers[0];

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

  return { uid, pid, exe };
}
