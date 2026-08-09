import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HOST_CLI_STAMP_FILENAME,
  buildHostCliStamp,
  compareHostCliToTarget,
  hostCliConvergedOnTarget,
  hostCliInstallCommand,
  hostCliInstallShellCommand,
  npmPackageRoot,
  npmPrefixFromScriptPath,
  readHostCliStamp,
  refreshHostCliStamp,
  resolveStampDir,
  shouldRefuseStaleHostCli,
  stampHomeCandidates,
  type HostCliStamp,
} from "./host-cli-stamp.js";

/**
 * Scope every existence probe to `<tmpdir>` so the resolver can never fall
 * through to the real `/host-home/.switchroom` (which is a REAL operator home
 * on a switchroom host, and a test that writes there corrupts a running
 * fleet). Not defensive dressing: without it, `resolveStampDir`'s
 * container-mount fallback resolved to the live home on the first run of this
 * suite.
 */
function scopedIo(home: string) {
  const root = tmpdir();
  return {
    env: {} as NodeJS.ProcessEnv,
    home,
    exists: (p: string) => p.startsWith(root) && existsSync(p),
  };
}

/** A tmp switchroom home (`<tmp>/.switchroom/switchroom.yaml`). */
function makeHome(): { home: string; dir: string } {
  const home = mkdtempSync(join(tmpdir(), "host-cli-stamp-"));
  const dir = join(home, ".switchroom");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "switchroom.yaml"), "switchroom:\n  version: 1\n", "utf8");
  return { home, dir };
}

/** The reference host's shape: nvm prefix, operator-owned, NOT root. */
const NVM_SCRIPT =
  "/home/op/.nvm/versions/node/v22.22.2/lib/node_modules/switchroom/dist/cli/switchroom.js";

describe("npm prefix + package root derivation", () => {
  it("derives the npm prefix from an nvm-installed entrypoint", () => {
    expect(npmPrefixFromScriptPath(NVM_SCRIPT)).toBe(
      "/home/op/.nvm/versions/node/v22.22.2",
    );
    expect(npmPackageRoot(NVM_SCRIPT)).toBe(
      "/home/op/.nvm/versions/node/v22.22.2/lib/node_modules/switchroom",
    );
  });

  it("derives the prefix from a root /usr/local npm install too", () => {
    const p = "/usr/local/lib/node_modules/switchroom/dist/cli/switchroom.js";
    expect(npmPrefixFromScriptPath(p)).toBe("/usr/local");
  });

  it("returns undefined rather than inventing a prefix for a non-npm path", () => {
    expect(npmPrefixFromScriptPath("/usr/local/bin/switchroom")).toBeUndefined();
    expect(npmPackageRoot("/usr/local/bin/switchroom")).toBeUndefined();
  });
});

describe("buildHostCliStamp", () => {
  it("records kind, prefix and OWNER for a user-prefix npm install", () => {
    const stamp = buildHostCliStamp(
      {
        version: "0.20.21",
        execPath: "/usr/bin/node",
        scriptPath: NVM_SCRIPT,
        bundleDir: "/home/op/.nvm/versions/node/v22.22.2/lib/node_modules/switchroom/dist/cli",
        inContainer: false,
      },
      { statUid: () => 1000, userForUid: () => "op" },
    );
    expect(stamp).toEqual({
      version: "0.20.21",
      installKind: "npm-global",
      path: NVM_SCRIPT,
      npmPrefix: "/home/op/.nvm/versions/node/v22.22.2",
      ownerUid: 1000,
      ownerUser: "op",
    } satisfies HostCliStamp);
  });

  it("records the static-binary path for a compiled install", () => {
    const stamp = buildHostCliStamp(
      {
        version: "v0.20.21",
        execPath: "/usr/local/bin/switchroom",
        scriptPath: "/$bunfs/root/switchroom",
        bundleDir: "/$bunfs/root",
        inContainer: false,
      },
      { statUid: () => 0, userForUid: () => "root" },
    );
    expect(stamp?.installKind).toBe("static-binary");
    expect(stamp?.path).toBe("/usr/local/bin/switchroom");
    // The leading `v` is stripped so the stored value is a bare semver.
    expect(stamp?.version).toBe("0.20.21");
  });

  it("refuses to stamp from inside a container — a container CLI is not the host CLI", () => {
    expect(
      buildHostCliStamp({
        version: "0.20.21",
        execPath: "/usr/bin/node",
        scriptPath: "/opt/switchroom/dist/cli/switchroom.js",
        bundleDir: "/opt/switchroom/dist/cli",
        inContainer: true,
      }),
    ).toBeUndefined();
  });
});

describe("refreshHostCliStamp / readHostCliStamp", () => {
  it("writes the stamp into the switchroom home and reads it back", () => {
    const { home, dir } = makeHome();
    const io = { ...scopedIo(home), statUid: () => 1000, userForUid: () => "op" };
    const first = refreshHostCliStamp(
      {
        version: "0.20.21",
        execPath: "/usr/bin/node",
        scriptPath: NVM_SCRIPT,
        bundleDir: "/x",
        inContainer: false,
      },
      io,
    );
    expect(first.status).toBe("written");
    expect(existsSync(join(dir, HOST_CLI_STAMP_FILENAME))).toBe(true);

    const read = readHostCliStamp(io);
    expect(read?.version).toBe("0.20.21");
    expect(read?.installKind).toBe("npm-global");
    expect(read?.ownerUser).toBe("op");
  });

  it("is a byte-identical no-op on re-run (idempotent, so it can run on every invocation)", () => {
    const { home, dir } = makeHome();
    const io = { ...scopedIo(home), statUid: () => 1000, userForUid: () => "op" };
    const input = {
      version: "0.20.21",
      execPath: "/usr/bin/node",
      scriptPath: NVM_SCRIPT,
      bundleDir: "/x",
      inContainer: false,
    };
    refreshHostCliStamp(input, io);
    const before = readFileSync(join(dir, HOST_CLI_STAMP_FILENAME), "utf8");
    expect(refreshHostCliStamp(input, io).status).toBe("unchanged");
    expect(readFileSync(join(dir, HOST_CLI_STAMP_FILENAME), "utf8")).toBe(before);
  });

  it("skips (never throws) when there is no switchroom home to stamp", () => {
    const empty = mkdtempSync(join(tmpdir(), "host-cli-nohome-"));
    const res = refreshHostCliStamp(
      {
        version: "0.20.21",
        execPath: "/usr/bin/node",
        scriptPath: NVM_SCRIPT,
        bundleDir: "/x",
        inContainer: false,
      },
      scopedIo(empty),
    );
    expect(res.status).toBe("skipped");
    expect(readHostCliStamp(scopedIo(empty))).toBeUndefined();
  });

  it("hands a root-written stamp back to the switchroom home's owner", () => {
    // A `sudo switchroom …` run would otherwise leave a root-owned stamp in a
    // uid-1000 home; every later unprivileged run's tmp+rename then EACCESes
    // and the stamp freezes — re-opening the silent-drift hole from the inside.
    const { home } = makeHome();
    const chowns: Array<[string, number, number]> = [];
    refreshHostCliStamp(
      {
        version: "0.20.21",
        execPath: "/usr/bin/node",
        scriptPath: NVM_SCRIPT,
        bundleDir: "/x",
        inContainer: false,
      },
      {
        ...scopedIo(home),
        statUid: () => 1000,
        userForUid: () => "op",
        getuid: () => 0,
        statOwner: () => ({ uid: 1000, gid: 1000 }),
        chown: (p, uid, gid) => chowns.push([p, uid, gid]),
      },
    );
    expect(chowns).toEqual([[join(home, ".switchroom", HOST_CLI_STAMP_FILENAME), 1000, 1000]]);
  });

  it("does not chown when the writer is not root, or when the home is root's own", () => {
    const { home } = makeHome();
    const input = {
      version: "0.20.21",
      execPath: "/usr/bin/node",
      scriptPath: NVM_SCRIPT,
      bundleDir: "/x",
      inContainer: false,
    };
    const chowns: string[] = [];
    const io = {
      ...scopedIo(home),
      statUid: () => 1000,
      userForUid: () => "op",
      chown: (p: string) => chowns.push(p),
    };
    refreshHostCliStamp(input, { ...io, getuid: () => 1000 });
    // A genuinely root-owned home needs no handoff.
    const { home: rootHome } = makeHome();
    refreshHostCliStamp(input, {
      ...io,
      ...scopedIo(rootHome),
      chown: (p: string) => chowns.push(p),
      getuid: () => 0,
      statOwner: () => ({ uid: 0, gid: 0 }),
    });
    expect(chowns).toEqual([]);
  });

  it("returns undefined for a malformed stamp instead of throwing", () => {
    const { home, dir } = makeHome();
    writeFileSync(join(dir, HOST_CLI_STAMP_FILENAME), "{not json", "utf8");
    expect(readHostCliStamp(scopedIo(home))).toBeUndefined();
  });

  it("prefers SWITCHROOM_HOST_HOME, then the sudo user's home, over the process home", () => {
    expect(
      stampHomeCandidates(
        { SWITCHROOM_HOST_HOME: "/host-h", SUDO_USER: "op" } as NodeJS.ProcessEnv,
        "/root",
        () => "/home/op",
      ),
    ).toEqual([
      "/host-h/.switchroom",
      "/home/op/.switchroom",
      "/root/.switchroom",
      "/host-home/.switchroom",
    ]);
  });

  it("resolves the container mount point when only /host-home has a switchroom.yaml", () => {
    const { home } = makeHome();
    // Simulate the container: process home has no config, SWITCHROOM_HOST_HOME does.
    const bare = mkdtempSync(join(tmpdir(), "host-cli-container-"));
    expect(
      resolveStampDir({
        ...scopedIo(bare),
        env: { SWITCHROOM_HOST_HOME: home } as NodeJS.ProcessEnv,
      }),
    ).toBe(join(home, ".switchroom"));
  });
});

describe("hostCliInstallCommand — the command must match how the host is ACTUALLY installed", () => {
  const target = "v0.20.21";

  it("does NOT say sudo for a user-owned npm prefix, and names the user + prefix", () => {
    const cmd = hostCliInstallCommand(
      {
        version: "0.20.16",
        installKind: "npm-global",
        path: NVM_SCRIPT,
        npmPrefix: "/home/op/.nvm/versions/node/v22.22.2",
        ownerUid: 1000,
        ownerUser: "op",
      },
      target,
    );
    expect(cmd).toContain(
      "npm i -g --prefix /home/op/.nvm/versions/node/v22.22.2 switchroom@0.20.21",
    );
    // The literal command must not be a sudo invocation. (It DOES contain the
    // word "sudo" inside the explicit "NOT under sudo" caution — that caution
    // is the point of this test, so match the invocation shape, not the word.)
    expect(cmd).not.toMatch(/(^|[;&|]\s*)sudo\s/);
    expect(cmd).toContain("run as op");
    expect(cmd).toContain("/home/op/.nvm/versions/node/v22.22.2");
  });

  it("DOES say sudo when the npm tree really is root-owned", () => {
    const cmd = hostCliInstallCommand(
      {
        version: "0.20.16",
        installKind: "npm-global",
        path: "/usr/local/lib/node_modules/switchroom/dist/cli/switchroom.js",
        npmPrefix: "/usr/local",
        ownerUid: 0,
        ownerUser: "root",
      },
      target,
    );
    expect(cmd).toBe("sudo npm i -g --prefix /usr/local switchroom@0.20.21");
  });

  it("points a static-binary install at `switchroom update`, not npm", () => {
    const cmd = hostCliInstallCommand(
      {
        version: "0.20.16",
        installKind: "static-binary",
        path: "/usr/local/bin/switchroom",
      },
      target,
    );
    expect(cmd).toContain("switchroom update --pin v0.20.21");
    expect(cmd).not.toContain("npm i -g");
  });

  it("degrades to a method-agnostic instruction with no stamp", () => {
    expect(hostCliInstallCommand(undefined, target)).toContain("0.20.21");
  });
});

describe("hostCliInstallShellCommand — pasteable ONLY when the caveat isn't load-bearing", () => {
  it("returns a runnable command for a root-owned npm tree and a static binary", () => {
    expect(
      hostCliInstallShellCommand(
        {
          version: "0.20.16",
          installKind: "npm-global",
          path: "/usr/local/lib/node_modules/switchroom/dist/cli/switchroom.js",
          npmPrefix: "/usr/local",
          ownerUid: 0,
        },
        "v0.20.21",
      ),
    ).toBe("sudo npm i -g --prefix /usr/local switchroom@0.20.21");
    expect(
      hostCliInstallShellCommand(
        { version: "0.20.16", installKind: "static-binary", path: "/usr/local/bin/switchroom" },
        "v0.20.21",
      ),
    ).toBe("switchroom update --pin v0.20.21");
  });

  it("returns undefined for a USER-owned npm prefix — the 'run as <user>' caveat cannot be &&-chained", () => {
    expect(
      hostCliInstallShellCommand(
        {
          version: "0.20.16",
          installKind: "npm-global",
          path: NVM_SCRIPT,
          npmPrefix: "/home/op/.nvm/versions/node/v22.22.2",
          ownerUid: 1000,
          ownerUser: "op",
        },
        "v0.20.21",
      ),
    ).toBeUndefined();
  });

  it("returns undefined with no stamp at all", () => {
    expect(hostCliInstallShellCommand(undefined, "v0.20.21")).toBeUndefined();
  });

  // npm resolves the global prefix from the INVOKING user's npmrc, and under
  // `sudo` that is root's — not necessarily the tree the stamp measured. A
  // bare `-g` then converges a DIFFERENT install and leaves the observed one
  // exactly as drifted as before, with the card reporting success.
  it("carries the OBSERVED prefix, because sudo swaps in root's npmrc prefix", () => {
    const rootOwnedElsewhere: HostCliStamp = {
      version: "0.20.16",
      installKind: "npm-global",
      path: "/opt/npm-global/lib/node_modules/switchroom/dist/cli/switchroom.js",
      npmPrefix: "/opt/npm-global",
      ownerUid: 0,
    };
    expect(hostCliInstallShellCommand(rootOwnedElsewhere, "v0.20.21")).toBe(
      "sudo npm i -g --prefix /opt/npm-global switchroom@0.20.21",
    );
    expect(hostCliInstallCommand(rootOwnedElsewhere, "v0.20.21")).toBe(
      "sudo npm i -g --prefix /opt/npm-global switchroom@0.20.21",
    );
  });

  it("omits --prefix when the stamp never recorded one", () => {
    expect(
      hostCliInstallShellCommand(
        {
          version: "0.20.16",
          installKind: "npm-global",
          path: "/some/unusual/switchroom",
          ownerUid: 0,
        },
        "v0.20.21",
      ),
    ).toBe("sudo npm i -g switchroom@0.20.21");
  });
});

describe("shouldRefuseStaleHostCli", () => {
  const stamp = (version: string): HostCliStamp => ({
    version,
    installKind: "npm-global",
    path: NVM_SCRIPT,
  });

  it("refuses when the observed host CLI is strictly older than the target", () => {
    expect(shouldRefuseStaleHostCli(stamp("0.20.16"), "v0.20.21")).toBe(true);
    expect(shouldRefuseStaleHostCli(stamp("v0.20.16"), "0.20.21")).toBe(true);
  });

  it("allows an equal or newer host CLI", () => {
    expect(shouldRefuseStaleHostCli(stamp("0.20.21"), "v0.20.21")).toBe(false);
    expect(shouldRefuseStaleHostCli(stamp("0.21.0"), "v0.20.21")).toBe(false);
  });

  it("never blocks with no stamp — a host CLI predating the stamp writes none", () => {
    expect(shouldRefuseStaleHostCli(undefined, "v0.20.21")).toBe(false);
  });

  it("never blocks on an unorderable version", () => {
    expect(shouldRefuseStaleHostCli(stamp("0.0.0-dev"), "v0.20.21")).toBe(false);
    expect(shouldRefuseStaleHostCli(stamp("0.20.16"), "nightly")).toBe(false);
  });
});

// The asymmetry that made a false all-clear possible: `shouldRefuseStaleHostCli`
// returns false for "converged" AND for "cannot be ordered", because the ROLL
// must not block on the latter. Any surface that instead wants to ASSERT the
// host CLI is done needs the third state, or it prints "nothing to do" over a
// host CLI that is five releases behind on an rc build.
describe("compareHostCliToTarget / hostCliConvergedOnTarget", () => {
  const stamp = (version: string): HostCliStamp => ({
    version,
    installKind: "npm-global",
    path: NVM_SCRIPT,
  });

  it("separates behind / current-or-ahead / unknown", () => {
    expect(compareHostCliToTarget(stamp("0.20.16"), "v0.20.21")).toBe("behind");
    expect(compareHostCliToTarget(stamp("0.20.21"), "v0.20.21")).toBe("current-or-ahead");
    expect(compareHostCliToTarget(stamp("0.21.0"), "v0.20.21")).toBe("current-or-ahead");
    expect(compareHostCliToTarget(stamp("0.20.16-rc.1"), "v0.20.21")).toBe("unknown");
    expect(compareHostCliToTarget(stamp("sha-abc1234"), "v0.20.21")).toBe("unknown");
    expect(compareHostCliToTarget(undefined, "v0.20.21")).toBe("unknown");
  });

  it("treats an UNORDERABLE version as not-converged, unlike the roll gate", () => {
    for (const v of ["0.20.16-rc.1", "0.20.16-dev", "sha-abc1234"]) {
      // The gate lets it through…
      expect(shouldRefuseStaleHostCli(stamp(v), "v0.20.21")).toBe(false);
      // …and that must NOT be readable as "the host CLI is on target".
      expect(hostCliConvergedOnTarget(stamp(v), "v0.20.21")).toBe(false);
    }
  });

  it("is true only for an observed, orderable, on-or-past version", () => {
    expect(hostCliConvergedOnTarget(stamp("0.20.21"), "v0.20.21")).toBe(true);
    expect(hostCliConvergedOnTarget(stamp("0.21.0"), "v0.20.21")).toBe(true);
    expect(hostCliConvergedOnTarget(stamp("0.20.16"), "v0.20.21")).toBe(false);
    expect(hostCliConvergedOnTarget(undefined, "v0.20.21")).toBe(false);
  });
});
