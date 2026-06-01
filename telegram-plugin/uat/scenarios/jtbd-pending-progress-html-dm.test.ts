/**
 * UAT — pending-progress edit preserves HTML formatting (#1698 regression gate).
 *
 * Promoted from the one-off `pr1706-pending-progress-html-dm.test.ts`
 * verification scenario per #1793. The pending-progress / silent-anchor
 * / answer-stream code family in `telegram-plugin/` all touch the
 * parse_mode contract on cross-turn edits; the existing UAT suite
 * (`cross-turn-pending-progress-dm.test.ts`, `jtbd-fast-trivial-dm.test.ts`,
 * `jtbd-soft-commit-dm.test.ts`) covers cadence / round-trip / pacing
 * but does NOT pin the parse_mode contract. #1698 shipped to prod and
 * the existing suite went green throughout — this scenario closes that
 * blind spot.
 *
 * Method:
 *   1. Ask the agent to send ONE reply with both <b> and <code> via
 *      the reply tool (default html format).
 *   2. Dispatch a background bash so the turn ends with pending async.
 *   3. End turn. Pending-progress activates.
 *   4. After ~60-90s, observe the first edit. Assert text reads back
 *      WITHOUT literal `<b>` / `<code>` substrings (Telegram parsed
 *      under HTML, formatting moved to entities, mtcute Message.text
 *      returns plain prose). Pre-fix, parse_mode was dropped on the
 *      edit and the tags would render as literal characters.
 */

import { describe, it, expect } from "vitest";
import { spinUp, type ObservedMessage } from "../harness.js";

const SLEEP_SECONDS = 90;
const OVERALL_DEADLINE_MS = 4 * 60_000;

const PROMPT =
  `Please run \`sleep ${SLEEP_SECONDS}\` in the background using the ` +
  `Bash tool with \`run_in_background: true\`. Send exactly ONE reply, ` +
  `using the reply tool with default html format, containing this text ` +
  `VERBATIM:\n\n` +
  `<b>Worker dispatched.</b> Running <code>sleep ${SLEEP_SECONDS}</code> ` +
  `in background.\n\n` +
  `Do NOT send any other reply until the sleep finishes. Just dispatch ` +
  `the bash, send that one HTML reply, end your turn. When it finishes ` +
  `much later, reply with the single word "done".`;

const SUFFIX_RE =
  /\n\n— still working \(\d+m\)( · message me anytime, I'll keep you posted)?$/;

describe("uat: pending-progress edit preserves HTML formatting (#1698 regression gate)", () => {
  it(
    "first pending-progress edit reads back WITHOUT literal HTML tags",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        const startedAt = Date.now();
        await sc.sendDM(PROMPT);

        let anchorMsgId: number | null = null;
        let editText: string | null = null;
        const deadline = startedAt + OVERALL_DEADLINE_MS;

        while (Date.now() < deadline) {
          try {
            const msg = await sc.expectMessage(
              (m: ObservedMessage) => m.fromBot,
              { from: "bot", timeout: deadline - Date.now() },
            );
            const rel = Date.now() - startedAt;
            console.log(
              `[jtbd-pending-progress-html] +${(rel / 1000).toFixed(1)}s ` +
                `${msg.edited ? "EDIT" : "FRESH"} msg=${msg.messageId} ` +
                `${JSON.stringify(msg.text.slice(0, 120))}`,
            );
            if (!msg.edited && anchorMsgId == null) {
              anchorMsgId = msg.messageId;
              continue;
            }
            if (
              msg.edited &&
              anchorMsgId === msg.messageId &&
              SUFFIX_RE.test(msg.text)
            ) {
              editText = msg.text;
              break;
            }
          } catch {
            break;
          }
        }

        expect(
          anchorMsgId,
          "agent never sent its initial HTML reply — UAT env issue",
        ).not.toBeNull();
        expect(
          editText,
          `no pending-progress edit observed within ${OVERALL_DEADLINE_MS / 1000}s — ` +
            `model may not have dispatched async, or pending-progress is disabled`,
        ).not.toBeNull();

        // ── THE #1698 REGRESSION GATE ─────────────────────────────────
        // mtcute's Message.text returns the parsed text — formatting
        // lives in `entities`. So a working parse_mode=HTML edit shows
        // clean prose with no literal "<b>" / "<code>" substrings.
        // Pre-fix the gateway dropped parse_mode on the cross-turn
        // edit and Telegram stored the tags as plain characters.
        expect(
          editText,
          `#1698 regression: pending-progress edit text contains literal "<b>" — ` +
            `parse_mode was dropped and Telegram is storing the original HTML tags as plain.`,
        ).not.toContain("<b>");
        expect(editText).not.toContain("</b>");
        expect(editText).not.toContain("<code>");
        expect(editText).not.toContain("</code>");

        // Sanity — the model's prose is still visible (without tags).
        expect(editText).toContain("Worker dispatched");

        // Belt-and-braces — the suffix landed (proves the edit was
        // pending-progress and not some other path).
        expect(editText).toMatch(SUFFIX_RE);
      } finally {
        await sc.tearDown();
      }
    },
    OVERALL_DEADLINE_MS + 30_000,
  );
});
