/**
 * #2483 — runTimezoneChecks doctor probe. Pins: warn (not fail) when the
 * resolved zone is UTC purely via server detection; ok when an explicit
 * switchroom.timezone is set; ok when a per-agent override is present;
 * never fails (a legitimately-UTC fleet is valid).
 */
import { describe, it, expect } from "vitest";
import type { SwitchroomConfig } from "../config/schema.js";
import { runTimezoneChecks, checkTimezone } from "./doctor-timezone.js";

// Force server detection to resolve to UTC, deterministically, regardless of
// the CI host's /etc — both probes report "nothing found" so the resolver's
// final fallback ("UTC") fires.
const FORCE_UTC = {
  readEtcTimezone: () => undefined,
  readLocaltimeLink: () => undefined,
};
// Force a real detected zone via the /etc/timezone probe.
const FORCE_MELBOURNE = {
  readEtcTimezone: () => "Australia/Melbourne",
  readLocaltimeLink: () => undefined,
};

function configWith(
  over: Partial<SwitchroomConfig>,
): SwitchroomConfig {
  return {
    switchroom: { version: 1, agents_dir: "/agents", skills_dir: "/skills" },
    telegram: { bot_token: "x", forum_chat_id: "-1001234567890" },
    vault: { path: "/v.enc" },
    defaults: {},
    agents: { assistant: { topic_name: "A" } },
    ...over,
  } as unknown as SwitchroomConfig;
}

describe("runTimezoneChecks (#2483)", () => {
  it("warns (not fails) when no zone is set anywhere and detection lands on UTC", () => {
    const cfg = configWith({});
    const r = runTimezoneChecks(cfg, FORCE_UTC);
    expect(r).toHaveLength(1);
    expect(r[0].status).toBe("warn");
    expect(r[0].name).toBe("timezone configured");
    expect(r[0].detail).toMatch(/UTC/);
    expect(r[0].fix).toMatch(/switchroom\.timezone/);
  });

  it("stays ok when detection finds a real zone (no explicit value, non-UTC host)", () => {
    const cfg = configWith({});
    const r = checkTimezone(cfg, FORCE_MELBOURNE);
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("Australia/Melbourne");
  });

  it("ok with detail when an explicit switchroom.timezone is set, even on a UTC host", () => {
    const cfg = configWith({
      switchroom: {
        version: 1,
        agents_dir: "/agents",
        skills_dir: "/skills",
        timezone: "Australia/Melbourne",
      } as never,
    });
    const r = checkTimezone(cfg, FORCE_UTC);
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("Australia/Melbourne");
  });

  it("ok when a per-agent timezone override is present (source !== detected)", () => {
    const cfg = configWith({
      agents: {
        assistant: { topic_name: "A", timezone: "Asia/Tokyo" } as never,
      },
    });
    const r = checkTimezone(cfg, FORCE_UTC);
    expect(r.status).toBe("ok");
  });

  it("no-agents bootstrap: warns on detected-UTC, never fails", () => {
    const cfg = configWith({ agents: {} as never });
    const r = checkTimezone(cfg, FORCE_UTC);
    expect(r.status).toBe("warn");
    expect(r.status).not.toBe("fail");
  });

  it("no-agents bootstrap: global explicit zone produces an ok row even on a UTC host", () => {
    const cfg = configWith({
      switchroom: {
        version: 1,
        agents_dir: "/agents",
        skills_dir: "/skills",
        timezone: "Europe/London",
      } as never,
      agents: {} as never,
    });
    const r = checkTimezone(cfg, FORCE_UTC);
    expect(r.status).toBe("ok");
    expect(r.detail).toContain("Europe/London");
  });
});
