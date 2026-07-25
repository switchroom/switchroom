/**
 * KEN-130 — doctor wiring for generated-surface drift. Outcome asserts:
 * a staled surface of each class produces a named WARN row; a clean
 * fleet produces none (a single ok summary); statuses are never `fail`
 * so doctor's exit code for an otherwise-OK install is unchanged.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SwitchroomConfig } from "../config/schema.js";
import { resolveAgentConfig } from "../config/merge.js";
import { buildSettingsHooksBlock } from "../agents/scaffold.js";
import {
  computeConfigHash,
  computeStampFilesFromDisk,
  writeGenerationStamp,
} from "../agents/generation-stamp.js";
import { VERSION } from "../build-info.js";
import { DRIFT_REPORT_FILE } from "../agents/drift.js";
import { runGeneratedSurfaceDriftChecks } from "./doctor-drift.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "doctor-drift-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const CONFIG_PATH = "/cfg/switchroom.yaml";

function mkConfig(): SwitchroomConfig {
  return {
    telegram: { bot_token: "tok", forum_chat_id: "-100" },
    switchroom: { agents_dir: join(root, "agents") },
    agents: { bot: { channels: { telegram: { plugin: "switchroom" } } } },
  } as unknown as SwitchroomConfig;
}

/** Scaffold a fully in-sync agent dir for `bot` under the config above. */
function seedCleanAgent(config: SwitchroomConfig): string {
  const agentDir = join(root, "agents", "bot");
  mkdirSync(join(agentDir, ".claude"), { recursive: true });
  const agentConfig = resolveAgentConfig(config.defaults, config.profiles, config.agents["bot"]);
  const hooks = buildSettingsHooksBlock({
    agentName: "bot",
    agentConfig,
    hindsightEnabled: false,
    useSwitchroomPlugin: true,
    configPath: CONFIG_PATH,
  });
  writeFileSync(join(agentDir, ".claude", "settings.json"), JSON.stringify({ hooks }));
  writeFileSync(join(agentDir, "start.sh"), "#!/bin/bash\n");
  writeFileSync(join(agentDir, ".mcp.json"), "{}\n");
  writeGenerationStamp(agentDir, {
    switchroomVersion: VERSION,
    configHash: computeConfigHash(agentConfig),
    files: computeStampFilesFromDisk(agentDir),
  });
  return agentDir;
}

const cleanCompose = async () => ({
  content: "services: {}\n",
  previous: "services: {}\n" as string | null,
  imageTag: "v1",
  previousImageTag: "v1" as string | null,
});

describe("runGeneratedSurfaceDriftChecks", () => {
  it("clean fleet → no WARN rows, single ok summary, report written empty", async () => {
    const config = mkConfig();
    const agentDir = seedCleanAgent(config);
    const results = await runGeneratedSurfaceDriftChecks(config, CONFIG_PATH, {
      composeCompute: cleanCompose,
      execImpl: () => {
        throw new Error("no docker in tests");
      },
    });
    expect(results.filter((r) => r.status === "warn")).toEqual([]);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("ok");
    // Report persisted for the boot card, and reads clean.
    const report = JSON.parse(readFileSync(join(agentDir, DRIFT_REPORT_FILE), "utf-8"));
    expect(report.findings).toEqual([]);
  });

  it("each staled surface class → a named WARN row", async () => {
    const config = mkConfig();
    const agentDir = seedCleanAgent(config);
    // Stale surface 2 (hooks): tamper the settings hooks block.
    writeFileSync(join(agentDir, ".claude", "settings.json"), JSON.stringify({ hooks: {} }));
    // Stale surface 3 (templates): tamper start.sh after the stamp.
    writeFileSync(join(agentDir, "start.sh"), "#!/bin/bash\nTAMPERED\n");
    // Stale surface 5 (mcp): tamper .mcp.json after the stamp.
    writeFileSync(join(agentDir, ".mcp.json"), '{"mcpServers":{"x":{}}}\n');
    // Stale surface 4 (skills): overlay-declared but uninstalled skill.
    mkdirSync(join(agentDir, "skills.d"), { recursive: true });
    writeFileSync(join(agentDir, "skills.d", "lost-skill.yaml"), "x: 1\n");

    const results = await runGeneratedSurfaceDriftChecks(config, CONFIG_PATH, {
      // Stale surface 1 (compose).
      composeCompute: async () => ({
        content: "services: {new: 1}\n",
        previous: "services: {old: 1}\n",
        imageTag: "v2",
        previousImageTag: "v1",
      }),
      // Stale surface 6 (hook-scripts): image hash differs from bin/.
      binDir: (() => {
        const b = join(root, "bin");
        mkdirSync(b);
        writeFileSync(join(b, "run-hook.sh"), "current content");
        return b;
      })(),
      execImpl: () =>
        "0000000000000000000000000000000000000000000000000000000000000000  /opt/switchroom/bin/run-hook.sh\n",
    });

    const warnNames = results.filter((r) => r.status === "warn").map((r) => r.name);
    expect(warnNames).toContain("drift: compose");
    expect(warnNames).toContain("drift: bot: hooks");
    expect(warnNames).toContain("drift: bot: start.sh");
    expect(warnNames).toContain("drift: bot: .mcp.json");
    expect(warnNames).toContain("drift: bot: skills");
    expect(warnNames).toContain("drift: bot: hook-scripts");
    // Exit-code invariant: drift is warn-only, never fail.
    expect(results.every((r) => r.status !== "fail")).toBe(true);
    // Report carries the findings (incl. fleet-level compose) for the boot card.
    const report = JSON.parse(readFileSync(join(agentDir, DRIFT_REPORT_FILE), "utf-8"));
    const surfaces = report.findings.map((f: { surface: string }) => f.surface);
    expect(surfaces).toContain("compose");
    expect(surfaces).toContain("hooks");
    expect(surfaces).toContain("hook-scripts");
  });

  it("yaml edited without apply → named config-staleness WARN", async () => {
    const config = mkConfig();
    seedCleanAgent(config);
    // Simulate a config edit after the stamp was written.
    (config.agents["bot"] as Record<string, unknown>).model = "different-model";
    const results = await runGeneratedSurfaceDriftChecks(config, CONFIG_PATH, {
      composeCompute: cleanCompose,
      execImpl: () => {
        throw new Error("no docker");
      },
    });
    const warns = results.filter((r) => r.status === "warn");
    expect(warns.map((r) => r.name)).toContain("drift: bot: config");
  });

  it("never-scaffolded agent dir → skipped silently, not drift", async () => {
    const config = mkConfig();
    // no agent dir on disk at all
    const results = await runGeneratedSurfaceDriftChecks(config, CONFIG_PATH, {
      composeCompute: cleanCompose,
    });
    expect(results.filter((r) => r.status === "warn")).toEqual([]);
    expect(existsSync(join(root, "agents", "bot"))).toBe(false);
  });

  it("fast mode skips the container hook-script probe", async () => {
    const config = mkConfig();
    seedCleanAgent(config);
    let execCalled = false;
    const results = await runGeneratedSurfaceDriftChecks(config, CONFIG_PATH, {
      composeCompute: cleanCompose,
      fast: true,
      execImpl: () => {
        execCalled = true;
        return "";
      },
    });
    expect(execCalled).toBe(false);
    expect(results.filter((r) => r.status === "warn")).toEqual([]);
  });
});
