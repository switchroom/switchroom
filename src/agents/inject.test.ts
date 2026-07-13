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

  it("#730 arg-gate — rejects trailing args for a bare-verb-only command", () => {
    // Was previously accepted (verb-only match); the arg-gate now rejects it.
    for (const cmd of ["/cost some-arg", "/memory edit", "/clear --flag"]) {
      const err = (() => {
        try {
          validateInjectCommand(cmd);
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err, `${cmd} must be rejected`).toBeInstanceOf(InjectError);
      expect((err as InjectError).code).toBe("args_not_allowed");
      expect((err as InjectError).message).toMatch(/args not permitted/i);
    }
  });

  it("#730 arg-gate — /model KEEPS args allowed (sanctioned set path, #2566)", () => {
    // The dedicated /model driver injects `/model <alias|id>` WITH an arg as
    // the sanctioned session-switch path. Gating it off would break /model.
    expect(validateInjectCommand("/model claude-sonnet-4-6")).toBe("/model");
    expect(validateInjectCommand("/model opus")).toBe("/model");
  });

  it("#730 arg-gate — every non-/model allowlist entry forbids args", () => {
    for (const [verb, meta] of INJECT_COMMANDS.entries()) {
      if (verb === "/model") {
        expect(meta.argsAllowed, "/model must allow args").toBe(true);
        continue;
      }
      expect(meta.argsAllowed, `${verb} must forbid args`).toBe(false);
      const err = (() => {
        try {
          validateInjectCommand(`${verb} extra`);
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err, `${verb} extra must be rejected`).toBeInstanceOf(InjectError);
      expect((err as InjectError).code).toBe("args_not_allowed");
    }
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

  it("#730 — new defensive blocklist entries return code 'blocked' (not not_allowed)", () => {
    const added = [
      "/upgrade",
      "/init",
      "/mcp",
      "/permissions",
      "/install-github-app",
      "/add-dir",
      "/terminal-setup",
      "/privacy-settings",
      "/bug",
    ];
    for (const cmd of added) {
      expect(INJECT_BLOCKED.has(cmd), `${cmd} must be blocklisted`).toBe(true);
      const err = (() => {
        try {
          validateInjectCommand(cmd);
          return null;
        } catch (e) {
          return e;
        }
      })();
      expect(err, `${cmd} must throw`).toBeInstanceOf(InjectError);
      expect((err as InjectError).code, `${cmd} → blocked`).toBe("blocked");
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
      expect(typeof meta.argsAllowed).toBe("boolean");
    }
  });

  it("#730 — new read-only additions are on the allowlist (bare verb accepted)", () => {
    for (const cmd of ["/help", "/context", "/release-notes"]) {
      expect(INJECT_COMMANDS.has(cmd), `${cmd} must be allowlisted`).toBe(true);
      expect(validateInjectCommand(cmd)).toBe(cmd);
    }
  });

  it("#730 — /help and /release-notes are dialog:true (Escape-dismiss), /context is inline", () => {
    expect(INJECT_COMMANDS.get("/help")?.dialog).toBe(true);
    expect(INJECT_COMMANDS.get("/release-notes")?.dialog).toBe(true);
    // /context renders inline (no modal) — verified via TUI probe, v2.1.205.
    expect(INJECT_COMMANDS.get("/context")?.dialog).toBeUndefined();
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

    // /cost has dialog:true — the two-step command send is followed by an
    // Escape dismiss. Three sends total.
    expect(sent).toEqual([
      ["send-keys", "-l", "/cost"],
      ["send-keys", "Enter"],
      ["send-keys", "Escape"],
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

// ─── #2566 — dialog dismissal ───────────────────────────────────────────────

describe("#2566 — dialog:true commands send Escape after capture", () => {
  /**
   * Helper that drives injectSlashCommandWith with a mock runner that
   * records all `send-keys` args in order. Returns `{ result, sent }`.
   */
  async function driveWithSentLog(
    command: string,
    paneAfter: string,
  ): Promise<{ result: Awaited<ReturnType<typeof injectSlashCommandWith>>; sent: string[][] }> {
    const sent: string[][] = [];
    let captures = 0;
    const runner: TmuxRunner = {
      hasSession: () => true,
      capture: () => {
        captures++;
        return captures === 1 ? "" : paneAfter;
      },
      send: (_s, _n, args) => {
        sent.push(args);
      },
    };
    const result = await injectSlashCommandWith(runner, {
      socket: "test",
      session: "test",
      command,
      settleMs: 50,
      timeoutMs: 200,
    });
    return { result, sent };
  }

  it("/status (dialog:true) — sends Escape AFTER Enter, captured output is returned", async () => {
    const dialogOutput = `❯ /status
   Settings   Status   Config   Usage   Stats
  Session: active
  Model: claude-opus-4`;
    const { result, sent } = await driveWithSentLog("/status", dialogOutput);

    // The command + Enter should be the first two sends.
    expect(sent[0]).toEqual(["send-keys", "-l", "/status"]);
    expect(sent[1]).toEqual(["send-keys", "Enter"]);
    // Escape must be the LAST send (dismiss the dialog after capture).
    expect(sent[sent.length - 1]).toEqual(["send-keys", "Escape"]);
    // Captured dialog content is still returned so Telegram gets it.
    expect(result.outcome).toBe("ok");
    expect(result.output).toContain("Settings   Status   Config   Usage   Stats");
  });

  it("/cost (dialog:true) — sends Escape AFTER Enter, captured output is returned", async () => {
    const dialogOutput = `❯ /cost
  Total cost: $1.23
  Session: $0.12 (3 turns)`;
    const { result, sent } = await driveWithSentLog("/cost", dialogOutput);

    expect(sent[0]).toEqual(["send-keys", "-l", "/cost"]);
    expect(sent[1]).toEqual(["send-keys", "Enter"]);
    expect(sent[sent.length - 1]).toEqual(["send-keys", "Escape"]);
    expect(result.outcome).toBe("ok");
    expect(result.output).toContain("Total cost: $1.23");
  });

  it("/usage (dialog:true) — sends Escape after capture", async () => {
    const dialogOutput = `❯ /usage
  Usage: 45% of plan
  Resets: 2026-07-01`;
    const { result, sent } = await driveWithSentLog("/usage", dialogOutput);

    expect(sent[sent.length - 1]).toEqual(["send-keys", "Escape"]);
    expect(result.outcome).toBe("ok");
  });

  it("/hooks (dialog:true) — sends Escape after capture", async () => {
    const dialogOutput = `❯ /hooks
  PreToolUse: /path/to/hook.sh
  Stop: /path/to/stop.sh`;
    const { result, sent } = await driveWithSentLog("/hooks", dialogOutput);

    expect(sent[sent.length - 1]).toEqual(["send-keys", "Escape"]);
    expect(result.outcome).toBe("ok");
  });

  it("/clear (not dialog:true) — NO Escape is sent", async () => {
    // /clear has no dialog flag — the dismiss must not fire for it.
    const { sent } = await driveWithSentLog("/clear", "");
    const escapeSends = sent.filter((a) => a.includes("Escape"));
    expect(escapeSends).toHaveLength(0);
  });

  it("/compact (not dialog:true) — NO Escape is sent", async () => {
    const { sent } = await driveWithSentLog("/compact", "");
    const escapeSends = sent.filter((a) => a.includes("Escape"));
    expect(escapeSends).toHaveLength(0);
  });

  it("/status (dialog:true, empty capture) — Escape is still sent + ok_no_output", async () => {
    // Even when the dialog yields no parsed output (unusual but possible),
    // Escape must be sent so the pane isn't left wedged.
    const { result, sent } = await driveWithSentLog("/status", "");
    expect(sent[sent.length - 1]).toEqual(["send-keys", "Escape"]);
    expect(result.outcome).toBe("ok_no_output");
  });

  it("Escape send failure degrades gracefully — output still returned", async () => {
    // Simulate a tmux glitch on the dismiss send: the captured content
    // must still be returned even if the Escape send-keys throws.
    const dialogOutput = `❯ /status
   Settings   Status   Config   Usage   Stats
  Session: active`;
    let sendCount = 0;
    const runner: TmuxRunner = {
      hasSession: () => true,
      capture: (() => {
        let c = 0;
        return () => {
          c++;
          return c === 1 ? "" : dialogOutput;
        };
      })(),
      send: (_s, _n, args) => {
        sendCount++;
        // The third call is the Escape dismiss — make it throw.
        if (args[0] === "send-keys" && args[1] === "Escape") {
          throw new Error("tmux socket gone");
        }
      },
    };
    const result = await injectSlashCommandWith(runner, {
      socket: "test",
      session: "test",
      command: "/status",
      settleMs: 50,
      timeoutMs: 200,
    });
    // Output is captured despite the Escape failure.
    expect(result.outcome).toBe("ok");
    expect(result.output).toContain("Settings   Status   Config   Usage   Stats");
    // Not a failed outcome — the dismiss error is swallowed gracefully.
    expect(result.errorCode).toBeUndefined();
  });
});

describe("#2566 — /model and /memory allowlist treatment", () => {
  /**
   * Records every send-keys call so we can assert whether Escape fires.
   */
  async function driveRecording(
    command: string,
    paneAfter: string,
  ): Promise<{ result: Awaited<ReturnType<typeof injectSlashCommandWith>>; sent: string[][] }> {
    const sent: string[][] = [];
    let captures = 0;
    const runner: TmuxRunner = {
      hasSession: () => true,
      capture: () => {
        captures++;
        return captures === 1 ? "" : paneAfter;
      },
      send: (_s, _n, args) => {
        sent.push(args);
      },
    };
    const result = await injectSlashCommandWith(runner, {
      socket: "test",
      session: "test",
      command,
      settleMs: 50,
      timeoutMs: 200,
    });
    return { result, sent };
  }

  // /model must STAY on the allowlist — the `/model <name>` set path
  // (telegram-plugin/gateway/model-command.ts) depends on it, enforced by
  // model-command.test.ts "inject allowlist contract".
  it("/model is in INJECT_COMMANDS and NOT in INJECT_BLOCKED", () => {
    expect(INJECT_COMMANDS.has("/model")).toBe(true);
    expect(INJECT_BLOCKED.has("/model")).toBe(false);
  });

  it("/model has NO dialog flag (driver-managed, never opens a raw picker)", () => {
    expect(INJECT_COMMANDS.get("/model")?.dialog).toBeFalsy();
  });

  it("/model — NO Escape is sent (not a dialog command)", async () => {
    const { sent } = await driveRecording("/model", "❯ /model\n  some output");
    expect(sent.some((s) => s[s.length - 1] === "Escape")).toBe(false);
  });

  // /memory is raw-injected (no driver); it opens a picker on v2.1.185+, so
  // it rides the dialog:true Escape-dismiss path — kept usable, not blocked.
  it("/memory is in INJECT_COMMANDS with dialog:true and NOT blocklisted", () => {
    expect(INJECT_COMMANDS.has("/memory")).toBe(true);
    expect(INJECT_COMMANDS.get("/memory")?.dialog).toBe(true);
    expect(INJECT_BLOCKED.has("/memory")).toBe(false);
  });

  it("/memory — sends Escape AFTER capture to dismiss the picker", async () => {
    const dialogOutput = `❯ /memory
  Select a memory file to edit
  1. ./CLAUDE.md`;
    const { result, sent } = await driveRecording("/memory", dialogOutput);
    expect(sent[0]).toEqual(["send-keys", "-l", "/memory"]);
    expect(sent[1]).toEqual(["send-keys", "Enter"]);
    expect(sent[sent.length - 1]).toEqual(["send-keys", "Escape"]);
    expect(result.outcome).toBe("ok");
  });
});

// ─── #3116 — check-to-send race guard (precondition re-eval at write) ──────
describe("injectSlashCommandWith — precondition (#3116)", () => {
  it("precondition false → command is NEVER typed into the pane (outcome=skipped)", async () => {
    // The race: idle-clear decided /clear, but an inbound arrived before the
    // tmux write. The precondition re-reads the idle gate at write time and
    // returns false, so nothing is sent.
    const sent: string[][] = [];
    const runner = makeFake({
      hasSession: true,
      captures: ["before\n"],
      onSend: (args) => sent.push(args),
    });

    const r = await injectSlashCommandWith(runner, {
      socket: "switchroom-x",
      session: "x",
      command: "/clear",
      settleMs: 50,
      timeoutMs: 100,
      precondition: () => false,
    });

    // The load-bearing assertion — no keys were ever sent into the pane.
    // On current main (no precondition param) the write always fires and
    // `sent` would contain the send-keys calls → this FAILS, proving the bug.
    expect(sent).toEqual([]);
    expect(r.outcome).toBe("skipped");
    expect(r.errorCode).toBe("precondition_failed");
    expect(r.command).toBe("/clear");
  });

  it("precondition true → command IS sent (still-idle at write time)", async () => {
    const sent: string[][] = [];
    const runner = makeFake({
      hasSession: true,
      captures: ["before\n", "before\n"],
      onSend: (args) => sent.push(args),
    });

    const r = await injectSlashCommandWith(runner, {
      socket: "switchroom-x",
      session: "x",
      command: "/clear",
      settleMs: 20,
      timeoutMs: 60,
      precondition: () => true,
    });

    expect(sent[0]).toEqual(["send-keys", "-l", "/clear"]);
    expect(sent[1]).toEqual(["send-keys", "Enter"]);
    // /clear renders no output → ok_no_output, but it WAS dispatched.
    expect(r.outcome).toBe("ok_no_output");
  });

  it("no precondition → unchanged behaviour (always sends)", async () => {
    const sent: string[][] = [];
    const runner = makeFake({
      hasSession: true,
      captures: ["before\n", "before\n"],
      onSend: (args) => sent.push(args),
    });

    await injectSlashCommandWith(runner, {
      socket: "switchroom-x",
      session: "x",
      command: "/clear",
      settleMs: 20,
      timeoutMs: 60,
    });

    expect(sent[0]).toEqual(["send-keys", "-l", "/clear"]);
  });

  it("precondition is evaluated BEFORE has-session pane capture, once", async () => {
    // The precondition must gate the write, and must not be re-invoked per poll.
    let calls = 0;
    const runner = makeFake({
      hasSession: true,
      captures: ["before\n", "before\n"],
    });
    await injectSlashCommandWith(runner, {
      socket: "switchroom-x",
      session: "x",
      command: "/clear",
      settleMs: 20,
      timeoutMs: 60,
      precondition: () => {
        calls += 1;
        return true;
      },
    });
    expect(calls).toBe(1);
  });
});
