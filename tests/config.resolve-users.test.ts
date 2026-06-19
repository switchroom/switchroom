import { describe, it, expect } from "vitest";
import { resolveUsers } from "../src/config/users.js";
import { SwitchroomConfigSchema } from "../src/config/schema.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

/**
 * First-class users (RFC reference/rfcs/user-concept.md, memory-routing phase):
 * `users:` + agent `serves`/`knows` resolve (with UNION semantics) into the
 * recall maps the scaffold emits — `serves` → sender_banks (speaker routing),
 * `knows` → additional_banks (subject knowledge).
 */

function cfg(partial: Record<string, unknown>): SwitchroomConfig {
  return {
    agents: {},
    memory: { backend: "hindsight", config: { url: "http://localhost:18888/mcp/" } },
    telegram: { bot_token: "t", forum_chat_id: "c" },
    ...partial,
  } as unknown as SwitchroomConfig;
}

const USERS = {
  ken: { telegram_ids: ["mekenthompson", "111"], profile_bank: "ken-profile" },
  lisa: { telegram_ids: ["8201250670"], profile_bank: "lisa-profile" },
};

describe("resolveUsers — serves/knows → recall maps", () => {
  it("serves maps each served user's telegram_ids to their profile_bank", () => {
    const r = resolveUsers(cfg({ users: USERS, agents: { ziggy: { serves: ["lisa"] } } }), "ziggy");
    expect(r.senderBanks).toEqual({ "8201250670": "lisa-profile" });
    expect(r.additionalBanks).toEqual([]);
  });

  it("multiple served users, multiple ids each", () => {
    const r = resolveUsers(cfg({ users: USERS, agents: { marko: { serves: ["ken", "lisa"] } } }), "marko");
    expect(r.senderBanks).toEqual({
      mekenthompson: "ken-profile",
      "111": "ken-profile",
      "8201250670": "lisa-profile",
    });
  });

  it("knows resolves a user → profile_bank, and passes a raw bank through", () => {
    const r = resolveUsers(
      cfg({ users: USERS, agents: { clerk: { serves: ["ken"], knows: ["lisa", "kids-profile"] } } }),
      "clerk",
    );
    expect(r.senderBanks).toEqual({ mekenthompson: "ken-profile", "111": "ken-profile" });
    expect(r.additionalBanks.sort()).toEqual(["kids-profile", "lisa-profile"]);
  });

  it("defaults.serves unions with per-agent serves (not replace)", () => {
    const r = resolveUsers(
      cfg({ users: USERS, defaults: { serves: ["ken"] }, agents: { ziggy: { serves: ["lisa"] } } }),
      "ziggy",
    );
    expect(r.senderBanks.mekenthompson).toBe("ken-profile");
    expect(r.senderBanks["8201250670"]).toBe("lisa-profile");
  });

  it("explicit memory.recall maps union with the generated maps", () => {
    const r = resolveUsers(
      cfg({
        users: USERS,
        agents: {
          marko: {
            serves: ["lisa"],
            knows: ["kids-profile"],
            memory: { recall: { sender_banks: { "999": "ken-profile" }, additional_banks: ["shared"] } },
          },
        },
      }),
      "marko",
    );
    expect(r.senderBanks).toEqual({ "8201250670": "lisa-profile", "999": "ken-profile" });
    expect(r.additionalBanks.sort()).toEqual(["kids-profile", "shared"]);
  });

  it("explicit sender_banks wins on a key conflict with the generated map", () => {
    const r = resolveUsers(
      cfg({
        users: USERS,
        agents: {
          marko: {
            serves: ["lisa"],
            memory: { recall: { sender_banks: { "8201250670": "override-bank" } } },
          },
        },
      }),
      "marko",
    );
    // lisa's id 8201250670 generates → lisa-profile, but the explicit map wins.
    expect(r.senderBanks["8201250670"]).toBe("override-bank");
  });

  it("unknown served user is skipped defensively (no throw)", () => {
    const r = resolveUsers(cfg({ users: USERS, agents: { x: { serves: ["ghost"] } } }), "x");
    expect(r.senderBanks).toEqual({});
  });

  it("no users block → empty maps (fleet behaves as today)", () => {
    const r = resolveUsers(cfg({ agents: { x: {} } }), "x");
    expect(r.senderBanks).toEqual({});
    expect(r.additionalBanks).toEqual([]);
  });
});

describe("schema — serves must reference a defined user", () => {
  // The superRefine only runs once the object validly parses, so the test
  // configs carry the required `telegram` + agent `topic_name` (a real
  // switchroom.yaml always has them).
  const TELEGRAM = { bot_token: "t", forum_chat_id: "123" };

  it("flags serves referencing an unknown user", () => {
    const r = SwitchroomConfigSchema.safeParse({
      switchroom: { version: 1 },
      telegram: TELEGRAM,
      users: { ken: { telegram_ids: ["x"], profile_bank: "ken-profile" } },
      agents: { ziggy: { topic_name: "Ziggy", serves: ["lisa"] } },
    });
    const issues = r.success ? [] : r.error.issues;
    expect(issues.some((i) => i.message.includes('unknown user "lisa"'))).toBe(true);
  });

  it("does NOT flag serves referencing a defined user", () => {
    const r = SwitchroomConfigSchema.safeParse({
      switchroom: { version: 1 },
      telegram: TELEGRAM,
      users: { lisa: { telegram_ids: ["x"], profile_bank: "lisa-profile" } },
      agents: { ziggy: { topic_name: "Ziggy", serves: ["lisa"] } },
    });
    const issues = r.success ? [] : r.error.issues;
    expect(issues.some((i) => i.message.includes("unknown user"))).toBe(false);
  });

  it("does NOT flag knows entries (user-or-bank, permissive)", () => {
    const r = SwitchroomConfigSchema.safeParse({
      switchroom: { version: 1 },
      telegram: TELEGRAM,
      users: { ken: { telegram_ids: ["x"], profile_bank: "ken-profile" } },
      agents: { clerk: { topic_name: "Clerk", serves: ["ken"], knows: ["lisa", "kids-profile"] } },
    });
    const issues = r.success ? [] : r.error.issues;
    expect(issues.some((i) => i.message.includes("unknown user"))).toBe(false);
  });
});
