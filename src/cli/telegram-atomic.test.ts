/**
 * Atomicity test for emitDiffOrWrite (src/cli/telegram.ts) — #3149 follow-up.
 *
 * `switchroom telegram enable/disable <feature> <agent>` rewrites the
 * operator's canonical switchroom.yaml via emitDiffOrWrite. The prior
 * implementation used a bare in-place `writeFileSync` — a crash / ENOSPC
 * between truncate and write left the fleet config torn or empty. It now
 * routes through writeConfigFileSync (tmp + fsync + rename, bind-mount-aware);
 * a failed rename leaves the PRIOR file byte-for-byte intact and no tempfile
 * behind. (linear-agent.ts's writeConfigAtomic uses the identical primitive.)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock node:fs so we can force renameSync(2) to fail while every other fs call
// stays real. writeConfigFileSync → atomicWriteFileSync imports renameSync from
// node:fs, so the mock reaches it.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    renameSync: vi.fn().mockImplementation(actual.renameSync),
  };
});

import { emitDiffOrWrite } from "./telegram.js";

const BEFORE = "agents:\n  bot: {}\n";
const AFTER = "agents:\n  bot:\n    telegram:\n      voice: true\n";

describe("emitDiffOrWrite — atomic switchroom.yaml write (#3149 follow-up)", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sr-telegram-atomic-"));
    configPath = join(dir, "switchroom.yaml");
    writeFileSync(configPath, BEFORE, { mode: 0o644 });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("dry-run writes nothing", () => {
    emitDiffOrWrite(configPath, BEFORE, AFTER, true);
    expect(readFileSync(configPath, "utf-8")).toBe(BEFORE);
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toHaveLength(0);
  });

  it("round-trips the new content atomically and preserves mode", () => {
    emitDiffOrWrite(configPath, BEFORE, AFTER, false);
    expect(readFileSync(configPath, "utf-8")).toBe(AFTER);
    expect(statSync(configPath).mode & 0o777).toBe(0o644);
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toHaveLength(0);
  });

  it("a failed rename leaves the prior config byte-intact and no tempfile (bite)", () => {
    // The bite: against the pre-fix in-place writeFileSync there is no rename,
    // so this mock never fires and the file is silently rewritten/truncated.
    (fs.renameSync as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      const e = new Error("ENOSPC: no space left on device") as NodeJS.ErrnoException;
      e.code = "ENOSPC";
      throw e;
    });
    expect(() => emitDiffOrWrite(configPath, BEFORE, AFTER, false)).toThrow(/ENOSPC/);
    // Prior file untouched, no torn/empty write, no leaked tempfile.
    expect(readFileSync(configPath, "utf-8")).toBe(BEFORE);
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toHaveLength(0);
  });
});
