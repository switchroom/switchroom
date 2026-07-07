/**
 * switchroom-hostd identity derivation.
 *
 * Same path-as-identity contract as the vault broker
 * (`src/vault/broker/peercred.ts`): the agent name comes from the
 * socket bind path, never from a wire payload. The host-side
 * canonical path (where the daemon binds) is
 * `~/.switchroom/hostd/<agent>/sock`; the in-container view (where
 * agents connect) is `/run/switchroom/hostd/<agent>/sock`. They are
 * the same file by virtue of a per-agent bind mount the compose
 * generator emits.
 *
 * Identity is parsed from the **daemon's** bind path (host-side), so
 * an agent cannot forge identity by renaming its in-container view.
 */

import {
  parseSocketIdentity,
  type SocketIdentity as BrokerSocketIdentity,
} from "../broker-common/peercred-path.js";

/** Subdir form on the in-container view: `/run/switchroom/hostd/<agent>/sock`. */
const SOCKET_PATH_CONTAINER_SUBDIR_RE =
  /^\/run\/switchroom\/hostd\/([a-zA-Z0-9][a-zA-Z0-9_-]*)\/sock$/;

/**
 * Host-side form. Match the operator's home prefix dynamically; we
 * don't want to bake `/home/<user>/` into the regex. Anything ending
 * in `/.switchroom/hostd/<agent>/sock` qualifies. The daemon
 * additionally verifies (at bind time) that the path is inside the
 * operator's HOME — this regex is just the textual structure check.
 */
const SOCKET_PATH_HOST_SUBDIR_RE =
  /\/\.switchroom\/hostd\/([a-zA-Z0-9][a-zA-Z0-9_-]*)\/sock$/;

/**
 * Reserved names that look like agent names but are claimed by other
 * identity kinds. Mirrors `RESERVED_AGENT_NAMES` in the broker
 * (`src/vault/broker/peercred.ts:84`). Today:
 *   - `operator` — the host-shell operator socket
 *   - `hostd`    — the daemon's own broker client (so an agent named
 *                  "hostd" can't collide with the daemon's broker
 *                  client mount)
 *
 * If new identity kinds are added, extend this set.
 */
const RESERVED_AGENT_NAMES = new Set(["operator", "hostd"]);

export type SocketIdentity = BrokerSocketIdentity;

/**
 * Parse a bind-path or connect-path to an identity. Returns null
 * when the path matches no canonical shape — callers treat null as
 * "unidentified → DENIED".
 *
 * Two canonical agent shapes accepted:
 *   - container view: `/run/switchroom/hostd/<agent>/sock`
 *   - host view:      `*\/.switchroom/hostd/<agent>/sock`
 *
 * One operator shape (host view only — the operator never connects
 * via a per-agent in-container socket):
 *   - `*\/.switchroom/hostd/operator/sock`
 *
 * #2795: the parse+operator+reserved gate is the shared broker-plane
 * primitive (`src/broker-common/peercred-path.ts`); this call site supplies
 * only the hostd-specific patterns + reserved set. Semantics are identical
 * to the pre-#2795 inline implementation.
 */
export function socketPathToIdentity(
  socketPath: string,
): SocketIdentity | null {
  return parseSocketIdentity(socketPath, {
    patterns: [SOCKET_PATH_CONTAINER_SUBDIR_RE, SOCKET_PATH_HOST_SUBDIR_RE],
    reservedNames: RESERVED_AGENT_NAMES,
  });
}

/** True iff `name` is reserved by another identity kind and may not
 *  be used as an agent name. Surfaced for the agent-allocator /
 *  config validator to refuse such names at scaffold time. */
export function isReservedHostdAgentName(name: string): boolean {
  return RESERVED_AGENT_NAMES.has(name);
}
