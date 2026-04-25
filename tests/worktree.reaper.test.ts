/**
 * Tests for the worktree reaper.
 *
 * IMPORTANT: We do NOT use real git worktrees here. We simulate the
 * filesystem state so that the reaper's existsSync checks do the right thing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeRecord, readRecord, listRecords } from "../src/worktree/registry.js";
import { runReaper, STALE_THRESHOLD_MS } from "../src/worktree/reaper.js";
import type { WorktreeRecord } from "../src/worktree/types.js";

describe("worktree reaper", () => {
  let tmpDir: string;
  let checkoutsDir: string;
  const origEnv = process.env.SWITCHROOM_WORKTREE_DIR;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "sw-reaper-test-"));
    checkoutsDir = join(tmpDir, "checkouts");
    mkdirSync(checkoutsDir, { recursive: true });
    process.env.SWITCHROOM_WORKTREE_DIR = tmpDir;
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origEnv === undefined) delete process.env.SWITCHROOM_WORKTREE_DIR;
    else process.env.SWITCHROOM_WORKTREE_DIR = origEnv;
  });

  function makeRecord(
    id: string,
    heartbeatAgoMs: number,
    worktreePathExists: boolean,
  ): WorktreeRecord {
    const now = Date.now();
    const heartbeatAt = new Date(now - heartbeatAgoMs).toISOString();
    const path = join(checkoutsDir, id);
    if (worktreePathExists) {
      mkdirSync(path, { recursive: true });
    }
    return {
      id,
      repo: "/fake/repo",
      repoName: "fake",
      branch: `task/test-${id}`,
      path,
      createdAt: new Date(now - heartbeatAgoMs).toISOString(),
      heartbeatAt,
    };
  }

  it("reaps a record whose path doesn't exist (orphan)", () => {
    const rec = makeRecord("orphan01", 0, false);
    writeRecord(rec);
    expect(listRecords()).toHaveLength(1);

    const result = runReaper();

    expect(result.reaped).toContain("orphan01");
    expect(listRecords()).toHaveLength(0);
  });

  it("does NOT reap a record with fresh heartbeat even if path exists", () => {
    const rec = makeRecord("fresh01", 60_000, true); // 1 min ago — fresh
    writeRecord(rec);

    const result = runReaper();

    expect(result.reaped).not.toContain("fresh01");
    expect(listRecords()).toHaveLength(1);
  });

  it("reaps a record with stale heartbeat (path exists, no fuser)", () => {
    // Heartbeat is 11 minutes ago — over the 10-min threshold
    const staleAge = STALE_THRESHOLD_MS + 60_000;
    const rec = makeRecord("stale01", staleAge, true);
    writeRecord(rec);

    // The reaper will try `git worktree remove --force` which will fail
    // on a fake path, but it should still delete the registry record.
    // It also tries `fuser` which will return false for our tmp dir.
    const result = runReaper();

    expect(result.reaped).toContain("stale01");
    expect(listRecords()).toHaveLength(0);
  });

  it("leaves fresh records intact while reaping stale ones", () => {
    const staleAge = STALE_THRESHOLD_MS + 60_000;
    const fresh = makeRecord("keepme", 60_000, true);
    const stale = makeRecord("reaped", staleAge, true);
    writeRecord(fresh);
    writeRecord(stale);

    const result = runReaper();

    expect(result.reaped).toContain("reaped");
    expect(result.reaped).not.toContain("keepme");
    const remaining = listRecords();
    expect(remaining.map(r => r.id)).toContain("keepme");
    expect(remaining.map(r => r.id)).not.toContain("reaped");
  });

  it("reaper is idempotent — double-run on empty registry is safe", () => {
    const r1 = runReaper();
    const r2 = runReaper();
    expect(r1.reaped).toHaveLength(0);
    expect(r2.reaped).toHaveLength(0);
  });

  it("reaper with multiple orphans reaps all of them", () => {
    writeRecord(makeRecord("orphan-a", 0, false));
    writeRecord(makeRecord("orphan-b", 0, false));
    writeRecord(makeRecord("orphan-c", 0, false));

    const result = runReaper();

    expect(result.reaped.sort()).toEqual(["orphan-a", "orphan-b", "orphan-c"]);
    expect(listRecords()).toHaveLength(0);
  });
});
