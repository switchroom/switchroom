/**
 * Loader-level test for notion_workspace cross-validation —
 * RFC reference/rfcs/notion-integration.md PR 1.
 *
 * Confirms that the loader hookup (loader.ts → validateNotionWorkspaceConfig)
 * fails fast at config-load time on invalid notion_workspace cross-refs.
 */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "./loader.js";

function writeYaml(yaml: string): string {
  const dir = mkdtempSync(join(tmpdir(), "switchroom-notion-validation-"));
  const path = join(dir, "switchroom.yaml");
  writeFileSync(path, yaml, "utf-8");
  return path;
}

describe("loader: notion_workspace cross-validation", () => {
  it("loads a valid notion_workspace config without complaint", () => {
    const path = writeYaml(`
switchroom:
  version: 1
  agents_dir: "/tmp/agents"
telegram:
  bot_token: "x"
  forum_chat_id: "1"
agents:
  clerk:
    topic_name: "clerk-topic"
    notion_workspace: {}
  carrie:
    topic_name: "carrie-topic"
    notion_workspace:
      databases: [essays]
notion_workspace:
  databases:
    essays: "a1b2c3d4-e5f6-7890-1234-567890abcdef"
    tasks: "b2c3d4e5-f6a7-8901-2345-67890abcdef0"
`);
    const config = loadConfig(path);
    expect(config.notion_workspace?.databases?.essays).toMatch(/^a1b2c3d4/);
    expect(config.agents.carrie?.notion_workspace?.databases).toEqual(["essays"]);
  });

  it("rejects a per-agent DB reference that's not in the top-level map", () => {
    const path = writeYaml(`
switchroom:
  version: 1
  agents_dir: "/tmp/agents"
telegram:
  bot_token: "x"
  forum_chat_id: "1"
agents:
  carrie:
    topic_name: "carrie-topic"
    notion_workspace:
      databases: [nonexistent]
notion_workspace:
  databases:
    essays: "a1b2c3d4-e5f6-7890-1234-567890abcdef"
`);
    expect(() => loadConfig(path)).toThrowError(ConfigError);
    try {
      loadConfig(path);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      const ce = err as ConfigError;
      expect(ce.message).toMatch(/Invalid notion_workspace/);
      expect(ce.details?.[0]).toMatch(/nonexistent/);
      expect(ce.details?.[0]).toMatch(/list-dbs/);
    }
  });

  it("rejects per-agent notion_workspace when top-level block is missing", () => {
    const path = writeYaml(`
switchroom:
  version: 1
  agents_dir: "/tmp/agents"
telegram:
  bot_token: "x"
  forum_chat_id: "1"
agents:
  carrie:
    topic_name: "carrie-topic"
    notion_workspace:
      databases: [essays]
`);
    expect(() => loadConfig(path)).toThrow(ConfigError);
    try {
      loadConfig(path);
    } catch (err) {
      const ce = err as ConfigError;
      expect(ce.details?.[0]).toMatch(/top-level notion_workspace block is missing/);
    }
  });

  it("rejects empty databases list at the zod schema layer", () => {
    const path = writeYaml(`
switchroom:
  version: 1
  agents_dir: "/tmp/agents"
telegram:
  bot_token: "x"
  forum_chat_id: "1"
agents:
  carrie:
    topic_name: "carrie-topic"
    notion_workspace:
      databases: []
notion_workspace:
  databases:
    essays: "a1b2c3d4-e5f6-7890-1234-567890abcdef"
`);
    // The zod schema's .min(1) catches this before the cross-validator
    // gets a chance; the error surface is "Invalid switchroom.yaml
    // configuration" with the zod path included.
    expect(() => loadConfig(path)).toThrow();
    try {
      loadConfig(path);
    } catch (err) {
      const ce = err as ConfigError;
      // Either error surface is acceptable — both fail fast at load.
      const msg = `${ce.message} ${(ce.details ?? []).join(" ")}`;
      expect(msg).toMatch(/notion_workspace|databases|at least one/);
    }
  });

  it("rejects malformed UUIDs in the top-level databases map", () => {
    const path = writeYaml(`
switchroom:
  version: 1
  agents_dir: "/tmp/agents"
telegram:
  bot_token: "x"
  forum_chat_id: "1"
agents:
  clerk:
    topic_name: "clerk-topic"
    notion_workspace: {}
notion_workspace:
  databases:
    essays: "not-a-uuid"
`);
    expect(() => loadConfig(path)).toThrow();
  });

  it("rejects out-of-range rate_limit_rps", () => {
    const path = writeYaml(`
switchroom:
  version: 1
  agents_dir: "/tmp/agents"
telegram:
  bot_token: "x"
  forum_chat_id: "1"
agents:
  clerk:
    topic_name: "clerk-topic"
    notion_workspace: {}
notion_workspace:
  rate_limit_rps: 100
  databases:
    essays: "a1b2c3d4-e5f6-7890-1234-567890abcdef"
`);
    expect(() => loadConfig(path)).toThrow();
  });

  it("ignores agents without notion_workspace", () => {
    const path = writeYaml(`
switchroom:
  version: 1
  agents_dir: "/tmp/agents"
telegram:
  bot_token: "x"
  forum_chat_id: "1"
agents:
  clerk:
    topic_name: "clerk-topic"
    notion_workspace: {}
  finn:
    topic_name: "finn-topic"
notion_workspace:
  databases:
    essays: "a1b2c3d4-e5f6-7890-1234-567890abcdef"
`);
    // Should load cleanly — finn has no notion config, isn't validated
    // against the friendly-name map.
    const config = loadConfig(path);
    expect(config.agents.finn?.notion_workspace).toBeUndefined();
  });
});
