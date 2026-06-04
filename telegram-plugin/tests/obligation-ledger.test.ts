import { describe, it, expect } from "vitest";
import {
  ObligationLedger,
  buildObligationRepresentInbound,
  obligationEscalationText,
  type Obligation,
} from "../gateway/obligation-ledger.js";

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

    it("no echo + MULTIPLE open → close NOTHING (never wrong-close/drop)", () => {
      const L = new ObligationLedger();
      L.openIfAbsent(input("c:635#713", 1000));
      L.openIfAbsent(input("c:3#715", 1100));
      // the marko race: 713's un-echoed reply lands while currentTurn=715.
      // Closing 715 would silently drop it → resolveCloseTarget refuses.
      expect(L.resolveCloseTarget(undefined, "c:3#715")).toBeNull();
      expect(L.isOpen("c:3#715")).toBe(true); // 715 stays open → re-presented
    });

    it("no echo + live turn not an open obligation → null", () => {
      const L = new ObligationLedger();
      L.openIfAbsent(input("c:3#715", 1100));
      expect(L.resolveCloseTarget(undefined, "c:9#999")).toBeNull();
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

  it("hydrate skips malformed rows", () => {
    const L = new ObligationLedger();
    L.hydrate([
      { originTurnId: "c:3#1", chatId: "-100123", messageId: 1, text: "x", openedAt: 1000, representCount: 0 },
      { originTurnId: "", chatId: "x", messageId: 0, text: "", openedAt: 0, representCount: 0 } as Obligation,
    ]);
    expect(L.size()).toBe(1);
  });
});
