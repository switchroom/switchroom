#!/usr/bin/env bun
// Small CLI wrapper around `runAutoaccept` (#725 PR-4).
//
// Invoked from the per-agent systemd unit's `ExecStartPost=` (see
// `src/agents/systemd.ts`) when the tmux supervisor is the active mode
// (default since #725 PR-1) AND the agent has not opted into the legacy
// `expect`-based autoaccept wrapper via
// `experimental.legacy_autoaccept_expect: true`.
//
// argv[2] = agent name. Always exits 0 — the poller is best-effort and
// must never fail the unit start. tmux not running yet, capture-pane
// erroring, send-keys racing the prompt: all soft-failures.

import { runAutoaccept } from "../agents/autoaccept.js";

async function main(): Promise<void> {
  const agentName = process.argv[2];
  if (!agentName) {
    console.error("[autoaccept-poll] missing agent name argv");
    process.exit(0);
  }
  try {
    const res = await runAutoaccept({ agentName });
    console.error(
      `[autoaccept-poll] ${agentName}: done reason=${res.reason} fired=${
        res.fired.length ? res.fired.join(",") : "(none)"
      }`,
    );
  } catch (err) {
    // runAutoaccept is contracted to never throw, but defence-in-depth:
    // any synchronous-throw at boot must not fail the agent unit.
    console.error(
      `[autoaccept-poll] ${agentName}: unexpected throw: ${(err as Error).message}`,
    );
  }
  process.exit(0);
}

main();
