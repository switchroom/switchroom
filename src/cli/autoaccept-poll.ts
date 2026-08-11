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
import { queryActiveOverageServing } from "../agents/overage-decision.js";

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
  // Opt-in OVERAGE carve-out: on a weekly-quota menu, ask the BROKER whether the
  // active account is currently overage-authorized and, if so, select "usage
  // credits" instead of failover. Default-off is enforced by the broker (returns
  // false unless the account is in `allow_overage_accounts` AND Anthropic
  // currently reports overage allowed). The extra kill switch
  // SWITCHROOM_RATE_LIMIT_OVERAGE=0 forces Esc-only even for a flagged account
  // (an operator "stop spending now" lever). Only wired when rate-limit
  // detection is on (the menu branch is otherwise disabled anyway).
  const overageSelect =
    rateLimitDetect && process.env.SWITCHROOM_RATE_LIMIT_OVERAGE !== "0";
  // #2971 — card-aware permission-prompt gate: default ON. Before Esc-ing a
  // shape-persistent permission prompt, ask the gateway whether a live
  // Telegram approval card already exists; if so, defer to the card + the
  // #2724 TTL reaper instead of racing it with a keystroke. Kill switch
  // SWITCHROOM_PERMISSION_CARD_AWARE=0 restores the old unconditional-Esc
  // behaviour (useful if this ever needs a fast rollback).
  const permissionCardAware = process.env.SWITCHROOM_PERMISSION_CARD_AWARE !== "0";
  // Flood-aware permission gate: default ON. While Telegram is 429-throttling
  // this agent's outbound path, an approval card the gateway has ALREADY
  // decided to post may still be sitting behind the flood window / the
  // edit-flood-fuse — so `{ok:true, pending:false}` does not mean "no card is
  // coming". The watchdog reads the flood-ban work's own on-disk state
  // (`flood-windows.json` + `429-ledger.json`) and withholds Esc while that
  // state says the channel is throttled, up to a bounded ceiling. Kill switch
  // SWITCHROOM_WEDGE_FLOOD_AWARE=0 restores the flood-blind behaviour.
  const permissionFloodAware = process.env.SWITCHROOM_WEDGE_FLOOD_AWARE !== "0";
  try {
    console.error(
      `[autoaccept-poll] ${agentName}: entering wedge-watchdog (continuous)` +
        (rateLimitDetect ? " +rate-limit-detect" : " (rate-limit-detect OFF)") +
        (overageSelect ? " +overage-carveout" : "") +
        (permissionCardAware ? " +permission-card-aware" : " (permission-card-aware OFF)") +
        (permissionFloodAware ? " +permission-flood-aware" : " (permission-flood-aware OFF)"),
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
      // The money-spending decision lives in the broker; the watchdog only asks.
      // Soft-fail inside queryActiveOverageServing → false (Esc-park).
      overageDecision: overageSelect ? () => queryActiveOverageServing() : undefined,
      // #2471 — wire the manifest-stall escalation (kill/interrupt + handoff).
      requestRestart: requestWedgeRestart,
      // #2971 — `undefined` wires the real gateway query (default export's
      // own default); `null` disables the card-aware check entirely.
      queryPendingPermission: permissionCardAware ? undefined : null,
      // `undefined` wires the real on-disk flood probe; `null` disables it.
      floodPressure: permissionFloodAware ? undefined : null,
    });
    console.error(
      `[autoaccept-poll] ${agentName}: wedge-watchdog returned reason=${res.reason} fires=${res.fires} rateLimitFires=${res.rateLimitFires} overageCreditSelections=${res.overageCreditSelections} confirmModalFires=${res.confirmModalFires} fableConsentFires=${res.fableConsentFires} permissionPromptFires=${res.permissionPromptFires} permissionPromptDeferrals=${res.permissionPromptDeferrals} permissionPromptFloodHolds=${res.permissionPromptFloodHolds} permissionPromptCardlessHolds=${res.permissionPromptCardlessHolds} restartEscalations=${res.restartEscalations}`,
    );
  } catch (err) {
    console.error(
      `[autoaccept-poll] ${agentName}: wedge-watchdog unexpected throw: ${(err as Error).message}`,
    );
  }
  process.exit(0);
}

main();
