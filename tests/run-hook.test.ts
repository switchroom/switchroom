import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  readdirSync,
  readFileSync,
} from "node:fs";
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

  // This and the auto-resolve test below each fork the real `bun dist/cli`
  // several times (record/resolve/list). A bun cold-start of the ~2.7MB
  // bundle is ~1s, so 4-5 forks comfortably exceed vitest's 5s default
  // testTimeout when the box is loaded (full-suite parallel run) — that was
  // the run-hook flake, a TIMEOUT not a logic failure. Give the spawn-heavy
  // cases room. (The single-fork tests below stay on the default.)
  it("coalesces repeated failures (occurrences bumps)", () => {
    const script = makeScript("flaky.sh", "echo bad >&2; exit 1");
    runHook("hook:flaky", script);
    runHook("hook:flaky", script);
    runHook("hook:flaky", script);
    const issues = listIssues() as Array<{ occurrences: number }>;
    expect(issues).toHaveLength(1);
    expect(issues[0].occurrences).toBe(3);
  }, 30_000);

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
  }, 30_000);

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

  it("fast-skips the CLI fork when there is nothing to resolve", () => {
    // Replace the shim with one that LOGS every invocation. The fix should
    // bash-prefilter and never call `issues resolve` when the JSONL has
    // no unresolved entry for this fingerprint. That cuts ~785ms per
    // success-path hook (measured 2026-05-01); per-turn cost across
    // 3-5 hooks is several seconds.
    const invocationLog = join(scriptDir, "shim-invocations.log");
    writeFileSync(
      cliShimPath,
      `#!/usr/bin/env bash\necho "$*" >> ${invocationLog}\nexec ${BUN} ${CLI} "$@"\n`,
    );
    chmodSync(cliShimPath, 0o755);

    const script = makeScript("ok.sh", "exit 0");
    runHook("hook:test", script);

    // Read invocation log (file may not exist if fast-skip worked).
    const fs = require("node:fs") as typeof import("node:fs");
    const calls = fs.existsSync(invocationLog)
      ? fs.readFileSync(invocationLog, "utf-8").trim().split("\n").filter(Boolean)
      : [];
    // No prior failure → no fingerprint in store → resolve is a guaranteed
    // no-op → wrapper must skip the fork. Zero CLI invocations expected.
    expect(calls).toHaveLength(0);
  });

  it("fast-skips on success when all matching entries are already resolved", () => {
    // Pre-seed: one failure (creates unresolved entry), one success
    // (resolves it). After this the JSONL contains a fingerprint with
    // `resolved_at` set. A subsequent success must not re-fork the CLI.
    const failing = makeScript("h.sh", "echo bad >&2; exit 1");
    runHook("hook:reused", failing);
    writeFileSync(failing, `#!/usr/bin/env bash\nexit 0\n`);
    chmodSync(failing, 0o755);
    runHook("hook:reused", failing);

    // From here, the entry is resolved. Swap the shim to a counter and
    // run again — fast-skip should kick in.
    const invocationLog = join(scriptDir, "shim-invocations.log");
    writeFileSync(
      cliShimPath,
      `#!/usr/bin/env bash\necho "$*" >> ${invocationLog}\nexec ${BUN} ${CLI} "$@"\n`,
    );
    chmodSync(cliShimPath, 0o755);

    runHook("hook:reused", failing);

    const fs = require("node:fs") as typeof import("node:fs");
    const calls = fs.existsSync(invocationLog)
      ? fs.readFileSync(invocationLog, "utf-8").trim().split("\n").filter(Boolean)
      : [];
    expect(calls).toHaveLength(0);
  });

  it("does NOT fast-skip when an unresolved entry exists for the fingerprint", () => {
    // Create a real unresolved entry, then run success with the same
    // fingerprint. The wrapper must fork the CLI to flip the entry.
    const failing = makeScript("h.sh", "echo bad >&2; exit 1");
    runHook("hook:must-flip", failing);

    // Swap shim to count invocations, then run success.
    const invocationLog = join(scriptDir, "shim-invocations.log");
    writeFileSync(
      cliShimPath,
      `#!/usr/bin/env bash\necho "$*" >> ${invocationLog}\nexec ${BUN} ${CLI} "$@"\n`,
    );
    chmodSync(cliShimPath, 0o755);

    writeFileSync(failing, `#!/usr/bin/env bash\nexit 0\n`);
    chmodSync(failing, 0o755);
    runHook("hook:must-flip", failing);

    const fs = require("node:fs") as typeof import("node:fs");
    const calls = fs.existsSync(invocationLog)
      ? fs.readFileSync(invocationLog, "utf-8").trim().split("\n").filter(Boolean)
      : [];
    expect(calls.length).toBeGreaterThan(0);
    expect(calls[0]).toContain("issues resolve");

    // And the entry actually flipped.
    const issues = listIssues() as Array<{ resolved_at?: number }>;
    expect(issues).toHaveLength(1);
    expect(issues[0].resolved_at).toBeDefined();
  });

  // ── Timing log (#3564) ─────────────────────────────────────────────────
  //
  // Before #3564 the wrapper logged ONLY failures, so a hook that regressed
  // from 20ms to 500ms produced no log output at all. These assert the
  // OUTCOME: a parseable duration_ms line exists per invocation and its
  // value tracks the wrapped command's actual runtime.

  function readTimingLines(dir = stateDir): Array<Record<string, unknown>> {
    const files = readdirSync(dir).filter((f) => f.startsWith("hook-timings-"));
    return files.flatMap((f) =>
      readFileSync(join(dir, f), "utf-8")
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as Record<string, unknown>),
    );
  }

  it("logs a duration_ms line on SUCCESS (the previously invisible case)", () => {
    const script = makeScript("ok.sh", "exit 0");
    runHook("hook:timing-ok", script);
    const lines = readTimingLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].source).toBe("hook:timing-ok");
    expect(lines[0].code).toBe("ok.sh");
    expect(lines[0].status).toBe(0);
    expect(typeof lines[0].duration_ms).toBe("number");
    expect(typeof lines[0].ts).toBe("string");
  });

  it("logs a duration_ms line on FAILURE too, carrying the exit status", () => {
    const script = makeScript("fail.sh", "exit 7");
    runHook("hook:timing-fail", script);
    const lines = readTimingLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].status).toBe(7);
    expect(typeof lines[0].duration_ms).toBe("number");
  });

  it("duration_ms reflects the wrapped command's real runtime", () => {
    // A slow hook must be distinguishable from a fast one in the log —
    // that is the entire point of #3564. 300ms of sleep must show up as
    // >= 250ms (slack for timer granularity), and a no-op must not.
    runHook("hook:timing-slow", makeScript("slow.sh", "sleep 0.3"));
    runHook("hook:timing-fast", makeScript("fast.sh", "exit 0"));
    const bySource = new Map(
      readTimingLines().map((l) => [l.source as string, l.duration_ms as number]),
    );
    expect(bySource.get("hook:timing-slow")).toBeGreaterThanOrEqual(250);
    expect(bySource.get("hook:timing-fast")).toBeLessThan(250);
  });

  it("appends one line per invocation", () => {
    const script = makeScript("ok.sh", "exit 0");
    runHook("hook:timing-a", script);
    runHook("hook:timing-b", script);
    runHook("hook:timing-c", script);
    expect(readTimingLines()).toHaveLength(3);
  });

  it("still logs timing when the switchroom CLI is missing (degraded path)", () => {
    // Issue recording is off on this path; hook cost must stay observable.
    const script = makeScript("ok.sh", "exit 0");
    // PATH keeps coreutils (the wrapper itself needs basename/mktemp) but
    // excludes any `switchroom` binary, so the CLI lookup genuinely fails.
    runHook("hook:timing-degraded", script, [], {
      SWITCHROOM_CLI_PATH: "/nonexistent/switchroom",
      PATH: "/usr/bin:/bin",
    });
    const lines = readTimingLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].source).toBe("hook:timing-degraded");
  });

  it("SWITCHROOM_HOOK_TIMING=0 disables the log", () => {
    const script = makeScript("ok.sh", "exit 0");
    runHook("hook:timing-off", script, [], { SWITCHROOM_HOOK_TIMING: "0" });
    expect(readTimingLines()).toHaveLength(0);
  });

  it("SWITCHROOM_HOOK_TIMING_MIN_MS filters out fast invocations", () => {
    const script = makeScript("ok.sh", "exit 0");
    runHook("hook:timing-under", script, [], {
      SWITCHROOM_HOOK_TIMING_MIN_MS: "100000",
    });
    expect(readTimingLines()).toHaveLength(0);
  });

  it("escapes quotes and backslashes in the source so the line stays valid JSON", () => {
    const script = makeScript("ok.sh", "exit 0");
    const nasty = 'hook:"quo\\ted"';
    runHook(nasty, script);
    const lines = readTimingLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].source).toBe(nasty);
  });

  it("truncates a weekday log left over from the previous week", () => {
    // The log file name embeds the weekday, giving a self-truncating 7-day
    // ring. A file whose first line carries a different date is last
    // week's and must be reset, not appended to — otherwise the ring grows
    // without bound.
    const script = makeScript("ok.sh", "exit 0");
    runHook("hook:ring", script);
    const files = readdirSync(stateDir).filter((f) => f.startsWith("hook-timings-"));
    expect(files).toHaveLength(1);
    const logPath = join(stateDir, files[0]);
    // Rewrite the file as if it were written seven days ago.
    writeFileSync(
      logPath,
      JSON.stringify({
        ts: "2000-01-01T00:00:00+0000",
        date: "2000-01-01",
        source: "hook:stale",
        code: "old.sh",
        duration_ms: 1,
        status: 0,
      }) + "\n",
    );
    runHook("hook:ring", script);
    const lines = readTimingLines();
    expect(lines).toHaveLength(1);
    expect(lines[0].source).toBe("hook:ring");
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
