import { describe, it, expect } from "vitest";

import {
  alreadySelfUpdated,
  ASSET_PAYLOAD_ASSET_NAME,
  detectInstallKind,
  expectedChecksum,
  installAssetPayload,
  parseLatestReleaseTag,
  payloadVersionDir,
  performSelfUpdate,
  planSelfUpdate,
  readPayloadVersion,
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

/**
 * An in-memory filesystem carrying the two things the shipped-asset payload
 * (#4163) actually depends on: SYMLINKS (the publish step is a rename over a
 * link) and DIRECTORY renames (the extract-then-publish split). Modelling
 * those as flat string keys would let the ordering tests pass over code that
 * could not work on a real filesystem.
 */
function makeIO(overrides: Partial<SelfUpdateIO> = {}) {
  const files = new Map<string, string>([
    ["/usr/local/bin/switchroom", "OLD-BINARY"],
  ]);
  const dirs = new Set<string>(["/usr/local/bin"]);
  /** linkPath -> target (relative, as installAssetPayload writes it). */
  const links = new Map<string, string>();
  const dirnameOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

  /** Resolve one level of symlink on `p` or on any of its parents. */
  function realpath(p: string): string {
    for (const [link, target] of links) {
      if (p === link) return `${dirnameOf(link)}/${target}`;
      if (p.startsWith(`${link}/`)) {
        return `${dirnameOf(link)}/${target}${p.slice(link.length)}`;
      }
    }
    return p;
  }
  function removeTree(p: string) {
    links.delete(p);
    files.delete(p);
    for (const k of [...files.keys()]) if (k.startsWith(`${p}/`)) files.delete(k);
    for (const k of [...links.keys()]) if (k.startsWith(`${p}/`)) links.delete(k);
    for (const k of [...dirs]) if (k === p || k.startsWith(`${p}/`)) dirs.delete(k);
  }

  const io: SelfUpdateIO = {
    async httpGetText(url) {
      if (url.endsWith("switchroom-checksums.txt")) {
        return (
          `${GOOD_SHA}  switchroom-linux-amd64\n` +
          `${GOOD_SHA}  ${ASSET_PAYLOAD_ASSET_NAME}\n`
        );
      }
      return '{"tag_name":"v0.19.28"}';
    },
    async httpDownload(url, dest) {
      // The payload archive carries the tag it was fetched for, so
      // extractTarGz can unpack a manifest that matches it — or, in the
      // negative tests, deliberately does not.
      if (url.endsWith(ASSET_PAYLOAD_ASSET_NAME)) {
        const tag = url.split("/download/")[1]?.split("/")[0] ?? "v0.0.0";
        files.set(dest, `PAYLOAD:${tag}`);
        return;
      }
      files.set(dest, "NEW-BINARY");
    },
    sha256File: () => GOOD_SHA,
    probeBinary: () => ({ ok: true, version: "0.19.28" }),
    mkdirp: (d) => void dirs.add(d),
    copyFile: (src, dest) => void files.set(dest, files.get(realpath(src)) ?? ""),
    chmodExec: () => {},
    rename: (src, dest) => {
      // A file, a symlink, or a whole subtree — the payload publish step uses
      // all three shapes.
      if (links.has(src)) {
        links.set(dest, links.get(src) as string);
        links.delete(src);
        files.delete(dest);
        return;
      }
      if (files.has(src)) {
        files.set(dest, files.get(src) as string);
        files.delete(src);
        return;
      }
      for (const k of [...files.keys()]) {
        if (k.startsWith(`${src}/`)) {
          files.set(`${dest}${k.slice(src.length)}`, files.get(k) as string);
          files.delete(k);
        }
      }
      dirs.add(dest);
      dirs.delete(src);
    },
    remove: (p) => {
      files.delete(p);
      links.delete(p);
    },
    exists: (p) =>
      files.has(p) ||
      links.has(p) ||
      dirs.has(p) ||
      [...files.keys()].some((k) => k.startsWith(`${p}/`)),
    dirname: dirnameOf,
    readText: (p) => files.get(realpath(p)) ?? null,
    extractTarGz: (archive, destDir) => {
      const body = files.get(archive);
      if (body === undefined) throw new Error(`no such archive: ${archive}`);
      const tag = body.startsWith("PAYLOAD:") ? body.slice("PAYLOAD:".length) : "v0.0.0";
      dirs.add(destDir);
      files.set(
        `${destDir}/switchroom-assets.json`,
        JSON.stringify({ version: tag, entries: ["profiles", "skills"] }),
      );
      files.set(`${destDir}/profiles/_base/start.sh.hbs`, "#!/bin/sh\n");
    },
    symlink: (target, linkPath) => void links.set(linkPath, target),
    isSymlink: (p) => links.has(p),
    removeTree,
    listDir: (dir) => {
      const out = new Set<string>();
      for (const k of [...files.keys(), ...links.keys(), ...dirs]) {
        if (!k.startsWith(`${dir}/`)) continue;
        out.add(k.slice(dir.length + 1).split("/")[0]);
      }
      return [...out];
    },
    ...overrides,
  };
  return { io, files, dirs, links };
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
    const { io, files } = makeIO({
      probeBinary: () => ({ ok: false, kind: "ran-but-failed", detail: "exit 1" }),
    });
    await expect(run(io)).rejects.toThrow(/the artifact itself is faulty/);
    // The whole point: a broken binary never reaches $PATH.
    expect(files.get("/usr/local/bin/switchroom")).toBe("OLD-BINARY");
  });

  // #4586 follow-up. Before this split, EVERY probe failure was reported as
  // "the downloaded binary did not run cleanly on this host", which reads as
  // "the artifact is bad" and sends the operator to re-download an artifact
  // whose sha256 already matched. A failure to EXEC is a property of the
  // staging location (a `noexec` mount, a lost +x bit, a foreign arch), and
  // the message must say so or the remedy is wrong.
  it("says the artifact is fine and the LOCATION is not, when the exec itself fails", async () => {
    const { io, files } = makeIO({
      probeBinary: () => ({
        ok: false,
        kind: "not-executable",
        detail: "EACCES: spawnSync .../switchroom-v0.19.28.download EACCES",
      }),
    });
    const err = await run(io).then(
      () => "",
      (e: Error) => e.message,
    );
    expect(err).toContain("could not EXECUTE");
    expect(err).toContain("noexec");
    expect(err).toContain("re-downloading will not help");
    // It must NOT accuse the artifact.
    expect(err).not.toContain("the artifact itself is faulty");
    // Still refuses: an unproven binary never reaches $PATH.
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

// ─── the shipped-asset payload (#4163) ───────────────────────────────────
//
// The non-negotiable property: the binary and the templates it renders from
// move together. If they can drift, a new CLI scaffolds agents from old
// templates — worse than today's "no templates at all", because it fails
// silently and much later.

const SHARE_ROOT = "/usr/local/share/switchroom";

describe("installAssetPayload", () => {
  it("publishes the payload as a versioned dir behind a symlink", async () => {
    const { io, files, links } = makeIO();
    const r = await installAssetPayload({
      tag: "v0.19.28",
      binaryPath: "/usr/local/bin/switchroom",
      io,
    });

    expect(r.installed).toBe(true);
    expect(r.version).toBe("v0.19.28");
    expect(r.root).toBe(SHARE_ROOT);
    // The published path is a SYMLINK — that is what makes the swap a
    // rename(2) rather than a recursive delete of a live directory.
    expect(links.get(SHARE_ROOT)).toBe("switchroom-0.19.28");
    expect(files.has(`${payloadVersionDir(SHARE_ROOT, "v0.19.28")}/profiles/_base/start.sh.hbs`)).toBe(true);
    // Resolving THROUGH the link is what the CLI actually does.
    expect(readPayloadVersion(io, SHARE_ROOT)).toBe("v0.19.28");
    // No staging debris left behind.
    expect([...files.keys()].filter((k) => k.includes(".incoming"))).toEqual([]);
    expect([...files.keys()].filter((k) => k.includes(".download"))).toEqual([]);
  });

  it("is a no-op when the payload on disk is already the wanted version", async () => {
    const { io } = makeIO();
    await installAssetPayload({ tag: "v0.19.28", binaryPath: "/usr/local/bin/switchroom", io });
    let downloads = 0;
    const second = await installAssetPayload({
      tag: "v0.19.28",
      binaryPath: "/usr/local/bin/switchroom",
      io: {
        ...io,
        httpDownload: async (...args) => {
          downloads += 1;
          return io.httpDownload(...args);
        },
      },
    });
    expect(second.installed).toBe(false);
    expect(downloads).toBe(0);
  });

  it("refuses to unpack a payload whose checksum does not match", async () => {
    const { io, files, links } = makeIO({ sha256File: () => "e".repeat(64) });
    await expect(
      installAssetPayload({ tag: "v0.19.28", binaryPath: "/usr/local/bin/switchroom", io }),
    ).rejects.toThrow(/SHA256 mismatch/);
    expect(links.has(SHARE_ROOT)).toBe(false);
    expect([...files.keys()].filter((k) => k.includes(".download"))).toEqual([]);
  });

  it("refuses when the release ships no payload checksum entry (a pre-#4163 tag)", async () => {
    const { io, links } = makeIO({
      httpGetText: async () => `${GOOD_SHA}  switchroom-linux-amd64\n`,
    });
    await expect(
      installAssetPayload({ tag: "v0.19.28", binaryPath: "/usr/local/bin/switchroom", io }),
    ).rejects.toThrow(/no checksum entry/);
    expect(links.has(SHARE_ROOT)).toBe(false);
  });

  it("refuses a payload whose manifest names a DIFFERENT release than the tag", async () => {
    // The skew guard: a correctly-hashed archive cut from another release
    // must not become the templates this CLI scaffolds from.
    const { io, links, files } = makeIO({
      async httpDownload(url, dest) {
        files.set(dest, url.endsWith(ASSET_PAYLOAD_ASSET_NAME) ? "PAYLOAD:v9.9.9" : "NEW-BINARY");
      },
    });
    await expect(
      installAssetPayload({ tag: "v0.19.28", binaryPath: "/usr/local/bin/switchroom", io }),
    ).rejects.toThrow(/unpacked with version v9\.9\.9/);
    expect(links.has(SHARE_ROOT)).toBe(false);
  });

  it("moves a pre-existing REAL directory aside instead of deleting it", async () => {
    // The dev-host stopgap shape: someone hand-staged profiles/ into
    // /usr/local/share/switchroom. rename(2) cannot replace a non-empty
    // directory, and silently rm -rf'ing an operator's files is not on.
    const { io, files, links } = makeIO();
    files.set(`${SHARE_ROOT}/profiles/hand-staged.hbs`, "OPERATOR-FILE");
    await installAssetPayload({ tag: "v0.19.28", binaryPath: "/usr/local/bin/switchroom", io });
    expect(files.get(`${SHARE_ROOT}.replaced/profiles/hand-staged.hbs`)).toBe("OPERATOR-FILE");
    expect(links.get(SHARE_ROOT)).toBe("switchroom-0.19.28");
  });

  it("keeps the current payload and ONE previous version, pruning the rest", async () => {
    // A binary rollback still has templates to render from; /usr/local/share
    // does not grow by ~7MB per release forever.
    const { io, files } = makeIO();
    for (const v of ["0.19.20", "0.19.21", "0.19.23"]) {
      files.set(`/usr/local/share/switchroom-${v}/switchroom-assets.json`, `{"version":"v${v}"}`);
    }
    await installAssetPayload({ tag: "v0.19.28", binaryPath: "/usr/local/bin/switchroom", io });
    const kept = [...files.keys()]
      .map((k) => k.match(/^\/usr\/local\/share\/switchroom-(\d+\.\d+\.\d+)\//)?.[1])
      .filter((v): v is string => Boolean(v));
    expect([...new Set(kept)].sort()).toEqual(["0.19.23", "0.19.28"]);
  });
});

describe("performSelfUpdate — binary and payload move together", () => {
  it("installs the payload for the SAME tag as the binary", async () => {
    const { io, files, links } = makeIO();
    const r = await run(io);
    expect(r.payload?.version).toBe("v0.19.28");
    expect(r.newVersion).toBe("v0.19.28");
    expect(links.get(SHARE_ROOT)).toBe("switchroom-0.19.28");
    expect(files.get("/usr/local/bin/switchroom")).toBe("NEW-BINARY");
    expect(r.message).toContain("asset payload v0.19.28");
  });

  it("publishes the payload BEFORE the binary swap", async () => {
    // The ordering IS the guarantee. An interruption between the two renames
    // must leave new-templates/old-CLI (recoverable, and the old CLI can read
    // newer templates) — never new-CLI/old-templates.
    const order: string[] = [];
    const base = makeIO();
    const io: SelfUpdateIO = {
      ...base.io,
      symlink: (target, linkPath) => {
        order.push(`payload:${linkPath}`);
        base.io.symlink(target, linkPath);
      },
      rename: (src, dest) => {
        if (dest === "/usr/local/bin/switchroom") order.push("binary:swap");
        base.io.rename(src, dest);
      },
    };
    await performSelfUpdate({ plan: PLAN, assetName: "switchroom-linux-amd64", io });
    expect(order).toEqual([`payload:${SHARE_ROOT}.new-link`, "binary:swap"]);
  });

  it("leaves the binary UNTOUCHED when the payload cannot be installed", async () => {
    // The direction that must never happen: a new CLI on $PATH with stale or
    // absent templates. A failed payload is a failed update.
    const { io, files, links } = makeIO({
      extractTarGz: () => {
        throw new Error("tar: unexpected EOF");
      },
    });
    await expect(run(io)).rejects.toThrow(/could not unpack/);
    expect(files.get("/usr/local/bin/switchroom")).toBe("OLD-BINARY");
    expect(links.has(SHARE_ROOT)).toBe(false);
  });

  it("refuses the whole update when the release has no payload at all", async () => {
    const { io, files } = makeIO({
      httpGetText: async (url) =>
        url.endsWith("switchroom-checksums.txt")
          ? `${GOOD_SHA}  switchroom-linux-amd64\n`
          : '{"tag_name":"v0.19.28"}',
    });
    await expect(run(io)).rejects.toThrow(/no checksum entry for switchroom-assets\.tar\.gz/);
    expect(files.get("/usr/local/bin/switchroom")).toBe("OLD-BINARY");
  });
});
