/**
 * `/effort` tmux driver — confirmation-modal handling.
 *
 * Fixtures are trimmed verbatim captures from claude CLI 2.1.177:
 *   - DIRECT: `/effort` applied with no modal (idle/small-cache session) —
 *     the status banner shows the new level.
 *   - MODAL: the "Change effort level?" confirmation that appears when the
 *     session has a cached conversation a switch would invalidate.
 *
 * The headline guarantee: the driver NEVER leaves the modal open (the
 * /rate-limit-options wedge class) — it confirms (Enter) the level the user
 * asked for, and if it can't, it cancels (Esc) and reports the failure.
 */
import { describe, it, expect } from "vitest";
import { applyEffort } from "../src/agents/effort-picker.js";
import type { TmuxRunner } from "../src/agents/inject.js";

const DIRECT_HIGH = [
  "❯ /effort high",
  "  ⎿  Set effort level to high (saved as your default for new sessions):",
  "     Comprehensive implementation with extensive testing and documentation",
  "────────────────────────────────────────────────────────────",
  "❯ ",
  "────────────────────────────────────────────────────────────",
  "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents      ● high · /effort",
].join("\n");

const MODAL_LOW = [
  "❯ /effort low",
  "  Change effort level?",
  "  Your next response will be slower and use more tokens",
  "  This conversation is cached for the current effort level. Switching to low",
  "  means the full history gets re-read on your next message.",
  "  ❯ 1. Yes, switch to low",
  "    2. No, go back",
].join("\n");

const APPLIED_LOW = [
  "❯ /effort low",
  "  ⎿  Set effort level to low (saved as your default for new sessions): Quick,",
  "     straightforward implementation with minimal overhead",
  "────────────────────────────────────────────────────────────",
  "❯ ",
  "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents       ○ low · /effort",
].join("\n");

const IDLE = ["❯ ", "  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents"].join("\n");

const fastOpts = { stepMs: 1, timeoutMs: 500, _sleep: async () => {} };

/** Scripted runner: `frames` consumed one capture at a time (last repeats). */
function fakeRunner(frames: string[], hasSession = true): { runner: TmuxRunner; sends: string[][] } {
  const sends: string[][] = [];
  let i = 0;
  const runner: TmuxRunner = {
    capture: () => frames[Math.min(i++, frames.length - 1)],
    send: (_s, _t, args) => {
      sends.push(args);
    },
    hasSession: () => hasSession,
  };
  return { runner, sends };
}

function sentKeys(sends: string[][]): string[] {
  return sends.map((args) => (args[1] === "-l" ? args[2] : args[1]));
}

describe("applyEffort", () => {
  it("direct apply (no modal): sends the command, verifies via the banner", async () => {
    const { runner, sends } = fakeRunner([DIRECT_HIGH]);
    const res = await applyEffort("agentx", "high", { ...fastOpts, _runner: runner });
    expect(res).toMatchObject({ ok: true, level: "high", confirmed: false });
    if (res.ok) expect(res.output).toContain("Set effort level to high");
    expect(sentKeys(sends)).toEqual(["/effort high", "Enter"]);
  });

  it("confirmation modal: presses Enter to confirm, then verifies the banner", async () => {
    const { runner, sends } = fakeRunner([MODAL_LOW, APPLIED_LOW]);
    const res = await applyEffort("agentx", "low", { ...fastOpts, _runner: runner });
    expect(res).toMatchObject({ ok: true, level: "low", confirmed: true });
    // /effort low, Enter (submit), Enter (confirm "Yes")
    expect(sentKeys(sends)).toEqual(["/effort low", "Enter", "Enter"]);
  });

  it("never wedges: a stuck modal is cancelled with Esc and reported", async () => {
    // Modal never clears across the two confirm attempts; 4th frame is clean
    // (post-Esc), so wedged resolves false.
    const { runner, sends } = fakeRunner([MODAL_LOW, MODAL_LOW, MODAL_LOW, IDLE]);
    const res = await applyEffort("agentx", "low", { ...fastOpts, _runner: runner });
    expect(res).toMatchObject({ ok: false, reason: "confirm_failed", wedged: false });
    const keys = sentKeys(sends);
    expect(keys.filter((k) => k === "Enter")).toHaveLength(3); // submit + 2 confirm tries
    expect(keys[keys.length - 1]).toBe("Escape"); // bailed out cleanly
  });

  it("reports a stuck modal that Esc could not clear as wedged", async () => {
    const { runner, sends } = fakeRunner([MODAL_LOW, MODAL_LOW, MODAL_LOW, MODAL_LOW]);
    const res = await applyEffort("agentx", "low", { ...fastOpts, _runner: runner });
    expect(res).toMatchObject({ ok: false, reason: "confirm_failed", wedged: true });
    expect(sentKeys(sends)).toContain("Escape");
  });

  it("returns session_missing without sending anything", async () => {
    const { runner, sends } = fakeRunner([DIRECT_HIGH], false);
    const res = await applyEffort("agentx", "high", { ...fastOpts, _runner: runner });
    expect(res).toEqual({ ok: false, reason: "session_missing" });
    expect(sends).toEqual([]);
  });

  it("apply_unverified when neither modal nor banner ever appears", async () => {
    const { runner } = fakeRunner([IDLE]);
    const res = await applyEffort("agentx", "high", { ...fastOpts, _runner: runner, timeoutMs: 20 });
    expect(res).toEqual({ ok: false, reason: "apply_unverified" });
  });

  it("does not false-match the command echo (verb before level)", async () => {
    // A pane that only shows the echo "/effort high" (verb precedes level)
    // must NOT be read as applied — only "high · /effort" (the banner) counts.
    const echoOnly = ["❯ /effort high", "  …thinking…"].join("\n");
    const { runner } = fakeRunner([echoOnly]);
    const res = await applyEffort("agentx", "high", { ...fastOpts, _runner: runner, timeoutMs: 20 });
    expect(res.ok).toBe(false);
  });
});
