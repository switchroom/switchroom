import { describe, it, expect } from "vitest";
import { runStatusPinReconcile } from "../gateway/status-pin-retarget.js";
import type { DesiredPin, PinState } from "../status-pin.js";

/**
 * The orchestrator the gateway's `reconcileStatusPinInner` delegates to.
 *
 * The defect it closes: a RETARGET (the caller wants a DIFFERENT message pinned
 * for a key it already holds a claim on) used to be reported as a bare `unpin`
 * and stopped there, on the assumption a later reconcile would pin the new
 * message. The FOREGROUND activity card reconciles `fg:<statusKey>` exactly
 * once (narrative-lane.ts, the `activityMessageId == null` OPEN branch), so an
 * ack-first mid-turn reopen left the live card unpinned for the rest of the
 * turn AND deleted the durable row, putting it out of reach of both the
 * mid-session reaper and the next boot's sweep.
 *
 * These tests drive the module with a fake leg runner and assert the LEG
 * SEQUENCE — the thing that was wrong — plus the registry bookkeeping.
 */

/** Records every leg and returns a scripted outcome for it. */
function legRecorder(outcomes: Array<PinState | null>) {
  const legs: Array<{ from: PinState | null; want: DesiredPin }> = [];
  let i = 0;
  const runPin = async (from: PinState | null, want: DesiredPin) => {
    legs.push({ from, want });
    const out = outcomes[i];
    i += 1;
    return out ?? null;
  };
  return { legs, runPin };
}

function registries(seed?: { key: string; state: PinState; chatId: string; at: number }) {
  const r = {
    state: new Map<string, PinState>(),
    chatIds: new Map<string, string>(),
    pinnedAt: new Map<string, number>(),
  };
  if (seed) {
    r.state.set(seed.key, seed.state);
    r.chatIds.set(seed.key, seed.chatId);
    r.pinnedAt.set(seed.key, seed.at);
  }
  return r;
}

const KEY = "fg:c:7";
const CHAT = "-100123";

describe("runStatusPinReconcile — RETARGET", () => {
  it("runs BOTH legs: unpins the stale claim, then pins the new message", async () => {
    const { legs, runPin } = legRecorder([null, { messageId: 901 }]);
    const reg = registries({ key: KEY, state: { messageId: 900 }, chatId: CHAT, at: 1000 });

    await runStatusPinReconcile({
      pinKey: KEY,
      chatId: CHAT,
      prev: { messageId: 900 },
      desired: { pinned: true, messageId: 901 },
      persist: null,
      runPin,
      registries: reg,
    });

    // The pre-fix behaviour was legs === [unpin] and nothing pinned.
    expect(legs).toEqual([
      { from: { messageId: 900 }, want: { pinned: false } },
      { from: null, want: { pinned: true, messageId: 901 } },
    ]);
    expect(reg.state.get(KEY)).toEqual({ messageId: 901 });
    expect(reg.chatIds.get(KEY)).toBe(CHAT);
  });

  it("leg 2 starts from a NULL claim, so it decides a real `pin` (not a noop)", async () => {
    const { legs, runPin } = legRecorder([null, { messageId: 901 }]);
    await runStatusPinReconcile({
      pinKey: KEY,
      chatId: CHAT,
      prev: { messageId: 900 },
      desired: { pinned: true, messageId: 901 },
      persist: null,
      runPin,
      registries: registries(),
    });
    expect(legs[1].from).toBeNull();
  });

  it("re-stamps pinnedAt for the NEW card, so the reaper ages the live message", async () => {
    const { runPin } = legRecorder([null, { messageId: 901 }]);
    const reg = registries({ key: KEY, state: { messageId: 900 }, chatId: CHAT, at: 1000 });
    await runStatusPinReconcile({
      pinKey: KEY,
      chatId: CHAT,
      prev: { messageId: 900 },
      desired: { pinned: true, messageId: 901 },
      persist: null,
      runPin,
      registries: reg,
    });
    // Leg 1 cleared the claim (dropping the old stamp), leg 2 took a fresh one.
    expect(reg.pinnedAt.get(KEY)).toBeGreaterThan(1000);
  });

  it("NEVER-CONFIRMED unpin (#3664 Defect B): SKIPS the pin leg and retains the OLD claim", async () => {
    // A non-null leg-1 result means reconcilePin deliberately kept the claim —
    // the old message is provably still pinned. Pinning the new one now would
    // leave TWO pins in the chat with a durable record of one.
    const { legs, runPin } = legRecorder([{ messageId: 900 }]);
    const reg = registries({ key: KEY, state: { messageId: 900 }, chatId: CHAT, at: 1000 });

    await runStatusPinReconcile({
      pinKey: KEY,
      chatId: CHAT,
      prev: { messageId: 900 },
      desired: { pinned: true, messageId: 901 },
      persist: null,
      runPin,
      registries: reg,
    });

    expect(legs).toHaveLength(1);
    expect(reg.state.get(KEY)).toEqual({ messageId: 900 });
    expect(reg.chatIds.get(KEY)).toBe(CHAT);
    expect(reg.pinnedAt.get(KEY)).toBe(1000); // original age preserved for the TTL gate
  });

  it("a FAILED pin leg drops the claim entirely (nothing is pinned, nothing is tracked)", async () => {
    // reconcilePin returns its `from` on a failed pin — here `null`.
    const { runPin } = legRecorder([null, null]);
    const reg = registries({ key: KEY, state: { messageId: 900 }, chatId: CHAT, at: 1000 });
    await runStatusPinReconcile({
      pinKey: KEY,
      chatId: CHAT,
      prev: { messageId: 900 },
      desired: { pinned: true, messageId: 901 },
      persist: null,
      runPin,
      registries: reg,
    });
    expect(reg.state.has(KEY)).toBe(false);
    expect(reg.chatIds.has(KEY)).toBe(false);
    expect(reg.pinnedAt.has(KEY)).toBe(false);
  });
});

describe("runStatusPinReconcile — single-leg actions are unchanged", () => {
  it("first pin: one leg, claim + chat + age recorded", async () => {
    const { legs, runPin } = legRecorder([{ messageId: 900 }]);
    const reg = registries();
    await runStatusPinReconcile({
      pinKey: KEY,
      chatId: CHAT,
      prev: null,
      desired: { pinned: true, messageId: 900 },
      persist: null,
      runPin,
      registries: reg,
    });
    expect(legs).toEqual([{ from: null, want: { pinned: true, messageId: 900 } }]);
    expect(reg.state.get(KEY)).toEqual({ messageId: 900 });
    expect(reg.pinnedAt.has(KEY)).toBe(true);
  });

  it("turn-end unpin: one leg, all three registries cleared", async () => {
    const { legs, runPin } = legRecorder([null]);
    const reg = registries({ key: KEY, state: { messageId: 900 }, chatId: CHAT, at: 1000 });
    await runStatusPinReconcile({
      pinKey: KEY,
      chatId: CHAT,
      prev: { messageId: 900 },
      desired: { pinned: false },
      persist: null,
      runPin,
      registries: reg,
    });
    expect(legs).toEqual([{ from: { messageId: 900 }, want: { pinned: false } }]);
    expect(reg.state.has(KEY)).toBe(false);
    expect(reg.chatIds.has(KEY)).toBe(false);
    expect(reg.pinnedAt.has(KEY)).toBe(false);
  });

  it("steady-state re-pin of the SAME id: still one leg, and the ORIGINAL age is kept", async () => {
    // 20 edits/turn each re-drive this; the reaper's TTL must measure from the
    // first pin, not be reset by every edit.
    const { legs, runPin } = legRecorder([{ messageId: 900 }]);
    const reg = registries({ key: KEY, state: { messageId: 900 }, chatId: CHAT, at: 1000 });
    await runStatusPinReconcile({
      pinKey: KEY,
      chatId: CHAT,
      prev: { messageId: 900 },
      desired: { pinned: true, messageId: 900 },
      persist: null,
      runPin,
      registries: reg,
    });
    expect(legs).toHaveLength(1);
    expect(reg.pinnedAt.get(KEY)).toBe(1000);
  });

  it("unpin with no claim: one no-op leg, registries stay empty", async () => {
    const { legs, runPin } = legRecorder([null]);
    const reg = registries();
    await runStatusPinReconcile({
      pinKey: KEY,
      chatId: CHAT,
      prev: null,
      desired: { pinned: false },
      persist: null,
      runPin,
      registries: reg,
    });
    expect(legs).toHaveLength(1);
    expect(reg.state.size).toBe(0);
  });
});
