/**
 * Cascade-resolution regression tests for `collectScheduleEntries`.
 *
 * The original implementation walked raw `config.agents[name].schedule`
 * and silently dropped entries declared in `defaults.schedule` or in a
 * profile's extends-chain. After Phase 4 (#893) deleted the singleton
 * scheduler, that meant cron silently died for every agent whose
 * schedule lived above the agent block in the cascade. These tests
 * pin the cascade-aware behaviour so the regression can't return.
 */

import { describe, it, expect } from "vitest";
import { collectScheduleEntries } from "./dispatch.js";
import { OVERLAY_TITLE } from "../config/overlay-loader.js";
import type { SwitchroomConfig } from "../config/schema.js";

function configFromAgents(
  agents: Record<string, Record<string, unknown>>,
  extras: Partial<SwitchroomConfig> = {},
): SwitchroomConfig {
  return {
    switchroom: {
      version: 1,
      agents_dir: "/tmp/agents",
      skills_dir: "/tmp/skills",
    },
    telegram: { bot_token: "x", forum_chat_id: "-1001234567890" },
    vault: { path: "/tmp/vault.enc" },
    agents: agents as SwitchroomConfig["agents"],
    ...extras,
  } as SwitchroomConfig;
}

describe("collectScheduleEntries — cascade resolution", () => {
  it("collects an agent-only schedule (baseline)", () => {
    const cfg = configFromAgents({
      alice: {
        schedule: [
          { cron: "0 8 * * *", prompt: "morning briefing" },
        ],
      },
    });
    const entries = collectScheduleEntries(cfg);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      agent: "alice",
      scheduleIndex: 0,
      cron: "0 8 * * *",
      prompt: "morning briefing",
    });
  });

  it("collects schedule entries declared in defaults — the original silent-drop bug", () => {
    const cfg = configFromAgents(
      { alice: {} },
      {
        defaults: {
          schedule: [
            { cron: "0 9 * * *", prompt: "from defaults" },
          ],
        } as SwitchroomConfig["defaults"],
      },
    );
    const entries = collectScheduleEntries(cfg);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.prompt).toBe("from defaults");
    expect(entries[0]?.agent).toBe("alice");
  });

  it("collects schedule entries from a profile via extends:", () => {
    const cfg = configFromAgents(
      { alice: { extends: "ops" } },
      {
        profiles: {
          ops: {
            schedule: [
              { cron: "*/5 * * * *", prompt: "from profile" },
            ],
          },
        } as unknown as SwitchroomConfig["profiles"],
      },
    );
    const entries = collectScheduleEntries(cfg);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.prompt).toBe("from profile");
  });

  it("concatenates defaults + profile + agent schedule entries in declared order", () => {
    const cfg = configFromAgents(
      {
        alice: {
          extends: "ops",
          schedule: [{ cron: "0 17 * * *", prompt: "agent" }],
        },
      },
      {
        defaults: {
          schedule: [{ cron: "0 8 * * *", prompt: "defaults" }],
        } as SwitchroomConfig["defaults"],
        profiles: {
          ops: {
            schedule: [{ cron: "0 12 * * *", prompt: "profile" }],
          },
        } as unknown as SwitchroomConfig["profiles"],
      },
    );
    const entries = collectScheduleEntries(cfg);
    expect(entries.map((e) => e.prompt)).toEqual([
      "defaults",
      "profile",
      "agent",
    ]);
    // Index must be sequential 0..N across the merged list — replay
    // semantics index off this number, so a re-ordering would change
    // which audit row matches which entry.
    expect(entries.map((e) => e.scheduleIndex)).toEqual([0, 1, 2]);
  });

  it("propagates a kind:action entry (no prompt) with its action spec + a stable key", () => {
    const cfg = configFromAgents({
      alice: {
        schedule: [
          {
            cron: "0 9 * * *",
            kind: "action",
            action: { type: "telegram-message", text: "Daily heartbeat {{date}}" },
          },
        ],
      },
    });
    const entries = collectScheduleEntries(cfg);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      agent: "alice",
      kind: "action",
      action: { type: "telegram-message", text: "Daily heartbeat {{date}}" },
    });
    // No prompt on an action; the audit key is still present + non-empty.
    expect(entries[0]?.prompt).toBeUndefined();
    expect(entries[0]?.promptKey).toMatch(/^[0-9a-f]{12}$/);
  });

  it("surfaces an OVERLAY_TITLE-stamped raw entry as SchedulerEntry.name", () => {
    const cfg = configFromAgents({
      alice: {
        schedule: [
          // Mirror what the overlay loader stamps: a non-enumerable
          // OVERLAY_TITLE symbol on the raw entry object.
          (() => {
            const e: Record<string | symbol, unknown> = {
              cron: "0 7 * * *",
              prompt: "morning briefing",
            };
            Object.defineProperty(e, OVERLAY_TITLE, {
              value: "school-alerts-linear",
              enumerable: false,
              configurable: false,
              writable: false,
            });
            return e;
          })(),
        ],
      },
    });
    const entries = collectScheduleEntries(cfg);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBe("school-alerts-linear");
  });

  it("leaves SchedulerEntry.name undefined for an un-stamped (base-config) entry", () => {
    const cfg = configFromAgents({
      alice: { schedule: [{ cron: "0 8 * * *", prompt: "no title" }] },
    });
    const entries = collectScheduleEntries(cfg);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.name).toBeUndefined();
  });

  it("empty defaults + empty profile + empty agent yields no entries (no false positives)", () => {
    const cfg = configFromAgents(
      { alice: { extends: "ops" } },
      {
        defaults: {} as SwitchroomConfig["defaults"],
        profiles: { ops: {} } as unknown as SwitchroomConfig["profiles"],
      },
    );
    expect(collectScheduleEntries(cfg)).toEqual([]);
  });
});
