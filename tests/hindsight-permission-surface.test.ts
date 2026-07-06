import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HINDSIGHT_MCP_TOOLS,
  HINDSIGHT_MENTAL_MODEL_WRITE_TOOLS,
} from "../src/agents/scaffold.js";

/**
 * Pins the pre-approved Hindsight MCP permission surface (Fix 1.2, #2903).
 *
 * The scaffold used to pre-approve `mcp__hindsight__*` (a wildcard), which
 * silently pre-approved the mental-model WRITE tools and thereby bypassed the
 * agent-proposes / human-approves gate. This test snapshots exactly which
 * tools are pre-approved so any future change (especially re-introducing a
 * wildcard, or adding a mental-model write) is a deliberate, reviewed edit.
 */
describe("Hindsight pre-approved permission surface (Fix 1.2, #2903)", () => {
  const snapshot = JSON.parse(
    readFileSync(
      join(__dirname, "fixtures", "hindsight-tools-list.snapshot.json"),
      "utf-8",
    ),
  ) as { tools: Record<string, unknown> };
  const allEngineTools = Object.keys(snapshot.tools).sort();

  it("never pre-approves a wildcard or bare server grant", () => {
    expect(HINDSIGHT_MCP_TOOLS).not.toContain("mcp__hindsight__*");
    expect(HINDSIGHT_MCP_TOOLS).not.toContain("mcp__hindsight");
    for (const t of HINDSIGHT_MCP_TOOLS) {
      expect(t.startsWith("mcp__hindsight__")).toBe(true);
      expect(t.endsWith("*")).toBe(false);
    }
  });

  it("pre-approves exactly this enumerated set (change = deliberate)", () => {
    expect([...HINDSIGHT_MCP_TOOLS].sort()).toEqual([
      "mcp__hindsight__cancel_operation",
      "mcp__hindsight__clear_memories",
      "mcp__hindsight__create_bank",
      "mcp__hindsight__create_directive",
      "mcp__hindsight__delete_bank",
      "mcp__hindsight__delete_directive",
      "mcp__hindsight__delete_document",
      "mcp__hindsight__get_bank",
      "mcp__hindsight__get_bank_stats",
      "mcp__hindsight__get_document",
      "mcp__hindsight__get_memory",
      "mcp__hindsight__get_mental_model",
      "mcp__hindsight__get_operation",
      "mcp__hindsight__list_banks",
      "mcp__hindsight__list_directives",
      "mcp__hindsight__list_documents",
      "mcp__hindsight__list_memories",
      "mcp__hindsight__list_mental_models",
      "mcp__hindsight__list_operations",
      "mcp__hindsight__list_tags",
      "mcp__hindsight__recall",
      "mcp__hindsight__reflect",
      "mcp__hindsight__retain",
      "mcp__hindsight__sync_retain",
      "mcp__hindsight__update_bank",
    ]);
  });

  it("NEVER pre-approves a mental-model write tool (they route through the propose card)", () => {
    for (const w of HINDSIGHT_MENTAL_MODEL_WRITE_TOOLS) {
      expect(HINDSIGHT_MCP_TOOLS).not.toContain(w);
    }
    // The write set matches the mutating mental-model tools in the surface.
    expect([...HINDSIGHT_MENTAL_MODEL_WRITE_TOOLS].sort()).toEqual([
      "mcp__hindsight__create_mental_model",
      "mcp__hindsight__delete_mental_model",
      "mcp__hindsight__refresh_mental_model",
      "mcp__hindsight__update_mental_model",
    ]);
  });

  it("every pre-approved tool corresponds to a real tool in the engine surface", () => {
    for (const t of HINDSIGHT_MCP_TOOLS) {
      const bare = t.replace("mcp__hindsight__", "");
      expect(
        allEngineTools,
        `${bare} not present in the captured 29-tool surface`,
      ).toContain(bare);
    }
  });

  it("read-only mental-model tools ARE pre-approved (get/list), writes are not", () => {
    expect(HINDSIGHT_MCP_TOOLS).toContain("mcp__hindsight__get_mental_model");
    expect(HINDSIGHT_MCP_TOOLS).toContain("mcp__hindsight__list_mental_models");
    expect(HINDSIGHT_MCP_TOOLS).not.toContain(
      "mcp__hindsight__create_mental_model",
    );
  });
});
