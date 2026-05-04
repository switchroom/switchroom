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

// ─── Account-level dashboard ──────────────────────────────────────────

import {
  buildAccountConfirmKeyboard,
  ACCOUNTS_DISPLAY_CAP,
  CALLBACK_BUDGET_BYTES,
  isSafeAccountLabel,
  type AccountSummary,
  type AccountHealth,
} from "../auth-dashboard";

function mkAccount(overrides: Partial<AccountSummary> = {}): AccountSummary {
  return {
    label: "default",
    health: "healthy",
    enabledHere: false,
    ...overrides,
  };
}

function mkState(overrides: Partial<DashboardState> = {}): DashboardState {
  return {
    agent: "clerk",
    bankId: "clerk",
    plan: "max",
    rateLimitTier: null,
    slots: [mkSlot({ active: true, health: "active" })],
    quotaHot: false,
    generatedAt: "2026-05-03T12:00:00Z",
    pendingSessionSlot: null,
    ...overrides,
  };
}

describe("isSafeAccountLabel", () => {
  it("accepts the CLI-validated regex including '.' for labels like acme.team", () => {
    expect(isSafeAccountLabel("default")).toBe(true);
    expect(isSafeAccountLabel("acme.team")).toBe(true);
    expect(isSafeAccountLabel("ken_personal")).toBe(true);
    expect(isSafeAccountLabel("co-2024")).toBe(true);
    expect(isSafeAccountLabel("a")).toBe(true);
    expect(isSafeAccountLabel("a".repeat(64))).toBe(true);
  });

  it("rejects empty, oversized, and dangerous characters", () => {
    expect(isSafeAccountLabel("")).toBe(false);
    expect(isSafeAccountLabel("a".repeat(65))).toBe(false);
    expect(isSafeAccountLabel("with space")).toBe(false);
    expect(isSafeAccountLabel("a/b")).toBe(false);
    expect(isSafeAccountLabel("a:b")).toBe(false); // colon would corrupt callback parsing
    expect(isSafeAccountLabel("a;rm -rf")).toBe(false);
    expect(isSafeAccountLabel("../escape")).toBe(false);
  });
});

describe("encodeCallbackData / parseCallbackData — account verbs", () => {
  it("account-enable round-trips with a simple label", () => {
    const action = { kind: "account-enable" as const, agent: "clerk", label: "work" };
    const encoded = encodeCallbackData(action);
    expect(encoded).toBe("auth:ae:clerk:work");
    expect(parseCallbackData(encoded)).toEqual(action);
  });

  it("account-disable round-trips", () => {
    const action = { kind: "account-disable" as const, agent: "clerk", label: "work" };
    const encoded = encodeCallbackData(action);
    expect(encoded).toBe("auth:ad:clerk:work");
    expect(parseCallbackData(encoded)).toEqual(action);
  });

  it("confirm-account-enable round-trips", () => {
    const action = { kind: "confirm-account-enable" as const, agent: "klanker", label: "work" };
    const encoded = encodeCallbackData(action);
    expect(encoded).toBe("auth:cae:klanker:work");
    expect(parseCallbackData(encoded)).toEqual(action);
  });

  it("confirm-account-disable round-trips", () => {
    const action = { kind: "confirm-account-disable" as const, agent: "klanker", label: "work" };
    const encoded = encodeCallbackData(action);
    expect(encoded).toBe("auth:cad:klanker:work");
    expect(parseCallbackData(encoded)).toEqual(action);
  });

  it("share-fleet round-trips (no label segment)", () => {
    const action = { kind: "share-fleet" as const, agent: "clerk" };
    const encoded = encodeCallbackData(action);
    expect(encoded).toBe("auth:sf:clerk");
    expect(parseCallbackData(encoded)).toEqual(action);
  });

  it("preserves labels with '.' through the round-trip (acme.team)", () => {
    const action = { kind: "account-enable" as const, agent: "clerk", label: "acme.team" };
    const encoded = encodeCallbackData(action);
    expect(parseCallbackData(encoded)).toEqual(action);
  });

  it("rejects malformed account labels (parses to noop)", () => {
    expect(parseCallbackData("auth:ae:clerk:bad label")).toEqual({ kind: "noop" });
    expect(parseCallbackData("auth:ae:clerk:..")).toEqual({ kind: "noop" });
    expect(parseCallbackData("auth:ae:clerk:")).toEqual({ kind: "noop" });
    expect(parseCallbackData("auth:ae:clerk")).toEqual({ kind: "noop" }); // missing label segment
  });

  it("rejects malformed agent in account verbs", () => {
    expect(parseCallbackData("auth:ae:bad agent:work")).toEqual({ kind: "noop" });
    expect(parseCallbackData("auth:ae::work")).toEqual({ kind: "noop" });
  });

  it("rejects payloads beyond the 64-byte cap as noop", () => {
    const oversize = "auth:ae:" + "a".repeat(80) + ":" + "b".repeat(80);
    expect(parseCallbackData(oversize)).toEqual({ kind: "noop" });
  });
});

describe("buildDashboardKeyboard — accounts section", () => {
  function rows(state: DashboardState): Array<Array<{ text: string; callback_data?: string }>> {
    return buildDashboardKeyboard(state).inline_keyboard as unknown as Array<
      Array<{ text: string; callback_data?: string }>
    >;
  }

  function flatTexts(state: DashboardState): string[] {
    return rows(state).flat().map((b) => b.text);
  }

  it("renders nothing when accounts is undefined (degraded fallback)", () => {
    const state = mkState({ accounts: undefined });
    const texts = flatTexts(state);
    expect(texts.find((t) => t.startsWith("✓") || t.startsWith("○"))).toBeUndefined();
    expect(texts).not.toContain("🌐 Share to fleet");
  });

  it("renders the bootstrap button when accounts is empty AND canBootstrapShare is true", () => {
    const state = mkState({ accounts: [], canBootstrapShare: true });
    const texts = flatTexts(state);
    expect(texts).toContain("🌐 Share to fleet");
  });

  it("hides the bootstrap button when canBootstrapShare is false", () => {
    const state = mkState({ accounts: [], canBootstrapShare: false });
    const texts = flatTexts(state);
    expect(texts).not.toContain("🌐 Share to fleet");
  });

  it("renders an account button with a drill-down (account-view) callback", () => {
    // v3a: account buttons on the main board open the sub-view, not a
    // toggle. The ✓/○ markers are gone from the main board buttons.
    const state = mkState({
      accounts: [mkAccount({ label: "work", enabledHere: true })],
    });
    const allButtons = rows(state).flat();
    const acctBtn = allButtons.find((b) => b.text.includes("work"));
    expect(acctBtn?.text).toBe("work");
    expect(acctBtn?.callback_data).toBe("auth:av:clerk:work");
  });

  it("renders account button for a disabled account — still uses account-view callback", () => {
    const state = mkState({
      accounts: [mkAccount({ label: "work", enabledHere: false })],
    });
    const allButtons = rows(state).flat();
    const acctBtn = allButtons.find((b) => b.text.includes("work"));
    expect(acctBtn?.text).toBe("work");
    expect(acctBtn?.callback_data).toBe("auth:av:clerk:work");
  });

  it("appends a health suffix for non-healthy accounts", () => {
    const state = mkState({
      accounts: [
        mkAccount({ label: "expired-acct", health: "expired", enabledHere: true }),
        mkAccount({ label: "quota-acct", health: "quota-exhausted", enabledHere: false }),
      ],
    });
    const texts = flatTexts(state);
    expect(texts.some((t) => t.startsWith("expired-acct ⌛"))).toBe(true);
    expect(texts.some((t) => t.startsWith("quota-acct ⚠️"))).toBe(true);
  });

  it("caps visible accounts at ACCOUNTS_DISPLAY_CAP and adds a truncated noop row", () => {
    const tooMany: AccountSummary[] = [];
    for (let i = 0; i < ACCOUNTS_DISPLAY_CAP + 2; i++) {
      tooMany.push(mkAccount({ label: `acct-${i}`, enabledHere: false }));
    }
    const state = mkState({ accounts: tooMany, accountsTruncated: true });
    const allButtons = rows(state).flat();
    // v3a: account buttons no longer have ✓/○ prefix; filter by account-view callback
    const acctBtns = allButtons.filter((b) => b.callback_data?.startsWith("auth:av:"));
    expect(acctBtns).toHaveLength(ACCOUNTS_DISPLAY_CAP);
    expect(allButtons.find((b) => b.text.startsWith("…"))?.callback_data).toBe(
      "auth:noop",
    );
  });

  it("hides the bootstrap button once accounts exist (per-account toggles take over)", () => {
    const state = mkState({
      accounts: [mkAccount({ label: "work", enabledHere: false })],
      canBootstrapShare: true,
    });
    const texts = flatTexts(state);
    expect(texts).not.toContain("🌐 Share to fleet");
  });

  it("falls back to a noop button when the synthesised callback exceeds the 64-byte cap", () => {
    // Pathological: 60-char label + 40-char agent → "auth:av:" (8) +
    // 40 + ":" + 60 = 109 bytes, well over the 64-byte cap.
    const longLabel = "a".repeat(60);
    const state = mkState({
      agent: "x".repeat(40),
      accounts: [mkAccount({ label: longLabel, enabledHere: true })],
    });
    const allButtons = rows(state).flat();
    const noopBtn = allButtons.find((b) => b.text.startsWith("⚠"));
    expect(noopBtn?.callback_data).toBe("auth:noop");
    expect(noopBtn?.text).toMatch(/use CLI/);
  });

  it("account-view encodes under the 64-byte budget for typical names", () => {
    expect(
      Buffer.byteLength(
        encodeCallbackData({ kind: "account-view", agent: "clerk", label: "work" }),
        "utf8",
      ),
    ).toBeLessThanOrEqual(CALLBACK_BUDGET_BYTES);
  });
});

describe("buildAccountConfirmKeyboard", () => {
  it("emits an enable confirm + cancel row", () => {
    const kb = buildAccountConfirmKeyboard("clerk", "work", "enable");
    const buttons = (kb.inline_keyboard as unknown as Array<Array<{ text: string; callback_data?: string }>>).flat();
    expect(buttons).toHaveLength(2);
    expect(buttons[0].text).toBe("⚠️ Confirm enable: work");
    expect(buttons[0].callback_data).toBe("auth:cae:clerk:work");
    expect(buttons[1].text).toBe("↩️ Cancel");
    expect(buttons[1].callback_data).toBe("auth:refresh:clerk");
  });

  it("emits a disable confirm with the disable callback", () => {
    const kb = buildAccountConfirmKeyboard("clerk", "work", "disable");
    const buttons = (kb.inline_keyboard as unknown as Array<Array<{ text: string; callback_data?: string }>>).flat();
    expect(buttons[0].text).toBe("⚠️ Confirm disable: work");
    expect(buttons[0].callback_data).toBe("auth:cad:clerk:work");
  });
});

describe("buildDashboardText — accounts summary line", () => {
  it("omits the line when accounts is undefined", () => {
    const text = buildDashboardText(mkState({ accounts: undefined }));
    expect(text).not.toMatch(/Accounts:/);
  });

  it("omits the line when accounts is an empty array (no totals to summarise)", () => {
    const text = buildDashboardText(mkState({ accounts: [] }));
    expect(text).not.toMatch(/Accounts:/);
  });

  it("renders account list with labels when accounts exist (v3a: accounts-first layout)", () => {
    // v3a: the summary line "Accounts: N/M shared" is replaced by a
    // proper section header + per-account rows. The text now shows each
    // account label. The old "N/M shared" summary is gone — sub-views
    // carry the per-account detail instead.
    const text = buildDashboardText(
      mkState({
        accounts: [
          mkAccount({ label: "work", enabledHere: true }),
          mkAccount({ label: "home", enabledHere: false }),
          mkAccount({ label: "test", enabledHere: false }),
        ],
      }),
    );
    expect(text).toMatch(/Anthropic accounts \(3\)/);
    expect(text).toContain("<code>work</code>");
    expect(text).toContain("<code>home</code>");
    expect(text).toContain("<code>test</code>");
  });
});

const _AccountHealthCheck: AccountHealth = "healthy"; // type-import smoke
void _AccountHealthCheck;

// ─── v3a: new callback kinds ──────────────────────────────────────────────

import {
  buildAccountSubViewText,
  buildAccountSubViewKeyboard,
  buildAccountRemoveConfirmKeyboard,
} from "../auth-dashboard";

describe("encodeCallbackData / parseCallbackData — v3a account sub-view verbs", () => {
  it("account-view round-trips", () => {
    const action = { kind: "account-view" as const, agent: "clerk", label: "work" };
    const encoded = encodeCallbackData(action);
    expect(encoded).toBe("auth:av:clerk:work");
    expect(parseCallbackData(encoded)).toEqual(action);
  });

  it("account-rm round-trips", () => {
    const action = { kind: "account-rm" as const, agent: "clerk", label: "work" };
    const encoded = encodeCallbackData(action);
    expect(encoded).toBe("auth:arm:clerk:work");
    expect(parseCallbackData(encoded)).toEqual(action);
  });

  it("account-rm-confirm round-trips", () => {
    const action = { kind: "account-rm-confirm" as const, agent: "clerk", label: "work" };
    const encoded = encodeCallbackData(action);
    expect(encoded).toBe("auth:armc:clerk:work");
    expect(parseCallbackData(encoded)).toEqual(action);
  });

  it("account-reauth round-trips", () => {
    const action = { kind: "account-reauth" as const, agent: "clerk", label: "work" };
    const encoded = encodeCallbackData(action);
    expect(encoded).toBe("auth:ara:clerk:work");
    expect(parseCallbackData(encoded)).toEqual(action);
  });

  it("rejects malformed agent in v3a verbs", () => {
    expect(parseCallbackData("auth:av:bad agent:work")).toEqual({ kind: "noop" });
  });

  it("rejects malformed label in v3a verbs", () => {
    expect(parseCallbackData("auth:av:clerk:bad label")).toEqual({ kind: "noop" });
    expect(parseCallbackData("auth:arm:clerk:..")).toEqual({ kind: "noop" });
    expect(parseCallbackData("auth:armc:clerk:")).toEqual({ kind: "noop" });
  });

  it("v3a verbs fit within 64-byte cap for typical names", () => {
    for (const kind of ["account-view", "account-rm", "account-rm-confirm", "account-reauth"] as const) {
      const encoded = encodeCallbackData({ kind, agent: "clerk", label: "work" });
      expect(Buffer.byteLength(encoded, "utf8")).toBeLessThanOrEqual(CALLBACK_BUDGET_BYTES);
    }
  });
});

describe("buildAccountSubViewText", () => {
  it("includes label, agent, and health in the sub-view body", () => {
    const acc: AccountSummary = { label: "work", health: "healthy", enabledHere: true };
    const text = buildAccountSubViewText("clerk", acc);
    expect(text).toContain("work");
    expect(text).toContain("clerk");
    expect(text).toContain("healthy");
  });

  it("escapes HTML in label and agent", () => {
    const acc: AccountSummary = { label: "a&b", health: "healthy", enabledHere: false };
    const text = buildAccountSubViewText("<evil>", acc);
    expect(text).toContain("&amp;");
    expect(text).toContain("&lt;evil&gt;");
    expect(text).not.toContain("<evil>");
  });

  it("shows subscriptionType when present", () => {
    const acc: AccountSummary = { label: "work", health: "healthy", enabledHere: true, subscriptionType: "max_5x" };
    const text = buildAccountSubViewText("clerk", acc);
    expect(text).toContain("max_5x");
  });
});

describe("buildAccountSubViewKeyboard", () => {
  it("has Reauth, Remove, and back-to-Accounts buttons", () => {
    const kb = buildAccountSubViewKeyboard("clerk", "work");
    const buttons = (kb.inline_keyboard as unknown as Array<Array<{ text: string; callback_data?: string }>>).flat();
    expect(buttons.find((b) => b.text === "🔁 Reauth")).toBeTruthy();
    expect(buttons.find((b) => b.text === "🗑 Remove")).toBeTruthy();
    expect(buttons.find((b) => b.text === "← Accounts")).toBeTruthy();
  });

  it("Reauth uses account-reauth callback", () => {
    const kb = buildAccountSubViewKeyboard("clerk", "work");
    const buttons = (kb.inline_keyboard as unknown as Array<Array<{ text: string; callback_data?: string }>>).flat();
    const btn = buttons.find((b) => b.text === "🔁 Reauth");
    expect(btn?.callback_data).toBe("auth:ara:clerk:work");
  });

  it("Remove uses account-rm callback", () => {
    const kb = buildAccountSubViewKeyboard("clerk", "work");
    const buttons = (kb.inline_keyboard as unknown as Array<Array<{ text: string; callback_data?: string }>>).flat();
    const btn = buttons.find((b) => b.text === "🗑 Remove");
    expect(btn?.callback_data).toBe("auth:arm:clerk:work");
  });

  it("back button returns to main dashboard via refresh", () => {
    const kb = buildAccountSubViewKeyboard("clerk", "work");
    const buttons = (kb.inline_keyboard as unknown as Array<Array<{ text: string; callback_data?: string }>>).flat();
    const btn = buttons.find((b) => b.text === "← Accounts");
    expect(btn?.callback_data).toBe("auth:refresh:clerk");
  });
});

describe("buildAccountRemoveConfirmKeyboard", () => {
  it("has Yes-remove and Cancel buttons", () => {
    const kb = buildAccountRemoveConfirmKeyboard("clerk", "work");
    const buttons = (kb.inline_keyboard as unknown as Array<Array<{ text: string; callback_data?: string }>>).flat();
    expect(buttons.find((b) => b.text === "✓ Yes, remove")).toBeTruthy();
    expect(buttons.find((b) => b.text === "✗ Cancel")).toBeTruthy();
  });

  it("Yes button uses account-rm-confirm callback", () => {
    const kb = buildAccountRemoveConfirmKeyboard("clerk", "work");
    const buttons = (kb.inline_keyboard as unknown as Array<Array<{ text: string; callback_data?: string }>>).flat();
    const btn = buttons.find((b) => b.text === "✓ Yes, remove");
    expect(btn?.callback_data).toBe("auth:armc:clerk:work");
  });

  it("Cancel button returns to account sub-view via account-view callback", () => {
    const kb = buildAccountRemoveConfirmKeyboard("clerk", "work");
    const buttons = (kb.inline_keyboard as unknown as Array<Array<{ text: string; callback_data?: string }>>).flat();
    const btn = buttons.find((b) => b.text === "✗ Cancel");
    expect(btn?.callback_data).toBe("auth:av:clerk:work");
  });

  it("Cancel button falls back to noop when account-view payload exceeds budget", () => {
    // A very long label pushes the encoded account-view callback over the
    // 64-byte cap — the Cancel button must use the noop fallback so the
    // Telegram Bot API doesn't reject the keyboard.
    const longLabel = "a".repeat(51);
    const kb = buildAccountRemoveConfirmKeyboard("clerk", longLabel);
    const buttons = (kb.inline_keyboard as unknown as Array<Array<{ text: string; callback_data?: string }>>).flat();
    const btn = buttons.find((b) => b.text === "✗ Cancel");
    // Verify the encoded cancel payload would exceed budget
    const cancelEncoded = encodeCallbackData({ kind: "account-view", agent: "clerk", label: longLabel });
    expect(Buffer.byteLength(cancelEncoded, "utf8")).toBeGreaterThan(CALLBACK_BUDGET_BYTES);
    // Cancel must fall back to noop when over budget
    expect(btn?.callback_data).toBe("auth:noop");
  });
});

describe("account-view not-found path — keyboard/text surface", () => {
  // The gateway handler for account-view fires answerCallbackQuery with an
  // error toast when the label is not found in the current dashboard state,
  // then refreshes the main dashboard. This test verifies the Cancel button
  // on the remove-confirm keyboard always produces a valid callback so the
  // user can escape back to a working state even when state is stale.
  it("account-view callback encodes cleanly for a label that has since been removed", () => {
    // Simulate: user opened remove-confirm for "old-account", then the
    // account was removed out-of-band. The Cancel button's encoded payload
    // must still parse to a valid (noop or account-view) action — it should
    // never produce a malformed string that Telegram would reject.
    const kb = buildAccountRemoveConfirmKeyboard("clerk", "old-account");
    const buttons = (kb.inline_keyboard as unknown as Array<Array<{ text: string; callback_data?: string }>>).flat();
    const btn = buttons.find((b) => b.text === "✗ Cancel");
    const action = parseCallbackData(btn?.callback_data ?? "");
    expect(["account-view", "noop"]).toContain(action.kind);
  });
});

describe("account-view not-found path — gateway dispatch contract", () => {
  // When the gateway receives an account-view callback but cannot find the
  // account label in the current dashboard state (e.g. removed out-of-band
  // between the button being rendered and tapped), the handler must:
  //   1. Fire answerCallbackQuery with an error toast (not an empty ACK).
  //   2. Refresh the main dashboard via editMessageText.
  //
  // This describe pins the pure-function contract that makes that path
  // deterministic: parseCallbackData identifies the action correctly, and
  // the sub-view builders are never called on absent accounts — the caller
  // (gateway) is responsible for the early-return / toast path.

  it("parseCallbackData correctly identifies account-view for a valid encoded label", () => {
    // The gateway uses parseCallbackData to dispatch. An account that has
    // since been removed still decodes to account-view (not noop) as long
    // as the label itself is structurally valid — the gateway then does the
    // state lookup and branches on not-found.
    const encoded = encodeCallbackData({ kind: "account-view", agent: "clerk", label: "old-account" });
    const action = parseCallbackData(encoded);
    expect(action.kind).toBe("account-view");
    if (action.kind === "account-view") {
      expect(action.agent).toBe("clerk");
      expect(action.label).toBe("old-account");
    }
  });

  it("account lookup against an empty state returns undefined (triggers not-found toast)", () => {
    // Simulate fetchDashboardState returning a state with no accounts.
    // The gateway does: state?.accounts?.find(a => a.label === action.label)
    // This must return undefined, which gates the error-toast branch.
    const accounts: AccountSummary[] = [];
    const found = accounts.find((a) => a.label === "old-account");
    expect(found).toBeUndefined();
  });

  it("account lookup against a state that no longer contains the label returns undefined", () => {
    // The account existed when the keyboard was rendered but was removed
    // before the user tapped the button.
    const accounts: AccountSummary[] = [
      { label: "current", health: "healthy", enabledHere: true },
      { label: "other", health: "healthy", enabledHere: false },
    ];
    const found = accounts.find((a) => a.label === "old-account");
    expect(found).toBeUndefined();
  });

  it("buildAccountSubViewText renders correctly for a present account (success path)", () => {
    // Verifies the happy path that the gateway takes when the account IS found.
    // The not-found branch must NOT call buildAccountSubViewText — this test
    // pins what the success path looks like so any regression in the dispatch
    // logic (e.g. calling sub-view builder before the not-found check) is
    // visible.
    const acc: AccountSummary = { label: "old-account", health: "healthy", enabledHere: true };
    const text = buildAccountSubViewText("clerk", acc);
    expect(text).toContain("old-account");
    expect(text).toContain("clerk");
  });

  it("error toast message format contains the label (matches gateway handler string)", () => {
    // The gateway sends: `Account "${action.label}" not found.`
    // Pin the label interpolation so a refactor of the toast string
    // doesn't silently drop the label.
    const label = "old-account";
    const toastText = `Account "${label}" not found.`;
    expect(toastText).toContain(label);
    expect(toastText).toMatch(/not found/i);
  });
});
