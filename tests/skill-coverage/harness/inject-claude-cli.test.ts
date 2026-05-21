/**
 * Pure unit tests for extractFromStreamJson — no subprocess spawn.
 * Validates we correctly pull Skill slug + reply text out of the
 * realistic shape of claude -p --output-format=stream-json output.
 */

import { describe, it, expect } from "vitest";
import { extractFromStreamJson } from "./inject-claude-cli.js";

const SAMPLE_INIT = JSON.stringify({ type: "system", subtype: "init", session_id: "s1" });

function assistantToolUse(skill: string): string {
  return JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", name: "Skill", input: { skill } },
      ],
    },
  });
}

function assistantText(text: string): string {
  return JSON.stringify({
    type: "assistant",
    message: { content: [{ type: "text", text }] },
  });
}

function resultRow(ok: boolean): string {
  return JSON.stringify({ type: "result", subtype: "success", is_error: !ok });
}

describe("extractFromStreamJson", () => {
  it("pulls the Skill slug from a tool_use block", () => {
    const out = extractFromStreamJson(
      [SAMPLE_INIT, assistantToolUse("switchroom-cli"), resultRow(true)].join("\n"),
    );
    expect(out.skills).toEqual(["switchroom-cli"]);
    expect(out.ok).toBe(true);
  });

  it("collects multiple distinct Skill invocations within one turn", () => {
    const out = extractFromStreamJson(
      [
        SAMPLE_INIT,
        assistantToolUse("docx"),
        assistantToolUse("pdf"),
        resultRow(true),
      ].join("\n"),
    );
    expect(out.skills.sort()).toEqual(["docx", "pdf"]);
  });

  it("lowercases the slug", () => {
    const out = extractFromStreamJson(
      [SAMPLE_INIT, assistantToolUse("Switchroom-CLI"), resultRow(true)].join("\n"),
    );
    expect(out.skills).toEqual(["switchroom-cli"]);
  });

  it("returns empty skills when no Skill tool_use fires", () => {
    const out = extractFromStreamJson(
      [SAMPLE_INIT, assistantText("Sure, here's the weather…"), resultRow(true)].join("\n"),
    );
    expect(out.skills).toEqual([]);
    expect(out.replyText).toContain("weather");
  });

  it("flags ok=false when result row has is_error=true", () => {
    const out = extractFromStreamJson(
      [SAMPLE_INIT, assistantText("error"), resultRow(false)].join("\n"),
    );
    expect(out.ok).toBe(false);
  });

  it("ignores malformed lines without failing", () => {
    const out = extractFromStreamJson(
      [SAMPLE_INIT, "{not-json", assistantToolUse("docx"), resultRow(true)].join("\n"),
    );
    expect(out.skills).toEqual(["docx"]);
  });

  it("captures assistant text across multiple blocks", () => {
    const out = extractFromStreamJson(
      [
        SAMPLE_INIT,
        JSON.stringify({
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "hello" },
              { type: "tool_use", name: "Skill", input: { skill: "docx" } },
              { type: "text", text: "world" },
            ],
          },
        }),
        resultRow(true),
      ].join("\n"),
    );
    expect(out.skills).toEqual(["docx"]);
    expect(out.replyText).toBe("hello\nworld");
  });
});
