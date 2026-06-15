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
  SCHEDULE_MAX_FIRES_PER_CRON,
  SCHEDULE_FRAME_BUDGET_BYTES,
} from "../../src/host-control/server.js";
import type { SchedulerEntry, DispatchResult } from "../../src/scheduler/dispatch.js";

/** The exact bytes the payload contributes to the response frame (JSON,
 *  then re-encoded as the `payload` string field). Mirrors the daemon's
 *  internal `scheduleFrameBytes`. */
function frameBytes(view: unknown): number {
  return Buffer.byteLength(JSON.stringify(JSON.stringify(view)), "utf8");
}

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

  it("keeps only the LAST N fires of a single cron (newest)", () => {
    const many = Array.from({ length: SCHEDULE_MAX_FIRES_PER_CRON + 5 }, (_, i) =>
      fire({ promptKey: "k1", startedAt: i, finishedAt: i + 1, exitCode: i }),
    );
    const { recentByAgent } = boundScheduleView([], { clerk: many });
    expect(recentByAgent.clerk).toHaveLength(SCHEDULE_MAX_FIRES_PER_CRON);
    // The last fire (highest startedAt) survives; the oldest is dropped.
    expect(recentByAgent.clerk.at(-1)!.startedAt).toBe(
      SCHEDULE_MAX_FIRES_PER_CRON + 4,
    );
    expect(recentByAgent.clerk[0].startedAt).toBe(5);
  });

  it("bounds fires PER CRON (promptKey) — a busy cron can't crowd a quiet one out", () => {
    // One agent, two crons: a busy cron (many fires) + a quiet cron (2 fires).
    const busy = Array.from({ length: SCHEDULE_MAX_FIRES_PER_CRON + 10 }, (_, i) =>
      fire({ promptKey: "busy", startedAt: i }),
    );
    const quiet = [fire({ promptKey: "quiet", startedAt: 1000 }), fire({ promptKey: "quiet", startedAt: 1001 })];
    const { recentByAgent } = boundScheduleView([], { clerk: [...busy, ...quiet] });
    const byKey = (k: string) => recentByAgent.clerk.filter((f) => f.promptKey === k);
    // Busy cron capped at N; quiet cron's 2 fires SURVIVE (the old per-agent
    // cap would have dropped them entirely).
    expect(byKey("busy")).toHaveLength(SCHEDULE_MAX_FIRES_PER_CRON);
    expect(byKey("quiet")).toHaveLength(2);
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

  it("projects entries to a render-only slim shape — drops the unbounded poll/action specs", () => {
    const huge = "A".repeat(50_000); // an operator-authored action text with no schema max
    const { entries } = boundScheduleView(
      [
        entry({
          kind: "action",
          model: "sonnet",
          context: "fresh",
          topic: "planning",
          // unbounded specs the wire must NOT carry:
          action: { kind: "webhook", url: "https://x", body: huge } as unknown as SchedulerEntry["action"],
          poll: { huge } as unknown as SchedulerEntry["poll"],
        }),
      ],
      {},
    );
    const e = entries[0] as SchedulerEntry & { action?: unknown; poll?: unknown };
    // Rendered + small routing fields kept…
    expect(e.agent).toBe("clerk");
    expect(e.cron).toBe("*/30 * * * *");
    expect(e.kind).toBe("action");
    expect(e.model).toBe("sonnet");
    expect(e.context).toBe("fresh");
    expect(e.topic).toBe("planning");
    // …unbounded specs dropped.
    expect(e.action).toBeUndefined();
    expect(e.poll).toBeUndefined();
  });

  it("carries the entry's `name` (cron title) through the slim projection", () => {
    const { entries } = boundScheduleView(
      [entry({ name: "school-alerts-linear", prompt: "check portal" })],
      {},
    );
    expect(entries[0].name).toBe("school-alerts-linear");
  });

  it("omits `name` when the entry has none (base-config / hash-only cron)", () => {
    const { entries } = boundScheduleView([entry({ prompt: "untitled" })], {});
    expect(entries[0].name).toBeUndefined();
  });

  it("preserves each fire's promptKey (the cron↔fire match key)", () => {
    const { recentByAgent } = boundScheduleView([], {
      clerk: [
        fire({ promptKey: "cron-a-key", outputSummary: "ok" }),
        fire({ promptKey: "cron-b-key", outputSummary: "ok" }),
      ],
    });
    expect(recentByAgent.clerk.map((f) => f.promptKey)).toEqual([
      "cron-a-key",
      "cron-b-key",
    ]);
  });

  it("preserves promptKey even on a fire whose outputSummary is truncated", () => {
    const long = "y".repeat(SCHEDULE_OUTPUT_SUMMARY_MAX_CHARS + 50);
    const { recentByAgent } = boundScheduleView([], {
      clerk: [fire({ promptKey: "kept-key", outputSummary: long })],
    });
    expect(recentByAgent.clerk[0].promptKey).toBe("kept-key");
    expect(recentByAgent.clerk[0].outputSummary).toHaveLength(
      SCHEDULE_OUTPUT_SUMMARY_MAX_CHARS,
    );
  });

  it("enforces a hard frame budget — a pathological fleet is truncated and fits", () => {
    // Far more entries than any real fleet, each with a max-length prompt.
    const many: SchedulerEntry[] = Array.from({ length: 4000 }, (_, i) =>
      entry({ scheduleIndex: i, prompt: "p".repeat(SCHEDULE_PROMPT_MAX_CHARS) }),
    );
    const fires: Record<string, DispatchResult[]> = {
      clerk: Array.from({ length: 50 }, (_, i) => fire({ startedAt: i, outputSummary: "s".repeat(200) })),
    };
    const view = boundScheduleView(many, fires);
    // The output FITS the frame budget (the whole point)…
    expect(frameBytes(view)).toBeLessThanOrEqual(SCHEDULE_FRAME_BUDGET_BYTES);
    // …it was marked truncated, fires were shed first, and entries trimmed.
    expect(view.truncated).toBe(true);
    expect(view.entries.length).toBeLessThan(many.length);
    expect(view.entries.length).toBeGreaterThan(0);
  });

  it("does NOT mark a normal fleet truncated", () => {
    // A realistic fleet (a few dozen entries, a handful of fires each) is
    // well under budget and untouched.
    const realistic: SchedulerEntry[] = Array.from({ length: 40 }, (_, i) =>
      entry({ scheduleIndex: i, prompt: "morning routine " + i }),
    );
    const fires: Record<string, DispatchResult[]> = {
      clerk: [fire(), fire()],
      marko: [fire({ agent: "marko" })],
    };
    const view = boundScheduleView(realistic, fires);
    expect(view.truncated).toBeUndefined();
    expect(view.entries).toHaveLength(40);
    expect(view.recentByAgent.clerk).toHaveLength(2);
  });
});
