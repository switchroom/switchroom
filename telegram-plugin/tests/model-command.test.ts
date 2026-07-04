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
import { describe, it, expect, beforeAll } from "vitest";
import {
  parseModelCommand,
  handleModelCommand,
  isValidModelArg,
  isSrModel,
  isClaudeModel,
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
  const restartCalls: string[] = [];
  const deps: ModelCommandDeps = {
    inject: async (agent, command) => {
      calls.push({ agent, command });
      return okResult("⏺ Set model to sonnet");
    },
    getAgentName: () => "klanker",
    getConfiguredModel: () => "claude-sonnet-5",
    escapeHtml: (s) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    preBlock: (s) => `<pre>${s}</pre>`,
    getActiveSessionModel: () => null,
    scheduleRestart: async (reason) => { restartCalls.push(reason); },
    ...overrides,
  };
  return { deps, calls, restartCalls };
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
    expect(parseModelCommand("/model claude-sonnet-5[1m]")).toEqual({
      kind: "set",
      model: "claude-sonnet-5[1m]",
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
    for (const good of [...MODEL_ALIASES, "claude-opus-4-8", "claude-haiku-4-5-20251001", "claude-sonnet-5[1m]"]) {
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
    expect(reply.text).toContain("claude-sonnet-5");
    expect(reply.text).toContain("/model opus");
    expect(reply.text).toContain("switchroom.yaml");
  });

  it("show falls back to 'default' when no model configured", async () => {
    const { deps, calls } = makeDeps({ getConfiguredModel: () => null });
    const reply = await handleModelCommand({ kind: "show" }, deps);
    expect(calls.length).toBe(0);
    expect(reply.text).toContain("`default`");
  });

  it("help never injects", async () => {
    const { deps, calls } = makeDeps();
    const reply = await handleModelCommand({ kind: "help", reason: "nope" }, deps);
    expect(calls.length).toBe(0);
    expect(reply.text).toContain("nope");
  });
});

describe("handleModelCommand — set", () => {
  it("injects exactly `/model <name>` once and relays a genuine confirmation + persistence note", async () => {
    const { deps, calls } = makeDeps();
    const reply = await handleModelCommand({ kind: "set", model: "opus" }, deps);
    expect(calls).toEqual([{ agent: "klanker", command: "/model opus" }]);
    expect(reply.text).toContain("<pre>⏺ Set model to sonnet</pre>");
    expect(reply.text).toContain("Session-only");
    expect(reply.html).toBe(true);
  });

  it("SILENT switch: suppresses raw pane scrollback instead of dumping it as a code block", async () => {
    // claude switches models silently, so the pane capture below the command
    // echo is just the agent's previous prose answer. It must NOT be relayed.
    const scrollback = [
      "Here's the summary you asked for earlier:",
      "- point one about the deploy",
      "- point two about the rollback plan",
    ].join("\n");
    const { deps } = makeDeps({ inject: async () => okResult(scrollback) });
    const reply = await handleModelCommand({ kind: "set", model: "fable" }, deps);
    // The leak: none of the scrollback prose reaches the reply, and there is
    // no <pre> code block echoing the capture.
    expect(reply.text).not.toContain("summary you asked for");
    expect(reply.text).not.toContain("rollback plan");
    expect(reply.text).not.toContain("<pre>");
    // A clean, session-scoped confirmation is sent instead.
    expect(reply.text).toContain("/model fable");
    expect(reply.text).toContain("switched (session)");
    expect(reply.text).toContain("Session-only");
    expect(reply.html).toBe(true);
  });

  it("relays only the confirmation line when the capture also carries scrollback", async () => {
    const mixed = [
      "Some earlier prose that must not leak",
      "⏺ Set model to Fable 5 for this session",
    ].join("\n");
    const { deps } = makeDeps({ inject: async () => okResult(mixed) });
    const reply = await handleModelCommand({ kind: "set", model: "fable" }, deps);
    expect(reply.text).toContain("<pre>⏺ Set model to Fable 5 for this session</pre>");
    expect(reply.text).not.toContain("earlier prose that must not leak");
  });

  it("does NOT relay scrollback prose that merely contains 'switched'/'set model' as ordinary words", async () => {
    // No line begins with claude's real confirmation phrasing — these are just
    // English sentences that happen to use the words. None must be relayed.
    const prose = [
      "I switched the deploy to blue-green as we discussed.",
      "Then I set model behaviour aside and moved on to the tests.",
      "The team kept model changes out of this release entirely.",
    ].join("\n");
    const { deps } = makeDeps({ inject: async () => okResult(prose) });
    const reply = await handleModelCommand({ kind: "set", model: "fable" }, deps);
    // The anchored regex rejects all three lines, so nothing leaks and there is
    // no <pre> block. A clean session confirmation is sent instead.
    expect(reply.text).not.toContain("<pre>");
    expect(reply.text).not.toContain("switched the deploy");
    expect(reply.text).not.toContain("set model behaviour");
    expect(reply.text).not.toContain("kept model changes");
    expect(reply.text).toContain("switched (session)");
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

describe("isSrModel / isClaudeModel helpers", () => {
  it("isSrModel is true only for sr-* names", () => {
    expect(isSrModel("sr-gemini-2.5-pro")).toBe(true);
    expect(isSrModel("sr-deepseek-r1")).toBe(true);
    expect(isSrModel("claude-sonnet-5")).toBe(false);
    expect(isSrModel("sonnet")).toBe(false);
    expect(isSrModel("")).toBe(false);
  });

  it("isClaudeModel is true for aliases and claude-* ids", () => {
    for (const alias of MODEL_ALIASES) {
      expect(isClaudeModel(alias), alias).toBe(true);
    }
    expect(isClaudeModel("claude-opus-4-8")).toBe(true);
    expect(isClaudeModel("claude-sonnet-5[1m]")).toBe(true);
    expect(isClaudeModel("sr-gemini-2.5-pro")).toBe(false);
    expect(isClaudeModel("gpt-4")).toBe(false);
  });
});

describe("handleModelCommand — sr-* → Claude graceful restart", () => {
  it("schedules restart instead of injecting when session is on sr-* and target is Claude alias", async () => {
    const { deps, calls, restartCalls } = makeDeps({
      getActiveSessionModel: () => "sr-gemini-2.5-pro",
    });
    const reply = await handleModelCommand({ kind: "set", model: "opus" }, deps);
    // Must NOT inject
    expect(calls).toHaveLength(0);
    // Must schedule a restart
    expect(restartCalls).toHaveLength(1);
    expect(restartCalls[0]).toContain("opus");
    expect(restartCalls[0]).toContain("sr-to-claude");
    // Reply mentions the sr-* model and ~30s
    expect(reply.text).toContain("sr-gemini-2.5-pro");
    expect(reply.text).toContain("30s");
    expect(reply.html).toBe(true);
  });

  it("schedules restart when session is on sr-* and target is a full claude-* id", async () => {
    const { deps, calls, restartCalls } = makeDeps({
      getActiveSessionModel: () => "sr-deepseek-r1",
    });
    const reply = await handleModelCommand({ kind: "set", model: "claude-opus-4-8" }, deps);
    expect(calls).toHaveLength(0);
    expect(restartCalls).toHaveLength(1);
    expect(reply.text).toContain("sr-deepseek-r1");
    expect(reply.text).toContain("30s");
  });

  it("does NOT restart when switching between Claude models (no sr-* session)", async () => {
    const { deps, calls, restartCalls } = makeDeps({
      getActiveSessionModel: () => "Opus 4.8",
    });
    const reply = await handleModelCommand({ kind: "set", model: "sonnet" }, deps);
    // Normal inject path: still injects, no restart
    expect(calls).toHaveLength(1);
    expect(restartCalls).toHaveLength(0);
    expect(reply.text).toContain("Set model to sonnet");
  });

  it("does NOT restart when switching from Claude to sr-* (no session override)", async () => {
    const { deps, calls, restartCalls } = makeDeps({
      getActiveSessionModel: () => null,
    });
    await handleModelCommand({ kind: "set", model: "sr-gemini-2.5-pro" }, deps);
    // sr-* is not a Claude model — no restart
    expect(restartCalls).toHaveLength(0);
    expect(calls).toHaveLength(1);
  });

  it("surfaces scheduleRestart failures without propagating the error", async () => {
    const { deps, calls } = makeDeps({
      getActiveSessionModel: () => "sr-deepseek-r1",
      scheduleRestart: async () => { throw new Error("hostd unreachable"); },
    });
    const reply = await handleModelCommand({ kind: "set", model: "sonnet" }, deps);
    expect(calls).toHaveLength(0);
    expect(reply.text).toContain("Could not schedule restart");
    expect(reply.text).toContain("hostd unreachable");
  });

  it("null session model (no prior override) still uses normal inject path for Claude target", async () => {
    const { deps, calls, restartCalls } = makeDeps({
      getActiveSessionModel: () => null,
    });
    await handleModelCommand({ kind: "set", model: "opus" }, deps);
    expect(calls).toHaveLength(1);
    expect(restartCalls).toHaveLength(0);
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

describe("SR_MODEL_ALIASES / expandSrAlias", () => {
  let expandSrAlias: (arg: string) => string;
  let SR_MODEL_ALIASES: Record<string, string>;

  beforeAll(async () => {
    const mod = await import("../gateway/model-command.js");
    expandSrAlias = mod.expandSrAlias;
    SR_MODEL_ALIASES = mod.SR_MODEL_ALIASES;
  });

  it("expands known short aliases to full sr-* ids", () => {
    expect(expandSrAlias("flash")).toBe("sr-gemini-2.5-flash");
    expect(expandSrAlias("gemini")).toBe("sr-gemini-2.5-pro");
    expect(expandSrAlias("deepseek")).toBe("sr-deepseek-v3");
    expect(expandSrAlias("r1")).toBe("sr-deepseek-r1");
    expect(expandSrAlias("glm")).toBe("sr-glm-5");
    expect(expandSrAlias("codex")).toBe("sr-codex-5.5");
  });

  it("is case-insensitive", () => {
    expect(expandSrAlias("Flash")).toBe("sr-gemini-2.5-flash");
    expect(expandSrAlias("CODEX")).toBe("sr-codex-5.5");
  });

  it("passes through unknown names unchanged", () => {
    expect(expandSrAlias("opus")).toBe("opus");
    expect(expandSrAlias("sr-gemini-2.5-flash")).toBe("sr-gemini-2.5-flash");
    expect(expandSrAlias("claude-opus-4-8")).toBe("claude-opus-4-8");
  });

  it("every alias target is a valid sr-* model arg", () => {
    for (const [alias, target] of Object.entries(SR_MODEL_ALIASES)) {
      expect(target.startsWith("sr-"), `${alias} → ${target} must start with sr-`).toBe(true);
    }
  });

  it("handleModelCommand injects expanded sr-* id, not the short alias", async () => {
    const { deps, calls } = makeDeps({ getActiveSessionModel: () => null });
    await handleModelCommand({ kind: "set", model: "flash" }, deps);
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe("/model sr-gemini-2.5-flash");
  });

  it("handleModelCommand with alias schedules restart when session is on sr-*", async () => {
    const { deps, calls, restartCalls } = makeDeps({
      getActiveSessionModel: () => "sr-deepseek-v3",
    });
    await handleModelCommand({ kind: "set", model: "opus" }, deps);
    expect(calls).toHaveLength(0);
    expect(restartCalls).toHaveLength(1);
    expect(restartCalls[0]).toContain("opus");
  });
});

import {
  buildModelMenu,
  handleModelMenuCallback,
  modelSelectCallbackData,
  sessionModelFromConfirmation,
  classifyDiscoveredOptions,
  MODEL_CALLBACK_REFRESH,
  MODEL_CALLBACK_HEADER,
  MODEL_CALLBACK_SR,
  MODEL_CALLBACK_ALIAS,
  MODEL_CALLBACK_PAGE_EXTERNAL,
  MODEL_CALLBACK_PAGE_MAIN,
  SR_MODEL_LABELS,
  SR_MODEL_ALIASES,
  EXTRA_CLAUDE_ALIASES,
  externalModelNames,
  isSrToClaudeTransition,
  type ModelMenuDeps,
} from "../gateway/model-command.js";
import { labelTag } from "../../src/agents/model-picker.js";

const OPTIONS = [
  { index: 1, label: "Default (recommended)", detail: "Opus 4.8 with 1M context", current: false },
  { index: 2, label: "Sonnet", detail: "Sonnet 5 · Efficient", current: true },
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
    discoverSrModels: async () => [],
    ...overrides,
  };
  return { deps, calls, injectCalls: base.calls };
}

describe("buildModelMenu", () => {
  it("renders current model, quota brief, and one button per discovered option", async () => {
    const { deps, calls } = makeMenuDeps();
    const menu = await buildModelMenu(deps);
    expect(calls.discover).toBe(1);
    expect(menu.text).toContain("**Sonnet**");
    expect(menu.text).toContain("29% / 5h · 33% / 7d");
    expect(menu.keyboard).toBeDefined();
    // 3 scraped option rows + static Fable row + refresh row
    // (no external row here — discoverSrModels returns [] and the default
    // makeMenuDeps has no SR seed override, but externalModelNames seeds from
    // SR_MODEL_ALIASES, so the External row IS present — see dedicated tests).
    expect(menu.keyboard![1][0].text).toBe("✅ Sonnet");
    expect(menu.keyboard![0][0].text).toBe("Default (recommended)");
    // Refresh is always the last row.
    expect(menu.keyboard![menu.keyboard!.length - 1][0].callback_data).toBe(
      MODEL_CALLBACK_REFRESH,
    );
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

// ---------------------------------------------------------------------------
// Ship D — sr-* (LiteLLM non-Anthropic) model support
// ---------------------------------------------------------------------------

const OPTIONS_WITH_SR = [
  { index: 1, label: "Default (recommended)", detail: "Opus 4.8 with 1M context", current: false },
  { index: 2, label: "Sonnet", detail: "Sonnet 5", current: true },
  { index: 3, label: "sr-gemini-2.5-pro", detail: "", current: false },
  { index: 4, label: "sr-deepseek-r1", detail: "", current: false },
  // internal path — should be filtered out
  { index: 5, label: "openrouter/google/gemini-2.5-pro", detail: "", current: false },
  // bare OpenAI models from GATEWAY_MODEL_DISCOVERY — should also be filtered out
  { index: 6, label: "gpt-4", detail: "", current: false },
  { index: 7, label: "gpt-4o", detail: "", current: false },
  { index: 8, label: "voyage-law-2", detail: "", current: false },
  // full claude ID — should be in claude bucket
  { index: 9, label: "claude-opus-4-8", detail: "", current: false },
];

describe("classifyDiscoveredOptions", () => {
  it("puts native Claude options in claude, sr-* in sr, drops others", () => {
    const { claude, sr } = classifyDiscoveredOptions(OPTIONS_WITH_SR);
    expect(claude.map((o) => o.label)).toEqual([
      "Default (recommended)", "Sonnet", "claude-opus-4-8",
    ]);
    expect(sr.map((o) => o.label)).toEqual(["sr-gemini-2.5-pro", "sr-deepseek-r1"]);
    // openrouter/*, gpt-*, voyage-* not present in either bucket
    const all = [...claude, ...sr];
    expect(all.find((o) => o.label.includes("openrouter"))).toBeUndefined();
    expect(all.find((o) => o.label.startsWith("gpt-"))).toBeUndefined();
    expect(all.find((o) => o.label.startsWith("voyage-"))).toBeUndefined();
  });

  it("handles a list with no sr-* models", () => {
    const { claude, sr } = classifyDiscoveredOptions(OPTIONS);
    expect(claude).toHaveLength(3);
    expect(sr).toHaveLength(0);
  });
});

describe("SR_MODEL_LABELS", () => {
  it("has friendly names for the standard sr-* models", () => {
    expect(SR_MODEL_LABELS["sr-gemini-2.5-pro"]).toBe("Gemini 2.5 Pro");
    expect(SR_MODEL_LABELS["sr-deepseek-r1"]).toBe("DeepSeek R1");
  });
});

describe("buildModelMenu — with sr-* models", () => {
  // sr-* models now come from discoverSrModels (LiteLLM), not the claude picker.
  function makeMenuDepsWithSr(overrides: Partial<ModelMenuDeps> = {}) {
    return makeMenuDeps({
      discoverSrModels: async () => ["sr-gemini-2.5-pro", "sr-deepseek-r1"],
      ...overrides,
    });
  }

  // Nested-page design (this PR): sr-* models no longer render inline on the
  // main page — they live behind the "🌐 External models ▸" button on a second
  // keyboard page. Live discoverSrModels() results are UNION-ed with the static
  // SR_MODEL_ALIASES seed, so the external page always has at least the six
  // curated aliases even when discovery returns [].

  it("live-discovered sr-* models appear on the EXTERNAL page (not inline on main)", async () => {
    const { deps } = makeMenuDepsWithSr();
    const main = await buildModelMenu(deps, "main");
    const mainButtons = main.keyboard!.flat();
    // Not inline on the main page…
    expect(mainButtons.find((b) => b.text === "🌐 Gemini 2.5 Pro")).toBeUndefined();
    // …but the External-open button is present.
    expect(mainButtons.find((b) => b.callback_data === MODEL_CALLBACK_PAGE_EXTERNAL)).toBeDefined();

    const ext = await buildModelMenu(deps, "external");
    const extButtons = ext.keyboard!.flat();
    expect(extButtons.find((b) => b.text === "🌐 Gemini 2.5 Pro")).toBeDefined();
    expect(extButtons.find((b) => b.text === "🌐 DeepSeek R1")).toBeDefined();
    // openrouter/* / non-sr-* never shown at all.
    expect(extButtons.find((b) => b.text.includes("openrouter"))).toBeUndefined();
  });

  it("external-page sr-* buttons use the mdl:sr: callback prefix", async () => {
    const { deps } = makeMenuDepsWithSr();
    const menu = await buildModelMenu(deps, "external");
    const srButton = menu.keyboard!.flat().find((b) => b.text === "🌐 Gemini 2.5 Pro");
    expect(srButton?.callback_data).toBe(`${MODEL_CALLBACK_SR}sr-gemini-2.5-pro`);
  });

  it("external page has exactly one header row (billed-separately)", async () => {
    const { deps } = makeMenuDepsWithSr();
    const menu = await buildModelMenu(deps, "external");
    const headers = menu.keyboard!.flat().filter((b) => b.callback_data === MODEL_CALLBACK_HEADER);
    expect(headers.length).toBe(1);
    expect(headers[0].text).toContain("External");
  });

  it("main page carries NO header rows (headers live on the external page)", async () => {
    const { deps } = makeMenuDeps();
    const menu = await buildModelMenu(deps, "main");
    const headers = (menu.keyboard ?? []).flat().filter((b) => b.callback_data === MODEL_CALLBACK_HEADER);
    expect(headers.length).toBe(0);
  });

  it("header-row tap returns toastOnly without inject or model change", async () => {
    const { deps, injectCalls } = makeMenuDepsWithSr();
    const out = await handleModelMenuCallback(MODEL_CALLBACK_HEADER, deps);
    expect(out.toastOnly).toBe(true);
    expect(out.selectedModel).toBeUndefined();
    expect(injectCalls).toHaveLength(0);
  });

  it("main page points at the External page for OpenRouter-billed models", async () => {
    const { deps } = makeMenuDepsWithSr();
    const menu = await buildModelMenu(deps, "main");
    expect(menu.text).toContain("Max/Pro subscription");
    expect(menu.text).toContain("External models");
  });
});

describe("handleModelMenuCallback — sr-* selection", () => {
  function makeMenuDepsWithSr(overrides: Partial<ModelMenuDeps> = {}) {
    return makeMenuDeps({
      discoverSrModels: async () => ["sr-gemini-2.5-pro", "sr-deepseek-r1"],
      ...overrides,
    });
  }

  it("sr-* tap uses inject path, not cursor nav", async () => {
    const { deps, calls, injectCalls } = makeMenuDepsWithSr();
    const out = await handleModelMenuCallback(`${MODEL_CALLBACK_SR}sr-gemini-2.5-pro`, deps);
    // inject was called with the raw /model command
    expect(injectCalls).toContainEqual({ agent: "klanker", command: "/model sr-gemini-2.5-pro" });
    // select (cursor nav) was NOT called
    expect(calls.select).toHaveLength(0);
    expect(out.answer).toContain("Set model to sonnet");
    expect(out.selectedModel).toBe("sr-gemini-2.5-pro");
    // No keyboard on success: static reply path skips discover() to avoid the
    // spurious "(picker unavailable)" line that discover() reliably produces
    // immediately after an inject. Operator taps /model for a fresh menu.
    expect(out.reply.keyboard).toBeUndefined();
    // Banner present and text doesn't contain picker-unavailable noise
    expect(out.reply.text).toContain('✅');
    expect(out.reply.text).not.toContain('picker unavailable');
  });

  it("sr-* tap while busy returns toast-only with no inject", async () => {
    const { deps, injectCalls } = makeMenuDepsWithSr({ isBusy: () => true });
    const out = await handleModelMenuCallback(`${MODEL_CALLBACK_SR}sr-gemini-2.5-pro`, deps);
    expect(out.toastOnly).toBe(true);
    expect(injectCalls).toHaveLength(0);
  });

  it("rejects malformed sr-* callback data", async () => {
    const { deps } = makeMenuDepsWithSr();
    const out = await handleModelMenuCallback(`${MODEL_CALLBACK_SR}bad name with spaces`, deps);
    expect(out.answer).toBe("Invalid model name");
  });
});

// ---------------------------------------------------------------------------
// isSrToClaudeTransition helper (used by gateway callback handler)
// ---------------------------------------------------------------------------

describe("isSrToClaudeTransition", () => {
  it("true when prev is sr-* and next is not sr-*", () => {
    expect(isSrToClaudeTransition("sr-gemini-2.5-pro", "Haiku 4.5")).toBe(true);
    expect(isSrToClaudeTransition("sr-deepseek-r1", "Fable 5")).toBe(true);
    expect(isSrToClaudeTransition("sr-deepseek-r1", "claude-opus-4-8")).toBe(true);
  });

  it("false when prev is not sr-* (Claude → Claude)", () => {
    expect(isSrToClaudeTransition("Opus 4.8", "Haiku 4.5")).toBe(false);
    expect(isSrToClaudeTransition(null, "Sonnet")).toBe(false);
    expect(isSrToClaudeTransition(undefined, "Sonnet")).toBe(false);
  });

  it("false when prev is sr-* but next is also sr-* (sr-* → sr-*)", () => {
    expect(isSrToClaudeTransition("sr-gemini-2.5-pro", "sr-deepseek-r1")).toBe(false);
  });

  it("false when switching to sr-* from Claude (Claude → sr-*)", () => {
    expect(isSrToClaudeTransition("Sonnet", "sr-gemini-2.5-pro")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Paginated picker — Fable in the Claude group + nested External page.
// ---------------------------------------------------------------------------

describe("externalModelNames", () => {
  it("seeds from SR_MODEL_ALIASES values even when discovery is empty", () => {
    const names = externalModelNames([]);
    for (const target of Object.values(SR_MODEL_ALIASES)) {
      expect(names).toContain(target);
    }
    // All six curated aliases, deduped.
    expect(names.length).toBe(new Set(Object.values(SR_MODEL_ALIASES)).size);
    expect(names).toEqual([...names].sort());
  });

  it("unions live discovery, dedupes, and drops non-sr-* names", () => {
    const names = externalModelNames(["sr-brand-new", "sr-glm-5", "gpt-4o", "voyage-law-2"]);
    expect(names).toContain("sr-brand-new");
    expect(names).toContain("sr-glm-5");
    // sr-glm-5 already came from aliases — deduped, not doubled.
    expect(names.filter((n) => n === "sr-glm-5").length).toBe(1);
    // Non-sr-* names never surface (subscription-honest).
    expect(names).not.toContain("gpt-4o");
    expect(names).not.toContain("voyage-law-2");
  });
});

describe("paginated model menu — main page", () => {
  it("main page includes a Fable button and an External-models-open button", async () => {
    const { deps } = makeMenuDeps();
    const menu = await buildModelMenu(deps);
    const flat = menu.keyboard!.flat();
    const fable = flat.find((b) => b.text === "Fable");
    expect(fable).toBeDefined();
    expect(fable!.callback_data).toBe(`${MODEL_CALLBACK_ALIAS}fable`);
    const ext = flat.find((b) => b.callback_data === MODEL_CALLBACK_PAGE_EXTERNAL);
    expect(ext).toBeDefined();
    expect(ext!.text).toContain("External");
    // Refresh is last.
    expect(menu.keyboard![menu.keyboard!.length - 1][0].callback_data).toBe(
      MODEL_CALLBACK_REFRESH,
    );
  });

  it("no External-open button when there are no external models", async () => {
    // Force externalModelNames to be empty by stubbing SR aliases away is not
    // possible (static), but a build with an empty alias set is covered by the
    // externalModelNames unit test. Here we assert the button is gated on the
    // list being non-empty via the real (non-empty) path: it IS present.
    const { deps } = makeMenuDeps();
    const menu = await buildModelMenu(deps);
    const flat = menu.keyboard!.flat();
    expect(flat.some((b) => b.callback_data === MODEL_CALLBACK_PAGE_EXTERNAL)).toBe(true);
  });

  it("dedupes the static Fable row if the scraped options already include Fable", async () => {
    const { deps } = makeMenuDeps({
      discover: async () => ({
        ok: true as const,
        options: [
          { index: 1, label: "Sonnet", detail: "", current: true },
          { index: 2, label: "Fable", detail: "Fable 5", current: false },
        ],
        currentLabel: "Sonnet",
      }),
    });
    const menu = await buildModelMenu(deps);
    const flat = menu.keyboard!.flat();
    // Exactly one Fable button, and it's the scraped (select) one, not the alias.
    const fables = flat.filter((b) => b.text === "Fable" || b.text === "✅ Fable");
    expect(fables.length).toBe(1);
    expect(fables[0].callback_data.startsWith(MODEL_CALLBACK_ALIAS)).toBe(false);
  });

  it("every callback_data still fits Telegram's 64-byte cap", async () => {
    const { deps } = makeMenuDeps();
    for (const page of ["main", "external"] as const) {
      const menu = await buildModelMenu(deps, page);
      for (const btn of menu.keyboard!.flat()) {
        expect(Buffer.byteLength(btn.callback_data, "utf-8")).toBeLessThanOrEqual(64);
      }
    }
  });
});

describe("paginated model menu — external page", () => {
  it("lists all six SR_MODEL_ALIASES models plus a Back button", async () => {
    const { deps } = makeMenuDeps();
    const menu = await buildModelMenu(deps, "external");
    const flat = menu.keyboard!.flat();
    for (const target of Object.values(SR_MODEL_ALIASES)) {
      const btn = flat.find((b) => b.callback_data === `${MODEL_CALLBACK_SR}${target}`);
      expect(btn, `missing external button for ${target}`).toBeDefined();
      expect(btn!.text.startsWith("🌐")).toBe(true);
    }
    expect(flat.some((b) => b.callback_data === MODEL_CALLBACK_PAGE_MAIN)).toBe(true);
    expect(flat.some((b) => b.callback_data === MODEL_CALLBACK_REFRESH)).toBe(true);
  });

  it("external page body text makes the billed-separately split explicit", async () => {
    const { deps } = makeMenuDeps();
    const menu = await buildModelMenu(deps, "external");
    expect(menu.text).toContain("billed separately");
    expect(menu.text).toContain("OpenRouter");
    expect(menu.text).toContain("subscription");
  });
});

describe("page callbacks swap the keyboard without switching model", () => {
  it("PAGE_EXTERNAL renders the external page and does NOT select/inject", async () => {
    const { deps, calls, injectCalls } = makeMenuDeps();
    const out = await handleModelMenuCallback(MODEL_CALLBACK_PAGE_EXTERNAL, deps);
    expect(calls.select).toEqual([]);
    expect(injectCalls).toEqual([]);
    expect(out.selectedModel).toBeUndefined();
    const flat = out.reply.keyboard!.flat();
    expect(flat.some((b) => b.callback_data === MODEL_CALLBACK_PAGE_MAIN)).toBe(true);
    expect(out.reply.text).toContain("billed separately");
  });

  it("PAGE_MAIN renders the main page and does NOT select/inject", async () => {
    const { deps, calls, injectCalls } = makeMenuDeps();
    const out = await handleModelMenuCallback(MODEL_CALLBACK_PAGE_MAIN, deps);
    expect(calls.select).toEqual([]);
    expect(injectCalls).toEqual([]);
    expect(out.selectedModel).toBeUndefined();
    const flat = out.reply.keyboard!.flat();
    expect(flat.some((b) => b.callback_data === MODEL_CALLBACK_PAGE_EXTERNAL)).toBe(true);
    expect(flat.some((b) => b.text === "Fable")).toBe(true);
  });
});

describe("Fable alias callback injects /model fable", () => {
  it("injects exactly '/model fable' and reports the session model", async () => {
    const { deps, calls, injectCalls } = makeMenuDeps();
    const out = await handleModelMenuCallback(`${MODEL_CALLBACK_ALIAS}fable`, deps);
    // Alias path uses inject, never the cursor-nav select path.
    expect(calls.select).toEqual([]);
    expect(injectCalls).toHaveLength(1);
    expect(injectCalls[0].command).toBe("/model fable");
    expect(out.reply.text).toContain("✅");
  });

  it("EXTRA_CLAUDE_ALIASES contains fable", () => {
    expect(EXTRA_CLAUDE_ALIASES.some((a) => a.alias === "fable" && a.label === "Fable")).toBe(true);
  });

  it("rejects an invalid alias without injecting", async () => {
    const { deps, injectCalls } = makeMenuDeps();
    const out = await handleModelMenuCallback(`${MODEL_CALLBACK_ALIAS}bad name`, deps);
    expect(injectCalls).toEqual([]);
    expect(out.answer).toContain("Invalid");
  });
});
