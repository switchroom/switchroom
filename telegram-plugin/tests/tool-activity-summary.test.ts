import { describe, it, expect } from "vitest";
import {
  makeEmptyActivityState,
  register,
  formatSummary,
  registerAndRender,
  verbForTool,
} from "../tool-activity-summary.js";

describe("verbForTool — tool name → past-tense verb", () => {
  it("maps standard CLI tools to readable verbs", () => {
    expect(verbForTool("Read")).toBe("read");
    expect(verbForTool("Write")).toBe("created");
    expect(verbForTool("Edit")).toBe("edited");
    expect(verbForTool("MultiEdit")).toBe("edited");
    expect(verbForTool("NotebookEdit")).toBe("edited");
    expect(verbForTool("Bash")).toBe("ran");
    expect(verbForTool("BashOutput")).toBe("ran");
    expect(verbForTool("WebSearch")).toBe("searched");
    expect(verbForTool("Grep")).toBe("searched");
    expect(verbForTool("Glob")).toBe("searched");
    expect(verbForTool("WebFetch")).toBe("fetched");
    expect(verbForTool("Task")).toBe("dispatched");
    expect(verbForTool("Agent")).toBe("dispatched");
    expect(verbForTool("TodoWrite")).toBe("noted");
  });

  it("skips user-facing switchroom-telegram tools (those ARE the surface)", () => {
    expect(verbForTool("mcp__switchroom-telegram__reply")).toBeNull();
    expect(verbForTool("mcp__switchroom-telegram__stream_reply")).toBeNull();
    expect(verbForTool("mcp__switchroom-telegram__edit_message")).toBeNull();
    expect(verbForTool("mcp__switchroom-telegram__react")).toBeNull();
  });

  it("returns 'used' for unknown / non-switchroom MCP tools", () => {
    expect(verbForTool("mcp__google-workspace__list_files")).toBe("used");
    expect(verbForTool("mcp__notion__query_database")).toBe("used");
    expect(verbForTool("SomeFutureUnknownTool")).toBe("used");
  });

  it("returns null for empty toolName (defensive)", () => {
    expect(verbForTool("")).toBeNull();
  });
});

describe("register + formatSummary — Claude Code-style summary", () => {
  it("formats a single Read as 'Read a file'", () => {
    const s = makeEmptyActivityState();
    register(s, "Read");
    expect(formatSummary(s)).toBe("Read a file");
  });

  it("formats multiple Reads as 'Read N files'", () => {
    const s = makeEmptyActivityState();
    register(s, "Read");
    register(s, "Read");
    register(s, "Read");
    expect(formatSummary(s)).toBe("Read 3 files");
  });

  it("formats single Bash as 'Ran a command'", () => {
    const s = makeEmptyActivityState();
    register(s, "Bash");
    expect(formatSummary(s)).toBe("Ran a command");
  });

  it("formats multiple Bash as 'Ran N commands'", () => {
    const s = makeEmptyActivityState();
    for (let i = 0; i < 5; i++) register(s, "Bash");
    expect(formatSummary(s)).toBe("Ran 5 commands");
  });

  it("joins multiple verb-classes with commas (first-occurrence order)", () => {
    const s = makeEmptyActivityState();
    // Tools fire in this order: Read → Bash → Edit
    register(s, "Read");
    register(s, "Bash");
    register(s, "Edit");
    // The summary renders chronologically: read, ran, edited.
    expect(formatSummary(s)).toBe("Read a file, ran a command, edited a file");
  });

  it("matches the Claude Code screenshot examples", () => {
    // "Ran 5 commands, read a file"
    const s1 = makeEmptyActivityState();
    for (let i = 0; i < 5; i++) register(s1, "Bash");
    register(s1, "Read");
    expect(formatSummary(s1)).toBe("Ran 5 commands, read a file");

    // "Edited a file, read a file, ran a command"
    const s2 = makeEmptyActivityState();
    register(s2, "Edit");
    register(s2, "Read");
    register(s2, "Bash");
    expect(formatSummary(s2)).toBe("Edited a file, read a file, ran a command");

    // "Created a file, ran a command"
    const s3 = makeEmptyActivityState();
    register(s3, "Write");
    register(s3, "Bash");
    expect(formatSummary(s3)).toBe("Created a file, ran a command");
  });

  it("returns null when state is empty", () => {
    expect(formatSummary(makeEmptyActivityState())).toBeNull();
  });

  it("ignores user-facing tools (reply/stream_reply etc.)", () => {
    const s = makeEmptyActivityState();
    register(s, "mcp__switchroom-telegram__reply");
    register(s, "mcp__switchroom-telegram__stream_reply");
    expect(formatSummary(s)).toBeNull(); // nothing tracked
  });

  it("includes generic 'used' for unknown MCP tools", () => {
    const s = makeEmptyActivityState();
    register(s, "mcp__google-workspace__list_files");
    expect(formatSummary(s)).toBe("Used a tool");
    register(s, "mcp__google-workspace__create_file");
    expect(formatSummary(s)).toBe("Used 2 tools");
  });

  it("tracks firstToolName for forensic / telemetry use", () => {
    const s = makeEmptyActivityState();
    register(s, "Read");
    register(s, "Bash");
    expect(s.firstToolName).toBe("Read");
  });
});

describe("parallel-tool-use coalescing — render only reflects accumulated state", () => {
  it("synchronous burst of N tool_uses produces the right summary at each step", () => {
    // Modern Claude emits parallel tool_uses in a tight sync loop. The
    // gateway calls register() N times before any async drain runs.
    // After N registers, the rendered string should reflect ALL of them
    // — so when the drain fires once with the latest pendingRender, the
    // sent text is correct and complete.
    const s = makeEmptyActivityState();
    register(s, "Read");
    register(s, "Read");
    register(s, "Read");
    register(s, "Bash");
    register(s, "Bash");
    expect(formatSummary(s)).toBe("Read 3 files, ran 2 commands");
  });

  it("ordering is preserved across a chronological burst", () => {
    const s = makeEmptyActivityState();
    // Simulates: Bash, then Read, then Bash, then Read, then Edit
    register(s, "Bash");
    register(s, "Read");
    register(s, "Bash");
    register(s, "Read");
    register(s, "Edit");
    // Bash was first, then Read, then Edit. Counts: bash 2, read 2, edit 1.
    expect(formatSummary(s)).toBe(
      "Ran 2 commands, read 2 files, edited a file",
    );
  });

  it("registerAndRender returns null on user-facing tools (no race contribution)", () => {
    const s = makeEmptyActivityState();
    register(s, "Read");
    // A reply tool fires concurrently — should not enter the activity state.
    expect(
      registerAndRender(s, "mcp__switchroom-telegram__reply"),
    ).toBeNull();
    // State still reflects only the Read.
    expect(formatSummary(s)).toBe("Read a file");
  });
});

describe("registerAndRender — ergonomic full-pipeline call", () => {
  it("returns the updated rendered text on a real tool (chronological)", () => {
    const s = makeEmptyActivityState();
    expect(registerAndRender(s, "Read")).toBe("Read a file");
    // Bash fires AFTER Read — chronological order shows read first.
    expect(registerAndRender(s, "Bash")).toBe(
      "Read a file, ran a command",
    );
  });

  it("returns null on a surface tool (no-op)", () => {
    const s = makeEmptyActivityState();
    expect(
      registerAndRender(s, "mcp__switchroom-telegram__reply"),
    ).toBeNull();
    // State unchanged
    expect(s.firstToolName).toBeNull();
  });
});
