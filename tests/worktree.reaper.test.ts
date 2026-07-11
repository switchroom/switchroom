/**
 * Tests for the worktree reaper.
 *
 * IMPORTANT: We do NOT use real git worktrees here. We simulate the
 * filesystem state so that the reaper's existsSync checks do the right thing.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeRecord, readRecord, listRecords } from "../src/worktree/registry.js";
import {
  runReaper,
  probePathInUse,
  STALE_THRESHOLD_MS,
  type ReaperDeps,
} from "../src/worktree/reaper.js";
import type { WorktreeRecord } from "../src/worktree/types.js";

/**
 * Deterministic default deps for the stale-reap path: the probe reports the
 * path as free and the tree is clean, so the reaper's ONLY remaining gate is
 * staleness. Individual fail-safe tests override one field to exercise a guard.
 * (Without this, the reaper would shell out to the host's real fuser/lsof/git,
 * making the outcome depend on which tools the CI box happens to have.)
 */
const REAP_ALLOWED: ReaperDeps = {
  probeInUse: () => "free",
  hasUncommittedChanges: () => false,
  removeWorktree: () => {},
};

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

  it("reaps a record with stale heartbeat (path free, tree clean)", () => {
    // Heartbeat is 11 minutes ago — over the 10-min threshold
    const staleAge = STALE_THRESHOLD_MS + 60_000;
    const rec = makeRecord("stale01", staleAge, true);
    writeRecord(rec);

    // Probe reports free + no uncommitted changes → the reaper removes it.
    const result = runReaper(undefined, REAP_ALLOWED);

    expect(result.reaped).toContain("stale01");
    expect(listRecords()).toHaveLength(0);
  });

  it("leaves fresh records intact while reaping stale ones", () => {
    const staleAge = STALE_THRESHOLD_MS + 60_000;
    const fresh = makeRecord("keepme", 60_000, true);
    const stale = makeRecord("reaped", staleAge, true);
    writeRecord(fresh);
    writeRecord(stale);

    const result = runReaper(undefined, REAP_ALLOWED);

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

  // ── Fail-safe: data-loss prevention (F1 / H3) ────────────────────────────

  it("does NOT force-remove a stale worktree that has UNCOMMITTED changes (real git)", () => {
    // Anchor test — uses the REAL hasUncommittedChanges + real git so it
    // fails at runtime against the pre-fix reaper (which only warned, then
    // force-removed anyway). The worktree path is a real git repo with an
    // untracked file, so `git status --porcelain` reports a dirty tree.
    const staleAge = STALE_THRESHOLD_MS + 60_000;
    const rec = makeRecord("dirty01", staleAge, true);
    // Turn the (already-existing) worktree dir into a git repo with a change.
    execFileSync("git", ["-C", rec.path, "init", "-q"], { stdio: "pipe" });
    writeFileSync(join(rec.path, "WIP.txt"), "uncommitted work\n");
    writeRecord(rec);

    // Real probe (fuser/lsof or "unavailable") — either way the dirty guard
    // fires FIRST and hard-skips, so the record must survive untouched.
    const result = runReaper();

    expect(result.reaped).not.toContain("dirty01");
    expect(listRecords().map((r) => r.id)).toContain("dirty01");
    // The skip is surfaced as a warning (not a silent drop).
    expect(result.warnings.some((w) => w.includes("UNCOMMITTED"))).toBe(true);
  });

  it("does NOT force-remove a stale worktree when the in-use probe is UNAVAILABLE (no fuser/lsof)", () => {
    const staleAge = STALE_THRESHOLD_MS + 60_000;
    const rec = makeRecord("noprobe01", staleAge, true);
    writeRecord(rec);

    // Simulate a host with neither fuser nor lsof installed. Tree is clean,
    // so the probe is the only remaining gate — and "unavailable" must be
    // treated as live (fail-safe), never reaped.
    const result = runReaper(undefined, {
      hasUncommittedChanges: () => false,
      probeInUse: () => "unavailable",
      removeWorktree: () => {
        throw new Error("must not force-remove when probe is unavailable");
      },
    });

    expect(result.reaped).not.toContain("noprobe01");
    expect(listRecords().map((r) => r.id)).toContain("noprobe01");
    expect(result.warnings.some((w) => w.includes("probe"))).toBe(true);
  });

  it("does NOT reap a stale worktree the probe reports as in-use", () => {
    const staleAge = STALE_THRESHOLD_MS + 60_000;
    const rec = makeRecord("inuse01", staleAge, true);
    writeRecord(rec);

    const result = runReaper(undefined, {
      hasUncommittedChanges: () => false,
      probeInUse: () => "in-use",
      removeWorktree: () => {
        throw new Error("must not force-remove a worktree that is in use");
      },
    });

    expect(result.reaped).not.toContain("inuse01");
    expect(listRecords().map((r) => r.id)).toContain("inuse01");
  });

  it("probePathInUse never reports an unheld dir as 'in-use' (host-independent)", () => {
    // Nothing holds an empty temp dir open, so the probe must be 'free' (a
    // probe ran and found no holder) or 'unavailable' (no probe installed) —
    // never a false 'in-use'. This pins the ENOENT-vs-nonzero-exit
    // distinction without depending on which tools the host has.
    const dir = join(checkoutsDir, "probe-free");
    mkdirSync(dir, { recursive: true });
    expect(["free", "unavailable"]).toContain(probePathInUse(dir));
  });
});
