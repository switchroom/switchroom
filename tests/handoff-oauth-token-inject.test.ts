import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
  mkdirSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { defaultClaudeCliRunner } from "../src/agents/handoff-summarizer.js";

/**
 * End-to-end behaviour test for the oauth-token injection added in #429.
 *
 * Strategy: substitute a fake `claude` binary on PATH that dumps its
 * env to a tempfile. Drive `defaultClaudeCliRunner.run()` and assert
 * the captured env contained `CLAUDE_CODE_OAUTH_TOKEN` from disk
 * (matching the .credentials.json or .oauth-token in the configured
 * CLAUDE_CONFIG_DIR).
 *
 * Reproduces the exact failure mode from #429: the parent process
 * has CLAUDE_CODE_OAUTH_TOKEN stripped (as Claude Code does for hook
 * subprocesses), the runner must reconstruct it from disk so the
 * `claude -p` subprocess can authenticate.
 */

let configDir: string;
let scratch: string;
let fakeBinDir: string;
let originalPath: string | undefined;

function makeFakeClaude(exitCode: number): { envCapturePath: string } {
  const fake = join(fakeBinDir, "claude");
  const envCapture = join(scratch, "claude-env.txt");
  writeFileSync(
    fake,
    `#!/usr/bin/env bash
env > "${envCapture}"
echo "ok"
exit ${exitCode}
`,
  );
  chmodSync(fake, 0o755);
  return { envCapturePath: envCapture };
}

function readCapturedEnv(path: string): Map<string, string> {
  const fs = require("node:fs") as typeof import("node:fs");
  const raw = fs.readFileSync(path, "utf-8");
  const m = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    m.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return m;
}

beforeEach(() => {
  configDir = mkdtempSync(join(tmpdir(), "handoff-cfg-"));
  scratch = mkdtempSync(join(tmpdir(), "handoff-scratch-"));
  fakeBinDir = mkdtempSync(join(tmpdir(), "handoff-bin-"));
  originalPath = process.env.PATH;
  // Prepend the fake bin so spawn("claude", ...) hits ours.
  process.env.PATH = `${fakeBinDir}:${originalPath ?? ""}`;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  // Strip any inherited token so we exercise the disk-read path.
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
});

afterEach(() => {
  rmSync(configDir, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
  rmSync(fakeBinDir, { recursive: true, force: true });
  if (originalPath) process.env.PATH = originalPath;
  delete process.env.CLAUDE_CONFIG_DIR;
});

describe("defaultClaudeCliRunner — oauth token injection (#429)", () => {
  it("injects CLAUDE_CODE_OAUTH_TOKEN from .credentials.json into the spawned env", async () => {
    writeFileSync(
      join(configDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "sk-ant-oat01-FROM-CREDS-FILE",
          refreshToken: "rt",
          expiresAt: Date.now() + 3_600_000,
        },
      }),
    );
    const { envCapturePath } = makeFakeClaude(0);

    await defaultClaudeCliRunner.run({
      model: "claude-haiku-4-5-20251001",
      system: "sys",
      user: "user",
      timeoutMs: 5_000,
    });

    const captured = readCapturedEnv(envCapturePath);
    expect(captured.get("CLAUDE_CODE_OAUTH_TOKEN")).toBe(
      "sk-ant-oat01-FROM-CREDS-FILE",
    );
  });

  it("falls back to .oauth-token when .credentials.json is absent", async () => {
    writeFileSync(
      join(configDir, ".oauth-token"),
      "sk-ant-oat01-FROM-OAUTH-TOKEN-FILE\n",
    );
    const { envCapturePath } = makeFakeClaude(0);

    await defaultClaudeCliRunner.run({
      model: "claude-haiku-4-5-20251001",
      system: "sys",
      user: "user",
      timeoutMs: 5_000,
    });

    const captured = readCapturedEnv(envCapturePath);
    // Trailing newlines/CRs stripped, payload preserved.
    expect(captured.get("CLAUDE_CODE_OAUTH_TOKEN")).toBe(
      "sk-ant-oat01-FROM-OAUTH-TOKEN-FILE",
    );
  });

  it("prefers .credentials.json over .oauth-token (live token wins)", async () => {
    writeFileSync(
      join(configDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "live-token",
          refreshToken: "rt",
          expiresAt: Date.now() + 3_600_000,
        },
      }),
    );
    writeFileSync(join(configDir, ".oauth-token"), "stale-static-token\n");
    const { envCapturePath } = makeFakeClaude(0);

    await defaultClaudeCliRunner.run({
      model: "claude-haiku-4-5-20251001",
      system: "sys",
      user: "user",
      timeoutMs: 5_000,
    });

    expect(readCapturedEnv(envCapturePath).get("CLAUDE_CODE_OAUTH_TOKEN")).toBe(
      "live-token",
    );
  });

  it("respects an existing CLAUDE_CODE_OAUTH_TOKEN in env (manual operator override)", async () => {
    writeFileSync(
      join(configDir, ".oauth-token"),
      "from-disk\n",
    );
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "from-env-explicit";
    const { envCapturePath } = makeFakeClaude(0);

    await defaultClaudeCliRunner.run({
      model: "claude-haiku-4-5-20251001",
      system: "sys",
      user: "user",
      timeoutMs: 5_000,
    });

    // Disk read path is skipped when env is already set.
    expect(readCapturedEnv(envCapturePath).get("CLAUDE_CODE_OAUTH_TOKEN")).toBe(
      "from-env-explicit",
    );
  });

  it("does not set the var when neither file is present (caller decides what to do)", async () => {
    const { envCapturePath } = makeFakeClaude(0);

    await defaultClaudeCliRunner.run({
      model: "claude-haiku-4-5-20251001",
      system: "sys",
      user: "user",
      timeoutMs: 5_000,
    });

    const captured = readCapturedEnv(envCapturePath);
    expect(captured.has("CLAUDE_CODE_OAUTH_TOKEN")).toBe(false);
  });

  it("does not set the var when CLAUDE_CONFIG_DIR is unset", async () => {
    writeFileSync(join(configDir, ".oauth-token"), "would-be-injected\n");
    delete process.env.CLAUDE_CONFIG_DIR;
    const { envCapturePath } = makeFakeClaude(0);

    await defaultClaudeCliRunner.run({
      model: "claude-haiku-4-5-20251001",
      system: "sys",
      user: "user",
      timeoutMs: 5_000,
    });

    const captured = readCapturedEnv(envCapturePath);
    expect(captured.has("CLAUDE_CODE_OAUTH_TOKEN")).toBe(false);
  });

  it("ignores malformed .credentials.json and falls through to .oauth-token", async () => {
    writeFileSync(
      join(configDir, ".credentials.json"),
      "this is not valid json {",
    );
    writeFileSync(
      join(configDir, ".oauth-token"),
      "fallback-token\n",
    );
    const { envCapturePath } = makeFakeClaude(0);

    await defaultClaudeCliRunner.run({
      model: "claude-haiku-4-5-20251001",
      system: "sys",
      user: "user",
      timeoutMs: 5_000,
    });

    expect(readCapturedEnv(envCapturePath).get("CLAUDE_CODE_OAUTH_TOKEN")).toBe(
      "fallback-token",
    );
  });
});

describe("regression: stop-hook env shape", () => {
  it("uses on-disk .oauth-token when .credentials.json is expired/refreshTokenless", async () => {
    // Reproduces the klanker failure mode from #429 directly:
    //   - hook subprocess has no CLAUDE_CODE_OAUTH_TOKEN
    //   - .credentials.json's accessToken is expired and there's no
    //     refreshToken to recover with
    //   - .oauth-token holds a still-valid token written at install
    //     time and continually re-exported by start.sh
    //
    // The runner must prefer .credentials.json (because it's where
    // claude code keeps refreshed tokens), but when the parsed
    // accessToken is missing/empty/null the runner should NOT inject
    // it — fallback to .oauth-token kicks in.
    writeFileSync(
      join(configDir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          // Empty accessToken — same shape as a half-written file
          // would produce. The previous code would happily inject
          // an empty string. The current code falls through.
          accessToken: "",
          refreshToken: "",
          expiresAt: Date.now() - 86_400_000,
        },
      }),
    );
    writeFileSync(
      join(configDir, ".oauth-token"),
      "valid-token-from-static-file\n",
    );
    const { envCapturePath } = makeFakeClaude(0);

    await defaultClaudeCliRunner.run({
      model: "claude-haiku-4-5-20251001",
      system: "s",
      user: "u",
      timeoutMs: 5_000,
    });

    const captured = readCapturedEnv(envCapturePath);
    expect(captured.get("CLAUDE_CODE_OAUTH_TOKEN")).toBe(
      "valid-token-from-static-file",
    );
  });
});
