/**
 * Tests for the agent-config MCP shim.
 *
 * Covers:
 *   - `TOOLS` exports exactly the four documented tools with sane shape.
 *   - `dispatchTool` happy path: stdout parsed as JSON / JSONL and returned.
 *   - `dispatchTool` failure path: non-zero CLI exit surfaces as isError.
 *   - Unknown tool name returns an error result.
 *
 * We mock `node:child_process.spawnSync` so the CLI doesn't actually
 * exec — that keeps tests hermetic and fast.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const spawnSyncMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

// Import after vi.mock so the mock is in place.
import { TOOLS, dispatchTool } from "./server.js";

function okCall(stdout: string) {
  spawnSyncMock.mockReturnValueOnce({ stdout, stderr: "", status: 0 });
}

function failCall(stderr: string, status = 1) {
  spawnSyncMock.mockReturnValueOnce({ stdout: "", stderr, status });
}

describe("TOOLS export", () => {
  it("exposes the documented tools (read + write surface)", () => {
    const names = TOOLS.map((t) => t.name).sort();
    expect(names).toEqual([
      "audit_tail",
      "config_get",
      "cron_list",
      "peers_list",      // identity / peer-awareness
      "schedule_add",
      "schedule_remove",
      "skill_install",   // #1163 Phase 2
      "skill_list",
      "skill_remove",    // #1163 Phase 2
    ]);
  });

  it("every tool has an inputSchema of type object", () => {
    for (const t of TOOLS) {
      expect(t.inputSchema.type).toBe("object");
      expect(typeof t.description).toBe("string");
      expect(t.description.length).toBeGreaterThan(10);
    }
  });
});

describe("dispatchTool — happy path", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it("config_get parses CLI stdout as a single JSON document", () => {
    okCall(JSON.stringify({ skills: ["calendar"], secrets: ["k"] }) + "\n");
    const res = dispatchTool("config_get", { agent: "a" });
    expect(res.isError).toBeFalsy();
    const parsed = JSON.parse(res.content[0]!.text);
    expect(parsed).toEqual({ skills: ["calendar"], secrets: ["k"] });
    // Ensure --agent was forwarded.
    const [, args] = spawnSyncMock.mock.calls[0]!;
    expect(args).toEqual(["config", "get", "--agent", "a"]);
  });

  it("cron_list / skill_list parse JSON", () => {
    okCall(JSON.stringify([{ name: "ping" }]) + "\n");
    const cron = dispatchTool("cron_list", {});
    expect(JSON.parse(cron.content[0]!.text)).toEqual([{ name: "ping" }]);

    okCall(JSON.stringify({ skills: ["s"], bundled_skills: {} }) + "\n");
    const skill = dispatchTool("skill_list", {});
    expect(JSON.parse(skill.content[0]!.text)).toEqual({
      skills: ["s"],
      bundled_skills: {},
    });
  });

  it("peers_list shells out with no --agent flag (caller identity is env-pinned)", () => {
    okCall(
      JSON.stringify([
        { name: "scribe", purpose: "notes" },
        { name: "doc", purpose: "Health" },
      ]) + "\n",
    );
    const res = dispatchTool("peers_list", {});
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(res.content[0]!.text)).toEqual([
      { name: "scribe", purpose: "notes" },
      { name: "doc", purpose: "Health" },
    ]);
    const [, args] = spawnSyncMock.mock.calls[0]!;
    expect(args).toEqual(["peers", "list"]);
  });

  it("peers_list forwards include_self when set", () => {
    okCall(JSON.stringify([]) + "\n");
    dispatchTool("peers_list", { include_self: true });
    const [, args] = spawnSyncMock.mock.calls[0]!;
    expect(args).toEqual(["peers", "list", "--include-self"]);
  });

  it("audit_tail parses JSONL (one row per line)", () => {
    const row1 = { ts: "t1", agent: "a", cmd: "x", args: {}, exit: 0, peer_uid: 1 };
    const row2 = { ts: "t2", agent: "a", cmd: "y", args: {}, exit: 0, peer_uid: 1 };
    okCall(JSON.stringify(row1) + "\n" + JSON.stringify(row2) + "\n");
    const res = dispatchTool("audit_tail", { limit: 5 });
    expect(res.isError).toBeFalsy();
    const rows = JSON.parse(res.content[0]!.text);
    expect(rows).toEqual([row1, row2]);
    // Ensure --limit was forwarded as a string.
    const [, args] = spawnSyncMock.mock.calls[0]!;
    expect(args).toEqual(["audit", "tail", "--limit", "5"]);
  });
});

describe("dispatchTool — failure modes", () => {
  beforeEach(() => {
    spawnSyncMock.mockReset();
  });

  it("non-zero CLI exit surfaces as isError with stderr in the message", () => {
    failCall("cross-agent read denied: env agent \"a\" cannot read config for \"b\"", 7);
    const res = dispatchTool("config_get", { agent: "b" });
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/CLI exit 7/);
    expect(res.content[0]!.text).toMatch(/cross-agent read denied/);
  });

  it("malformed JSON from CLI surfaces as a parse error", () => {
    okCall("not-json\n");
    const res = dispatchTool("config_get", {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/failed to parse/);
  });

  it("unknown tool name returns an error result without invoking CLI", () => {
    const res = dispatchTool("nope" as string, {});
    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/unknown tool: nope/);
    expect(spawnSyncMock).not.toHaveBeenCalled();
  });
});
