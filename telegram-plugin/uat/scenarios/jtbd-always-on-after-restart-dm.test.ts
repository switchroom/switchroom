/**
 * JTBD scenario — always-on vision: first message after restart replies
 * quickly, NOT 5 minutes later via silence-poke fallback.
 *
 * Vision (`reference/vision.md`, see [[project_vision_reanchor_human_assistants]]):
 * agents are always-on specialist exec-assistants. A 5-min blank
 * window on the first message after restart is what BROKEN feels
 * like to a user trying to use their assistant.
 *
 * ## The wedge this guards against
 *
 * Pre-v0.12.22, every agent restart produced ~5 min blank on the
 * first user message in each thread:
 *
 *   1. User sends msg → handleInbound runs the fresh-turn branch
 *      → activeTurnStartedAt.set(key, now) at gateway.ts:7357
 *   2. The #1556 delivery gate further down (~7551) checks
 *      activeTurnStartedAt.size > 0 to decide if a turn is "already
 *      in flight" — sees the entry it just wrote → buffer-until-idle
 *   3. Inbound stuck in pendingInboundBuffer. Bridge never sees it.
 *      Claude never replies. activeTurnStartedAt[key] stays set.
 *   4. ~300s later silence-poke framework-fallback fires, drains
 *      the buffer, the reply finally lands — five minutes late.
 *
 * Documented in `feedback_5min_restart_wedge_violates_vision.md`.
 * Fix is a one-line snapshot of the live size at receipt-time before
 * the fresh-turn branch mutates the Map.
 *
 * ## What this UAT asserts
 *
 * After a deliberate restart, the FIRST message in a fresh thread
 * gets a reply within a budget that excludes the silence-poke
 * fallback floor (300s). Concretely we assert < 120s, which is
 * generous for slow LLM replies but well below the wedge symptom.
 *
 * The test also makes a stricter observation log so a future
 * regression that lands BETWEEN "wedge fixed" (~LLM latency) and
 * "wedge present" (~5 min) is visible — e.g. some slow startup
 * path that takes 60-90s would pass the contract but bear
 * investigation.
 *
 * ## Why this scenario specifically
 *
 * - `smoke-dm-reply.test.ts` covers steady-state inbound→reply but
 *   does NOT restart the agent first, so the wedge surfaces as a
 *   "first message is slow" pattern that the smoke test would
 *   silently absorb on warm runs.
 * - `silent-end-recovery-dm.test.ts` covers mid-turn silent-end →
 *   no-reply, but at 6 min budget — too generous to catch the
 *   5-min wedge as a regression.
 * - This is the FIRST UAT to explicitly tie the assertion to the
 *   "always-on" vision and measure first-after-restart TTFO.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { spinUp } from "../harness.js";

const AGENT = "test-harness";

// Budget for the marker-safe restart itself (per
// feedback_agent_restart_needs_sudo_when_running.md, restart blocks
// ~30s as the gateway's bridge reattaches).
const RESTART_BUDGET_MS = 90_000;

// Hard contract: first-after-restart reply must land in under 2 min.
// This is generous for slow LLM replies but well below the 5-min
// silence-poke fallback floor — a regression of the #1556 wedge
// would trip on TTFO ≥ 300s and fail the test.
const HARD_REPLY_BUDGET_MS = 120_000;

// Vision-aligned target: real expectation is well under 30s on a
// healthy fleet. A pass between 30-120s is yellow — covered by the
// contract but worth logging for forensic visibility.
const VISION_REPLY_BUDGET_MS = 30_000;

function canShellSudo(): boolean {
  try {
    execSync("sudo -n true", { stdio: "ignore", timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

function restartAgent(name: string): void {
  // Marker-safe restart per memory feedback_compose_rollout.md +
  // feedback_agent_restart_needs_sudo_when_running.md. Apply step
  // self-elevates internally; restart needs the wrapper. We don't
  // call apply here — the agent scaffolds are already current; only
  // the in-memory state needs to reset.
  execSync(
    `sudo -n env PATH=$PATH HOME=$HOME switchroom agent restart ${name} --force`,
    { stdio: ["ignore", "pipe", "pipe"], timeout: RESTART_BUDGET_MS },
  );
}

// This scenario requires NOPASSWD sudo + the switchroom CLI on PATH on
// the harness host. Skip on CI runners that don't expose those.
const sudoOk = canShellSudo();

(sudoOk ? describe : describe.skip)(
  "uat: always-on after restart",
  () => {
    beforeAll(() => {
      restartAgent(AGENT);
      // Brief settle so the bridge sidecar finishes its reattach
      // before we send the first inbound. The bridge-register log
      // line is the earliest the agent can accept inbound.
      return new Promise((r) => setTimeout(r, 5_000));
    }, RESTART_BUDGET_MS + 10_000);

    it(
      "first message after fresh restart → reply within 2 min (NOT the 5-min wedge)",
      async () => {
        const sc = await spinUp({ agent: AGENT });
        try {
          const sendStart = Date.now();
          await sc.sendDM("ping — JTBD always-on UAT");

          const firstReply = await sc.expectMessage(/\S/, {
            from: "bot",
            timeout: HARD_REPLY_BUDGET_MS,
          });
          const ttfo = Date.now() - sendStart;

          expect(firstReply.text.length).toBeGreaterThan(0);

          // HARD CONTRACT: the wedge symptom is 300s+ TTFO. Anything
          // ≥ HARD_REPLY_BUDGET_MS (120s) flags a regression of the
          // #1556 self-blocking gate.
          if (ttfo >= HARD_REPLY_BUDGET_MS) {
            throw new Error(
              `[always-on] first-post-restart reply took ${ttfo}ms — ` +
              `matches the #1556 wedge symptom (5-min silence-poke fallback). ` +
              `Vision broken; see feedback_5min_restart_wedge_violates_vision.md`,
            );
          }
          expect(ttfo).toBeLessThan(HARD_REPLY_BUDGET_MS);

          // Yellow-band log: passes the contract but degraded from the
          // vision target. Worth investigating if this fires regularly.
          if (ttfo >= VISION_REPLY_BUDGET_MS) {
            console.warn(
              `[always-on] first-post-restart TTFO=${ttfo}ms — passed ` +
              `contract (${HARD_REPLY_BUDGET_MS}ms) but slower than the ` +
              `vision target (${VISION_REPLY_BUDGET_MS}ms). Forensic flag.`,
            );
          }
        } finally {
          await sc.tearDown();
        }
      },
      HARD_REPLY_BUDGET_MS + 10_000,
    );
  },
);
