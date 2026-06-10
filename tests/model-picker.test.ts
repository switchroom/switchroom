/**
 * Claude `/model` picker driver — parser + tmux-driving invariants.
 *
 * The PICKER fixture is a verbatim capture from claude CLI 2.1.170 on
 * the live test-harness agent (2026-06-10) — if claude changes its
 * picker layout, update the fixture from a fresh capture and the
 * parser together.
 *
 * Headline safety invariants:
 *   1. Esc-always: every discovery path and every failed selection
 *      path sends Escape — the picker is never left open to wedge the
 *      pane (the /rate-limit-options class of wedge).
 *   2. Never select blind: `selectModel` re-verifies the cursor row's
 *      LABEL after navigation; any mismatch aborts via Escape and the
 *      session-only `s` keypress is never sent.
 */
import { describe, it, expect } from "vitest";
import {
  parseModelPicker,
  labelTag,
  extractConfirmation,
  discoverModels,
  selectModel,
} from "../src/agents/model-picker.js";
import type { TmuxRunner } from "../src/agents/inject.js";

const IDLE = [
  "✻ Cooked for 7s",
  "─".repeat(40),
  "❯ ",
  "─".repeat(40),
  "  ⏵⏵ accept edits on (shift+tab to cycle)",
].join("\n");

// Verbatim shape from claude 2.1.170 (cursor + ✔ on row 2).
const PICKER = [
  "❯ /model",
  "",
  "─".repeat(40),
  "  Select model",
  "  Switch between Claude models. Your pick becomes the default for new",
  "  sessions. For other/previous model names, specify with --model.",
  "",
  "    1. Default (recommended)  Opus 4.8 with 1M context · Best for everyday,",
  "                              complex tasks",
  "  ❯ 2. Sonnet ✔               Sonnet 4.6 · Efficient for routine tasks",
  "    3. Haiku                  Haiku 4.5 · Fastest for quick answers",
  "",
  "  ○ Low effort ←/→ to adjust",
  "",
  "  Enter to set as default · s to use this session only · Esc to cancel",
].join("\n");

const PICKER_CURSOR_3 = PICKER.replace("  ❯ 2. Sonnet ✔ ", "    2. Sonnet ✔ ")
  .replace("    3. Haiku ", "  ❯ 3. Haiku ");

const AFTER_ESC = [
  "❯ /model",
  "  ⎿  Kept model as Sonnet 4.6",
  "",
  "─".repeat(40),
  "❯ ",
].join("\n");

const AFTER_S = [
  "❯ /model",
  "  ⎿  Set model to Haiku 4.5 for this session",
  "",
  "─".repeat(40),
  "❯ ",
].join("\n");

describe("parseModelPicker", () => {
  it("parses the real 2.1.170 picker: options, current, cursor, footer", () => {
    const p = parseModelPicker(PICKER);
    expect(p).not.toBeNull();
    expect(p!.footerSeen).toBe(true);
    expect(p!.options.map((o) => o.label)).toEqual([
      "Default (recommended)",
      "Sonnet",
      "Haiku",
    ]);
    expect(p!.options.find((o) => o.current)?.label).toBe("Sonnet");
    expect(p!.cursorIndex).toBe(2);
    // Wrapped continuation folded into option 1's detail
    expect(p!.options[0].detail).toContain("complex tasks");
    // Effort row is not an option
    expect(p!.options.some((o) => /effort/i.test(o.label))).toBe(false);
  });

  it("anchors on the LAST picker when scrollback holds an older one", () => {
    const older = PICKER.replace("❯ 2. Sonnet ✔", "❯ 2. Sonnet")
      .replace("1. Default (recommended)", "1. Old Option");
    const p = parseModelPicker(older + "\n" + PICKER);
    expect(p!.options[0].label).toBe("Default (recommended)");
  });

  it("returns null on a pane with no picker", () => {
    expect(parseModelPicker(IDLE)).toBeNull();
    expect(parseModelPicker(AFTER_ESC)).toBeNull();
  });

  it("handles a picker with extra options (future models) without code changes", () => {
    const extended = PICKER.replace(
      "    3. Haiku                  Haiku 4.5 · Fastest for quick answers",
      [
        "    3. Haiku                  Haiku 4.5 · Fastest for quick answers",
        "    4. Opus Plan Mode         Plan with Opus, execute with Sonnet",
      ].join("\n"),
    );
    const p = parseModelPicker(extended);
    expect(p!.options.map((o) => o.label)).toEqual([
      "Default (recommended)",
      "Sonnet",
      "Haiku",
      "Opus Plan Mode",
    ]);
  });
});

describe("labelTag", () => {
  it("is stable and distinct across realistic labels", () => {
    const labels = ["Default (recommended)", "Sonnet", "Haiku", "Opus Plan Mode"];
    const tags = labels.map(labelTag);
    expect(new Set(tags).size).toBe(labels.length);
    expect(labelTag("Sonnet")).toBe(labelTag("Sonnet"));
    for (const t of tags) expect(t).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("extractConfirmation", () => {
  it("pulls the ⎿ confirmation line", () => {
    expect(extractConfirmation(AFTER_S)).toBe("Set model to Haiku 4.5 for this session");
    expect(extractConfirmation(AFTER_ESC)).toBe("Kept model as Sonnet 4.6");
    expect(extractConfirmation(IDLE)).toBeNull();
  });
});

/**
 * Scripted fake runner: `frames` is consumed one capture at a time
 * (last frame repeats); every send is recorded for exact-sequence
 * assertions.
 */
function fakeRunner(frames: string[]): { runner: TmuxRunner; sends: string[][]; framesLeft: () => number } {
  const sends: string[][] = [];
  let i = 0;
  const runner: TmuxRunner = {
    capture: () => frames[Math.min(i++, frames.length - 1)],
    send: (_s, _t, args) => {
      sends.push(args);
    },
    hasSession: () => true,
  };
  return { runner, sends, framesLeft: () => frames.length - i };
}

const fastOpts = { stepMs: 1, timeoutMs: 500, _sleep: async () => {} };

function sentKeys(sends: string[][]): string[] {
  // Normalize: literal sends as their text, key sends as the key name.
  return sends.map((args) => (args[1] === "-l" ? args[2] : args[1]));
}

describe("discoverModels", () => {
  it("opens, parses, and ALWAYS escapes (happy path)", async () => {
    const { runner, sends } = fakeRunner([PICKER, AFTER_ESC]);
    const res = await discoverModels("agentx", { ...fastOpts, _runner: runner });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.options.map((o) => o.label)).toEqual(["Default (recommended)", "Sonnet", "Haiku"]);
      expect(res.currentLabel).toBe("Sonnet");
    }
    expect(sentKeys(sends)).toEqual(["/model", "Enter", "Escape"]);
  });

  it("escapes even when the picker never renders (Esc-always invariant)", async () => {
    const { runner, sends } = fakeRunner([IDLE]);
    const res = await discoverModels("agentx", { ...fastOpts, _runner: runner, timeoutMs: 20 });
    expect(res.ok).toBe(false);
    expect(sentKeys(sends)).toContain("Escape");
  });

  it("fails clean when the tmux session is missing (nothing sent)", async () => {
    const sends: string[][] = [];
    const runner: TmuxRunner = {
      capture: () => null,
      send: (_s, _t, a) => { sends.push(a); },
      hasSession: () => false,
    };
    const res = await discoverModels("agentx", { ...fastOpts, _runner: runner });
    expect(res.ok).toBe(false);
    expect(sends.length).toBe(0);
  });
});

describe("selectModel", () => {
  it("navigates cursor→target, verifies the label, presses s — no Escape", async () => {
    // open → PICKER (cursor 2) → after Down: cursor 3 → verify → s → confirmation
    const { runner, sends } = fakeRunner([PICKER, PICKER_CURSOR_3, AFTER_S]);
    const res = await selectModel("agentx", "Haiku", { ...fastOpts, _runner: runner });
    expect(res).toEqual({ ok: true, confirmation: "Set model to Haiku 4.5 for this session" });
    expect(sentKeys(sends)).toEqual(["/model", "Enter", "Down", "s"]);
  });

  it("navigates UP when the target is above the cursor", async () => {
    const cursorOn3 = PICKER_CURSOR_3;
    const cursorOn2 = PICKER;
    const { runner, sends } = fakeRunner([cursorOn3, cursorOn2, AFTER_S]);
    const res = await selectModel("agentx", "Sonnet", { ...fastOpts, _runner: runner });
    expect(res.ok).toBe(true);
    expect(sentKeys(sends)).toEqual(["/model", "Enter", "Up", "s"]);
  });

  it("aborts via Escape when the label is not offered — never presses s", async () => {
    const { runner, sends } = fakeRunner([PICKER, AFTER_ESC]);
    const res = await selectModel("agentx", "Nonexistent Model", { ...fastOpts, _runner: runner });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("not offered");
    const keys = sentKeys(sends);
    expect(keys).toContain("Escape");
    expect(keys).not.toContain("s");
  });

  it("aborts via Escape when cursor verification fails — never presses s", async () => {
    // After the Down keypress the pane unexpectedly still shows cursor
    // on Sonnet (row 2) — e.g. the pane shifted under us.
    const { runner, sends } = fakeRunner([PICKER, PICKER, AFTER_ESC]);
    const res = await selectModel("agentx", "Haiku", { ...fastOpts, _runner: runner });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("cursor verification failed");
    const keys = sentKeys(sends);
    expect(keys).toContain("Escape");
    expect(keys).not.toContain("s");
  });

  it("zero-delta selection (target == cursor row) presses s directly", async () => {
    const { runner, sends } = fakeRunner([PICKER, PICKER, AFTER_S]);
    const res = await selectModel("agentx", "Sonnet", { ...fastOpts, _runner: runner });
    expect(res.ok).toBe(true);
    expect(sentKeys(sends)).toEqual(["/model", "Enter", "s"]);
  });

  it("aborts when the picker never renders", async () => {
    const { runner, sends } = fakeRunner([IDLE]);
    const res = await selectModel("agentx", "Haiku", { ...fastOpts, _runner: runner, timeoutMs: 20 });
    expect(res.ok).toBe(false);
    expect(sentKeys(sends)).not.toContain("s");
    expect(sentKeys(sends)).toContain("Escape");
  });
});
