import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import { readHooksRecallTimeout } from "../src/setup/hindsight-recall-tunables.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

/**
 * The recall envelope's LOAD-BEARING carrier: the two `export HINDSIGHT_RECALL_*`
 * lines in the rendered start.sh.
 *
 * Why they matter more than the settings.json stamp they duplicate. The plugin
 * resolves config in this order (`vendor/hindsight-memory/scripts/lib/config.py:398-455`):
 *
 *   built-in DEFAULTS -> plugin settings.json -> ~/.hindsight/claude-code.json -> env
 *
 * `~/.hindsight/claude-code.json` sits ABOVE the settings.json switchroom
 * stamps and SURVIVES `switchroom apply` — the live fleet had exactly such a
 * file pinning recallParallelDeadlineSeconds to a stale 16. So the env export
 * is the only channel that actually makes switchroom.yaml authoritative, and
 * every other test in this area asserts the channel that a stale hand-edit
 * defeats.
 *
 * The regression this file exists to catch is silent and total: rename or typo
 * a handlebars variable and Handlebars renders EMPTY rather than failing, giving
 * `export HINDSIGHT_RECALL_REQUEST_TIMEOUT_SECONDS=`. `os.environ.get` then
 * returns `""` (not None), `_cast_env("", float)` raises and returns None, and
 * `config.py:450-451` skips the assignment — so claude-code.json wins again with
 * every existing test still green.
 */

const PLUGIN_REL = [".claude", "plugins", "hindsight-memory"] as const;

const DEADLINE_RE = /^export HINDSIGHT_RECALL_PARALLEL_DEADLINE_SECONDS=(.*)$/m;
const REQUEST_RE = /^export HINDSIGHT_RECALL_REQUEST_TIMEOUT_SECONDS=(.*)$/m;

describe("recall envelope: the start.sh env carrier", () => {
  let tmpDir: string;
  let telegram: TelegramConfig;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `recall-envelope-env-${Date.now()}-${Math.floor(Math.random() * 1e6)}`);
    mkdirSync(tmpDir, { recursive: true });
    telegram = { bot_token: "t", forum_chat_id: "c" };
  });
  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  function scaffold(
    agentConfig: AgentConfig,
    extra: Partial<SwitchroomConfig> = {},
  ): { startSh: string; agentDir: string } {
    const config = {
      agents: { probe: agentConfig },
      memory: { backend: "hindsight", config: { url: "http://localhost:18888/mcp/" } },
      telegram,
      ...extra,
    } as unknown as SwitchroomConfig;
    const res = scaffoldAgent("probe", agentConfig, tmpDir, telegram, config);
    return {
      startSh: readFileSync(join(res.agentDir, "start.sh"), "utf-8"),
      agentDir: res.agentDir,
    };
  }

  it("exports BOTH envelope vars even with no memory.recall config at all", () => {
    // Unconditional by design (unlike the sibling override-only knobs): the
    // whole point is to outrank a stale ~/.hindsight/claude-code.json, which a
    // conditional export cannot do — there is nothing to override when the
    // operator has not set the key, which is precisely the case the stale file
    // is left over from.
    const { startSh } = scaffold({} as AgentConfig);
    expect(startSh.match(DEADLINE_RE)?.[1]).toBe("10");
    expect(startSh.match(REQUEST_RE)?.[1]).toBe("8");
  });

  it("never renders an empty value (the silent handlebars-typo failure mode)", () => {
    // `export FOO=` is not a syntax error and not a test failure anywhere else,
    // but it makes the plugin fall through to claude-code.json. Assert on the
    // captured value, not just on the line's presence.
    for (const cfg of [
      {} as AgentConfig,
      { memory: { recall: { hook_timeout_seconds: 30 } } } as unknown as AgentConfig,
    ]) {
      const { startSh } = scaffold(cfg);
      for (const re of [DEADLINE_RE, REQUEST_RE]) {
        const value = startSh.match(re)?.[1];
        expect(value, `${re} must render a value`).toBeTruthy();
        expect(value).toMatch(/^[0-9]+$/);
      }
    }
  });

  it("exports the configured values, not the shipped defaults", () => {
    const { startSh } = scaffold({
      memory: {
        recall: {
          hook_timeout_seconds: 20,
          parallel_deadline_seconds: 17,
          request_timeout_seconds: 13,
        },
      },
    } as unknown as AgentConfig);
    expect(startSh.match(DEADLINE_RE)?.[1]).toBe("17");
    expect(startSh.match(REQUEST_RE)?.[1]).toBe("13");
  });

  it("exports the RESOLVED value, never the raw yaml, when the envelope is inverted", () => {
    // deadline == ceiling is the zero-headroom config the resolver clamps.
    // Exporting the operator's literal 12 here would hand the plugin the exact
    // envelope the clamp exists to prevent.
    const { startSh } = scaffold({
      memory: { recall: { hook_timeout_seconds: 12, parallel_deadline_seconds: 12 } },
    } as unknown as AgentConfig);
    expect(startSh.match(DEADLINE_RE)?.[1]).toBe("10");
  });

  it("keeps the env exports and the plugin stamp on ONE cascaded input (profile tier)", () => {
    // start.sh.hbs claims the two channels "cannot diverge" because they share
    // a resolver. Sharing a resolver only helps if it is fed the same INPUT:
    // the env path reads the cascaded agentConfig, while the stamp used to
    // re-derive from `switchroomConfig.agents[name] ?? {}` — and `{}` carries no
    // `extends`, so resolveAgentConfig skipped the profile tier entirely.
    //
    // This is the fresh-scaffold shape that fallback was written for: an agent
    // that extends a profile but is not (yet) in the `agents` map.
    const recall = {
      hook_timeout_seconds: 20,
      parallel_deadline_seconds: 17,
      request_timeout_seconds: 13,
    };
    const config = {
      profiles: { memtuned: { memory: { recall } } },
      agents: {},
      memory: { backend: "hindsight", config: { url: "http://localhost:18888/mcp/" } },
      telegram,
    } as unknown as SwitchroomConfig;
    const agentConfig = { extends: "memtuned" } as unknown as AgentConfig;
    const res = scaffoldAgent("probe", agentConfig, tmpDir, telegram, config);

    const startSh = readFileSync(join(res.agentDir, "start.sh"), "utf-8");
    const settings = JSON.parse(
      readFileSync(join(res.agentDir, ...PLUGIN_REL, "settings.json"), "utf-8"),
    ) as Record<string, unknown>;
    const hookTimeout = readHooksRecallTimeout(
      readFileSync(join(res.agentDir, ...PLUGIN_REL, "hooks", "hooks.json"), "utf-8"),
    );

    // Channel 1 — env exports.
    expect(startSh.match(DEADLINE_RE)?.[1]).toBe("17");
    expect(startSh.match(REQUEST_RE)?.[1]).toBe("13");
    // Channel 2 — the plugin stamp. Before the fix this read 10 / 8 / 12: the
    // profile tier was silently dropped on one side only.
    expect(settings.recallParallelDeadlineSeconds).toBe(17);
    expect(settings.recallRequestTimeoutSeconds).toBe(13);
    // The ceiling has no env channel at all, so hooks.json is its only carrier.
    expect(hookTimeout).toBe(20);
  });
});
