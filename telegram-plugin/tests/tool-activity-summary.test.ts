import { describe, it, expect } from "vitest";
import {
  describeToolUse,
  appendActivityLine,
  appendActivityLabel,
  clipNarrative,
  renderActivityFeed,
  renderActivityFeedWithNested,
  renderActivityHeader,
  formatFeedElapsed,
  type SessionActivityHeader,
} from "../tool-activity-summary.js";
import { STATUS_ROLLING_LINES, STATUS_LINE_MAX } from "../status-no-truncate.js";

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

  it("windows to the last STATUS_ROLLING_LINES with a '✓ +N earlier…' header on the AGENT surface", () => {
    // The +N earlier header now appears on the AGENT surface too (flag retired).
    const total = STATUS_ROLLING_LINES + 4;
    const lines = Array.from({ length: total }, (_, i) => `Action ${i + 1}`);
    const out = renderActivityFeed(lines)!;
    const hidden = total - STATUS_ROLLING_LINES;
    expect(out.startsWith(`<i>✓ +${hidden} earlier…</i>\n`)).toBe(true);
    // Only the last STATUS_ROLLING_LINES actions are shown; older ones collapsed.
    const firstVisible = total - STATUS_ROLLING_LINES + 1;
    expect(out).toContain(`<i>✓ Action ${firstVisible}</i>`);
    expect(out).not.toContain(`Action ${firstVisible - 1}<`);
    // The newest action is the in-progress step (bold →); the rest are done (✓).
    expect(out).toContain(`<b>→ Action ${total}</b>`);
    expect(out).toContain(`<i>✓ Action ${total - 1}</i>`);
    expect(out).not.toContain(`<b>→ Action ${total - 1}</b>`);
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

  // final=true: the persisted "status stays" terminal render — the feed is
  // left in the chat when clear_status_on_completion=false, so the newest line
  // must read done (✓), not a frozen "→ in-progress".
  it("final=true renders the newest line as done (✓), not in-progress (→)", () => {
    const lines = ["Reading a.ts", "Searching memory", "Running a command"];
    const out = renderActivityFeed(lines, true)!;
    expect(out).toBe(
      "<i>✓ Reading a.ts</i>\n<i>✓ Searching memory</i>\n<i>✓ Running a command</i>",
    );
    expect(out).not.toContain("→"); // no in-progress arrow anywhere
  });

  it("final=true on a single line is also done (✓)", () => {
    expect(renderActivityFeed(["Reading a.ts"], true)).toBe("<i>✓ Reading a.ts</i>");
  });

  it("final defaults false (live render keeps the → in-progress newest line)", () => {
    expect(renderActivityFeed(["Reading a.ts"])).toBe("<b>→ Reading a.ts</b>");
  });

  // liveSuffix (PR1 heartbeat): appended INSIDE the newest in-progress line so a
  // long single step visibly advances ("→ Pulling Meta data · 18s") even though
  // the feed is pull-only and no new tool label arrived.
  describe("liveSuffix (heartbeat)", () => {
    it("appends the suffix to the newest in-progress line only", () => {
      expect(renderActivityFeed(["Reading a.ts", "Running a command"], false, " · 18s")).toBe(
        "<i>✓ Reading a.ts</i>\n<b>→ Running a command · 18s</b>",
      );
    });
    it("single live line gets the suffix", () => {
      expect(renderActivityFeed(["Pulling Meta data"], false, " · 1m05s")).toBe(
        "<b>→ Pulling Meta data · 1m05s</b>",
      );
    });
    it("final=true ignores the suffix (a finalized record never ticks)", () => {
      const out = renderActivityFeed(["Reading a.ts", "Running a command"], true, " · 18s")!;
      expect(out).not.toContain("·");
      expect(out).not.toContain("→");
      expect(out).toBe("<i>✓ Reading a.ts</i>\n<i>✓ Running a command</i>");
    });
    it("default empty suffix is byte-identical to no suffix", () => {
      expect(renderActivityFeed(["Reading a.ts"], false, "")).toBe(
        renderActivityFeed(["Reading a.ts"]),
      );
    });
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

describe("clipNarrative — narrative-step clip (JSONL-text-narrative primitive)", () => {
  it("takes the first line only, trims, slices to 120 chars", () => {
    expect(clipNarrative("On it. Let me find the repo…\nthen build")).toBe(
      "On it. Let me find the repo…",
    );
    expect(clipNarrative("  Found both:  ")).toBe("Found both:");
    const long = "x".repeat(200);
    expect(clipNarrative(long).length).toBe(120);
  });

  it("a shown narrative renders identically to a tool label via the same feed path", () => {
    // A SHOWN narrative line is pushed through appendActivityLabel exactly
    // like a tool label, so the rendered feed string is byte-identical.
    const narrativeLines: string[] = [];
    const labelLines: string[] = [];
    const text = "Important find: no main branch yet — branching off origin.";
    const narrativeRender = appendActivityLabel(narrativeLines, clipNarrative(text));
    const labelRender = appendActivityLabel(labelLines, clipNarrative(text));
    expect(narrativeRender).toBe(labelRender);
    expect(narrativeRender).toBe(`<b>→ ${text}</b>`);
  });

  it("empty string yields an empty clip (appendActivityLabel then drops it)", () => {
    expect(clipNarrative("")).toBe("");
    expect(appendActivityLabel([], clipNarrative("   \n  "))).toBeNull();
  });
});

describe("renderActivityFeed — ✓ N steps total (final render, issue #2461)", () => {
  it("appends '✓ N steps' footer when final=true and stepCount > 0", () => {
    const lines = ["Reading CLAUDE.md", "Searching memory", "Running a command"];
    const out = renderActivityFeed(lines, true, "", 5)!;
    // All lines are done (✓) and the footer is appended.
    expect(out).toContain("<i>✓ Running a command</i>");
    expect(out).toContain("<i>✓ 5 steps</i>");
    expect(out.endsWith("<i>✓ 5 steps</i>")).toBe(true);
  });

  it("stepCount=0 → no footer (no tools fired that were surfaced)", () => {
    const lines = ["Reading CLAUDE.md"];
    const out = renderActivityFeed(lines, true, "", 0)!;
    expect(out).not.toContain("steps");
    expect(out).toBe("<i>✓ Reading CLAUDE.md</i>");
  });

  it("stepCount undefined → no footer (live/non-final callers omit it)", () => {
    const lines = ["Reading CLAUDE.md"];
    const out = renderActivityFeed(lines, true)!;
    expect(out).not.toContain("steps");
  });

  it("stepCount present but final=false → no footer (live in-progress feed stays clean)", () => {
    const lines = ["Reading CLAUDE.md", "Running a command"];
    const out = renderActivityFeed(lines, false, "", 7)!;
    expect(out).not.toContain("steps");
    // The newest line is still the live in-progress step.
    expect(out).toContain("<b>→ Running a command</b>");
  });

  it("stepCount=1 footer reads '✓ 1 steps' (no special-casing)", () => {
    const lines = ["Reading CLAUDE.md"];
    const out = renderActivityFeed(lines, true, "", 1)!;
    expect(out).toContain("<i>✓ 1 steps</i>");
  });

  it("footer appears even when the feed overflows the rolling window", () => {
    const total = STATUS_ROLLING_LINES + 4;
    const lines = Array.from({ length: total }, (_, i) => `Action ${i + 1}`);
    const out = renderActivityFeed(lines, true, "", total)!;
    expect(out).toContain(`<i>✓ +${total - STATUS_ROLLING_LINES} earlier…</i>`);
    expect(out).toContain(`<i>✓ ${total} steps</i>`);
    expect(out.endsWith(`<i>✓ ${total} steps</i>`)).toBe(true);
  });

  it("stepCount is surface-tool-excluded: reply/react count 0, Read+mcp count correctly", () => {
    // This test documents the counting contract: stepCount is incremented
    // after the isTelegramSurfaceTool guard in case 'tool_label', so surface
    // tools (reply/stream_reply/edit_message/react) are never counted. The
    // rendered footer reflects only the surfaced non-surface steps.
    const lines = ["Reading CLAUDE.md", "Searching memory"]; // 2 non-surface labels
    // stepCount=2 (Read + mcp__hindsight__recall) — reply is NOT counted.
    const out = renderActivityFeed(lines, true, "", 2)!;
    expect(out).toContain("<i>✓ 2 steps</i>");
    // stepCount=0 would mean only surface tools fired — no footer.
    const outSurfaceOnly = renderActivityFeed(["Reading CLAUDE.md"], true, "", 0)!;
    expect(outSurfaceOnly).not.toContain("steps");
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

  it("windows the nested block to STATUS_ROLLING_LINES with a '↳ +N earlier…' header", () => {
    const total = STATUS_ROLLING_LINES + 3;
    const child = Array.from({ length: total }, (_, i) => `step ${i + 1}`);
    const out = renderActivityFeedWithNested(["Delegating: x"], child)!;
    expect(out).toContain(`   ↳ <i>+${total - STATUS_ROLLING_LINES} earlier…</i>`);
    // newest nested line is the live → step
    expect(out).toContain(`   ↳ <b>→ step ${total}</b>`);
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

  it("final=true: the nested newest step renders done (✓), not in-progress (→)", () => {
    const out = renderActivityFeedWithNested(
      ["Delegating: x"],
      ["Reading schema.ts", "Looking for foreign keys"],
      true,
    )!;
    expect(out).toContain("   ↳ <i>Looking for foreign keys</i>"); // newest now italic done
    expect(out).not.toContain("→"); // no in-progress arrow in the finalized feed
  });

  it("final=true with no children delegates to the finalized flat render", () => {
    expect(renderActivityFeedWithNested(["Reading a.ts"], [], true)).toBe(
      "<i>✓ Reading a.ts</i>",
    );
  });

  it("liveSuffix (heartbeat) lands on the nested newest in-progress step", () => {
    const out = renderActivityFeedWithNested(
      ["Delegating: x"],
      ["Reading schema.ts", "Looking for foreign keys"],
      false,
      " · 22s",
    )!;
    expect(out).toContain("   ↳ <b>→ Looking for foreign keys · 22s</b>");
    expect(out).not.toContain("Reading schema.ts · "); // only the newest line ticks
  });

  it("liveSuffix passes through to the flat render when there are no children", () => {
    expect(renderActivityFeedWithNested(["Reading a.ts"], [], false, " · 9s")).toBe(
      "<b>→ Reading a.ts · 9s</b>",
    );
  });

  it("stepCount footer appears on final=true with children present", () => {
    const parent = ["Delegating: review the migration"];
    const child = ["Reading schema.ts", "Looking for foreign keys"];
    const out = renderActivityFeedWithNested(parent, child, true, "", 5)!;
    expect(out).toContain("<i>✓ 5 steps</i>");
    expect(out.endsWith("<i>✓ 5 steps</i>")).toBe(true);
    expect(out).not.toContain("→");
  });

  it("stepCount footer appears on final=true with no children (delegates to flat render)", () => {
    const out = renderActivityFeedWithNested(["Reading a.ts"], [], true, "", 3)!;
    expect(out).toContain("<i>✓ 3 steps</i>");
    expect(out).toBe("<i>✓ Reading a.ts</i>\n<i>✓ 3 steps</i>");
  });

  // Liveness-driven feed open (dark-turn fix): a turn that emits no tool_label
  // (pure thinking / suppressed tools) gets a minimal "Working…" placeholder so
  // the feed still opens and stays visibly alive. These pin the exact render
  // the gateway's feedHeartbeatTick (open + climb) and clearActivitySummary
  // (terminal record) depend on.
  describe("liveness placeholder — 'Working…' feed", () => {
    it("renders the live in-progress placeholder with climbing elapsed", () => {
      expect(
        renderActivityFeedWithNested(["Working…"], [], false, " · 12s"),
      ).toBe("<b>→ Working… · 12s</b>");
    });

    it("finalizes the placeholder to a done record (no frozen → line)", () => {
      expect(renderActivityFeedWithNested(["Working…"], [], true)).toBe(
        "<i>✓ Working…</i>",
      );
    });
  });

  it("stepCount=0 → no footer even on final=true", () => {
    const out = renderActivityFeedWithNested(["Reading a.ts"], [], true, "", 0)!;
    expect(out).not.toContain("steps");
  });

  // Pins the invariant the gateway's foreground handoff-clear path relies on:
  // on an ack-first turn the parent feed is empty (mirrorLines=[]) and the only
  // content is the foreground sub-agent's nested narrative. The finalized
  // render MUST be captured WHILE that narrative is present — once the gateway
  // removes the finished sub-agent from the map, the render collapses to null
  // and the finalize would be skipped, freezing the last live "→" line. This is
  // exactly why clearActivitySummary takes a pre-delete finalHtmlOverride.
  describe("foreground handoff-clear: capture-before-delete invariant", () => {
    it("ack-first (empty parent) + child present → non-null all-done render (✓, no →)", () => {
      const out = renderActivityFeedWithNested(
        [],
        ["Sleep 2 for step 8", "Step 8 done; final echo", "All eight steps completed"],
        true,
      );
      expect(out).not.toBeNull();
      expect(out).not.toContain("→");
      expect(out).toContain("All eight steps completed");
    });

    it("ack-first (empty parent) + child REMOVED → null (the emptied-feed skip the gateway must avoid)", () => {
      // After foregroundSubAgents.delete(agentId), the parent has nothing left
      // to render on an ack-first turn → null → finalize would no-op.
      expect(renderActivityFeedWithNested([], [], true)).toBeNull();
    });
  });
});

// ─── Rolling-window + STATUS_LINE_MAX (flag retired) ────────────────────────
// Contract (single mode, no flag):
//   - last STATUS_ROLLING_LINES lines render; overflow → `+N earlier…` header
//     on BOTH surfaces;
//   - each line clipped to STATUS_LINE_MAX (200) chars then escaped;
//   - char-budget backstop (fitCardToBudget) is the only wire-limit ceiling.

describe("rolling window + +N earlier — renderActivityFeed", () => {
  it("with 12 lines, exactly the last STATUS_ROLLING_LINES render + a +N earlier header", () => {
    const lines = Array.from({ length: 12 }, (_, i) => `XAct-${String(i + 1).padStart(3, '0')}`);
    const out = renderActivityFeed(lines)!;
    const firstVisible = 12 - STATUS_ROLLING_LINES + 1;
    for (let i = firstVisible; i <= 12; i++) {
      expect(out).toContain(`XAct-${String(i).padStart(3, '0')}`);
    }
    for (let i = 1; i < firstVisible; i++) {
      expect(out).not.toContain(`XAct-${String(i).padStart(3, '0')}`);
    }
    // Overflow header present on the AGENT surface now.
    expect(out).toContain(`<i>✓ +${12 - STATUS_ROLLING_LINES} earlier…</i>`);
    expect(out).toContain(`<b>→ XAct-012</b>`);
  });

  it("STATUS_LINE_MAX=200: a 250-char step is clipped to 200 with a trailing …", () => {
    const longLine = "a".repeat(250);
    const out = renderActivityFeed([longLine])!;
    expect(out).toContain("…");
    // The full 250-char line must NOT survive; the clip is 200 (199 + …).
    expect(out).not.toContain(longLine);
    expect(out).toContain("a".repeat(STATUS_LINE_MAX - 1) + "…");
  });

  it("a line at exactly STATUS_LINE_MAX is NOT clipped", () => {
    const exact = "b".repeat(STATUS_LINE_MAX);
    const out = renderActivityFeed([exact])!;
    expect(out).toContain(exact);
    expect(out).not.toContain("…");
  });

  it("no spurious overflow header when the feed fits the window", () => {
    const lines = Array.from({ length: STATUS_ROLLING_LINES }, (_, i) => `Short ${i + 1}`);
    const out = renderActivityFeed(lines)!;
    expect(out).not.toContain("earlier");
  });

  it("pathologically oversized lines: char-budget backstop fires, output ≤ 4096 chars", () => {
    // STATUS_ROLLING_LINES lines of ~900 chars each → over budget pre-clip, but
    // each line is clipped to 200 first, so the budget should comfortably hold.
    const bigLine = "z".repeat(900);
    const lines = Array.from({ length: STATUS_ROLLING_LINES }, () => bigLine);
    const out = renderActivityFeed(lines)!;
    expect(out.length).toBeLessThanOrEqual(4096);
    const hasBullet = out.includes("→") || out.includes("✓");
    expect(hasBullet).toBe(true);
  });
});

describe("rolling window + +N earlier — renderActivityFeedWithNested", () => {
  it("many parent lines → only the last STATUS_ROLLING_LINES render with a +N earlier header", () => {
    const totalParent = STATUS_ROLLING_LINES + 3;
    const parent = Array.from({ length: totalParent }, (_, i) => `Parent ${i + 1}`);
    const child = ["Child step A", "Child step B"];
    const out = renderActivityFeedWithNested(parent, child)!;
    const firstVisible = totalParent - STATUS_ROLLING_LINES + 1;
    for (let i = firstVisible; i <= totalParent; i++) {
      expect(out).toContain(`Parent ${i}`);
    }
    for (let i = 1; i < firstVisible; i++) {
      expect(out).not.toContain(`Parent ${i}`);
    }
    expect(out).toContain(`<i>✓ +${totalParent - STATUS_ROLLING_LINES} earlier…</i>`);
    expect(out).toContain("   ↳ <b>→ Child step B</b>");
  });

  it("many child lines → only the last STATUS_ROLLING_LINES child lines render with a ↳ +N earlier header", () => {
    const parent = ["Delegating: big task"];
    const totalChild = STATUS_ROLLING_LINES + 4;
    const child = Array.from({ length: totalChild }, (_, i) => `Child ${i + 1}`);
    const out = renderActivityFeedWithNested(parent, child)!;
    const firstVisible = totalChild - STATUS_ROLLING_LINES + 1;
    for (let i = firstVisible; i <= totalChild; i++) {
      expect(out).toContain(`Child ${i}`);
    }
    for (let i = 1; i < firstVisible; i++) {
      expect(out).not.toContain(`Child ${i}`);
    }
    expect(out).toContain(`   ↳ <i>+${totalChild - STATUS_ROLLING_LINES} earlier…</i>`);
    expect(out).toContain(`   ↳ <b>→ Child ${totalChild}</b>`);
  });

  it("STATUS_LINE_MAX=200: a 250-char child line is clipped to 200 (both surfaces)", () => {
    const longLine = "x".repeat(250);
    const out = renderActivityFeedWithNested(["Delegating"], [longLine])!;
    expect(out).toContain("…");
    expect(out).not.toContain(longLine);
    expect(out).toContain("x".repeat(STATUS_LINE_MAX - 1) + "…");
  });

  it("huge nested feed: char-budget backstop fires, output ≤ 4096 chars", () => {
    const bigLine = "w".repeat(900);
    const parent = Array.from({ length: STATUS_ROLLING_LINES }, () => bigLine);
    const child = Array.from({ length: STATUS_ROLLING_LINES }, () => bigLine);
    const out = renderActivityFeedWithNested(parent, child)!;
    expect(out.length).toBeLessThanOrEqual(4096);
    expect(out).toContain("   ↳ ");
  });
});

// ─── Extreme-edge: single oversized line with HTML-special chars ─────────────
// These tests cover the _fitToCharBudget and _fitNestedToCharBudget fallback
// paths that are reachable in no-truncate mode when a Bash label contains
// special chars (e.g. && is extremely common) and is longer than the budget.

/** Cheap valid-HTML checker: balanced tags + no partial entity. */
function isValidHtml(s: string): boolean {
  // No partial entity: must not end with &[a-z]* lacking semicolon.
  if (/&[a-z]+$/.test(s)) return false;
  if (/&[a-z]+[^;]$/.test(s)) return false;
  // Every &...; must be complete.
  const entityRe = /&([^;]*)/g;
  let m: RegExpExecArray | null;
  while ((m = entityRe.exec(s)) !== null) {
    if (!s.slice(m.index).startsWith("&") || s[m.index + m[0].length] !== ";") {
      // Check if this entity is actually terminated
      const entityStart = m.index;
      const semiIdx = s.indexOf(";", entityStart + 1);
      if (semiIdx === -1) return false; // no closing semicolon
    }
  }
  // All opening tags have a corresponding close (simple check for <b>/<i>).
  const bOpen = (s.match(/<b>/g) ?? []).length;
  const bClose = (s.match(/<\/b>/g) ?? []).length;
  const iOpen = (s.match(/<i>/g) ?? []).length;
  const iClose = (s.match(/<\/i>/g) ?? []).length;
  return bOpen === bClose && iOpen === iClose;
}

describe("extreme-edge: single oversized line with &, <, >, &&", () => {
  it("renderActivityFeed: single ~4100-char line with special chars → ≤ budget and valid HTML", () => {
    // Build a raw line >4000 chars with &, <, >, and a trailing &&.
    // The && will escape to &amp;&amp; (5 chars each), exercising the expansion guard.
    const base = "Run script with args: foo=bar && baz=<qux> & corge=1 ";
    const bigLine = base.repeat(80) + "&&";
    expect(bigLine.length).toBeGreaterThan(4000);

    const out = renderActivityFeed([bigLine])!;
    expect(out).not.toBeNull();
    expect(out.length).toBeLessThanOrEqual(4000); // STATUS_CARD_CHAR_BUDGET
    expect(isValidHtml(out)).toBe(true);
    // Must be wrapped in <b>…</b> (live/non-final) — no dangling tag.
    expect(out.startsWith("<b>→ ")).toBe(true);
    expect(out.endsWith("</b>")).toBe(true);
  });

  it("renderActivityFeed final=true: single ~4100-char line → ≤ budget and valid HTML", () => {
    const base = "Deploy build && upload && notify && cleanup: ";
    const bigLine = base.repeat(90) + "done";
    expect(bigLine.length).toBeGreaterThan(4000);

    const out = renderActivityFeed([bigLine], true)!;
    expect(out).not.toBeNull();
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(isValidHtml(out)).toBe(true);
    expect(out.startsWith("<i>✓ ")).toBe(true);
    expect(out.endsWith("</i>")).toBe(true);
  });

  it("renderActivityFeedWithNested: single ~4100-char parent line → ≤ budget and valid HTML", () => {
    const base = "Parent action with & < > special chars && bash: ";
    const bigLine = base.repeat(85);
    expect(bigLine.length).toBeGreaterThan(4000);

    const out = renderActivityFeedWithNested([bigLine], [])!;
    expect(out).not.toBeNull();
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(isValidHtml(out)).toBe(true);
  });

  it("renderActivityFeedWithNested: single ~4100-char child line → ≤ budget and valid HTML", () => {
    const base = "Child step: run build && test && deploy with <args> & flags=1 ";
    const bigChild = base.repeat(65) + "&&";
    expect(bigChild.length).toBeGreaterThan(4000);

    const out = renderActivityFeedWithNested(["Delegating: big job"], [bigChild])!;
    expect(out).not.toBeNull();
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(isValidHtml(out)).toBe(true);
    // Must contain the nested prefix.
    expect(out).toContain("   ↳ ");
    // Regression guard: an operator-precedence bug made wrapperOverhead a string
    // (NESTED_PREFIX + n) → NaN budget → slice(0, NaN) === "" → the child content
    // was silently discarded, leaving only "   ↳ <b>→ </b>". The empty-wrapper
    // output still satisfies the toContain("   ↳ ") check above, so assert that
    // real child content actually survives.
    expect(out).toContain("Child step");
    expect(out.length).toBeGreaterThan(100);
  });

  it("renderActivityFeedWithNested final=true: single ~4100-char child line → ≤ budget and valid HTML", () => {
    const base = "Final child: compile && link && package & ship: ";
    const bigChild = base.repeat(85);
    expect(bigChild.length).toBeGreaterThan(4000);

    const out = renderActivityFeedWithNested(["Delegating: big job"], [bigChild], true)!;
    expect(out).not.toBeNull();
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(isValidHtml(out)).toBe(true);
    // final=true → nested line renders done (italic, no →).
    expect(out).not.toContain("→");
  });
});

// ─── Session activity header (unified renderer — main-session card fix) ───────
//
// The main-session card was missing the two-line header that the worker card
// already renders: elapsed time + tool count. These tests verify that the header
// is now emitted when a `SessionActivityHeader` is supplied, matching the worker
// card's style and fixing the "missing header" regression.

describe("renderActivityHeader — two-line header builder", () => {
  it("renders the running header with elapsed and tool count", () => {
    const [h1, h2] = renderActivityHeader("🤖", "Agent", "", 15_000, 7, "running");
    expect(h1).toBe("🤖 <b>Agent</b>");
    expect(h2).toBe("<i>15s · 7 tools</i>");
  });

  it("renders the done header with tool count and elapsed", () => {
    const [h1, h2] = renderActivityHeader("🤖", "Agent", "", 65_000, 3, "done");
    expect(h1).toBe("🤖 <b>Agent</b>");
    expect(h2).toBe("<i>done · 3 tools · 1m05s</i>");
  });

  it("includes the description in line 1 when non-empty", () => {
    const [h1] = renderActivityHeader("🛠", "Worker", "run tests", 10_000, 2, "running");
    expect(h1).toBe("🛠 <b>Worker</b> · <i>run tests</i>");
  });

  it("omits the description part when empty", () => {
    const [h1] = renderActivityHeader("🤖", "Agent", "", 5_000, 1, "running");
    expect(h1).toBe("🤖 <b>Agent</b>");
    expect(h1).not.toContain(" · ");
  });

  it("HTML-escapes special chars in description and label", () => {
    const [h1] = renderActivityHeader("🤖", "Agent", "run <foo> & <bar>", 5_000, 1, "running");
    expect(h1).toContain("run &lt;foo&gt; &amp; &lt;bar&gt;");
  });
});

describe("agent flat path routes through the shared step-feed primitive", () => {
  it("flat renderActivityFeed === nested-with-empty-children (same window + +N output)", () => {
    // The flat agent path and the nested path with NO children must produce the
    // identical render — both flow through renderStatusCard's step feed.
    const lines = Array.from({ length: STATUS_ROLLING_LINES + 3 }, (_, i) => `Step ${i + 1}`);
    expect(renderActivityFeed(lines)).toBe(renderActivityFeedWithNested(lines, []));
    expect(renderActivityFeed(lines, true, "", 9)).toBe(
      renderActivityFeedWithNested(lines, [], true, "", 9),
    );
    // And the +N earlier marker is present on the flat agent surface.
    expect(renderActivityFeed(lines)!).toContain(
      `<i>✓ +${lines.length - STATUS_ROLLING_LINES} earlier…</i>`,
    );
  });
});

describe("escape entity is never split mid-clip (clip raw → escape last)", () => {
  it("a step ending in '&' clipped at STATUS_LINE_MAX stays valid HTML", () => {
    // Build a step exactly STATUS_LINE_MAX+1 chars ending in '&' so a naive
    // escape-then-clip would split the &amp; entity at the boundary.
    const line = "x".repeat(STATUS_LINE_MAX) + "&";
    const out = renderActivityFeed([line])!;
    // The clip keeps STATUS_LINE_MAX-1 chars + '…', then escapes — no stray entity.
    expect(out).not.toMatch(/&amp$/);
    expect(out).not.toMatch(/&am[^p]/);
    expect(out).toContain("…");
    // Whatever '&' survives must be a complete &amp;.
    const ampCount = (out.match(/&amp;/g) ?? []).length;
    const bareAmp = (out.match(/&(?!amp;|lt;|gt;)/g) ?? []).length;
    expect(bareAmp).toBe(0);
    expect(ampCount).toBeGreaterThanOrEqual(0);
  });

  it("a step ending in '<' clipped at STATUS_LINE_MAX stays valid HTML", () => {
    const line = "y".repeat(STATUS_LINE_MAX) + "<";
    const out = renderActivityFeed([line])!;
    expect(out).not.toMatch(/&lt$/);
    expect(out).not.toMatch(/&l[^t;]/);
    const bareLt = (out.match(/&(?!amp;|lt;|gt;)/g) ?? []).length;
    expect(bareLt).toBe(0);
  });
});

describe("formatFeedElapsed — elapsed formatter", () => {
  it("formats sub-minute durations as Ns", () => {
    expect(formatFeedElapsed(0)).toBe("0s");
    expect(formatFeedElapsed(999)).toBe("0s");
    expect(formatFeedElapsed(1_000)).toBe("1s");
    expect(formatFeedElapsed(59_000)).toBe("59s");
  });

  it("formats minute+ durations as MmSSs", () => {
    expect(formatFeedElapsed(60_000)).toBe("1m00s");
    expect(formatFeedElapsed(65_000)).toBe("1m05s");
    expect(formatFeedElapsed(125_000)).toBe("2m05s");
  });
});

describe("renderActivityFeed — header param (main-session card fix)", () => {
  it("prepends the two-line header when header is supplied (running)", () => {
    const header: SessionActivityHeader = {
      label: "Agent",
      elapsedMs: 15_000,
      toolCount: 7,
      state: "running",
    };
    const out = renderActivityFeed(["Reading CLAUDE.md", "Searching memory"], false, "", undefined, header)!;
    // Must start with the header lines.
    expect(out).toContain("🤖 <b>Agent</b>");
    expect(out).toContain("<i>15s · 7 tools</i>");
    // Step feed follows the header.
    expect(out).toContain("<i>✓ Reading CLAUDE.md</i>");
    expect(out).toContain("<b>→ Searching memory</b>");
  });

  it("prepends the done header when final=true", () => {
    const header: SessionActivityHeader = {
      label: "Agent",
      elapsedMs: 65_000,
      toolCount: 3,
      state: "done",
    };
    const out = renderActivityFeed(["Reading CLAUDE.md"], true, "", undefined, header)!;
    expect(out).toContain("🤖 <b>Agent</b>");
    expect(out).toContain("<i>done · 3 tools · 1m05s</i>");
    expect(out).toContain("<i>✓ Reading CLAUDE.md</i>");
    // No in-progress arrow (final=true).
    expect(out).not.toContain("→");
  });

  it("renders header-only (no steps) when lines is empty", () => {
    const header: SessionActivityHeader = {
      label: "Agent",
      elapsedMs: 5_000,
      toolCount: 0,
      state: "running",
    };
    // renderActivityFeed normally returns null for empty lines; with header it returns content.
    const out = renderActivityFeed([], false, "", undefined, header);
    expect(out).not.toBeNull();
    expect(out).toContain("🤖 <b>Agent</b>");
  });

  it("without header, renderActivityFeed still returns null for empty lines (no regression)", () => {
    expect(renderActivityFeed([], false, "", undefined, undefined)).toBeNull();
  });

  it("header is present in renderActivityFeedWithNested output too", () => {
    const header: SessionActivityHeader = {
      label: "Agent",
      elapsedMs: 30_000,
      toolCount: 5,
      state: "running",
    };
    const out = renderActivityFeedWithNested(
      ["Delegating: review"],
      ["Reading schema.ts"],
      false,
      "",
      undefined,
      header,
    )!;
    expect(out).toContain("🤖 <b>Agent</b>");
    expect(out).toContain("<i>30s · 5 tools</i>");
    // Parent step is done-styled (child is the live step).
    expect(out).toContain("<i>✓ Delegating: review</i>");
    // Child step is the in-progress step.
    expect(out).toContain("   ↳ <b>→ Reading schema.ts</b>");
  });
});

describe("describeToolUse — surface-tool suppression is key-agnostic", () => {
  it("returns null for telegram reply/stream_reply under any registration key", () => {
    // Standard switchroom-telegram key.
    expect(describeToolUse("mcp__switchroom-telegram__reply", {})).toBeNull();
    expect(describeToolUse("mcp__switchroom-telegram__stream_reply", {})).toBeNull();
    // Legacy clerk-telegram key.
    expect(describeToolUse("mcp__clerk-telegram__reply", {})).toBeNull();
    expect(describeToolUse("mcp__clerk-telegram__stream_reply", {})).toBeNull();
    // Hypothetical custom fork.
    expect(describeToolUse("mcp__my-custom-telegram__reply", {})).toBeNull();
  });

  it("returns null for telegram edit_message and react under any key", () => {
    expect(describeToolUse("mcp__clerk-telegram__edit_message", {})).toBeNull();
    expect(describeToolUse("mcp__clerk-telegram__react", {})).toBeNull();
  });
});
