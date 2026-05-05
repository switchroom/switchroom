/**
 * Tests for the #725 Phase 2 inject primitive.
 *
 * The real tmux process is faked via the TmuxRunner test seam — these
 * tests assert the validation rules, the session-existence check, the
 * pane-diff logic, and the basic happy-path output capture.
 *
 * Run: npx vitest run src/agents/inject.test.ts
 */

import { describe, it, expect } from "vitest";
import {
  INJECT_ALLOWLIST,
  INJECT_BLOCKLIST,
  InjectError,
  diffPane,
  injectSlashCommand,
  injectSlashCommandWith,
  validateInjectCommand,
} from "./inject.js";

describe("validateInjectCommand", () => {
  it("accepts every command in the allowlist", () => {
    for (const cmd of INJECT_ALLOWLIST) {
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
    for (const cmd of INJECT_BLOCKLIST) {
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

describe("diffPane", () => {
  it("returns lines in after that aren't in before", () => {
    const before = "line one\nline two\n";
    const after = "line one\nline two\nline three\n";
    expect(diffPane(before, after)).toBe("line three");
  });

  it("ignores empty lines", () => {
    const before = "a\nb\n";
    const after = "\n\na\nb\nc\n\n";
    expect(diffPane(before, after)).toBe("c");
  });

  it("returns empty string when nothing new", () => {
    expect(diffPane("a\nb", "a\nb")).toBe("");
  });
});

// ─── injectSlashCommandWith — happy path + error paths via fake runner ─────

interface FakeRunner {
  hasSession: (s: string, n: string) => boolean;
  capture: (s: string, n: string) => string | null;
  send: (s: string, n: string, args: string[]) => void;
}

function makeFake(opts: {
  hasSession?: boolean;
  captures?: string[]; // sequence returned in order
  onSend?: (args: string[]) => void;
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
      opts.onSend?.(args);
    },
  };
}

describe("injectSlashCommandWith", () => {
  it("throws session_missing when has-session returns false", async () => {
    const runner = makeFake({ hasSession: false });
    await expect(
      injectSlashCommandWith(runner, {
        socket: "switchroom-x",
        session: "x",
        command: "/cost",
        settleMs: 50,
        timeoutMs: 100,
      }),
    ).rejects.toMatchObject({ code: "session_missing" });
  });

  it("captures diff between before and after pane snapshots", async () => {
    const before = "$ \n";
    const after = "$ /cost\n\nTotal cost: $0.42\n$ \n";
    const runner = makeFake({
      hasSession: true,
      // returns: 1) before-snapshot, 2..) after-snapshots (stable)
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
    expect(result.output).toContain("Total cost: $0.42");
    expect(result.truncated).toBe(false);
  });

  it("flags truncated when output exceeds 3000 bytes", async () => {
    const before = "";
    const big = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(40)}`).join("\n");
    const runner = makeFake({
      hasSession: true,
      captures: [before, big, big, big, big],
    });
    const result = await injectSlashCommandWith(runner, {
      socket: "switchroom-x",
      session: "x",
      command: "/cost",
      settleMs: 50,
      timeoutMs: 1000,
    });
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.output, "utf-8")).toBeLessThanOrEqual(3000);
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
