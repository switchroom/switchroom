/**
 * JTBD — always-on in a supergroup: a message sent into a forum topic WHILE the
 * agent is restarting must still be answered IN the group (the channel twin of
 * jtbd-message-during-restart-dm). Regression gate for v0.14.48 / #2117, proving
 * the restart-redeliver rescue is keyed per (chat, thread) so DM and supergroup
 * topics recover identically.
 *
 * Self-skips green when SWITCHROOM_UAT_CHAT_ID is unset or the chat isn't a
 * resolvable forum supergroup the driver is in (uat/** is excluded from gating
 * CI). mtcute caveat: no forum-topic create API, so this uses the supergroup's
 * General topic — it proves DM-vs-channel routing, not "correct topic among
 * many" (pinned by the gateway unit thread-assertions).
 */

import { describe, it, expect } from "vitest";
import { execSync, spawn } from "node:child_process";
import { spinUp } from "../harness.js";
import { expectMessage } from "../assertions.js";

const AGENT = "test-harness";
const SUPERGROUP_ID = Number.parseInt(process.env.SWITCHROOM_UAT_CHAT_ID ?? "", 10);
const BOOT_SEND_DELAY_MS = Number.parseInt(
  process.env.SWITCHROOM_UAT_BOOT_SEND_DELAY_MS ?? "12000",
  10,
);
const REPLY_BUDGET_MS = 180_000;

function canShellSudo(): boolean {
  try {
    execSync("sudo -n true", { stdio: "ignore", timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

function kickRestartDetached(name: string): void {
  const child = spawn(
    "sudo",
    ["-n", "env", `PATH=${process.env.PATH}`, `HOME=${process.env.HOME}`,
      "switchroom", "agent", "restart", name, "--force"],
    { detached: true, stdio: "ignore" },
  );
  child.unref();
}

const sudoOk = canShellSudo();

(sudoOk ? describe : describe.skip)("uat: message sent during a restart (supergroup)", () => {
  it(
    "a supergroup-topic message sent DURING the restart boot window is still answered in the group",
    async () => {
      if (!Number.isFinite(SUPERGROUP_ID)) {
        console.warn("[during-restart-channel] SWITCHROOM_UAT_CHAT_ID unset — skipping");
        return;
      }
      const sc = await spinUp({ agent: AGENT, settleMs: 0 });
      try {
        await sc.driver.primeDialogs();
        if (!(await sc.driver.canResolve(SUPERGROUP_ID))) {
          console.warn(
            `[during-restart-channel] supergroup ${SUPERGROUP_ID} not resolvable — skipping ` +
              `(ensure forum supergroup with Topics + driver is a member)`,
          );
          return;
        }

        const nonce = `bootsg-${Date.now().toString(36)}`;
        kickRestartDetached(AGENT);
        await new Promise((r) => setTimeout(r, BOOT_SEND_DELAY_MS));

        const sendStart = Date.now();
        await sc.driver.sendText(
          SUPERGROUP_ID,
          `You are being restart-tested in this group. Reply in this group with exactly this token and nothing else: ${nonce}`,
        );

        const reply = await expectMessage(
          sc.driver,
          SUPERGROUP_ID,
          (m) => m.text.includes(nonce),
          { timeout: REPLY_BUDGET_MS, senderFilter: { notUserId: sc.driverUserId } },
        );
        const ttfo = Date.now() - sendStart;
        console.warn(`[during-restart-channel] answered in ${ttfo}ms (nonce ${nonce})`);
        expect(reply.chatId).toBe(SUPERGROUP_ID);
        expect(reply.fromBot).toBe(true);
        expect(reply.text).toContain(nonce);
      } finally {
        await sc.tearDown();
      }
    },
    REPLY_BUDGET_MS + 60_000,
  );
});
