/**
 * `switchroom debug turn` per-turn-floor accounting (2026-06-06).
 *
 * The Totals block historically understated the per-turn context floor ~3x: it
 * DOUBLE-COUNTED SOUL.md (already inside the stable prefix), OMITTED the
 * --add-dir fleet invariants, omitted the MCP tool-schema surface, and used a
 * /4 token divisor. These guard the corrected accounting.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { estimateTokens, readMcpServerNames } from "../src/cli/debug.js";

describe("estimateTokens — /3.7 divisor (audit ratio)", () => {
  it("uses ~3.7 chars/token, not /4", () => {
    expect(estimateTokens(3700)).toBe(1000);
    expect(estimateTokens(37000)).toBe(10000);
    // /4 would have given 9250 for 37000.
    expect(estimateTokens(37000)).not.toBe(9250);
  });
});

describe("readMcpServerNames — parse / missing / agent-private", () => {
  it("returns the server names when .mcp.json is readable", () => {
    const dir = mkdtempSync(join(tmpdir(), "sr-mcp-"));
    writeFileSync(
      join(dir, ".mcp.json"),
      JSON.stringify({ mcpServers: { "switchroom-telegram": {}, hindsight: {}, webkite: {} } }),
    );
    expect(readMcpServerNames(dir)).toEqual(["switchroom-telegram", "hindsight", "webkite"]);
  });

  it("returns [] when there is no .mcp.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "sr-mcp-"));
    expect(readMcpServerNames(dir)).toEqual([]);
  });

  it("returns null (unknown) when .mcp.json is present but unparseable (agent-private / corrupt)", () => {
    const dir = mkdtempSync(join(tmpdir(), "sr-mcp-"));
    writeFileSync(join(dir, ".mcp.json"), "{ not valid json");
    expect(readMcpServerNames(dir)).toBeNull();
  });
});

describe("Totals block — no SOUL double-count + fleet invariants counted (source guards)", () => {
  const src = readFileSync(resolve(__dirname, "..", "src", "cli", "debug.ts"), "utf-8");
  const totalsBlock = src.split("const totalBytes =")[1]?.split(";")[0] ?? "";

  it("SOUL is NOT added to the total (it lives inside the stable prefix)", () => {
    // soulMdBytes must not appear in the totalBytes summation.
    expect(totalsBlock).not.toMatch(/soulMdBytes/);
  });

  it("fleet invariants ARE added to the total", () => {
    expect(totalsBlock).toMatch(/fleetBytes/);
  });

  it("the MCP tool-schema surface is surfaced (the dominant, previously-omitted cost)", () => {
    expect(src).toMatch(/MCP tool surface:/);
    expect(src).toMatch(/Per-turn FLOOR:/);
  });
});
