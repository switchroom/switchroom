import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

// The hook is a .ts that bundles to .mjs at build time; drive it through
// `bun` against source so the test doesn't depend on build order (mirrors
// skill-validate-pretool.test.ts). Skip cleanly if bun absent.
const bunOk = spawnSync("which", ["bun"], { encoding: "utf-8" }).status === 0;
const HOOK = join(
  process.cwd(),
  "src",
  "cli",
  "hindsight-mental-model-pretool.ts",
);

const DENY_MESSAGE =
  "Mental-model writes are operator-approved. Use " +
  "`mcp__switchroom-telegram__mental_model_propose` instead — it posts an " +
  "approval card and persists on approval.";

const WRITE_TOOLS = [
  "mcp__hindsight__create_mental_model",
  "mcp__hindsight__update_mental_model",
  "mcp__hindsight__delete_mental_model",
  "mcp__hindsight__refresh_mental_model",
];

function run(payload: unknown): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const r = spawnSync("bun", [HOOK], {
    input: typeof payload === "string" ? payload : JSON.stringify(payload),
    encoding: "utf-8",
    timeout: 30000,
  });
  return {
    status: r.status ?? 1,
    stdout: (r.stdout ?? "").trim(),
    stderr: r.stderr ?? "",
  };
}

describe("hindsight-mental-model-pretool hook", () => {
  it("DENIES each of the four write tools with the redirect message", () => {
    if (!bunOk) return;
    for (const tool of WRITE_TOOLS) {
      const r = run({ tool_name: tool, tool_input: { name: "x" } });
      expect(r.status).toBe(0);
      const out = JSON.parse(r.stdout);
      expect(out.decision).toBe("block");
      expect(out.reason).toBe(DENY_MESSAGE);
    }
  });

  it("ALLOWS hindsight read tools untouched", () => {
    if (!bunOk) return;
    for (const tool of [
      "mcp__hindsight__get_mental_model",
      "mcp__hindsight__list_mental_models",
      "mcp__hindsight__recall",
      "mcp__hindsight__retain",
      "mcp__hindsight__reflect",
      "mcp__hindsight__list_memories",
    ]) {
      const r = run({ tool_name: tool, tool_input: {} });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
  });

  it("ALLOWS arbitrary non-hindsight tools untouched", () => {
    if (!bunOk) return;
    for (const tool of [
      "Bash",
      "Read",
      "mcp__switchroom-telegram__mental_model_propose",
      "mcp__switchroom-telegram__reply",
      // A lookalike on a different server must NOT be caught (matcher
      // scopes to hindsight in scaffold, but the hook itself is exact-match).
      "mcp__other__create_mental_model",
    ]) {
      const r = run({ tool_name: tool, tool_input: { command: "ls" } });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
  });

  it("fails open on empty / non-JSON / unknown-shape stdin", () => {
    if (!bunOk) return;
    for (const bad of ["", "not-json", "{}", '{"tool_name":123}']) {
      const r = run(bad);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe("");
    }
  });
});
