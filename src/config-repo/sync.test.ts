import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  lstatSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  runConfigRepoSync,
  runConfigRepoSyncLocked,
  defaultSyncDeps,
  parseGitHubSlug,
  guardedCopyFile,
  type ConfigRepoSyncDeps,
  type CmdRunner,
} from "./sync.js";

/** Run git in a repo and assert success (setup helper). */
function git(repo: string, args: string[]): string {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
  if (r.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  }
  return (r.stdout ?? "").trim();
}

/** Every file git currently tracks in the repo. */
function trackedFiles(repo: string): string[] {
  return git(repo, ["ls-files"]).split("\n").filter(Boolean);
}

let base: string;
let repo: string;
let live: string;
let agentsDir: string;
const logs: string[] = [];

/** A gh stub whose visibility answer is set per test. */
function ghStub(visibility: "private" | "public" | "error"): CmdRunner {
  return (args) => {
    // Only the `api repos/<owner>/<repo> --jq .private` shape is exercised.
    if (visibility === "error") return { ok: false, stdout: "", stderr: "gh not authed" };
    return { ok: true, stdout: visibility === "private" ? "true" : "false", stderr: "" };
  };
}

function deps(gh: CmdRunner): ConfigRepoSyncDeps {
  const real = defaultSyncDeps(repo, (m) => logs.push(m));
  return { git: real.git, gh, log: (m) => logs.push(m) };
}

beforeEach(() => {
  logs.length = 0;
  base = mkdtempSync(join(tmpdir(), "config-repo-sync-"));
  repo = join(base, "repo");
  live = join(base, "live");
  agentsDir = join(live, "agents");

  // --- config repo (git) ---
  mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "test@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  // Blanket agents/ ignore, exactly like the operator's real config repo.
  writeFileSync(join(repo, ".gitignore"), "agents/\nvault.enc\n");
  writeFileSync(join(repo, "README.md"), "# config\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  // A GitHub remote so the private-gate path is exercised.
  git(repo, ["remote", "add", "origin", "https://github.com/acme/switchroom-config.git"]);

  // --- live tree ---
  const ws = join(agentsDir, "klanker", "workspace");
  mkdirSync(join(ws, "memory"), { recursive: true });
  writeFileSync(join(ws, "SOUL.md"), "persona\n");
  writeFileSync(join(ws, "memory", "2026-08-06.md"), "daily notes\n");
  writeFileSync(join(live, "switchroom.yaml"), "switchroom:\n  version: 1\n");

  // A mirrored personal skill already on disk in the repo (agents mirror
  // writes directly into their slice) — blanket-ignored, so untracked.
  const ps = join(repo, "agents", "klanker", "personal-skills", "foo");
  mkdirSync(ps, { recursive: true });
  writeFileSync(join(ps, "SKILL.md"), "---\nname: foo\ndescription: a skill\n---\nbody\n");
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

const baseOpts = () => ({
  repoPath: repo,
  livePath: join(live, "switchroom.yaml"),
  agentsDir,
  push: true,
  remote: "origin",
  requirePrivate: true,
});

describe("config-repo sync — GAP A + core invariants", () => {
  it("tracks mirrored personal skills (ls-files goes zero -> non-zero) and commits workspace state", () => {
    // RED-WITHOUT-FIX baseline: before sync, no personal-skill file is tracked.
    expect(trackedFiles(repo).filter((f) => f.includes("personal-skills"))).toHaveLength(0);

    const res = runConfigRepoSync(baseOpts(), deps(ghStub("private")));

    expect(res.committed).toBe(true);
    const tracked = trackedFiles(repo);
    // GAP A closed: the personal skill is now tracked.
    expect(tracked).toContain("agents/klanker/personal-skills/foo/SKILL.md");
    // Workspace owned file + memory captured.
    expect(tracked).toContain("agents/klanker/workspace/SOUL.md");
    expect(tracked).toContain("agents/klanker/workspace/memory/2026-08-06.md");
    // yaml copied in.
    expect(tracked).toContain("switchroom.yaml");
  });

  it("stores switchroom.yaml as a REGULAR FILE, not a symlink (rename() trap)", () => {
    // Even if a prior 'simplification' left a symlink, sync must replace it.
    const repoYaml = join(repo, "switchroom.yaml");
    symlinkSync(join(live, "switchroom.yaml"), repoYaml);
    expect(lstatSync(repoYaml).isSymbolicLink()).toBe(true);

    runConfigRepoSync(baseOpts(), deps(ghStub("private")));

    expect(lstatSync(repoYaml).isSymbolicLink()).toBe(false);
    expect(readFileSync(repoYaml, "utf-8")).toContain("version: 1");
  });

  it("withholds a planted secret from the commit and exits with a WARN", () => {
    // A secret arrives by a direct rw-mount write into a personal-skill slice,
    // bypassing the in-container CLI scan.
    const evil = join(repo, "agents", "klanker", "personal-skills", "evil");
    mkdirSync(evil, { recursive: true });
    writeFileSync(
      join(evil, "SKILL.md"),
      "---\nname: evil\ndescription: leaks\n---\ntoken ghp_ABCDEFGHIJ0123456789KLMNOPqrst here\n",
    );

    const res = runConfigRepoSync(baseOpts(), deps(ghStub("private")));

    expect(res.secretFindings.length).toBeGreaterThan(0);
    expect(res.exitCode).toBe(10);
    // The offending file is NOT tracked; the clean skill still is.
    const tracked = trackedFiles(repo);
    expect(tracked).not.toContain("agents/klanker/personal-skills/evil/SKILL.md");
    expect(tracked).toContain("agents/klanker/personal-skills/foo/SKILL.md");
  });

  it("skips a workspace symlink that escapes the agent tree", () => {
    // MEMORY.md -> outside the agent workspace (e.g. a credentials env file).
    const secretOutside = join(base, "outside-secret.env");
    writeFileSync(secretOutside, "API_KEY=ghp_ZZZZZZZZZZ0123456789ZZZZZZZZ\n");
    const ws = join(agentsDir, "klanker", "workspace");
    symlinkSync(secretOutside, join(ws, "MEMORY.md"));

    const res = runConfigRepoSync(baseOpts(), deps(ghStub("private")));

    expect(res.skippedSymlinks.some((s) => s.file.endsWith("MEMORY.md"))).toBe(true);
    // The escaping target's content never reaches the repo.
    expect(existsSync(join(repo, "agents", "klanker", "workspace", "MEMORY.md"))).toBe(false);
    expect(trackedFiles(repo)).not.toContain("agents/klanker/workspace/MEMORY.md");
  });

  it("commits nothing on a second run with no changes", () => {
    const first = runConfigRepoSync(baseOpts(), deps(ghStub("private")));
    expect(first.committed).toBe(true);

    const second = runConfigRepoSync(baseOpts(), deps(ghStub("private")));
    expect(second.committed).toBe(false);
  });

  it("refuses to push when require_private and the remote is PUBLIC (commit still lands)", () => {
    const res = runConfigRepoSync(baseOpts(), deps(ghStub("public")));

    expect(res.committed).toBe(true);
    expect(res.pushed).toBe(false);
    expect(res.pushSkippedReason).toMatch(/PUBLIC/i);
    expect(res.exitCode).toBe(10);
  });

  it("refuses to push when the visibility probe is unreachable (fail-safe)", () => {
    const res = runConfigRepoSync(baseOpts(), deps(ghStub("error")));
    expect(res.pushed).toBe(false);
    expect(res.pushSkippedReason).toMatch(/could not confirm/i);
  });

  it("never commits or leaves the .sync.lock (flock file) tracked", () => {
    const res = runConfigRepoSyncLocked({ ...baseOpts(), push: false }, deps(ghStub("private")));
    expect(res.committed).toBe(true);
    expect(trackedFiles(repo)).not.toContain(".sync.lock");
    // Lock released after the run.
    expect(existsSync(join(repo, ".sync.lock"))).toBe(false);
  });

  it("skips a workspace file reached through an escaping intermediate DIR symlink", () => {
    // memory/ is itself a symlink out to a credentials dir.
    const outsideDir = join(base, "creds");
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(join(outsideDir, "leak.md"), "API_KEY=ghp_AAAAAAAAAA0123456789BBBBBBBB\n");
    const ws = join(agentsDir, "klanker", "workspace");
    rmSync(join(ws, "memory"), { recursive: true, force: true });
    symlinkSync(outsideDir, join(ws, "memory"));

    const res = runConfigRepoSync(baseOpts(), deps(ghStub("private")));
    // The escaping dir's content never reaches the repo.
    expect(existsSync(join(repo, "agents", "klanker", "workspace", "memory", "leak.md"))).toBe(false);
    expect(res.skippedSymlinks.some((s) => s.file.includes("memory"))).toBe(true);
  });

  it("does not attempt the private gate at all when push:false", () => {
    const res = runConfigRepoSync({ ...baseOpts(), push: false }, deps(ghStub("public")));
    expect(res.committed).toBe(true);
    expect(res.pushed).toBe(false);
    expect(res.pushSkippedReason).toBeUndefined();
    expect(res.exitCode).toBe(0);
  });
});

describe("parseGitHubSlug", () => {
  it("parses https and ssh remotes", () => {
    expect(parseGitHubSlug("https://github.com/acme/repo.git")).toEqual({ owner: "acme", repo: "repo" });
    expect(parseGitHubSlug("git@github.com:acme/repo.git")).toEqual({ owner: "acme", repo: "repo" });
    expect(parseGitHubSlug("https://github.com/acme/repo")).toEqual({ owner: "acme", repo: "repo" });
  });
  it("returns null for a non-GitHub remote", () => {
    expect(parseGitHubSlug("https://gitlab.com/acme/repo.git")).toBeNull();
  });
});

describe("guardedCopyFile", () => {
  it("copies a regular file inside the tree", () => {
    const root = mkdtempSync(join(tmpdir(), "guard-"));
    writeFileSync(join(root, "a.md"), "hi");
    const dest = join(root, "out", "a.md");
    expect(guardedCopyFile(join(root, "a.md"), dest, root).status).toBe("copied");
    expect(readFileSync(dest, "utf-8")).toBe("hi");
    rmSync(root, { recursive: true, force: true });
  });

  it("refuses a symlink whose target escapes the tree", () => {
    const outer = mkdtempSync(join(tmpdir(), "guard-outer-"));
    const root = join(outer, "root");
    mkdirSync(root);
    writeFileSync(join(outer, "secret.env"), "K=v");
    symlinkSync(join(outer, "secret.env"), join(root, "link.md"));
    expect(guardedCopyFile(join(root, "link.md"), join(root, "out.md"), root).status).toBe("escape");
    rmSync(outer, { recursive: true, force: true });
  });
});
