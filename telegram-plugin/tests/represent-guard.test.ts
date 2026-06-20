import { describe, it, expect } from "vitest";
import {
  shouldSuppressRepresent,
  type RepresentGuardObligation,
} from "../gateway/represent-guard.js";
import { ObligationLedger } from "../gateway/obligation-ledger.js";

// Executable verification of the #2472 fix: obligation_represent must NOT re-fire
// for an origin_turn_id that has already been answered by a reply since the last
// represent (the satisfied-but-misdetected case that produced the near-identical
// duplicate), while the genuine "plain text, never replied" case still represents
// ONCE and the represent_count cap is honored.

const CHAT = "12345";
const ORIGIN = "12345:_#10605";

function obligation(over: Partial<RepresentGuardObligation> = {}): RepresentGuardObligation {
  return { originTurnId: ORIGIN, chatId: CHAT, ...over };
}

/** A hasOutboundDeliveredSince stub that returns true only for queries whose
 *  cutoff falls at/after `replyTs` — modelling a reply delivered at replyTs. */
function replyDeliveredAt(replyTs: number) {
  return (_chat: string, sinceMs: number) => replyTs >= sinceMs;
}

describe("shouldSuppressRepresent — #2472 duplicate-represent guard", () => {
  it("suppresses the SECOND represent once a reply landed since the FIRST represent", () => {
    // The exact #2472 sequence: represent_count=1 fired at t=1000, the agent
    // answered with a reply at t=1500, the sweep is about to fire count=2.
    const o = obligation({ lastRepresentedAt: 1000 });
    const suppress = shouldSuppressRepresent(o, {
      historyEnabled: true,
      hasOutboundDeliveredSince: replyDeliveredAt(1500),
    });
    expect(suppress).toBe(true); // do NOT re-fire → no duplicate 10609
  });

  it("does NOT suppress the FIRST represent — genuine plain-text-no-reply still represents once", () => {
    // First represent: lastRepresentedAt is undefined. Even though an assistant
    // message (the original plain-text answer) exists in history, the single
    // re-ask must still fire — the agent never called the reply tool.
    const o = obligation({ lastRepresentedAt: undefined });
    const suppress = shouldSuppressRepresent(o, {
      historyEnabled: true,
      // history WOULD report an outbound exists, but the first represent ignores it
      hasOutboundDeliveredSince: () => true,
    });
    expect(suppress).toBe(false); // represent fires exactly once
  });

  it("does NOT suppress a later represent when NO reply landed since the last one", () => {
    // count=1 fired at t=1000, nothing answered it → count=2 must still fire.
    const o = obligation({ lastRepresentedAt: 1000 });
    const suppress = shouldSuppressRepresent(o, {
      historyEnabled: true,
      hasOutboundDeliveredSince: () => false,
    });
    expect(suppress).toBe(false);
  });

  it("a reply that PREDATES the last represent does not count (cutoff is lastRepresentedAt, not openedAt)", () => {
    // The original plain-text answer landed at t=500, before the represent at
    // t=1000. That is not evidence the represent itself was answered → fire.
    const o = obligation({ lastRepresentedAt: 1000 });
    const suppress = shouldSuppressRepresent(o, {
      historyEnabled: true,
      hasOutboundDeliveredSince: replyDeliveredAt(500),
    });
    expect(suppress).toBe(false);
  });

  it("never suppresses when history is unavailable (safe: re-ask rather than silently drop)", () => {
    const o = obligation({ lastRepresentedAt: 1000 });
    const suppress = shouldSuppressRepresent(o, {
      historyEnabled: false,
      hasOutboundDeliveredSince: () => true,
    });
    expect(suppress).toBe(false);
  });
});

describe("represent_count cap is honored by the ledger — a misdetected obligation cannot loop", () => {
  it("escalates (stops re-presenting) once representCount reaches maxRepresents", () => {
    const L = new ObligationLedger(2); // maxRepresents = 2
    L.openIfAbsent({
      originTurnId: ORIGIN,
      chatId: CHAT,
      messageId: 10605,
      text: "Check there was a bug raised…",
      openedAt: 0,
    });

    // count 0 -> represent
    expect(L.decideAtIdle().action).toBe("represent");
    L.markRepresented(ORIGIN, 1000);
    // count 1 -> represent
    expect(L.decideAtIdle().action).toBe("represent");
    L.markRepresented(ORIGIN, 2000);
    // count 2 == cap -> escalate, NOT another represent
    expect(L.decideAtIdle().action).toBe("escalate");

    // and the ladder terminates: closing on escalate ends it
    L.close(ORIGIN);
    expect(L.decideAtIdle().action).toBe("none");
  });
});
