/**
 * Integration tests for claim/release/list.
 *
 * Uses a temp git repo fixture (git init in tmpdir) to avoid touching
 * the actual switchroom repo. Tests 3 parallel claims, verify each
 * gets a unique worktree + branch, no conflicts.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { claimWorktree } from "../src/worktree/claim.js";
import { releaseWorktree } from "../src/worktree/release.js";
import { listWorktrees } from "../src/worktree/list.js";
import { listRecords } from "../src/worktree/registry.js";

function initTempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "sw-repo-"));
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.email", "test@test.com"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir, stdio: "pipe" });
  // Need at least one commit so worktrees can branch off HEAD
  execFileSync("bash", ["-c", "echo 'init' > README.md"], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["add", "."], { cwd: dir, stdio: "pipe" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: dir, stdio: "pipe" });
  return dir;
}

describe("claim / release / list integration", () => {
  let repoDir: string;
  let regDir: string;
  let checkoutsDir: string;
  const origReg = process.env.SWITCHROOM_WORKTREE_DIR;
  const origBase = process.env.SWITCHROOM_WORKTREE_BASE;

  beforeEach(() => {
    repoDir = initTempRepo();
    const base = mkdtempSync(join(tmpdir(), "sw-int-test-"));
    regDir = join(base, "registry");
    checkoutsDir = join(base, "checkouts");
    mkdirSync(regDir, { recursive: true });
    mkdirSync(checkoutsDir, { recursive: true });
    process.env.SWITCHROOM_WORKTREE_DIR = regDir;
    process.env.SWITCHROOM_WORKTREE_BASE = checkoutsDir;
  });

  afterEach(() => {
    // Release all remaining worktrees (if any) before deleting dirs
    for (const rec of listRecords()) {
      try { releaseWorktree({ id: rec.id }); } catch { /* best-effort */ }
    }
    rmSync(repoDir, { recursive: true, force: true });
    // The checkouts parent
    try { rmSync(join(checkoutsDir, ".."), { recursive: true, force: true }); } catch { /* */ }
    if (origReg === undefined) delete process.env.SWITCHROOM_WORKTREE_DIR;
    else process.env.SWITCHROOM_WORKTREE_DIR = origReg;
    if (origBase === undefined) delete process.env.SWITCHROOM_WORKTREE_BASE;
    else process.env.SWITCHROOM_WORKTREE_BASE = origBase;
  });

  it("claim returns id, path, and branch", async () => {
    const result = await claimWorktree({ repo: repoDir, taskName: "my-feature" });
    expect(result.id).toBeTruthy();
    expect(result.path).toContain(checkoutsDir);
    expect(result.branch).toMatch(/^task\/my-feature-/);
  });

  it("3 parallel claims get unique ids, paths, and branches", async () => {
    const [r1, r2, r3] = await Promise.all([
      claimWorktree({ repo: repoDir, taskName: "feat" }),
      claimWorktree({ repo: repoDir, taskName: "feat" }),
      claimWorktree({ repo: repoDir, taskName: "feat" }),
    ]);

    // All IDs must be unique
    const ids = [r1.id, r2.id, r3.id];
    expect(new Set(ids).size).toBe(3);

    // All paths must be unique
    const paths = [r1.path, r2.path, r3.path];
    expect(new Set(paths).size).toBe(3);

    // All branches must be unique
    const branches = [r1.branch, r2.branch, r3.branch];
    expect(new Set(branches).size).toBe(3);

    // All branches follow the pattern
    for (const b of branches) {
      expect(b).toMatch(/^task\/feat-[a-f0-9]+$/);
    }

    // Registry should have 3 records
    const recs = listRecords();
    expect(recs).toHaveLength(3);
  });

  it("list_worktrees shows all active claims", async () => {
    await claimWorktree({ repo: repoDir, taskName: "task-a", ownerAgent: "worker1" });
    await claimWorktree({ repo: repoDir, taskName: "task-b", ownerAgent: "worker2" });

    const { worktrees } = listWorktrees();
    expect(worktrees).toHaveLength(2);
    const owners = worktrees.map(w => w.ownerAgent);
    expect(owners).toContain("worker1");
    expect(owners).toContain("worker2");
  });

  it("release removes the worktree and registry record", async () => {
    const claim = await claimWorktree({ repo: repoDir, taskName: "release-test" });
    expect(listRecords()).toHaveLength(1);

    const result = releaseWorktree({ id: claim.id });
    expect(result.released).toBe(true);
    expect(listRecords()).toHaveLength(0);
  });

  it("release is idempotent — releasing a missing id returns released:true", () => {
    const result = releaseWorktree({ id: "nonexistent-id" });
    expect(result.released).toBe(true);
  });

  it("respects concurrency cap", async () => {
    // Use codeRepos with concurrency 2
    const codeRepos = [{ name: "testrepo", source: repoDir, concurrency: 2 }];

    await claimWorktree({ repo: "testrepo" }, codeRepos);
    await claimWorktree({ repo: "testrepo" }, codeRepos);

    await expect(
      claimWorktree({ repo: "testrepo" }, codeRepos),
    ).rejects.toThrow(/concurrency cap/i);
  });

  it("resolves repo from code_repos alias", async () => {
    const codeRepos = [{ name: "myrepo", source: repoDir }];
    const result = await claimWorktree({ repo: "myrepo" }, codeRepos);
    expect(result.id).toBeTruthy();
    // The stored record should have the resolved absolute path
    const recs = listRecords();
    expect(recs[0].repo).toBe(repoDir);
    expect(recs[0].repoName).toBe("myrepo");
  });

  it("rejects unknown repo alias", async () => {
    await expect(
      claimWorktree({ repo: "unknown-alias" }),
    ).rejects.toThrow(/not declared/i);
  });
});
