/**
 * JTBD: "talking to my agent feels like talking to a capable person."
 * Conversational-pacing beat 4 — the sub-agent handback.
 *
 * The gap this closes: a *background* sub-agent finishes decoupled from
 * any turn boundary. The parent agent is idle when it completes, with no
 * turn to receive the result — so without a deterministic nudge the user
 * never hears back until they send the next message themselves. The
 * agent looks like it dropped the delegated work on the floor.
 *
 * The fix (Option B): the gateway's subagent-watcher `onFinish` fires a
 * `subagent_handback` inbound carrying the worker's result; the idle
 * agent wakes and synthesises a user-facing handback in its own voice.
 *
 * What this scenario asserts: after the parent dispatches a background
 * worker and ends its turn, a SECOND, unprompted bot message arrives —
 * the handback — without the driver sending anything further. That
 * second message is the whole point: proactive "the worker's done,
 * here's what it found".
 *
 * Prompt strategy: explicit tool-naming (Option 1, mirroring
 * `bg-sub-agent-dispatch-dm.test.ts`) — the scenario verifies the
 * handback INFRA, not the model's delegation judgment, so the dispatch
 * is pinned deterministic.
 *
 * Requires the standard DM-scenario env (see uat/SETUP.md §3-6). The
 * test-harness override `SWITCHROOM_SUBAGENT_STALL_*` (switchroom.yaml)
 * compresses the watcher's terminal-synthesis window so a background
 * worker that never writes an explicit `turn_end` still terminates
 * (and hands back) within the scenario budget instead of 5 min.
 */

import { describe, expect, it } from "vitest";
import { spinUp } from "../harness.js";

const BG_DISPATCH_PROMPT =
  `Use the Agent tool with subagent_type "general-purpose" and ` +
  `run_in_background: true to dispatch a worker with this exact task: ` +
  `"Run \`echo HANDBACK-PROBE-OK\` via the Bash tool, then return a ` +
  `one-line summary of what you did." After dispatching, send me a ` +
  `brief one-line reply saying you have kicked off the background ` +
  `worker, then END YOUR TURN — do NOT wait for the worker and do NOT ` +
  `do the echo yourself.`;

describe("uat: sub-agent handback — proactive beat-4 communication", () => {
  it(
    "delivers an unprompted handback message after a background worker finishes",
    async () => {
      const sc = await spinUp({ agent: "test-harness" });
      try {
        await sc.sendDM(BG_DISPATCH_PROMPT);

        // Beat 1/5 of the dispatch turn: the parent acks that it kicked
        // off the worker, then ends its turn. Generous timeout — a cold
        // first turn plus the Agent dispatch can run long.
        const ack = await sc.expectMessage(/.+/, {
          from: "bot",
          timeout: 60_000,
        });
        expect(ack.messageId).toBeGreaterThan(0);

        // THE TEST: a second, distinct bot message arrives — the
        // handback — WITHOUT the driver sending anything further. This
        // is the deterministic beat-4 win: the watcher's onFinish fired
        // a `subagent_handback` inbound, the idle agent woke, and it
        // synthesised a user-facing report.
        //
        // Match: a bot message that is NOT the ack and reads like a
        // completion report. The handback inbound steers the model to
        // report what the worker found; we accept any of the natural
        // wordings rather than pinning exact prose (the model owns the
        // words — determinism contract).
        const handback = await sc.expectMessage(
          (m) =>
            m.messageId !== ack.messageId &&
            /\b(done|finished|complete|completed|wrapped up|worker|back|result)\b/i.test(
              m.text,
            ),
          { from: "bot", timeout: 180_000 },
        );

        expect(handback.messageId).not.toBe(ack.messageId);
        // The handback must be a real synthesised message, not an echo
        // of the raw `<channel source="subagent_handback">` envelope or
        // the steering text verbatim.
        expect(handback.text).not.toMatch(/<channel/i);
        expect(handback.text).not.toMatch(/source="subagent_handback"/i);
        expect(handback.text.length).toBeGreaterThan(0);
      } finally {
        await sc.tearDown();
      }
    },
    240_000,
  );
});
