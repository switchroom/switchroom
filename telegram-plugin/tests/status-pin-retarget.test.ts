import { describe, it, expect } from "vitest";
import {
  runStatusPinReconcile,
  type StatusPinClaim,
} from "../gateway/status-pin-retarget.js";
import type { PinLegAction, PinState } from "../status-pin.js";

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
 * #3831: the expansion ALSO existed inside `status-pin-driver.ts`, decided from
 * the driver's own `decidePinAction` call and lacking the per-leg persistence.
 * That copy is gone — the driver now takes a `PinLegAction`, which cannot
 * express a repin — so this module is the only decider. These tests assert the
 * LEG SEQUENCE the driver now receives, plus the claim bookkeeping.
 */

/** Records every leg and returns a scripted outcome for it. */
function legRecorder(outcomes: Array<PinState | null>) {
  const legs: Array<{ from: PinState | null; action: PinLegAction }> = [];
  let i = 0;
  const runPin = async (action: PinLegAction, from: PinState | null) => {
    legs.push({ from, action });
    const out = outcomes[i];
    i += 1;
    return out ?? null;
  };
  return { legs, runPin };
}

function claimsOf(seed?: { key: string; claim: StatusPinClaim }) {
  const claims = new Map<string, StatusPinClaim>();
  if (seed) claims.set(seed.key, seed.claim);
  return claims;
}

const KEY = "fg:c:7";
const CHAT = "-100123";

describe("runStatusPinReconcile — RETARGET", () => {
  it("runs BOTH legs: unpins the stale claim, then pins the new message", async () => {
    const { legs, runPin } = legRecorder([null, { messageId: 901 }]);
    const claims = claimsOf({
      key: KEY,
      claim: { messageId: 900, chatId: CHAT, pinnedAt: 1000 },
    });

    await runStatusPinReconcile({
      pinKey: KEY,
      chatId: CHAT,
      prev: { messageId: 900 },
      desired: { pinned: true, messageId: 901 },
      persist: null,
      runPin,
      claims,
    });

    // The pre-fix behaviour was legs === [unpin] and nothing pinned.
    expect(legs).toEqual([
      { from: { messageId: 900 }, action: { kind: "unpin", messageId: 900 } },
      { from: null, action: { kind: "pin", messageId: 901 } },
    ]);
    expect(claims.get(KEY)?.messageId).toBe(901);
    expect(claims.get(KEY)?.chatId).toBe(CHAT);
  });

  it("leg 2 starts from a NULL claim, so the driver pins rather than no-opping", async () => {
    const { legs, runPin } = legRecorder([null, { messageId: 901 }]);
    await runStatusPinReconcile({
      pinKey: KEY,
      chatId: CHAT,
      prev: { messageId: 900 },
      desired: { pinned: true, messageId: 901 },
      persist: null,
      runPin,
      claims: claimsOf(),
    });
    expect(legs[1].from).toBeNull();
    expect(legs[1].action).toEqual({ kind: "pin", messageId: 901 });
  });

  it("re-stamps pinnedAt for the NEW card, so the reaper ages the live message", async () => {
    const { runPin } = legRecorder([null, { messageId: 901 }]);
    const claims = claimsOf({
      key: KEY,
      claim: { messageId: 900, chatId: CHAT, pinnedAt: 1000 },
    });
    await runStatusPinReconcile({
      pinKey: KEY,
      chatId: CHAT,
      prev: { messageId: 900 },
      desired: { pinned: true, messageId: 901 },
      persist: null,
      runPin,
      claims,
      now: () => 5000,
    });
    // Leg 1 cleared the claim (dropping the old stamp), leg 2 took a fresh one.
    expect(claims.get(KEY)?.pinnedAt).toBe(5000);
  });

  it("NEVER-CONFIRMED unpin (#3664 Defect B): SKIPS the pin leg and retains the OLD claim", async () => {
    // A non-null leg-1 result means executePinLeg deliberately kept the claim —
    // the old message is provably still pinned. Pinning the new one now would
    // leave TWO pins in the chat with a durable record of one.
    const { legs, runPin } = legRecorder([{ messageId: 900 }]);
    const claims = claimsOf({
      key: KEY,
      claim: { messageId: 900, chatId: CHAT, pinnedAt: 1000 },
    });

    await runStatusPinReconcile({
      pinKey: KEY,
      chatId: CHAT,
      prev: { messageId: 900 },
      desired: { pinned: true, messageId: 901 },
      persist: null,
      runPin,
      claims,
    });

    expect(legs).toHaveLength(1);
    expect(claims.get(KEY)).toEqual({
      messageId: 900,
      chatId: CHAT,
      pinnedAt: 1000, // original age preserved for the TTL gate
    });
  });

  it("a FAILED pin leg drops the claim entirely (nothing is pinned, nothing is tracked)", async () => {
    // executePinLeg returns its `from` on a failed pin — here `null`.
    const { runPin } = legRecorder([null, null]);
    const claims = claimsOf({
      key: KEY,
      claim: { messageId: 900, chatId: CHAT, pinnedAt: 1000 },
    });
    await runStatusPinReconcile({
      pinKey: KEY,
      chatId: CHAT,
      prev: { messageId: 900 },
      desired: { pinned: true, messageId: 901 },
      persist: null,
      runPin,
      claims,
    });
    expect(claims.has(KEY)).toBe(false);
  });
});

describe("runStatusPinReconcile — single-leg actions are unchanged", () => {
  it("first pin: one leg, claim + chat + age recorded together", async () => {
    const { legs, runPin } = legRecorder([{ messageId: 900 }]);
    const claims = claimsOf();
    await runStatusPinReconcile({
      pinKey: KEY,
      chatId: CHAT,
      prev: null,
      desired: { pinned: true, messageId: 900 },
      persist: null,
      runPin,
      claims,
      now: () => 4242,
    });
    expect(legs).toEqual([
      { from: null, action: { kind: "pin", messageId: 900 } },
    ]);
    // #3809: the claim is ONE record — a chat-less claim cannot be represented.
    expect(claims.get(KEY)).toEqual({
      messageId: 900,
      chatId: CHAT,
      pinnedAt: 4242,
    });
  });

  it("turn-end unpin: one leg, the whole claim is cleared", async () => {
    const { legs, runPin } = legRecorder([null]);
    const claims = claimsOf({
      key: KEY,
      claim: { messageId: 900, chatId: CHAT, pinnedAt: 1000 },
    });
    await runStatusPinReconcile({
      pinKey: KEY,
      chatId: CHAT,
      prev: { messageId: 900 },
      desired: { pinned: false },
      persist: null,
      runPin,
      claims,
    });
    expect(legs).toEqual([
      { from: { messageId: 900 }, action: { kind: "unpin", messageId: 900 } },
    ]);
    expect(claims.has(KEY)).toBe(false);
  });

  it("steady-state re-pin of the SAME id: still one leg, and the ORIGINAL age is kept", async () => {
    // 20 edits/turn each re-drive this; the reaper's TTL must measure from the
    // first pin, not be reset by every edit.
    const { legs, runPin } = legRecorder([{ messageId: 900 }]);
    const claims = claimsOf({
      key: KEY,
      claim: { messageId: 900, chatId: CHAT, pinnedAt: 1000 },
    });
    await runStatusPinReconcile({
      pinKey: KEY,
      chatId: CHAT,
      prev: { messageId: 900 },
      desired: { pinned: true, messageId: 900 },
      persist: null,
      runPin,
      claims,
      now: () => 9_999_999,
    });
    expect(legs).toHaveLength(1);
    expect(legs[0].action.kind).toBe("noop");
    expect(claims.get(KEY)?.pinnedAt).toBe(1000);
  });

  it("unpin with no claim: one no-op leg, the registry stays empty", async () => {
    const { legs, runPin } = legRecorder([null]);
    const claims = claimsOf();
    await runStatusPinReconcile({
      pinKey: KEY,
      chatId: CHAT,
      prev: null,
      desired: { pinned: false },
      persist: null,
      runPin,
      claims,
    });
    expect(legs).toHaveLength(1);
    expect(legs[0].action.kind).toBe("noop");
    expect(claims.size).toBe(0);
  });
});
