import { readFileSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

/**
 * Blocked approvals — the Telegram-independent view of an agent stuck on an
 * approval it cannot deliver.
 *
 * Serves the job spec `reference/jobs/approve-what-my-agent-can-touch.md`
 * (outcome `hold-the-leash`).
 *
 * Why this exists: on 2026-07-11 the `overlord` bot took a 4.6h Telegram
 * flood ban (#3084). A permission prompt fired during it, the approval card
 * could not be sent, and the operator had no idea — the agent sat blocked for
 * 50 minutes and was only found by someone going looking. The agent now HOLDS
 * (never auto-approves, never auto-denies), which is correct but useless if a
 * held agent is invisible. So the block has to be visible on a surface that
 * does NOT depend on Telegram: this reader, the `/api/blocked-approvals`
 * route, and the dashboard.
 *
 * The record is written by the gateway on each blocked approval, one file per
 * agent, at `~/.switchroom/blocked-approvals/<agent>.json` (dir 0755, files
 * 0644). Two hard constraints on that contract, both learned the hard way:
 *
 *  1. **The web container runs as uid 1000 and cannot read the agent's own
 *     0600 state.** `~/.switchroom/agents/<agent>/telegram/*.json` is mode
 *     0600, root/agent-owned; `docker exec switchroom-web cat` on it returns
 *     "Permission denied". A dashboard built on those files renders a silently
 *     empty page (the same bug as Hermes' 0600 `registry.db` → empty history
 *     tab). Hence a SHARED, world-readable record in a shared dir — the same
 *     posture as `~/.switchroom/fleet-health/ledger.json` (0644 in a 0755
 *     dir), which the web container demonstrably reads today.
 *  2. **Metadata only.** The record NEVER carries raw tool input. This reader
 *     hard-whitelists the fields below and drops everything else, so an
 *     unexpected field on disk can never reach the render side.
 *
 * Everything degrades to an honest empty list: absent dir (record producer
 * not deployed yet), unreadable file (wrong mode), malformed JSON, or a
 * record missing its required fields. Never throws, never renders a lie.
 */

/** One agent held on an approval that could not be delivered. Metadata only —
 *  never the tool's input. Extra on-disk fields are untrusted and dropped. */
export interface BlockedApproval {
  /** The held agent. */
  agent: string;
  /** The approval request id — the join key to the gateway log. */
  requestId: string;
  /** The tool the agent is asking to use (e.g. "Bash"). */
  toolName: string;
  /** Short human text: what it wants to do. Not the raw tool input. */
  action: string;
  /** Unix ms — when the agent started waiting on this approval. */
  blockedSince: number;
  /** Unix ms — when delivery to Telegram started failing. null if unknown. */
  undeliverableSince: number | null;
  /** Unix ms — earliest the gateway may retry delivery (e.g. the flood-wait
   *  expiry). null when the producer can't say. */
  retryableAt: number | null;
  /** Why it could not be delivered, e.g. "flood_wait". */
  reason: string;
}

/**
 * Resolve the record directory. `~/.switchroom/blocked-approvals` by default;
 * the `home` arg (or `SWITCHROOM_HOME` / `HOME`) is injectable so tests point
 * at a tmpdir and never touch the operator's live tree. Same idiom as
 * `fleetHealthLedgerPath()`. In the web container `HOME=/host-home`, which the
 * compose file binds to the operator's home — so this resolves to the same
 * host path the gateway writes.
 */
export function blockedApprovalsDir(
  home: string = process.env.SWITCHROOM_HOME ?? process.env.HOME ?? homedir(),
): string {
  return resolve(home, ".switchroom", "blocked-approvals");
}

/** A finite number or null — a malformed timestamp must never reach the UI as
 *  NaN/Infinity/string (that renders "blocked NaNm", a lie). */
function finiteOrNull(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Non-empty string or null. */
function stringOrNull(v: unknown): string | null {
  return typeof v === "string" && v.trim().length > 0 ? v : null;
}

/**
 * Coerce one on-disk record into the typed shape, hard-whitelisting fields.
 * Returns null when a REQUIRED field is missing or unusable — a record we
 * can't honestly describe is dropped rather than half-rendered. `agent` falls
 * back to the filename stem so a record that lost its own name still surfaces
 * (an agent held and invisible is the exact failure this module exists to
 * prevent; better to name it from the file than to drop it).
 */
function coerce(raw: unknown, fallbackAgent: string): BlockedApproval | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;

  const agent = stringOrNull(r.agent) ?? fallbackAgent;
  const blockedSince = finiteOrNull(r.blockedSince);
  // Without an agent and a start time there is nothing honest to say.
  if (!agent || blockedSince === null) return null;

  return {
    agent,
    requestId: stringOrNull(r.requestId) ?? "unknown",
    toolName: stringOrNull(r.toolName) ?? "unknown",
    action: stringOrNull(r.action) ?? "",
    blockedSince,
    undeliverableSince: finiteOrNull(r.undeliverableSince),
    retryableAt: finiteOrNull(r.retryableAt),
    reason: stringOrNull(r.reason) ?? "unknown",
  };
}

/**
 * Read every `<agent>.json` in `dir` and return the blocked agents,
 * longest-blocked first (worst-first, same posture as the fleet-health
 * ranking). ALWAYS an array — honest empty `[]`, never null, never an
 * object wrapper (the Hermes Desktop adapter consumes this API; a shape
 * surprise crashes that client).
 *
 * Degrades per-file: one unreadable (0600) or malformed record never hides
 * the others, and no failure escapes as a throw.
 */
export function readBlockedApprovals(dir: string): BlockedApproval[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    // Dir absent (record producer not deployed yet) or unreadable → nothing
    // is known to be blocked. Honest empty, not an error page.
    return [];
  }

  const out: BlockedApproval[] = [];
  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    let record: BlockedApproval | null;
    try {
      const raw = JSON.parse(readFileSync(join(dir, name), "utf-8")) as unknown;
      record = coerce(raw, name.slice(0, -".json".length));
    } catch {
      // Malformed JSON, or EACCES on a wrongly-moded file. Skip this record;
      // the others still render.
      continue;
    }
    if (record) out.push(record);
  }

  // Longest-blocked first — the one that has been waiting on the operator
  // the longest is the one that most needs them.
  return out.sort((a, b) => a.blockedSince - b.blockedSince);
}

/**
 * How long the agent has been held, as short human text: "35s", "47m",
 * "2h 13m", "3d 4h". Pure; `now` is injected so it's testable. A future
 * `blockedSince` (clock skew) clamps to 0 rather than emitting "-3m".
 * Used for the Summary attention row ("overlord — blocked 47m") and the
 * Approvals table, so both read identically.
 */
export function formatBlockedFor(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  if (t < 60) return `${t}s`;
  const m = Math.floor(t / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return h > 0 && m % 60 > 0 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 > 0 ? `${d}d ${h % 24}h` : `${d}d`;
}

/**
 * Route handler — resolves the default record dir and reads it. `dir` is
 * injectable for tests. Read-only: no model call, no host mutation, no
 * network (mirrors handleGetFleetHealth).
 */
export function handleGetBlockedApprovals(
  dir: string = blockedApprovalsDir(),
): BlockedApproval[] {
  return readBlockedApprovals(dir);
}
