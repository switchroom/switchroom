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
  injectSlashCommand,
  injectSlashCommandWith,
  validateInjectCommand,
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

  it("/clear has expectsOutput=false and no silentNote", () => {
    const meta = INJECT_COMMANDS.get("/clear");
    expect(meta?.expectsOutput).toBe(false);
    expect(meta?.silentNote).toBeUndefined();
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
