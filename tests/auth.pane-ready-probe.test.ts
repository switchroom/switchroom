import { describe, expect, it } from "vitest";
import {
  paneHasCodePrompt,
  probeForCodePrompt,
  type PaneReadyDeps,
} from "../src/auth/pane-ready-probe";

// ── paneHasCodePrompt ────────────────────────────────────────────────────────

describe("paneHasCodePrompt", () => {
  it("returns true when pane contains 'Paste code here' (exact case)", () => {
    expect(paneHasCodePrompt("Paste code here: ")).toBe(true);
  });

  it("returns true when pane contains 'paste code here' (lowercase)", () => {
    expect(paneHasCodePrompt("paste code here")).toBe(true);
  });

  it("returns true when embedded in longer pane output", () => {
    const pane = `
Login URL: https://claude.com/cai/oauth/authorize?code_challenge=ABC

Paste code here:
`;
    expect(paneHasCodePrompt(pane)).toBe(true);
  });

  it("returns false when the prompt is absent", () => {
    expect(paneHasCodePrompt("Please wait...")).toBe(false);
    expect(paneHasCodePrompt("")).toBe(false);
    expect(paneHasCodePrompt("Login successful")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(paneHasCodePrompt("PASTE CODE HERE")).toBe(true);
    expect(paneHasCodePrompt("Paste Code Here")).toBe(true);
  });
});

// ── probeForCodePrompt ────────────────────────────────────────────────────────
//
// Uses injectable deps to avoid needing a real tmux process.

function makeDeps(
  paneOutputs: (string | null)[],
  timeMs: number[] = [],
): PaneReadyDeps {
  let captureCallCount = 0;
  let nowCallCount = 0;
  return {
    capturePane(_sessionName: string): string | null {
      const idx = captureCallCount++;
      return idx < paneOutputs.length ? paneOutputs[idx] : null;
    },
    sleepMs(_ms: number): void {
      // no-op in tests
    },
    nowMs(): number {
      const idx = nowCallCount++;
      return idx < timeMs.length ? timeMs[idx] : 0;
    },
  };
}

describe("probeForCodePrompt", () => {
  it("returns ready:true immediately when prompt is present on first poll", () => {
    const deps = makeDeps(["Paste code here: "]);
    const result = probeForCodePrompt("test-session", 5000, 250, deps);
    expect(result.ready).toBe(true);
  });

  it("returns ready:true after a few polls when prompt appears", () => {
    // First two captures return no prompt, third has it.
    const deps = makeDeps(
      ["Loading...", "Still loading...", "Paste code here: "],
      [0, 200, 400, 600, 800, 1000],
    );
    const result = probeForCodePrompt("test-session", 5000, 250, deps);
    expect(result.ready).toBe(true);
  });

  it("returns ready:false with reason 'prompt-not-visible' when timeout expires", () => {
    // All captures return content without the prompt.
    // nowMs progresses past the timeout after 2 calls.
    const deps: PaneReadyDeps = {
      capturePane: () => "Loading...",
      sleepMs: () => {},
      nowMs: (() => {
        let call = 0;
        // Start=0, deadline=5000. After 2 polls, return 6000 so loop exits.
        const times = [0, 100, 6000];
        return () => times[Math.min(call++, times.length - 1)] ?? 6000;
      })(),
    };
    const result = probeForCodePrompt("test-session", 5000, 250, deps);
    expect(result.ready).toBe(false);
    if (!result.ready) expect(result.reason).toBe("prompt-not-visible");
  });

  it("returns ready:false with reason 'session-gone' when capturePane returns null", () => {
    const deps = makeDeps([null]);
    const result = probeForCodePrompt("test-session", 5000, 250, deps);
    expect(result.ready).toBe(false);
    if (!result.ready) expect(result.reason).toBe("session-gone");
  });

  it("returns session-gone even if timeout hasn't expired", () => {
    // null on first call should immediately return session-gone regardless of time.
    const deps: PaneReadyDeps = {
      capturePane: () => null,
      sleepMs: () => {},
      nowMs: () => 0, // never past deadline
    };
    const result = probeForCodePrompt("test-session", 5000, 250, deps);
    expect(result.ready).toBe(false);
    if (!result.ready) expect(result.reason).toBe("session-gone");
  });
});
