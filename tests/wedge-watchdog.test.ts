// Unit tests for the mid-session wedge watchdog (Layer 2 of the
// blocking-TUI-prompt fix). We drive the pure state machine through the
// `capture` / `send` test seams so no real tmux is involved.

import { describe, it, expect, vi } from "vitest";
import {
  runWedgeWatchdog,
  parseWeeklyReset,
  WEDGE_FOOTER_SIGNATURE,
  CONFIRM_MODAL_SIGNATURE,
  RATE_LIMIT_MENU_SIGNATURE,
  PERMISSION_PROMPT_SIGNATURE,
  STOP_HOOK_ERROR_SIGNATURE,
  MANIFESTING_SIGNATURE,
} from "../src/agents/wedge-watchdog.js";
import { FABLE_CONSENT_SIGNATURE } from "../src/agents/autoaccept.js";

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

  it("soft-fails when send throws (counts the fire, no throw)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await runWedgeWatchdog({
      agentName: "a",
      stabilityThreshold: 1,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 1,
      capture: captureSeq([WEDGE_SCREEN]),
      send: () => {
        throw new Error("tmux: send-keys failed");
      },
    });
    // The fire is attempted (and counted) but the throw is swallowed so the
    // sidecar loop survives.
    expect(res.fires).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

// ── #2471 — confirmation-modal shape persistence + manifest-stall ─────────

// The /effort modal, rendered TWO different ways across polls so a
// byte-stable gate would NEVER fire (the manifest timer / cursor moves).
const EFFORT_MODAL_A =
  "Change effort level?\n❯ 1. Yes, switch to high\n  2. No, go back\n  (1s)";
const EFFORT_MODAL_B =
  "Change effort level?\n❯ 1. Yes, switch to high\n  2. No, go back\n  (0s)";

// A Manifesting + stop-hook-error pane whose timer flickers each poll.
const MANIFEST_STALL_A =
  "✶ Manifesting… (112k tokens · 0s)\nStop hook error occurred\nrunning stop hooks 0/6";
const MANIFEST_STALL_B =
  "✶ Manifesting… (112k tokens · 0s)\nStop hook error occurred\nrunning stop hooks 0/6\n.";

function captureFlicker(screens: string[]) {
  let i = 0;
  return (_agent: string): string => screens[i++ % screens.length] ?? "";
}

describe("#2471 confirmation-modal signatures", () => {
  it("CONFIRM_MODAL_SIGNATURE matches the effort modal and a generic yes/no", () => {
    expect(CONFIRM_MODAL_SIGNATURE.test(EFFORT_MODAL_A)).toBe(true);
    expect(
      CONFIRM_MODAL_SIGNATURE.test("Proceed?\n❯ 1. Yes, do it\n  2. No, cancel"),
    ).toBe(true);
  });

  it("CONFIRM_MODAL_SIGNATURE does NOT match idle/working/plain panes", () => {
    for (const text of [
      "⏵⏵ accept edits on · esc to interrupt\n> ",
      "Here is the answer. Done.",
      "Thinking… (12s · esc to interrupt)",
      "",
    ]) {
      expect(CONFIRM_MODAL_SIGNATURE.test(text), `matched: ${text}`).toBe(false);
    }
  });

  it("STOP_HOOK_ERROR_SIGNATURE matches the 0/6 stop-hook signature", () => {
    expect(STOP_HOOK_ERROR_SIGNATURE.test(MANIFEST_STALL_A)).toBe(true);
    expect(STOP_HOOK_ERROR_SIGNATURE.test("running stop hooks 3/6")).toBe(false);
    expect(MANIFESTING_SIGNATURE.test(MANIFEST_STALL_A)).toBe(true);
  });
});

describe("#2471 runWedgeWatchdog — confirmation-modal shape persistence", () => {
  it("dismisses a FLICKERING effort modal with Esc (byte-stability gate defeated)", async () => {
    const { send, calls } = recordSend();
    const res = await runWedgeWatchdog({
      agentName: "overlord",
      // shape must be PRESENT for 3 consecutive polls — pane bytes differ each poll.
      confirmModalPolls: 3,
      // disable the other branches so we isolate the confirm-modal path.
      rateLimitSignature: null,
      manifestStallSignature: null,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 3,
      capture: captureFlicker([EFFORT_MODAL_A, EFFORT_MODAL_B, EFFORT_MODAL_A]),
      send,
    });
    expect(res.confirmModalFires).toBe(1);
    expect(res.fires).toBe(1);
    expect(calls).toEqual([["Escape"]]);
  });

  it("does NOT fire before the present-streak threshold", async () => {
    const { send, calls } = recordSend();
    const res = await runWedgeWatchdog({
      agentName: "a",
      confirmModalPolls: 3,
      rateLimitSignature: null,
      manifestStallSignature: null,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 2, // one short of the threshold
      capture: captureFlicker([EFFORT_MODAL_A, EFFORT_MODAL_B]),
      send,
    });
    expect(res.confirmModalFires).toBe(0);
    expect(calls).toEqual([]);
  });

  it("resets the present-streak when the modal clears", async () => {
    const idle = "⏵⏵ accept edits on · esc to interrupt\n> ";
    const { send, calls } = recordSend();
    const res = await runWedgeWatchdog({
      agentName: "a",
      confirmModalPolls: 3,
      rateLimitSignature: null,
      manifestStallSignature: null,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 5,
      // modal, modal, IDLE (reset), modal, modal — never 3 consecutive.
      capture: captureFlicker([
        EFFORT_MODAL_A,
        EFFORT_MODAL_B,
        idle,
        EFFORT_MODAL_A,
        EFFORT_MODAL_B,
      ]),
      send,
    });
    expect(res.confirmModalFires).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("#2471 runWedgeWatchdog — manifest-stall escalation", () => {
  it("escalates to requestRestart after the stall persists (Manifesting + stop-hook-error)", async () => {
    const restarts: Array<{ agent: string; reason: string }> = [];
    const { send } = recordSend();
    const res = await runWedgeWatchdog({
      agentName: "overlord",
      manifestStallPolls: 3,
      rateLimitSignature: null,
      confirmModalSignature: null,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 3,
      capture: captureFlicker([MANIFEST_STALL_A, MANIFEST_STALL_B, MANIFEST_STALL_A]),
      send,
      requestRestart: (agent, reason) => restarts.push({ agent, reason }),
    });
    expect(res.restartEscalations).toBe(1);
    expect(restarts).toHaveLength(1);
    expect(restarts[0].agent).toBe("overlord");
    expect(restarts[0].reason).toMatch(/Manifesting/);
  });

  it("does NOT escalate a healthy long Manifesting turn whose pane ADVANCES (no stop-hook)", async () => {
    // A genuinely-working turn's pane changes every poll — the spinner glyph
    // animates and the elapsed timer / token count climbs. The byte-stability
    // discriminator (which replaced the mandatory stop-hook AND) resets the
    // stall counter on every change, so it is never killed.
    const restarts: string[] = [];
    const advancing = [
      "✶ Manifesting… (200k tokens · 4s)\nrunning stop hooks 2/6",
      "✷ Manifesting… (201k tokens · 5s)\nrunning stop hooks 2/6",
      "✸ Manifesting… (203k tokens · 6s)\nrunning stop hooks 2/6",
      "✹ Manifesting… (204k tokens · 7s)\nrunning stop hooks 2/6",
    ];
    const res = await runWedgeWatchdog({
      agentName: "a",
      manifestStallPolls: 3,
      rateLimitSignature: null,
      confirmModalSignature: null,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 8,
      capture: captureFlicker(advancing),
      send: () => true,
      requestRestart: (a) => restarts.push(a),
    });
    expect(res.restartEscalations).toBe(0);
    expect(restarts).toEqual([]);
  });

  it("escalates a FULLY FROZEN render: Manifesting pane byte-identical across polls, NO stop-hook", async () => {
    // The gap this fix closes: a fully frozen "Manifesting…" pane (a hard TUI /
    // render-loop deadlock — even the elapsed timer stopped repainting) with no
    // stop-hook error matched nothing under the old `Manifesting AND stop-hook`
    // rule and was never caught. A byte-identical pane across the full streak is
    // now a stall in its own right. (A live-but-hung pane whose timer keeps
    // ticking is NOT byte-stable and is caught by the gateway Stage B marker-
    // staleness restart, not this tmux layer — see the branch comment.)
    const restarts: Array<{ agent: string; reason: string }> = [];
    const frozen = "✶ Manifesting… (112k tokens · 30s)\nrunning stop hooks 3/6";
    const res = await runWedgeWatchdog({
      agentName: "overlord",
      manifestStallPolls: 3,
      rateLimitSignature: null,
      confirmModalSignature: null,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 4,
      capture: captureFlicker([frozen]),
      send: () => true,
      requestRestart: (agent, reason) => restarts.push({ agent, reason }),
    });
    expect(res.restartEscalations).toBe(1);
    expect(restarts).toHaveLength(1);
    expect(restarts[0].reason).toMatch(/byte-stable/);
  });

  it("does NOT escalate before the stall threshold", async () => {
    const restarts: string[] = [];
    const res = await runWedgeWatchdog({
      agentName: "a",
      manifestStallPolls: 3,
      rateLimitSignature: null,
      confirmModalSignature: null,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 2,
      capture: captureFlicker([MANIFEST_STALL_A, MANIFEST_STALL_B]),
      send: () => true,
      requestRestart: (a) => restarts.push(a),
    });
    expect(res.restartEscalations).toBe(0);
    expect(restarts).toEqual([]);
  });

  it("soft-fails when requestRestart throws (no throw out of the loop)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await runWedgeWatchdog({
      agentName: "a",
      manifestStallPolls: 1,
      rateLimitSignature: null,
      confirmModalSignature: null,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 1,
      capture: captureFlicker([MANIFEST_STALL_A]),
      send: () => true,
      requestRestart: () => {
        throw new Error("restart spawn failed");
      },
    });
    expect(res.restartEscalations).toBe(1);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});

// ─── Per-tool permission-prompt TUI freeze (config_propose_edit / hostd) ──────
//
// A non-pre-approved MCP tool's permission prompt that renders as Claude
// Code's interactive TUI (instead of emitting the channel notification that
// becomes a Telegram card) arms no TTL auto-deny and parks the turn forever
// — the carrie freeze. The watchdog must detect it by SHAPE persistence and
// dismiss it with Esc (a SAFE decline/deny), never selecting option 1/2.

// The real per-tool permission prompt, rendered TWO ways so a byte-stable
// gate would never fire (the spinner / cursor jitter between paints).
const PERMISSION_PROMPT_A =
  "config_propose_edit(reason: widen tools.allow)\n" +
  "Do you want to proceed?\n" +
  "❯ 1. Yes\n" +
  "  2. Yes, and don't ask again this session\n" +
  "  3. No, and tell Claude what to do differently (esc)";
const PERMISSION_PROMPT_B = PERMISSION_PROMPT_A + "\n ";

describe("PERMISSION_PROMPT_SIGNATURE", () => {
  it("matches the per-tool permission prompt (proceed? + don't-ask-again)", () => {
    expect(PERMISSION_PROMPT_SIGNATURE.test(PERMISSION_PROMPT_A)).toBe(true);
  });

  it("does NOT match the /effort confirm modal or a plain yes/no", () => {
    // The effort modal has no "Do you want to proceed?" + "don't ask again".
    expect(PERMISSION_PROMPT_SIGNATURE.test(EFFORT_MODAL_A)).toBe(false);
    expect(
      PERMISSION_PROMPT_SIGNATURE.test("Do you want to proceed?\n 1. Yes\n 2. No"),
    ).toBe(false);
  });

  it("does NOT match idle / working / plain panes", () => {
    for (const text of [
      "⏵⏵ accept edits on · esc to interrupt\n> ",
      "Here is the answer. Done.",
      "Thinking… (12s · esc to interrupt)",
      "",
    ]) {
      expect(PERMISSION_PROMPT_SIGNATURE.test(text), `matched: ${text}`).toBe(
        false,
      );
    }
  });
});

describe("runWedgeWatchdog — permission-prompt freeze", () => {
  it("dismisses a FLICKERING permission prompt with Esc (safe deny)", async () => {
    const { send, calls } = recordSend();
    const res = await runWedgeWatchdog({
      agentName: "carrie",
      permissionPromptPolls: 3,
      // Flood-awareness off: these cases assert the non-flood behaviour and
      // must never read the real on-disk flood state.
      floodPressure: null,
      // isolate the permission-prompt branch.
      rateLimitSignature: null,
      confirmModalSignature: null,
      manifestStallSignature: null,
      // #2971 — disable the card-aware gate for these pre-existing
      // plain-Esc tests (isolates them from the new branch; a real gateway
      // socket is never touched in tests).
      queryPendingPermission: null,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 3,
      capture: captureFlicker([
        PERMISSION_PROMPT_A,
        PERMISSION_PROMPT_B,
        PERMISSION_PROMPT_A,
      ]),
      send,
    });
    expect(res.permissionPromptFires).toBe(1);
    expect(res.fires).toBe(1);
    // ESC ONLY — never an Enter or a "1"/"2" numeric (would auto-approve).
    expect(calls).toEqual([["Escape"]]);
  });

  it("does NOT fire before the present-streak threshold", async () => {
    const { send, calls } = recordSend();
    const res = await runWedgeWatchdog({
      agentName: "carrie",
      permissionPromptPolls: 3,
      // Flood-awareness off: these cases assert the non-flood behaviour and
      // must never read the real on-disk flood state.
      floodPressure: null,
      rateLimitSignature: null,
      confirmModalSignature: null,
      manifestStallSignature: null,
      queryPendingPermission: null,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 2, // one short
      capture: captureFlicker([PERMISSION_PROMPT_A, PERMISSION_PROMPT_B]),
      send,
    });
    expect(res.permissionPromptFires).toBe(0);
    expect(calls).toEqual([]);
  });

  it("resets the streak when the prompt clears (no fire on intermittent)", async () => {
    const idle = "⏵⏵ accept edits on · esc to interrupt\n> ";
    const { send, calls } = recordSend();
    const res = await runWedgeWatchdog({
      agentName: "carrie",
      permissionPromptPolls: 3,
      // Flood-awareness off: these cases assert the non-flood behaviour and
      // must never read the real on-disk flood state.
      floodPressure: null,
      rateLimitSignature: null,
      confirmModalSignature: null,
      manifestStallSignature: null,
      queryPendingPermission: null,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 5,
      capture: captureFlicker([
        PERMISSION_PROMPT_A,
        PERMISSION_PROMPT_B,
        idle,
        PERMISSION_PROMPT_A,
        PERMISSION_PROMPT_B,
      ]),
      send,
    });
    expect(res.permissionPromptFires).toBe(0);
    expect(calls).toEqual([]);
  });
});

// ─── Issue #2971 — card-aware permission-prompt gate ──────────────────────────
//
// Since PR #2581, the permission branch above Esc-denied EVERY per-tool
// permission prompt after the shape-persistence threshold — including
// prompts that already had a live Telegram approval card racing in
// parallel. These tests drive the NEW `queryPendingPermission` seam
// directly (no real gateway socket touched).

describe("runWedgeWatchdog — permission-prompt card-aware gate (#2971)", () => {
  it("SKIPS Esc when the gateway reports a live pending permission card", async () => {
    const { send, calls } = recordSend();
    const queryPendingPermission = async () =>
      ({ ok: true, pending: true, requestId: "abc123" }) as const;
    const res = await runWedgeWatchdog({
      agentName: "carrie",
      permissionPromptPolls: 3,
      // Flood-awareness off: these cases assert the non-flood behaviour and
      // must never read the real on-disk flood state.
      floodPressure: null,
      rateLimitSignature: null,
      confirmModalSignature: null,
      manifestStallSignature: null,
      queryPendingPermission,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 3,
      capture: captureFlicker([
        PERMISSION_PROMPT_A,
        PERMISSION_PROMPT_B,
        PERMISSION_PROMPT_A,
      ]),
      send,
    });
    // No keystroke of ANY kind — the fix's hard constraint.
    expect(calls).toEqual([]);
    expect(res.fires).toBe(0);
    expect(res.permissionPromptFires).toBe(0);
    expect(res.permissionPromptDeferrals).toBe(1);
  });

  it("Escs on gateway-unreachable (ok: false) — fallback preserved", async () => {
    const { send, calls } = recordSend();
    const queryPendingPermission = async () =>
      ({ ok: false, reason: "timeout" }) as const;
    const res = await runWedgeWatchdog({
      agentName: "carrie",
      permissionPromptPolls: 3,
      // Flood-awareness off: these cases assert the non-flood behaviour and
      // must never read the real on-disk flood state.
      floodPressure: null,
      rateLimitSignature: null,
      confirmModalSignature: null,
      manifestStallSignature: null,
      queryPendingPermission,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 3,
      capture: captureFlicker([
        PERMISSION_PROMPT_A,
        PERMISSION_PROMPT_B,
        PERMISSION_PROMPT_A,
      ]),
      send,
    });
    expect(calls).toEqual([["Escape"]]);
    expect(res.fires).toBe(1);
    expect(res.permissionPromptFires).toBe(1);
    expect(res.permissionPromptDeferrals).toBe(0);
  });

  it("Escs on gateway reporting no pending permission (card-less prompt), but only after the LONGER card-less streak", async () => {
    const { send, calls } = recordSend();
    const queryPendingPermission = async () =>
      ({ ok: true, pending: false }) as const;
    const base = {
      agentName: "carrie",
      permissionPromptPolls: 3,
      permissionCardlessPolls: 6,
      // Flood-awareness off: these cases assert the non-flood behaviour and
      // must never read the real on-disk flood state.
      floodPressure: null as null,
      rateLimitSignature: null,
      confirmModalSignature: null,
      manifestStallSignature: null,
      queryPendingPermission,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      capture: captureFlicker([PERMISSION_PROMPT_A, PERMISSION_PROMPT_B]),
    };
    // At the OLD threshold (3 polls) the card-less prompt is now held, not Esc'd.
    const early = await runWedgeWatchdog({ ...base, maxPolls: 5, send });
    expect(calls).toEqual([]);
    expect(early.permissionPromptFires).toBe(0);
    expect(early.permissionPromptCardlessHolds).toBe(3); // polls 3,4,5
    // Past the card-less streak it still fires — a genuinely wedged prompt is
    // never left to hang.
    const late = await runWedgeWatchdog({ ...base, maxPolls: 6, send });
    expect(calls).toEqual([["Escape"]]);
    expect(late.fires).toBe(1);
    expect(late.permissionPromptFires).toBe(1);
    expect(late.permissionPromptDeferrals).toBe(0);
  });

  it("Escs when queryPendingPermission THROWS (soft-fail, defence-in-depth)", async () => {
    const { send, calls } = recordSend();
    const queryPendingPermission = async () => {
      throw new Error("boom");
    };
    const res = await runWedgeWatchdog({
      agentName: "carrie",
      permissionPromptPolls: 3,
      // Flood-awareness off: these cases assert the non-flood behaviour and
      // must never read the real on-disk flood state.
      floodPressure: null,
      rateLimitSignature: null,
      confirmModalSignature: null,
      manifestStallSignature: null,
      queryPendingPermission,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 3,
      capture: captureFlicker([
        PERMISSION_PROMPT_A,
        PERMISSION_PROMPT_B,
        PERMISSION_PROMPT_A,
      ]),
      send,
    });
    expect(calls).toEqual([["Escape"]]);
    expect(res.fires).toBe(1);
  });

  it("never sends Enter or a numeric key on ANY path (deferred or Esc)", async () => {
    for (const queryPendingPermission of [
      async () => ({ ok: true, pending: true, requestId: "x" }) as const,
      async () => ({ ok: true, pending: false }) as const,
      async () => ({ ok: false, reason: "down" }) as const,
      null,
    ]) {
      const { send, calls } = recordSend();
      await runWedgeWatchdog({
        agentName: "carrie",
        permissionPromptPolls: 3,
        permissionCardlessPolls: 3,
        floodPressure: null,
      // Flood-awareness off: these cases assert the non-flood behaviour and
      // must never read the real on-disk flood state.
      floodPressure: null,
        rateLimitSignature: null,
        confirmModalSignature: null,
        manifestStallSignature: null,
        queryPendingPermission,
        pollIntervalMs: 0,
        now: () => 0,
        sleep: () => {},
        maxPolls: 3,
        capture: captureFlicker([
          PERMISSION_PROMPT_A,
          PERMISSION_PROMPT_B,
          PERMISSION_PROMPT_A,
        ]),
        send,
      });
      for (const keys of calls) {
        expect(keys).toEqual(["Escape"]);
      }
    }
  });
});

// ─── Flood-aware permission gate (the Esc-before-the-card race) ───────────────
//
// clerk, 2026-07-28. Telegram 429'd chat 12345; the gateway's
// edit-flood-fuse deferred the approval card
// (`edit-flood-fuse deferred method=sendRichMessage key=t:12345
// class=critical`); the watchdog asked the gateway, was told
// `{ok:true, pending:false}` because the card did not exist YET, and Esc'd —
// a permanent deny — ~15s in. The card then landed still looking tappable and
// the operator tapped Approve into a dead prompt.
//
// Outcome contract asserted here: while the flood state says Telegram is
// throttling this agent, a card-less permission prompt gets NO keystroke; with
// no flood pressure, a genuinely wedged one is still denied.

describe("runWedgeWatchdog — flood-aware permission gate", () => {
  const cardless = async () => ({ ok: true, pending: false }) as const;

  it("does NOT Esc a card-less prompt while a flood window is open", async () => {
    const { send, calls } = recordSend();
    const res = await runWedgeWatchdog({
      agentName: "clerk",
      permissionPromptPolls: 3,
      permissionCardlessPolls: 6,
      permissionFloodMaxPolls: 100,
      // The flood-ban state says chat:12345 is throttled.
      floodPressure: () => ({
        active: true,
        reason: "open flood window chat:12345 (3s left, src=429)",
      }),
      rateLimitSignature: null,
      confirmModalSignature: null,
      manifestStallSignature: null,
      queryPendingPermission: cardless,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 40,
      capture: captureFlicker([PERMISSION_PROMPT_A, PERMISSION_PROMPT_B]),
      send,
    });
    // The whole point: no keystroke of any kind reached the TUI.
    expect(calls).toEqual([]);
    expect(res.fires).toBe(0);
    expect(res.permissionPromptFires).toBe(0);
    expect(res.permissionPromptFloodHolds).toBe(38); // polls 3..40
  });

  it("still Escs a genuinely wedged card-less prompt when there is NO flood window", async () => {
    const { send, calls } = recordSend();
    const res = await runWedgeWatchdog({
      agentName: "clerk",
      permissionPromptPolls: 3,
      permissionCardlessPolls: 6,
      permissionFloodMaxPolls: 100,
      floodPressure: () => ({ active: false, reason: "" }),
      rateLimitSignature: null,
      confirmModalSignature: null,
      manifestStallSignature: null,
      queryPendingPermission: cardless,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 6,
      capture: captureFlicker([PERMISSION_PROMPT_A, PERMISSION_PROMPT_B]),
      send,
    });
    expect(calls).toEqual([["Escape"]]);
    expect(res.permissionPromptFires).toBe(1);
    expect(res.permissionPromptFloodHolds).toBe(0);
  });

  it("Escs once the flood ceiling is reached — patience is bounded, never infinite", async () => {
    const { send, calls } = recordSend();
    const res = await runWedgeWatchdog({
      agentName: "clerk",
      permissionPromptPolls: 3,
      permissionCardlessPolls: 6,
      // A 4.4h ban would otherwise hold forever; the ceiling ends it.
      permissionFloodMaxPolls: 10,
      floodPressure: () => ({ active: true, reason: "429 episode 3x peak=15908s" }),
      rateLimitSignature: null,
      confirmModalSignature: null,
      manifestStallSignature: null,
      queryPendingPermission: cardless,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 10,
      capture: captureFlicker([PERMISSION_PROMPT_A, PERMISSION_PROMPT_B]),
      send,
    });
    expect(calls).toEqual([["Escape"]]);
    expect(res.permissionPromptFires).toBe(1);
    expect(res.permissionPromptFloodHolds).toBe(7); // polls 3..9, then poll 10 fires
  });

  it("withholds Esc under flood pressure even when the gateway is UNREACHABLE", async () => {
    const { send, calls } = recordSend();
    const res = await runWedgeWatchdog({
      agentName: "clerk",
      permissionPromptPolls: 3,
      permissionFloodMaxPolls: 100,
      floodPressure: () => ({ active: true, reason: "open flood window global" }),
      rateLimitSignature: null,
      confirmModalSignature: null,
      manifestStallSignature: null,
      queryPendingPermission: async () => ({ ok: false, reason: "timeout" }) as const,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 8,
      capture: captureFlicker([PERMISSION_PROMPT_A, PERMISSION_PROMPT_B]),
      send,
    });
    expect(calls).toEqual([]);
    expect(res.permissionPromptFires).toBe(0);
  });

  it("never sends anything but Escape under flood pressure (safety boundary)", async () => {
    for (const active of [true, false]) {
      const { send, calls } = recordSend();
      await runWedgeWatchdog({
        agentName: "clerk",
        permissionPromptPolls: 3,
        permissionCardlessPolls: 4,
        permissionFloodMaxPolls: 6,
        floodPressure: () => ({ active, reason: "r" }),
        rateLimitSignature: null,
        confirmModalSignature: null,
        manifestStallSignature: null,
        queryPendingPermission: cardless,
        pollIntervalMs: 0,
        now: () => 0,
        sleep: () => {},
        maxPolls: 8,
        capture: captureFlicker([PERMISSION_PROMPT_A, PERMISSION_PROMPT_B]),
        send,
      });
      for (const keys of calls) expect(keys).toEqual(["Escape"]);
    }
  });

  it("clamps a mis-set card-less streak so it can never be SHORTER than the base streak", async () => {
    const { send, calls } = recordSend();
    const res = await runWedgeWatchdog({
      agentName: "clerk",
      permissionPromptPolls: 5,
      permissionCardlessPolls: 1, // nonsense — must clamp up to 5
      floodPressure: null,
      rateLimitSignature: null,
      confirmModalSignature: null,
      manifestStallSignature: null,
      queryPendingPermission: cardless,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 4,
      capture: captureFlicker([PERMISSION_PROMPT_A, PERMISSION_PROMPT_B]),
      send,
    });
    expect(calls).toEqual([]);
    expect(res.permissionPromptFires).toBe(0);
  });
});

// ─── parseWeeklyReset — time-only SESSION-cap branch (auth-failover Fix 2) ─────
//
// The weekly-quota MENU path threads parseWeeklyReset → resolveExhaustUntil.
// Pre-fix, a SESSION cap ("resets 5pm", time-only, no month/day) returned null,
// forcing the caller's now+7d weekly fallback — benching a session-capped
// account for a WEEK. The new branch resolves it to the next occurrence of that
// wall-clock time (hours away), tz-aware, while leaving the month/day form
// untouched.
describe("Fable-5 usage-credits consent modal (mid-session)", () => {
  // Captured from a live wedged pane (finn, 2026-08-11). Two renderings so
  // the fixtures exercise SHAPE persistence, not byte-stability.
  const FABLE_A =
    "  Fable 5 now uses usage credits\n" +
    "\n" +
    "  Fable 5 runs on usage credits, purchased separately from your plan.\n" +
    "\n" +
    "    1. Continue with Fable 5\n" +
    "  ❯ 2. Switch to Sonnet 5 and continue\n" +
    "\n" +
    "  Enter to confirm · Esc to cancel";
  const FABLE_B = FABLE_A.replace("plan.", "plan. ");

  it("no pre-existing signature classifies it — this is why it wedged", () => {
    // The footer has no "to select" / "to navigate" / ↑↓ affordance…
    expect(WEDGE_FOOTER_SIGNATURE.test(FABLE_A)).toBe(false);
    // …option 2 is "Switch to Sonnet 5", not "No"…
    expect(CONFIRM_MODAL_SIGNATURE.test(FABLE_A)).toBe(false);
    // …there is no "Do you want to proceed?" / "don't ask again"…
    expect(PERMISSION_PROMPT_SIGNATURE.test(FABLE_A)).toBe(false);
    // …and no "Stop and wait for" (the quota-wall anchor), despite the
    // shared "usage credits" wording.
    expect(RATE_LIMIT_MENU_SIGNATURE.test(FABLE_A)).toBe(false);
    // The dedicated signature is the only one that sees it.
    expect(FABLE_CONSENT_SIGNATURE.test(FABLE_A)).toBe(true);
  });

  it("selects 'Continue with Fable 5' after the present-streak, never Enter/Esc", async () => {
    const { send, calls } = recordSend();
    const res = await runWedgeWatchdog({
      agentName: "finn",
      fableConsentPolls: 3,
      rateLimitSignature: null,
      manifestStallSignature: null,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 3,
      capture: captureFlicker([FABLE_A, FABLE_B, FABLE_A]),
      send,
    });
    expect(res.fableConsentFires).toBe(1);
    expect(res.fires).toBe(1);
    expect(calls).toEqual([["1", "Enter"]]);
    // Esc cancels the modal (leaving the operator's model choice unmade) and
    // Enter picks the CLI's default focus, which is option 2.
    expect(calls).not.toContainEqual(["Escape"]);
    expect(calls).not.toContainEqual(["Enter"]);
  });

  it("does NOT fire before the present-streak threshold", async () => {
    const { send, calls } = recordSend();
    const res = await runWedgeWatchdog({
      agentName: "finn",
      fableConsentPolls: 3,
      rateLimitSignature: null,
      manifestStallSignature: null,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 2,
      capture: captureFlicker([FABLE_A, FABLE_B]),
      send,
    });
    expect(res.fableConsentFires).toBe(0);
    expect(calls).toEqual([]);
  });

  it("with the branch disabled, nothing else touches the modal (kill switch)", async () => {
    const { send, calls } = recordSend();
    const res = await runWedgeWatchdog({
      agentName: "finn",
      fableConsentSignature: null,
      rateLimitSignature: null,
      manifestStallSignature: null,
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 6,
      capture: captureFlicker([FABLE_A, FABLE_B]),
      send,
    });
    expect(res.fableConsentFires).toBe(0);
    expect(res.fires).toBe(0);
    expect(calls).toEqual([]);
  });
});

describe("parseWeeklyReset — time-only session-cap branch (Fix 2)", () => {
  const HOUR = 3600_000;
  const WEEK = 7 * 24 * HOUR;
  // A fixed anchor: 2026-06-25T00:00:00Z (a Thursday). Deterministic so the
  // "next occurrence" maths is reproducible regardless of when the suite runs.
  const NOW = Date.UTC(2026, 5, 25, 0, 0, 0);

  function wallClockOf(epoch: number, tz: string): { hour: number; minute: number } {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false,
      })
        .formatToParts(new Date(epoch))
        .filter((p) => p.type !== "literal")
        .map((p) => [p.type, p.value]),
    );
    return { hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
  }

  it('resolves "resets 5pm (Australia/Melbourne)" to the next 17:00 there, hours away (NOT +7d)', () => {
    const epoch = parseWeeklyReset("resets 5pm (Australia/Melbourne)", NOW);
    expect(epoch).not.toBeNull();
    const delta = (epoch as number) - NOW;
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThanOrEqual(24 * HOUR);
    expect(delta).toBeLessThan(WEEK - HOUR); // the whole point: not the weekly floor
    expect(wallClockOf(epoch as number, "Australia/Melbourne")).toEqual({ hour: 17, minute: 0 });
  });

  it('resolves an am time with minutes — "resets 8:50am (Australia/Melbourne)"', () => {
    const epoch = parseWeeklyReset("resets 8:50am (Australia/Melbourne)", NOW);
    expect(epoch).not.toBeNull();
    expect((epoch as number) - NOW).toBeLessThanOrEqual(24 * HOUR);
    expect(wallClockOf(epoch as number, "Australia/Melbourne")).toEqual({ hour: 8, minute: 50 });
  });

  it('resolves a time without a tz label (best-effort UTC) — "resets 11pm"', () => {
    const epoch = parseWeeklyReset("resets 11pm", NOW);
    expect(epoch).not.toBeNull();
    expect((epoch as number) - NOW).toBeLessThanOrEqual(24 * HOUR);
    expect(wallClockOf(epoch as number, "UTC")).toEqual({ hour: 23, minute: 0 });
  });

  it('resolves a 24-hour clock time — "resets 17:00 (UTC)"', () => {
    const epoch = parseWeeklyReset("resets 17:00 (UTC)", NOW);
    expect(epoch).not.toBeNull();
    expect(wallClockOf(epoch as number, "UTC")).toEqual({ hour: 17, minute: 0 });
  });

  it("STILL resolves the month/day WEEKLY form (regression guard)", () => {
    // "resets Jun 27, 5am (UTC)" — two days ahead of NOW.
    const epoch = parseWeeklyReset("resets Jun 27, 5am (UTC)", NOW);
    expect(epoch).not.toBeNull();
    const asDate = new Date(epoch as number);
    expect(asDate.getUTCMonth()).toBe(5); // Jun
    expect(asDate.getUTCDate()).toBe(27);
    expect(wallClockOf(epoch as number, "UTC")).toEqual({ hour: 5, minute: 0 });
  });

  it("a month/day string never falls into the time-only branch", () => {
    // The negative lookahead must keep "Jun 9, 5pm" on the calendar branch, so
    // its resolved date is Jun 9 (a month away → roughly weekly-scale), NOT the
    // next 5pm tomorrow.
    const epoch = parseWeeklyReset("resets Jun 9, 5pm (UTC)", NOW);
    expect(epoch).not.toBeNull();
    const asDate = new Date(epoch as number);
    // Jun 9 already passed in 2026 relative to NOW (Jun 25) → rolls to next year.
    expect(asDate.getUTCMonth()).toBe(5); // Jun
    expect(asDate.getUTCDate()).toBe(9);
  });

  it("returns null on an unparseable line", () => {
    expect(parseWeeklyReset("nothing here", NOW)).toBeNull();
  });
});
