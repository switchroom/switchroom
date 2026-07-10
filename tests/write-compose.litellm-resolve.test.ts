import { describe, it, expect, vi, afterEach } from "vitest";
import {
  resolveLiteLLMConfirmedAgents,
  agentHadLiteLLMRouting,
} from "../src/cli/write-compose.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

/**
 * Fix #2 regression guard: a vault-broker outage must NOT silently strip fleet
 * routing.
 *
 * `resolveLiteLLMConfirmedAgents` gates the LiteLLM routing-env injection in the
 * generated compose. `writeComposeFile` runs on `agent restart` too, so if a
 * broker blip (unreachable/timeout) marked every opted-in agent not-confirmed,
 * a container recreated mid-blip would boot on UNTRACKED direct OAuth —
 * violating the product invariant that all model traffic stays proxy-routed.
 *
 * Contract under test:
 *   - broker answers `not_found`  → legitimately no key → strip (unconfirmed).
 *   - broker answers `unreachable`→ status unknown → PRESERVE the agent's prior
 *     verdict from the on-disk compose (never silently strip), loud-warn.
 *   - broker client entirely unavailable (getKey null via import failure) is
 *     modelled here by an injected getter that returns `unreachable` for all.
 */

const telegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
} as const;

function makeConfig(agentNames: string[]): SwitchroomConfig {
  const agents: Record<string, unknown> = {};
  for (const name of agentNames) {
    agents[name] = {
      extends: "default",
      topic_name: "T",
      schedule: [],
      litellm: { enabled: true },
    };
  }
  return {
    switchroom: {
      version: 1,
      agents_dir: "~/.switchroom/agents",
      skills_dir: "~/.switchroom/skills",
    },
    telegram: telegramConfig,
    litellm: { enabled: true },
    agents,
  } as unknown as SwitchroomConfig;
}

/** A minimal generated-compose fragment routing exactly `routedNames`. */
function composeWith(routedNames: string[], allNames: string[]): string {
  const blocks = allNames.map((name) => {
    const env = [`      SWITCHROOM_AGENT_NAME: "${name}"`];
    if (routedNames.includes(name)) {
      env.push(`      SWITCHROOM_LITELLM: "1"`);
      env.push(`      SWITCHROOM_LITELLM_BASE: "http://litellm:4010"`);
      env.push(`      ANTHROPIC_BASE_URL: "http://litellm:4010/anthropic"`);
    }
    return [
      `  agent-${name}:`,
      `    image: ghcr.io/switchroom/switchroom-agent:v1`,
      `    environment:`,
      ...env,
      `    volumes:`,
      `      - broker-${name}-sock:/run/switchroom/broker`,
    ].join("\n");
  });
  return ["services:", ...blocks, "volumes:", "  broker-x-sock:"].join("\n");
}

describe("agentHadLiteLLMRouting", () => {
  it("detects a routed agent and ignores an unrouted sibling", () => {
    const compose = composeWith(["alpha"], ["alpha", "beta"]);
    expect(agentHadLiteLLMRouting(compose, "alpha")).toBe(true);
    expect(agentHadLiteLLMRouting(compose, "beta")).toBe(false);
  });

  it("returns false for an agent absent from the compose", () => {
    const compose = composeWith(["alpha"], ["alpha"]);
    expect(agentHadLiteLLMRouting(compose, "ghost")).toBe(false);
  });

  it("does not leak a sibling's SWITCHROOM_LITELLM into an unrouted block", () => {
    // beta unrouted, alpha routed and lexically adjacent — the block scan must
    // stop at beta's service header, not read alpha's env.
    const compose = composeWith(["alpha"], ["beta", "alpha"]);
    expect(agentHadLiteLLMRouting(compose, "beta")).toBe(false);
  });
});

describe("resolveLiteLLMConfirmedAgents — broker outage vs key-not-found", () => {
  const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  afterEach(() => warnSpy.mockClear());

  it("confirms agents whose key the broker returns as ok", async () => {
    const config = makeConfig(["alpha", "beta"]);
    const confirmed = await resolveLiteLLMConfirmedAgents(config, null, {
      getKey: async () => ({ kind: "ok" }),
    });
    expect([...confirmed].sort()).toEqual(["alpha", "beta"]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("STRIPS an agent the broker reports as not_found (legitimate)", async () => {
    const config = makeConfig(["alpha"]);
    // Prior compose HAD routing — but not_found is a real "no key" answer, so
    // the strip is correct and the prior verdict must NOT rescue it.
    const prior = composeWith(["alpha"], ["alpha"]);
    const confirmed = await resolveLiteLLMConfirmedAgents(config, prior, {
      getKey: async () => ({ kind: "not_found" }),
    });
    expect(confirmed.has("alpha")).toBe(false);
    // No broker-outage warning on a clean not_found.
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("STRIPS an agent on a genuine grant/ACL DENIED (broker answered definitively)", async () => {
    const config = makeConfig(["alpha"]);
    const prior = composeWith(["alpha"], ["alpha"]);
    const confirmed = await resolveLiteLLMConfirmedAgents(config, prior, {
      getKey: async () => ({ kind: "denied", code: "DENIED" }),
    });
    // A real ACL denial means "no usable key" — the strip is legitimate and
    // the prior verdict must NOT rescue it.
    expect(confirmed.has("alpha")).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("PRESERVES routing on LOCKED — the client rolls it into kind 'denied' (the relock window)", async () => {
    // The broker returns LOCKED whenever the vault is locked, which happens
    // routinely during the apply/relock window — and the client collapses it
    // into kind "denied". Treating that as a definitive no-key answer would be
    // a silent strip of a routed agent on every relock. The code must be
    // classified: LOCKED ⇒ status unknown ⇒ preserve + warn.
    const config = makeConfig(["alpha"]);
    const prior = composeWith(["alpha"], ["alpha"]);
    const confirmed = await resolveLiteLLMConfirmedAgents(config, prior, {
      getKey: async () => ({ kind: "denied", code: "LOCKED" }),
    });
    expect(confirmed.has("alpha")).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    const warned = warnSpy.mock.calls.flat().join("\n");
    expect(warned).toContain("alpha");
    expect(warned).toContain("PRESERVED");
  });

  it("PRESERVES routing on INTERNAL — transient broker error, not a no-key answer", async () => {
    const config = makeConfig(["alpha"]);
    const prior = composeWith(["alpha"], ["alpha"]);
    const confirmed = await resolveLiteLLMConfirmedAgents(config, prior, {
      getKey: async () => ({ kind: "denied", code: "INTERNAL" }),
    });
    expect(confirmed.has("alpha")).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    const warned = warnSpy.mock.calls.flat().join("\n");
    expect(warned).toContain("alpha");
    expect(warned).toContain("PRESERVED");
  });

  it("PRESERVES routing for an unreachable agent that was routed on disk", async () => {
    const config = makeConfig(["alpha"]);
    const prior = composeWith(["alpha"], ["alpha"]);
    const confirmed = await resolveLiteLLMConfirmedAgents(config, prior, {
      getKey: async () => ({ kind: "unreachable" }),
    });
    // The broker blip must NOT strip routing — the agent keeps its verdict.
    expect(confirmed.has("alpha")).toBe(true);
    // …and it warns loudly, naming the affected agent.
    expect(warnSpy).toHaveBeenCalled();
    const warned = warnSpy.mock.calls.flat().join("\n");
    expect(warned).toContain("vault-broker unreachable");
    expect(warned).toContain("alpha");
    expect(warned).toContain("PRESERVED");
  });

  it("does NOT invent routing for an unreachable agent absent from prior compose", async () => {
    const config = makeConfig(["alpha"]);
    // First-ever apply: no prior compose → nothing to preserve → stay unrouted.
    const confirmed = await resolveLiteLLMConfirmedAgents(config, null, {
      getKey: async () => ({ kind: "unreachable" }),
    });
    expect(confirmed.has("alpha")).toBe(false);
    const warned = warnSpy.mock.calls.flat().join("\n");
    expect(warned).toContain("vault-broker unreachable");
    expect(warned).toContain("leaving them unrouted");
  });

  it("splits a mixed fleet: ok confirmed, not_found stripped, unreachable preserved", async () => {
    const config = makeConfig(["ok1", "gone", "blip"]);
    const prior = composeWith(["ok1", "gone", "blip"], ["ok1", "gone", "blip"]);
    const confirmed = await resolveLiteLLMConfirmedAgents(config, prior, {
      getKey: async (key) => {
        if (key.includes("ok1")) return { kind: "ok" };
        if (key.includes("gone")) return { kind: "not_found" };
        return { kind: "unreachable" };
      },
    });
    expect(confirmed.has("ok1")).toBe(true);
    expect(confirmed.has("gone")).toBe(false); // legitimately stripped
    expect(confirmed.has("blip")).toBe(true); // preserved across the blip
    const warned = warnSpy.mock.calls.flat().join("\n");
    expect(warned).toContain("blip");
    expect(warned).not.toContain("gone,"); // not lumped into the unreachable list
  });

  it("treats an injected getter that throws as unreachable (preserve, not strip)", async () => {
    const config = makeConfig(["alpha"]);
    const prior = composeWith(["alpha"], ["alpha"]);
    const confirmed = await resolveLiteLLMConfirmedAgents(config, prior, {
      getKey: async () => {
        throw new Error("socket ECONNREFUSED");
      },
    });
    expect(confirmed.has("alpha")).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("returns empty (no probe) when no agent opted in", async () => {
    const config = makeConfig([]);
    const getKey = vi.fn(async () => ({ kind: "ok" }));
    const confirmed = await resolveLiteLLMConfirmedAgents(config, null, { getKey });
    expect(confirmed.size).toBe(0);
    expect(getKey).not.toHaveBeenCalled();
  });
});
