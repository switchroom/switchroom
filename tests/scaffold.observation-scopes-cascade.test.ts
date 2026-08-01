import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import type { SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

/**
 * #3912 — the defaults/profile-tier `memory.observation_scopes` comment used
 * to promise a "per-agent opt-out". `ObservationScopesSchema` is
 * `z.enum().optional()` with NO clear/null sentinel, and the cascade inherits
 * on `undefined` — so a per-agent value can only OVERRIDE the fleet pin with
 * another enum member; it cannot cancel it. The member that declines the pool
 * is `combined` (restores the pre-feature engine default).
 *
 * These pin the OUTCOME the corrected comment describes, driving the FULL
 * cascade through scaffoldAgent (defaults → agent) and reading the start.sh
 * export the plugin actually loads. Each fails if the cascade stops inheriting
 * the fleet pin, or if a per-agent override stops winning.
 */
describe("observation_scopes defaults-tier cascade + override (#3912)", () => {
  let tmpDir: string;
  let telegram: TelegramConfig;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `obs-cascade-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(tmpDir, { recursive: true });
    telegram = { bot_token: "t", forum_chat_id: "c" };
  });
  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function startShFor(config: SwitchroomConfig): string {
    const res = scaffoldAgent("probe", config.agents.probe ?? {}, tmpDir, telegram, config);
    return readFileSync(join(res.agentDir, "start.sh"), "utf-8");
  }

  function base(partial: Partial<SwitchroomConfig>): SwitchroomConfig {
    return {
      memory: { backend: "hindsight", config: { url: "http://localhost:18888/mcp/" } },
      telegram,
      agents: {},
      ...partial,
    } as SwitchroomConfig;
  }

  it("a defaults-tier pin is INHERITED by an agent that sets nothing", () => {
    // The agent's own memory block is empty ⇒ undefined ⇒ inherits the fleet
    // pin. This is the "cannot cancel by omission" half: silence adopts the
    // fleet scope, it does not fall back to the engine default.
    const startSh = startShFor(
      base({
        defaults: { memory: { observation_scopes: "shared" } },
        agents: { probe: {} },
      }),
    );
    expect(startSh).toMatch(/export HINDSIGHT_OBSERVATION_SCOPES='shared'/);
  });

  it("a per-agent value OVERRIDES the defaults-tier pin (not additive)", () => {
    const startSh = startShFor(
      base({
        defaults: { memory: { observation_scopes: "shared" } },
        agents: { probe: { memory: { observation_scopes: "per_tag" } } as never },
      }),
    );
    expect(startSh).toMatch(/export HINDSIGHT_OBSERVATION_SCOPES='per_tag'/);
    // The inherited pin must NOT also leak through — override, not merge.
    expect(startSh).not.toMatch(/export HINDSIGHT_OBSERVATION_SCOPES='shared'/);
  });

  it("`combined` is the member an agent uses to decline a fleet pool", () => {
    // The corrected comment's opt-out mechanism: not a null sentinel, but the
    // `combined` enum member, which restores the pre-feature engine default.
    const startSh = startShFor(
      base({
        defaults: { memory: { observation_scopes: "shared" } },
        agents: { probe: { memory: { observation_scopes: "combined" } } as never },
      }),
    );
    expect(startSh).toMatch(/export HINDSIGHT_OBSERVATION_SCOPES='combined'/);
    expect(startSh).not.toMatch(/export HINDSIGHT_OBSERVATION_SCOPES='shared'/);
  });

  it("a profile-tier pin cascades the same way (defaults → profile → agent)", () => {
    const startSh = startShFor(
      base({
        profiles: { pooled: { memory: { observation_scopes: "shared" } } } as never,
        agents: { probe: { extends: "pooled" } } as never,
      }),
    );
    expect(startSh).toMatch(/export HINDSIGHT_OBSERVATION_SCOPES='shared'/);
  });
});
