/**
 * Deterministic per-agent container UID derivation.
 *
 * Extracted from compose.ts (which re-exports these symbols for its many
 * existing importers) so that scaffold.ts can derive the agent UID without
 * creating an import cycle: compose.ts already imports `resolveMainModel`
 * from scaffold.ts, so scaffold.ts must never import compose.ts back.
 *
 * scaffold.ts needs the UID for the reconcile ownership sweep
 * (agent-owned-tree.ts): reconcile runs as root on the hostd rollout path
 * (`switchroom agent restart` is spawned with root privileges — see
 * src/cli/rollout.ts) and every file it writes must end up owned by the
 * agent's container UID, or the agent cannot read its own settings.json.
 */

import { createHash } from "node:crypto";
import { isReservedAgentName } from "../vault/broker/peercred.js";

/** UID range reserved for agent containers. 999 slots — practical fleet limit. */
export const AGENT_UID_MIN = 10001;
export const AGENT_UID_MAX = 10999;

/**
 * Allocate a deterministic UID for an agent in [AGENT_UID_MIN, AGENT_UID_MAX].
 *
 * Algorithm: SHA-256 of the agent name, take the first 4 bytes as a
 * uint32, modulo the range size, plus the floor. This is collision-prone
 * by birthday-paradox at large fleets — `checkAgentUidUniqueness` in
 * doctor flags collisions and instructs the operator to rename one of
 * the colliders. With 50 agents the collision probability is ~0.12%; at
 * the canonical ~10-agent fleet it's negligible.
 *
 * Determinism: same name → same UID, always. This matters for
 * compose regeneration after an `add agent` so existing agents' UIDs
 * never shift (which would require a chown sweep over their state).
 */
export function allocateAgentUid(name: string): number {
  // Names reserved by other identity kinds (today: "operator", used for
  // the host-shell broker socket) cannot be used as agent names.
  // Refusing here at allocation rather than letting a same-named agent
  // silently collide with the operator socket — which would forge an
  // identity from the broker's POV.
  if (isReservedAgentName(name)) {
    throw new Error(
      `agent name '${name}' is reserved by switchroom for another identity kind ` +
      `(see vault/broker/peercred.ts:RESERVED_AGENT_NAMES). Pick a different name.`,
    );
  }
  const hash = createHash("sha256").update(name).digest();
  const u32 = hash.readUInt32BE(0);
  const range = AGENT_UID_MAX - AGENT_UID_MIN + 1;
  return AGENT_UID_MIN + (u32 % range);
}
