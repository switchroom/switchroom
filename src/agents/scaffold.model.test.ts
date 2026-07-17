import { describe, it, expect } from "vitest";
import { resolveMainModel, normalizeModelAlias, SWITCHROOM_DEFAULT_MAIN_MODEL } from "./scaffold.js";

// The ONE model resolver — shared by the scaffold bake, `agent list --json`,
// and the launcher's boot-time `agent effective-model` read. These pin the
// mapping so launcher and gateway can never disagree.
describe("resolveMainModel / normalizeModelAlias", () => {
  it("maps unset and the `default` alias to the switchroom default (account-default 4xx footgun)", () => {
    expect(resolveMainModel(undefined)).toBe(SWITCHROOM_DEFAULT_MAIN_MODEL);
    expect(resolveMainModel("default")).toBe(SWITCHROOM_DEFAULT_MAIN_MODEL);
  });

  it("passes real ids and aliases through unchanged", () => {
    expect(resolveMainModel("opus")).toBe("opus");
    expect(resolveMainModel("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(resolveMainModel("sr-glm-5")).toBe("sr-glm-5");
    expect(resolveMainModel("fable")).toBe("fable");
  });

  it("never emits the retired claude-fable-5 codename — normalizes to the fable alias", () => {
    // The codename 4xxs direct-to-Anthropic; only the alias is safe to
    // launch/persist (the CLI maps it via ANTHROPIC_DEFAULT_FABLE_MODEL).
    expect(resolveMainModel("claude-fable-5")).toBe("fable");
    expect(normalizeModelAlias("claude-fable-5")).toBe("fable");
    expect(normalizeModelAlias("fable")).toBe("fable");
    expect(normalizeModelAlias("claude-sonnet-5")).toBe("claude-sonnet-5");
  });
});
