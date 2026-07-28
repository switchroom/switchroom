import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent, reconcileAgent } from "../src/agents/scaffold.js";
import { AgentMemorySchema, SwitchroomConfigSchema } from "../src/config/schema.js";
import type { SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

/**
 * Per-row Hindsight `observation_scopes` on the retain path.
 *
 * `memory.observation_scopes: shared` makes the plugin stamp every retain
 * with a scope, which sends that item's consolidated observations into ONE
 * global untagged scope instead of a scope per tag — how a set of agents
 * pooling a bank gets merged observations.
 *
 * The knob is OFF by default and must stay invisible when off: no export in
 * start.sh, so the plugin's `observationScopes` stays None and the field
 * never reaches the wire. These tests pin both directions, and the
 * init-vs-reconcile parity that a second hand-built template context makes
 * easy to drift.
 */
describe("memory.observation_scopes plumbing", () => {
  let tmpDir: string;
  let telegram: TelegramConfig;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `obs-scopes-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(tmpDir, { recursive: true });
    telegram = { bot_token: "t", forum_chat_id: "c" };
  });
  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function configFor(memory: Record<string, unknown> | undefined): SwitchroomConfig {
    return {
      agents: memory ? ({ probe: { memory } } as never) : {},
      memory: { backend: "hindsight", config: { url: "http://localhost:18888/mcp/" } },
      telegram,
    } as SwitchroomConfig;
  }

  function startShFor(memory: Record<string, unknown> | undefined): string {
    const config = configFor(memory);
    const res = scaffoldAgent("probe", config.agents.probe ?? {}, tmpDir, telegram, config);
    return readFileSync(join(res.agentDir, "start.sh"), "utf-8");
  }

  describe("schema", () => {
    it("accepts memory.observation_scopes as a non-empty string", () => {
      const ok = AgentMemorySchema.safeParse({
        collection: "probe",
        observation_scopes: "shared",
      });
      expect(ok.success).toBe(true);
      if (ok.success) expect(ok.data?.observation_scopes).toBe("shared");
    });

    it("rejects an empty string (an empty scope is a typo, not an opt-out)", () => {
      expect(
        AgentMemorySchema.safeParse({ collection: "probe", observation_scopes: "" }).success,
      ).toBe(false);
    });

    it("survives the defaults tier instead of being stripped by the parse", () => {
      // The defaults/profile tier is a SEPARATE zod object; a key missing
      // there is silently dropped, so a fleet-wide setting would vanish
      // before the cascade ever saw it.
      const parsed = SwitchroomConfigSchema.parse({
        switchroom: { version: 1, home: "/tmp/does-not-matter" },
        telegram: { bot_token: "t", forum_chat_id: "c" },
        defaults: { memory: { observation_scopes: "shared" } },
        agents: {},
      });
      expect(parsed.defaults?.memory?.observation_scopes).toBe("shared");
    });
  });

  describe("start.sh", () => {
    it("unset emits NO export — the field never reaches the wire", () => {
      expect(startShFor(undefined)).not.toMatch(/HINDSIGHT_OBSERVATION_SCOPES/);
    });

    it("an unrelated memory block still emits NO export", () => {
      expect(startShFor({ collection: "probe" })).not.toMatch(/HINDSIGHT_OBSERVATION_SCOPES/);
    });

    it("set emits the export with the configured value", () => {
      expect(startShFor({ observation_scopes: "shared" })).toMatch(
        /export HINDSIGHT_OBSERVATION_SCOPES='shared'/,
      );
    });

    it("shell-quotes the value so it cannot inject shell", () => {
      const startSh = startShFor({ observation_scopes: "a'b; rm -rf /" });
      expect(startSh).toContain(
        `export HINDSIGHT_OBSERVATION_SCOPES='a'"'"'b; rm -rf /'`,
      );
      // The injected command must not be reachable as its own statement.
      expect(startSh).not.toMatch(/^\s*rm -rf \//m);
    });

    it("reconcileAgent emits the same export as scaffoldAgent (no init/reconcile drift)", () => {
      const memory = { observation_scopes: "shared" };
      const config = configFor(memory);
      const agentConfig = config.agents.probe ?? {};
      const res = scaffoldAgent("probe", agentConfig, tmpDir, telegram, config);
      const scaffolded = readFileSync(join(res.agentDir, "start.sh"), "utf-8");
      reconcileAgent("probe", agentConfig, tmpDir, telegram, config);
      const reconciled = readFileSync(join(res.agentDir, "start.sh"), "utf-8");
      expect(reconciled).toMatch(/export HINDSIGHT_OBSERVATION_SCOPES='shared'/);
      expect(reconciled).toBe(scaffolded);
    });

    it("reconcileAgent also omits the export when unset", () => {
      const config = configFor(undefined);
      const res = scaffoldAgent("probe", {}, tmpDir, telegram, config);
      reconcileAgent("probe", {}, tmpDir, telegram, config);
      const reconciled = readFileSync(join(res.agentDir, "start.sh"), "utf-8");
      expect(reconciled).not.toMatch(/HINDSIGHT_OBSERVATION_SCOPES/);
    });
  });
});
