#!/usr/bin/env bun
// Small CLI wrapper around `runAutoaccept` + `runWedgeWatchdog` (#725 PR-4).
//
// Invoked from the agent's docker entrypoint after the tmux supervisor
// is launched (default since #725 PR-1), when the agent has not opted
// into the legacy `expect`-based autoaccept wrapper via
// `experimental.legacy_autoaccept_expect: true`.
//
// Two phases in one process:
//   1. Boot phase — `runAutoaccept` dispatches the first-run TUI prompts
//      (theme / MCP trust / dev-channels) and returns once claude reaches
//      the REPL (or, in the pathological never-boots case, after the
//      generous boot hard-cap).
//   2. Watch phase — `runWedgeWatchdog` then runs for the container
//      lifetime, dismissing any STABLE blocking modal selector that wedges
//      the agent mid-session (the AskUserQuestion / ExitPlanMode class).
//      This phase does not return; the process lives until the container
//      stops. Disable it with `SWITCHROOM_WEDGE_WATCHDOG=0`, which restores
//      the legacy single-shot (boot-only) behaviour.
//
// argv[2] = agent name. Best-effort throughout — never fails the unit
// start. tmux not running yet, capture-pane erroring, send-keys racing the
// prompt: all soft-failures.

import { execFileSync } from "node:child_process";
import { runAutoaccept } from "../agents/autoaccept.js";
import { runWedgeWatchdog } from "../agents/wedge-watchdog.js";
import { signalQuotaWall } from "../agents/rate-limit-signal.js";

/**
 * #2471 — manifest-stall escalation. A turn stuck "Manifesting" with a
 * Stop-hook error never ends, so the in-pane Esc the watchdog already
 * tried could not clear it. The cleanest in-container recovery is the
 * tmux interrupt (`send-keys C-c`) — the SAME primitive the operator's
 * `! interrupt` uses — which breaks the wedged turn and returns claude to
 * an idle REPL; the next inbound (or the gateway's own resume path)
 * carries the work forward. We deliberately do NOT kill the session here
 * (the watchdog's hard contract forbids destructive tmux verbs); a bare
 * interrupt is the most aggressive compliant action. If the interrupt
 * itself does not clear the wedge, the log line below tells the operator
 * a hard `switchroom agent restart` is warranted.
 *
 * Soft-fail throughout — must never throw (never-throw sidecar contract).
 */
function requestWedgeRestart(agentName: string, reason: string): void {
  const socket = `switchroom-${agentName}`;
  console.error(
    `[autoaccept-poll] ${agentName}: manifest-stall recovery — ${reason}; ` +
      `sending tmux interrupt (C-c). If this recurs, a hard ` +
      `'switchroom agent restart ${agentName}' is warranted.`,
  );
  try {
    execFileSync("tmux", ["-L", socket, "send-keys", "-t", agentName, "C-c"], {
      timeout: 3000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    console.error(
      `[autoaccept-poll] ${agentName}: wedge interrupt send-keys failed: ${(err as Error).message}`,
    );
  }
}

async function main(): Promise<void> {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("[autoaccept-poll] missing agent name argv");
    process.exit(0);
  }

  // --- Boot phase: first-run prompt dispatch (one-shot). ---
  try {
    const res = await runAutoaccept({ agentName });
    console.error(
      `[autoaccept-poll] ${agentName}: boot done reason=${res.reason} fired=${
        res.fired.length ? res.fired.join(",") : "(none)"
      }`,
    );
  } catch (err) {
    // runAutoaccept is contracted to never throw, but defence-in-depth:
    // any synchronous-throw at boot must not fail the agent unit.
    console.error(
      `[autoaccept-poll] ${agentName}: boot unexpected throw: ${(err as Error).message}`,
    );
  }

  // --- Watch phase: continuous mid-session wedge watchdog. ---
  if (process.env.SWITCHROOM_WEDGE_WATCHDOG === "0") {
    console.error(
      `[autoaccept-poll] ${agentName}: wedge-watchdog disabled (SWITCHROOM_WEDGE_WATCHDOG=0) — exiting after boot phase`,
    );
    process.exit(0);
  }
  // Rate-limit (weekly-quota) menu detection: default ON. When detected, the
  // watchdog signals the gateway to trigger account failover, then Esc-parks the
  // menu. Kill switch SWITCHROOM_RATE_LIMIT_DETECT=0 → detect-disabled (the
  // watchdog behaves exactly as before: generic-modal Esc only).
  const rateLimitDetect = process.env.SWITCHROOM_RATE_LIMIT_DETECT !== "0";
  try {
    console.error(
      `[autoaccept-poll] ${agentName}: entering wedge-watchdog (continuous)` +
        (rateLimitDetect ? " +rate-limit-detect" : " (rate-limit-detect OFF)"),
    );
    // Runs until the container stops (maxPolls defaults to Infinity).
    const res = await runWedgeWatchdog({
      agentName,
      rateLimitSignature: rateLimitDetect ? undefined : null,
      onRateLimitMenu: rateLimitDetect
        ? (name, resetAt) => {
            // Fire-and-forget; do not await (a slow/absent gateway socket must
            // never stall the poll loop).
            void signalQuotaWall(name, resetAt);
          }
        : undefined,
      // #2471 — wire the manifest-stall escalation (kill/interrupt + handoff).
      requestRestart: requestWedgeRestart,
    });
    console.error(
      `[autoaccept-poll] ${agentName}: wedge-watchdog returned reason=${res.reason} fires=${res.fires} rateLimitFires=${res.rateLimitFires} confirmModalFires=${res.confirmModalFires} permissionPromptFires=${res.permissionPromptFires} restartEscalations=${res.restartEscalations}`,
    );
  } catch (err) {
    console.error(
      `[autoaccept-poll] ${agentName}: wedge-watchdog unexpected throw: ${(err as Error).message}`,
    );
  }
  process.exit(0);
}

main();
