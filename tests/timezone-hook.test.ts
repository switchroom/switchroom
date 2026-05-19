import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Exercises bin/timezone-hook.sh end-to-end. The hook is invoked by
 * Claude Code's UserPromptSubmit on every turn, so its two branches —
 * SWITCHROOM_TIMEZONE set, and unset — both need to emit valid JSON and
 * the "unset" branch must surface an in-band WARNING so a stale unit is
 * visible in the agent's context rather than silently falling back to UTC.
 *
 * #1563 (de-flake): the original shape ran `runHook` per-test (1–2
 * shell-outs each, 7 total), each gated by vitest's default 5s test
 * timeout. Under contended CI shards a cold bash startup occasionally
 * pushed a single shell-out past 5s, producing a spurious "Test timed
 * out in 5000ms" on `vitest-shard (4)` (#1560 PR's CI; same class as
 * other CI-load flakes on this repo). Now: hoist the four distinct
 * invocations into a single `beforeAll` with an explicit 30s timeout,
 * and assert on the cached results. Also reduces — though doesn't
 * eliminate — the back-to-back-bucket-straddle race in test #4 by
 * running the two reproducibility-pair calls inside the same hook
 * frame instead of across separate `it` bodies with vitest scheduling
 * between them.
 */
const HOOK = resolve(__dirname, "../bin/timezone-hook.sh");

function runHook(env: Record<string, string | undefined>): { stdout: string; json: unknown } {
  // Build a sanitized env. Passing `undefined` removes the key.
  const merged: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") merged[k] = v;
  }
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) {
      delete merged[k];
    } else {
      merged[k] = v;
    }
  }
  const stdout = execFileSync("bash", [HOOK], {
    env: merged,
    encoding: "utf-8",
  });
  return { stdout, json: JSON.parse(stdout) };
}

type Sample = { stdout: string; json: unknown };

describe("timezone-hook.sh", () => {
  // Four distinct invocations cover every assertion in the suite. The
  // "byte-identical back-to-back" pair (`setMelb`/`setMelb2`) runs in
  // tight sequence inside this hook so vitest scheduling between
  // tests can't widen the wall-clock window between the two calls.
  let setMelb: Sample;
  let setMelb2: Sample;
  let unsetTZ: Sample;
  let setUTC: Sample;

  beforeAll(() => {
    setMelb = runHook({ SWITCHROOM_TIMEZONE: "Australia/Melbourne" });
    setMelb2 = runHook({ SWITCHROOM_TIMEZONE: "Australia/Melbourne" });
    unsetTZ = runHook({ SWITCHROOM_TIMEZONE: undefined });
    setUTC = runHook({ SWITCHROOM_TIMEZONE: "UTC" });
  }, 30_000);

  it("emits well-formed additionalContext when SWITCHROOM_TIMEZONE is set", () => {
    const { json } = setMelb;
    expect(json).toMatchObject({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
      },
    });
    const ctx = (json as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(ctx).toMatch(/Current local time:/);
    expect(ctx).toMatch(/Australia\/Melbourne/);
    // No WARNING when the env is set.
    expect(ctx).not.toMatch(/WARNING/);
  });

  it("emits a WARNING-annotated context when SWITCHROOM_TIMEZONE is unset", () => {
    const { json } = unsetTZ;
    const ctx = (json as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(ctx).toMatch(/Current local time:/);
    expect(ctx).toMatch(/WARNING/);
    expect(ctx).toMatch(/SWITCHROOM_TIMEZONE unset/);
    // The remediation hint pivoted in #1198: the legacy systemd unit
    // path is gone (#906 removed `switchroom systemd install`), and the
    // new wiring lives in the compose `environment:` block. Hint must
    // point at the compose path now.
    expect(ctx).toMatch(/compose env may be stale/);
    expect(ctx).toMatch(/switchroom apply/);
    expect(ctx).toMatch(/switchroom agent restart/);
    // Regression pin: the legacy systemd verb is gone.
    expect(ctx).not.toMatch(/switchroom systemd install/);
    // Still falls back to UTC so the base time string is meaningful.
    expect(ctx).toMatch(/UTC/);
  });

  it("produces valid JSON in both branches (no unescaped control chars)", () => {
    // The cached values already round-tripped through JSON.parse() inside
    // runHook(); re-parse the raw stdout here as a regression guard on
    // the no-throw contract.
    expect(() => JSON.parse(setMelb.stdout)).not.toThrow();
    expect(() => JSON.parse(unsetTZ.stdout)).not.toThrow();
  });

  // The hook must round to a 15-minute bucket so the additionalContext
  // is byte-stable across closely-spaced turns. Without this, every
  // UserPromptSubmit invalidates the prompt cache via the embedded
  // wall-clock minute. We can't easily fake $(date) inside the hook,
  // but two back-to-back invocations should always land in the same
  // bucket (the 15-min window is far longer than the test runtime).
  it("emits byte-identical stdout for back-to-back invocations (15-min bucket)", () => {
    expect(setMelb2.stdout).toBe(setMelb.stdout);
  });

  it("the embedded HH:MM minute is a multiple of 15", () => {
    const { json } = setUTC;
    const ctx = (json as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    // Match "YYYY-MM-DD HH:MM " — the literal minute token after the colon.
    const m = ctx.match(/\d{4}-\d{2}-\d{2} \d{2}:(\d{2}) /);
    expect(m).not.toBeNull();
    const mins = parseInt(m![1], 10);
    expect(mins % 15).toBe(0);
  });
});
