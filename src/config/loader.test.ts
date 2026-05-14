/**
 * RFC G Phase 1 — loader-level alias coercion for `drive:` ↔
 * `google_workspace:`.
 *
 * Tests the YAML→config path end-to-end (write a temp YAML file, load it,
 * verify both keys are populated when one is set + the both-with-mismatch
 * fast-fail). Schema-only equivalence is covered in schema.test.ts.
 */

import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig, ConfigError, resolveAgentsDir } from "./loader.js";
import type { SwitchroomConfig } from "./schema.js";

let tempRoots: string[] = [];

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  tempRoots = [];
});

function writeTempConfig(yaml: string): string {
  const root = mkdtempSync(join(tmpdir(), "switchroom-loader-test-"));
  tempRoots.push(root);
  const path = join(root, "switchroom.yaml");
  writeFileSync(path, yaml);
  return path;
}

const validBaseYaml = `
switchroom:
  version: 1
telegram:
  bot_token: "x"
  forum_chat_id: "1"
agents: {}
`.trim();

describe("loader: drive: ↔ google_workspace: alias coercion (RFC G Phase 1)", () => {
  it("top-level: only `drive:` set → mirrors onto google_workspace", () => {
    const path = writeTempConfig(`${validBaseYaml}
drive:
  google_client_id: "id"
  google_client_secret: "secret"
  approvers: [123]
`);
    const config = loadConfig(path);
    expect(config.drive?.google_client_id).toBe("id");
    expect(config.google_workspace?.google_client_id).toBe("id");
    // Mirrored = same shape, including approvers and (absent) tier.
    expect(config.drive).toEqual(config.google_workspace);
  });

  it("top-level: only `google_workspace:` set → mirrors onto drive (back-compat)", () => {
    const path = writeTempConfig(`${validBaseYaml}
google_workspace:
  google_client_id: "id"
  google_client_secret: "secret"
  approvers: [123]
  tier: core
`);
    const config = loadConfig(path);
    expect(config.google_workspace?.tier).toBe("core");
    // Existing readers (src/cli/drive.ts) still see config.drive populated.
    expect(config.drive?.tier).toBe("core");
    expect(config.drive).toEqual(config.google_workspace);
  });

  it("top-level: both set with same content but different key order → accepted (order-insensitive)", () => {
    const path = writeTempConfig(`${validBaseYaml}
drive:
  approvers: [123]
  google_client_id: "id"
  google_client_secret: "secret"
  tier: core
google_workspace:
  tier: core
  google_client_secret: "secret"
  google_client_id: "id"
  approvers: [123]
`);
    const config = loadConfig(path);
    expect(config.drive?.tier).toBe("core");
    expect(config.google_workspace?.tier).toBe("core");
  });

  it("top-level: both set with identical values → accepted (transition convenience)", () => {
    const path = writeTempConfig(`${validBaseYaml}
drive:
  google_client_id: "id"
  google_client_secret: "secret"
  approvers: [123]
google_workspace:
  google_client_id: "id"
  google_client_secret: "secret"
  approvers: [123]
`);
    const config = loadConfig(path);
    expect(config.drive?.google_client_id).toBe("id");
    expect(config.google_workspace?.google_client_id).toBe("id");
  });

  it("top-level: both set with different values → fast-fail with clear message", () => {
    const path = writeTempConfig(`${validBaseYaml}
drive:
  google_client_id: "id-A"
  google_client_secret: "secret"
  approvers: [123]
google_workspace:
  google_client_id: "id-B"
  google_client_secret: "secret"
  approvers: [123]
  tier: extended
`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
    try {
      loadConfig(path);
    } catch (err) {
      expect((err as ConfigError).message).toMatch(/different values/);
      expect((err as ConfigError).message).toMatch(/the top level/);
      expect((err as ConfigError).details?.join("\n")).toMatch(
        /pick one and remove the other/,
      );
    }
  });

  it("per-agent: only `drive:` set on agent → mirrors onto google_workspace", () => {
    const path = writeTempConfig(`${validBaseYaml.replace("agents: {}", `agents:
  klanker:
    bot_token: "vault:k-bot"
    forum_chat_id: 1
    topic_name: "klanker"
    drive:
      approvers: [777]`)}`);
    const config = loadConfig(path);
    expect(config.agents.klanker?.drive?.approvers).toEqual([777]);
    expect(config.agents.klanker?.google_workspace?.approvers).toEqual([777]);
  });

  it("per-agent: only `google_workspace:` with tier → mirrors onto drive", () => {
    const path = writeTempConfig(`${validBaseYaml.replace("agents: {}", `agents:
  klanker:
    bot_token: "vault:k-bot"
    forum_chat_id: 1
    topic_name: "klanker"
    google_workspace:
      tier: extended
      approvers: [777]`)}`);
    const config = loadConfig(path);
    expect(config.agents.klanker?.google_workspace?.tier).toBe("extended");
    expect(config.agents.klanker?.drive?.approvers).toEqual([777]);
  });

  it("per-agent: both set with mismatch → fast-fail naming the agent", () => {
    const path = writeTempConfig(`${validBaseYaml.replace("agents: {}", `agents:
  klanker:
    bot_token: "vault:k-bot"
    forum_chat_id: 1
    topic_name: "klanker"
    drive:
      approvers: [111]
    google_workspace:
      approvers: [222]
      tier: extended`)}`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
    try {
      loadConfig(path);
    } catch (err) {
      expect((err as ConfigError).message).toMatch(/agent `klanker`/);
      expect((err as ConfigError).message).toMatch(/different values/);
    }
  });

  it("neither set → both fields stay undefined (no false positives)", () => {
    const path = writeTempConfig(validBaseYaml);
    const config = loadConfig(path);
    expect(config.drive).toBeUndefined();
    expect(config.google_workspace).toBeUndefined();
  });
});

// ─── resolveAgentsDir: env-var override (RFC H container mode) ─────────────
// Regression pin for the auth-broker / approval-kernel container layout:
// compose emits SWITCHROOM_AGENTS_DIR=/state/agents and bind-mounts the
// host ~/.switchroom/agents there. Without honouring the env var here,
// the broker resolves agents_dir from config.switchroom.agents_dir
// (= ~/.switchroom/agents → /root/.switchroom/agents inside the container,
// nothing mounted) and per-agent credential mirrors land in tmpfs. The
// auth-broker / kernel containers stay quiet but the operator sees an
// empty fleet.

describe("resolveAgentsDir: SWITCHROOM_AGENTS_DIR env var override", () => {
  const yamlAgentsDir = "/tmp/from-yaml-agents";
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  const cfg = {
    switchroom: { version: 1, agents_dir: yamlAgentsDir },
  } as SwitchroomConfig;

  afterEach(() => {
    delete process.env.SWITCHROOM_AGENTS_DIR;
  });

  it("falls back to config.switchroom.agents_dir when env var unset", () => {
    delete process.env.SWITCHROOM_AGENTS_DIR;
    expect(resolveAgentsDir(cfg)).toBe(yamlAgentsDir);
  });

  it("env var wins over yaml when set to an absolute path", () => {
    process.env.SWITCHROOM_AGENTS_DIR = "/state/agents";
    expect(resolveAgentsDir(cfg)).toBe("/state/agents");
  });

  it("env var ignored when empty", () => {
    process.env.SWITCHROOM_AGENTS_DIR = "";
    expect(resolveAgentsDir(cfg)).toBe(yamlAgentsDir);
  });

  it("env var ignored when not absolute (defensive: refuse relative)", () => {
    process.env.SWITCHROOM_AGENTS_DIR = "relative/path";
    expect(resolveAgentsDir(cfg)).toBe(yamlAgentsDir);
  });
});
