import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  HINDSIGHT_MCP_TOOLS,
  HINDSIGHT_MENTAL_MODEL_WRITE_TOOLS,
} from "../src/agents/scaffold.js";
import { SYNTHESIZED_TOOL_NAMES } from "../src/cli/hindsight-mcp-shim.js";

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
      "mcp__hindsight__create_bank",
      "mcp__hindsight__create_directive",
      "mcp__hindsight__deactivate_directive",
      "mcp__hindsight__delete_document",
      "mcp__hindsight__get_bank",
      "mcp__hindsight__get_bank_stats",
      "mcp__hindsight__get_document",
      "mcp__hindsight__get_knowledge_page",
      "mcp__hindsight__get_knowledge_tree",
      "mcp__hindsight__get_memory",
      "mcp__hindsight__get_mental_model",
      "mcp__hindsight__get_operation",
      "mcp__hindsight__invalidate_memory",
      "mcp__hindsight__list_banks",
      "mcp__hindsight__list_directives",
      "mcp__hindsight__list_documents",
      "mcp__hindsight__list_memories",
      "mcp__hindsight__list_mental_models",
      "mcp__hindsight__list_operations",
      "mcp__hindsight__list_tags",
      "mcp__hindsight__reactivate_directive",
      "mcp__hindsight__recall",
      "mcp__hindsight__reflect",
      "mcp__hindsight__retain",
      "mcp__hindsight__search_knowledge_pages",
      "mcp__hindsight__sync_retain",
      "mcp__hindsight__update_bank",
      "mcp__hindsight__update_memory",
    ]);
  });

  it("NEVER pre-approves the destructive tools demoted to a permission prompt (#2911)", () => {
    // Least-privilege: these fall through to a Claude Code permission prompt
    // (→ Telegram approval card) instead of silent pre-approval. No automated
    // flow depends on their pre-approval (verified by whole-repo grep in #2911).
    for (const destructive of [
      "mcp__hindsight__delete_bank",
      "mcp__hindsight__clear_memories",
      "mcp__hindsight__delete_directive",
    ]) {
      expect(
        HINDSIGHT_MCP_TOOLS,
        `${destructive} must NOT be pre-approved — it should require a per-call permission prompt (#2911)`,
      ).not.toContain(destructive);
    }
    // delete_document STAYS pre-approved: MEMORY_GUIDANCE instructs the agent
    // to call it autonomously for corrections / "forget that" (automated flow).
    expect(HINDSIGHT_MCP_TOOLS).toContain("mcp__hindsight__delete_document");
  });

  it("pre-approves the REVERSIBLE memory writes but NOT the permanent memory wipe", () => {
    // invalidate_memory (soft-retire with a `restore` path) and update_memory
    // (in-place edit) are reversible, so they ride with the read/retain surface
    // instead of raising a per-call Telegram card on every correction. The
    // permanently-destructive clear_memories stays gated.
    expect(HINDSIGHT_MCP_TOOLS).toContain("mcp__hindsight__invalidate_memory");
    expect(HINDSIGHT_MCP_TOOLS).toContain("mcp__hindsight__update_memory");
    expect(HINDSIGHT_MCP_TOOLS).not.toContain("mcp__hindsight__clear_memories");
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

  /**
   * The carve-out, stated as an assertion rather than a comment.
   *
   * Every pre-approved name must be EITHER a real backend tool OR a
   * shim-synthesized one — nothing else. A typo'd or hallucinated tool name
   * still fails here, which is the property the original test bought; the only
   * thing that changed is that a synthesized name is a legal second bucket,
   * and the buckets are proven disjoint below so the exemption can't be used
   * to smuggle a backend tool in unreviewed.
   */
  it("every pre-approved tool is either a real engine tool or an explicitly synthesized one", () => {
    for (const t of HINDSIGHT_MCP_TOOLS) {
      const bare = t.replace("mcp__hindsight__", "");
      expect(
        allEngineTools.includes(bare) || SYNTHESIZED_TOOL_NAMES.includes(bare),
        `${bare} is neither in the captured engine surface nor in the shim's ` +
          `SYNTHESIZED_TOOL_TABLE — a pre-approved tool that nothing implements`,
      ).toBe(true);
    }
  });

  it("the synthesized names are not engine tools (the exemption cannot shadow a real one)", () => {
    for (const bare of SYNTHESIZED_TOOL_NAMES) {
      expect(
        allEngineTools,
        `'${bare}' is now a real hindsight tool — retire the shim synthesis ` +
          `rather than shadowing the backend's implementation`,
      ).not.toContain(bare);
    }
  });

  /**
   * The #2911 reversal is scoped to DEACTIVATION. This asserts the scope in
   * both directions so a later "while we're here" edit cannot quietly widen
   * it: deactivate/reactivate pre-approved, delete still gated.
   */
  it("deactivation is pre-approved but deletion is NOT (the #2911 reversal is scoped)", () => {
    expect(HINDSIGHT_MCP_TOOLS).toContain(
      "mcp__hindsight__deactivate_directive",
    );
    expect(HINDSIGHT_MCP_TOOLS).toContain(
      "mcp__hindsight__reactivate_directive",
    );
    expect(
      HINDSIGHT_MCP_TOOLS,
      "delete_directive destroys a guardrail irrecoverably (no directive " +
        "history table upstream) — it must keep its per-call approval card. " +
        "Deactivation being pre-approved is not a precedent for deletion.",
    ).not.toContain("mcp__hindsight__delete_directive");
  });

  /**
   * The knowledge-page surface is READS ONLY, asserted in both directions.
   *
   * The three reads are pre-approved; no page-authoring name may appear here,
   * and none is synthesized at all (KnowledgeAdmin has no write method). Page
   * DELETE upstream removes the page and its backing mental model with no
   * undo, so a "while we're here" write addition must fail loudly rather than
   * inherit the reads' pre-approval.
   */
  it("knowledge-page READS are pre-approved and no page WRITE is", () => {
    for (const read of [
      "mcp__hindsight__search_knowledge_pages",
      "mcp__hindsight__get_knowledge_page",
      "mcp__hindsight__get_knowledge_tree",
    ]) {
      expect(HINDSIGHT_MCP_TOOLS).toContain(read);
    }
    for (const write of [
      "mcp__hindsight__create_knowledge_page",
      "mcp__hindsight__create_knowledge_folder",
      "mcp__hindsight__update_knowledge_node",
      "mcp__hindsight__delete_knowledge_node",
    ]) {
      expect(
        HINDSIGHT_MCP_TOOLS,
        `${write} would pre-approve knowledge-page authorship/deletion — the ` +
          `shim deliberately synthesizes reads only (KnowledgeAdmin is GET-only)`,
      ).not.toContain(write);
      expect(SYNTHESIZED_TOOL_NAMES).not.toContain(
        write.replace("mcp__hindsight__", ""),
      );
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
