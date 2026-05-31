/**
 * JTBD scenario — memory survives across restart (the "fleet differentiator").
 *
 * Serves: `reference/remember-across-sessions.md` — the JTBD says:
 *
 *   *Outcome:* The agent brings back relevant facts, preferences,
 *   decisions, and open threads from past conversations, in the right
 *   moment, without the user reminding it.
 *
 *   *Stakes:* An agent with no memory is a stranger every time. The
 *   user stops sharing context because they're tired of repeating
 *   it. The relationship never compounds.
 *
 * Memory IS the moat. If hindsight silently drops captures, or if a
 * restart wipes recent recall, the multi-agent specialist proposition
 * collapses to "9 chatbots with no context, each costing a separate
 * conversation thread to bring up to speed." This is the most
 * expensive trust-leak in the product because regressions are
 * invisible for days (the user keeps re-explaining, attributing the
 * cost to "agents are like that" not "switchroom broke memory").
 *
 * ## Contract this asserts
 *
 * 1. **Capture works**: agent confirms it remembers a unique token in
 *    its first reply (capture-side observable via reply content).
 * 2. **Survival works**: after a marker-safe restart of the agent, the
 *    same token is recalled in response to a follow-up question.
 * 3. **Timing is reasonable**: post-restart recall reply lands within
 *    the always-on cold-start budget (vision target <30s; hard
 *    contract <120s, same as `jtbd-always-on-after-restart-dm.test.ts`).
 *
 * ## What this catches that other UATs don't
 *
 * - `jtbd-always-on-after-restart-dm.test.ts` asserts the agent REPLIES
 *   post-restart. This asserts the agent REMEMBERS post-restart.
 * - `jtbd-status-query-dm.test.ts` and friends test conversational
 *   pacing. None test memory.
 * - No existing UAT exercises hindsight recall as a vision contract.
 *
 * ## Honest scope caveat
 *
 * Hindsight capture is opportunistic (the agent decides when to
 * remember, not the user). This test uses an EXPLICIT recall prompt
 * ("please remember exactly this token") which heavily biases the
 * model toward capturing it. A future scenario should test IMPLICIT
 * recall (the agent inferring relevance without being asked) — the
 * harder + more valuable JTBD case — but that's flaky against any
 * single model, so we start with the explicit-capture baseline as the
 * floor.
 */

import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { spinUp } from "../harness.js";
import { isActivityFeedMessage, isWorkerFeedMessage } from "../assertions.js";
import type { ObservedMessage } from "../driver.js";

const AGENT = "test-harness";

// Two classes of bot message are NOT the agent's reply and must be
// skipped, or a bare `/\S/` matcher latches onto them and the
// verbatim-token check fails against noise instead of catching a real
// memory miss:
//   1. The worker-activity feed (#2000, default-on since v0.14.19) — a
//      stray background sub-agent posts `🔧 Worker · …` into this DM.
//   2. The tool-activity feed — on a turn that uses tools (memory recall
//      does), `→ Finding the right tool` paints as its own message before
//      the real answer lands.
// Match the first non-empty bot reply that is neither.
const isReply = (m: ObservedMessage): boolean =>
  /\S/.test(m.text) && !isWorkerFeedMessage(m) && !isActivityFeedMessage(m);

const RESTART_BUDGET_MS = 90_000;
const CAPTURE_REPLY_BUDGET_MS = 60_000;
const RECALL_REPLY_BUDGET_MS = 120_000;
const VISION_RECALL_BUDGET_MS = 30_000;

// Unique per-run token so we know the model isn't echoing a stale
// answer from a prior cached conversation.
const TOKEN = `SWITCHROOM_UAT_MEM_${randomBytes(8).toString("hex").toUpperCase()}`;

function canShellSudo(): boolean {
  try {
    execSync("sudo -n true", { stdio: "ignore", timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

function restartAgent(name: string): void {
  execSync(
    `sudo -n env PATH=$PATH HOME=$HOME switchroom agent restart ${name} --force`,
    { stdio: ["ignore", "pipe", "pipe"], timeout: RESTART_BUDGET_MS },
  );
}

const sudoOk = canShellSudo();

// UNSKIPPED 2026-05-20 after root-cause + fix.
//
// Original failure: the first live run on 2026-05-20 FAILED — after
// capture → restart → recall, the agent replied "I don't have that
// token — no SWITCHROOM_UAT_MEM_* value was ever shared with me to
// remember." Documented at the time as a known vision gap.
//
// Root cause: the vendored hindsight-memory plugin's default
// `retainEveryNTurns: 10` throttled auto-retention to every 10
// turns. A 2-turn UAT session (capture turn → restart) NEVER reached
// the threshold, so the Stop hook's retain.py skipped (`turn_count %
// retain_every_n != 0`) and the token never persisted. The recall
// query at the new boot found nothing.
//
// Fix: switchroom's scaffold (src/agents/scaffold.ts) now applies a
// post-copy override that sets `retainEveryNTurns: 1` in the
// per-agent settings.json. Every turn end retains. Vendor file
// stays untouched. See project_hindsight_memory_gap_root_cause.md.
//
// Live re-run after the fix: capture TTFO=22.7s, recall TTFO=14.1s,
// token round-tripped successfully. The remember-across-sessions
// JTBD is now met for single-turn explicit-memory prompts.
//
// Likely root causes (any/all):
//   - Hindsight capture is opportunistic — the model decides when to
//     invoke `hindsight_save`. The "please remember exactly this
//     token" prompt didn't trigger a save in the model's judgment.
//   - The post-turn Stop hook (which writes hindsight) may not have
//     flushed before the marker-safe restart killed the container.
//   - Recall at the new boot may not query hindsight pre-reply.
//
// This UAT is SKIPPED but kept in-tree as an EXECUTABLE SPECIFICATION
// of the contract. Unskip the test when the underlying memory pipeline
// is fixed — passing this test is the gate for `remember-across-sessions`
// being a satisfied JTBD.
//
// Tracked as: memory-pipeline work in the post-Phase-2b roadmap.
//
// (Memory is the moat — see comment block above. Shipping the test
// as a known-failing skip is more honest than not shipping it at all.)
(sudoOk ? describe : describe.skip)(
  "uat: memory survives across restart (remember-across-sessions JTBD)",
  () => {
    it(
      "agent remembers a unique token after capture → restart → recall",
      async () => {
        // --- Phase 1: Capture ---
        const sc1 = await spinUp({ agent: AGENT });
        try {
          const captureStart = Date.now();
          await sc1.sendDM(
            `Please remember exactly this token for later: ${TOKEN}. ` +
            `Confirm in your reply that you've noted it. ` +
            `(This is a memory-survival UAT — store it via hindsight.)`,
          );

          const captureReply = await sc1.expectMessage(isReply, {
            from: "bot",
            timeout: CAPTURE_REPLY_BUDGET_MS,
          });
          const captureTtfo = Date.now() - captureStart;

          // The agent's first reply should acknowledge the token. We
          // don't require the token to be echoed verbatim (the agent
          // may say "noted" without repeating), but we DO require a
          // non-empty reply that doesn't error.
          expect(captureReply.text.length).toBeGreaterThan(0);
          console.log(
            `[memory-survives] capture phase: TTFO=${captureTtfo}ms, ` +
            `reply length=${captureReply.text.length}`,
          );

          // Brief settle so any async hindsight write has time to flush
          // before we kill the container. Hindsight captures are
          // typically post-turn-end via a Stop hook; turn-complete
          // signals from the gateway run within ~1-3s after the reply.
          await new Promise((r) => setTimeout(r, 10_000));
        } finally {
          await sc1.tearDown();
        }

        // --- Phase 2: Restart ---
        restartAgent(AGENT);
        // Settle so the bridge sidecar reattaches and the new claude
        // session loads hindsight before the recall inbound arrives.
        await new Promise((r) => setTimeout(r, 8_000));

        // --- Phase 3: Recall ---
        const sc2 = await spinUp({ agent: AGENT });
        try {
          const recallStart = Date.now();
          await sc2.sendDM(
            `Earlier I asked you to remember a token starting with ` +
            `SWITCHROOM_UAT_MEM_. What was the full token? ` +
            `Reply with the token only, no extra text.`,
          );

          const recallReply = await sc2.expectMessage(isReply, {
            from: "bot",
            timeout: RECALL_REPLY_BUDGET_MS + 5_000,
          });
          const recallTtfo = Date.now() - recallStart;

          expect(recallReply.text.length).toBeGreaterThan(0);

          // HARD CONTRACT — memory survival. If the token doesn't
          // appear, hindsight either didn't capture it OR the recall
          // failed to surface it.
          const tokenInReply = recallReply.text.includes(TOKEN);
          if (!tokenInReply) {
            throw new Error(
              `[memory-survives] CONTRACT FAILED: token ${TOKEN} not ` +
              `present in recall reply. Either hindsight capture missed ` +
              `the original message (likely if the post-turn-end Stop ` +
              `hook didn't run before restart) OR the recall query ` +
              `didn't find the entry. Reply was: ` +
              `${JSON.stringify(recallReply.text.slice(0, 400))}`,
            );
          }
          expect(tokenInReply).toBe(true);

          // Timing contract — recall on a cold-restarted agent should
          // still feel "always-on". Same bound as the post-restart
          // first-message UAT.
          if (recallTtfo >= RECALL_REPLY_BUDGET_MS) {
            throw new Error(
              `[memory-survives] recall TTFO=${recallTtfo}ms exceeds ` +
              `${RECALL_REPLY_BUDGET_MS}ms — matches the wedge symptom`,
            );
          }
          expect(recallTtfo).toBeLessThan(RECALL_REPLY_BUDGET_MS);

          if (recallTtfo >= VISION_RECALL_BUDGET_MS) {
            console.warn(
              `[memory-survives] recall TTFO=${recallTtfo}ms — passed ` +
              `contract (${RECALL_REPLY_BUDGET_MS}ms) but slower than ` +
              `vision target (${VISION_RECALL_BUDGET_MS}ms). Hindsight ` +
              `query latency canary.`,
            );
          } else {
            console.log(
              `[memory-survives] recall TTFO=${recallTtfo}ms — ` +
              `within vision target. Token round-tripped successfully.`,
            );
          }
        } finally {
          await sc2.tearDown();
        }
      },
      // Outer budget: capture + 10s settle + restart + 8s settle + recall.
      CAPTURE_REPLY_BUDGET_MS + 10_000 + RESTART_BUDGET_MS + 8_000 + RECALL_REPLY_BUDGET_MS + 10_000,
    );
  },
);
