/**
 * JTBD scenario — reflective status reaction (#1713).
 *
 * Serves the JTBD "know what my agent is actually doing" (see
 * `reference/know-what-my-agent-is-doing.md`). The status reaction on
 * the user's inbound is the *primary* ambient liveness signal — the
 * user reads it as "what is the agent doing right now". When it
 * collapses straight to 👍 mid-turn, the signal evaporates and the
 * user is left wondering whether the agent is still working.
 *
 * #1713 defect: plain `reply` and `stream_reply done=true` were both
 * firing the terminal 👍 immediately, regardless of whether the turn
 * had actually ended (the model often continues with tools after a
 * mid-turn ack or a stream-finalized answer). The fix makes the
 * controller reflective:
 *
 *   - Working states (🤔, ✍, 👨‍💻, ⚡, 🗜) are bidirectional and may
 *     re-enter any number of times within a turn.
 *   - Mid-turn replies (ack or final) are non-events for the reaction.
 *   - 🔥 / 😱 is non-terminal — recovery to a working state is allowed.
 *   - Only the `turn_end` IPC event (Stop hook) finalizes to 👍.
 *   - Rapid state flips coalesce via a 3-5s debounce window.
 *
 * This JTBD test asserts the controller contract end-to-end at the
 * gateway-wiring level (via the StatusReactionController itself —
 * the wiring is exhaustively covered by gateway integration tests
 * and the unit suite at `telegram-plugin/tests/status-reactions.test.ts`).
 * A live-Telegram harness UAT was considered but is poor value for
 * this contract: real Bot-API reactions only expose the *current*
 * emoji, not the full transition trail, so the unit-suite assertion
 * shape is strictly more powerful. Live-harness coverage can be
 * added as a follow-up once Bot-API reaction-history surfaces.
 *
 * Acceptance criteria (mapped from #1713 issue body):
 *   1. Reply does NOT advance reaction to 👍.
 *   2. Bidirectional transitions: thinking → tool → thinking works.
 *   3. Only turn_end produces 👍.
 *   4. Debounce coalesces rapid flips.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StatusReactionController } from "../../status-reactions.js";

function makeEmitter() {
  const calls: string[] = [];
  const emit = vi.fn(async (emoji: string) => {
    calls.push(emoji);
  });
  return { emit, calls };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

describe("uat-jtbd: reflective status reaction (#1713)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // ── AC1 ──────────────────────────────────────────────────────────────
  it("AC1: mid-turn reply does NOT advance reaction to 👍", async () => {
    // Simulate a turn that:
    //   1. Receives an inbound (👀).
    //   2. The model thinks (🤔).
    //   3. The model sends a reply mid-turn (NON-EVENT — no controller call).
    //   4. The model continues with a tool call (👨‍💻).
    //   5. turn_end finalizes (👍).
    const { emit, calls } = makeEmitter();
    const ctrl = new StatusReactionController(emit);

    ctrl.setQueued(); // 👀
    await flush();

    ctrl.setThinking(); // → 🤔 (debounced)
    vi.advanceTimersByTime(3500);
    await flush();

    // Mid-turn reply happens here — gateway does NOT call any controller
    // method. The reaction must remain on 🤔.
    expect(calls).toEqual(["👀", "🤔"]);

    // Model continues working post-reply.
    ctrl.setTool("Bash"); // → 👨‍💻 (debounced)
    vi.advanceTimersByTime(3500);
    await flush();
    expect(calls).toEqual(["👀", "🤔", "👨‍💻"]);

    // turn_end is the only terminal trigger.
    ctrl.finalize("done");
    await flush();
    expect(calls).toEqual(["👀", "🤔", "👨‍💻", "👍"]);
  });

  // ── AC2 ──────────────────────────────────────────────────────────────
  it("AC2: bidirectional transitions — thinking → tool → thinking re-enters", async () => {
    const { emit, calls } = makeEmitter();
    const ctrl = new StatusReactionController(emit);
    ctrl.setQueued();
    await flush();

    ctrl.setThinking();
    vi.advanceTimersByTime(3500);
    await flush();
    expect(calls).toEqual(["👀", "🤔"]);

    ctrl.setTool("Read"); // → 👨‍💻 (coding family)
    vi.advanceTimersByTime(3500);
    await flush();
    expect(calls).toEqual(["👀", "🤔", "👨‍💻"]);

    // Back to thinking. The same state may re-enter; controller is
    // reflective, not a one-way ratchet.
    ctrl.setThinking();
    vi.advanceTimersByTime(3500);
    await flush();
    expect(calls).toEqual(["👀", "🤔", "👨‍💻", "🤔"]);

    // And a non-terminal 😱 mid-turn (e.g. transient 5xx) must permit
    // recovery to a working state.
    ctrl.setError();
    vi.advanceTimersByTime(3500);
    await flush();
    expect(calls).toEqual(["👀", "🤔", "👨‍💻", "🤔", "😱"]);

    ctrl.setTool("WebFetch"); // recovery → ⚡
    vi.advanceTimersByTime(3500);
    await flush();
    expect(calls).toEqual(["👀", "🤔", "👨‍💻", "🤔", "😱", "⚡"]);
  });

  // ── AC3 ──────────────────────────────────────────────────────────────
  it("AC3: only turn_end (finalize) produces 👍", async () => {
    const { emit, calls } = makeEmitter();
    const ctrl = new StatusReactionController(emit);
    ctrl.setQueued();
    await flush();

    // Many working transitions; never call finalize. The reaction must
    // not land on 👍.
    for (let i = 0; i < 5; i++) {
      ctrl.setThinking();
      vi.advanceTimersByTime(3500);
      await flush();
      ctrl.setTool("Bash");
      vi.advanceTimersByTime(3500);
      await flush();
    }
    expect(calls).not.toContain("👍");

    // turn_end fires → 👍 finally lands.
    ctrl.finalize("done");
    await flush();
    expect(calls[calls.length - 1]).toBe("👍");
  });

  // ── AC4 ──────────────────────────────────────────────────────────────
  it("AC4: 3500ms debounce coalesces rapid state flips into one emit", async () => {
    const { emit, calls } = makeEmitter();
    const ctrl = new StatusReactionController(emit);
    ctrl.setQueued();
    await flush();

    // Rapid flip storm — 10 transitions within ~2s.
    for (let i = 0; i < 10; i++) {
      if (i % 2 === 0) ctrl.setThinking();
      else ctrl.setTool("Bash");
      vi.advanceTimersByTime(200);
    }
    await flush();

    // Debounce hasn't elapsed — only the queued emoji has landed.
    expect(calls).toEqual(["👀"]);

    // After the window closes, only the LAST state lands.
    vi.advanceTimersByTime(3500);
    await flush();
    // Last call was setTool('Bash') on odd index — last index is 9 (odd).
    expect(calls).toEqual(["👀", "👨‍💻"]);
  });

  // ── AC5: terminal flushes any pending debounced state ────────────────
  it("AC5: finalize() flushes a pending working state before emitting 👍", async () => {
    // F1 guarantee (#553) — preserved through #1713. If the turn ends
    // while a non-terminal reaction is mid-debounce, the pending state
    // must land BEFORE the terminal so the user sees the working
    // signal rather than a 👀 → 👍 collapse.
    const { emit, calls } = makeEmitter();
    const ctrl = new StatusReactionController(emit);
    ctrl.setQueued();
    await flush();

    ctrl.setThinking(); // pending — debounce window open
    // Turn ends before debounce elapses.
    ctrl.finalize("done");
    await flush();
    expect(calls).toEqual(["👀", "🤔", "👍"]);
  });
});
