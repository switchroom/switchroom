import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * Unit tests for {@link alignAgentUid}.
 *
 * The function shells out to `chown` (and falls back to `sudo chown`)
 * to fix bind-mount ownership for an agent's per-agent state dir.
 * We mock `node:child_process` and `node:fs` so the tests run
 * deterministically regardless of the runner's UID, sudo policy, or
 * filesystem state.
 */

// Mock factories must declare their state inside the factory body —
// vi.mock is hoisted, so anything referenced here must be self-contained.
vi.mock("node:child_process", () => {
  return {
    execSync: vi.fn(),
    execFileSync: vi.fn(),
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(() => true),
    statSync: vi.fn(),
    appendFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

// Imports MUST come after vi.mock so the mocks are applied.
import { execFileSync } from "node:child_process";
import { existsSync, statSync, appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { alignAgentUid } from "./scaffold.js";

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedStatSync = vi.mocked(statSync);
const mockedAppendFileSync = vi.mocked(appendFileSync);
const mockedMkdirSync = vi.mocked(mkdirSync);

describe("alignAgentUid", () => {
  beforeEach(() => {
    mockedExecFileSync.mockReset();
    mockedExistsSync.mockReset();
    mockedStatSync.mockReset();
    mockedAppendFileSync.mockReset();
    mockedMkdirSync.mockReset();
    mockedExistsSync.mockReturnValue(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // The agent state dir AND the per-agent log dir
  // (~/.switchroom/logs/<name>) are both chowned to the agent UID. The
  // log dir was added in #880 — without it, the in-container supervised
  // gateway and autoaccept-poll sidecars exit silently because their
  // log redirects (`>> /var/log/switchroom/...`) hit the bind-mounted
  // root-owned dir as a non-root agent UID.
  const expectedLogsDir = join(homedir(), ".switchroom", "logs", "agent");
  // Added 2026-05-26 (#1831): the per-agent audit dir lives at
  // ~/.switchroom/audit/<name>/ and is chowned alongside state + logs
  // so the agent-config audit JSONL is writable from inside the container.
  const expectedAuditDir = join(homedir(), ".switchroom", "audit", "agent");

  it("still runs recursive chown even when the top-level dir is already owned (subtree may be stale)", () => {
    // The previous behaviour was a fast-path no-op when statSync said the
    // top-level was already aligned. That hid stale uid 1000 entries
    // sitting deeper in the subtree (e.g. files an operator dropped in
    // via sudo). chown -R is idempotent + cheap, so we always run it.
    mockedStatSync.mockReturnValue({ uid: 10042, gid: 10042 } as never);
    mockedExecFileSync.mockImplementationOnce(() => Buffer.from(""));

    const res = alignAgentUid("agent", "/fake/state/agent", 10042, {
      writeOut: () => {},
      confirm: false,
    });

    expect(res.chowned).toBe(true);
    expect(res.paths).toEqual([
      "/fake/state/agent",
      expectedLogsDir,
      expectedAuditDir,
    ]);
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
    const [bin, args] = mockedExecFileSync.mock.calls[0];
    expect(bin).toBe("chown");
    expect(args).toEqual([
      "-R",
      "10042:10042",
      "/fake/state/agent",
      expectedLogsDir,
      expectedAuditDir,
    ]);
  });

  it("tries unprivileged chown first, returns success when it works", () => {
    mockedStatSync.mockReturnValue({ uid: 1000, gid: 1000 } as never);
    mockedExecFileSync.mockImplementationOnce(() => Buffer.from(""));

    const res = alignAgentUid("agent", "/fake/state/agent", 10042, {
      writeOut: () => {},
      confirm: false,
    });

    expect(res.chowned).toBe(true);
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
    const [bin, args] = mockedExecFileSync.mock.calls[0];
    expect(bin).toBe("chown");
    expect(args).toEqual([
      "-R",
      "10042:10042",
      "/fake/state/agent",
      expectedLogsDir,
      expectedAuditDir,
    ]);
  });

  it("falls back to `sudo chown` when unprivileged chown fails (EPERM)", () => {
    mockedStatSync.mockReturnValue({ uid: 1000, gid: 1000 } as never);
    mockedExecFileSync
      .mockImplementationOnce(() => {
        const e = new Error("EPERM: operation not permitted");
        throw e;
      })
      .mockImplementationOnce(() => Buffer.from(""));

    const res = alignAgentUid("agent", "/fake/state/agent", 10042, {
      writeOut: () => {},
      confirm: false,
    });

    expect(res.chowned).toBe(true);
    expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
    const [bin1] = mockedExecFileSync.mock.calls[0];
    const [bin2, args2] = mockedExecFileSync.mock.calls[1];
    expect(bin1).toBe("chown");
    expect(bin2).toBe("sudo");
    expect(args2).toEqual([
      "chown",
      "-R",
      "10042:10042",
      "/fake/state/agent",
      expectedLogsDir,
      expectedAuditDir,
    ]);
  });

  it("throws an actionable error when both unprivileged AND sudo chown fail", () => {
    mockedStatSync.mockReturnValue({ uid: 1000, gid: 1000 } as never);
    mockedExecFileSync.mockImplementation(() => {
      throw new Error("nope");
    });

    expect(() =>
      alignAgentUid("agent", "/fake/state/agent", 10042, {
        writeOut: () => {},
        confirm: false,
      }),
    ).toThrow(/sudo chown failed.*Run manually: sudo chown -R 10042:10042/);
    expect(mockedExecFileSync).toHaveBeenCalledTimes(2);
  });

  it("respects dryRun: never shells out even if uids mismatch", () => {
    mockedStatSync.mockReturnValue({ uid: 1000, gid: 1000 } as never);

    const res = alignAgentUid("agent", "/fake/state/agent", 10042, {
      writeOut: () => {},
      confirm: false,
      dryRun: true,
    });

    expect(res.chowned).toBe(false);
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it("returns immediately with no paths when neither agentDir nor the logs dir exists", () => {
    mockedExistsSync.mockReturnValue(false);

    const res = alignAgentUid("agent", "/missing/agent", 10042, {
      writeOut: () => {},
      confirm: false,
    });

    expect(res.chowned).toBe(false);
    expect(res.paths).toEqual([]);
    expect(mockedExecFileSync).not.toHaveBeenCalled();
  });

  it("still chowns when only the logs dir exists (legacy state-only paths absent)", () => {
    // existsSync returns true for everything EXCEPT /fake/state/agent
    // and the audit dir, isolating the logs-dir-only path.
    mockedExistsSync.mockImplementation(
      (p) => p !== "/fake/state/agent" && p !== expectedAuditDir,
    );
    mockedStatSync.mockReturnValue({ uid: 1000, gid: 1000 } as never);
    mockedExecFileSync.mockImplementationOnce(() => Buffer.from(""));

    const res = alignAgentUid("agent", "/fake/state/agent", 10042, {
      writeOut: () => {},
      confirm: false,
    });

    expect(res.chowned).toBe(true);
    expect(res.paths).toEqual([expectedLogsDir]);
    const [bin, args] = mockedExecFileSync.mock.calls[0];
    expect(bin).toBe("chown");
    expect(args).toEqual(["-R", "10042:10042", expectedLogsDir]);
  });

  // #1831 — the audit dir must be chowned alongside state + logs.
  // Without this, every appendAudit() call in agent-config.ts is a
  // silent no-op (write to root-owned dir from agent UID).
  it("includes the per-agent audit dir in the chown sweep (#1831)", () => {
    mockedStatSync.mockReturnValue({ uid: 0, gid: 0 } as never);
    mockedExecFileSync.mockImplementationOnce(() => Buffer.from(""));

    const res = alignAgentUid("agent", "/fake/state/agent", 10042, {
      writeOut: () => {},
      confirm: false,
    });

    expect(res.chowned).toBe(true);
    expect(res.paths).toContain(expectedAuditDir);
    const [bin, args] = mockedExecFileSync.mock.calls[0];
    expect(bin).toBe("chown");
    expect(args).toContain(expectedAuditDir);
    expect(args).toContain("10042:10042");
  });

  it("skips the audit dir if it doesn't exist yet (resilient to fresh installs)", () => {
    mockedExistsSync.mockImplementation((p) => p !== expectedAuditDir);
    mockedStatSync.mockReturnValue({ uid: 0, gid: 0 } as never);
    mockedExecFileSync.mockImplementationOnce(() => Buffer.from(""));

    const res = alignAgentUid("agent", "/fake/state/agent", 10042, {
      writeOut: () => {},
      confirm: false,
    });

    expect(res.chowned).toBe(true);
    expect(res.paths).not.toContain(expectedAuditDir);
  });

  // PR-D1 / v0.7 coverage gap #4 — when alignAgentUid actually shells
  // chown, it must record the prior owner of every top-level path to
  // ~/.switchroom/.uid-alignment.log so a future rollback can restore
  // exact ownership without guessing.
  it("appends one log line per top-level path whose prior owner differs from the target uid", () => {
    mockedStatSync.mockReturnValue({ uid: 1000, gid: 1000 } as never);
    mockedExecFileSync.mockImplementationOnce(() => Buffer.from(""));

    alignAgentUid("agent", "/fake/state/agent", 10042, {
      writeOut: () => {},
      confirm: false,
    });

    // Three paths chowned (state dir + logs dir + audit dir), so
    // three audit lines.
    expect(mockedAppendFileSync).toHaveBeenCalledTimes(3);
    for (const call of mockedAppendFileSync.mock.calls) {
      const [logPath, line] = call;
      expect(logPath).toBe(join(homedir(), ".switchroom", ".uid-alignment.log"));
      expect(typeof line).toBe("string");
      // Shape: <iso-ts> <path> <prior-uid>:<prior-gid> -> <new>:<new>\n
      expect(line as string).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \S+ 1000:1000 -> 10042:10042\n$/,
      );
    }
    // One line per chowned path: state dir AND logs dir each appear.
    const linesText = mockedAppendFileSync.mock.calls
      .map((c) => c[1] as string)
      .join("");
    expect(linesText).toContain("/fake/state/agent");
    expect(linesText).toContain(expectedLogsDir);

    // The log dir must be ensured ahead of the append (ENOENT-safe).
    expect(mockedMkdirSync).toHaveBeenCalledWith(
      join(homedir(), ".switchroom"),
      expect.objectContaining({ recursive: true }),
    );
  });

  it("does NOT append a log line when prior owner already matches the target uid (no work to record)", () => {
    mockedStatSync.mockReturnValue({ uid: 10042, gid: 10042 } as never);
    mockedExecFileSync.mockImplementationOnce(() => Buffer.from(""));

    alignAgentUid("agent", "/fake/state/agent", 10042, {
      writeOut: () => {},
      confirm: false,
    });

    expect(mockedAppendFileSync).not.toHaveBeenCalled();
  });

  it("appendFileSync failures never block the chown (best-effort audit)", () => {
    mockedStatSync.mockReturnValue({ uid: 1000, gid: 1000 } as never);
    mockedAppendFileSync.mockImplementation(() => {
      throw new Error("ENOSPC: disk full");
    });
    mockedExecFileSync.mockImplementationOnce(() => Buffer.from(""));

    const res = alignAgentUid("agent", "/fake/state/agent", 10042, {
      writeOut: () => {},
      confirm: false,
    });

    expect(res.chowned).toBe(true);
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
  });
});
