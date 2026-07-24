/**
 * KEN-130 — per-surface drift detectors. Outcome-asserting: every test
 * intentionally stales (or keeps clean) a real on-disk surface and
 * asserts the NAMED finding appears (or that a clean surface yields
 * none), matching the issue's acceptance criteria.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SwitchroomConfig } from "../config/schema.js";
import { resolveAgentConfig } from "../config/merge.js";
import { buildSettingsHooksBlock } from "./scaffold.js";
import { sha256Text } from "./generation-stamp.js";
import {
  detectComposeDrift,
  detectHookScriptDrift,
  detectHooksSurfaceDrift,
  detectSkillsDrift,
} from "./drift.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drift-test-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// ─── Surface 1: compose ─────────────────────────────────────────────────────

describe("detectComposeDrift", () => {
  const base = {
    imageTag: "v1.0.0",
    previousImageTag: "v1.0.0" as string | null,
  };

  it("deployed == rendered → no findings", async () => {
    const r = await detectComposeDrift({
      compute: async () => ({ ...base, content: "services: {}\n", previous: "services: {}\n" }),
    });
    expect(r).toEqual([]);
  });

  it("stale deployed compose → named compose finding", async () => {
    const r = await detectComposeDrift({
      compute: async () => ({
        content: "services: {new: true}\n",
        previous: "services: {old: true}\n",
        imageTag: "v1.1.0",
        previousImageTag: "v1.0.0",
      }),
    });
    expect(r).toHaveLength(1);
    expect(r[0].surface).toBe("compose");
    expect(r[0].detail).toContain("differs from current config render");
    expect(r[0].detail).toContain("v1.0.0 → v1.1.0");
  });

  it("no deployed compose (apply never ran) → not drift", async () => {
    const r = await detectComposeDrift({
      compute: async () => ({ ...base, content: "x", previous: null, previousImageTag: null }),
    });
    expect(r).toEqual([]);
  });

  it("render error → no findings (doctor surfaces render errors elsewhere)", async () => {
    const r = await detectComposeDrift({
      compute: async () => {
        throw new Error("vault locked");
      },
    });
    expect(r).toEqual([]);
  });
});

// ─── Surface 2: settings.json hooks ─────────────────────────────────────────

describe("detectHooksSurfaceDrift", () => {
  const config = {
    telegram: { bot_token: "tok", forum_chat_id: "-100" },
    agents: { bot: { channels: { telegram: { plugin: "switchroom" } } } },
  } as unknown as SwitchroomConfig;

  function resolved() {
    return resolveAgentConfig(config.defaults, config.profiles, config.agents["bot"]);
  }

  function writeSettings(hooks: Record<string, unknown>): void {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({ hooks }, null, 2),
    );
  }

  it("settings hooks matching the current render → no findings", () => {
    const agentConfig = resolved();
    const expected = buildSettingsHooksBlock({
      agentName: "bot",
      agentConfig,
      hindsightEnabled: false,
      useSwitchroomPlugin: true,
      configPath: "/cfg/switchroom.yaml",
    });
    writeSettings(expected);
    const r = detectHooksSurfaceDrift("bot", agentConfig, dir, config, "/cfg/switchroom.yaml");
    expect(r).toEqual([]);
  });

  it("tampered hooks block → named hooks finding", () => {
    const agentConfig = resolved();
    const expected = buildSettingsHooksBlock({
      agentName: "bot",
      agentConfig,
      hindsightEnabled: false,
      useSwitchroomPlugin: true,
      configPath: "/cfg/switchroom.yaml",
    });
    writeSettings({ ...expected, UserPromptSubmit: [] });
    const r = detectHooksSurfaceDrift("bot", agentConfig, dir, config, "/cfg/switchroom.yaml");
    expect(r).toHaveLength(1);
    expect(r[0].surface).toBe("hooks");
    expect(r[0].agent).toBe("bot");
    expect(r[0].detail).toContain("DRIFTED");
  });

  it("missing settings.json → named finding", () => {
    const r = detectHooksSurfaceDrift("bot", resolved(), dir, config, undefined);
    expect(r).toHaveLength(1);
    expect(r[0].detail).toContain("settings.json missing");
  });
});

// ─── Surface 4: skills sync ─────────────────────────────────────────────────

describe("detectSkillsDrift", () => {
  it("healthy skills tree → no findings", () => {
    const pool = join(dir, "pool", "good-skill");
    mkdirSync(pool, { recursive: true });
    writeFileSync(join(pool, "SKILL.md"), "# skill");
    const skillsDir = join(dir, "agent", ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    symlinkSync(pool, join(skillsDir, "good-skill"));
    expect(detectSkillsDrift("bot", join(dir, "agent"))).toEqual([]);
  });

  it("dangling symlink (pool skill removed) → named finding", () => {
    const skillsDir = join(dir, "agent", ".claude", "skills");
    mkdirSync(skillsDir, { recursive: true });
    symlinkSync(join(dir, "gone", "removed-skill"), join(skillsDir, "removed-skill"));
    const r = detectSkillsDrift("bot", join(dir, "agent"));
    expect(r).toHaveLength(1);
    expect(r[0].surface).toBe("skills");
    expect(r[0].detail).toContain("removed-skill");
    expect(r[0].detail).toContain("dangling");
  });

  it("overlay-declared slug with no installed entry → named finding", () => {
    const agentDir = join(dir, "agent");
    mkdirSync(join(agentDir, "skills.d"), { recursive: true });
    writeFileSync(join(agentDir, "skills.d", "my-skill.yaml"), "source: bundled:my-skill\n");
    const r = detectSkillsDrift("bot", agentDir);
    expect(r).toHaveLength(1);
    expect(r[0].detail).toContain("my-skill");
    expect(r[0].detail).toContain("not installed");
  });

  it("overlay slug with live entry → clean", () => {
    const agentDir = join(dir, "agent");
    mkdirSync(join(agentDir, "skills.d"), { recursive: true });
    writeFileSync(join(agentDir, "skills.d", "my-skill.yaml"), "x: 1\n");
    mkdirSync(join(agentDir, ".claude", "skills", "my-skill"), { recursive: true });
    expect(detectSkillsDrift("bot", agentDir)).toEqual([]);
  });
});

// ─── Surface 6: image hook scripts ──────────────────────────────────────────

describe("detectHookScriptDrift", () => {
  function seedBin(): string {
    const binDir = join(dir, "bin");
    mkdirSync(binDir);
    writeFileSync(join(binDir, "run-hook.sh"), "#!/bin/sh\necho run\n");
    writeFileSync(join(binDir, "timezone-hook.sh"), "#!/bin/sh\necho tz\n");
    return binDir;
  }
  const h = (s: string) => sha256Text(s);

  it("image scripts matching installed bin/ → no findings", () => {
    const binDir = seedBin();
    const r = detectHookScriptDrift("bot", {
      binDir,
      execImpl: () =>
        `${h("#!/bin/sh\necho run\n")}  /opt/switchroom/bin/run-hook.sh\n` +
        `${h("#!/bin/sh\necho tz\n")}  /opt/switchroom/bin/timezone-hook.sh\n`,
    });
    expect(r).toEqual([]);
  });

  it("stale image script → finding naming the script", () => {
    const binDir = seedBin();
    const r = detectHookScriptDrift("bot", {
      binDir,
      execImpl: () =>
        `${h("OLD CONTENT")}  /opt/switchroom/bin/run-hook.sh\n` +
        `${h("#!/bin/sh\necho tz\n")}  /opt/switchroom/bin/timezone-hook.sh\n`,
    });
    expect(r).toHaveLength(1);
    expect(r[0].surface).toBe("hook-scripts");
    expect(r[0].detail).toContain("run-hook.sh");
    expect(r[0].detail).not.toContain("timezone-hook.sh");
  });

  it("script missing from image entirely → finding names it", () => {
    const binDir = seedBin();
    const r = detectHookScriptDrift("bot", {
      binDir,
      execImpl: () => `${h("#!/bin/sh\necho run\n")}  /opt/switchroom/bin/run-hook.sh\n`,
    });
    expect(r).toHaveLength(1);
    expect(r[0].detail).toContain("timezone-hook.sh");
  });

  it("container not running (docker exec throws) → not checkable, no findings", () => {
    const binDir = seedBin();
    const r = detectHookScriptDrift("bot", {
      binDir,
      execImpl: () => {
        throw new Error("No such container: switchroom-bot");
      },
    });
    expect(r).toEqual([]);
  });
});
