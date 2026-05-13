/**
 * Tests for the cron-unit content-hash naming scheme (#1163 Phase D).
 *
 * The contract:
 *   - same (cron, prompt) inputs always produce the same filename;
 *   - any change to either input produces a different hash;
 *   - the hash is exactly 12 lowercase hex chars;
 *   - filenames follow the `cron-<sha12>.sh` shape.
 */
import { describe, expect, it } from "vitest";
import {
  cronUnitHash,
  cronUnitName,
  cronScriptFilename,
  CRON_SCRIPT_BASENAME_RE,
} from "./cron-unit-name.js";

describe("cron-unit-name", () => {
  it("is deterministic: identical inputs produce identical filename", () => {
    const a = cronScriptFilename("0 8 * * *", "Morning briefing");
    const b = cronScriptFilename("0 8 * * *", "Morning briefing");
    expect(a).toBe(b);
    expect(CRON_SCRIPT_BASENAME_RE.test(a)).toBe(true);
  });

  it("prompt change produces a different hash", () => {
    const a = cronUnitHash("0 8 * * *", "v1 prompt");
    const b = cronUnitHash("0 8 * * *", "v2 prompt");
    expect(a).not.toBe(b);
  });

  it("cron change produces a different hash", () => {
    const a = cronUnitHash("0 8 * * *", "same prompt");
    const b = cronUnitHash("0 9 * * *", "same prompt");
    expect(a).not.toBe(b);
  });

  it("hash is exactly 12 lowercase hex chars", () => {
    const h = cronUnitHash("0 8 * * *", "anything");
    expect(h).toMatch(/^[0-9a-f]{12}$/);
    expect(cronUnitName("0 8 * * *", "anything")).toBe(`cron-${h}`);
    expect(cronScriptFilename("0 8 * * *", "anything")).toBe(`cron-${h}.sh`);
  });

  it("uses a NUL separator so concat-collisions are impossible", () => {
    // "foo" + "bar" and "fooba" + "r" must differ.
    const a = cronUnitHash("foo", "bar");
    const b = cronUnitHash("fooba", "r");
    expect(a).not.toBe(b);
  });
});
