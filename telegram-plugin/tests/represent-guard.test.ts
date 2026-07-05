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
    // First represent: lastRepresentedAt is undefined, no reply tool call was
    // ever recorded (the genuine plain-text-no-reply case → no outbound row, so
    // the predicate reports false). The single re-ask must still fire.
    const o = obligation({ openedAt: 0, lastRepresentedAt: undefined });
    const suppress = shouldSuppressRepresent(o, {
      historyEnabled: true,
      // No outbound row exists for a plain-text answer → predicate is false.
      hasOutboundDeliveredSince: () => false,
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

  it("#2788 Gap B — SUPPRESSES the FIRST represent when a genuine reply was delivered since openedAt", () => {
    // The narrow false "you never answered" window: a real reply landed at
    // t=1500 after the obligation was raised at t=1000, but its routing didn't
    // resolve back to the origin so the ledger's close path missed it. The FIRST
    // represent must now dedup against outbound history (cutoff = openedAt) and
    // suppress, instead of emitting a false "you never answered".
    const o = obligation({ openedAt: 1000, lastRepresentedAt: undefined });
    const suppress = shouldSuppressRepresent(o, {
      historyEnabled: true,
      hasOutboundDeliveredSince: replyDeliveredAt(1500),
    });
    expect(suppress).toBe(true); // first represent deduped → no false "you never answered"
  });

  it("#2788 Gap B — first represent still fires when the only reply PREDATES openedAt", () => {
    // A reply at t=500 answered an EARLIER turn, before this obligation was
    // raised at t=1000. It is not evidence THIS obligation was answered → the
    // first represent must still fire.
    const o = obligation({ openedAt: 1000, lastRepresentedAt: undefined });
    const suppress = shouldSuppressRepresent(o, {
      historyEnabled: true,
      hasOutboundDeliveredSince: replyDeliveredAt(500),
    });
    expect(suppress).toBe(false);
  });

  it("#2788 Gap B — first represent falls back to firing when openedAt is unknown", () => {
    // Without an openedAt cutoff we cannot dedup safely — never suppress on doubt.
    const o = obligation({ openedAt: undefined, lastRepresentedAt: undefined });
    const suppress = shouldSuppressRepresent(o, {
      historyEnabled: true,
      hasOutboundDeliveredSince: () => true,
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

// #2474 follow-up — the terse-reply gap. PR #2474 suppressed the duplicate
// represent only when the satisfied-check saw a >=200-char "substantive" reply
// (the 200-char proxy borrowed from the ESCALATE branch). A GENUINE but SHORT
// reply (e.g. "Yes — done.") therefore did NOT suppress the duplicate, leaving
// the #2472 duplicate-message bug alive for terse answers. The guard itself is
// pure: the gateway now binds hasOutboundDeliveredSince with a LOW minChars so a
// terse-but-real reply reports true. These tests model the wired predicate's
// behavior at the guard boundary.
describe("represent guard — terse genuine reply suppresses the duplicate (#2474 follow-up)", () => {
  /** Models the gateway-wired predicate AFTER the fix: reports true for ANY real
   *  reply at/after the cutoff regardless of length (minChars=1 inside history).
   *  `replyChars` is the length of the terse reply; included to make the intent
   *  explicit — the predicate no longer gates on length. */
  function terseReplyDeliveredAt(replyTs: number, replyChars: number) {
    expect(replyChars).toBeGreaterThan(0); // a real, non-empty reply
    return (_chat: string, sinceMs: number) => replyTs >= sinceMs;
  }

  it("suppresses the duplicate when a SHORT genuine reply landed since the last represent", () => {
    // count=1 fired at t=1000; the agent answered with a terse 11-char reply
    // ("Yes — done.") at t=1500. The duplicate (count=2) must now be suppressed —
    // before the fix the 200-char gate let it through.
    const o = obligation({ lastRepresentedAt: 1000 });
    const suppress = shouldSuppressRepresent(o, {
      historyEnabled: true,
      hasOutboundDeliveredSince: terseReplyDeliveredAt(1500, "Yes — done.".length),
    });
    expect(suppress).toBe(true);
  });

  it("does NOT suppress when only framework noise occurred since the last represent", () => {
    // Typing indicators and progress-card edits never call recordOutbound, so no
    // assistant row exists for them → the wired predicate reports false. A real
    // answer never landed, so the represent SHOULD still fire (no false suppress).
    const o = obligation({ lastRepresentedAt: 1000 });
    const suppress = shouldSuppressRepresent(o, {
      historyEnabled: true,
      // No assistant row for typing/progress edits → predicate is false.
      hasOutboundDeliveredSince: () => false,
    });
    expect(suppress).toBe(false);
  });

  it("does NOT suppress when the terse reply PREDATES the last represent", () => {
    // A terse reply at t=500 answered an EARLIER ask, not the represent at t=1000.
    // The cutoff is lastRepresentedAt, so a pre-cutoff terse reply must not count.
    const o = obligation({ lastRepresentedAt: 1000 });
    const suppress = shouldSuppressRepresent(o, {
      historyEnabled: true,
      hasOutboundDeliveredSince: terseReplyDeliveredAt(500, "ok".length),
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
