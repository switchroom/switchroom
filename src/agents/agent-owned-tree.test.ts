/**
 * Tests for the reconcile ownership sweep's ENOENT-race tolerance.
 *
 * Incident: a full-mode rollout halted at a non-canary agent whose live
 * `workspace/pgdata-*` Postgres data dir was churning files. The recursive
 * `chown -h -R` over the whole agent tree hit `readdir`→`lchown` races on
 * vanished inodes → per-file "No such file or directory" → aggregate exit
 * status 1 → `execFileSync` threw → the sweep re-threw → reconcile aborted
 * BEFORE the container was recreated. A benign race stalled the roll.
 *
 * The fix makes `chownTree` tolerant of a pure vanished-file race while
 * STILL failing loudly on a real ownership failure (EPERM/EACCES/EROFS —
 * the #3168 invariant: a still-present, still-mis-owned inode must throw).
 *
 * These tests assert the OUTCOME, not the code path:
 *   - `isChownVanishedRaceOnly` classifies stderr correctly (fail-closed).
 *   - `chownTree` SWALLOWS a pure-ENOENT throw and RE-THROWS a real failure.
 * Both would fail on pre-fix `main` (the classifier does not exist and
 * `chownTree` had no tolerance at all — every non-zero chown threw).
 */

import { describe, expect, it, vi, beforeEach } from "vitest";

const { execFileSyncMock } = vi.hoisted(() => ({ execFileSyncMock: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: execFileSyncMock };
});

import { isChownVanishedRaceOnly, ownershipRuntime } from "./agent-owned-tree.js";

/** Fabricate an execFileSync-style throw carrying status + captured stderr. */
function chownError(stderr: string): Error & { status: number; stderr: Buffer } {
  const err = new Error("Command failed: chown -h -R -- 10001:10001 /a") as Error & {
    status: number;
    stderr: Buffer;
  };
  err.status = 1;
  err.stderr = Buffer.from(stderr);
  return err;
}

/**
 * Fabricate the shape execFileSync throws when it SIGTERM-kills the child for
 * exceeding maxBuffer (#4365): `status === null`, `.signal` set, and the
 * captured stderr TRUNCATED (here, an all-ENOENT tail — the trap the classifier
 * must not be fooled by).
 */
function chownKilledError(
  stderr: string,
  signal: string = "SIGTERM",
): Error & { status: null; signal: string; stderr: Buffer } {
  const err = new Error("stderr maxBuffer length exceeded") as Error & {
    status: null;
    signal: string;
    stderr: Buffer;
  };
  err.status = null;
  err.signal = signal;
  err.stderr = Buffer.from(stderr);
  return err;
}

describe("isChownVanishedRaceOnly", () => {
  it("returns true when EVERY stderr line is a vanished-file (ENOENT) error", () => {
    const stderr =
      "chown: cannot access '/a/workspace/pgdata-r435/16384': No such file or directory\n" +
      "chown: cannot access '/a/workspace/pgdata-r435/pg_wal/000001': No such file or directory\n" +
      "chown: cannot read directory '/a/workspace/pgdata-r435/base': No such file or directory\n";
    expect(isChownVanishedRaceOnly(chownError(stderr))).toBe(true);
  });

  it("returns false when ANY line is a real ownership failure (mixed)", () => {
    const stderr =
      "chown: cannot access '/a/workspace/pgdata/16384': No such file or directory\n" +
      "chown: changing ownership of '/a/immutable': Operation not permitted\n";
    expect(isChownVanishedRaceOnly(chownError(stderr))).toBe(false);
  });

  it("returns false for a pure EPERM failure", () => {
    const stderr = "chown: changing ownership of '/a/x': Operation not permitted\n";
    expect(isChownVanishedRaceOnly(chownError(stderr))).toBe(false);
  });

  it("returns false for a read-only filesystem failure", () => {
    const stderr = "chown: changing ownership of '/a/ro': Read-only file system\n";
    expect(isChownVanishedRaceOnly(chownError(stderr))).toBe(false);
  });

  it("is fail-closed on empty/absent stderr (non-zero exit, no evidence)", () => {
    expect(isChownVanishedRaceOnly(chownError(""))).toBe(false);
    expect(isChownVanishedRaceOnly({ status: 1 })).toBe(false);
    expect(isChownVanishedRaceOnly(null)).toBe(false);
    expect(isChownVanishedRaceOnly(undefined)).toBe(false);
  });
});

describe("ownershipRuntime.chownTree ENOENT-race tolerance", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it("succeeds normally when chown exits 0", () => {
    execFileSyncMock.mockReturnValue(Buffer.from(""));
    expect(() => ownershipRuntime.chownTree(10001, 10001, "/a")).not.toThrow();
  });

  it("SWALLOWS a pure vanished-file race (the incident: today this throws)", () => {
    execFileSyncMock.mockImplementation(() => {
      throw chownError(
        "chown: cannot access '/a/workspace/pgdata-r435/16384': No such file or directory\n" +
          "chown: cannot access '/a/workspace/pgdata-r435/pg_wal/x': No such file or directory\n",
      );
    });
    expect(() => ownershipRuntime.chownTree(10001, 10001, "/a")).not.toThrow();
  });

  it("RE-THROWS a real ownership failure (preserves the #3168 invariant)", () => {
    execFileSyncMock.mockImplementation(() => {
      throw chownError(
        "chown: changing ownership of '/a/.claude/settings.json': Operation not permitted\n",
      );
    });
    // The ORIGINAL error is re-thrown intact — its `.stderr` still carries the
    // real EPERM failure so the upstack #3168 "could not restore ownership"
    // wrap fires loudly.
    let caught: (Error & { stderr?: Buffer }) | undefined;
    try {
      ownershipRuntime.chownTree(10001, 10001, "/a");
    } catch (e) {
      caught = e as Error & { stderr?: Buffer };
    }
    expect(caught).toBeDefined();
    expect(caught?.stderr?.toString()).toMatch(/Operation not permitted/);
  });

  it("RE-THROWS when a real failure is mixed with vanished-file races", () => {
    execFileSyncMock.mockImplementation(() => {
      throw chownError(
        "chown: cannot access '/a/workspace/pgdata/16384': No such file or directory\n" +
          "chown: changing ownership of '/a/ro': Read-only file system\n",
      );
    });
    let caught: (Error & { stderr?: Buffer }) | undefined;
    try {
      ownershipRuntime.chownTree(10001, 10001, "/a");
    } catch (e) {
      caught = e as Error & { stderr?: Buffer };
    }
    expect(caught).toBeDefined();
    expect(caught?.stderr?.toString()).toMatch(/Read-only file system/);
  });

  it("pins LC_ALL=C on the chown invocation so stderr wording is stable", () => {
    execFileSyncMock.mockReturnValue(Buffer.from(""));
    ownershipRuntime.chownTree(10001, 10001, "/a");
    const [cmd, args, opts] = execFileSyncMock.mock.calls[0];
    expect(cmd).toBe("chown");
    expect(args).toEqual(["-h", "-R", "--", "10001:10001", "/a"]);
    expect((opts as { env: Record<string, string> }).env.LC_ALL).toBe("C");
  });

  it("passes a generous maxBuffer so churn stderr never truncates (#4365 part 1)", () => {
    execFileSyncMock.mockReturnValue(Buffer.from(""));
    ownershipRuntime.chownTree(10001, 10001, "/a");
    const [, , opts] = execFileSyncMock.mock.calls[0];
    // Explicit and far above the 1 MB default that let a churning tree
    // SIGTERM-kill chown mid-walk.
    expect((opts as { maxBuffer?: number }).maxBuffer).toBeGreaterThanOrEqual(
      64 * 1024 * 1024,
    );
  });

  it("RE-THROWS a maxBuffer-kill even when the TRUNCATED stderr is all-ENOENT (#4365 part 2, fail-closed)", () => {
    // The incident's poison shape: >1 MB of churn ENOENT stderr overflows
    // maxBuffer, execFileSync SIGTERM-kills chown (status===null, signal set),
    // and the stderr we could classify is TRUNCATED — a real EPERM may have
    // followed past the cutoff. Swallowing on the all-ENOENT tail would wrongly
    // declare a benign race. Pre-fix (no signal/null-status guard) this stderr
    // classifies as a pure race and the throw is SWALLOWED — the test goes red.
    execFileSyncMock.mockImplementation(() => {
      throw chownKilledError(
        "chown: cannot access '/a/workspace/pgdata/16384': No such file or directory\n" +
          "chown: cannot access '/a/workspace/pgdata/pg_wal/x': No such file or directory\n",
      );
    });
    let caught: (Error & { signal?: string }) | undefined;
    try {
      ownershipRuntime.chownTree(10001, 10001, "/a");
    } catch (e) {
      caught = e as Error & { signal?: string };
    }
    expect(caught).toBeDefined();
    // The ORIGINAL kill error is re-thrown intact (signal preserved) so the
    // upstack #3168 "could not restore ownership" wrap fires loudly.
    expect(caught?.signal).toBe("SIGTERM");
  });
});

describe("ownershipRuntime.chownShallow hardening (#4366)", () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue(Buffer.from(""));
  });

  it("passes the `--` end-of-options guard before the owner spec", () => {
    ownershipRuntime.chownShallow(10001, 10001, ["/a/-weird", "/a/start.sh"]);
    const [cmd, args] = execFileSyncMock.mock.calls[0];
    expect(cmd).toBe("chown");
    expect(args).toEqual(["-h", "--", "10001:10001", "/a/-weird", "/a/start.sh"]);
  });

  it("pins LC_ALL=C on the invocation, mirroring chownTree", () => {
    ownershipRuntime.chownShallow(10001, 10001, ["/a/start.sh"]);
    const [, , opts] = execFileSyncMock.mock.calls[0];
    expect((opts as { env: Record<string, string> }).env.LC_ALL).toBe("C");
  });

  it("is a no-op with no paths (never shells chown)", () => {
    ownershipRuntime.chownShallow(10001, 10001, []);
    expect(execFileSyncMock).not.toHaveBeenCalled();
  });
});
