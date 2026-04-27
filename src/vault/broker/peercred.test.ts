/**
 * Tests for vault-broker peercred identification.
 *
 * Uses a mocked execFileSync to avoid requiring ss / /proc in CI.
 * Covers:
 *   - Happy path: returns { uid, pid, exe, systemdUnit } when ss + /proc succeed
 *   - Missing PID in ss output → returns null
 *   - Foreign UID → returns null
 *   - ss failure → returns null
 *   - Non-Linux platform → returns null (tested by checking platform guard)
 *   - readSystemdUnit: cgroup v2 line with matching unit
 *   - readSystemdUnit: cgroup v1 name=systemd line with matching unit
 *   - readSystemdUnit: no switchroom-*-cron-* segment → null
 *   - readSystemdUnit: no matching controller → null
 *   - readSystemdUnit: missing /proc/<pid>/cgroup → null
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

import { identify, readSystemdUnit } from "./peercred.js";

const SOCKET_PATH = "/home/test/.switchroom/vault-broker.sock";

// Mock /proc reading via vi.mocked
function setupProcMocks(uid: number, exe: string, pid: number, cgroupContent?: string) {
  vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
    const p = String(path);
    if (p === `/proc/${pid}/status`) {
      return `Name:\ttest\nUid:\t${uid}\t${uid}\t${uid}\t${uid}\nGid:\t1000\t1000\t1000\t1000\n`;
    }
    if (p === `/proc/${pid}/cgroup`) {
      if (cgroupContent !== undefined) return cgroupContent;
      // Default: no cgroup file
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
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

  // Build a mockExec that dispatches between `ss` and `systemctl` calls.
  // Pass `null` for systemctlOutput to simulate systemctl failure.
  function mkMockExec(
    ssOutput: string,
    systemctlOutput: string | null = "LoadState=loaded\nActiveState=active\n",
  ) {
    return vi.fn().mockImplementation((file: string, _args: readonly string[]) => {
      if (file === "ss") return ssOutput;
      if (file === "systemctl") {
        if (systemctlOutput === null) {
          const e = new Error("systemctl: command failed");
          throw e;
        }
        return systemctlOutput;
      }
      throw new Error(`unexpected exec: ${file}`);
    });
  }

  it("returns PeerInfo on happy path (Linux), systemdUnit verified by systemctl", () => {
    if (process.platform !== "linux") return; // skip on non-Linux

    const clientPid = 9876;
    const brokerPid = 1234;
    const brokerUid = process.getuid?.() ?? 1000;
    const exe = "/bin/bash";
    const cgroupContent =
      `0::/user.slice/user-${brokerUid}.slice/user@${brokerUid}.service/app.slice/switchroom-myagent-cron-3.service\n`;

    // `ss -xpn` shows BOTH sides of the connection. The path only appears on
    // the server-side row; the client-side row has Local=* with the matching
    // peer-inode pair. We must reconstruct that pair to identify the caller.
    const SERVER_INODE = "100";
    const CLIENT_INODE = "200";
    const ssOutput =
      `Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n` +
      `u_str ESTAB 0 0 ${SOCKET_PATH} ${SERVER_INODE} * ${CLIENT_INODE} users:(("broker",pid=${brokerPid},fd=5))\n` +
      `u_str ESTAB 0 0 * ${CLIENT_INODE} * ${SERVER_INODE} users:(("bash",pid=${clientPid},fd=4))\n`;

    setupProcMocks(brokerUid, exe, clientPid, cgroupContent);

    const mockExec = mkMockExec(ssOutput);
    const result = identify(SOCKET_PATH, undefined, mockExec as any);

    expect(result).not.toBeNull();
    expect(result?.pid).toBe(clientPid);
    expect(result?.uid).toBe(brokerUid);
    expect(result?.exe).toBe(exe);
    expect(result?.systemdUnit).toBe("switchroom-myagent-cron-3.service");
    expect(mockExec).toHaveBeenCalledWith(
      "ss",
      ["-xpn"],
      expect.objectContaining({ timeout: 200 }),
    );
    expect(mockExec).toHaveBeenCalledWith(
      "systemctl",
      [
        "--user",
        "show",
        "switchroom-myagent-cron-3.service",
        "--property=LoadState,ActiveState",
      ],
      expect.objectContaining({ timeout: 500 }),
    );
  });

  it("returns systemdUnit=null when cgroup name is spoofed (systemctl reports not-found)", () => {
    // Threat: a same-UID attacker creates a cgroup directory shaped like a
    // real cron unit and moves their PID into it. /proc/<pid>/cgroup then
    // claims the unit name, but systemd-user has no record of it.
    if (process.platform !== "linux") return;

    const clientPid = 9876;
    const brokerPid = 1234;
    const brokerUid = process.getuid?.() ?? 1000;
    const exe = "/bin/bash";
    const cgroupContent =
      `0::/user.slice/user-${brokerUid}.slice/user@${brokerUid}.service/app.slice/switchroom-fakecron-cron-0.service\n`;

    const SERVER_INODE = "100";
    const CLIENT_INODE = "200";
    const ssOutput =
      `u_str ESTAB 0 0 ${SOCKET_PATH} ${SERVER_INODE} * ${CLIENT_INODE} users:(("broker",pid=${brokerPid},fd=5))\n` +
      `u_str ESTAB 0 0 * ${CLIENT_INODE} * ${SERVER_INODE} users:(("bash",pid=${clientPid},fd=4))\n`;

    setupProcMocks(brokerUid, exe, clientPid, cgroupContent);

    // systemctl returns LoadState=not-found for spoofed/unknown units.
    const mockExec = mkMockExec(
      ssOutput,
      "LoadState=not-found\nActiveState=inactive\n",
    );
    const result = identify(SOCKET_PATH, undefined, mockExec as any);

    // Caller is still identified (uid/pid/exe), but systemdUnit is null
    // because we couldn't verify the cgroup claim.
    expect(result).not.toBeNull();
    expect(result?.pid).toBe(clientPid);
    expect(result?.systemdUnit).toBeNull();
  });

  it("returns systemdUnit=null when systemctl errors (e.g. systemd-user not running)", () => {
    if (process.platform !== "linux") return;

    const clientPid = 9876;
    const brokerPid = 1234;
    const brokerUid = process.getuid?.() ?? 1000;
    const cgroupContent =
      `0::/user.slice/user-${brokerUid}.slice/user@${brokerUid}.service/app.slice/switchroom-myagent-cron-3.service\n`;

    const SERVER_INODE = "100";
    const CLIENT_INODE = "200";
    const ssOutput =
      `u_str ESTAB 0 0 ${SOCKET_PATH} ${SERVER_INODE} * ${CLIENT_INODE} users:(("broker",pid=${brokerPid},fd=5))\n` +
      `u_str ESTAB 0 0 * ${CLIENT_INODE} * ${SERVER_INODE} users:(("bash",pid=${clientPid},fd=4))\n`;

    setupProcMocks(brokerUid, "/bin/bash", clientPid, cgroupContent);

    const mockExec = mkMockExec(ssOutput, null); // systemctl throws
    const result = identify(SOCKET_PATH, undefined, mockExec as any);

    expect(result).not.toBeNull();
    expect(result?.systemdUnit).toBeNull();
  });

  it("returns systemdUnit=null when unit is loaded but inactive (failed/stale)", () => {
    if (process.platform !== "linux") return;

    const clientPid = 9876;
    const brokerPid = 1234;
    const brokerUid = process.getuid?.() ?? 1000;
    const cgroupContent =
      `0::/user.slice/user-${brokerUid}.slice/user@${brokerUid}.service/app.slice/switchroom-myagent-cron-3.service\n`;

    const SERVER_INODE = "100";
    const CLIENT_INODE = "200";
    const ssOutput =
      `u_str ESTAB 0 0 ${SOCKET_PATH} ${SERVER_INODE} * ${CLIENT_INODE} users:(("broker",pid=${brokerPid},fd=5))\n` +
      `u_str ESTAB 0 0 * ${CLIENT_INODE} * ${SERVER_INODE} users:(("bash",pid=${clientPid},fd=4))\n`;

    setupProcMocks(brokerUid, "/bin/bash", clientPid, cgroupContent);

    const mockExec = mkMockExec(
      ssOutput,
      "LoadState=loaded\nActiveState=failed\n",
    );
    const result = identify(SOCKET_PATH, undefined, mockExec as any);

    expect(result).not.toBeNull();
    expect(result?.systemdUnit).toBeNull();
  });

  it("returns PeerInfo with systemdUnit=null when cgroup has no switchroom unit", () => {
    if (process.platform !== "linux") return;

    const clientPid = 9876;
    const brokerPid = 1234;
    const brokerUid = process.getuid?.() ?? 1000;
    const exe = "/usr/bin/bash";
    const cgroupContent = `0::/user.slice/user-${brokerUid}.slice/user@${brokerUid}.service/app.slice/some-other.service\n`;

    const SERVER_INODE = "100";
    const CLIENT_INODE = "200";
    const ssOutput =
      `u_str ESTAB 0 0 ${SOCKET_PATH} ${SERVER_INODE} * ${CLIENT_INODE} users:(("broker",pid=${brokerPid},fd=5))\n` +
      `u_str ESTAB 0 0 * ${CLIENT_INODE} * ${SERVER_INODE} users:(("bash",pid=${clientPid},fd=4))\n`;

    setupProcMocks(brokerUid, exe, clientPid, cgroupContent);

    // No systemctl call expected because cgroup name doesn't match the
    // switchroom-cron pattern; readSystemdUnit returns null upstream.
    const mockExec = vi.fn().mockReturnValue(ssOutput);
    const result = identify(SOCKET_PATH, undefined, mockExec as any);

    expect(result).not.toBeNull();
    expect(result?.systemdUnit).toBeNull();
  });

  it("returns null when ss output has no users column (no connected peers)", () => {
    if (process.platform !== "linux") return;

    const ssOutput = `Netid State Recv-Q Send-Q\nu_str ESTAB 0 0 ${SOCKET_PATH} 12345\n`;
    const mockExec = vi.fn().mockReturnValue(ssOutput);

    const result = identify(SOCKET_PATH, undefined, mockExec as any);
    expect(result).toBeNull();
  });

  it("returns null when ss throws (ss unavailable or timeout)", () => {
    if (process.platform !== "linux") return;

    const mockExec = vi.fn().mockImplementation(() => {
      throw new Error("ss: command not found");
    });

    const result = identify(SOCKET_PATH, undefined, mockExec as any);
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

    const result = identify(SOCKET_PATH, undefined, mockExec as any);
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

    const result = identify(SOCKET_PATH, undefined, mockExec as any);
    expect(result).toBeNull();
  });

  it("returns null on non-Linux without calling ss", () => {
    if (process.platform === "linux") return; // only run on non-Linux

    const mockExec = vi.fn();
    const result = identify(SOCKET_PATH, undefined, mockExec as any);
    expect(result).toBeNull();
    expect(mockExec).not.toHaveBeenCalled();
  });

  // Issue #129: concurrency safety. With multiple clients connected, the
  // legacy "first row wins" picked an arbitrary PID. Passing the socket
  // (whose fd inode pinpoints the right ss row) returns the correct one.
  it("picks the row matching the accepted server fd's inode under multi-client load", () => {
    if (process.platform !== "linux") return;

    const brokerPid = 1234;
    const brokerUid = process.getuid?.() ?? 1000;
    const exe = "/bin/bash";
    const cgroupContent =
      `0::/user.slice/user-${brokerUid}.slice/user@${brokerUid}.service/app.slice/switchroom-myagent-cron-3.service\n`;

    // Two simultaneous connections to the same listening socket. The
    // legacy lookup would return whichever client appears first in the
    // ss output. Our fd-pinned lookup must select the correct one.
    const TARGET_SERVER_INODE = 200;
    const TARGET_CLIENT_INODE = "201";
    const TARGET_CLIENT_PID = 9999;
    const OTHER_SERVER_INODE = "300";
    const OTHER_CLIENT_INODE = "301";
    const OTHER_CLIENT_PID = 8888;

    const ssOutput =
      `Netid State Recv-Q Send-Q Local Address:Port Peer Address:Port Process\n` +
      // OTHER connection (listed first in ss output, and would win under legacy)
      `u_str ESTAB 0 0 ${SOCKET_PATH} ${OTHER_SERVER_INODE} * ${OTHER_CLIENT_INODE} users:(("broker",pid=${brokerPid},fd=5))\n` +
      `u_str ESTAB 0 0 * ${OTHER_CLIENT_INODE} * ${OTHER_SERVER_INODE} users:(("bash",pid=${OTHER_CLIENT_PID},fd=4))\n` +
      // TARGET connection — what our fd actually points to
      `u_str ESTAB 0 0 ${SOCKET_PATH} ${TARGET_SERVER_INODE} * ${TARGET_CLIENT_INODE} users:(("broker",pid=${brokerPid},fd=6))\n` +
      `u_str ESTAB 0 0 * ${TARGET_CLIENT_INODE} * ${TARGET_SERVER_INODE} users:(("bash",pid=${TARGET_CLIENT_PID},fd=4))\n`;

    setupProcMocks(brokerUid, exe, TARGET_CLIENT_PID, cgroupContent);

    // Build a fake `Socket` exposing a synthetic _handle.fd. peercred reads
    // its inode via fstatSync, which we can't easily mock here without
    // pulling in more vi.mock plumbing — so we mock fstat too.
    const SYNTH_FD = 42;
    const fstatSpy = vi.spyOn(fs, "fstatSync");
    fstatSpy.mockImplementation((fd: number) => {
      if (fd === SYNTH_FD) {
        return { ino: TARGET_SERVER_INODE } as unknown as fs.Stats;
      }
      throw new Error(`unexpected fd: ${fd}`);
    });

    const fakeSocket = { _handle: { fd: SYNTH_FD } } as unknown as import("node:net").Socket;
    const mockExec = mkMockExec(ssOutput);
    const result = identify(SOCKET_PATH, fakeSocket, mockExec as any);

    expect(result).not.toBeNull();
    // Critical: the target client PID, not the OTHER client PID.
    expect(result?.pid).toBe(TARGET_CLIENT_PID);
    expect(result?.uid).toBe(brokerUid);
    expect(result?.systemdUnit).toBe("switchroom-myagent-cron-3.service");

    fstatSpy.mockRestore();
  });
});

describe("readSystemdUnit", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("parses a valid cgroup v2 line and returns the unit name", () => {
    const pid = 1111;
    vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
      if (String(path) === `/proc/${pid}/cgroup`) {
        return `0::/user.slice/user-1000.slice/user@1000.service/app.slice/switchroom-myagent-cron-3.service\n`;
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    expect(readSystemdUnit(pid)).toBe("switchroom-myagent-cron-3.service");
  });

  it("parses a valid cgroup v1 name=systemd line and returns the unit name", () => {
    const pid = 2222;
    vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
      if (String(path) === `/proc/${pid}/cgroup`) {
        return [
          "12:blkio:/user.slice",
          "11:perf_event:/",
          "1:name=systemd:/user.slice/user-1000.slice/user@1000.service/app.slice/switchroom-myagent-cron-0.service",
          "0::/user.slice",
        ].join("\n") + "\n";
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    expect(readSystemdUnit(pid)).toBe("switchroom-myagent-cron-0.service");
  });

  it("returns null when cgroup path has no switchroom-*-cron-* segment", () => {
    const pid = 3333;
    vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
      if (String(path) === `/proc/${pid}/cgroup`) {
        return `0::/user.slice/user-1000.slice/user@1000.service/app.slice/some-other-service.service\n`;
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    expect(readSystemdUnit(pid)).toBeNull();
  });

  it("returns null when no matching controller exists in cgroup v1", () => {
    const pid = 4444;
    vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
      if (String(path) === `/proc/${pid}/cgroup`) {
        return [
          "12:blkio:/user.slice",
          "11:perf_event:/",
          "10:cpu,cpuacct:/user.slice",
        ].join("\n") + "\n";
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    expect(readSystemdUnit(pid)).toBeNull();
  });

  it("returns null when /proc/<pid>/cgroup does not exist", () => {
    const pid = 5555;
    vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    expect(readSystemdUnit(pid)).toBeNull();
  });

  it("returns null for malformed cgroup content (empty file)", () => {
    const pid = 6666;
    vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
      if (String(path) === `/proc/${pid}/cgroup`) return "";
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    expect(readSystemdUnit(pid)).toBeNull();
  });

  it("ignores agent names that look like but don't match the convention", () => {
    const pid = 7777;
    vi.mocked(fs.readFileSync).mockImplementation((path: unknown) => {
      if (String(path) === `/proc/${pid}/cgroup`) {
        // Missing the index digit at the end
        return `0::/user.slice/user-1000.slice/user@1000.service/app.slice/switchroom-myagent-cron-.service\n`;
      }
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    });

    expect(readSystemdUnit(pid)).toBeNull();
  });
});
