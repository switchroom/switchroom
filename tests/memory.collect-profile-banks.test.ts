import { describe, it, expect } from "vitest";
import { collectProfileBanks } from "../src/memory/hindsight.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

/**
 * collectProfileBanks underpins profile-bank visibility on every health
 * surface (dashboard Memory tab, `doctor`, `memory stats`). It enumerates the
 * per-user / shared banks recall routes to — from `users.*.profile_bank`,
 * `serves`/`knows`, and explicit `additional_banks`/`sender_banks` — minus any
 * bank that is already an agent's own collection.
 */
function cfg(p: Record<string, unknown>): SwitchroomConfig {
  return {
    agents: {},
    memory: { backend: "hindsight", config: { url: "http://localhost:18888/mcp/" } },
    telegram: { bot_token: "t", forum_chat_id: "c" },
    ...p,
  } as unknown as SwitchroomConfig;
}

const USERS = {
  ken: { telegram_ids: ["1"], profile_bank: "ken-profile" },
  lisa: { telegram_ids: ["2"], profile_bank: "lisa-profile" },
};

describe("collectProfileBanks", () => {
  it("collects users.profile_bank even when not assigned to any agent", () => {
    expect([...collectProfileBanks(cfg({ users: USERS, agents: {} }))].sort()).toEqual([
      "ken-profile",
      "lisa-profile",
    ]);
  });

  it("collects banks from serves (sender_banks) and knows (additional_banks)", () => {
    const c = cfg({
      users: USERS,
      agents: { clerk: { topic_name: "C", serves: ["ken"], knows: ["lisa"] } },
    });
    expect([...collectProfileBanks(c)].sort()).toEqual(["ken-profile", "lisa-profile"]);
  });

  it("collects explicit additional_banks / sender_banks values", () => {
    const c = cfg({
      agents: {
        a: {
          topic_name: "A",
          memory: { recall: { additional_banks: ["shared"], sender_banks: { "9": "vip-profile" } } },
        },
      },
    });
    expect([...collectProfileBanks(c)].sort()).toEqual(["shared", "vip-profile"]);
  });

  it("excludes banks that are an agent's own collection (default)", () => {
    const c = cfg({
      agents: {
        ziggy: { topic_name: "Z" }, // collection = "ziggy"
        clerk: { topic_name: "C", memory: { recall: { additional_banks: ["ziggy", "shared"] } } },
      },
    });
    // "ziggy" is an agent collection → dropped; "shared" stays a profile bank.
    expect([...collectProfileBanks(c)]).toEqual(["shared"]);
  });

  it("can include agent collections when excludeAgentCollections=false", () => {
    const c = cfg({
      agents: {
        ziggy: { topic_name: "Z" },
        clerk: { topic_name: "C", memory: { recall: { additional_banks: ["ziggy"] } } },
      },
    });
    expect([...collectProfileBanks(c, { excludeAgentCollections: false })]).toContain("ziggy");
  });

  it("dedupes a bank referenced by multiple agents/users", () => {
    const c = cfg({
      users: USERS,
      agents: {
        marko: { topic_name: "M", serves: ["ken", "lisa"] },
        lawgpt: { topic_name: "L", serves: ["ken", "lisa"] },
      },
    });
    expect([...collectProfileBanks(c)].sort()).toEqual(["ken-profile", "lisa-profile"]);
  });

  it("empty config → empty set", () => {
    expect(collectProfileBanks(cfg({ agents: {} })).size).toBe(0);
  });
});
