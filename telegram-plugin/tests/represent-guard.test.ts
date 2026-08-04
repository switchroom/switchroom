import { describe, it, expect } from "vitest";
import {
  shouldSuppressRepresent,
  type RepresentGuardObligation,
} from "../gateway/represent-guard.js";
import { ObligationLedger } from "../gateway/obligation-ledger.js";
import {
  makeRepresentRedeliveryGuard,
  makeSessionBusyDrainDeferral,
} from "../gateway/represent-delivery-guard.js";
import { createObligationWiring } from "../gateway/obligation-wiring.js";
import type { InboundMessage } from "../gateway/ipc-protocol.js";

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

// F1 (fix/represent-double-send-delivery-recheck) — the DELIVERY-time re-check.
// The decision-time guard (shouldSuppressRepresent) is consulted when the sweep
// buffers a represent, which can be BEFORE the reply exists. This layer re-runs it
// at the moment the buffered represent is handed to the CLI bridge, catching the
// reply that landed in between (the double-send race).
describe("makeRepresentRedeliveryGuard — F1 delivery-time represent re-check", () => {
  const MSG_ID = 42;

  function representInbound(originTurnId: string, chatId: string): InboundMessage {
    return {
      type: "inbound",
      chatId,
      messageId: MSG_ID,
      user: "switchroom",
      userId: 0,
      ts: 1,
      text: "you have an earlier message…",
      meta: { source: "obligation_represent", origin_turn_id: originTurnId, chat_id: chatId },
    };
  }

  function openRepresented(ledger: ObligationLedger, representedAt: number, openedAt = 1000): void {
    ledger.openIfAbsent({ originTurnId: ORIGIN, chatId: CHAT, messageId: MSG_ID, text: "q", openedAt });
    ledger.markRepresented(ORIGIN, representedAt); // mirror the sweep stamping lastRepresentedAt
  }

  it("RETRACTS (drops + closes) a represent whose reply landed since the decision", () => {
    const ledger = new ObligationLedger();
    openRepresented(ledger, 2000); // sweep decided this represent at t=2000
    // The real reply was recorded at t=3000 (AFTER the decision) but its routing
    // missed the normal close path — the exact double-send race.
    const guard = makeRepresentRedeliveryGuard({
      enabled: true,
      historyEnabled: true,
      ledger,
      // Chat-scoped: only the obligation's OWN (resolved) chat id has the row —
      // outbound was recorded under the fallback-resolved id, which is o.chatId.
      hasOutboundDeliveredSince: (chat, sinceMs) => chat === CHAT && 3000 >= sinceMs,
      minReplyChars: 1,
      log: () => {},
    });
    expect(guard(representInbound(ORIGIN, CHAT))).toBe(false); // do NOT deliver
    expect(ledger.isOpen(ORIGIN)).toBe(false); // ledger closed by the retract
  });

  it("RETRACTS a represent whose obligation was already closed since it was buffered", () => {
    const ledger = new ObligationLedger();
    openRepresented(ledger, 2000);
    ledger.close(ORIGIN); // the normal close path DID fire after buffering
    const guard = makeRepresentRedeliveryGuard({
      enabled: true,
      historyEnabled: true,
      ledger,
      hasOutboundDeliveredSince: () => false, // irrelevant — obligation is gone
      minReplyChars: 1,
      log: () => {},
    });
    expect(guard(representInbound(ORIGIN, CHAT))).toBe(false); // stale → drop
  });

  it("PROCEEDS (delivers once) when NO outbound row exists — plain-text-no-reply (#2788)", () => {
    const ledger = new ObligationLedger();
    openRepresented(ledger, 2000);
    const guard = makeRepresentRedeliveryGuard({
      enabled: true,
      historyEnabled: true,
      ledger,
      hasOutboundDeliveredSince: () => false, // the agent never called the reply tool
      minReplyChars: 1,
      log: () => {},
    });
    expect(guard(representInbound(ORIGIN, CHAT))).toBe(true); // still fires exactly once
    expect(ledger.isOpen(ORIGIN)).toBe(true); // guard did NOT close it
  });

  it("PROCEEDS when the only reply PREDATES lastRepresentedAt (#2472 second-represent cutoff)", () => {
    const ledger = new ObligationLedger();
    openRepresented(ledger, 5000); // second represent decided at t=5000
    // A reply exists but only at t=3000 — it answered an EARLIER question, not
    // this represent. The delivery re-check must use the obligation's own cutoff
    // (lastRepresentedAt=5000), so this old reply does NOT suppress.
    const guard = makeRepresentRedeliveryGuard({
      enabled: true,
      historyEnabled: true,
      ledger,
      hasOutboundDeliveredSince: (_chat, sinceMs) => 3000 >= sinceMs,
      minReplyChars: 1,
      log: () => {},
    });
    expect(guard(representInbound(ORIGIN, CHAT))).toBe(true); // legitimate new represent fires
    expect(ledger.isOpen(ORIGIN)).toBe(true);
  });

  it("passes NON-represent inbounds through untouched", () => {
    const ledger = new ObligationLedger();
    openRepresented(ledger, 2000);
    const guard = makeRepresentRedeliveryGuard({
      enabled: true,
      historyEnabled: true,
      ledger,
      hasOutboundDeliveredSince: () => true, // would suppress a represent — but this isn't one
      minReplyChars: 1,
      log: () => {},
    });
    const userMsg: InboundMessage = {
      type: "inbound",
      chatId: CHAT,
      messageId: 7,
      user: "ken",
      userId: 1,
      ts: 1,
      text: "hello",
    };
    expect(guard(userMsg)).toBe(true);
    expect(ledger.isOpen(ORIGIN)).toBe(true);
  });

  it("is inert when the obligation ledger is disabled", () => {
    const ledger = new ObligationLedger();
    openRepresented(ledger, 2000);
    const guard = makeRepresentRedeliveryGuard({
      enabled: false,
      historyEnabled: true,
      ledger,
      hasOutboundDeliveredSince: () => true,
      minReplyChars: 1,
      log: () => {},
    });
    expect(guard(representInbound(ORIGIN, CHAT))).toBe(true); // never retracts when off
  });
});

// F2 (fix/represent-double-send-delivery-recheck) — a poke-cleared session that is
// STILL busy must not be treated as idle. Two halves: the bounded drain-defer
// (drain half) and the sweep decision folding session-busy into the bounded
// background-work grace (decision half).
describe("makeSessionBusyDrainDeferral — F2 bounded busy-defer for the idle drain", () => {
  it("defers while busy, then STOPS deferring once the bound elapses (red-team #2: no forever-silence)", () => {
    const defer = makeSessionBusyDrainDeferral(1000);
    expect(defer(true, 0)).toBe(true); // busy → defer the drain
    expect(defer(true, 500)).toBe(true); // still within the bound
    expect(defer(true, 999)).toBe(true);
    expect(defer(true, 1000)).toBe(false); // bound reached → drain anyway (bounded)
  });

  it("resets the deferral clock whenever the session reads idle", () => {
    const defer = makeSessionBusyDrainDeferral(1000);
    expect(defer(true, 0)).toBe(true);
    expect(defer(false, 400)).toBe(false); // idle → reset
    expect(defer(true, 500)).toBe(true); // fresh window opens at 500
    expect(defer(true, 1499)).toBe(true); // 999ms into the new window
    expect(defer(true, 1500)).toBe(false); // new bound elapsed
  });

  it("is disabled when the bound is <= 0 (kill switch)", () => {
    const off = makeSessionBusyDrainDeferral(0);
    expect(off(true, 0)).toBe(false);
    expect(off(true, 10_000)).toBe(false);
  });
});

describe("obligationSweep — F2 decision half: a poke-cleared-but-busy session defers, then re-asks (bounded)", () => {
  const GRACE = 20 * 60_000;
  const SWEEP_ORIGIN = "12345:_#77001";

  function makeWiring(opts: { ledger: ObligationLedger; pushed: InboundMessage[]; sessionBusy: boolean }) {
    const liveTurn = opts.sessionBusy ? ({ turnId: "live", endedAt: null } as any) : null;
    const deps = {
      OBLIGATION_LEDGER_ENABLED: true,
      HISTORY_ENABLED: true,
      OBLIGATION_BACKGROUND_WORK_GRACE_MS: GRACE,
      OBLIGATION_ESCALATE_GRACE_MS: 0,
      OBLIGATION_REPRESENT_GRACE_MS: 0,
      OBLIGATION_REPRESENT_MAX: 2,
      OBLIGATION_REPRESENT_GUARD_MIN_REPLY_CHARS: 1,
      OBLIGATION_ESCALATE_MAX: 3,
      OBLIGATION_ESCALATE_SEND_DEADLINE_MS: 10_000,
      obligationLedger: opts.ledger,
      obligationEscalateInFlight: new Set<string>(),
      pendingCrossTurnGate: { set: () => {} },
      pendingInboundBuffer: {
        depth: () => 0,
        push: (_agent: string, m: InboundMessage) => {
          opts.pushed.push(m);
          return true;
        },
      },
      capturedResume: { dispatch: () => {} },
      getCurrentTurn: () => liveTurn,
      // The ~5-min silence poke has ALREADY cleared the machine turn.
      turnInFlightForGate: () => false,
      agentHasInFlightBackgroundWork: () => false,
      // No reply has been delivered — a genuinely unanswered turn.
      hasOutboundDeliveredSince: () => false,
      findTurnByOriginId: () => undefined,
      bridgeAlive: () => true,
      sendEscalationNudge: () => {},
    };
    // The wiring's dep type is derived from the gateway; the shape above matches
    // the fields the sweep reads.
    return createObligationWiring(deps as unknown as Parameters<typeof createObligationWiring>[0]);
  }

  function open(ledger: ObligationLedger, openedAt: number): void {
    ledger.openIfAbsent({
      originTurnId: SWEEP_ORIGIN,
      chatId: CHAT,
      messageId: 77001,
      text: "an unanswered question",
      openedAt,
    });
  }

  it("DEFERS the represent while the session is busy and the obligation is younger than the grace", () => {
    const ledger = new ObligationLedger(2);
    const pushed: InboundMessage[] = [];
    const wiring = makeWiring({ ledger, pushed, sessionBusy: true });
    open(ledger, Date.now()); // age ~0 < GRACE
    wiring.obligationSweep();
    expect(pushed).toHaveLength(0); // deferred — no represent buffered
    expect(ledger.isOpen(SWEEP_ORIGIN)).toBe(true);
  });

  it("RE-ASKS once the bound expires even though the session is still busy (bounded, not silent)", () => {
    const ledger = new ObligationLedger(2);
    const pushed: InboundMessage[] = [];
    const wiring = makeWiring({ ledger, pushed, sessionBusy: true });
    open(ledger, Date.now() - (GRACE + 60_000)); // age > GRACE → bound expired
    wiring.obligationSweep();
    expect(pushed).toHaveLength(1); // represent fires despite the still-busy session
    expect(pushed[0]?.meta?.source).toBe("obligation_represent");
  });

  it("does NOT defer when the session is idle (represent fires immediately)", () => {
    const ledger = new ObligationLedger(2);
    const pushed: InboundMessage[] = [];
    const wiring = makeWiring({ ledger, pushed, sessionBusy: false });
    open(ledger, Date.now()); // young, but session is genuinely idle
    wiring.obligationSweep();
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.meta?.source).toBe("obligation_represent");
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
