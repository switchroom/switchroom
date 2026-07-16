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

// ─── PR4b-cron follow-up: cron topic alias validation ────────────────────
describe("loadConfig: cron `topic:` alias validation", () => {
  it("accepts schedule entries with aliases that resolve in topic_aliases", () => {
    const path = writeTempConfig(`
switchroom:
  version: 1
telegram:
  bot_token: "x"
  forum_chat_id: "-1001111111111"
agents:
  klanker:
    topic_name: planning
    channels:
      telegram:
        chat_id: "-1002222222222"
        default_topic_id: 1
        topic_aliases:
          planning: 17
          cron: 23
    schedule:
      - cron: "0 8 * * 1-5"
        prompt: "Morning digest"
        topic: planning
      - cron: "30 9 * * *"
        prompt: "Another check"
        topic: cron
`);
    expect(() => loadConfig(path)).not.toThrow();
  });

  it("accepts numeric topic IDs without consulting topic_aliases", () => {
    const path = writeTempConfig(`
switchroom:
  version: 1
telegram:
  bot_token: "x"
  forum_chat_id: "-1001111111111"
agents:
  klanker:
    topic_name: planning
    channels:
      telegram:
        chat_id: "-1002222222222"
        default_topic_id: 1
    schedule:
      - cron: "0 8 * * 1-5"
        prompt: "Send to thread 99"
        topic: 99
`);
    expect(() => loadConfig(path)).not.toThrow();
  });

  it("accepts schedule entries without a topic field (default fallback)", () => {
    const path = writeTempConfig(`
switchroom:
  version: 1
telegram:
  bot_token: "x"
  forum_chat_id: "-1001111111111"
agents:
  klanker:
    topic_name: planning
    schedule:
      - cron: "0 8 * * *"
        prompt: "Daily — no topic override"
`);
    expect(() => loadConfig(path)).not.toThrow();
  });

  it("rejects an unknown alias with a clear, agent-and-cron-cited error", () => {
    const path = writeTempConfig(`
switchroom:
  version: 1
telegram:
  bot_token: "x"
  forum_chat_id: "-1001111111111"
agents:
  klanker:
    topic_name: planning
    channels:
      telegram:
        chat_id: "-1002222222222"
        default_topic_id: 1
        topic_aliases:
          planning: 17
    schedule:
      - cron: "0 8 * * 1-5"
        prompt: "Typo here"
        topic: plannign
`);
    let caught: Error | null = null;
    try { loadConfig(path); } catch (e) { caught = e as Error; }
    expect(caught).toBeInstanceOf(ConfigError);
    const ce = caught as ConfigError;
    expect(ce.message).toContain("Cron \`topic:\` alias references unknown");
    expect(ce.details?.join("\n")).toContain("klanker");
    expect(ce.details?.join("\n")).toContain("plannign");
    expect(ce.details?.join("\n")).toContain("0 8 * * 1-5");
  });

  it("rejects string aliases when fleet-mode agents have no topic_aliases at all", () => {
    // Fleet/DM agents: silent dispatch to undefined / chat-root would be
    // worse than failing fast — definitely not what the operator meant.
    const path = writeTempConfig(`
switchroom:
  version: 1
telegram:
  bot_token: "x"
  forum_chat_id: "-1001111111111"
agents:
  klanker:
    topic_name: planning
    topic_id: 42
    schedule:
      - cron: "0 8 * * *"
        prompt: "Where does this go?"
        topic: planning
`);
    let caught: Error | null = null;
    try { loadConfig(path); } catch (e) { caught = e as Error; }
    expect(caught).toBeInstanceOf(ConfigError);
  });

  it("aggregates multiple violations from multiple agents in a single error", () => {
    const path = writeTempConfig(`
switchroom:
  version: 1
telegram:
  bot_token: "x"
  forum_chat_id: "-1001111111111"
agents:
  klanker:
    topic_name: planning
    channels:
      telegram:
        chat_id: "-1002222222222"
        default_topic_id: 1
        topic_aliases:
          planning: 17
    schedule:
      - cron: "0 8 * * *"
        prompt: "Typo 1"
        topic: plannign
  ziggy:
    topic_name: cron
    channels:
      telegram:
        chat_id: "-1003333333333"
        default_topic_id: 1
        topic_aliases:
          admin: 31
    schedule:
      - cron: "30 8 * * *"
        prompt: "Typo 2"
        topic: alerst
`);
    let caught: Error | null = null;
    try { loadConfig(path); } catch (e) { caught = e as Error; }
    expect(caught).toBeInstanceOf(ConfigError);
    const ce = caught as ConfigError;
    expect(ce.details?.length).toBe(2);
    const joined = ce.details?.join("\n") ?? "";
    expect(joined).toContain("plannign");
    expect(joined).toContain("alerst");
  });
});

describe("loader: timezone validity (#tz-fix audit gap 3)", () => {
  it("accepts a real IANA zone on an agent", () => {
    const path = writeTempConfig(`${validBaseYaml.replace("agents: {}", "")}
agents:
  alice:
    topic_name: "alice"
    timezone: "Australia/Melbourne"
`);
    const config = loadConfig(path);
    expect(config.agents.alice?.timezone).toBe("Australia/Melbourne");
  });

  it("accepts UTC and a real global switchroom.timezone", () => {
    const path = writeTempConfig(`
switchroom:
  version: 1
  timezone: "America/New_York"
telegram:
  bot_token: "x"
  forum_chat_id: "1"
agents:
  bob:
    topic_name: "bob"
    timezone: "UTC"
`.trim());
    const config = loadConfig(path);
    expect(config.switchroom.timezone).toBe("America/New_York");
    expect(config.agents.bob?.timezone).toBe("UTC");
  });

  it("rejects a shape-valid but non-existent IANA zone (typo) at load", () => {
    // Passes TIMEZONE_REGEX (Region/City shape) but no such zone exists — it
    // would silently degrade to UTC at runtime without this check.
    const path = writeTempConfig(`${validBaseYaml.replace("agents: {}", "")}
agents:
  carol:
    topic_name: "carol"
    timezone: "Australia/Melbrone"
`);
    let caught: Error | null = null;
    try { loadConfig(path); } catch (e) { caught = e as Error; }
    expect(caught).toBeInstanceOf(ConfigError);
    const joined = (caught as ConfigError).details?.join("\n") ?? "";
    expect(joined).toContain("agents.carol.timezone");
    expect(joined).toContain("Australia/Melbrone");
  });

  it("aggregates typos across the global layer and multiple agents", () => {
    const path = writeTempConfig(`
switchroom:
  version: 1
  timezone: "America/New_Yrok"
telegram:
  bot_token: "x"
  forum_chat_id: "1"
agents:
  dave:
    topic_name: "dave"
    timezone: "Europe/Lodnon"
`.trim());
    let caught: Error | null = null;
    try { loadConfig(path); } catch (e) { caught = e as Error; }
    expect(caught).toBeInstanceOf(ConfigError);
    const details = (caught as ConfigError).details ?? [];
    expect(details.length).toBe(2);
    const joined = details.join("\n");
    expect(joined).toContain("switchroom.timezone");
    expect(joined).toContain("agents.dave.timezone");
  });
});
