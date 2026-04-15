import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  ensurePythonEnv,
  PythonEnvError,
} from "../src/deps/python.js";
import { ensureNodeEnv, NodeEnvError } from "../src/deps/node.js";

function hasBin(name: string): boolean {
  try {
    execFileSync("which", [name], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

function canCreatePythonVenv(): boolean {
  if (!hasBin("python3")) return false;
  // Debian/Ubuntu often ship python3 without the venv/ensurepip packages,
  // so a bare `which python3` isn't enough. Probe an actual venv creation
  // into a throwaway path — if ensurepip is missing the real helper will
  // fail the same way, and we should skip these tests.
  const probeDir = join(
    tmpdir(),
    `switchroom-python-probe-${process.pid}-${Date.now()}`
  );
  try {
    execFileSync("python3", ["-m", "venv", probeDir], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  } finally {
    try {
      rmSync(probeDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

const PYTHON_AVAILABLE = canCreatePythonVenv();
const BUN_AVAILABLE = hasBin("bun");

describe.skipIf(!PYTHON_AVAILABLE)("ensurePythonEnv", () => {
  let tmpDir: string;
  let cacheRoot: string;
  let reqPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-python-deps-"));
    cacheRoot = join(tmpDir, "cache");
    reqPath = join(tmpDir, "requirements.txt");
    writeFileSync(reqPath, "# empty requirements\n");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lazily builds a venv and reports rebuilt=true on first call", () => {
    const env = ensurePythonEnv({
      skillName: "testskill",
      requirementsPath: reqPath,
      cacheRoot,
    });

    expect(env.rebuilt).toBe(true);
    expect(env.venvDir).toBe(join(cacheRoot, "testskill"));
    expect(existsSync(env.pythonBin)).toBe(true);
    expect(existsSync(join(env.venvDir, ".requirements.sha256"))).toBe(true);

    // Stamp file contains a sha256 hex string.
    const stamp = readFileSync(
      join(env.venvDir, ".requirements.sha256"),
      "utf8"
    ).trim();
    expect(stamp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns rebuilt=false on second call with unchanged requirements", () => {
    ensurePythonEnv({
      skillName: "idempotent",
      requirementsPath: reqPath,
      cacheRoot,
    });
    const second = ensurePythonEnv({
      skillName: "idempotent",
      requirementsPath: reqPath,
      cacheRoot,
    });
    expect(second.rebuilt).toBe(false);
    expect(existsSync(second.pythonBin)).toBe(true);
  });

  it("rebuilds when requirements content changes (hash mismatch)", () => {
    const first = ensurePythonEnv({
      skillName: "invalidate",
      requirementsPath: reqPath,
      cacheRoot,
    });
    expect(first.rebuilt).toBe(true);

    // Change the requirements content — still no actual package, just a
    // different comment, which shifts the hash.
    writeFileSync(reqPath, "# changed\n");

    const second = ensurePythonEnv({
      skillName: "invalidate",
      requirementsPath: reqPath,
      cacheRoot,
    });
    expect(second.rebuilt).toBe(true);
  });

  it("rebuilds when force=true even with identical hash", () => {
    ensurePythonEnv({
      skillName: "forced",
      requirementsPath: reqPath,
      cacheRoot,
    });
    const forced = ensurePythonEnv({
      skillName: "forced",
      requirementsPath: reqPath,
      cacheRoot,
      force: true,
    });
    expect(forced.rebuilt).toBe(true);
  });

  it("throws PythonEnvError when requirements file is missing", () => {
    expect(() =>
      ensurePythonEnv({
        skillName: "missing",
        requirementsPath: join(tmpDir, "nope.txt"),
        cacheRoot,
      })
    ).toThrow(PythonEnvError);
  });
}, 60_000);

describe.skipIf(!BUN_AVAILABLE)("ensureNodeEnv", () => {
  let tmpDir: string;
  let cacheRoot: string;
  let sourceDir: string;
  let pkgPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-node-deps-"));
    cacheRoot = join(tmpDir, "cache");
    sourceDir = join(tmpDir, "src");
    require("node:fs").mkdirSync(sourceDir, { recursive: true });
    pkgPath = join(sourceDir, "package.json");
    writeFileSync(
      pkgPath,
      JSON.stringify(
        { name: "deps-test-pkg", version: "0.0.0", dependencies: {} },
        null,
        2
      )
    );
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("lazily installs on first call and reports rebuilt=true", () => {
    const env = ensureNodeEnv({
      skillName: "testnode",
      packageJsonPath: pkgPath,
      cacheRoot,
    });

    expect(env.rebuilt).toBe(true);
    expect(env.dir).toBe(join(cacheRoot, "testnode"));
    expect(existsSync(env.nodeModulesDir)).toBe(true);
    expect(existsSync(join(env.dir, ".package.sha256"))).toBe(true);

    const stamp = readFileSync(
      join(env.dir, ".package.sha256"),
      "utf8"
    ).trim();
    expect(stamp).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns rebuilt=false on second call with unchanged package.json", () => {
    ensureNodeEnv({
      skillName: "idempotent-node",
      packageJsonPath: pkgPath,
      cacheRoot,
    });
    const second = ensureNodeEnv({
      skillName: "idempotent-node",
      packageJsonPath: pkgPath,
      cacheRoot,
    });
    expect(second.rebuilt).toBe(false);
    expect(existsSync(second.nodeModulesDir)).toBe(true);
  });

  it("rebuilds when package.json content changes", () => {
    ensureNodeEnv({
      skillName: "invalidate-node",
      packageJsonPath: pkgPath,
      cacheRoot,
    });

    writeFileSync(
      pkgPath,
      JSON.stringify(
        { name: "deps-test-pkg", version: "0.0.1", dependencies: {} },
        null,
        2
      )
    );

    const second = ensureNodeEnv({
      skillName: "invalidate-node",
      packageJsonPath: pkgPath,
      cacheRoot,
    });
    expect(second.rebuilt).toBe(true);
  });

  it("force=true rebuilds even with identical hash", () => {
    ensureNodeEnv({
      skillName: "forced-node",
      packageJsonPath: pkgPath,
      cacheRoot,
    });
    const forced = ensureNodeEnv({
      skillName: "forced-node",
      packageJsonPath: pkgPath,
      cacheRoot,
      force: true,
    });
    expect(forced.rebuilt).toBe(true);
  });

  it("includes lockfile contents in the hash (cross-installer)", () => {
    // Use a package-lock.json so bun ignores it at install time (no
    // syntax validation), but our hash pipeline still picks it up and
    // invalidates the cache on changes. This exercises the
    // "lockfile-change-busts-the-cache" path in isolation from any
    // installer-specific lockfile format.
    const lockPath = join(sourceDir, "package-lock.json");
    writeFileSync(
      lockPath,
      JSON.stringify({ name: "deps-test-pkg", lockfileVersion: 3 }, null, 2)
    );

    const first = ensureNodeEnv({
      skillName: "lockhash",
      packageJsonPath: pkgPath,
      cacheRoot,
    });
    expect(first.rebuilt).toBe(true);

    const same = ensureNodeEnv({
      skillName: "lockhash",
      packageJsonPath: pkgPath,
      cacheRoot,
    });
    expect(same.rebuilt).toBe(false);

    writeFileSync(
      lockPath,
      JSON.stringify(
        { name: "deps-test-pkg", lockfileVersion: 3, packages: {} },
        null,
        2
      )
    );
    const different = ensureNodeEnv({
      skillName: "lockhash",
      packageJsonPath: pkgPath,
      cacheRoot,
    });
    expect(different.rebuilt).toBe(true);
  });

  it("throws NodeEnvError when package.json is missing", () => {
    expect(() =>
      ensureNodeEnv({
        skillName: "missing",
        packageJsonPath: join(tmpDir, "nope.json"),
        cacheRoot,
      })
    ).toThrow(NodeEnvError);
  });
}, 120_000);
