import { describe, it, expect } from "vitest";
import {
  answeredSinceOpen,
  createEscalationSettleGate,
  resolveEscalateSettleMs,
  OBLIGATION_ESCALATE_SETTLE_MS_DEFAULT,
  OBLIGATION_ESCALATE_SETTLE_MS_MAX,
} from "../gateway/escalation-staleness.js";
import {
  createAnswerRouteOverrides,
  answerRouteOverrides,
} from "../gateway/answer-route-overrides.js";
import { ObligationLedger } from "../gateway/obligation-ledger.js";
import { createObligationWiring } from "../gateway/obligation-wiring.js";

// Regression suite for the false "⚠️ I may have missed an earlier message"
// escalation that lands ON TOP of an answer the user already received — and for
// the opposite failure the fix must not introduce, where a genuinely unanswered
// message is silently closed by someone else's answer.
//
// Both defects were confirmed in marko's gateway-supervisor.log. Only ids,
// topics and timings are reproduced here; no chat id and no message bodies.
//
//   1. REROUTED ANSWER (2026-08-10 06:36). Obligation `…:4#5191` lived in thread
//      4; the model addressed its reply to thread 4 and the framework's topic
//      authority overrode that to thread 635 — logged
//      `EXPLICIT_OVERRIDDEN(model→4,routed→635)` at 06:36:07.921. The
//      thread-4-keyed staleness check never saw the answer and the nag fired
//      126 ms later at 06:36:08.047.
//
//   2. NO SETTLE (2026-08-10 06:36 and 07:52). The answer was still in flight at
//      the moment the sweep decided — the reply tool had been invoked but the
//      history row did not exist yet. Decision 06:36:08.047 → delivery
//      06:36:09.281 (1,234 ms) and decision 07:52:34.400 → delivery
//      07:52:37.209 (2,809 ms).
//
// And the two invariants the fix must NOT break:
//
//   - 2026-08-12 09:08, where the agent genuinely had not answered — its real
//     reply landed 41,331 ms after the escalation decision. That obligation must
//     still escalate.
//   - 2026-08-13 04:03, where obligation `…:4#5462` (thread 4) escalated at
//     04:03:06.140 while a 292-char answer had landed at 04:02:50.521 — but that
//     answer was `via=origin` to turn `…:3#5480`, a DIFFERENT question in topic
//     3, with NO override logged anywhere in the represent→escalate window.
//     Topic 4's message was genuinely unanswered. A chat-wide "did anything long
//     land" fallback would have closed it silently; the override-gated fallback
//     must not.

const CHAT = "-100999";
const OBLIGATION_THREAD = 4;
const ROUTED_THREAD = 635; // the router's `EXPLICIT_OVERRIDDEN(model→4,routed→635)` reroute
const UNRELATED_THREAD = 3;

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

/** A route-override registry pre-loaded with one recorded reroute. */
function overridesWithReroute(
  intendedThreadId: number,
  routedThreadId: number | undefined,
  atMs: number,
  chatId = CHAT,
) {
  const reg = createAnswerRouteOverrides();
  reg.note({
    chatId,
    enabled: true,
    explicitThreadId: intendedThreadId,
    anchored: true,
    routedThreadId,
    nowMs: atMs,
  });
  return reg;
}

const NO_OVERRIDES = createAnswerRouteOverrides();

describe("answerRouteOverrides — records only genuine explicit-thread overrides", () => {
  it("records the reroute the router logs as EXPLICIT_OVERRIDDEN", () => {
    const reg = createAnswerRouteOverrides();
    expect(
      reg.note({
        chatId: CHAT,
        enabled: true,
        explicitThreadId: 4,
        anchored: true,
        routedThreadId: 635,
        nowMs: 1000,
      }),
    ).toBe(true);
    expect(reg.routedThreadsSince(CHAT, 4, 0)).toEqual([635]);
  });

  it("maps a chat-root routing to an explicit NULL thread, never to 'any thread'", () => {
    // 2026-08-10 07:52: `EXPLICIT_OVERRIDDEN(model→3,routed→-)`; recordOutbound
    // writes `thread_id IS NULL` for a threadless send.
    const reg = overridesWithReroute(3, undefined, 1000);
    expect(reg.routedThreadsSince(CHAT, 3, 0)).toEqual([null]);
  });

  it("does NOT record when the routing agreed with the model", () => {
    const reg = createAnswerRouteOverrides();
    expect(
      reg.note({
        chatId: CHAT,
        enabled: true,
        explicitThreadId: 4,
        anchored: true,
        routedThreadId: 4,
        nowMs: 1000,
      }),
    ).toBe(false);
    expect(reg.routedThreadsSince(CHAT, 4, 0)).toEqual([]);
  });

  it("does NOT record when the model named no topic, or no anchor could override it", () => {
    const reg = createAnswerRouteOverrides();
    const base = { chatId: CHAT, enabled: true, routedThreadId: 635, nowMs: 1000 };
    expect(reg.note({ ...base, explicitThreadId: undefined, anchored: true })).toBe(false);
    expect(reg.note({ ...base, explicitThreadId: 4, anchored: false })).toBe(false);
    expect(reg.note({ ...base, explicitThreadId: 4, anchored: true, enabled: false })).toBe(false);
    expect(reg.size()).toBe(0);
  });

  it("scopes by chat and by intended thread", () => {
    const reg = overridesWithReroute(4, 635, 1000);
    expect(reg.routedThreadsSince("-100777", 4, 0)).toEqual([]);
    expect(reg.routedThreadsSince(CHAT, 3, 0)).toEqual([]);
  });

  it("ignores an override that predates the cutoff", () => {
    const reg = overridesWithReroute(4, 635, 1000);
    expect(reg.routedThreadsSince(CHAT, 4, 5000)).toEqual([]);
  });

  it("bounds both the key count and the per-key history", () => {
    const reg = createAnswerRouteOverrides(3, 2);
    for (let i = 0; i < 20; i++) {
      reg.note({
        chatId: `chat-${i}`,
        enabled: true,
        explicitThreadId: 4,
        anchored: true,
        routedThreadId: 635,
        nowMs: i,
      });
    }
    expect(reg.size()).toBeLessThanOrEqual(3);
    for (let i = 0; i < 20; i++) {
      reg.note({
        chatId: CHAT,
        enabled: true,
        explicitThreadId: 4,
        anchored: true,
        routedThreadId: i,
        nowMs: i,
      });
    }
    expect(reg.routedThreadsSince(CHAT, 4, 0).length).toBeLessThanOrEqual(2);
  });
});

describe("answeredSinceOpen — a REROUTED answer stands the escalation down", () => {
  it("counts an answer the router recorded as rerouted out of this topic (2026-08-10 06:36)", () => {
    // Pre-fix this asked history for thread 4 only, found nothing, and nagged.
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 1000, threadId: OBLIGATION_THREAD },
      {
        historyEnabled: true,
        hasOutboundDeliveredSince: historyWithAnswer(2000, ROUTED_THREAD),
        routeOverrides: overridesWithReroute(OBLIGATION_THREAD, ROUTED_THREAD, 1500),
      },
    );
    expect(answered).toEqual({ answered: true, via: "reroute", routedThreadId: ROUTED_THREAD });
  });

  it("counts an answer rerouted to the chat ROOT (2026-08-10 07:52)", () => {
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 1000, threadId: 3 },
      {
        historyEnabled: true,
        hasOutboundDeliveredSince: historyWithAnswer(2000, null),
        routeOverrides: overridesWithReroute(3, undefined, 1500),
      },
    );
    expect(answered).toEqual({ answered: true, via: "reroute", routedThreadId: null });
  });

  it("still counts a same-thread answer (the pre-existing behaviour is preserved)", () => {
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 1000, threadId: OBLIGATION_THREAD },
      {
        historyEnabled: true,
        hasOutboundDeliveredSince: historyWithAnswer(2000, OBLIGATION_THREAD),
        routeOverrides: NO_OVERRIDES,
      },
    );
    expect(answered).toEqual({ answered: true, via: "thread" });
  });

  it("does NOT count an unrelated answer in ANOTHER topic with no reroute on record (2026-08-13 04:03)", () => {
    // The whole point of the override gate: topic 3's answer to a DIFFERENT
    // question must not close topic 4's genuinely-unanswered obligation.
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 1000, threadId: OBLIGATION_THREAD },
      {
        historyEnabled: true,
        hasOutboundDeliveredSince: historyWithAnswer(2000, UNRELATED_THREAD),
        routeOverrides: NO_OVERRIDES,
      },
    );
    expect(answered).toEqual({ answered: false, via: null });
  });

  it("does NOT follow a reroute recorded for a DIFFERENT topic", () => {
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 1000, threadId: OBLIGATION_THREAD },
      {
        historyEnabled: true,
        hasOutboundDeliveredSince: historyWithAnswer(2000, ROUTED_THREAD),
        // The override belongs to topic 3's answer, not topic 4's.
        routeOverrides: overridesWithReroute(UNRELATED_THREAD, ROUTED_THREAD, 1500),
      },
    );
    expect(answered.answered).toBe(false);
  });

  it("does NOT follow a reroute that PREDATES the obligation", () => {
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 5000, threadId: OBLIGATION_THREAD },
      {
        historyEnabled: true,
        hasOutboundDeliveredSince: historyWithAnswer(6000, ROUTED_THREAD),
        routeOverrides: overridesWithReroute(OBLIGATION_THREAD, ROUTED_THREAD, 1500),
      },
    );
    expect(answered.answered).toBe(false);
  });

  it("does NOT count an answer in a DIFFERENT chat", () => {
    const answered = answeredSinceOpen(
      { chatId: "-100777", openedAt: 1000, threadId: OBLIGATION_THREAD },
      {
        historyEnabled: true,
        hasOutboundDeliveredSince: historyWithAnswer(2000, ROUTED_THREAD),
        routeOverrides: overridesWithReroute(OBLIGATION_THREAD, ROUTED_THREAD, 1500),
      },
    );
    expect(answered.answered).toBe(false);
  });

  it("does NOT count an answer that PREDATES the obligation", () => {
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 5000, threadId: OBLIGATION_THREAD },
      {
        historyEnabled: true,
        hasOutboundDeliveredSince: historyWithAnswer(2000, OBLIGATION_THREAD),
        routeOverrides: NO_OVERRIDES,
      },
    );
    expect(answered.answered).toBe(false);
  });

  it("reports not-answered when history is unavailable (never suppresses on doubt)", () => {
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 1000, threadId: OBLIGATION_THREAD },
      {
        historyEnabled: false,
        hasOutboundDeliveredSince: () => true,
        routeOverrides: NO_OVERRIDES,
      },
    );
    expect(answered.answered).toBe(false);
  });
});

describe("createEscalationSettleGate — the nudge waits out an in-flight answer", () => {
  const ID = "-100999:4#5462";
  const OPENED = 111;

  it("defers the FIRST decision and proceeds only after the settle window", () => {
    const gate = createEscalationSettleGate(8_500);
    expect(gate.shouldDefer(ID, 0, OPENED)).toBe(true); // first look — settle
    expect(gate.shouldDefer(ID, 5_000, OPENED)).toBe(true); // next 5s sweep, still settling
    expect(gate.shouldDefer(ID, 8_499, OPENED)).toBe(true);
    expect(gate.shouldDefer(ID, 8_500, OPENED)).toBe(false); // window elapsed → escalate
  });

  it("is disabled by a zero window (kill switch → pre-fix immediate escalate)", () => {
    const gate = createEscalationSettleGate(0);
    expect(gate.shouldDefer(ID, 0, OPENED)).toBe(false);
  });

  it("clear() forgets the episode so a later escalate settles afresh", () => {
    const gate = createEscalationSettleGate(8_500);
    expect(gate.shouldDefer(ID, 0, OPENED)).toBe(true);
    expect(gate.shouldDefer(ID, 9_000, OPENED)).toBe(false);
    gate.clear(ID);
    expect(gate.size()).toBe(0);
    expect(gate.shouldDefer(ID, 10_000, OPENED)).toBe(true); // fresh window, not stale-proceed
  });

  it("a RE-OPENED obligation under the same origin id gets its own fresh window", () => {
    const gate = createEscalationSettleGate(8_500);
    expect(gate.shouldDefer(ID, 0, OPENED)).toBe(true);
    expect(gate.shouldDefer(ID, 9_000, OPENED)).toBe(false); // episode 1 escalates
    // Re-opened: a new openedAt. Its first decision must NOT inherit episode 1's
    // elapsed window and skip the re-check.
    expect(gate.shouldDefer(ID, 9_100, OPENED + 1)).toBe(true);
    expect(gate.shouldDefer(ID, 17_599, OPENED + 1)).toBe(true);
    expect(gate.shouldDefer(ID, 17_600, OPENED + 1)).toBe(false);
  });

  it("tracks obligations independently", () => {
    const gate = createEscalationSettleGate(8_500);
    expect(gate.shouldDefer("a", 0, OPENED)).toBe(true);
    expect(gate.shouldDefer("b", 8_000, OPENED)).toBe(true);
    expect(gate.shouldDefer("a", 9_000, OPENED)).toBe(false); // a's window elapsed
    expect(gate.shouldDefer("b", 9_000, OPENED)).toBe(true); // b's has not
  });

  it("a backwards clock jump re-anchors instead of pinning the gate open forever", () => {
    const gate = createEscalationSettleGate(8_500);
    expect(gate.shouldDefer(ID, 100_000, OPENED)).toBe(true);
    expect(gate.shouldDefer(ID, 10_000, OPENED)).toBe(true); // jumped back → re-anchor
    expect(gate.shouldDefer(ID, 18_500, OPENED)).toBe(false); // one window from the new anchor
  });

  it("bounds its id map (a long-lived gateway cannot grow it without limit)", () => {
    const gate = createEscalationSettleGate(8_500, 4);
    for (let i = 0; i < 50; i++) gate.shouldDefer(`id-${i}`, i, OPENED);
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
  it("clamps an absurd window so a config typo cannot suppress escalation for a day", () => {
    expect(
      resolveEscalateSettleMs({ SWITCHROOM_OBLIGATION_ESCALATE_SETTLE_MS: "85000000" }),
    ).toBe(OBLIGATION_ESCALATE_SETTLE_MS_MAX);
    expect(
      resolveEscalateSettleMs({ SWITCHROOM_OBLIGATION_ESCALATE_SETTLE_MS: "Infinity" }),
    ).toBe(OBLIGATION_ESCALATE_SETTLE_MS_DEFAULT); // not finite → default, not clamp
  });
  it("passes a deliberate in-range tuning through untouched", () => {
    expect(resolveEscalateSettleMs({ SWITCHROOM_OBLIGATION_ESCALATE_SETTLE_MS: "20000" })).toBe(
      20_000,
    );
  });
});

// End-to-end through the real sweep: the assertion is the OUTCOME the user sees —
// did the "I may have missed this" nudge go out, and was the obligation closed?
describe("obligationSweep escalate branch — nag only when the answer really is missing", () => {
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
  function openExhausted(ledger: ObligationLedger, openedAt: number, origin = ORIGIN): void {
    ledger.openIfAbsent({
      originTurnId: origin,
      chatId: CHAT,
      threadId: OBLIGATION_THREAD,
      messageId: 5462,
      text: "synthetic fixture question about the widget report",
      openedAt,
    });
    ledger.markRepresented(origin);
    ledger.markRepresented(origin); // count == max → decideAtIdle returns 'escalate'
  }

  it("(b) an answer the router RECORDED as rerouted out of this topic suppresses the nudge", () => {
    // 2026-08-10 06:36 reproduction. Pre-fix: the thread-4 query misses the
    // thread-635 answer and the nag fires. Post-fix: closed silently, no nudge.
    const ledger = new ObligationLedger(2);
    const openedAt = Date.now() - 60_000;
    const { wiring, nudges } = makeWiring({
      ledger,
      hasOutboundDeliveredSince: historyWithAnswer(Date.now() - 14_200, ROUTED_THREAD),
    });
    answerRouteOverrides.note({
      chatId: CHAT,
      enabled: true,
      explicitThreadId: OBLIGATION_THREAD,
      anchored: true,
      routedThreadId: ROUTED_THREAD,
      nowMs: Date.now() - 14_300,
    });
    openExhausted(ledger, openedAt);

    wiring.obligationSweep();

    expect(nudges).toEqual([]); // the user is NOT nagged on top of their answer
    expect(ledger.isOpen(ORIGIN)).toBe(false); // closed silently
  });

  it("(d) an UNRELATED long message in another topic does NOT suppress the nudge (2026-08-13 04:03)", () => {
    // The blocker this guard exists for. Obligation open in topic 4; a long
    // assistant message lands in topic 3 answering a DIFFERENT question, with no
    // reroute on record. A chat-wide fallback closes topic 4's obligation
    // silently and the user's message is dropped with no nudge and no
    // re-present. It must escalate instead.
    const ledger = new ObligationLedger(2);
    const ORIGIN_D = `${CHAT}:${OBLIGATION_THREAD}#5463`;
    const { wiring, nudges } = makeWiring({
      ledger,
      // A substantive assistant row exists in topic 3 — and ONLY in topic 3.
      hasOutboundDeliveredSince: historyWithAnswer(Date.now() - 15_000, UNRELATED_THREAD),
    });
    openExhausted(ledger, Date.now() - 600_000, ORIGIN_D);

    const realNow = Date.now;
    try {
      const base = realNow();
      for (const offset of [0, 5_000, 10_000]) {
        Date.now = () => base + offset;
        wiring.obligationSweep();
      }
    } finally {
      Date.now = realNow;
    }

    expect(nudges).toEqual([ORIGIN_D]); // topic 4's message is NOT silently dropped
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
      // Reads false until the in-flight reply is recorded, then true — in the
      // obligation's OWN topic, so no reroute record is needed.
      hasOutboundDeliveredSince: (chatId, sinceMs, threadId) =>
        answerDelivered &&
        chatId === CHAT &&
        (threadId === undefined || threadId === OBLIGATION_THREAD) &&
        Date.now() >= sinceMs,
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

  it("the settle deferral is real AND bounded — deferred across the window, then sent", () => {
    const ledger = new ObligationLedger(2);
    const { wiring, nudges } = makeWiring({ ledger, hasOutboundDeliveredSince: () => false });
    openExhausted(ledger, Date.now() - 600_000);

    const realNow = Date.now;
    const seen: string[][] = [];
    try {
      const base = realNow();
      // Sweep every 5s across the settle window, as the real 5s interval does,
      // recording what the user had received after each tick.
      for (const offset of [0, 5_000, 10_000]) {
        Date.now = () => base + offset;
        wiring.obligationSweep();
        seen.push([...nudges]);
      }
    } finally {
      Date.now = realNow;
    }
    // The deferral actually happened: nothing sent on the first two ticks, both
    // inside the 8.5s window. (Without the gate the nudge goes out on tick 1.)
    expect(seen[0]).toEqual([]);
    expect(seen[1]).toEqual([]);
    // And it is bounded: escalated on the first tick past the window.
    expect(seen[2]).toEqual([ORIGIN]);
  });
});
