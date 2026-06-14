/**
 * Tests for `buildWhoami` — the agent's legible "what am I allowed to do"
 * view. Pins the access-model contracts: drift-free (computed from the SAME
 * enforcement functions), resolved-not-raw config, and NO secret values.
 */

import { describe, it, expect } from "vitest";
import { buildWhoami } from "./agent-config.js";
import { checkAclByAgent } from "../vault/broker/acl.js";
import type { SwitchroomConfig } from "../config/schema.js";

const CFG = {
  switchroom: { agents_dir: "/tmp/agents" },
  telegram: { forum_chat_id: "0" },
  defaults: { tools: { allow: ["Read"] } },
  profiles: {},
  hostd: { config_edit_enabled: true },
  memory: { backend: "hindsight" },
  agents: {
    clerk: {
      admin: true,
      model: "sonnet",
      description: "desk assistant",
      tools: { allow: ["Edit(/state/x.ts)"], deny: ["Bash(rm:*)"] },
      mcp_servers: { hindsight: {}, "agent-config": {} },
      skills: ["calendar"],
      secrets: ["clerk/api-key"],
      bot_token: "vault:clerk-bot-token",
      schedule: [{ name: "p", at: "0 * * * *" }],
    },
    overlord: { root: true },
    plain: {},
  },
} as unknown as SwitchroomConfig;

describe("buildWhoami", () => {
  it("reports tier from admin/root flags", () => {
    expect(buildWhoami(CFG, "clerk").tier).toBe("admin");
    expect(buildWhoami(CFG, "overlord").tier).toBe("root");
    expect(buildWhoami(CFG, "plain").tier).toBe("standard");
  });

  it("surfaces the agent's RESOLVED tools (cascade-merged, not the raw slice)", () => {
    const w = buildWhoami(CFG, "clerk");
    expect(w.tools.allow).toContain("Edit(/state/x.ts)"); // agent's own
    // defaults.tools.allow=["Read"] is merged in — proves whoami reads the
    // resolved cascade (resolveAgentConfig), not the raw config.agents slice.
    expect(w.tools.allow).toContain("Read");
    expect(w.tools.deny).toContain("Bash(rm:*)");
  });

  it("lists MCP servers and skills", () => {
    const w = buildWhoami(CFG, "clerk");
    expect(w.mcpServers).toEqual(expect.arrayContaining(["hindsight", "agent-config"]));
    expect(w.skills).toContain("calendar");
  });

  it("reports vault KEY NAMES (from secrets[] and vault: refs), never values", () => {
    const w = buildWhoami(CFG, "clerk");
    const keys = w.vault.map((v) => v.key);
    expect(keys).toContain("clerk/api-key"); // from secrets[]
    expect(keys).toContain("clerk-bot-token"); // from the `vault:` ref, prefix stripped
    // No secret VALUE / raw `vault:` ref leaks anywhere in the view.
    const json = JSON.stringify(w);
    expect(json).not.toContain("vault:clerk-bot-token");
  });

  it("vault.readable is sourced from the SAME enforcer (anti-drift)", () => {
    const w = buildWhoami(CFG, "clerk");
    for (const entry of w.vault) {
      expect(entry.readable).toBe(checkAclByAgent(CFG, "clerk", entry.key).allow);
    }
  });

  it("reports powers from config (admin/root/config-edit/cross-agent)", () => {
    expect(buildWhoami(CFG, "clerk").powers).toEqual({
      admin: true,
      root: false,
      configEdit: true,
      crossAgentHostVerbs: true,
    });
    expect(buildWhoami(CFG, "plain").powers).toEqual({
      admin: false,
      root: false,
      configEdit: true, // config-edit is a fleet flag, independent of admin
      crossAgentHostVerbs: false,
    });
  });

  it("carries persona, model, schedule count, memory backend", () => {
    const w = buildWhoami(CFG, "clerk");
    expect(w.persona).toBe("desk assistant");
    expect(w.model).toBe("sonnet");
    expect(w.scheduleCount).toBe(1);
    expect(w.memoryBackend).toBe("hindsight");
  });

  it("throws for an unknown agent", () => {
    expect(() => buildWhoami(CFG, "nope")).toThrow(/not defined/);
  });
});
