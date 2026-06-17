/**
 * JTBD scenario — wake-audit content visibility post-restart.
 *
 * Serves: `reference/jobs/restart-and-know-what-im-running.md` — the JTBD:
 *
 *   *Outcome:* After any restart, the user is told what config is live.
 *   Model, tools, skills, memory backend, auth state. **No need to ask.**
 *
 *   *Stakes:* If the user has to probe to find out what they're talking
 *   to, they don't know what they're talking to. Agents drift silently,
 *   bad configs ship unnoticed, and trust leaks away a turn at a time.
 *
 * The existing `jtbd-always-on-after-restart-dm.test.ts` UAT validates
 * that the agent REPLIES post-restart. This one validates that the
 * agent's content reflects awareness of its own config — i.e. that
 * the wake-audit / boot card is doing its job.
 *
 * ## Soft contract (this version)
 *
 * The strictest contract — the JTBD's "no need to ask" — would require
 * observing a proactive wake-audit message immediately after restart
 * without any user prompt. That requires harness support for observing
 * `editMessageText` events (the boot card is an edit of a pinned
 * message, not a fresh send), which `mtcute` doesn't currently
 * surface in the same way as `sendMessage`.
 *
 * This UAT relaxes to: after restart, the user asks "what are you
 * running?" — the agent's reply must contain identifiable config
 * signals (model name OR "claude" OR an MCP server name OR "skill"
 * OR "memory" OR "switchroom"). A fully amnesiac agent that says
 * "I'm an AI assistant" would fail this.
 *
 * A FUTURE strict UAT should observe the boot card edit directly
 * — that's the true vision contract. This is the floor.
 */

import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { spinUp } from "../harness.js";

const AGENT = "test-harness";
const RESTART_BUDGET_MS = 90_000;
const REPLY_BUDGET_MS = 60_000;

// Config signals — at least ONE must appear in the agent's reply to
// the "what are you running" question. These cover:
//   - model identity (`claude`, `sonnet`, `opus`, `haiku`)
//   - tooling layer (`switchroom`, `mcp`, `tool`)
//   - capability surface (`skill`, `memory`, `hindsight`)
//   - operational state (`agent`, `running`, `version`)
const CONFIG_SIGNAL_REGEX =
  /\b(claude|sonnet|opus|haiku|switchroom|mcp|hindsight|skill|memory|agent|model|running|version)\b/i;

function canShellSudo(): boolean {
  try {
    execSync("sudo -n true", { stdio: "ignore", timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

function restartAgent(name: string): void {
  execSync(
    `sudo -n env PATH=$PATH HOME=$HOME switchroom agent restart ${name} --force`,
    { stdio: ["ignore", "pipe", "pipe"], timeout: RESTART_BUDGET_MS },
  );
}

const sudoOk = canShellSudo();

(sudoOk ? describe : describe.skip)(
  "uat: wake-audit content post-restart (restart-and-know JTBD)",
  () => {
    it(
      "agent describes its own config when asked post-restart",
      async () => {
        restartAgent(AGENT);
        // Settle for bridge re-attach.
        await new Promise((r) => setTimeout(r, 8_000));

        const sc = await spinUp({ agent: AGENT });
        try {
          await sc.sendDM(
            "Briefly: what model are you running, and what tools/skills do " +
            "you have available? One short paragraph is fine.",
          );

          const reply = await sc.expectMessage(/\S/, {
            from: "bot",
            timeout: REPLY_BUDGET_MS,
          });

          expect(reply.text.length).toBeGreaterThan(0);

          // The reply must include AT LEAST ONE config signal. A
          // generic "I'm an AI assistant ready to help" without any
          // model/tool reference would fail — that's the failure mode
          // we want to catch.
          const matchedSignal = CONFIG_SIGNAL_REGEX.exec(reply.text);
          if (matchedSignal == null) {
            throw new Error(
              `[wake-audit-content] CONTRACT FAILED: agent reply to ` +
              `"what are you running?" contained NO config signals ` +
              `(model, tools, skills, mcp, memory, etc.). The ` +
              `\`restart-and-know-what-im-running\` JTBD requires the ` +
              `user to know what's live without probing — at minimum ` +
              `the agent should respond to a direct question. Reply: ` +
              `${JSON.stringify(reply.text.slice(0, 400))}`,
            );
          }
          expect(matchedSignal).not.toBeNull();
          console.log(
            `[wake-audit-content] config signal "${matchedSignal[0]}" ` +
            `present in reply. Length=${reply.text.length}, snippet: ` +
            `${JSON.stringify(reply.text.slice(0, 120))}`,
          );

          // Optional: count how many distinct signals appeared. A
          // wake-audit-rich reply mentions several (model + skills +
          // mcp). A bare-minimum compliant reply mentions one.
          const allSignals =
            reply.text.match(new RegExp(CONFIG_SIGNAL_REGEX.source, "gi")) ?? [];
          const uniqueSignals = new Set(allSignals.map((s) => s.toLowerCase()));
          if (uniqueSignals.size < 2) {
            console.warn(
              `[wake-audit-content] only ${uniqueSignals.size} distinct ` +
              `config signal(s) present — reply meets the floor but ` +
              `is not config-rich. Vision target: model + tools + ` +
              `skills + memory all visible in the wake-audit.`,
            );
          } else {
            console.log(
              `[wake-audit-content] config-rich reply: ${uniqueSignals.size} ` +
              `distinct signals: ${Array.from(uniqueSignals).slice(0, 6).join(", ")}`,
            );
          }
        } finally {
          await sc.tearDown();
        }
      },
      RESTART_BUDGET_MS + 8_000 + REPLY_BUDGET_MS + 10_000,
    );
  },
);
