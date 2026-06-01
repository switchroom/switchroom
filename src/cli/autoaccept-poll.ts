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
//      (theme / MCP trust / dev-channels) and returns after idle-timeout.
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

import { runAutoaccept } from "../agents/autoaccept.js";
import { runWedgeWatchdog } from "../agents/wedge-watchdog.js";

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
  try {
    console.error(`[autoaccept-poll] ${agentName}: entering wedge-watchdog (continuous)`);
    // Runs until the container stops (maxPolls defaults to Infinity).
    const res = await runWedgeWatchdog({ agentName });
    console.error(
      `[autoaccept-poll] ${agentName}: wedge-watchdog returned reason=${res.reason} fires=${res.fires}`,
    );
  } catch (err) {
    console.error(
      `[autoaccept-poll] ${agentName}: wedge-watchdog unexpected throw: ${(err as Error).message}`,
    );
  }
  process.exit(0);
}

main();
