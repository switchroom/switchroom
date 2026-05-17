/**
 * Unit tests for `detectInstallType`.
 *
 * `node:fs` is mocked via vi.mock so each test can simulate the
 * presence / absence / symlink-state of `/usr/local/bin/switchroom`
 * and the source build artifact independently of the host.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

vi.mock("node:fs", async () => {
  return {
    existsSync: vi.fn(),
    lstatSync: vi.fn(),
    readlinkSync: vi.fn(),
  };
});

import { detectInstallType } from "./install-detect.js";

const BIN = "/usr/local/bin/switchroom";
const REPO = path.join(os.homedir(), "code", "switchroom", "dist", "cli", "switchroom.js");
const DIST_PREFIX = path.join(os.homedir(), "code", "switchroom", "dist") + path.sep;

function fakeStat(isSymlink: boolean): fs.Stats {
  return { isSymbolicLink: () => isSymlink } as unknown as fs.Stats;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("detectInstallType", () => {
  it("returns 'binary' when /usr/local/bin/switchroom is a regular file", () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p === BIN);
    vi.mocked(fs.lstatSync).mockReturnValue(fakeStat(false));
    const ctx = detectInstallType();
    expect(ctx.install_type).toBe("binary");
    expect(ctx.source_paths.bin).toBe(BIN);
  });

  it("returns 'binary' when the symlink points outside the source dist tree", () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p === BIN);
    vi.mocked(fs.lstatSync).mockReturnValue(fakeStat(true));
    vi.mocked(fs.readlinkSync).mockReturnValue(
      "/usr/local/lib/node_modules/@switchroom/cli/dist/cli/switchroom.js" as unknown as string,
    );
    const ctx = detectInstallType();
    expect(ctx.install_type).toBe("binary");
  });

  it("returns 'source' when the symlink target lives under $HOME/code/switchroom/dist/", () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.lstatSync).mockReturnValue(fakeStat(true));
    vi.mocked(fs.readlinkSync).mockReturnValue(
      (DIST_PREFIX + "cli/switchroom.js") as unknown as string,
    );
    const ctx = detectInstallType();
    expect(ctx.install_type).toBe("source");
    expect(ctx.source_paths.bin).toBe(BIN);
    expect(ctx.source_paths.repo).toBe(REPO);
  });

  it("returns 'source-unlinked' when the source artifact exists but the bin is missing", () => {
    vi.mocked(fs.existsSync).mockImplementation((p) => p === REPO);
    const ctx = detectInstallType();
    expect(ctx.install_type).toBe("source-unlinked");
    expect(ctx.source_paths.repo).toBe(REPO);
    expect(ctx.source_paths.bin).toBeUndefined();
  });

  it("returns 'docker' when neither artifact is present", () => {
    vi.mocked(fs.existsSync).mockReturnValue(false);
    const ctx = detectInstallType();
    expect(ctx.install_type).toBe("docker");
    expect(ctx.source_paths).toEqual({});
  });

  it("returns 'unknown' when fs probing throws", () => {
    vi.mocked(fs.existsSync).mockImplementation(() => {
      throw new Error("EACCES");
    });
    const ctx = detectInstallType();
    expect(ctx.install_type).toBe("unknown");
    expect(ctx.source_paths).toEqual({});
  });
});
