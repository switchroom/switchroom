import { describe, it, expect } from "vitest";
import {
  SIGNAL_MAP,
  ALL_JOB_SPECS,
  dedupKeyFor,
  frequencyFactor,
  recencyFactor,
  reachFactor,
  issuePriority,
} from "./mapping.js";
import type { Finding } from "./detect.js";

describe("signal → job-spec mapping", () => {
  it("maps every L0 signal to a real job spec + taxonomy class", () => {
    for (const [, m] of Object.entries(SIGNAL_MAP)) {
      expect(ALL_JOB_SPECS).toContain(m.job_spec);
      expect(m.severity).toBeGreaterThanOrEqual(1);
      expect(m.severity).toBeLessThanOrEqual(3);
    }
  });

  it("routes the represent-duplicate case to delivery, severity 2", () => {
    const m = SIGNAL_MAP["duplicate-delivery-represent"];
    expect(m.job_spec).toBe("talk-to-agents-from-anywhere");
    expect(m.failure_mode).toBe("duplicate");
    expect(m.severity).toBe(2);
  });

  it("routes a silent no-op to know-what-my-agent-is-doing, severity 3", () => {
    const m = SIGNAL_MAP["silent-no-op-candidate"];
    expect(m.job_spec).toBe("know-what-my-agent-is-doing");
    expect(m.severity).toBe(3);
  });

  it("routes a flush-recovered turn to the same job, informational severity 1", () => {
    const m = SIGNAL_MAP["flush-recovered-turn"];
    expect(m.job_spec).toBe("know-what-my-agent-is-doing");
    expect(m.failure_mode).toBe("drift");
    expect(m.severity).toBe(1);
  });

  it("builds a stable dedup key <job_spec>:<signature>", () => {
    const f: Finding = {
      signal: "duplicate-delivery-represent",
      agent: "clerk",
      turn_id: "x",
      log_pointer: "y",
      ts: null,
    };
    expect(dedupKeyFor(f)).toBe(
      "talk-to-agents-from-anywhere:represent-duplicate-send:reply-tool-not-called",
    );
  });
});

describe("priority score math (severity × frequency × reach × recency)", () => {
  it("frequency uses log10(1+count)", () => {
    expect(frequencyFactor(0)).toBeCloseTo(0);
    expect(frequencyFactor(9)).toBeCloseTo(1);
    expect(frequencyFactor(99)).toBeCloseTo(2);
  });

  it("reach is the distinct-agent count, floored at 1", () => {
    expect(reachFactor(0)).toBe(1);
    expect(reachFactor(2)).toBe(2);
  });

  it("recency: 1.0 within 24h, ~0.1 at window edge, 0 if never", () => {
    const now = new Date("2026-07-03T00:00:00Z");
    expect(recencyFactor(null, now)).toBe(0);
    expect(recencyFactor("2026-07-02T12:00:00Z", now)).toBe(1.0);
    // 30 days old = window edge.
    expect(recencyFactor("2026-06-03T00:00:00Z", now, 30)).toBeCloseTo(0.1, 5);
  });

  it("a rare-but-severe issue can outrank a frequent-but-cosmetic one", () => {
    const now = new Date("2026-07-03T00:00:00Z");
    const fresh = "2026-07-02T23:00:00Z";
    // severe(3), rare(5), 2 agents, fresh
    const severe = issuePriority(3, 5, 2, fresh, now);
    // cosmetic(1), frequent(282), 1 agent, fresh
    const cosmetic = issuePriority(1, 282, 1, fresh, now);
    expect(severe).toBeGreaterThan(cosmetic);
  });

  it("recency decay sinks a fixed issue toward zero as occurrences stop", () => {
    const now = new Date("2026-07-03T00:00:00Z");
    const stale = issuePriority(3, 282, 2, "2026-06-04T00:00:00Z", now, 30);
    const active = issuePriority(3, 282, 2, "2026-07-02T23:00:00Z", now, 30);
    expect(stale).toBeLessThan(active);
  });
});
