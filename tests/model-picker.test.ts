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

describe("#3241 interstitial dismiss-and-retry", () => {
  // An async access banner (no "Select model" header, no footer) renders where
  // the picker should be on the first open; openPickerWithRetry must Esc it and
  // re-open once, then discover succeeds.
  const INTERSTITIAL = ["❯ /model", "", "⠋ extending Claude Fable 5 access…"].join("\n");

  it("discover Esc-and-retries past a first-render banner, then parses the picker", async () => {
    let opens = 0;
    const sends: string[][] = [];
    const runner: TmuxRunner = {
      // Until the SECOND `/model` open, the pane shows only the banner; after it,
      // the real picker renders.
      capture: () => (opens >= 2 ? PICKER : INTERSTITIAL),
      send: (_s, _t, args) => {
        sends.push(args);
        if (args[1] === "-l" && args[2] === "/model") opens++;
      },
      hasSession: () => true,
    };
    const res = await discoverModels("agentx", { ...fastOpts, _runner: runner, timeoutMs: 60 });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.options.map((o) => o.label)).toEqual([
        "Default (recommended)", "Sonnet", "Haiku",
      ]);
    }
    // Two `/model` opens (initial + one retry) and at least one Escape between them.
    expect(opens).toBe(2);
    expect(sentKeys(sends).filter((k) => k === "/model").length).toBe(2);
    expect(sentKeys(sends)).toContain("Escape");
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

describe("pane-lock serialization (#2263 review blocker 1)", () => {
  it("two concurrent drives on one pane never interleave keys", async () => {
    // A slow runner whose captures resolve through real microtasks;
    // both drives target the same socket:session, so the second must
    // queue behind the first — the recorded send sequence must be the
    // first drive's full key sequence followed by the second's, never
    // interleaved.
    const sends: string[][] = [];
    let frameByDrive = 0;
    const frames = [PICKER, AFTER_ESC, PICKER, AFTER_ESC];
    const runner: TmuxRunner = {
      capture: () => frames[Math.min(frameByDrive++, frames.length - 1)],
      send: (_s, _t, args) => {
        sends.push(args);
      },
      hasSession: () => true,
    };
    const opts = { ...fastOpts, _runner: runner };
    const [a, b] = await Promise.all([
      discoverModels("samepane", opts),
      discoverModels("samepane", opts),
    ]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    expect(sentKeys(sends)).toEqual([
      "/model", "Enter", "Escape",
      "/model", "Enter", "Escape",
    ]);
  });

  it("a select queued behind a discover runs after its Escape", async () => {
    const sends: string[][] = [];
    let i = 0;
    const frames = [
      // discover: open → esc
      PICKER, AFTER_ESC,
      // select: open → walk-verify → s-confirm
      PICKER, PICKER_CURSOR_3, AFTER_S,
    ];
    const runner: TmuxRunner = {
      capture: () => frames[Math.min(i++, frames.length - 1)],
      send: (_s, _t, args) => {
        sends.push(args);
      },
      hasSession: () => true,
    };
    const opts = { ...fastOpts, _runner: runner };
    const [d, s] = await Promise.all([
      discoverModels("samepane2", opts),
      selectModel("samepane2", "Haiku", opts),
    ]);
    expect(d.ok).toBe(true);
    expect(s).toEqual({ ok: true, confirmation: "Set model to Haiku 4.5 for this session" });
    expect(sentKeys(sends)).toEqual([
      "/model", "Enter", "Escape",
      "/model", "Enter", "Down", "s",
    ]);
  });
});

describe("dismissal failure is loud (#2263 review blocker 3)", () => {
  it("discover logs + flags dismissFailed when Esc never closes the modal", async () => {
    // Picker stays rendered with its footer at the tail forever —
    // dismissal verification can never succeed.
    const logs: string[] = [];
    const { runner } = fakeRunner([PICKER]);
    const res = await discoverModels("agentx", {
      ...fastOpts,
      _runner: runner,
      _log: (l) => logs.push(l),
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.dismissFailed).toBe(true);
    expect(logs.some((l) => l.includes("may still be open"))).toBe(true);
  });

  it("failed select logs the stuck-modal warning too", async () => {
    const logs: string[] = [];
    const { runner } = fakeRunner([PICKER]);
    const res = await selectModel("agentx", "Nonexistent Model", {
      ...fastOpts,
      _runner: runner,
      _log: (l) => logs.push(l),
    });
    expect(res.ok).toBe(false);
    expect(logs.some((l) => l.includes("may still be open"))).toBe(true);
  });
});
