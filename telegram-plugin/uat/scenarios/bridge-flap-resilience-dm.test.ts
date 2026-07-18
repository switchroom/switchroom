/**
 * Bridge-flap resilience scenario — regression guard for #1613 / #1616.
 *
 * ## The bug this guards
 *
 * The handoff-briefing summarizer shells out to a headless `claude -p`
 * once per turn (handoff Stop hook). Before #1616 it ran without
 * `--strict-mcp-config`, so it auto-discovered the agent's project
 * `.mcp.json` and started every MCP server in it — including
 * `switchroom-telegram`. That spun up a *second* telegram bridge
 * process which registered against the same gateway socket as the
 * live agent's real bridge; the two collided under the gateway's
 * register-race close, producing an A↔B "bridge reconnect race" flap
 * every ~2s for the ~7-9s the `claude -p` lived. The handoff hook
 * fires every turn, so did the flap. A turn whose completion landed
 * inside a flap burst could have its `turn_end` signal eaten — the
 * agent looked wedged for that turn.
 *
 * The fix (#1616): the summarizer passes `--strict-mcp-config`, so
 * the headless `claude -p` loads zero MCP servers and never spawns a
 * competing bridge. The structural guard against a new offending
 * callsite is `tests/bridge-flap-regression-guard.test.ts`; this
 * scenario is the behavioural backstop.
 *
 * ## What this scenario asserts (root-cause-agnostic by design)
 *
 * The checks are symptom-based, so they catch a flap reintroduced by
 * ANY future change — not only a regression of #1616:
 *
 * 1. Send a handful of DMs in succession — each drives a turn (and a
 *    handoff-hook fire). **Primary assertion:** every DM gets a reply
 *    within budget. Directly catches both the flap (eats turn_end)
 *    and the wedge (a zero-bridge gap strands the inbound).
 * 2. **Forensic assertion:** inspect the agent's gateway-supervisor.log
 *    over the test window and assert the `bridge disconnected` density
 *    stays BELOW a flap threshold. One healthy persistent bridge
 *    produces only a trickle of disconnects; a sustained reconnect
 *    race produces dozens in tight ~2s bursts.
 *
 * ## Why the log inspection
 *
 * A flap is a server-side phenomenon that does not always surface as
 * a missed reply (a burst can self-heal in ~20-30s). The `bridge
 * disconnected` count is the transport-agnostic flap symptom. This
 * scenario shells into the agent container via `docker exec` to read
 * the gateway log; if docker is unavailable the log assertion is
 * skipped with a warning and the responsiveness checks still run.
 *
 * ## Tolerances
 *
 * - `DISCONNECT_FLAP_THRESHOLD` is the max acceptable `bridge
 *   disconnected` count over the window. Post-#1616 a healthy ~4-turn
 *   run sits well under 16 (measured ~8-13, including anonymous
 *   probe-connection churn); a sustained flap is 20-40+. 16 sits
 *   comfortably in the gap.
 */

import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { spinUp } from "../harness.js";
import type { ObservedMessage } from "../driver.js";

const AGENT = "test-harness";
const CONTAINER = `switchroom-${AGENT}`;
const GATEWAY_LOG = "/var/log/switchroom/gateway-supervisor.log";

const DM_COUNT = 4;
const PER_DM_TIMEOUT_MS = 30_000;
const OVERALL_DEADLINE_MS = 180_000;

// Post-#1616 a healthy ~4-turn run logs ~8-13 `bridge disconnected`
// lines (one persistent bridge + anonymous probe-connection churn).
// A sustained A↔B flap produces 20-40+ in tight ~2s bursts. 16 sits
// in the gap.
const DISCONNECT_FLAP_THRESHOLD = 16;

/** Total line count of the agent's gateway-supervisor.log, or null if
 *  the container/log is unreachable (CI without the container). */
function gatewayLogLineCount(): number | null {
  try {
    const out = execSync(
      `docker exec ${CONTAINER} sh -lc 'wc -l < ${GATEWAY_LOG}'`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return parseInt(out.trim(), 10);
  } catch {
    return null;
  }
}

/** Count `bridge disconnected` lines after `sinceLine` in the log. */
function disconnectCountSince(sinceLine: number): number | null {
  try {
    const out = execSync(
      `docker exec ${CONTAINER} sh -lc ` +
        `'awk "NR>${sinceLine}" ${GATEWAY_LOG} | grep -c "bridge disconnected" || true'`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    return parseInt(out.trim(), 10);
  } catch {
    return null;
  }
}

describe("uat: bridge-flap resilience — agent stays responsive, gateway does not flap", () => {
  it(
    "every DM gets a reply and the gateway does not flap across turns",
    async () => {
      const baselineLine = gatewayLogLineCount();
      const sc = await spinUp({ agent: AGENT });
      try {
        const overallDeadline = Date.now() + OVERALL_DEADLINE_MS;

        for (let i = 1; i <= DM_COUNT; i++) {
          await sc.sendDM(`flap-resilience probe ${i}/${DM_COUNT}: reply with OK${i}`);

          const remaining = Math.min(
            PER_DM_TIMEOUT_MS,
            overallDeadline - Date.now(),
          );
          expect(
            remaining,
            `overall deadline hit before DM ${i} — earlier turns were too slow`,
          ).toBeGreaterThan(0);

          // Skip empty-text observations: the Bot API cannot send an
          // empty text message (Telegram rejects it), so an empty-text
          // fromBot observation is by construction a SERVICE message —
          // e.g. the `[pinned_message]` event from the progress-card pin.
          // One of those latched here as "the reply" on 2026-07-18
          // (ci-uat run 29634400115: pinChatMessage 06:54:36.420Z → rx
          // [pinned_message] 06:54:37.012Z, exactly at the DM-2 failure).
          // A genuinely eaten turn_end still fails loudly: no non-empty
          // reply arrives and this expectMessage times out.
          const reply = await sc.expectMessage(
            (m: ObservedMessage) =>
              m.fromBot && !m.edited && m.text.length > 0,
            { from: "bot", timeout: remaining },
          );
          expect(
            reply.text.length,
            `DM ${i}/${DM_COUNT} produced an empty reply — a flap may have ` +
              `eaten the turn_end signal`,
          ).toBeGreaterThan(0);
        }

        // Responsiveness held for all DM_COUNT turns. Now check the
        // server-side flap signal.
        if (baselineLine == null) {
          console.warn(
            "[bridge-flap-resilience] docker exec unavailable — skipping " +
              "the gateway-log flap assertion; responsiveness checks passed.",
          );
          return;
        }

        const disconnectCount = disconnectCountSince(baselineLine);
        expect(
          disconnectCount,
          "could not read gateway log after the run — container went away",
        ).not.toBeNull();
        expect(
          disconnectCount as number,
          `gateway logged ${disconnectCount} "bridge disconnected" lines across ` +
            `${DM_COUNT} turns — at/above the flap threshold ` +
            `(${DISCONNECT_FLAP_THRESHOLD}). A parasitic bridge is racing the ` +
            `live one — check for a headless 'claude -p' spawned without ` +
            `--strict-mcp-config (#1613/#1616).`,
        ).toBeLessThan(DISCONNECT_FLAP_THRESHOLD);
      } finally {
        await sc.tearDown();
      }
    },
    OVERALL_DEADLINE_MS + 30_000,
  );
});
