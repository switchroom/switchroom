/**
 * Regression: `switchroom apply --example <name>` must work in the
 * compiled static binary. `import.meta.dirname` resolves to the bunfs
 * virtual root inside `bun build --compile` output, so the legacy
 * `resolve(import.meta.dirname, "../../examples/...")` path was an
 * ENOENT on the host. Examples are now embedded via text imports —
 * this test rebuilds the CLI as a static binary in a tmpdir, runs
 * `apply --example switchroom`, and asserts the example landed.
 *
 * Skipped automatically when `bun` itself isn't on PATH (CI workers
 * without the bun toolchain) or when the `BUN_BUILD_COMPILE_SKIP` env
 * var is set (sandbox where compile is too heavy).
 */
import { describe, it, expect, onTestFinished } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  writeFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../..");

/**
 * Snapshot of any `switchroom-static-*` dirs that already existed in the
 * tmpdir when this module loaded — leftovers from an earlier run, another
 * worker, or a developer's aborted session. The leak guard at the bottom
 * diffs against this so it only ever fails on dirs THIS run created.
 */
const preexistingStaticDirs = new Set(
  readdirSync(tmpdir()).filter((n) => n.startsWith("switchroom-static-")),
);

/**
 * Allocate a scratch dir under the system tmpdir AND register its removal
 * with `onTestFinished` in one move.
 *
 * WHY THIS EXISTS (the leak this closes). Each of the tests below compiles
 * the CLI with `bun build --compile`, which writes a ~102 MiB self-contained
 * binary into its scratch dir, and neither test removed it. Agent containers
 * mount `/tmp` as a 2 GiB RAM-backed tmpfs (src/agents/compose.ts
 * DEFAULT_TMP_SIZE), so ~204 MiB per suite run accumulated until the tmpfs
 * was full and every subsequent `/tmp` write — including `npm ci`'s
 * postinstall staging — failed. Measured on a live agent container: two
 * orphaned `switchroom-static-*` trees held 204 MiB of a 490 MiB total.
 *
 * `onTestFinished` rather than a trailing `rmSync` in the test body: the
 * hook runs on the FAILURE path too. A trailing statement does not — the
 * first failed `expect` throws past it, which is exactly the run (a broken
 * compile, a flaky assertion) that leaves the biggest artifact behind.
 * `afterEach` would work as well, but it cannot see the per-test path
 * without a mutable module-scope variable, and would silently reap nothing
 * if a future test forgot to assign it.
 */
function scratchDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  onTestFinished(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function bunAvailable(): boolean {
  if (process.env.BUN_BUILD_COMPILE_SKIP) return false;
  try {
    execFileSync("bun", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Compile the CLI into a single static binary in `dir`. Mirrors the production
 * `package.json` build:cli target but stripped down (no --target / --minify so
 * the build is fast).
 */
function compileStaticBinary(dir: string): string {
  const binPath = join(dir, "switchroom-bin");
  const compile = spawnSync(
    "bun",
    [
      "build",
      "--compile",
      resolve(REPO_ROOT, "bin/switchroom.ts"),
      "--outfile",
      binPath,
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (compile.status !== 0) {
    throw new Error(
      `bun build --compile failed:\nstdout: ${compile.stdout}\nstderr: ${compile.stderr}`,
    );
  }
  return binPath;
}

/**
 * A process env with EVERY `SWITCHROOM_*` var stripped.
 *
 * Without this the test inherits the developer's / CI runner's own switchroom
 * environment: `SWITCHROOM_CONFIG` pointed the binary at a live fleet config
 * (observed on a dev host — setup happily loaded a real 5-agent config and
 * never bootstrapped anything), and `SWITCHROOM_PROFILES_ROOT` and friends
 * would mask exactly the resolution bug these tests exist to catch.
 */
function sandboxEnv(fakeHome: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!k.startsWith("SWITCHROOM_")) env[k] = v;
  }
  env.HOME = fakeHome;
  // Skip the docker-compose-v2 preflight; these tests only care about the
  // config-bootstrap step.
  env.SWITCHROOM_SKIP_PREFLIGHT = "1";
  return env;
}

describe("static binary — import.meta.dirname regression", () => {
  it.skipIf(!bunAvailable())(
    "apply --example switchroom works inside a `bun build --compile` artifact",
    () => {
      const tmp = scratchDir("switchroom-static-");
      const binPath = compileStaticBinary(tmp);
      expect(existsSync(binPath)).toBe(true);

      // Need a writable home + cwd so apply doesn't blow up writing
      // the compose file or hitting the agents-dir.
      const fakeHome = join(tmp, "home");
      const cwd = join(tmp, "work");
      const env = sandboxEnv(fakeHome);
      execFileSync("mkdir", ["-p", fakeHome, cwd]);

      // Run `apply --example switchroom` — but we don't actually want
      // apply itself to run (it'd shell out to docker preflight). The
      // copyExampleConfig() step runs BEFORE config load, so even a
      // failed apply leaves switchroom.yaml on disk. Capture output
      // for diagnostics.
      const run = spawnSync(binPath, ["apply", "--example", "switchroom"], {
        cwd,
        env,
        encoding: "utf8",
        timeout: 30_000,
      });

      // The example copy must have succeeded regardless of apply's
      // overall exit status. The pre-fix bug surfaced as:
      //   "Example config not found: switchroom.yaml (available: ...)"
      // ...which would NOT leave the file on disk.
      const dest = join(cwd, "switchroom.yaml");
      expect(
        existsSync(dest),
        `Expected switchroom.yaml at ${dest}.\nstdout: ${run.stdout}\nstderr: ${run.stderr}`,
      ).toBe(true);

      const contents = readFileSync(dest, "utf8");
      // Sanity: the embedded example is non-empty and looks like YAML.
      expect(contents.length).toBeGreaterThan(50);
      expect(contents).toMatch(/agents\s*:/);
    },
    120_000,
  );

  it.skipIf(!bunAvailable())(
    "setup --non-interactive bootstraps switchroom.yaml from the EMBEDDED example (#4163)",
    () => {
      // `setup` is the first command a `curl … | sh` user runs, and it kept
      // its own copy of the example lookup: `resolve(import.meta.dirname,
      // "../../examples")` → `/examples` inside the binary, so it died with
      // "Example config not found" while `apply --example` (already embedded)
      // worked. Both now go through src/cli/embedded-examples.ts.
      const tmp = scratchDir("switchroom-static-setup-");
      const binPath = compileStaticBinary(tmp);

      const fakeHome = join(tmp, "home");
      const cwd = join(tmp, "work");
      execFileSync("mkdir", ["-p", fakeHome, cwd]);

      const run = spawnSync(binPath, ["setup", "--non-interactive"], {
        cwd,
        env: sandboxEnv(fakeHome),
        encoding: "utf8",
        timeout: 60_000,
      });

      // setup does a lot more than write the config and may well not exit 0
      // in a bare sandbox — but the bootstrap step runs first, and the bug
      // being guarded made it THROW rather than write anything. The
      // destination is the user-wide path, not cwd (see copyExampleConfig).
      const dest = join(fakeHome, ".switchroom", "switchroom.yaml");
      expect(
        existsSync(dest),
        `Expected switchroom.yaml at ${dest}.\nstdout: ${run.stdout}\nstderr: ${run.stderr}`,
      ).toBe(true);
      const contents = readFileSync(dest, "utf8");
      expect(contents).toMatch(/agents\s*:/);
      // The precise failure mode of an un-inlined text import: the module
      // PATH written out instead of the file body.
      expect(contents.trim()).not.toMatch(/^\/?examples\/\S+\.yaml$/);
      expect(run.stderr ?? "").not.toContain("Example config not found");
    },
    120_000,
  );
});

/**
 * Guards the cleanup contract itself, and specifically the FAILURE path —
 * the one a trailing `rmSync` in the test body does not cover, and the one
 * that leaks the largest artifact (a half-written 102 MiB compile output).
 *
 * These assert an OUTCOME (the directory no longer exists on disk once its
 * test has finished), not that `onTestFinished` was called. They run
 * unconditionally — no `bun` needed — so the contract stays pinned on CI
 * workers that skip the compile tests above.
 *
 * Vitest runs the tests in a file sequentially in declaration order, so the
 * observer test below runs strictly after the allocating test has finished
 * and its cleanup hooks have drained.
 */
const observed: Record<string, string> = {};

describe("scratch dirs are reaped after each test (tmpfs exhaustion, /tmp)", () => {
  it.fails("a FAILING test allocates a scratch dir and then throws", () => {
    observed.failing = scratchDir("switchroom-scratch-guard-fail-");
    // A stand-in for the ~102 MiB compile artifact: something with real
    // bytes in it, so a leak is a leak of storage and not just an inode.
    writeFileSync(join(observed.failing, "artifact.bin"), Buffer.alloc(64 * 1024));
    expect(existsSync(join(observed.failing, "artifact.bin"))).toBe(true);
    // Deliberate failure — `it.fails` asserts this test throws. Everything
    // after this line is unreachable, which is exactly the point: a trailing
    // cleanup statement here would never run.
    throw new Error("deliberate failure — exercises the cleanup failure path");
  });

  it("a PASSING test allocates a scratch dir", () => {
    observed.passing = scratchDir("switchroom-scratch-guard-pass-");
    writeFileSync(join(observed.passing, "artifact.bin"), Buffer.alloc(64 * 1024));
    expect(existsSync(join(observed.passing, "artifact.bin"))).toBe(true);
  });

  it("…and BOTH scratch dirs are gone from the tmpdir afterwards", () => {
    expect(
      observed.failing,
      "the failing test did not run — this guard is vacuous",
    ).toBeTruthy();
    expect(
      observed.passing,
      "the passing test did not run — this guard is vacuous",
    ).toBeTruthy();
    expect(
      existsSync(observed.failing),
      `leaked scratch dir from the FAILING test: ${observed.failing} — ` +
        `cleanup must be registered with onTestFinished, which runs on the ` +
        `failure path; a trailing rmSync in the test body does not.`,
    ).toBe(false);
    expect(
      existsSync(observed.passing),
      `leaked scratch dir from the PASSING test: ${observed.passing}`,
    ).toBe(false);
  });

  /**
   * The two guards above pin the scratchDir() HELPER. They do not pin the
   * compile tests' CALL SITES: reverting either of those to a bare
   * `mkdtempSync(join(tmpdir(), "switchroom-static-"))` re-introduces the
   * exact 204 MiB leak this file exists to close, with every assertion
   * above still green. This sweeps the tmpdir for the real prefix instead.
   *
   * CAVEAT: trivially satisfied when bunAvailable() is false, because the
   * compile tests skip and allocate nothing. That is acceptable — on a
   * worker with no bun there is no leak to catch — but it means this guard
   * only carries weight on runners that actually compile.
   */
  it("leaves no switchroom-static-* compile scratch behind in the tmpdir", () => {
    const leaked = readdirSync(tmpdir()).filter(
      (n) => n.startsWith("switchroom-static-") && !preexistingStaticDirs.has(n),
    );
    expect(
      leaked,
      `the bun --compile tests leaked scratch dirs into /tmp: ${leaked.join(", ")}. ` +
        `Each holds a ~102 MiB compiled binary, and an agent's /tmp is a 2 GiB ` +
        `tmpfs. Allocate through scratchDir(), which registers onTestFinished ` +
        `cleanup, not through a bare mkdtempSync().`,
    ).toEqual([]);
  });
});
