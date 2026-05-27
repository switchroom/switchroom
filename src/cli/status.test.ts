/**
 * Unit tests for `switchroom status` — focused on the pure helpers
 * (parser + uptime formatter). Integration coverage (docker exec
 * + broker round-trip) lives in the e2e test that needs a running
 * fleet — kept out of the per-PR critical path.
 */
import { describe, it, expect } from "vitest";
import { parseClaudeMcpList, formatUptimeShort } from "./status.js";

describe("parseClaudeMcpList", () => {
  const SAMPLE_HAPPY = `Checking MCP server health…

switchroom-telegram: bun run --cwd /opt/switchroom/telegram-plugin --shell=bun --silent start - ✓ Connected
agent-config: /usr/local/bin/switchroom mcp agent-config - ✓ Connected
hindsight: http://127.0.0.1:18888/mcp/ (HTTP) - ✓ Connected
gdrive: /usr/local/bin/switchroom drive-mcp-launcher --tier extended - ✓ Connected
perplexity: ~/.switchroom/mcp-launchers/perplexity-mcp.sh  - ✓ Connected
`;

  it("parses all-connected output cleanly", () => {
    const out = parseClaudeMcpList(SAMPLE_HAPPY);
    expect(out.map((s) => s.name)).toEqual([
      "switchroom-telegram",
      "agent-config",
      "hindsight",
      "gdrive",
      "perplexity",
    ]);
    expect(out.every((s) => s.connected)).toBe(true);
  });

  it("flags failed servers", () => {
    const out = parseClaudeMcpList(`Checking MCP server health…

switchroom-telegram: bun run ... - ✓ Connected
perplexity: /home/foo/perplexity.sh - ✗ Failed to connect
`);
    expect(out).toHaveLength(2);
    expect(out[0].connected).toBe(true);
    expect(out[1].connected).toBe(false);
    expect(out[1].status).toContain("Failed");
  });

  it("ignores the header banner and any blank lines", () => {
    const out = parseClaudeMcpList(`

Checking MCP server health…


switchroom-telegram: cmd - ✓ Connected

`);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("switchroom-telegram");
  });

  it("ignores lines without the ` - ` discriminator", () => {
    const out = parseClaudeMcpList(`Some random preamble: not an MCP line
switchroom-telegram: cmd - ✓ Connected
Trailing chatter without a dash
`);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("switchroom-telegram");
  });

  it("treats `Connected` not adjacent to `Failed` as connected", () => {
    // Defensive — a server named "Connected" or status with weird
    // wording shouldn't trip the heuristic.
    const out = parseClaudeMcpList(`my-mcp: cmd - ✓ Connected (HTTP)\n`);
    expect(out[0].connected).toBe(true);
  });

  it("treats any non-Connected status as failure with verbatim text preserved", () => {
    const out = parseClaudeMcpList(`stuck-mcp: cmd - Connecting…\n`);
    expect(out[0].connected).toBe(false);
    expect(out[0].status).toBe("Connecting…");
  });

  it("returns empty on empty input", () => {
    expect(parseClaudeMcpList("")).toEqual([]);
  });

  it("returns empty when no line has the discriminator", () => {
    expect(parseClaudeMcpList("No MCP servers configured.\n")).toEqual([]);
  });

  it("handles single-line probe failure output (claude not installed)", () => {
    // When claude isn't on PATH, the docker exec returns stderr —
    // parser sees no MCP lines and returns empty (probe-level wrapper
    // handles the error separately).
    expect(parseClaudeMcpList("/bin/sh: claude: command not found\n")).toEqual([]);
  });
});

describe("formatUptimeShort", () => {
  it("returns em-dash for null / malformed / future timestamps", () => {
    expect(formatUptimeShort(null)).toBe("—");
    expect(formatUptimeShort("not-an-iso-date")).toBe("—");
    // A timestamp in the future yields a negative delta → em-dash.
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(formatUptimeShort(future)).toBe("—");
  });

  it("renders minutes for short uptimes", () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    expect(formatUptimeShort(fiveMinAgo)).toBe("5m");
  });

  it("renders hours + minutes for medium uptimes", () => {
    const twoHrThirtyAgo = new Date(Date.now() - (2 * 3600 + 30 * 60) * 1000).toISOString();
    expect(formatUptimeShort(twoHrThirtyAgo)).toBe("2h 30m");
  });

  it("renders days + hours for long uptimes", () => {
    const threeDaysFiveHrsAgo = new Date(
      Date.now() - (3 * 86400 + 5 * 3600) * 1000,
    ).toISOString();
    expect(formatUptimeShort(threeDaysFiveHrsAgo)).toBe("3d 5h");
  });
});
