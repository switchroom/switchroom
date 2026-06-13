/**
 * #2307 Tier-1 — runCronSessionChecks doctor probe. Pins: a cron-session agent
 * with a fresh cron bridge → ok; stale → fail; never-registered (ENOENT) →
 * fail; unreadable (EACCES) → skip; a non-cron agent → no result.
 */
import { describe, it, expect } from "vitest";
import type { SwitchroomConfig } from "../config/schema.js";
import { runCronSessionChecks, type CronSessionProbeDeps } from "./doctor-cron-session.js";

function configWith(agents: SwitchroomConfig["agents"]): SwitchroomConfig {
  return {
    switchroom: { version: 1, agents_dir: "/agents", skills_dir: "/skills" },
    telegram: { bot_token: "x", forum_chat_id: "-1001234567890" },
    vault: { path: "/v.enc" },
    defaults: {},
    agents,
  } as unknown as SwitchroomConfig;
}

// An agent whose schedule routes to a cron session (context: fresh ⟹ Tier 1).
const cronAgent = { topic_name: "C", schedule: [{ cron: "*/10 * * * *", prompt: "p", context: "fresh" }] };
// An agent with only a normal prompt cron → no cron session.
const plainAgent = { topic_name: "P", schedule: [{ cron: "0 9 * * *", prompt: "p" }] };

const NOW = 1_000_000;
function deps(over: Partial<CronSessionProbeDeps>): CronSessionProbeDeps {
  return { now: () => NOW, statMtimeMs: () => NOW, ...over };
}

describe("runCronSessionChecks (#2307 Tier-1)", () => {
  it("fresh cron bridge → ok", () => {
    const r = runCronSessionChecks(configWith({ clerk: cronAgent } as never), deps({ statMtimeMs: () => NOW - 5_000 }));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ name: "cron-session: clerk", status: "ok" });
  });

  it("stale heartbeat → fail (session registered then died)", () => {
    const r = runCronSessionChecks(configWith({ clerk: cronAgent } as never), deps({ statMtimeMs: () => NOW - 120_000 }));
    expect(r[0]).toMatchObject({ name: "cron-session: clerk", status: "fail" });
    expect(r[0].detail).toMatch(/stale/);
  });

  it("never registered (ENOENT) → fail (wedged boot)", () => {
    const r = runCronSessionChecks(
      configWith({ clerk: cronAgent } as never),
      deps({ statMtimeMs: () => { const e = new Error("nope") as NodeJS.ErrnoException; e.code = "ENOENT"; throw e; } }),
    );
    expect(r[0]).toMatchObject({ name: "cron-session: clerk", status: "fail" });
    expect(r[0].detail).toMatch(/not registered/);
    expect(r[0].fix).toMatch(/agent restart/);
  });

  it("unreadable (EACCES from the host operator) → skip, never fail", () => {
    const r = runCronSessionChecks(
      configWith({ clerk: cronAgent } as never),
      deps({ statMtimeMs: () => { const e = new Error("denied") as NodeJS.ErrnoException; e.code = "EACCES"; throw e; } }),
    );
    expect(r[0]).toMatchObject({ name: "cron-session: clerk", status: "skip" });
  });

  it("a non-cron agent produces NO result (the fleet today)", () => {
    const r = runCronSessionChecks(configWith({ plain: plainAgent } as never), deps({}));
    expect(r).toHaveLength(0);
  });

  it("mixed fleet → only the cron agent is checked", () => {
    const r = runCronSessionChecks(
      configWith({ clerk: cronAgent, plain: plainAgent } as never),
      deps({ statMtimeMs: () => NOW - 1_000 }),
    );
    expect(r.map((x) => x.name)).toEqual(["cron-session: clerk"]);
  });
});
