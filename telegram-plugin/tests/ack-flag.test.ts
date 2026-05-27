import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { markAckSent, clearAckSent, ACK_SENT_MARKER } from "../ack-flag.js";

describe("ack-flag — gateway-side state file for ack-first hook", () => {
  let stateDir: string;
  let prevEnv: string | undefined;

  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "ack-flag-"));
    prevEnv = process.env.TELEGRAM_STATE_DIR;
    process.env.TELEGRAM_STATE_DIR = stateDir;
  });

  afterEach(() => {
    if (prevEnv != null) process.env.TELEGRAM_STATE_DIR = prevEnv;
    else delete process.env.TELEGRAM_STATE_DIR;
    rmSync(stateDir, { recursive: true, force: true });
  });

  it("markAckSent creates the marker file", () => {
    expect(existsSync(join(stateDir, ACK_SENT_MARKER))).toBe(false);
    markAckSent();
    expect(existsSync(join(stateDir, ACK_SENT_MARKER))).toBe(true);
  });

  it("markAckSent is idempotent (second call is a no-op)", () => {
    markAckSent();
    expect(() => markAckSent()).not.toThrow();
    expect(existsSync(join(stateDir, ACK_SENT_MARKER))).toBe(true);
  });

  it("clearAckSent removes the marker file", () => {
    markAckSent();
    expect(existsSync(join(stateDir, ACK_SENT_MARKER))).toBe(true);
    clearAckSent();
    expect(existsSync(join(stateDir, ACK_SENT_MARKER))).toBe(false);
  });

  it("clearAckSent is idempotent (works when marker doesn't exist)", () => {
    expect(existsSync(join(stateDir, ACK_SENT_MARKER))).toBe(false);
    expect(() => clearAckSent()).not.toThrow();
  });

  it("round-trip: mark → clear → mark cycles work across turns", () => {
    // turn 1
    markAckSent();
    expect(existsSync(join(stateDir, ACK_SENT_MARKER))).toBe(true);
    // turn end / next turn start
    clearAckSent();
    expect(existsSync(join(stateDir, ACK_SENT_MARKER))).toBe(false);
    // turn 2 first reply
    markAckSent();
    expect(existsSync(join(stateDir, ACK_SENT_MARKER))).toBe(true);
  });

  it("noop when TELEGRAM_STATE_DIR is unset (best-effort)", () => {
    delete process.env.TELEGRAM_STATE_DIR;
    expect(() => markAckSent()).not.toThrow();
    expect(() => clearAckSent()).not.toThrow();
  });
});
