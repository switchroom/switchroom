/**
 * doctor-approval-attribution — WS10-F5 part 1 (#1420).
 *
 * Proactive, forensic detection of approval-attribution anomalies in the
 * approval kernel's `approval_decisions` table: an active grant whose
 * recorded `granted_by_user_id` (the operator who tapped [Approve]) is NOT
 * a member of the operator allowlist that authorized it.
 *
 * Why this lives in `doctor` and NOT as a live operator-event card wired
 * into the approval kernel (the "wire an event there" option the #1420
 * brief offered):
 *
 *   1. EMISSION IS UNREACHABLE FROM THE KERNEL. The operator-event card
 *      pipeline (classify → render → sendMessage) lives entirely in the
 *      telegram-plugin GATEWAY process (telegram-plugin/operator-events.ts
 *      + telegram-plugin/gateway/*.ts). The approval kernel is a separate
 *      daemon (src/vault/approvals/kernel-server.ts) with ZERO telegram /
 *      grammy imports — `grep -n "telegram\|grammy\|sendMessage"
 *      src/vault/approvals/kernel*.ts` returns nothing. The kernel cannot
 *      emit a card; only the gateway can.
 *
 *   2. THE GATEWAY ALREADY FAILS CLOSED AT TAP TIME. Every approval-tap
 *      handler in telegram-plugin/gateway/callback-query-handlers.ts gates
 *      on `access.allowFrom.includes(senderId)` BEFORE recording a decision
 *      (e.g. lines 498, 856, 949, 1109, …). So a non-allowlisted user
 *      literally cannot mint a grant through the normal path. A decision
 *      row whose granter is off the allowlist therefore did NOT come through
 *      that gate — it is a forensic signal of a bypass (direct DB write, a
 *      forged `origin='agent'` row, a compromised writer), exactly the kind
 *      of after-the-fact tamper evidence `doctor` exists to surface. A live
 *      card at grant time would be redundant with the existing gate; a
 *      standing forensic sweep is the meaningful, non-redundant control.
 *
 * The detection core (`detectAttributionAnomalies`) is a pure function over
 * decision rows + the operator allowlist — DI-testable, no I/O — mirroring
 * the doctor-audit-integrity / doctor-drive DI pattern.
 */

import { execFileSync } from "node:child_process";
import { readFileSync as fsReadFileSync } from "node:fs";
import { join } from "node:path";

import { canonicalizeApproverSet } from "../vault/approvals/canonical.js";
import { GRANTS_DB_CONTAINER_PATH } from "../vault/grants-db-path.js";

import type { CheckStatus } from "./doctor-status.js";

export interface CheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

/**
 * One approval_decisions row, reduced to the fields attribution detection
 * needs. Mirrors the columns in src/vault/approvals/schema.ts.
 */
export interface DecisionRow {
  id: string;
  /** Telegram user_id of the operator who tapped [Approve]. */
  granted_by_user_id: number;
  /** Canonicalized JSON array of the operator allowlist at grant time. */
  approver_set_canonical: string;
  /** Decision mode, e.g. "allow_always" / "allow_ttl" / "deny". */
  decision: string;
  /** Provenance: 'operator' (kernel-verified) or 'agent' (forgeable). */
  origin: string;
  /** Unix seconds; non-null ⇒ the grant was revoked (excluded from checks). */
  revoked_at: number | null;
}

/** Parse a canonicalized approver set back into a member list. */
function parseApproverSet(canonical: string): string[] {
  try {
    const arr = JSON.parse(canonical);
    return Array.isArray(arr) ? arr.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

/**
 * Pure detection core (WS10-F5 part 1). Flags every ACTIVE `allow*` grant
 * whose `granted_by_user_id` is not a member of the allowlist that
 * authorized it. Two allowlists are checked:
 *
 *   - the decision's OWN recorded `approver_set_canonical` (the set in
 *     force when it was granted) — a miss here is a hard tamper signal
 *     (`fail`): the row could not have come through the gateway's
 *     allowFrom gate.
 *   - the LIVE operator allowlist (`liveAllowFrom`, from access.allowFrom),
 *     when supplied — a miss here alone is a softer `warn`: the granter was
 *     valid at grant time but is no longer an operator (allowlist shrank).
 */
export function detectAttributionAnomalies(
  decisions: readonly DecisionRow[],
  liveAllowFrom?: readonly string[],
): CheckResult[] {
  const active = decisions.filter(
    (d) => d.revoked_at === null && d.decision.startsWith("allow"),
  );

  const liveSet =
    liveAllowFrom !== undefined
      ? new Set(parseApproverSet(canonicalizeApproverSet([...liveAllowFrom])))
      : undefined;

  const forged: DecisionRow[] = [];
  const staleGranter: DecisionRow[] = [];

  for (const d of active) {
    const granter = String(d.granted_by_user_id);
    const ownSet = new Set(parseApproverSet(d.approver_set_canonical));
    if (!ownSet.has(granter)) {
      forged.push(d);
      continue; // a self-set miss is the strongest signal — don't double-count
    }
    if (liveSet !== undefined && !liveSet.has(granter)) {
      staleGranter.push(d);
    }
  }

  const results: CheckResult[] = [];

  if (forged.length > 0) {
    const ids = forged.map((d) => `${d.id}(uid=${d.granted_by_user_id},origin=${d.origin})`).join(", ");
    results.push({
      name: "approval attribution: granter in own approver set",
      status: "fail",
      detail: `${forged.length} active grant(s) recorded a granted_by_user_id that is NOT in the decision's OWN approver_set_canonical — the gateway gates every tap on access.allowFrom, so these rows did not come through it (forged/bypass/direct-DB write; WS10-F5). Affected: ${ids}`,
      fix: `Treat these grants as unauthorized: revoke them, preserve vault-grants.db for forensics, and investigate how a decision was written bypassing the gateway's allowFrom gate.`,
    });
  } else {
    results.push({
      name: "approval attribution: granter in own approver set",
      status: "ok",
      detail: `every active grant's granted_by_user_id is a member of the approver set that authorized it`,
    });
  }

  if (staleGranter.length > 0) {
    const ids = staleGranter.map((d) => `${d.id}(uid=${d.granted_by_user_id})`).join(", ");
    results.push({
      name: "approval attribution: granter still on live allowlist",
      status: "warn",
      detail: `${staleGranter.length} active grant(s) were authorized by a user no longer on the live access.allowFrom — valid at grant time, but that operator has since been removed. Affected: ${ids}`,
      fix: `Review whether these standing grants should persist now that their granter is no longer an operator; revoke if the access should not outlive the operator.`,
    });
  }

  return results;
}

export interface ApprovalAttributionDeps {
  /**
   * Loads the approval_decisions rows to inspect. Defaults to
   * `defaultLoadDecisions` (host-file bun:sqlite read with docker-exec
   * fallback); injectable for tests. Return `null` to signal "could not
   * read" (→ skip).
   */
  loadDecisions?: () => Promise<DecisionRow[] | null> | DecisionRow[] | null;
  /**
   * Live operator allowlist for the stale-granter warn. The list lives in
   * the per-agent `telegram/access.json` files (`allowFrom`) — NOT in
   * switchroom.yaml — so the doctor call site derives it with
   * `loadLiveAllowFromAccessFiles`. Undefined skips the stale-granter check.
   */
  liveAllowFrom?: readonly string[];
}

const DECISIONS_SQL =
  "SELECT id, granted_by_user_id, approver_set_canonical, decision, origin, " +
  "COALESCE(revoked_at, -1) FROM approval_decisions;";

/** Parse `sqlite3 -separator <US>` output lines into DecisionRows. */
function parseSqlite3Lines(stdout: string, sep: string): DecisionRow[] {
  const rows: DecisionRow[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    const f = line.split(sep);
    if (f.length < 6) continue;
    const revoked = Number(f[5]);
    rows.push({
      id: f[0],
      granted_by_user_id: Number(f[1]),
      approver_set_canonical: f[2],
      decision: f[3],
      origin: f[4],
      revoked_at: revoked === -1 ? null : revoked,
    });
  }
  return rows;
}

/**
 * Default loader: read approval_decisions out of vault-grants.db.
 *
 * Primary path — HOST-SIDE bun:sqlite read of the canonical
 * `~/.switchroom/vault-broker/vault-grants.db` (grants-db-path.ts
 * `getGrantsDbPath()`): doctor runs on the host, and the broker container
 * bind-mounts that directory to `/root/.switchroom/vault-broker` (compose.ts),
 * so the host file IS the authoritative DB and needs neither docker nor a
 * sqlite3 binary. The built CLI runs under bun (scripts/build.mjs rewrites the
 * shebang to bun precisely because of `bun:sqlite`), so the dynamic import
 * resolves; under vitest/node the `typeof Bun` guard skips it.
 *
 * Fallback — `docker exec switchroom-vault-broker sqlite3` against the
 * IN-CONTAINER path `GRANTS_DB_CONTAINER_PATH`. Best-effort only:
 * requires sqlite3 in the broker image, and the container name assumes the
 * default compose project prefix ("switchroom-"); a custom prefix makes this
 * fallback miss and the check degrades to `skip`.
 *
 * Any failure on both paths returns `null` so the caller emits a `skip`,
 * never a false `fail`.
 */
async function defaultLoadDecisions(): Promise<DecisionRow[] | null> {
  // Path 1: direct host-file read via bun:sqlite (readonly).
  try {
    if (typeof Bun !== "undefined") {
      const fs = await import("node:fs");
      const { getGrantsDbPath } = await import("../vault/grants-db-path.js");
      const dbPath = getGrantsDbPath();
      if (fs.existsSync(dbPath)) {
        const { Database } = await import("bun:sqlite");
        const db = new Database(dbPath, { readonly: true });
        try {
          const raw = db
            .query(
              "SELECT id, granted_by_user_id, approver_set_canonical, decision, origin, revoked_at FROM approval_decisions",
            )
            .all() as Array<{
            id: string;
            granted_by_user_id: number;
            approver_set_canonical: string;
            decision: string;
            origin: string;
            revoked_at: number | null;
          }>;
          return raw.map((r) => ({
            id: String(r.id),
            granted_by_user_id: Number(r.granted_by_user_id),
            approver_set_canonical: String(r.approver_set_canonical),
            decision: String(r.decision),
            origin: String(r.origin),
            revoked_at: r.revoked_at === null ? null : Number(r.revoked_at),
          }));
        } finally {
          db.close();
        }
      }
    }
  } catch {
    // fall through to the docker-exec path
  }

  // Path 2: docker exec into the broker container (in-container mount path).
  try {
    const SEP = String.fromCharCode(31); // ASCII unit separator
    const stdout = execFileSync(
      "docker",
      [
        "exec",
        "switchroom-vault-broker",
        "sqlite3",
        // `-readonly` — doctor is a FOREIGN process against the broker's live
        // WAL `grants.db`. The CLI defaults to read-write, and a read-write
        // handle that closes as the last connection checkpoints and UNLINKS
        // the `-wal` / `-shm` sidecars (see #4595). DECISIONS_SQL is a SELECT.
        "-readonly",
        "-separator",
        SEP,
        GRANTS_DB_CONTAINER_PATH,
        DECISIONS_SQL,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 },
    );
    return parseSqlite3Lines(stdout, SEP);
  } catch {
    return null;
  }
}

/**
 * Derive the live operator allowlist for the stale-granter check by
 * unioning `allowFrom` across every agent's `telegram/access.json`
 * (`<agentsDir>/<agent>/telegram/access.json`). That file — not
 * switchroom.yaml — is where the gateway reads its tap-authorization list
 * (telegram-plugin/gateway/callback-query-handlers.ts `loadAccess`), so it
 * is the ground truth the detector must compare against.
 *
 * Returns `undefined` when NO access.json could be read (fresh install /
 * wrong dir) so the caller skips the stale-granter warn instead of
 * treating every granter as stale against an empty list.
 */
export function loadLiveAllowFromAccessFiles(
  agentNames: readonly string[],
  agentsDir: string,
  readFile: (p: string) => string = (p) => fsReadFileSync(p, "utf8"),
): string[] | undefined {
  const union = new Set<string>();
  let readAny = false;
  for (const name of agentNames) {
    try {
      const raw = readFile(join(agentsDir, name, "telegram", "access.json"));
      const parsed = JSON.parse(raw) as { allowFrom?: unknown };
      readAny = true;
      if (Array.isArray(parsed.allowFrom)) {
        for (const id of parsed.allowFrom) union.add(String(id));
      }
    } catch {
      // missing/unreadable access.json for this agent — skip it
    }
  }
  return readAny ? Array.from(union) : undefined;
}

/**
 * doctor entry point (WS10-F5 part 1). Loads the decisions and runs the pure
 * detector. Degrades to a single `skip` when the DB can't be read.
 */
export async function runApprovalAttributionChecks(
  deps: ApprovalAttributionDeps = {},
): Promise<CheckResult[]> {
  const load = deps.loadDecisions ?? defaultLoadDecisions;
  const decisions = await load();
  if (decisions === null) {
    return [
      {
        name: "approval attribution",
        status: "skip",
        detail:
          "could not read approval_decisions from ~/.switchroom/vault-grants.db (host read) or the vault-broker container (docker exec fallback) — attribution not evaluated",
      },
    ];
  }
  return detectAttributionAnomalies(decisions, deps.liveAllowFrom);
}
