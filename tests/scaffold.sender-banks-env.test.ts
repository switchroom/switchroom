import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import type { SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

/**
 * Per-speaker memory routing (RFC reference/rfcs/per-speaker-memory-routing.md):
 * `memory.recall.sender_banks` is serialized into start.sh as
 * HINDSIGHT_SENDER_BANKS_JSON, which the recall hook reads to route recall to
 * the speaker's profile bank. Mirrors the topic-aliases env wiring — emitted
 * only when the agent has a sender_banks map (single-user agents get nothing),
 * and resolved from the CASCADED config so a fleet-wide `defaults` value works.
 */
describe("per-speaker routing — sender_banks → HINDSIGHT_SENDER_BANKS_JSON", () => {
  let tmpDir: string;
  let telegram: TelegramConfig;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `sender-banks-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(tmpDir, { recursive: true });
    telegram = { bot_token: "t", forum_chat_id: "c" };
  });
  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function configWith(opts: { defaults?: unknown; agentMemory?: unknown }): SwitchroomConfig {
    return {
      agents: { probe: opts.agentMemory ? ({ memory: opts.agentMemory } as never) : {} },
      defaults: opts.defaults,
      memory: { backend: "hindsight", config: { url: "http://localhost:18888/mcp/" } },
      telegram,
    } as SwitchroomConfig;
  }

  function startShFor(opts: { defaults?: unknown; agentMemory?: unknown }): string {
    const config = configWith(opts);
    const res = scaffoldAgent("probe", config.agents.probe ?? {}, tmpDir, telegram, config);
    return readFileSync(join(res.agentDir, "start.sh"), "utf-8");
  }

  function exportedMap(startSh: string): Record<string, string> | null {
    const m = startSh.match(/export HINDSIGHT_SENDER_BANKS_JSON=(.+)/);
    if (!m) return null;
    // shellSingleQuote wraps the JSON in single quotes; JSON has none of its
    // own, so stripping the surrounding quotes is safe.
    return JSON.parse(m[1].replace(/^'/, "").replace(/'$/, ""));
  }

  it("no sender_banks: no HINDSIGHT_SENDER_BANKS_JSON export (single-user agents)", () => {
    expect(startShFor({})).not.toMatch(/export HINDSIGHT_SENDER_BANKS_JSON=/);
  });

  it("empty sender_banks map: still no export", () => {
    expect(startShFor({ agentMemory: { recall: { sender_banks: {} } } })).not.toMatch(
      /export HINDSIGHT_SENDER_BANKS_JSON=/,
    );
  });

  it("per-agent sender_banks → exports the JSON map", () => {
    const startSh = startShFor({
      agentMemory: { recall: { sender_banks: { "@lisa": "lisa-profile", "123": "ken-profile" } } },
    });
    expect(startSh).toMatch(/export HINDSIGHT_SENDER_BANKS_JSON=/);
    expect(exportedMap(startSh)).toEqual({ "@lisa": "lisa-profile", "123": "ken-profile" });
  });

  it("cascade: a fleet-wide defaults.memory.recall.sender_banks reaches an agent with no override", () => {
    const startSh = startShFor({
      defaults: { memory: { recall: { sender_banks: { "@lisa": "lisa-profile" } } } },
    });
    expect(exportedMap(startSh)).toEqual({ "@lisa": "lisa-profile" });
  });
});
