/**
 * Atomicity tests for setVaultBrokerAutoUnlock (src/cli/vault-auto-unlock.ts).
 *
 * The 2026-07-11 durability review flagged the bare readFileSync → writeFileSync
 * (truncate-in-place) rewrite of switchroom.yaml: a crash / ENOSPC mid-write
 * truncates the fleet-wide config. The write now routes through the bind-mount-
 * aware writeConfigFileSync (tmp + fsync + rename, in-place fsync'd fallback
 * only on EBUSY/EXDEV/EINVAL). These tests assert the atomic outcome.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

// Mock node:fs so we can force renameSync(2) to fail (crash between the tmp
// write and the atomic swap) while leaving every other fs call real.
// writeConfigFileSync → atomicWriteFileSync imports renameSync from node:fs,
// so this mock reaches it. Mirrors src/util/atomic.test.ts.
vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    renameSync: vi.fn().mockImplementation(actual.renameSync),
  };
});

import { setVaultBrokerAutoUnlock } from "./vault-auto-unlock.js";

const SAMPLE = [
  "telegram:",
  "  bot_token: vault:telegram/bot_token",
  "agents:",
  "  klanker:",
  "    extends: default",
  "vault:",
  "  broker:",
  "    autoUnlock: false",
  "",
].join("\n");

describe("setVaultBrokerAutoUnlock — atomic switchroom.yaml write", () => {
  let dir: string;
  let cfg: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sr-autounlock-"));
    cfg = join(dir, "switchroom.yaml");
    writeFileSync(cfg, SAMPLE, { mode: 0o644 });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it("round-trips: sets vault.broker.autoUnlock and stays parseable", () => {
    setVaultBrokerAutoUnlock(cfg, true);
    const doc = YAML.parse(readFileSync(cfg, "utf-8"));
    expect(doc.vault.broker.autoUnlock).toBe(true);
    // Unrelated keys preserved.
    expect(doc.agents.klanker.extends).toBe("default");
    // Used the atomic rename path.
    expect(vi.mocked(fs.renameSync)).toHaveBeenCalled();
    // No tempfile leaked alongside the config.
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toHaveLength(0);
  });

  // BITE: a hard failure at the atomic swap (EPERM — NOT a bind-mount fallback
  // code) must rethrow and leave switchroom.yaml byte-for-byte intact. The
  // pre-fix bare writeFileSync truncated in place and never called renameSync,
  // so the mocked failure never fired: no throw, and the file was rewritten —
  // both assertions below fail on the old code.
  it("leaves switchroom.yaml intact when rename(2) fails mid-write", () => {
    const before = readFileSync(cfg, "utf-8");

    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });
    });

    expect(() => setVaultBrokerAutoUnlock(cfg, true)).toThrow(/EPERM/);

    // Fleet config unharmed — never truncated.
    expect(readFileSync(cfg, "utf-8")).toBe(before);
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toHaveLength(0);
  });

  it("preserves the file mode across the write", () => {
    fs.chmodSync(cfg, 0o600);
    setVaultBrokerAutoUnlock(cfg, true);
    expect(fs.statSync(cfg).mode & 0o777).toBe(0o600);
  });
});
