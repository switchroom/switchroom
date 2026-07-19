/**
 * `switchroom doctor --fix` — auto-remediation for rev5 `.session-model`
 * carrier drift (#3427 item 1, follow-up to #3424).
 *
 * #3424 shipped DETECTION (`checkStartShSessionModelCarrier`): a start.sh that
 * predates the rev5 consume-once `.session-model` JSON carrier silently boots
 * the yaml pin on every Telegram `/model` switch while the logs look
 * successful. Healing previously required the operator to notice the doctor
 * FAIL, run a manual `switchroom apply`, and restart the agent — so a drifted
 * fleet could stay drifted unattended. This module closes that gap: for every
 * agent whose carrier check fails, regenerate start.sh from the CURRENT
 * template via the standard per-agent reconcile (the same code path
 * `switchroom apply` uses — `reconcileAgent` re-renders start.sh from
 * profiles/_base/start.sh.hbs), then re-run the check to prove the heal.
 *
 * Why reconcile rather than an in-container boot-time self-heal: start.sh is
 * purely template-driven ("no user-merged sections", scaffold.ts — safe to
 * overwrite in full), but the template tree (`profiles/_base/`) is NOT shipped
 * into the agent image (see ReconcileOptions.skipProfileTemplates), so an
 * agent cannot regenerate its own start.sh at boot. The host-side doctor is
 * the earliest place both the drift signal and the template exist together.
 *
 * Determinism + idempotency: healthy agents are never reconciled (the check
 * gates the write), and `reconcileAgent` itself only writes start.sh when the
 * rendered content differs. Running `doctor --fix` twice is a no-op the second
 * time. `preserveClaudeMd: true` keeps the fix scoped — CLAUDE.md regeneration
 * is `switchroom apply`'s business, not a carrier fix's.
 *
 * The regenerated start.sh takes effect on the agent's NEXT restart (same
 * semantics as apply); the result row says so.
 */

import { join } from "node:path";

import { resolveAgentsDir } from "../config/loader.js";
import type { SwitchroomConfig } from "../config/schema.js";
import type { CheckStatus } from "./doctor-status.js";

/** Structural copy of doctor.ts's CheckResult (avoids a doctor.ts import cycle). */
export interface FixCheckResult {
  name: string;
  status: CheckStatus;
  detail?: string;
  fix?: string;
}

/**
 * Injected seams so the drift→heal→re-check pipeline is testable with the
 * real `reconcileAgent` (integration) or a stub (unit), and so this module
 * never imports doctor.ts (which imports it).
 */
export interface SessionModelCarrierFixDeps {
  /** The #3424 tripwire — checkStartShSessionModelCarrier from doctor.ts. */
  check: (agentName: string, startShPath: string) => FixCheckResult;
  /**
   * Regenerate the agent's switchroom-managed files from the current
   * templates — reconcileAgent(name, …, { preserveClaudeMd: true }). NB this
   * is the FULL per-agent reconcile (start.sh, .mcp.json, settings.json,
   * plugins, skills — everything `switchroom apply` manages for that agent
   * except CLAUDE.md), not a start.sh-only rewrite; the returned `changes`
   * (every file the reconcile actually rewrote) are disclosed verbatim in
   * the result row so an operator with staged switchroom.yaml edits sees
   * exactly what was applied (#3437 review M1). Throws on failure.
   */
  reconcile: (agentName: string) => { changes: string[] };
}


/**
 * Honest disclosure of what the heal's FULL reconcile actually rewrote
 * (#3437 review M1): the fix regenerates every switchroom-managed file for
 * the agent, not just start.sh, and any staged switchroom.yaml edits land
 * with it — so the row must name the files, not claim a start.sh-only write.
 */
function describeReconcileChanges(changes: string[]): string {
  if (changes.length === 0) return "Reconcile rewrote no other files.";
  const MAX_LISTED = 6;
  const listed = changes.slice(0, MAX_LISTED).join(", ");
  const more = changes.length > MAX_LISTED ? ` (+${changes.length - MAX_LISTED} more)` : "";
  return (
    `Full per-agent reconcile applied — rewrote ${changes.length} managed file(s): ` +
    listed + more
  );
}

/**
 * For every configured agent: run the carrier check; heal drifted/missing
 * start.sh via reconcile; re-check and report the POST-fix status. Pure
 * orchestration — every result row is an outcome of a real check run after
 * any write, never an assumption that the write worked.
 */
export function fixSessionModelCarrierDrift(
  config: SwitchroomConfig,
  deps: SessionModelCarrierFixDeps,
): FixCheckResult[] {
  const agentsDir = resolveAgentsDir(config);
  const results: FixCheckResult[] = [];

  for (const name of Object.keys(config.agents ?? {})) {
    const startShPath = join(agentsDir, name, "start.sh");
    const label = `${name}: start.sh /model session carrier (--fix)`;
    const pre = deps.check(name, startShPath);

    if (pre.status === "ok") {
      results.push({
        name: label,
        status: "ok",
        detail: "rev5 carrier already present — nothing to fix",
      });
      continue;
    }
    if (pre.status === "skip") {
      // Unreadable from the host UID — we cannot verify OR safely rewrite.
      results.push({ ...pre, name: label });
      continue;
    }

    // fail (drifted / legacy-only) or warn (start.sh missing): regenerate via
    // the reconcile path, then RE-CHECK — the heal claim is the re-run check.
    let reconcileChanges: string[];
    try {
      reconcileChanges = deps.reconcile(name).changes;
    } catch (err) {
      results.push({
        name: label,
        status: "fail",
        detail: `drift detected (${pre.detail ?? "carrier check failed"}) but reconcile failed: ${(err as Error).message}`,
        fix: "Fix the reconcile error, or run `switchroom apply` manually.",
      });
      continue;
    }

    const post = deps.check(name, startShPath);
    if (post.status === "ok") {
      results.push({
        name: label,
        status: "ok",
        detail:
          "healed: start.sh regenerated with the rev5 `.session-model` carrier — takes effect on the agent's next restart. " +
          describeReconcileChanges(reconcileChanges),
      });
    } else {
      results.push({
        name: label,
        status: "fail",
        detail: `regenerated start.sh still fails the carrier check: ${post.detail ?? post.status} — the installed template may be stale`,
        fix: "Update switchroom (the bundled profiles/_base/start.sh.hbs must carry the rev5 carrier), then re-run `switchroom doctor --fix`.",
      });
    }
  }

  return results;
}
