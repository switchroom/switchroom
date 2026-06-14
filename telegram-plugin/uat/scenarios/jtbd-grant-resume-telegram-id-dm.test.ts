/**
 * End-to-end UAT — agent AUTO-RESUMES after a vault grant approval,
 * under the live `telegram-id` (single-factor) posture. Regression gate
 * for the mid-turn-strand fix (#2340).
 *
 * THE BUG (#2340, clerk 2026-06-13): the gateway injects a synthetic
 * "✅ approved — resume your task" inbound after the operator taps
 * Approve. That inject used a raw `sendToAgent` and only buffered on a
 * disconnected bridge. When the approval landed WHILE the agent's
 * grant-requesting turn was still finishing, the socket write succeeded
 * (`delivered=true`) but claude was mid-turn, so the channel
 * notification stranded in its TUI composer (the #1556 race) and the
 * agent sat idle until manually poked. Fix: route the resume through
 * the same turn-gate as normal inbounds (buffer mid-turn, flush at
 * turn-end). This scenario proves the agent resumes on its own.
 *
 * Posture: the live fleet runs `vault.broker.approvalAuth: telegram-id`
 * (broker auto-unlocked), so tapping Approve mints silently — NO
 * passphrase prompt. The sibling `vault-grant-auto-resume-dm.test.ts`
 * covers the (now-legacy) passphrase posture and stays skipped.
 *
 * No sacrificial key needed: `vault_request_access` mints an ACL grant
 * for the key *pattern*; the card → approve → resume cycle fires
 * whether or not the key holds a value. We assert the RESUME (a fresh
 * bot turn after the tap, with no driver nudge), not a secret value —
 * so nothing sensitive is read or leaked.
 *
 * Self-skips green when the driver can't resolve the chat (unwired
 * host), matching the other opt-in scenarios — uat/** is excluded from
 * gating CI anyway. Mutates host vault state (mints a short grant on
 * test-harness); harmless + TTL-expiring.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

const AGENT = "test-harness";
const KEY = "uat/resume-probe";

describe("uat: agent auto-resumes after vault grant approval — telegram-id (#2340)", () => {
  it(
    "fires card → operator taps Approve → agent emits a NEW turn with no nudge",
    async () => {
      const sc = await spinUp({ agent: AGENT });
      try {
        // 1. Ask the agent to request access then resume. Steer it to
        //    end its turn after the tool call so the approval lands at
        //    a turn boundary — the exact window #2340 fixes.
        await sc.sendDM(
          `Call your vault_request_access MCP tool with key="${KEY}", ` +
          `scope="read", reason="UAT #2340 resume gate". After the tool ` +
          `returns "waiting for operator", END YOUR TURN. When the ` +
          `operator approves, you should AUTOMATICALLY resume: confirm ` +
          `the grant landed and that you saw the approval for ${KEY}.`,
        );

        // 2. Wait for the approval card.
        const card = await sc.expectMessage(/wants vault access/i, {
          from: "bot",
          timeout: 120_000,
        });

        // 3. Find + tap the Approve button.
        const kb = await sc.driver.getKeyboard(sc.botUserId, card.messageId);
        const approve = kb!
          .flat()
          .find((b) => b.callbackData !== undefined && /approve/i.test(b.text));
        expect(approve, "Approve button present on the card").toBeDefined();
        const tapAtMsgId = card.messageId;
        await sc.driver.pressButton(sc.botUserId, card.messageId, approve!.callbackData!);

        // 4. Single-factor: card edits to "Granted" with no passphrase
        //    prompt. Anchor on the grant confirmation.
        await sc.expectMessage(/Granted|already has|access to/i, {
          from: "bot",
          timeout: 30_000,
        });

        // 5. THE #2340 ASSERTION: the agent auto-resumes — a NEW bot
        //    turn referencing the approval/grant/key, WITHOUT the driver
        //    sending anything else. Pre-fix this stranded mid-turn and
        //    timed out. The resume reply must be a message newer than
        //    the card we tapped (not the card edit).
        const resume = await sc.expectMessage(
          (m) =>
            m.messageId > tapAtMsgId &&
            /(approv|grant|access|resume|landed|✅)/i.test(m.text),
          { from: "bot", timeout: 150_000 },
        );
        expect(resume.text.length).toBeGreaterThan(0);
      } finally {
        await sc.tearDown();
      }
    },
    360_000,
  );
});
