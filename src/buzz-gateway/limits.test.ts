import { describe, it, expect } from "vitest";
import {
  byteLength,
  splitByBytes,
  isFrameWithinBudget,
  BUZZ_MAX_FRAME_BYTES,
} from "./limits.js";

describe("byteLength — UTF-8 bytes, not UTF-16 code units", () => {
  it("counts ASCII as one byte each", () => {
    expect(byteLength("hello")).toBe(5);
  });
  it("counts a multi-byte code point by its UTF-8 length", () => {
    expect(byteLength("é")).toBe(2); // U+00E9 → 2 bytes
    expect(byteLength("€")).toBe(3); // U+20AC → 3 bytes
    expect(byteLength("😀")).toBe(4); // astral → 4 bytes
  });
});

describe("splitByBytes — code-point-safe chunking (S5)", () => {
  it("returns a single chunk when already within budget", () => {
    expect(splitByBytes("short", 100)).toEqual(["short"]);
  });

  it("returns [''] for empty input so a caller always has one event", () => {
    expect(splitByBytes("", 100)).toEqual([""]);
  });

  it("splits an over-budget ASCII string into ≤maxBytes chunks", () => {
    const chunks = splitByBytes("abcdefghij", 4);
    expect(chunks).toEqual(["abcd", "efgh", "ij"]);
    for (const c of chunks) expect(byteLength(c)).toBeLessThanOrEqual(4);
  });

  it("NEVER severs a multi-byte code point across a chunk boundary", () => {
    // Four 4-byte emoji, budget 4 → each emoji is its own chunk, never halved.
    const chunks = splitByBytes("😀😀😀😀", 4);
    expect(chunks).toEqual(["😀", "😀", "😀", "😀"]);
    for (const c of chunks) expect(byteLength(c)).toBeLessThanOrEqual(4);
    // Rejoining reproduces the original exactly (no lost/mangled bytes).
    expect(chunks.join("")).toBe("😀😀😀😀");
  });

  it("keeps a code point whole even when it does not fit the current chunk", () => {
    // 'a' (1 byte) then '€' (3 bytes), budget 3: 'a' fills 1, '€' would overflow
    // to 4 → '€' starts a fresh chunk rather than being cut.
    const chunks = splitByBytes("a€", 3);
    expect(chunks).toEqual(["a", "€"]);
  });

  it("a maxBytes ≤ 0 disables splitting (returns the whole string)", () => {
    expect(splitByBytes("abcdef", 0)).toEqual(["abcdef"]);
  });
});

describe("isFrameWithinBudget — per-frame wire check (S5)", () => {
  it("accepts a small frame", () => {
    expect(isFrameWithinBudget(["EVENT", { id: "x", content: "hi" }])).toBe(true);
  });

  it("rejects a frame whose serialized JSON exceeds the budget", () => {
    const huge = { id: "x", content: "y".repeat(BUZZ_MAX_FRAME_BYTES) };
    expect(isFrameWithinBudget(["EVENT", huge])).toBe(false);
  });

  it("measures the SERIALIZED frame in bytes (multi-byte content counts double)", () => {
    // A content of exactly maxBytes ASCII already overflows once wrapped in the
    // ["EVENT", …] envelope, so the envelope overhead is counted, not ignored.
    const content = "z".repeat(BUZZ_MAX_FRAME_BYTES);
    expect(isFrameWithinBudget(["EVENT", { content }])).toBe(false);
  });
});
