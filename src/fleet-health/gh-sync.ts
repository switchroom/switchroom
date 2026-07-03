/**
 * Fleet Health — GitHub issue lifecycle. Design:
 * `reference/rfcs/fleet-health.md` ("GitHub issue lifecycle").
 *
 * GitHub issues are the identify+resolve system-of-record. For each distinct
 * problem (dedup_key) the sensor: opens an issue if none exists, updates the
 * occurrence list + count if it does, and closes it on a verified count-drop.
 * The ledger stores the issue NUMBER back; GitHub is durable, the ledger is the
 * fast rankable index.
 *
 * This shells out to `gh` (authed in the owner-agent container). It is guarded
 * behind `--sync-issues` at the CLI so tests/CI never hit the network. If `gh`
 * is unavailable it no-ops with a clear log line — the scan still writes the
 * ledger.
 */

import { spawnSync } from "node:child_process";
import type {
  FleetHealthLedger,
  FleetHealthIssue,
  FleetHealthRecord,
} from "../web/fleet-health-read.js";

const LABEL = "fleet-health";

export interface GhSyncDeps {
  /** Runs a `gh` invocation; returns {ok, stdout}. Injectable for tests. */
  run: (args: string[]) => { ok: boolean; stdout: string; stderr: string };
  log: (msg: string) => void;
}

export function defaultGhDeps(log: (m: string) => void): GhSyncDeps {
  return {
    log,
    run: (args) => {
      const r = spawnSync("gh", args, { encoding: "utf-8" });
      return {
        ok: r.status === 0,
        stdout: (r.stdout ?? "").trim(),
        stderr: (r.stderr ?? "").trim(),
      };
    },
  };
}

/** True iff `gh` is present and authenticated. */
export function ghAvailable(deps: GhSyncDeps): boolean {
  const r = deps.run(["auth", "status"]);
  return r.ok;
}

function severityLabel(sev: number): string {
  const s = Math.max(1, Math.min(3, Math.round(sev)));
  return `severity:${s}`;
}

function issueTitle(iss: FleetHealthIssue, job_spec: string): string {
  return `[fleet-health] ${job_spec}: ${iss.failure_mode} (${iss.dedup_key})`;
}

function issueBody(iss: FleetHealthIssue, job_spec: string): string {
  const lines: string[] = [];
  lines.push(`**Job spec:** \`${job_spec}\` (\`reference/jobs/${job_spec}.md\`)`);
  lines.push(`**Failure mode:** ${iss.failure_mode} — severity ${iss.severity}`);
  lines.push(`**Dedup key:** \`${iss.dedup_key}\``);
  lines.push(`**Frequency (scan window):** ${iss.frequency}`);
  lines.push(`**Reach:** ${iss.reach.join(", ") || "—"}`);
  lines.push(`**Newest occurrence:** ${iss.recency ?? "—"}`);
  lines.push("");
  lines.push("**Occurrences (hard-artifact evidence):**");
  for (const o of iss.occurrences.slice(0, 25)) {
    lines.push(`- \`${o.agent}\` turn \`${o.turn_id}\` — ${o.log_pointer ?? ""}`);
  }
  lines.push("");
  lines.push(
    "_Opened + maintained by the Fleet Health sensor " +
      "(`switchroom fleet-health scan --sync-issues`). Closes automatically on " +
      "a verified count-drop. See `reference/rfcs/fleet-health.md`._",
  );
  return lines.join("\n");
}

/**
 * Sync one issue to GitHub. Returns the (possibly new) issue number, or the
 * existing one. Mutates `iss.gh_issue` and `iss.status`.
 */
function syncIssue(
  deps: GhSyncDeps,
  repo: string,
  job_spec: string,
  iss: FleetHealthIssue,
): void {
  const labels = [LABEL, severityLabel(iss.severity), `job:${job_spec}`];
  const title = issueTitle(iss, job_spec);
  const body = issueBody(iss, job_spec);

  const shouldClose =
    iss.status === "closed" || iss.status === "resolved-pending-verify";

  if (iss.gh_issue === undefined) {
    if (shouldClose) return; // nothing to do — no issue and already resolved.
    // Open a new issue.
    const r = deps.run([
      "issue",
      "create",
      "-R",
      repo,
      "--title",
      title,
      "--body",
      body,
      "--label",
      labels.join(","),
    ]);
    if (r.ok) {
      const m = r.stdout.match(/\/issues\/(\d+)/);
      if (m) {
        iss.gh_issue = Number(m[1]);
        deps.log(`fleet-health: opened GH #${iss.gh_issue} for ${iss.dedup_key}`);
      }
    } else {
      deps.log(`fleet-health: gh issue create failed for ${iss.dedup_key}: ${r.stderr}`);
    }
    return;
  }

  // Existing issue: update the body (refreshes occurrence list + count).
  const num = String(iss.gh_issue);
  const upd = deps.run(["issue", "edit", num, "-R", repo, "--body", body]);
  if (!upd.ok) {
    deps.log(`fleet-health: gh issue edit #${num} failed: ${upd.stderr}`);
  }

  if (iss.status === "closed") {
    const c = deps.run([
      "issue",
      "close",
      num,
      "-R",
      repo,
      "--comment",
      `Verified count-drop (frequency ${iss.frequency} ≤ resolved threshold). Closed by the Fleet Health sensor.`,
    ]);
    if (c.ok) deps.log(`fleet-health: closed GH #${num} (count-drop) for ${iss.dedup_key}`);
    else deps.log(`fleet-health: gh issue close #${num} failed: ${c.stderr}`);
  }
}

/**
 * Sync every issue in the ledger to GitHub. No-ops (with a clear log line) if
 * `gh` is unavailable — the scan already wrote the ledger. Mutates the ledger
 * records in place (fills gh_issue numbers), so the caller re-writes the ledger
 * afterward to persist them.
 */
export function syncLedgerIssues(
  ledger: FleetHealthLedger,
  repo: string,
  deps: GhSyncDeps,
): { synced: number; skipped: boolean } {
  if (!ghAvailable(deps)) {
    deps.log(
      "fleet-health: gh unavailable or not authenticated — skipping GitHub issue sync (ledger still written).",
    );
    return { synced: 0, skipped: true };
  }
  let synced = 0;
  for (const rec of ledger.records as FleetHealthRecord[]) {
    for (const iss of rec.issues) {
      syncIssue(deps, repo, rec.job_spec, iss);
      synced++;
    }
    // Refresh the record's rolled-up gh_issues after sync.
    rec.gh_issues = rec.issues
      .map((i) => i.gh_issue)
      .filter((n): n is number => typeof n === "number");
  }
  return { synced, skipped: false };
}
