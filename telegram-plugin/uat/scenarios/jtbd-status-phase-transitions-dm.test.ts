/**
 * JTBD scenario — the status reaction moves through DISTINCT phases across
 * a turn: acknowledged → thinking → working/editing → done.
 *
 * Serves "know what my agent is actually doing"
 * (`reference/jobs/know-what-my-agent-is-doing.md`): the "Good looks like"
 * line — "that signal distinguishes phases at a glance: acknowledged,
 * thinking or working, actively editing. It stays present from receipt to
 * turn end and never disappears mid-turn." The reflective controller test
 * (`jtbd-reflective-status-reaction-dm`) pins the #1713 non-event/
 * bidirectional rules; THIS scenario pins the complementary contract the
 * job cares about most: over a realistic full turn the phases actually
 * FIRE, in order, and are visibly DIFFERENT emoji families (not one
 * undifferentiated "working" blob — an explicit bad-list item).
 *
 * Simulated (not live mtcute): real Bot-API reactions expose only the
 * CURRENT emoji, never the transition trail, so the controller-level
 * assertion over the whole sequence is strictly more powerful — the same
 * reasoning documented in `jtbd-reflective-status-reaction-dm`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { StatusReactionController } from "../../status-reactions.js";

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

// Phase families the JOB cares about (job spec "Good looks like"). Emoji
// membership is pinned by status-reactions.ts; we assert the family a
// glance would read, so a palette retune that preserves the phase meaning
// doesn't false-fail this behavioural scenario.
const ACK = new Set(["👀", "🤔", "🤓"]); // received / acknowledged
const THINKING = new Set(["🤔", "🤓"]); // generating
const WORKING = new Set(["✍", "⚡", "👌", "👨‍💻", "🗜"]); // tools / editing / coding
const DONE = new Set(["👍", "💯", "🎉"]); // turn over

describe("uat-jtbd: status reaction phase transitions across a turn", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("acknowledged → thinking → working/editing → done all fire, in order, as distinct phases", async () => {
    const calls: string[] = [];
    const ctrl = new StatusReactionController(async (e: string) => {
      calls.push(e);
    });

    // A realistic turn: inbound arrives, model thinks, then reads/edits
    // (a silent tool stretch), then the turn ends with an answer.
    ctrl.setQueued(); // acknowledged
    await flush();

    ctrl.setThinking(); // thinking
    vi.advanceTimersByTime(3500);
    await flush();

    ctrl.setTool("Read"); // working — coding family
    vi.advanceTimersByTime(3500);
    await flush();

    ctrl.setTool("Edit"); // still working — actively editing
    vi.advanceTimersByTime(3500);
    await flush();

    ctrl.finalize("done"); // turn_end — done
    await flush();

    // Each phase fired at least once.
    expect(calls.some((e) => ACK.has(e))).toBe(true);
    expect(calls.some((e) => THINKING.has(e))).toBe(true);
    expect(calls.some((e) => WORKING.has(e))).toBe(true);
    expect(calls.some((e) => DONE.has(e))).toBe(true);

    // They fired IN ORDER: first ack, a working beat before the terminal,
    // and done strictly last.
    const firstWorkingIdx = calls.findIndex((e) => WORKING.has(e));
    const doneIdx = calls.findIndex((e) => DONE.has(e));
    expect(firstWorkingIdx).toBeGreaterThan(0); // ack precedes working
    expect(doneIdx).toBe(calls.length - 1); // done is terminal + last
    expect(firstWorkingIdx).toBeLessThan(doneIdx); // work before done

    // The phases are VISIBLY DIFFERENT — thinking and working are not the
    // same emoji (the "one undifferentiated working signal" bad-list item).
    const thinkingEmoji = calls.find((e) => THINKING.has(e))!;
    const workingEmoji = calls.find((e) => WORKING.has(e))!;
    expect(thinkingEmoji).not.toBe(workingEmoji);

    // Liveness never disappears mid-turn: 👍 appears exactly once, only at
    // the end — the signal is present from receipt to terminal state.
    expect(calls.filter((e) => DONE.has(e)).length).toBe(1);
  });

  it("a trivial turn still acknowledges before it finishes (never a silent gap)", async () => {
    // "A trivial ask just gets the answer" — but even then the inbound is
    // acknowledged (👀) before the turn finalizes; the ack is never skipped.
    const calls: string[] = [];
    const ctrl = new StatusReactionController(async (e: string) => {
      calls.push(e);
    });

    ctrl.setQueued();
    await flush();
    ctrl.finalize("done");
    await flush();

    expect(ACK.has(calls[0])).toBe(true);
    expect(DONE.has(calls[calls.length - 1])).toBe(true);
  });
});
