import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { installHindsightPlugin, scaffoldAgent } from "../src/agents/scaffold.js";
import { AgentMemorySchema } from "../src/config/schema.js";
import type { SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

/**
 * #2848 Stage B — directive-capture nudge threading.
 *
 * Stage A audit found a ~55% miss rate on durable corrections. The
 * deterministic nudge is ON by default for every agent: recall.py
 * regex-detects correction / standing-rule-shaped inbound and appends a
 * terse advisory telling the model to persist the rule with
 * create_directive. The default is pinned into the copied plugin
 * settings.json by applyHindsightSettingsOverrides; an operator opts OUT
 * per-agent (or fleet-wide under `defaults`) via
 * memory.directive_capture_nudge, which scaffold exports into start.sh as
 * HINDSIGHT_DIRECTIVE_CAPTURE_NUDGE ONLY when set — the env value wins over
 * the settings.json default at plugin load.
 */
describe("directive-capture nudge (#2848 Stage B)", () => {
  let tmpDir: string;
  let telegram: TelegramConfig;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `directive-nudge-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(tmpDir, { recursive: true });
    telegram = { bot_token: "t", forum_chat_id: "c" };
  });
  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("schema acceptance", () => {
    it("accepts memory.directive_capture_nudge as a boolean", () => {
      const ok = AgentMemorySchema.safeParse({
        collection: "probe",
        directive_capture_nudge: false,
      });
      expect(ok.success).toBe(true);
      if (ok.success) {
        expect(ok.data?.directive_capture_nudge).toBe(false);
      }
    });

    it("rejects a non-boolean value", () => {
      const bad = AgentMemorySchema.safeParse({
        collection: "probe",
        directive_capture_nudge: "yes",
      });
      expect(bad.success).toBe(false);
    });
  });

  describe("settings.json default (on)", () => {
    it("applyHindsightSettingsOverrides pins directiveCaptureNudge true", () => {
      const config = {
        agents: {},
        memory: { backend: "hindsight", config: { url: "http://localhost:18888/mcp/" } },
        telegram: { bot_token: "t", forum_chat_id: "c" },
      } as SwitchroomConfig;
      const res = installHindsightPlugin("probe", tmpDir, config);
      expect(res).not.toBeNull();
      const settingsPath = join(tmpDir, ".claude", "plugins", "hindsight-memory", "settings.json");
      const settings = JSON.parse(readFileSync(settingsPath, "utf-8"));
      expect(settings.directiveCaptureNudge).toBe(true);
    });
  });

  describe("start.sh opt-out cascade", () => {
    function startShFor(memory: Record<string, unknown> | undefined): string {
      const config: SwitchroomConfig = {
        agents: memory ? ({ probe: { memory } } as never) : {},
        memory: { backend: "hindsight", config: { url: "http://localhost:18888/mcp/" } },
        telegram,
      } as SwitchroomConfig;
      const res = scaffoldAgent("probe", config.agents.probe ?? {}, tmpDir, telegram, config);
      return readFileSync(join(res.agentDir, "start.sh"), "utf-8");
    }

    it("default (no override) emits NO env export — settings.json default stays in force", () => {
      const startSh = startShFor(undefined);
      expect(startSh).not.toMatch(/export HINDSIGHT_DIRECTIVE_CAPTURE_NUDGE=/);
    });

    it("directive_capture_nudge=false exports the false env (not omitted)", () => {
      // The bool-false case must still emit the export — otherwise the
      // settings.json default (true) would silently win and the opt-out fail.
      const startSh = startShFor({ directive_capture_nudge: false });
      expect(startSh).toMatch(/export HINDSIGHT_DIRECTIVE_CAPTURE_NUDGE=false/);
    });

    it("directive_capture_nudge=true also exports (explicit re-affirm is harmless)", () => {
      const startSh = startShFor({ directive_capture_nudge: true });
      expect(startSh).toMatch(/export HINDSIGHT_DIRECTIVE_CAPTURE_NUDGE=true/);
    });
  });
});
