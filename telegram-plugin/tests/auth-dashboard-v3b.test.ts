/**
 * Dashboard v3b — active/fallback marking + promote verb tests.
 *
 * Three surfaces under test:
 *   1. encodeCallbackData / parseCallbackData round-trip for the new
 *      `account-promote` + `confirm-account-promote` verbs (`apr`/`cpr`).
 *   2. formatQuotaBar — the mini-bar renderer used on the active row.
 *   3. buildDashboardText / buildDashboardKeyboard — verifies the `▶`
 *      glyph floats the active account, the "Fallback ↓:" subhead
 *      appears when there's a distinguished active row, and that the
 *      v3a unmarked layout is preserved when no account claims active
 *      (older CLI without primaryForAgents).
 *
 * Pure module — no gateway/Telegram side effects.
 */

import { describe, expect, it } from "vitest";
import {
  encodeCallbackData,
  parseCallbackData,
  formatQuotaBar,
  buildDashboardText,
  buildDashboardKeyboard,
  buildAccountPromoteConfirmKeyboard,
  CALLBACK_BUDGET_BYTES,
  type AccountSummary,
  type DashboardState,
} from "../auth-dashboard.js";

const baseState: Omit<DashboardState, "accounts"> = {
  agent: "clerk",
  bankId: "clerk",
  plan: "max",
  rateLimitTier: "default_claude_max_20x",
  slots: [],
  quotaHot: false,
};

const acc = (
  label: string,
  overrides: Partial<AccountSummary> = {},
): AccountSummary => ({
  label,
  health: "healthy",
  enabledHere: true,
  ...overrides,
});

describe("v3b: account-promote callback round-trip", () => {
  it("encodes and decodes account-promote (verb apr)", () => {
    const encoded = encodeCallbackData({
      kind: "account-promote",
      agent: "clerk",
      label: "pixsoul@gmail.com",
    });
    expect(encoded).toBe("auth:apr:clerk:pixsoul@gmail.com");
    expect(parseCallbackData(encoded)).toEqual({
      kind: "account-promote",
      agent: "clerk",
      label: "pixsoul@gmail.com",
    });
  });

  it("encodes and decodes confirm-account-promote (verb cpr)", () => {
    const encoded = encodeCallbackData({
      kind: "confirm-account-promote",
      agent: "clerk",
      label: "me@kenthompson.com.au",
    });
    expect(encoded).toBe("auth:cpr:clerk:me@kenthompson.com.au");
    expect(parseCallbackData(encoded)).toEqual({
      kind: "confirm-account-promote",
      agent: "clerk",
      label: "me@kenthompson.com.au",
    });
  });

  it("rejects labels with disallowed characters", () => {
    // `/` is rejected by isSafeAccountLabel — would create on-disk
    // ambiguity under ~/.switchroom/accounts/.
    expect(parseCallbackData("auth:apr:clerk:bad/label")).toEqual({
      kind: "noop",
    });
    // Whitespace, quotes, etc.
    expect(parseCallbackData("auth:apr:clerk:bad label")).toEqual({
      kind: "noop",
    });
  });

  it("rejects payloads beyond the 64-byte cap", () => {
    const longLabel = "a".repeat(60);
    const overlong = `auth:cpr:agent:${longLabel}`;
    // sanity — payload exceeds the cap
    expect(Buffer.byteLength(overlong, "utf8")).toBeGreaterThan(
      CALLBACK_BUDGET_BYTES,
    );
    expect(parseCallbackData(overlong)).toEqual({ kind: "noop" });
  });

  it("rejects empty label segment", () => {
    expect(parseCallbackData("auth:apr:clerk:")).toEqual({ kind: "noop" });
  });
});

describe("v3b: formatQuotaBar", () => {
  it("renders all-empty for 0%", () => {
    expect(formatQuotaBar(0)).toBe("░░░░░░");
  });

  it("renders all-full for 100%", () => {
    expect(formatQuotaBar(100)).toBe("██████");
  });

  it("clamps below full for 99% so the bar reads visibly under the cap", () => {
    // Critical UX point: a 99% account is one bad turn from exhaustion.
    // The bar must NOT show as full. The cell math floors, so 99/100*6
    // = 5.94 → 5 filled cells.
    expect(formatQuotaBar(99)).toBe("█████░");
  });

  it("scales linearly across the range", () => {
    expect(formatQuotaBar(50)).toBe("███░░░");
    expect(formatQuotaBar(33)).toBe("█░░░░░"); // 33/100*6=1.98 → 1
    expect(formatQuotaBar(17)).toBe("█░░░░░"); // 17/100*6=1.02 → 1
    expect(formatQuotaBar(83)).toBe("████░░"); // 83/100*6=4.98 → 4
  });

  it("clamps negative or >100 inputs to the legal range", () => {
    expect(formatQuotaBar(-5)).toBe("░░░░░░");
    expect(formatQuotaBar(150)).toBe("██████");
  });

  it("supports a custom cell count", () => {
    expect(formatQuotaBar(50, 10)).toBe("█████░░░░░");
    expect(formatQuotaBar(0, 0)).toBe("");
  });
});

describe("v3b: buildDashboardText — active-row marking", () => {
  it("floats the activeForThisAgent row to the top with a ▶ glyph", () => {
    const state: DashboardState = {
      ...baseState,
      accounts: [
        acc("pixsoul@gmail.com", { activeForThisAgent: true }),
        acc("me@kenthompson.com.au"),
        acc("ken.thompson@outlook.com.au"),
      ],
    };
    const text = buildDashboardText(state);
    const pixIdx = text.indexOf("pixsoul@gmail.com");
    const meIdx = text.indexOf("me@kenthompson.com.au");
    expect(pixIdx).toBeGreaterThan(-1);
    expect(meIdx).toBeGreaterThan(-1);
    // Active row precedes fallbacks in the rendered text.
    expect(pixIdx).toBeLessThan(meIdx);
    // ▶ glyph appears on the active row, before the label.
    const arrowIdx = text.indexOf("▶");
    expect(arrowIdx).toBeGreaterThan(-1);
    expect(arrowIdx).toBeLessThan(pixIdx);
  });

  it("emits a 'Fallback ↓:' subhead when there's a distinguished active row", () => {
    const state: DashboardState = {
      ...baseState,
      accounts: [
        acc("pixsoul@gmail.com", { activeForThisAgent: true }),
        acc("me@kenthompson.com.au"),
      ],
    };
    expect(buildDashboardText(state)).toContain("Fallback");
  });

  it("falls back to the v3a unmarked layout when no account claims active", () => {
    // Older CLI without primaryForAgents → activeForThisAgent is unset
    // on every account → no ▶ glyph, no Fallback subhead. The v3a
    // bullet-list rendering still works.
    const state: DashboardState = {
      ...baseState,
      accounts: [acc("pixsoul@gmail.com"), acc("me@kenthompson.com.au")],
    };
    const text = buildDashboardText(state);
    expect(text).not.toContain("▶");
    expect(text).not.toContain("Fallback");
    // Both labels still appear.
    expect(text).toContain("pixsoul@gmail.com");
    expect(text).toContain("me@kenthompson.com.au");
  });

  it("renders inline mini-bars on the active row when both percentages are known", () => {
    const state: DashboardState = {
      ...baseState,
      accounts: [
        acc("pixsoul@gmail.com", {
          activeForThisAgent: true,
          fiveHourPct: 47,
          sevenDayPct: 12,
        }),
      ],
    };
    const text = buildDashboardText(state);
    // Both bars present (the "█"/"░" cells appear in the active-row's
    // inline summary). Spot-check the 47% → "██░░░░░" (47/100*6=2.82
    // → 2 filled cells) and 12% → "░░░░░░" (12/100*6=0.72 → 0 filled).
    expect(text).toContain(formatQuotaBar(47));
    expect(text).toContain(formatQuotaBar(12));
    expect(text).toContain("47%");
    expect(text).toContain("12%");
  });

  it("falls back to the legacy quota-line on the active row when only one percentage is known", () => {
    const state: DashboardState = {
      ...baseState,
      accounts: [
        acc("pixsoul@gmail.com", {
          activeForThisAgent: true,
          fiveHourPct: 47,
          // sevenDayPct intentionally absent
        }),
      ],
    };
    const text = buildDashboardText(state);
    // No mini-bar (would require both); the legacy line shows just 5h.
    expect(text).toContain("47%");
    expect(text).not.toContain("12%");
  });

  it("uses the existing 'exhausted · resets in …' line when active is exhausted", () => {
    const state: DashboardState = {
      ...baseState,
      accounts: [
        acc("pixsoul@gmail.com", {
          activeForThisAgent: true,
          quotaExhaustedUntil: Date.now() + 90 * 60_000,
          fiveHourPct: 100,
          sevenDayPct: 50,
        }),
      ],
    };
    const text = buildDashboardText(state);
    expect(text).toContain("exhausted");
    expect(text).toContain("resets in");
  });
});

describe("v3b: buildDashboardKeyboard — promote button row", () => {
  const renderRows = (
    accounts: AccountSummary[],
  ): Array<Array<{ text: string; data: string }>> => {
    const kb = buildDashboardKeyboard({ ...baseState, accounts });
    // grammY's InlineKeyboard exposes its internal layout via `inline_keyboard`.
    const raw = (kb as unknown as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> })
      .inline_keyboard;
    return raw.map((row) =>
      row.map((b) => ({ text: b.text, data: b.callback_data })),
    );
  };

  it("emits a `⤴ Promote <label>` button under each non-active account", () => {
    const rows = renderRows([
      acc("pixsoul@gmail.com", { activeForThisAgent: true }),
      acc("me@kenthompson.com.au"),
      acc("ken.thompson@outlook.com.au"),
    ]);
    const promoteRows = rows.flat().filter((b) => b.text.startsWith("⤴ Promote"));
    expect(promoteRows.length).toBe(2); // me@ + ken@
    const labels = promoteRows.map((b) => b.text.replace("⤴ Promote ", ""));
    expect(labels.sort()).toEqual(
      ["ken.thompson@outlook.com.au", "me@kenthompson.com.au"].sort(),
    );
    // Promote callbacks dispatch to account-promote (verb apr).
    for (const b of promoteRows) {
      expect(b.data.startsWith("auth:apr:clerk:")).toBe(true);
    }
  });

  it("does NOT emit a promote button for the active row", () => {
    const rows = renderRows([
      acc("pixsoul@gmail.com", { activeForThisAgent: true }),
      acc("me@kenthompson.com.au"),
    ]);
    const promoteRows = rows.flat().filter((b) => b.text.startsWith("⤴ Promote"));
    // Only one — the fallback. The active row gets none.
    expect(promoteRows.length).toBe(1);
    expect(promoteRows[0].text).toBe("⤴ Promote me@kenthompson.com.au");
  });

  it("emits NO promote buttons when no account claims active (older CLI)", () => {
    // Without a distinguished active row we can't tell which one to
    // suppress, so we suppress all of them rather than offer ambiguous
    // "promote" actions on every row.
    const rows = renderRows([
      acc("pixsoul@gmail.com"),
      acc("me@kenthompson.com.au"),
    ]);
    const promoteRows = rows.flat().filter((b) => b.text.startsWith("⤴ Promote"));
    expect(promoteRows.length).toBe(0);
  });

  it("renders a noop fallback when the promote payload would exceed 64 bytes", () => {
    // Pathological agent + label lengths. Guard renders the row inert
    // rather than letting Telegram reject the message.
    const longAgent = "a".repeat(50);
    const longLabel = "b".repeat(50);
    const kb = buildDashboardKeyboard({
      ...baseState,
      agent: longAgent,
      accounts: [
        acc(longLabel, { activeForThisAgent: false }),
        acc("pixsoul", { activeForThisAgent: true }),
      ],
    });
    const raw = (kb as unknown as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard;
    const guarded = raw.flat().find((b) => b.text.includes("⤴ Promote") && b.text.includes("(use CLI)"));
    expect(guarded).toBeDefined();
    expect(guarded?.callback_data).toBe("auth:noop");
  });
});

describe("v3b: buildAccountPromoteConfirmKeyboard", () => {
  it("emits a confirm row whose callback dispatches confirm-account-promote", () => {
    const kb = buildAccountPromoteConfirmKeyboard("clerk", "pixsoul@gmail.com");
    const raw = (kb as unknown as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> }).inline_keyboard;
    const confirm = raw.flat().find((b) => b.text.includes("Confirm promote"));
    expect(confirm?.callback_data).toBe("auth:cpr:clerk:pixsoul@gmail.com");
    const cancel = raw.flat().find((b) => b.text.includes("Cancel"));
    expect(cancel?.callback_data).toBe("auth:refresh:clerk");
  });
});
