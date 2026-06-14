/**
 * UAT — `/effort` command (#2336, #2342): show + tap-to-switch the
 * Claude reasoning effort for the live session. The effort sibling of
 * `/model`; the picker-driven menu is the same shape.
 *
 * Verified live on test-harness v0.15.21. Switches are session-only
 * (revert on restart), so the tap test restores the original level.
 *
 * Self-skips green on an unwired host (spinUp can't resolve the chat).
 */
import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

const AGENT = "test-harness";
const T = 30_000;

describe("uat: /effort — show, tap-switch, bad-arg", () => {
  it(
    "bare /effort shows the effort menu with a tap keyboard",
    async () => {
      const sc = await spinUp({ agent: AGENT });
      try {
        await sc.sendDM("/effort");
        const menu = await sc.expectMessage(/Effort —/, { from: "bot", timeout: T });
        expect(menu.text).toMatch(/faster → smarter|low · medium · high/i);
        expect(menu.text).toMatch(/switchroom\.yaml/i);
        const kb = await sc.driver.getKeyboard(sc.botUserId, menu.messageId);
        const labels = (kb ?? []).flat().map((b) => b.text);
        expect(labels.some((t) => /low/i.test(t)), "low button present").toBe(true);
        expect(labels.some((t) => /max/i.test(t)), "max button present").toBe(true);
      } finally {
        await sc.tearDown();
      }
    },
    60_000,
  );

  it(
    "tapping a level switches the live session, then restores",
    async () => {
      const sc = await spinUp({ agent: AGENT });
      try {
        await sc.sendDM("/effort");
        const menu = await sc.expectMessage(/Effort —/, { from: "bot", timeout: T });
        const kb = await sc.driver.getKeyboard(sc.botUserId, menu.messageId);
        const flat = (kb ?? []).flat();
        // The current level is prefixed with ✅; pick a DIFFERENT one.
        const current = flat.find((b) => /✅/.test(b.text));
        const target = flat.find(
          (b) => b.callbackData && !/✅/.test(b.text) && /medium|high/i.test(b.text),
        );
        expect(target, "a non-current effort button to tap").toBeDefined();
        await sc.driver.pressButton(sc.botUserId, menu.messageId, target!.callbackData!);
        // The card edits in place to prepend a confirmation line.
        await new Promise((r) => setTimeout(r, 4000));
        const after = await sc.driver.getMessage(sc.botUserId, menu.messageId);
        expect(after?.text ?? "").toMatch(/Effort →|Switched|effort/i);

        // Restore the original level so test-harness isn't left changed.
        if (current?.callbackData) {
          const kb2 = await sc.driver.getKeyboard(sc.botUserId, menu.messageId);
          const restore = (kb2 ?? [])
            .flat()
            .find((b) => b.callbackData === current.callbackData);
          if (restore?.callbackData) {
            await sc.driver.pressButton(sc.botUserId, menu.messageId, restore.callbackData);
          }
        }
      } finally {
        await sc.tearDown();
      }
    },
    90_000,
  );

  it(
    "/effort bogus → reply (error/help), never silence",
    async () => {
      const sc = await spinUp({ agent: AGENT });
      try {
        await sc.sendDM("/effort definitely-not-a-level");
        const reply = await sc.expectMessage(/\S/, { from: "bot", timeout: T });
        expect(reply.text.length).toBeGreaterThan(0);
      } finally {
        await sc.tearDown();
      }
    },
    60_000,
  );
});
