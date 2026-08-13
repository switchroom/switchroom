/**
 * Isolation tests for per-agent STANDING trees (src/repos/agent-worktree.ts)
 * — the reconcile-path twin of the claim-path fix in PR #4659.
 *
 * These assert the OUTCOMES that fail when standing trees are provisioned
 * as `git worktree add` checkouts off the shared bare clone — every
 * isolation test here fails on the old provisioning:
 *
 *   1. Two agents' standing trees must NOT share a stash ref (a
 *      `git stash push` in one agent's tree must be invisible to a
 *      `git stash pop` in the other's).
 *   2. Provisioning must leave NO `.git/worktrees` admin metadata in the
 *      shared bare clone, and the tree must have its own git dir.
 *   3. `origin` in the tree points at the bare clone's real upstream.
 *   4. A legacy per-agent branch left in the bare (pre-fix provisioning)
 *      is preserved as the start point on re-provision.
 *   5. Reconcile still fast-forwards a clean tree, and leaves a dirty
 *      tree untouched.
 *   6. An agent dir under /tmp is rejected at provision time (noexec in
 *      agent containers).
 *   7. Removal is SHAPE-AWARE: both a clone-shaped tree and a
 *      PRE-EXISTING linked-worktree tree are removable, detected by
 *      filesystem shape, and the legacy removal cleans the bare's admin
 *      entry and per-agent branch.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  ensureAgentWorktree,
  removeAgentWorktree,
  agentWorktreePath,
} from "../src/repos/agent-worktree.js";
import { detectCheckoutKind } from "../src/worktree/remove-checkout.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, stdio: "pipe", encoding: "utf-8" }).trim();
}

describe("agent standing trees — independent clones, no shared git state", () => {
  let base: string;
  let upstream: string;
  let bare: string;
  const origAllowTmp = process.env.SWITCHROOM_WORKTREE_ALLOW_TMP;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "sw-agent-wt-"));
    // Upstream repo with a commit on main.
    upstream = join(base, "upstream");
    mkdirSync(upstream);
    git(upstream, "init", "-b", "main");
    git(upstream, "config", "user.email", "test@test.com");
    git(upstream, "config", "user.name", "Test");
    writeFileSync(join(upstream, "README.md"), "init\n");
    writeFileSync(join(upstream, "shared.txt"), "shared content\n");
    git(upstream, "add", ".");
    git(upstream, "commit", "-m", "init");
    // Shared bare clone — what ensureBareClone provisions.
    bare = join(base, "repos", "my-app.git");
    mkdirSync(join(base, "repos"), { recursive: true });
    execFileSync("git", ["clone", "--bare", "--quiet", upstream, bare], { stdio: "pipe" });
    // Fixtures live under tmpdir; don't let the production noexec guard
    // reject the test environment itself.
    process.env.SWITCHROOM_WORKTREE_ALLOW_TMP = "1";
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
    if (origAllowTmp === undefined) delete process.env.SWITCHROOM_WORKTREE_ALLOW_TMP;
    else process.env.SWITCHROOM_WORKTREE_ALLOW_TMP = origAllowTmp;
  });

  function agentDirFor(name: string): string {
    const dir = join(base, "agents", name);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("two agents' standing trees do NOT share a stash ref", () => {
    const aliceDir = agentDirFor("alice");
    const bobDir = agentDirFor("bob");
    const a = ensureAgentWorktree("alice", "my-app", bare, aliceDir);
    const b = ensureAgentWorktree("bob", "my-app", bare, bobDir);
    expect(a.dirty).toBe(false);
    expect(b.dirty).toBe(false);

    // Stash creates commits — give the trees an identity (CI runners have
    // no global git config).
    for (const p of [a.path, b.path]) {
      git(p, "config", "user.email", "test@test.com");
      git(p, "config", "user.name", "Test");
    }

    // Alice stashes an in-flight edit.
    writeFileSync(join(a.path, "shared.txt"), "alice's uncommitted change\n");
    git(a.path, "stash", "push", "-m", "alice-wip");
    expect(git(a.path, "stash", "list")).toContain("alice-wip");

    // Bob's stash must be EMPTY — on the old linked-worktree provisioning
    // both trees share the bare clone's single refs/stash, Bob sees Alice's
    // entry, and a `git stash pop` in Bob's tree pops Alice's work.
    expect(git(b.path, "stash", "list")).toBe("");
    expect(() => git(b.path, "stash", "pop")).toThrow();
    expect(git(b.path, "status", "--porcelain")).toBe("");

    // Alice can still pop her own stash intact.
    git(a.path, "stash", "pop");
    expect(git(a.path, "status", "--porcelain")).toContain("shared.txt");
  });

  it("provisioning leaves NO worktree admin metadata in the bare clone and the tree owns its git dir", () => {
    const a = ensureAgentWorktree("alice", "my-app", bare, agentDirFor("alice"));
    expect(detectCheckoutKind(a.path)).toBe("clone");
    // Old behaviour: the bare grows a worktrees/<name> admin entry.
    const adminDir = join(bare, "worktrees");
    const entries = existsSync(adminDir) ? readdirSync(adminDir) : [];
    expect(entries).toEqual([]);
    // The tree's git common dir resolves INSIDE the tree, not to the bare.
    const commonDir = git(a.path, "rev-parse", "--path-format=absolute", "--git-common-dir");
    expect(commonDir.startsWith(a.path)).toBe(true);
    // And it is on the expected branch.
    expect(git(a.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agent/alice/main");
    expect(a.branch).toBe("agent/alice/main");
  });

  it("origin in the tree points at the bare clone's real upstream", () => {
    const a = ensureAgentWorktree("alice", "my-app", bare, agentDirFor("alice"));
    // The bare's origin is the upstream path — the tree must inherit it,
    // not point at the local bare clone.
    expect(git(a.path, "remote", "get-url", "origin")).toBe(git(bare, "remote", "get-url", "origin"));
    expect(git(a.path, "remote", "get-url", "origin")).not.toBe(bare);
  });

  it("a legacy per-agent branch in the bare is preserved as the start point", () => {
    // Simulate pre-fix state: the bare carries agent/alice/main at a commit
    // AHEAD of main (work the old linked worktree committed to the bare).
    git(upstream, "checkout", "-b", "side");
    writeFileSync(join(upstream, "legacy.txt"), "legacy work\n");
    git(upstream, "add", ".");
    git(upstream, "commit", "-m", "legacy agent work");
    const legacySha = git(upstream, "rev-parse", "HEAD");
    git(upstream, "push", "--quiet", bare, "side:refs/heads/agent/alice/main");
    git(upstream, "checkout", "main");

    const a = ensureAgentWorktree("alice", "my-app", bare, agentDirFor("alice"));
    expect(git(a.path, "rev-parse", "HEAD")).toBe(legacySha);
    expect(existsSync(join(a.path, "legacy.txt"))).toBe(true);
  });

  it("a clean tree fast-forwards to upstream's default branch on re-ensure", () => {
    const agentDir = agentDirFor("alice");
    ensureAgentWorktree("alice", "my-app", bare, agentDir);

    // Upstream moves forward.
    writeFileSync(join(upstream, "new.txt"), "new\n");
    git(upstream, "add", ".");
    git(upstream, "commit", "-m", "upstream moves");
    const newSha = git(upstream, "rev-parse", "HEAD");

    const again = ensureAgentWorktree("alice", "my-app", bare, agentDir);
    expect(again.dirty).toBe(false);
    expect(git(again.path, "rev-parse", "HEAD")).toBe(newSha);
  });

  it("a dirty tree is left untouched (dirty: true, no reset)", () => {
    const agentDir = agentDirFor("alice");
    const a = ensureAgentWorktree("alice", "my-app", bare, agentDir);
    writeFileSync(join(a.path, "shared.txt"), "in-flight edit\n");

    const again = ensureAgentWorktree("alice", "my-app", bare, agentDir);
    expect(again.dirty).toBe(true);
    expect(git(again.path, "status", "--porcelain")).toContain("shared.txt");
  });

  it("rejects an agent dir under /tmp at provision time (noexec guard)", () => {
    delete process.env.SWITCHROOM_WORKTREE_ALLOW_TMP;
    const tmpAgentDir = join(tmpdir(), "sw-agent-wt-noexec-agent");
    expect(() => ensureAgentWorktree("alice", "my-app", bare, tmpAgentDir)).toThrow(/noexec/i);
    // Nothing was provisioned.
    expect(existsSync(agentWorktreePath(tmpAgentDir, "my-app"))).toBe(false);
  });

  it("a failed provision leaves NO partial tree behind", () => {
    // A bare of an EMPTY repo: the clone step succeeds but the branch
    // checkout has no start point and fails. The partial clone must be
    // removed — a leftover dir would be mistaken for an existing (dirty)
    // tree on every subsequent reconcile.
    const emptyUpstream = join(base, "empty-upstream");
    mkdirSync(emptyUpstream);
    git(emptyUpstream, "init", "-b", "main");
    const emptyBare = join(base, "repos", "empty.git");
    execFileSync("git", ["clone", "--bare", "--quiet", emptyUpstream, emptyBare], {
      stdio: "pipe",
    });

    const agentDir = agentDirFor("alice");
    expect(() => ensureAgentWorktree("alice", "empty", emptyBare, agentDir)).toThrow();
    expect(existsSync(agentWorktreePath(agentDir, "empty"))).toBe(false);
  });

  it("removes a clone-shaped standing tree", () => {
    const agentDir = agentDirFor("alice");
    const a = ensureAgentWorktree("alice", "my-app", bare, agentDir);
    expect(detectCheckoutKind(a.path)).toBe("clone");

    removeAgentWorktree("alice", "my-app", bare, agentDir);
    expect(existsSync(a.path)).toBe(false);
  });

  it("removes a PRE-EXISTING linked-worktree standing tree (shape-aware) and cleans the bare", () => {
    // Provision the OLD way: linked worktree + per-agent branch in the bare.
    const agentDir = agentDirFor("alice");
    const legacyPath = agentWorktreePath(agentDir, "my-app");
    mkdirSync(join(agentDir, "work"), { recursive: true });
    execFileSync(
      "git",
      ["worktree", "add", "--quiet", "-b", "agent/alice/main", legacyPath, "main"],
      { cwd: bare, stdio: "pipe" },
    );
    expect(detectCheckoutKind(legacyPath)).toBe("worktree");

    removeAgentWorktree("alice", "my-app", bare, agentDir);
    expect(existsSync(legacyPath)).toBe(false);
    // The bare's admin entry and the per-agent branch are gone.
    const adminDir = join(bare, "worktrees");
    const entries = existsSync(adminDir) ? readdirSync(adminDir) : [];
    expect(entries).toEqual([]);
    expect(() => git(bare, "rev-parse", "--verify", "refs/heads/agent/alice/main")).toThrow();
  });
});
