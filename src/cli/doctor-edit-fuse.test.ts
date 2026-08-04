/**
 * `switchroom doctor` edit-flood fuse section.
 *
 * The fuse's own kill-switch parsing is proved in
 * `telegram-plugin/tests/feed-edit-rate-ceiling.test.ts`. What is proved here
 * is the operator-facing wiring: a fuse left enabled (or unset) is silent, a
 * disabled fuse produces a WARN row that names the affected agents, and the
 * decision runs through the SAME env parser the runtime uses (so `false`/`off`
 * — which the runtime does NOT treat as disabling — do not produce a false
 * warning).
 */
import { describe, it, expect } from "vitest";

import { runEditFuseChecks } from "./doctor-edit-fuse.js";
import type { SwitchroomConfig } from "../config/schema.js";

function config(
  agents: Record<string, { env?: Record<string, string> }>,
  defaults?: { env?: Record<string, string> },
): SwitchroomConfig {
  return { agents, defaults } as unknown as SwitchroomConfig;
}

describe("runEditFuseChecks", () => {
  it("is silent when no agent sets the fuse env var", () => {
    const results = runEditFuseChecks(config({ alpha: {}, beta: {} }));
    expect(results).toEqual([]);
  });

  it("is silent when the fuse is explicitly enabled", () => {
    const results = runEditFuseChecks(
      config({ alpha: { env: { SWITCHROOM_EDIT_FUSE: "1" } } }),
    );
    expect(results).toEqual([]);
  });

  it("WARNs when an agent disables the fuse with 0", () => {
    const results = runEditFuseChecks(
      config({ alpha: { env: { SWITCHROOM_EDIT_FUSE: "0" } }, beta: {} }),
    );
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("warn");
    expect(results[0].name).toBe("edit-flood fuse enabled");
    expect(results[0].detail).toContain("alpha");
    expect(results[0].detail).not.toContain("beta");
    expect(results[0].detail).toContain("SWITCHROOM_EDIT_FUSE");
  });

  it("names every disabled agent, including via defaults.env", () => {
    // defaults.env=0 should propagate to every agent via resolveAgentConfig.
    const results = runEditFuseChecks(
      config({ alpha: {}, beta: {} }, { env: { SWITCHROOM_EDIT_FUSE: "0" } }),
    );
    expect(results).toHaveLength(1);
    expect(results[0].detail).toContain("alpha");
    expect(results[0].detail).toContain("beta");
  });

  it("agent env overrides defaults: agent re-enables the fuse → silent", () => {
    const results = runEditFuseChecks(
      config(
        { alpha: { env: { SWITCHROOM_EDIT_FUSE: "1" } } },
        { env: { SWITCHROOM_EDIT_FUSE: "0" } },
      ),
    );
    expect(results).toEqual([]);
  });

  it("does not false-warn on values the runtime keeps enabled (false/off)", () => {
    // edit-flood-fuse.ts treats ONLY '0' as disabling; 'false'/'off' leave the
    // fuse ON. The probe must not claim reduced protection when there is none.
    for (const value of ["false", "off", "no"]) {
      const results = runEditFuseChecks(
        config({ alpha: { env: { SWITCHROOM_EDIT_FUSE: value } } }),
      );
      expect(results).toEqual([]);
    }
  });
});
