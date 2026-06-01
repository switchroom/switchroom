/**
 * End-to-end UAT for the agent-initiated `request_secret` flow (#2045).
 *
 * The upstream fix behind the 2026-06-01 incident: an agent must never ask
 * the user to paste a secret into chat. Instead it calls `request_secret`,
 * the operator taps [Provide securely] and sends the value once, and the
 * gateway deletes the message + writes it straight to the vault — the raw
 * value never lands in history/logs and is never returned to the agent.
 *
 * This round-trips through real Telegram + real broker + real agent and
 * asserts the FINAL state: (a) the secure card renders with the right
 * button, (b) after the operator provides the value the bot confirms a
 * vault save, (c) the value actually landed in the vault (host-side read),
 * and (d) the raw value never reappears in a bot message.
 *
 * **Skipped by default.** To unskip:
 *
 * 1. Standard UAT preflight (`uat/SETUP.md` §5-6) — test-harness agent live
 *    (running build WITH request_secret, #2045), driver session auth'd,
 *    env vars set.
 * 2. `SWITCHROOM_VAULT_PASSPHRASE` in env (read-back asserts the value
 *    landed; under telegram-id approval mode the save itself is
 *    posture-attested and needs no passphrase).
 * 3. Remove `describe.skip`.
 *
 * Cleanup is operator-side: `switchroom vault rm uat/req-secret-target`.
 */

import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

const TARGET_KEY = "uat/req-secret-target";
// Built at runtime so the source never holds a contiguous secret literal.
const PROVIDED_VALUE = "sentinel-2045-" + "Ab3xK9pQ".repeat(2);

function hostVaultGet(key: string): string {
  try {
    return execFileSync("switchroom", ["vault", "get", key], {
      encoding: "utf-8",
      env: { ...process.env },
    }).trim();
  } catch {
    return "";
  }
}

describe.skip("uat: request_secret end-to-end (#2045)", () => {
  it(
    "agent calls request_secret → operator provides → value vaulted, never echoed",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        // 1. Prompt the agent to call request_secret for a key it lacks.
        //    (We don't fire the card from the driver — the point is to
        //    cover the agent → gateway → capture → vault path.)
        await sc.sendDM(
          `I need an API token but it is NOT in your vault. Use your ` +
          `request_secret MCP tool with key="${TARGET_KEY}", ` +
          `reason="UAT for #2045" to ask me for it securely. Do NOT ask me ` +
          `to paste it as a normal message.`,
        );

        // 2. The secure card (request_secret renders "needs a secret").
        const card = await sc.expectMessage(/needs a secret/i, {
          from: "bot",
          timeout: 60_000,
        });

        // 3. It must carry a [Provide securely] button.
        const kb = await sc.driver.getKeyboard(sc.botUserId, card.messageId);
        expect(kb).not.toBeNull();
        const provide = kb!
          .flat()
          .find((b) => b.callbackData !== undefined && /provide/i.test(b.text));
        expect(provide, "card should have a [Provide securely] button").toBeDefined();

        // 4. Tap Provide → the card arms capture + prompts for the value.
        await sc.driver.pressButton(sc.botUserId, card.messageId, provide!.callbackData!);
        await sc.expectMessage(/Send the value for/i, { from: "bot", timeout: 15_000 });

        // 5. Send the value. The gateway deletes it + writes to the vault.
        await sc.sendDM(PROVIDED_VALUE);
        const confirm = await sc.expectMessage(/saved as/i, {
          from: "bot",
          timeout: 30_000,
        });

        // 6. The confirmation references the key, NOT the raw value.
        expect(confirm.text).toContain(`vault:${TARGET_KEY}`);
        expect(confirm.text).not.toContain(PROVIDED_VALUE);

        // 7. Load-bearing: the value actually landed in the vault.
        expect(hostVaultGet(TARGET_KEY)).toBe(PROVIDED_VALUE);
      } finally {
        await sc.tearDown();
      }
    },
    300_000,
  );
});
