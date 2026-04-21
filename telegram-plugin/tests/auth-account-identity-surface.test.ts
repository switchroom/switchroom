import { describe, it, expect } from "vitest";
import {
  buildDashboardText,
  formatRateLimitTier,
  type DashboardState,
  type DashboardSlot,
} from "../auth-dashboard";

function slot(o: Partial<DashboardSlot> = {}): DashboardSlot {
  return { slot: "default", active: false, health: "healthy", quotaExhaustedUntil: null, fiveHourPct: null, sevenDayPct: null, ...o };
}

/**
 * 2026-04-22 — account-identity surface.
 *
 * Context: Ken tried to reauth lawgpt onto his pixsoul@gmail.com Max
 * 20x account. The OAuth browser flow got hijacked by Telegram's
 * in-app WebView (separate cookie jar from his main browser) and the
 * saved token ended up for his Outlook Max 5x account instead. The
 * dashboard header showed 'Plan: max' \u2014 indistinguishable between
 * 5x and 20x \u2014 so the mismatch was silent until he hit a quota wall
 * hours later.
 *
 * Fix: surface the full `rateLimitTier` string on the dashboard so a
 * wrong-account reauth is IMMEDIATELY visible. Ken expected max_20x,
 * sees max_5x, acts.
 *
 * Pair fixes (out of scope for these tests but covered in the PR):
 * - Auth response now includes a \ud83d\udccb Copy URL button so the user can
 *   paste into their main browser instead of Telegram's WebView.
 * - Auth response text includes a tip about the in-app-browser pitfall.
 */

describe("formatRateLimitTier", () => {
  it("shortens default_claude_max_5x to max_5x", () => {
    expect(formatRateLimitTier("default_claude_max_5x")).toBe("max_5x");
  });

  it("shortens default_claude_max_20x to max_20x", () => {
    expect(formatRateLimitTier("default_claude_max_20x")).toBe("max_20x");
  });

  it("shortens default_claude_pro to pro", () => {
    expect(formatRateLimitTier("default_claude_pro")).toBe("pro");
  });

  it("passes unknown tiers through unchanged", () => {
    // We don't pretend to understand every future tier string. Passthrough
    // means a new Anthropic tier name is visible verbatim until we
    // update the formatter.
    expect(formatRateLimitTier("team_custom_42")).toBe("team_custom_42");
    expect(formatRateLimitTier("enterprise_unlimited")).toBe("enterprise_unlimited");
  });

  it("handles empty/null-ish input gracefully", () => {
    expect(formatRateLimitTier("")).toBe("");
  });
});

describe("dashboard header surfaces rateLimitTier when present", () => {
  const base: DashboardState = {
    agent: "lawgpt",
    bankId: "lawgpt",
    plan: "max",
    slots: [slot({ active: true })],
    quotaHot: false,
  };

  it("shows max_20x when on the bigger plan", () => {
    const text = buildDashboardText({ ...base, rateLimitTier: "default_claude_max_20x" });
    expect(text).toContain("Plan: <b>max_20x</b>");
    // Should NOT just say 'max' \u2014 that's the ambiguous label that
    // hid the account mismatch in the incident.
    expect(text).not.toContain("Plan: <b>max</b>");
  });

  it("shows max_5x when on the smaller plan", () => {
    const text = buildDashboardText({ ...base, rateLimitTier: "default_claude_max_5x" });
    expect(text).toContain("Plan: <b>max_5x</b>");
  });

  it("falls back to plan label when rateLimitTier missing", () => {
    const text = buildDashboardText({ ...base, rateLimitTier: null });
    expect(text).toContain("Plan: <b>max</b>");
  });

  it("falls back to plan label when rateLimitTier undefined", () => {
    const text = buildDashboardText({ ...base });
    expect(text).toContain("Plan: <b>max</b>");
  });

  it("omits Plan: when neither tier nor plan are known", () => {
    const text = buildDashboardText({ ...base, plan: null, rateLimitTier: null });
    expect(text).not.toContain("Plan:");
    expect(text).toContain("Bank: <code>lawgpt</code>");
  });

  it("escapes HTML in tier (injection guard)", () => {
    const text = buildDashboardText({
      ...base,
      rateLimitTier: "<script>alert(1)</script>",
    });
    expect(text).not.toContain("<script>");
    expect(text).toContain("&lt;script&gt;");
  });

  it("pair assertion: user can distinguish 5x from 20x without hunting", () => {
    // Regression anchor: this was the exact confusion in the incident.
    // The user saw 'Plan: max' for both accounts and couldn't tell
    // which got authorized. With the tier string present, 5x and 20x
    // look different in a glance.
    const fivex = buildDashboardText({ ...base, rateLimitTier: "default_claude_max_5x" });
    const twentyx = buildDashboardText({ ...base, rateLimitTier: "default_claude_max_20x" });
    expect(fivex).not.toBe(twentyx);
    expect(fivex).toContain("5x");
    expect(twentyx).toContain("20x");
  });
});
