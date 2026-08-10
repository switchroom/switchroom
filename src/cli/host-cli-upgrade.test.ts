import { describe, it, expect } from "vitest";

import {
  encodeHostCliUpgradeResult,
  handBackOwnership,
  parseHostCliUpgradeResult,
  runHostCliUpgrade,
  type HostCliUpgradeIo,
} from "./host-cli-upgrade.js";
import { ASSET_PAYLOAD_ASSET_NAME, type SelfUpdateIO } from "./self-update.js";

const GOOD_SHA = "e".repeat(64);
const HOST_BINARY = "/hostcli/bin/switchroom";

/**
 * An in-memory filesystem for `performSelfUpdate`, modelling the two shapes
 * the payload install depends on: symlinks and directory renames. Same shape
 * as `self-update.test.ts`'s fixture, trimmed to what this verb exercises.
 */
function makeIo(overrides: {
  self?: Partial<SelfUpdateIO>;
  io?: Partial<HostCliUpgradeIo>;
} = {}) {
  const files = new Map<string, string>([[HOST_BINARY, "OLD-BINARY"]]);
  const dirs = new Set<string>(["/hostcli", "/hostcli/bin"]);
  const links = new Map<string, string>();
  const owners = new Map<string, { uid: number; gid: number }>([
    ["/hostcli", { uid: 1000, gid: 1000 }],
    ["/hostcli/bin", { uid: 1000, gid: 1000 }],
    [HOST_BINARY, { uid: 1000, gid: 1000 }],
  ]);
  const chowned: string[] = [];
  const dirnameOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
  /**
   * The helper container runs as `USER 0:0` (docker/Dockerfile.hostd), so
   * EVERY path the update creates lands root-owned. The fixture models that
   * faithfully — it is what makes the "nothing left root-owned" assertions
   * below non-vacuous.
   */
  const asRoot = (p: string) => void owners.set(p, { uid: 0, gid: 0 });
  /** Every path the fixture knows about inside the bound prefix. */
  const allPaths = () =>
    [...files.keys(), ...links.keys(), ...dirs].filter((p) => p.startsWith("/hostcli"));
  /** Paths still owned by someone other than the pre-swap operator. */
  const strays = () => allPaths().filter((p) => owners.get(p)?.uid !== 1000);

  function realpath(p: string): string {
    for (const [link, target] of links) {
      if (p === link) return `${dirnameOf(link)}/${target}`;
      if (p.startsWith(`${link}/`)) {
        return `${dirnameOf(link)}/${target}${p.slice(link.length)}`;
      }
    }
    return p;
  }
  const existsIn = (p: string) =>
    files.has(p) ||
    links.has(p) ||
    dirs.has(p) ||
    [...files.keys()].some((k) => k.startsWith(`${p}/`));

  const self: SelfUpdateIO = {
    async httpGetText() {
      return (
        `${GOOD_SHA}  switchroom-linux-amd64\n` +
        `${GOOD_SHA}  ${ASSET_PAYLOAD_ASSET_NAME}\n`
      );
    },
    async httpDownload(url, dest) {
      if (url.endsWith(ASSET_PAYLOAD_ASSET_NAME)) {
        const tag = url.split("/download/")[1]?.split("/")[0] ?? "v0.0.0";
        files.set(dest, `PAYLOAD:${tag}`);
        asRoot(dest);
        return;
      }
      files.set(dest, "NEW-BINARY");
      asRoot(dest);
    },
    sha256File: () => GOOD_SHA,
    probeBinary: () => ({ ok: true, version: "0.22.0" }),
    mkdirp: (d) => {
      dirs.add(d);
      asRoot(d);
    },
    copyFile: (src, dest) => {
      files.set(dest, files.get(realpath(src)) ?? "");
      asRoot(dest);
    },
    chmodExec: () => {},
    rename: (src, dest) => {
      if (links.has(src)) {
        links.set(dest, links.get(src) as string);
        links.delete(src);
        files.delete(dest);
        asRoot(dest);
        return;
      }
      if (files.has(src)) {
        files.set(dest, files.get(src) as string);
        files.delete(src);
        asRoot(dest);
        return;
      }
      for (const k of [...files.keys()]) {
        if (k.startsWith(`${src}/`)) {
          const moved = `${dest}${k.slice(src.length)}`;
          files.set(moved, files.get(k) as string);
          files.delete(k);
          asRoot(moved);
        }
      }
      dirs.add(dest);
      dirs.delete(src);
      asRoot(dest);
    },
    remove: (p) => {
      files.delete(p);
      links.delete(p);
    },
    exists: existsIn,
    dirname: dirnameOf,
    readText: (p) => files.get(realpath(p)) ?? null,
    extractTarGz: (archive, destDir) => {
      const body = files.get(archive);
      if (body === undefined) throw new Error(`no such archive: ${archive}`);
      const tag = body.startsWith("PAYLOAD:") ? body.slice("PAYLOAD:".length) : "v0.0.0";
      dirs.add(destDir);
      asRoot(destDir);
      // Shapes that actually ship in the payload (scripts/build-asset-payload.mjs):
      // `profiles/` and `skills/`, the latter nesting six-plus levels deep. The
      // depth matters — a bounded ownership walk misses the deepest entries.
      const written: Array<[string, string]> = [
        [
          `${destDir}/switchroom-assets.json`,
          JSON.stringify({ version: tag, entries: ["profiles", "skills"] }),
        ],
        [`${destDir}/profiles/_base/start.sh.hbs`, "#!/bin/sh\n"],
        [`${destDir}/skills/telegram/access/scripts/lib/pair.sh`, "#!/bin/sh\n"],
      ];
      for (const [p, body2] of written) {
        files.set(p, body2);
        asRoot(p);
      }
    },
    symlink: (target, linkPath) => {
      links.set(linkPath, target);
      asRoot(linkPath);
    },
    isSymlink: (p) => links.has(p),
    removeTree: (p) => {
      links.delete(p);
      files.delete(p);
      for (const k of [...files.keys()]) if (k.startsWith(`${p}/`)) files.delete(k);
      for (const k of [...links.keys()]) if (k.startsWith(`${p}/`)) links.delete(k);
      for (const k of [...dirs]) if (k === p || k.startsWith(`${p}/`)) dirs.delete(k);
    },
    listDir: (dir) => {
      const out = new Set<string>();
      for (const k of [...files.keys(), ...links.keys(), ...dirs]) {
        if (!k.startsWith(`${dir}/`)) continue;
        out.add(k.slice(dir.length + 1).split("/")[0]);
      }
      return [...out];
    },
    ...overrides.self,
  };

  const io: HostCliUpgradeIo = {
    isFile: (p) => files.has(p),
    kind: (p) => {
      if (links.has(p)) return "symlink";
      if (files.has(p)) return "file";
      if (
        dirs.has(p) ||
        [...files.keys(), ...links.keys(), ...dirs].some((k) => k.startsWith(`${p}/`))
      ) {
        return "dir";
      }
      return undefined;
    },
    owner: (p) => owners.get(p),
    chown: (p, uid, gid) => {
      chowned.push(`${p}:${uid}:${gid}`);
      owners.set(p, { uid, gid });
    },
    list: (d) => self.listDir(d),
    selfUpdate: self,
    platform: "linux",
    arch: "x64",
    getuid: () => 0,
    ...overrides.io,
  };
  return { io, self, files, links, chowned, owners, strays, allPaths };
}

describe("runHostCliUpgrade — guards", () => {
  it("refuses a binary that is not named `switchroom`", async () => {
    const { io, files } = makeIo();
    files.set("/hostcli/bin/sshd", "IMPORTANT");
    const r = await runHostCliUpgrade(
      { binary: "/hostcli/bin/sshd", pin: "v0.22.0", from: "0.21.0" },
      io,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("refusing to overwrite an unrelated file");
    // The unrelated file is untouched.
    expect(files.get("/hostcli/bin/sshd")).toBe("IMPORTANT");
  });

  it("refuses a relative path", async () => {
    const { io } = makeIo();
    const r = await runHostCliUpgrade(
      { binary: "bin/switchroom", pin: "v0.22.0", from: "0.21.0" },
      io,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("absolute path");
  });

  it("refuses a pin that is not a vX.Y.Z tag", async () => {
    const { io } = makeIo();
    const r = await runHostCliUpgrade(
      { binary: HOST_BINARY, pin: "latest", from: "0.21.0" },
      io,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("vX.Y.Z");
  });

  it("refuses when the bind mount did not bring the binary in", async () => {
    const { io, files } = makeIo();
    files.delete(HOST_BINARY);
    const r = await runHostCliUpgrade(
      { binary: HOST_BINARY, pin: "v0.22.0", from: "0.21.0" },
      io,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("not an existing regular file");
  });
});

describe("runHostCliUpgrade — the swap", () => {
  it("replaces the host binary, keeps the outgoing one, and proves the result", async () => {
    const { io, files } = makeIo();
    const r = await runHostCliUpgrade(
      { binary: HOST_BINARY, pin: "v0.22.0", from: "0.21.0" },
      io,
    );
    expect(r).toMatchObject({ ok: true, version: "v0.22.0", binaryPath: HOST_BINARY });
    // The file the host's $PATH resolves to is the new one …
    expect(files.get(HOST_BINARY)).toBe("NEW-BINARY");
    // … and the outgoing binary is recoverable for a rollback.
    expect(files.get("/hostcli/bin/.switchroom-versions/switchroom-0.21.0")).toBe(
      "OLD-BINARY",
    );
  });

  it("installs the shipped-asset payload under the bound PREFIX, not the bindir", async () => {
    // Regression guard for the mount choice in host-cli-heal.ts: the payload
    // root is `<prefix>/share/switchroom`, so binding only `<prefix>/bin`
    // would write the payload into the helper's throwaway filesystem.
    const { io, links, files } = makeIo();
    const r = await runHostCliUpgrade(
      { binary: HOST_BINARY, pin: "v0.22.0", from: "0.21.0" },
      io,
    );
    expect(r.ok).toBe(true);
    // `<prefix>/share/switchroom` is the symlink, pointing at the versioned dir.
    expect(links.get("/hostcli/share/switchroom")).toBe("switchroom-0.22.0");
    expect(files.has("/hostcli/share/switchroom-0.22.0/switchroom-assets.json")).toBe(
      true,
    );
  });

  it("fails when the swapped binary does not report the pin", async () => {
    // The whole point of the gate is that the HOST binary is the target
    // version. A swap that lands the wrong build must not report success.
    let calls = 0;
    const { io, files } = makeIo({
      self: {
        probeBinary: () => {
          calls += 1;
          // First call proves the staged candidate inside performSelfUpdate;
          // the second is host-cli-upgrade re-probing the installed path.
          return { ok: true, version: calls === 1 ? "0.22.0" : "0.21.0" };
        },
      },
    });
    const r = await runHostCliUpgrade(
      { binary: HOST_BINARY, pin: "v0.22.0", from: "0.21.0" },
      io,
    );
    expect(r.ok).toBe(false);
    expect(r.error).toContain("the install did not land");
    expect(files.get(HOST_BINARY)).toBe("NEW-BINARY");
  });

  it("surfaces a checksum mismatch as a failure and leaves the binary alone", async () => {
    const { io, files } = makeIo({ self: { sha256File: () => "f".repeat(64) } });
    const r = await runHostCliUpgrade(
      { binary: HOST_BINARY, pin: "v0.22.0", from: "0.21.0" },
      io,
    );
    expect(r.ok).toBe(false);
    expect(files.get(HOST_BINARY)).toBe("OLD-BINARY");
  });

  it("hands ownership back even when the update FAILS", async () => {
    // `performSelfUpdate` mkdirp's `<bindir>/.switchroom-versions` as its first
    // action, as root. A failure after that point used to return before the
    // handoff, leaving a root-owned directory inside an operator-owned bindir
    // — which permanently EACCESes the operator's own `switchroom update` and
    // the non-root self-heal timer.
    const { io, owners, strays } = makeIo({ self: { sha256File: () => "f".repeat(64) } });
    const r = await runHostCliUpgrade(
      { binary: HOST_BINARY, pin: "v0.22.0", from: "0.21.0" },
      io,
    );
    expect(r.ok).toBe(false);
    expect(owners.get("/hostcli/bin/.switchroom-versions")).toEqual({
      uid: 1000,
      gid: 1000,
    });
    expect(strays()).toEqual([]);
  });

  it("leaves NOTHING under the bound prefix owned by root", async () => {
    // The helper runs as root; anything it leaves behind breaks the operator's
    // next update. Asserted over the fixture's ownership map — not over the
    // chown call list, which by construction only ever names the handoff's own
    // target uid and so cannot detect a path the walk never reached.
    const { io, owners, strays } = makeIo();
    const r = await runHostCliUpgrade(
      { binary: HOST_BINARY, pin: "v0.22.0", from: "0.21.0" },
      io,
    );
    expect(r.ok).toBe(true);
    expect(strays()).toEqual([]);
    // Spot-check the three shapes that each regressed independently: the
    // bindir store, `<prefix>/share` (created by installAssetPayload's mkdirp),
    // the symlink, and a payload entry nested past any small depth bound.
    for (const p of [
      HOST_BINARY,
      "/hostcli/bin/.switchroom-versions",
      "/hostcli/share",
      "/hostcli/share/switchroom",
      "/hostcli/share/switchroom-0.22.0/skills/telegram/access/scripts/lib/pair.sh",
    ]) {
      expect({ [p]: owners.get(p) }).toEqual({ [p]: { uid: 1000, gid: 1000 } });
    }
  });

  it("does not chown when the binary was already owned by the running uid", async () => {
    const { io, chowned } = makeIo({ io: { getuid: () => 1000 } });
    const r = await runHostCliUpgrade(
      { binary: HOST_BINARY, pin: "v0.22.0", from: "0.21.0" },
      io,
    );
    expect(r.ok).toBe(true);
    expect(chowned).toEqual([]);
  });

  it("still succeeds when the ownership handoff fails", async () => {
    const { io } = makeIo({
      io: {
        chown: () => {
          throw new Error("EPERM");
        },
      },
    });
    const lines: string[] = [];
    const r = await runHostCliUpgrade(
      { binary: HOST_BINARY, pin: "v0.22.0", from: "0.21.0" },
      io,
      (s) => lines.push(s),
    );
    expect(r.ok).toBe(true);
    expect(lines.join("")).toContain("could not hand ownership back");
  });
});

describe("handBackOwnership", () => {
  it("skips paths that do not exist and reports per-path failures", () => {
    const { io } = makeIo({
      io: {
        kind: (p) =>
          p === "/hostcli/bin/switchroom" || p === "/nope" ? "file" : undefined,
        list: () => [],
        chown: (p) => {
          if (p === "/nope") throw new Error("EPERM");
        },
      },
    });
    const failures = handBackOwnership(
      ["/hostcli/bin/switchroom", "/nope", "/absent"],
      { uid: 1000, gid: 1000 },
      io,
    );
    expect(failures).toEqual(["/nope: EPERM"]);
  });

  it("walks a directory tree to ANY depth", () => {
    // The payload's `skills/` tree is six to eight levels deep; a bounded walk
    // silently leaves its leaves root-owned.
    const deep = "/root/a/b/c/d/e/f/leaf";
    const { io } = makeIo({
      io: {
        kind: (p) => (p === deep ? "file" : deep.startsWith(`${p}/`) ? "dir" : undefined),
        list: (d) => (deep.startsWith(`${d}/`) ? [deep.slice(d.length + 1).split("/")[0]] : []),
      },
    });
    const chowns: string[] = [];
    io.chown = (p) => void chowns.push(p);
    expect(handBackOwnership(["/root"], { uid: 1000, gid: 1000 }, io)).toEqual([]);
    expect(chowns).toContain(deep);
  });

  it("re-owns a symlink itself and does not walk through it", () => {
    // `<prefix>/share/switchroom` is a symlink. Following it would chown the
    // target tree twice at best, and an unrelated tree at worst.
    const { io } = makeIo({
      io: {
        kind: (p) => (p === "/link" ? "symlink" : undefined),
        list: () => {
          throw new Error("must not enumerate a symlink");
        },
      },
    });
    const chowns: string[] = [];
    io.chown = (p) => void chowns.push(p);
    expect(handBackOwnership(["/link"], { uid: 1000, gid: 1000 }, io)).toEqual([]);
    expect(chowns).toEqual(["/link"]);
  });
});

describe("the result sentinel", () => {
  it("round-trips a success through a noisy log blob", () => {
    const line = encodeHostCliUpgradeResult({
      ok: true,
      version: "v0.22.0",
      binaryPath: HOST_BINARY,
    });
    const parsed = parseHostCliUpgradeResult(
      `downloading...\nverifying checksum\n${line}\n`,
    );
    expect(parsed).toEqual({ ok: true, version: "v0.22.0", binaryPath: HOST_BINARY });
  });

  it("returns null when the helper produced no sentinel", () => {
    expect(parseHostCliUpgradeResult("Segmentation fault\n")).toBeNull();
  });

  it("returns null on a malformed sentinel rather than inventing a verdict", () => {
    expect(parseHostCliUpgradeResult("SWITCHROOM_HOST_CLI_UPGRADE:{oops")).toBeNull();
    expect(parseHostCliUpgradeResult('SWITCHROOM_HOST_CLI_UPGRADE:{"version":"v1"}')).toBeNull();
  });

  it("takes the LAST sentinel when the log carries more than one", () => {
    const blob = [
      encodeHostCliUpgradeResult({ ok: true, version: "v0.1.0" }),
      encodeHostCliUpgradeResult({ ok: false, error: "boom" }),
    ].join("\n");
    expect(parseHostCliUpgradeResult(blob)).toEqual({ ok: false, error: "boom" });
  });
});
