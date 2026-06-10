/**
 * `/model` Telegram command — parser + handler coverage.
 *
 * The headline guarantees:
 *
 *   1. The bare `/model` form NEVER reaches the inject primitive —
 *      with no argument claude renders an interactive picker modal
 *      that Telegram can't drive (no arrows, no Esc), so injecting it
 *      would wedge the pane (the /rate-limit-options class of wedge).
 *   2. The argument is shape-gated before it's typed into the tmux
 *      pane: one token, no whitespace, no shell/control smuggling.
 *   3. The set path injects exactly `/model <name>` (claude's own
 *      REPL verb — already on the inject allowlist) and relays the
 *      captured output, with the session-only persistence caveat.
 */
import { describe, it, expect } from "vitest";
import {
  parseModelCommand,
  handleModelCommand,
  isValidModelArg,
  MODEL_ALIASES,
  type ModelCommandDeps,
} from "../gateway/model-command.js";
import type { InjectResult } from "../../src/agents/inject.js";

function okResult(output: string): InjectResult {
  return {
    outcome: "ok",
    output,
    truncated: false,
    command: "/model",
    meta: { description: "Open model picker", expectsOutput: true },
  };
}

function makeDeps(overrides: Partial<ModelCommandDeps> = {}) {
  const calls: Array<{ agent: string; command: string }> = [];
  const deps: ModelCommandDeps = {
    inject: async (agent, command) => {
      calls.push({ agent, command });
      return okResult("⏺ Set model to sonnet");
    },
    getAgentName: () => "klanker",
    getConfiguredModel: () => "claude-sonnet-4-6",
    escapeHtml: (s) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    preBlock: (s) => `<pre>${s}</pre>`,
    ...overrides,
  };
  return { deps, calls };
}

describe("parseModelCommand", () => {
  it("returns null for non-/model text", () => {
    expect(parseModelCommand("/auth list")).toBeNull();
    expect(parseModelCommand("model sonnet")).toBeNull();
    expect(parseModelCommand("/modelx sonnet")).toBeNull();
  });

  it("bare /model (and @botname form) parses as show", () => {
    expect(parseModelCommand("/model")).toEqual({ kind: "show" });
    expect(parseModelCommand("/model@klanker_bot")).toEqual({ kind: "show" });
    expect(parseModelCommand("/model   ")).toEqual({ kind: "show" });
  });

  it("single valid token parses as set", () => {
    expect(parseModelCommand("/model sonnet")).toEqual({ kind: "set", model: "sonnet" });
    expect(parseModelCommand("/model@bot claude-opus-4-8")).toEqual({
      kind: "set",
      model: "claude-opus-4-8",
    });
    // 1m-context variant ids carry brackets
    expect(parseModelCommand("/model claude-sonnet-4-6[1m]")).toEqual({
      kind: "set",
      model: "claude-sonnet-4-6[1m]",
    });
  });

  it("/model help parses as help", () => {
    expect(parseModelCommand("/model help")).toEqual({ kind: "help" });
  });

  it("rejects multi-token args (no second token can ride into the pane)", () => {
    const p = parseModelCommand("/model sonnet; rm -rf /");
    expect(p?.kind).toBe("help");
  });

  it("rejects shell/control smuggling shapes", () => {
    for (const bad of [
      "/model $(reboot)",
      "/model `id`",
      "/model -opus", // leading dash — looks like a flag
      "/model sonnet\nEnter",
      "/model ../../etc/passwd",
      "/model a|b",
    ]) {
      const p = parseModelCommand(bad);
      expect(p?.kind, `should reject: ${bad}`).toBe("help");
    }
  });
});

describe("isValidModelArg", () => {
  it("accepts aliases and full ids", () => {
    for (const good of [...MODEL_ALIASES, "claude-opus-4-8", "claude-haiku-4-5-20251001", "claude-sonnet-4-6[1m]"]) {
      expect(isValidModelArg(good), good).toBe(true);
    }
  });
  it("rejects whitespace, metacharacters, and over-long strings", () => {
    for (const bad of ["", " ", "a b", "a;b", "a/b", "-x", "a".repeat(120), "a\tb", "a\nb"]) {
      expect(isValidModelArg(bad), JSON.stringify(bad)).toBe(false);
    }
  });
});

describe("handleModelCommand — show / help never inject (picker-wedge guard)", () => {
  it("show renders configured model + switch options without injecting", async () => {
    const { deps, calls } = makeDeps();
    const reply = await handleModelCommand({ kind: "show" }, deps);
    expect(calls.length).toBe(0);
    expect(reply.text).toContain("claude-sonnet-4-6");
    expect(reply.text).toContain("/model opus");
    expect(reply.text).toContain("switchroom.yaml");
  });

  it("show falls back to 'default' when no model configured", async () => {
    const { deps, calls } = makeDeps({ getConfiguredModel: () => null });
    const reply = await handleModelCommand({ kind: "show" }, deps);
    expect(calls.length).toBe(0);
    expect(reply.text).toContain("<code>default</code>");
  });

  it("help never injects", async () => {
    const { deps, calls } = makeDeps();
    const reply = await handleModelCommand({ kind: "help", reason: "nope" }, deps);
    expect(calls.length).toBe(0);
    expect(reply.text).toContain("nope");
  });
});

describe("handleModelCommand — set", () => {
  it("injects exactly `/model <name>` once and relays output + persistence note", async () => {
    const { deps, calls } = makeDeps();
    const reply = await handleModelCommand({ kind: "set", model: "opus" }, deps);
    expect(calls).toEqual([{ agent: "klanker", command: "/model opus" }]);
    expect(reply.text).toContain("<pre>⏺ Set model to sonnet</pre>");
    expect(reply.text).toContain("Session-only");
    expect(reply.html).toBe(true);
  });

  it("re-gates the model arg at the seam (caller bypassing the parser)", async () => {
    const { deps, calls } = makeDeps();
    const reply = await handleModelCommand({ kind: "set", model: "a b; reboot" }, deps);
    expect(calls.length).toBe(0);
    expect(reply.text).toContain("not a valid model name");
  });

  it("ok_no_output explains the empty capture", async () => {
    const { deps } = makeDeps({
      inject: async () => ({
        outcome: "ok_no_output",
        output: "",
        truncated: false,
        command: "/model",
        meta: { description: "Open model picker", expectsOutput: true },
      }),
    });
    const reply = await handleModelCommand({ kind: "set", model: "sonnet" }, deps);
    expect(reply.text).toContain("no response captured");
  });

  it("session_missing failure surfaces the tmux-supervisor hint", async () => {
    const { deps } = makeDeps({
      inject: async () => ({
        outcome: "failed",
        output: "",
        truncated: false,
        command: "/model",
        meta: null,
        errorCode: "session_missing",
        errorMessage: "tmux session not found",
      }),
    });
    const reply = await handleModelCommand({ kind: "set", model: "sonnet" }, deps);
    expect(reply.text).toContain("tmux session not found");
    expect(reply.text).toContain("tmux supervisor");
  });

  it("inject throwing is surfaced, not propagated", async () => {
    const { deps } = makeDeps({
      inject: async () => {
        throw new Error("boom");
      },
    });
    const reply = await handleModelCommand({ kind: "set", model: "sonnet" }, deps);
    expect(reply.text).toContain("boom");
  });
});

describe("inject allowlist contract", () => {
  it("/model stays on the inject allowlist (the set path depends on it)", async () => {
    const { INJECT_COMMANDS } = await import("../../src/agents/inject.js");
    expect(INJECT_COMMANDS.has("/model")).toBe(true);
  });
});
