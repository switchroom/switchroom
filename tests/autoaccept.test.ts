// Unit tests for the TS autoaccept pane-poller (#725 PR-4).
//
// We mock `node:child_process` so the test never shells out to real tmux.
// Each `execFileSync` call is steered by a queue of canned pane-text /
// outcomes set up per-test, mirroring the way `tests/tmux-capture.test.ts`
// drives `captureAgentPane`.

import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("node:child_process", () => {
  return {
    execFileSync: vi.fn(),
  };
});

import { execFileSync } from "node:child_process";
import {
  runAutoaccept,
  PROMPTS,
  capturePane,
  sendKeys,
  type PromptRule,
} from "../src/agents/autoaccept.js";

const mockedExec = execFileSync as unknown as ReturnType<typeof vi.fn>;

/**
 * Build a stub for execFileSync that branches on the tmux subcommand.
 * `captureScreens` is consumed in order for each capture-pane call;
 * once exhausted, returns "".
 */
function setupTmux(captureScreens: string[]) {
  const sentKeys: string[][] = [];
  let captureIdx = 0;
  mockedExec.mockImplementation((_bin: string, args: readonly string[]) => {
    const subcmd = args[2];
    if (subcmd === "capture-pane") {
      const next = captureIdx < captureScreens.length
        ? captureScreens[captureIdx]
        : "";
      captureIdx++;
      return Buffer.from(next, "utf8");
    }
    if (subcmd === "send-keys") {
      // args: ["-L", socket, "send-keys", "-t", agent, ...keys]
      sentKeys.push([...args.slice(5)]);
      return Buffer.from("");
    }
    return Buffer.from("");
  });
  return { sentKeys };
}

beforeEach(() => {
  mockedExec.mockReset();
});

describe("runAutoaccept", () => {
  it("fires a single prompt once when the pane matches (theme picker)", async () => {
    const { sentKeys } = setupTmux([
      // poll 1: theme prompt visible
      "Choose the text style you'd like\n[1] Auto",
      // poll 2..N: nothing (no REPL footer) — runs out via maxPolls
      "",
    ]);
    const res = await runAutoaccept({
      agentName: "klanker",
      pollIntervalMs: 0,
      now: () => 0, // never advances; rely on maxPolls
      sleep: () => {},
      maxPolls: 5,
    });
    expect(res.fired).toContain("theme");
    expect(sentKeys).toEqual([["Enter"]]);
  });

  it("dispatches multi-prompt sequence in order: theme → mcp-trust → dev-channels", async () => {
    const { sentKeys } = setupTmux([
      "Choose the text style", // theme
      "Use this and all future MCP servers", // mcp-trust
      "I accept the use of development channels", // dev-channels
    ]);
    const res = await runAutoaccept({
      agentName: "a",
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 4,
    });
    expect(res.fired).toEqual(["theme", "mcp-trust", "dev-channels"]);
    expect(sentKeys).toEqual([
      ["Enter"],
      ["Enter"],
      ["Down", "Enter"],
    ]);
  });

  it("maxFires=1 prevents double-ack when the prompt re-appears in the scrollback", async () => {
    const { sentKeys } = setupTmux([
      "Choose the text style please",
      "Choose the text style please", // still in scrollback — must NOT re-fire
      "Choose the text style please",
    ]);
    const res = await runAutoaccept({
      agentName: "a",
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 5,
    });
    expect(res.fired).toEqual(["theme"]);
    expect(sentKeys).toHaveLength(1);
  });

  it("exits repl-ready the moment claude reaches the REPL (clean handoff)", async () => {
    // Boot screen, then the REPL footer appears → exit cleanly so the
    // sidecar hands the pane to the wedge-watchdog.
    setupTmux([
      "starting up…",
      "❯ \n────────────\n? for shortcuts · ← for agents",
    ]);
    const res = await runAutoaccept({
      agentName: "a",
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 50,
    });
    expect(res.reason).toBe("repl-ready");
    expect(res.fired).toEqual([]);
  });

  it("does NOT give up while claude is still booting, then fires a LATE-rendering dev-channels prompt", async () => {
    // The 2026-06-17 cold-restart regression: under CPU contention claude
    // took far longer than the old 30s idle window to render the
    // dev-channels prompt. The poller must keep waiting through a blank /
    // pre-REPL pane and still dispatch the prompt when it finally appears.
    const { sentKeys } = setupTmux([
      "", // claude not started rendering yet
      "",
      "",
      "",
      "", // ...well past the retired 30s idle window...
      "WARNING: Loading development channels\n❯ 1. I am using this for local development\n  2. Exit",
      "❯ \n? for shortcuts · ← for agents", // REPL after the prompt is dismissed
    ]);
    // Clock advances 60s per poll — under the OLD "idle since launch" logic
    // this would have given up on the first blank poll. The hard cap is far
    // higher, so the late prompt is still caught.
    let t = 0;
    const res = await runAutoaccept({
      agentName: "a",
      bootHardCapMs: 600_000,
      pollIntervalMs: 0,
      now: () => {
        t += 60_000;
        return t;
      },
      sleep: () => {},
      maxPolls: 50,
    });
    expect(res.fired).toContain("dev-channels-loading");
    expect(sentKeys[0]).toEqual(["Enter"]);
    expect(res.reason).toBe("repl-ready");
  });

  it("a blank pane never trips an early exit — only the hard cap does", async () => {
    // claude never renders anything (truly hung container). The poller must
    // not exit until bootHardCapMs, then surface idle-timeout so the sidecar
    // can still enter the watch phase.
    setupTmux([""]); // setupTmux returns "" once exhausted anyway
    let t = 0;
    const res = await runAutoaccept({
      agentName: "a",
      bootHardCapMs: 300,
      pollIntervalMs: 0,
      now: () => {
        t += 100;
        return t;
      },
      sleep: () => {},
      maxPolls: 50,
    });
    expect(res.reason).toBe("idle-timeout");
    expect(res.fired).toEqual([]);
  });

  it("soft-fails on tmux capture-pane errors (does not throw)", async () => {
    mockedExec.mockImplementation((_bin: string, args: readonly string[]) => {
      const subcmd = args[2];
      if (subcmd === "capture-pane") {
        throw new Error("tmux: no server running");
      }
      return Buffer.from("");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await runAutoaccept({
      agentName: "a",
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 3,
    });
    // The poll loop ran, captures all failed (logged), no fires, exits via maxPolls.
    expect(res.fired).toEqual([]);
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("soft-fails on send-keys errors (continues polling)", async () => {
    mockedExec.mockImplementation((_bin: string, args: readonly string[]) => {
      const subcmd = args[2];
      if (subcmd === "capture-pane") {
        return Buffer.from("Choose the text style", "utf8");
      }
      if (subcmd === "send-keys") {
        throw new Error("send-keys boom");
      }
      return Buffer.from("");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await runAutoaccept({
      agentName: "a",
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 2,
    });
    // The match still fires (we tried), maxFires caps further dispatch.
    expect(res.fired).toContain("theme");
    errSpy.mockRestore();
  });

  it("respects custom prompts override and maxFires=2", async () => {
    const rule: PromptRule = {
      name: "blip",
      match: /BLIP/,
      keys: ["Enter"],
      maxFires: 2,
    };
    const { sentKeys } = setupTmux(["BLIP", "BLIP", "BLIP", "BLIP"]);
    const res = await runAutoaccept({
      agentName: "a",
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 6,
      prompts: [rule],
    });
    expect(res.fired).toEqual(["blip", "blip"]);
    expect(sentKeys).toHaveLength(2);
  });
});

describe("PROMPTS — regex sanity (translated from bin/autoaccept.exp)", () => {
  // Canned fixture strings drawn from the same prompt phrases the legacy
  // expect script's regex was tuned against. If claude's TUI rewords any
  // of these, both this test and bin/autoaccept.exp need updating.
  const fixtures: Array<{ text: string; expected: string }> = [
    {
      text: "Choose the text style that looks best with your terminal",
      expected: "theme",
    },
    {
      text: "Use this and all future MCP servers in this project",
      expected: "mcp-trust",
    },
    {
      text: "Yes, I accept the use of development channels",
      expected: "dev-channels",
    },
    {
      // NEW prompt wording (mid-2026+): WARNING header.
      text: "WARNING: Loading development channels",
      expected: "dev-channels-loading",
    },
    {
      // NEW prompt wording (mid-2026+): option-row text. The header
      // matcher is preferred (defined first) but if scrollback hides it,
      // the option-row matcher catches the prompt.
      text: "❯ 1. I am using this for local development",
      expected: "dev-channels-local",
    },
    {
      text: "Anthropic API   /   Bedrock   /   Vertex",
      expected: "provider",
    },
    {
      // #2471 — the /effort confirmation modal.
      text: "Change effort level?\n❯ 1. Yes, switch to high\n  2. No, go back",
      expected: "effort-modal-dismiss",
    },
    {
      text: "Press Enter to confirm your selection",
      expected: "enter-to-confirm",
    },
  ];

  for (const { text, expected } of fixtures) {
    it(`matches the ${expected} prompt`, () => {
      const hit = PROMPTS.find((p) => p.match.test(text));
      expect(hit?.name).toBe(expected);
    });
  }

  it("#2471 — the effort modal rule dismisses with Escape (never confirms)", () => {
    const rule = PROMPTS.find((p) => p.name === "effort-modal-dismiss");
    expect(rule).toBeDefined();
    expect(rule?.keys).toEqual(["Escape"]);
    // Must allow several re-arms (a stack of queued /effort injects).
    expect(rule?.maxFires).toBeGreaterThan(1);
  });

  it("does NOT match per-tool 'Yes, I accept this file edit' style prompts", () => {
    // Critical: per-tool permission prompts must fall through to the
    // plugin's permission_request flow, not be auto-accepted here.
    const text = "Yes, I accept this file edit";
    const hit = PROMPTS.find((p) => p.match.test(text));
    expect(hit).toBeUndefined();
  });

  it("does NOT match other 'accept ... development' phrasings that aren't the dev-channels prompt", () => {
    // Defensive: confirm the new matchers don't fire on tangentially
    // related strings. Per-tool confirmations and any other dialog must
    // remain the security boundary.
    const negatives = [
      "Yes, accept this development file edit",
      "Allow Claude to make development changes to this file?",
      "I am using this for production",
    ];
    for (const text of negatives) {
      const hit = PROMPTS.find((p) => p.match.test(text));
      expect(hit, `unexpectedly matched: ${text}`).toBeUndefined();
    }
  });
});

describe("runAutoaccept — new dev-channels prompt dispatch", () => {
  // Re-declare the local helper here so this block can drive captures
  // independent of the module-level setup.
  function setupTmuxLocal(captureScreens: string[]) {
    const sentKeys: string[][] = [];
    let captureIdx = 0;
    mockedExec.mockImplementation((_bin: string, args: readonly string[]) => {
      const subcmd = args[2];
      if (subcmd === "capture-pane") {
        const next = captureIdx < captureScreens.length
          ? captureScreens[captureIdx]
          : "";
        captureIdx++;
        return Buffer.from(next, "utf8");
      }
      if (subcmd === "send-keys") {
        sentKeys.push([...args.slice(5)]);
        return Buffer.from("");
      }
      return Buffer.from("");
    });
    return { sentKeys };
  }

  it("fires the new 'Loading development channels' prompt with Enter only (no Down)", async () => {
    const { sentKeys } = setupTmuxLocal([
      "WARNING: Loading development channels\n❯ 1. I am using this for local development\n  2. Exit",
      "",
    ]);
    const res = await runAutoaccept({
      agentName: "a",
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 4,
    });
    // The header matcher is defined first and wins.
    expect(res.fired).toContain("dev-channels-loading");
    // Critical: keys are Enter only — no Down keystroke would land on the
    // "Exit" option and kill claude on first launch.
    expect(sentKeys[0]).toEqual(["Enter"]);
  });

  it("still fires the legacy dev-channels prompt with Down+Enter for older Claude Code releases", async () => {
    const { sentKeys } = setupTmuxLocal([
      "Yes, I accept the use of development channels",
      "",
    ]);
    const res = await runAutoaccept({
      agentName: "a",
      pollIntervalMs: 0,
      now: () => 0,
      sleep: () => {},
      maxPolls: 4,
    });
    expect(res.fired).toContain("dev-channels");
    expect(sentKeys[0]).toEqual(["Down", "Enter"]);
  });
});

describe("capturePane / sendKeys helpers", () => {
  it("capturePane returns '' on tmux error (soft-fail)", () => {
    mockedExec.mockImplementation(() => {
      throw new Error("nope");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = capturePane("a");
    expect(out).toBe("");
    errSpy.mockRestore();
  });

  it("sendKeys returns false on tmux error (soft-fail)", () => {
    mockedExec.mockImplementation(() => {
      throw new Error("nope");
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ok = sendKeys("a", ["Enter"]);
    expect(ok).toBe(false);
    errSpy.mockRestore();
  });

  it("capturePane uses the per-agent socket and target", () => {
    mockedExec.mockReturnValue(Buffer.from("hello"));
    capturePane("klanker");
    const args = mockedExec.mock.calls[0]?.[1] as string[];
    expect(args).toContain("-L");
    expect(args).toContain("switchroom-klanker");
    expect(args).toContain("capture-pane");
    expect(args).toContain("-t");
    expect(args).toContain("klanker");
  });
});
