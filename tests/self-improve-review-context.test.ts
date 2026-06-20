import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  writeReviewContext,
  readReviewContext,
  reviewIsPending,
  clearReviewContext,
  hasFiredForSession,
  markFiredForSession,
  REVIEW_CONTEXT_FILE,
  type ReviewContext,
} from "../src/self-improve/review-context.js";

let stateDir: string;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "self-improve-ctx-"));
});
afterEach(() => {
  if (stateDir && existsSync(stateDir)) rmSync(stateDir, { recursive: true, force: true });
});

const sample: ReviewContext = {
  created_at: new Date(1_700_000_000_000).toISOString(),
  triggering_session: "sess-123",
  chat_id: "12345",
  signals: [
    {
      kind: "operator-correction",
      reason: "operator corrected the same thing twice",
      occurrences: 2,
      evidence: "no, not that",
    },
  ],
};

describe("self-improve review-context marker", () => {
  it("is absent on a fresh state dir", () => {
    expect(readReviewContext(stateDir)).toBeNull();
    expect(reviewIsPending(stateDir)).toBe(false);
  });

  it("write → read round-trips the marker", () => {
    writeReviewContext(stateDir, sample);
    expect(existsSync(join(stateDir, REVIEW_CONTEXT_FILE))).toBe(true);
    const got = readReviewContext(stateDir);
    expect(got).not.toBeNull();
    expect(got?.created_at).toBe(sample.created_at);
    expect(got?.triggering_session).toBe("sess-123");
    expect(got?.signals.map((s) => s.kind)).toEqual(["operator-correction"]);
    expect(reviewIsPending(stateDir)).toBe(true);
  });

  it("creates the state dir if missing", () => {
    const nested = join(stateDir, "deep", "nested");
    writeReviewContext(nested, sample);
    expect(reviewIsPending(nested)).toBe(true);
  });

  it("clear removes the marker (so enforcement stops after the review turn)", () => {
    writeReviewContext(stateDir, sample);
    expect(reviewIsPending(stateDir)).toBe(true);
    clearReviewContext(stateDir);
    expect(reviewIsPending(stateDir)).toBe(false);
    expect(readReviewContext(stateDir)).toBeNull();
  });

  it("clear on an absent marker is a no-op (best-effort)", () => {
    expect(() => clearReviewContext(stateDir)).not.toThrow();
  });

  it("treats a malformed marker as absent (fail-open)", () => {
    writeFileSync(join(stateDir, REVIEW_CONTEXT_FILE), "{ not json", "utf-8");
    expect(readReviewContext(stateDir)).toBeNull();
    expect(reviewIsPending(stateDir)).toBe(false);
  });

  it("per-session breaker: records and recalls a fired session (issue #2462)", () => {
    expect(hasFiredForSession(stateDir, "sess-A")).toBe(false);
    markFiredForSession(stateDir, "sess-A");
    expect(hasFiredForSession(stateDir, "sess-A")).toBe(true);
    // A different session is unaffected.
    expect(hasFiredForSession(stateDir, "sess-B")).toBe(false);
    markFiredForSession(stateDir, "sess-B");
    expect(hasFiredForSession(stateDir, "sess-A")).toBe(true);
    expect(hasFiredForSession(stateDir, "sess-B")).toBe(true);
    // Idempotent — re-marking doesn't break recall.
    markFiredForSession(stateDir, "sess-A");
    expect(hasFiredForSession(stateDir, "sess-A")).toBe(true);
  });

  it("per-session breaker: ignores empty / unknown session ids", () => {
    markFiredForSession(stateDir, "");
    markFiredForSession(stateDir, "unknown");
    expect(hasFiredForSession(stateDir, "")).toBe(false);
    expect(hasFiredForSession(stateDir, "unknown")).toBe(false);
  });

  it("defaults signals to [] when the marker omits them", () => {
    writeFileSync(
      join(stateDir, REVIEW_CONTEXT_FILE),
      JSON.stringify({ created_at: sample.created_at, triggering_session: "s", chat_id: "c" }),
      "utf-8",
    );
    const got = readReviewContext(stateDir);
    expect(got).not.toBeNull();
    expect(got?.signals).toEqual([]);
  });
});
