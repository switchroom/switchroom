/**
 * Isolation tests for the worktree-collision fix (#claim-as-independent-clone).
 *
 * These assert the OUTCOMES that failed in production when claims were
 * `git worktree add` checkouts off a shared repo — every test here fails on
 * the old provisioning:
 *
 *   1. Two concurrent claims must NOT share a stash ref (a `git stash push`
 *      in one must be invisible to a `git stash pop` in the other).
 *   2. A claim must leave NO admin metadata in the source repo
 *      (`.git/worktrees/<name>` was where stale index state survived
 *      remove --force + rm -rf + prune and resurrected dirty trees).
 *   3. A checkout in a claim must not move the source repo's HEAD, and the
 *      claim must have its own git dir (no shared object/ref store).
 *   4. Release + re-claim of the same task name must yield a CLEAN tree.
 *   5. A /tmp checkout base is rejected in code (noexec in containers).
 *   6. Legacy `git worktree add` records are still releasable (shape-aware
 *      removal).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { claimWorktree, assertBaseDirNotTmp } from "../src/worktree/claim.js";
import { releaseWorktree } from "../src/worktree/release.js";
import { listRecords, writeRecord } from "../src/worktree/registry.js";
import { detectCheckoutKind } from "../src/worktree/remove-checkout.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf-8" }).trim();
}

function initTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sw-iso-repo-"));
  git(dir, "init");
  git(dir, "config", "user.email", "test@test.com");
  git(dir, "config", "user.name", "Test");
  writeFileSync(join(dir, "README.md"), "init\n");
  writeFileSync(join(dir, "shared.txt"), "shared content\n");
  git(dir, "add", ".");
  git(dir, "commit", "-m", "init");
  return dir;
}

describe("claim isolation — independent clones, no shared git state", () => {
  let repoDir: string;
  let base: string;
  const origReg = process.env.SWITCHROOM_WORKTREE_DIR;
  const origBase = process.env.SWITCHROOM_WORKTREE_BASE;
  const origAllowTmp = process.env.SWITCHROOM_WORKTREE_ALLOW_TMP;

  beforeEach(() => {
    repoDir = initTempRepo();
    base = mkdtempSync(join(tmpdir(), "sw-iso-test-"));
    process.env.SWITCHROOM_WORKTREE_DIR = join(base, "registry");
    process.env.SWITCHROOM_WORKTREE_BASE = join(base, "checkouts");
    // Fixtures live under tmpdir; don't let the production noexec guard
    // reject the test environment itself.
    process.env.SWITCHROOM_WORKTREE_ALLOW_TMP = "1";
  });

  afterEach(() => {
    for (const rec of listRecords()) {
      try { releaseWorktree({ id: rec.id }); } catch { /* best-effort */ }
    }
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(base, { recursive: true, force: true });
    if (origReg === undefined) delete process.env.SWITCHROOM_WORKTREE_DIR;
    else process.env.SWITCHROOM_WORKTREE_DIR = origReg;
    if (origBase === undefined) delete process.env.SWITCHROOM_WORKTREE_BASE;
    else process.env.SWITCHROOM_WORKTREE_BASE = origBase;
    if (origAllowTmp === undefined) delete process.env.SWITCHROOM_WORKTREE_ALLOW_TMP;
    else process.env.SWITCHROOM_WORKTREE_ALLOW_TMP = origAllowTmp;
  });

  it("two claims do NOT share a stash ref — a stash in one is invisible to the other", async () => {
    const a = await claimWorktree({ repo: repoDir, taskName: "worker-a" });
    const b = await claimWorktree({ repo: repoDir, taskName: "worker-b" });

    // Worker A stashes an in-flight edit.
    writeFileSync(join(a.path, "shared.txt"), "worker A's uncommitted change\n");
    git(a.path, "stash", "push", "-m", "worker-a-wip");
    expect(git(a.path, "stash", "list")).toContain("worker-a-wip");

    // Worker B's stash must be EMPTY — on shared-worktree provisioning
    // (the old behaviour) refs/stash is shared and B sees A's entry, and a
    // `git stash pop` in B would pop A's work into B's tree.
    expect(git(b.path, "stash", "list")).toBe("");
    expect(() => git(b.path, "stash", "pop")).toThrow();

    // And B's file is untouched.
    expect(git(b.path, "status", "--porcelain")).toBe("");

    // A can still pop its own stash intact.
    git(a.path, "stash", "pop");
    expect(git(a.path, "status", "--porcelain")).toContain("shared.txt");
  });

  it("claiming leaves NO worktree admin metadata in the source repo", async () => {
    await claimWorktree({ repo: repoDir, taskName: "meta-check" });
    // Old behaviour: .git/worktrees/<name> exists in the source repo — the
    // exact metadata that went stale and resurrected dirty state.
    const adminDir = join(repoDir, ".git", "worktrees");
    const entries = existsSync(adminDir) ? readdirSync(adminDir) : [];
    expect(entries).toEqual([]);
    // And `git worktree list` in the source shows only the source itself.
    const list = git(repoDir, "worktree", "list", "--porcelain");
    expect(list.split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
  });

  it("a claim has its own git dir and checkouts never move the source repo's HEAD", async () => {
    const sourceHeadBefore = git(repoDir, "rev-parse", "HEAD");
    const sourceBranchBefore = git(repoDir, "rev-parse", "--abbrev-ref", "HEAD");

    const a = await claimWorktree({ repo: repoDir, taskName: "own-gitdir" });
    expect(detectCheckoutKind(a.path)).toBe("clone");

    // The claim's git common dir resolves INSIDE the claim, not to the
    // source repo (a linked worktree resolves to the source's .git).
    const commonDir = git(a.path, "rev-parse", "--path-format=absolute", "--git-common-dir");
    expect(commonDir.startsWith(a.path)).toBe(true);

    // Detach / branch-switch inside the claim; source repo must not move.
    git(a.path, "checkout", "--detach", "HEAD");
    expect(git(repoDir, "rev-parse", "HEAD")).toBe(sourceHeadBefore);
    expect(git(repoDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(sourceBranchBefore);
  });

  it("origin in the claim points at the source repo's real remote", async () => {
    git(repoDir, "remote", "add", "origin", "https://github.com/example/upstream.git");
    const a = await claimWorktree({ repo: repoDir, taskName: "origin-rewire" });
    expect(git(a.path, "remote", "get-url", "origin")).toBe(
      "https://github.com/example/upstream.git",
    );
  });

  it("release + re-claim with the same task name yields a clean tree (no resurrected state)", async () => {
    const first = await claimWorktree({ repo: repoDir, taskName: "reuse-me" });
    // Dirty the tree the way the production failure did, then force-release.
    writeFileSync(join(first.path, "shared.txt"), "dirty leftover\n");
    writeFileSync(join(first.path, "junk.txt"), "junk\n");
    const rel = releaseWorktree({ id: first.id });
    expect(rel.released).toBe(true);
    expect(existsSync(first.path)).toBe(false);

    const second = await claimWorktree({ repo: repoDir, taskName: "reuse-me" });
    expect(git(second.path, "status", "--porcelain")).toBe("");
    expect(existsSync(join(second.path, "junk.txt"))).toBe(false);
  });

  it("rejects a checkout base under /tmp with a clear noexec error", async () => {
    delete process.env.SWITCHROOM_WORKTREE_ALLOW_TMP;
    process.env.SWITCHROOM_WORKTREE_BASE = join(tmpdir(), "sw-noexec-base");
    await expect(
      claimWorktree({ repo: repoDir, taskName: "tmp-reject" }),
    ).rejects.toThrow(/noexec/i);
    // No ghost record may survive the rejection.
    expect(listRecords()).toHaveLength(0);
  });

  it("assertBaseDirNotTmp rejects /tmp and /var/tmp, allows $HOME-shaped paths", () => {
    delete process.env.SWITCHROOM_WORKTREE_ALLOW_TMP;
    expect(() => assertBaseDirNotTmp("/tmp/checkouts")).toThrow(/noexec/i);
    expect(() => assertBaseDirNotTmp("/var/tmp/checkouts")).toThrow(/noexec/i);
    expect(() => assertBaseDirNotTmp("/home/agent/.switchroom/worktree-checkouts")).not.toThrow();
    process.env.SWITCHROOM_WORKTREE_ALLOW_TMP = "1";
    expect(() => assertBaseDirNotTmp("/tmp/checkouts")).not.toThrow();
  });

  it("legacy `git worktree add` records are still releasable (shape-aware removal)", () => {
    // Simulate a pre-fix claim: a real linked worktree + its registry record.
    const legacyPath = join(base, "checkouts", "legacy-wt");
    mkdirSync(join(base, "checkouts"), { recursive: true });
    execFileSync("git", ["worktree", "add", "-b", "task/legacy-1", legacyPath], {
      cwd: repoDir,
      stdio: "pipe",
    });
    expect(detectCheckoutKind(legacyPath)).toBe("worktree");
    const now = new Date().toISOString();
    writeRecord({
      id: "legacy01",
      repo: repoDir,
      repoName: repoDir,
      branch: "task/legacy-1",
      path: legacyPath,
      createdAt: now,
      heartbeatAt: now,
    });

    const rel = releaseWorktree({ id: "legacy01" });
    expect(rel.released).toBe(true);
    expect(existsSync(legacyPath)).toBe(false);
    // The source repo's admin entry is gone too (git did the removal).
    const adminDir = join(repoDir, ".git", "worktrees");
    const entries = existsSync(adminDir) ? readdirSync(adminDir) : [];
    expect(entries).toEqual([]);
  });
});
