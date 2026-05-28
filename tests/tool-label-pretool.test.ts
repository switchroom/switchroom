import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Unit tests for telegram-plugin/hooks/tool-label-pretool.mjs (#783).
 *
 * Spawns the .mjs as a child process, feeds Claude Code's PreToolUse
 * stdin payload, and asserts the resulting sidecar JSONL line.
 * Every test asserts exit 0 and empty stdout (per Claude Code's hook
 * contract: stdout JSON would risk hookSpecificOutput.updatedInput
 * collisions; non-zero exit BLOCKS the tool call).
 */

const HOOK = resolve(
  __dirname,
  "..",
  "telegram-plugin",
  "hooks",
  "tool-label-pretool.mjs",
);

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
  sidecarLines: Array<Record<string, unknown>>;
}

function run(
  payload: Record<string, unknown> | string,
  stateDir: string | null,
  sessionId = "sess-test",
): RunResult {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  if (stateDir) env.TELEGRAM_STATE_DIR = stateDir;
  else delete env.TELEGRAM_STATE_DIR;
  // Strip SWITCHROOM_AGENT_NAME so the hook's agent_id derivation falls
  // back to cwd basename — keeps tests deterministic.
  delete env.SWITCHROOM_AGENT_NAME;

  const stdin = typeof payload === "string" ? payload : JSON.stringify(payload);
  const r = spawnSync(process.execPath, [HOOK], {
    input: stdin,
    env,
    encoding: "utf8",
  });

  let sidecarLines: Array<Record<string, unknown>> = [];
  if (stateDir) {
    const f = join(stateDir, `tool-labels-${sessionId}.jsonl`);
    if (existsSync(f)) {
      const text = readFileSync(f, "utf8");
      sidecarLines = text
        .split("\n")
        .filter((l) => l.trim().length > 0)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    }
  }

  return {
    status: r.status ?? 0,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
    sidecarLines,
  };
}

describe("tool-label-pretool.mjs", () => {
  let stateDir: string;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "tool-label-pretool-"));
  });

  afterEach(() => {
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("always exits 0 with empty stdout — even on bad input", () => {
    for (const bad of ["", "not-json", "{}", "{\"tool_name\":\"Read\"}"]) {
      const r = run(bad, stateDir);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
  });

  it("Read → 'Reading <basename>'", () => {
    const r = run(
      {
        session_id: "sess-test",
        tool_use_id: "toolu_1",
        tool_name: "Read",
        tool_input: { file_path: "/abs/path/to/scaffold.ts" },
      },
      stateDir,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.sidecarLines).toHaveLength(1);
    expect(r.sidecarLines[0].label).toBe("Reading scaffold.ts");
    expect(r.sidecarLines[0].tool_use_id).toBe("toolu_1");
    expect(r.sidecarLines[0].tool_name).toBe("Read");
  });

  it("Skill → 'Running skill <slug>' so the sidecar carries it for the UAT runner", () => {
    const r = run(
      {
        session_id: "sess-test",
        tool_use_id: "toolu_skill_1",
        tool_name: "Skill",
        tool_input: { skill: "switchroom-cli" },
      },
      stateDir,
    );
    expect(r.status).toBe(0);
    expect(r.sidecarLines).toHaveLength(1);
    expect(r.sidecarLines[0].label).toBe("Running skill switchroom-cli");
    expect(r.sidecarLines[0].tool_name).toBe("Skill");
  });

  it("Skill with empty slug emits no sidecar line", () => {
    const r = run(
      {
        session_id: "sess-test",
        tool_use_id: "toolu_skill_empty",
        tool_name: "Skill",
        tool_input: { skill: "" },
      },
      stateDir,
    );
    expect(r.status).toBe(0);
    expect(r.sidecarLines).toHaveLength(0);
  });

  it("Edit / Write / NotebookEdit produce matching verbs", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["Edit", { file_path: "/x/foo.ts" }, "Editing foo.ts"],
      ["Write", { file_path: "/x/bar.md" }, "Writing bar.md"],
      ["NotebookEdit", { notebook_path: "/x/n.ipynb" }, "Editing notebook n.ipynb"],
    ];
    for (const [tool, input, expected] of cases) {
      const r = run(
        { session_id: "sess-test", tool_use_id: `t-${tool}`, tool_name: tool, tool_input: input },
        stateDir,
      );
      expect(r.status).toBe(0);
      const line = r.sidecarLines.find((l) => l.tool_use_id === `t-${tool}`);
      expect(line?.label).toBe(expected);
    }
  });

  it("Grep with and without path", () => {
    const r1 = run(
      {
        session_id: "sess-test",
        tool_use_id: "g1",
        tool_name: "Grep",
        tool_input: { pattern: "hindsight", path: "src/" },
      },
      stateDir,
    );
    expect(r1.sidecarLines[0].label).toBe("Searching src/ for hindsight");

    const r2 = run(
      {
        session_id: "sess-test",
        tool_use_id: "g2",
        tool_name: "Grep",
        tool_input: { pattern: "TODO" },
      },
      stateDir,
    );
    const g2 = r2.sidecarLines.find((l) => l.tool_use_id === "g2");
    expect(g2?.label).toBe("Searching . for TODO");
  });

  it("Glob / WebFetch / WebSearch", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["Glob", { pattern: "**/*.ts" }, "Finding files matching **/*.ts"],
      ["WebFetch", { url: "https://example.com/path?x=1" }, "Fetching example.com/path"],
      ["WebSearch", { query: "claude code hooks" }, "Searching the web for claude code hooks"],
    ];
    for (const [tool, input, expected] of cases) {
      const r = run(
        { session_id: "sess-test", tool_use_id: `t-${tool}`, tool_name: tool, tool_input: input },
        stateDir,
      );
      const line = r.sidecarLines.find((l) => l.tool_use_id === `t-${tool}`);
      expect(line?.label).toBe(expected);
    }
  });

  it("BashOutput / KillBash / KillShell", () => {
    for (const [tool, expected] of [
      ["BashOutput", "Reading background output"],
      ["KillBash", "Stopping background process"],
      ["KillShell", "Stopping background process"],
    ] as const) {
      const r = run(
        { session_id: "sess-test", tool_use_id: `t-${tool}`, tool_name: tool, tool_input: {} },
        stateDir,
      );
      const line = r.sidecarLines.find((l) => l.tool_use_id === `t-${tool}`);
      expect(line?.label).toBe(expected);
    }
  });

  it("MCP allowlist (telegram + hindsight)", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["mcp__switchroom-telegram__reply", { text: "hi" }, "Replying"],
      ["mcp__switchroom-telegram__stream_reply", { text: "hi" }, "Replying"],
      ["mcp__switchroom-telegram__react", { emoji: "👍" }, "Reacting 👍"],
      ["mcp__switchroom-telegram__get_recent_messages", {}, "Reading chat history"],
      ["mcp__hindsight__recall", { query: "x" }, "Searching memory"],
      ["mcp__hindsight__reflect", { query: "x" }, "Searching memory"],
      ["mcp__hindsight__retain", { content: "x" }, "Saving memory"],
    ];
    for (const [tool, input, expected] of cases) {
      const r = run(
        { session_id: "sess-test", tool_use_id: `t-${tool}`, tool_name: tool, tool_input: input },
        stateDir,
      );
      const line = r.sidecarLines.find((l) => l.tool_use_id === `t-${tool}`);
      expect(line?.label, `${tool}`).toBe(expected);
    }
  });

  it("Bash / Task / Agent / TodoWrite / ToolSearch now emit labels (draft-mirror real-time source)", () => {
    // Previously suppressed (deferred to the JSONL description path). Since
    // the draft-mirror drives off this sidecar in real time, they must be
    // labelled here too. Bash/Task use the model-authored description.
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["Bash", { command: "ls -la", description: "List workspace" }, "List workspace"],
      ["Bash", { command: "ls" }, "Running a command"], // no description → safe fallback
      ["Task", { description: "Review the migration", prompt: "y" }, "Delegating: Review the migration"],
      ["Agent", { description: "Audit deps", prompt: "y" }, "Delegating: Audit deps"],
      ["TodoWrite", { todos: [] }, "Updating the plan"],
      ["ToolSearch", { query: "x" }, "Finding the right tool"],
    ];
    cases.forEach(([tool, input, expected], idx) => {
      // Unique session per case so the per-session sidecar file isn't
      // shared/accumulated across iterations. `run()` reads the sidecar
      // via its 3rd arg, so it must match the payload's session_id.
      const sess = `sess-${idx}`;
      const r = run(
        { session_id: sess, tool_use_id: `t-${tool}-${idx}`, tool_name: tool, tool_input: input },
        stateDir,
        sess,
      );
      expect(r.status).toBe(0);
      expect(r.sidecarLines, `${tool} should emit a sidecar label`).toHaveLength(1);
      expect(r.sidecarLines[0].label).toBe(expected);
    });
  });

  it("genuinely-suppressed tools (send_typing, sync_retain, exotic mcp__) still emit nothing", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["mcp__switchroom-telegram__send_typing", {}],
      ["mcp__hindsight__sync_retain", {}],
      ["mcp__some-other-server__random_tool", { foo: "bar" }],
    ];
    for (const [tool, input] of cases) {
      const r = run(
        { session_id: "sess-test", tool_use_id: `t-${tool}`, tool_name: tool, tool_input: input },
        stateDir,
      );
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
    const files = readdirSync(stateDir).filter((f) => f.startsWith("tool-labels-"));
    expect(files).toHaveLength(0);
  });

  it("missing TELEGRAM_STATE_DIR → silent skip, exit 0", () => {
    const r = run(
      {
        session_id: "sess-test",
        tool_use_id: "t-x",
        tool_name: "Read",
        tool_input: { file_path: "/x/foo.ts" },
      },
      null,
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toBe("");
    expect(r.sidecarLines).toHaveLength(0);
  });

  it("missing session_id or tool_use_id → silent skip", () => {
    const r1 = run(
      { tool_use_id: "t", tool_name: "Read", tool_input: { file_path: "/a/b" } },
      stateDir,
    );
    expect(r1.status).toBe(0);
    expect(r1.sidecarLines).toHaveLength(0);

    const r2 = run(
      { session_id: "s", tool_name: "Read", tool_input: { file_path: "/a/b" } },
      stateDir,
    );
    expect(r2.status).toBe(0);
    expect(r2.sidecarLines).toHaveLength(0);
  });

  it("oversize input gets clipped to a single line", () => {
    const huge = "x".repeat(2000) + "\nsecond line";
    const r = run(
      {
        session_id: "sess-test",
        tool_use_id: "t-big",
        tool_name: "WebSearch",
        tool_input: { query: huge },
      },
      stateDir,
    );
    expect(r.status).toBe(0);
    const line = r.sidecarLines[0];
    expect(line).toBeDefined();
    const label = String(line.label);
    expect(label.length).toBeLessThanOrEqual(120);
    expect(label.includes("\n")).toBe(false);
  });
});
