import { describe, it, expect } from "vitest";
import { resolvePersonEntries } from "../src/config/users.js";
import { SwitchroomConfigSchema } from "../src/config/schema.js";
import type { SwitchroomConfig } from "../src/config/schema.js";

/**
 * person_id name resolution (docs/configuration.md). `resolvePersonEntries`
 * is a DUMB raw projection only — no dedup/validation (that's the
 * gateway-side boot-time job, telegram-plugin/gateway/resolve-person.ts).
 */

function cfg(partial: Record<string, unknown>): SwitchroomConfig {
  return {
    agents: {},
    memory: { backend: "hindsight", config: { url: "http://localhost:18888/mcp/" } },
    telegram: { bot_token: "t", forum_chat_id: "c" },
    ...partial,
  } as unknown as SwitchroomConfig;
}

describe("resolvePersonEntries — raw projection of users: person_id entries", () => {
  it("projects a user with person_id set", () => {
    const entries = resolvePersonEntries(
      cfg({
        users: {
          lisa: { telegram_ids: ["8201250670"], profile_bank: "lisa-profile", person_id: "Lisa" },
        },
      }),
    );
    expect(entries).toEqual([{ key: "lisa", person_id: "Lisa", telegram_ids: ["8201250670"] }]);
  });

  it("skips users without person_id set", () => {
    const entries = resolvePersonEntries(
      cfg({
        users: {
          ken: { telegram_ids: ["111"], profile_bank: "ken-profile" },
          lisa: { telegram_ids: ["8201250670"], profile_bank: "lisa-profile", person_id: "Lisa" },
        },
      }),
    );
    expect(entries).toEqual([{ key: "lisa", person_id: "Lisa", telegram_ids: ["8201250670"] }]);
  });

  it("no users block → empty array", () => {
    expect(resolvePersonEntries(cfg({}))).toEqual([]);
  });

  it("does not dedup or validate — that's the gateway boot-time job", () => {
    // Two different users declaring the same person_id is NOT rejected
    // here; buildPersonDirectory (gateway-side) is the one that drops the
    // duplicate at boot and alerts.
    const entries = resolvePersonEntries(
      cfg({
        users: {
          a: { telegram_ids: ["1"], profile_bank: "a-profile", person_id: "Same" },
          b: { telegram_ids: ["2"], profile_bank: "b-profile", person_id: "Same" },
        },
      }),
    );
    expect(entries).toHaveLength(2);
  });
});

describe("schema — users.<key>.person_id", () => {
  const TELEGRAM = { bot_token: "t", forum_chat_id: "123" };

  it("accepts a user with person_id set", () => {
    const r = SwitchroomConfigSchema.safeParse({
      switchroom: { version: 1 },
      telegram: TELEGRAM,
      users: { lisa: { telegram_ids: ["x"], profile_bank: "lisa-profile", person_id: "Lisa" } },
      agents: {},
    });
    expect(r.success).toBe(true);
  });

  it("person_id is optional — a user without it still parses", () => {
    const r = SwitchroomConfigSchema.safeParse({
      switchroom: { version: 1 },
      telegram: TELEGRAM,
      users: { ken: { telegram_ids: ["x"], profile_bank: "ken-profile" } },
      agents: {},
    });
    expect(r.success).toBe(true);
  });

  it("rejects a non-string person_id", () => {
    const r = SwitchroomConfigSchema.safeParse({
      switchroom: { version: 1 },
      telegram: TELEGRAM,
      users: { lisa: { telegram_ids: ["x"], profile_bank: "lisa-profile", person_id: 42 } },
      agents: {},
    });
    expect(r.success).toBe(false);
  });
});
