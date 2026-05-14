import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Regression pin for PR #1260: `switchroom auth heal <agent> --json
 * --config-dir <dir>` must NOT load the global switchroom.yaml.
 *
 * boot-self-test.sh shells this from start.sh under a stripped env;
 * any host where the test temp dir has no switchroom.yaml in its
 * ancestor chain (e.g. buildkite hosted agents cloning into
 * /buildkite/builds/...) used to cause `getConfig` → ConfigError →
 * `2>/dev/null` swallow → empty DIAG_JSON → 5 `boot-self-test.sh >
 * records auth.*` tests fail with "expected undefined to be defined".
 *
 * The end-to-end coverage in tests/boot-self-test.test.ts is what
 * surfaced the regression on buildkite, but only after main was red.
 * This test exercises the CLI layer directly with HOME pointed at an
 * empty temp dir so no `findConfigFile()` walk can succeed — catches
 * the same class of breakage in `npm run lint`-time, not in CI.
 */

const CLI = resolve(__dirname, "..", "dist", "cli", "switchroom.js");
const BUN = process.env.BUN_PATH ?? "bun";

let scratch: string;
let emptyHome: string;
let configDir: string;

beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "auth-heal-cli-"));
  emptyHome = mkdtempSync(join(tmpdir(), "auth-heal-home-"));
  configDir = join(scratch, "claude-config");
  mkdirSync(configDir, { recursive: true });
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(emptyHome, { recursive: true, force: true });
});

function runHeal(args: string[], env: Record<string, string> = {}): {
  stdout: string;
  stderr: string;
  status: number;
} {
  try {
    const stdout = execFileSync(BUN, [CLI, "auth", "heal", "testagent", ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf-8",
      // Stripped env so the binary can't walk up to a real ~/.switchroom/switchroom.yaml.
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: emptyHome,
        ...env,
      },
    });
    return { stdout, stderr: "", status: 0 };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; status?: number };
    return {
      stdout: typeof e.stdout === "string" ? e.stdout : (e.stdout ?? Buffer.alloc(0)).toString(),
      stderr: typeof e.stderr === "string" ? e.stderr : (e.stderr ?? Buffer.alloc(0)).toString(),
      status: e.status ?? 1,
    };
  }
}

describe("auth heal --json --config-dir (boot-self-test contract)", () => {
  it("succeeds without a global switchroom.yaml in cwd when --config-dir is given", () => {
    // Empty configDir → diagnoser reports credentials_missing.
    const { stdout, status } = runHeal(["--json", "--config-dir", configDir]);
    expect(status).toBe(0);
    const diag = JSON.parse(stdout);
    expect(diag.findings).toBeDefined();
    expect(diag.findings.some((f: { code: string }) => f.code === "credentials_missing")).toBe(true);
  });

  it("diagnoses token_expired against a real .credentials.json", () => {
    writeFileSync(
      join(configDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "tok",
          refreshToken: "rt",
          expiresAt: Date.now() - 86_400_000,
        },
      }),
    );
    const { stdout, status } = runHeal(["--json", "--config-dir", configDir]);
    expect(status).toBe(0);
    const diag = JSON.parse(stdout);
    expect(diag.findings.some((f: { code: string }) => f.code === "token_expired")).toBe(true);
  });

  it("WITHOUT --config-dir, falls back to global config (and errors cleanly if no yaml)", () => {
    // No --config-dir means the handler walks to find switchroom.yaml.
    // With HOME pointed at an empty temp dir, findConfigFile() should
    // fail and the withConfigError wrapper should print a tidy red
    // "Config error:" line and exit 1.
    const { stderr, status } = runHeal(["--json"]);
    expect(status).toBe(1);
    expect(stderr).toMatch(/Config error:/);
  });
});
