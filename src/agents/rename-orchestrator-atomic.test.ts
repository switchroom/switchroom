/**
 * F1 atomicity test for renameAgentInConfig (src/agents/rename-orchestrator.ts).
 *
 * `switchroom agent rename <old> <new>` rewrites the operator's canonical
 * switchroom.yaml to move an agent block under its new slug. The prior
 * implementation wrote it with a bare in-place `writeFileSync` — a crash /
 * ENOSPC between truncate and write left the operator's fleet config torn
 * or empty. renameAgentInConfig now routes through writeConfigFileSync
 * (tmp + fsync + rename, bind-mount-aware); a failed rename leaves the
 * PRIOR file byte-for-byte intact and no tempfile behind.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock node:fs so we can force renameSync(2) to fail while every other fs
// call stays real. writeConfigFileSync → atomicWriteFileSync imports
// renameSync from node:fs, so the mock reaches it. Mirrors
// src/agents/scaffold-write-atomic.test.ts.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    renameSync: vi.fn().mockImplementation(actual.renameSync),
  };
});

import { renameAgentInConfig } from "./rename-orchestrator.js";

// Full block mapping (not flow) so renameAgentInConfig's YAML round-trip
// preserves fields verbatim and the assertions read cleanly.
const FIXTURE = `agents:
  oldbot:
    bot_token: vault:oldbot.bot_token
    memory:
      collection: oldbot
    model: sonnet
  keepbot:
    bot_token: vault:keepbot.bot_token
`;

describe("renameAgentInConfig — atomic switchroom.yaml write (F1)", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sr-rename-atomic-"));
    configPath = join(dir, "switchroom.yaml");
    writeFileSync(configPath, FIXTURE, { mode: 0o644 });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("round-trips: renames the agent block atomically and preserves mode", () => {
    renameAgentInConfig(configPath, "oldbot", "newbot");

    const after = readFileSync(configPath, "utf-8");
    // New slug present, old gone, sibling untouched.
    expect(after).toContain("newbot:");
    expect(after).not.toMatch(/^  oldbot:/m);
    expect(after).toContain("keepbot:");
    // Slug-prefixed vault ref + default memory.collection rewritten.
    expect(after).toContain("vault:newbot.bot_token");
    expect(after).toContain("collection: newbot");
    // Went through the atomic swap.
    expect(vi.mocked(fs.renameSync)).toHaveBeenCalled();
    // Mode preserved, no tempfile leaked.
    expect(statSync(configPath).mode & 0o777).toBe(0o644);
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toHaveLength(0);
  });

  // BITE: a hard rename(2) failure (ENOSPC — NOT one of the
  // EBUSY/EXDEV/EINVAL codes writeConfigFileSync falls back on) must leave
  // the PRIOR switchroom.yaml byte-for-byte intact and throw. The pre-fix
  // bare writeFileSync never called rename, so the mock never fired: it
  // truncated + rewrote the file in place with no throw. Both the throw and
  // the byte-intact assertion fail on the old code.
  it("leaves the prior config byte-intact when rename(2) fails mid-write", () => {
    const before = readFileSync(configPath, "utf-8");
    const beforeMode = statSync(configPath).mode & 0o777;

    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
    });

    expect(() => renameAgentInConfig(configPath, "oldbot", "newbot")).toThrow(/ENOSPC/);

    // Prior file untouched — not torn, not empty, not renamed.
    expect(readFileSync(configPath, "utf-8")).toBe(before);
    expect(statSync(configPath).mode & 0o777).toBe(beforeMode);
    // Tempfile cleaned up.
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toHaveLength(0);
  });
});
