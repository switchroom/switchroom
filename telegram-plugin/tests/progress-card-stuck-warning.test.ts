/**
 * Tests for the stuck-warning rendered under the card header.
 *
 * Covers `docs/pinned-progress-card-reliability.md` §5 F10 and T6: when
 * the driver hasn't seen a real session event for 2+ minutes, the card
 * surfaces an early "⚠️ No events for …" warning so users aren't left
 * staring at a silently ticking elapsed-time counter until the zombie
 * ceiling force-closes.
 */

import { describe, it, expect } from "vitest";
import type { SessionEvent } from "../session-tail.js";
import {
  initialState,
  reduce,
  render,
  STUCK_THRESHOLD_MS,
} from "../progress-card.js";
import { createProgressDriver } from "../progress-card-driver.js";

function enqueue(chatId = "c1", text = "hi"): SessionEvent {
  return {
    kind: "enqueue",
    chatId,
    messageId: "1",
    threadId: null,
    rawContent: `<channel chat_id="${chatId}">${text}</channel>`,
  };
}

describe("render — stuck-warning", () => {
  // reduce() uses `turnStartedAt` of 0 as the "idle" sentinel, so enqueue
  // events need a non-zero clock to establish a real turn.
  const START = 1_000;

  it("does not render the warning before the threshold", () => {
    const s = reduce(initialState(), enqueue(), START);
    const html = render(s, START + STUCK_THRESHOLD_MS - 1, undefined, {
      stuckMs: STUCK_THRESHOLD_MS - 1,
    });
    expect(html).not.toContain("No events for");
  });

  it("renders the warning at or above the threshold", () => {
    const s = reduce(initialState(), enqueue(), START);
    const html = render(s, START + STUCK_THRESHOLD_MS, undefined, {
      stuckMs: STUCK_THRESHOLD_MS,
    });
    expect(html).toContain("⚠️");
    expect(html).toContain("No events for");
    expect(html).toContain("likely stuck");
  });

  it("suppresses the warning on the final 'done' render", () => {
    let s = reduce(initialState(), enqueue(), START);
    s = reduce(s, { kind: "turn_end", durationMs: 0 }, START + 100);
    expect(s.stage).toBe("done");
    const html = render(s, START + 10 * 60_000, undefined, { stuckMs: 9 * 60_000 });
    expect(html).not.toContain("No events for");
    expect(html).toContain("✅");
  });

  it("omits the warning when no stuckMs option is passed", () => {
    const s = reduce(initialState(), enqueue(), START);
    const html = render(s, START + STUCK_THRESHOLD_MS + 10_000);
    expect(html).not.toContain("No events for");
  });
});

describe("progress-card driver — stuck warning propagation via heartbeat", () => {
  interface FakeTimer {
    fireAt: number;
    fn: () => void;
    ref: number;
    repeat?: number;
  }

  function harness(opts: { heartbeatMs?: number; maxIdleMs?: number } = {}) {
    let now = 1000;
    const timers: FakeTimer[] = [];
    let nextRef = 0;
    const emits: Array<{ html: string; done: boolean; isFirstEmit: boolean }> = [];
    const driver = createProgressDriver({
      emit: ({ html, done, isFirstEmit }) => emits.push({ html, done, isFirstEmit }),
      heartbeatMs: opts.heartbeatMs ?? 5000,
      // Distinct from the renderer's STUCK_THRESHOLD_MS: the driver zombie
      // ceiling fires later (5 min in production); use a large value here
      // so the warning has a window to be observed before force-close.
      maxIdleMs: opts.maxIdleMs ?? 10 * 60_000,
      initialDelayMs: 0,
      now: () => now,
      setTimeout: (fn, ms) => {
        const ref = nextRef++;
        timers.push({ fireAt: now + ms, fn, ref });
        return { ref };
      },
      clearTimeout: (handle) => {
        const target = (handle as { ref: number }).ref;
        const idx = timers.findIndex((t) => t.ref === target);
        if (idx !== -1) timers.splice(idx, 1);
      },
      setInterval: (fn, ms) => {
        const ref = nextRef++;
        timers.push({ fireAt: now + ms, fn, ref, repeat: ms });
        return { ref };
      },
      clearInterval: (handle) => {
        const target = (handle as { ref: number }).ref;
        const idx = timers.findIndex((t) => t.ref === target);
        if (idx !== -1) timers.splice(idx, 1);
      },
    });
    const advance = (ms: number): void => {
      now += ms;
      for (;;) {
        timers.sort((a, b) => a.fireAt - b.fireAt);
        const next = timers[0];
        if (!next || next.fireAt > now) break;
        if (next.repeat != null) {
          next.fireAt += next.repeat;
          next.fn();
        } else {
          timers.shift();
          next.fn();
        }
      }
    };
    return { driver, emits, advance };
  }

  it("heartbeat re-render shows the warning once stuckMs crosses 2 min", () => {
    const { driver, emits, advance } = harness({ heartbeatMs: 30_000 });
    driver.ingest(enqueue("c1"), null);
    // Initial emit is the skeleton card — no warning yet.
    expect(emits[0].html).not.toContain("No events for");

    // Advance past the 2-min stuck threshold. Heartbeat ticks every 30s;
    // each tick re-renders the card. The render crossing 2 min should
    // surface the warning. We advance in 30s steps (matching heartbeatMs)
    // so the fake timer actually fires.
    advance(STUCK_THRESHOLD_MS + 30_000);

    const hasWarning = emits.some((e) => e.html.includes("No events for"));
    expect(hasWarning).toBe(true);
  });

  it("heartbeat suppresses warning after a real event resets stuckMs", () => {
    const { driver, emits, advance } = harness({ heartbeatMs: 30_000 });
    driver.ingest(enqueue("c1"), null);
    // Cross the threshold so the warning lights up.
    advance(STUCK_THRESHOLD_MS + 30_000);
    const beforeReset = emits.length;
    expect(emits.some((e) => e.html.includes("No events for"))).toBe(true);

    // A real session event lands — lastEventAt refreshes, warning should
    // disappear from subsequent heartbeat renders.
    driver.ingest(
      { kind: "tool_use", toolName: "Read", toolUseId: "tu1", input: { file_path: "x" } },
      "c1",
    );
    advance(60_000);

    const post = emits.slice(beforeReset);
    const postHasWarning = post.some((e) => e.html.includes("No events for"));
    expect(postHasWarning).toBe(false);
  });

  it("zombie ceiling force-closes a card whose lastEventAt is older than maxIdleMs", () => {
    const { driver, emits, advance } = harness({
      heartbeatMs: 30_000,
      maxIdleMs: 5 * 60_000,
    });
    driver.ingest(enqueue("c1"), null);

    // Step past the 5-min ceiling. The heartbeat detects the zombie and
    // forces a terminal render with done=true.
    advance(6 * 60_000);

    const terminal = emits.find((e) => e.done === true);
    expect(terminal).toBeDefined();
    expect(terminal!.html).toContain("✅");
  });
});
