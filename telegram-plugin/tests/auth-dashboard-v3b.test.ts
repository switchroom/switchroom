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

describe("v3c: buildDashboardKeyboard — single Switch primary button", () => {
  // v3c replaces the v3b per-fallback `⤴ Promote` flood with a single
  // `🔀 Switch primary →` entry that opens a picker sub-keyboard.
  // Pin the visibility rules + the picker behaviour so a refactor can't
  // silently re-surface the v3b button explosion.
  const renderRows = (
    accounts: AccountSummary[],
  ): Array<Array<{ text: string; data: string }>> => {
    const kb = buildDashboardKeyboard({ ...baseState, accounts });
    const raw = (kb as unknown as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> })
      .inline_keyboard;
    return raw.map((row) =>
      row.map((b) => ({ text: b.text, data: b.callback_data })),
    );
  };

  it("emits exactly ONE `🔀 Switch primary →` button when fallbacks exist", () => {
    const rows = renderRows([
      acc("pixsoul@gmail.com", { activeForThisAgent: true }),
      acc("me@kenthompson.com.au"),
      acc("ken.thompson@outlook.com.au"),
    ]);
    const switchButtons = rows
      .flat()
      .filter((b) => b.text.includes("Switch primary"));
    expect(switchButtons.length).toBe(1);
    expect(switchButtons[0].data).toBe("auth:spv:clerk");
  });

  it("hides the Switch primary button when no fallback exists", () => {
    // Only one account, and it's already active → nothing to switch to.
    const rows = renderRows([
      acc("pixsoul@gmail.com", { activeForThisAgent: true }),
    ]);
    const switchButtons = rows
      .flat()
      .filter((b) => b.text.includes("Switch primary"));
    expect(switchButtons.length).toBe(0);
  });

  it("hides the Switch primary button when no account claims active", () => {
    // Older CLI without primaryForAgents → activeForThisAgent unset
    // everywhere → can't tell which account to keep, so no picker.
    const rows = renderRows([
      acc("pixsoul@gmail.com"),
      acc("me@kenthompson.com.au"),
    ]);
    const switchButtons = rows
      .flat()
      .filter((b) => b.text.includes("Switch primary"));
    expect(switchButtons.length).toBe(0);
  });

  it("does NOT emit per-fallback ⤴ Promote buttons on the main board", () => {
    // The whole point of v3c — kill the button flood.
    const rows = renderRows([
      acc("pixsoul@gmail.com", { activeForThisAgent: true }),
      acc("me@kenthompson.com.au"),
      acc("ken.thompson@outlook.com.au"),
    ]);
    const promoteRows = rows.flat().filter((b) => b.text.includes("⤴ Promote"));
    expect(promoteRows.length).toBe(0);
  });

  it("does NOT emit per-account drilldown buttons on the main board", () => {
    // v3c also drops the per-account `account-view` drilldown buttons
    // (av verb) — the text already names every account, the sub-views
    // are reachable via Switch primary / Reauth / Add buttons.
    const rows = renderRows([
      acc("pixsoul@gmail.com", { activeForThisAgent: true }),
      acc("me@kenthompson.com.au"),
    ]);
    const drilldownRows = rows
      .flat()
      .filter((b) => b.data.startsWith("auth:av:"));
    expect(drilldownRows.length).toBe(0);
  });
});

describe("v3c: buildSwitchPrimaryKeyboard — picker", () => {
  it("emits one row per candidate, each fires confirm-account-promote", async () => {
    const { buildSwitchPrimaryKeyboard } = await import("../auth-dashboard.js");
    const kb = buildSwitchPrimaryKeyboard("clerk", [
      { label: "me@kenthompson.com.au", health: "healthy" },
      { label: "ken.thompson@outlook.com.au", health: "healthy" },
    ]);
    const raw = (kb as unknown as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    }).inline_keyboard;
    // 2 candidate rows + 1 cancel row.
    expect(raw.length).toBe(3);
    expect(raw[0][0].callback_data).toBe(
      "auth:cpr:clerk:me@kenthompson.com.au",
    );
    expect(raw[1][0].callback_data).toBe(
      "auth:cpr:clerk:ken.thompson@outlook.com.au",
    );
    // Cancel returns to the main board via refresh.
    expect(raw[2][0].text).toContain("Cancel");
    expect(raw[2][0].callback_data).toBe("auth:refresh:clerk");
  });

  it("renders a noop fallback when a candidate's payload exceeds 64 bytes", async () => {
    const { buildSwitchPrimaryKeyboard } = await import("../auth-dashboard.js");
    const kb = buildSwitchPrimaryKeyboard("a".repeat(50), [
      { label: "b".repeat(50), health: "healthy" },
    ]);
    const raw = (kb as unknown as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    }).inline_keyboard;
    const guarded = raw[0][0];
    expect(guarded.text).toContain("(use CLI)");
    expect(guarded.callback_data).toBe("auth:noop");
  });

  it("appends health suffix to each candidate row", async () => {
    const { buildSwitchPrimaryKeyboard } = await import("../auth-dashboard.js");
    const kb = buildSwitchPrimaryKeyboard("clerk", [
      { label: "expired@x.com", health: "expired" },
      { label: "good@x.com", health: "healthy" },
    ]);
    const raw = (kb as unknown as {
      inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
    }).inline_keyboard;
    expect(raw[0][0].text).toContain("⌛");
    expect(raw[1][0].text).not.toContain("⌛");
    expect(raw[1][0].text).not.toContain("⚠");
  });
});

describe("v3c: switch-primary-view callback round-trip", () => {
  it("encodes and decodes (verb spv)", () => {
    const encoded = encodeCallbackData({
      kind: "switch-primary-view",
      agent: "clerk",
    });
    expect(encoded).toBe("auth:spv:clerk");
    expect(parseCallbackData(encoded)).toEqual({
      kind: "switch-primary-view",
      agent: "clerk",
    });
  });

  it("rejects unsafe agent names", () => {
    expect(parseCallbackData("auth:spv:bad/agent")).toEqual({ kind: "noop" });
  });
});

describe("v3b: Slots + Pool sections hide when active-account signal is present", () => {
  // The slot row was rendering `● pixsoul@gmail.com (active) ✓ healthy`
  // when the active label was known — a 1:1 duplicate of the
  // `▶ pixsoul@gmail.com  ✓` active-account row above. Same for the
  // `Pool: pixsoul@gmail.com is active` line. So we hide both sections
  // entirely under the new account model. Pin the visibility rules so
  // a refactor can't silently re-surface the duplication.
  const slotRowState = (
    activeAccountLabel: string | null,
  ): DashboardState => ({
    ...baseState,
    slots: [
      {
        slot: "default",
        active: true,
        health: "active",
      },
    ],
    accounts:
      activeAccountLabel != null
        ? [
            acc(activeAccountLabel, { activeForThisAgent: true }),
            acc("ken.thompson@outlook.com.au"),
          ]
        : [acc("ken.thompson@outlook.com.au")],
  });

  it("hides the Slots section entirely when an active-account signal is present", () => {
    const text = buildDashboardText(slotRowState("pixsoul@gmail.com"));
    // No "Slots (N)" header, no "default" leaking out, no Pool line.
    expect(text).not.toContain("Slots (");
    expect(text).not.toContain("default");
    expect(text).not.toMatch(/Pool:/);
    // The ▶ active row is the single source of truth for what's active.
    expect(text).toContain("▶");
    expect(text).toContain("pixsoul@gmail.com");
  });

  it("keeps the legacy Slots + Pool layout when accounts have no active signal", () => {
    // Older CLIs don't emit primaryForAgents → no activeForThisAgent
    // is set on any account → slots section is the only signal of
    // "what's active." Preserve it for graceful degradation.
    const text = buildDashboardText(slotRowState(null));
    expect(text).toContain("Slots (");
    expect(text).toContain("<code>default</code> (active)");
    expect(text).toContain("Pool:");
  });

  it("keeps the Slots section visible when no accounts exist (fresh-fleet bootstrap)", () => {
    // Bootstrap path: no accounts yet, the operator's only handle is
    // the slot — they need [➕ Add slot] / [🔄 Reauth] to work.
    const text = buildDashboardText({
      ...baseState,
      slots: [{ slot: "default", active: true, health: "active" }],
      accounts: [],
    });
    expect(text).toContain("Slots (");
    expect(text).toContain("default");
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

describe("regression: button count cap on the main board", () => {
  // Real-world wedge: a screenshot from /auth showed 8 buttons stacked
  // vertically on a three-account fleet (the v3b explosion). v3c
  // collapsed everything into a Switch primary picker. Pin the cap so
  // a future "let's add one more affordance" PR can't bring it back.
  const renderRows = (accounts: AccountSummary[]): number => {
    const kb = buildDashboardKeyboard({ ...baseState, accounts });
    return (
      kb as unknown as {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
      }
    ).inline_keyboard.length;
  };

  it("renders <=6 keyboard rows with three accounts (down from 8 in v3b)", () => {
    // pixsoul (active) + 2 fallbacks. Expected layout:
    //   row 1: 🔀 Switch primary →
    //   row 2: 🔄 Reauth + ➕ Add slot  (2 buttons, 1 row)
    //   row 3: 📊 Full quota
    //   row 4: 🔁 Refresh
    // = 4 rows. Cap at 6 leaves room for a future row without letting
    // the v3b explosion return.
    expect(
      renderRows([
        acc("pixsoul@gmail.com", { activeForThisAgent: true }),
        acc("me@kenthompson.com.au"),
        acc("ken.thompson@outlook.com.au"),
      ]),
    ).toBeLessThanOrEqual(6);
  });

  it("never emits a Promote button targeting the active account", () => {
    // The original screenshot bug: ⤴ Promote pixsoul@gmail.com
    // appeared even when pixsoul was the active row. Pin that no
    // promote callback (apr/cpr verbs) targets the active label.
    const kb = buildDashboardKeyboard({
      ...baseState,
      accounts: [
        acc("pixsoul@gmail.com", { activeForThisAgent: true }),
        acc("me@kenthompson.com.au"),
      ],
    });
    const allButtons = (
      kb as unknown as {
        inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
      }
    ).inline_keyboard.flat();
    for (const btn of allButtons) {
      const m = btn.callback_data.match(/^auth:(?:apr|cpr):[^:]+:(.+)$/);
      if (m) {
        expect(m[1], "active label found in promote callback").not.toBe(
          "pixsoul@gmail.com",
        );
      }
    }
  });
});

describe("regression: [⚠️ Fall back now] button stays gone (v0.6.11)", () => {
  // Removed when the Switch primary picker became the operator-facing
  // surface for the same outcome. Two paths to the same action
  // confused operators. If quotaHot ever re-surfaces the button, this
  // test catches it.
  it("absent regardless of quotaHot, slot health, or accounts shape", () => {
    const cases: Array<Parameters<typeof buildDashboardKeyboard>[0]> = [
      { ...baseState, quotaHot: false },
      { ...baseState, quotaHot: true },
      {
        ...baseState,
        quotaHot: true,
        slots: [{ slot: "default", active: true, health: "quota-exhausted" }],
      },
      {
        ...baseState,
        accounts: [
          acc("pixsoul", { activeForThisAgent: true, fiveHourPct: 99 }),
        ],
      },
    ];
    for (const state of cases) {
      const kb = buildDashboardKeyboard(state);
      const labels = (
        kb as unknown as {
          inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
        }
      ).inline_keyboard
        .flat()
        .map((b) => b.text);
      expect(
        labels.some((t) => /fall.?back/i.test(t)),
        `Fall back surfaced under quotaHot=${state.quotaHot}, slots=${state.slots?.length}`,
      ).toBe(false);
    }
  });
});
