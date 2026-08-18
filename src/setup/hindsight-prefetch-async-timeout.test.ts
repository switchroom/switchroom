/**
 * M4 deviation-5 — pure reader + validator for the async prefetch producer's
 * Stop-hook timeout envelope. Outcome-asserting: each case feeds a real
 * hooks.json shape (or a settings value) and asserts the validator's verdict,
 * so a regression in the "wedged prefetch" detection surfaces here without the
 * doctor fs harness.
 */
import { describe, expect, it } from "vitest";
import {
  readHooksPrefetchAsyncTimeout,
  validatePrefetchAsyncTimeout,
  DEFAULT_PREFETCH_ASYNC_TIMEOUT_SECONDS,
  MAX_PREFETCH_ASYNC_TIMEOUT_SECONDS,
} from "./hindsight-recall-tunables.js";

function hooksJson(prefetchHook: Record<string, unknown> | null): string {
  const stop: unknown[] = [
    { hooks: [{ type: "command", command: "python3 retain.py", timeout: 15, async: true }] },
  ];
  if (prefetchHook !== null) {
    stop.push({ hooks: [prefetchHook] });
  }
  return JSON.stringify({ hooks: { Stop: stop } });
}

describe("readHooksPrefetchAsyncTimeout", () => {
  it("reads the vendor-shipped async prefetch hook (async:true, timeout 20)", () => {
    const shape = readHooksPrefetchAsyncTimeout(
      hooksJson({
        type: "command",
        command: 'python3 "${CLAUDE_PLUGIN_ROOT}/scripts/prefetch.py"',
        timeout: DEFAULT_PREFETCH_ASYNC_TIMEOUT_SECONDS,
        async: true,
      }),
    );
    expect(shape).toEqual({ present: true, async: true, timeout: 20 });
  });

  it("reports present:false when the prefetch hook is absent", () => {
    expect(readHooksPrefetchAsyncTimeout(hooksJson(null))).toEqual({
      present: false,
      async: false,
      timeout: null,
    });
  });

  it("reports async:false / timeout:null when those keys are missing", () => {
    const shape = readHooksPrefetchAsyncTimeout(
      hooksJson({ type: "command", command: "python3 prefetch.py" }),
    );
    expect(shape).toEqual({ present: true, async: false, timeout: null });
  });

  it("never throws on malformed JSON", () => {
    expect(readHooksPrefetchAsyncTimeout("{ not json")).toEqual({
      present: false,
      async: false,
      timeout: null,
    });
  });
});

describe("validatePrefetchAsyncTimeout", () => {
  const good = { present: true, async: true, timeout: 20 };

  it("passes the vendor default with the default recall timeout", () => {
    expect(validatePrefetchAsyncTimeout(good, 5)).toEqual([]);
  });

  it("flags an absent prefetch hook", () => {
    const problems = validatePrefetchAsyncTimeout({ present: false, async: false, timeout: null }, 5);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("registers no Stop hook for prefetch.py");
  });

  it("flags a non-async prefetch hook as a turn-blocking wedge", () => {
    const problems = validatePrefetchAsyncTimeout({ present: true, async: false, timeout: 20 }, 5);
    expect(problems.some((p) => p.includes('"async": true'))).toBe(true);
  });

  it("flags a missing / non-positive ceiling", () => {
    const problems = validatePrefetchAsyncTimeout({ present: true, async: true, timeout: null }, 5);
    expect(problems.some((p) => p.includes("no positive `timeout`"))).toBe(true);
  });

  it("flags a ceiling above the maximum", () => {
    const problems = validatePrefetchAsyncTimeout(
      { present: true, async: true, timeout: MAX_PREFETCH_ASYNC_TIMEOUT_SECONDS + 1 },
      5,
    );
    expect(problems.some((p) => p.includes("maximum"))).toBe(true);
  });

  it("flags a recall timeout that meets or exceeds the async ceiling (torn buffer)", () => {
    const problems = validatePrefetchAsyncTimeout(good, 20);
    expect(problems.some((p) => p.includes("async hook ceiling"))).toBe(true);
  });
});
