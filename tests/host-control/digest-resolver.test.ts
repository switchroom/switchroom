import { describe, it, expect, vi, afterEach } from "vitest";

// vi.mock must be at module top to hoist correctly.
vi.mock("node:child_process", async (orig) => {
  const real = (await orig()) as typeof import("node:child_process");
  return { ...real, spawnSync: vi.fn() };
});

import { spawnSync } from "node:child_process";
import { resolveDigests, readCachedInstallType } from "../../src/host-control/server.js";
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const spawnSyncMock = spawnSync as unknown as ReturnType<typeof vi.fn>;

afterEach(() => {
  spawnSyncMock.mockReset();
});

describe("resolveDigests", () => {
  it("parses RepoDigests output into a ref→sha256 map", () => {
    spawnSyncMock.mockImplementation((_cmd, args: string[]) => {
      const ref = args[args.length - 1]!;
      if (ref === "ghcr.io/switchroom/switchroom-agent:dev") {
        return {
          status: 0,
          stdout: "ghcr.io/switchroom/switchroom-agent@sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789\n",
          stderr: "",
        } as ReturnType<typeof spawnSync>;
      }
      return { status: 1, stdout: "", stderr: "no such image" } as ReturnType<typeof spawnSync>;
    });

    const out = resolveDigests([
      "ghcr.io/switchroom/switchroom-agent:dev",
      "ghcr.io/switchroom/switchroom-broker:dev",
    ]);
    expect(out.size).toBe(1);
    expect(out.get("ghcr.io/switchroom/switchroom-agent:dev")).toBe(
      "sha256:abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    );
  });

  it("returns empty map on docker error / fails soft", () => {
    spawnSyncMock.mockImplementation(() => {
      throw new Error("ENOENT: docker");
    });
    const out = resolveDigests(["foo:bar"]);
    expect(out.size).toBe(0);
  });

  it("skips refs whose stdout does not contain an @sha256: pin", () => {
    spawnSyncMock.mockReturnValue({
      status: 0,
      stdout: "<no value>\n",
      stderr: "",
    } as ReturnType<typeof spawnSync>);
    const out = resolveDigests(["foo:bar"]);
    expect(out.size).toBe(0);
  });
});

describe("readCachedInstallType", () => {
  it("reads a pre-existing cache file unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "itc-cache-"));
    try {
      mkdirSync(join(root, ".switchroom"), { recursive: true });
      writeFileSync(
        join(root, ".switchroom", "install-type.json"),
        JSON.stringify({
          install_type: "binary",
          detected_at: "2026-05-17T00:00:00.000Z",
          source_paths: { bin: "/usr/local/bin/switchroom" },
        }),
      );
      const got = readCachedInstallType(root);
      expect(got.install_type).toBe("binary");
      expect(got.detected_at).toBe("2026-05-17T00:00:00.000Z");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns unknown on malformed cache JSON", () => {
    const root = mkdtempSync(join(tmpdir(), "itc-bad-"));
    try {
      mkdirSync(join(root, ".switchroom"), { recursive: true });
      writeFileSync(join(root, ".switchroom", "install-type.json"), "not-json");
      const got = readCachedInstallType(root);
      expect(got.install_type).toBe("unknown");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("lazy-detects + writes cache when missing (mode 0o644)", () => {
    const root = mkdtempSync(join(tmpdir(), "itc-lazy-"));
    try {
      const got = readCachedInstallType(root);
      expect(typeof got.install_type).toBe("string");
      const path = join(root, ".switchroom", "install-type.json");
      const st = statSync(path);
      expect(st.mode & 0o777).toBe(0o644);
      const reread = JSON.parse(readFileSync(path, "utf-8"));
      expect(reread.install_type).toBe(got.install_type);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
