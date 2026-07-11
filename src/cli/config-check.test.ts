/**
 * `switchroom config check` — pre-validation of a switchroom.yaml
 * candidate through the REAL production load path (no loader mocks).
 * The headline case is duplicate YAML keys: the exact failure that
 * crash-looped hostd on 2026-07-11. An agent that runs `config check`
 * on its candidate before writing it catches this before the fleet does.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { Command } from "commander";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { registerAgentConfigCommands } from "./agent-config.js";

let tempRoots: string[] = [];
afterEach(() => {
  for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
  tempRoots = [];
  vi.restoreAllMocks();
});

function writeTempConfig(yaml: string): string {
  const root = mkdtempSync(join(tmpdir(), "config-check-test-"));
  tempRoots.push(root);
  const path = join(root, "switchroom.yaml");
  writeFileSync(path, yaml);
  return path;
}

const validYaml = `
switchroom:
  version: 1
telegram:
  bot_token: "x"
  forum_chat_id: "1"
agents: {}
`.trim();

let stdout: string[];
let stderr: string[];
let exitCode: number | undefined;

beforeEach(() => {
  stdout = [];
  stderr = [];
  exitCode = undefined;
  vi.spyOn(process.stdout, "write").mockImplementation((s) => {
    stdout.push(String(s));
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((s) => {
    stderr.push(String(s));
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    exitCode = code;
    throw new Error(`process.exit(${code})`);
  }) as never);
});

async function runCheck(file: string): Promise<void> {
  const program = new Command();
  program.exitOverride();
  registerAgentConfigCommands(program);
  try {
    await program.parseAsync(["node", "switchroom", "config", "check", "--file", file]);
  } catch {
    // process.exit mock throws to halt the action — expected on failures.
  }
}

describe("switchroom config check", () => {
  it("passes a valid config (exit 0, OK on stdout)", async () => {
    const path = writeTempConfig(validYaml);
    await runCheck(path);
    expect(exitCode).toBeUndefined();
    expect(stdout.join("")).toContain(`OK: ${path}`);
  });

  it("rejects duplicate YAML keys with exit 1 and a legible error", async () => {
    const path = writeTempConfig(`${validYaml}
web:
  enabled: true
web:
  enabled: false
`);
    await runCheck(path);
    expect(exitCode).toBe(1);
    const err = stderr.join("");
    expect(err).toContain(`INVALID: ${path}`);
    expect(err).toContain("Invalid YAML");
    expect(err.toLowerCase()).toContain("unique");
  });

  it("rejects a schema violation with exit 1", async () => {
    const path = writeTempConfig(`${validYaml}
host_control:
  enabled: "not-a-bool"
`);
    await runCheck(path);
    expect(exitCode).toBe(1);
    expect(stderr.join("")).toContain("INVALID");
  });

  it("rejects a missing file with exit 1", async () => {
    await runCheck("/nonexistent/switchroom.yaml");
    expect(exitCode).toBe(1);
    expect(stderr.join("")).toContain("INVALID");
  });
});
