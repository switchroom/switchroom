import { describe, it, expect } from "vitest";
import { withDeadline } from "../gateway/with-deadline.js";

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("withDeadline — bounds the obligation escalation send so a hang can't leak the in-flight flag", () => {
  it("resolves with the inner value when the promise settles before the deadline", async () => {
    await expect(withDeadline(Promise.resolve("ok"), 1000, "timed out")).resolves.toBe("ok");
  });

  it("rejects with the inner error when the promise rejects before the deadline", async () => {
    await expect(withDeadline(Promise.reject(new Error("boom")), 1000, "timed out")).rejects.toThrow(
      "boom",
    );
  });

  it("rejects with the timeout message when the promise NEVER settles (the hang case)", async () => {
    // The whole point: a promise that never resolves/rejects (a stalled send)
    // must still settle the chain so the caller's .finally clears the in-flight flag.
    const neverSettles = new Promise<string>(() => {});
    await expect(withDeadline(neverSettles, 20, "obligation escalation send timed out")).rejects.toThrow(
      "obligation escalation send timed out",
    );
  });

  it("the .finally chained after it ALWAYS runs even when the inner promise hangs", async () => {
    // This mirrors the gateway's obligationEscalateInFlight clear: it lives in a
    // .finally on withDeadline(...), and must fire within the deadline regardless.
    let flagCleared = false;
    await withDeadline(new Promise<void>(() => {}), 20, "timed out")
      .catch(() => {})
      .finally(() => {
        flagCleared = true;
      });
    expect(flagCleared).toBe(true);
  });

  it("a hung-then-late-rejecting inner promise does not produce an unhandled rejection", async () => {
    const seen: unknown[] = [];
    const onUnhandled = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const lateReject = new Promise<void>((_, reject) => {
        setTimeout(() => reject(new Error("late-zombie-rejection")), 30);
      });
      // withDeadline rejects at 10ms; the inner promise rejects later at 30ms.
      await withDeadline(lateReject, 10, "timed out").catch(() => {});
      await tick(60); // let the late rejection fire
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
    expect(seen.some((r) => r instanceof Error && r.message === "late-zombie-rejection")).toBe(false);
  });

  it("clears its timer on a fast settle (no dangling work keeps the loop alive)", async () => {
    // Sanity: a fast resolve settles immediately, not after the deadline.
    const start = Date.now();
    await withDeadline(Promise.resolve(1), 5000, "timed out");
    expect(Date.now() - start).toBeLessThan(500);
  });
});
