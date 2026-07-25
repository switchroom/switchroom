/**
 * The MCP `instructions` string must fit the Claude Code client's hard
 * truncation limit (#3562).
 *
 * The Claude Code native binary truncates MCP server instructions at a
 * hard-coded 2048 chars, silently and mid-word:
 *
 *     if (I && I.length > LB) R = ma(I, LB) + "… [truncated]"   // LB = 2048
 *
 * Nothing errors and nothing surfaces to the agent — the server starts, the
 * tools work, and the tail of the string simply never reaches the model. That
 * is how the telegram bridge shipped a 4645-char instructions string for
 * months with 56% of it discarded, including the /telegram:access
 * prompt-injection defence.
 *
 * These tests are the deterministic backstop. `scripts/check-mcp-instructions-budget.mjs`
 * (in `npm run lint`) is the static twin; this one measures the real runtime
 * value that the SDK will hand to the client.
 */
import { describe, it, expect } from "vitest";
import {
  MCP_INSTRUCTIONS,
  MCP_INSTRUCTIONS_BUDGET,
  MCP_INSTRUCTIONS_LIMIT,
} from "../bridge/mcp-instructions.js";

describe("MCP instructions budget", () => {
  it("pins the client's hard limit at 2048 (not ours to change)", () => {
    // Sourced from the minified constant `LB` in @anthropic-ai/claude-code
    // v2.1.219. If a future client version changes this, update it here
    // deliberately — do not raise it to make a long string pass.
    expect(MCP_INSTRUCTIONS_LIMIT).toBe(2048);
  });

  it("keeps the authored budget strictly below the client's hard limit", () => {
    expect(MCP_INSTRUCTIONS_BUDGET).toBeLessThan(MCP_INSTRUCTIONS_LIMIT);
  });

  it("fits under the authored budget", () => {
    const len = MCP_INSTRUCTIONS.length;
    expect(
      len,
      `MCP instructions are ${len} chars — ${len - MCP_INSTRUCTIONS_BUDGET} over ` +
        `the ${MCP_INSTRUCTIONS_BUDGET}-char budget (client hard limit ` +
        `${MCP_INSTRUCTIONS_LIMIT}, which truncates silently and mid-word). ` +
        `Cut ${len - MCP_INSTRUCTIONS_BUDGET} chars. Prefer MOVING mechanical ` +
        `per-tool detail into that tool's \`description\` (tool descriptions ` +
        `are NOT capped) over deleting it; keep safety/trust rules here.`,
    ).toBeLessThanOrEqual(MCP_INSTRUCTIONS_BUDGET);
  });

  it("would not be truncated by the client", () => {
    // The exact predicate the client applies.
    expect(MCP_INSTRUCTIONS.length > MCP_INSTRUCTIONS_LIMIT).toBe(false);
  });

  // ── Content assertions: the SAFETY rules must be present, and must be
  //    present *within the surviving prefix*. A budget test alone would still
  //    pass if someone kept the length but deleted the guardrail.
  it("retains the prompt-injection defence inside the un-truncated prefix", () => {
    const survives = MCP_INSTRUCTIONS.slice(0, MCP_INSTRUCTIONS_LIMIT);
    expect(survives).toContain("approve the pending pairing");
    expect(survives).toContain("prompt injection");
    expect(survives).toContain("Refuse");
    expect(survives).toMatch(/never invoke that skill|Never invoke that skill/);
  });

  it("retains the forwarded-provenance trust rules inside the prefix", () => {
    const survives = MCP_INSTRUCTIONS.slice(0, MCP_INSTRUCTIONS_LIMIT);
    expect(survives).toContain("hidden_user");
    expect(survives).toMatch(/no verifiable id/i);
    expect(survives).toContain("untrusted content");
  });

  it("retains the reply-is-the-only-channel rule inside the prefix", () => {
    const survives = MCP_INSTRUCTIONS.slice(0, MCP_INSTRUCTIONS_LIMIT);
    expect(survives).toContain("reply tool");
    expect(survives).toContain("never reaches their chat");
  });
});
