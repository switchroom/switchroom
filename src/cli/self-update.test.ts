import { describe, it, expect } from "vitest";

import {
  alreadySelfUpdated,
  detectInstallKind,
  expectedChecksum,
  parseLatestReleaseTag,
  performSelfUpdate,
  planSelfUpdate,
  releaseAssetName,
  rollbackHint,
  versionStorePath,
  type SelfUpdateAction,
  type SelfUpdateIO,
} from "./self-update.js";

const STATIC_BINARY = {
  bundleDir: "/$bunfs/root",
  execPath: "/usr/local/bin/switchroom",
  scriptPath: "/$bunfs/root/switchroom",
  inContainer: false,
};

describe("detectInstallKind", () => {
  it("identifies a published static binary and the file to replace", () => {
    const d = detectInstallKind(STATIC_BINARY);
    expect(d.kind).toBe("static-binary");
    expect(d.binaryPath).toBe("/usr/local/bin/switchroom");
  });

  it("refuses to touch a source checkout", () => {
    const d = detectInstallKind({
      bundleDir: "/home/dev/switchroom/src/cli",
      execPath: "/home/dev/.bun/bin/bun",
      scriptPath: "/home/dev/switchroom/dist/cli/switchroom.js",
      inContainer: false,
    });
    expect(d.kind).toBe("source-checkout");
    expect(d.binaryPath).toBeUndefined();
    expect(d.reason).toContain("npm run build");
  });

  it("refuses to touch an npm-global install and names the right command", () => {
    const d = detectInstallKind({
      bundleDir: "/usr/lib/node_modules/switchroom/dist/cli",
      execPath: "/usr/bin/node",
      scriptPath: "/usr/lib/node_modules/switchroom/dist/cli/switchroom.js",
      inContainer: false,
    });
    expect(d.kind).toBe("npm-global");
    expect(d.reason).toContain("npm i -g switchroom@latest");
  });

  it("never self-updates inside a container", () => {
    const d = detectInstallKind({ ...STATIC_BINARY, inContainer: true });
    expect(d.kind).toBe("container");
    expect(d.binaryPath).toBeUndefined();
  });

  it("falls back to `unknown` rather than guessing", () => {
    const d = detectInstallKind({
      bundleDir: "/opt/weird/bundle",
      execPath: "/opt/weird/bin/node",
      scriptPath: "/opt/weird/switchroom-launcher",
      inContainer: false,
    });
    expect(d.kind).toBe("unknown");
    expect(d.binaryPath).toBeUndefined();
  });
});

describe("planSelfUpdate", () => {
  const detection = detectInstallKind(STATIC_BINARY);

  it("updates when the local CLI is behind the published release", () => {
    const p = planSelfUpdate({
      detection,
      currentVersion: "0.19.23",
      latestTag: "v0.19.28",
    });
    expect(p).toEqual({
      action: "update",
      from: "v0.19.23",
      to: "v0.19.28",
      binaryPath: "/usr/local/bin/switchroom",
    });
  });

  it("is a no-op when already current", () => {
    expect(
      planSelfUpdate({ detection, currentVersion: "0.19.28", latestTag: "v0.19.28" }),
    ).toEqual({ action: "current", version: "v0.19.28" });
  });

  it("never DOWNGRADES a locally-newer CLI", () => {
    const p = planSelfUpdate({
      detection,
      currentVersion: "0.20.0",
      latestTag: "v0.19.28",
    });
    expect(p.action).toBe("current");
  });

  it("skips (does not fail) when GitHub could not be reached", () => {
    const p = planSelfUpdate({
      detection,
      currentVersion: "0.19.23",
      latestTag: null,
    });
    expect(p.action).toBe("skip");
  });

  it("skips a non-static install even when a newer release exists", () => {
    const p = planSelfUpdate({
      detection: detectInstallKind({ ...STATIC_BINARY, inContainer: true }),
      currentVersion: "0.19.23",
      latestTag: "v0.19.28",
    });
    expect(p.action).toBe("skip");
  });
});

describe("release metadata parsing", () => {
  it("reads tag_name from /releases/latest", () => {
    expect(parseLatestReleaseTag('{"tag_name":"v0.19.28"}')).toBe("v0.19.28");
  });

  it("rejects a draft payload", () => {
    expect(parseLatestReleaseTag('{"tag_name":"v0.19.29","draft":true}')).toBeNull();
  });

  it("rejects a non-semver tag rather than passing it to a download URL", () => {
    expect(parseLatestReleaseTag('{"tag_name":"nightly"}')).toBeNull();
    expect(parseLatestReleaseTag("not json")).toBeNull();
  });

  it("matches the checksum line exactly, not by prefix", () => {
    const text = [
      `${"a".repeat(64)}  switchroom-linux-amd64.sig`,
      `${"b".repeat(64)}  switchroom-linux-amd64`,
      `${"c".repeat(64)}  switchroom-macos-arm64`,
    ].join("\n");
    expect(expectedChecksum(text, "switchroom-linux-amd64")).toBe("b".repeat(64));
    expect(expectedChecksum(text, "switchroom-linux-arm64")).toBeNull();
  });

  it("mirrors install.sh's asset naming", () => {
    expect(releaseAssetName("linux", "x64")).toBe("switchroom-linux-amd64");
    expect(releaseAssetName("darwin", "arm64")).toBe("switchroom-macos-arm64");
    expect(releaseAssetName("win32", "x64")).toBeNull();
    expect(releaseAssetName("linux", "ppc64")).toBeNull();
  });
});

describe("rollback layout", () => {
  it("archives inside the install dir so the final swap is a same-fs rename", () => {
    expect(versionStorePath("/usr/local/bin", "v0.19.23")).toBe(
      "/usr/local/bin/.switchroom-versions/switchroom-0.19.23",
    );
  });

  it("prints a one-command rollback", () => {
    expect(rollbackHint("/usr/local/bin", "v0.19.23")).toBe(
      "Rollback: cp /usr/local/bin/.switchroom-versions/switchroom-0.19.23 /usr/local/bin/switchroom",
    );
  });
});

describe("alreadySelfUpdated", () => {
  it("is the re-exec loop guard", () => {
    expect(alreadySelfUpdated({ SWITCHROOM_SELF_UPDATED: "1" })).toBe(true);
    expect(alreadySelfUpdated({})).toBe(false);
  });
});

// ─── performSelfUpdate — an in-memory filesystem, no network ─────────────

const GOOD_SHA = "d".repeat(64);

function makeIO(overrides: Partial<SelfUpdateIO> = {}) {
  const files = new Map<string, string>([
    ["/usr/local/bin/switchroom", "OLD-BINARY"],
  ]);
  const dirs = new Set<string>(["/usr/local/bin"]);
  const io: SelfUpdateIO = {
    async httpGetText(url) {
      if (url.endsWith("switchroom-checksums.txt")) {
        return `${GOOD_SHA}  switchroom-linux-amd64\n`;
      }
      return '{"tag_name":"v0.19.28"}';
    },
    async httpDownload(_url, dest) {
      files.set(dest, "NEW-BINARY");
    },
    sha256File: () => GOOD_SHA,
    probeBinaryVersion: () => "0.19.28",
    mkdirp: (d) => void dirs.add(d),
    copyFile: (src, dest) => void files.set(dest, files.get(src) ?? ""),
    chmodExec: () => {},
    rename: (src, dest) => {
      files.set(dest, files.get(src) ?? "");
      files.delete(src);
    },
    remove: (p) => void files.delete(p),
    exists: (p) => files.has(p),
    dirname: (p) => p.slice(0, p.lastIndexOf("/")) || "/",
    ...overrides,
  };
  return { io, files, dirs };
}

const PLAN: Extract<SelfUpdateAction, { action: "update" }> = {
  action: "update",
  from: "v0.19.23",
  to: "v0.19.28",
  binaryPath: "/usr/local/bin/switchroom",
};

async function run(io: SelfUpdateIO) {
  return performSelfUpdate({ plan: PLAN, assetName: "switchroom-linux-amd64", io });
}

describe("performSelfUpdate", () => {
  it("installs the new binary and archives the outgoing one for rollback", async () => {
    const { io, files } = makeIO();
    const r = await run(io);
    expect(r.replaced).toBe(true);
    expect(r.newVersion).toBe("v0.19.28");
    // The binary on $PATH is the new one …
    expect(files.get("/usr/local/bin/switchroom")).toBe("NEW-BINARY");
    // … the OUTGOING one is recoverable …
    expect(
      files.get("/usr/local/bin/.switchroom-versions/switchroom-0.19.23"),
    ).toBe("OLD-BINARY");
    // … the new one is kept under its version too …
    expect(
      files.get("/usr/local/bin/.switchroom-versions/switchroom-0.19.28"),
    ).toBe("NEW-BINARY");
    // … and no temp file is left behind.
    expect([...files.keys()].filter((k) => k.includes(".download"))).toEqual([]);
    expect([...files.keys()].filter((k) => k.endsWith(".new"))).toEqual([]);
    expect(r.message).toContain("Rollback: cp");
  });

  it("leaves the installed binary UNTOUCHED when the download fails", async () => {
    const { io, files } = makeIO({
      httpDownload: async () => {
        throw new Error("connection reset");
      },
    });
    await expect(run(io)).rejects.toThrow(/download of .* failed/);
    expect(files.get("/usr/local/bin/switchroom")).toBe("OLD-BINARY");
  });

  it("refuses a checksum mismatch and leaves the binary UNTOUCHED", async () => {
    const { io, files } = makeIO({ sha256File: () => "e".repeat(64) });
    await expect(run(io)).rejects.toThrow(/SHA256 mismatch/);
    expect(files.get("/usr/local/bin/switchroom")).toBe("OLD-BINARY");
    expect([...files.keys()].filter((k) => k.includes(".download"))).toEqual([]);
  });

  it("refuses when the release has no checksum entry for this asset", async () => {
    const { io, files } = makeIO({
      httpGetText: async () => "",
    });
    await expect(run(io)).rejects.toThrow(/no checksum entry/);
    expect(files.get("/usr/local/bin/switchroom")).toBe("OLD-BINARY");
  });

  it("refuses a binary that cannot run on this host, BEFORE the swap", async () => {
    const { io, files } = makeIO({ probeBinaryVersion: () => null });
    await expect(run(io)).rejects.toThrow(/did not run cleanly/);
    // The whole point: a broken binary never reaches $PATH.
    expect(files.get("/usr/local/bin/switchroom")).toBe("OLD-BINARY");
  });

  it("refuses to swap when the rollback copy cannot be made", async () => {
    const { io, files } = makeIO({
      copyFile: () => {
        throw new Error("EACCES");
      },
    });
    await expect(run(io)).rejects.toThrow(/refusing to swap without a rollback copy/);
    expect(files.get("/usr/local/bin/switchroom")).toBe("OLD-BINARY");
  });

  it("does not clobber an existing archive of the outgoing version", async () => {
    const { io, files } = makeIO();
    files.set(
      "/usr/local/bin/.switchroom-versions/switchroom-0.19.23",
      "PRISTINE-0.19.23",
    );
    await run(io);
    expect(
      files.get("/usr/local/bin/.switchroom-versions/switchroom-0.19.23"),
    ).toBe("PRISTINE-0.19.23");
  });
});
