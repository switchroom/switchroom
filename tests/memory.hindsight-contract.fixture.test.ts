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

interface Snapshot {
  tools: Record<string, { required: string[]; props: string[] }>;
}
const snapshot = JSON.parse(
  readFileSync(resolve(__dirname, "fixtures", "hindsight-tools-list.snapshot.json"), "utf-8"),
) as Snapshot;

describe("hindsight contract — golden snapshot integrity", () => {
  it("the snapshot captures all 29 server tools", () => {
    expect(Object.keys(snapshot.tools).length).toBe(29);
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
      // (c) NO arg sent that the server doesn't accept (silently dropped).
      for (const sent of cs.argKeys) {
        expect(
          real.props,
          `${cs.where} sends '${sent}' which '${cs.tool}' does NOT accept → SILENTLY DROPPED (isError can't catch this)`,
        ).toContain(sent);
      }
    });
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
