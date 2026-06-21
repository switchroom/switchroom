import { describe, it, expect } from "vitest";
import {
  detectServerTimezone,
  extractZoneFromLocaltimeLink,
  resolveTimezone,
  classifyTimezoneSource,
} from "../src/config/timezone.js";
import { SwitchroomConfigSchema, type AgentConfig, type SwitchroomConfig } from "../src/config/schema.js";

function makeConfig(overrides: Partial<SwitchroomConfig["switchroom"]> = {}, extras: Partial<SwitchroomConfig> = {}): SwitchroomConfig {
  return {
    switchroom: {
      version: 1,
      agents_dir: "~/.switchroom/agents",
      skills_dir: "~/.switchroom/skills",
      ...overrides,
    },
    telegram: {
      bot_token: "test",
      forum_chat_id: "-100",
    },
    agents: {},
    ...extras,
  } as unknown as SwitchroomConfig;
}

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    topic_name: "Test",
    schedule: [],
    ...overrides,
  } as AgentConfig;
}

describe("extractZoneFromLocaltimeLink", () => {
  it("extracts two-segment zones", () => {
    expect(extractZoneFromLocaltimeLink("/usr/share/zoneinfo/Australia/Melbourne"))
      .toBe("Australia/Melbourne");
  });

  it("extracts three-segment zones", () => {
    expect(
      extractZoneFromLocaltimeLink("/usr/share/zoneinfo/America/Argentina/Buenos_Aires"),
    ).toBe("America/Argentina/Buenos_Aires");
  });

  it("handles relative symlink targets", () => {
    expect(extractZoneFromLocaltimeLink("../usr/share/zoneinfo/Europe/Berlin"))
      .toBe("Europe/Berlin");
  });

  it("returns undefined when zoneinfo marker is missing", () => {
    expect(extractZoneFromLocaltimeLink("/etc/localtime.bak")).toBeUndefined();
  });

  it("returns undefined for an empty tail after zoneinfo/", () => {
    expect(extractZoneFromLocaltimeLink("/usr/share/zoneinfo/")).toBeUndefined();
  });
});

describe("detectServerTimezone", () => {
  it("prefers /etc/timezone when present", () => {
    const tz = detectServerTimezone({
      readEtcTimezone: () => "Australia/Melbourne",
      readLocaltimeLink: () => "/usr/share/zoneinfo/UTC",
    });
    expect(tz).toBe("Australia/Melbourne");
  });

  it("falls back to /etc/localtime symlink when /etc/timezone is missing", () => {
    const tz = detectServerTimezone({
      readEtcTimezone: () => undefined,
      readLocaltimeLink: () => "/usr/share/zoneinfo/America/New_York",
    });
    expect(tz).toBe("America/New_York");
  });

  it("ignores empty /etc/timezone and falls through to the link", () => {
    const tz = detectServerTimezone({
      readEtcTimezone: () => undefined, // simulates empty-then-trimmed
      readLocaltimeLink: () => "/usr/share/zoneinfo/Europe/London",
    });
    expect(tz).toBe("Europe/London");
  });

  it("returns undefined when both probes fail (no signal)", () => {
    const tz = detectServerTimezone({
      readEtcTimezone: () => undefined,
      readLocaltimeLink: () => undefined,
    });
    expect(tz).toBeUndefined();
  });

  it("returns undefined when the localtime link has no zoneinfo marker", () => {
    const tz = detectServerTimezone({
      readEtcTimezone: () => undefined,
      readLocaltimeLink: () => "/var/random/localtime",
    });
    expect(tz).toBeUndefined();
  });

  it("honors SWITCHROOM_HOST_TZ over everything else", () => {
    const tz = detectServerTimezone({
      env: { SWITCHROOM_HOST_TZ: "Australia/Melbourne" },
      readEtcTimezone: () => "America/New_York",
      readLocaltimeLink: () => "/usr/share/zoneinfo/Europe/Berlin",
    });
    expect(tz).toBe("Australia/Melbourne");
  });

  it("returns undefined (not UTC) when /etc/localtime → container-default Etc/UTC with no /etc/timezone", () => {
    // This is the in-container scenario: the base image ships with
    // /etc/localtime → Etc/UTC and no /etc/timezone. Without SWITCHROOM_HOST_TZ
    // we must NOT silently accept UTC — return undefined so the caller can warn.
    const tz = detectServerTimezone({
      env: {},
      readEtcTimezone: () => undefined,
      readLocaltimeLink: () => "/usr/share/zoneinfo/Etc/UTC",
    });
    expect(tz).toBeUndefined();
  });

  it("returns undefined for other bare container-default UTC aliases", () => {
    for (const alias of ["UTC", "Etc/Universal", "Universal"]) {
      const tz = detectServerTimezone({
        env: {},
        readEtcTimezone: () => undefined,
        readLocaltimeLink: () => `/usr/share/zoneinfo/${alias}`,
      });
      expect(tz).toBeUndefined();
    }
  });

  it("accepts a real non-UTC zone from /etc/localtime even without /etc/timezone", () => {
    const tz = detectServerTimezone({
      env: {},
      readEtcTimezone: () => undefined,
      readLocaltimeLink: () => "/usr/share/zoneinfo/Australia/Melbourne",
    });
    expect(tz).toBe("Australia/Melbourne");
  });
});

describe("resolveTimezone", () => {
  const probeNoSignal = {
    env: {} as NodeJS.ProcessEnv,
    readEtcTimezone: () => undefined,
    readLocaltimeLink: () => undefined,
  };

  it("returns the agent-level timezone when set", () => {
    const tz = resolveTimezone(
      makeConfig({ timezone: "America/New_York" }),
      makeAgent({ timezone: "Australia/Melbourne" }),
      probeNoSignal,
    );
    expect(tz).toBe("Australia/Melbourne");
  });

  it("falls back to switchroom.timezone when the agent is unset", () => {
    const tz = resolveTimezone(
      makeConfig({ timezone: "Europe/Paris" }),
      makeAgent(),
      probeNoSignal,
    );
    expect(tz).toBe("Europe/Paris");
  });

  it("falls back to server detection when neither layer is set", () => {
    const tz = resolveTimezone(makeConfig(), makeAgent(), {
      env: {},
      readEtcTimezone: () => "Asia/Tokyo",
      readLocaltimeLink: () => undefined,
    });
    expect(tz).toBe("Asia/Tokyo");
  });

  it("returns UTC as the last resort when no signal is found, and calls onUtcFallback", () => {
    let warned = false;
    const tz = resolveTimezone(makeConfig(), makeAgent(), {
      ...probeNoSignal,
      onUtcFallback: () => { warned = true; },
    });
    expect(tz).toBe("UTC");
    expect(warned).toBe(true);
  });

  it("does NOT call onUtcFallback when a real zone is detected", () => {
    let warned = false;
    const tz = resolveTimezone(makeConfig(), makeAgent(), {
      env: {},
      readEtcTimezone: () => "Australia/Melbourne",
      readLocaltimeLink: () => undefined,
      onUtcFallback: () => { warned = true; },
    });
    expect(tz).toBe("Australia/Melbourne");
    expect(warned).toBe(false);
  });

  it("does NOT call onUtcFallback when timezone is set in yaml", () => {
    let warned = false;
    const tz = resolveTimezone(
      makeConfig({ timezone: "Europe/Paris" }),
      makeAgent(),
      { ...probeNoSignal, onUtcFallback: () => { warned = true; } },
    );
    expect(tz).toBe("Europe/Paris");
    expect(warned).toBe(false);
  });

  it("uses SWITCHROOM_HOST_TZ when all other signals are missing", () => {
    const tz = resolveTimezone(makeConfig(), makeAgent(), {
      env: { SWITCHROOM_HOST_TZ: "Australia/Melbourne" },
      readEtcTimezone: () => undefined,
      readLocaltimeLink: () => undefined,
    });
    expect(tz).toBe("Australia/Melbourne");
  });

  it("explicit yaml timezone wins over SWITCHROOM_HOST_TZ", () => {
    const tz = resolveTimezone(
      makeConfig({ timezone: "Europe/Berlin" }),
      makeAgent(),
      {
        env: { SWITCHROOM_HOST_TZ: "Australia/Melbourne" },
        readEtcTimezone: () => undefined,
        readLocaltimeLink: () => undefined,
      },
    );
    expect(tz).toBe("Europe/Berlin");
  });

  it("agent-level value wins over every other layer", () => {
    const tz = resolveTimezone(
      makeConfig({ timezone: "Europe/Berlin" }),
      makeAgent({ timezone: "Pacific/Auckland" }),
      {
        env: { SWITCHROOM_HOST_TZ: "America/Los_Angeles" },
        readEtcTimezone: () => "America/Chicago",
        readLocaltimeLink: () => "/usr/share/zoneinfo/Asia/Dubai",
      },
    );
    expect(tz).toBe("Pacific/Auckland");
  });

  it("in-container scenario: Etc/UTC localtime + no /etc/timezone → UTC fallback with warning", () => {
    // Simulates the hostd container environment before SWITCHROOM_HOST_TZ lands.
    let warned = false;
    const tz = resolveTimezone(makeConfig(), makeAgent(), {
      env: {},
      readEtcTimezone: () => undefined,
      readLocaltimeLink: () => "/usr/share/zoneinfo/Etc/UTC",
      onUtcFallback: () => { warned = true; },
    });
    expect(tz).toBe("UTC");
    expect(warned).toBe(true);
  });

  it("in-container scenario: SWITCHROOM_HOST_TZ set → correct zone, no warning", () => {
    // Simulates the fixed hostd container where SWITCHROOM_HOST_TZ is baked in.
    let warned = false;
    const tz = resolveTimezone(makeConfig(), makeAgent(), {
      env: { SWITCHROOM_HOST_TZ: "Australia/Melbourne" },
      readEtcTimezone: () => undefined,
      readLocaltimeLink: () => "/usr/share/zoneinfo/Etc/UTC",
      onUtcFallback: () => { warned = true; },
    });
    expect(tz).toBe("Australia/Melbourne");
    expect(warned).toBe(false);
  });
});

describe("classifyTimezoneSource", () => {
  it("reports 'agent' when the resolved agent carries a timezone", () => {
    expect(
      classifyTimezoneSource(
        makeConfig({ timezone: "Europe/Paris" }),
        makeAgent({ timezone: "Australia/Melbourne" }),
      ),
    ).toBe("agent");
  });

  it("reports 'global' when only switchroom.timezone is set", () => {
    expect(
      classifyTimezoneSource(
        makeConfig({ timezone: "Europe/Paris" }),
        makeAgent(),
      ),
    ).toBe("global");
  });

  it("reports 'detected' when neither layer is set", () => {
    expect(classifyTimezoneSource(makeConfig(), makeAgent())).toBe("detected");
  });
});

describe("schema validation — timezone", () => {
  function baseConfig(overrides: Record<string, unknown> = {}) {
    return {
      switchroom: { version: 1 },
      telegram: {
        bot_token: "test",
        forum_chat_id: "-100",
      },
      agents: {
        "test-agent": {
          topic_name: "Test",
          ...overrides,
        },
      },
    };
  }

  it("accepts canonical Region/City IANA zones on agent-level", () => {
    const result = SwitchroomConfigSchema.safeParse(
      baseConfig({ timezone: "Australia/Melbourne" }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts the bare string UTC", () => {
    const result = SwitchroomConfigSchema.safeParse(
      baseConfig({ timezone: "UTC" }),
    );
    expect(result.success).toBe(true);
  });

  it("accepts three-segment IANA zones", () => {
    const result = SwitchroomConfigSchema.safeParse(
      baseConfig({ timezone: "America/Argentina/Buenos_Aires" }),
    );
    expect(result.success).toBe(true);
  });

  it("rejects three-letter aliases like EST", () => {
    const result = SwitchroomConfigSchema.safeParse(
      baseConfig({ timezone: "EST" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects three-letter aliases like PST", () => {
    const result = SwitchroomConfigSchema.safeParse(
      baseConfig({ timezone: "PST" }),
    );
    expect(result.success).toBe(false);
  });

  it("rejects bare-offset timezones like UTC+10", () => {
    const result = SwitchroomConfigSchema.safeParse(
      baseConfig({ timezone: "UTC+10" }),
    );
    expect(result.success).toBe(false);
  });

  it("accepts top-level switchroom.timezone", () => {
    const result = SwitchroomConfigSchema.safeParse({
      switchroom: { version: 1, timezone: "Australia/Melbourne" },
      telegram: { bot_token: "t", forum_chat_id: "-1" },
      agents: {
        a: { topic_name: "A" },
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a top-level switchroom.timezone that is a three-letter alias", () => {
    const result = SwitchroomConfigSchema.safeParse({
      switchroom: { version: 1, timezone: "EST" },
      telegram: { bot_token: "t", forum_chat_id: "-1" },
      agents: {
        a: { topic_name: "A" },
      },
    });
    expect(result.success).toBe(false);
  });

  it("allows omitting timezone entirely (cascade handles fallback)", () => {
    const result = SwitchroomConfigSchema.safeParse(baseConfig({}));
    expect(result.success).toBe(true);
  });

  // Regression coverage for PR #44 review blocker: the original regex used
  // the inner class [A-Za-z_] which silently rejected real IANA zones
  // containing + or -. Each of the names below appears in the public IANA
  // tzdata and must round-trip through schema validation.
  it.each([
    "Etc/GMT+1",
    "Etc/GMT-10",
    "America/Port-au-Prince",
    "America/Argentina/Buenos_Aires",
    "America/Argentina/ComodRivadavia",
    "America/Indiana/Indianapolis",
    "Antarctica/DumontDUrville",
    "Pacific/Chatham",
    "Australia/Melbourne",
    "America/New_York",
  ])("accepts IANA zone %s", (zone) => {
    const result = SwitchroomConfigSchema.safeParse(
      baseConfig({ timezone: zone }),
    );
    expect(result.success).toBe(true);
  });

  // Explicit reject set: inputs that look plausible but are either bare
  // aliases, bare offsets, lowercase, or outright garbage.
  it.each([
    "EST",
    "PST",
    "MST",
    "CST",
    "UTC+10",
    "+10:00",
    "-05:00",
    "lowercase/thing",
    "europe/london",
    "",
    "Only_One_Segment",
  ])("rejects non-IANA input %s", (zone) => {
    const result = SwitchroomConfigSchema.safeParse(
      baseConfig({ timezone: zone }),
    );
    expect(result.success).toBe(false);
  });
});
