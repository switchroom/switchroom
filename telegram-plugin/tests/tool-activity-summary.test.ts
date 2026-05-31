import { describe, it, expect } from "vitest";
import {
  describeToolUse,
  appendActivityLine,
  appendActivityLabel,
  renderActivityFeed,
  renderActivityFeedWithNested,
  MIRROR_MAX_LINES,
  NESTED_MAX_LINES,
} from "../tool-activity-summary.js";

describe("describeToolUse — friendly per-tool rendering (draft-mirror)", () => {
  it("Bash uses the model-authored description verbatim, never the command", () => {
    expect(
      describeToolUse("Bash", { command: "ls -la /tmp", description: "List workspace" }),
    ).toBe("List workspace");
    // No description → safe generic, still never the raw command.
    expect(describeToolUse("Bash", { command: "grep -r foo ." })).toBe("Running a command");
  });

  it("Read/Edit/Write render the file basename, not the full path", () => {
    expect(describeToolUse("Read", { file_path: "/home/ken/code/switchroom/gateway.ts" })).toBe(
      "Reading gateway.ts",
    );
    expect(describeToolUse("Edit", { file_path: "/a/b/CLAUDE.md" })).toBe("Editing CLAUDE.md");
    expect(describeToolUse("Write", { file_path: "notes.txt" })).toBe("Writing notes.txt");
    expect(describeToolUse("Read", {})).toBe("Reading a file");
  });

  it("Grep/Glob show the pattern; WebFetch shows the hostname", () => {
    expect(describeToolUse("Grep", { pattern: "TODO" })).toBe("Searching for TODO");
    expect(describeToolUse("WebFetch", { url: "https://www.example.com/path?q=1" })).toBe(
      "Reading example.com",
    );
    expect(describeToolUse("WebSearch", { query: "best running shoes" })).toBe(
      "Searching the web for best running shoes",
    );
  });

  it("Task/Agent surface the sub-agent task description", () => {
    expect(describeToolUse("Task", { description: "Review the migration" })).toBe(
      "Delegating: Review the migration",
    );
  });

  it("domain MCP tools render human-meaningful labels (no jargon)", () => {
    expect(describeToolUse("mcp__hindsight__reflect", { query: "x" })).toBe("Searching memory");
    expect(describeToolUse("mcp__hindsight__retain", {})).toBe("Saving to memory");
    expect(describeToolUse("mcp__claude_ai_Google_Calendar__list_events", {})).toBe(
      "Checking your calendar",
    );
    expect(describeToolUse("mcp__claude_ai_Gmail__search", {})).toBe("Checking your email");
    expect(describeToolUse("mcp__claude_ai_Google_Drive__search_files", {})).toBe(
      "Looking through your files",
    );
    expect(describeToolUse("mcp__claude_ai_Notion__notion-search", {})).toBe("Checking your notes");
  });

  it("surface tools (reply/stream_reply) return null — never mirrored", () => {
    expect(describeToolUse("mcp__switchroom-telegram__reply", { text: "hi" })).toBeNull();
    expect(describeToolUse("mcp__switchroom-telegram__stream_reply", {})).toBeNull();
  });

  it("unknown MCP tool prefers a model-authored field, else humanizes the name", () => {
    expect(describeToolUse("mcp__acme__do_thing", { description: "Fetched the report" })).toBe(
      "Fetched the report",
    );
    expect(describeToolUse("mcp__acme__do_thing", {})).toBe("Using do thing");
  });

  it("unknown built-in falls back to a generic working line, never raw syntax", () => {
    expect(describeToolUse("SomeFutureTool", {})).toBe("Working…");
    expect(describeToolUse("", {})).toBeNull();
  });
});

describe("appendActivityLine + renderActivityFeed — accumulating activity feed", () => {
  it("accumulates distinct actions chronologically (newest = current → bold, earlier = done ✓ italic)", () => {
    const lines: string[] = [];
    expect(appendActivityLine(lines, "Read", { file_path: "a/gateway.ts" })).toBe(
      "<b>→ Reading gateway.ts</b>",
    );
    expect(appendActivityLine(lines, "mcp__hindsight__reflect", { query: "x" })).toBe(
      "<i>✓ Reading gateway.ts</i>\n<b>→ Searching memory</b>",
    );
    expect(appendActivityLine(lines, "Bash", { command: "ls", description: "List workspace" })).toBe(
      "<i>✓ Reading gateway.ts</i>\n<i>✓ Searching memory</i>\n<b>→ List workspace</b>",
    );
  });

  it("collapses consecutive exact-duplicate lines", () => {
    const lines: string[] = [];
    appendActivityLine(lines, "Read", { file_path: "a.ts" });
    appendActivityLine(lines, "Read", { file_path: "a.ts" }); // dup → collapsed
    expect(lines).toEqual(["Reading a.ts"]);
  });

  it("returns null (no feed update) for surface tools", () => {
    const lines: string[] = [];
    expect(appendActivityLine(lines, "mcp__switchroom-telegram__reply", { text: "hi" })).toBeNull();
    expect(lines).toEqual([]);
  });

  it("caps to the last MIRROR_MAX_LINES with a '✓ +N earlier…' header", () => {
    const lines = Array.from({ length: 9 }, (_, i) => `Action ${i + 1}`);
    const out = renderActivityFeed(lines)!;
    expect(out.startsWith("<i>✓ +3 earlier…</i>\n")).toBe(true);
    // Only the last 6 actions are shown; the oldest 3 are collapsed.
    expect(out).toContain("<i>✓ Action 4</i>");
    expect(out).not.toContain("Action 3");
    // The newest action is the in-progress step (bold →); the rest are done (✓).
    expect(out).toContain("<b>→ Action 9</b>");
    expect(out).toContain("<i>✓ Action 8</i>");
    expect(out).not.toContain("<b>→ Action 8</b>");
  });

  it("HTML-escapes &, <, > in action text (no double-escaping by callers)", () => {
    const out = renderActivityFeed(["Running <foo> & <bar>"])!;
    expect(out).toBe("<b>→ Running &lt;foo&gt; &amp; &lt;bar&gt;</b>");
  });

  it("renders a single line as the current (bold →) step", () => {
    expect(renderActivityFeed(["Reading a.ts"])).toBe("<b>→ Reading a.ts</b>");
  });

  it("renderActivityFeed returns null on empty", () => {
    expect(renderActivityFeed([])).toBeNull();
  });
});

describe("appendActivityLabel — precomputed label feed (tool_label path)", () => {
  it("accumulates precomputed labels, dedups consecutive, ignores empty", () => {
    const lines: string[] = [];
    expect(appendActivityLabel(lines, "Searching memory")).toBe("<b>→ Searching memory</b>");
    expect(appendActivityLabel(lines, "List workspace")).toBe(
      "<i>✓ Searching memory</i>\n<b>→ List workspace</b>",
    );
    // consecutive dup collapses
    appendActivityLabel(lines, "List workspace");
    expect(lines).toEqual(["Searching memory", "List workspace"]);
    // empty / whitespace → null, no push
    expect(appendActivityLabel(lines, "")).toBeNull();
    expect(appendActivityLabel(lines, "   ")).toBeNull();
    expect(appendActivityLabel(lines, undefined)).toBeNull();
    expect(lines.length).toBe(2);
  });
});

describe("renderActivityFeedWithNested — foreground sub-agent nesting (Model A)", () => {
  it("with no child lines, is identical to the flat feed", () => {
    const lines = ["Searching memory", "Delegating: review the migration"];
    expect(renderActivityFeedWithNested(lines, [])).toBe(renderActivityFeed(lines));
    // whitespace-only children also collapse to the flat feed
    expect(renderActivityFeedWithNested(lines, ["  ", ""])).toBe(renderActivityFeed(lines));
  });

  it("done-styles ALL parent lines and nests the child block (newest = bold →)", () => {
    const parent = ["Searching memory", "Delegating: review the migration"];
    const child = ["Reading schema.ts", "Looking for foreign keys"];
    const out = renderActivityFeedWithNested(parent, child)!;
    // Parent is blocked at the Task tool → none of its lines is the live step.
    expect(out).toContain("<i>✓ Searching memory</i>");
    expect(out).toContain("<i>✓ Delegating: review the migration</i>");
    expect(out).not.toContain("<b>→ Delegating");
    // The live → step is the newest nested child line; earlier child = italic.
    expect(out).toContain("   ↳ <i>Reading schema.ts</i>");
    expect(out).toContain("   ↳ <b>→ Looking for foreign keys</b>");
  });

  it("caps the nested block to NESTED_MAX_LINES with a '↳ +N earlier…' header", () => {
    const child = Array.from({ length: NESTED_MAX_LINES + 3 }, (_, i) => `step ${i + 1}`);
    const out = renderActivityFeedWithNested(["Delegating: x"], child)!;
    expect(out).toContain("   ↳ <i>+3 earlier…</i>");
    // newest nested line is the live → step
    expect(out).toContain(`   ↳ <b>→ step ${NESTED_MAX_LINES + 3}</b>`);
    // the oldest (collapsed) lines are not rendered verbatim
    expect(out).not.toContain("step 1<");
  });

  it("renders the child block even when the parent feed is empty", () => {
    const out = renderActivityFeedWithNested([], ["Reading a.ts"]);
    expect(out).toBe("   ↳ <b>→ Reading a.ts</b>");
  });

  it("HTML-escapes nested child text", () => {
    const out = renderActivityFeedWithNested(["Delegating: x"], ["touch <a> & <b>"])!;
    expect(out).toContain("   ↳ <b>→ touch &lt;a&gt; &amp; &lt;b&gt;</b>");
  });
});
