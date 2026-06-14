/**
 * UAT — `/model` v2 dashboard BUTTON TAP (#2263, #2270, #2271). The
 * existing jtbd-model-command scenario covers the bare dashboard +
 * typed-arg forms; this one exercises the genuinely new path the
 * mtcute driver can now drive: tapping a model button to switch the
 * live session via the picker, and the menu never leaving a dead card
 * (#2270 — keeps buttons + clears the toast).
 *
 * Switches are session-only (revert on restart); the test taps a
 * different model then restores the original so test-harness isn't
 * left changed.
 *
 * Self-skips green on an unwired host.
 */
import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

const AGENT = "test-harness";

describe("uat: /model dashboard button tap switches the live session", () => {
  it(
    "tap a non-current model → switch confirmation; then restore",
    async () => {
      const sc = await spinUp({ agent: AGENT });
      try {
        await sc.sendDM("/model");
        const menu = await sc.expectMessage(/Default \(new sessions\):|Now:/i, {
          from: "bot",
          timeout: 30_000,
        });
        const kb = await sc.driver.getKeyboard(sc.botUserId, menu.messageId);
        const flat = (kb ?? []).flat().filter((b) => b.callbackData);
        // Model buttons carry mdl:s:<tag>; the current one is prefixed
        // ✅. Refresh (mdl:r) is excluded — pick a non-current model.
        const originalLabel = flat
          .find((b) => /✅/.test(b.text))
          ?.text.replace(/^✅\s*/, "");
        const target = flat.find(
          (b) => /mdl:s:/.test(b.callbackData!) && !/✅/.test(b.text),
        );
        expect(target, "a non-current model button to tap").toBeDefined();

        await sc.driver.pressButton(sc.botUserId, menu.messageId, target!.callbackData!);
        await new Promise((r) => setTimeout(r, 6000));
        // #2270: the card never goes dead — it edits in place to a
        // confirmation and KEEPS a keyboard.
        const after = await sc.driver.getMessage(sc.botUserId, menu.messageId);
        expect(after?.text ?? "").toMatch(/Set model to|Switched|model/i);
        const kbAfter = await sc.driver.getKeyboard(sc.botUserId, menu.messageId);
        expect(
          (kbAfter ?? []).flat().length,
          "menu keeps its buttons after a tap (no dead card, #2270)",
        ).toBeGreaterThan(0);

        // Restore the original model: tap the button whose label now
        // matches the original (it's no longer the ✅ row).
        if (originalLabel) {
          const restore = (kbAfter ?? [])
            .flat()
            .find((b) => b.callbackData?.startsWith("mdl:s:") && b.text.replace(/^✅\s*/, "") === originalLabel);
          if (restore?.callbackData) {
            await sc.driver.pressButton(sc.botUserId, menu.messageId, restore.callbackData);
          }
        }
      } finally {
        await sc.tearDown();
      }
    },
    120_000,
  );
});
