/**
 * Unit tests for the pure `boundScheduleView` helper — the frame-bounding
 * shaper for the hostd `agent_schedule` payload. Truncates entry prompts
 * + fire outputSummaries and keeps only the last N fires per agent so the
 * structured payload can't blow the 64 KiB NDJSON frame.
 */

import { describe, it, expect } from "vitest";
import {
  boundScheduleView,
  SCHEDULE_PROMPT_MAX_CHARS,
  SCHEDULE_OUTPUT_SUMMARY_MAX_CHARS,
  SCHEDULE_MAX_FIRES_PER_AGENT,
} from "../../src/host-control/server.js";
import type { SchedulerEntry, DispatchResult } from "../../src/scheduler/dispatch.js";

function entry(over: Partial<SchedulerEntry> = {}): SchedulerEntry {
  return {
    agent: "clerk",
    scheduleIndex: 0,
    cron: "*/30 * * * *",
    promptKey: "abc123",
    ...over,
  };
}

function fire(over: Partial<DispatchResult> = {}): DispatchResult {
  return {
    agent: "clerk",
    scheduleIndex: 0,
    promptKey: "abc123",
    exitCode: 0,
    outputSummary: "delivered to bridge via gateway",
    startedAt: 1,
    finishedAt: 2,
    ...over,
  };
}

describe("boundScheduleView", () => {
  it("truncates an entry's prompt to the cap", () => {
    const long = "x".repeat(SCHEDULE_PROMPT_MAX_CHARS + 200);
    const { entries } = boundScheduleView([entry({ prompt: long })], {});
    expect(entries[0].prompt).toHaveLength(SCHEDULE_PROMPT_MAX_CHARS);
    expect(entries[0].prompt).toBe("x".repeat(SCHEDULE_PROMPT_MAX_CHARS));
  });

  it("leaves a short prompt untouched", () => {
    const short = "morning standup";
    const { entries } = boundScheduleView([entry({ prompt: short })], {});
    expect(entries[0].prompt).toBe(short);
  });

  it("handles an entry with no prompt (kind=action)", () => {
    const { entries } = boundScheduleView([entry({ prompt: undefined })], {});
    expect(entries[0].prompt).toBeUndefined();
  });

  it("truncates each fire's outputSummary to the cap", () => {
    const long = "y".repeat(SCHEDULE_OUTPUT_SUMMARY_MAX_CHARS + 50);
    const { recentByAgent } = boundScheduleView([], {
      clerk: [fire({ outputSummary: long })],
    });
    expect(recentByAgent.clerk[0].outputSummary).toHaveLength(
      SCHEDULE_OUTPUT_SUMMARY_MAX_CHARS,
    );
  });

  it("keeps only the LAST N fires per agent (newest)", () => {
    const many = Array.from({ length: SCHEDULE_MAX_FIRES_PER_AGENT + 5 }, (_, i) =>
      fire({ startedAt: i, finishedAt: i + 1, exitCode: i }),
    );
    const { recentByAgent } = boundScheduleView([], { clerk: many });
    expect(recentByAgent.clerk).toHaveLength(SCHEDULE_MAX_FIRES_PER_AGENT);
    // The last fire (highest startedAt) survives; the oldest is dropped.
    expect(recentByAgent.clerk.at(-1)!.startedAt).toBe(
      SCHEDULE_MAX_FIRES_PER_AGENT + 4,
    );
    expect(recentByAgent.clerk[0].startedAt).toBe(5);
  });

  it("does not mutate the input objects (purity)", () => {
    const long = "z".repeat(SCHEDULE_PROMPT_MAX_CHARS + 10);
    const input = entry({ prompt: long });
    const inputFire = fire({ outputSummary: "w".repeat(SCHEDULE_OUTPUT_SUMMARY_MAX_CHARS + 10) });
    boundScheduleView([input], { clerk: [inputFire] });
    // Originals unchanged.
    expect(input.prompt).toHaveLength(SCHEDULE_PROMPT_MAX_CHARS + 10);
    expect(inputFire.outputSummary).toHaveLength(SCHEDULE_OUTPUT_SUMMARY_MAX_CHARS + 10);
  });

  it("passes through multiple agents independently", () => {
    const { recentByAgent } = boundScheduleView([], {
      clerk: [fire({ agent: "clerk" })],
      marko: [fire({ agent: "marko" }), fire({ agent: "marko" })],
    });
    expect(recentByAgent.clerk).toHaveLength(1);
    expect(recentByAgent.marko).toHaveLength(2);
  });
});
