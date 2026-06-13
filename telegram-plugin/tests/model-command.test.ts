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

// Regression for the 2026-06-13 fleet outage: defaults.model was pinned to
// the full codename `claude-fable-5`, which Anthropic retired server-side →
// every agent 4xx'd. The fix is to select models by ALIAS (durable) instead
// of pinned ids. This locks in that `fable` (and the other aliases) stay
// selectable, and documents the alias-vs-codename distinction.
describe("model selection: aliases stay selectable (incl. fable)", () => {
  it("lists fable as a first-class alias", () => {
    // `fable` is the latest flagship (Fable 5) and must remain pickable.
    expect(MODEL_ALIASES).toContain("fable");
    // The standard set is intact alongside it.
    for (const a of ["opus", "sonnet", "haiku", "default"]) {
      expect(MODEL_ALIASES, a).toContain(a);
    }
  });

  it("each alias is a valid model arg and parses as a set", () => {
    for (const alias of MODEL_ALIASES) {
      expect(isValidModelArg(alias), alias).toBe(true);
      expect(parseModelCommand(`/model ${alias}`)).toEqual({ kind: "set", model: alias });
    }
  });

  it("the help text surfaces the fable alias", async () => {
    const reply = await handleModelCommand({ kind: "help" }, makeDeps());
    expect(reply.text).toContain("fable");
  });

  it("passthrough: a full id (incl. the retired claude-fable-5 codename) is shape-accepted, not allowlisted", () => {
    // switchroom does NOT allowlist models — the SHAPE gate passes any
    // well-formed id through to claude, which is the sole validator. So the
    // retired `claude-fable-5` codename still parses here (it just 4xx's at
    // claude); selection flexibility (any current/future model) is preserved.
    expect(parseModelCommand("/model claude-fable-5")).toEqual({
      kind: "set",
      model: "claude-fable-5",
    });
    expect(isValidModelArg("claude-fable-5")).toBe(true);
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

// ---------------------------------------------------------------------------
// Picker-driven menu (v2) — buildModelMenu + handleModelMenuCallback
// ---------------------------------------------------------------------------

import {
  buildModelMenu,
  handleModelMenuCallback,
  modelSelectCallbackData,
  sessionModelFromConfirmation,
  MODEL_CALLBACK_REFRESH,
  type ModelMenuDeps,
} from "../gateway/model-command.js";
import { labelTag } from "../../src/agents/model-picker.js";

const OPTIONS = [
  { index: 1, label: "Default (recommended)", detail: "Opus 4.8 with 1M context", current: false },
  { index: 2, label: "Sonnet", detail: "Sonnet 4.6 · Efficient", current: true },
  { index: 3, label: "Haiku", detail: "Haiku 4.5 · Fastest", current: false },
];

function makeMenuDeps(overrides: Partial<ModelMenuDeps> = {}) {
  const calls = { discover: 0, select: [] as string[] };
  const base = makeDeps(); // v1 deps (inject/getConfiguredModel/escapeHtml/preBlock)
  const deps = {
    ...base.deps,
    discover: async () => {
      calls.discover++;
      return { ok: true as const, options: OPTIONS, currentLabel: "Sonnet" };
    },
    select: async (_a: string, label: string) => {
      calls.select.push(label);
      return { ok: true as const, confirmation: `Set model to ${label} for this session` };
    },
    isBusy: () => false,
    getQuotaBrief: async () => "29% / 5h · 33% / 7d",
    ...overrides,
  };
  return { deps, calls, injectCalls: base.calls };
}

describe("buildModelMenu", () => {
  it("renders current model, quota brief, and one button per discovered option", async () => {
    const { deps, calls } = makeMenuDeps();
    const menu = await buildModelMenu(deps);
    expect(calls.discover).toBe(1);
    expect(menu.text).toContain("<b>Sonnet</b>");
    expect(menu.text).toContain("29% / 5h · 33% / 7d");
    expect(menu.keyboard).toBeDefined();
    // 3 option rows + refresh row
    expect(menu.keyboard!.length).toBe(4);
    expect(menu.keyboard![1][0].text).toBe("✅ Sonnet");
    expect(menu.keyboard![0][0].text).toBe("Default (recommended)");
    expect(menu.keyboard![3][0].callback_data).toBe(MODEL_CALLBACK_REFRESH);
  });

  it("every callback_data fits Telegram's 64-byte cap", async () => {
    const { deps } = makeMenuDeps();
    const menu = await buildModelMenu(deps);
    for (const row of menu.keyboard!) {
      for (const btn of row) {
        expect(Buffer.byteLength(btn.callback_data, "utf-8")).toBeLessThanOrEqual(64);
      }
    }
  });

  it("busy agent → no discovery, no keyboard, explanatory text", async () => {
    const { deps, calls } = makeMenuDeps({ isBusy: () => true });
    const menu = await buildModelMenu(deps);
    expect(calls.discover).toBe(0);
    expect(menu.keyboard).toBeUndefined();
    expect(menu.text).toContain("mid-turn");
  });

  it("discovery failure → static v1 fallback with the reason, no keyboard", async () => {
    const { deps } = makeMenuDeps({
      discover: async () => ({ ok: false as const, reason: "tmux session not found" }),
    });
    const menu = await buildModelMenu(deps);
    expect(menu.keyboard).toBeUndefined();
    expect(menu.text).toContain("picker unavailable");
    expect(menu.text).toContain("Configured:");
  });

  it("quota failure never blocks the menu", async () => {
    const { deps } = makeMenuDeps({
      getQuotaBrief: async () => {
        throw new Error("broker down");
      },
    });
    const menu = await buildModelMenu(deps);
    expect(menu.keyboard).toBeDefined();
    expect(menu.text).not.toContain("Quota:");
  });
});

describe("handleModelMenuCallback", () => {
  it("mdl:s:<tag> selects by re-discovered label", async () => {
    const { deps, calls } = makeMenuDeps();
    const out = await handleModelMenuCallback(modelSelectCallbackData("Haiku"), deps);
    expect(calls.select).toEqual(["Haiku"]);
    expect(out.answer).toContain("Set model to Haiku");
    expect(out.reply.text).toContain("✅");
  });

  it("stale tag (options changed) → never selects, re-renders menu", async () => {
    const { deps, calls } = makeMenuDeps();
    const staleTag = `mdl:s:${labelTag("Removed Model")}`;
    const out = await handleModelMenuCallback(staleTag, deps);
    expect(calls.select).toEqual([]);
    expect(out.answer).toContain("refreshed");
    expect(out.reply.keyboard).toBeDefined();
  });

  it("tapping the ✔ (default) row STILL drives a switch — ✔ is the new-session default, not the live session model", async () => {
    // OPTIONS marks "Sonnet" current (the ✔). An agent launched on a
    // different model must still be able to apply the ✔ row to its live
    // session — skipping it was the "tapped Default, nothing happened" bug.
    const { deps, calls } = makeMenuDeps();
    const out = await handleModelMenuCallback(modelSelectCallbackData("Sonnet"), deps);
    expect(calls.select).toEqual(["Sonnet"]);
    expect(out.reply.text).toContain("✅");
    expect(out.reply.keyboard).toBeDefined();
  });

  it("busy agent → toastOnly refusal that leaves the menu untouched", async () => {
    const { deps, calls } = makeMenuDeps({ isBusy: () => true });
    const out = await handleModelMenuCallback(modelSelectCallbackData("Haiku"), deps);
    expect(calls.select).toEqual([]);
    expect(out.answer).toContain("mid-turn");
    // toastOnly tells the gateway to NOT edit the menu — buttons survive.
    expect(out.toastOnly).toBe(true);
  });

  it("selection failure surfaces the reason AND keeps the menu so the operator can retry", async () => {
    const { deps } = makeMenuDeps({
      select: async () => ({ ok: false as const, reason: "cursor verification failed" }),
    });
    const out = await handleModelMenuCallback(modelSelectCallbackData("Haiku"), deps);
    expect(out.answer).toContain("failed");
    expect(out.reply.text).toContain("cursor verification failed");
    // The menu buttons are preserved — a failure no longer collapses the
    // menu to a button-less error (the "nothing happened" bug).
    expect(out.reply.keyboard).toBeDefined();
  });

  it("a successful switch banners the confirmation, keeps the menu, AND reports the live model for /status", async () => {
    const { deps } = makeMenuDeps({
      select: async () => ({ ok: true as const, confirmation: "Set model to Haiku 4.5 for this session only" }),
    });
    const out = await handleModelMenuCallback(modelSelectCallbackData("Haiku"), deps);
    expect(out.answer).toContain("Haiku 4.5");
    expect(out.reply.text).toContain("✅");
    expect(out.reply.text).toContain("Set model to Haiku 4.5");
    expect(out.reply.keyboard).toBeDefined();
    // The gateway records this so /status reflects the live session model.
    expect(out.selectedModel).toBe("Haiku 4.5");
  });
});

describe("sessionModelFromConfirmation", () => {
  it("pulls the model name from claude's session-switch confirmation", () => {
    expect(sessionModelFromConfirmation("Set model to Fable 5 for this session only")).toBe("Fable 5");
    expect(sessionModelFromConfirmation("Set model to Opus 4.8 (1M context) for this session only")).toBe("Opus 4.8");
    expect(sessionModelFromConfirmation("Switched to Haiku 4.5")).toBe("Haiku 4.5");
  });
  it("returns null when no recognizable name is present", () => {
    expect(sessionModelFromConfirmation("Kept model as Opus 4.8 (default)")).toBeNull();
    expect(sessionModelFromConfirmation("")).toBeNull();
  });

  it("mdl:r re-renders the dashboard", async () => {
    const { deps, calls } = makeMenuDeps();
    const out = await handleModelMenuCallback(MODEL_CALLBACK_REFRESH, deps);
    expect(out.answer).toBe("Refreshed");
    expect(calls.discover).toBe(1);
    expect(out.reply.keyboard).toBeDefined();
  });
});
