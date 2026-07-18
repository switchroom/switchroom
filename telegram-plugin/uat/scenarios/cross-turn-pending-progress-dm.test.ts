/**
 * Cross-turn pending-async progress — UAT regression gate for #1445.
 *
 * Verifies the post-fix behaviour shipped in `pending-work-progress.ts`:
 * when a turn ends with the model having dispatched async background
 * work (here `Bash` with `run_in_background:true`) and the model has
 * stopped speaking, the framework keeps editing the model's last reply
 * *in place* at ~60s intervals so the user sees ambient liveness during
 * the wait.
 *
 * ## Pre-fix behaviour (what the user complained about)
 *
 * 1. User sends a long-task prompt at t=0.
 * 2. Model runs the bash command with `run_in_background:true` and
 *    sends one PING reply at ~+20s ("Background sleep running…").
 * 3. Turn ends.
 * 4. Silence-poke ladder is per-turn — it stops the moment endTurn()
 *    fires. There is no cross-turn ambient surface.
 * 5. The user sees NOTHING for ~5 min until the framework's 300s
 *    silence-poke fallback fires (or — as observed in the UAT that
 *    drove the fix — does not fire at all, because the turn already
 *    ended). Production data confirms: silence-poke succeeded/fired
 *    rate is 0–7% across hundreds of fires.
 *
 * ## Post-fix behaviour (this scenario asserts)
 *
 * 1. Model sends one fresh reply at ~+20s — the anchor.
 * 2. Turn ends.
 * 3. Framework edits the anchor in place at ~+80s, ~+140s, ~+200s,
 *    ~+260s, ~+320s with the suffix `\n\n— still working (Nm)`.
 * 4. All edits are SILENT (`disable_notification: true` on the edit
 *    or, equivalently, an edit which never pushes a notification).
 *    The user sees ambient liveness without any added pings.
 * 5. Sleep completes ~+350s; the model wakes (`BashOutput` /
 *    background-task notification path), turn re-starts,
 *    `clearPending` fires — no further edits.
 *
 * ## What this scenario asserts
 *
 *   1. At least one FRESH bot message lands (the initial anchor).
 *   2. At least one EDIT to the anchor lands AFTER the initial reply,
 *      whose text contains the framework suffix `— still working (\d+m)`.
 *   3. Every observed EDIT message is `silent === true` (no push
 *      notification fired by the in-place edit).
 *   4. Edits are anchored to the SAME `messageId` as the initial
 *      fresh reply (single in-place surface, not spammy new sends).
 *
 * The full per-message trail is dumped to console for forensic
 * inspection regardless of pass / fail.
 *
 * Wall-clock budget: ~8 min.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";
import type { ObservedMessage } from "../driver.js";

const SLEEP_SECONDS = 350;

// Engineered to elicit the natural production pattern: the model
// sends a quick ack reply ("on it — background sleep running"),
// dispatches the sleep as a background Bash, ends its turn, then
// returns with "done" once the sleep completes. The framework
// fix-under-test owns the in-between ambient.
const PROMPT =
  `Please run \`sleep ${SLEEP_SECONDS}\` in the background using the ` +
  `Bash tool with \`run_in_background: true\` — this is a stress ` +
  `test of the cross-turn ambient progress surface, so the sleep ` +
  `duration matters. Send a brief one-line acknowledgement that ` +
  `you've dispatched it (your natural beat-1 ack is fine), then ` +
  `wait for it to complete. When it finishes, reply with exactly ` +
  `the single word "done".`;

const OVERALL_DEADLINE_MS = (SLEEP_SECONDS + 240) * 1000;

interface TrailEntry {
  relMs: number;
  kind: "fresh" | "edit";
  silent: boolean;
  messageId: number;
  text: string;
}

// Mirrors the production matcher (`pending-work-progress.ts` SUFFIX_RE):
// the CURRENT emit is the italic rich-markdown form
// `\n\n_still working (Nm) · message me anytime, I'll keep you posted_`
// (#2669) — mtcute's parsed `Message.text` strips the italic markers, so
// the observed text is `\n\nstill working (Nm) · …`. The legacy em-dash
// prefix (`— still working`) and a literal-underscore render are also
// tolerated. The old mandatory-em-dash regex could not match ANY current
// production edit (stale oracle, diagnosed 2026-07-18).
const SUFFIX_RE =
  /\n\n(?:— |_)?still working \(\d+m\)( · message me anytime, I'll keep you posted)?_?$/;

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

describe("uat: cross-turn pending-async ambient progress (#1445)", () => {
  it(
    "framework edits the anchor in place during a 350s background bash",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        const startedAt = Date.now();
        await sc.sendDM(PROMPT);
        console.log(`[cross-turn-pending] t=0 prompt sent`);

        const trail: TrailEntry[] = [];

        // Initial wait window — give the model 90s to send its first
        // anchor reply. After that, we observe edits for the full
        // sleep duration plus headroom; once the model's final fresh
        // "done" lands we wind down within 10s.
        let quiescenceDeadline = startedAt + 90_000;
        const overallDeadline = startedAt + OVERALL_DEADLINE_MS;
        let firstAnchorMsgId: number | null = null;
        let sawDone = false;

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
              text: msg.text,
            };
            trail.push(entry);
            console.log(
              `[cross-turn-pending] +${(rel / 1000).toFixed(1)}s ` +
                `${entry.kind.toUpperCase()} msg=${entry.messageId} ` +
                `silent=${entry.silent} text=${JSON.stringify(
                  entry.text.slice(0, 120).replace(/\n/g, " ⏎ "),
                )}`,
            );
            if (firstAnchorMsgId == null && entry.kind === "fresh") {
              firstAnchorMsgId = entry.messageId;
            }
            // EXACT match only. The prompt demands the completion signal be
            // the single word "done" and nothing else; the loose `/\bdone\b/`
            // fallback false-positived on the model's beat-1 ACK ("…I'll
            // reply \"done\" when it finishes"), tripping a 10s wind-down that
            // quit the test ~22s BEFORE the turn even ended — so the ambient
            // edit mechanism was never observable (#3334 item b, observed UAT
            // v0.18.32 r2). Requiring `trim() === "done"` makes the terminal
            // signal deterministic and un-spoofable by an ack that merely
            // mentions the word.
            const trimmedFinal = entry.text.trim().toLowerCase();
            const looksLikeDone =
              entry.kind === "fresh" &&
              entry.messageId !== firstAnchorMsgId &&
              trimmedFinal === "done";
            if (looksLikeDone) {
              sawDone = true;
              quiescenceDeadline = Date.now() + 10_000;
            } else {
              // Generous quiescence so we cover the whole sleep window
              // plus a 90s headroom for the model's wake + final reply.
              quiescenceDeadline = Date.now() + 120_000;
            }
          } catch {
            // Timed out — quiescence reached.
            break;
          }
        }

        // Dump full trail.
        console.log(
          "\n========== CROSS-TURN PENDING-PROGRESS TRAIL ==========",
        );
        console.log(`prompt: ${SLEEP_SECONDS}s background bash`);
        console.log(`total bot messages observed: ${trail.length}`);
        console.log(`anchor messageId: ${firstAnchorMsgId}`);
        console.log(`saw_done: ${sawDone}`);
        console.log("");
        console.log("  rel(s)   kind   silent  msg          text");
        console.log("  -------  -----  ------  -----------  ----");
        for (const e of trail) {
          console.log(
            `  ${pad((e.relMs / 1000).toFixed(1) + "s", 8)} ` +
              `${pad(e.kind, 6)} ${pad(String(e.silent), 7)} ` +
              `${pad(String(e.messageId), 12)} ` +
              `${e.text.slice(0, 80).replace(/\n/g, " ⏎ ")}`,
          );
        }
        console.log(
          "=======================================================\n",
        );

        // ── Regression assertions ─────────────────────────────────

        // (1) at least one fresh anchor reply landed
        const fresh = trail.filter((e) => e.kind === "fresh");
        expect(
          fresh.length,
          `no fresh bot replies observed — agent isn't responding`,
        ).toBeGreaterThanOrEqual(1);
        expect(firstAnchorMsgId).not.toBeNull();

        // (2) at least one edit landed AFTER the initial anchor, and
        // its text carries the framework's "— still working (Nm)"
        // suffix. This is THE regression gate for the fix.
        const edits = trail.filter((e) => e.kind === "edit");
        const editsWithSuffix = edits.filter((e) => SUFFIX_RE.test(e.text));
        expect(
          editsWithSuffix.length,
          `no in-place edits with the "— still working (Nm)" suffix ` +
            `landed during the ${SLEEP_SECONDS}s background bash. ` +
            `Total edits observed: ${edits.length}. The cross-turn ` +
            `pending-progress fix is not active — see ` +
            `\`pending-work-progress.ts\` and the gateway hooks at ` +
            `\`noteAsyncDispatch\` / \`noteOutbound\` / \`noteTurnEnd\`. ` +
            `Pre-fix this number is zero by construction.`,
        ).toBeGreaterThanOrEqual(1);

        // (3) every observed edit is silent (an edit never pings per
        // Telegram semantics; we double-check via the receiving-side
        // flag so any framework regression that switched to fresh
        // sends fails loudly).
        const loudEdits = edits.filter((e) => !e.silent);
        expect(
          loudEdits.length,
          `${loudEdits.length} edit(s) pinged the device — edits ` +
            `should never fire a notification.`,
        ).toBe(0);

        // (4) every edit is anchored to the same messageId as the
        // initial fresh anchor — the framework is editing ONE
        // surface, not spamming.
        const offAnchorEdits = edits.filter(
          (e) => e.messageId !== firstAnchorMsgId,
        );
        expect(
          offAnchorEdits.length,
          `${offAnchorEdits.length} edit(s) were anchored to a ` +
            `different message id than the initial reply ` +
            `(${firstAnchorMsgId}). The framework should edit a ` +
            `single anchor in place, not a chain of messages.`,
        ).toBe(0);
      } finally {
        await sc.tearDown();
      }
    },
    OVERALL_DEADLINE_MS + 60_000,
  );
});
