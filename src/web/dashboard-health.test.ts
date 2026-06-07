import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentBridgeAlive } from "./api.js";

/**
 * The web container is dockerless by design, so the dashboard's agent-liveness
 * must come from the gateway's `.bridge-alive` heartbeat file (touched ~every
 * 5s), not `docker ps`. These pin that fallback.
 */
describe("agentBridgeAlive (dockerless agent liveness)", () => {
  let agentsDir: string;
  const NOW = 1_780_000_000_000;

  beforeEach(() => {
    agentsDir = mkdtempSync(join(tmpdir(), "sr-bridge-alive-"));
  });
  afterEach(() => {
    rmSync(agentsDir, { recursive: true, force: true });
  });

  function writeHeartbeat(name: string, mtimeMs: number): void {
    const dir = join(agentsDir, name, "telegram");
    mkdirSync(dir, { recursive: true });
    const f = join(dir, ".bridge-alive");
    writeFileSync(f, "");
    const secs = mtimeMs / 1000;
    utimesSync(f, secs, secs);
  }

  it("is alive when the heartbeat mtime is within the window", () => {
    writeHeartbeat("clerk", NOW - 4_000); // 4s old — fresh
    expect(agentBridgeAlive(agentsDir, "clerk", 30_000, NOW)).toBe(true);
  });

  it("is alive exactly at the window boundary", () => {
    writeHeartbeat("clerk", NOW - 30_000);
    expect(agentBridgeAlive(agentsDir, "clerk", 30_000, NOW)).toBe(true);
  });

  it("is NOT alive when the heartbeat is stale (gateway dead)", () => {
    writeHeartbeat("clerk", NOW - 120_000); // 2 min old
    expect(agentBridgeAlive(agentsDir, "clerk", 30_000, NOW)).toBe(false);
  });

  it("is NOT alive when the heartbeat file is missing", () => {
    // no file written
    expect(agentBridgeAlive(agentsDir, "ghost", 30_000, NOW)).toBe(false);
  });

  it("is NOT alive when the agent dir doesn't exist at all", () => {
    expect(agentBridgeAlive(join(agentsDir, "nope"), "x", 30_000, NOW)).toBe(false);
  });
});
