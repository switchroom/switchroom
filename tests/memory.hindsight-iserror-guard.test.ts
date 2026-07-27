/**
 * Hindsight isError + prompt-carrier source guards (offline, no server).
 *
 * Two structural guards that make the contract-drift bug class CI-red the
 * instant a regression is introduced — complementing the fixture test (which
 * catches tool/arg drift) and the live doctor check (which catches server
 * drift):
 *
 *  A. ISERROR GUARD — every TS function that makes a hindsight MCP tools/call
 *     must inspect result.isError before returning success. A hindsight
 *     tools/call returns HTTP 200 + isError:true on a renamed/unknown arg, so a
 *     callsite that checks only `response.ok` reports false success (the class
 *     that bit createBank/updateBankMissions/create_mental_model).
 *
 *  B. PROMPT-CARRIER GUARD — every mcp__hindsight__<tool> the model is
 *     instructed to call (in any prompt carrier) must be a real server tool
 *     (the delete_memory-in-guidance bug, incident #4).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HINDSIGHT_PROMPT_TOOLS } from "../src/memory/hindsight-tools.js";

const repo = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf-8");

interface Snapshot {
  tools: Record<string, unknown>;
}
const snapshot = JSON.parse(repo("tests/fixtures/hindsight-tools-list.snapshot.json")) as Snapshot;

describe("A. isError guard — every hindsight tools/call checks result.isError", () => {
  const src = repo("src/memory/hindsight.ts");
  // Split into exported function bodies; flag any that issues a tools/call but
  // never establishes that the MCP envelope was inspected.
  const funcs = src.split(/\nexport (?:async )?function /).slice(1);
  const nameOf = (body: string) => body.slice(0, body.indexOf("("));
  const byName = new Map(funcs.map((b) => [nameOf(b), b]));

  /**
   * A callsite satisfies the guard either by inspecting `.isError` itself, or
   * by handing the envelope to a same-file helper that does.
   *
   * The delegated form is not a loophole — it is the stronger shape, and one
   * resolution step is all that is allowed. `addMemoryTag` passes the raw
   * result to `verifyTagWriteResponse`, which checks `.isError` AND reads the
   * returned memory back, because on this backend an unknown *argument* is
   * dropped SILENTLY (isError stays false; verified live on 0.8.4 — the
   * responses with and without `add_tags` are byte-identical). A guard that
   * accepted only a literal `.isError` in the caller would have pushed the
   * verification back inline, i.e. would have forced the weaker check.
   *
   * A callsite that inspects nothing, or delegates to a helper that inspects
   * nothing, still reds.
   */
  const inspectsEnvelope = (body: string, depth = 1): boolean => {
    if (/\.isError/.test(body)) return true;
    if (depth === 0) return false;
    for (const [helper, helperBody] of byName) {
      if (helper === nameOf(body)) continue;
      if (!new RegExp(`\\b${helper}\\s*\\(`).test(body)) continue;
      if (inspectsEnvelope(helperBody, depth - 1)) return true;
    }
    return false;
  };

  for (const body of funcs) {
    const name = nameOf(body);
    const makesToolCall = /method:\s*["']tools\/call["']/.test(body);
    if (!makesToolCall) continue;
    it(`${name} inspects the MCP result envelope`, () => {
      expect(
        inspectsEnvelope(body),
        `${name} makes a hindsight tools/call but neither checks result.isError nor ` +
          `delegates the envelope to a same-file helper that does — a renamed/unknown ` +
          `arg would return HTTP 200 and this would report false success`,
      ).toBe(true);
    });
  }

  it("found the expected tools/call functions (guard is actually scanning)", () => {
    const withToolCall = funcs.filter((b) => /method:\s*["']tools\/call["']/.test(b)).length;
    expect(withToolCall).toBeGreaterThanOrEqual(4); // ensureUserProfileMentalModel, createBank, updateBankMissions, addMemoryTag
  });

  it("the delegation escape hatch does not accept a helper that inspects nothing", () => {
    // Mutation-guard for the guard: a caller whose only helper ignores the
    // envelope must still fail, or the relaxation above would be a loophole.
    const caller = `sham(): void {\n  const r = await post({ method: "tools/call" });\n  blindHelper(r);\n}`;
    const scoped = new Map([["blindHelper", `blindHelper(r) {\n  return { ok: true };\n}`]]);
    const probe = (body: string, depth = 1): boolean => {
      if (/\.isError/.test(body)) return true;
      if (depth === 0) return false;
      for (const [helper, helperBody] of scoped) {
        if (!new RegExp(`\\b${helper}\\s*\\(`).test(body)) continue;
        if (probe(helperBody, depth - 1)) return true;
      }
      return false;
    };
    expect(probe(caller)).toBe(false);
  });
});

describe("B. prompt-carrier guard — instructed tools are real", () => {
  // Gather every mcp__hindsight__<tool> named across all model-facing carriers.
  const carriers = [
    "src/agents/scaffold.ts", // MEMORY_GUIDANCE + renderFleetInvariants source
    "profiles/default/CLAUDE.md.hbs",
    "profiles/default/workspace/CLAUDE.md.hbs",
  ];
  const named = new Set<string>();
  for (const c of carriers) {
    let text = "";
    try {
      text = repo(c);
    } catch {
      continue;
    }
    for (const m of text.matchAll(/mcp__hindsight__([a-z_]+)/g)) named.add(m[1]);
  }

  it("extracted some instructed hindsight tools (guard is scanning the carriers)", () => {
    expect(named.size).toBeGreaterThan(0);
  });

  it("every mcp__hindsight__<tool> named in a prompt carrier is a real server tool (incident #4)", () => {
    for (const tool of named) {
      expect(
        snapshot.tools[tool] !== undefined,
        `a prompt carrier instructs the model to call mcp__hindsight__${tool}, which is NOT a real server tool`,
      ).toBe(true);
    }
  });

  it("the declared prompt-tool set (HINDSIGHT_PROMPT_TOOLS) are all real + actually named in a carrier", () => {
    for (const tool of HINDSIGHT_PROMPT_TOOLS) {
      expect(snapshot.tools[tool], `HINDSIGHT_PROMPT_TOOLS lists ${tool} which is not a real server tool`).toBeDefined();
    }
  });
});
