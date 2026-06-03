/**
 * JTBD — always-on: a message sent WHILE the agent is restarting must still be
 * answered (DM). Regression gate for the v0.14.48 / #2117 lost-message incident
 * (clerk/KenGPT, 2026-06-03).
 *
 * The wedge this guards: an inbound that arrives during a restart is buffered +
 * spool-persisted, then redelivered on bridge-up — but `bridge registered` is
 * not the same as `claude` session-ready. If claude is slow to boot (e.g. a
 * Hindsight MCP timeout) the redelivered inject hit a still-booting session and
 * was silently dropped; the 300s silence-poke then ended a phantom turn
 * (`drained_buffered=0/0`) and the message was gone. The fix re-enrols the
 * redelivered inbound in the deliver-until-acked queue so it re-delivers every
 * 5s until claude actually consumes it.
 *
 * Unlike `jtbd-always-on-after-restart-dm` (which sends ~5s AFTER the restart
 * returns, exercising the live path), this sends DURING the boot window so the
 * message goes through the restart-redeliver path the fix patches. The mtcute
 * driver sends straight to Telegram — independent of the agent's bridge — so the
 * message queues server-side and is delivered the moment the new gateway
 * reconnects.
 *
 * Self-skips green without NOPASSWD sudo (can't restart the agent).
 */

import { describe, it, expect } from "vitest";
import { execSync, spawn } from "node:child_process";
import { spinUp } from "../harness.js";

const AGENT = "test-harness";

// After kicking the restart, wait this long before sending — long enough that
// the reconcile + docker recreate have dropped the bridge, so the message
// buffers and is drained on bridge-up (the restart-redeliver path). Override
// for forensics (e.g. 6000 to land it deeper in the not-ready window so the
// strand-rescue sweep fires).
const BOOT_SEND_DELAY_MS = Number.parseInt(
  process.env.SWITCHROOM_UAT_BOOT_SEND_DELAY_MS ?? "12000",
  10,
);

// Generous: the fix re-delivers every 5s until claude is ready. The wedge
// symptom is ≥300s (silence-poke floor) or never — both fail this.
const REPLY_BUDGET_MS = 180_000;

function canShellSudo(): boolean {
  try {
    execSync("sudo -n true", { stdio: "ignore", timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

/** Kick a marker-safe restart and return immediately (detached). */
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

(sudoOk ? describe : describe.skip)("uat: message sent during a restart (DM)", () => {
  it(
    "a DM sent DURING the restart boot window is still answered (not lost)",
    async () => {
      const sc = await spinUp({ agent: AGENT, settleMs: 0 });
      try {
        const nonce = `bootdm-${Date.now().toString(36)}`;
        kickRestartDetached(AGENT);
        await new Promise((r) => setTimeout(r, BOOT_SEND_DELAY_MS));

        const sendStart = Date.now();
        await sc.sendDM(
          `You are being restart-tested. Reply with exactly this token and nothing else: ${nonce}`,
        );

        const reply = await sc.expectMessage((m) => m.text.includes(nonce), {
          from: "bot",
          timeout: REPLY_BUDGET_MS,
        });
        const ttfo = Date.now() - sendStart;
        console.warn(`[during-restart-dm] answered in ${ttfo}ms (nonce ${nonce})`);
        expect(reply.text).toContain(nonce);
      } finally {
        await sc.tearDown();
      }
    },
    REPLY_BUDGET_MS + 60_000,
  );
});
