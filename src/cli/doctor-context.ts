/**
 * Context-headroom doctor probe (RFC reference/rfcs/context-headroom-surface.md).
 *
 * The gateway writes a per-agent `/state/agent/context-occupancy.json` snapshot
 * at each turn-end idle gate (telegram-plugin/gateway/context-occupancy.ts).
 * This probe reads it (via the injected reader — `docker exec … cat`, since the
 * agent state dir is 0700 agent-owned) and reports each agent's working-context
 * headroom, so the operator can see how close an agent is to a `/compact`.
 *
 * Pure renderer + injectable reader, mirroring doctor-mcp-secrets. Read-only;
 * a missing/stale/malformed snapshot reads as `skip` (not yet computed / agent
 * idle since boot), never a failure.
 */

import type { SwitchroomConfig } from "../config/schema.js";
import type { CheckStatus } from "./doctor-status.js";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

/** Snapshot shape written by the gateway (kept in sync with context-occupancy.ts). */
export interface ContextSnapshot {
  occupancy: number;
  cap: number | null;
  headroom: number | null;
  pct: number | null;
  state: "ok" | "tight" | "unknown";
  computedAt: number;
}

export type SnapshotRead =
  | { kind: "ok"; snapshot: ContextSnapshot }
  | { kind: "absent" } // agent down / no snapshot yet
  | { kind: "unreadable"; msg: string };

export interface ContextProbeDeps {
  /** Reads an agent's context snapshot. Injected; default = docker exec cat. */
  readSnapshot?: (agent: string) => Promise<SnapshotRead>;
}

function fmtK(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : `${n}`;
}

/** Pure: one agent's snapshot → a CheckResult row. */
export function contextRow(agent: string, read: SnapshotRead): CheckResult {
  const name = `context:${agent}`;
  if (read.kind === "absent") {
    return { name, status: "skip", detail: "no snapshot yet (agent idle since boot, or stopped)" };
  }
  if (read.kind === "unreadable") {
    return { name, status: "skip", detail: read.msg };
  }
  const s = read.snapshot;
  if (s.state === "unknown") {
    return { name, status: "skip", detail: "occupancy not yet measured" };
  }
  if (s.cap == null || s.pct == null) {
    // No cap configured — show occupancy, nothing to be tight against.
    return { name, status: "ok", detail: `${fmtK(s.occupancy)} tok (no cap — native compaction)` };
  }
  const pctLabel = `${Math.round(s.pct * 100)}%`;
  const detail = `${fmtK(s.occupancy)}/${fmtK(s.cap)} (${pctLabel})`;
  if (s.state === "tight") {
    return {
      name,
      status: "warn",
      detail: `${detail} — tight; a /compact is near`,
      fix: `Working context is ${pctLabel} of the cap. Normal if mid-large-task (it compacts automatically); if persistent, consider raising session.max_context_tokens or trimming this agent's tool/prose surface.`,
    };
  }
  return { name, status: "ok", detail };
}

/**
 * Read every agent's context snapshot and render a row each. Agents with no
 * snapshot (idle/stopped) skip cleanly.
 */
export async function runContextChecks(
  config: SwitchroomConfig,
  deps: ContextProbeDeps = {},
): Promise<CheckResult[]> {
  const agents = Object.keys(config.agents ?? {});
  if (agents.length === 0) return [];
  const read =
    deps.readSnapshot ??
    (async (): Promise<SnapshotRead> => ({ kind: "absent" }));
  const results = await Promise.all(
    agents.sort().map(async (a) => contextRow(a, await read(a))),
  );
  return results;
}
