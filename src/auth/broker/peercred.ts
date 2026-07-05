/**
 * Path-as-identity for auth-broker — mirrors the vault-broker pattern at
 * `src/vault/broker/peercred.ts`.
 *
 * Three canonical socket-path shapes (RFC H §4.2):
 *
 *   (a) /run/switchroom/auth-broker/<agent>/sock     — per-agent socket
 *   (b) /run/switchroom/auth-broker/<consumer>/sock  — per-consumer (hindsight et al.)
 *   (c) /run/switchroom/auth-broker/operator/sock    — host-shell operator socket
 *
 * Agent vs consumer is resolved by config lookup (`auth.consumers[].name`),
 * not by path. The path alone yields `{kind: 'named', name}`; the server
 * classifies into `{kind: 'agent' | 'consumer' | 'operator'}` after
 * consulting the loaded config. This keeps the identity-from-path step
 * pure and testable.
 *
 * SO_PEERCRED is captured (when available) for audit attribution only.
 * Authorization gates on path-identity + config classification — never
 * on peer UID, because UIDs collide and the bind-path is what we control.
 */

import { matchSocketName } from "../../broker-common/peercred-path.js";

/** Listener-bind regex. Accepts `<name>/sock` shape only — flat `<name>.sock` is rejected. */
const AUTH_BROKER_SOCKET_PATH_RE =
  /^\/run\/switchroom\/auth-broker\/([a-zA-Z0-9][a-zA-Z0-9_-]*)\/sock$/;

/** Max slug length — defence in depth beyond the regex slug shape. */
const AUTH_BROKER_MAX_NAME_LEN = 63;

/** Reserved socket-path names that cannot be used as agent or consumer names. */
export const RESERVED_NAMES = new Set(["operator"]);

/**
 * Bind-path → name (raw, including the reserved `operator` name — the
 * kind split happens in `classify` against the loaded config). Returns null
 * when the path matches no canonical shape or the name exceeds the length
 * guard.
 *
 * #2795: the match+length-guard is the shared broker-plane primitive
 * (`src/broker-common/peercred-path.ts` `matchSocketName`); this call site
 * supplies only the auth-broker pattern + length cap. Semantics are
 * identical to the pre-#2795 inline implementation.
 */
export function socketPathToName(socketPath: string): string | null {
  return matchSocketName(
    socketPath,
    [AUTH_BROKER_SOCKET_PATH_RE],
    AUTH_BROKER_MAX_NAME_LEN,
  );
}

/**
 * Classify a bind-path-derived name against the loaded auth config.
 * Returns the identity kind plus the resolved name. `null` when the
 * name is reserved (operator) but path didn't take the operator shape,
 * or when the name doesn't match any known agent/consumer.
 *
 * Admin authority is sourced from the per-agent `agents.<name>.admin`
 * field — the canonical "this agent has fleet admin powers" flag
 * established by PR #1258 (foreman retirement). The auth-broker
 * shares this source of truth so an operator setting up an admin
 * agent has one knob to flip, not two.
 */
export interface AuthConfigShape {
  /** Agent names declared in switchroom.yaml `agents:`. */
  agents: readonly string[];
  /** Subset of `agents` whose `agents.<name>.admin` field is true. */
  adminAgents: readonly string[];
  /** Consumer names declared in `auth.consumers[]`. */
  consumers: readonly string[];
}

export type Identity =
  | { kind: "agent"; name: string; admin: boolean }
  | { kind: "consumer"; name: string }
  | { kind: "operator" };

export function classify(
  socketPath: string,
  config: AuthConfigShape,
): Identity | null {
  const name = socketPathToName(socketPath);
  if (!name) return null;
  if (name === "operator") return { kind: "operator" };
  if (RESERVED_NAMES.has(name)) return null;
  if (config.consumers.includes(name)) return { kind: "consumer", name };
  if (config.agents.includes(name)) {
    return {
      kind: "agent",
      name,
      admin: config.adminAgents.includes(name),
    };
  }
  return null;
}

/**
 * Same-name check used by schema validation: a consumer name cannot
 * collide with an agent name or be listed as an admin agent.
 *
 * Post-RFC-H + PR #1258 unification: admin is sourced from each agent's
 * own `admin: true` flag. A consumer name collides with an agent name
 * iff it appears in `config.agents` — separately checking the admin
 * subset is defence in depth (a consumer can't have an agent admin
 * setting, so the path-identity gate already prevents it, but we
 * surface the error early at schema-validation time).
 */
export function validateConsumerNames(config: AuthConfigShape): string[] {
  const errors: string[] = [];
  for (const c of config.consumers) {
    if (RESERVED_NAMES.has(c)) {
      errors.push(`consumer name '${c}' is reserved`);
    }
    if (config.agents.includes(c)) {
      errors.push(`consumer name '${c}' collides with an agent name`);
    }
    if (config.adminAgents.includes(c)) {
      errors.push(`consumer name '${c}' is an admin agent (consumers cannot be admins)`);
    }
  }
  return errors;
}
