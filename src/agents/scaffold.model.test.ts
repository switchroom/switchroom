import { describe, it, expect } from "vitest";
import { resolveMainModel, normalizeModelAlias, SWITCHROOM_DEFAULT_MAIN_MODEL } from "./scaffold.js";
// The gateway `/model` entrypoint — the OTHER site that turns an operator alias
// into a `claude --model` token. These are re-exported by model-command from
// the shared `model-aliases.ts` module; scaffold consumes the same module, so
// the two sites can no longer carry divergent alias tables (#3998).
import {
  CLAUDE_MODEL_ALIASES,
  SR_MODEL_ALIASES,
  expandModelAlias,
} from "../../telegram-plugin/gateway/model-command.js";
import {
  CLAUDE_MODEL_ALIASES as SHARED_CLAUDE_ALIASES,
  SR_MODEL_ALIASES as SHARED_SR_ALIASES,
} from "./model-aliases.js";

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

  // #3998: the class this kills is "two divergent alias tables". Before the
  // shared module, scaffold expanded ONLY the fable codename, so a config
  // `model: opus48` (a shortcut the gateway `/model` path expands to
  // `claude-opus-4-8`) reached `claude --model` VERBATIM and 4xx'd.
  describe("shares ONE alias table with the gateway /model path (#3998)", () => {
    it("resolves the opus48-class pinned-Claude shortcuts to their full ids", () => {
      // These are exactly the shortcuts the gateway accepts; each must now
      // resolve identically when it arrives as a config `model:` default.
      expect(resolveMainModel("opus48")).toBe("claude-opus-4-8");
      expect(resolveMainModel("opus-4-8")).toBe("claude-opus-4-8");
      expect(normalizeModelAlias("opus48")).toBe("claude-opus-4-8");
      // Case-insensitive, matching the gateway's expansion.
      expect(resolveMainModel("OPUS48")).toBe("claude-opus-4-8");
    });

    it("resolves every alias the gateway accepts to the same launch token", () => {
      // Guards against a shortcut being added to the gateway table but not
      // resolving in scaffold — the exact drift that produced the original bug.
      const aliases = [
        ...Object.keys(CLAUDE_MODEL_ALIASES),
        ...Object.keys(SR_MODEL_ALIASES),
      ];
      // Non-empty so the loop can't vacuously pass.
      expect(aliases.length).toBeGreaterThan(0);
      for (const alias of aliases) {
        // resolveMainModel diverges from expandModelAlias ONLY on the
        // `default`/unset footgun remap; no alias-table key is `default`, so
        // the two must agree on every one of them.
        expect(resolveMainModel(alias)).toBe(expandModelAlias(alias));
        // And the resolved value is the full id, never the bare shortcut.
        expect(resolveMainModel(alias)).not.toBe(alias);
      }
    });

    it("uses the SAME table object as the gateway (single source of truth)", () => {
      // Re-export identity: model-command re-exports the shared module's tables
      // rather than declaring its own, so there is exactly one table to drift.
      expect(CLAUDE_MODEL_ALIASES).toBe(SHARED_CLAUDE_ALIASES);
      expect(SR_MODEL_ALIASES).toBe(SHARED_SR_ALIASES);
    });
  });
});
