/**
 * UAT scenario named by `reference/jobs/approve-what-my-agent-can-touch.md`
 * § Prove it — "Denied request resumes the turn (DM)".
 *
 * Contract under test: the operator taps Deny on an agent-initiated
 * `vault_request_access` card; the parked turn RESUMES (the gateway injects
 * the `vault_grant_denied` synthetic), and the agent states plainly what it
 * now can't do and continues or degrades — never left waiting on a card it
 * already got an answer to, and never treating the denial as a reason to
 * silently strand.
 *
 * Load-bearing assertion: after the Deny tap, the DRIVER sees a NEW bot turn
 * that acknowledges the denial/degraded path WITHOUT the driver sending any
 * further message. (The unit-level twin pins the synthetic's envelope in
 * `tests/vault-grant-inbound-builders.test.ts`; this scenario proves the
 * user-visible outcome over real Telegram.)
 *
 * Needs only the standard UAT preflight (`uat/SETUP.md` §5-6) — a Deny mints
 * nothing and mutates no vault state, so no passphrase or sacrificial key is
 * required. The requested key deliberately does not exist.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

const KEY = "uat/deny-resume-nonexistent-key";
const CARD_BUDGET_MS = 120_000;
const RESUME_BUDGET_MS = 120_000;

// The deny synthetic steers the model toward naming the blocked capability
// and a fallback — this framing is the stable signal of a resumed turn.
const DENY_RESUME_FRAMING =
  /den(?:ied|ial)|can(?:'|no)t|won'?t be able|without (?:that|the) (?:key|access|credential)|not (?:been )?grant/i;

describe("uat: denied vault request resumes the parked turn (DM)", () => {
  it(
    "operator taps Deny → parked turn resumes and the agent names what it can't do, with no nudge",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        // 1. Park the agent on an approval card.
        await sc.sendDM(
          `Please call your vault_request_access MCP tool for the key ` +
          `\`${KEY}\` (scope read, reason "UAT deny-resumes-turn"). Then END ` +
          `YOUR TURN cleanly and wait. When you hear the operator's decision, ` +
          `resume: if denied, tell me plainly that you can't read that key ` +
          `and what you'd do instead.`,
        );

        // 2. Wait for the approval card and find the Deny button.
        const card = await sc.expectMessage(/wants vault access/, {
          from: "bot",
          timeout: CARD_BUDGET_MS,
        });
        const kb = await sc.driver.getKeyboard(sc.botUserId, card.messageId);
        const denyButton = kb!
          .flat()
          .find((b) => b.callbackData !== undefined && /deny/i.test(b.text));
        expect(denyButton).toBeDefined();

        // 3. Tap Deny. NO further driver message after this point.
        await sc.driver.pressButton(
          sc.botUserId,
          card.messageId,
          denyButton!.callbackData!,
        );

        // 4. The deny synthetic must wake the parked turn: a substantive
        //    bot reply that acknowledges the denial arrives unprompted.
        const reply = await sc.expectMessage(
          (m) => DENY_RESUME_FRAMING.test(m.text) && m.text.length > 40,
          { from: "bot", timeout: RESUME_BUDGET_MS },
        );
        expect(reply.text).toMatch(DENY_RESUME_FRAMING);
      } finally {
        await sc.tearDown();
      }
    },
    CARD_BUDGET_MS + RESUME_BUDGET_MS + 60_000,
  );
});
