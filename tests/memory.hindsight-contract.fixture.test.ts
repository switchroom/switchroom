/**
 * Hindsight MCP contract — offline regression guard (no server).
 *
 * Closes the bug class that bit 5 callsites over 2026-06-06..07: switchroom
 * calling a renamed/removed tool or a renamed/dropped arg, silently. Three
 * cross-checks against the committed golden snapshot of the live tools/list:
 *
 *  1. EXPECTED_HINDSIGHT_TOOLS agrees with the captured server truth (no drift
 *     between the hand-maintained const and the snapshot).
 *  2. Every TS callsite calls a real tool, sends all required args, and sends
 *     NO arg the server doesn't accept (the silent-drop class — types,
 *     retain_mission — that an isError check can never catch).
 *  3. Every prompt-/hook-named tool is a real server tool (the delete_memory
 *     guidance bug, #4).
 *
 * When the offline const/snapshot disagree with reality, refresh the snapshot
 * from the live server and reconcile EXPECTED_HINDSIGHT_TOOLS — the diff IS the
 * upstream contract change you need to handle.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EXPECTED_HINDSIGHT_TOOLS,
  HINDSIGHT_TS_CALLSITES,
  HINDSIGHT_PROMPT_TOOLS,
  HINDSIGHT_HOOK_TOOLS,
} from "../src/memory/hindsight-tools.js";
import { FALLBACK_TOOL_TABLE } from "../src/cli/hindsight-mcp-shim.js";

interface Snapshot {
  tools: Record<string, { required: string[]; props: string[] }>;
}
const snapshot = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures", "hindsight-tools-list.snapshot.json"), "utf-8"),
) as Snapshot;

/** Tool count on the hindsight surface switchroom targets (0.8.5). */
const HINDSIGHT_TOOL_COUNT = 32;

describe("hindsight contract — golden snapshot integrity", () => {
  it(`the snapshot captures all ${HINDSIGHT_TOOL_COUNT} server tools`, () => {
    expect(Object.keys(snapshot.tools).length).toBe(HINDSIGHT_TOOL_COUNT);
  });

  it("EXPECTED_HINDSIGHT_TOOLS agrees with the captured server truth (required-args, no const/snapshot drift)", () => {
    for (const [tool, spec] of Object.entries(EXPECTED_HINDSIGHT_TOOLS)) {
      const real = snapshot.tools[tool];
      expect(real, `expected tool '${tool}' is not in the snapshot — refresh the snapshot / fix the const`).toBeDefined();
      // The hand-maintained `required` intent must match the server exactly.
      // A server rename of a required arg (the source_query class) reds here.
      expect(
        [...spec.required].sort(),
        `'${tool}' required-args drifted from the server (renamed/added/removed upstream)`,
      ).toEqual([...real.required].sort());
    }
  });
});

/**
 * The shim's first-boot fallback manifest is what an agent's tools/list returns
 * when hindsight has never been reachable in that session. If it drifts below
 * the real surface, the affected tools are INVISIBLE to the agent and the
 * symptom is indistinguishable from an upstream removal.
 *
 * That is not hypothetical: the table shipped 29 tools against a 32-tool server
 * for weeks, hiding `update_memory`, `invalidate_memory` and
 * `clear_mental_model` — the tools `switchroom memory demote` and vault-sweep
 * reach for — plus six accepted props. Byte-equality with the snapshot is the
 * deterministic fix; a comment saying "keep these in sync" is not.
 */
describe("hindsight contract — the shim fallback manifest mirrors the snapshot", () => {
  it("advertises exactly the snapshot's tool set (no missing tool, no phantom)", () => {
    expect(Object.keys(FALLBACK_TOOL_TABLE).sort()).toEqual(
      Object.keys(snapshot.tools).sort(),
    );
  });

  for (const tool of Object.keys(snapshot.tools).sort()) {
    it(`${tool}: fallback required+props match the snapshot exactly`, () => {
      const [required, props] = FALLBACK_TOOL_TABLE[tool];
      expect(
        [...required].sort(),
        `fallback '${tool}' required-args drifted from the snapshot`,
      ).toEqual([...snapshot.tools[tool].required].sort());
      expect(
        [...props].sort(),
        `fallback '${tool}' accepted props drifted from the snapshot — a prop ` +
          `missing here is a capability the agent cannot see on first boot`,
      ).toEqual([...snapshot.tools[tool].props].sort());
    });
  }
});

describe("hindsight contract — every TS callsite satisfies the tool schema", () => {
  for (const cs of HINDSIGHT_TS_CALLSITES) {
    it(`${cs.where} → ${cs.tool}(${cs.argKeys.join(",")}) is contract-valid`, () => {
      const real = snapshot.tools[cs.tool];
      // (a) the tool exists.
      expect(real, `${cs.where} calls '${cs.tool}' which the server does not advertise (phantom/renamed)`).toBeDefined();
      // (b) every required arg is sent.
      for (const req of real.required) {
        expect(
          cs.argKeys,
          `${cs.where} omits required arg '${req}' of '${cs.tool}' → the call silently no-ops`,
        ).toContain(req);
      }
      // (c) NO arg sent that the server doesn't accept (silently dropped),
      //     except args explicitly declared unsupported — those are asserted
      //     separately below so the exemption self-invalidates.
      const exempt = new Set(cs.knownUnsupportedArgs ?? []);
      for (const sent of cs.argKeys) {
        if (exempt.has(sent)) continue;
        expect(
          real.props,
          `${cs.where} sends '${sent}' which '${cs.tool}' does NOT accept → SILENTLY DROPPED (isError can't catch this)`,
        ).toContain(sent);
      }
    });

    if (cs.knownUnsupportedArgs?.length) {
      it(`${cs.where} → ${cs.tool}: declared-unsupported args are still unsupported upstream`, () => {
        const real = snapshot.tools[cs.tool];
        expect(real).toBeDefined();
        for (const arg of cs.knownUnsupportedArgs!) {
          expect(
            real.props,
            `'${arg}' is now an accepted prop of '${cs.tool}' — the upstream gap ` +
              `that broke ${cs.where} has CLOSED. Drop the knownUnsupportedArgs ` +
              `exemption and un-break the feature it was blocking.`,
          ).not.toContain(arg);
        }
      });
    }
  }
});

describe("hindsight contract — prompt + hook only name real tools", () => {
  it("every mcp__hindsight__<tool> the model is instructed to use is a real server tool (incident #4)", () => {
    for (const tool of HINDSIGHT_PROMPT_TOOLS) {
      expect(snapshot.tools[tool], `guidance names mcp__hindsight__${tool} which is not a real server tool`).toBeDefined();
    }
  });

  it("every tool the user-profile-refresh hook calls is a real server tool", () => {
    for (const tool of HINDSIGHT_HOOK_TOOLS) {
      expect(snapshot.tools[tool], `the refresh hook calls '${tool}' which is not a real server tool`).toBeDefined();
    }
  });
});
