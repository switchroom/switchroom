/**
 * Regression test for #907 — `collectScheduleEntries` must walk the
 * cascade-resolved agent config so schedule entries declared in
 * `defaults.schedule` or in an `extends:` profile are visible to the
 * in-agent scheduler. Walking the raw `config.agents[name].schedule`
 * skipped them, the agent-scheduler exited with "no schedule entries",
 * the supervisor burned its restart budget, and fires silently stopped.
 */

import { describe, it, expect } from "vitest";
import { collectScheduleEntries } from "./dispatch.js";
import type { SwitchroomConfig } from "../config/schema.js";

describe("collectScheduleEntries — cascade resolution (#907)", () => {
  it("merges defaults.schedule into every agent's resolved entries", () => {
    const config = {
      switchroom: { version: 1 },
      defaults: {
        schedule: [
          { cron: "0 8 * * *", prompt: "morning briefing" },
        ],
      },
      profiles: {},
      agents: {
        klanker: {},
      },
    } as unknown as SwitchroomConfig;

    const entries = collectScheduleEntries(config);
    expect(entries.length).toBe(1);
    expect(entries[0]!.agent).toBe("klanker");
    expect(entries[0]!.cron).toBe("0 8 * * *");
    expect(entries[0]!.prompt).toBe("morning briefing");
  });

  it("preserves agent-level schedule entries when defaults has none", () => {
    const config = {
      switchroom: { version: 1 },
      defaults: {},
      profiles: {},
      agents: {
        klanker: {
          schedule: [{ cron: "*/15 * * * *", prompt: "heartbeat" }],
        },
      },
    } as unknown as SwitchroomConfig;

    const entries = collectScheduleEntries(config);
    expect(entries.length).toBe(1);
    expect(entries[0]!.cron).toBe("*/15 * * * *");
  });

  it("concatenates defaults.schedule before agent.schedule (cascade order)", () => {
    const config = {
      switchroom: { version: 1 },
      defaults: {
        schedule: [{ cron: "0 8 * * *", prompt: "a" }],
      },
      profiles: {},
      agents: {
        klanker: {
          schedule: [{ cron: "0 18 * * *", prompt: "b" }],
        },
      },
    } as unknown as SwitchroomConfig;

    const entries = collectScheduleEntries(config);
    expect(entries.map((e) => e.prompt)).toEqual(["a", "b"]);
  });
});
