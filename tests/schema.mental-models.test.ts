import { describe, it, expect } from "vitest";
import { AgentMemorySchema } from "../src/config/schema.js";

/**
 * Phase 5 config surface — `memory.mental_models[]`.
 */
describe("AgentMemorySchema.mental_models", () => {
  it("accepts a valid per-specialist declaration", () => {
    const parsed = AgentMemorySchema.parse({
      collection: "b",
      mental_models: [
        { name: "training-plan-state", source_query: "What is the plan?" },
        {
          name: "injury-history",
          source_query: "What injuries?",
          refresh_after_consolidation: true,
          max_tokens: 2048,
        },
      ],
    });
    expect(parsed.mental_models).toHaveLength(2);
    expect(parsed.mental_models?.[1].refresh_after_consolidation).toBe(true);
    expect(parsed.mental_models?.[1].max_tokens).toBe(2048);
  });

  it("is optional — omitting it is valid (zero-declaration = post-#2447 behaviour)", () => {
    const parsed = AgentMemorySchema.parse({ collection: "b" });
    expect(parsed.mental_models).toBeUndefined();
  });

  it("rejects duplicate model names within one agent", () => {
    const result = AgentMemorySchema.safeParse({
      collection: "b",
      mental_models: [
        { name: "dupe", source_query: "a?" },
        { name: "dupe", source_query: "b?" },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0].message).toContain("duplicate mental_models name");
    }
  });

  it("rejects an empty name or empty source_query", () => {
    expect(
      AgentMemorySchema.safeParse({
        collection: "b",
        mental_models: [{ name: "", source_query: "q?" }],
      }).success,
    ).toBe(false);
    expect(
      AgentMemorySchema.safeParse({
        collection: "b",
        mental_models: [{ name: "x", source_query: "" }],
      }).success,
    ).toBe(false);
  });

  it("rejects a non-positive / non-integer max_tokens", () => {
    expect(
      AgentMemorySchema.safeParse({
      collection: "b",
        mental_models: [{ name: "x", source_query: "q?", max_tokens: 0 }],
      }).success,
    ).toBe(false);
    expect(
      AgentMemorySchema.safeParse({
      collection: "b",
        mental_models: [{ name: "x", source_query: "q?", max_tokens: 1.5 }],
      }).success,
    ).toBe(false);
  });

  it("rejects a max_tokens above the 8192 ceiling", () => {
    expect(
      AgentMemorySchema.safeParse({
        collection: "b",
        mental_models: [{ name: "x", source_query: "q?", max_tokens: 8193 }],
      }).success,
    ).toBe(false);
    // At the ceiling is fine.
    expect(
      AgentMemorySchema.safeParse({
        collection: "b",
        mental_models: [{ name: "x", source_query: "q?", max_tokens: 8192 }],
      }).success,
    ).toBe(true);
  });

  it("rejects a source_query above the 2000-char ceiling", () => {
    expect(
      AgentMemorySchema.safeParse({
        collection: "b",
        mental_models: [{ name: "x", source_query: "q".repeat(2001) }],
      }).success,
    ).toBe(false);
    // At the ceiling is fine.
    expect(
      AgentMemorySchema.safeParse({
        collection: "b",
        mental_models: [{ name: "x", source_query: "q".repeat(2000) }],
      }).success,
    ).toBe(true);
  });
});
