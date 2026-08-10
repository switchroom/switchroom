/**
 * `switchroom update` × host-CLI self-update wiring (#3919).
 *
 * These assert the OUTCOMES that the pre-#3919 pipeline got wrong:
 *
 *   1. The host CLI is in scope at all — before this change nothing on a
 *      host ever updated it, which is how the reference host's CLI reached
 *      0.19.23 against a v0.19.28 fleet.
 *   2. It is updated FIRST. `apply-config` renders per-agent scaffolds from
 *      Handlebars templates that ship inside the installed CLI, so a
 *      self-update ordered after apply renders the run from the OLD
 *      templates — the drift, one release later.
 *   3. Whole-host update is the DEFAULT; the scope control is an opt-out.
 *   4. After a swap the process re-execs the NEW binary — a process cannot
 *      begin executing a replacement of its own file — with loop guards.
 */

import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { planUpdate, runUpdate, buildReexecArgs } from "./update.js";
import { SWITCHROOM_VERSION } from "./resolve-version.js";
import type { SelfUpdateIO } from "./self-update.js";

function withCompose<T>(fn: (composePath: string) => T): T {
  const tmp = mkdtempSync(join(tmpdir(), "update-selfupd-"));
  try {
    const composePath = join(tmp, "docker-compose.yml");
    writeFileSync(composePath, "services: {}\n");
    return fn(composePath);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const baseOpts = {
  hostControlEnabled: false,
  webServiceManaged: false,
  memoryBackendHindsight: false,
  syncBundledSkillsFn: () => {},
  agentNamesFn: () => [] as string[],
  writeMarkerFn: () => {},
  componentExec: () => ({ status: 1, stdout: "" }),
};

/**
 * A self-update IO that swaps successfully, with no network or disk.
 *
 * It also models enough of a filesystem (symlinks, subtree renames) for the
 * shipped-asset payload install (#4163), because the payload is not optional:
 * `performSelfUpdate` and the convergence path both go through it, and an IO
 * that could not satisfy it would let these tests pass against a build that
 * had quietly dropped the payload.
 */
function fakeIO(): SelfUpdateIO & { files: Map<string, string>; links: Map<string, string> } {
  const files = new Map<string, string>([["/usr/local/bin/switchroom", "OLD"]]);
  const links = new Map<string, string>();
  const dirnameOf = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
  const under = (prefix: string) =>
    [...files.keys()].filter((k) => k === prefix || k.startsWith(`${prefix}/`));
  const removeTree = (p: string) => {
    for (const k of under(p)) files.delete(k);
    links.delete(p);
  };
  return {
    files,
    links,
    httpGetText: async (url) =>
      url.endsWith("switchroom-checksums.txt")
        ? `${"a".repeat(64)}  switchroom-linux-amd64\n${"a".repeat(64)}  switchroom-linux-arm64\n${"a".repeat(64)}  switchroom-macos-amd64\n${"a".repeat(64)}  switchroom-macos-arm64\n${"a".repeat(64)}  switchroom-assets.tar.gz\n`
        : '{"tag_name":"v9.9.9"}',
    httpDownload: async (url, dest) => {
      const tag = /download\/(v[^/]+)\//.exec(url)?.[1] ?? "v9.9.9";
      files.set(dest, url.endsWith(".tar.gz") ? `PAYLOAD:${tag}` : "NEW");
    },
    sha256File: () => "a".repeat(64),
    probeBinary: () => ({ ok: true, version: "9.9.9" }),
    mkdirp: () => {},
    copyFile: (s, d) => void files.set(d, files.get(s) ?? ""),
    chmodExec: () => {},
    rename: (s, d) => {
      if (links.has(s)) {
        links.set(d, links.get(s) as string);
        links.delete(s);
        return;
      }
      for (const k of under(s)) {
        files.set(d + k.slice(s.length), files.get(k) as string);
        files.delete(k);
      }
    },
    remove: (p) => {
      files.delete(p);
      links.delete(p);
    },
    exists: (p) => files.has(p) || links.has(p) || under(p).length > 0,
    dirname: dirnameOf,
    readText: (p) => {
      const direct = files.get(p);
      if (direct !== undefined) return direct;
      // Resolve one level of symlink on any ancestor, as readText(2) would.
      for (const [link, target] of links) {
        if (p.startsWith(`${link}/`)) {
          const real = `${dirnameOf(link)}/${target}${p.slice(link.length)}`;
          const v = files.get(real);
          if (v !== undefined) return v;
        }
      }
      return null;
    },
    extractTarGz: (archive, destDir) => {
      const tag = (files.get(archive) ?? "").replace(/^PAYLOAD:/, "");
      files.set(
        `${destDir}/switchroom-assets.json`,
        JSON.stringify({ version: tag, entries: ["profiles"], files: 1 }),
      );
      files.set(`${destDir}/profiles/_base/start.sh.hbs`, "#!/bin/sh\n");
    },
    symlink: (target, linkPath) => void links.set(linkPath, target),
    isSymlink: (p) => links.has(p),
    removeTree,
    listDir: (dir) => {
      const names = new Set<string>();
      for (const k of [...files.keys(), ...links.keys()]) {
        if (k.startsWith(`${dir}/`)) names.add(k.slice(dir.length + 1).split("/")[0]);
      }
      return [...names];
    },
  };
}

const STATIC_PROBE = {
  bundleDir: "/$bunfs/root",
  execPath: "/usr/local/bin/switchroom",
  scriptPath: "/$bunfs/root/switchroom",
  inContainer: false,
};

describe("self-update-cli is in the plan, first, by default", () => {
  it("is the FIRST step — ahead of apply-config, which renders from CLI templates", () => {
    withCompose((composePath) => {
      const names = planUpdate({ composePath, ...baseOpts }).map((s) => s.name);
      expect(names[0]).toBe("self-update-cli");
      expect(names.indexOf("self-update-cli")).toBeLessThan(
        names.indexOf("apply-config"),
      );
    });
  });

  it("still precedes persist-release-pin and the compose regen under --pin", () => {
    withCompose((composePath) => {
      const names = planUpdate({
        composePath,
        ...baseOpts,
        pin: "v1.2.3",
        persistPinFn: () => {},
      }).map((s) => s.name);
      expect(names[0]).toBe("self-update-cli");
      expect(names).toContain("persist-release-pin");
      expect(names.indexOf("self-update-cli")).toBeLessThan(
        names.indexOf("persist-release-pin"),
      );
    });
  });

  it("runs by DEFAULT — whole-host update is opt-out, not opt-in", () => {
    withCompose((composePath) => {
      const step = planUpdate({ composePath, ...baseOpts }).find(
        (s) => s.name === "self-update-cli",
      );
      expect(step?.skipReason).toBeUndefined();
    });
  });

  it("--skip-self-update opts out, and --check says so", async () => {
    await withCompose(async (composePath) => {
      const step = planUpdate({
        composePath,
        ...baseOpts,
        skipSelfUpdate: true,
      }).find((s) => s.name === "self-update-cli");
      expect(step?.skipReason).toBe("--skip-self-update flag set");

      let out = "";
      const code = await runUpdate({
        composePath,
        ...baseOpts,
        skipSelfUpdate: true,
        check: true,
        stdout: (s) => {
          out += s;
        },
        stderr: () => {},
      });
      expect(code).toBe(0);
      expect(out).toContain("self-update-cli");
      expect(out).toContain("--skip-self-update flag set");
    });
  });

  it("--check names the step as [run] when it is NOT opted out", async () => {
    await withCompose(async (composePath) => {
      let out = "";
      await runUpdate({
        composePath,
        ...baseOpts,
        check: true,
        stdout: (s) => {
          out += s;
        },
        stderr: () => {},
      });
      // The step is listed and not marked skipped.
      const line = out
        .split("\n")
        .find((l) => l.includes("self-update-cli"));
      expect(line).toBeDefined();
      expect(line).not.toContain("[skip]");
    });
  });
});

describe("--check reports component drift", () => {
  it("names every component behind the pin, including the CLI itself", async () => {
    await withCompose(async (composePath) => {
      let out = "";
      await runUpdate({
        composePath,
        ...baseOpts,
        check: true,
        componentExec: () => ({
          status: 0,
          stdout: [
            "switchroom-hostd\tghcr.io/switchroom/switchroom-hostd:v0.19.28",
            "switchroom-hindsight-autoheal\tghcr.io/switchroom/switchroom-hostd:v0.19.26",
            "switchroom-web\tghcr.io/switchroom/switchroom-web:v0.19.26",
          ].join("\n"),
        }),
        stdout: (s) => {
          out += s;
        },
        stderr: () => {},
      });
      expect(out).toContain("BEHIND   switchroom-web — v0.19.26");
      expect(out).toContain("BEHIND   switchroom-hindsight-autoheal — v0.19.26");
      expect(out).toContain("component(s) BEHIND");
    });
  });
});

describe("swap → re-exec", () => {
  it("re-execs the NEW binary for the remaining steps and adopts its exit code", async () => {
    await withCompose(async (composePath) => {
      const reexec: Array<{ bin: string; args: string[] }> = [];
      const ranAfter: string[] = [];
      const code = await runUpdate({
        composePath,
        ...baseOpts,
        installProbe: STATIC_PROBE,
        selfUpdateIO: fakeIO(),
        latestReleaseTagFn: async () => "v9.9.9",
        runner: (cmd, args) => {
          ranAfter.push(`${cmd} ${args[1] ?? args[0]}`);
          return { status: 0 };
        },
        reexecFn: (bin, args) => {
          reexec.push({ bin, args });
          return { status: 0 };
        },
        stdout: () => {},
        stderr: () => {},
      });
      expect(code).toBe(0);
      expect(reexec).toHaveLength(1);
      expect(reexec[0].bin).toBe("/usr/local/bin/switchroom");
      expect(reexec[0].args).toEqual(["update", "--skip-self-update"]);
      // The OLD process must NOT go on to run apply-config etc. — that is
      // the whole reason to re-exec.
      expect(ranAfter).toEqual([]);
    });
  });

  it("propagates a non-zero exit from the re-exec'd binary", async () => {
    await withCompose(async (composePath) => {
      const code = await runUpdate({
        composePath,
        ...baseOpts,
        installProbe: STATIC_PROBE,
        selfUpdateIO: fakeIO(),
        latestReleaseTagFn: async () => "v9.9.9",
        reexecFn: () => ({ status: 3 }),
        stdout: () => {},
        stderr: () => {},
      });
      expect(code).toBe(3);
    });
  });

  it("does NOT re-exec when the CLI was already current", async () => {
    await withCompose(async (composePath) => {
      let reexeced = false;
      await runUpdate({
        composePath,
        ...baseOpts,
        installProbe: STATIC_PROBE,
        selfUpdateIO: fakeIO(),
        // Older than the running CLI → nothing to do.
        latestReleaseTagFn: async () => "v0.0.1",
        runner: () => ({ status: 0 }),
        reexecFn: () => {
          reexeced = true;
          return { status: 0 };
        },
        stdout: () => {},
        stderr: () => {},
      });
      expect(reexeced).toBe(false);
    });
  });

  it("fails the whole update when the swap fails — never silently continues stale", async () => {
    await withCompose(async (composePath) => {
      let err = "";
      const code = await runUpdate({
        composePath,
        ...baseOpts,
        installProbe: STATIC_PROBE,
        selfUpdateIO: {
          ...fakeIO(),
          // downloaded binary won't run
          probeBinary: () => ({
            ok: false as const,
            kind: "ran-but-failed" as const,
            detail: "exit 1",
          }),
        },
        latestReleaseTagFn: async () => "v9.9.9",
        runner: () => ({ status: 0 }),
        reexecFn: () => ({ status: 0 }),
        stdout: () => {},
        stderr: (s) => {
          err += s;
        },
      });
      expect(code).toBe(1);
      expect(err).toContain("self-update-cli failed");
      expect(err).toContain("the artifact itself is faulty");
    });
  });
});

describe("shipped-asset payload convergence (#4163)", () => {
  it("installs the payload alongside the binary on a real self-update", async () => {
    await withCompose(async (composePath) => {
      const io = fakeIO();
      await runUpdate({
        composePath,
        ...baseOpts,
        installProbe: STATIC_PROBE,
        selfUpdateIO: io,
        latestReleaseTagFn: async () => "v9.9.9",
        runner: () => ({ status: 0 }),
        reexecFn: () => ({ status: 0 }),
        stdout: () => {},
        stderr: () => {},
      });
      expect(io.links.get("/usr/local/share/switchroom")).toBe("switchroom-9.9.9");
      expect(
        io.files.get("/usr/local/share/switchroom-9.9.9/profiles/_base/start.sh.hbs"),
      ).toBeDefined();
    });
  });

  it("REPAIRS a missing payload even when the CLI is already current", async () => {
    // Ordering payload-before-binary is only safe if a half-finished update
    // can still finish. Without this the "already current" path would short-
    // circuit and the host would sit on a new CLI with no templates forever.
    await withCompose(async (composePath) => {
      const io = fakeIO();
      let out = "";
      await runUpdate({
        composePath,
        ...baseOpts,
        installProbe: STATIC_PROBE,
        selfUpdateIO: {
          ...io,
          httpGetText: async (url) =>
            url.endsWith("switchroom-checksums.txt")
              ? `${"a".repeat(64)}  switchroom-assets.tar.gz\n`
              : `{"tag_name":"v${SWITCHROOM_VERSION}"}`,
        },
        latestReleaseTagFn: async () => `v${SWITCHROOM_VERSION}`,
        runner: () => ({ status: 0 }),
        reexecFn: () => ({ status: 0 }),
        stdout: (s) => {
          out += s;
        },
        stderr: () => {},
      });
      // The CLI itself needed nothing…
      expect(out).toContain("already on");
      // The repair actually happened — not just a log line.
      expect(io.links.get("/usr/local/share/switchroom")).toBe(
        `switchroom-${SWITCHROOM_VERSION}`,
      );
    });
  });

  it("does not re-download the payload when it is already the current version", async () => {
    await withCompose(async (composePath) => {
      const io = fakeIO();
      // Pre-publish the payload the way a completed update leaves it.
      io.files.set(
        `/usr/local/share/switchroom-${SWITCHROOM_VERSION}/switchroom-assets.json`,
        JSON.stringify({ version: `v${SWITCHROOM_VERSION}`, entries: ["profiles"], files: 1 }),
      );
      io.links.set("/usr/local/share/switchroom", `switchroom-${SWITCHROOM_VERSION}`);
      let downloads = 0;
      await runUpdate({
        composePath,
        ...baseOpts,
        installProbe: STATIC_PROBE,
        selfUpdateIO: {
          ...io,
          httpDownload: async (...args) => {
            downloads += 1;
            return io.httpDownload(...args);
          },
        },
        latestReleaseTagFn: async () => `v${SWITCHROOM_VERSION}`,
        runner: () => ({ status: 0 }),
        reexecFn: () => ({ status: 0 }),
        stdout: () => {},
        stderr: () => {},
      });
      expect(downloads).toBe(0);
    });
  });

  it("fails the update when the payload cannot be installed — never a new CLI on old templates", async () => {
    await withCompose(async (composePath) => {
      const io = fakeIO();
      let err = "";
      const code = await runUpdate({
        composePath,
        ...baseOpts,
        installProbe: STATIC_PROBE,
        selfUpdateIO: {
          ...io,
          extractTarGz: () => {
            throw new Error("tar: unexpected EOF");
          },
        },
        latestReleaseTagFn: async () => "v9.9.9",
        runner: () => ({ status: 0 }),
        reexecFn: () => ({ status: 0 }),
        stdout: () => {},
        stderr: (s) => {
          err += s;
        },
      });
      expect(code).toBe(1);
      expect(err).toContain("self-update-cli failed");
      expect(io.files.get("/usr/local/bin/switchroom")).toBe("OLD");
    });
  });
});

describe("buildReexecArgs", () => {
  it("always carries the loop guard", () => {
    expect(buildReexecArgs({})).toEqual(["update", "--skip-self-update"]);
  });

  it("forwards the flags that still matter after the swap", () => {
    expect(
      buildReexecArgs({ skipImages: true, pin: "v1.2.3" }),
    ).toEqual(["update", "--skip-self-update", "--skip-images", "--pin", "v1.2.3"]);
    expect(buildReexecArgs({ channel: "rc" })).toEqual([
      "update",
      "--skip-self-update",
      "--channel",
      "rc",
    ]);
  });
});
