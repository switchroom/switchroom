// Unit tests for the rate-limit (weekly-quota) menu detector in the
// wedge-watchdog. The COMPLIANCE assertion (only ['Escape'] is ever sent —
// never a Down/2/3 that could select "Switch to usage credits" = off-
// subscription) is the load-bearing one (vision.md pillar 3).

import { describe, it, expect } from "vitest";
import {
  runWedgeWatchdog,
  parseWeeklyReset,
  RATE_LIMIT_MENU_SIGNATURE,
  WEDGE_FOOTER_SIGNATURE,
} from "../src/agents/wedge-watchdog.js";

// The REAL wedged pane captured live from finn, 2026-06-07.
const RATE_LIMIT_SCREEN =
  "← switchroom-telegram: Kiosk outage watcher tick. Run\n" +
  "`~/.switchroom/agents/finn/w…\n" +
  "  ⎿  You've hit your weekly limit · resets Jun 9, 5am (Australia/Melbourne)\n" +
  "\n" +
  "✻ Churned for 1s\n" +
  "\n" +
  "❯ /rate-limit-options\n" +
  "\n" +
  "────────────────────────────────────────\n" +
  "  What do you want to do?\n" +
  "\n" +
  "  ❯ 1. Stop and wait for limit to reset\n" +
  "    2. Switch to usage credits\n" +
  "    3. Upgrade your plan\n" +
  "\n" +
  "  Enter to confirm · Esc to cancel";

// The REAL way clerk wedged, 2026-06-07: the SAME menu, but with enough
// preceding output that the `❯ /rate-limit-options` prompt line scrolled OFF
// the top of the `tmux capture-pane -p` viewport (no scrollback). The v0.14.84
// detector anchored on `/rate-limit-options` and so stayed SILENT here (zero
// log fires) while clerk sat dead. This fixture omits that line and uses the
// newer option-2 wording ("Add funds to continue with usage credits"). The
// re-anchored signature (option-1 menu-body row + "usage credits") must match.
const CLERK_RATE_LIMIT_SCREEN =
  "  ⎿  You've hit your weekly limit · resets Jun 9, 5am (Australia/Melbourne)\n" +
  "\n" +
  "────────────────────────────────────────\n" +
  "  What do you want to do?\n" +
  "\n" +
  "  ❯ 1. Stop and wait for limit to reset\n" +
  "    2. Add funds to continue with usage credits\n" +
  "    3. Upgrade your plan\n" +
  "\n" +
  "  Enter to confirm · Esc to cancel";

const NORMAL_SCREEN =
  "⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt\n❯ ";

function captureSeq(screens: string[]) {
  let i = 0;
  return (_a: string) => (i < screens.length ? screens[i++] : screens[screens.length - 1] ?? "");
}
function recordSend() {
  const calls: string[][] = [];
  return { send: (_a: string, keys: string[]) => (calls.push([...keys]), true), calls };
}

describe("RATE_LIMIT_MENU_SIGNATURE", () => {
  it("matches the real finn pane (prompt line present)", () => {
    expect(RATE_LIMIT_MENU_SIGNATURE.test(RATE_LIMIT_SCREEN)).toBe(true);
  });
  it("matches clerk's scroll-off pane: NO /rate-limit-options line + 'Add funds…' wording (the #2218 blind spot)", () => {
    // This is the case the v0.14.84 detector MISSED — the regression guard.
    expect(CLERK_RATE_LIMIT_SCREEN).not.toContain("/rate-limit-options");
    expect(RATE_LIMIT_MENU_SIGNATURE.test(CLERK_RATE_LIMIT_SCREEN)).toBe(true);
  });
  it("does NOT match normal output / a generic modal / empty", () => {
    expect(RATE_LIMIT_MENU_SIGNATURE.test(NORMAL_SCREEN)).toBe(false);
    expect(RATE_LIMIT_MENU_SIGNATURE.test("Which option?\n❯ 1. Yes\n  2. No\nEnter to select · Esc to cancel")).toBe(false);
    expect(RATE_LIMIT_MENU_SIGNATURE.test("")).toBe(false);
    // Needs BOTH anchors — one alone is not enough.
    // anchor B alone (no option-1 menu-body row):
    expect(RATE_LIMIT_MENU_SIGNATURE.test("see /rate-limit-options docs")).toBe(false);
    expect(RATE_LIMIT_MENU_SIGNATURE.test("you could Upgrade your plan someday")).toBe(false);
    expect(RATE_LIMIT_MENU_SIGNATURE.test("we ran low on usage credits last month")).toBe(false);
    // anchor A alone (option-1 row but no usage-credits/upgrade/slash-cmd):
    expect(RATE_LIMIT_MENU_SIGNATURE.test("Stop and wait for the deploy to finish before retrying")).toBe(false);
  });
  it("the GENERIC wedge signature does NOT match this menu (why a dedicated detector is needed)", () => {
    // The footer is 'Enter to confirm · Esc to cancel' — no 'to select/navigate/↑↓'.
    expect(WEDGE_FOOTER_SIGNATURE.test(RATE_LIMIT_SCREEN)).toBe(false);
  });
});

describe("parseWeeklyReset", () => {
  const NOW = Date.UTC(2026, 5, 7, 0, 0, 0); // 2026-06-07
  it("parses 'resets Jun 9, 5am (Australia/Melbourne)' to the correct epoch", () => {
    const epoch = parseWeeklyReset(RATE_LIMIT_SCREEN, NOW);
    expect(epoch).not.toBeNull();
    // Jun 9 2026 05:00 Australia/Melbourne (AEST, UTC+10) = Jun 8 19:00 UTC.
    expect(epoch).toBe(Date.UTC(2026, 5, 8, 19, 0, 0));
  });
  it("handles pm + minutes + bare tz/no-tz", () => {
    expect(parseWeeklyReset("resets Jul 1, 5:30pm (UTC)", NOW)).toBe(Date.UTC(2026, 6, 1, 17, 30, 0));
    expect(parseWeeklyReset("resets Jul 1, 12am (UTC)", NOW)).toBe(Date.UTC(2026, 6, 1, 0, 0, 0));
    expect(parseWeeklyReset("resets Dec 31, 11pm", NOW)).toBe(Date.UTC(2026, 11, 31, 23, 0, 0)); // no tz → UTC
  });
  it("rolls to next year when the M/D already passed", () => {
    const lateNow = Date.UTC(2026, 11, 15); // Dec 15
    const epoch = parseWeeklyReset("resets Jan 2, 9am (UTC)", lateNow);
    expect(epoch).toBe(Date.UTC(2027, 0, 2, 9, 0, 0));
  });
  it("returns null on garbage / unparseable (caller substitutes +7d)", () => {
    expect(parseWeeklyReset("no reset info here", NOW)).toBeNull();
    expect(parseWeeklyReset("resets someday soon", NOW)).toBeNull();
    expect(parseWeeklyReset("resets Foo 9, 5am", NOW)).toBeNull();
  });
});

describe("runWedgeWatchdog — rate-limit branch", () => {
  it("on a stable rate-limit menu: signals failover (with parsed reset) AND parks with Esc", async () => {
    const { send, calls } = recordSend();
    const signals: Array<{ name: string; resetAt: number | null }> = [];
    const res = await runWedgeWatchdog({
      agentName: "finn",
      now: () => Date.UTC(2026, 5, 7, 0, 0, 0),
      sleep: () => {},
      maxPolls: 3,
      capture: captureSeq([RATE_LIMIT_SCREEN]),
      send,
      onRateLimitMenu: (name, resetAt) => signals.push({ name, resetAt }),
    });
    expect(res.rateLimitFires).toBe(1);
    expect(res.fires).toBe(1);
    // Signal fired with the agent + the PARSED weekly reset.
    expect(signals).toHaveLength(1);
    expect(signals[0].name).toBe("finn");
    expect(signals[0].resetAt).toBe(Date.UTC(2026, 5, 8, 19, 0, 0));
    // COMPLIANCE: the ONLY keystroke ever sent is Escape — never Down/2/3.
    expect(calls).toEqual([["Escape"]]);
  });

  it("clerk's scroll-off pane (no /rate-limit-options line) STILL signals failover + Esc-parks", async () => {
    // End-to-end proof that the re-anchor fixes the #2218 blind spot: the exact
    // pane shape that left clerk dead now drives the full watchdog branch.
    const { send, calls } = recordSend();
    const signals: Array<{ name: string; resetAt: number | null }> = [];
    const res = await runWedgeWatchdog({
      agentName: "clerk",
      now: () => Date.UTC(2026, 5, 7, 0, 0, 0),
      sleep: () => {},
      maxPolls: 3,
      capture: captureSeq([CLERK_RATE_LIMIT_SCREEN]),
      send,
      onRateLimitMenu: (name, resetAt) => signals.push({ name, resetAt }),
    });
    expect(res.rateLimitFires).toBe(1);
    expect(signals).toHaveLength(1);
    expect(signals[0].name).toBe("clerk");
    expect(signals[0].resetAt).toBe(Date.UTC(2026, 5, 8, 19, 0, 0));
    // COMPLIANCE preserved on this pane too: Esc only.
    expect(calls).toEqual([["Escape"]]);
  });

  it("does NOT fire before the stability threshold", async () => {
    const { send, calls } = recordSend();
    const signals: unknown[] = [];
    const res = await runWedgeWatchdog({
      agentName: "finn", now: () => 0, sleep: () => {}, maxPolls: 2,
      capture: captureSeq([RATE_LIMIT_SCREEN]), send,
      onRateLimitMenu: () => signals.push(1),
    });
    expect(res.rateLimitFires).toBe(0);
    expect(signals).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it("does NOT fire on normal output (no false positive)", async () => {
    const { send, calls } = recordSend();
    const signals: unknown[] = [];
    const res = await runWedgeWatchdog({
      agentName: "finn", now: () => 0, sleep: () => {}, maxPolls: 5,
      capture: captureSeq([NORMAL_SCREEN]), send,
      onRateLimitMenu: () => signals.push(1),
    });
    expect(res.rateLimitFires).toBe(0);
    expect(signals).toHaveLength(0);
    expect(calls).toEqual([]);
  });

  it("KILL SWITCH: rateLimitSignature=null → no detection, no signal (back to v0.14.83 behaviour)", async () => {
    const { send, calls } = recordSend();
    const signals: unknown[] = [];
    const res = await runWedgeWatchdog({
      agentName: "finn", now: () => 0, sleep: () => {}, maxPolls: 4,
      capture: captureSeq([RATE_LIMIT_SCREEN]), send,
      rateLimitSignature: null,
      onRateLimitMenu: () => signals.push(1),
    });
    expect(res.rateLimitFires).toBe(0);
    expect(signals).toHaveLength(0);
    // And the generic branch must not touch it either (footer lacks 'to select').
    expect(calls).toEqual([]);
  });

  it("COMPLIANCE (exhaustive): over many polls, the rate-limit branch NEVER emits Down/Up/Enter/2/3", async () => {
    const { send, calls } = recordSend();
    await runWedgeWatchdog({
      agentName: "finn", now: () => 0, sleep: () => {}, maxPolls: 20,
      capture: captureSeq([RATE_LIMIT_SCREEN]), send,
      onRateLimitMenu: () => {},
    });
    const banned = ["Down", "Up", "Enter", "2", "3", "Tab"];
    for (const keys of calls) {
      expect(keys).toEqual(["Escape"]);
      for (const k of keys) expect(banned).not.toContain(k);
    }
  });
});
