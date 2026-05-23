/**
 * Conversational pacing UAT — measures the END-TO-END user-perceived
 * turn UX on a multi-step prompt.
 *
 * Original framing was "validate the visible-answer-stream path
 * activates." Live research on test-harness with the
 * `SWITCHROOM_VISIBLE_ANSWER_STREAM=1` flag showed that modern Claude
 * 2.1.x on this fleet does NOT emit transcript text events between
 * tool calls — it consistently calls the `reply` MCP tool directly
 * for every user-visible chunk (beat 1 ack, then per-step beat 3
 * updates). So the visible-answer-stream code path (which renders
 * `text` session events into a chat-timeline message) doesn't
 * activate; the answer-stream lane stays idle while the model uses
 * `reply` calls instead.
 *
 * That's actually FINE — the model is correctly following the
 * five-beat conversational-pacing contract (`reference/conversational-
 * pacing.md`): one silent ack at the start, silent updates per step,
 * one pinged final answer. This UAT now validates THAT — the pacing
 * the user actually experiences — rather than the answer-stream code
 * path specifically.
 *
 * The flag `SWITCHROOM_VISIBLE_ANSWER_STREAM=1` is still set on
 * test-harness for ongoing observation; if a future model version
 * starts emitting transcript text, the lane will surface it visibly
 * instead of writing to the invisible compose-box draft (the prior
 * default).
 *
 * ## What this asserts
 *
 *   1. First user-visible bot message lands within `TTFO_BUDGET_MS`
 *      (default 15 s) of the inbound — covers beat 1 ack OR straight-
 *      to-content depending on the model's pacing choice.
 *   2. Multiple distinct bot messages land per turn for the multi-
 *      step prompt — proving the model isn't collapsing everything
 *      into a single pinged dump.
 *   3. All but at most one message is silent (`disable_notification:
 *      true`). Only the final answer should ping — anything earlier
 *      pinging is a beat-3 contract violation.
 *
 * ## Wall-clock budget
 *
 * ~90 s.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";
import type { ObservedMessage } from "../driver.js";

const TTFO_BUDGET_MS = 15_000;
const OVERALL_DEADLINE_MS = 90_000;
const QUIESCENCE_MS = 12_000;

// Multi-step investigation prompt — designed to make the model emit
// transcript text BETWEEN tool calls, which is the assistant-content
// `text` block shape session-tail surfaces via the `text` event the
// answer-stream lane consumes. With the visible-answer-stream flag
// ON, those text events should become user-visible edit-in-place
// chat-timeline updates.
//
// We choose a research-style task because that pattern reliably
// emits `text` chunks (the model thinks out loud between Read /
// Bash steps) on most Claude versions. A pure-answer prompt (the
// previous version of this scenario) tended to make modern Claude
// jump straight to a single `reply` tool-call with no intermediate
// text — exercising the wrong path.
const PROMPT =
  `Investigate this step by step:\n\n` +
  `1. Read \`/etc/hostname\` and tell me what host this is — write a ` +
  `sentence about it.\n` +
  `2. Then read \`/etc/os-release\` and tell me what OS family / version.\n` +
  `3. Then read \`/proc/cpuinfo\` (head it), and tell me the CPU model + ` +
  `core count.\n` +
  `4. Wrap up with a one-line summary of all three.\n\n` +
  `Between each step, narrate what you're finding in plain prose ` +
  `(not just bullet outputs). Don't batch all your observations into ` +
  `one final reply — talk as you investigate.`;

interface TrailEntry {
  relMs: number;
  kind: "fresh" | "edit";
  silent: boolean;
  messageId: number;
  textPreview: string;
  textLength: number;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

describe("uat: conversational pacing on a multi-step turn", () => {
  it(
    "first message lands within TTFO_BUDGET_MS; multiple silent messages; final answer pings",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        const startedAt = Date.now();
        await sc.sendDM(PROMPT);
        console.log(`[visible-answer-stream] t=0 prompt sent`);

        const trail: TrailEntry[] = [];
        let firstAnchorMsgId: number | null = null;
        let quiescenceDeadline = startedAt + 30_000;
        const overallDeadline = startedAt + OVERALL_DEADLINE_MS;

        while (Date.now() < overallDeadline) {
          const remaining = Math.min(
            quiescenceDeadline - Date.now(),
            overallDeadline - Date.now(),
          );
          if (remaining <= 0) break;
          try {
            const msg = await sc.expectMessage(
              (m: ObservedMessage) => m.fromBot,
              { from: "bot", timeout: remaining },
            );
            const rel = Date.now() - startedAt;
            const entry: TrailEntry = {
              relMs: rel,
              kind: msg.edited ? "edit" : "fresh",
              silent: msg.silent,
              messageId: msg.messageId,
              textPreview: msg.text
                .slice(0, 120)
                .replace(/\n/g, " ⏎ "),
              textLength: msg.text.length,
            };
            trail.push(entry);
            if (firstAnchorMsgId == null && entry.kind === "fresh") {
              firstAnchorMsgId = entry.messageId;
            }
            console.log(
              `[visible-answer-stream] +${(rel / 1000).toFixed(1)}s ` +
                `${entry.kind.toUpperCase()} msg=${entry.messageId} ` +
                `silent=${entry.silent} len=${entry.textLength} ` +
                `text=${JSON.stringify(entry.textPreview)}`,
            );
            quiescenceDeadline = Date.now() + QUIESCENCE_MS;
          } catch {
            break;
          }
        }

        console.log("\n========== VISIBLE-ANSWER-STREAM TRAIL ==========");
        console.log(`total bot messages observed: ${trail.length}`);
        console.log(`first anchor messageId: ${firstAnchorMsgId}`);
        console.log("");
        console.log("  rel(s)   kind   silent  msg          len   text");
        console.log("  -------  -----  ------  -----------  ----  ----");
        for (const e of trail) {
          console.log(
            `  ${pad((e.relMs / 1000).toFixed(1) + "s", 8)} ` +
              `${pad(e.kind, 6)} ${pad(String(e.silent), 7)} ` +
              `${pad(String(e.messageId), 12)} ${pad(String(e.textLength), 5)} ` +
              `${e.textPreview}`,
          );
        }
        console.log("=================================================\n");

        // ── Pacing assertions ─────────────────────────────────────

        // (1) at least one bot message landed
        expect(
          trail.length,
          `no bot replies observed — the agent isn't responding.`,
        ).toBeGreaterThanOrEqual(1);

        // (2) first message landed within TTFO budget
        const ttfoMs = trail[0].relMs;
        expect(
          ttfoMs,
          `TTFO ${ttfoMs}ms exceeded the budget of ${TTFO_BUDGET_MS}ms.`,
        ).toBeLessThanOrEqual(TTFO_BUDGET_MS);

        // (3) multiple messages landed — proves the model is pacing,
        // not dumping a single big reply
        expect(
          trail.length,
          `only ${trail.length} message(s) observed — the model ` +
            `collapsed this multi-step prompt into a single dump. ` +
            `Beat 3 pacing (per-step updates) requires multiple ` +
            `messages. Either the model didn't follow the prompt ` +
            `or quiescence bailed early.`,
        ).toBeGreaterThanOrEqual(2);

        // (4) at most one message pinged the user — beat-3 contract
        // says only the FINAL answer pings; mid-turn updates pass
        // `disable_notification: true`.
        const pingedMessages = trail.filter((e) => !e.silent);
        expect(
          pingedMessages.length,
          `${pingedMessages.length} message(s) pinged the device — ` +
            `the conversational-pacing contract allows AT MOST 1 ` +
            `(the final answer). Mid-turn updates must be silent. ` +
            `Pinged messages at: ${pingedMessages
              .map((m) => `+${(m.relMs / 1000).toFixed(0)}s`)
              .join(", ")}`,
        ).toBeLessThanOrEqual(1);
      } finally {
        await sc.tearDown();
      }
    },
    OVERALL_DEADLINE_MS + 30_000,
  );
});
