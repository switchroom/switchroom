/**
 * Blast-radius classifier for an applied config edit: which running agents
 * must restart for the change to take effect.
 *
 * Why: claude loads its config (tools, MCP servers, settings) at boot, so a
 * `config_propose_edit` that's written + reconciled is INERT in the running
 * agents until they restart. The finalize card uses this to tell the operator
 * EXACTLY which agents to bounce (and offer a one-tap restart) instead of the
 * change silently not taking effect.
 *
 * Mapping:
 *   - a change under `agents.<X>.*` (or adding/removing `agents.<X>`) → agent X
 *   - a change to `defaults.*`, `profiles.*`, or ANY other top-level key
 *     (telegram, vault, mcp_servers, hostd, …) is inherited/shared → FLEET-WIDE
 *
 * Fails SAFE: an unrecognized or ambiguous change classifies as fleet-wide
 * (over-inclusive — the operator is told "everything", never silently told
 * "fewer agents than actually affected"). The fleet-wide case is surfaced as
 * guidance to run a full rollout, never an auto-bounce of the whole fleet.
 */

import { parse } from "yaml";

export interface BlastRadius {
  /** Specific agents whose own config changed (empty when fleetWide). */
  agents: string[];
  /** True when a shared/inherited key changed → all agents affected. */
  fleetWide: boolean;
  /** Dotted paths that differ before→after (for logging / the card detail). */
  changedPaths: string[];
}

function toObject(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

/**
 * Collect leaf-level dotted paths that differ between two parsed configs.
 * A changed/added/removed scalar, array, or sub-object is reported at the
 * shallowest path where they diverge.
 */
export function changedConfigPaths(
  before: unknown,
  after: unknown,
  prefix = "",
): string[] {
  if (deepEqual(before, after)) return [];
  const bObj = before && typeof before === "object" && !Array.isArray(before);
  const aObj = after && typeof after === "object" && !Array.isArray(after);
  // Both objects → recurse into the union of keys.
  if (bObj && aObj) {
    const keys = new Set([
      ...Object.keys(before as Record<string, unknown>),
      ...Object.keys(after as Record<string, unknown>),
    ]);
    const out: string[] = [];
    for (const k of keys) {
      out.push(
        ...changedConfigPaths(
          (before as Record<string, unknown>)[k],
          (after as Record<string, unknown>)[k],
          prefix ? `${prefix}.${k}` : k,
        ),
      );
    }
    return out;
  }
  // Leaf (scalar / array / type-mismatch) that differs.
  return [prefix || "<root>"];
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === "object") {
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      return a.every((x, i) => deepEqual(x, b[i]));
    }
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(ao), ...Object.keys(bo)]);
    for (const k of keys) if (!deepEqual(ao[k], bo[k])) return false;
    return true;
  }
  return false;
}

/**
 * Classify which agents a before→after config change affects. Accepts the
 * raw YAML strings (parses internally); a parse failure on EITHER side
 * fails safe to fleet-wide.
 */
export function classifyBlastRadius(beforeYaml: string, afterYaml: string): BlastRadius {
  let before: Record<string, unknown>;
  let after: Record<string, unknown>;
  try {
    before = toObject(parse(beforeYaml));
    after = toObject(parse(afterYaml));
  } catch {
    return { agents: [], fleetWide: true, changedPaths: ["<unparseable>"] };
  }

  const changedPaths = changedConfigPaths(before, after).sort();
  if (changedPaths.length === 0) {
    return { agents: [], fleetWide: false, changedPaths: [] };
  }

  const agents = new Set<string>();
  let fleetWide = false;
  for (const path of changedPaths) {
    if (path === "<root>") {
      fleetWide = true;
      continue;
    }
    const segs = path.split(".");
    if (segs[0] === "agents" && segs.length >= 2) {
      // agents.<X> or agents.<X>.<...> → that agent
      agents.add(segs[1]!);
    } else {
      // defaults.*, profiles.*, telegram.*, vault.*, mcp_servers.*, hostd.*, …
      // → inherited/shared → fleet-wide.
      fleetWide = true;
    }
  }

  return {
    agents: fleetWide ? [] : [...agents].sort(),
    fleetWide,
    changedPaths,
  };
}
