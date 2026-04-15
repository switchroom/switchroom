import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readActivePins,
  writeActivePins,
  addActivePin,
  removeActivePin,
  clearActivePins,
  ACTIVE_PINS_FILENAME,
  type ActivePin,
} from "../active-pins.js";

describe("active-pins sidecar", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "active-pins-"));
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

  describe("readActivePins", () => {
    it("returns [] when the file is missing", () => {
      expect(readActivePins(tmp)).toEqual([]);
    });

    it("returns [] when the file is empty", () => {
      writeFileSync(join(tmp, ACTIVE_PINS_FILENAME), "");
      expect(readActivePins(tmp)).toEqual([]);
    });

    it("returns [] when the file is not valid JSON", () => {
      writeFileSync(join(tmp, ACTIVE_PINS_FILENAME), "{not json");
      expect(readActivePins(tmp)).toEqual([]);
    });

    it("returns [] when the JSON root is not an array", () => {
      writeFileSync(join(tmp, ACTIVE_PINS_FILENAME), '{"oops": true}');
      expect(readActivePins(tmp)).toEqual([]);
    });

    it("round-trips valid pin entries", () => {
      const pin = makePin();
      writeFileSync(join(tmp, ACTIVE_PINS_FILENAME), JSON.stringify([pin]));
      expect(readActivePins(tmp)).toEqual([pin]);
    });

    it("drops entries with missing or wrong-typed fields", () => {
      const good = makePin({ messageId: 7 });
      const bad = [
        good,
        { chatId: "x", messageId: "not-a-number", turnKey: "k", pinnedAt: 1 },
        { chatId: "y", messageId: 1, turnKey: "k" }, // missing pinnedAt
        null,
        "nope",
      ];
      writeFileSync(join(tmp, ACTIVE_PINS_FILENAME), JSON.stringify(bad));
      expect(readActivePins(tmp)).toEqual([good]);
    });
  });

  describe("writeActivePins", () => {
    it("creates the sidecar with JSON content", () => {
      const pins = [makePin(), makePin({ messageId: 43, turnKey: "100:0:2" })];
      writeActivePins(tmp, pins);
      const raw = readFileSync(join(tmp, ACTIVE_PINS_FILENAME), "utf-8");
      expect(JSON.parse(raw)).toEqual(pins);
    });

    it("deletes the sidecar when writing an empty list", () => {
      writeFileSync(join(tmp, ACTIVE_PINS_FILENAME), JSON.stringify([makePin()]));
      writeActivePins(tmp, []);
      expect(existsSync(join(tmp, ACTIVE_PINS_FILENAME))).toBe(false);
    });

    it("is idempotent — deleting an already-missing file is a no-op", () => {
      writeActivePins(tmp, []);
      expect(existsSync(join(tmp, ACTIVE_PINS_FILENAME))).toBe(false);
    });
  });

  describe("addActivePin", () => {
    it("creates the sidecar on first add", () => {
      addActivePin(tmp, makePin());
      expect(readActivePins(tmp)).toHaveLength(1);
    });

    it("appends distinct pins", () => {
      addActivePin(tmp, makePin({ messageId: 1, turnKey: "a" }));
      addActivePin(tmp, makePin({ messageId: 2, turnKey: "b" }));
      const pins = readActivePins(tmp);
      expect(pins).toHaveLength(2);
      expect(pins.map((p) => p.messageId).sort()).toEqual([1, 2]);
    });

    it("replaces an existing entry with the same (chatId, messageId)", () => {
      addActivePin(tmp, makePin({ pinnedAt: 100 }));
      addActivePin(tmp, makePin({ pinnedAt: 200 }));
      const pins = readActivePins(tmp);
      expect(pins).toHaveLength(1);
      expect(pins[0].pinnedAt).toBe(200);
    });

    it("treats different chatIds as distinct even with matching messageIds", () => {
      addActivePin(tmp, makePin({ chatId: "A", messageId: 1 }));
      addActivePin(tmp, makePin({ chatId: "B", messageId: 1 }));
      expect(readActivePins(tmp)).toHaveLength(2);
    });
  });

  describe("removeActivePin", () => {
    it("removes the matching entry", () => {
      addActivePin(tmp, makePin({ messageId: 1, turnKey: "a" }));
      addActivePin(tmp, makePin({ messageId: 2, turnKey: "b" }));
      removeActivePin(tmp, "100", 1);
      const pins = readActivePins(tmp);
      expect(pins).toHaveLength(1);
      expect(pins[0].messageId).toBe(2);
    });

    it("deletes the sidecar when the last entry is removed", () => {
      addActivePin(tmp, makePin());
      removeActivePin(tmp, "100", 42);
      expect(existsSync(join(tmp, ACTIVE_PINS_FILENAME))).toBe(false);
    });

    it("is a no-op when the file is missing", () => {
      removeActivePin(tmp, "100", 42);
      expect(readActivePins(tmp)).toEqual([]);
    });

    it("is a no-op when no entry matches", () => {
      addActivePin(tmp, makePin({ messageId: 1 }));
      removeActivePin(tmp, "100", 999);
      expect(readActivePins(tmp)).toHaveLength(1);
    });

    it("only matches on (chatId, messageId) — turnKey/pinnedAt are ignored", () => {
      addActivePin(tmp, makePin({ chatId: "A", messageId: 1, turnKey: "x" }));
      removeActivePin(tmp, "A", 1);
      expect(readActivePins(tmp)).toEqual([]);
    });
  });

  describe("clearActivePins", () => {
    it("deletes the sidecar outright", () => {
      addActivePin(tmp, makePin());
      addActivePin(tmp, makePin({ messageId: 43, turnKey: "b" }));
      clearActivePins(tmp);
      expect(existsSync(join(tmp, ACTIVE_PINS_FILENAME))).toBe(false);
    });

    it("is a no-op when the file is missing", () => {
      clearActivePins(tmp);
      expect(existsSync(join(tmp, ACTIVE_PINS_FILENAME))).toBe(false);
    });
  });

  describe("crash → restart simulation", () => {
    it("sidecar survives to be read by a fresh process", () => {
      addActivePin(tmp, makePin({ chatId: "C1", messageId: 10, turnKey: "C1:0:1" }));
      addActivePin(tmp, makePin({ chatId: "C2", messageId: 20, turnKey: "C2:0:1" }));
      // simulated restart — only thing a fresh process has is agentDir
      const recovered = readActivePins(tmp);
      expect(recovered).toHaveLength(2);
      expect(recovered.map((p) => `${p.chatId}/${p.messageId}`).sort()).toEqual([
        "C1/10",
        "C2/20",
      ]);
      // sweep: unpin each then clear
      clearActivePins(tmp);
      expect(readActivePins(tmp)).toEqual([]);
    });
  });
});
