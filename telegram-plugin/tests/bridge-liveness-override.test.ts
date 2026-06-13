/**
 * #2307 Tier-1 — the cron-session bridge writes its liveness file to a DISTINCT
 * path so a live `<agent>-cron` bridge can't mask a dead MAIN bridge in the
 * dashboard/doctor probe (RISK #2). The bridge is an IIFE (can't instantiate
 * in-process), so this pins the wiring by source-read: the liveness file path
 * honours `SWITCHROOM_BRIDGE_ALIVE_PATH`, falling back to the canonical
 * STATE_DIR/.bridge-alive (unchanged for the main bridge).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const bridgeSrc = readFileSync(resolve(__dirname, "..", "bridge", "bridge.ts"), "utf-8");

describe("bridge liveness path override (#2307 Tier-1)", () => {
  it("honours SWITCHROOM_BRIDGE_ALIVE_PATH, falling back to STATE_DIR/.bridge-alive", () => {
    expect(bridgeSrc).toMatch(
      /livenessFilePath:\s*process\.env\.SWITCHROOM_BRIDGE_ALIVE_PATH\s*\?\?\s*join\(STATE_DIR,\s*["']\.bridge-alive["']\)/,
    );
  });
});
