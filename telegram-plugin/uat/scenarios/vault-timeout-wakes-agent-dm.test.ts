/**
 * UAT scenario named by `reference/jobs/approve-what-my-agent-can-touch.md`
 * § Prove it — "Timeout wakes the agent as timeout-not-denial (DM)".
 *
 * Contract under test: an agent-initiated `vault_request_access` card ages
 * past the approval TTL (60-min default) with NO operator tap. The reaper
 * expires the card, records the missed-approvals re-offer, and injects the
 * `vault_grant_timeout` synthetic — waking the parked agent with a *timeout,
 * not a denial* outcome. The agent then says the request went unanswered
 * (rather than reading silence as a "no" and rather than staying parked).
 *
 * A real 60-min wait is not viable in a scenario, so this test requires the
 * test-harness gateway to run with a SHORT approval TTL:
 *
 *   1. Standard UAT preflight (`uat/SETUP.md` §5-6).
 *   2. Set `channels.telegram.approval_timeout_minutes: 2` on the
 *      test-harness agent (threads to `SWITCHROOM_TG_APPROVAL_TIMEOUT_MS`,
 *      see `approvalTtlMs()` in gateway/permission-timeout.ts) and restart it.
 *   3. Export `SWITCHROOM_UAT_APPROVAL_TTL_MINUTES=2` in the runner env so
 *      this scenario unskips and sizes its wait window.
 *
 * Self-skips green when `SWITCHROOM_UAT_APPROVAL_TTL_MINUTES` is unset (the
 * default 60-min TTL cannot be observed within test wall-clock). The
 * module-level twin covering the same outcome deterministically is
 * `tests/approval-card-restart-outcome.test.ts` plus
 * `tests/approval-timeout-inbound-builders.test.ts` (the "TIMEOUT, not a
 * denial" wording pin).
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

const TTL_MINUTES = Number.parseInt(
  process.env.SWITCHROOM_UAT_APPROVAL_TTL_MINUTES ?? "",
  10,
);
const ttlTuned = Number.isFinite(TTL_MINUTES) && TTL_MINUTES > 0 && TTL_MINUTES <= 5;

const KEY = "uat/timeout-wake-nonexistent-key";
const CARD_BUDGET_MS = 120_000;
// TTL + reaper tick slack + model turn budget.
const WAKE_BUDGET_MS = (ttlTuned ? TTL_MINUTES : 2) * 60_000 + 240_000;

// The timeout synthetic's load-bearing wording is "TIMEOUT, not a denial" —
// the model is steered to say the request went unanswered, not refused.
const TIMEOUT_FRAMING =
  /unanswer|timed?[ -]?out|no (?:response|answer|decision)|didn'?t (?:hear|get|respond)|went without/i;

(ttlTuned ? describe : describe.skip)(
  "uat: unanswered approval card times out and wakes the agent as timeout-not-denial (DM)",
  () => {
    it(
      "card ages past the TTL with no tap → agent says the request went unanswered, unprompted",
      async () => {
        const sc = await spinUp({ agent: "test-harness" });
        try {
          // 1. Park the agent on an approval card that nobody will answer.
          await sc.sendDM(
            `Please call your vault_request_access MCP tool for the key ` +
            `\`${KEY}\` (scope read, reason "UAT timeout-wakes-agent"). Then ` +
            `END YOUR TURN cleanly and wait for the operator. If the request ` +
            `times out unanswered, tell me plainly that it went unanswered ` +
            `(not that it was denied) and what you'll do about it.`,
          );

          // 2. The card must render — and then we deliberately never tap it.
          await sc.expectMessage(/wants vault access/, {
            from: "bot",
            timeout: CARD_BUDGET_MS,
          });

          // 3. TTL elapses → reaper fires the vault_grant_timeout synthetic →
          //    a substantive bot reply arrives with timeout (never denial)
          //    framing, with no further driver message. Edits are excluded —
          //    the reaper's own "timed out" edit of the approval card must
          //    not satisfy this; only a NEW message from the woken turn does.
          const reply = await sc.expectMessage(
            (m) => !m.edited && TIMEOUT_FRAMING.test(m.text) && m.text.length > 40,
            { from: "bot", timeout: WAKE_BUDGET_MS },
          );
          expect(reply.text).toMatch(TIMEOUT_FRAMING);
          // A timeout must never be narrated as an operator refusal.
          expect(reply.text).not.toMatch(/operator denied|was denied|refused my request/i);
        } finally {
          await sc.tearDown();
        }
      },
      CARD_BUDGET_MS + WAKE_BUDGET_MS + 60_000,
    );
  },
);
