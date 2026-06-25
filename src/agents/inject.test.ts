/**
 * Tests for the #725 Phase 2 inject primitive.
 *
 * The real tmux process is faked via the TmuxRunner test seam — these
 * tests assert the validation rules, the session-existence check, the
 * pane-diff logic, and outcome classification.
 *
 * Run: npx vitest run src/agents/inject.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  INJECT_COMMANDS,
  INJECT_BLOCKED,
  InjectError,
  diffPane,
  dedupeInjectQueue,
  injectSlashCommand,
  injectSlashCommandWith,
  isTuiChromeLine,
  normalizeInjectCommand,
  validateInjectCommand,
  type TmuxRunner,
} from "./inject.js";

describe("validateInjectCommand", () => {
  it("accepts every command in the allowlist", () => {
    for (const cmd of INJECT_COMMANDS.keys()) {
      expect(validateInjectCommand(cmd)).toBe(cmd);
    }
  });

  it("accepts an allowed command with trailing args (verb-only check)", () => {
    expect(validateInjectCommand("/model claude-opus-4")).toBe("/model");
  });

  it("is case-insensitive on the verb", () => {
    expect(validateInjectCommand("/COST")).toBe("/cost");
  });

  it("throws blocked for /login, /logout, /exit, /quit", () => {
    for (const cmd of INJECT_BLOCKED.keys()) {
      const err = (() => {
        try {
          validateInjectCommand(cmd);
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err).toBeInstanceOf(InjectError);
      expect((err as InjectError).code).toBe("blocked");
    }
  });

  it("#2471 — blocks /effort (opens a blocking confirmation modal)", () => {
    for (const variant of ["/effort", "/effort high", "/EFFORT high"]) {
      try {
        validateInjectCommand(variant);
        throw new Error(`expected /effort to be blocked: ${variant}`);
      } catch (e) {
        expect(e).toBeInstanceOf(InjectError);
        expect((e as InjectError).code).toBe("blocked");
        expect((e as InjectError).message).toMatch(/blocking confirmation modal/i);
      }
    }
  });

  it("throws not_allowed for any command outside the allow/blocklist", () => {
    expect(() => validateInjectCommand("/foo")).toThrow(InjectError);
    try {
      validateInjectCommand("/foo");
    } catch (e) {
      expect((e as InjectError).code).toBe("not_allowed");
    }
  });

  it("throws invalid for empty / non-slash input", () => {
    for (const bad of ["", "  ", "cost", "no-slash"]) {
      try {
        validateInjectCommand(bad);
        throw new Error(`expected throw on ${JSON.stringify(bad)}`);
      } catch (e) {
        expect(e).toBeInstanceOf(InjectError);
        expect((e as InjectError).code).toBe("invalid");
      }
    }
  });
});

describe("INJECT_COMMANDS metadata", () => {
  it("provides expected metadata shape for every entry", () => {
    for (const [verb, meta] of INJECT_COMMANDS) {
      expect(verb.startsWith("/")).toBe(true);
      expect(typeof meta.description).toBe("string");
      expect(typeof meta.expectsOutput).toBe("boolean");
    }
  });

  it("/compact carries a silentNote", () => {
    expect(INJECT_COMMANDS.get("/compact")?.silentNote).toBe(
      "compaction runs silently",
    );
  });

  it("/clear has expectsOutput=false and silentNote 'context cleared — fresh slate'", () => {
    const meta = INJECT_COMMANDS.get("/clear");
    expect(meta?.expectsOutput).toBe(false);
    expect(meta?.silentNote).toBe("context cleared — fresh slate");
  });
});

describe("#2471 dedupeInjectQueue", () => {
  it("collapses repeated identical commands to a single send (order-preserving)", () => {
    const queue = ["/effort high", "/effort high", "/effort high"];
    expect(dedupeInjectQueue(queue)).toEqual(["/effort high"]);
  });

  it("treats case- and whitespace-variants as the same command", () => {
    const queue = ["/effort high", "/EFFORT  high", "  /effort   high  "];
    expect(dedupeInjectQueue(queue)).toEqual(["/effort high"]);
  });

  it("keeps distinct commands and preserves first-occurrence order", () => {
    const queue = ["/cost", "/effort high", "/cost", "/status", "/effort high"];
    expect(dedupeInjectQueue(queue)).toEqual(["/cost", "/effort high", "/status"]);
  });

  it("drops empty / whitespace-only entries", () => {
    expect(dedupeInjectQueue(["", "  ", "/cost", ""])).toEqual(["/cost"]);
  });

  it("returns an empty array for an empty queue", () => {
    expect(dedupeInjectQueue([])).toEqual([]);
  });

  it("normalizeInjectCommand collapses casing and whitespace", () => {
    expect(normalizeInjectCommand("  /EFFORT   high  ")).toBe("/effort high");
  });
});

describe("diffPane", () => {
  it("returns lines in after that aren't in before (set-diff fallback)", () => {
    const before = "line one\nline two\n";
    const after = "line one\nline two\nline three\n";
    const r = diffPane(before, after);
    expect(r.output).toBe("line three");
    expect(r.anchored).toBe(false);
  });

  it("ignores empty lines", () => {
    const before = "a\nb\n";
    const after = "\n\na\nb\nc\n\n";
    expect(diffPane(before, after).output).toBe("c");
  });

  it("returns empty string when nothing new", () => {
    expect(diffPane("a\nb", "a\nb").output).toBe("");
  });

  it("anchors on the LAST command-echo line in `after`", () => {
    const before = `❯ /usage
   Status   Config   Usage   Stats
  Session
  Total cost: $0.50
  Esc to cancel`;
    const after = `❯ /usage
   Status   Config   Usage   Stats
  Session
  Total cost: $0.50
  Esc to cancel
some-narrative
❯ /usage
   Status   Config   Usage   Stats
  Session
  Total cost: $0.75
  Esc to cancel`;
    const r = diffPane(before, after, "/usage");
    expect(r.output).toContain("Status   Config   Usage   Stats");
    expect(r.output).toContain("$0.75");
    expect(r.output).not.toContain("Esc to cancel");
    expect(r.anchored).toBe(true);
  });

  it("falls back to line-set diff when command anchor is absent", () => {
    const before = "old line A\nold line B";
    const after = "old line A\nold line B\nnew line C\nnew line D";
    const r = diffPane(before, after, "/cost");
    expect(r.output).toContain("new line C");
    expect(r.output).toContain("new line D");
    expect(r.anchored).toBe(false);
  });
});

describe("isTuiChromeLine — chrome predicate", () => {
  // Lines that must be filtered (chrome)
  it("identifies box-drawing rule lines as chrome", () => {
    expect(isTuiChromeLine("─────────────────────────────")).toBe(true);
    expect(isTuiChromeLine("│")).toBe(true);
    expect(isTuiChromeLine("╭──────────────────────╮")).toBe(true);
    expect(isTuiChromeLine("╰──────────────────────╯")).toBe(true);
    expect(isTuiChromeLine("______________________________")).toBe(true);
    expect(isTuiChromeLine("------------------------------")).toBe(true);
  });

  it("identifies bare prompt-glyph lines as chrome", () => {
    expect(isTuiChromeLine("❯")).toBe(true);
    expect(isTuiChromeLine(">")).toBe(true);
    expect(isTuiChromeLine(")")).toBe(true);
    expect(isTuiChromeLine("  ❯  ")).toBe(true);
    expect(isTuiChromeLine("│ ❯ │")).toBe(true);
  });

  it("identifies footer hint lines as chrome", () => {
    expect(isTuiChromeLine("▶▶ accept edits on (shift+tab to cycle) · ← for agents")).toBe(true);
    expect(isTuiChromeLine("shift+tab to cycle modes")).toBe(true);
    expect(isTuiChromeLine("← for agents")).toBe(true);
    expect(isTuiChromeLine("? for shortcuts")).toBe(true);
    expect(isTuiChromeLine("bypassing permissions")).toBe(true);
  });

  it("identifies the copy affordance as chrome", () => {
    expect(isTuiChromeLine("copy")).toBe(true);
  });

  // Lines that must NOT be filtered (real content)
  it("does NOT strip real output lines", () => {
    expect(isTuiChromeLine("Total cost: $1.23")).toBe(false);
    expect(isTuiChromeLine("Session cost: $0.05")).toBe(false);
    expect(isTuiChromeLine("  Model: claude-opus-4  ")).toBe(false);
    expect(isTuiChromeLine("Context window: 3%")).toBe(false);
    expect(isTuiChromeLine("No hooks configured")).toBe(false);
    expect(isTuiChromeLine("  Cache creation: 1234 tokens")).toBe(false);
  });
});

describe("diffPane — /clear post-clear TUI chrome filtering", () => {
  // Realistic post-/clear capture: command-echo ABSENT (wiped), fresh input-box chrome visible
  const clearBefore = `  Some earlier output line
  Another earlier line
❯ /clear`;

  const clearAfter = `╭──────────────────────────────────────────────────────────────────────╮
│ ❯                                                                    │
╰──────────────────────────────────────────────────────────────────────╯
▶▶ accept edits on (shift+tab to cycle) · ← for agents`;

  it("falls back to set-diff when /clear echo is absent", () => {
    const r = diffPane(clearBefore, clearAfter, "/clear");
    expect(r.anchored).toBe(false);
  });

  it("strips all chrome lines in the fallback path — output is empty", () => {
    const r = diffPane(clearBefore, clearAfter, "/clear");
    expect(r.output).toBe("");
  });

  // Regression test for the v2.1.185 bug: after /clear, the command-echo
  // line `❯ /clear` SURVIVES in capture-pane output, so the anchored path
  // runs — but it was returning the trailing chrome raw. The fix adds
  // isTuiChromeLine filtering to the anchored path as well. After filtering,
  // the tail is empty, so the code falls through to set-diff (anchored=false)
  // which is also empty → output="" → ok_no_output. Either way, the critical
  // invariant is that output is empty (no chrome leaks to Telegram).
  //
  // This is the exact `after` pane from the live reproduction capture at
  // /state/agent/home/workspace/clearfix-evidence/after.txt (trimmed to the
  // relevant tail after the startup banner).
  it("anchored path: /clear echo present + trailing chrome → output empty (v2.1.185 regression)", () => {
    const before = `❯ /clear`;
    const after = `❯ /clear

────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents`;
    const r = diffPane(before, after, "/clear");
    expect(r.output, "chrome-only tail must yield empty output — no chrome leaks to Telegram").toBe("");
  });

  it("anchored /cost path with trailing chrome — real content passes, chrome is stripped", () => {
    const before = "❯ /cost\n";
    const after = `❯ /cost
  Total cost: $1.23
  Session: $0.12 (3 turns)
────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents`;
    const r = diffPane(before, after, "/cost");
    expect(r.anchored).toBe(true);
    expect(r.output).toContain("Total cost: $1.23");
    expect(r.output).toContain("$0.12");
    expect(r.output).not.toContain("────────────────────────────────────────────────────────────────────────────────");
    expect(r.output).not.toContain("accept edits on");
    expect(r.output).not.toMatch(/^❯\s*$/m);
  });

  it("anchored /cost path is unaffected by fix — real content passes through (no chrome present)", () => {
    const before = "❯ /cost\n";
    const after = `❯ /cost
  Total cost: $0.42
  Session: $0.12 (3 turns)`;
    const r = diffPane(before, after, "/cost");
    expect(r.anchored).toBe(true);
    expect(r.output).toContain("Total cost: $0.42");
    expect(r.output).toContain("$0.12");
  });

  it("fallback does NOT strip real output lines that happen to appear without an anchor", () => {
    const before = "old line\n";
    const after = "old line\nTotal cost: $1.23\nContext window: 5%\n";
    const r = diffPane(before, after, "/cost");
    expect(r.anchored).toBe(false);
    expect(r.output).toContain("Total cost: $1.23");
    expect(r.output).toContain("Context window: 5%");
  });
});

describe("injectSlashCommandWith — /clear produces ok_no_output (not ok with chrome)", () => {
  it("post-clear pane with only TUI chrome (anchor absent) → outcome=ok_no_output, output empty", async () => {
    // Simulate what happens after /clear: pre-snapshot has content,
    // post-capture has only fresh input-box chrome (no command-echo line).
    const before = `  Some earlier session output
  Another line of output
❯ /clear`;
    const clearChrome = `╭───────────────────────────────────────────────────────────────╮
│ ❯                                                             │
╰───────────────────────────────────────────────────────────────╯
▶▶ accept edits on (shift+tab to cycle) · ← for agents`;

    let callCount = 0;
    const runner: TmuxRunner = {
      hasSession: () => true,
      capture: () => {
        callCount += 1;
        // First capture (before send) returns the pre-snapshot.
        // Subsequent captures (after send) return the post-clear chrome.
        return callCount === 1 ? before : clearChrome;
      },
      send: () => {},
    };

    const r = await injectSlashCommandWith(runner, {
      socket: "switchroom-test",
      session: "test",
      command: "/clear",
      settleMs: 50,
      timeoutMs: 200,
    });

    expect(r.outcome).toBe("ok_no_output");
    expect(r.output).toBe("");
    expect(r.command).toBe("/clear");
    expect(r.meta?.silentNote).toBe("context cleared — fresh slate");
  });

  // Regression test for the v2.1.185 bug: the command-echo `❯ /clear`
  // survives in tmux capture-pane after /clear runs, so the anchored path
  // runs and previously returned trailing chrome verbatim. With the fix the
  // anchored path also strips chrome, leaving an empty tail → ok_no_output.
  it("post-clear pane with command-echo anchor + trailing chrome → outcome=ok_no_output (v2.1.185 regression)", async () => {
    const before = `  Some earlier session output
  Another line of output
❯ /clear`;
    // Exact shape from the live reproduction capture: echo survives, chrome follows.
    const afterWithAnchor = `❯ /clear

────────────────────────────────────────────────────────────────────────────────
❯
────────────────────────────────────────────────────────────────────────────────
  ⏵⏵ accept edits on (shift+tab to cycle) · ← for agents`;

    let callCount = 0;
    const runner: TmuxRunner = {
      hasSession: () => true,
      capture: () => {
        callCount += 1;
        return callCount === 1 ? before : afterWithAnchor;
      },
      send: () => {},
    };

    const r = await injectSlashCommandWith(runner, {
      socket: "switchroom-test",
      session: "test",
      command: "/clear",
      settleMs: 50,
      timeoutMs: 200,
    });

    expect(r.outcome).toBe("ok_no_output");
    expect(r.output).toBe("");
    expect(r.command).toBe("/clear");
    expect(r.meta?.silentNote).toBe("context cleared — fresh slate");
  });
});

// ─── injectSlashCommandWith — outcome classification ───────────────────────

interface FakeRunner {
  hasSession: (s: string, n: string) => boolean;
  capture: (s: string, n: string) => string | null;
  send: (s: string, n: string, args: string[]) => void;
}

function makeFake(opts: {
  hasSession?: boolean;
  captures?: string[];
  onSend?: (args: string[]) => void;
  sendThrows?: Error;
}): FakeRunner {
  let i = 0;
  const captures = opts.captures ?? [];
  return {
    hasSession: () => opts.hasSession ?? true,
    capture: () => {
      const v = captures[Math.min(i, captures.length - 1)] ?? "";
      i += 1;
      return v;
    },
    send: (_s, _n, args) => {
      if (opts.sendThrows) throw opts.sendThrows;
      opts.onSend?.(args);
    },
  };
}

describe("injectSlashCommandWith — outcomes", () => {
  it("outcome=failed (session_missing) when has-session returns false", async () => {
    const runner = makeFake({ hasSession: false });
    const r = await injectSlashCommandWith(runner, {
      socket: "switchroom-x",
      session: "x",
      command: "/cost",
      settleMs: 50,
      timeoutMs: 100,
    });
    expect(r.outcome).toBe("failed");
    expect(r.errorCode).toBe("session_missing");
    expect(r.command).toBe("/cost");
    expect(r.meta).not.toBeNull();
  });

  it("outcome=failed (tmux_failed) when send-keys throws", async () => {
    const runner = makeFake({
      hasSession: true,
      captures: ["before\n"],
      sendThrows: new Error("connection refused"),
    });
    const r = await injectSlashCommandWith(runner, {
      socket: "switchroom-x",
      session: "x",
      command: "/cost",
      settleMs: 50,
      timeoutMs: 100,
    });
    expect(r.outcome).toBe("failed");
    expect(r.errorCode).toBe("tmux_failed");
    expect(r.errorMessage).toContain("connection refused");
  });

  it("outcome=ok with non-empty capture", async () => {
    const before = "$ \n";
    const after = "$ /cost\n\nTotal cost: $0.42\n$ \n";
    const runner = makeFake({
      hasSession: true,
      captures: [before, after, after, after, after],
    });
    const sent: string[][] = [];
    runner.send = (_s, _n, args) => sent.push(args);

    const result = await injectSlashCommandWith(runner, {
      socket: "switchroom-x",
      session: "x",
      command: "/cost",
      settleMs: 50,
      timeoutMs: 1000,
    });

    expect(sent).toEqual([
      ["send-keys", "-l", "/cost"],
      ["send-keys", "Enter"],
    ]);
    expect(result.outcome).toBe("ok");
    expect(result.output).toContain("Total cost: $0.42");
    expect(result.truncated).toBe(false);
    expect(result.command).toBe("/cost");
    expect(result.meta?.expectsOutput).toBe(true);
  });

  it("outcome=ok with diagnostic=truncated_output when over byte cap", async () => {
    const before = "";
    const big = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    const runner = makeFake({
      hasSession: true,
      captures: [before, big, big, big, big],
    });
    const r = await injectSlashCommandWith(runner, {
      socket: "switchroom-x",
      session: "x",
      command: "/cost",
      settleMs: 50,
      timeoutMs: 1000,
    });
    expect(r.outcome).toBe("ok");
    expect(r.truncated).toBe(true);
    expect(r.diagnostic).toBe("truncated_output");
    expect(Buffer.byteLength(r.output, "utf-8")).toBeLessThanOrEqual(3000);
  });

  it("outcome=ok_no_output with diagnostic=anchor_missing when capture is empty", async () => {
    // Pre and post identical (no anchor, no new lines) → empty output.
    const buf = "$ \n";
    const runner = makeFake({
      hasSession: true,
      captures: [buf, buf, buf, buf, buf],
    });
    const r = await injectSlashCommandWith(runner, {
      socket: "switchroom-x",
      session: "x",
      command: "/clear",
      settleMs: 30,
      timeoutMs: 200,
    });
    expect(r.outcome).toBe("ok_no_output");
    expect(r.output).toBe("");
    expect(r.diagnostic).toBe("anchor_missing");
    expect(r.command).toBe("/clear");
    expect(r.meta?.expectsOutput).toBe(false);
  });
});

describe("injectSlashCommand (default runner — validation only)", () => {
  it("rejects blocked commands before touching tmux", async () => {
    await expect(injectSlashCommand("any", "/login")).rejects.toMatchObject({
      code: "blocked",
    });
  });

  it("rejects unknown commands before touching tmux", async () => {
    await expect(injectSlashCommand("any", "/foo")).rejects.toMatchObject({
      code: "not_allowed",
    });
  });
});

/**
 * Per-allowlist-entry coverage: every command in INJECT_COMMANDS must
 * round-trip through injectSlashCommandWith and produce the expected
 * outcome shape, with the right metadata wired through. Catches drift
 * between the metadata map and the classifier.
 *
 * Mirrors the response-shape contract per command:
 *  - expectsOutput=true + we return realistic pane bytes → outcome=ok
 *  - expectsOutput=true + we return empty pane → outcome=ok_no_output
 *  - expectsOutput=false + we return empty pane → outcome=ok_no_output
 *    (with silentNote propagating through meta when present)
 */
function makeFakeRunner(paneAfter: string): TmuxRunner {
  const sent: string[][] = [];
  let captures = 0;
  const runner: TmuxRunner = {
    capture: () => {
      captures++;
      // First capture (before send) returns empty; subsequent (after
      // send) return the simulated post-inject pane.
      return captures === 1 ? "" : paneAfter;
    },
    send: (_socket, _session, args) => {
      sent.push(args);
    },
    hasSession: () => true,
  };
  // expose for assertions if needed
  (runner as unknown as { __sent: string[][] }).__sent = sent;
  return runner;
}

describe("INJECT_COMMANDS — per-entry classifier coverage (#725)", () => {
  for (const [verb, meta] of INJECT_COMMANDS.entries()) {
    it(`${verb} (expectsOutput=${meta.expectsOutput}) classifies ok when capture has output`, async () => {
      const paneAfter = `❯ ${verb}\n  rendered output line 1\n  rendered output line 2\n`;
      const runner = makeFakeRunner(paneAfter);
      const r = await injectSlashCommandWith(runner, {
        socket: "test", session: "test", command: verb,
        settleMs: 50, timeoutMs: 200,
      });
      expect(r.outcome, `expected ok for ${verb}`).toBe("ok");
      expect(r.command).toBe(verb);
      expect(r.meta).not.toBeNull();
      expect(r.meta?.description).toBe(meta.description);
      expect(r.meta?.expectsOutput).toBe(meta.expectsOutput);
      expect(r.output.length, `output for ${verb}`).toBeGreaterThan(0);
    });

    it(`${verb} classifies ok_no_output when capture is empty`, async () => {
      const runner = makeFakeRunner("");
      const r = await injectSlashCommandWith(runner, {
        socket: "test", session: "test", command: verb,
        settleMs: 50, timeoutMs: 200,
      });
      expect(r.outcome).toBe("ok_no_output");
      expect(r.command).toBe(verb);
      // silentNote propagates verbatim when the metadata declares one.
      expect(r.meta?.silentNote).toBe(meta.silentNote);
      expect(r.output).toBe("");
    });
  }
});

describe("INJECT_BLOCKED — per-entry coverage (#725)", () => {
  for (const [verb, meta] of INJECT_BLOCKED.entries()) {
    it(`${verb} returns failed:blocked with the configured reason`, async () => {
      const runner = makeFakeRunner("");
      const r = await injectSlashCommandWith(runner, {
        socket: "test", session: "test", command: verb,
        settleMs: 50, timeoutMs: 200,
      });
      expect(r.outcome).toBe("failed");
      expect(r.errorCode).toBe("blocked");
      // The user-facing error message should mention the configured reason.
      expect(r.errorMessage).toContain(meta.reason);
    });
  }
});
