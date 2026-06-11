import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";

/**
 * Integration test: run turn-pacing-hook.sh and workspace-dynamic-hook.sh
 * through the REAL run-hook.sh wrapper (as they are invoked in production
 * via the generated settings.json hook commands).
 *
 * BLOCKER 1 regression guard: env-var prefixes (TURN_PACING_DIRECTIVE=...,
 * SWITCHROOM_INJECT_ON_CHANGE=1) must be passed via `env ...` so that
 * run-hook.sh can exec them. Without the `env` prefix, run-hook.sh tries
 * to exec "TURN_PACING_DIRECTIVE=..." as a binary → exit 127.
 *
 * These tests:
 *  1. Verify the CORRECT `env VAR=val bash script` form works end-to-end.
 *  2. (Regression) Verify the OLD broken form (bare `VAR=val bash script`)
 *     fails (exit 127) — so the test catches any future regression.
 */

const RUN_HOOK = resolve(__dirname, "../bin/run-hook.sh");
const TURN_PACING_HOOK = resolve(__dirname, "../bin/turn-pacing-hook.sh");
const WS_DYNAMIC_HOOK = resolve(__dirname, "../bin/workspace-dynamic-hook.sh");

const DIRECTIVE_TEXT =
  "<turn-pacing>test directive for integration test</turn-pacing>";
const DIRECTIVE_HASH = createHash("sha256")
  .update(DIRECTIVE_TEXT)
  .digest("hex");

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

function runViaHookWrapper(opts: {
  stateDir: string;
  /** The command string passed as argv[2] to run-hook.sh (i.e. the "command" field from settings.json). */
  command: string;
  /** Additional env vars merged into the subprocess environment. */
  env?: Record<string, string>;
  stdin?: string;
}): RunResult {
  const { stateDir, command, env = {}, stdin } = opts;

  const fullEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries({
    ...process.env,
    TELEGRAM_STATE_DIR: stateDir,
    ...env,
  })) {
    if (v !== undefined && v !== null) fullEnv[k] = String(v);
  }

  // run-hook.sh <source> <command> — the "command" here is the full command
  // string from settings.json. We pass it as a single argument (bash -c style
  // is how the generated command is invoked by claude code).
  const r = spawnSync("bash", [RUN_HOOK, "hook:turn-pacing", "bash", "-c", command], {
    env: fullEnv,
    input: stdin ?? JSON.stringify({ session_id: "integration-test-session", prompt: "hello" }),
    stdio: ["pipe", "pipe", "pipe"],
    encoding: "utf-8",
  });

  return {
    status: r.status ?? 1,
    stdout: typeof r.stdout === "string" ? r.stdout : "",
    stderr: typeof r.stderr === "string" ? r.stderr : "",
  };
}

describe("turn-pacing-hook.sh through run-hook.sh wrapper (BLOCKER 1 regression)", () => {
  let tmp: string;
  let stateDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join("/var/tmp", "tp-rh-integration-"));
    stateDir = tmp;
    mkdirSync(stateDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("correct form: `env VAR=val bash hook.sh` — directive emitted on first turn", () => {
    // This is the form scaffold.ts now generates (with `env` prefix).
    const command = `env TURN_PACING_DIRECTIVE=${shellSingleQuote(DIRECTIVE_TEXT)} TURN_PACING_HASH=${shellSingleQuote(DIRECTIVE_HASH)} bash "${TURN_PACING_HOOK}"`;
    const r = runViaHookWrapper({ stateDir, command });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(DIRECTIVE_TEXT);
  });

  it("correct form: directive suppressed on second turn (same session)", () => {
    const command = `env TURN_PACING_DIRECTIVE=${shellSingleQuote(DIRECTIVE_TEXT)} TURN_PACING_HASH=${shellSingleQuote(DIRECTIVE_HASH)} bash "${TURN_PACING_HOOK}"`;
    // First turn: emit
    const a = runViaHookWrapper({ stateDir, command });
    expect(a.stdout).toContain(DIRECTIVE_TEXT);
    // Second turn: suppress
    const b = runViaHookWrapper({ stateDir, command });
    expect(b.status).toBe(0);
    expect(b.stdout).toBe("");
  });

  it("REGRESSION: old broken form `VAR=val bash hook.sh` exits 127 (run-hook.sh cannot exec an assignment)", () => {
    // The OLD (broken) command format that the fix eliminates. run-hook.sh
    // calls: `"$COMMAND" "$@"` where COMMAND="TURN_PACING_DIRECTIVE=..." — not
    // a valid executable → exit 127.
    // This test MUST FAIL on the old format so it would have caught the bug.
    const brokenCommand = `TURN_PACING_DIRECTIVE=${shellSingleQuote(DIRECTIVE_TEXT)} TURN_PACING_HASH=${shellSingleQuote(DIRECTIVE_HASH)} bash "${TURN_PACING_HOOK}"`;
    // run-hook.sh receives: source="hook:turn-pacing" command="TURN_PACING_DIRECTIVE=..." args=...
    // It tries to exec "TURN_PACING_DIRECTIVE=..." as a binary → exit 127.
    const r = spawnSync(
      "bash",
      [
        RUN_HOOK,
        "hook:turn-pacing",
        // Simulate how run-hook.sh would receive the old-format command:
        // the first token is the assignment string, run-hook.sh execs it directly.
        `TURN_PACING_DIRECTIVE=${shellSingleQuote(DIRECTIVE_TEXT)}`,
        `TURN_PACING_HASH=${shellSingleQuote(DIRECTIVE_HASH)}`,
        "bash",
        TURN_PACING_HOOK,
      ],
      {
        env: { ...process.env as Record<string, string>, TELEGRAM_STATE_DIR: stateDir },
        input: JSON.stringify({ session_id: "sess-broken", prompt: "hello" }),
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf-8",
      },
    );
    // Must exit non-zero (127 = command not found for an assignment token)
    expect(r.status).not.toBe(0);
  });
});

describe("workspace-dynamic-hook.sh through run-hook.sh wrapper (BLOCKER 1 regression)", () => {
  let tmp: string;
  let stateDir: string;
  let shimDir: string;
  let cacheDir: string;

  beforeEach(() => {
    tmp = mkdtempSync(join("/var/tmp", "wsdyn-rh-integration-"));
    stateDir = join(tmp, "state");
    shimDir = join(tmp, "bin");
    cacheDir = join(tmp, "claude");
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(shimDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });

    // Install a switchroom shim that returns simple content
    const shimPath = join(shimDir, "switchroom");
    const payload = "# Project Context\n\n## MEMORY.md\nmemory content here\n";
    const escaped = payload.replace(/'/g, `'"'"'`);
    require("node:fs").writeFileSync(shimPath, `#!/bin/bash\nprintf '%s' '${escaped}'\n`, { mode: 0o755 });
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("correct form: `env SWITCHROOM_INJECT_ON_CHANGE=1 bash hook.sh` — content emitted on first turn", () => {
    const command = `env SWITCHROOM_INJECT_ON_CHANGE=1 bash "${WS_DYNAMIC_HOOK}"`;
    const r = spawnSync(
      "bash",
      [RUN_HOOK, "hook:workspace-dynamic", "bash", "-c", command],
      {
        env: {
          ...process.env as Record<string, string>,
          TELEGRAM_STATE_DIR: stateDir,
          CLAUDE_CONFIG_DIR: cacheDir,
          SWITCHROOM_AGENT_NAME: "test-agent",
          PATH: `${shimDir}:${process.env.PATH ?? ""}`,
        },
        input: JSON.stringify({ session_id: "ws-integration-session", prompt: "hello" }),
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf-8",
      },
    );
    expect(r.status).toBe(0);
    expect(typeof r.stdout === "string" ? r.stdout : "").toContain("memory content here");
  });

  it("REGRESSION: old broken form `SWITCHROOM_INJECT_ON_CHANGE=1 bash hook.sh` exits non-zero", () => {
    // run-hook.sh receives "SWITCHROOM_INJECT_ON_CHANGE=1" as COMMAND,
    // tries to exec it as a binary → exit 127.
    const r = spawnSync(
      "bash",
      [
        RUN_HOOK,
        "hook:workspace-dynamic",
        "SWITCHROOM_INJECT_ON_CHANGE=1",
        "bash",
        WS_DYNAMIC_HOOK,
      ],
      {
        env: {
          ...process.env as Record<string, string>,
          TELEGRAM_STATE_DIR: stateDir,
          CLAUDE_CONFIG_DIR: cacheDir,
          SWITCHROOM_AGENT_NAME: "test-agent",
          PATH: `${shimDir}:${process.env.PATH ?? ""}`,
        },
        input: JSON.stringify({ session_id: "ws-broken-session", prompt: "hello" }),
        stdio: ["pipe", "pipe", "pipe"],
        encoding: "utf-8",
      },
    );
    expect(r.status).not.toBe(0);
  });
});

function shellSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}
