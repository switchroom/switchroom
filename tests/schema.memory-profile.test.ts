import { describe, it, expect } from "vitest";
import {
  resolveMemoryProfile,
  DEFAULT_PROFILE,
  AgentMemorySchema,
  ProfileSchema,
  AgentDefaultsSchema,
} from "../src/config/schema.js";

/**
 * `memory.profile` decouples the MEMORY profile (which curated disposition +
 * observations_mission bundle a bank keys off, in PROFILE_MEMORY_DEFAULTS) from
 * `extends` (the filesystem PERSONA profile). An agent can run the `default`
 * persona while opting its bank into the `coding` memory bundle.
 *
 * These are the pure-precedence unit tests. Each fails if `resolveMemoryProfile`
 * is reverted to a bare `extends ?? DEFAULT_PROFILE` (the historical behaviour):
 * the first case would then return `default` instead of `coding`.
 */
describe("resolveMemoryProfile", () => {
  it("explicit memory.profile wins over extends", () => {
    expect(
      resolveMemoryProfile({ extends: "default", memory: { profile: "coding" } }),
    ).toBe("coding");
    // Even when extends names a different real profile.
    expect(
      resolveMemoryProfile({ extends: "health-coach", memory: { profile: "coding" } }),
    ).toBe("coding");
  });

  it("falls back to extends when memory.profile is unset", () => {
    expect(resolveMemoryProfile({ extends: "coding" })).toBe("coding");
    expect(resolveMemoryProfile({ extends: "coding", memory: {} })).toBe("coding");
    // A memory block present but without `profile` must not shadow extends.
    expect(
      resolveMemoryProfile({ extends: "health-coach", memory: { profile: undefined } }),
    ).toBe("health-coach");
  });

  it("falls back to DEFAULT_PROFILE when neither is set", () => {
    expect(resolveMemoryProfile({})).toBe(DEFAULT_PROFILE);
    expect(resolveMemoryProfile(undefined)).toBe(DEFAULT_PROFILE);
    expect(resolveMemoryProfile({ memory: {} })).toBe(DEFAULT_PROFILE);
  });

  // Back-compat: for every agent that does NOT set memory.profile, the resolved
  // value is byte-identical to the historical `extends ?? DEFAULT_PROFILE`, so
  // this change is a pure no-op for the entire existing fleet (zero migration).
  it("is byte-identical to `extends ?? DEFAULT_PROFILE` whenever memory.profile is unset", () => {
    for (const extendsVal of [undefined, "default", "coding", "health-coach", "executive-assistant"]) {
      const legacy = extendsVal ?? DEFAULT_PROFILE;
      expect(resolveMemoryProfile({ extends: extendsVal })).toBe(legacy);
      expect(resolveMemoryProfile({ extends: extendsVal, memory: { collection: "b" } })).toBe(legacy);
    }
  });
});

describe("memory.profile schema acceptance", () => {
  it("AgentMemorySchema accepts an optional profile string and defaults it undefined", () => {
    expect(AgentMemorySchema.parse({ collection: "b" }).profile).toBeUndefined();
    expect(AgentMemorySchema.parse({ collection: "b", profile: "coding" }).profile).toBe("coding");
  });

  it("cascades from the defaults/profile tier too (mirror), so `defaults.memory.profile` is not stripped", () => {
    expect(AgentDefaultsSchema.parse({ memory: { profile: "coding" } })?.memory?.profile).toBe(
      "coding",
    );
    expect(ProfileSchema.parse({ memory: { profile: "coding" } }).memory?.profile).toBe("coding");
  });
});
