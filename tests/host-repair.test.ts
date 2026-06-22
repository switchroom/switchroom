/**
 * Tests for `switchroom host repair-mounts`.
 *
 * Covers:
 *  - planMountRepairs: detects the ~/.docker/cli-plugins/docker-compose
 *    empty-dir artifact (marks safe=true)
 *  - planMountRepairs: refuses a non-empty directory (safe=false)
 *  - planMountRepairs: refuses a regular file (safe=false, real plugin)
 *  - planMountRepairs: refuses a symlink (safe=false)
 *  - planMountRepairs: detects /state bogus auto-dir shape (safe=true)
 *  - planMountRepairs: refuses /state with non-bogus shape (safe=false)
 *  - planMountRepairs: refuses /state that isn't root-owned (safe=false)
 *  - isStateBogusAutoDir: shape-recognition unit test
 *  - applyMountRepairs: calls rmdir for safe rmdir items
 *  - applyMountRepairs: skips unsafe items
 *  - Dry-run invariant: planMountRepairs never returns a glob/wildcard path
 *  - applyMountRepairs: calls rmRf for rm-rf-state items
 */

import { describe, it, expect, vi } from "vitest";
import {
  planMountRepairs,
  applyMountRepairs,
  isStateBogusAutoDir,
  ARTIFACT_ALLOWLIST,
  type FsProbe,
  type ApplyDeps,
} from "../src/cli/host-repair.js";
import { homedir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal stat-like object returned by a probe. */
function fakeDir(uid = 0): ReturnType<FsProbe["lstat"]> {
  return {
    isDirectory: () => true,
    isFile: () => false,
    isSymbolicLink: () => false,
    uid,
  };
}

function fakeFile(uid = 1000): ReturnType<FsProbe["lstat"]> {
  return {
    isDirectory: () => false,
    isFile: () => true,
    isSymbolicLink: () => false,
    uid,
  };
}

function fakeSymlink(): ReturnType<FsProbe["lstat"]> {
  return {
    isDirectory: () => false,
    isFile: () => false,
    isSymbolicLink: () => true,
    uid: 0,
  };
}

/**
 * Build a FsProbe from a map of path → lstat result + readdir result.
 * Anything not in the map returns null.
 */
function buildProbe(
  stat: Record<string, ReturnType<FsProbe["lstat"]>>,
  dirs: Record<string, string[]> = {},
): FsProbe {
  return {
    lstat: (path) => stat[path] ?? null,
    readdir: (path) => dirs[path] ?? null,
  };
}

// ---------------------------------------------------------------------------
// Fixture: a clean host (no artifacts) — planMountRepairs returns []
// ---------------------------------------------------------------------------

describe("planMountRepairs — clean host", () => {
  it("returns no items when neither artifact path exists", () => {
    const probe = buildProbe({});
    const items = planMountRepairs(probe, { hostHome: "/home/op" });
    expect(items).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Artifact 1: ~/.docker/cli-plugins/docker-compose
// ---------------------------------------------------------------------------

describe("planMountRepairs — docker-compose plugin dir", () => {
  const hostHome = "/home/op";
  const artifactPath = ARTIFACT_ALLOWLIST.dockerComposePluginDir(hostHome);

  it("detects an empty directory as a safe artifact", () => {
    const probe = buildProbe({ [artifactPath]: fakeDir() }, { [artifactPath]: [] });
    const items = planMountRepairs(probe, { hostHome });

    expect(items).toHaveLength(1);
    const item = items[0];
    expect(item.path).toBe(artifactPath);
    expect(item.action).toBe("rmdir");
    expect(item.safe).toBe(true);
    expect(item.reason).toMatch(/empty directory/i);
  });

  it("refuses a non-empty directory (safe=false)", () => {
    const probe = buildProbe(
      { [artifactPath]: fakeDir() },
      { [artifactPath]: ["docker-compose"] },
    );
    const items = planMountRepairs(probe, { hostHome });

    expect(items).toHaveLength(1);
    expect(items[0].safe).toBe(false);
    expect(items[0].reason).toMatch(/non-empty/i);
  });

  it("refuses a regular file (the real plugin binary, safe=false)", () => {
    const probe = buildProbe({ [artifactPath]: fakeFile() });
    const items = planMountRepairs(probe, { hostHome });

    expect(items).toHaveLength(1);
    expect(items[0].safe).toBe(false);
    expect(items[0].reason).toMatch(/regular file/i);
  });

  it("refuses a symlink (safe=false)", () => {
    const probe = buildProbe({ [artifactPath]: fakeSymlink() });
    const items = planMountRepairs(probe, { hostHome });

    expect(items).toHaveLength(1);
    expect(items[0].safe).toBe(false);
    expect(items[0].reason).toMatch(/symlink/i);
  });

  it("uses the real homedir() when no hostHome override is supplied", () => {
    // Just check the path shape — no lstat in this run so no items returned.
    const probe = buildProbe({});
    const items = planMountRepairs(probe);
    expect(items).toHaveLength(0);
    // Confirm the expected path was probed by checking homedir() is the base.
    const expected = ARTIFACT_ALLOWLIST.dockerComposePluginDir(homedir());
    expect(expected).toContain(join(".docker", "cli-plugins", "docker-compose"));
  });
});

// ---------------------------------------------------------------------------
// Artifact 2: /state auto-dir tree
// ---------------------------------------------------------------------------

const STATE_PATH = "/state";

/** Build a probe that simulates the exact bogus /state shape from the outage. */
function buildBoguStateProbe(): FsProbe {
  return buildProbe(
    {
      [STATE_PATH]: fakeDir(0), // root-owned
      "/state/agent": fakeDir(0),
      "/state/agent/home": fakeDir(0),
      "/state/agent/home/.switchroom": fakeDir(0),
      "/state/agent/home/.switchroom/myagent": fakeDir(0),
    },
    {
      [STATE_PATH]: ["agent"],
      "/state/agent": ["home"],
      "/state/agent/home": [".switchroom"],
      "/state/agent/home/.switchroom": ["myagent"],
      "/state/agent/home/.switchroom/myagent": [],
    },
  );
}

describe("isStateBogusAutoDir", () => {
  it("recognises the exact outage auto-dir shape", () => {
    expect(isStateBogusAutoDir(buildBoguStateProbe())).toBe(true);
  });

  it("returns false when /state is missing", () => {
    expect(isStateBogusAutoDir(buildProbe({}))).toBe(false);
  });

  it("returns true for an empty /state directory", () => {
    const probe = buildProbe({ [STATE_PATH]: fakeDir(0) }, { [STATE_PATH]: [] });
    expect(isStateBogusAutoDir(probe)).toBe(true);
  });

  it("returns false when /state contains something other than 'agent'", () => {
    const probe = buildProbe(
      { [STATE_PATH]: fakeDir(0) },
      { [STATE_PATH]: ["agent", "realstuff"] },
    );
    expect(isStateBogusAutoDir(probe)).toBe(false);
  });

  it("returns false when a leaf in the .switchroom dir is a file (real content)", () => {
    const probe = buildProbe(
      {
        [STATE_PATH]: fakeDir(0),
        "/state/agent": fakeDir(0),
        "/state/agent/home": fakeDir(0),
        "/state/agent/home/.switchroom": fakeDir(0),
        "/state/agent/home/.switchroom/vault.enc": fakeFile(0),
      },
      {
        [STATE_PATH]: ["agent"],
        "/state/agent": ["home"],
        "/state/agent/home": [".switchroom"],
        "/state/agent/home/.switchroom": ["vault.enc"],
      },
    );
    expect(isStateBogusAutoDir(probe)).toBe(false);
  });
});

describe("planMountRepairs — /state artifact", () => {
  it("detects the bogus /state shape as a safe artifact", () => {
    const probe = buildBoguStateProbe();
    const items = planMountRepairs(probe, { hostHome: "/home/op" });

    const stateItem = items.find((i) => i.path === STATE_PATH);
    expect(stateItem).toBeDefined();
    expect(stateItem!.safe).toBe(true);
    expect(stateItem!.action).toBe("rm-rf-state");
    expect(stateItem!.reason).toMatch(/bogus/i);
  });

  it("refuses /state that isn't root-owned (safe=false)", () => {
    const probe = buildProbe(
      { [STATE_PATH]: fakeDir(1000) }, // user-owned
      { [STATE_PATH]: [] },
    );
    const items = planMountRepairs(probe, { hostHome: "/home/op" });

    const stateItem = items.find((i) => i.path === STATE_PATH);
    expect(stateItem).toBeDefined();
    expect(stateItem!.safe).toBe(false);
    expect(stateItem!.reason).toMatch(/not root-owned/i);
  });

  it("refuses a root-owned /state that doesn't match the bogus shape (safe=false)", () => {
    // /state exists, root-owned, but contains unexpected entries
    const probe = buildProbe(
      { [STATE_PATH]: fakeDir(0) },
      { [STATE_PATH]: ["something-real", "agent"] },
    );
    const items = planMountRepairs(probe, { hostHome: "/home/op" });

    const stateItem = items.find((i) => i.path === STATE_PATH);
    expect(stateItem).toBeDefined();
    expect(stateItem!.safe).toBe(false);
    expect(stateItem!.reason).toMatch(/real data/i);
  });

  it("refuses a non-directory /state (safe=false)", () => {
    const probe = buildProbe({ [STATE_PATH]: fakeFile(0) });
    const items = planMountRepairs(probe, { hostHome: "/home/op" });

    const stateItem = items.find((i) => i.path === STATE_PATH);
    expect(stateItem).toBeDefined();
    expect(stateItem!.safe).toBe(false);
    expect(stateItem!.reason).toMatch(/not a directory/i);
  });
});

// ---------------------------------------------------------------------------
// applyMountRepairs
// ---------------------------------------------------------------------------

describe("applyMountRepairs", () => {
  it("calls rmdir for safe rmdir items", () => {
    const rmdirFn = vi.fn();
    const rmRfFn = vi.fn();
    const deps: ApplyDeps = { rmdir: rmdirFn, rmRf: rmRfFn };

    const items = [
      {
        path: "/home/op/.docker/cli-plugins/docker-compose",
        action: "rmdir" as const,
        reason: "empty dir",
        safe: true,
      },
    ];

    const results = applyMountRepairs(items, deps);
    expect(rmdirFn).toHaveBeenCalledWith("/home/op/.docker/cli-plugins/docker-compose");
    expect(rmRfFn).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(true);
  });

  it("calls rmRf for safe rm-rf-state items", () => {
    const rmdirFn = vi.fn();
    const rmRfFn = vi.fn();
    const deps: ApplyDeps = { rmdir: rmdirFn, rmRf: rmRfFn };

    const items = [
      {
        path: "/state",
        action: "rm-rf-state" as const,
        reason: "bogus shape",
        safe: true,
      },
    ];

    const results = applyMountRepairs(items, deps);
    expect(rmRfFn).toHaveBeenCalledWith("/state");
    expect(rmdirFn).not.toHaveBeenCalled();
    expect(results[0].ok).toBe(true);
  });

  it("skips unsafe items and does not call any removal fn", () => {
    const rmdirFn = vi.fn();
    const rmRfFn = vi.fn();
    const deps: ApplyDeps = { rmdir: rmdirFn, rmRf: rmRfFn };

    const items = [
      {
        path: "/home/op/.docker/cli-plugins/docker-compose",
        action: "rmdir" as const,
        reason: "non-empty directory",
        safe: false,
      },
    ];

    const results = applyMountRepairs(items, deps);
    expect(rmdirFn).not.toHaveBeenCalled();
    expect(rmRfFn).not.toHaveBeenCalled();
    // unsafe items are skipped, nothing returned for them
    expect(results).toHaveLength(0);
  });

  it("captures errors and marks result ok=false without throwing", () => {
    const deps: ApplyDeps = {
      rmdir: () => {
        throw new Error("EACCES: permission denied");
      },
      rmRf: vi.fn(),
    };

    const items = [
      {
        path: "/some/path",
        action: "rmdir" as const,
        reason: "test",
        safe: true,
      },
    ];

    const results = applyMountRepairs(items, deps);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].error).toMatch(/EACCES/);
  });
});

// ---------------------------------------------------------------------------
// Invariant: planMountRepairs never proposes a glob or wildcard path
// ---------------------------------------------------------------------------

describe("planMountRepairs — path safety invariant", () => {
  it("never returns a path containing a glob or wildcard character", () => {
    // Run with both artifacts present (worst case)
    const hostHome = "/home/op";
    const artifactPath = ARTIFACT_ALLOWLIST.dockerComposePluginDir(hostHome);
    const probe = buildProbe(
      {
        [artifactPath]: fakeDir(0),
        [STATE_PATH]: fakeDir(0),
      },
      {
        [artifactPath]: [],
        [STATE_PATH]: ["agent"],
        "/state/agent": ["home"],
        "/state/agent/home": [".switchroom"],
        "/state/agent/home/.switchroom": [],
      },
    );

    const items = planMountRepairs(probe, { hostHome });
    for (const item of items) {
      // No glob characters
      expect(item.path).not.toMatch(/[*?[\]{}!]/);
      // No shell expansion characters
      expect(item.path).not.toMatch(/[~$`]/);
    }
  });

  it("never returns more paths than the known artifact allowlist size", () => {
    // The allowlist has exactly 2 entries; planMountRepairs can return at most 2 items
    const hostHome = "/home/op";
    const artifactPath = ARTIFACT_ALLOWLIST.dockerComposePluginDir(hostHome);
    const probe = buildBoguStateProbe();
    // Also add the docker artifact
    const statMap = {
      ...Object.fromEntries(
        Object.entries({
          [STATE_PATH]: fakeDir(0),
          "/state/agent": fakeDir(0),
          "/state/agent/home": fakeDir(0),
          "/state/agent/home/.switchroom": fakeDir(0),
        }),
      ),
      [artifactPath]: fakeDir(0),
    };
    const dirMap = {
      [STATE_PATH]: ["agent"],
      "/state/agent": ["home"],
      "/state/agent/home": [".switchroom"],
      "/state/agent/home/.switchroom": [],
      [artifactPath]: [],
    };
    const fullProbe = buildProbe(statMap, dirMap);
    const items = planMountRepairs(fullProbe, { hostHome });
    expect(items.length).toBeLessThanOrEqual(2);
  });
});
