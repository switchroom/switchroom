import { describe, it, expect } from "vitest";
import { validateAnthropicToolSchemas } from "./anthropic-tool-schema-validator.js";

describe("validateAnthropicToolSchemas", () => {
  it("accepts a well-formed object schema", () => {
    const issues = validateAnthropicToolSchemas([
      {
        name: "good_tool",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string" },
            count: { type: "integer" },
          },
          required: ["name"],
        },
      },
    ]);
    expect(issues).toEqual([]);
  });

  it("flags missing inputSchema", () => {
    const issues = validateAnthropicToolSchemas([{ name: "no_schema" }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/missing inputSchema/);
  });

  it("flags root.type !== object", () => {
    const issues = validateAnthropicToolSchemas([
      { name: "wrong_root", inputSchema: { type: "string" } },
    ]);
    expect(issues[0]).toMatch(/root schema type/);
  });

  it("flags top-level oneOf / anyOf / allOf", () => {
    const issues = validateAnthropicToolSchemas([
      { name: "tool_oneof", inputSchema: { type: "object", oneOf: [{ type: "object" }] } },
      { name: "tool_anyof", inputSchema: { type: "object", anyOf: [{ type: "object" }] } },
      { name: "tool_allof", inputSchema: { type: "object", allOf: [{ type: "object" }] } },
    ]);
    expect(issues).toHaveLength(3);
    expect(issues.join("\n")).toMatch(/oneOf/);
    expect(issues.join("\n")).toMatch(/anyOf/);
    expect(issues.join("\n")).toMatch(/allOf/);
  });

  it("recurses into property schemas", () => {
    const issues = validateAnthropicToolSchemas([
      {
        name: "nested_bad",
        inputSchema: {
          type: "object",
          properties: {
            bad_field: { type: "object", oneOf: [{ type: "string" }] },
          },
        },
      },
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatch(/properties\.bad_field/);
    expect(issues[0]).toMatch(/oneOf/);
  });

  it("returns one diagnostic per offending tool", () => {
    const issues = validateAnthropicToolSchemas([
      { name: "ok", inputSchema: { type: "object" } },
      { name: "bad1", inputSchema: { type: "object", oneOf: [] } },
      { name: "bad2", inputSchema: { type: "array" } },
    ]);
    expect(issues).toHaveLength(2);
  });
});
