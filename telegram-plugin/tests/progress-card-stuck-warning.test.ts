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

  it("demotes active narrative to italic+stale when age > threshold", () => {
    // When the stuck banner appears, a still-bolded narrative with a
    // confidently ticking age sends mixed signals. The narrative should
    // render in italics with a "· stale" marker so the two signals agree.
    let s = reduce(initialState(), enqueue(), START);
    s = reduce(s, { kind: "text", text: "Reading config" }, START + 100);
    const html = render(s, START + STUCK_THRESHOLD_MS + 30_000, undefined, {
      stuckMs: STUCK_THRESHOLD_MS + 30_000,
    });
    expect(html).toContain("stale");
    expect(html).not.toContain("<b>Reading config</b>");
  });

  it("keeps active narrative bold while fresh (below threshold)", () => {
    let s = reduce(initialState(), enqueue(), START);
    s = reduce(s, { kind: "text", text: "Reading config" }, START + 100);
    const html = render(s, START + 30_000, undefined, {
      stuckMs: 30_000,
    });
    expect(html).toContain("<b>Reading config</b>");
    expect(html).not.toContain("stale");
  });

  it("narrative at exact STUCK_THRESHOLD_MS stays bold (deliberate `>` asymmetry)", () => {
    // Banner condition is `>=`; narrative demotion uses `>`. At the
    // exact-equality tick the banner appears but the narrative is still
    // bold. In production stuckMs ticks in ~5s increments so the window
    // never reaches exact-equality — pin this as intentional so a
    // future refactor doesn't accidentally change both to `>=`.
    let s = reduce(initialState(), enqueue(), START);
    s = reduce(s, { kind: "text", text: "Reading config" }, START);
    const html = render(s, START + STUCK_THRESHOLD_MS, undefined, {
      stuckMs: STUCK_THRESHOLD_MS,
    });
    expect(html).toContain("<b>Reading config</b>");
    expect(html).toContain("No events for");
  });
});

describe("progress-card driver — stuck warning propagation via heartbeat", () => {
  interface FakeTimer {
    fireAt: number;
    fn: () => void;
    ref: number;
    repeat?: number;
  }

  function harness(opts: {
    heartbeatMs?: number;
    maxIdleMs?: number;
    onTurnComplete?: (args: { chatId: string; threadId?: string; turnKey: string; summary: string; taskIndex: number; taskTotal: number }) => void;
  } = {}) {
    let now = 1000;
    const timers: FakeTimer[] = [];
    let nextRef = 0;
    const emits: Array<{ html: string; done: boolean; isFirstEmit: boolean }> = [];
    const driver = createProgressDriver({
      emit: ({ html, done, isFirstEmit }) => emits.push({ html, done, isFirstEmit }),
      onTurnComplete: opts.onTurnComplete,
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

  it("heartbeat keeps card pinned while sub-agent outlives parent turn_end (#313 Gap 8)", () => {
    // Post-#313: parent `turn_end` immediately renders the final card with
    // ✅ Done in the header (decoupled from unpin). The card stays pinned —
    // onTurnComplete fires only when the last running sub-agent finishes
    // OR the deferred-completion timeout expires. Heartbeat still ticks so
    // the sub-agent's per-row elapsed advances visibly.
    //
    // Note: this scenario exercises a CORRELATED sub-agent — the parent
    // tool_use's `prompt` matches sub_agent_started's `firstPromptText`
    // so the reducer establishes parentToolUseId. After the #31/#43 fix,
    // orphan sub-agents (parentToolUseId == null) no longer gate the
    // defer at turn_end — the card closes immediately for those.
    // Correlated sub-agents like this one DO keep the card alive.
    const completions: Array<{ chatId: string; turnKey: string }> = [];
    const { driver, emits, advance } = harness({
      heartbeatMs: 5_000,
      onTurnComplete: ({ chatId, turnKey }) => completions.push({ chatId, turnKey }),
    });
    driver.ingest(enqueue("c1"), null);
    // Start a background Agent sub-agent. `prompt` matches firstPromptText
    // below so correlation succeeds and parentToolUseId is set.
    driver.ingest(
      {
        kind: "tool_use",
        toolName: "Agent",
        toolUseId: "toolu_agent",
        input: { description: "run review", subagent_type: "reviewer", prompt: "run review" },
      },
      "c1",
    );
    driver.ingest(
      {
        kind: "sub_agent_started",
        agentId: "agent-bg",
        firstPromptText: "run review",
        subagentType: "reviewer",
      },
      "c1",
    );
    // Parent turn ends while sub-agent still running. Per Gap 8, this
    // produces an immediate ✅ Done render but does NOT fire onTurnComplete.
    driver.ingest({ kind: "turn_end", durationMs: 500 }, "c1");
    const emitsAtTurnEnd = emits.length;
    expect(completions.length).toBe(0); // unpin deferred
    // The most recent emit at turn_end carries the ✅ Done header.
    expect(emits[emits.length - 1].html).toContain("✅");
    // Tick heartbeats forward. The sub-agent is still running, so the card
    // stays alive and heartbeat re-renders as the sub-agent's elapsed advances.
    advance(20_000);
    const postHeartbeatEmits = emits.length;
    expect(postHeartbeatEmits).toBeGreaterThan(emitsAtTurnEnd);
    const heartbeatEmits = emits.slice(emitsAtTurnEnd);
    // Heartbeat emits are non-terminal (not done=true) — terminal already fired
    // at turn_end. The card stays pinned; unpin is the separate deferred path.
    expect(heartbeatEmits.every((e) => e.done === false)).toBe(true);
    // Heartbeat keeps ✅ Done in the header (parent committed at turn_end);
    // sub-agent rows underneath still show 🤖 running.
    const lastHeartbeat = heartbeatEmits[heartbeatEmits.length - 1];
    expect(lastHeartbeat.html).toContain("✅");
    expect(lastHeartbeat.html).toContain("🤖");
    // Still no unpin signal — onTurnComplete only fires when sub-agent finishes
    // (natural) or the deferred-completion timeout expires.
    expect(completions.length).toBe(0);
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
    // Issue #132: a zombie that never produced a reply correctly renders
    // "🙊 Ended without reply" rather than "✅ Done" — a hung turn that
    // sent nothing is *not* a successful done state. The test asserts the
    // terminal-state contract: SOME terminal header lands, and we record
    // which one. (Either ✅ Done or 🙊 silent end is acceptable here; the
    // important property is `done: true` was emitted by the zombie path.)
    expect(terminal!.html).toMatch(/✅ <b>Done<\/b>|🙊 <b>Ended without reply<\/b>/);
  });

  // T6 (spec §7): combined scenario — 2 min silence → stuck-warning in
  // header; continue to 5 min → zombie ceiling fires, onTurnComplete
  // callback invoked (this is the signal server.ts uses to unpin the card).
  it("T6: 2-min silence shows stuck-warning, 5-min zombie ceiling fires onTurnComplete (unpin signal)", () => {
    const completions: Array<{ chatId: string; turnKey: string }> = [];
    const { driver, emits, advance } = harness({
      heartbeatMs: 30_000,
      maxIdleMs: 5 * 60_000,
      onTurnComplete: ({ chatId, turnKey }) => completions.push({ chatId, turnKey }),
    });
    driver.ingest(enqueue("c1"), null);
    // No further events — the turn goes silent from this point.

    // ── Phase 1: advance to just past the 2-min stuck threshold ──────────
    advance(STUCK_THRESHOLD_MS + 30_000); // 2.5 min elapsed
    const stuckEmits = emits.filter((e) => e.html.includes("No events for"));
    expect(stuckEmits.length).toBeGreaterThan(0);
    // The card should still be alive (not yet zombie-closed).
    expect(completions).toHaveLength(0);

    // ── Phase 2: advance to past the 5-min zombie ceiling ────────────────
    // Total elapsed from turn start: 2.5 min + 3 min = 5.5 min > maxIdleMs.
    advance(3 * 60_000);
    // onTurnComplete is the driver-layer signal that the card is being torn
    // down — in production server.ts wires this to unpinProgressCard(). The
    // zombie path MUST have fired it exactly once.
    expect(completions).toHaveLength(1);
    expect(completions[0].chatId).toBe("c1");
    // A terminal emit with done=true must also have been produced so the
    // Telegram message is marked done before the unpin.
    const terminal = emits.find((e) => e.done === true);
    expect(terminal).toBeDefined();
    expect(terminal!.html).toMatch(/✅ <b>Done<\/b>|🙊 <b>Ended without reply<\/b>/);
  });
});
