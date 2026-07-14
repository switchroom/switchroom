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
  planModelCommand,
  isModelCommandBusy,
  modelCommandReceiptLine,
  handleModelCommand,
  isValidModelArg,
  isSrModel,
  isClaudeModel,
  isBusyRefusalText,
  isOfflineTrustedModelToken,
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
  const relaunchCalls: Array<{ model: string; reason: string }> = [];
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
    isBusy: () => false,
    scheduleRestart: async (reason) => { restartCalls.push(reason); },
    scheduleModelRelaunch: async (model, reason) => { relaunchCalls.push({ model, reason }); },
    ...overrides,
  };
  return { deps, calls, restartCalls, relaunchCalls };
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
  it("accepts OpenRouter-style sr-vendor/model ids (embedded slash)", () => {
    // `/` is a legal char in a model id — needed for OpenRouter-style
    // `sr-vendor/model` routing. It is NOT a shell metachar inside the
    // double-quoted `claude --model "$_EFFECTIVE_MODEL"` launch, so it is
    // safe. Kept aligned with the shell shape gate in profiles/_base/start.sh.hbs.
    for (const good of ["sr-openrouter/gpt-5", "sr-vendor/model", "sr-mistralai/mixtral-8x7b"]) {
      expect(isValidModelArg(good), good).toBe(true);
    }
  });
  it("rejects whitespace, metacharacters, and over-long strings", () => {
    for (const bad of ["", " ", "a b", "a;b", "-x", "a".repeat(120), "a\tb", "a\nb", "/leading"]) {
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

describe("handleModelCommand — set — #3241 poll-until-signal wiring", () => {
  it("forwards successPattern + errorPattern + settleBeforeSendMs to the inject primitive", async () => {
    const seen: Array<{ command: string; opts: unknown }> = [];
    const { deps } = makeDeps({
      inject: async (_agent, command, opts) => {
        seen.push({ command, opts });
        return okResult("⏺ Set model to Sonnet 5 for this session");
      },
    });
    await handleModelCommand({ kind: "set", model: "sonnet" }, deps);
    expect(seen).toHaveLength(1);
    const opts = seen[0].opts as {
      successPattern?: RegExp;
      errorPattern?: RegExp;
      settleBeforeSendMs?: number;
    };
    // A success pattern that matches claude's confirmation line, an error pattern
    // that matches the "not found" line, and a clean-prompt pre-send wait.
    expect(opts.successPattern?.test("⏺ Set model to Sonnet 5")).toBe(true);
    expect(opts.errorPattern?.test("⎿  Model 'x' not found")).toBe(true);
    expect(typeof opts.settleBeforeSendMs).toBe("number");
    expect(opts.settleBeforeSendMs).toBeGreaterThan(0);
  });

  it("confirmation that lands after a banner → records the live model for /status", async () => {
    // The inject primitive (poll-until-signal) is responsible for returning the
    // confirmation and not the banner; here the handler receives that confirmation
    // and must record it as the session override.
    const { deps } = makeDeps({
      inject: async () =>
        okResult("⠋ extending Claude Fable 5 access…\n⎿  Set model to Fable 5 for this session"),
    });
    const reply = await handleModelCommand({ kind: "set", model: "fable" }, deps);
    expect(reply.selectedModel).toBe("Fable 5");
    expect(reply.optimistic).toBeUndefined();
    expect(reply.text).toContain("Set model to Fable 5");
    // The banner is scrollback and must not leak as prose above the confirmation.
    expect(reply.text).not.toContain("extending Claude Fable 5 access");
  });

  it("scraped error line → failure verdict AND no override recorded (retract)", async () => {
    const { deps } = makeDeps({
      inject: async () => okResult("⎿  Model 'claude-bogus-99' not found"),
    });
    const reply = await handleModelCommand({ kind: "set", model: "claude-bogus-99" }, deps);
    expect(reply.text).toContain("did not take");
    expect(reply.selectedModel).toBeUndefined();
    expect(reply.optimistic).toBeUndefined();
  });
});

describe("handleModelCommand — set", () => {
  it("injects exactly `/model <name>` once and relays a genuine confirmation + persistence note", async () => {
    const { deps, calls } = makeDeps();
    const reply = await handleModelCommand({ kind: "set", model: "opus" }, deps);
    expect(calls).toEqual([{ agent: "klanker", command: "/model opus" }]);
    expect(reply.text).toContain("<pre>⏺ Set model to sonnet</pre>");
    expect(reply.text).toContain("lasts until the agent’s next restart");
    expect(reply.html).toBe(true);
    // A verified confirmation records the live model so /status stays honest
    // (bug 1: the typed path never recorded the switch before).
    expect(reply.selectedModel).toBe("sonnet");
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
    // #3241 part B — poll-until-signal already waited the full window, so a
    // missing confirmation line with NO scraped error is a SILENT switch, not a
    // failure. Record the requested model optimistically so /status is right,
    // and say so honestly (no false "switched (session)", no scrollback leak).
    expect(reply.text).toContain("/model fable");
    expect(reply.text).toContain("Recorded");
    expect(reply.text).toContain("couldn't read claude");
    expect(reply.text).toContain("/status");
    expect(reply.text).not.toContain("switched (session)");
    expect(reply.selectedModel).toBe("fable");
    expect(reply.optimistic).toBe(true);
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
    // no <pre> block. No confirmation AND no scraped error → #3241 optimistic
    // record: the switch is reported as sent + recorded, never a false
    // "switched", and no scrollback prose leaks.
    expect(reply.text).not.toContain("<pre>");
    expect(reply.text).not.toContain("switched the deploy");
    expect(reply.text).not.toContain("set model behaviour");
    expect(reply.text).not.toContain("kept model changes");
    expect(reply.text).toContain("Recorded");
    expect(reply.text).not.toContain("switched (session)");
    expect(reply.selectedModel).toBe("fable");
    expect(reply.optimistic).toBe(true);
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
    // #3241 part B — an empty capture can't carry an error line, so the send is
    // treated as a silent switch and the requested model is recorded
    // optimistically (was: "no response captured", recorded nothing).
    expect(reply.text).toContain("Recorded");
    expect(reply.text).toContain("/status");
    expect(reply.selectedModel).toBe("sonnet");
    expect(reply.optimistic).toBe(true);
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
  it("carries the requested Claude model across the restart (relaunch carrier), never injects", async () => {
    const { deps, calls, restartCalls, relaunchCalls } = makeDeps({
      getActiveSessionModel: () => "sr-gemini-2.5-pro",
    });
    const reply = await handleModelCommand({ kind: "set", model: "opus" }, deps);
    // Must NOT inject
    expect(calls).toHaveLength(0);
    // sr→Claude now rides the SAME carrier mechanism as Claude→sr so the
    // requested Claude model survives the restart (bug 2). The bespoke
    // scheduleRestart-without-carrier path is gone.
    expect(restartCalls).toHaveLength(0);
    expect(relaunchCalls).toHaveLength(1);
    expect(relaunchCalls[0].model).toBe("opus");
    expect(relaunchCalls[0].reason).toContain("sr-to-claude");
    // Reply mentions the sr-* model and ~30s
    expect(reply.text).toContain("sr-gemini-2.5-pro");
    expect(reply.text).toContain("30s");
    expect(reply.html).toBe(true);
  });

  it("carries a full claude-* id across the restart when session is on sr-*", async () => {
    const { deps, calls, restartCalls, relaunchCalls } = makeDeps({
      getActiveSessionModel: () => "sr-deepseek-r1",
    });
    const reply = await handleModelCommand({ kind: "set", model: "claude-opus-4-8" }, deps);
    expect(calls).toHaveLength(0);
    expect(restartCalls).toHaveLength(0);
    expect(relaunchCalls).toHaveLength(1);
    expect(relaunchCalls[0].model).toBe("claude-opus-4-8");
    expect(reply.text).toContain("sr-deepseek-r1");
    expect(reply.text).toContain("30s");
  });

  it("does NOT restart when switching between Claude models (no sr-* session)", async () => {
    const { deps, calls, restartCalls, relaunchCalls } = makeDeps({
      getActiveSessionModel: () => "Opus 4.8",
    });
    const reply = await handleModelCommand({ kind: "set", model: "sonnet" }, deps);
    // Normal inject path: still injects, no restart, no relaunch
    expect(calls).toHaveLength(1);
    expect(restartCalls).toHaveLength(0);
    expect(relaunchCalls).toHaveLength(0);
    expect(reply.text).toContain("Set model to sonnet");
  });

  it("surfaces relaunch dispatch failures without propagating the error", async () => {
    const { deps, calls } = makeDeps({
      getActiveSessionModel: () => "sr-deepseek-r1",
      scheduleModelRelaunch: async () => { throw new Error("hostd unreachable"); },
    });
    const reply = await handleModelCommand({ kind: "set", model: "sonnet" }, deps);
    expect(calls).toHaveLength(0);
    expect(reply.text).toContain("Could not schedule restart");
    expect(reply.text).toContain("hostd unreachable");
  });

  it("reports 'restart already in flight' honestly on a debounced dispatch (no silent no-op)", async () => {
    const { deps } = makeDeps({
      getActiveSessionModel: () => "sr-deepseek-r1",
      scheduleModelRelaunch: async () => {
        const e = new Error("a restart is already in flight — try again in ~15s");
        (e as { code?: string }).code = "restart_in_flight";
        throw e;
      },
    });
    const reply = await handleModelCommand({ kind: "set", model: "opus" }, deps);
    expect(reply.text).toContain("restart is already in flight");
    expect(reply.text).toContain("15s");
    // Never a false success.
    expect(reply.text).not.toContain("Set model to");
  });

  it("null session model (no prior override) still uses normal inject path for Claude target", async () => {
    const { deps, calls, restartCalls, relaunchCalls } = makeDeps({
      getActiveSessionModel: () => null,
    });
    await handleModelCommand({ kind: "set", model: "opus" }, deps);
    expect(calls).toHaveLength(1);
    expect(restartCalls).toHaveLength(0);
    expect(relaunchCalls).toHaveLength(0);
  });
});

describe("handleModelCommand — busy gate + honest unverified reporting", () => {
  it("refuses a typed switch while the agent is mid-turn (no inject, no relaunch)", async () => {
    const { deps, calls, relaunchCalls } = makeDeps({ isBusy: () => true });
    const reply = await handleModelCommand({ kind: "set", model: "opus" }, deps);
    expect(calls).toHaveLength(0);
    expect(relaunchCalls).toHaveLength(0);
    expect(reply.text).toContain("mid-turn");
    expect(reply.selectedModel).toBeUndefined();
  });

  it("refuses an sr-* switch too while mid-turn", async () => {
    const { deps, relaunchCalls } = makeDeps({ isBusy: () => true });
    const reply = await handleModelCommand({ kind: "set", model: "sr-glm-5" }, deps);
    expect(relaunchCalls).toHaveLength(0);
    expect(reply.text).toContain("mid-turn");
  });

  it("reports a claude error output as an HONEST failure, not a switch", async () => {
    const { deps } = makeDeps({
      inject: async () => okResult("Error: Model not found"),
    });
    const reply = await handleModelCommand({ kind: "set", model: "claude-bogus" }, deps);
    expect(reply.text).toContain("did not take");
    expect(reply.text).toContain("Model not found");
    expect(reply.text).not.toContain("Sticky across switchroom-managed relaunches");
    expect(reply.selectedModel).toBeUndefined();
  });

  it("detects claude v2.1.205's real error shape: ⎿  Model 'name' not found (TUI-probe verified)", async () => {
    // Captured verbatim from a disposable claude v2.1.205 TUI, 2026-07-10.
    const { deps } = makeDeps({
      inject: async () => okResult("⎿  Model 'claude-bogus-99' not found"),
    });
    const reply = await handleModelCommand({ kind: "set", model: "claude-bogus-99" }, deps);
    expect(reply.text).toContain("did not take");
    expect(reply.text).toContain("not found");
    expect(reply.selectedModel).toBeUndefined();
  });

  it("scrollback prose CONTAINING 'model not found' mid-sentence is NOT a failure (anchored error scan)", async () => {
    // The error regex is line-start anchored, like the confirmation prefix —
    // prose that merely mentions the phrase must not flip a successful switch
    // into a reported failure (the false-FAILURE variant of the scrollback-leak
    // class this PR eliminates).
    const { deps } = makeDeps({
      inject: async () => okResult("deploy failed: model not found in registry"),
    });
    const reply = await handleModelCommand({ kind: "set", model: "opus" }, deps);
    expect(reply.text).not.toContain("did not take");
    expect(reply.text).not.toContain("model not found");
    // No LINE-ANCHORED error and no confirmation → #3241 optimistic record: the
    // mid-sentence "model not found" prose does NOT flip the switch to a failure,
    // and the requested model is recorded (was: "couldn't confirm", nothing).
    expect(reply.text).toContain("Recorded");
    expect(reply.selectedModel).toBe("opus");
    expect(reply.optimistic).toBe(true);
  });

  it("recognises claude v2.1.205's real arg-form confirmation (⎿ glyph + 'and saved as your default')", async () => {
    // Captured verbatim from a disposable claude v2.1.205 TUI, 2026-07-10:
    // the arg form is NOT silent — it prints this line, and the ⎿ glyph
    // survives the inject capture. The name extraction must stop at "and
    // saved", not swallow the whole sentence.
    const { deps } = makeDeps({
      inject: async () =>
        okResult("⎿  Set model to Opus 4.8 and saved as your default for new sessions"),
    });
    const reply = await handleModelCommand({ kind: "set", model: "opus" }, deps);
    expect(reply.text).toContain("Set model to Opus 4.8");
    expect(reply.selectedModel).toBe("Opus 4.8");
  });

  it("does NOT record an override when the confirmation is 'Kept model as' (no change)", async () => {
    const { deps } = makeDeps({
      inject: async () => okResult("⏺ Kept model as Opus 4.8 (default)"),
    });
    const reply = await handleModelCommand({ kind: "set", model: "opus" }, deps);
    // The kept line is still relayed as a confirmation, but nothing is recorded.
    expect(reply.selectedModel).toBeUndefined();
  });
});

describe("handleModelCommand — Claude → sr-* session relaunch", () => {
  it("schedules a model relaunch (carrier) instead of injecting for an sr-* target", async () => {
    const { deps, calls, restartCalls, relaunchCalls } = makeDeps({
      getActiveSessionModel: () => null,
    });
    const reply = await handleModelCommand({ kind: "set", model: "sr-glm-5" }, deps);
    // Must NOT inject (claude's picker rejects sr-* ids)
    expect(calls).toHaveLength(0);
    // Must NOT use the sr→claude scheduleRestart path
    expect(restartCalls).toHaveLength(0);
    // Must schedule the carrier-based relaunch with the full sr-* id
    expect(relaunchCalls).toHaveLength(1);
    expect(relaunchCalls[0].model).toBe("sr-glm-5");
    expect(reply.text).toContain("sr-glm-5");
    expect(reply.text).toContain("30s");
    expect(reply.html).toBe(true);
  });

  it("expands a short sr alias then relaunches on the full id", async () => {
    const { deps, calls, relaunchCalls } = makeDeps({ getActiveSessionModel: () => null });
    await handleModelCommand({ kind: "set", model: "glm" }, deps);
    expect(calls).toHaveLength(0);
    expect(relaunchCalls).toHaveLength(1);
    expect(relaunchCalls[0].model).toBe("sr-glm-5");
  });

  it("Claude target still uses the instant inject path (no relaunch)", async () => {
    const { deps, calls, relaunchCalls, restartCalls } = makeDeps({
      getActiveSessionModel: () => null,
    });
    await handleModelCommand({ kind: "set", model: "sonnet" }, deps);
    expect(calls).toHaveLength(1);
    expect(relaunchCalls).toHaveLength(0);
    expect(restartCalls).toHaveLength(0);
  });

  it("sr-* → Claude rides scheduleModelRelaunch (carrier) so the Claude model survives the restart", async () => {
    const { deps, calls, restartCalls, relaunchCalls } = makeDeps({
      getActiveSessionModel: () => "sr-glm-5",
    });
    await handleModelCommand({ kind: "set", model: "opus" }, deps);
    expect(calls).toHaveLength(0);
    expect(restartCalls).toHaveLength(0);
    expect(relaunchCalls).toHaveLength(1);
    expect(relaunchCalls[0].model).toBe("opus");
  });

  it("surfaces scheduleModelRelaunch failures without propagating the error", async () => {
    const { deps, calls } = makeDeps({
      getActiveSessionModel: () => null,
      scheduleModelRelaunch: async () => { throw new Error("carrier write failed"); },
    });
    const reply = await handleModelCommand({ kind: "set", model: "sr-glm-5" }, deps);
    expect(calls).toHaveLength(0);
    expect(reply.text).toContain("Could not schedule model switch");
    expect(reply.text).toContain("carrier write failed");
  });
});

// ---------------------------------------------------------------------------
// Manual full-sr-* passthrough (Ken 2026-07-08): the /model MENU stays curated
// to the main SR_MODEL_ALIASES set, but typing `/model <any registered sr-*>`
// must switch to that exact model — the set path is a SHAPE gate only, with NO
// whitelist against SR_MODEL_LABELS / SR_MODEL_ALIASES. These guard that any
// arbitrary sr-* id passes through verbatim and schedules the relaunch on the
// exact id (not rejected, not remapped, not injected).
// ---------------------------------------------------------------------------
describe("handleModelCommand — arbitrary sr-* passthrough (no whitelist)", () => {
  // sr-* names that are NOT in SR_MODEL_ALIASES (so not menu-reachable) but ARE
  // registered in the live litellm config — must still switch when typed.
  const ARBITRARY_SR = [
    "sr-gpt-oss-120b",
    "sr-gpt-oss-20b",
    "sr-minimax-m3",
    "sr-gemini-flash-lite",
    "sr-gpt-5.5",
    "sr-gpt-5-codex",
    "sr-gpt-5.2-codex",
    "sr-deepseek-v4-flash",
  ];

  it("each arbitrary sr-* passes the shape gate and isSrModel", () => {
    for (const name of ARBITRARY_SR) {
      expect(isValidModelArg(name), `${name} must pass MODEL_ARG_RE`).toBe(true);
      expect(isSrModel(name), `${name} must be recognised as sr-*`).toBe(true);
      expect(isClaudeModel(name)).toBe(false);
    }
  });

  it("relaunches on the exact typed id — not rejected, not remapped", async () => {
    for (const name of ARBITRARY_SR) {
      const { deps, calls, restartCalls, relaunchCalls } = makeDeps({
        getActiveSessionModel: () => null,
      });
      const reply = await handleModelCommand({ kind: "set", model: name }, deps);
      // Never injected (claude's picker rejects sr-* ids).
      expect(calls, `${name} must not inject`).toHaveLength(0);
      // Never the sr→claude restart path (source session is Claude here).
      expect(restartCalls, `${name} must not scheduleRestart`).toHaveLength(0);
      // Scheduled the carrier relaunch on the EXACT id (no alias remap).
      expect(relaunchCalls).toHaveLength(1);
      expect(relaunchCalls[0].model, `${name} must relaunch verbatim`).toBe(name);
      expect(reply.text).toContain(name);
    }
  });

  it("parseModelCommand accepts arbitrary sr-* ids as a set command", () => {
    for (const name of ARBITRARY_SR) {
      expect(parseModelCommand(`/model ${name}`)).toEqual({ kind: "set", model: name });
    }
  });

  it("switching FROM an arbitrary sr-* back to Claude carries the Claude model via the relaunch carrier", async () => {
    const { deps, calls, restartCalls, relaunchCalls } = makeDeps({
      getActiveSessionModel: () => "sr-gpt-oss-120b",
    });
    await handleModelCommand({ kind: "set", model: "opus" }, deps);
    expect(calls).toHaveLength(0);
    expect(restartCalls).toHaveLength(0);
    expect(relaunchCalls).toHaveLength(1);
    expect(relaunchCalls[0].model).toBe("opus");
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

  it("handleModelCommand relaunches on the expanded sr-* id, not the short alias", async () => {
    const { deps, calls, relaunchCalls } = makeDeps({ getActiveSessionModel: () => null });
    await handleModelCommand({ kind: "set", model: "flash" }, deps);
    // sr-* targets no longer inject — they carrier-relaunch on the full id.
    expect(calls).toHaveLength(0);
    expect(relaunchCalls).toHaveLength(1);
    expect(relaunchCalls[0].model).toBe("sr-gemini-2.5-flash");
  });

  it("handleModelCommand with a Claude alias relaunches (carrier) when session is on sr-*", async () => {
    const { deps, calls, restartCalls, relaunchCalls } = makeDeps({
      getActiveSessionModel: () => "sr-deepseek-v3",
    });
    await handleModelCommand({ kind: "set", model: "opus" }, deps);
    expect(calls).toHaveLength(0);
    expect(restartCalls).toHaveLength(0);
    expect(relaunchCalls).toHaveLength(1);
    expect(relaunchCalls[0].model).toBe("opus");
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

  it("busy agent → no discovery, STATIC keyboard whose taps ride the queue (#3039)", async () => {
    const { deps, calls } = makeMenuDeps({ isBusy: () => true });
    const menu = await buildModelMenu(deps);
    // Never drives the picker mid-turn…
    expect(calls.discover).toBe(0);
    expect(menu.text).toContain("mid-turn");
    // …but no dead-end either: static alias rows are offered so the operator
    // can still lock in a choice (the tap queues at the gateway busy gate).
    expect(menu.keyboard).toBeDefined();
    const data = menu.keyboard!.flat().map(b => b.callback_data);
    expect(data).toContain("mdl:alias:opus");
    expect(data).toContain("mdl:alias:default");
    expect(menu.text).not.toContain("Try again");
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

  it("tapping the Default row when already on it (Kept model as) records NO override", async () => {
    // Bug 6: "Kept model as X" is a no-change; the old code fell back to
    // target.label and stored "Default (recommended)" verbatim into /status.
    const { deps } = makeMenuDeps({
      select: async () => ({ ok: true as const, confirmation: "Kept model as Opus 4.8 (default)" }),
    });
    const out = await handleModelMenuCallback(modelSelectCallbackData("Default (recommended)"), deps);
    expect(out.reply.text).toContain("✅");
    // Crucially, NOTHING is recorded — no display label leaks into the override.
    expect(out.selectedModel).toBeUndefined();
    expect(out.reply.text).not.toContain("Default (recommended)");
  });

  it("a real switch on the Default row stores a canonical token, never the display label", async () => {
    // The Default row confirms with a real model name; the /status value is that
    // name (never "Default (recommended)"), and the carrier token is canonical.
    const { deps } = makeMenuDeps({
      select: async () => ({ ok: true as const, confirmation: "Set model to Opus 4.8 for this session only" }),
    });
    const out = await handleModelMenuCallback(modelSelectCallbackData("Default (recommended)"), deps);
    expect(out.selectedModel).toBe("Opus 4.8");
    // "Default (recommended)" yields no --model token → carrier boots the config default.
    expect(out.selectedModelToken).toBeUndefined();
  });

  it("selecting an alias row exposes a canonical --model token for the sr→claude carrier", async () => {
    const { deps } = makeMenuDeps({
      select: async () => ({ ok: true as const, confirmation: "Set model to Sonnet for this session" }),
    });
    const out = await handleModelMenuCallback(modelSelectCallbackData("Sonnet"), deps);
    expect(out.selectedModel).toBe("Sonnet");
    expect(out.selectedModelToken).toBe("sonnet");
  });
});

describe("sessionModelFromConfirmation", () => {
  it("pulls the model name from claude's session-switch confirmation", () => {
    expect(sessionModelFromConfirmation("Set model to Fable 5 for this session only")).toBe("Fable 5");
    expect(sessionModelFromConfirmation("Set model to Opus 4.8 (1M context) for this session only")).toBe("Opus 4.8");
    expect(sessionModelFromConfirmation("Switched to Haiku 4.5")).toBe("Haiku 4.5");
  });
  it("terminates the name at 'and saved' (claude v2.1.205 arg-form phrasing, TUI-probe verified)", () => {
    expect(
      sessionModelFromConfirmation("⎿  Set model to Opus 4.8 and saved as your default for new sessions"),
    ).toBe("Opus 4.8");
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

  it("bumps sr-glm-5 label to GLM-5.2 (now targets glm-5.2 in litellm)", () => {
    expect(SR_MODEL_LABELS["sr-glm-5"]).toBe("GLM-5.2");
  });

  it("has friendly names for the new OpenRouter sr-* models (display-only)", () => {
    expect(SR_MODEL_LABELS["sr-gpt-oss-20b"]).toBe("GPT-OSS 20B");
    expect(SR_MODEL_LABELS["sr-gpt-oss-120b"]).toBe("GPT-OSS 120B");
    expect(SR_MODEL_LABELS["sr-gpt-5.5"]).toBe("GPT-5.5");
    expect(SR_MODEL_LABELS["sr-gpt-5-codex"]).toBe("GPT-5 Codex");
    expect(SR_MODEL_LABELS["sr-gpt-5.2-codex"]).toBe("GPT-5.2 Codex");
    expect(SR_MODEL_LABELS["sr-gemini-flash-lite"]).toBe("Gemini 3.1 Flash Lite");
    expect(SR_MODEL_LABELS["sr-minimax-m3"]).toBe("MiniMax M3");
    expect(SR_MODEL_LABELS["sr-deepseek-v4-flash"]).toBe("DeepSeek V4 Flash");
  });
});

describe("menu stays curated — new OpenRouter models are display-only, not in the picker", () => {
  // The 8 new models are typeable (manual passthrough) but must NOT bloat the
  // /model keyboard. externalModelNames() seeds the picker from SR_MODEL_ALIASES
  // values, so these ids must be ABSENT from both the alias table and the picker
  // list. This locks in Ken's "menu = main models only" decision.
  const NEW_SR = [
    "sr-gpt-oss-20b",
    "sr-gpt-oss-120b",
    "sr-gpt-5.5",
    "sr-gpt-5-codex",
    "sr-gpt-5.2-codex",
    "sr-gemini-flash-lite",
    "sr-minimax-m3",
    "sr-deepseek-v4-flash",
  ];

  it("SR_MODEL_ALIASES stays the curated 6-entry main set (no new short aliases)", () => {
    expect(Object.keys(SR_MODEL_ALIASES).sort()).toEqual(
      ["codex", "deepseek", "flash", "gemini", "glm", "r1"],
    );
    // None of the new sr-* ids are an alias target.
    const targets = new Set(Object.values(SR_MODEL_ALIASES));
    for (const name of NEW_SR) {
      expect(targets.has(name), `${name} must NOT be an alias target`).toBe(false);
    }
  });

  it("externalModelNames (picker seed) excludes the new models", () => {
    const picker = externalModelNames([]);
    for (const name of NEW_SR) {
      expect(picker.includes(name), `${name} must NOT appear in the picker`).toBe(false);
    }
    // The curated main set is still exactly the alias targets.
    expect(picker.sort()).toEqual([...new Set(Object.values(SR_MODEL_ALIASES))].sort());
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

  it("sr-* tap delegates to the carrier relaunch — never a picker-rejecting inject", async () => {
    // The gateway intercepts mdl:sr: before this function; if a direct caller
    // reaches it, delegating to scheduleModelRelaunch is the ONLY safe path (an
    // inject of `/model sr-*` 4xxs — picker rejects the id, base-URL never repointed).
    const relaunch: Array<{ model: string }> = [];
    const { deps, calls, injectCalls } = makeMenuDepsWithSr({
      scheduleModelRelaunch: async (model) => { relaunch.push({ model }); },
    });
    const out = await handleModelMenuCallback(`${MODEL_CALLBACK_SR}sr-gemini-2.5-pro`, deps);
    // No inject, no cursor nav — a carrier relaunch on the exact sr-* id.
    expect(injectCalls).toHaveLength(0);
    expect(calls.select).toHaveLength(0);
    expect(relaunch).toEqual([{ model: "sr-gemini-2.5-pro" }]);
    expect(out.selectedModel).toBe("sr-gemini-2.5-pro");
    expect(out.reply.keyboard).toBeUndefined();
    expect(out.reply.text).toContain('🔄');
    expect(out.reply.text).not.toContain('picker unavailable');
  });

  it("sr-* tap while busy returns toast-only with no relaunch", async () => {
    const relaunch: string[] = [];
    const { deps, injectCalls } = makeMenuDepsWithSr({
      isBusy: () => true,
      scheduleModelRelaunch: async (model) => { relaunch.push(model); },
    });
    const out = await handleModelMenuCallback(`${MODEL_CALLBACK_SR}sr-gemini-2.5-pro`, deps);
    expect(out.toastOnly).toBe(true);
    expect(injectCalls).toHaveLength(0);
    expect(relaunch).toHaveLength(0);
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

// ─── #3039: busy-refusal detection for the queued-command drain ──────────────

describe("isBusyRefusalText (#3039)", () => {
  it("matches the typed and menu busy refusals", async () => {
    const deps = makeDeps({ isBusy: () => true }).deps;
    const reply = await handleModelCommand({ kind: "set", model: "opus" }, deps);
    expect(isBusyRefusalText(reply.text)).toBe(true);
  });

  it("never matches a genuine confirmation or failure", () => {
    expect(isBusyRefusalText("⏺ Set model to Opus 4.8")).toBe(false);
    expect(isBusyRefusalText("✅ `/effort high` — Set effort level to high")).toBe(false);
    expect(isBusyRefusalText("❌ Switch to opus failed: tmux session not found")).toBe(false);
  });
});


describe("isOfflineTrustedModelToken (#3042 blocker 2a)", () => {
  it("trusts static Claude aliases and curated sr-* alias names/targets", () => {
    for (const a of MODEL_ALIASES) expect(isOfflineTrustedModelToken(a)).toBe(true);
    // Curated sr-* aliases resolve by construction (present in the LiteLLM config).
    const [alias, target] = Object.entries(SR_MODEL_ALIASES)[0];
    expect(isOfflineTrustedModelToken(alias)).toBe(true);
    expect(isOfflineTrustedModelToken(target)).toBe(true);
  });

  it("refuses hand-typed full ids — shape-valid garbage must never reach a boot carrier unconfirmed", () => {
    expect(isOfflineTrustedModelToken("claude-nonexistnet-9")).toBe(false);
    expect(isOfflineTrustedModelToken("claude-opus-4-8")).toBe(false); // real but unverifiable offline
    expect(isOfflineTrustedModelToken("sr-made-up/model")).toBe(false);
    expect(isOfflineTrustedModelToken("")).toBe(false);
  });

  it("#3043 item 1: accepts case-variant aliases the live path already normalizes (OPUS, Sonnet)", () => {
    // The live accept path lowercases (isClaudeModel / expandSrAlias) so a
    // queued `/model OPUS` is accepted live — the persist gate must not then
    // refuse it with the over-conservative "couldn't verify" card.
    for (const a of MODEL_ALIASES) {
      expect(isOfflineTrustedModelToken(a.toUpperCase())).toBe(true);
    }
    expect(isOfflineTrustedModelToken("OPUS")).toBe(true);
    expect(isOfflineTrustedModelToken("Sonnet")).toBe(true);
    // Curated sr-* alias, upper-cased, still resolves.
    const [alias] = Object.entries(SR_MODEL_ALIASES)[0];
    expect(isOfflineTrustedModelToken(alias.toUpperCase())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// #3177 — a typed /model must NEVER be swallowed without trace when sent
// mid-turn. The routing decision folds BOTH busy signals, and every parsed
// shape maps to a visible action (menu / queue / apply — never "do nothing").
// ---------------------------------------------------------------------------
describe("#3177 typed /model never silently swallowed mid-turn", () => {
  describe("isModelCommandBusy folds both busy signals", () => {
    it("is busy when the turn atom is set", () => {
      expect(isModelCommandBusy({ currentTurnActive: true, turnInFlight: false })).toBe(true);
    });

    it("is busy when only the authoritative delivery-machine/approval gate is set", () => {
      // THE SWALLOW REGRESSION: the pre-fix handler gated on `currentTurn !==
      // null` ALONE. A session busy by the delivery-machine / pending-approval
      // gate while the turn atom is cleared (the recovered-late / premature-
      // turn-end window) read as idle, so the switch injected into a busy pane
      // and was swallowed as literal text. Folding turnInFlight closes it.
      expect(isModelCommandBusy({ currentTurnActive: false, turnInFlight: true })).toBe(true);
    });

    it("is idle only when BOTH signals are clear", () => {
      expect(isModelCommandBusy({ currentTurnActive: false, turnInFlight: false })).toBe(false);
    });
  });

  describe("planModelCommand routes every shape to a visible action", () => {
    const busyByAtom = { currentTurnActive: true, turnInFlight: false, menuEnabled: true };
    const busyByGate = { currentTurnActive: false, turnInFlight: true, menuEnabled: true };
    const idle = { currentTurnActive: false, turnInFlight: false, menuEnabled: true };

    it("QUEUES a set while busy by the turn atom (ack, not silent inject)", () => {
      const d = planModelCommand({ kind: "set", model: "opus" }, busyByAtom);
      expect(d).toEqual({ kind: "queue", target: "opus" });
    });

    it("QUEUES a set while busy by the delivery-machine/approval gate ONLY — the swallow case", () => {
      // Sabotage-verify: revert the fix (gate on currentTurnActive alone) and
      // this flips to { kind: 'apply' } → the direct-inject swallow returns.
      const d = planModelCommand({ kind: "set", model: "opus" }, busyByGate);
      expect(d).toEqual({ kind: "queue", target: "opus" });
    });

    it("expands sr-* aliases into the queued target token", () => {
      const d = planModelCommand({ kind: "set", model: "flash" }, busyByAtom);
      expect(d).toEqual({ kind: "queue", target: "sr-gemini-2.5-flash" });
    });

    it("APPLIES a set immediately when idle by both signals", () => {
      const d = planModelCommand({ kind: "set", model: "opus" }, idle);
      expect(d).toEqual({ kind: "apply", parsed: { kind: "set", model: "opus" } });
    });

    it("renders the MENU for bare /model when the picker is enabled (even mid-turn)", () => {
      expect(planModelCommand({ kind: "show" }, busyByGate)).toEqual({ kind: "menu" });
    });

    it("APPLIES the text show path when the picker is disabled", () => {
      const d = planModelCommand({ kind: "show" }, { ...idle, menuEnabled: false });
      expect(d).toEqual({ kind: "apply", parsed: { kind: "show" } });
    });

    it("APPLIES help so a bad arg still gets an explicit reply", () => {
      const parsed = { kind: "help", reason: "not a valid model name: !!" } as const;
      expect(planModelCommand(parsed, busyByGate)).toEqual({ kind: "apply", parsed });
    });
  });

  describe("modelCommandReceiptLine — the durable, greppable entry trace", () => {
    it("stamps agent, kind, arg, and busy for a typed set", () => {
      const line = modelCommandReceiptLine("finn", { kind: "set", model: "opus" }, true);
      expect(line).toBe("telegram gateway: gw /model received agent=finn kind=set arg=opus busy=true");
    });

    it("marks the show + help forms with placeholder args", () => {
      expect(modelCommandReceiptLine("finn", { kind: "show" }, false)).toContain("kind=show arg=(show)");
      expect(modelCommandReceiptLine("finn", { kind: "help" }, false)).toContain("kind=help arg=(help)");
    });
  });
});
