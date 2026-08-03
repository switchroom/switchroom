/**
 * #4244 — runBootBriefingChecks doctor probe. Pins: a fully-wired
 * `briefing: gateway` agent → ok; each dead prerequisite (telegram off, official
 * plugin, non-docker runtime, history disabled) → warn with that reason;
 * multiple dead reasons collapse into one warn row listing all; a `legacy`
 * (or unset) agent produces no result. WARN never FAILs (exit-code contract).
 */
import { describe, it, expect } from "vitest";
import type { SwitchroomConfig } from "../config/schema.js";
import {
  runBootBriefingChecks,
  historyExplicitlyDisabled,
  type BootBriefingProbeDeps,
} from "./doctor-boot-briefing.js";

function configWith(agents: SwitchroomConfig["agents"]): SwitchroomConfig {
  return {
    switchroom: { version: 1, agents_dir: "/agents", skills_dir: "/skills" },
    telegram: { bot_token: "x", forum_chat_id: "-1001234567890" },
    vault: { path: "/v.enc" },
    defaults: {},
    agents,
  } as unknown as SwitchroomConfig;
}

// Fully-wired gateway-briefing agent (docker + switchroom plugin + history on).
const wired = {
  topic_name: "W",
  session_continuity: { briefing: "gateway" },
  channels: { telegram: { enabled: true, plugin: "switchroom" } },
};

// history.db unavailable ⟹ nothing to read; default deps never touches the fs
// for the wired/off/official/non-docker cases because agentsDir + a present
// access.json only matter to the history branch.
function deps(over: Partial<BootBriefingProbeDeps>): BootBriefingProbeDeps {
  return {
    isDocker: () => true,
    readAccess: () => {
      const e = new Error("nope") as NodeJS.ErrnoException;
      e.code = "ENOENT";
      throw e;
    },
    agentsDir: "/agents",
    ...over,
  };
}

describe("runBootBriefingChecks (#4244)", () => {
  it("fully-wired briefing:gateway → ok", () => {
    const r = runBootBriefingChecks(configWith({ clerk: wired } as never), deps({}));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ name: "boot-briefing: clerk", status: "ok" });
  });

  it("telegram disabled → warn naming that reason", () => {
    const agent = { ...wired, channels: { telegram: { enabled: false, plugin: "switchroom" } } };
    const r = runBootBriefingChecks(configWith({ clerk: agent } as never), deps({}));
    expect(r[0]).toMatchObject({ name: "boot-briefing: clerk", status: "warn" });
    expect(r[0].detail).toMatch(/telegram\.enabled: false/);
    expect(r[0].fix).toMatch(/legacy/);
  });

  it("official plugin → warn (no gateway/history in the upstream plugin)", () => {
    const agent = { ...wired, channels: { telegram: { enabled: true, plugin: "official" } } };
    const r = runBootBriefingChecks(configWith({ clerk: agent } as never), deps({}));
    expect(r[0]).toMatchObject({ status: "warn" });
    expect(r[0].detail).toMatch(/plugin: official/);
  });

  it("non-docker runtime → warn (env never threaded to a systemd gateway unit)", () => {
    const r = runBootBriefingChecks(
      configWith({ clerk: wired } as never),
      deps({ isDocker: () => false }),
    );
    expect(r[0]).toMatchObject({ status: "warn" });
    expect(r[0].detail).toMatch(/not docker/);
  });

  it("historyEnabled:false in access.json → warn", () => {
    const r = runBootBriefingChecks(
      configWith({ clerk: wired } as never),
      deps({ readAccess: () => JSON.stringify({ historyEnabled: false }) }),
    );
    expect(r[0]).toMatchObject({ status: "warn" });
    expect(r[0].detail).toMatch(/historyEnabled: false/);
  });

  it("multiple dead reasons collapse into ONE warn row listing all", () => {
    const agent = { ...wired, channels: { telegram: { enabled: false, plugin: "official" } } };
    const r = runBootBriefingChecks(
      configWith({ clerk: agent } as never),
      deps({ isDocker: () => false, readAccess: () => JSON.stringify({ historyEnabled: false }) }),
    );
    expect(r).toHaveLength(1);
    expect(r[0].status).toBe("warn");
    expect(r[0].detail).toMatch(/telegram\.enabled: false/);
    expect(r[0].detail).toMatch(/plugin: official/);
    expect(r[0].detail).toMatch(/not docker/);
    expect(r[0].detail).toMatch(/historyEnabled: false/);
  });

  it("legacy (default) briefing produces NO result — the flag has no prerequisites", () => {
    const legacyAgent = { topic_name: "L", channels: { telegram: { enabled: true, plugin: "switchroom" } } };
    const r = runBootBriefingChecks(configWith({ clerk: legacyAgent } as never), deps({}));
    expect(r).toHaveLength(0);
  });

  it("explicit legacy briefing also produces NO result", () => {
    const legacyAgent = { ...wired, session_continuity: { briefing: "legacy" } };
    const r = runBootBriefingChecks(configWith({ clerk: legacyAgent } as never), deps({}));
    expect(r).toHaveLength(0);
  });

  it("mixed fleet → only the gateway-briefing agents earn a row", () => {
    const legacyAgent = { topic_name: "L", channels: { telegram: { enabled: true, plugin: "switchroom" } } };
    const r = runBootBriefingChecks(
      configWith({ clerk: wired, plain: legacyAgent } as never),
      deps({}),
    );
    expect(r).toHaveLength(1);
    expect(r[0].name).toBe("boot-briefing: clerk");
  });

  it("never emits a fail (warn is the ceiling — the agent still boots)", () => {
    const agent = { ...wired, channels: { telegram: { enabled: false, plugin: "official" } } };
    const r = runBootBriefingChecks(
      configWith({ clerk: agent } as never),
      deps({ isDocker: () => false }),
    );
    expect(r.every((x) => x.status !== "fail")).toBe(true);
  });
});

describe("historyExplicitlyDisabled", () => {
  it("true only when the file exists and historyEnabled === false", () => {
    expect(historyExplicitlyDisabled(() => JSON.stringify({ historyEnabled: false }), "/a")).toBe(true);
  });
  it("false when the key is absent (default-on)", () => {
    expect(historyExplicitlyDisabled(() => JSON.stringify({ other: 1 }), "/a")).toBe(false);
  });
  it("false when historyEnabled is true", () => {
    expect(historyExplicitlyDisabled(() => JSON.stringify({ historyEnabled: true }), "/a")).toBe(false);
  });
  it("false when the file is missing (ENOENT)", () => {
    expect(
      historyExplicitlyDisabled(() => {
        throw new Error("nope");
      }, "/a"),
    ).toBe(false);
  });
  it("false when the file is corrupt JSON", () => {
    expect(historyExplicitlyDisabled(() => "{not json", "/a")).toBe(false);
  });
});
