import { describe, it, expect, beforeEach } from "vitest";
import {
  answeredSinceOpen,
  createEscalationSettleGate,
  resolveEscalateSettleMs,
  resolveRerouteMatchWindowMs,
  OBLIGATION_ESCALATE_SETTLE_MS_DEFAULT,
  OBLIGATION_ESCALATE_SETTLE_MS_MAX,
  OBLIGATION_REROUTE_MATCH_MS_MAX,
  REROUTE_MATCH_GRACE_MS,
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
//   - 2026-08-13 04:03, where obligation `…:4#5462` (thread 4, opened
//     03:50:02.807) escalated at 04:03:06.140. Its window holds THREE
//     `EXPLICIT_OVERRIDDEN(model→4,routed→3)` records (03:50:44.201,
//     03:51:43.108, 03:53:11.225) AND a later, unrelated 295-char delivery in
//     thread 3 at 04:02:51.987 answering a DIFFERENT question (`via=origin` to
//     turn `…:3#5480`). Topic 4's message was genuinely unanswered, so this
//     obligation MUST escalate. It is the counter-example that kills both weaker
//     fallbacks: chat-wide, and override-gated-but-cut-at-`openedAt` (which
//     pairs the 03:53 override with the 04:02 delivery). The newest override is
//     594.8 s stale at the decision, so the freshness window rejects it.

const CHAT = "-100999";
const OBLIGATION_THREAD = 4;
const ROUTED_THREAD = 635; // the router's `EXPLICIT_OVERRIDDEN(model→4,routed→635)` reroute
const UNRELATED_THREAD = 3;
// A separate intended topic for the end-to-end counter-example, so its entries
// in the process-wide override registry cannot collide with another test's.
const THREAD_D = 44;

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

// `answerRouteOverrides` is a process-wide module singleton and the end-to-end
// scenarios below note real records into it with wall-clock timestamps. Reset it
// before every test so no scenario inherits (or silently depends on) another's.
beforeEach(() => {
  answerRouteOverrides.clear();
});

/** The reroute-fallback deps, with the freshness window the sweep really uses. */
function stalenessDeps(over: {
  hasOutboundDeliveredSince: (chatId: string, sinceMs: number, threadId?: number | null) => boolean;
  routeOverrides: Parameters<typeof answeredSinceOpen>[1]["routeOverrides"];
  nowMs?: number;
  historyEnabled?: boolean;
  rerouteMatchWindowMs?: number;
}) {
  return {
    historyEnabled: over.historyEnabled ?? true,
    hasOutboundDeliveredSince: over.hasOutboundDeliveredSince,
    routeOverrides: over.routeOverrides,
    anchorMs: over.nowMs ?? 2_000,
    rerouteMatchWindowMs:
      over.rerouteMatchWindowMs ??
      resolveRerouteMatchWindowMs(OBLIGATION_ESCALATE_SETTLE_MS_DEFAULT),
  };
}

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
    expect(reg.routedOverridesSince(CHAT, 4, 0)).toEqual([{ routedThreadId: 635, atMs: 1000 }]);
  });

  it("maps a chat-root routing to an explicit NULL thread, never to 'any thread'", () => {
    // 2026-08-10 07:52: `EXPLICIT_OVERRIDDEN(model→3,routed→-)`; recordOutbound
    // writes `thread_id IS NULL` for a threadless send.
    const reg = overridesWithReroute(3, undefined, 1000);
    expect(reg.routedOverridesSince(CHAT, 3, 0)).toEqual([{ routedThreadId: null, atMs: 1000 }]);
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
    expect(reg.routedOverridesSince(CHAT, 4, 0)).toEqual([]);
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
    expect(reg.routedOverridesSince("-100777", 4, 0)).toEqual([]);
    expect(reg.routedOverridesSince(CHAT, 3, 0)).toEqual([]);
  });

  it("ignores an override older than the caller's freshness floor", () => {
    const reg = overridesWithReroute(4, 635, 1000);
    expect(reg.routedOverridesSince(CHAT, 4, 5000)).toEqual([]);
  });

  it("returns the EARLIEST in-window record per routed thread (the widest correct cutoff)", () => {
    // 2026-08-13 shape: three overrides, same intended topic, same routed topic.
    const reg = createAnswerRouteOverrides();
    for (const atMs of [1000, 1500, 2000]) {
      reg.note({
        chatId: CHAT,
        enabled: true,
        explicitThreadId: 4,
        anchored: true,
        routedThreadId: 3,
        nowMs: atMs,
      });
    }
    expect(reg.routedOverridesSince(CHAT, 4, 0)).toEqual([{ routedThreadId: 3, atMs: 1000 }]);
    // With a later floor, the earliest SURVIVING record wins.
    expect(reg.routedOverridesSince(CHAT, 4, 1600)).toEqual([{ routedThreadId: 3, atMs: 2000 }]);
  });

  it("clear() drops every record (the process-wide singleton's test reset)", () => {
    const reg = overridesWithReroute(4, 635, 1000);
    expect(reg.routedOverridesSince(CHAT, 4, 0)).toHaveLength(1);
    reg.clear();
    expect(reg.routedOverridesSince(CHAT, 4, 0)).toEqual([]);
    expect(reg.newestOverrideSince(CHAT, 4, 0)).toBeUndefined();
    expect(reg.size()).toBe(0);
  });

  it("newestOverrideSince returns the LATEST in-window record, not the earliest", () => {
    const reg = createAnswerRouteOverrides();
    for (const atMs of [1000, 1500, 2000]) {
      reg.note({
        chatId: CHAT,
        enabled: true,
        explicitThreadId: 4,
        anchored: true,
        routedThreadId: 3,
        nowMs: atMs,
      });
    }
    // `routedOverridesSince` deliberately yields the earliest (widest cutoff);
    // the diagnostic asks the opposite question — how NEAR the miss was.
    expect(reg.routedOverridesSince(CHAT, 4, 0)[0]?.atMs).toBe(1000);
    expect(reg.newestOverrideSince(CHAT, 4, 0)).toEqual({ routedThreadId: 3, atMs: 2000 });
    expect(reg.newestOverrideSince(CHAT, 4, 2500)).toBeUndefined();
    expect(reg.newestOverrideSince(CHAT, 99, 0)).toBeUndefined();
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
    expect(reg.routedOverridesSince(CHAT, 4, 0).length).toBeLessThanOrEqual(2);
  });
});

describe("answeredSinceOpen — a REROUTED answer stands the escalation down", () => {
  it("counts an answer the router recorded as rerouted out of this topic (2026-08-10 06:36)", () => {
    // Pre-fix this asked history for thread 4 only, found nothing, and nagged.
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 1000, threadId: OBLIGATION_THREAD },
      stalenessDeps({
        hasOutboundDeliveredSince: historyWithAnswer(2000, ROUTED_THREAD),
        routeOverrides: overridesWithReroute(OBLIGATION_THREAD, ROUTED_THREAD, 1500),
      }),
    );
    expect(answered).toEqual({ answered: true, via: "reroute", routedThreadId: ROUTED_THREAD });
  });

  it("counts an answer rerouted to the chat ROOT (2026-08-10 07:52)", () => {
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 1000, threadId: 3 },
      stalenessDeps({
        hasOutboundDeliveredSince: historyWithAnswer(2000, null),
        routeOverrides: overridesWithReroute(3, undefined, 1500),
      }),
    );
    expect(answered).toEqual({ answered: true, via: "reroute", routedThreadId: null });
  });

  it("still counts a same-thread answer (the pre-existing behaviour is preserved)", () => {
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 1000, threadId: OBLIGATION_THREAD },
      stalenessDeps({
        hasOutboundDeliveredSince: historyWithAnswer(2000, OBLIGATION_THREAD),
        routeOverrides: NO_OVERRIDES,
      }),
    );
    expect(answered).toEqual({ answered: true, via: "thread" });
  });

  it("does NOT count an unrelated answer in ANOTHER topic with no reroute on record (2026-08-13 04:03)", () => {
    // The whole point of the override gate: topic 3's answer to a DIFFERENT
    // question must not close topic 4's genuinely-unanswered obligation.
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 1000, threadId: OBLIGATION_THREAD },
      stalenessDeps({
        hasOutboundDeliveredSince: historyWithAnswer(2000, UNRELATED_THREAD),
        routeOverrides: NO_OVERRIDES,
      }),
    );
    expect(answered).toEqual({ answered: false, via: null });
  });

  it("does NOT pair a STALE override with a later unrelated delivery (2026-08-13 04:03)", () => {
    // The real 4#5462 shape, and the one an `openedAt` cutoff gets WRONG.
    // Opened at 0. Overrides model→4,routed→3 at 41s / 100s / 188s. The
    // delivery in thread 3 is at 769s — a DIFFERENT question's answer, 594.8s
    // after the newest override. Decision at 783s.
    const NOW = 783_000;
    const reg = createAnswerRouteOverrides();
    for (const atMs of [41_394, 100_301, 188_418]) {
      reg.note({
        chatId: CHAT,
        enabled: true,
        explicitThreadId: OBLIGATION_THREAD,
        anchored: true,
        routedThreadId: UNRELATED_THREAD,
        nowMs: atMs,
      });
    }
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 0, threadId: OBLIGATION_THREAD },
      stalenessDeps({
        hasOutboundDeliveredSince: historyWithAnswer(769_180, UNRELATED_THREAD),
        routeOverrides: reg,
        nowMs: NOW,
      }),
    );
    // Cut at `openedAt` this reads {answered: true, via: "reroute"} and the
    // user's message is dropped in silence.
    expect(answered.answered).toBe(false);
    expect(answered.via).toBe(null);
    // …and the rejection is reported rather than silent (594.6s stale).
    expect(answered.staleOverrideAgeMs).toBe(NOW - 188_418);
  });

  it("DOES follow an override that is still fresh, from the override's own instant", () => {
    // Same shape, but the decision happens while the override is still inside
    // the window — the 2026-08-10 case, re-checked after a settle deferral.
    const NOW = 188_418 + OBLIGATION_ESCALATE_SETTLE_MS_DEFAULT + 1_000;
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 0, threadId: OBLIGATION_THREAD },
      stalenessDeps({
        hasOutboundDeliveredSince: historyWithAnswer(189_800, UNRELATED_THREAD),
        routeOverrides: overridesWithReroute(OBLIGATION_THREAD, UNRELATED_THREAD, 188_418),
        nowMs: NOW,
      }),
    );
    expect(answered).toEqual({
      answered: true,
      via: "reroute",
      routedThreadId: UNRELATED_THREAD,
    });
  });

  it("does NOT accept a delivery that PREDATES the override it is paired with", () => {
    // The override is fresh, but the only delivery in the routed thread landed
    // before that routing decision — it cannot be the answer it produced.
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 1_000, threadId: OBLIGATION_THREAD },
      stalenessDeps({
        hasOutboundDeliveredSince: historyWithAnswer(4_999, ROUTED_THREAD),
        routeOverrides: overridesWithReroute(OBLIGATION_THREAD, ROUTED_THREAD, 5_000),
        nowMs: 6_000,
      }),
    );
    expect(answered.answered).toBe(false);
  });

  it("does NOT follow a reroute recorded for a DIFFERENT topic", () => {
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 1000, threadId: OBLIGATION_THREAD },
      stalenessDeps({
        hasOutboundDeliveredSince: historyWithAnswer(2000, ROUTED_THREAD),
        // The override belongs to topic 3's answer, not topic 4's.
        routeOverrides: overridesWithReroute(UNRELATED_THREAD, ROUTED_THREAD, 1500),
      }),
    );
    expect(answered.answered).toBe(false);
  });

  it("does NOT follow a reroute that PREDATES the obligation", () => {
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 5000, threadId: OBLIGATION_THREAD },
      stalenessDeps({
        hasOutboundDeliveredSince: historyWithAnswer(6000, ROUTED_THREAD),
        routeOverrides: overridesWithReroute(OBLIGATION_THREAD, ROUTED_THREAD, 1500),
        nowMs: 6000,
      }),
    );
    expect(answered.answered).toBe(false);
  });

  it("does NOT count an answer in a DIFFERENT chat", () => {
    const answered = answeredSinceOpen(
      { chatId: "-100777", openedAt: 1000, threadId: OBLIGATION_THREAD },
      stalenessDeps({
        hasOutboundDeliveredSince: historyWithAnswer(2000, ROUTED_THREAD),
        routeOverrides: overridesWithReroute(OBLIGATION_THREAD, ROUTED_THREAD, 1500),
      }),
    );
    expect(answered.answered).toBe(false);
  });

  it("does NOT count an answer that PREDATES the obligation", () => {
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 5000, threadId: OBLIGATION_THREAD },
      stalenessDeps({
        hasOutboundDeliveredSince: historyWithAnswer(2000, OBLIGATION_THREAD),
        routeOverrides: NO_OVERRIDES,
      }),
    );
    expect(answered.answered).toBe(false);
  });

  it("reports WHY the fallback found nothing when a record existed but was stale", () => {
    // Negative-path telemetry. "No override on record" and "an override was on
    // record and the freshness bound rejected it" are operationally different —
    // the second is the bound doing its job (or being mis-tuned), and without a
    // signal the 18.5s window is unmeasurable in production. Same 2026-08-13
    // shape: newest override 188_418, decision 783_000 → 594.6s stale.
    const reg = createAnswerRouteOverrides();
    for (const atMs of [41_394, 100_301, 188_418]) {
      reg.note({
        chatId: CHAT,
        enabled: true,
        explicitThreadId: OBLIGATION_THREAD,
        anchored: true,
        routedThreadId: UNRELATED_THREAD,
        nowMs: atMs,
      });
    }
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 0, threadId: OBLIGATION_THREAD },
      stalenessDeps({
        hasOutboundDeliveredSince: historyWithAnswer(769_180, UNRELATED_THREAD),
        routeOverrides: reg,
        nowMs: 783_000,
      }),
    );
    expect(answered.answered).toBe(false);
    // The NEWEST rejected record's age — the near-miss the bound must be judged on.
    expect(answered.staleOverrideAgeMs).toBe(783_000 - 188_418);
  });

  it("reports NO stale-override age when there was simply no record to reject", () => {
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 1000, threadId: OBLIGATION_THREAD },
      stalenessDeps({
        hasOutboundDeliveredSince: historyWithAnswer(2000, UNRELATED_THREAD),
        routeOverrides: NO_OVERRIDES,
      }),
    );
    expect(answered).toEqual({ answered: false, via: null });
  });

  it("a ZERO reroute-match window disables the fallback outright (kill switch)", () => {
    // The fallback is the one new mechanism that can silently close a genuinely
    // unanswered obligation, so it needs its own off-switch — and the switch
    // must mean "no fallback", not "a zero-width window an override recorded at
    // this very instant still slips through".
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 1_000, threadId: OBLIGATION_THREAD },
      stalenessDeps({
        hasOutboundDeliveredSince: historyWithAnswer(6_000, ROUTED_THREAD),
        routeOverrides: overridesWithReroute(OBLIGATION_THREAD, ROUTED_THREAD, 6_000),
        nowMs: 6_000,
        rerouteMatchWindowMs: 0,
      }),
    );
    expect(answered).toEqual({ answered: false, via: null });
  });

  it("reports not-answered when history is unavailable (never suppresses on doubt)", () => {
    const answered = answeredSinceOpen(
      { chatId: CHAT, openedAt: 1000, threadId: OBLIGATION_THREAD },
      stalenessDeps({
        hasOutboundDeliveredSince: () => true,
        routeOverrides: NO_OVERRIDES,
        historyEnabled: false,
      }),
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

describe("resolveRerouteMatchWindowMs — how stale an override may be", () => {
  it("tracks the settle window, because the consulting decision comes after it", () => {
    expect(resolveRerouteMatchWindowMs(OBLIGATION_ESCALATE_SETTLE_MS_DEFAULT)).toBe(
      OBLIGATION_ESCALATE_SETTLE_MS_DEFAULT + REROUTE_MATCH_GRACE_MS,
    );
    expect(resolveRerouteMatchWindowMs(20_000)).toBe(20_000 + REROUTE_MATCH_GRACE_MS);
  });

  it("still allows a window with the settle gate killed (decision is immediate)", () => {
    expect(resolveRerouteMatchWindowMs(0)).toBe(REROUTE_MATCH_GRACE_MS);
    expect(resolveRerouteMatchWindowMs(-5_000)).toBe(REROUTE_MATCH_GRACE_MS);
  });

  it("stays far below the observed false-pairing gap and far above the real ones", () => {
    const w = resolveRerouteMatchWindowMs(OBLIGATION_ESCALATE_SETTLE_MS_DEFAULT);
    expect(w).toBeGreaterThan(2_809); // worst real override→delivery lag, with margin
    expect(w).toBeLessThan(594_800); // 2026-08-13's stale-override→unrelated-delivery gap
  });

  it("has its OWN kill switch — SETTLE_MS=0 does not disable the fallback", () => {
    // The settle gate's kill switch only disables the settle gate. The reroute
    // fallback is a separate mechanism with a separate failure mode (it can
    // close a genuinely unanswered obligation SILENTLY), so it gets its own
    // off-switch. Every sibling guard in this family already has one.
    expect(
      resolveRerouteMatchWindowMs(0, { SWITCHROOM_OBLIGATION_ESCALATE_SETTLE_MS: "0" }),
    ).toBe(REROUTE_MATCH_GRACE_MS); // still live — the settle switch is not this switch
    expect(
      resolveRerouteMatchWindowMs(OBLIGATION_ESCALATE_SETTLE_MS_DEFAULT, {
        SWITCHROOM_OBLIGATION_REROUTE_MATCH_MS: "0",
      }),
    ).toBe(0); // and this one really does turn it off
  });

  it("passes a deliberate override through, and falls back to the derivation on garbage", () => {
    const derived = resolveRerouteMatchWindowMs(OBLIGATION_ESCALATE_SETTLE_MS_DEFAULT);
    expect(
      resolveRerouteMatchWindowMs(OBLIGATION_ESCALATE_SETTLE_MS_DEFAULT, {
        SWITCHROOM_OBLIGATION_REROUTE_MATCH_MS: "5000",
      }),
    ).toBe(5_000);
    for (const raw of ["", "soon", "-1", "Infinity"]) {
      expect(
        resolveRerouteMatchWindowMs(OBLIGATION_ESCALATE_SETTLE_MS_DEFAULT, {
          SWITCHROOM_OBLIGATION_REROUTE_MATCH_MS: raw,
        }),
      ).toBe(derived);
    }
  });

  it("clamps an absurd override so a typo cannot widen the silent-close window for a day", () => {
    expect(
      resolveRerouteMatchWindowMs(OBLIGATION_ESCALATE_SETTLE_MS_DEFAULT, {
        SWITCHROOM_OBLIGATION_REROUTE_MATCH_MS: "85000000",
      }),
    ).toBe(OBLIGATION_REROUTE_MATCH_MS_MAX);
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
  function openExhausted(
    ledger: ObligationLedger,
    openedAt: number,
    origin = ORIGIN,
    threadId = OBLIGATION_THREAD,
  ): void {
    ledger.openIfAbsent({
      originTurnId: origin,
      chatId: CHAT,
      threadId,
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

  it("(d) a STALE reroute record does NOT license an unrelated later delivery (2026-08-13 04:03)", () => {
    // The blocker this guard exists for, built to the REAL 4#5462 shape — the
    // overrides the incident actually had, not a scenario without them:
    //
    //   opened      03:50:02.807   (T-783.3s from the escalate decision)
    //   overrides   03:50:44.201 / 03:51:43.108 / 03:53:11.225  model→4,routed→3
    //   delivery    04:02:51.987   295 chars, thread 3, a DIFFERENT question
    //   decision    04:03:06.140
    //
    // The newest override is 594.8s stale when the sweep decides. Cut at
    // `openedAt`, the fallback pairs it with that unrelated delivery, closes
    // topic 4's obligation silently, and the user's message is dropped with no
    // nudge and no re-present. It must escalate instead.
    const ledger = new ObligationLedger(2);
    const ORIGIN_D = `${CHAT}:${THREAD_D}#5463`;
    const base = Date.now();
    const { wiring, nudges } = makeWiring({
      ledger,
      // A substantive assistant row in topic 3 — and ONLY in topic 3.
      hasOutboundDeliveredSince: historyWithAnswer(base - 14_200, UNRELATED_THREAD),
    });
    // The three real overrides, all long stale by the time the sweep decides.
    for (const ago of [741_900, 683_000, 594_900]) {
      answerRouteOverrides.note({
        chatId: CHAT,
        enabled: true,
        explicitThreadId: THREAD_D,
        anchored: true,
        routedThreadId: UNRELATED_THREAD,
        nowMs: base - ago,
      });
    }
    openExhausted(ledger, base - 783_300, ORIGIN_D, THREAD_D);

    const realNow = Date.now;
    try {
      for (const offset of [0, 5_000, 10_000]) {
        Date.now = () => base + offset;
        wiring.obligationSweep();
      }
    } finally {
      Date.now = realNow;
    }

    expect(nudges).toEqual([ORIGIN_D]); // topic 4's message is NOT silently dropped
  });

  it("every scenario starts from an EMPTY process-wide override registry", () => {
    // `answerRouteOverrides` is a module singleton and these scenarios write to
    // it with wall-clock timestamps, so without a reset (b)'s `CHAT:4` record is
    // still FRESH when (a) and (c) — same topic — run, and (a)/(c) pass only
    // because their history stubs happen to reject the routed thread. Loosen a
    // stub and (b) silently changes another test's outcome.
    expect(answerRouteOverrides.routedOverridesSince(CHAT, OBLIGATION_THREAD, 0)).toEqual([]);
    expect(answerRouteOverrides.size()).toBe(0);
  });

  it("(e) a SKIPPED sweep tick does not turn a fresh reroute record stale (freshness anchor)", () => {
    // The freshness bound must be anchored to the instant the decision FIRST
    // read "unanswered" — the settle gate's own `firstAt` — not to whenever the
    // re-check happens to run. A tick is not merely DELAYED, it can be skipped
    // outright: `turnInFlightForGate()` (unbounded), the background-work /
    // session-busy defer (bounded at 20 min), and the escalate/represent graces
    // all sit ABOVE this branch. The 2026-08-13 log shows the sweep deferring
    // for minutes at a time.
    //
    //   T+0      the router reroutes topic 45's answer to thread 635
    //   T+0.1    first escalate decision — answer still in flight → settle defer
    //   T+1.4    the rerouted answer lands in thread 635
    //   T+107    the next decision that actually RUNS (ticks in between skipped)
    //
    // Anchored at the re-check, the record is 107s old, the fallback is skipped
    // and the user is nagged on top of the answer they already have — the exact
    // bug this PR exists to fix, surviving for that timing.
    const THREAD_E = 45;
    const ORIGIN_E = `${CHAT}:${THREAD_E}#5464`;
    const ledger = new ObligationLedger(2);
    const base = Date.now();
    const DELIVERED_AT = base + 1_400;
    const { wiring, nudges } = makeWiring({
      ledger,
      hasOutboundDeliveredSince: (chatId, sinceMs, threadId) =>
        chatId === CHAT &&
        (threadId === undefined || threadId === ROUTED_THREAD) &&
        Date.now() >= DELIVERED_AT &&
        DELIVERED_AT >= sinceMs,
    });
    answerRouteOverrides.note({
      chatId: CHAT,
      enabled: true,
      explicitThreadId: THREAD_E,
      anchored: true,
      routedThreadId: ROUTED_THREAD,
      nowMs: base,
    });
    openExhausted(ledger, base - 60_000, ORIGIN_E, THREAD_E);

    const realNow = Date.now;
    try {
      Date.now = () => base + 100;
      wiring.obligationSweep(); // decision 1 — answer in flight → settle
      expect(nudges).toEqual([]);
      // …and now the sweep is starved for 107s by the gates above this branch.
      Date.now = () => base + 107_000;
      wiring.obligationSweep();
    } finally {
      Date.now = realNow;
    }

    expect(nudges).toEqual([]); // no nag on top of the delivered answer
    expect(ledger.isOpen(ORIGIN_E)).toBe(false); // closed silently instead
  });

  it("logs the stale-override rejection so the freshness bound is measurable in production", () => {
    // The `via=reroute` close is logged because the fallback's blast radius must
    // be observable without a rebuild. The bound that makes the fallback safe
    // deserves the same: a rejection currently looks identical to "no record".
    const THREAD_F = 46;
    const ORIGIN_F = `${CHAT}:${THREAD_F}#5465`;
    const ledger = new ObligationLedger(2);
    const base = Date.now();
    const { wiring } = makeWiring({
      ledger,
      hasOutboundDeliveredSince: historyWithAnswer(base - 14_200, UNRELATED_THREAD),
    });
    answerRouteOverrides.note({
      chatId: CHAT,
      enabled: true,
      explicitThreadId: THREAD_F,
      anchored: true,
      routedThreadId: UNRELATED_THREAD,
      nowMs: base - 594_900,
    });
    openExhausted(ledger, base - 783_300, ORIGIN_F, THREAD_F);

    const lines: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      lines.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      wiring.obligationSweep();
    } finally {
      process.stderr.write = realWrite;
    }

    const rejected = lines.find((l) => l.includes("reroute record rejected"));
    expect(rejected).toBeDefined();
    expect(rejected).toContain("window=18500ms");
    expect(rejected).toMatch(/age=59[45]\d{3}ms/);
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
