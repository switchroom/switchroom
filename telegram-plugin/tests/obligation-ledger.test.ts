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
