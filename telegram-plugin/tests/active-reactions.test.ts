import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readActiveReactions,
  writeActiveReactions,
  addActiveReaction,
  removeActiveReaction,
  clearActiveReactions,
  ACTIVE_REACTIONS_FILENAME,
  type ActiveReaction,
} from "../active-reactions.js";

describe("active-reactions sidecar", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "active-reactions-"));
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

  describe("readActiveReactions", () => {
    it("returns [] when the file is missing", () => {
      expect(readActiveReactions(tmp)).toEqual([]);
    });

    it("returns [] when the file is empty", () => {
      writeFileSync(join(tmp, ACTIVE_REACTIONS_FILENAME), "");
      expect(readActiveReactions(tmp)).toEqual([]);
    });

    it("returns [] when the file is not valid JSON", () => {
      writeFileSync(join(tmp, ACTIVE_REACTIONS_FILENAME), "{not json");
      expect(readActiveReactions(tmp)).toEqual([]);
    });

    it("returns [] when the JSON root is not an array", () => {
      writeFileSync(join(tmp, ACTIVE_REACTIONS_FILENAME), '{"oops": true}');
      expect(readActiveReactions(tmp)).toEqual([]);
    });

    it("round-trips valid reaction entries", () => {
      const r = makeReaction();
      writeFileSync(join(tmp, ACTIVE_REACTIONS_FILENAME), JSON.stringify([r]));
      expect(readActiveReactions(tmp)).toEqual([r]);
    });

    it("accepts entries with threadId: null", () => {
      const r = makeReaction({ threadId: null });
      writeFileSync(join(tmp, ACTIVE_REACTIONS_FILENAME), JSON.stringify([r]));
      expect(readActiveReactions(tmp)).toEqual([r]);
    });

    it("accepts entries with numeric threadId", () => {
      const r = makeReaction({ threadId: 789 });
      writeFileSync(join(tmp, ACTIVE_REACTIONS_FILENAME), JSON.stringify([r]));
      expect(readActiveReactions(tmp)).toEqual([r]);
    });

    it("drops entries with missing or wrong-typed fields", () => {
      const good = makeReaction({ messageId: 7 });
      const bad = [
        good,
        { chatId: "x", messageId: "not-a-number", threadId: null, reactedAt: 1 },
        { chatId: "y", messageId: 1, threadId: null }, // missing reactedAt
        { chatId: "z", messageId: 1, threadId: "bad", reactedAt: 1 }, // threadId wrong type
        null,
        "nope",
      ];
      writeFileSync(join(tmp, ACTIVE_REACTIONS_FILENAME), JSON.stringify(bad));
      expect(readActiveReactions(tmp)).toEqual([good]);
    });
  });

  describe("writeActiveReactions", () => {
    it("creates the sidecar with JSON content", () => {
      const reactions = [makeReaction(), makeReaction({ messageId: 43 })];
      writeActiveReactions(tmp, reactions);
      const raw = readFileSync(join(tmp, ACTIVE_REACTIONS_FILENAME), "utf-8");
      expect(JSON.parse(raw)).toEqual(reactions);
    });

    it("deletes the sidecar when writing an empty list", () => {
      writeFileSync(join(tmp, ACTIVE_REACTIONS_FILENAME), JSON.stringify([makeReaction()]));
      writeActiveReactions(tmp, []);
      expect(existsSync(join(tmp, ACTIVE_REACTIONS_FILENAME))).toBe(false);
    });

    it("is idempotent — deleting an already-missing file is a no-op", () => {
      writeActiveReactions(tmp, []);
      expect(existsSync(join(tmp, ACTIVE_REACTIONS_FILENAME))).toBe(false);
    });
  });

  describe("addActiveReaction", () => {
    it("creates the sidecar on first add", () => {
      addActiveReaction(tmp, makeReaction());
      expect(readActiveReactions(tmp)).toHaveLength(1);
    });

    it("appends distinct reactions", () => {
      addActiveReaction(tmp, makeReaction({ messageId: 1 }));
      addActiveReaction(tmp, makeReaction({ messageId: 2 }));
      const reactions = readActiveReactions(tmp);
      expect(reactions).toHaveLength(2);
      expect(reactions.map((r) => r.messageId).sort()).toEqual([1, 2]);
    });

    it("replaces an existing entry with the same (chatId, messageId)", () => {
      addActiveReaction(tmp, makeReaction({ reactedAt: 100 }));
      addActiveReaction(tmp, makeReaction({ reactedAt: 200 }));
      const reactions = readActiveReactions(tmp);
      expect(reactions).toHaveLength(1);
      expect(reactions[0].reactedAt).toBe(200);
    });

    it("treats different chatIds as distinct even with matching messageIds", () => {
      addActiveReaction(tmp, makeReaction({ chatId: "A", messageId: 1 }));
      addActiveReaction(tmp, makeReaction({ chatId: "B", messageId: 1 }));
      expect(readActiveReactions(tmp)).toHaveLength(2);
    });
  });

  describe("removeActiveReaction", () => {
    it("removes the matching entry", () => {
      addActiveReaction(tmp, makeReaction({ messageId: 1 }));
      addActiveReaction(tmp, makeReaction({ messageId: 2 }));
      removeActiveReaction(tmp, "100", 1);
      const reactions = readActiveReactions(tmp);
      expect(reactions).toHaveLength(1);
      expect(reactions[0].messageId).toBe(2);
    });

    it("deletes the sidecar when the last entry is removed", () => {
      addActiveReaction(tmp, makeReaction());
      removeActiveReaction(tmp, "100", 42);
      expect(existsSync(join(tmp, ACTIVE_REACTIONS_FILENAME))).toBe(false);
    });

    it("is a no-op when the file is missing", () => {
      removeActiveReaction(tmp, "100", 42);
      expect(readActiveReactions(tmp)).toEqual([]);
    });

    it("is a no-op when no entry matches", () => {
      addActiveReaction(tmp, makeReaction({ messageId: 1 }));
      removeActiveReaction(tmp, "100", 999);
      expect(readActiveReactions(tmp)).toHaveLength(1);
    });

    it("only matches on (chatId, messageId) — threadId/reactedAt are ignored", () => {
      addActiveReaction(tmp, makeReaction({ chatId: "A", messageId: 1, threadId: 5 }));
      removeActiveReaction(tmp, "A", 1);
      expect(readActiveReactions(tmp)).toEqual([]);
    });
  });

  describe("clearActiveReactions", () => {
    it("deletes the sidecar outright", () => {
      addActiveReaction(tmp, makeReaction());
      addActiveReaction(tmp, makeReaction({ messageId: 43 }));
      clearActiveReactions(tmp);
      expect(existsSync(join(tmp, ACTIVE_REACTIONS_FILENAME))).toBe(false);
    });

    it("is a no-op when the file is missing", () => {
      clearActiveReactions(tmp);
      expect(existsSync(join(tmp, ACTIVE_REACTIONS_FILENAME))).toBe(false);
    });
  });

  describe("crash → restart simulation", () => {
    it("sidecar survives to be read by a fresh process", () => {
      addActiveReaction(tmp, makeReaction({ chatId: "C1", messageId: 10, threadId: null }));
      addActiveReaction(tmp, makeReaction({ chatId: "C2", messageId: 20, threadId: 5 }));
      const recovered = readActiveReactions(tmp);
      expect(recovered).toHaveLength(2);
      expect(recovered.map((r) => `${r.chatId}/${r.messageId}`).sort()).toEqual([
        "C1/10",
        "C2/20",
      ]);
      clearActiveReactions(tmp);
      expect(readActiveReactions(tmp)).toEqual([]);
    });
  });
});
