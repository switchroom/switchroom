import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent, reconcileAgent } from "../src/agents/scaffold.js";
import { AgentMemorySchema, SwitchroomConfigSchema } from "../src/config/schema.js";
import type { SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";
import { OBSERVATION_SCOPE_STRATEGIES } from "../src/memory/observation-scopes.js";

/**
 * `memory.observation_scope_strategy` — the first-class switchroom.yaml surface
 * for the plugin's `observationScopeStrategy` selector (shipped on-by-default
 * in #4035, previously reachable only via a raw env var or by pinning
 * `memory.observation_scopes`).
 *
 * The end-to-end chain is: yaml `memory.observation_scope_strategy: combined`
 * → schema validation (rejects a typo at `apply`) → cascade → scaffold.ts →
 * `start.sh` exports `HINDSIGHT_OBSERVATION_SCOPE_STRATEGY=combined`. The
 * resolver half — that env value reaching `observationScopeStrategy` and
 * producing the opt-out (no per-row scope on the wire) — is proven by
 * `vendor/hindsight-memory/scripts/tests/test_observation_scopes.py`
 * (`test_strategy_env_override_opts_out`, `test_payload_omits_scope_when_opted_out`).
 * These tests pin the switchroom half and the init-vs-reconcile parity a second
 * hand-built template context makes easy to drift.
 */
describe("memory.observation_scope_strategy plumbing", () => {
  let tmpDir: string;
  let telegram: TelegramConfig;

  beforeEach(() => {
    tmpDir = join(
      tmpdir(),
      `obs-strategy-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    );
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
    it("accepts every strategy the resolver accepts", () => {
      for (const strategy of OBSERVATION_SCOPE_STRATEGIES) {
        const ok = AgentMemorySchema.safeParse({
          collection: "probe",
          observation_scope_strategy: strategy,
        });
        expect(ok.success, strategy).toBe(true);
        if (ok.success) expect(ok.data?.observation_scope_strategy).toBe(strategy);
      }
    });

    it("rejects an empty string (an empty strategy is a typo, not an opt-out)", () => {
      expect(
        AgentMemorySchema.safeParse({
          collection: "probe",
          observation_scope_strategy: "",
        }).success,
      ).toBe(false);
    });

    it("REJECTS an off-list value instead of passing it through", () => {
      // A free string would apply clean, reach the env, and the resolver would
      // silently fall back to `curated` — the operator's opt-out never landing,
      // discovered only by inspecting the bank. `apply` is the cheap gate.
      for (const bad of ["curate", "Combined", "opt-out", "sharedd", "none"]) {
        const res = AgentMemorySchema.safeParse({
          collection: "probe",
          observation_scope_strategy: bad,
        });
        expect(res.success, bad).toBe(false);
      }
    });

    it("REJECTS an off-list value at the defaults tier too", () => {
      expect(() =>
        SwitchroomConfigSchema.parse({
          switchroom: { version: 1, home: "/tmp/does-not-matter" },
          telegram: { bot_token: "t", forum_chat_id: "c" },
          defaults: { memory: { observation_scope_strategy: "curate" } },
          agents: {},
        }),
      ).toThrow();
    });

    it("survives the defaults tier instead of being stripped by the parse", () => {
      // The defaults/profile tier is a SEPARATE zod object; a key missing there
      // is silently dropped, so a fleet-wide opt-out would vanish before the
      // cascade ever saw it.
      const parsed = SwitchroomConfigSchema.parse({
        switchroom: { version: 1, home: "/tmp/does-not-matter" },
        telegram: { bot_token: "t", forum_chat_id: "c" },
        defaults: { memory: { observation_scope_strategy: "combined" } },
        agents: {},
      });
      expect(parsed.defaults?.memory?.observation_scope_strategy).toBe("combined");
    });
  });

  describe("start.sh", () => {
    it("unset emits NO export — the plugin's on-by-default curated stands", () => {
      expect(startShFor(undefined)).not.toMatch(
        /HINDSIGHT_OBSERVATION_SCOPE_STRATEGY/,
      );
    });

    it("an unrelated memory block still emits NO export", () => {
      expect(startShFor({ collection: "probe" })).not.toMatch(
        /HINDSIGHT_OBSERVATION_SCOPE_STRATEGY/,
      );
    });

    it("the opt-out value reaches the resolver env verbatim", () => {
      // The whole point of the feature: `combined` in yaml must land as the env
      // the plugin's ENV_MAPPINGS reads (config.py). The resolver then omits the
      // per-row scope (vendor test_payload_omits_scope_when_opted_out).
      expect(startShFor({ observation_scope_strategy: "combined" })).toMatch(
        /export HINDSIGHT_OBSERVATION_SCOPE_STRATEGY='combined'/,
      );
    });

    it("shell-quotes the value so it cannot inject shell", () => {
      const startSh = startShFor({ observation_scope_strategy: "a'b; rm -rf /" });
      expect(startSh).toContain(
        `export HINDSIGHT_OBSERVATION_SCOPE_STRATEGY='a'"'"'b; rm -rf /'`,
      );
      expect(startSh).not.toMatch(/^\s*rm -rf \//m);
    });

    it("reconcileAgent emits the same export as scaffoldAgent (no init/reconcile drift)", () => {
      const memory = { observation_scope_strategy: "combined" };
      const config = configFor(memory);
      const agentConfig = config.agents.probe ?? {};
      const res = scaffoldAgent("probe", agentConfig, tmpDir, telegram, config);
      const scaffolded = readFileSync(join(res.agentDir, "start.sh"), "utf-8");
      reconcileAgent("probe", agentConfig, tmpDir, telegram, config);
      const reconciled = readFileSync(join(res.agentDir, "start.sh"), "utf-8");
      expect(reconciled).toMatch(
        /export HINDSIGHT_OBSERVATION_SCOPE_STRATEGY='combined'/,
      );
      expect(reconciled).toBe(scaffolded);
    });

    it("reconcileAgent also omits the export when unset", () => {
      const config = configFor(undefined);
      const res = scaffoldAgent("probe", {}, tmpDir, telegram, config);
      reconcileAgent("probe", {}, tmpDir, telegram, config);
      const reconciled = readFileSync(join(res.agentDir, "start.sh"), "utf-8");
      expect(reconciled).not.toMatch(/HINDSIGHT_OBSERVATION_SCOPE_STRATEGY/);
    });

    it("the pin and the strategy export independently (both wire up)", () => {
      // A pin still wins in the resolver, but the schema/scaffold surface both:
      // setting both must emit both exports, not swallow one.
      const startSh = startShFor({
        observation_scopes: "shared",
        observation_scope_strategy: "combined",
      });
      expect(startSh).toMatch(/export HINDSIGHT_OBSERVATION_SCOPES='shared'/);
      expect(startSh).toMatch(
        /export HINDSIGHT_OBSERVATION_SCOPE_STRATEGY='combined'/,
      );
    });
  });
});
