/**
 * M1 atomicity test for writeIfMissing (src/agents/scaffold.ts).
 *
 * The 2026-07-11 durability review flagged that a scaffold interrupted mid-write
 * (crash / ENOSPC / SIGKILL) left a torn settings.json — written non-atomically
 * via a bare writeFileSync and then read back + JSON.parse'd a few dozen lines
 * later, aborting the scaffold with a corrupt agent on disk. writeIfMissing now
 * routes through atomicWriteFileSync (tmp + fsync + rename); a failed write
 * leaves NO file at the destination rather than a partial one.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock node:fs so we can force renameSync(2) to fail while leaving every other
// fs call real. atomicWriteFileSync imports renameSync from node:fs, so the
// mock reaches it. Mirrors src/util/atomic.test.ts.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    renameSync: vi.fn().mockImplementation(actual.renameSync),
  };
});

import { writeIfMissing } from "./scaffold.js";

describe("writeIfMissing — atomic scaffold write (M1)", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sr-scaffold-atomic-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("round-trips: writes the file and records it as created", () => {
    const created: string[] = [];
    const skipped: string[] = [];
    const p = join(dir, ".claude", "settings.json");
    mkdirSync(join(dir, ".claude"), { recursive: true });

    writeIfMissing(p, () => '{\n  "mcpServers": {}\n}\n', created, skipped, 0o600);

    expect(readFileSync(p, "utf-8")).toBe('{\n  "mcpServers": {}\n}\n');
    expect(created).toEqual([p]);
    expect(skipped).toEqual([]);
    expect(vi.mocked(fs.renameSync)).toHaveBeenCalled();
    // Mode honoured, no tempfile leaked.
    expect(fs.statSync(p).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(join(dir, ".claude")).filter((f) => f.includes(".tmp-"))).toHaveLength(0);
  });

  it("skips when the file already exists (unchanged)", () => {
    const created: string[] = [];
    const skipped: string[] = [];
    const p = join(dir, "existing");
    writeFileSync(p, "ORIGINAL");

    writeIfMissing(p, () => "SHOULD-NOT-WRITE", created, skipped);

    expect(readFileSync(p, "utf-8")).toBe("ORIGINAL");
    expect(created).toEqual([]);
    expect(skipped).toEqual([p]);
  });

  // BITE: a crash at the atomic swap must leave NO file at the destination —
  // never a torn/partial one. Pre-fix writeIfMissing used a bare writeFileSync
  // (no rename), so the mocked failure never fired: no throw, and the file was
  // fully created. Both assertions below fail on the old code.
  it("creates no file at the destination when rename(2) fails mid-write", () => {
    const created: string[] = [];
    const skipped: string[] = [];
    const p = join(dir, ".claude", "settings.json");
    mkdirSync(join(dir, ".claude"), { recursive: true });

    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    });

    expect(() =>
      writeIfMissing(p, () => '{\n  "mcpServers": {}\n}\n', created, skipped),
    ).toThrow(/ENOSPC/);

    // No torn file left behind — the JSON.parse read that follows in the real
    // scaffold would therefore see "missing", not "corrupt".
    expect(existsSync(p)).toBe(false);
    expect(created).toEqual([]);
    // Tempfile cleaned up.
    expect(fs.readdirSync(join(dir, ".claude")).filter((f) => f.includes(".tmp-"))).toHaveLength(0);
  });
});
