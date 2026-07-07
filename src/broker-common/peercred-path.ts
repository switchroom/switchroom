/**
 * Shared path-as-identity primitive for the switchroom broker plane (#2795).
 *
 * Three brokers derive the *identity* of a caller from the SERVER's own
 * bind path — never from a wire payload, never from the SO_PEERCRED UID
 * (UIDs collide; the bind path is what the broker controls):
 *
 *   - vault-broker        `/run/switchroom/broker/<agent>.sock` | `<agent>/sock`
 *   - auth-broker         `/run/switchroom/auth-broker/<name>/sock`
 *   - host-control (hostd) `/run/switchroom/hostd/<agent>/sock`
 *                          `*​/.switchroom/hostd/<agent>/sock` (host view)
 *
 * Before #2795 each broker carried its own copy of the *same* three-step
 * gate — (1) regex-match the path to a name, (2) map the reserved
 * `operator` name to `{kind:"operator"}`, (3) reject any other reserved
 * name, else `{kind:"agent"}`. Divergence between copies of an
 * authentication primitive is exactly the class of drift that produces a
 * silent authz bypass (issue #2795, audit items 4/5). This module is the
 * single seam for that gate. Each broker keeps ONLY its site-specific
 * declarative inputs — the anchored path patterns and the reserved-name
 * set — and delegates the security-load-bearing parse+gate here.
 *
 * SECURITY MODEL — fail-closed. `matchSocketName` / `parseSocketIdentity`
 * return null on ANY of: non-string / empty path, no pattern match, empty
 * captured name, over-length name, or a reserved (non-operator) name in an
 * agent slot. Every caller treats null as "unidentified → DENIED". The
 * operator name is the ONE reserved name that resolves to a non-null,
 * non-agent identity; it is matched BEFORE the reserved-name rejection so a
 * reserved set that (correctly) also contains "operator" cannot swallow it.
 */

/**
 * Identity of the listener that accepted a connection, derived purely from
 * the bind path. `{kind:"agent"}` carries the agent slug; `{kind:"operator"}`
 * is the host-shell operator socket (trust comes from the reserved bind path
 * plus the mode-0600 + chown-to-operator-UID the broker enforces at bind).
 */
export type SocketIdentity =
  | { kind: "agent"; name: string }
  | { kind: "operator" };

export interface PathIdentitySpec {
  /**
   * Anchored path patterns, tried in order. Each MUST have exactly one
   * capture group whose match is the raw name. First match wins.
   */
  patterns: readonly RegExp[];
  /**
   * Names that may NOT be used as an agent name. Should include the
   * operator name (defence in depth) — `parseSocketIdentity` resolves the
   * operator name to `{kind:"operator"}` before consulting this set, so
   * listing it here has no effect on the operator path but keeps the set an
   * honest "these names are claimed by another identity kind" declaration.
   */
  reservedNames: ReadonlySet<string>;
  /** The reserved name that maps to `{kind:"operator"}`. Default "operator". */
  operatorName?: string;
  /**
   * Optional maximum captured-name length (defence in depth beyond the
   * regex slug shape). When set, a longer name fails closed to null.
   */
  maxNameLen?: number;
}

/**
 * Low-level: bind path → raw captured name, or null.
 *
 * Returns the name VERBATIM, including reserved names such as "operator" —
 * it applies NO operator/reserved semantics. Callers that need the raw name
 * to classify it against external state (auth-broker's config-driven
 * agent/consumer/operator split) use this directly; callers that want a
 * ready `SocketIdentity` use {@link parseSocketIdentity}.
 *
 * Fail-closed: null on non-string / empty path, no pattern match, empty
 * capture, or (when `maxNameLen` is set) an over-length name.
 */
export function matchSocketName(
  socketPath: unknown,
  patterns: readonly RegExp[],
  maxNameLen?: number,
): string | null {
  if (typeof socketPath !== "string" || socketPath.length === 0) return null;
  let name: string | null = null;
  for (const re of patterns) {
    const m = socketPath.match(re);
    if (m && typeof m[1] === "string") {
      name = m[1];
      break;
    }
  }
  if (name === null || name.length === 0) return null;
  if (maxNameLen !== undefined && name.length > maxNameLen) return null;
  return name;
}

/**
 * Bind path → {@link SocketIdentity} or null.
 *
 * The operator name resolves to `{kind:"operator"}` and is checked BEFORE
 * the reserved-name rejection (so a reserved set that also contains the
 * operator name can't null it out). Any OTHER reserved name → null. Every
 * remaining match → `{kind:"agent", name}`.
 *
 * Fail-closed by inheritance from {@link matchSocketName}.
 */
export function parseSocketIdentity(
  socketPath: unknown,
  spec: PathIdentitySpec,
): SocketIdentity | null {
  const name = matchSocketName(socketPath, spec.patterns, spec.maxNameLen);
  if (name === null) return null;
  const operatorName = spec.operatorName ?? "operator";
  if (name === operatorName) return { kind: "operator" };
  if (spec.reservedNames.has(name)) return null;
  return { kind: "agent", name };
}
