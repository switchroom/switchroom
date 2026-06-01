// Unit tests for the mid-session wedge watchdog (Layer 2 of the
// blocking-TUI-prompt fix). We drive the pure state machine through the
// `capture` / `send` test seams so no real tmux is involved.

import { describe, it, expect, vi } from "vitest";
import {
  runWedgeWatchdog,
  WEDGE_FOOTER_SIGNATURE,
} from "../src/agents/wedge-watchdog.js";

// A realistic blocking-modal pane (the klanker AskUserQuestion shape).
const WEDGE_SCREEN =
  "Which option do you want?\n" +
  "❯ 1. First choice\n" +
  "  2. Second choice\n" +
  "\n" +
  "Enter to select · ↑/↓ to navigate · Esc to cancel";

// The working / idle REPL footer — must NOT trip the watchdog.
const IDLE_SCREEN =
  "⏵⏵ accept edits on (shift+tab to cycle) · esc to interrupt\n> ";

/**
 * Build a `capture` seam that yields canned screens in order; once
 * exhausted it repeats the LAST screen (so an all-wedged steady state is
 * easy to express with a single-element array).
 */
function captureSeq(screens: string[]) {
  let i = 0;
  return (_agent: string): string => {
    const s = i < screens.length ? screens[i] : screens[screens.length - 1];
    i++;
    return s ?? "";
  };
}

function recordSend() {
  const calls: string[][] = [];
  const send = (_agent: string, keys: string[]): boolean => {
    calls.push([...keys]);
    return true;
  };
  return { send, calls };
}

describe("WEDGE_FOOTER_SIGNATURE", () => {
  it("matches a blocking modal selector footer", () => {
    expect(WEDGE_FOOTER_SIGNATURE.test(WEDGE_SCREEN)).toBe(true);
  });

  it("does NOT match the working/idle REPL footer ('esc to interrupt')", () => {
    expect(WEDGE_FOOTER_SIGNATURE.test(IDLE_SCREEN)).toBe(false);
  });

  it("does NOT match streaming output or a plain confirmation", () => {
    const negatives = [
      "Thinking… (12s · esc to interrupt)",
      "Here is the answer you asked for.\n\nDone.",
      "Do you want to proceed?\n❯ 1. Yes\n  2. No\nPress enter to confirm",
      "", // empty pane
    ];
    for (const text of negatives) {
      expect(WEDGE_FOOTER_SIGNATURE.test(text), `matched: ${text}`).toBe(false);
    }
  });
});

describe("runWedgeWatchdog", () => {
  it("fires Esc once a stable blocking selector persists past the threshold", async () => {
    const { send, calls } = recordSend();
    const res = await runWedgeWatchdog({
      agentName: "klanker",
      stabilityThreshold: 3,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 3,
      capture: captureSeq([WEDGE_SCREEN]),
      send,
    });
    expect(res.fires).toBe(1);
    expect(calls).toEqual([["Escape"]]);
  });

  it("does NOT fire before the stability threshold is reached", async () => {
    const { send, calls } = recordSend();
    const res = await runWedgeWatchdog({
      agentName: "a",
      stabilityThreshold: 3,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 2, // only 2 stable polls — one short of the threshold
      capture: captureSeq([WEDGE_SCREEN]),
      send,
    });
    expect(res.fires).toBe(0);
    expect(calls).toEqual([]);
  });

  it("does NOT fire when the pane keeps changing (a working agent)", async () => {
    // Each capture matches the modal footer but the body differs every
    // poll — a static stuck prompt would be byte-identical, so a moving
    // pane must never trip the stability guard.
    const moving = [0, 1, 2, 3, 4].map(
      (n) =>
        `Working step ${n}\n❯ 1. opt${n}\nEnter to select · ↑/↓ to navigate · Esc to cancel`,
    );
    const { send, calls } = recordSend();
    const res = await runWedgeWatchdog({
      agentName: "a",
      stabilityThreshold: 3,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 5,
      capture: captureSeq(moving),
      send,
    });
    expect(res.fires).toBe(0);
    expect(calls).toEqual([]);
  });

  it("defers to the boot autoaccept poller for first-run prompts (no Esc)", async () => {
    // A dev-channels first-run prompt that ALSO carries a modal footer:
    // autoaccept owns it (it wants Enter), so the watchdog must not Esc it.
    const firstRunWithFooter =
      "Yes, I accept the use of development channels\n" +
      "❯ 1. Accept\nEnter to select · ↑/↓ to navigate · Esc to cancel";
    const { send, calls } = recordSend();
    const res = await runWedgeWatchdog({
      agentName: "a",
      stabilityThreshold: 3,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 6,
      capture: captureSeq([firstRunWithFooter]),
      send,
    });
    expect(res.fires).toBe(0);
    expect(calls).toEqual([]);
  });

  it("resets its streak when the pane leaves the wedged state", async () => {
    // wedge, wedge, IDLE (reset), wedge, wedge — never 3 consecutive.
    const { send, calls } = recordSend();
    const res = await runWedgeWatchdog({
      agentName: "a",
      stabilityThreshold: 3,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 5,
      capture: captureSeq([
        WEDGE_SCREEN,
        WEDGE_SCREEN,
        IDLE_SCREEN,
        WEDGE_SCREEN,
        WEDGE_SCREEN,
      ]),
      send,
    });
    expect(res.fires).toBe(0);
    expect(calls).toEqual([]);
  });

  it("honors the cooldown: re-fires only after it elapses", async () => {
    // Clock advances by pollIntervalMs each poll (via the sleep seam), so
    // cooldown is measured in poll-time. threshold 3 + cooldown 60s @ 5s
    // cadence → fire at poll 3, blocked until clock≥70s, fire again at
    // poll 15. 20 polls → exactly 2 fires.
    let clock = 0;
    const { send, calls } = recordSend();
    const res = await runWedgeWatchdog({
      agentName: "a",
      stabilityThreshold: 3,
      pollIntervalMs: 5_000,
      cooldownMs: 60_000,
      now: () => clock,
      sleep: (ms) => {
        clock += ms;
      },
      maxPolls: 20,
      capture: captureSeq([WEDGE_SCREEN]),
      send,
    });
    expect(res.fires).toBe(2);
    expect(calls).toEqual([["Escape"], ["Escape"]]);
  });

  it("soft-fails when capture throws (no fire, no throw)", async () => {
    const { send, calls } = recordSend();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await runWedgeWatchdog({
      agentName: "a",
      stabilityThreshold: 1,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 3,
      capture: () => {
        throw new Error("tmux: no server running");
      },
      send,
    });
    expect(res.fires).toBe(0);
    expect(calls).toEqual([]);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
