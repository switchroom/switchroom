/**
 * #2483 — runTimezoneChecks doctor probe. Pins: warn (not fail) when the
 * resolved zone is UTC purely via server detection; ok when an explicit
 * switchroom.timezone is set; ok when a per-agent override is present;
 * never fails (a legitimately-UTC fleet is valid).
 */
import { describe, it, expect } from "vitest";
import type { SwitchroomConfig } from "../config/schema.js";
import {
  runTimezoneChecks,
  checkTimezone,
  checkZoneinfoIntegrity,
} from "./doctor-timezone.js";
import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    // Row 0 = "timezone configured"; row 1 = "tzdata Etc/UTC integrity".
    expect(r).toHaveLength(2);
    expect(r[1].name).toBe("tzdata Etc/UTC integrity");
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

/**
 * checkZoneinfoIntegrity — the loud detector for the /etc/localtime
 * bind-mount defect (Docker resolves a mount destination through the
 * stock tzdata symlink, so the agent's local zonefile was written over
 * /usr/share/zoneinfo/Etc/UTC).
 *
 * Fixtures are REAL TZif bytes copied from the host's tzdata, not
 * hand-rolled buffers — a synthetic buffer would only prove the parser
 * agrees with itself. The corrupted case is built by literally
 * reproducing the bug: copy a non-UTC zonefile over Etc/UTC in a temp
 * tree, exactly as the daemon did in the container.
 */
describe("checkZoneinfoIntegrity — tzdata Etc/UTC has really been clobbered", () => {
  const HOST_ZONEINFO = "/usr/share/zoneinfo";
  // Etc/GMT is a zero-offset, no-transition zonefile that the compose
  // mount never targets, so it is a trustworthy "pristine UTC" source
  // even on a host that IS currently corrupted.
  const PRISTINE_UTC_SRC = join(HOST_ZONEINFO, "Etc/GMT");
  const NON_UTC_SRC = join(HOST_ZONEINFO, "Australia/Melbourne");

  function fixtureTree(utcSource: string): string | undefined {
    if (!existsSync(utcSource)) return undefined;
    const root = mkdtempSync(join(tmpdir(), "sr-zoneinfo-"));
    mkdirSync(join(root, "Etc"), { recursive: true });
    copyFileSync(utcSource, join(root, "Etc/UTC"));
    return root;
  }

  it("passes when Etc/UTC really is UTC", () => {
    const root = fixtureTree(PRISTINE_UTC_SRC);
    if (!root) return; // exotic host without tzdata
    try {
      const r = checkZoneinfoIntegrity(root);
      expect(r.status).toBe("ok");
      expect(r.detail).toMatch(/UTC\+00:00/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("FAILS when another zone's data has been written over Etc/UTC (the bug)", () => {
    const root = fixtureTree(NON_UTC_SRC);
    if (!root) return;
    try {
      const r = checkZoneinfoIntegrity(root);
      // fail, not warn: this is a silent multi-hour correctness bug and
      // there is no valid config in which Etc/UTC is not UTC.
      expect(r.status).toBe("fail");
      expect(r.detail).toMatch(/is not UTC/);
      expect(r.fix).toMatch(/localtime/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not use Intl — a bundled-ICU check would pass on a corrupted host", () => {
    // Guards the implementation choice, not just the outcome: Node's ICU
    // reports UTC+00:00 for "UTC" even when /usr/share/zoneinfo/Etc/UTC
    // holds Melbourne, so an Intl-based probe is blind to this defect.
    // If the corrupted fixture still fails the check, we are reading the
    // filesystem rather than asking Intl.
    const root = fixtureTree(NON_UTC_SRC);
    if (!root) return;
    try {
      const viaIntl = new Intl.DateTimeFormat("en-US", {
        timeZone: "UTC",
        timeZoneName: "short",
      }).format(new Date(0));
      expect(viaIntl).toMatch(/UTC/); // Intl is happy...
      expect(checkZoneinfoIntegrity(root).status).toBe("fail"); // ...we are not.
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips (never fails) on a host with no tzdata at all", () => {
    const root = mkdtempSync(join(tmpdir(), "sr-zoneinfo-empty-"));
    try {
      const r = checkZoneinfoIntegrity(root);
      expect(r.status).toBe("skip");
      expect(r.status).not.toBe("fail");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips on a non-TZif file rather than guessing", () => {
    const root = mkdtempSync(join(tmpdir(), "sr-zoneinfo-junk-"));
    try {
      mkdirSync(join(root, "Etc"), { recursive: true });
      writeFileSync(join(root, "Etc/UTC"), "not a zonefile");
      expect(checkZoneinfoIntegrity(root).status).toBe("skip");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
