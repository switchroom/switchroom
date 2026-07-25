import { describe, it, expect } from "vitest";
import {
  ObligationLedger,
  buildObligationRepresentInbound,
  obligationEscalationText,
  type Obligation,
} from "../gateway/obligation-ledger.js";
import { deriveTurnId } from "../gateway/derive-turn-id.js";

function input(id: string, openedAt: number, text = "do the thing") {
  return { originTurnId: id, chatId: "-100123", threadId: 3, messageId: Number(id.split("#").pop() ?? 0), text, openedAt };
}

describe("ObligationLedger", () => {
  it("opens, reports open, and closes by origin id", () => {
    const L = new ObligationLedger();
    expect(L.hasOpen()).toBe(false);
    expect(L.openIfAbsent(input("c:3#715", 1000))).toBe(true);
    expect(L.hasOpen()).toBe(true);
    expect(L.isOpen("c:3#715")).toBe(true);
    expect(L.close("c:3#715")).toBe(true);
    expect(L.hasOpen()).toBe(false);
    expect(L.close("c:3#715")).toBe(false); // already closed
  });

  it("openIfAbsent is idempotent — buffer-then-enqueue opens once, keeps the first", () => {
    const L = new ObligationLedger();
    expect(L.openIfAbsent(input("c:3#715", 1000, "first"))).toBe(true);
    expect(L.openIfAbsent(input("c:3#715", 2000, "second"))).toBe(false);
    expect(L.size()).toBe(1);
    expect(L.list()[0].text).toBe("first");
    expect(L.list()[0].openedAt).toBe(1000);
  });

  it("close(null/undefined) is a safe no-op", () => {
    const L = new ObligationLedger();
    L.openIfAbsent(input("c:3#715", 1000));
    expect(L.close(null)).toBe(false);
    expect(L.close(undefined)).toBe(false);
    expect(L.hasOpen()).toBe(true);
  });

  it("decideAtIdle returns 'none' when nothing is open", () => {
    expect(new ObligationLedger().decideAtIdle()).toEqual({ action: "none" });
  });

  it("decideAtIdle picks the OLDEST open obligation to re-present", () => {
    const L = new ObligationLedger();
    L.openIfAbsent(input("c:3#715", 2000));
    L.openIfAbsent(input("c:4#690", 1000)); // older
    const d = L.decideAtIdle();
    expect(d.action).toBe("represent");
    expect(d.obligation?.originTurnId).toBe("c:4#690");
  });

  it("re-presents up to maxRepresents, then escalates (no infinite loop)", () => {
    const L = new ObligationLedger(2); // max 2 represents
    L.openIfAbsent(input("c:3#715", 1000));
    // represent #1
    expect(L.decideAtIdle().action).toBe("represent");
    expect(L.markRepresented("c:3#715")).toBe(1);
    // represent #2
    expect(L.decideAtIdle().action).toBe("represent");
    expect(L.markRepresented("c:3#715")).toBe(2);
    // now exhausted → escalate
    const d = L.decideAtIdle();
    expect(d.action).toBe("escalate");
    expect(d.obligation?.originTurnId).toBe("c:3#715");
    // caller closes on escalate → ledger empties (no loop)
    expect(L.close("c:3#715")).toBe(true);
    expect(L.decideAtIdle().action).toBe("none");
  });

  it("the 715 scenario: open at receipt, NOT closed by an unrelated reply, re-presented", () => {
    const L = new ObligationLedger();
    // 713 (video, topic 635) and 715 (Meta report, topic 3) both open
    L.openIfAbsent(input("c:635#713", 1000, "video swap task"));
    L.openIfAbsent(input("c:3#715", 1100, "do the Meta report"));
    // 713 gets a substantive reply resolving to its origin → close 713 only
    expect(L.close("c:635#713")).toBe(true);
    // 715 was only verbally deferred (no reply resolved to it) → still OPEN
    expect(L.isOpen("c:3#715")).toBe(true);
    // at idle, 715 is re-presented (this is the fix — the drop becomes a re-ask)
    const d = L.decideAtIdle();
    expect(d.action).toBe("represent");
    expect(d.obligation?.originTurnId).toBe("c:3#715");
  });

  it("markRepresented on an unknown/closed id is a harmless 0", () => {
    const L = new ObligationLedger();
    expect(L.markRepresented("nope")).toBe(0);
  });

  describe("resolveCloseTarget — deterministic, holds for any model behavior", () => {
    it("an echoed origin is authoritative (closes exactly that)", () => {
      const L = new ObligationLedger();
      L.openIfAbsent(input("c:635#713", 1000));
      L.openIfAbsent(input("c:3#715", 1100));
      // model echoed 713 while live turn is 715 → close 713, NOT the live turn
      expect(L.resolveCloseTarget("c:635#713", "c:3#715")).toBe("c:635#713");
    });

    it("no echo + exactly ONE open → close the live turn (unambiguous)", () => {
      const L = new ObligationLedger();
      L.openIfAbsent(input("c:3#715", 1100));
      expect(L.resolveCloseTarget(undefined, "c:3#715")).toBe("c:3#715");
    });

    it("no echo + MULTIPLE open + live turn IS open → close the live turn's OWN obligation (Fix 2)", () => {
      const L = new ObligationLedger();
      L.openIfAbsent(input("c:635#713", 1000));
      L.openIfAbsent(input("c:3#715", 1100));
      // A substantive reply delivered during currentTurn=715 (no model echo, no
      // routed origin) closes 715's own obligation. 713 stays open and is
      // re-presented. The 713/715 invariant holds: this does NOT close 713.
      expect(L.resolveCloseTarget(undefined, "c:3#715")).toBe("c:3#715");
      expect(L.isOpen("c:635#713")).toBe(true); // 713 stays open
    });

    it("no echo + MULTIPLE open + live turn NOT one of them → close nothing (713/715 invariant preserved)", () => {
      const L = new ObligationLedger();
      L.openIfAbsent(input("c:635#713", 1000));
      L.openIfAbsent(input("c:3#715", 1100));
      // currentTurn=999 is NOT an open obligation. We can't identify the right
      // target → refuse to close anything (a re-present is safer than a wrong close).
      expect(L.resolveCloseTarget(undefined, "c:9#999")).toBeNull();
      expect(L.isOpen("c:635#713")).toBe(true);
      expect(L.isOpen("c:3#715")).toBe(true);
    });

    it("no echo + live turn not an open obligation → null", () => {
      const L = new ObligationLedger();
      L.openIfAbsent(input("c:3#715", 1100));
      expect(L.resolveCloseTarget(undefined, "c:9#999")).toBeNull();
    });

    it("routedOriginId (Fix 1) closes the routed target even with multiple open + no model echo", () => {
      // Simulate the clerk incident: two obligations open, agent answers #14057
      // via a quoted reply (via=quoted), no model echo. The gateway resolves
      // routedOriginId=#14057 from the quote. That obligation closes; #14059 stays.
      const L = new ObligationLedger();
      L.openIfAbsent(input("c:0#14057", 1000));
      L.openIfAbsent(input("c:0#14059", 1100));
      expect(L.resolveCloseTarget(undefined, "c:0#14059", "c:0#14057")).toBe("c:0#14057");
      // Close it to confirm only #14057 closes
      L.close("c:0#14057");
      expect(L.isOpen("c:0#14057")).toBe(false);
      expect(L.isOpen("c:0#14059")).toBe(true);
    });

    it("echoedTurnId wins over routedOriginId when both present (echoed is authoritative)", () => {
      const L = new ObligationLedger();
      L.openIfAbsent(input("c:635#713", 1000));
      L.openIfAbsent(input("c:3#715", 1100));
      // Model explicitly echoed 713 AND router resolved 715 as routed origin.
      // The echo is authoritative — close 713.
      expect(L.resolveCloseTarget("c:635#713", "c:3#715", "c:3#715")).toBe("c:635#713");
    });

    it("routedOriginId=null falls through to live-turn fallback", () => {
      const L = new ObligationLedger();
      L.openIfAbsent(input("c:3#715", 1100));
      expect(L.resolveCloseTarget(undefined, "c:3#715", null)).toBe("c:3#715");
    });
  });
});

describe("buildObligationRepresentInbound", () => {
  const ob: Obligation = {
    originTurnId: "-100123:3#715",
    chatId: "-100123",
    threadId: 3,
    messageId: 715,
    text: "do the Meta report",
    openedAt: 1000,
    representCount: 0,
  };

  it("carries the original message_id + origin_turn_id so the reply resolves back", () => {
    const m = buildObligationRepresentInbound(ob, 5000);
    expect(m.type).toBe("inbound");
    expect(m.chatId).toBe("-100123");
    expect(m.threadId).toBe(3);
    expect(m.messageId).toBe(715); // ORIGINAL id → reply-quote + origin routing
    expect(m.meta.origin_turn_id).toBe("-100123:3#715");
    expect(m.meta.source).toBe("obligation_represent"); // synthetic → not tracked, no new obligation
    expect(m.meta.represent_count).toBe("1");
    expect(m.meta.chat_id).toBe("-100123"); // Bug C fix: chat_id in meta drives the <channel> tag
    expect(m.text).toContain("do the Meta report");
    expect(m.text).toMatch(/answer it now|reply tool/i);
  });

  it("omits threadId for a DM obligation", () => {
    const m = buildObligationRepresentInbound({ ...ob, threadId: undefined }, 5000);
    expect(m.threadId).toBeUndefined();
  });

  it("truncates a long original to ~200 chars", () => {
    const long = "x".repeat(500);
    const m = buildObligationRepresentInbound({ ...ob, text: long }, 5000);
    expect(m.text).toContain("…");
    expect(m.text).not.toContain("x".repeat(201));
  });

  it("escalation text names the message and asks to re-send", () => {
    expect(obligationEscalationText(ob)).toMatch(/missed|not sure/i);
    expect(obligationEscalationText(ob)).toContain("do the Meta report");
    expect(obligationEscalationText(ob)).toMatch(/re-?send/i);
  });
});

describe("ObligationLedger — durability hooks + escalate-attempt counter", () => {
  function input(id: string, openedAt: number, text = "do the thing") {
    return { originTurnId: id, chatId: "-100123", threadId: 3, messageId: Number(id.split("#").pop() ?? 0), text, openedAt };
  }

  it("fires onChange after every mutation with the full open snapshot", () => {
    const snapshots: Obligation[][] = [];
    const L = new ObligationLedger(2, { onChange: (s) => snapshots.push(s) });
    L.openIfAbsent(input("c:3#1", 1000)); // open
    L.openIfAbsent(input("c:3#2", 1001)); // open
    L.markRepresented("c:3#1"); // represent
    L.markEscalateAttempt("c:3#1"); // escalate-attempt
    L.close("c:3#1"); // close
    // open, open, represent, escalate-attempt, close = 5 mutations.
    expect(snapshots.length).toBe(5);
    expect(snapshots[1].map((o) => o.originTurnId).sort()).toEqual(["c:3#1", "c:3#2"]);
    // last snapshot reflects the close.
    expect(snapshots[4].map((o) => o.originTurnId)).toEqual(["c:3#2"]);
  });

  it("does NOT fire onChange for an idempotent (already-open) openIfAbsent", () => {
    const snapshots: Obligation[][] = [];
    const L = new ObligationLedger(2, { onChange: (s) => snapshots.push(s) });
    expect(L.openIfAbsent(input("c:3#1", 1000))).toBe(true);
    expect(L.openIfAbsent(input("c:3#1", 9999))).toBe(false); // dup
    expect(snapshots.length).toBe(1);
  });

  it("does NOT fire onChange for a close of an unknown id", () => {
    const snapshots: Obligation[][] = [];
    const L = new ObligationLedger(2, { onChange: (s) => snapshots.push(s) });
    expect(L.close("nope")).toBe(false);
    expect(snapshots.length).toBe(0);
  });

  it("markEscalateAttempt increments per call and persists", () => {
    const snapshots: Obligation[][] = [];
    const L = new ObligationLedger(2, { onChange: (s) => snapshots.push(s) });
    L.openIfAbsent(input("c:3#1", 1000));
    expect(L.markEscalateAttempt("c:3#1")).toBe(1);
    expect(L.markEscalateAttempt("c:3#1")).toBe(2);
    expect(L.list()[0].escalateAttempts).toBe(2);
    expect(L.markEscalateAttempt("missing")).toBe(0);
  });

  it("hydrate restores the open set WITH counters and does not fire onChange", () => {
    const snapshots: Obligation[][] = [];
    const L = new ObligationLedger(2, { onChange: (s) => snapshots.push(s) });
    L.hydrate([
      { originTurnId: "c:3#715", chatId: "-100123", threadId: 3, messageId: 715, text: "x", openedAt: 1000, representCount: 2, escalateAttempts: 1 },
    ]);
    expect(snapshots.length).toBe(0); // hydrate is restoration, not a mutation
    expect(L.isOpen("c:3#715")).toBe(true);
    expect(L.list()[0].representCount).toBe(2);
    expect(L.list()[0].escalateAttempts).toBe(1);
    // a represented obligation at/over max decides 'escalate', preserving count across restart
    expect(L.decideAtIdle().action).toBe("escalate");
  });

  it("interrupt-cancel semantics: closing the in-flight turn's obligation removes it from the sweep, sibling untouched", () => {
    // Mirrors cancelInterruptedObligation: an `!` interrupt SIGINT-kills the
    // in-flight turn and closes its obligation, so the sweep can't later
    // re-present/escalate the question the user explicitly redirected away from.
    // A queued SIBLING obligation must survive.
    const L = new ObligationLedger();
    L.openIfAbsent(input("c:3#700", 1000)); // the in-flight turn's message
    L.openIfAbsent(input("c:3#701", 1001)); // a queued sibling
    expect(L.close("c:3#700")).toBe(true); // interrupt cancels the in-flight one
    expect(L.isOpen("c:3#700")).toBe(false);
    expect(L.decideAtIdle().obligation?.originTurnId).toBe("c:3#701"); // sibling still actionable
    expect(L.close("c:3#700")).toBe(false); // re-close / unknown is a safe no-op
  });

  it("hydrate skips malformed rows", () => {
    const L = new ObligationLedger();
    L.hydrate([
      { originTurnId: "c:3#1", chatId: "-100123", messageId: 1, text: "x", openedAt: 1000, representCount: 0 },
      { originTurnId: "", chatId: "x", messageId: 0, text: "", openedAt: 0, representCount: 0 } as Obligation,
    ]);
    expect(L.size()).toBe(1);
  });
});

describe("ObligationLedger — escalate-grace window (over-escalation fix)", () => {
  function input(id: string, openedAt: number) {
    return { originTurnId: id, chatId: "-100123", threadId: 3, messageId: Number(id.split("#").pop() ?? 0), text: "x", openedAt };
  }

  it("no opts (or graceMs<=0) → pre-grace behaviour: acts immediately", () => {
    const L = new ObligationLedger();
    L.openIfAbsent(input("c:3#1", 1000));
    L.noteTurnEnded("c:3#1", 5000); // a turn just ended
    expect(L.decideAtIdle().action).toBe("represent"); // no grace → act now
    expect(L.decideAtIdle({ now: 5001, graceMs: 0 }).action).toBe("represent"); // graceMs 0 → off
  });

  it("skips an obligation whose turn ended < graceMs ago (the trailing-answer window)", () => {
    const L = new ObligationLedger();
    L.openIfAbsent(input("c:3#1", 1000));
    L.noteTurnEnded("c:3#1", 5000);
    // 30s after turn-end, grace 45s → still within grace → wait (none)
    expect(L.decideAtIdle({ now: 35000, graceMs: 45000 }).action).toBe("none");
    // 46s after turn-end → out of grace → act
    expect(L.decideAtIdle({ now: 51000, graceMs: 45000 }).action).toBe("represent");
  });

  it("an obligation that never had a turn end (still-queued) is always eligible — no trailing answer to wait for", () => {
    const L = new ObligationLedger();
    L.openIfAbsent(input("c:3#1", 1000)); // no noteTurnEnded
    expect(L.decideAtIdle({ now: 1001, graceMs: 45000 }).action).toBe("represent");
  });

  it("picks the oldest ELIGIBLE: a newer in-grace obligation does not block an older out-of-grace one", () => {
    const L = new ObligationLedger();
    L.openIfAbsent(input("c:3#1", 1000)); // older
    L.openIfAbsent(input("c:3#2", 2000)); // newer
    L.noteTurnEnded("c:3#1", 5000); // older's turn ended at 5000 (out of grace by now)
    L.noteTurnEnded("c:3#2", 60000); // newer's turn ended at 60000 (in grace)
    const d = L.decideAtIdle({ now: 70000, graceMs: 45000 });
    // older (#1) ended 65s ago → eligible; newer (#2) ended 10s ago → in grace.
    // pick oldest eligible = #1.
    expect(d.action).toBe("represent");
    expect(d.obligation?.originTurnId).toBe("c:3#1");
  });

  it("returns none when EVERY open obligation is within grace", () => {
    const L = new ObligationLedger();
    L.openIfAbsent(input("c:3#1", 1000));
    L.openIfAbsent(input("c:3#2", 2000));
    L.noteTurnEnded("c:3#1", 60000);
    L.noteTurnEnded("c:3#2", 61000);
    expect(L.decideAtIdle({ now: 65000, graceMs: 45000 }).action).toBe("none");
  });

  it("noteTurnEnded is a no-op for an unknown/closed obligation and persists when it applies", () => {
    const snapshots: Obligation[][] = [];
    const L = new ObligationLedger(2, { onChange: (s) => snapshots.push(s) });
    L.openIfAbsent(input("c:3#1", 1000)); // persist #1
    L.noteTurnEnded("nope", 5000); // unknown → no persist
    expect(snapshots.length).toBe(1);
    L.noteTurnEnded("c:3#1", 5000); // applies → persist
    expect(snapshots.length).toBe(2);
    expect(snapshots[1][0].lastTurnEndedAt).toBe(5000);
  });

  it("grace still terminates the ladder: represent → escalate once each is out of grace", () => {
    const L = new ObligationLedger(2);
    L.openIfAbsent(input("c:3#1", 1000));
    // turn 0 ended at 1000; out of grace by t=50000
    L.noteTurnEnded("c:3#1", 1000);
    expect(L.decideAtIdle({ now: 50000, graceMs: 45000 }).action).toBe("represent");
    L.markRepresented("c:3#1");
    L.noteTurnEnded("c:3#1", 50000); // re-present turn ended
    expect(L.decideAtIdle({ now: 96000, graceMs: 45000 }).action).toBe("represent");
    L.markRepresented("c:3#1");
    L.noteTurnEnded("c:3#1", 96000);
    // representCount now 2 == max → escalate (once out of grace)
    expect(L.decideAtIdle({ now: 142000, graceMs: 45000 }).action).toBe("escalate");
  });
});

describe("ObligationLedger — background-work grace (extended-autonomous fix, gymbro 2026-06-10)", () => {
  function input(id: string, openedAt: number) {
    return { originTurnId: id, chatId: "-100123", threadId: 3, messageId: Number(id.split("#").pop() ?? 0), text: "research liven", openedAt };
  }
  // 20-min ceiling, mirroring OBLIGATION_BACKGROUND_WORK_GRACE_MS default.
  const CEIL = 20 * 60_000;

  it("skips an obligation younger than the ceiling while background work is active", () => {
    const L = new ObligationLedger();
    L.openIfAbsent(input("c:3#1", 1000)); // opened at t=1000
    // 5 min later, a worker is running → genuine work in flight → wait.
    expect(
      L.decideAtIdle({ now: 1000 + 5 * 60_000, graceMs: 45000, backgroundWorkActive: true, backgroundGraceMs: CEIL }).action,
    ).toBe("none");
  });

  it("acts once the obligation crosses the ceiling EVEN IF work is still active (bounded — no silent drop)", () => {
    const L = new ObligationLedger();
    L.openIfAbsent(input("c:3#1", 1000));
    // 20m + 1s after openedAt, still flagged active → ceiling wins → act.
    expect(
      L.decideAtIdle({ now: 1000 + CEIL + 1000, graceMs: 45000, backgroundWorkActive: true, backgroundGraceMs: CEIL }).action,
    ).toBe("represent");
  });

  it("backgroundWorkActive=false → no extra grace (pre-fix behaviour on this axis)", () => {
    const L = new ObligationLedger();
    L.openIfAbsent(input("c:3#1", 1000)); // still-queued, no turn end
    expect(
      L.decideAtIdle({ now: 2000, graceMs: 45000, backgroundWorkActive: false, backgroundGraceMs: CEIL }).action,
    ).toBe("represent");
  });

  it("backgroundGraceMs=0 (kill switch) → work signal ignored, acts immediately", () => {
    const L = new ObligationLedger();
    L.openIfAbsent(input("c:3#1", 1000));
    expect(
      L.decideAtIdle({ now: 2000, graceMs: 45000, backgroundWorkActive: true, backgroundGraceMs: 0 }).action,
    ).toBe("represent");
  });

  it("composes with the trailing-answer grace: both must clear before acting", () => {
    const L = new ObligationLedger();
    L.openIfAbsent(input("c:3#1", 1000));
    L.noteTurnEnded("c:3#1", 5000);
    // turn-end grace cleared (60s later) but within bg ceiling + work active → still wait.
    expect(
      L.decideAtIdle({ now: 65000, graceMs: 45000, backgroundWorkActive: true, backgroundGraceMs: CEIL }).action,
    ).toBe("none");
    // same instant, work no longer active → trailing grace already clear → act.
    expect(
      L.decideAtIdle({ now: 65000, graceMs: 45000, backgroundWorkActive: false, backgroundGraceMs: CEIL }).action,
    ).toBe("represent");
  });

  it("picks the oldest ELIGIBLE: a young in-work obligation does not block an ancient one past the ceiling", () => {
    const L = new ObligationLedger();
    L.openIfAbsent(input("c:3#old", 1000)); // ancient
    L.openIfAbsent(input("c:3#new", 1000 + CEIL)); // opened CEIL later
    const now = 1000 + CEIL + 5000; // old is past ceiling; new is only 5s old
    const d = L.decideAtIdle({ now, graceMs: 45000, backgroundWorkActive: true, backgroundGraceMs: CEIL });
    expect(d.action).toBe("represent");
    expect(d.obligation?.originTurnId).toBe("c:3#old");
  });

  it("represent budget is preserved across the work window → resumes (not escalates) after a restart-kill", () => {
    // Models the gymbro case: while the worker runs, the sweep must NOT burn the
    // represent ladder. So after a restart kills the work (work now inactive),
    // a never-represented obligation re-presents (resume) rather than escalates.
    const L = new ObligationLedger(2);
    L.openIfAbsent(input("c:3#1", 1000));
    // During the work window, every sweep is a no-op (no markRepresented called).
    for (const t of [60_000, 120_000, 300_000]) {
      expect(
        L.decideAtIdle({ now: t, graceMs: 45000, backgroundWorkActive: true, backgroundGraceMs: CEIL }).action,
      ).toBe("none");
    }
    expect(L.list()[0].representCount).toBe(0); // budget intact
    // Restart kills the work; obligation hydrated with representCount 0 → resume.
    expect(
      L.decideAtIdle({ now: 360_000, graceMs: 45000, backgroundWorkActive: false, backgroundGraceMs: CEIL }).action,
    ).toBe("represent");
  });
});

describe("ObligationLedger — per-represent grace (Fix 3: clerk 2026-06-13 incident)", () => {
  function input(id: string, openedAt: number) {
    return { originTurnId: id, chatId: "-100123", threadId: 3, messageId: Number(id.split("#").pop() ?? 0), text: "x", openedAt };
  }

  const REPR_GRACE = 120_000; // 2 min, mirroring the default

  it("a freshly re-presented obligation is ineligible until representGraceMs elapses", () => {
    const L = new ObligationLedger(2);
    L.openIfAbsent(input("c:3#1", 1000));
    // Re-present fires at t=5000; markRepresented stamps lastRepresentedAt.
    L.markRepresented("c:3#1", 5000);
    // 10s later — still within 120s represent grace → ineligible → none.
    expect(
      L.decideAtIdle({ now: 15000, graceMs: 45000, representGraceMs: REPR_GRACE }).action,
    ).toBe("none");
    // 120s + 1ms after re-present → grace expired → act.
    expect(
      L.decideAtIdle({ now: 5000 + REPR_GRACE + 1, graceMs: 45000, representGraceMs: REPR_GRACE }).action,
    ).toBe("represent");
  });

  it("markRepresented stamps lastRepresentedAt and persists", () => {
    const snapshots: Obligation[][] = [];
    const L = new ObligationLedger(2, { onChange: (s) => snapshots.push(s) });
    L.openIfAbsent(input("c:3#1", 1000));
    L.markRepresented("c:3#1", 9000);
    const snap = L.list()[0];
    expect(snap.lastRepresentedAt).toBe(9000);
    expect(snap.representCount).toBe(1);
    // Persisted: onChange fired for open + markRepresented = 2 snapshots
    expect(snapshots.length).toBe(2);
    expect(snapshots[1][0].lastRepresentedAt).toBe(9000);
  });

  it("representGraceMs=0 (kill switch) → no per-represent grace, acts immediately", () => {
    const L = new ObligationLedger(2);
    L.openIfAbsent(input("c:3#1", 1000));
    L.markRepresented("c:3#1", 5000);
    // Kill switch: representGraceMs=0 → the freshly-represented obligation is still eligible.
    expect(
      L.decideAtIdle({ now: 5001, graceMs: 45000, representGraceMs: 0 }).action,
    ).toBe("represent");
  });

  it("an obligation that was NEVER re-presented has no per-represent grace (no lastRepresentedAt)", () => {
    const L = new ObligationLedger(2);
    L.openIfAbsent(input("c:3#1", 1000));
    // No markRepresented call → no lastRepresentedAt → always eligible on this axis.
    expect(
      L.decideAtIdle({ now: 2000, graceMs: 45000, representGraceMs: REPR_GRACE }).action,
    ).toBe("represent");
  });

  it("per-represent grace survives hydration (durable snapshot)", () => {
    const L = new ObligationLedger(2);
    const now = 10_000;
    L.hydrate([
      {
        originTurnId: "c:3#1",
        chatId: "-100123",
        threadId: 3,
        messageId: 1,
        text: "x",
        openedAt: 1000,
        representCount: 1,
        lastRepresentedAt: now - 5000, // represented 5s ago
      },
    ]);
    // 5s after re-present, grace=120s → still within grace → none.
    expect(
      L.decideAtIdle({ now, graceMs: 0, representGraceMs: REPR_GRACE }).action,
    ).toBe("none");
    // 120s + 1ms after re-present → grace expired → escalate (count=1 < max=2 → represent).
    expect(
      L.decideAtIdle({ now: now - 5000 + REPR_GRACE + 1, graceMs: 0, representGraceMs: REPR_GRACE }).action,
    ).toBe("represent");
  });

  it("per-represent grace composes with trailing-answer grace: both must clear", () => {
    const L = new ObligationLedger(2);
    L.openIfAbsent(input("c:3#1", 1000));
    L.noteTurnEnded("c:3#1", 5000);
    L.markRepresented("c:3#1", 5000);
    // Both graces active; trailing: turn ended 5s ago (grace=45s → in grace);
    // per-represent: re-presented 5s ago (grace=120s → in grace) → none.
    expect(
      L.decideAtIdle({ now: 10000, graceMs: 45000, representGraceMs: REPR_GRACE }).action,
    ).toBe("none");
    // Trailing grace cleared (50s after turn-end), per-represent NOT yet (only 45s after re-present).
    expect(
      L.decideAtIdle({ now: 5000 + 50000, graceMs: 45000, representGraceMs: REPR_GRACE }).action,
    ).toBe("none");
    // Both cleared (125s after re-present at t=5000 → t=130000).
    expect(
      L.decideAtIdle({ now: 5000 + REPR_GRACE + 5000, graceMs: 45000, representGraceMs: REPR_GRACE }).action,
    ).toBe("represent");
  });

  it("the clerk incident: two messages arrive, re-present fires at T; the sweep ticks again at T+5s → grace prevents premature escalation", () => {
    // This is the exact sequence from clerk 2026-06-13: obligation re-presented
    // at T, sweep fires at T+5s before the re-present turn has even landed, would
    // immediately fire AGAIN (burning representCount to 2 → escalate in 5 more
    // seconds). With per-represent grace, the T+5s tick is a no-op.
    const L = new ObligationLedger(2);
    const T = 1_000_000;
    L.openIfAbsent(input("c:0#14057", T));
    // First represent at T
    L.markRepresented("c:0#14057", T);
    expect(L.list()[0].representCount).toBe(1);
    // Sweep at T+5s: MUST be "none" (within per-represent grace)
    expect(
      L.decideAtIdle({ now: T + 5000, graceMs: 45000, representGraceMs: REPR_GRACE }).action,
    ).toBe("none");
    // Sweep at T+10s: still within grace
    expect(
      L.decideAtIdle({ now: T + 10000, graceMs: 45000, representGraceMs: REPR_GRACE }).action,
    ).toBe("none");
    // Sweep after grace: eligible for second represent (not escalate — count=1 < max=2)
    expect(
      L.decideAtIdle({ now: T + REPR_GRACE + 1000, graceMs: 45000, representGraceMs: REPR_GRACE }).action,
    ).toBe("represent");
    expect(L.list()[0].representCount).toBe(1); // still 1 — decideAtIdle is pure
  });
});

describe("ObligationLedger — escalation suppression predicate (Fix 4)", () => {
  // Fix 4 is implemented in the gateway (obligationSweep checks
  // hasOutboundDeliveredSince before calling driveEscalation). We test the
  // predicate seam via the pattern the sweep uses: if an outbound was delivered
  // since openedAt, the obligation should be closed silently, not escalated.
  // This suite tests the ledger behaviour that enables that path: after a
  // silent close the ledger is empty and the next sweep sees 'none'.
  function input(id: string, openedAt: number) {
    return { originTurnId: id, chatId: "-100123", threadId: 3, messageId: Number(id.split("#").pop() ?? 0), text: "x", openedAt };
  }

  it("a silently-closed obligation (gateway closed on outbound-delivered check) leaves ledger empty", () => {
    const L = new ObligationLedger(2);
    L.openIfAbsent(input("c:3#1", 1000));
    // Gateway's Fix 4 path: outbound delivered since openedAt → close silently
    expect(L.close("c:3#1")).toBe(true);
    expect(L.hasOpen()).toBe(false);
    expect(L.decideAtIdle().action).toBe("none");
  });

  it("an escalation that reaches maxRepresents WITHOUT any known outbound still proceeds (escalate action)", () => {
    const L = new ObligationLedger(2);
    L.openIfAbsent(input("c:3#1", 1000));
    L.markRepresented("c:3#1");
    L.markRepresented("c:3#1");
    // hasOutboundDeliveredSince returns false (no outbound recorded) → escalate
    const d = L.decideAtIdle({ now: 9_999_999, graceMs: 0, representGraceMs: 0 });
    expect(d.action).toBe("escalate");
    expect(d.obligation?.originTurnId).toBe("c:3#1");
  });

  it("silent close fires onChange (persists the empty set)", () => {
    const snapshots: Obligation[][] = [];
    const L = new ObligationLedger(2, { onChange: (s) => snapshots.push(s) });
    L.openIfAbsent(input("c:3#1", 1000)); // snapshot[0]
    L.close("c:3#1"); // snapshot[1] = []
    expect(snapshots.length).toBe(2);
    expect(snapshots[1]).toEqual([]);
  });
});

// #3282 — the durable captured-answer snapshot attaches to the OPEN obligation
// so a partial backstop delivery is resumed (tail only) rather than regenerated.
describe("ObligationLedger — noteCapturedDelivery (#3282)", () => {
  function input(id: string, openedAt: number) {
    return { originTurnId: id, chatId: "-100123", threadId: 3, messageId: 1, text: "q", openedAt };
  }
  const snap = { chunks: ["c0", "c1"], chunkStates: [{ index: 0, messageIds: [10], confirmed: true }] };

  it("attaches the snapshot to an OPEN obligation and persists it", () => {
    const snapshots: Obligation[][] = [];
    const L = new ObligationLedger(2, { onChange: (s) => snapshots.push(s) });
    L.openIfAbsent(input("c:3#1", 1000));
    L.noteCapturedDelivery("c:3#1", snap);
    expect(L.list()[0]!.capturedDelivery).toEqual(snap);
    // The mutation persisted (onChange fired again after open).
    expect(snapshots.at(-1)![0]!.capturedDelivery).toEqual(snap);
  });

  it("is a no-op for an obligation that is not open (a delivered turn has none to resume)", () => {
    const L = new ObligationLedger(2);
    L.noteCapturedDelivery("c:3#missing", snap); // never opened
    expect(L.isOpen("c:3#missing")).toBe(false);
  });

  it("ignores an EMPTY snapshot (nothing to resume)", () => {
    const L = new ObligationLedger(2);
    L.openIfAbsent(input("c:3#1", 1000));
    L.noteCapturedDelivery("c:3#1", { chunks: [], chunkStates: [] });
    expect(L.list()[0]!.capturedDelivery).toBeUndefined();
  });

  it("close drops the snapshot with the obligation (bounded lifetime, A6)", () => {
    const L = new ObligationLedger(2);
    L.openIfAbsent(input("c:3#1", 1000));
    L.noteCapturedDelivery("c:3#1", snap);
    expect(L.close("c:3#1")).toBe(true);
    expect(L.isOpen("c:3#1")).toBe(false);
  });
});

describe("ObligationLedger — #3550: the represent grace retires once its turn has ended", () => {
  function input(id: string, openedAt: number) {
    return { originTurnId: id, chatId: "-100123", threadId: 3, messageId: Number(id.split("#").pop() ?? 0), text: "x", openedAt };
  }
  const REPR_GRACE = 120_000; // default
  const TRAIL = 45_000;       // OBLIGATION_ESCALATE_GRACE_MS default

  // The bug: the per-represent grace is a proxy for "the re-present has not
  // landed yet". Once a turn that started after it has ENDED, the proxy is
  // provably false, yet the obligation stayed frozen for the rest of the 120s.
  it("acts once the trailing grace clears, instead of waiting out the full represent window", () => {
    const L = new ObligationLedger(2);
    L.openIfAbsent(input("c:3#1", 0));
    L.markRepresented("c:3#1", 5_000);
    L.noteTurnEnded("c:3#1", 15_000); // the re-presented turn ran and ended
    const eligibleAt = 15_000 + TRAIL + 1; // trailing-answer grace from turn end
    expect(eligibleAt).toBeLessThan(5_000 + REPR_GRACE); // i.e. this is genuinely earlier
    expect(
      L.decideAtIdle({ now: eligibleAt, graceMs: TRAIL, representGraceMs: REPR_GRACE }).action,
    ).toBe("represent");
  });

  it("still refuses to act during the trailing-answer grace — the answer may be landing", () => {
    const L = new ObligationLedger(2);
    L.openIfAbsent(input("c:3#1", 0));
    L.markRepresented("c:3#1", 5_000);
    L.noteTurnEnded("c:3#1", 15_000);
    // 1ms before the trailing grace expires: the slow answer still has its beat.
    expect(
      L.decideAtIdle({ now: 15_000 + TRAIL - 1, graceMs: TRAIL, representGraceMs: REPR_GRACE }).action,
    ).toBe("none");
  });

  it("an IN-FLIGHT re-present (no turn ended after it) keeps the FULL window — the protection is untouched", () => {
    const L = new ObligationLedger(2);
    L.openIfAbsent(input("c:3#1", 0));
    L.noteTurnEnded("c:3#1", 4_000); // the turn BEFORE the represent — must not count
    L.markRepresented("c:3#1", 5_000);
    expect(
      L.decideAtIdle({ now: 5_000 + REPR_GRACE - 1, graceMs: TRAIL, representGraceMs: REPR_GRACE }).action,
    ).toBe("none");
    expect(
      L.decideAtIdle({ now: 5_000 + REPR_GRACE + 1, graceMs: TRAIL, representGraceMs: REPR_GRACE }).action,
    ).toBe("represent");
  });

  it("with the trailing grace disabled the full represent window is kept — never leaves the obligation ungated", () => {
    const L = new ObligationLedger(2);
    L.openIfAbsent(input("c:3#1", 0));
    L.markRepresented("c:3#1", 5_000);
    L.noteTurnEnded("c:3#1", 15_000);
    expect(
      L.decideAtIdle({ now: 16_000, graceMs: 0, representGraceMs: REPR_GRACE }).action,
    ).toBe("none");
  });

  it("representGraceStillProtecting states the rule directly", () => {
    const P = ObligationLedger.representGraceStillProtecting;
    // in-flight re-present, inside window → still protecting
    expect(P({ lastRepresentedAt: 5_000 }, 10_000, REPR_GRACE, TRAIL)).toBe(true);
    // turn ended after the re-present, but still inside the floor → protecting
    expect(P({ lastRepresentedAt: 5_000, lastTurnEndedAt: 6_000 }, 10_000, REPR_GRACE, TRAIL)).toBe(true);
    // turn ended after the re-present, past the floor → spent
    expect(P({ lastRepresentedAt: 5_000, lastTurnEndedAt: 6_000 }, 5_000 + TRAIL, REPR_GRACE, TRAIL)).toBe(false);
    // turn ended BEFORE the re-present → irrelevant, still protecting
    expect(P({ lastRepresentedAt: 5_000, lastTurnEndedAt: 4_000 }, 10_000, REPR_GRACE, TRAIL)).toBe(true);
    // window already elapsed → not protecting either way
    expect(P({ lastRepresentedAt: 5_000 }, 5_000 + REPR_GRACE, REPR_GRACE, TRAIL)).toBe(false);
    // kill switch / never re-presented
    expect(P({ lastRepresentedAt: 5_000 }, 6_000, 0, TRAIL)).toBe(false);
    expect(P({}, 6_000, REPR_GRACE, TRAIL)).toBe(false);
    // trailing grace disabled → the early-out is withheld
    expect(P({ lastRepresentedAt: 5_000, lastTurnEndedAt: 6_000 }, 10_000, REPR_GRACE, 0)).toBe(true);
  });

  // ── Review finding 3: the derived rung interval needs a FLOOR ──────────────
  // Retiring the represent window makes the rung interval derived (trailing
  // grace + the represent-turn's duration) where the flat 120s used to floor it
  // regardless of tuning. `MIN_REPRESENT_INTERVAL_MS` closes that footgun as a
  // mechanism rather than a doc warning.
  describe("MIN_REPRESENT_INTERVAL_MS floors the derived rung interval", () => {
    const SNAPPY = 1_000; // SWITCHROOM_OBLIGATION_ESCALATE_GRACE_MS=1000

    it("a small-but-non-zero trailing grace cannot collapse the ladder to seconds", () => {
      const FLOOR = ObligationLedger.MIN_REPRESENT_INTERVAL_MS;
      const L = new ObligationLedger(2);
      L.openIfAbsent(input("c:3#1", 0));
      L.markRepresented("c:3#1", 5_000);
      L.noteTurnEnded("c:3#1", 6_000); // represent turn ran and ended in 1s
      // Pre-floor this was eligible at 6_000 + 1_000 = 7_000 — 2s after the
      // re-present. The ladder would have escalated inside ~15-20s.
      expect(
        L.decideAtIdle({ now: 7_000, graceMs: SNAPPY, representGraceMs: REPR_GRACE }).action,
      ).toBe("none");
      // Still held right up to the floor…
      expect(
        L.decideAtIdle({ now: 5_000 + FLOOR - 1, graceMs: SNAPPY, representGraceMs: REPR_GRACE }).action,
      ).toBe("none");
      // …and released at it (the floor, not the full 120s window — the #3550
      // early-out is clamped, not reverted).
      expect(
        L.decideAtIdle({ now: 5_000 + FLOOR, graceMs: SNAPPY, representGraceMs: REPR_GRACE }).action,
      ).toBe("represent");
      expect(5_000 + FLOOR).toBeLessThan(5_000 + REPR_GRACE);
    });

    it("the floor never EXTENDS a window past the represent grace the operator configured", () => {
      // representGraceMs below the floor: the configured window still wins, so
      // the clamp can only ever shorten-cap, never lengthen.
      const SHORT_REPR = 10_000;
      expect(SHORT_REPR).toBeLessThan(ObligationLedger.MIN_REPRESENT_INTERVAL_MS);
      const L = new ObligationLedger(2);
      L.openIfAbsent(input("c:3#1", 0));
      L.markRepresented("c:3#1", 5_000);
      L.noteTurnEnded("c:3#1", 6_000);
      expect(
        L.decideAtIdle({ now: 5_000 + SHORT_REPR, graceMs: SNAPPY, representGraceMs: SHORT_REPR }).action,
      ).toBe("represent");
    });

    it("at the shipped defaults the floor never binds — behaviour is unchanged", () => {
      // 45s trailing ≥ the 30s floor, and it is measured from a turn end that is
      // strictly LATER than the re-present, so the trailing grace always expires
      // after the floor. The clamp is inert in the shipped configuration.
      const P = ObligationLedger.representGraceStillProtecting;
      for (const turnDurationMs of [1, 1_000, 10_000, 60_000]) {
        const represented = 5_000;
        const turnEnded = represented + turnDurationMs;
        const eligibleAt = turnEnded + TRAIL; // what the trailing grace alone allows
        expect(P({ lastRepresentedAt: represented, lastTurnEndedAt: turnEnded }, eligibleAt, REPR_GRACE, TRAIL)).toBe(false);
      }
    });
  });

  // ── Review finding 5: a turn that ended WITHOUT consuming its re-present ───
  // `representGraceStillProtecting` retires the window on a bare timestamp
  // comparison (`lastTurnEndedAt > lastRepresentedAt`) and the doc comment
  // justifies that as "the agent ran a whole turn on it". The code cannot in
  // fact distinguish a consuming turn from a turn that ended without ever
  // seeing the re-present — a bridge-down abort, an instantly-failed turn, or
  // one torn down by #3575's silence-poke fallback. These tests pin what the
  // ledger ACTUALLY does in that case, so the behaviour is asserted rather than
  // assumed by the comment.
  describe("a turn that ends WITHOUT consuming the re-present", () => {
    it("retires the window on the bare timestamp — but never before the floor", () => {
      const FLOOR = ObligationLedger.MIN_REPRESENT_INTERVAL_MS;
      const L = new ObligationLedger(2);
      L.openIfAbsent(input("c:3#1", 0));
      L.markRepresented("c:3#1", 5_000);
      // A turn that died 200ms after the represent fired. It cannot have carried
      // the re-presented text to the agent, yet it stamps lastTurnEndedAt.
      L.noteTurnEnded("c:3#1", 5_200);
      // The ledger treats it as spent, so the next rung is NOT held for the full
      // 120s. It is held for max(floor, trailing-from-turn-end) instead.
      const eligibleAt = Math.max(5_000 + FLOOR, 5_200 + TRAIL);
      expect(
        L.decideAtIdle({ now: eligibleAt - 1, graceMs: TRAIL, representGraceMs: REPR_GRACE }).action,
      ).toBe("none");
      expect(
        L.decideAtIdle({ now: eligibleAt, graceMs: TRAIL, representGraceMs: REPR_GRACE }).action,
      ).toBe("represent");
      // Documented consequence: an aborted turn shortens the rung. That is
      // SAFE-BY-DIRECTION — a turn that never consumed the re-present is a turn
      // that never answered, so re-presenting sooner is the correct action; the
      // cost is one rung of the (already bounded) budget spent earlier.
      expect(eligibleAt).toBeLessThan(5_000 + REPR_GRACE);
    });

    it("burns at most maxRepresents rungs even if EVERY turn aborts instantly", () => {
      // The worst case for the timestamp proxy: no turn ever consumes anything.
      // Termination must still hold and the ladder must still land on escalate.
      const FLOOR = ObligationLedger.MIN_REPRESENT_INTERVAL_MS;
      const L = new ObligationLedger(2);
      L.openIfAbsent(input("c:3#1", 0));
      let now = 0;
      const actions: string[] = [];
      for (let i = 0; i < 5; i++) {
        const d = L.decideAtIdle({ now, graceMs: TRAIL, representGraceMs: REPR_GRACE });
        actions.push(d.action);
        if (d.action === "represent") {
          L.markRepresented("c:3#1", now);
          L.noteTurnEnded("c:3#1", now + 200); // instant abort — nothing consumed
          now += Math.max(FLOOR, TRAIL) + 1_000;
        } else if (d.action === "escalate") {
          break;
        } else {
          now += 5_000;
        }
      }
      expect(actions.filter((a) => a === "represent")).toHaveLength(2); // maxRepresents
      expect(actions.at(-1)).toBe("escalate");
    });

    it("a turn that ended BEFORE the re-present is still not mistaken for a consuming one", () => {
      // The complement: only a STRICTLY later stamp retires the window, so a
      // stale pre-represent turn end can never shorten it.
      const L = new ObligationLedger(2);
      L.openIfAbsent(input("c:3#1", 0));
      L.noteTurnEnded("c:3#1", 4_999);
      L.markRepresented("c:3#1", 5_000);
      expect(
        L.decideAtIdle({ now: 5_000 + REPR_GRACE - 1, graceMs: TRAIL, representGraceMs: REPR_GRACE }).action,
      ).toBe("none");
    });
  });

  // ── Review finding 6: the hydrated post-restart shape ──────────────────────
  // A snapshot restored with lastTurnEndedAt > lastRepresentedAt hits the
  // early-out on the FIRST sweep after boot. Pre-#3550 the represent window was
  // measured from lastRepresentedAt and survived the restart, so a crash 2s
  // after a re-present still cost 118s before the next rung.
  describe("hydrated post-restart obligation (E1 > R1)", () => {
    it("cannot fire on the first sweep after boot — the floor survives hydration", () => {
      const FLOOR = ObligationLedger.MIN_REPRESENT_INTERVAL_MS;
      const L = new ObligationLedger(2);
      L.hydrate([
        {
          ...input("c:3#1", 0),
          representCount: 1,
          lastRepresentedAt: 100_000,
          lastTurnEndedAt: 101_000, // the turn the crash ended
        },
      ]);
      // Boot sweep, ~5s after the crash. Without the floor this is eligible at
      // 101_000+TRAIL and, with a snappier trailing tune, immediately — racing
      // the boot-resume inbound so the user sees the resume AND a re-present.
      expect(
        L.decideAtIdle({ now: 105_000, graceMs: TRAIL, representGraceMs: REPR_GRACE }).action,
      ).toBe("none");
      expect(
        L.decideAtIdle({ now: 105_000, graceMs: 1_000, representGraceMs: REPR_GRACE }).action,
      ).toBe("none");
      // The floor is measured from the DURABLE lastRepresentedAt, so it holds
      // across the restart rather than restarting from boot.
      expect(
        L.decideAtIdle({ now: 100_000 + FLOOR - 1, graceMs: 1_000, representGraceMs: REPR_GRACE }).action,
      ).toBe("none");
      expect(
        L.decideAtIdle({ now: 100_000 + FLOOR, graceMs: 1_000, representGraceMs: REPR_GRACE }).action,
      ).toBe("represent");
    });

    it("still eventually advances after a restart — the floor delays, never prevents", () => {
      const L = new ObligationLedger(2);
      L.hydrate([
        { ...input("c:3#1", 0), representCount: 1, lastRepresentedAt: 100_000, lastTurnEndedAt: 101_000 },
      ]);
      expect(
        L.decideAtIdle({ now: 101_000 + TRAIL, graceMs: TRAIL, representGraceMs: REPR_GRACE }).action,
      ).toBe("represent");
    });
  });
});

describe("#3550 G2 — the seam that makes noteTurnEnded actually fire in production", () => {
  // Every other #3550 test calls noteTurnEnded() directly, so they prove the
  // LEDGER RULE but not the WIRING. In production the stamp only lands because
  // the represent inbound round-trips back to the same key: the gateway builds
  // the inbound from the obligation, and the turn it spawns derives its turn id
  // from that inbound's chat/thread/message. noteTurnEnded is a keyed lookup —
  // if `deriveTurnId(buildObligationRepresentInbound(o)) !== o.originTurnId` it
  // silently no-ops, this entire fix goes dead in the field, and every other
  // test in this file still passes green. That linkage was asserted only by a
  // comment at obligation-wiring.ts:250-256. This pins it.
  function obligationFor(chatId: string, threadId: number | undefined, messageId: number) {
    const L = new ObligationLedger(2);
    const originTurnId = deriveTurnId(chatId, threadId ?? null, messageId)!;
    L.openIfAbsent({ originTurnId, chatId, threadId, messageId, text: "do the thing", openedAt: 0 });
    return L.list()[0];
  }

  const cases: Array<[string, string, number | undefined, number]> = [
    ["forum topic", "-100123", 3, 715],
    ["DM (no thread)", "12345", undefined, 42],
    ["general topic id 1", "-100999", 1, 8],
  ];

  for (const [label, chatId, threadId, messageId] of cases) {
    it(`round-trips the origin id through the represent inbound — ${label}`, () => {
      const o = obligationFor(chatId, threadId, messageId);
      const inbound = buildObligationRepresentInbound(o, 1_000);
      const derived = deriveTurnId(inbound.chatId, inbound.threadId ?? null, inbound.messageId);
      expect(derived).toBe(o.originTurnId);
    });
  }

  it("a represent-spawned turn's derived key actually reaches noteTurnEnded (end-to-end on the real seam)", () => {
    const L = new ObligationLedger(2);
    const originTurnId = deriveTurnId("-100123", 3, 715)!;
    L.openIfAbsent({ originTurnId, chatId: "-100123", threadId: 3, messageId: 715, text: "x", openedAt: 0 });
    L.markRepresented(originTurnId, 5_000);
    // Stamp using ONLY what a represent-spawned turn would know: the inbound.
    const inbound = buildObligationRepresentInbound(L.list()[0], 5_000);
    const turnKey = deriveTurnId(inbound.chatId, inbound.threadId ?? null, inbound.messageId)!;
    L.noteTurnEnded(turnKey, 15_000);
    // If the seam drifted, noteTurnEnded no-ops, lastTurnEndedAt stays undefined,
    // the #3550 early-out never fires, and this stays "none" until t=125_000.
    expect(L.list()[0].lastTurnEndedAt).toBe(15_000);
    expect(
      L.decideAtIdle({ now: 15_000 + 45_000 + 1, graceMs: 45_000, representGraceMs: 120_000 }).action,
    ).toBe("represent");
  });

  it("the represent inbound also echoes origin_turn_id in meta (the close-side half of the same seam)", () => {
    const o = obligationFor("-100123", 3, 715);
    expect(buildObligationRepresentInbound(o, 1_000).meta?.origin_turn_id).toBe(o.originTurnId);
  });
});
