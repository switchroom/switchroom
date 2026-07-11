/**
 * F3 atomicity coverage for reconcileAgent's settings.json + .mcp.json
 * writers (src/agents/scaffold.ts).
 *
 * reconcileAgent read-modify-writes each agent's `.claude/settings.json`
 * and `.mcp.json` on every `switchroom agent reconcile`. Both were bare
 * in-place `writeFileSync(..., { mode: 0o600 })` calls — the same torn-JSON
 * risk M5 already fixed elsewhere: a crash / ENOSPC mid-write leaves a
 * truncated file that Claude Code then fails to parse. Both sites now route
 * through atomicWriteFileSync (tmp + fsync + rename), preserving mode 0600.
 *
 * reconcileAgent itself needs a fully-scaffolded agent directory (a heavy
 * integration fixture with no precedent in this suite), so F3 is covered
 * two ways:
 *   1. A source-integrity guard that BITES if either reconcile writer is
 *      reverted to a truncating writeFileSync (deterministic regression
 *      fence, not prompt discipline).
 *   2. A functional round-trip + crash-bite of the exact mechanism the two
 *      sites invoke — atomicWriteFileSync(path, json, 0o600).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    renameSync: vi.fn().mockImplementation(actual.renameSync),
  };
});

import { atomicWriteFileSync } from "../util/atomic.js";

const SCAFFOLD_SRC = fileURLToPath(new URL("./scaffold.ts", import.meta.url));

describe("reconcileAgent settings.json + .mcp.json — atomic writers (F3)", () => {
  // GUARD: both reconcile write sites must go through atomicWriteFileSync
  // with mode 0600, and neither may use a truncating writeFileSync on its
  // path variable. Reverting either to writeFileSync fails this test.
  it("routes both reconcile JSON writers through atomicWriteFileSync (source guard)", () => {
    const src = readFileSync(SCAFFOLD_SRC, "utf-8");

    // settings.json reconcile writer
    expect(src).toContain("atomicWriteFileSync(settingsPath, after, 0o600)");
    expect(src).not.toContain("writeFileSync(settingsPath, after");
    // .mcp.json reconcile writer
    expect(src).toContain("atomicWriteFileSync(mcpJsonPath, after, 0o600)");
    expect(src).not.toContain("writeFileSync(mcpJsonPath, after");
  });

  describe("mechanism — atomicWriteFileSync at 0o600 (settings.json / .mcp.json)", () => {
    let dir: string;
    let p: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "sr-reconcile-atomic-"));
      p = join(dir, "settings.json");
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
      vi.clearAllMocks();
    });

    it("round-trips JSON content and preserves mode 0600", () => {
      const json = JSON.stringify({ mcpServers: {}, model: "sonnet" }, null, 2) + "\n";
      atomicWriteFileSync(p, json, 0o600);

      expect(readFileSync(p, "utf-8")).toBe(json);
      expect(JSON.parse(readFileSync(p, "utf-8"))).toEqual({ mcpServers: {}, model: "sonnet" });
      expect(vi.mocked(fs.renameSync)).toHaveBeenCalled();
      expect(statSync(p).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toHaveLength(0);
    });

    // BITE: crash at the atomic swap leaves the PRIOR settings.json
    // byte-intact — never torn — so the JSON.parse the reconcile flow does
    // on the next run sees valid old content, not corruption.
    it("leaves the prior JSON byte-intact when rename(2) fails mid-write", () => {
      const original = JSON.stringify({ mcpServers: { old: {} } }, null, 2) + "\n";
      writeFileSync(p, original, { mode: 0o600 });

      vi.mocked(fs.renameSync).mockImplementationOnce(() => {
        throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
      });

      const next = JSON.stringify({ mcpServers: { new: {} } }, null, 2) + "\n";
      expect(() => atomicWriteFileSync(p, next, 0o600)).toThrow(/EPERM/);

      expect(readFileSync(p, "utf-8")).toBe(original);
      expect(statSync(p).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toHaveLength(0);
    });
  });
});
