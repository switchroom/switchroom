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
import { resolveStaleAwareBusy } from "../gateway/model-command.js";
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
    expect(r.text).toMatch(/lasts until the agent’s next restart/);
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
    expect(r.text).toMatch(/lasts until the agent’s next restart/);
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

// ─── #3039: /effort default + durable-override surfaces ─────────────────────

describe("effort-command: /effort default (#3039)", () => {
  it("parses `/effort default` as an explicit clear", () => {
    expect(parseEffortCommand("/effort default")).toEqual({ kind: "default" });
    expect(parseEffortCommand("/effort DEFAULT")).toEqual({ kind: "default" });
  });

  it("default restores the configured level, THEN clears the durable override (order pins the wrapper undo)", async () => {
    const events: string[] = [];
    const { deps } = makeDeps({
      getConfiguredEffort: () => "medium",
      applyEffort: async (_a, level) => {
        events.push(`apply:${level}`);
        return applyOk(level);
      },
      clearSessionEffort: () => events.push("clear"),
    });
    const r = await handleEffortCommand({ kind: "default" }, deps);
    expect(events).toEqual(["apply:medium", "clear"]);
    expect(r.text).toContain("override cleared");
    expect(r.text).toContain("`medium`");
  });

  it("default still clears the override when the live apply fails (boots on default from now on)", async () => {
    let cleared = false;
    const { deps } = makeDeps({
      applyEffort: async () => applyFail("apply_unverified"),
      clearSessionEffort: () => { cleared = true; },
    });
    const r = await handleEffortCommand({ kind: "default" }, deps);
    expect(cleared).toBe(true);
    expect(r.text).toContain("override cleared");
    // Honest: does not claim the live session switched.
    expect(r.text).toContain("Couldn't switch the live session right now");
  });

  it("show surfaces an active session override next to the configured default", async () => {
    const { deps } = makeDeps({ getConfiguredEffort: () => "low", getSessionEffort: () => "xhigh" });
    const r = await handleEffortCommand({ kind: "show" }, deps);
    expect(r.text).toContain("session override: `xhigh`");
  });

  it("menu marks the durable override as the live level", () => {
    const { deps } = makeDeps({ getConfiguredEffort: () => "low", getSessionEffort: () => "max" });
    const menu = buildEffortMenu(deps);
    const marked = menu.keyboard!.flat().find((b) => b.text.startsWith("✅"));
    expect(marked?.text).toBe("✅ max");
  });

  it("help text advertises /effort default and the session-only contract", async () => {
    const r = await handleEffortCommand({ kind: "help" }, makeDeps().deps);
    expect(r.text).toContain("/effort default");
    expect(r.text).toContain("lasts until the agent’s next restart");
  });

  // #3262 parity with /model: the gateway gates the effort apply-vs-queue on
  // `resolveModelEffortBusy().currentTurnActive` (the turn-atom leg — /effort
  // does not consult the delivery-machine/approval gate). These pin the SAME
  // stale-aware decision the gateway feeds that gate: a dangling atom older than
  // the hard TTL reads idle → APPLY; a fresh atom reads busy → QUEUE.
  describe("phantom 'active turn' apply-vs-queue (#3262)", () => {
    const HARD_TTL = 10 * 60_000;
    // The gateway's effort queue predicate, reduced to the signal it reads.
    const effortWouldQueue = (currentTurnActive: boolean): boolean => currentTurnActive;

    it("APPLIES a set when the turn atom is DANGLING (older than the hard TTL)", () => {
      const r = resolveStaleAwareBusy({
        currentTurnActive: true,
        turnAgeMs: HARD_TTL + 1,
        machineInTurn: false,
        oldestPendingApprovalAgeMs: null,
        hardTtlMs: HARD_TTL,
      });
      expect(r.clearStaleTurn).toBe(true);
      expect(effortWouldQueue(r.currentTurnActive)).toBe(false); // → applies now
    });

    it("QUEUES a set when the turn is FRESH (marker within the TTL) — no regression", () => {
      const r = resolveStaleAwareBusy({
        currentTurnActive: true,
        turnAgeMs: 5_000,
        machineInTurn: false,
        oldestPendingApprovalAgeMs: null,
        hardTtlMs: HARD_TTL,
      });
      expect(r.clearStaleTurn).toBe(false);
      expect(effortWouldQueue(r.currentTurnActive)).toBe(true); // → queues
    });

    it("APPLIES when there is no turn atom at all", () => {
      const r = resolveStaleAwareBusy({
        currentTurnActive: false,
        turnAgeMs: null,
        machineInTurn: false,
        oldestPendingApprovalAgeMs: null,
        hardTtlMs: HARD_TTL,
      });
      expect(effortWouldQueue(r.currentTurnActive)).toBe(false);
    });
  });
});
