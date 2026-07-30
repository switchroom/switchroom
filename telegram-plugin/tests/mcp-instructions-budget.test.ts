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
 * (in `npm run lint`) is the twin: it resolves the module the bridge actually
 * imports and measures the same runtime value that the SDK will hand to the
 * client.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

  it("leaves a real safety margin below the hard limit", () => {
    // The budget exists to fail an edit BEFORE the client silently cuts it.
    // Raising it to within a handful of chars of 2048 would leave no room to
    // notice, so the margin is asserted rather than trusted to review.
    const margin = MCP_INSTRUCTIONS_LIMIT - MCP_INSTRUCTIONS_BUDGET;
    expect(
      margin,
      `budget ${MCP_INSTRUCTIONS_BUDGET} is only ${margin} chars below the ` +
        `${MCP_INSTRUCTIONS_LIMIT} hard limit — too close to act as an early ` +
        `warning. Lower the budget instead of raising it.`,
    ).toBeGreaterThanOrEqual(50);
  });

  it("leaves usable authoring headroom under the budget", () => {
    // The counterpart to the margin above: a budget pinned two chars above the
    // current string is a nuisance rail, and nuisance rails get "fixed" by
    // deleting content — which is precisely what caused #3562. If this fails,
    // MOVE mechanical detail into a tool `description` (those are not capped)
    // rather than raising the budget toward the limit.
    const headroom = MCP_INSTRUCTIONS_BUDGET - MCP_INSTRUCTIONS.length;
    expect(
      headroom,
      `only ${headroom} chars of headroom between the string ` +
        `(${MCP_INSTRUCTIONS.length}) and the budget ` +
        `(${MCP_INSTRUCTIONS_BUDGET}); a routine edit would trip lint.`,
    ).toBeGreaterThanOrEqual(25);
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

  it("retains the multi-origin forward-attribution rule inside the prefix", () => {
    // Review catch: this sentence was dropped in the first cut with no
    // landing spot, surviving only in docs/telegram-features.md. A two-origin
    // forwarded burst would then be wholly attributed to origin 1 — a
    // provenance failure, not a mechanical one, so it belongs here.
    const survives = MCP_INSTRUCTIONS.slice(0, MCP_INSTRUCTIONS_LIMIT);
    expect(survives).toContain("forwarded_from_2");
    expect(survives).toMatch(/attribute each part to its OWN origin/i);
    expect(survives).toMatch(/never the whole burst to the first/i);
  });

  it("retains the forward id/date/deep-link attributes inside the prefix", () => {
    const survives = MCP_INSTRUCTIONS.slice(0, MCP_INSTRUCTIONS_LIMIT);
    for (const attr of [
      "forwarded_from_id",
      "forwarded_date",
      "forwarded_message_id",
      "t.me/<channel>/<id>",
      "attachment_count",
    ]) {
      expect(survives).toContain(attr);
    }
  });
});

/**
 * The PR's thesis is "MOVED, not deleted" — mechanical detail was cut from the
 * instructions only because it landed in a tool `description`, which is not
 * subject to the 2048-char cap. Nothing tested that the landing actually
 * happened, so deleting the destination text passed the whole suite.
 *
 * These assertions pin the destinations. Comments are stripped first: a
 * matching comment in bridge.ts must NOT be able to satisfy an assertion about
 * text the AGENT reads.
 */
describe("moved instruction content landed in tool descriptions", () => {
  const raw = readFileSync(
    resolve(__dirname, "..", "bridge", "bridge.ts"),
    "utf-8",
  );
  // Strip block and line comments so only real agent-facing strings match.
  const bridgeCode = raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("forum-topic routing landed in the reply description", () => {
    expect(bridgeCode).toContain("FORUM TOPICS:");
    expect(bridgeCode).toMatch(/do NOT pass message_thread_id on a normal reply/);
    expect(bridgeCode).toContain("origin_turn_id");
  });

  it("format modes landed in the reply description", () => {
    expect(bridgeCode).toContain("FORMAT:");
    // The description must describe the ONE real render path (rich GFM), and
    // still name the legacy aliases so the enum values stay documented. It must
    // NOT resurrect the deleted-engine claims (html→HTML conversion, MarkdownV2
    // auto-escaping) — those are false at HEAD (single GFM path, no escaping).
    expect(bridgeCode).toMatch(/rich GFM markdown/);
    expect(bridgeCode).toContain("markdownv2");
    expect(bridgeCode).not.toMatch(/default format is "html"/);
    expect(bridgeCode).not.toMatch(/auto-converted to Telegram HTML/);
    expect(bridgeCode).not.toMatch(/MarkdownV2 with auto-escaping/);
  });

  it("history-buffer rationale landed in get_recent_messages", () => {
    expect(bridgeCode).toMatch(/no history endpoint/);
    expect(bridgeCode).toMatch(/buffer survives restarts/);
  });

  it("the comment-stripping itself works (guards the assertions above)", () => {
    // If stripping silently no-ops, every assertion in this block becomes
    // satisfiable by a comment. Prove it removes both comment forms.
    const sample = 'const a = 1 // FORUM TOPICS:\n/* FORMAT: */ const b = 2';
    const stripped = sample
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(stripped).not.toContain("FORUM TOPICS:");
    expect(stripped).not.toContain("FORMAT:");
  });
});
