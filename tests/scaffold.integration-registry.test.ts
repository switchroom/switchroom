/**
 * Regression-gate tests for the integration MCP registry in
 * `src/agents/scaffold.ts`.
 *
 * Three load-bearing invariants:
 *
 *   1. **Emit/retract symmetry**: when a resolver returns null, the
 *      site that retracts must delete the SAME key the resolver
 *      would have emitted. Today every integration's `emitKey` ===
 *      `retractionKey`, but they're declared as separate fields so a
 *      future drift can't slip through. This test pins that they
 *      stay synchronized.
 *
 *   2. **Iteration order**: gdrive → ms-365 → notion. Pinned so a
 *      reorder in the registry can't silently change which
 *      integration wins on a hypothetical key collision (and, more
 *      practically, so the user-spread at Site 2 always lands after
 *      all framework integrations in deterministic order).
 *
 *   3. **All three integrations registered**: a future integration
 *      added by appending to the registry shouldn't accidentally
 *      drop one of the existing three. Defensive — but cheap.
 *
 * The end-to-end emit/retract behaviour at each of the four scaffold
 * call sites (settings.json scaffold, .mcp.json scaffold,
 * settings.json reconcile, .mcp.json reconcile) is covered by the
 * existing scaffold tests; this file is the registry-shape
 * regression gate.
 */

import { describe, expect, it } from "vitest";

import { INTEGRATION_MCP_RESOLVERS } from "../src/agents/scaffold.js";

describe("INTEGRATION_MCP_RESOLVERS — registry shape", () => {
  it("contains exactly the three shipped integrations in order", () => {
    const labels = INTEGRATION_MCP_RESOLVERS.map((i) => i.label);
    expect(labels).toEqual([
      "Google Workspace",
      "Microsoft 365",
      "Notion",
      "Webkite",
    ]);
  });

  it("each entry has matching emitKey and retractionKey (today's invariant)", () => {
    // Today every integration's emit key equals its retraction key
    // (gdrive/gdrive, ms-365/ms-365, notion/notion). Keep them as
    // separate fields so a future divergence is explicit, but pin
    // the current state — a silent drift here is exactly the bug
    // class the separate fields exist to catch.
    for (const integration of INTEGRATION_MCP_RESOLVERS) {
      expect(integration.emitKey).toBe(integration.retractionKey);
    }
  });

  it("emitKeys are unique (no two integrations collide)", () => {
    const keys = INTEGRATION_MCP_RESOLVERS.map((i) => i.emitKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("retractionKeys are unique (no two integrations would retract each other)", () => {
    const keys = INTEGRATION_MCP_RESOLVERS.map((i) => i.retractionKey);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("expected keys are present", () => {
    const keys = INTEGRATION_MCP_RESOLVERS.map((i) => i.emitKey);
    expect(keys).toContain("gdrive");
    expect(keys).toContain("ms-365");
    expect(keys).toContain("notion");
    expect(keys).toContain("webkite");
  });

  it("each resolver is callable and accepts the (name, agentConfig, switchroomConfig) shape", () => {
    // Call each with a minimal disable config + per-server opt-out so
    // every resolver returns null. Webkite is fleet-default (no opt-in
    // gate) so the opt-out flag is required for it to return null —
    // gdrive/m365/notion gate on their workspace blocks which are
    // absent here, so they return null without the flag either way.
    const optOutAll = {
      mcp_servers: { gdrive: false, "ms-365": false, notion: false, webkite: false },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
    for (const integration of INTEGRATION_MCP_RESOLVERS) {
      const result = integration.resolve(
        "test-agent",
        optOutAll,
        undefined,
      );
      expect(result).toBeNull();
    }
  });

  it("webkite resolver emits the canonical entry when not opted out", () => {
    const webkite = INTEGRATION_MCP_RESOLVERS.find((i) => i.emitKey === "webkite");
    expect(webkite).toBeDefined();
    const result = webkite!.resolve(
      "test-agent",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      undefined,
    );
    expect(result).toEqual({
      key: "webkite",
      value: { command: "webkite", args: ["mcp"] },
    });
  });

  it("webkite resolver returns null when the agent opts out", () => {
    const webkite = INTEGRATION_MCP_RESOLVERS.find((i) => i.emitKey === "webkite");
    const result = webkite!.resolve(
      "test-agent",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { mcp_servers: { webkite: false } } as any,
      undefined,
    );
    expect(result).toBeNull();
  });
});
