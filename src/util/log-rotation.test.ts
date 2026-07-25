/**
 * #3596 — the shared size-based rotation primitive.
 *
 * These assert OUTCOMES an unbounded log would fail: after enough bytes
 * the active file is small, the old bytes survive in `.1`, retention
 * caps total on-disk history, and the active inode is preserved (the
 * bind-mount / open-fd constraint that rules out rename).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  maybeRotateLogFile,
  rotateLogFile,
  resolveRotationConfig,
} from "./log-rotation.js";

let dir: string;
let log: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "logrot-"));
  log = path.join(dir, "test.log");
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("maybeRotateLogFile", () => {
  it("bounds an otherwise-unbounded log: repeated appends never exceed ~cap", () => {
    const cap = 4096;
    // Append 200 KiB in 1 KiB rows with a rotation check before each —
    // exactly the writer-path shape. Unbounded, the file ends at 200 KiB.
    let maxSeen = 0;
    for (let i = 0; i < 200; i++) {
      maybeRotateLogFile(log, { maxBytes: cap, maxFiles: 2, tag: "t" });
      fs.appendFileSync(log, "x".repeat(1023) + "\n");
      maxSeen = Math.max(maxSeen, fs.statSync(log).size);
    }
    expect(fs.statSync(log).size).toBeLessThanOrEqual(cap + 1024);
    expect(maxSeen).toBeLessThanOrEqual(cap + 1024);
    // And the whole directory is bounded by (maxFiles + 1) * cap-ish.
    const total = fs
      .readdirSync(dir)
      .reduce((n, f) => n + fs.statSync(path.join(dir, f)).size, 0);
    expect(total).toBeLessThan((2 + 1) * (cap + 1024));
    expect(total).toBeLessThan(200 * 1024); // ≪ the unbounded 200 KiB
  });

  it("enforces retention: only maxFiles generations survive", () => {
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(log, `gen${i}\n`.padEnd(200, "."));
      const rotated = maybeRotateLogFile(log, {
        maxBytes: 100,
        maxFiles: 2,
        tag: "t",
      });
      expect(rotated).toBe(true);
    }
    expect(fs.existsSync(`${log}.1`)).toBe(true);
    expect(fs.existsSync(`${log}.2`)).toBe(true);
    expect(fs.existsSync(`${log}.3`)).toBe(false);
    // Newest generation first: .1 holds gen9, .2 holds gen8.
    expect(fs.readFileSync(`${log}.1`, "utf-8")).toContain("gen9");
    expect(fs.readFileSync(`${log}.2`, "utf-8")).toContain("gen8");
  });

  it("does not rotate below the cap, and no-ops on a missing file", () => {
    expect(
      maybeRotateLogFile(log, { maxBytes: 100, maxFiles: 2, tag: "t" }),
    ).toBe(false);
    fs.writeFileSync(log, "small\n");
    expect(
      maybeRotateLogFile(log, { maxBytes: 100, maxFiles: 2, tag: "t" }),
    ).toBe(false);
    expect(fs.existsSync(`${log}.1`)).toBe(false);
  });

  it("a non-positive maxBytes disables rotation (operator escape hatch)", () => {
    fs.writeFileSync(log, "x".repeat(10_000));
    expect(
      maybeRotateLogFile(log, { maxBytes: -1, maxFiles: 2, tag: "t" }),
    ).toBe(false);
    expect(fs.statSync(log).size).toBe(10_000);
    expect(fs.existsSync(`${log}.1`)).toBe(false);
  });

  it("preserves the active inode (rename would EBUSY a single-file bind mount)", () => {
    fs.writeFileSync(log, "x".repeat(1000));
    const before = fs.statSync(log).ino;
    rotateLogFile(log, 2, "t");
    expect(fs.statSync(log).ino).toBe(before);
    expect(fs.statSync(log).size).toBe(0);
    expect(fs.statSync(`${log}.1`).size).toBe(1000);
  });

  it("an fd already open in O_APPEND keeps writing to the live file", () => {
    fs.writeFileSync(log, "x".repeat(1000));
    const fd = fs.openSync(log, "a");
    try {
      rotateLogFile(log, 2, "t");
      fs.writeSync(fd, "AFTER\n");
    } finally {
      fs.closeSync(fd);
    }
    expect(fs.readFileSync(log, "utf-8")).toContain("AFTER");
  });
});

describe("resolveRotationConfig", () => {
  const base = {
    envBytesVar: "X_BYTES",
    envFilesVar: "X_FILES",
    defaultBytes: 1000,
    defaultFiles: 3,
  };

  it("falls back to defaults with no options and no env", () => {
    expect(resolveRotationConfig({ ...base, env: {} })).toEqual({
      maxBytes: 1000,
      maxFiles: 3,
    });
  });

  it("env overrides defaults; explicit options override env", () => {
    const env = { X_BYTES: "500", X_FILES: "7" };
    expect(resolveRotationConfig({ ...base, env })).toEqual({
      maxBytes: 500,
      maxFiles: 7,
    });
    expect(
      resolveRotationConfig({ ...base, env, maxBytes: 42, maxFiles: 1 }),
    ).toEqual({ maxBytes: 42, maxFiles: 1 });
  });

  it("a negative env value disables rotation (maxBytes < 0)", () => {
    expect(
      resolveRotationConfig({ ...base, env: { X_BYTES: "-1" } }).maxBytes,
    ).toBe(-1);
  });
});
