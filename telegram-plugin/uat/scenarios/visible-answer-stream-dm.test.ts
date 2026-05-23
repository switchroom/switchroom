/**
 * Visible answer-stream — UAT for the openclaw-pattern TTFO fix
 * (#869 Phase 1 narrow scope).
 *
 * Validates that when `SWITCHROOM_VISIBLE_ANSWER_STREAM=1` is set on
 * the target agent, the framework auto-renders the model's transcript
 * text as a user-visible edit-in-place message starting within ~5s of
 * inbound — instead of writing to Telegram's invisible compose-box
 * draft (the default #1664 behaviour).
 *
 * ## Required setup
 *
 * The target agent (default `test-harness`) MUST have
 * `SWITCHROOM_VISIBLE_ANSWER_STREAM=1` in its container environment.
 * Without that env var the scenario will (correctly) fail — the
 * default behaviour writes to a draft the mtcute driver cannot see.
 *
 * ## What this asserts
 *
 *   1. The first user-visible bot output (fresh `sendMessage`) lands
 *      within `VISIBLE_TTFO_BUDGET_MS` (default 8 s) of the inbound.
 *      Today's median TTFO across the fleet is 17–69 s; the visible
 *      lane should drop it well under 10 s for any reply long enough
 *      to emit a text chunk.
 *   2. The initial fresh message is silent (the answer-stream emits
 *      with `disable_notification: true` so mid-turn edits never ping).
 *   3. Subsequent edits land on the SAME message_id — single in-place
 *      surface, not a chain of pinged sends.
 *   4. At least one edit growth event happens between first send and
 *      turn-end (the streaming property — TTFO is fast, then content
 *      grows live).
 *
 * The captured trail is dumped to console for forensic inspection
 * regardless of pass/fail.
 *
 * Wall-clock budget: ~90 s.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";
import type { ObservedMessage } from "../driver.js";

const VISIBLE_TTFO_BUDGET_MS = 8_000;
const OVERALL_DEADLINE_MS = 90_000;
const QUIESCENCE_MS = 8_000;

// Prompt engineered to make the model emit a multi-sentence answer
// over a few seconds — long enough that the streaming behaviour
// is observable, short enough that turn-flush isn't tempted to fire.
// Deliberately does NOT instruct the model to call `reply` — we want
// to exercise the transcript-only path that the visible-answer-stream
// covers.
const PROMPT =
  `Please give a four-sentence overview of how Linux page-cache ` +
  `interacts with mmap on a typical x86_64 server. Reply in a single ` +
  `message, with substantive prose. No code blocks.`;

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

describe("uat: visible answer-stream — model transcript renders live (#869 Phase 1)", () => {
  it(
    "first fresh message lands within VISIBLE_TTFO_BUDGET_MS; subsequent edits grow it in place",
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

        // ── Regression assertions ─────────────────────────────────

        const fresh = trail.filter((e) => e.kind === "fresh");
        const edits = trail.filter((e) => e.kind === "edit");

        // (1) at least one fresh message landed
        expect(
          fresh.length,
          `no fresh bot replies observed — either the agent isn't ` +
            `responding OR the visible-answer-stream flag is OFF ` +
            `(SWITCHROOM_VISIBLE_ANSWER_STREAM not set on the target ` +
            `agent's container env). Re-check the agent's compose ` +
            `environment.`,
        ).toBeGreaterThanOrEqual(1);

        // (2) first fresh landed within the TTFO budget
        const ttfoMs = fresh[0].relMs;
        expect(
          ttfoMs,
          `TTFO ${ttfoMs}ms exceeded the visible-answer-stream ` +
            `budget of ${VISIBLE_TTFO_BUDGET_MS}ms. Either the model ` +
            `was unusually slow to emit its first text chunk, OR the ` +
            `visible answer-stream is not active. Default behaviour ` +
            `(invisible draft) would never have surfaced a fresh ` +
            `message at all, so the most likely cause is model latency.`,
        ).toBeLessThanOrEqual(VISIBLE_TTFO_BUDGET_MS);

        // (3) first fresh message was silent (mid-turn edits don't ping)
        expect(
          fresh[0].silent,
          `the first fresh message pinged the user — answer-stream ` +
            `should send silently (disable_notification:true). A ping ` +
            `here means an explicit \`reply\` tool may have fired instead.`,
        ).toBe(true);

        // (4) at least one in-place EDIT landed on the same messageId
        // (this is the "live streaming" assertion — TTFO is fast AND
        // content grows on the same surface, not a chain of new sends).
        const sameAnchorEdits = edits.filter(
          (e) => e.messageId === firstAnchorMsgId,
        );
        expect(
          sameAnchorEdits.length,
          `no in-place edits to the anchor message landed — the model ` +
            `either replied in a single shot (very short answer) or ` +
            `the streaming path isn't running. Edits observed: ` +
            `${edits.length}, on anchor: ${sameAnchorEdits.length}.`,
        ).toBeGreaterThanOrEqual(1);

        // (5) every edit is silent (Telegram edits don't push, but
        // we double-check via mtcute's flag in case the framework
        // ever swaps to a fresh-send pattern by accident)
        const loudEdits = edits.filter((e) => !e.silent);
        expect(
          loudEdits.length,
          `${loudEdits.length} edit(s) pinged the device.`,
        ).toBe(0);

        // (6) text length grows monotonically on the anchor (streaming
        // by construction — once content is on the anchor, it only
        // accumulates)
        const anchorTrail = trail.filter(
          (e) => e.messageId === firstAnchorMsgId,
        );
        for (let i = 1; i < anchorTrail.length; i++) {
          expect(
            anchorTrail[i].textLength,
            `anchor message #${firstAnchorMsgId} text shrank between ` +
              `events ${i - 1} (len=${anchorTrail[i - 1].textLength}) ` +
              `and ${i} (len=${anchorTrail[i].textLength}) — ` +
              `streaming text should only grow.`,
          ).toBeGreaterThanOrEqual(anchorTrail[i - 1].textLength);
        }
      } finally {
        await sc.tearDown();
      }
    },
    OVERALL_DEADLINE_MS + 30_000,
  );
});
