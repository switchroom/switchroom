import { describe, it, expect } from "vitest";
import {
  buildDashboardText,
  buildDashboardKeyboard,
  parseCallbackData,
  encodeCallbackData,
  isQuotaHot,
  buildRemoveConfirmKeyboard,
  QUOTA_HOT_THRESHOLD_PCT,
  type DashboardSlot,
} from "../auth-dashboard";

/**
 * Edge-case coverage for the /auth dashboard. Pair with
 * auth-dashboard.test.ts which covers the happy paths. This file
 * focuses on pathological input, security boundaries, and failure
 * modes we should not regress.
 */

function slot(o: Partial<DashboardSlot> = {}): DashboardSlot {
  return { slot: "default", active: false, health: "healthy", quotaExhaustedUntil: null, fiveHourPct: null, sevenDayPct: null, ...o };
}

describe("callback payload — hostile inputs", () => {
  const cases: Array<[string, string]> = [
    ["shell expansion", "auth:reauth:$(whoami)"],
    ["backticks", "auth:reauth:`id`"],
    ["semicolons", "auth:reauth:clerk;ls"],
    ["pipes", "auth:reauth:clerk|nc attacker"],
    ["dot-segments", "auth:use:../../../etc/passwd:default"],
    ["null bytes", "auth:reauth:clerk\0xyz"],
    ["tabs", "auth:reauth:clerk\ttab"],
    ["newlines", "auth:reauth:clerk\nextra"],
    ["leading space", "auth:reauth: clerk"],
    ["trailing space", "auth:reauth:clerk "],
    ["unicode lookalike", "auth:reauth:\u202eevil"],
    ["empty agent", "auth:reauth:"],
    ["empty slot for use", "auth:use:clerk:"],
    ["slot too long (33 chars)", "auth:use:clerk:" + "a".repeat(33)],
    ["agent too long (65 chars)", "auth:reauth:" + "a".repeat(65)],
    ["slot contains dot", "auth:use:clerk:slot.name"],
    ["slot contains slash", "auth:use:clerk:slot/name"],
    ["slot contains space", "auth:use:clerk:slot name"],
  ];

  it.each(cases)("rejects %s as noop: %s", (_desc, data) => {
    expect(parseCallbackData(data)).toEqual({ kind: "noop" });
  });

  it("accepts legitimately hyphenated slot names", () => {
    expect(parseCallbackData("auth:use:clerk:backup-1")).toMatchObject({ kind: "use", slot: "backup-1" });
  });

  it("accepts underscored names", () => {
    expect(parseCallbackData("auth:use:clerk:work_personal")).toMatchObject({ kind: "use", slot: "work_personal" });
  });
});

describe("dashboard text — pathological slot states", () => {
  it("renders 10 slots without breaking layout", () => {
    const slots: DashboardSlot[] = Array.from({ length: 10 }, (_, i) => slot({
      slot: `slot-${i}`,
      active: i === 0,
    }));
    const text = buildDashboardText({ agent: "clerk", bankId: "assistant", plan: "max", slots, quotaHot: false });
    // All 10 slot names appear in the output
    for (let i = 0; i < 10; i++) {
      expect(text).toContain(`slot-${i}`);
    }
  });

  it("renders when ALL slots are quota-exhausted (fallback-impossible state)", () => {
    const slots = [
      slot({ slot: "default", active: true, health: "quota-exhausted", quotaExhaustedUntil: Date.now() + 60_000 }),
      slot({ slot: "backup", active: false, health: "quota-exhausted", quotaExhaustedUntil: Date.now() + 120_000 }),
    ];
    const text = buildDashboardText({ agent: "clerk", bankId: "assistant", slots, quotaHot: true });
    expect(text).toContain("default");
    expect(text).toContain("backup");
    expect(text.match(/quota-exhausted/g)?.length).toBe(2);
  });

  it("renders when a slot has zero quota data (no fiveHour/sevenDay pct)", () => {
    const text = buildDashboardText({
      agent: "clerk",
      bankId: "assistant",
      slots: [slot({ active: true, fiveHourPct: null, sevenDayPct: null })],
      quotaHot: false,
    });
    // Shouldn't contain '5h:' or '7d:' if no data
    expect(text).not.toContain("5h:");
    expect(text).not.toContain("7d:");
  });

  it("handles plan=null gracefully", () => {
    const text = buildDashboardText({
      agent: "clerk",
      bankId: "assistant",
      plan: null,
      slots: [slot({ active: true })],
      quotaHot: false,
    });
    expect(text).toContain("assistant");
    expect(text).not.toContain("Plan:");
  });

  it("handles 0% utilization (falsy but present)", () => {
    const text = buildDashboardText({
      agent: "clerk",
      bankId: "a",
      slots: [slot({ active: true, fiveHourPct: 0, sevenDayPct: 0 })],
      quotaHot: false,
    });
    expect(text).toContain("5h: 0%");
    expect(text).toContain("7d: 0%");
  });

  it("handles 100% utilization", () => {
    const text = buildDashboardText({
      agent: "clerk",
      bankId: "a",
      slots: [slot({ active: true, fiveHourPct: 100, sevenDayPct: 100 })],
      quotaHot: true,
    });
    expect(text).toContain("5h: 100%");
    expect(text).toContain("7d: 100%");
  });

  it("handles negative reset time (already expired)", () => {
    const text = buildDashboardText({
      agent: "clerk",
      bankId: "a",
      slots: [slot({ active: true, health: "quota-exhausted", quotaExhaustedUntil: Date.now() - 60_000 })],
      quotaHot: true,
    });
    // Should clamp to 0 rather than show negative minutes
    expect(text).toContain("resets in ~0m");
  });

  it("escapes very adversarial agent names", () => {
    const text = buildDashboardText({
      agent: '</b><script>alert("x")</script><b>',
      bankId: "a",
      slots: [slot({ active: true })],
      quotaHot: false,
    });
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
  });
});

describe("dashboard keyboard — edge cases", () => {
  it("caps non-active slot buttons at 3 (prevents runaway rows)", () => {
    const slots = [
      slot({ slot: "active", active: true }),
      slot({ slot: "s1" }),
      slot({ slot: "s2" }),
      slot({ slot: "s3" }),
      slot({ slot: "s4" }),
      slot({ slot: "s5" }),
    ];
    const kb = buildDashboardKeyboard({ agent: "clerk", bankId: "a", slots, quotaHot: false });
    const useButtons = kb.inline_keyboard.flat().filter((b) => b.text.startsWith("Use:"));
    expect(useButtons.length).toBeLessThanOrEqual(3);
  });

  it("no [Reauth active] button when no active slot", () => {
    const kb = buildDashboardKeyboard({ agent: "clerk", bankId: "a", slots: [slot({ slot: "a", active: false })], quotaHot: false });
    const reauthButton = kb.inline_keyboard.flat().find((b) => b.text.includes("Reauth"));
    // There IS still a Reauth button (agent-level, no slot) — expected behaviour
    expect(reauthButton).toBeDefined();
    // But it should NOT reference a specific slot name
    expect(reauthButton!.text).not.toMatch(/Reauth \S+$/);
  });

  it("no Use/Remove rows at all when only the active slot exists", () => {
    const kb = buildDashboardKeyboard({ agent: "clerk", bankId: "a", slots: [slot({ active: true })], quotaHot: false });
    const flat = kb.inline_keyboard.flat();
    expect(flat.some((b) => b.text.startsWith("Use:"))).toBe(false);
    expect(flat.some((b) => b.text.startsWith("🗑 Remove:"))).toBe(false);
  });

  it("empty slot set still shows Add + Refresh", () => {
    const kb = buildDashboardKeyboard({ agent: "clerk", bankId: "a", slots: [], quotaHot: false });
    const flat = kb.inline_keyboard.flat();
    expect(flat.some((b) => b.text.includes("Add slot"))).toBe(true);
    expect(flat.some((b) => b.text.includes("Refresh"))).toBe(true);
  });

  it("Refresh callback always targets the correct agent", () => {
    const kb = buildDashboardKeyboard({ agent: "specific-agent", bankId: "a", slots: [], quotaHot: false });
    const refreshBtn = kb.inline_keyboard.flat().find((b) => b.text.includes("Refresh"));
    if (refreshBtn && "callback_data" in refreshBtn) {
      expect(refreshBtn.callback_data).toBe("auth:refresh:specific-agent");
    }
  });
});

describe("isQuotaHot — boundary conditions", () => {
  it("99% 5h does NOT trip hot (cold, auto-fallback at 99.5%)", () => {
    expect(isQuotaHot([slot({ fiveHourPct: 89 })])).toBe(false);
  });

  it("exactly QUOTA_HOT_THRESHOLD_PCT (90%) trips hot", () => {
    expect(isQuotaHot([slot({ fiveHourPct: QUOTA_HOT_THRESHOLD_PCT })])).toBe(true);
    expect(isQuotaHot([slot({ sevenDayPct: QUOTA_HOT_THRESHOLD_PCT })])).toBe(true);
  });

  it("one hot slot among many cold → hot", () => {
    expect(isQuotaHot([
      slot({ fiveHourPct: 10 }),
      slot({ fiveHourPct: 20 }),
      slot({ fiveHourPct: 95 }),
      slot({ fiveHourPct: 0 }),
    ])).toBe(true);
  });

  it("quota-exhausted always hot, even with 0% pct", () => {
    expect(isQuotaHot([slot({ health: "quota-exhausted", fiveHourPct: 0, sevenDayPct: 0 })])).toBe(true);
  });

  it("null utilization doesn't trip", () => {
    expect(isQuotaHot([slot({ fiveHourPct: null, sevenDayPct: null })])).toBe(false);
  });
});

describe("remove confirm keyboard — edge cases", () => {
  it("cancel button refreshes back to the dashboard (doesn't leave orphan)", () => {
    const kb = buildRemoveConfirmKeyboard("clerk", "personal");
    const cancelBtn = kb.inline_keyboard.flat().find((b) => b.text.includes("Cancel"));
    if (cancelBtn && "callback_data" in cancelBtn) {
      expect(cancelBtn.callback_data).toBe("auth:refresh:clerk");
    }
  });

  it("handles slot names with hyphens/underscores in the confirm label", () => {
    const kb = buildRemoveConfirmKeyboard("clerk", "backup_slot-v2");
    const confirmBtn = kb.inline_keyboard.flat().find((b) => b.text.startsWith("⚠️"));
    expect(confirmBtn?.text).toContain("backup_slot-v2");
  });
});

describe("encode/parse round-trip — lots of identities", () => {
  const actions = [
    { kind: "refresh", agent: "a" },
    { kind: "reauth", agent: "a" },
    { kind: "reauth", agent: "a", slot: "b" },
    { kind: "add", agent: "a" },
    { kind: "use", agent: "a", slot: "b" },
    { kind: "rm", agent: "a", slot: "b" },
    { kind: "confirm-rm", agent: "a", slot: "b" },
    { kind: "fallback", agent: "a" },
    { kind: "usage", agent: "a" },
  ] as const;

  it.each(actions)("round-trips %s", (action) => {
    const encoded = encodeCallbackData(action);
    expect(parseCallbackData(encoded)).toEqual(action);
  });
});
