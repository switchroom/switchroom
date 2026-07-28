/**
 * atomic — sec #1410 (TOCTOU follow-up to CRITICAL #1393). The two
 * brokers run as ROOT through this primitive, so the symlink-safety
 * guarantees matter. Pre-#1410 atomic.ts had no direct test.
 *
 * writeConfigFileSync (#2457): EBUSY/EXDEV/EINVAL fallback for single-file
 * bind mounts inside the hostd container where rename(2) is rejected.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock node:fs so we can spy on renameSync for the writeConfigFileSync EBUSY
// tests while leaving all other functions as real implementations. The existing
// atomicWriteFileSync tests never touch the mock (mockImplementationOnce is
// only set in the writeConfigFileSync EBUSY describe block).
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    renameSync: vi.fn().mockImplementation(actual.renameSync),
  };
});

import { atomicWriteFileSync, atomicWriteJsonSync, fsyncPathSync, writeConfigFileSync } from "./atomic.js";

describe("atomicWriteFileSync", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), "atomic-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    // Only clear call counts/instances; the mock's real-implementation
    // wrapping must stay in place for subsequent tests.
    vi.clearAllMocks();
  });

  it("writes content at 0600 by default and leaves no tempfile", () => {
    const p = join(dir, "secret.json");
    atomicWriteFileSync(p, "hello");
    expect(fs.readFileSync(p, "utf8")).toBe("hello");
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    // No `.tmp-` leak on the success path.
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toHaveLength(0);
  });

  it("atomically replaces an existing regular file", () => {
    const p = join(dir, "f");
    fs.writeFileSync(p, "OLD");
    atomicWriteFileSync(p, "NEW");
    expect(fs.readFileSync(p, "utf8")).toBe("NEW");
  });

  it("atomicWriteJsonSync writes pretty JSON + trailing newline", () => {
    const p = join(dir, "c.json");
    atomicWriteJsonSync(p, { a: 1 });
    expect(fs.readFileSync(p, "utf8")).toBe('{\n  "a": 1\n}\n');
  });

  // THE security property (#1393/#1410): if the destination is an
  // attacker-planted symlink to a sensitive file, the write must NOT
  // follow it — rename(2) replaces the symlink itself, so the pointed-
  // at victim is never modified and dest becomes a real file.
  it("does not write through a symlinked destination (no symlink-follow)", () => {
    const victim = join(dir, "victim-secret");
    fs.writeFileSync(victim, "SECRET-UNTOUCHED");
    const dest = join(dir, "dest");
    fs.symlinkSync(victim, dest);
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(true);

    atomicWriteFileSync(dest, "ATTACKER-CONTROLLED-PAYLOAD");

    // dest is now a regular file with the new bytes …
    expect(fs.lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(dest, "utf8")).toBe("ATTACKER-CONTROLLED-PAYLOAD");
    // … and the symlink's victim was NEVER written through.
    expect(fs.readFileSync(victim, "utf8")).toBe("SECRET-UNTOUCHED");
  });

  it("propagates errors fail-closed (bad dir → throws, dest untouched)", () => {
    const p = join(dir, "nope", "deep", "x");
    expect(() => atomicWriteFileSync(p, "data")).toThrow();
  });

  // Deterministic guard for the flagship symlink-safety property (#1410):
  // the tempfile open MUST carry O_EXCL (refuse a pre-existing path) and
  // O_NOFOLLOW (refuse a symlink at the final component). The destination-
  // symlink test above passes even on pre-fix code because rename(2) defeats a
  // dest symlink regardless of open flags — so it does NOT pin these flags. If
  // someone stripped O_NOFOLLOW|O_EXCL from TMP_OPEN_FLAGS, only this test fails.
  it("opens the tempfile with O_EXCL and O_NOFOLLOW (symlink-proof create)", () => {
    const openSpy = vi.spyOn(fs, "openSync");
    try {
      atomicWriteFileSync(join(dir, "x"), "data");
      const tmpOpen = openSpy.mock.calls.find((c) => String(c[0]).includes(".tmp-"));
      expect(tmpOpen).toBeDefined();
      const flags = tmpOpen![1] as number;
      expect(flags & fs.constants.O_EXCL).toBe(fs.constants.O_EXCL);
      // O_NOFOLLOW is Linux/macOS-only; TMP_OPEN_FLAGS uses `?? 0` where absent.
      if (fs.constants.O_NOFOLLOW) {
        expect(flags & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW);
      }
    } finally {
      openSpy.mockRestore();
    }
  });
});

describe("writeConfigFileSync (#2457 — EBUSY bind-mount fallback)", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), "config-write-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    // Only clear call counts/instances; the mock's real-implementation
    // wrapping must stay in place for subsequent tests.
    vi.clearAllMocks();
  });

  it("happy path: uses rename(2) and the file ends up with the new contents", () => {
    const p = join(dir, "switchroom.yaml");
    fs.writeFileSync(p, "agents: {}\n");
    writeConfigFileSync(p, "agents: { foo: {} }\n");
    expect(fs.readFileSync(p, "utf8")).toBe("agents: { foo: {} }\n");
    // renameSync must have been called at least once on the happy path
    expect(vi.mocked(fs.renameSync)).toHaveBeenCalled();
    // No tempfile left behind
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toHaveLength(0);
  });

  it("EBUSY: falls back to in-place rewrite and file ends up with new contents", () => {
    const p = join(dir, "switchroom.yaml");
    fs.writeFileSync(p, "agents: {}\n", { mode: 0o644 });

    // Simulate EBUSY on the first rename call (single-file bind mount)
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    });

    writeConfigFileSync(p, "agents: { bar: {} }\n");

    // Despite the rename failure, the in-place fallback wrote the new content
    expect(fs.readFileSync(p, "utf8")).toBe("agents: { bar: {} }\n");
  });

  it("EXDEV: falls back to in-place rewrite and file ends up with new contents", () => {
    const p = join(dir, "switchroom.yaml");
    fs.writeFileSync(p, "old: true\n", { mode: 0o644 });

    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EXDEV: cross-device link not permitted"), { code: "EXDEV" });
    });

    writeConfigFileSync(p, "new: true\n");

    expect(fs.readFileSync(p, "utf8")).toBe("new: true\n");
  });

  it("EINVAL: falls back to in-place rewrite and file ends up with new contents", () => {
    const p = join(dir, "switchroom.yaml");
    fs.writeFileSync(p, "old: true\n", { mode: 0o644 });

    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EINVAL: invalid argument"), { code: "EINVAL" });
    });

    writeConfigFileSync(p, "new: true\n");

    expect(fs.readFileSync(p, "utf8")).toBe("new: true\n");
  });

  it("non-EBUSY rename error is re-thrown (atomicity not silently swallowed)", () => {
    const p = join(dir, "switchroom.yaml");
    fs.writeFileSync(p, "agents: {}\n");

    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });

    expect(() => writeConfigFileSync(p, "new content\n")).toThrow("EPERM");
    // The original file must be untouched (the rename errored, in-place was not attempted)
    expect(fs.readFileSync(p, "utf8")).toBe("agents: {}\n");
  });

  it("propagates in-place fallback write errors (bad path on fallback)", () => {
    // Trigger EBUSY so we enter the fallback path, but the fallback itself fails
    // because the destination doesn't exist (no pre-created file to O_TRUNC).
    const p = join(dir, "nonexistent.yaml");

    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    });

    // openSync(p, O_WRONLY|O_TRUNC) on a nonexistent file throws ENOENT
    expect(() => writeConfigFileSync(p, "content\n")).toThrow();
  });

  it("EBUSY fallback: preserves the file's existing inode permissions (mode unchanged)", () => {
    // Create the file with a restrictive mode so we can verify it is left intact
    // after an in-place rewrite. O_TRUNC without O_CREAT does not touch the mode.
    const p = join(dir, "restricted.yaml");
    fs.writeFileSync(p, "old: true\n", { mode: 0o600 });
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);

    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    });

    writeConfigFileSync(p, "new: true\n");

    expect(fs.readFileSync(p, "utf8")).toBe("new: true\n");
    // The in-place fallback must not alter the inode's permission bits.
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
  });

  it("EBUSY fallback: fsyncSync throwing EIO propagates the error and closes the fd (no leak)", () => {
    const p = join(dir, "switchroom.yaml");
    fs.writeFileSync(p, "agents: {}\n", { mode: 0o644 });

    // First: enter the fallback path via a mocked EBUSY on rename.
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
    });

    // Spy on closeSync so we can assert it is called even when fsyncSync throws.
    const closeSpy = vi.spyOn(fs, "closeSync");
    // Make fsyncSync throw EIO once (simulates a hardware/kernel I/O error after
    // the file has been opened with O_TRUNC).
    const fsyncSpy = vi.spyOn(fs, "fsyncSync").mockImplementationOnce(() => {
      throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
    });

    expect(() => writeConfigFileSync(p, "new content\n")).toThrow("EIO");

    // The fd must have been closed despite the fsyncSync failure — no leak.
    expect(closeSpy).toHaveBeenCalled();

    fsyncSpy.mockRestore();
    closeSpy.mockRestore();
  });
});

describe("fsyncPathSync", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(join(tmpdir(), "fsync-path-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("syncs a regular file without disturbing its contents", () => {
    const p = join(dir, "spool.jsonl");
    fs.writeFileSync(p, "line one\n");
    expect(() => fsyncPathSync(p)).not.toThrow();
    expect(fs.readFileSync(p, "utf-8")).toBe("line one\n");
  });

  it("syncs a DIRECTORY — the non-obvious half, and the one a rename needs", () => {
    // A directory cannot be opened for writing, so a naive fsync helper that
    // opens O_WRONLY throws EISDIR here and the rename-durability barrier is
    // silently never taken.
    fs.writeFileSync(join(dir, "obligations.json"), "{}");
    expect(() => fsyncPathSync(dir)).not.toThrow();
  });

  it("throws on a missing path rather than silently skipping the barrier", () => {
    // A swallowed fsync is exactly the bug this primitive exists to prevent;
    // callers that want best-effort must wrap it themselves.
    expect(() => fsyncPathSync(join(dir, "does-not-exist"))).toThrow(/ENOENT/);
  });
});
