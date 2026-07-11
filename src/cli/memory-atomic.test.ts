/**
 * F2 atomicity test for persistMemoryConfigUrl (src/cli/memory.ts).
 *
 * `switchroom memory setup` rewrites the operator's canonical
 * switchroom.yaml to record the freshly-started Hindsight endpoint under
 * memory.config.url. The prior implementation wrote it with a bare in-place
 * `writeFileSync` — a crash / ENOSPC between truncate and write left the
 * fleet config torn or empty. persistMemoryConfigUrl now routes through
 * writeConfigFileSync (tmp + fsync + rename, bind-mount-aware); a failed
 * rename leaves the PRIOR file byte-for-byte intact and no tempfile behind.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock node:fs so we can force renameSync(2) to fail while every other fs
// call stays real. writeConfigFileSync → atomicWriteFileSync imports
// renameSync from node:fs, so the mock reaches it.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    renameSync: vi.fn().mockImplementation(actual.renameSync),
  };
});

import { persistMemoryConfigUrl } from "./memory.js";

const URL = "http://127.0.0.1:6207/mcp/";
const PROVIDER = "claude-code";

describe("persistMemoryConfigUrl — atomic switchroom.yaml write (F2)", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sr-memory-atomic-"));
    configPath = join(dir, "switchroom.yaml");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("returns false and writes nothing when the config is missing", () => {
    expect(persistMemoryConfigUrl(configPath, PROVIDER, URL)).toBe(false);
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toHaveLength(0);
  });

  it("round-trips: adds a full memory block atomically and preserves mode", () => {
    writeFileSync(configPath, "agents:\n  bot: {}\n", { mode: 0o644 });

    expect(persistMemoryConfigUrl(configPath, PROVIDER, URL)).toBe(true);

    const after = readFileSync(configPath, "utf-8");
    expect(after).toContain("memory:");
    expect(after).toContain(`url: ${URL}`);
    expect(after).toContain(`provider: ${PROVIDER}`);
    expect(after).toContain("backend: hindsight");
    // Sibling content preserved.
    expect(after).toContain("agents:");
    // Went through the atomic swap; mode preserved; no tempfile leaked.
    expect(vi.mocked(fs.renameSync)).toHaveBeenCalled();
    expect(statSync(configPath).mode & 0o777).toBe(0o644);
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toHaveLength(0);
  });

  it("updates only the url when memory.config already exists", () => {
    writeFileSync(
      configPath,
      "memory:\n  backend: hindsight\n  config:\n    provider: claude-code\n    url: http://old/mcp/\n",
      { mode: 0o644 },
    );

    persistMemoryConfigUrl(configPath, PROVIDER, URL);

    const after = readFileSync(configPath, "utf-8");
    expect(after).toContain(`url: ${URL}`);
    expect(after).not.toContain("http://old/mcp/");
  });

  // BITE: a hard rename(2) failure (ENOSPC — NOT one of the
  // EBUSY/EXDEV/EINVAL codes writeConfigFileSync falls back on) must leave
  // the PRIOR switchroom.yaml byte-for-byte intact and throw. The pre-fix
  // bare writeFileSync never called rename, so the mock never fired: it
  // truncated + rewrote in place with no throw. Both assertions fail on the
  // old code.
  it("leaves the prior config byte-intact when rename(2) fails mid-write", () => {
    const original = "agents:\n  bot: {}\nmemory:\n  backend: hindsight\n";
    writeFileSync(configPath, original, { mode: 0o644 });
    const beforeMode = statSync(configPath).mode & 0o777;

    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    });

    expect(() => persistMemoryConfigUrl(configPath, PROVIDER, URL)).toThrow(/ENOSPC/);

    // Prior file untouched — not torn, not empty.
    expect(readFileSync(configPath, "utf-8")).toBe(original);
    expect(statSync(configPath).mode & 0o777).toBe(beforeMode);
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toHaveLength(0);
  });
});
