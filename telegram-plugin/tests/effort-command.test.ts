/**
 * `/effort` Telegram command — parser + handler + menu coverage.
 *
 * Guarantees mirrored from `/model`:
 *   1. The argument is allowlist-gated before it's typed into the tmux
 *      pane — only the five levels claude accepts, nothing else.
 *   2. The set path injects exactly `/effort <level>` (claude's own REPL
 *      verb, on the inject allowlist) and relays the captured output with
 *      the session-only / reverts-on-restart caveat.
 *   3. The bare form renders a five-button menu; a tap injects the level.
 */
import { describe, it, expect } from "vitest";
import {
  parseEffortCommand,
  handleEffortCommand,
  isValidEffortArg,
  EFFORT_LEVELS,
  buildEffortMenu,
  handleEffortMenuCallback,
  effortSelectCallbackData,
  EFFORT_CALLBACK_PREFIX,
  type EffortCommandDeps,
} from "../gateway/effort-command.js";
import type { EffortApplyResult } from "../../src/agents/effort-picker.js";

function applyOk(level: string, confirmed = false): EffortApplyResult {
  return { ok: true, level, confirmed, output: `Set effort level to ${level}` };
}

function applyFail(
  reason: "session_missing" | "confirm_failed" | "apply_unverified",
  wedged?: boolean,
): EffortApplyResult {
  return { ok: false, reason, ...(wedged !== undefined ? { wedged } : {}) };
}

function makeDeps(overrides: Partial<EffortCommandDeps> = {}) {
  const calls: Array<{ agent: string; level: string }> = [];
  const deps: EffortCommandDeps = {
    applyEffort: async (agent, level) => {
      calls.push({ agent, level });
      return applyOk(level);
    },
    getAgentName: () => "carrie",
    getConfiguredEffort: () => "low",
    escapeHtml: (s) => s,
    ...overrides,
  };
  return { deps, calls };
}

describe("effort-command: levels + validation", () => {
  it("exposes exactly the five CLI levels in faster→smarter order", () => {
    expect(EFFORT_LEVELS).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("isValidEffortArg accepts levels case-insensitively, rejects others", () => {
    for (const l of EFFORT_LEVELS) {
      expect(isValidEffortArg(l)).toBe(true);
      expect(isValidEffortArg(l.toUpperCase())).toBe(true);
    }
    for (const bad of ["", "highest", "fast", "/effort", "low high", "9"]) {
      expect(isValidEffortArg(bad)).toBe(false);
    }
  });
});

describe("effort-command: parser", () => {
  it("bare /effort → show", () => {
    expect(parseEffortCommand("/effort")).toEqual({ kind: "show" });
    expect(parseEffortCommand("/effort   ")).toEqual({ kind: "show" });
  });

  it("/effort@bot suffix is tolerated", () => {
    expect(parseEffortCommand("/effort@carrie_bot")).toEqual({ kind: "show" });
  });

  it("/effort <level> → set, normalized to lowercase", () => {
    expect(parseEffortCommand("/effort high")).toEqual({ kind: "set", level: "high" });
    expect(parseEffortCommand("/effort XHIGH")).toEqual({ kind: "set", level: "xhigh" });
  });

  it("/effort help → help", () => {
    expect(parseEffortCommand("/effort help")).toEqual({ kind: "help" });
  });

  it("invalid level → help with a reason", () => {
    const p = parseEffortCommand("/effort turbo");
    expect(p?.kind).toBe("help");
    expect((p as { reason?: string }).reason).toMatch(/not a valid effort level/);
  });

  it("more than one token → help", () => {
    const p = parseEffortCommand("/effort high please");
    expect(p?.kind).toBe("help");
    expect((p as { reason?: string }).reason).toMatch(/single level/);
  });

  it("non-/effort text → null", () => {
    expect(parseEffortCommand("/model opus")).toBeNull();
    expect(parseEffortCommand("hello")).toBeNull();
  });
});

describe("effort-command: handler", () => {
  it("show renders the configured default", async () => {
    const { deps } = makeDeps({ getConfiguredEffort: () => "medium" });
    const r = await handleEffortCommand({ kind: "show" }, deps);
    expect(r.text).toContain("medium");
    expect(r.text).toMatch(/reverts to the configured default/);
  });

  it("show falls back to low when effort is unreadable", async () => {
    const { deps } = makeDeps({ getConfiguredEffort: () => null });
    const r = await handleEffortCommand({ kind: "show" }, deps);
    expect(r.text).toContain("low");
  });

  it("set applies exactly the level and relays output", async () => {
    const { deps, calls } = makeDeps();
    const r = await handleEffortCommand({ kind: "set", level: "high" }, deps);
    expect(calls).toEqual([{ agent: "carrie", level: "high" }]);
    expect(r.text).toContain("Set effort level to high");
    expect(r.text).toMatch(/reverts to the configured default/);
  });

  it("set notes the re-read cost when a confirmation was needed", async () => {
    const { deps } = makeDeps({ applyEffort: async (_a, l) => applyOk(l, true) });
    const r = await handleEffortCommand({ kind: "set", level: "high" }, deps);
    expect(r.text).toMatch(/re-reads the cached history/);
  });

  it("set surfaces a confirm_failed outcome honestly", async () => {
    const { deps } = makeDeps({ applyEffort: async () => applyFail("confirm_failed", false) });
    const r = await handleEffortCommand({ kind: "set", level: "max" }, deps);
    expect(r.text).toContain("couldn't confirm the switch");
    expect(r.text).toContain("❌");
  });

  it("set re-gates the level at the seam (defensive)", async () => {
    const { deps, calls } = makeDeps();
    // Hand-craft a parsed object that skipped the parser's gate.
    const r = await handleEffortCommand({ kind: "set", level: "evil; rm -rf" as never }, deps);
    expect(calls).toEqual([]); // never applied
    expect(r.text).toMatch(/not a valid effort level/);
  });
});

describe("effort-command: menu + callback", () => {
  it("buildEffortMenu offers all five levels with the configured one checked", () => {
    const { deps } = makeDeps({ getConfiguredEffort: () => "high" });
    const menu = buildEffortMenu(deps);
    const buttons = menu.keyboard!.flat();
    expect(buttons.map((b) => b.callback_data)).toEqual(
      EFFORT_LEVELS.map((l) => effortSelectCallbackData(l)),
    );
    const checked = buttons.find((b) => b.text.startsWith("✅"));
    expect(checked?.text).toBe("✅ high");
    expect(menu.keyboard![0]).toHaveLength(5);
  });

  it("callback eff:s:<level> applies the level and checks it in the re-render", async () => {
    const { deps, calls } = makeDeps();
    const out = await handleEffortMenuCallback(effortSelectCallbackData("xhigh"), deps);
    expect(calls).toEqual([{ agent: "carrie", level: "xhigh" }]);
    expect(out.selectedEffort).toBe("xhigh");
    expect(out.reply.text).toContain("Effort → ");
    const checked = out.reply.keyboard!.flat().find((b) => b.text.startsWith("✅"));
    expect(checked?.text).toBe("✅ xhigh");
  });

  it("callback notes the re-read when a confirmation was answered", async () => {
    const { deps } = makeDeps({ applyEffort: async (_a, l) => applyOk(l, true) });
    const out = await handleEffortMenuCallback(effortSelectCallbackData("high"), deps);
    expect(out.reply.text).toMatch(/re-reads history/);
    expect(out.selectedEffort).toBe("high");
  });

  it("callback with a failed apply keeps the menu and shows the error, no selection", async () => {
    const { deps } = makeDeps({ applyEffort: async () => applyFail("session_missing") });
    const out = await handleEffortMenuCallback(effortSelectCallbackData("max"), deps);
    expect(out.selectedEffort).toBeUndefined();
    expect(out.reply.text).toContain("❌");
    expect(out.reply.keyboard!.flat()).toHaveLength(5); // buttons preserved
  });

  it("callback surfaces a wedged confirm_failed as a warning, no selection", async () => {
    const { deps } = makeDeps({ applyEffort: async () => applyFail("confirm_failed", true) });
    const out = await handleEffortMenuCallback(effortSelectCallbackData("max"), deps);
    expect(out.selectedEffort).toBeUndefined();
    expect(out.reply.text).toMatch(/may still be open/);
  });

  it("callback ignores a malformed level", async () => {
    const { deps, calls } = makeDeps();
    const out = await handleEffortMenuCallback(`${EFFORT_CALLBACK_PREFIX}s:bogus`, deps);
    expect(calls).toEqual([]);
    expect(out.selectedEffort).toBeUndefined();
  });
});
