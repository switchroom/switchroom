/**
 * `switchroom worktree capture` — outcome tests.
 *
 * The headline test builds a REAL git repo containing all four hazards a
 * `git bundle create --all` silently drops, captures it, clones from the
 * bundle, and asserts every hazard is recoverable from the clone. Asserting
 * that the bundle FILE EXISTS would pass against a `--all` bundle that lost
 * ~12,000 commits, which is the exact incident this verb exists to prevent —
 * so every assertion here reads content back out of an independent clone.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readFileSync,
  existsSync,
  openSync,
  ftruncateSync,
  closeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureCheckout,
  parseFsckUnreachableCommits,
  parseForEachRef,
  updateRefStdin,
  bundleFileName,
  rescueDestRoot,
  rescueRootIsFallback,
  restoreCommands,
  RESCUE_NS,
} from "../src/worktree/capture.js";

let root: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  }).trim();
}

/**
 * A checkout carrying every hazard:
 *   1. uncommitted change to a tracked file
 *   2. untracked file
 *   3. TWO stash entries (the older one is reachable only via the stash reflog)
 *   4. an unreachable commit left behind by `commit --amend`
 */
function makeHazardRepo(dir: string): { amended: string; oldStash: string; topStash: string } {
  git(root, "init", "-q", "-b", "main", dir);
  writeFileSync(join(dir, "tracked.txt"), "v1\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "one");

  // hazard 4: an amend orphans the pre-amend commit
  writeFileSync(join(dir, "tracked.txt"), "v2\n");
  git(dir, "commit", "-qam", "two");
  const amended = git(dir, "rev-parse", "HEAD");
  git(dir, "commit", "-q", "--amend", "-m", "two-amended");

  // hazard 3a: an older stash entry (survives only via the stash reflog)
  writeFileSync(join(dir, "stash-old.txt"), "old-stash-content\n");
  git(dir, "add", "stash-old.txt");
  git(dir, "stash", "-q");
  const oldStash = git(dir, "rev-parse", "refs/stash");

  // hazard 3b: the top stash entry
  writeFileSync(join(dir, "stash-new.txt"), "new-stash-content\n");
  git(dir, "add", "stash-new.txt");
  git(dir, "stash", "-q");
  const topStash = git(dir, "rev-parse", "refs/stash");

  // hazards 1 + 2
  writeFileSync(join(dir, "tracked.txt"), "v2-uncommitted\n");
  writeFileSync(join(dir, "untracked.txt"), "untracked-content\n");
  // ignored files must NOT be captured
  writeFileSync(join(dir, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(dir, "ignored.txt"), "junk\n");

  return { amended, oldStash, topStash };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "capture-test-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("captureCheckout — four-hazard round trip", () => {
  it("recovers uncommitted changes, untracked files, every stash entry and unreachable commits from the bundle", () => {
    const repo = join(root, "repo");
    const { amended, oldStash, topStash } = makeHazardRepo(repo);

    // Sanity: this is exactly the tree that fools the usual safety checks —
    // git reports the working tree as having only the two visible hazards,
    // and the orphaned commit is invisible to a default fsck.
    expect(git(repo, "fsck", "--unreachable", "--no-progress")).not.toContain(amended);

    const dest = join(root, "rescue");
    const result = captureCheckout({ dir: repo, dest });

    expect(result.ok).toBe(true);
    expect(result.verified).toBe(true);
    expect(result.bundle).not.toBeNull();
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.deleted).toBe(false);
    expect(existsSync(repo)).toBe(true); // capture alone never deletes

    // ── restore path 1: plain clone → the working tree comes back ──────────
    const restored = join(root, "restored");
    git(root, "clone", "-q", result.bundle!, restored);

    // hazard 1: uncommitted change to a tracked file
    expect(readFileSync(join(restored, "tracked.txt"), "utf-8")).toBe("v2-uncommitted\n");
    // hazard 2: untracked file
    expect(readFileSync(join(restored, "untracked.txt"), "utf-8")).toBe("untracked-content\n");
    // ignored files are deliberately NOT carried
    expect(existsSync(join(restored, "ignored.txt"))).toBe(false);
    expect(git(restored, "rev-parse", "--abbrev-ref", "HEAD")).toBe("rescued-wip");

    // ── restore path 2: mirror clone → everything else ────────────────────
    const mirror = join(root, "mirror.git");
    git(root, "clone", "-q", "--mirror", result.bundle!, mirror);

    // hazard 4: the amended-away commit, with its content
    const unreachableRef = `${RESCUE_NS}/unreachable/${amended}`;
    expect(git(mirror, "rev-parse", unreachableRef)).toBe(amended);
    expect(git(mirror, "show", `${amended}:tracked.txt`)).toBe("v2");
    expect(git(mirror, "log", "-1", "--format=%s", amended)).toBe("two");

    // hazard 3: BOTH stash entries — the top one and the reflog-only one
    expect(git(mirror, "rev-parse", `${RESCUE_NS}/stash/0`)).toBe(topStash);
    expect(git(mirror, "rev-parse", `${RESCUE_NS}/stash/1`)).toBe(oldStash);
    expect(git(mirror, "show", `${topStash}:stash-new.txt`)).toBe("new-stash-content");
    expect(git(mirror, "show", `${oldStash}:stash-old.txt`)).toBe("old-stash-content");

    // the ordinary history is still there too
    expect(git(mirror, "log", "-1", "--format=%s", "refs/heads/main")).toBe("two-amended");

    expect(result.refs.wip).toBe(true);
    expect(result.refs.stash).toBe(2);
    expect(result.refs.unreachable).toBeGreaterThanOrEqual(1);
  });

  it("proves the hazards are what a plain `git bundle create --all` loses", () => {
    // The control case. Without this, the round-trip test above could pass
    // against a naive implementation and nobody would know.
    const repo = join(root, "repo");
    const { amended, oldStash } = makeHazardRepo(repo);
    const naive = join(root, "naive.bundle");
    git(repo, "bundle", "create", naive, "--all");

    const clone = join(root, "naive.git");
    git(root, "clone", "-q", "--mirror", naive, clone);

    // uncommitted + untracked: absent from every ref in the naive bundle
    const heads = git(clone, "for-each-ref", "--format=%(refname)");
    expect(heads).not.toContain("rescued-wip");
    // the orphaned commit is simply not in the object store
    expect(() => git(clone, "cat-file", "-e", `${amended}^{commit}`)).toThrow();
    // and the older stash entry is gone with the reflog
    expect(() => git(clone, "cat-file", "-e", `${oldStash}^{commit}`)).toThrow();
  });
});

describe("captureCheckout — the source repo is not mutated", () => {
  it("leaves refs, HEAD, the index and the working tree exactly as they were", () => {
    const repo = join(root, "repo");
    makeHazardRepo(repo);
    const refsBefore = git(repo, "for-each-ref", "--format=%(objectname) %(refname)");
    const statusBefore = git(repo, "status", "--porcelain");
    const headBefore = git(repo, "rev-parse", "HEAD");
    // Read the index bytes LAST, with no git command in between: `git status`
    // legitimately rewrites the index to refresh stat data, so anything else
    // between the two reads would make this assertion measure the test.
    const indexBefore = readFileSync(join(repo, ".git", "index"));

    const result = captureCheckout({ dir: repo, dest: join(root, "rescue") });
    expect(result.ok).toBe(true);

    expect(readFileSync(join(repo, ".git", "index")).equals(indexBefore)).toBe(true);
    expect(git(repo, "for-each-ref", "--format=%(objectname) %(refname)")).toBe(refsBefore);
    expect(git(repo, "status", "--porcelain")).toBe(statusBefore);
    expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore);
    // no rescue refs leaked into the source
    expect(git(repo, "for-each-ref", "--format=%(refname)")).not.toContain("rescued");
  });

  it("leaves no staging directory behind in the destination", () => {
    const repo = join(root, "repo");
    makeHazardRepo(repo);
    const dest = join(root, "rescue");
    const result = captureCheckout({ dir: repo, dest });
    expect(result.ok).toBe(true);
    const leftovers = execFileSync("ls", ["-A", dest], { encoding: "utf-8" })
      .split("\n")
      .filter((f) => f.startsWith(".capture-"));
    expect(leftovers).toEqual([]);
  });
});

describe("captureCheckout — the verify gate", () => {
  it("deletes the checkout only after a verified capture", () => {
    const repo = join(root, "repo");
    makeHazardRepo(repo);
    const result = captureCheckout({ dir: repo, dest: join(root, "rescue"), deleteAfter: true });
    expect(result.verified).toBe(true);
    expect(result.deleted).toBe(true);
    expect(existsSync(repo)).toBe(false);

    // and the work is still recoverable from the bundle after the delete
    const restored = join(root, "restored");
    git(root, "clone", "-q", result.bundle!, restored);
    expect(readFileSync(join(restored, "untracked.txt"), "utf-8")).toBe("untracked-content\n");

    // the sidecar manifest records what ACTUALLY happened, deletion included
    const manifest = JSON.parse(readFileSync(`${result.bundle!}.json`, "utf-8"));
    expect(manifest.source).toBe(repo);
    expect(manifest.deleted).toBe(true);
    expect(manifest.verified).toBe(true);
  });

  it("does NOT delete when the bundle is truncated between write and verification", () => {
    const repo = join(root, "repo");
    makeHazardRepo(repo);
    const out = join(root, "rescue", "x.bundle");

    const result = captureCheckout({
      dir: repo,
      out,
      deleteAfter: true,
      // simulate a short write / full destination disk
      onBundleWritten: (p) => {
        const fd = openSync(p, "r+");
        ftruncateSync(fd, 200);
        closeSync(fd);
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failure).toBe("readback-failed");
    expect(result.verified).toBe(false);
    expect(result.deleted).toBe(false);
    expect(existsSync(repo)).toBe(true);
    expect(readFileSync(join(repo, "untracked.txt"), "utf-8")).toBe("untracked-content\n");
  });

  it("does NOT delete when a byte inside the pack is corrupted", () => {
    const repo = join(root, "repo");
    makeHazardRepo(repo);
    const out = join(root, "rescue", "y.bundle");

    const result = captureCheckout({
      dir: repo,
      out,
      deleteAfter: true,
      onBundleWritten: (p) => {
        const buf = readFileSync(p);
        buf[buf.length - 40] = buf[buf.length - 40]! ^ 0xff;
        writeFileSync(p, buf);
      },
    });

    expect(result.ok).toBe(false);
    expect(result.deleted).toBe(false);
    expect(existsSync(repo)).toBe(true);
  });

  it("`git bundle verify` alone would NOT have caught either — which is why the gate reads back", () => {
    // This is the load-bearing justification for the second half of the gate.
    // If a future change drops the readback and keeps only `bundle verify`,
    // the two tests above stop failing — unless this one pins the reason.
    const repo = join(root, "repo");
    makeHazardRepo(repo);
    const out = join(root, "rescue", "z.bundle");
    const good = captureCheckout({ dir: repo, out });
    expect(good.verified).toBe(true);

    const fd = openSync(out, "r+");
    ftruncateSync(fd, 200);
    closeSync(fd);

    const probe = join(root, "probe.git");
    git(root, "init", "-q", "--bare", probe);
    // verify calls the truncated file "okay"…
    expect(() => git(probe, "bundle", "verify", out)).not.toThrow();
    // …while the readback — the half that actually gates deletion — rejects it.
    expect(() => git(probe, "fetch", "-q", out, "refs/*:refs/*")).toThrow();
  });

  it("refuses to delete, and reports the failure, when the destination cannot be created", () => {
    const repo = join(root, "repo");
    makeHazardRepo(repo);
    // Parent is a FILE → ENOTDIR. Deterministic regardless of the uid the
    // suite runs as (a permission-based fixture is a no-op under root, which
    // is exactly how this verb runs on a fleet host).
    const blocker = join(root, "blocker");
    writeFileSync(blocker, "not a directory\n");
    const result = captureCheckout({
      dir: repo,
      dest: join(blocker, "rescue"),
      deleteAfter: true,
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("bundle-failed");
    expect(result.deleted).toBe(false);
    expect(existsSync(repo)).toBe(true);
  });
});

describe("captureCheckout — edge shapes", () => {
  it("refuses a directory that is not a git repository, deletes nothing, and names the alternative", () => {
    const plain = join(root, "orphan");
    execFileSync("mkdir", ["-p", plain]);
    writeFileSync(join(plain, "work.txt"), "precious\n");
    const result = captureCheckout({ dir: plain, dest: join(root, "rescue"), deleteAfter: true });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("not-a-git-repo");
    expect(result.deleted).toBe(false);
    expect(existsSync(join(plain, "work.txt"))).toBe(true);
    expect(result.error).toContain("tar");
  });

  it("refuses to write the bundle inside the checkout it is about to delete", () => {
    const repo = join(root, "self-swallow");
    makeHazardRepo(repo);
    const result = captureCheckout({
      dir: repo,
      out: join(repo, "rescue.bundle"),
      deleteAfter: true,
    });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("bundle-failed");
    expect(result.deleted).toBe(false);
    // The checkout — and the work in it — is still there.
    expect(existsSync(join(repo, "untracked.txt"))).toBe(true);
  });

  it("snapshots the working tree on a host with NO git identity configured", () => {
    // The hosts this verb runs on are the least likely to have a
    // `user.email`: a CI runner, a rescue shell, a fresh container. Without an
    // explicit identity `commit-tree` fails with "Committer identity unknown"
    // and hazards 1+2 are lost silently — capture would report
    // `nothing-to-capture` on a repo full of uncommitted work. This
    // reproduces that host by scrubbing every identity source from the
    // environment the capture child process inherits.
    const repo = join(root, "no-identity");
    makeHazardRepo(repo);

    const saved = { ...process.env };
    delete process.env.GIT_AUTHOR_NAME;
    delete process.env.GIT_AUTHOR_EMAIL;
    delete process.env.GIT_COMMITTER_NAME;
    delete process.env.GIT_COMMITTER_EMAIL;
    delete process.env.EMAIL;
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_SYSTEM = "/dev/null";
    let result;
    try {
      result = captureCheckout({ dir: repo, dest: join(root, "rescue") });
    } finally {
      for (const k of Object.keys(process.env)) delete process.env[k];
      Object.assign(process.env, saved);
    }

    expect(result.ok).toBe(true);
    expect(result.refs.wip).toBe(true);
    const restored = join(root, "restored");
    git(root, "clone", "-q", result.bundle!, restored);
    expect(readFileSync(join(restored, "untracked.txt"), "utf-8")).toBe("untracked-content\n");
    expect(readFileSync(join(restored, "tracked.txt"), "utf-8")).toBe("v2-uncommitted\n");
  });

  it("warns that submodule content is not in the bundle", () => {
    const repo = join(root, "with-submodule");
    makeHazardRepo(repo);
    writeFileSync(join(repo, ".gitmodules"), '[submodule "vendor"]\n\tpath = vendor\n');
    const result = captureCheckout({ dir: repo, dest: join(root, "rescue") });
    expect(result.ok).toBe(true);
    expect(result.warnings.join("\n")).toContain("submodule");
  });

  it("reports a missing directory instead of throwing", () => {
    const result = captureCheckout({ dir: join(root, "nope"), dest: join(root, "rescue") });
    expect(result.ok).toBe(false);
    expect(result.failure).toBe("missing");
  });

  it("captures a repo with NO commits but untracked work", () => {
    const repo = join(root, "fresh");
    git(root, "init", "-q", "-b", "main", repo);
    writeFileSync(join(repo, "only.txt"), "unborn-head-content\n");

    const result = captureCheckout({ dir: repo, dest: join(root, "rescue") });
    expect(result.ok).toBe(true);
    // HEAD is unborn but still symbolic, so the branch name is what to report.
    expect(result.head).toBe("main");
    expect(result.refs.source).toBe(0); // no refs exist yet
    expect(result.refs.wip).toBe(true); // …and the snapshot is the only tip

    const restored = join(root, "restored");
    git(root, "clone", "-q", result.bundle!, restored);
    expect(readFileSync(join(restored, "only.txt"), "utf-8")).toBe("unborn-head-content\n");
  });

  it("captures a detached HEAD without losing the checked-out commit", () => {
    const repo = join(root, "detached");
    makeHazardRepo(repo);
    const target = git(repo, "rev-parse", "HEAD");
    git(repo, "checkout", "-q", "--detach", target);
    // Delete the only branch so the commit is reachable ONLY via HEAD.
    git(repo, "branch", "-D", "main");

    const result = captureCheckout({ dir: repo, dest: join(root, "rescue") });
    expect(result.ok).toBe(true);
    expect(result.head).toContain("detached@");

    const mirror = join(root, "mirror.git");
    git(root, "clone", "-q", "--mirror", result.bundle!, mirror);
    expect(git(mirror, "cat-file", "-t", target)).toBe("commit");
  });

  it("captures a bare repo (no working tree, no snapshot)", () => {
    const src = join(root, "src");
    makeHazardRepo(src);
    const bare = join(root, "bare.git");
    git(root, "clone", "-q", "--bare", src, bare);

    const result = captureCheckout({ dir: bare, dest: join(root, "rescue") });
    expect(result.ok).toBe(true);
    expect(result.refs.wip).toBe(false);
    expect(result.refs.source).toBeGreaterThan(0);

    const mirror = join(root, "mirror.git");
    git(root, "clone", "-q", "--mirror", result.bundle!, mirror);
    expect(git(mirror, "log", "-1", "--format=%s", "refs/heads/main")).toBe("two-amended");
  });

  it("captures a linked git worktree, including its own uncommitted work", () => {
    const src = join(root, "src");
    makeHazardRepo(src);
    const linked = join(root, "linked");
    git(src, "worktree", "add", "-q", "-b", "side", linked);
    writeFileSync(join(linked, "linked-only.txt"), "linked-untracked\n");

    const result = captureCheckout({ dir: linked, dest: join(root, "rescue") });
    expect(result.ok).toBe(true);

    const restored = join(root, "restored");
    git(root, "clone", "-q", result.bundle!, restored);
    expect(readFileSync(join(restored, "linked-only.txt"), "utf-8")).toBe("linked-untracked\n");
  });

  it("does not overwrite a source branch that is already called rescued-wip", () => {
    const repo = join(root, "repo");
    makeHazardRepo(repo);
    git(repo, "branch", "rescued-wip");
    const decoy = git(repo, "rev-parse", "rescued-wip");

    const result = captureCheckout({ dir: repo, dest: join(root, "rescue") });
    expect(result.ok).toBe(true);

    const mirror = join(root, "mirror.git");
    git(root, "clone", "-q", "--mirror", result.bundle!, mirror);
    expect(git(mirror, "rev-parse", "refs/heads/rescued-wip")).toBe(decoy);
    expect(git(mirror, "rev-parse", "refs/heads/rescued-wip-2")).not.toBe(decoy);
  });
});

describe("pure helpers", () => {
  it("parseFsckUnreachableCommits keeps commits only, deduped", () => {
    const out = [
      "unreachable commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "unreachable tree bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "unreachable blob cccccccccccccccccccccccccccccccccccccccc",
      "dangling commit dddddddddddddddddddddddddddddddddddddddd",
      "unreachable commit aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "Checking object directories: 100% (256/256), done.",
      "",
    ].join("\n");
    expect(parseFsckUnreachableCommits(out)).toEqual([
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "dddddddddddddddddddddddddddddddddddddddd",
    ]);
  });

  it("parseForEachRef ignores malformed lines", () => {
    const out = [
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa refs/heads/main",
      "not-a-sha refs/heads/bad",
      "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb HEAD",
      "cccccccccccccccccccccccccccccccccccccccc refs/stash",
      "",
    ].join("\n");
    expect(parseForEachRef(out)).toEqual([
      { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ref: "refs/heads/main" },
      { sha: "cccccccccccccccccccccccccccccccccccccccc", ref: "refs/stash" },
    ]);
  });

  it("updateRefStdin emits one create line per ref, newline-terminated", () => {
    expect(updateRefStdin([{ sha: "abc1234", ref: "refs/x" }])).toBe("create refs/x abc1234\n");
    expect(updateRefStdin([])).toBe("");
  });

  it("bundleFileName is local-clock stamped and filesystem-safe", () => {
    const name = bundleFileName("/a/b/my repo!", new Date(2026, 7, 15, 9, 4, 5));
    expect(name).toBe("my-repo--20260815-090405.bundle");
  });

  it("rescueDestRoot honours SWITCHROOM_RESCUE_DIR, then the bulk volume, then HOME", () => {
    const prev = process.env.SWITCHROOM_RESCUE_DIR;
    try {
      process.env.SWITCHROOM_RESCUE_DIR = "/tmp/somewhere-else";
      expect(rescueDestRoot(() => ({}))).toBe("/tmp/somewhere-else");

      delete process.env.SWITCHROOM_RESCUE_DIR;
      // a volume that exists on every machine, standing in for /mnt/bulkdata
      expect(rescueDestRoot(() => ({ scratch: { volume: "/tmp" } }))).toBe(
        "/tmp/switchroom/rescue",
      );
      expect(rescueRootIsFallback(rescueDestRoot(() => ({ scratch: { volume: "/tmp" } })))).toBe(
        false,
      );

      // no bulk volume → root-disk fallback, flagged as such
      const fallback = rescueDestRoot(() => ({ scratch: { volume: "/definitely/not/mounted" } }));
      expect(rescueRootIsFallback(fallback)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.SWITCHROOM_RESCUE_DIR;
      else process.env.SWITCHROOM_RESCUE_DIR = prev;
    }
  });

  it("restoreCommands names both restore paths", () => {
    const [plain, mirror] = restoreCommands("/mnt/bulkdata/switchroom/rescue/foo-20260815-090405.bundle");
    expect(plain).toContain("git clone /mnt/bulkdata/switchroom/rescue/foo-20260815-090405.bundle");
    expect(mirror).toContain("--mirror");
    expect(mirror).toContain("foo-20260815-090405.git");
  });
});
