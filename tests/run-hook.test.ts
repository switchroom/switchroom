import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Integration tests for bin/run-hook.sh.
 *
 * The wrapper:
 *   - Forwards stdout, exits with the wrapped command's status.
 *   - On non-zero exit, records an issue via `switchroom issues record`
 *     with detail = stderr tail.
 *   - On exit 0, resolves any prior issue with the same fingerprint
 *     so success auto-clears the failure state.
 *   - Tolerates the CLI being missing (degraded passthrough).
 */

const RUN_HOOK = resolve(__dirname, "..", "bin", "run-hook.sh");
const CLI = resolve(__dirname, "..", "dist", "cli", "switchroom.js");
const BUN = process.env.BUN_PATH ?? "bun";

/**
 * The CLI binary's shebang resolves to bun, so the wrapper expects
 * SWITCHROOM_CLI_PATH to point at an executable that accepts
 * `[CLI, ...args]`. We wrap with a tiny shell script that does
 * `exec bun <CLI> "$@"`, dropped into a tmpdir per-test.
 */
let cliShimPath: string;
let stateDir: string;
let scriptDir: string;

function runHook(
  source: string,
  command: string,
  args: string[] = [],
  envOverride: Record<string, string> = {},
): { status: number; stdout: string; stderr: string } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    ...process.env,
    SWITCHROOM_CLI_PATH: cliShimPath,
    TELEGRAM_STATE_DIR: stateDir,
    SWITCHROOM_AGENT_NAME: "testagent",
    ...envOverride,
  })) {
    if (v !== undefined && v !== null) env[k] = String(v);
  }
  // spawnSync (not execFileSync) so we always capture stdout AND stderr,
  // including on success.
  const r = spawnSync("bash", [RUN_HOOK, source, command, ...args], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
  });
  return {
    status: r.status ?? 1,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
  };
}

function listIssues(): unknown[] {
  const out = execFileSync(BUN, [
    CLI,
    "issues",
    "list",
    "--include-resolved",
    "--json",
    "--state-dir",
    stateDir,
  ], { encoding: "utf-8" });
  return JSON.parse(out);
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "run-hook-state-"));
  scriptDir = mkdtempSync(join(tmpdir(), "run-hook-scripts-"));
  cliShimPath = join(scriptDir, "switchroom-shim.sh");
  // Tiny shim so the wrapper's `"$SWITCHROOM_CLI" issues record ...`
  // resolves to `bun <dist/cli/switchroom.js> issues record ...`.
  writeFileSync(
    cliShimPath,
    `#!/usr/bin/env bash\nexec ${BUN} ${CLI} "$@"\n`,
  );
  chmodSync(cliShimPath, 0o755);
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(scriptDir, { recursive: true, force: true });
});

function makeScript(name: string, body: string): string {
  const path = join(scriptDir, name);
  writeFileSync(path, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

describe("run-hook.sh", () => {
  it("preserves a successful command's exit code without recording issues", () => {
    const script = makeScript("ok.sh", "exit 0");
    const { status } = runHook("hook:test", script);
    expect(status).toBe(0);
    expect(listIssues()).toHaveLength(0);
  });

  it("preserves a failed command's exit code", () => {
    const script = makeScript("fail.sh", "exit 7");
    const { status } = runHook("hook:test", script);
    expect(status).toBe(7);
  });

  it("records an issue on non-zero exit with stderr tail as detail", () => {
    const script = makeScript(
      "fail.sh",
      `echo 'first line' >&2\necho 'second line' >&2\nexit 1`,
    );
    runHook("hook:test", script);

    const issues = listIssues() as Array<{
      fingerprint: string;
      severity: string;
      detail?: string;
      summary: string;
      occurrences: number;
    }>;
    expect(issues).toHaveLength(1);
    const i = issues[0];
    expect(i.fingerprint).toBe("hook:test::fail.sh");
    expect(i.severity).toBe("error");
    expect(i.detail).toContain("first line");
    expect(i.detail).toContain("second line");
    expect(i.summary).toContain("exited 1");
    expect(i.occurrences).toBe(1);
  });

  it("coalesces repeated failures (occurrences bumps)", () => {
    const script = makeScript("flaky.sh", "echo bad >&2; exit 1");
    runHook("hook:flaky", script);
    runHook("hook:flaky", script);
    runHook("hook:flaky", script);
    const issues = listIssues() as Array<{ occurrences: number }>;
    expect(issues).toHaveLength(1);
    expect(issues[0].occurrences).toBe(3);
  });

  it("auto-resolves the matching fingerprint on a subsequent success", () => {
    const failing = makeScript("h.sh", "echo bad >&2; exit 1");
    const passing = makeScript("h.sh.tmp", "exit 0");
    // Use the SAME script path for both runs (same code = same fingerprint).
    runHook("hook:auto", failing);
    runHook("hook:auto", failing);
    let issues = listIssues() as Array<{ resolved_at?: number }>;
    expect(issues).toHaveLength(1);
    expect(issues[0].resolved_at).toBeUndefined();

    // Overwrite the script to pass without changing its path.
    writeFileSync(failing, `#!/usr/bin/env bash\nexit 0\n`);
    chmodSync(failing, 0o755);
    runHook("hook:auto", failing);

    issues = listIssues() as Array<{ resolved_at?: number }>;
    expect(issues).toHaveLength(1);
    expect(issues[0].resolved_at).toBeDefined();
    // Avoid unused-var lint
    void passing;
  });

  it("forwards stdout from the wrapped command", () => {
    const script = makeScript("out.sh", "echo hello-from-hook");
    const { stdout } = runHook("hook:t", script);
    expect(stdout).toContain("hello-from-hook");
  });

  it("forwards stderr from the wrapped command (visible in journald)", () => {
    const script = makeScript("err.sh", "echo this-is-stderr >&2; exit 0");
    const { stderr } = runHook("hook:t", script);
    expect(stderr).toContain("this-is-stderr");
  });

  it("degrades cleanly when the CLI is missing", () => {
    const script = makeScript("ok.sh", "echo ran");
    // SWITCHROOM_CLI_PATH points at a non-existent file and PATH excludes
    // anywhere `switchroom` could be found. The hook itself still runs;
    // the wrapper just emits a warning and passes through the exit code.
    const { status, stdout, stderr } = runHook("hook:t", script, [], {
      PATH: "/usr/bin:/bin",
      SWITCHROOM_CLI_PATH: "/nonexistent/switchroom",
    });
    expect(status).toBe(0);
    expect(stdout).toContain("ran");
    expect(stderr).toContain("CLI not found");
  });

  it("derives code from script basename when command is an interpreter", () => {
    const fooScript = makeScript("foo.sh", "echo bad >&2; exit 1");
    const barScript = makeScript("bar.sh", "echo bad >&2; exit 1");
    runHook("hook:s", "bash", [fooScript]);
    runHook("hook:s", "bash", [barScript]);
    const issues = (listIssues() as Array<{ fingerprint: string }>).map(
      (i) => i.fingerprint,
    );
    // Distinct scripts → distinct fingerprints, even though COMMAND is
    // `bash` in both cases.
    expect(issues).toContain("hook:s::foo.sh");
    expect(issues).toContain("hook:s::bar.sh");
  });

  it("rejects malformed invocation (no source/command)", () => {
    let status = 0;
    let stderr = "";
    try {
      execFileSync("bash", [RUN_HOOK], {
        stdio: ["ignore", "pipe", "pipe"],
        encoding: "utf-8",
      });
    } catch (err) {
      const e = err as { status?: number; stderr?: Buffer };
      status = e.status ?? 1;
      stderr = (e.stderr ?? Buffer.alloc(0)).toString();
    }
    expect(status).toBe(2);
    expect(stderr).toContain("usage:");
  });
});
