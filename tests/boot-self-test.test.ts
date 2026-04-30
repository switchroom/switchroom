import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Tests for bin/boot-self-test.sh.
 *
 * Strategy: a fake `claude` binary on PATH so the test controls the
 * exit code of the `claude -p` step. The fake also lets us assert
 * which env it was called with (specifically, that
 * CLAUDE_CODE_OAUTH_TOKEN was unset — matching the hook context the
 * self-test simulates).
 *
 * Tests assert on the issues.jsonl produced by the script after each
 * scenario.
 */

const SCRIPT = resolve(__dirname, "..", "bin", "boot-self-test.sh");
const CLI = resolve(__dirname, "..", "dist", "cli", "switchroom.js");

// Resolve `bun` to its absolute path once. The tests run with a
// minimal PATH (so the fake `claude` is discovered) and that PATH
// doesn't necessarily contain bun's dir — the shim must resolve it
// from the test host instead.
const BUN: string = (() => {
  if (process.env.BUN_PATH) return process.env.BUN_PATH;
  try {
    return execFileSync("which", ["bun"], { encoding: "utf-8" }).trim();
  } catch {
    return "bun";
  }
})();

let stateDir: string;
let configDir: string;
let scratch: string;
let cliShim: string;
let fakeBinDir: string;

function writeCreds(payload: object): void {
  writeFileSync(join(configDir, ".credentials.json"), JSON.stringify(payload));
}

function makeFakeClaude(exitCode: number, stdout = "ok"): void {
  const fake = join(fakeBinDir, "claude");
  writeFileSync(
    fake,
    `#!/usr/bin/env bash
# Capture env for inspection by tests.
env > "${scratch}/claude-env.txt"
echo "${stdout}"
exit ${exitCode}
`,
  );
  chmodSync(fake, 0o755);
}

function runSelfTest(envOverride: Record<string, string> = {}): {
  status: number;
  stdout: string;
  stderr: string;
} {
  const env: Record<string, string> = {};
  // Start from a minimal env so the fake `claude` is the one found.
  for (const [k, v] of Object.entries({
    PATH: `${fakeBinDir}:/usr/bin:/bin`,
    HOME: process.env.HOME ?? "/tmp",
    SWITCHROOM_AGENT_NAME: "testagent",
    TELEGRAM_STATE_DIR: stateDir,
    CLAUDE_CONFIG_DIR: configDir,
    SWITCHROOM_CLI_PATH: cliShim,
    CLAUDE_CODE_OAUTH_TOKEN: "should-be-stripped-by-script",
    ...envOverride,
  })) {
    if (v !== undefined) env[k] = String(v);
  }
  const r = spawnSync("bash", [SCRIPT], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  return {
    status: r.status ?? 1,
    stdout: r.stdout ?? "",
    stderr: r.stderr ?? "",
  };
}

function listIssues(includeResolved = true): Array<{
  fingerprint: string;
  severity: string;
  code: string;
  summary: string;
  detail?: string;
  resolved_at?: number;
}> {
  const args = [
    CLI,
    "issues",
    "list",
    "--json",
    "--state-dir",
    stateDir,
  ];
  if (includeResolved) args.push("--include-resolved");
  const out = execFileSync(BUN, args, { encoding: "utf-8" });
  return JSON.parse(out);
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "boot-self-state-"));
  configDir = mkdtempSync(join(tmpdir(), "boot-self-config-"));
  scratch = mkdtempSync(join(tmpdir(), "boot-self-scratch-"));
  fakeBinDir = mkdtempSync(join(tmpdir(), "boot-self-bin-"));
  mkdirSync(join(scratch, "shim"), { recursive: true });
  cliShim = join(scratch, "shim", "switchroom-shim.sh");
  writeFileSync(
    cliShim,
    `#!/usr/bin/env bash\nexec ${BUN} ${CLI} "$@"\n`,
  );
  chmodSync(cliShim, 0o755);
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  rmSync(fakeBinDir, { recursive: true, force: true });
});

describe("boot-self-test.sh", () => {
  it("records auth.credentials_missing when .credentials.json is absent", () => {
    makeFakeClaude(0);
    const { status } = runSelfTest();
    expect(status).toBe(0);
    const issues = listIssues();
    const missing = issues.find((i) => i.code === "credentials_missing");
    expect(missing).toBeDefined();
    expect(missing!.severity).toBe("error");
    expect(missing!.summary).toContain("no .credentials.json");
  });

  it("records auth.token_expired when expiresAt is in the past", () => {
    writeCreds({
      claudeAiOauth: {
        accessToken: "tok",
        refreshToken: "rt",
        expiresAt: Date.now() - 86_400_000, // 1 day ago
      },
    });
    makeFakeClaude(0);
    runSelfTest();
    const issues = listIssues();
    const expired = issues.find((i) => i.code === "token_expired");
    expect(expired).toBeDefined();
    expect(expired!.severity).toBe("error");
    expect(expired!.summary).toMatch(/expired \d+d ago/);
  });

  it("records auth.refresh_token_missing as warn when refreshToken is empty", () => {
    writeCreds({
      claudeAiOauth: {
        accessToken: "tok",
        refreshToken: "",
        expiresAt: Date.now() + 3_600_000, // valid for 1h
      },
    });
    makeFakeClaude(0);
    runSelfTest();
    const issues = listIssues();
    const noRefresh = issues.find(
      (i) => i.code === "refresh_token_missing",
    );
    expect(noRefresh).toBeDefined();
    expect(noRefresh!.severity).toBe("warn");
  });

  it("records auth.cli_unauthenticated as critical when claude -p fails", () => {
    writeCreds({
      claudeAiOauth: {
        accessToken: "tok",
        refreshToken: "rt",
        expiresAt: Date.now() + 3_600_000,
      },
    });
    makeFakeClaude(1, "401 Unauthorized");
    runSelfTest();
    const issues = listIssues();
    const cli = issues.find((i) => i.code === "cli_unauthenticated");
    expect(cli).toBeDefined();
    expect(cli!.severity).toBe("critical");
    expect(cli!.detail).toContain("401");
  });

  it("strips CLAUDE_CODE_OAUTH_TOKEN before invoking claude (matches hook context)", () => {
    writeCreds({
      claudeAiOauth: {
        accessToken: "tok",
        refreshToken: "rt",
        expiresAt: Date.now() + 3_600_000,
      },
    });
    makeFakeClaude(0);
    runSelfTest();
    const envCapture = require("node:fs").readFileSync(
      join(scratch, "claude-env.txt"),
      "utf-8",
    ) as string;
    // The fake claude was invoked. Its env must NOT contain
    // CLAUDE_CODE_OAUTH_TOKEN — that's the whole point of the check.
    expect(envCapture).not.toMatch(/^CLAUDE_CODE_OAUTH_TOKEN=/m);
  });

  it("resolves prior issues when state goes healthy", { timeout: 15_000 }, () => {
    // First run with a bad state.
    makeFakeClaude(0);
    runSelfTest();
    let issues = listIssues();
    expect(
      issues.find((i) => i.code === "credentials_missing"),
    ).toBeDefined();

    // Now write a healthy creds file and re-run.
    writeCreds({
      claudeAiOauth: {
        accessToken: "tok",
        refreshToken: "rt",
        expiresAt: Date.now() + 3_600_000,
      },
    });
    runSelfTest();
    issues = listIssues();
    const missing = issues.find((i) => i.code === "credentials_missing");
    // The issue is now resolved (stays in the file with --include-resolved
    // until pruned).
    expect(missing!.resolved_at).toBeDefined();
    // The unresolved view filters it out:
    const unresolved = listIssues(false);
    expect(unresolved.find((i) => i.code === "credentials_missing")).toBeUndefined();
  });

  it("exits 0 on every code path (boot must not be blocked)", () => {
    // Even with everything broken, exit should be 0.
    makeFakeClaude(1);
    const { status } = runSelfTest();
    expect(status).toBe(0);
  });

  it("skips silently when required env is missing", () => {
    makeFakeClaude(0);
    const { status, stderr } = runSelfTest({
      SWITCHROOM_AGENT_NAME: "",
    });
    expect(status).toBe(0);
    expect(stderr).toContain("missing required env");
  });

  it("skips silently when switchroom CLI is unavailable", () => {
    makeFakeClaude(0);
    const { status, stderr } = runSelfTest({
      SWITCHROOM_CLI_PATH: "",
      // Strip /usr/local/bin too in case switchroom ended up there.
      PATH: `${fakeBinDir}:/usr/bin:/bin`,
    });
    // We can't fully prevent /usr/bin/switchroom existence on the test
    // host, but we can at least ensure we don't crash.
    expect(status).toBe(0);
    void stderr;
  });
});
