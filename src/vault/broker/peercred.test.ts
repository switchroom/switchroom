/**
 * Tests for vault-broker peercred identification.
 *
 * Uses a mocked execFileSync to avoid requiring ss / /proc in CI.
 * Covers:
 *   - Happy path: returns { uid, pid, exe } when ss + /proc succeed
 *   - Missing PID in ss output → returns null
 *   - Foreign UID → returns null
 *   - ss failure → returns null
 *   - Non-Linux platform → returns null (tested by checking platform guard)
 */

import { describe, expect, it, vi, beforeEach } from "vitest";
import * as fs from "node:fs";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, readFileSync: vi.fn(), readlinkSync: vi.fn() };
});

// We cannot easily mock process.platform, so we mock the identify function
// indirectly by intercepting execFileSync and fs calls.
// The peercred module is tested by importing it and providing mock overrides.

import { identify } from "./peercred.js";

const SOCKET_PATH = "/home/test/.switchroom/vault-broker.sock";

// Mock /proc reading via vi.mocked
function setupProcMocks(uid: number, exe: string, pid: number) {
  vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
    const p = String(path);
    if (p === `/proc/${pid}/status`) {
      return `Name:\ttest\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t1000\t1000\t1000\t1000\n`;
    }
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });

  vi.mocked(fs.readlinkSync).mockImplementation((path: unknown) => {
    const p = String(path);
    if (p === `/proc/${pid}/exe`) return exe;
    throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  });
}

describe("peercred.identify", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns PeerInfo on happy path (Linux)", () => {
    if (process.platform !== "linux") return; // skip on non-Linux

    const pid = 9876;
    const brokerUid = process.getuid?.() ?? 1000;
    const exe = "/usr/bin/bash";

    const ssOutput =
      `Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port\n` +
      `u_str ESTAB 0 0 ${SOCKET_PATH} 12345 * 0 users:(("bash",pid=${pid},fd=5))\n`;

    setupProcMocks(brokerUid, exe, pid);

    const mockExec = vi.fn().mockReturnValue(ssOutput);
    const result = identify(SOCKET_PATH, mockExec as any);

    expect(result).not.toBeNull();
    expect(result?.pid).toBe(pid);
    expect(result?.uid).toBe(brokerUid);
    expect(result?.exe).toBe(exe);
    expect(mockExec).toHaveBeenCalledWith(
      "ss",
      ["-xpn", "state", "connected", "src", SOCKET_PATH],
      expect.objectContaining({ timeout: 200 }),
    );
  });

  it("returns null when ss output has no users column (no connected peers)", () => {
    if (process.platform !== "linux") return;

    const ssOutput = `Netid State Recv-Q Send-Q\nu_str ESTAB 0 0 ${SOCKET_PATH} 12345\n`;
    const mockExec = vi.fn().mockReturnValue(ssOutput);

    const result = identify(SOCKET_PATH, mockExec as any);
    expect(result).toBeNull();
  });

  it("returns null when ss throws (ss unavailable or timeout)", () => {
    if (process.platform !== "linux") return;

    const mockExec = vi.fn().mockImplementation(() => {
      throw new Error("ss: command not found");
    });

    const result = identify(SOCKET_PATH, mockExec as any);
    expect(result).toBeNull();
  });

  it("returns null when /proc/<pid>/status is missing (process exited)", () => {
    if (process.platform !== "linux") return;

    const pid = 9999;
    const ssOutput =
      `u_str ESTAB 0 0 ${SOCKET_PATH} 1 * 0 users:(("bash",pid=${pid},fd=3))\n`;
    const mockExec = vi.fn().mockReturnValue(ssOutput);

    // /proc/<pid>/status not found — simulate exited process
    vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const result = identify(SOCKET_PATH, mockExec as any);
    expect(result).toBeNull();
  });

  it("returns null when caller UID doesn't match broker UID", () => {
    if (process.platform !== "linux") return;

    const pid = 1234;
    const brokerUid = process.getuid?.() ?? 1000;
    const foreignUid = brokerUid + 1; // always different

    const ssOutput =
      `u_str ESTAB 0 0 ${SOCKET_PATH} 1 * 0 users:(("proc",pid=${pid},fd=3))\n`;
    const mockExec = vi.fn().mockReturnValue(ssOutput);

    // Proc status returns foreign UID
    vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
      const p = String(path);
      if (p === `/proc/${pid}/status`) {
        return `Name:\ttest\nUid:\t${foreignUid}\t${foreignUid}\t${foreignUid}\t${foreignUid}\n`;
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    const result = identify(SOCKET_PATH, mockExec as any);
    expect(result).toBeNull();
  });

  it("returns null on non-Linux without calling ss", () => {
    if (process.platform === "linux") return; // only run on non-Linux

    const mockExec = vi.fn();
    const result = identify(SOCKET_PATH, mockExec as any);
    expect(result).toBeNull();
    expect(mockExec).not.toHaveBeenCalled();
  });
});
