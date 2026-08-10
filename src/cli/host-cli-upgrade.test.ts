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
    [HOST_BINARY, { uid: 1000, gid: 1000 }],
  ]);
  const chowned: string[] = [];
  const dirnameOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";

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
        return;
      }
      files.set(dest, "NEW-BINARY");
    },
    sha256File: () => GOOD_SHA,
    probeBinaryVersion: () => "0.22.0",
    mkdirp: (d) => void dirs.add(d),
    copyFile: (src, dest) => void files.set(dest, files.get(realpath(src)) ?? ""),
    chmodExec: () => {},
    rename: (src, dest) => {
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
    exists: existsIn,
    dirname: dirnameOf,
    readText: (p) => files.get(realpath(p)) ?? null,
    extractTarGz: (archive, destDir) => {
      const body = files.get(archive);
      if (body === undefined) throw new Error(`no such archive: ${archive}`);
      const tag = body.startsWith("PAYLOAD:") ? body.slice("PAYLOAD:".length) : "v0.0.0";
      dirs.add(destDir);
      files.set(
        `${destDir}/switchroom-assets.json`,
        JSON.stringify({ version: tag, entries: ["profiles"] }),
      );
      files.set(`${destDir}/profiles/_base/start.sh.hbs`, "#!/bin/sh\n");
    },
    symlink: (target, linkPath) => void links.set(linkPath, target),
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
    exists: existsIn,
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
  return { io, self, files, links, chowned, owners };
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
        probeBinaryVersion: () => {
          calls += 1;
          // First call proves the staged candidate inside performSelfUpdate;
          // the second is host-cli-upgrade re-probing the installed path.
          return calls === 1 ? "0.22.0" : "0.21.0";
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

  it("hands the swapped tree back to the pre-swap owner", async () => {
    // The helper runs as root; leaving root-owned files in an operator's
    // ~/.local/bin would break the non-root host self-heal on the next tick.
    const { io, chowned } = makeIo();
    const r = await runHostCliUpgrade(
      { binary: HOST_BINARY, pin: "v0.22.0", from: "0.21.0" },
      io,
    );
    expect(r.ok).toBe(true);
    expect(chowned).toContain(`${HOST_BINARY}:1000:1000`);
    expect(chowned.some((c) => c.startsWith("/hostcli/bin/.switchroom-versions:"))).toBe(
      true,
    );
    expect(chowned.some((c) => c.startsWith("/hostcli/share/switchroom:"))).toBe(true);
    // Nothing is left owned by root.
    expect(chowned.every((c) => c.endsWith(":1000:1000"))).toBe(true);
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
        exists: (p) => p === "/hostcli/bin/switchroom" || p === "/nope",
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
