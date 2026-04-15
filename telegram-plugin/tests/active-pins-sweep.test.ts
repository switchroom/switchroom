/**
 * Tests for sweepActivePins — the shared helper called by both the
 * startup failsafe and the /restart, /reconcile --restart, and /update
 * command handlers to unpin any still-pinned progress cards and clear
 * the sidecar.
 *
 * The real unpin path goes through `lockedBot.api.unpinChatMessage`.
 * These tests inject a fake unpin callback so behavior is verified
 * without a Telegram stub — the shape under test is:
 *
 *   1. Reads the sidecar
 *   2. Calls unpinFn(chatId, messageId) for each entry
 *   3. Swallows unpin errors (best-effort — the message may already be
 *      gone, or the bot may have lost admin rights)
 *   4. Clears the sidecar regardless of success/failure
 *   5. Bounded by timeoutMs so a hung Telegram API can't block a
 *      restart indefinitely
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addActivePin, readActivePins, ACTIVE_PINS_FILENAME, type ActivePin } from "../active-pins.js";
import {
  sweepActivePins,
  sweepBotAuthoredPins,
  type PinnedMessageInfo,
} from "../active-pins-sweep.js";

describe("sweepActivePins", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "active-pins-sweep-"));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  const makePin = (overrides: Partial<ActivePin> = {}): ActivePin => ({
    chatId: "100",
    messageId: 42,
    turnKey: "100:0:1",
    pinnedAt: 1_700_000_000_000,
    ...overrides,
  });

  it("is a no-op when the sidecar is empty", async () => {
    const calls: Array<[string, number]> = [];
    const result = await sweepActivePins(tmp, async (chatId, messageId) => {
      calls.push([chatId, messageId]);
    });
    expect(calls).toEqual([]);
    expect(result.swept).toEqual([]);
    expect(result.timedOut).toBe(false);
  });

  it("calls unpin for each sidecar entry and clears the file", async () => {
    addActivePin(tmp, makePin({ chatId: "A", messageId: 1, turnKey: "A:0:1" }));
    addActivePin(tmp, makePin({ chatId: "B", messageId: 2, turnKey: "B:0:1" }));
    addActivePin(tmp, makePin({ chatId: "A", messageId: 3, turnKey: "A:0:2" }));

    const calls: Array<[string, number]> = [];
    const result = await sweepActivePins(tmp, async (chatId, messageId) => {
      calls.push([chatId, messageId]);
    });

    expect(calls.sort()).toEqual([
      ["A", 1],
      ["A", 3],
      ["B", 2],
    ]);
    expect(result.swept).toHaveLength(3);
    expect(existsSync(join(tmp, ACTIVE_PINS_FILENAME))).toBe(false);
    expect(readActivePins(tmp)).toEqual([]);
  });

  it("still clears the sidecar when unpin throws for every entry", async () => {
    addActivePin(tmp, makePin({ chatId: "A", messageId: 1 }));
    addActivePin(tmp, makePin({ chatId: "B", messageId: 2, turnKey: "B:0:1" }));

    const errors: string[] = [];
    await sweepActivePins(
      tmp,
      async () => {
        throw new Error("message to unpin not found");
      },
      { log: (msg) => errors.push(msg) },
    );

    expect(existsSync(join(tmp, ACTIVE_PINS_FILENAME))).toBe(false);
    expect(readActivePins(tmp)).toEqual([]);
    // Each failure is logged — log receives one "sweeping N" line plus
    // one "unpin failed" line per entry.
    expect(errors.some((e) => e.includes("sweeping 2"))).toBe(true);
    expect(errors.filter((e) => e.includes("unpin failed"))).toHaveLength(2);
  });

  it("tolerates a mix of successful and failing unpins", async () => {
    addActivePin(tmp, makePin({ chatId: "A", messageId: 1 }));
    addActivePin(tmp, makePin({ chatId: "A", messageId: 2, turnKey: "A:0:2" }));

    const unpinned: Array<[string, number]> = [];
    await sweepActivePins(tmp, async (chatId, messageId) => {
      if (messageId === 2) throw new Error("nope");
      unpinned.push([chatId, messageId]);
    });

    expect(unpinned).toEqual([["A", 1]]);
    expect(existsSync(join(tmp, ACTIVE_PINS_FILENAME))).toBe(false);
  });

  it("returns after timeoutMs even if unpin never resolves", async () => {
    addActivePin(tmp, makePin({ chatId: "A", messageId: 1 }));

    const start = Date.now();
    const result = await sweepActivePins(
      tmp,
      () => new Promise(() => { /* never resolves */ }),
      { timeoutMs: 50 },
    );
    const elapsed = Date.now() - start;

    expect(result.timedOut).toBe(true);
    expect(elapsed).toBeLessThan(500);
    // Sidecar is cleared even though the unpin never landed — stale
    // entries get retried from Telegram's side on next boot but we
    // don't want the sweep to keep re-firing them forever.
    expect(existsSync(join(tmp, ACTIVE_PINS_FILENAME))).toBe(false);
  });

  it("passes the caller-provided log hook", async () => {
    addActivePin(tmp, makePin({ chatId: "A", messageId: 1 }));
    const lines: string[] = [];
    await sweepActivePins(
      tmp,
      async () => { /* succeed silently */ },
      { log: (msg) => lines.push(msg) },
    );
    expect(lines).toContain("sweeping 1 active pin(s)");
  });
});

describe("sweepBotAuthoredPins", () => {
  const BOT_ID = 1000;

  /**
   * Build a fake getTopPin backed by a map of { chatId: queue }.
   * Each unpin pops the head of the queue — which mimics Telegram's
   * "unpinning the top reveals the next most recent pin" behavior.
   */
  function fakeChats(
    state: Record<string, Array<{ messageId: number; fromId: number | null }>>,
  ) {
    const getTopPin = async (chatId: string): Promise<PinnedMessageInfo | null> => {
      const q = state[chatId] ?? [];
      return q.length === 0 ? null : { ...q[0] };
    };
    const unpinCalls: Array<[string, number]> = [];
    const unpin = async (chatId: string, messageId: number): Promise<void> => {
      unpinCalls.push([chatId, messageId]);
      const q = state[chatId] ?? [];
      if (q[0]?.messageId === messageId) q.shift();
    };
    return { getTopPin, unpin, unpinCalls };
  }

  it("is a no-op when no chats are provided", async () => {
    const { getTopPin, unpin, unpinCalls } = fakeChats({});
    const result = await sweepBotAuthoredPins([], BOT_ID, getTopPin, unpin);
    expect(unpinCalls).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.perChat).toEqual({});
  });

  it("is a no-op when a chat has no pinned message", async () => {
    const { getTopPin, unpin, unpinCalls } = fakeChats({ A: [] });
    const result = await sweepBotAuthoredPins(["A"], BOT_ID, getTopPin, unpin);
    expect(unpinCalls).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("unpins consecutive bot-authored pins until a foreign pin is reached", async () => {
    const { getTopPin, unpin, unpinCalls } = fakeChats({
      A: [
        { messageId: 10, fromId: BOT_ID },
        { messageId: 9, fromId: BOT_ID },
        { messageId: 8, fromId: 42 }, // user pin — barrier
        { messageId: 7, fromId: BOT_ID }, // would be unpinned if barrier weren't there
      ],
    });
    const result = await sweepBotAuthoredPins(["A"], BOT_ID, getTopPin, unpin);
    expect(unpinCalls).toEqual([
      ["A", 10],
      ["A", 9],
    ]);
    expect(result.total).toBe(2);
    expect(result.perChat).toEqual({ A: 2 });
  });

  it("stops immediately when the top pin belongs to someone else", async () => {
    const { getTopPin, unpin, unpinCalls } = fakeChats({
      A: [
        { messageId: 5, fromId: 999 },
        { messageId: 4, fromId: BOT_ID },
      ],
    });
    const result = await sweepBotAuthoredPins(["A"], BOT_ID, getTopPin, unpin);
    expect(unpinCalls).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("treats pins with no from.id as foreign (anonymous channel post)", async () => {
    const { getTopPin, unpin, unpinCalls } = fakeChats({
      A: [
        { messageId: 5, fromId: null },
        { messageId: 4, fromId: BOT_ID },
      ],
    });
    const result = await sweepBotAuthoredPins(["A"], BOT_ID, getTopPin, unpin);
    expect(unpinCalls).toEqual([]);
    expect(result.total).toBe(0);
  });

  it("iterates across multiple chats independently", async () => {
    const { getTopPin, unpin, unpinCalls } = fakeChats({
      A: [
        { messageId: 1, fromId: BOT_ID },
        { messageId: 2, fromId: BOT_ID },
      ],
      B: [{ messageId: 3, fromId: 777 }],
      C: [{ messageId: 4, fromId: BOT_ID }],
    });
    const result = await sweepBotAuthoredPins(
      ["A", "B", "C"],
      BOT_ID,
      getTopPin,
      unpin,
    );
    expect(unpinCalls).toEqual([
      ["A", 1],
      ["A", 2],
      ["C", 4],
    ]);
    expect(result.total).toBe(3);
    expect(result.perChat).toEqual({ A: 2, C: 1 });
  });

  it("advances to the next chat when getTopPin throws", async () => {
    const unpinCalls: Array<[string, number]> = [];
    const errors: string[] = [];
    const result = await sweepBotAuthoredPins(
      ["A", "B"],
      BOT_ID,
      async (chatId) => {
        if (chatId === "A") throw new Error("boom");
        return { messageId: 7, fromId: BOT_ID };
      },
      async (chatId, messageId) => {
        unpinCalls.push([chatId, messageId]);
        // Simulate "pin is gone after unpin" so the B loop terminates
        throw new Error("already gone");
      },
      { log: (msg) => errors.push(msg) },
    );
    // A errored on getChat; B attempted one unpin (which threw) then stopped
    expect(unpinCalls).toEqual([["B", 7]]);
    expect(result.total).toBe(0);
    expect(errors.some((e) => e.includes("getChat failed for A"))).toBe(true);
    expect(errors.some((e) => e.includes("unpin failed for B/7"))).toBe(true);
  });

  it("breaks out of a chat on unpin failure to avoid infinite loops", async () => {
    const calls: Array<[string, number]> = [];
    const result = await sweepBotAuthoredPins(
      ["A"],
      BOT_ID,
      async () => ({ messageId: 1, fromId: BOT_ID }),
      async (chatId, messageId) => {
        calls.push([chatId, messageId]);
        throw new Error("permission denied");
      },
    );
    // Without the break, the fake getTopPin would keep returning the same
    // pin and we'd loop until maxPerChat. With the break, we see exactly
    // one call and the sweep moves on.
    expect(calls).toEqual([["A", 1]]);
    expect(result.total).toBe(0);
  });

  it("is bounded by maxPerChat when pins keep re-appearing", async () => {
    // A pathological case: getTopPin always returns a bot-authored pin,
    // and unpin silently "succeeds" without removing it. Without the
    // maxPerChat bound the loop would be infinite.
    let calls = 0;
    await sweepBotAuthoredPins(
      ["A"],
      BOT_ID,
      async () => ({ messageId: 1, fromId: BOT_ID }),
      async () => {
        calls++;
      },
      { maxPerChat: 5 },
    );
    expect(calls).toBe(5);
  });
});
