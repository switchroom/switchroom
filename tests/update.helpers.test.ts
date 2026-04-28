/**
 * Unit tests for the helper functions added to src/cli/update.ts as part of
 * the four update-reliability fixes.
 *
 * These tests exercise pure logic and file-system helpers. They do NOT shell
 * out to git or invoke the full runUpdate flow — that's an integration concern.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, utimesSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  BUILD_INFO_FILE,
  classifyDirtyTree,
  isDistStale,
  readLastDeployedSha,
  writeLastDeployedSha,
  extractBuiltSha,
} from "../src/cli/update.js";

// ─── Fix 1: classifyDirtyTree ──────────────────────────────────────────────

describe("classifyDirtyTree", () => {
  it("returns buildInfoOnly=false and empty otherLines for a clean tree", () => {
    const { buildInfoOnly, otherLines } = classifyDirtyTree("");
    expect(buildInfoOnly).toBe(false);
    expect(otherLines).toEqual([]);
  });

  it("detects when only src/build-info.ts is dirty (modified)", () => {
    const porcelain = ` M ${BUILD_INFO_FILE}`;
    const { buildInfoOnly, otherLines } = classifyDirtyTree(porcelain);
    expect(buildInfoOnly).toBe(true);
    expect(otherLines).toHaveLength(0);
  });

  it("detects when only src/build-info.ts is dirty (staged)", () => {
    const porcelain = `M  ${BUILD_INFO_FILE}`;
    const { buildInfoOnly, otherLines } = classifyDirtyTree(porcelain);
    expect(buildInfoOnly).toBe(true);
    expect(otherLines).toHaveLength(0);
  });

  it("returns buildInfoOnly=false when other files are also dirty", () => {
    const porcelain = [
      ` M ${BUILD_INFO_FILE}`,
      " M src/cli/update.ts",
    ].join("\n");
    const { buildInfoOnly, otherLines } = classifyDirtyTree(porcelain);
    expect(buildInfoOnly).toBe(false);
    expect(otherLines).toContain(" M src/cli/update.ts");
  });

  it("returns buildInfoOnly=false when build-info.ts is NOT dirty", () => {
    const porcelain = " M src/cli/update.ts";
    const { buildInfoOnly, otherLines } = classifyDirtyTree(porcelain);
    expect(buildInfoOnly).toBe(false);
    expect(otherLines).toHaveLength(1);
  });

  it("includes the non-build-info lines in otherLines", () => {
    const porcelain = [
      "M  src/agents/scaffold.ts",
      "?? newfile.txt",
    ].join("\n");
    const { buildInfoOnly, otherLines } = classifyDirtyTree(porcelain);
    expect(buildInfoOnly).toBe(false);
    expect(otherLines).toHaveLength(2);
    expect(otherLines).toContain("M  src/agents/scaffold.ts");
    expect(otherLines).toContain("?? newfile.txt");
  });
});

// ─── Fix 3: isDistStale ────────────────────────────────────────────────────

describe("isDistStale", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-update-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true when the dist file does not exist", () => {
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    writeFileSync(join(tmpDir, "src", "foo.ts"), "export const x = 1;");
    expect(isDistStale(tmpDir, "dist/cli/switchroom.js", ["src"])).toBe(true);
  });

  it("returns false when dist file exists and no source files are newer", () => {
    mkdirSync(join(tmpDir, "dist", "cli"), { recursive: true });
    mkdirSync(join(tmpDir, "src"), { recursive: true });

    // Write source first
    const srcFile = join(tmpDir, "src", "foo.ts");
    writeFileSync(srcFile, "export const x = 1;");

    // Write dist after, then backdating it to ensure it's not "newer"
    const distFile = join(tmpDir, "dist", "cli", "switchroom.js");
    writeFileSync(distFile, "// bundled");

    // Set source mtime to far in the past so dist is definitively newer
    const pastDate = new Date(Date.now() - 10_000);
    utimesSync(srcFile, pastDate, pastDate);

    expect(isDistStale(tmpDir, "dist/cli/switchroom.js", ["src"])).toBe(false);
  });

  it("returns true when a source file is newer than the dist file", () => {
    mkdirSync(join(tmpDir, "dist", "cli"), { recursive: true });
    mkdirSync(join(tmpDir, "src"), { recursive: true });

    const distFile = join(tmpDir, "dist", "cli", "switchroom.js");
    writeFileSync(distFile, "// bundled");

    // Set dist mtime to far in the past so source is definitively newer
    const pastDate = new Date(Date.now() - 10_000);
    utimesSync(distFile, pastDate, pastDate);

    // Write source AFTER backdating dist
    const srcFile = join(tmpDir, "src", "foo.ts");
    writeFileSync(srcFile, "export const x = 2;");

    expect(isDistStale(tmpDir, "dist/cli/switchroom.js", ["src"])).toBe(true);
  });

  it("ignores missing source directories gracefully", () => {
    mkdirSync(join(tmpDir, "dist", "cli"), { recursive: true });
    const distFile = join(tmpDir, "dist", "cli", "switchroom.js");
    writeFileSync(distFile, "// bundled");

    // Source dirs don't exist
    expect(isDistStale(tmpDir, "dist/cli/switchroom.js", ["src", "bin"])).toBe(false);
  });

  it("checks multiple source dirs — stale if any dir has a newer file", () => {
    mkdirSync(join(tmpDir, "dist", "cli"), { recursive: true });
    mkdirSync(join(tmpDir, "src"), { recursive: true });
    mkdirSync(join(tmpDir, "bin"), { recursive: true });

    const distFile = join(tmpDir, "dist", "cli", "switchroom.js");
    writeFileSync(distFile, "// bundled");

    // Backdate dist
    const pastDate = new Date(Date.now() - 10_000);
    utimesSync(distFile, pastDate, pastDate);

    // Only bin/ has a newer file
    writeFileSync(join(tmpDir, "bin", "entry.ts"), "#!/usr/bin/env bun");

    expect(isDistStale(tmpDir, "dist/cli/switchroom.js", ["src", "bin"])).toBe(true);
  });
});

// ─── Fix 4: readLastDeployedSha / writeLastDeployedSha / extractBuiltSha ──

describe("readLastDeployedSha", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-sha-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null when the state file does not exist (first run)", () => {
    expect(readLastDeployedSha(join(tmpDir, "missing.json"))).toBeNull();
  });

  it("returns null on malformed JSON", () => {
    const f = join(tmpDir, "bad.json");
    writeFileSync(f, "{ not json }", "utf-8");
    expect(readLastDeployedSha(f)).toBeNull();
  });

  it("returns null when sha field is missing", () => {
    const f = join(tmpDir, "noshafield.json");
    writeFileSync(f, JSON.stringify({ other: "data" }), "utf-8");
    expect(readLastDeployedSha(f)).toBeNull();
  });

  it("reads back the SHA written by writeLastDeployedSha", () => {
    const f = join(tmpDir, "sha.json");
    writeLastDeployedSha("abc1234", f);
    expect(readLastDeployedSha(f)).toBe("abc1234");
  });
});

describe("writeLastDeployedSha", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-sha-write-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates parent directories if they don't exist", () => {
    const nested = join(tmpDir, "a", "b", "c", "sha.json");
    writeLastDeployedSha("deadbeef", nested);
    expect(existsSync(nested)).toBe(true);
    expect(readLastDeployedSha(nested)).toBe("deadbeef");
  });

  it("overwrites an existing state file", () => {
    const f = join(tmpDir, "sha.json");
    writeLastDeployedSha("oldsha", f);
    writeLastDeployedSha("newsha", f);
    expect(readLastDeployedSha(f)).toBe("newsha");
  });
});

describe("extractBuiltSha", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-extractsha-test-"));
    mkdirSync(join(tmpDir, "src"), { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("extracts the SHA from a realistic build-info.ts", () => {
    const content = `// AUTO-GENERATED by scripts/build.mjs — do not edit by hand.
export const VERSION: string = "1.2.3";
export const COMMIT_SHA: string | null = "a1b2c3d";
export const COMMIT_DATE: string | null = "2026-04-28T00:00:00Z";
export const LATEST_PR: number | null = 42;
export const COMMITS_AHEAD_OF_TAG: number | null = 5;
`;
    writeFileSync(join(tmpDir, BUILD_INFO_FILE), content, "utf-8");
    expect(extractBuiltSha(tmpDir)).toBe("a1b2c3d");
  });

  it("returns null when COMMIT_SHA is null", () => {
    const content = `// AUTO-GENERATED by scripts/build.mjs — do not edit by hand.
export const VERSION: string = "1.2.3";
export const COMMIT_SHA: string | null = null;
export const COMMIT_DATE: string | null = null;
export const LATEST_PR: number | null = null;
export const COMMITS_AHEAD_OF_TAG: number | null = null;
`;
    writeFileSync(join(tmpDir, BUILD_INFO_FILE), content, "utf-8");
    expect(extractBuiltSha(tmpDir)).toBeNull();
  });

  it("returns null when build-info.ts does not exist", () => {
    expect(extractBuiltSha(tmpDir)).toBeNull();
  });

  it("returns null when COMMIT_SHA line is missing", () => {
    const content = `// AUTO-GENERATED
export const VERSION: string = "1.0.0";
`;
    writeFileSync(join(tmpDir, BUILD_INFO_FILE), content, "utf-8");
    expect(extractBuiltSha(tmpDir)).toBeNull();
  });
});
