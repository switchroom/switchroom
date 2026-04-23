import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/**
 * Exercises bin/timezone-hook.sh end-to-end. The hook is invoked by
 * Claude Code's UserPromptSubmit on every turn, so its two branches —
 * SWITCHROOM_TIMEZONE set, and unset — both need to emit valid JSON and
 * the "unset" branch must surface an in-band WARNING so a stale unit is
 * visible in the agent's context rather than silently falling back to UTC.
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

describe("timezone-hook.sh", () => {
  it("emits well-formed additionalContext when SWITCHROOM_TIMEZONE is set", () => {
    const { json } = runHook({ SWITCHROOM_TIMEZONE: "Australia/Melbourne" });
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
    const { json } = runHook({ SWITCHROOM_TIMEZONE: undefined });
    const ctx = (json as { hookSpecificOutput: { additionalContext: string } })
      .hookSpecificOutput.additionalContext;
    expect(ctx).toMatch(/Current local time:/);
    expect(ctx).toMatch(/WARNING/);
    expect(ctx).toMatch(/SWITCHROOM_TIMEZONE unset/);
    expect(ctx).toMatch(/switchroom systemd install/);
    // Still falls back to UTC so the base time string is meaningful.
    expect(ctx).toMatch(/UTC/);
  });

  it("produces valid JSON in both branches (no unescaped control chars)", () => {
    // Just re-parse; the runHook helper already calls JSON.parse.
    expect(() => runHook({ SWITCHROOM_TIMEZONE: "Australia/Melbourne" })).not.toThrow();
    expect(() => runHook({ SWITCHROOM_TIMEZONE: undefined })).not.toThrow();
  });
});
