/**
 * Tests for the I2 lint guard (`scripts/check-litellm-config-guard.mjs`).
 * Runs the real script over temp fixture files via LITELLM_CONFIG_PATH and
 * asserts exit code + output for the four design cases: good / global-flag /
 * openrouter-flag / absent-file (skip-notice asserted).
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const SCRIPT = resolve(REPO, "scripts/check-litellm-config-guard.mjs");

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function runWith(configPath: string): { ok: boolean; stdout: string; stderr: string } {
  const r = spawnSync("node", [SCRIPT], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, LITELLM_CONFIG_PATH: configPath },
  });
  return { ok: r.status === 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function fixture(yaml: string): string {
  const d = mkdtempSync(join(tmpdir(), "litellm-guard-"));
  dirs.push(d);
  const p = join(d, "litellm-config.yaml");
  writeFileSync(p, yaml);
  return p;
}

describe("check-litellm-config-guard.mjs", () => {
  it("absent file → exit 0 with a visible SKIP notice", () => {
    const r = runWith("/definitely/not/here/litellm-config.yaml");
    expect(r.ok).toBe(true);
    expect(r.stdout).toMatch(/SKIP.*absent/);
  });

  it("good config → exit 0, OK", () => {
    const r = runWith(
      fixture(`
model_group_settings:
  claude-opus-4:
    forward_client_headers_to_llm_api: true
  sonnet:
    forward_client_headers_to_llm_api: true
`),
    );
    expect(r.ok).toBe(true);
    expect(r.stdout).toMatch(/OK/);
  });

  it("global flag → exit 1, FAIL", () => {
    const r = runWith(
      fixture(`
litellm_settings:
  forward_client_headers_to_llm_api: true
`),
    );
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/FAIL/);
    expect(r.stderr).toMatch(/litellm_settings/);
  });

  it("openrouter-group flag → exit 1, FAIL naming the group", () => {
    const r = runWith(
      fixture(`
model_group_settings:
  claude-sonnet-5-openrouter:
    forward_client_headers_to_llm_api: true
`),
    );
    expect(r.ok).toBe(false);
    expect(r.stderr).toMatch(/claude-sonnet-5-openrouter/);
  });

  it("4b: claude group with num_retries>1 and no fallbacks → WARN, still exit 0", () => {
    const r = runWith(
      fixture(`
model_group_settings:
  claude-opus-4:
    num_retries: 3
`),
    );
    expect(r.ok).toBe(true);
    expect(r.stderr).toMatch(/WARN.*num_retries/);
  });
});
