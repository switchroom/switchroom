/**
 * UAT — /model with LiteLLM sr-* (OpenRouter) model switching + spend tracking.
 *
 * Covers:
 *   1. /model menu shows section headers ("Claude (Max / Pro subscription)" and
 *      "OpenRouter / external") when sr-* models are available.
 *   2. Tapping an sr-* button switches the live session (text-inject path,
 *      not cursor-nav) and the confirmation banner appears.
 *   3. After switching, the agent replies on the new model, and LiteLLM
 *      spend logs show agent:test-harness attribution.
 *   4. Session resets to the configured model on restart (out of scope for
 *      this test — asserted in jtbd-always-on-after-restart-dm).
 *
 * Self-skips green when:
 *   - SWITCHROOM_UAT_DRIVER_SESSION is not set (no Telegram driver)
 *   - LiteLLM admin key unavailable (SWITCHROOM_UAT_LITELLM_ADMIN_KEY unset)
 *   - No sr-* buttons found in the menu (agent not LiteLLM-enabled or no
 *     sr-* models registered in LiteLLM)
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

const AGENT = "test-harness";
const LITELLM_URL = process.env.SWITCHROOM_UAT_LITELLM_URL ?? "http://127.0.0.1:4010";
const LITELLM_ADMIN_KEY = process.env.SWITCHROOM_UAT_LITELLM_ADMIN_KEY ?? "";

async function getLiteLLMSpendForAgent(agent: string): Promise<number> {
  if (!LITELLM_ADMIN_KEY) return -1;
  const res = await fetch(`${LITELLM_URL}/spend/tags`, {
    headers: { Authorization: `Bearer ${LITELLM_ADMIN_KEY}` },
  }).catch(() => null);
  if (!res?.ok) return -1;
  const tags: Array<{ individual_request_tag: string; log_count: number }> = await res.json();
  return tags.find((t) => t.individual_request_tag === `agent:${agent}`)?.log_count ?? 0;
}

describe("uat: /model sr-* LiteLLM routing — section headers + session switch + spend attribution", () => {
  it(
    "menu shows Claude/OpenRouter section headers, sr-* tap switches session and LiteLLM logs the request",
    async () => {
      const sc = await spinUp({ agent: AGENT });
      try {
        await sc.sendDM("/model");
        const menu = await sc.expectMessage(/Default \(new sessions\):/i, {
          from: "bot",
          timeout: 30_000,
        });

        // ── 1. Section headers ──────────────────────────────────────────
        const kb = await sc.driver.getKeyboard(sc.botUserId, menu.messageId);
        const flat = (kb ?? []).flat().filter((b) => b.callbackData);

        const claudeHeader = flat.find(
          (b) => b.text.includes("Claude") && b.text.includes("subscription") && b.callbackData === "mdl:h",
        );
        const openrouterHeader = flat.find(
          (b) => b.text.includes("OpenRouter") && b.callbackData === "mdl:h",
        );
        const srButton = flat.find((b) => b.callbackData?.startsWith("mdl:sr:"));

        if (!srButton) {
          console.log("No sr-* buttons in menu — agent not LiteLLM-enabled or no sr-* models registered. Skipping.");
          return;
        }

        expect(claudeHeader, "Claude (Max / Pro subscription) header row").toBeDefined();
        expect(openrouterHeader, "OpenRouter / external header row").toBeDefined();
        expect(menu.text).toContain("Max/Pro subscription");
        expect(menu.text).toContain("OpenRouter");

        // ── 2. sr-* switch ─────────────────────────────────────────────
        const spendBefore = await getLiteLLMSpendForAgent(AGENT);
        const srName = srButton.callbackData!.replace("mdl:sr:", "");

        await sc.driver.pressButton(sc.botUserId, menu.messageId, srButton.callbackData!);
        // Allow text-inject + claude's /model response to propagate
        await new Promise((r) => setTimeout(r, 8_000));

        const afterMenu = await sc.driver.getMessage(sc.botUserId, menu.messageId);
        expect(afterMenu?.text ?? "", "confirmation banner after sr-* tap").toMatch(
          /Set model to|Switched|session/i,
        );
        // Card must keep its buttons (#2270 — no dead card)
        const kbAfter = await sc.driver.getKeyboard(sc.botUserId, menu.messageId);
        expect((kbAfter ?? []).flat().length, "menu keeps buttons after sr-* tap").toBeGreaterThan(0);

        // ── 3. Send a quick message to generate a LiteLLM-routed turn ──
        await sc.sendDM("Just reply with the word OK.");
        await sc.expectMessage(/ok/i, { from: "bot", timeout: 60_000 });

        // ── 4. LiteLLM spend attribution ────────────────────────────────
        if (spendBefore >= 0) {
          // Give LiteLLM a moment to flush the log
          await new Promise((r) => setTimeout(r, 3_000));
          const spendAfter = await getLiteLLMSpendForAgent(AGENT);
          expect(spendAfter, `agent:${AGENT} log_count increased after turn`).toBeGreaterThan(spendBefore);
        }

        // ── Restore: switch back to configured model ────────────────────
        const currentKb = await sc.driver.getKeyboard(sc.botUserId, menu.messageId);
        const restoreBtn = (currentKb ?? []).flat().find(
          (b) => b.callbackData?.startsWith("mdl:s:") && /Default|Sonnet|claude-sonnet/i.test(b.text),
        );
        if (restoreBtn?.callbackData) {
          await sc.driver.pressButton(sc.botUserId, menu.messageId, restoreBtn.callbackData);
          await new Promise((r) => setTimeout(r, 4_000));
        }

        console.log(`✅ sr-* model switch (${srName}) verified end-to-end through LiteLLM`);
      } finally {
        await sc.tearDown();
      }
    },
    180_000,
  );

  it(
    "header row tap shows toast without switching model or opening picker",
    async () => {
      const sc = await spinUp({ agent: AGENT });
      try {
        await sc.sendDM("/model");
        const menu = await sc.expectMessage(/Default \(new sessions\):/i, {
          from: "bot",
          timeout: 30_000,
        });
        const kb = await sc.driver.getKeyboard(sc.botUserId, menu.messageId);
        const flat = (kb ?? []).flat();
        const headerBtn = flat.find((b) => b.callbackData === "mdl:h");
        if (!headerBtn) {
          console.log("No header row — agent not LiteLLM-enabled. Skipping.");
          return;
        }
        // Pressing the header should NOT change the menu text
        const textBefore = menu.text;
        await sc.driver.pressButton(sc.botUserId, menu.messageId, "mdl:h");
        await new Promise((r) => setTimeout(r, 3_000));
        const after = await sc.driver.getMessage(sc.botUserId, menu.messageId);
        expect(after?.text ?? "").toBe(textBefore);
      } finally {
        await sc.tearDown();
      }
    },
    60_000,
  );
});
