import { describe, it, expect } from "vitest";
import {
  buildDashboard,
  buildDashboardText,
  buildDashboardKeyboard,
  buildRemoveConfirmKeyboard,
  encodeCallbackData,
  parseCallbackData,
  isQuotaHot,
  escapeHtml,
  QUOTA_HOT_THRESHOLD_PCT,
  type DashboardState,
  type DashboardSlot,
} from "../auth-dashboard";

function mkSlot(overrides: Partial<DashboardSlot> = {}): DashboardSlot {
  return {
    slot: "default",
    active: false,
    health: "healthy",
    quotaExhaustedUntil: null,
    fiveHourPct: null,
    sevenDayPct: null,
    ...overrides,
  };
}

describe("encodeCallbackData / parseCallbackData round-trip", () => {
  it("refresh preserves agent", () => {
    const encoded = encodeCallbackData({ kind: "refresh", agent: "clerk" });
    expect(encoded).toBe("auth:refresh:clerk");
    expect(parseCallbackData(encoded)).toEqual({ kind: "refresh", agent: "clerk" });
  });

  it("reauth with slot preserves both", () => {
    const encoded = encodeCallbackData({ kind: "reauth", agent: "klanker", slot: "personal" });
    expect(parseCallbackData(encoded)).toEqual({ kind: "reauth", agent: "klanker", slot: "personal" });
  });

  it("reauth without slot works", () => {
    const encoded = encodeCallbackData({ kind: "reauth", agent: "klanker" });
    expect(parseCallbackData(encoded)).toEqual({ kind: "reauth", agent: "klanker" });
  });

  it("use requires a slot", () => {
    const encoded = encodeCallbackData({ kind: "use", agent: "clerk", slot: "personal" });
    expect(parseCallbackData(encoded)).toEqual({ kind: "use", agent: "clerk", slot: "personal" });
  });

  it("rm and confirm-rm round-trip", () => {
    expect(parseCallbackData(encodeCallbackData({ kind: "rm", agent: "clerk", slot: "x" }))).toEqual({
      kind: "rm",
      agent: "clerk",
      slot: "x",
    });
    expect(parseCallbackData(encodeCallbackData({ kind: "confirm-rm", agent: "clerk", slot: "x" }))).toEqual({
      kind: "confirm-rm",
      agent: "clerk",
      slot: "x",
    });
  });

  it("fallback/usage/add all round-trip", () => {
    for (const kind of ["fallback", "usage", "add"] as const) {
      const encoded = encodeCallbackData({ kind, agent: "clerk" });
      expect(parseCallbackData(encoded)).toEqual({ kind, agent: "clerk" });
    }
  });

  it("rejects unknown verbs as noop", () => {
    expect(parseCallbackData("auth:unknown:clerk")).toEqual({ kind: "noop" });
  });

  it("rejects malicious agent names as noop (injection guard)", () => {
    expect(parseCallbackData("auth:reauth:evil;rm -rf /")).toEqual({ kind: "noop" });
    expect(parseCallbackData("auth:reauth:$(whoami)")).toEqual({ kind: "noop" });
    expect(parseCallbackData("auth:reauth:../../etc/passwd")).toEqual({ kind: "noop" });
  });

  it("rejects malicious slot names as noop", () => {
    expect(parseCallbackData("auth:use:clerk:evil slot")).toEqual({ kind: "noop" });
    expect(parseCallbackData("auth:use:clerk:../../x")).toEqual({ kind: "noop" });
  });

  it("rejects non-auth prefixes as noop", () => {
    expect(parseCallbackData("perm:allow:abc")).toEqual({ kind: "noop" });
    expect(parseCallbackData("random garbage")).toEqual({ kind: "noop" });
    expect(parseCallbackData("")).toEqual({ kind: "noop" });
  });

  it("realistic-length payloads fit Telegram's 64-byte callback_data cap", () => {
    // Longest prefix is 'auth:confirm-rm:' = 16 chars. Typical agent
    // names (clerk / klanker / lawgpt) and slot names (default /
    // personal / work / backup) are <= 16 chars each in practice.
    //
    // Agent names CAN go up to 64 chars in the config schema, but if a
    // user picks e.g. a 40-char agent name their dashboard callbacks
    // would exceed the cap and break silently. Document as an
    // upstream limit rather than enforce here; the scaffold CLI also
    // doesn't warn on this today.
    const encoded = encodeCallbackData({
      kind: "confirm-rm",
      agent: "a".repeat(16),
      slot: "b".repeat(16),
    });
    expect(encoded.length).toBeLessThanOrEqual(64);
  });
});

describe("buildDashboardText", () => {
  const base: DashboardState = {
    agent: "clerk",
    bankId: "assistant",
    plan: "max",
    slots: [mkSlot({ slot: "default", active: true })],
    quotaHot: false,
  };

  it("renders header with agent + bank + plan", () => {
    const text = buildDashboardText(base);
    expect(text).toContain("Auth");
    expect(text).toContain("clerk");
    expect(text).toContain("assistant");
    expect(text).toContain("max");
  });

  it("marks the active slot with ● and a label", () => {
    const text = buildDashboardText(base);
    expect(text).toContain("●");
    expect(text).toContain("<code>default</code>");
    expect(text).toContain("(active)");
  });

  it("renders quota-exhausted slots with resets-in hint", () => {
    const until = Date.now() + 30 * 60_000;
    const text = buildDashboardText({
      ...base,
      slots: [mkSlot({ slot: "default", active: true, health: "quota-exhausted", quotaExhaustedUntil: until })],
    });
    expect(text).toMatch(/resets in ~\d+m/);
    expect(text).toContain("⚠️");
  });

  it("renders utilization when present", () => {
    const text = buildDashboardText({
      ...base,
      slots: [mkSlot({ slot: "default", active: true, fiveHourPct: 42, sevenDayPct: 61 })],
    });
    expect(text).toContain("5h: 42%");
    expect(text).toContain("7d: 61%");
  });

  it("escapes HTML in agent + slot names (XSS/injection guard)", () => {
    const text = buildDashboardText({
      ...base,
      agent: "<evil>",
      slots: [mkSlot({ slot: "<also>", active: true })],
    });
    expect(text).toContain("&lt;evil&gt;");
    expect(text).toContain("&lt;also&gt;");
    expect(text).not.toContain("<evil>");
  });

  it("shows empty-state message when no slots exist", () => {
    const text = buildDashboardText({ ...base, slots: [] });
    expect(text).toMatch(/no account slots/i);
    expect(text).toContain("Add slot");
  });
});

describe("buildDashboardKeyboard", () => {
  it("shows [Reauth active] + [Add slot] in the first row when active slot exists", () => {
    const kb = buildDashboardKeyboard({
      agent: "clerk",
      bankId: "assistant",
      plan: "max",
      slots: [mkSlot({ slot: "default", active: true })],
      quotaHot: false,
    });
    const row0 = kb.inline_keyboard[0];
    expect(row0[0].text).toMatch(/Reauth/);
    expect(row0[0].text).toContain("default");
    expect(row0[1].text).toMatch(/Add slot/);
  });

  it("renders [Use: X] for every non-active slot (up to 3)", () => {
    const kb = buildDashboardKeyboard({
      agent: "clerk",
      bankId: "assistant",
      slots: [
        mkSlot({ slot: "default", active: true }),
        mkSlot({ slot: "personal", active: false }),
        mkSlot({ slot: "work", active: false }),
      ],
      quotaHot: false,
    });
    const useButtons = kb.inline_keyboard.flat().filter((b) => b.text.startsWith("Use:"));
    expect(useButtons).toHaveLength(2);
    expect(useButtons[0].text).toContain("personal");
    expect(useButtons[1].text).toContain("work");
  });

  it("shows [Fall back now] only when quotaHot is true", () => {
    const cold = buildDashboardKeyboard({
      agent: "clerk",
      bankId: "a",
      slots: [mkSlot({ active: true })],
      quotaHot: false,
    });
    const hot = buildDashboardKeyboard({
      agent: "clerk",
      bankId: "a",
      slots: [mkSlot({ active: true, health: "quota-exhausted" })],
      quotaHot: true,
    });
    const coldTexts = cold.inline_keyboard.flat().map((b) => b.text);
    const hotTexts = hot.inline_keyboard.flat().map((b) => b.text);
    expect(coldTexts.some((t) => t.includes("Fall back"))).toBe(false);
    expect(hotTexts.some((t) => t.includes("Fall back"))).toBe(true);
  });

  it("always ends with a Refresh button", () => {
    const kb = buildDashboardKeyboard({
      agent: "clerk",
      bankId: "a",
      slots: [mkSlot({ active: true })],
      quotaHot: false,
    });
    const lastRow = kb.inline_keyboard[kb.inline_keyboard.length - 1];
    expect(lastRow[0].text).toContain("Refresh");
  });

  it("encodes agent + slot correctly in callback_data", () => {
    const kb = buildDashboardKeyboard({
      agent: "klanker",
      bankId: "assistant",
      slots: [mkSlot({ slot: "default", active: true }), mkSlot({ slot: "backup", active: false })],
      quotaHot: false,
    });
    const flat = kb.inline_keyboard.flat();
    for (const btn of flat) {
      if ("callback_data" in btn && btn.callback_data) {
        expect(btn.callback_data.startsWith("auth:")).toBe(true);
        // All payloads fit within Telegram's callback_data cap.
        expect(btn.callback_data.length).toBeLessThanOrEqual(64);
      }
    }
  });
});

describe("buildRemoveConfirmKeyboard", () => {
  it("shows a confirm + cancel two-button keyboard", () => {
    const kb = buildRemoveConfirmKeyboard("clerk", "personal");
    const flat = kb.inline_keyboard.flat();
    expect(flat).toHaveLength(2);
    expect(flat[0].text).toContain("Confirm remove");
    expect(flat[0].text).toContain("personal");
    expect(flat[1].text).toContain("Cancel");
  });

  it("confirm button uses confirm-rm action; cancel refreshes", () => {
    const kb = buildRemoveConfirmKeyboard("clerk", "personal");
    const flat = kb.inline_keyboard.flat();
    if ("callback_data" in flat[0] && flat[0].callback_data) {
      expect(flat[0].callback_data).toBe("auth:confirm-rm:clerk:personal");
    }
    if ("callback_data" in flat[1] && flat[1].callback_data) {
      expect(flat[1].callback_data).toBe("auth:refresh:clerk");
    }
  });
});

describe("isQuotaHot", () => {
  it("returns true when any slot is quota-exhausted", () => {
    expect(isQuotaHot([mkSlot({ health: "quota-exhausted" })])).toBe(true);
  });

  it("returns true when 5h utilization crosses the threshold", () => {
    expect(isQuotaHot([mkSlot({ fiveHourPct: QUOTA_HOT_THRESHOLD_PCT })])).toBe(true);
  });

  it("returns true when 7d utilization crosses the threshold", () => {
    expect(isQuotaHot([mkSlot({ sevenDayPct: QUOTA_HOT_THRESHOLD_PCT })])).toBe(true);
  });

  it("returns false when all slots are cool", () => {
    expect(isQuotaHot([mkSlot({ fiveHourPct: 20, sevenDayPct: 40 })])).toBe(false);
  });

  it("returns false on empty slot set", () => {
    expect(isQuotaHot([])).toBe(false);
  });
});

describe("buildDashboard — full integration", () => {
  it("returns { text, keyboard }", () => {
    const result = buildDashboard({
      agent: "clerk",
      bankId: "assistant",
      plan: "max",
      slots: [mkSlot({ slot: "default", active: true })],
      quotaHot: false,
    });
    expect(result.text.length).toBeGreaterThan(0);
    expect(result.keyboard.inline_keyboard.length).toBeGreaterThan(0);
  });
});

describe("escapeHtml", () => {
  it("escapes angle brackets, ampersands, and quotes", () => {
    expect(escapeHtml('<foo bar="baz">&')).toBe("&lt;foo bar=&quot;baz&quot;&gt;&amp;");
  });
});
