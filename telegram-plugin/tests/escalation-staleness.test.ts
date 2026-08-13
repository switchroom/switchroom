import { describe, it, expect } from "vitest";
import {
  answeredSinceOpen,
  createEscalationSettleGate,
  resolveEscalateSettleMs,
  OBLIGATION_ESCALATE_SETTLE_MS_DEFAULT,
} from "../gateway/escalation-staleness.js";
import { ObligationLedger } from "../gateway/obligation-ledger.js";
import { createObligationWiring } from "../gateway/obligation-wiring.js";
import type { InboundMessage } from "../gateway/ipc-protocol.js";

// Regression suite for the false "⚠️ I may have missed an earlier message"
// escalation that lands ON TOP of an answer the user already received.
//
// Two defects in the escalate branch's staleness check, both confirmed in
// marko's gateway-supervisor.log:
//
//   1. THREAD SCOPING (2026-08-13 04:03). Obligation `<chat>:4#5462` lived in
//      thread 4; the agent's answer (message 5494, 295 chars) was routed to
//      thread 3 and delivered at 04:02:51.987. The thread-keyed check never saw
//      it and the nag fired 14.2s LATER, at 04:03:06.140.
//
//   2. NO SETTLE (2026-08-10 06:36 and 07:52). The answer was still in flight at
//      the moment the sweep decided — the reply tool had been invoked but the
//      history row did not exist yet. Decision 06:36:08.047 → delivery
//      06:36:09.281 (1,234 ms) and decision 07:52:34.400 → delivery
//      07:52:37.209 (2,809 ms).
//
// And the invariant the fix must NOT break: 2026-08-12 09:08, where the agent
// genuinely had not answered — its real reply (5357) landed 41,331 ms after the
// escalation decision. That obligation must still escalate.

const CHAT = "-100999";
const OBLIGATION_THREAD = 4;
const ANSWER_THREAD = 3; // the router's `EXPLICIT_OVERRIDDEN(model→4,routed→3)` reroute

/**
 * Models the real history predicate: an assistant row delivered at `deliveredAt`
 * under `thread`. `threadId === undefined` from the caller means CHAT scope.
 */
function historyWithAnswer(deliveredAt: number, thread: number | null) {
  return (chatId: string, sinceMs: number, threadId?: number | null): boolean => {
    if (chatId !== CHAT) return false;
    if (threadId !== undefined && threadId !== thread) return false;
    return deliveredAt >= sinceMs;
  };
}

describe("answeredSinceOpen — cross-topic delivered answer must stand the escalation down", () => {
  it("counts an answer delivered to a DIFFERENT thread in the same chat (2026-08-13 04:03)", () => {
    // Pre-fix this asked history for thread 4 only, found nothing, and nagged.
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 1000, threadId: OBLIGATION_THREAD },
      {
        historyEnabled: true,
        hasOutboundDeliveredSince: historyWithAnswer(2000, ANSWER_THREAD),
      },
    );
    expect(answered).toBe(true);
  });

  it("counts an answer delivered to the chat ROOT when the obligation is in a topic", () => {
    // 2026-08-10 07:52: obligation in thread 3, answer 5232 recorded thread_id NULL.
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 1000, threadId: 3 },
      { historyEnabled: true, hasOutboundDeliveredSince: historyWithAnswer(2000, null) },
    );
    expect(answered).toBe(true);
  });

  it("still counts a same-thread answer (the pre-existing behaviour is preserved)", () => {
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 1000, threadId: OBLIGATION_THREAD },
      {
        historyEnabled: true,
        hasOutboundDeliveredSince: historyWithAnswer(2000, OBLIGATION_THREAD),
      },
    );
    expect(answered).toBe(true);
  });

  it("does NOT count an answer in a DIFFERENT chat (the widening is chat-scoped, not global)", () => {
    const answered = answeredSinceOpen(
      { chatId: "-100777", openedAt: 1000, threadId: OBLIGATION_THREAD },
      {
        historyEnabled: true,
        hasOutboundDeliveredSince: historyWithAnswer(2000, ANSWER_THREAD),
      },
    );
    expect(answered).toBe(false);
  });

  it("does NOT count an answer that PREDATES the obligation", () => {
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 5000, threadId: OBLIGATION_THREAD },
      {
        historyEnabled: true,
        hasOutboundDeliveredSince: historyWithAnswer(2000, ANSWER_THREAD),
      },
    );
    expect(answered).toBe(false);
  });

  it("reports false when history is unavailable (never suppresses on doubt)", () => {
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 1000, threadId: OBLIGATION_THREAD },
      { historyEnabled: false, hasOutboundDeliveredSince: () => true },
    );
    expect(answered).toBe(false);
  });
});

describe("createEscalationSettleGate — the nudge waits out an in-flight answer", () => {
  const ID = "-100999:4#5462";

  it("defers the FIRST decision and proceeds only after the settle window", () => {
    const gate = createEscalationSettleGate(8_500);
    expect(gate.shouldDefer(ID, 0)).toBe(true); // first look — settle
    expect(gate.shouldDefer(ID, 5_000)).toBe(true); // next 5s sweep, still settling
    expect(gate.shouldDefer(ID, 8_499)).toBe(true);
    expect(gate.shouldDefer(ID, 8_500)).toBe(false); // window elapsed → escalate
  });

  it("is disabled by a zero window (kill switch → pre-fix immediate escalate)", () => {
    const gate = createEscalationSettleGate(0);
    expect(gate.shouldDefer(ID, 0)).toBe(false);
  });

  it("clear() forgets the episode so a later escalate settles afresh", () => {
    const gate = createEscalationSettleGate(8_500);
    expect(gate.shouldDefer(ID, 0)).toBe(true);
    expect(gate.shouldDefer(ID, 9_000)).toBe(false);
    gate.clear(ID);
    expect(gate.size()).toBe(0);
    expect(gate.shouldDefer(ID, 10_000)).toBe(true); // fresh window, not stale-proceed
  });

  it("tracks obligations independently", () => {
    const gate = createEscalationSettleGate(8_500);
    expect(gate.shouldDefer("a", 0)).toBe(true);
    expect(gate.shouldDefer("b", 8_000)).toBe(true);
    expect(gate.shouldDefer("a", 9_000)).toBe(false); // a's window elapsed
    expect(gate.shouldDefer("b", 9_000)).toBe(true); // b's has not
  });

  it("a backwards clock jump re-anchors instead of pinning the gate open forever", () => {
    const gate = createEscalationSettleGate(8_500);
    expect(gate.shouldDefer(ID, 100_000)).toBe(true);
    expect(gate.shouldDefer(ID, 10_000)).toBe(true); // jumped back → re-anchor
    expect(gate.shouldDefer(ID, 18_500)).toBe(false); // one window from the new anchor
  });

  it("bounds its id map (a long-lived gateway cannot grow it without limit)", () => {
    const gate = createEscalationSettleGate(8_500, 4);
    for (let i = 0; i < 50; i++) gate.shouldDefer(`id-${i}`, i);
    expect(gate.size()).toBeLessThanOrEqual(4);
  });
});

describe("resolveEscalateSettleMs", () => {
  it("defaults to the derived window", () => {
    expect(resolveEscalateSettleMs({})).toBe(OBLIGATION_ESCALATE_SETTLE_MS_DEFAULT);
  });
  it("honours an explicit 0 kill switch", () => {
    expect(resolveEscalateSettleMs({ SWITCHROOM_OBLIGATION_ESCALATE_SETTLE_MS: "0" })).toBe(0);
  });
  it("falls back to the default on garbage rather than disabling the guard", () => {
    expect(resolveEscalateSettleMs({ SWITCHROOM_OBLIGATION_ESCALATE_SETTLE_MS: "soon" })).toBe(
      OBLIGATION_ESCALATE_SETTLE_MS_DEFAULT,
    );
    expect(resolveEscalateSettleMs({ SWITCHROOM_OBLIGATION_ESCALATE_SETTLE_MS: "-1" })).toBe(
      OBLIGATION_ESCALATE_SETTLE_MS_DEFAULT,
    );
  });
});

// End-to-end through the real sweep: the assertion is the OUTCOME the user sees —
// did the "I may have missed this" nudge go out, and was the obligation closed?
describe("obligationSweep escalate branch — no nag on top of a delivered answer", () => {
  const ORIGIN = `${CHAT}:${OBLIGATION_THREAD}#5462`;

  function makeWiring(opts: {
    ledger: ObligationLedger;
    hasOutboundDeliveredSince: (chatId: string, sinceMs: number, threadId?: number | null) => boolean;
  }) {
    const nudges: string[] = [];
    const deps = {
      OBLIGATION_LEDGER_ENABLED: true,
      HISTORY_ENABLED: true,
      OBLIGATION_BACKGROUND_WORK_GRACE_MS: 0,
      OBLIGATION_ESCALATE_GRACE_MS: 0,
      OBLIGATION_REPRESENT_GRACE_MS: 0,
      OBLIGATION_REPRESENT_MAX: 2,
      OBLIGATION_REPRESENT_GUARD_MIN_REPLY_CHARS: 1,
      OBLIGATION_ESCALATE_MAX: 3,
      OBLIGATION_ESCALATE_SEND_DEADLINE_MS: 10_000,
      obligationLedger: opts.ledger,
      obligationEscalateInFlight: new Set<string>(),
      pendingCrossTurnGate: { set: () => {} },
      pendingInboundBuffer: { depth: () => 0, push: () => true },
      capturedResume: { dispatch: () => {} },
      getCurrentTurn: () => null,
      turnInFlightForGate: () => false,
      agentHasInFlightBackgroundWork: () => false,
      hasOutboundDeliveredSince: opts.hasOutboundDeliveredSince,
      findTurnByOriginId: () => undefined,
      bridgeAlive: () => true,
      sendEscalationNudge: (o: { originTurnId: string }) => {
        nudges.push(o.originTurnId);
        return Promise.resolve();
      },
    };
    const wiring = createObligationWiring(
      deps as unknown as Parameters<typeof createObligationWiring>[0],
    );
    return { wiring, nudges };
  }

  /** Open an obligation whose represent ladder is already exhausted → escalate. */
  function openExhausted(ledger: ObligationLedger, openedAt: number): void {
    ledger.openIfAbsent({
      originTurnId: ORIGIN,
      chatId: CHAT,
      threadId: OBLIGATION_THREAD,
      messageId: 5462,
      text: "review lukes sales report",
      openedAt,
    });
    ledger.markRepresented(ORIGIN);
    ledger.markRepresented(ORIGIN); // count == max → decideAtIdle returns 'escalate'
  }

  it("(b) an answer delivered to a DIFFERENT thread in the same chat suppresses the nudge", () => {
    // 2026-08-13 04:03 reproduction. Pre-fix: the thread-4 query misses the
    // thread-3 answer and the nag fires. Post-fix: closed silently, no nudge.
    const ledger = new ObligationLedger(2);
    const openedAt = Date.now() - 60_000;
    const { wiring, nudges } = makeWiring({
      ledger,
      hasOutboundDeliveredSince: historyWithAnswer(Date.now() - 14_200, ANSWER_THREAD),
    });
    openExhausted(ledger, openedAt);

    wiring.obligationSweep();

    expect(nudges).toEqual([]); // the user is NOT nagged on top of their answer
    expect(ledger.isOpen(ORIGIN)).toBe(false); // closed silently
  });

  it("(a) an answer that lands while the first escalate decision is settling suppresses the nudge", () => {
    // 2026-08-10 06:36 / 07:52 reproduction: at the first decision the reply is
    // in flight and no history row exists yet; it appears ~1-3s later. Pre-fix
    // the nudge is sent on that very first decision.
    const ledger = new ObligationLedger(2);
    const openedAt = Date.now() - 60_000;
    let answerDelivered = false;
    const { wiring, nudges } = makeWiring({
      ledger,
      // Reads false until the in-flight reply is recorded, then true.
      hasOutboundDeliveredSince: (chatId, sinceMs) =>
        answerDelivered && chatId === CHAT && Date.now() >= sinceMs,
    });
    openExhausted(ledger, openedAt);

    wiring.obligationSweep(); // decision 1 — answer still in flight
    expect(nudges).toEqual([]); // settling, not sent
    expect(ledger.isOpen(ORIGIN)).toBe(true); // and not lost

    answerDelivered = true; // the reply's history row lands 1.2s later
    wiring.obligationSweep(); // next sweep re-checks

    expect(nudges).toEqual([]); // still no nag
    expect(ledger.isOpen(ORIGIN)).toBe(false); // closed silently instead
  });

  it("(c) a genuinely unanswered obligation STILL escalates once the settle window elapses", () => {
    // 2026-08-12 09:08: the agent really had not answered (its reply was 41s
    // away). The guards must not swallow this — the nudge is the whole point.
    const ledger = new ObligationLedger(2);
    const { wiring, nudges } = makeWiring({
      ledger,
      hasOutboundDeliveredSince: () => false, // nothing was ever delivered
    });
    openExhausted(ledger, Date.now() - 600_000);

    wiring.obligationSweep(); // decision 1 — settles
    expect(nudges).toEqual([]);
    expect(ledger.isOpen(ORIGIN)).toBe(true); // held open, not dropped

    // A later sweep, past the settle window. The gate reads the wall clock the
    // sweep passes it, so advance real time by stubbing Date.now.
    const realNow = Date.now;
    try {
      const t = realNow() + OBLIGATION_ESCALATE_SETTLE_MS_DEFAULT + 1_000;
      Date.now = () => t;
      wiring.obligationSweep();
    } finally {
      Date.now = realNow;
    }

    expect(nudges).toEqual([ORIGIN]); // the genuine escalation fires
  });

  it("the settle deferral is bounded — it cannot silence a genuine escalation indefinitely", () => {
    const ledger = new ObligationLedger(2);
    const { wiring, nudges } = makeWiring({ ledger, hasOutboundDeliveredSince: () => false });
    openExhausted(ledger, Date.now() - 600_000);

    const realNow = Date.now;
    try {
      const base = realNow();
      // Sweep every 5s across the settle window, as the real 5s interval does.
      for (const offset of [0, 5_000, 10_000]) {
        Date.now = () => base + offset;
        wiring.obligationSweep();
      }
    } finally {
      Date.now = realNow;
    }
    // Escalated within two sweep ticks of the first decision — not swallowed.
    expect(nudges).toEqual([ORIGIN]);
  });
});
