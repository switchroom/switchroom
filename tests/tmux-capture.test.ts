import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

// Mock execFileSync so the test doesn't touch real tmux.
vi.mock("node:child_process", () => {
  return {
    execFileSync: vi.fn(),
  };
});

import { execFileSync } from "node:child_process";
import { captureAgentPane } from "../src/agents/tmux.js";

const mockedExec = execFileSync as unknown as ReturnType<typeof vi.fn>;

describe("captureAgentPane", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(resolve(tmpdir(), "tmux-capture-test-"));
    mockedExec.mockReset();
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("writes a crash-report file with header and pane content", () => {
    mockedExec.mockReturnValue(Buffer.from("hello pane content\n"));
    const result = captureAgentPane({
      agentName: "klanker",
      agentDir,
      reason: "watchdog-bridge-stale",
    });
    expect("path" in result).toBe(true);
    if (!("path" in result)) return;
    const body = readFileSync(result.path, "utf8");
    expect(body).toContain("# agent: klanker");
    expect(body).toContain("# reason: watchdog-bridge-stale");
    expect(body).toContain("# tmux-socket: switchroom-klanker");
    expect(body).toContain("hello pane content");
  });

  it("uses ISO timestamp with colons replaced by dashes in filename", () => {
    mockedExec.mockReturnValue(Buffer.from("x"));
    const result = captureAgentPane({ agentName: "a", agentDir, reason: "r" });
    expect("path" in result).toBe(true);
    if (!("path" in result)) return;
    const fname = result.path.split("/").pop()!;
    expect(fname).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z-r\.txt$/);
  });

  it("includes -S - by default for full scrollback", () => {
    mockedExec.mockReturnValue(Buffer.from(""));
    captureAgentPane({ agentName: "a", agentDir, reason: "r" });
    const args = mockedExec.mock.calls[0]?.[1] as string[];
    expect(args).toContain("-S");
    expect(args).toContain("-");
  });

  it("omits -S - when scrollback=false", () => {
    mockedExec.mockReturnValue(Buffer.from(""));
    captureAgentPane({ agentName: "a", agentDir, reason: "r", scrollback: false });
    const args = mockedExec.mock.calls[0]?.[1] as string[];
    expect(args).not.toContain("-S");
  });

  it("returns {error} on tmux failure without throwing", () => {
    mockedExec.mockImplementation(() => {
      throw new Error("no server running");
    });
    const result = captureAgentPane({ agentName: "a", agentDir, reason: "r" });
    expect("error" in result).toBe(true);
    if (!("error" in result)) return;
    expect(result.error).toMatch(/no server running/);
  });

  it("retains only the N most recent files", () => {
    mockedExec.mockReturnValue(Buffer.from("body"));
    const dir = resolve(agentDir, "crash-reports");
    mkdirSync(dir, { recursive: true });
    // Pre-populate with 5 old files; their mtimes are deliberately older.
    const past = Math.floor(Date.now() / 1000) - 10000;
    for (let i = 0; i < 5; i++) {
      const p = resolve(dir, `old-${i}.txt`);
      writeFileSync(p, "old");
      utimesSync(p, past + i, past + i);
    }
    const result = captureAgentPane({
      agentName: "a",
      agentDir,
      reason: "r",
      retain: 3,
    });
    expect("path" in result).toBe(true);
    const remaining = readdirSync(dir).filter((n) => n.endsWith(".txt"));
    expect(remaining.length).toBe(3);
    // The newly-created file must be among the survivors (it's the newest).
    if ("path" in result) {
      expect(remaining).toContain(result.path.split("/").pop()!);
    }
  });

  it("caps captured bytes at 10MB", () => {
    const huge = Buffer.alloc(11 * 1024 * 1024, "x");
    mockedExec.mockReturnValue(huge);
    const result = captureAgentPane({ agentName: "a", agentDir, reason: "r" });
    expect("path" in result).toBe(true);
    if (!("path" in result)) return;
    const size = statSync(result.path).size;
    // Header is ~100 bytes; body capped at 10MB. Allow generous header room.
    expect(size).toBeLessThan(10 * 1024 * 1024 + 1024);
    expect(size).toBeGreaterThan(10 * 1024 * 1024 - 1024);
  });

  it("sanitizes weird reason strings into a slug", () => {
    mockedExec.mockReturnValue(Buffer.from(""));
    const result = captureAgentPane({
      agentName: "a",
      agentDir,
      reason: "Watchdog: Bridge / stale!!",
    });
    expect("path" in result).toBe(true);
    if (!("path" in result)) return;
    const fname = result.path.split("/").pop()!;
    expect(fname).toMatch(/-watchdog-bridge-stale\.txt$/);
  });
});
