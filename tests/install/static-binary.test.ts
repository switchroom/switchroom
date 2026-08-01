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
import { describe, it, expect } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO_ROOT = resolve(__dirname, "../..");

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
      const tmp = mkdtempSync(join(tmpdir(), "switchroom-static-"));
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
      const tmp = mkdtempSync(join(tmpdir(), "switchroom-static-setup-"));
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
