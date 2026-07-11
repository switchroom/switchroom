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
 * 0644) — and, when that shared dir is not writable by the agent's uid, at the
 * FALLBACK `~/.switchroom/agents/<agent>/blocked-approval.json`. This reader
 * scans BOTH. It did not when the feature shipped (#3109), which meant a
 * fallback record was written to a file nobody ever read: the agent held, the
 * record on disk, and the dashboard printing "No agent is blocked". Do not drop
 * the fallback scan — see {@link FALLBACK_RECORD_NAME}.
 *
 * Two hard constraints on that contract, both learned the hard way:
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

/**
 * The FALLBACK record's filename, inside the agent's own state dir.
 *
 * `createBlockedApprovalStore` (telegram-plugin/gateway/approval-hold.ts) writes
 * the shared record first; when the shared dir is not writable by the agent's
 * uid (docker auto-created the bind source root-owned; a container predating the
 * volume) it falls back to `~/.switchroom/agents/<agent>/blocked-approval.json`,
 * which the scaffold chowns to the agent uid so the write always lands.
 *
 * This reader must scan BOTH, or the fallback is a record nobody reads — the
 * agent is held, the record is on disk, and the dashboard prints "No agent is
 * blocked". That is the reassuring lie this whole surface exists to kill, and it
 * shipped that way in #3109: the fallback wrote a DIFFERENT filename in a
 * DIFFERENT directory from the only one `readdirSync` looked at.
 *
 * It is readable. Verified live on the dev host, 2026-07-11:
 *   - `~/.switchroom/agents/<agent>/` is 0775 (drwxrwxr-x), agent-uid owned —
 *     traversable and listable by the web container's uid 1000.
 *   - `docker exec switchroom-web` reads a 0644 file in that dir fine, and gets
 *     "Permission denied" ONLY on the 0600 files (telegram/access.json). The
 *     0600 MODE is the blocker, never the directory — and the fallback record is
 *     written 0644 like the shared one.
 *   - The web compose binds all of `~/.switchroom` at `/host-home/.switchroom`
 *     with `HOME=/host-home`, so both locations resolve for this reader.
 */
export const FALLBACK_RECORD_NAME = "blocked-approval.json";

/**
 * Where the per-agent fallback records live: `~/.switchroom/agents`. Derived
 * from the shared dir (its sibling) so every existing caller — and every test
 * pointing at a tmpdir — picks the fallback scan up without changing its call.
 */
export function agentStateRoot(sharedDir: string): string {
  return resolve(sharedDir, "..", "agents");
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
 * The result of a read: the blocked agents PLUS how many records we could
 * not read at all.
 *
 * `unreadable` exists because "there is nothing there" and "I failed to
 * look" are different facts, and collapsing them is the worst bug this
 * surface can have. An EACCES on a 0600 record means an agent may well be
 * held right now; reporting that as an empty list makes the page print "No
 * agent is blocked", which is a positive claim the code has NOT verified.
 * That is the reassuring-lie failure the whole feature exists to kill, and
 * it is a live risk: the record producer is a separate change, and the
 * per-agent Telegram state files sitting next to these records are written
 * 0600 TODAY (the same way the Hermes `registry.db` bug happened).
 *
 * So: `unreadable > 0` means the surface must say "I could not read the
 * records; an agent may be held", never "nothing is blocked".
 */
export interface BlockedApprovalsRead {
  /** The records we could read and parse, longest-blocked first. */
  blocked: BlockedApproval[];
  /** How many records existed but could NOT be read (EACCES on a 0600 file,
   *  EISDIR, IO error), or 1 when the directory itself existed but could not
   *  be enumerated. 0 means every record present was read successfully — the
   *  only state in which an empty `blocked` honestly means "nothing is
   *  blocked". */
  unreadable: number;
}

/**
 * Read every `<agent>.json` in `dir`, returning the blocked agents AND the
 * count we failed to read. Never throws.
 *
 * Degrades per-file: one unreadable (0600) or malformed record never hides
 * the others. A read FAILURE is counted in `unreadable` rather than being
 * silently swallowed; a clean parse-miss (malformed JSON, missing required
 * fields) is a drop, because there we DID look and there was nothing usable.
 */
export function readBlockedApprovalsWithErrors(
  dir: string,
  /** Per-agent fallback root. Defaults to the shared dir's `agents` sibling. */
  agentsRoot: string = agentStateRoot(dir),
): BlockedApprovalsRead {
  const shared = readSharedRecords(dir);
  const fallback = readFallbackRecords(agentsRoot, new Set(shared.blocked.map((b) => b.agent)));

  return {
    // Longest-blocked first — the one that has been waiting on the operator
    // the longest is the one that most needs them.
    blocked: [...shared.blocked, ...fallback.blocked].sort(
      (a, b) => a.blockedSince - b.blockedSince,
    ),
    unreadable: shared.unreadable + fallback.unreadable,
  };
}

/** The shared, canonical surface: `<dir>/<agent>.json`. */
function readSharedRecords(dir: string): BlockedApprovalsRead {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch (err) {
    // ENOENT: the dir genuinely isn't there (the record producer hasn't
    // landed, or nothing has ever blocked). That is an honest empty.
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { blocked: [], unreadable: 0 };
    }
    // Anything else (EACCES on the dir, EIO): the dir EXISTS and we could
    // not look inside it. We do not know that nothing is blocked, and we
    // must not imply it. Count it as one unreadable record.
    return { blocked: [], unreadable: 1 };
  }

  const out: BlockedApproval[] = [];
  let unreadable = 0;

  for (const name of entries) {
    if (!name.endsWith(".json")) continue;

    // Read and parse are SEPARATE steps so the two failures stay
    // distinguishable: a read error means we couldn't look, a parse error
    // means we looked and found nothing usable.
    let text: string;
    try {
      text = readFileSync(join(dir, name), "utf-8");
    } catch {
      // EACCES (record written 0600 root/agent-owned — the trap), EISDIR, IO.
      // An agent may be held behind this file and we cannot see it. Count it.
      unreadable++;
      continue;
    }

    let record: BlockedApproval | null;
    try {
      record = coerce(JSON.parse(text) as unknown, name.slice(0, -".json".length));
    } catch {
      // Malformed JSON. We read it; there is nothing honest to render.
      continue;
    }
    if (record) out.push(record);
  }

  return { blocked: out, unreadable };
}

/**
 * The FALLBACK surface: `<agentsRoot>/<agent>/blocked-approval.json`, written
 * when the shared dir was not writable by the agent's uid.
 *
 * Skipped for any agent already carrying a shared record: the store unlinks its
 * fallback the moment a shared write succeeds, so a leftover is stale by
 * definition and must never double-report a block that is already surfaced.
 *
 * Enumeration failures here are counted honestly, on the same rule as the shared
 * dir: ENOENT is an honest empty (no agents scaffolded on this host), anything
 * else means we could not look and must not imply "nothing is blocked".
 */
function readFallbackRecords(
  agentsRoot: string,
  alreadySeen: ReadonlySet<string>,
): BlockedApprovalsRead {
  let agents: string[];
  try {
    agents = readdirSync(agentsRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { blocked: [], unreadable: 0 };
    }
    return { blocked: [], unreadable: 1 };
  }

  const out: BlockedApproval[] = [];
  let unreadable = 0;

  for (const agent of agents) {
    if (alreadySeen.has(agent)) continue;

    let text: string;
    try {
      text = readFileSync(join(agentsRoot, agent, FALLBACK_RECORD_NAME), "utf-8");
    } catch (err) {
      // ENOENT is the overwhelmingly normal case: this agent is not blocked, or
      // its record landed in the shared dir like it should. Only a real read
      // FAILURE (EACCES on a record written with the wrong mode, EIO) means an
      // agent may be held behind a file we cannot see.
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") unreadable++;
      continue;
    }

    let record: BlockedApproval | null;
    try {
      record = coerce(JSON.parse(text) as unknown, agent);
    } catch {
      continue; // malformed — we looked, there is nothing honest to render.
    }
    if (record) out.push(record);
  }

  return { blocked: out, unreadable };
}

/**
 * The blocked agents alone, longest-blocked first. ALWAYS an array — honest
 * empty `[]`, never null, never an object wrapper (the Hermes Desktop
 * adapter consumes `/api/blocked-approvals`; a shape surprise crashes that
 * client, so this endpoint's contract is a bare array and stays one).
 *
 * Read failures are NOT visible through this function. Anything that renders
 * an "all clear" to the operator must use {@link readBlockedApprovalsWithErrors}
 * and check `unreadable` first.
 */
export function readBlockedApprovals(
  dir: string,
  agentsRoot: string = agentStateRoot(dir),
): BlockedApproval[] {
  return readBlockedApprovalsWithErrors(dir, agentsRoot).blocked;
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

/**
 * Status handler for `GET /api/blocked-approvals/status` — the out-of-band
 * companion to the bare-array endpoint. The Approvals tab needs to know
 * whether a read FAILED (so it can warn instead of printing "nothing is
 * blocked"), and the bare-array contract has nowhere to carry that without
 * breaking Hermes. So it rides here instead of being synthesized as a fake
 * row in the array, which would defeat the field whitelist.
 */
export function handleGetBlockedApprovalsStatus(
  dir: string = blockedApprovalsDir(),
): { blocked: number; unreadable: number } {
  const { blocked, unreadable } = readBlockedApprovalsWithErrors(dir);
  return { blocked: blocked.length, unreadable };
}
