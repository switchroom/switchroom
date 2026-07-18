/**
 * `/model` Telegram command — parser + handler coverage (rev 5, DETERMINISTIC
 * SWITCH). This suite encodes the CURRENT contract after the inject-into-tmux +
 * terminal-scrape path was RETIRED (reference/rfcs/session-model-stickiness.md
 * §0.05):
 *
 *   1. The bare `/model` form renders the dashboard; it never applies a switch.
 *   2. The argument is shape-gated before it becomes a `claude --model` token.
 *   3. EVERY switch — typed Claude→Claude, Claude→sr-*, sr-*→Claude, the
 *      Fable/alias button, and the picker SELECT — routes through the carrier
 *      relaunch (`scheduleModelRelaunch` / `scheduleModelDefaultRelaunch`). No
 *      inject, no cursor-nav select, no scrape, no optimistic `/status` record.
 *
 * These tests FAIL on the OLD behavior on purpose: a Claude→Claude switch that
 * called `inject`, a picker tap that called `select`, or any reply carrying an
 * `optimistic` / scrape-derived `selectedModel` would not satisfy them.
 */
import { describe, it, expect } from "vitest";
import {
  parseModelCommand,
  planModelCommand,
  resolveStaleAwareBusy,
  isModelCommandBusy,
  modelCommandReceiptLine,
  handleModelCommand,
  isValidModelArg,
  isSrModel,
  isClaudeModel,
  isBusyRefusalText,
  isOfflineTrustedModelToken,
  classifyModelSwitchConfirmation,
  parseModelSwitchTarget,
  modelFamilyToken,
  MODEL_ALIASES,
  type ModelCommandDeps,
} from "../gateway/model-command.js";

/** A recorder-backed ModelCommandDeps. The inject/select deps are GONE (rev 5). */
function makeDeps(overrides: Partial<ModelCommandDeps> = {}) {
  const relaunchCalls: Array<{ model: string; reason: string }> = [];
  const defaultRelaunchCalls: string[] = [];
  const restartCalls: string[] = [];
  const deps: ModelCommandDeps = {
    getAgentName: () => "klanker",
    getConfiguredModel: () => "claude-sonnet-5",
    escapeHtml: (s) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    preBlock: (s) => `<pre>${s}</pre>`,
    getActiveSessionModel: () => null,
    isBusy: () => false,
    scheduleRestart: async (reason) => { restartCalls.push(reason); },
    scheduleModelRelaunch: async (model, reason) => { relaunchCalls.push({ model, reason }); },
    scheduleModelDefaultRelaunch: async (reason) => { defaultRelaunchCalls.push(reason); },
    ...overrides,
  };
  return { deps, relaunchCalls, defaultRelaunchCalls, restartCalls };
}

/** An error shaped like scheduleRestart's 15s-debounce throw. */
function restartInFlight(): Error {
  const e = new Error("a restart is already in flight — try again in ~15s");
  (e as { code?: string }).code = "restart_in_flight";
  return e;
}

describe("parseModelCommand", () => {
  it("bare /model → show", () => {
    expect(parseModelCommand("/model")).toEqual({ kind: "show" });
  });
  it("/model opus → set opus", () => {
    expect(parseModelCommand("/model opus")).toEqual({ kind: "set", model: "opus" });
  });
  it("/model help → help", () => {
    expect(parseModelCommand("/model help")).toEqual({ kind: "help" });
  });
  it("two args → help with reason", () => {
    const p = parseModelCommand("/model opus sonnet");
    expect(p?.kind).toBe("help");
  });
  it("invalid arg → help with reason", () => {
    const p = parseModelCommand("/model bad name!");
    expect(p?.kind).toBe("help");
  });
  it("non-/model text → null", () => {
    expect(parseModelCommand("hello")).toBeNull();
  });
});

describe("isValidModelArg", () => {
  it("accepts aliases + full ids + sr-*", () => {
    for (const a of ["opus", "sonnet", "haiku", "fable", "claude-opus-4-8", "sr-glm-5", "sr-gpt-5.5"]) {
      expect(isValidModelArg(a)).toBe(true);
    }
  });
  it("rejects whitespace / control / shell smuggling", () => {
    for (const bad of ["a b", "opus\n", "opus;rm", "", " "]) {
      expect(isValidModelArg(bad)).toBe(false);
    }
  });
});

describe("isSrModel / isClaudeModel", () => {
  it("classifies", () => {
    expect(isSrModel("sr-glm-5")).toBe(true);
    expect(isSrModel("opus")).toBe(false);
    expect(isClaudeModel("opus")).toBe(true);
    expect(isClaudeModel("claude-opus-4-8")).toBe(true);
    expect(isClaudeModel("fable")).toBe(true);
    expect(isClaudeModel("sr-glm-5")).toBe(false);
  });
});

// ─── The headline rev-5 contract: every switch relaunches, nothing injects ───

describe("handleModelCommand — set — deterministic carrier relaunch (rev 5)", () => {
  it("Claude→Claude `/model opus` (idle) calls scheduleModelRelaunch('opus') EXACTLY ONCE", async () => {
    // FAILS on old code: Claude→Claude went through the inject+scrape path and
    // NEVER called scheduleModelRelaunch.
    const { deps, relaunchCalls, defaultRelaunchCalls } = makeDeps();
    const reply = await handleModelCommand({ kind: "set", model: "opus" }, deps);
    expect(relaunchCalls).toHaveLength(1);
    expect(relaunchCalls[0].model).toBe("opus");
    expect(defaultRelaunchCalls).toHaveLength(0);
    expect(reply.text).toContain("relaunching the session");
    // No optimistic / scrape-derived fields on the reply (the retired-path guard).
    expect((reply as Record<string, unknown>).selectedModel).toBeUndefined();
    expect((reply as Record<string, unknown>).optimistic).toBeUndefined();
  });

  it("Claude→Claude with a full id relaunches on that id", async () => {
    const { deps, relaunchCalls } = makeDeps();
    await handleModelCommand({ kind: "set", model: "claude-opus-4-8" }, deps);
    expect(relaunchCalls).toEqual([
      expect.objectContaining({ model: "claude-opus-4-8" }),
    ]);
  });

  it("sr-* typed `/model sr-glm-5` relaunches once (regression guard)", async () => {
    const { deps, relaunchCalls } = makeDeps();
    await handleModelCommand({ kind: "set", model: "sr-glm-5" }, deps);
    expect(relaunchCalls).toEqual([expect.objectContaining({ model: "sr-glm-5" })]);
  });

  it("non-Claude token passes the RAW token through (accepted, not picker-validated)", async () => {
    const { deps, relaunchCalls } = makeDeps();
    await handleModelCommand({ kind: "set", model: "sr-gpt-5.5" }, deps);
    expect(relaunchCalls[0].model).toBe("sr-gpt-5.5");
  });

  it("short alias expands before relaunch (`flash` → `sr-gemini-2.5-flash`)", async () => {
    const { deps, relaunchCalls } = makeDeps();
    await handleModelCommand({ kind: "set", model: "flash" }, deps);
    expect(relaunchCalls[0].model).toBe("sr-gemini-2.5-flash");
  });

  it("sr-*→Claude relaunches on the Claude token (no special inject path)", async () => {
    const { deps, relaunchCalls } = makeDeps({ getActiveSessionModel: () => "sr-deepseek-v3" });
    await handleModelCommand({ kind: "set", model: "opus" }, deps);
    expect(relaunchCalls).toEqual([expect.objectContaining({ model: "opus" })]);
  });

  it("`/model default` calls scheduleModelDefaultRelaunch, NOT scheduleModelRelaunch", async () => {
    const { deps, relaunchCalls, defaultRelaunchCalls } = makeDeps();
    const reply = await handleModelCommand({ kind: "set", model: "default" }, deps);
    expect(defaultRelaunchCalls).toHaveLength(1);
    expect(relaunchCalls).toHaveLength(0);
    expect(reply.text).toContain("Reverting to the configured default");
  });

  it("busy session refuses without scheduling anything", async () => {
    const { deps, relaunchCalls, defaultRelaunchCalls } = makeDeps({ isBusy: () => true });
    const reply = await handleModelCommand({ kind: "set", model: "opus" }, deps);
    expect(relaunchCalls).toHaveLength(0);
    expect(defaultRelaunchCalls).toHaveLength(0);
    expect(reply.text).toContain("mid-turn");
  });

  it("debounce: a restart_in_flight throw yields the ~15s copy, not a double-dispatch", async () => {
    let calls = 0;
    const { deps } = makeDeps({
      scheduleModelRelaunch: async () => { calls++; throw restartInFlight(); },
    });
    const reply = await handleModelCommand({ kind: "set", model: "opus" }, deps);
    expect(calls).toBe(1);
    expect(reply.text).toContain("~15s");
  });

  it("a generic dispatch failure surfaces an honest error", async () => {
    const { deps } = makeDeps({
      scheduleModelRelaunch: async () => { throw new Error("hostd down"); },
    });
    const reply = await handleModelCommand({ kind: "set", model: "opus" }, deps);
    expect(reply.text).toContain("Could not schedule model switch");
  });

  it("the reply type carries no optimistic/selectedModel field on ANY set outcome", async () => {
    // The retired-contract guard (F3): the fields were DELETED from the reply,
    // so an unapplied switch can no longer be optimistically recorded.
    const { deps } = makeDeps();
    for (const model of ["opus", "sr-glm-5", "default", "fable"]) {
      const reply = await handleModelCommand({ kind: "set", model }, deps);
      expect(Object.prototype.hasOwnProperty.call(reply, "selectedModel")).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(reply, "optimistic")).toBe(false);
    }
  });
});

describe("handleModelCommand — show / help never schedule a switch", () => {
  it("show renders the configured model + options, schedules nothing", async () => {
    const { deps, relaunchCalls, defaultRelaunchCalls } = makeDeps();
    const reply = await handleModelCommand({ kind: "show" }, deps);
    expect(reply.text).toContain("claude-sonnet-5");
    expect(relaunchCalls).toHaveLength(0);
    expect(defaultRelaunchCalls).toHaveLength(0);
  });
  it("help lists the aliases including fable", async () => {
    const reply = await handleModelCommand({ kind: "help" }, makeDeps().deps);
    for (const a of MODEL_ALIASES) expect(reply.text).toContain(a);
  });
});

// ─── Menu / callback deterministic relaunch ─────────────────────────────────

import {
  buildModelMenu,
  handleModelMenuCallback,
  modelSelectCallbackData,
  isRecognizedSwitchToken,
  classifyDiscoveredOptions,
  canonicalClaudeToken,
  MODEL_CALLBACK_REFRESH,
  MODEL_CALLBACK_SR,
  MODEL_CALLBACK_ALIAS,
  MODEL_CALLBACK_PAGE_EXTERNAL,
  SR_MODEL_LABELS,
  SR_MODEL_ALIASES,
  EXTRA_CLAUDE_ALIASES,
  expandSrAlias,
  externalModelNames,
  type ModelMenuDeps,
} from "../gateway/model-command.js";

const OPTIONS = [
  { index: 1, label: "Default (recommended)", detail: "Opus 4.8 with 1M context", current: false },
  { index: 2, label: "Sonnet", detail: "Sonnet 5 · Efficient", current: true },
  { index: 3, label: "Haiku", detail: "Haiku 4.5 · Fastest", current: false },
];

function makeMenuDeps(overrides: Partial<ModelMenuDeps & ModelCommandDeps> = {}) {
  const base = makeDeps();
  const calls = { discover: 0 };
  const deps: ModelMenuDeps & ModelCommandDeps = {
    ...base.deps,
    discover: async () => {
      calls.discover++;
      return { ok: true as const, options: OPTIONS, currentLabel: "Sonnet" };
    },
    isBusy: () => false,
    getQuotaBrief: async () => "29% / 5h · 33% / 7d",
    discoverSrModels: async () => [],
    ...overrides,
  };
  return {
    deps,
    calls,
    relaunchCalls: base.relaunchCalls,
    defaultRelaunchCalls: base.defaultRelaunchCalls,
  };
}

describe("modelSelectCallbackData — embeds the canonical token (rev 5)", () => {
  it("an alias row carries the alias token", () => {
    expect(modelSelectCallbackData("Haiku")).toBe("mdl:s:haiku");
  });
  it("a full-id row carries the id", () => {
    expect(modelSelectCallbackData("claude-opus-4-8")).toBe("mdl:s:claude-opus-4-8");
  });
  it("the Default row carries the `default` sentinel", () => {
    expect(modelSelectCallbackData("Default (recommended)")).toBe("mdl:s:default");
  });
  it("N2: an UNMAPPED Claude row does NOT collapse to the `default` sentinel", () => {
    // A label whose first word is neither a known alias nor claude-* nor default
    // must not masquerade as a default-revert; it carries an empty (rejected) suffix.
    expect(modelSelectCallbackData("Sparkle 9 (preview)")).toBe("mdl:s:");
    expect(modelSelectCallbackData("Sparkle 9 (preview)")).not.toBe("mdl:s:default");
  });
});

describe("isRecognizedSwitchToken (N1 allowlist)", () => {
  it("accepts default, sr-*, aliases, and claude-* ids", () => {
    for (const t of ["default", "sr-glm-5", "opus", "fable", "claude-opus-4-8"]) {
      expect(isRecognizedSwitchToken(t)).toBe(true);
    }
  });
  it("rejects a stale 8-hex labelTag and other garbage", () => {
    for (const t of ["1a2b3c4d", "", "deadbeef", "Sparkle9"]) {
      expect(isRecognizedSwitchToken(t)).toBe(false);
    }
  });
});

describe("handleModelMenuCallback — every switch tap relaunches (rev 5)", () => {
  it("picker SELECT `mdl:s:haiku` relaunches on 'haiku' and never scrapes/selects", async () => {
    // FAILS on old code: the SELECT branch called deps.select and re-discovered
    // the picker; here there is no select dep at all.
    const { deps, relaunchCalls, calls } = makeMenuDeps();
    const out = await handleModelMenuCallback(modelSelectCallbackData("Haiku"), deps);
    expect(relaunchCalls).toEqual([expect.objectContaining({ model: "haiku" })]);
    // The switch path does NOT drive discovery.
    expect(calls.discover).toBe(0);
    expect(out.reply.text).toContain("relaunching");
    expect(Object.prototype.hasOwnProperty.call(out, "selectedModel")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(out, "selectedModelToken")).toBe(false);
  });

  it("N1: a stale SELECT token (old 8-hex labelTag) does NOT relaunch — re-renders instead", async () => {
    // A menu rendered by the OLD gateway carries `mdl:s:<hex>`. The hex passes the
    // loose shape gate but is not a recognized model token; relaunching onto it
    // would write a garbage carrier that --fallback-model silently masks. The
    // handler must re-render, not schedule anything.
    const { deps, relaunchCalls, defaultRelaunchCalls } = makeMenuDeps();
    const out = await handleModelMenuCallback("mdl:s:1a2b3c4d", deps);
    expect(relaunchCalls).toHaveLength(0);
    expect(defaultRelaunchCalls).toHaveLength(0);
    expect(out.answer).toContain("menu refreshed");
  });

  it("N1: an empty SELECT suffix (unmapped row) does NOT relaunch", async () => {
    const { deps, relaunchCalls, defaultRelaunchCalls } = makeMenuDeps();
    await handleModelMenuCallback("mdl:s:", deps);
    expect(relaunchCalls).toHaveLength(0);
    expect(defaultRelaunchCalls).toHaveLength(0);
  });

  it("picker SELECT of the Default row routes to the default relaunch", async () => {
    const { deps, relaunchCalls, defaultRelaunchCalls } = makeMenuDeps();
    await handleModelMenuCallback("mdl:s:default", deps);
    expect(defaultRelaunchCalls).toHaveLength(1);
    expect(relaunchCalls).toHaveLength(0);
  });

  it("Fable button `mdl:alias:fable` relaunches on 'fable' (never injects)", async () => {
    // FAILS on old code: the alias branch injected `/model fable` and scraped.
    const { deps, relaunchCalls } = makeMenuDeps();
    await handleModelMenuCallback(`${MODEL_CALLBACK_ALIAS}fable`, deps);
    expect(relaunchCalls).toEqual([expect.objectContaining({ model: "fable" })]);
  });

  it("Default alias button routes to the default relaunch", async () => {
    const { deps, relaunchCalls, defaultRelaunchCalls } = makeMenuDeps();
    await handleModelMenuCallback(`${MODEL_CALLBACK_ALIAS}default`, deps);
    expect(defaultRelaunchCalls).toHaveLength(1);
    expect(relaunchCalls).toHaveLength(0);
  });

  it("sr-* tap `mdl:sr:sr-glm-5` relaunches on the sr id", async () => {
    const { deps, relaunchCalls } = makeMenuDeps();
    await handleModelMenuCallback(`${MODEL_CALLBACK_SR}sr-glm-5`, deps);
    expect(relaunchCalls).toEqual([expect.objectContaining({ model: "sr-glm-5" })]);
  });

  it("a switch tap while mid-turn refuses (toastOnly) and schedules nothing", async () => {
    const { deps, relaunchCalls } = makeMenuDeps({ isBusy: () => true });
    const out = await handleModelMenuCallback(`${MODEL_CALLBACK_ALIAS}opus`, deps);
    expect(out.toastOnly).toBe(true);
    expect(out.busyRefusal).toBe(true);
    expect(relaunchCalls).toHaveLength(0);
  });

  it("restart_in_flight on a menu tap yields the ~15s copy, one dispatch", async () => {
    let calls = 0;
    const { deps } = makeMenuDeps({
      scheduleModelRelaunch: async () => { calls++; throw restartInFlight(); },
    });
    const out = await handleModelMenuCallback(`${MODEL_CALLBACK_ALIAS}fable`, deps);
    expect(calls).toBe(1);
    expect(out.reply.text).toContain("~15s");
  });

  it("Refresh re-renders without scheduling", async () => {
    const { deps, relaunchCalls } = makeMenuDeps();
    const out = await handleModelMenuCallback(MODEL_CALLBACK_REFRESH, deps);
    expect(relaunchCalls).toHaveLength(0);
    expect(out.answer).toBe("Refreshed");
  });

  it("page-nav swaps the keyboard without scheduling", async () => {
    const { deps, relaunchCalls } = makeMenuDeps();
    await handleModelMenuCallback(MODEL_CALLBACK_PAGE_EXTERNAL, deps);
    expect(relaunchCalls).toHaveLength(0);
  });
});

describe("buildModelMenu — render only (discovery is not the switch path)", () => {
  it("renders current model, quota, and one button per option", async () => {
    const { deps, calls } = makeMenuDeps();
    const menu = await buildModelMenu(deps);
    expect(calls.discover).toBe(1);
    expect(menu.text).toContain("**Sonnet**");
    expect(menu.text).toContain("29% / 5h · 33% / 7d");
    expect(menu.keyboard).toBeDefined();
    // SELECT rows now carry canonical tokens, not label hashes.
    const selectRows = menu.keyboard!.flat().map((b) => b.callback_data).filter((d) => d.startsWith("mdl:s:"));
    expect(selectRows).toContain("mdl:s:default");
    expect(selectRows).toContain("mdl:s:haiku");
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

  it("busy agent → static keyboard, no discovery", async () => {
    const { deps, calls } = makeMenuDeps({ isBusy: () => true });
    const menu = await buildModelMenu(deps);
    expect(calls.discover).toBe(0);
    const data = menu.keyboard!.flat().map((b) => b.callback_data);
    expect(data).toContain("mdl:alias:opus");
    expect(data).toContain("mdl:alias:default");
  });
});

// ─── Preserved pure-logic helpers ───────────────────────────────────────────

describe("canonicalClaudeToken", () => {
  it("aliases → alias, ids → id, Default → null", () => {
    expect(canonicalClaudeToken("Opus")).toBe("opus");
    expect(canonicalClaudeToken("claude-opus-4-8")).toBe("claude-opus-4-8");
    expect(canonicalClaudeToken("Default (recommended)")).toBeNull();
  });
});

describe("SR_MODEL_ALIASES / expandSrAlias", () => {
  it("expands known aliases, passes others through", () => {
    expect(expandSrAlias("flash")).toBe("sr-gemini-2.5-flash");
    expect(expandSrAlias("opus")).toBe("opus");
    expect(expandSrAlias("sr-glm-5")).toBe("sr-glm-5");
  });
  it("every alias target is a sr-* id", () => {
    for (const target of Object.values(SR_MODEL_ALIASES)) expect(isSrModel(target)).toBe(true);
  });
  it("2026-07-19 grok/kimi/gpt flagship buttons expand to their sr-* ids", () => {
    expect(expandSrAlias("grok")).toBe("sr-grok-4.5");
    expect(expandSrAlias("kimi")).toBe("sr-kimi-k3");
    expect(expandSrAlias("gpt")).toBe("sr-gpt-5.6-sol");
  });
  it("per-tier GPT-5.6 buttons sol/terra/luna expand to their sr-* ids", () => {
    expect(expandSrAlias("sol")).toBe("sr-gpt-5.6-sol");
    expect(expandSrAlias("terra")).toBe("sr-gpt-5.6-terra");
    expect(expandSrAlias("luna")).toBe("sr-gpt-5.6-luna");
    for (const a of ["sol", "terra", "luna"]) expect(isOfflineTrustedModelToken(a)).toBe(true);
  });
  it("new flagship buttons are offline-trustable carriers (#3042 gate)", () => {
    for (const a of ["grok", "kimi", "gpt"]) expect(isOfflineTrustedModelToken(a)).toBe(true);
    for (const id of ["sr-grok-4.5", "sr-kimi-k3", "sr-gpt-5.6-sol"])
      expect(isOfflineTrustedModelToken(id)).toBe(true);
  });
  it("labels every new grok/kimi/gpt-5.6 sr-* id (typeable tiers included)", () => {
    for (const id of [
      "sr-grok-4.5",
      "sr-grok-4.3",
      "sr-kimi-k3",
      "sr-kimi-k2.7-code",
      "sr-gpt-5.6-sol",
      "sr-gpt-5.6-terra",
      "sr-gpt-5.6-luna",
    ]) {
      expect(SR_MODEL_LABELS[id]).toBeTypeOf("string");
      expect(isValidModelArg(id)).toBe(true);
    }
  });
});

describe("classifyDiscoveredOptions", () => {
  it("splits native Claude rows from sr-* rows and drops routing paths", () => {
    const { claude, sr } = classifyDiscoveredOptions([
      { index: 1, label: "Opus", current: false },
      { index: 2, label: "sr-glm-5", current: false },
      { index: 3, label: "openrouter/foo", current: false },
      { index: 4, label: "gpt-4o", current: false },
    ]);
    expect(claude.map((o) => o.label)).toEqual(["Opus"]);
    expect(sr.map((o) => o.label)).toEqual(["sr-glm-5"]);
  });
});

describe("externalModelNames / SR_MODEL_LABELS / EXTRA_CLAUDE_ALIASES", () => {
  it("seeds from the curated alias targets and merges discovered sr-*", () => {
    const names = externalModelNames(["sr-gpt-oss-20b"]);
    expect(names).toContain("sr-gemini-2.5-flash");
    expect(names).toContain("sr-gpt-oss-20b");
  });
  it("Fable is offered as an extra Claude alias", () => {
    expect(EXTRA_CLAUDE_ALIASES.some((a) => a.alias === "fable")).toBe(true);
  });
  it("labels are display-only strings", () => {
    expect(SR_MODEL_LABELS["sr-glm-5"]).toBeTypeOf("string");
  });
});

describe("isOfflineTrustedModelToken (#3042 blocker 2a)", () => {
  it("trusts static aliases + curated sr targets, refuses arbitrary ids", () => {
    expect(isOfflineTrustedModelToken("opus")).toBe(true);
    expect(isOfflineTrustedModelToken("OPUS")).toBe(true);
    expect(isOfflineTrustedModelToken("flash")).toBe(true);
    expect(isOfflineTrustedModelToken("sr-gemini-2.5-flash")).toBe(true);
    expect(isOfflineTrustedModelToken("claude-random-9")).toBe(false);
    expect(isOfflineTrustedModelToken("sr-obscure-xyz")).toBe(false);
  });
});

describe("isBusyRefusalText (#3039)", () => {
  it("matches the mid-turn refusal copy", () => {
    expect(isBusyRefusalText("⏳ The agent is mid-turn — …")).toBe(true);
    expect(isBusyRefusalText("done")).toBe(false);
  });
});

describe("#3177 — routing decision helpers", () => {
  it("isModelCommandBusy folds both signals", () => {
    expect(isModelCommandBusy({ currentTurnActive: true, turnInFlight: false })).toBe(true);
    expect(isModelCommandBusy({ currentTurnActive: false, turnInFlight: true })).toBe(true);
    expect(isModelCommandBusy({ currentTurnActive: false, turnInFlight: false })).toBe(false);
  });

  it("planModelCommand routes each shape", () => {
    const idle = { currentTurnActive: false, turnInFlight: false, menuEnabled: true };
    expect(planModelCommand({ kind: "show" }, idle)).toEqual({ kind: "menu" });
    expect(planModelCommand({ kind: "set", model: "opus" }, idle)).toEqual({
      kind: "apply",
      parsed: { kind: "set", model: "opus" },
    });
    const busy = { currentTurnActive: true, turnInFlight: false, menuEnabled: true };
    expect(planModelCommand({ kind: "set", model: "flash" }, busy)).toEqual({
      kind: "queue",
      target: "sr-gemini-2.5-flash",
    });
  });

  it("resolveStaleAwareBusy discounts a stale turn atom", () => {
    const out = resolveStaleAwareBusy({
      currentTurnActive: true,
      turnAgeMs: 10 * 60_000,
      machineInTurn: false,
      oldestPendingApprovalAgeMs: null,
      hardTtlMs: 5 * 60_000,
    });
    expect(out.currentTurnActive).toBe(false);
    expect(out.clearStaleTurn).toBe(true);
  });

  it("modelCommandReceiptLine is stable + greppable", () => {
    const line = modelCommandReceiptLine("klanker", { kind: "set", model: "opus" }, false);
    expect(line).toContain("gw /model received");
    expect(line).toContain("agent=klanker");
    expect(line).toContain("arg=opus");
  });
});

describe("parseModelSwitchTarget", () => {
  it("extracts the target from a menu relaunch reason", () => {
    expect(
      parseModelSwitchTarget("user: /model fable (session-only relaunch, menu)"),
    ).toBe("fable");
  });
  it("extracts the target from a typed relaunch reason", () => {
    expect(
      parseModelSwitchTarget("user: /model sr-gemini-2.5-flash (session-only relaunch)"),
    ).toBe("sr-gemini-2.5-flash");
  });
  it("extracts the default sentinel from a revert reason", () => {
    expect(parseModelSwitchTarget("user: /model default (revert relaunch)")).toBe("default");
  });
  it("returns null for a non-/model reason", () => {
    expect(parseModelSwitchTarget("cli: restart")).toBeNull();
  });
});

describe("classifyModelSwitchConfirmation", () => {
  // The regression this fix closes: a /model fable apply-boot that reverted to
  // the configured default (opus) must be reported as NOT-applied (⚠️), not as a
  // green "✅ Now running opus (the configured default)". Under the OLD inline
  // logic (isApplyBoot ? applied : green-default) this exact case produced the
  // misleading green card — this asserts the corrected outcome.
  it("flags a non-default switch that reverted to the configured default as not-applied", () => {
    const out = classifyModelSwitchConfirmation({
      reason: "user: /model fable (session-only relaunch, menu)",
      launched: "opus",
      configured: "opus",
    });
    expect(out).toEqual({ kind: "not-applied", target: "fable", revertedTo: "opus" });
  });

  it("reports an applied switch when the launched model differs from the default", () => {
    const out = classifyModelSwitchConfirmation({
      reason: "user: /model fable (session-only relaunch, menu)",
      launched: "fable",
      configured: "opus",
    });
    expect(out).toEqual({ kind: "applied", launched: "fable" });
  });

  it("reports the default (green) for an intended /model default revert", () => {
    const out = classifyModelSwitchConfirmation({
      reason: "user: /model default (revert relaunch)",
      launched: "opus",
      configured: "opus",
    });
    expect(out).toEqual({ kind: "default", launched: "opus" });
  });

  it("reports the default (green) when the operator asked for the configured model itself", () => {
    // /model opus while configured=opus is a SUCCESS, not a silent revert.
    const out = classifyModelSwitchConfirmation({
      reason: "user: /model opus (session-only relaunch)",
      launched: "opus",
      configured: "opus",
    });
    expect(out).toEqual({ kind: "default", launched: "opus" });
  });

  it("is case-insensitive on the target-vs-launched comparison", () => {
    const out = classifyModelSwitchConfirmation({
      reason: "user: /model OPUS (session-only relaunch)",
      launched: "opus",
      configured: "opus",
    });
    expect(out).toEqual({ kind: "default", launched: "opus" });
  });

  it("treats an empty launched value (unreadable .active-session-model) as a revert to the default", () => {
    const out = classifyModelSwitchConfirmation({
      reason: "user: /model fable (session-only relaunch, menu)",
      launched: "",
      configured: "opus",
    });
    expect(out).toEqual({ kind: "not-applied", target: "fable", revertedTo: "opus" });
  });

  // LOW-1: an ALIAS target must family-match its RESOLVED full-id revert, so a
  // `/model sonnet` on a `claude-sonnet-5`-default agent (start.sh wrote the full
  // id to .active-session-model on a config-changed / proxy-down revert path) is
  // NOT falsely reported as "sonnet didn't apply". This is the exact case the
  // reviewer flagged; a naive string compare returns not-applied here.
  it("family-matches an alias target to its resolved full-id default (sonnet ≡ claude-sonnet-5)", () => {
    const out = classifyModelSwitchConfirmation({
      reason: "user: /model sonnet (session-only relaunch)",
      launched: "claude-sonnet-5",
      configured: "claude-sonnet-5",
    });
    expect(out).toEqual({ kind: "default", launched: "claude-sonnet-5" });
  });

  it("still flags a genuinely different-family switch that reverted to the full-id default", () => {
    // /model opus reverting to a claude-sonnet-5 default is a REAL failed switch.
    const out = classifyModelSwitchConfirmation({
      reason: "user: /model opus (session-only relaunch)",
      launched: "claude-sonnet-5",
      configured: "claude-sonnet-5",
    });
    expect(out).toEqual({ kind: "not-applied", target: "opus", revertedTo: "claude-sonnet-5" });
  });

  it("family-matches a full-id target to the aliased default (claude-opus-4-8 ≡ opus)", () => {
    const out = classifyModelSwitchConfirmation({
      reason: "user: /model claude-opus-4-8 (session-only relaunch)",
      launched: "opus",
      configured: "opus",
    });
    expect(out).toEqual({ kind: "default", launched: "opus" });
  });
});

describe("modelFamilyToken", () => {
  it("reduces a claude full id to its family, dropping version + date", () => {
    expect(modelFamilyToken("claude-sonnet-5")).toBe("sonnet");
    expect(modelFamilyToken("claude-opus-4-8")).toBe("opus");
    expect(modelFamilyToken("claude-haiku-4-5-20251001")).toBe("haiku");
  });
  it("passes a bare alias through, lowercased", () => {
    expect(modelFamilyToken("Sonnet")).toBe("sonnet");
    expect(modelFamilyToken("fable")).toBe("fable");
  });
  it("keeps sr-* routing ids verbatim (no claude- prefix)", () => {
    expect(modelFamilyToken("sr-glm-5")).toBe("sr-glm-5");
    expect(modelFamilyToken("sr-gemini-2.5-flash")).toBe("sr-gemini-2.5-flash");
  });
});
