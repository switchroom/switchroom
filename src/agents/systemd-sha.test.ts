/**
 * Tests for per-agent SHA env injection in generateUnit (issue #66).
 *
 * generateUnit should bake SWITCHROOM_AGENT_START_SHA into the unit file
 * when COMMIT_SHA is available. getAgentStartSha should parse it back out
 * from `systemctl show --property=Environment` output.
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import { generateUnit } from "./systemd.js";
import { getAgentStartSha, parseAgentStartShaFromSystemctl } from "./lifecycle.js";

// ─── generateUnit SHA injection ──────────────────────────────────────────────

describe("generateUnit: SWITCHROOM_AGENT_START_SHA injection", () => {
  // Reset the module registry between tests so each `vi.doMock` of
  // build-info.js takes effect on the next dynamic import. Earlier the file
  // used query-string cache-busters (./systemd.js?sha-test-foo) which Bun
  // honors at runtime but tsc rejects with TS2307. resetModules + plain
  // dynamic import is the vitest-blessed way and types cleanly.
  beforeEach(() => {
    vi.resetModules();
  });

  it("includes SWITCHROOM_AGENT_START_SHA when COMMIT_SHA is set", async () => {
    vi.doMock("../build-info.js", () => ({
      COMMIT_SHA: "abc1234",
      VERSION: "0.3.0",
      COMMIT_DATE: null,
      LATEST_PR: null,
      COMMITS_AHEAD_OF_TAG: null,
    }));

    const { generateUnit: gen } = await import("./systemd.js");
    const unit = gen("myagent", "/agents/myagent");
    expect(unit).toContain("Environment=SWITCHROOM_AGENT_START_SHA=abc1234");
  });

  it("omits SWITCHROOM_AGENT_START_SHA when COMMIT_SHA is null", async () => {
    vi.doMock("../build-info.js", () => ({
      COMMIT_SHA: null,
      VERSION: "0.3.0",
      COMMIT_DATE: null,
      LATEST_PR: null,
      COMMITS_AHEAD_OF_TAG: null,
    }));

    const { generateUnit: gen } = await import("./systemd.js");
    const unit = gen("myagent", "/agents/myagent");
    expect(unit).not.toContain("SWITCHROOM_AGENT_START_SHA");
  });

  it("includes SHA alongside timezone env when both are set", async () => {
    vi.doMock("../build-info.js", () => ({
      COMMIT_SHA: "def5678",
      VERSION: "0.3.0",
      COMMIT_DATE: null,
      LATEST_PR: null,
      COMMITS_AHEAD_OF_TAG: null,
    }));

    const { generateUnit: gen } = await import("./systemd.js");
    const unit = gen("myagent", "/agents/myagent", false, undefined, "Australia/Brisbane");
    expect(unit).toContain("Environment=SWITCHROOM_AGENT_START_SHA=def5678");
    expect(unit).toContain("Environment=TZ=Australia/Brisbane");
  });
});

// ─── parseAgentStartShaFromSystemctl: parsing ────────────────────────────────

// Test the real exported parser so a regression in lifecycle.ts is caught
// here rather than silently passing because of a stale local copy.
describe("parseAgentStartShaFromSystemctl", () => {
  it("extracts SHA from a single-var Environment line", () => {
    const output = "Environment=SWITCHROOM_AGENT_START_SHA=abc1234";
    expect(parseAgentStartShaFromSystemctl(output)).toBe("abc1234");
  });

  it("extracts SHA when multiple env vars are on the same line", () => {
    const output = "Environment=TZ=UTC SWITCHROOM_AGENT_START_SHA=abc1234 SWITCHROOM_TIMEZONE=UTC";
    expect(parseAgentStartShaFromSystemctl(output)).toBe("abc1234");
  });

  it("extracts SHA when it appears first on the line", () => {
    const output = "Environment=SWITCHROOM_AGENT_START_SHA=ff00112 TZ=UTC";
    expect(parseAgentStartShaFromSystemctl(output)).toBe("ff00112");
  });

  it("returns null when SWITCHROOM_AGENT_START_SHA is absent", () => {
    const output = "Environment=TZ=UTC SWITCHROOM_TIMEZONE=UTC";
    expect(parseAgentStartShaFromSystemctl(output)).toBeNull();
  });

  it("returns null when output is empty", () => {
    expect(parseAgentStartShaFromSystemctl("")).toBeNull();
  });

  it("returns null when no Environment= line is present", () => {
    const output = "ActiveEnterTimestamp=Mon 2026-04-25 10:00:00 UTC\nMainPID=1234";
    expect(parseAgentStartShaFromSystemctl(output)).toBeNull();
  });

  it("handles multi-line output with other properties before Environment=", () => {
    const output = [
      "ActiveEnterTimestamp=Mon 2026-04-25 10:00:00 UTC",
      "MainPID=1234",
      "Environment=TZ=Australia/Brisbane SWITCHROOM_AGENT_START_SHA=deadbeef SWITCHROOM_TIMEZONE=Australia/Brisbane",
      "MemoryCurrent=12345678",
    ].join("\n");
    expect(parseAgentStartShaFromSystemctl(output)).toBe("deadbeef");
  });

  it("does not partially match a different env var name containing SHA", () => {
    const output = "Environment=NOT_SWITCHROOM_AGENT_START_SHA=should-not-match";
    // Our regex requires whitespace OR start-of-string before the key
    expect(parseAgentStartShaFromSystemctl(output)).toBeNull();
  });
});

// ─── getAgentStartSha: fallback when systemctl unavailable ──────────────────

describe("getAgentStartSha: returns null on systemctl failure", () => {
  it("returns null when the service does not exist", () => {
    // Pass a name that definitely won't exist as a systemd unit.
    // On a machine without systemd --user this also throws → null.
    const result = getAgentStartSha("__nonexistent_test_agent_switchroom__");
    expect(result).toBeNull();
  });
});
