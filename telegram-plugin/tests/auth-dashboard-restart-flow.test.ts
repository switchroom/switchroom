import { describe, it, expect } from "vitest";
import {
  buildDashboardText,
  buildDashboardKeyboard,
  encodeCallbackData,
  parseCallbackData,
  type DashboardState,
  type DashboardSlot,
} from "../auth-dashboard";

function slot(o: Partial<DashboardSlot> = {}): DashboardSlot {
  return { slot: "default", active: false, health: "healthy", quotaExhaustedUntil: null, fiveHourPct: null, sevenDayPct: null, ...o };
}

/**
 * PR C — [♻️ Restart flow] dashboard button.
 *
 * Pairs with PR B (automatic stale-session detection). When the user
 * wants to explicitly kill + restart a pending auth flow without
 * waiting for the PKCE challenge to drift, the dashboard surfaces a
 * button keyed by the pending slot name. Gateway routes it to
 * cancel + re-initiate the matching reauth/add.
 */

describe("restart-flow callback — encode / parse round-trip", () => {
  it("encodes as auth:restart-flow:<agent>:<slot>", () => {
    expect(encodeCallbackData({ kind: "restart-flow", agent: "clerk", slot: "default" }))
      .toBe("auth:restart-flow:clerk:default");
    expect(encodeCallbackData({ kind: "restart-flow", agent: "lawgpt", slot: "slot-2" }))
      .toBe("auth:restart-flow:lawgpt:slot-2");
  });

  it("round-trips cleanly", () => {
    for (const action of [
      { kind: "restart-flow", agent: "clerk", slot: "default" },
      { kind: "restart-flow", agent: "lawgpt", slot: "slot-2" },
      { kind: "restart-flow", agent: "klanker", slot: "personal_v2" },
    ] as const) {
      expect(parseCallbackData(encodeCallbackData(action))).toEqual(action);
    }
  });

  it("rejects restart-flow without a slot (slot is required)", () => {
    // The `use`, `rm`, `confirm-rm`, and `restart-flow` verbs all
    // require a slot. Missing slot → noop (doesn't accidentally fire
    // a wider-scope reset).
    expect(parseCallbackData("auth:restart-flow:clerk")).toEqual({ kind: "noop" });
    expect(parseCallbackData("auth:restart-flow:clerk:")).toEqual({ kind: "noop" });
  });

  it("rejects unsafe slot names as noop (shell-injection guard)", () => {
    expect(parseCallbackData("auth:restart-flow:clerk:../etc")).toEqual({ kind: "noop" });
    expect(parseCallbackData("auth:restart-flow:clerk:bad slot")).toEqual({ kind: "noop" });
    expect(parseCallbackData("auth:restart-flow:clerk:slot;ls")).toEqual({ kind: "noop" });
  });

  it("encoded payload fits Telegram's 64-byte callback_data cap", () => {
    // Longest practical: auth:restart-flow:<agent32>:<slot32> = 17 + 32 + 1 + 32 = 82.
    // Agent + slot each capped at 16 chars realistic → well under 64.
    const realistic = encodeCallbackData({
      kind: "restart-flow",
      agent: "a".repeat(16),
      slot: "b".repeat(16),
    });
    expect(realistic.length).toBeLessThanOrEqual(64);
  });
});

describe("dashboard renders [Restart flow] button when pending session exists", () => {
  const base: DashboardState = {
    agent: "lawgpt",
    bankId: "lawgpt",
    plan: "max",
    slots: [slot({ slot: "default", active: true })],
    quotaHot: false,
  };

  it("omits the button when pendingSessionSlot is absent", () => {
    const kb = buildDashboardKeyboard(base);
    const flat = kb.inline_keyboard.flat();
    expect(flat.some((b) => b.text.includes("Restart"))).toBe(false);
  });

  it("renders the button when pendingSessionSlot is set", () => {
    const kb = buildDashboardKeyboard({ ...base, pendingSessionSlot: "default" });
    const flat = kb.inline_keyboard.flat();
    const btn = flat.find((b) => b.text.includes("Restart"));
    expect(btn).toBeDefined();
    expect(btn!.text).toContain("default");
    if (btn && "callback_data" in btn && btn.callback_data) {
      expect(btn.callback_data).toBe("auth:restart-flow:lawgpt:default");
    }
  });

  it("includes slot name in the button label for named-slot pending flows", () => {
    const kb = buildDashboardKeyboard({ ...base, pendingSessionSlot: "slot-2" });
    const flat = kb.inline_keyboard.flat();
    const btn = flat.find((b) => b.text.includes("Restart"));
    expect(btn!.text).toContain("slot-2");
    if (btn && "callback_data" in btn && btn.callback_data) {
      expect(btn.callback_data).toBe("auth:restart-flow:lawgpt:slot-2");
    }
  });

  it("pendingSessionSlot=null is treated as 'no pending' (no button)", () => {
    const kb = buildDashboardKeyboard({ ...base, pendingSessionSlot: null });
    const flat = kb.inline_keyboard.flat();
    expect(flat.some((b) => b.text.includes("Restart"))).toBe(false);
  });
});

describe("dashboard text includes the pending-flow notice", () => {
  const base: DashboardState = {
    agent: "lawgpt",
    bankId: "lawgpt",
    plan: "max",
    slots: [slot({ active: true })],
    quotaHot: false,
  };

  it("no notice when no pending", () => {
    const text = buildDashboardText(base);
    expect(text).not.toContain("Auth flow pending");
    expect(text).not.toContain("⏳");
  });

  it("shows a pending-flow notice when pendingSessionSlot is set", () => {
    const text = buildDashboardText({ ...base, pendingSessionSlot: "slot-2" });
    expect(text).toContain("Auth flow pending");
    expect(text).toContain("slot-2");
    expect(text).toContain("⏳");
    expect(text).toContain("♻️");
  });

  it("escapes HTML in pendingSessionSlot to guard against injection", () => {
    const text = buildDashboardText({ ...base, pendingSessionSlot: "<script>alert(1)</script>" });
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
  });
});
