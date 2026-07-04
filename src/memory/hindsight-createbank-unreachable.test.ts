/**
 * createBank connect-failure classification (#2752 follow-up).
 *
 * The scaffold's bank-create chain branches on `reason === "Unreachable"`:
 * that path prints the CALM "Hindsight unreachable — agent still usable"
 * message and skips creation. Any OTHER reason falls through to the scary
 * `⚠ Failed to create Hindsight bank …` branch.
 *
 * The undici connect-layer failure surfaces as
 *   `Error: Unable to connect. Is the computer able to access the url?`
 * with `err.cause?.code === "UND_ERR_CONNECT"` — matching NONE of the
 * original substrings (ECONNREFUSED / fetch failed / Failed to fetch /
 * ENOTFOUND). It was therefore mis-classified as a hard create failure and
 * spammed the scary alarm on every restart. These tests pin that the
 * broadened classifier now normalizes it to "Unreachable".
 */

import { describe, expect, it } from "vitest";

import { createBank } from "./hindsight.js";

const API_URL = "http://127.0.0.1:18888/mcp/";

/** A fetch stub that always throws the given error at connect time. */
function throwingFetch(err: unknown): typeof fetch {
  return (async () => {
    throw err;
  }) as unknown as typeof fetch;
}

describe("createBank — connect-failure normalizes to Unreachable", () => {
  it('classifies the undici "Unable to connect" message as Unreachable', async () => {
    const err = new Error("Unable to connect. Is the computer able to access the url?");
    const r = await createBank(API_URL, "clerk", {
      fetchImpl: throwingFetch(err),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("Unreachable");
  });

  it("classifies an UND_ERR_CONNECT cause code as Unreachable", async () => {
    const err = new Error("fetch failed - connect error") as Error & {
      cause?: { code?: string };
    };
    // Simulate the undici shape: opaque message, real code on err.cause.
    const opaque = new Error("something opaque") as Error & {
      cause?: { code?: string };
    };
    opaque.cause = { code: "UND_ERR_CONNECT" };
    void err; // keep the intent explicit; the opaque-message case is the point.
    const r = await createBank(API_URL, "clerk", {
      fetchImpl: throwingFetch(opaque),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("Unreachable");
  });

  it("still classifies the legacy ECONNREFUSED message as Unreachable", async () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:18888");
    const r = await createBank(API_URL, "clerk", {
      fetchImpl: throwingFetch(err),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("Unreachable");
  });

  it("does NOT swallow an unrelated error into Unreachable (scary branch still reachable)", async () => {
    const err = new Error("some totally unrelated bug");
    const r = await createBank(API_URL, "clerk", {
      fetchImpl: throwingFetch(err),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).not.toBe("Unreachable");
  });
});
