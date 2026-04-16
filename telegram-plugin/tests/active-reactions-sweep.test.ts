import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addActiveReaction, readActiveReactions, ACTIVE_REACTIONS_FILENAME, type ActiveReaction } from "../active-reactions.js";
import { sweepActiveReactions } from "../active-reactions-sweep.js";

describe("sweepActiveReactions", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "active-reactions-sweep-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const makeReaction = (overrides: Partial<ActiveReaction> = {}): ActiveReaction => ({
    chatId: "100",
    messageId: 42,
    threadId: null,
    reactedAt: 1_700_000_000_000,
    ...overrides,
  });

  it("is a no-op when the sidecar is empty", async () => {
    const calls: Array<[string, number]> = [];
    const result = await sweepActiveReactions(tmp, async (chatId, messageId) => {
      calls.push([chatId, messageId]);
    });
    expect(calls).toEqual([]);
    expect(result.swept).toEqual([]);
    expect(result.timedOut).toBe(false);
  });

  it("calls setDone for each sidecar entry and clears the file", async () => {
    addActiveReaction(tmp, makeReaction({ chatId: "A", messageId: 1 }));
    addActiveReaction(tmp, makeReaction({ chatId: "B", messageId: 2, threadId: 5 }));
    addActiveReaction(tmp, makeReaction({ chatId: "A", messageId: 3 }));

    const calls: Array<[string, number]> = [];
    const result = await sweepActiveReactions(tmp, async (chatId, messageId) => {
      calls.push([chatId, messageId]);
    });

    expect(calls.sort()).toEqual([
      ["A", 1],
      ["A", 3],
      ["B", 2],
    ]);
    expect(result.swept).toHaveLength(3);
    expect(existsSync(join(tmp, ACTIVE_REACTIONS_FILENAME))).toBe(false);
    expect(readActiveReactions(tmp)).toEqual([]);
  });

  it("still clears the sidecar when setDone throws for every entry", async () => {
    addActiveReaction(tmp, makeReaction({ chatId: "A", messageId: 1 }));
    addActiveReaction(tmp, makeReaction({ chatId: "B", messageId: 2 }));

    const errors: string[] = [];
    await sweepActiveReactions(
      tmp,
      async () => {
        throw new Error("Bad Request: message not found");
      },
      { log: (msg) => errors.push(msg) },
    );

    expect(existsSync(join(tmp, ACTIVE_REACTIONS_FILENAME))).toBe(false);
    expect(readActiveReactions(tmp)).toEqual([]);
    expect(errors.some((e) => e.includes("sweeping 2"))).toBe(true);
    expect(errors.filter((e) => e.includes("reaction sweep failed"))).toHaveLength(2);
  });

  it("tolerates a mix of successful and failing setDone calls", async () => {
    addActiveReaction(tmp, makeReaction({ chatId: "A", messageId: 1 }));
    addActiveReaction(tmp, makeReaction({ chatId: "A", messageId: 2 }));

    const resolved: Array<[string, number]> = [];
    await sweepActiveReactions(tmp, async (chatId, messageId) => {
      if (messageId === 2) throw new Error("nope");
      resolved.push([chatId, messageId]);
    });

    expect(resolved).toEqual([["A", 1]]);
    expect(existsSync(join(tmp, ACTIVE_REACTIONS_FILENAME))).toBe(false);
  });

  it("returns after timeoutMs even if setDone never resolves", async () => {
    addActiveReaction(tmp, makeReaction({ chatId: "A", messageId: 1 }));

    const start = Date.now();
    const result = await sweepActiveReactions(
      tmp,
      () => new Promise(() => { /* never resolves */ }),
      { timeoutMs: 50 },
    );
    const elapsed = Date.now() - start;

    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(500);
    expect(existsSync(join(tmp, ACTIVE_REACTIONS_FILENAME))).toBe(false);
  });

  it("passes the caller-provided log hook", async () => {
    addActiveReaction(tmp, makeReaction({ chatId: "A", messageId: 1 }));
    const lines: string[] = [];
    await sweepActiveReactions(
      tmp,
      async () => { /* succeed silently */ },
      { log: (msg) => lines.push(msg) },
    );
    expect(lines).toContain("sweeping 1 stale reaction(s)");
  });
});
