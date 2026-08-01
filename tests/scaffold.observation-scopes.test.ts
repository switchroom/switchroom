import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFileSync } from "node:fs";
import { scaffoldAgent, reconcileAgent } from "../src/agents/scaffold.js";
import { AgentMemorySchema, SwitchroomConfigSchema } from "../src/config/schema.js";
import type { SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";
import { OBSERVATION_SCOPES } from "../src/memory/observation-scopes.js";

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

    it("accepts every value the engine accepts as a bare string", () => {
      for (const scope of OBSERVATION_SCOPES) {
        const ok = AgentMemorySchema.safeParse({ collection: "probe", observation_scopes: scope });
        expect(ok.success, scope).toBe(true);
      }
    });

    it("REJECTS an off-list value instead of passing it through", () => {
      // A free string would apply clean, reach the wire, and leave the engine
      // falling back to its own default scope — a bank whose observations
      // never merged, discovered months later. `apply` is the cheap gate.
      for (const bad of ["shred", "Shared", "per-tag", "sharedd", "all_combos"]) {
        const res = AgentMemorySchema.safeParse({ collection: "probe", observation_scopes: bad });
        expect(res.success, bad).toBe(false);
      }
    });

    it("REJECTS an off-list value at the defaults tier too", () => {
      expect(() =>
        SwitchroomConfigSchema.parse({
          switchroom: { version: 1, home: "/tmp/does-not-matter" },
          telegram: { bot_token: "t", forum_chat_id: "c" },
          defaults: { memory: { observation_scopes: "shred" } },
          agents: {},
        }),
      ).toThrow();
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

  /**
   * #3915 — the settings.json mirror, the OTHER channel.
   *
   * start.sh exports HINDSIGHT_OBSERVATION_SCOPES / _STRATEGY into the
   * SUPERVISED claude session only. A docker-exec'd retain — a
   * `backfill_transcripts.py` slice, a consolidation drain, `hostd agent_exec` —
   * does NOT inherit that env, so `lib/config.load_config` falls back to the
   * plugin's settings.json. Left unmirrored, settings.json carried the vendor
   * default (scope None / strategy "curated") and the exec'd process retained
   * under the WRONG scope — silent bank corruption during a reconsolidation.
   *
   * So the load-bearing assertion is not "the value reaches start.sh" (the
   * describe above) but "the value is ALSO in the deployed settings.json, so the
   * two channels resolve identically". These read the deployed plugin file that
   * the env-less exec path actually consults.
   */
  describe("settings.json mirror for docker-exec'd retains (#3915)", () => {
    const PLUGIN_REL = [".claude", "plugins", "hindsight-memory", "settings.json"] as const;

    function deployedSettings(
      memory: Record<string, unknown> | undefined,
    ): Record<string, unknown> {
      const config = configFor(memory);
      const res = scaffoldAgent("probe", config.agents.probe ?? {}, tmpDir, telegram, config);
      return JSON.parse(
        readFileSync(join(res.agentDir, ...PLUGIN_REL), "utf-8"),
      ) as Record<string, unknown>;
    }

    it("stamps the configured scope + strategy into the file the env-less path reads", () => {
      // The bug: before the mirror these keys were absent, so an exec'd retain
      // resolved the vendor default instead of the operator's scope.
      const s = deployedSettings({
        observation_scopes: "shared",
        observation_scope_strategy: "shared",
      });
      expect(s.observationScopes).toBe("shared");
      expect(s.observationScopeStrategy).toBe("shared");
    });

    it("stamps a strategy-only config (no manual pin) too", () => {
      const s = deployedSettings({ observation_scope_strategy: "combined" });
      expect(s.observationScopeStrategy).toBe("combined");
      // No pin set → no scope key, so the strategy is what decides the scope.
      expect("observationScopes" in s).toBe(false);
    });

    it("unset leaves NO observation keys — the vendor default (None/curated) stands", () => {
      // Over-stamping would change the wire for every agent that configured
      // nothing; the field must stay absent so config.py keeps its own default.
      const s = deployedSettings(undefined);
      expect("observationScopes" in s).toBe(false);
      expect("observationScopeStrategy" in s).toBe(false);
    });

    it("an unrelated memory block still stamps NO observation keys", () => {
      const s = deployedSettings({ collection: "probe" });
      expect("observationScopes" in s).toBe(false);
      expect("observationScopeStrategy" in s).toBe(false);
    });

    it("the settings.json value is BYTE-IDENTICAL to what start.sh exports", () => {
      // The whole point of the mirror is that the supervised env channel and the
      // exec'd settings.json channel carry the SAME value. Assert both at once so
      // a future edit to one cannot silently diverge from the other.
      const memory = { observation_scopes: "shared", observation_scope_strategy: "shared" };
      const config = configFor(memory);
      const res = scaffoldAgent("probe", config.agents.probe ?? {}, tmpDir, telegram, config);
      const startSh = readFileSync(join(res.agentDir, "start.sh"), "utf-8");
      const s = JSON.parse(
        readFileSync(join(res.agentDir, ...PLUGIN_REL), "utf-8"),
      ) as Record<string, unknown>;
      expect(startSh).toMatch(/export HINDSIGHT_OBSERVATION_SCOPES='shared'/);
      expect(startSh).toMatch(/export HINDSIGHT_OBSERVATION_SCOPE_STRATEGY='shared'/);
      expect(s.observationScopes).toBe("shared");
      expect(s.observationScopeStrategy).toBe("shared");
    });

    it("re-asserts the stamp after a reinstall clobbers it (survives apply)", () => {
      // installHindsightPlugin rm+re-copies the vendor tree on every reconcile;
      // a mirror that only stamped on first install would be reverted by the
      // next `switchroom apply` — the exact failure mode the recall-tunables
      // regression test guards. Reproduce it: install, clobber, reinstall.
      const memory = { observation_scopes: "shared", observation_scope_strategy: "shared" };
      const config = configFor(memory);
      const agentConfig = config.agents.probe ?? {};
      const res = scaffoldAgent("probe", agentConfig, tmpDir, telegram, config);
      const settingsPath = join(res.agentDir, ...PLUGIN_REL);

      const clobbered = JSON.parse(readFileSync(settingsPath, "utf-8"));
      delete clobbered.observationScopes;
      delete clobbered.observationScopeStrategy;
      writeFileSync(settingsPath, JSON.stringify(clobbered, null, 2) + "\n");
      // Sanity: the clobber took, so a green result below means the re-stamp ran.
      expect(
        "observationScopes" in
          (JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>),
      ).toBe(false);

      reconcileAgent("probe", agentConfig, tmpDir, telegram, config);
      const s = JSON.parse(readFileSync(settingsPath, "utf-8")) as Record<string, unknown>;
      expect(s.observationScopes).toBe("shared");
      expect(s.observationScopeStrategy).toBe("shared");
    });
  });
});
