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

/** Listener-bind regex. Accepts `<name>/sock` shape only — flat `<name>.sock` is rejected. */
const AUTH_BROKER_SOCKET_PATH_RE =
  /^\/run\/switchroom\/auth-broker\/([a-zA-Z0-9][a-zA-Z0-9_-]*)\/sock$/;

/** Reserved socket-path names that cannot be used as agent or consumer names. */
export const RESERVED_NAMES = new Set(["operator"]);

/** Bind-path → name. Returns null when the path matches no canonical shape. */
export function socketPathToName(socketPath: string): string | null {
  const m = AUTH_BROKER_SOCKET_PATH_RE.exec(socketPath);
  if (!m) return null;
  const name = m[1];
  // Validate name length and that it's a legal slug — defence in depth
  // against a path slipping past the regex check.
  if (name.length === 0 || name.length > 63) return null;
  return name;
}

/**
 * Classify a bind-path-derived name against the loaded auth config.
 * Returns the identity kind plus the resolved name. `null` when the
 * name is reserved (operator) but path didn't take the operator shape,
 * or when the name doesn't match any known agent/consumer.
 */
export interface AuthConfigShape {
  /** Agent names declared in switchroom.yaml `agents:`. */
  agents: readonly string[];
  /** Consumer names declared in `auth.consumers[]`. */
  consumers: readonly string[];
  /** Agent names declared in `auth.admin_agents[]` (subset of `agents`). */
  adminAgents: readonly string[];
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
 * collide with an agent name or an admin-agent entry. Enforces RFC §4.5
 * "Consumers cannot be admins; adding a consumer name to `admin_agents`
 * is a config error."
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
      errors.push(`consumer name '${c}' is listed in admin_agents (consumers cannot be admins)`);
    }
  }
  return errors;
}
