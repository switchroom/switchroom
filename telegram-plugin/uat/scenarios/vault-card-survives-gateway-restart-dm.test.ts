/**
 * UAT scenario named by `reference/jobs/approve-what-my-agent-can-touch.md`
 * § Prove it — "Card survives a gateway restart (DM)".
 *
 * Contract under test (#2989 durability fix): an agent-initiated
 * `vault_request_access` card issued BEFORE a gateway restart is still
 * tappable AFTER it. The gateway persists card metadata to the durable
 * pending-card store, restores it on boot, and a tap on the still-valid card
 * grants and resumes the parked agent exactly like a pre-restart tap —
 * never the "Card expired — ask the agent to re-request" tombstone while the
 * agent is parked and structurally cannot re-request.
 *
 * Load-bearing assertions:
 *   1. The post-restart tap does NOT produce the expired-card tombstone edit.
 *   2. The approve flow completes (passphrase → Granted card edit).
 *   3. The parked agent resumes on the grant with no driver nudge.
 *
 * **Skipped by default.** To unskip:
 *
 *   1. Standard UAT preflight (`uat/SETUP.md` §5-6).
 *   2. NOPASSWD sudo on the runner host (the scenario restarts test-harness).
 *   3. `TELEGRAM_UAT_VAULT_PASSPHRASE` set in env.
 *   4. Pre-create a sacrificial vault key:
 *
 *      ```bash
 *      TMPF=$(mktemp) && printf '%s' 'sentinel-2989-value' > "$TMPF" && \
 *        switchroom vault set uat/card-survives-restart --file "$TMPF" \
 *          --format string ; shred -u "$TMPF"
 *      ```
 *
 *   5. Remove `describe.skip` below.
 *
 * Why skipped: mutates vault state (mints a grant) and bounces the harness
 * agent. Cleanup is operator-side (`switchroom vault revoke <grant-id>`).
 *
 * Module-level twin (every CI run): the restart round-trip in
 * `tests/approval-card-restart-outcome.test.ts` and the store contract in
 * `tests/pending-card-store.test.ts`.
 */

import { describe, expect, it } from "vitest";
import { execSync, spawn } from "node:child_process";
import { spinUp } from "../harness.js";

const AGENT = "test-harness";
const KEY = "uat/card-survives-restart";
const CARD_BUDGET_MS = 120_000;
const BOOT_BUDGET_MS = 180_000;
const RESUME_BUDGET_MS = 180_000;

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

describe.skip("uat: approval card survives a gateway restart (DM, #2989)", () => {
  it(
    "card issued pre-restart is tappable post-restart: grant lands and the agent resumes",
    async () => {
      if (!canShellSudo()) {
        throw new Error("NOPASSWD sudo required — see header to set up.");
      }
      const passphrase = process.env.TELEGRAM_UAT_VAULT_PASSPHRASE;
      if (!passphrase) {
        throw new Error(
          "TELEGRAM_UAT_VAULT_PASSPHRASE must be set in env (see uat/SETUP.md).",
        );
      }
      const sc = await spinUp({ agent: AGENT, settleMs: 0 });
      try {
        // 1. Park the agent on an approval card.
        await sc.sendDM(
          `Please call your vault_request_access MCP tool for the key ` +
          `\`${KEY}\` (scope read, 30d, reason "UAT #2989 card durability"). ` +
          `END YOUR TURN cleanly and wait; when the operator approves, resume ` +
          `by running \`switchroom vault get ${KEY}\` and reporting success.`,
        );
        const card = await sc.expectMessage(/wants vault access/, {
          from: "bot",
          timeout: CARD_BUDGET_MS,
        });

        // 2. Bounce the gateway BEFORE anyone taps.
        kickRestartDetached(AGENT);
        await new Promise((r) => setTimeout(r, BOOT_BUDGET_MS));

        // 3. Tap Approve on the ORIGINAL, pre-restart card message.
        const kb = await sc.driver.getKeyboard(sc.botUserId, card.messageId);
        const approveButton = kb!
          .flat()
          .find((b) => b.callbackData !== undefined && /approve/i.test(b.text));
        expect(approveButton).toBeDefined();
        await sc.driver.pressButton(
          sc.botUserId,
          card.messageId,
          approveButton!.callbackData!,
        );

        // 4. The restored card must run the REAL approve flow — the expired
        //    tombstone ("expired before you tapped") is the pre-#2989 defect.
        const next = await sc.expectMessage(
          (m) =>
            /Reply with your passphrase|Granted|expired before you tapped/i.test(m.text),
          { from: "bot", timeout: 60_000 },
        );
        expect(next.text).not.toMatch(/expired before you tapped/i);

        if (/passphrase/i.test(next.text)) {
          await sc.sendDM(passphrase);
        }

        // 5. Grant lands and the parked agent resumes without a nudge.
        //    Edits excluded — the "✅ Granted" edit of the card itself must
        //    not satisfy this; only a NEW message from the resumed turn does.
        const resumed = await sc.expectMessage(
          (m) => !m.edited && /(granted|access|vault get|succe)/i.test(m.text) && m.text.length > 40,
          { from: "bot", timeout: RESUME_BUDGET_MS },
        );
        expect(resumed.text.length).toBeGreaterThan(40);
      } finally {
        await sc.tearDown();
      }
    },
    CARD_BUDGET_MS + BOOT_BUDGET_MS + RESUME_BUDGET_MS + 120_000,
  );
});
