/**
 * Sub-agent limit pinning — the two env vars that decide how the fleet may
 * fan out, asserted against the RENDERED boot scripts by EXECUTING them.
 *
 * Why this file exists: both limits are load-bearing and were previously
 * unguarded (`git grep CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH -- tests/ src/`
 * returned nothing), so deleting either line in an unrelated edit changes
 * fleet-wide delegation behaviour with no failing test and no visible symptom.
 *
 *   CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH=2
 *     Claude Code 2.1.217 turned NESTED spawning OFF by default. Without this
 *     export a dispatched @worker silently cannot fan out at all
 *     (main → sub-agent → grandchild stops working).
 *
 *   CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS=15
 *     The deterministic half of the dev-protocol's "max 15 parallel
 *     sub-agents". That sentence is prompt text a model can ignore; the CLI's
 *     own default is 20. This export is what actually enforces the cap
 *     (`skills/dev-protocol/SKILL.md`: prefer a mechanism over prompt
 *     discipline).
 *
 * OUTCOME, not string-presence: the export lines are extracted from the real
 * rendered script and run through bash, then read back with `printenv` — which
 * only sees EXPORTED vars, so this proves the value would actually reach the
 * `exec claude` child, not merely that a shell variable was assigned. Both the
 * default and the `${VAR:-N}` override shape are exercised.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import { renderTemplate } from "../src/agents/profiles.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

const DEPTH_VAR = "CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH";
const WIDTH_VAR = "CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS";
/** Nesting levels the fleet relies on: main → sub-agent → grandchild. */
const EXPECTED_DEPTH = "2";
/** Fan-out width, deliberately below the CLI's own default of 20. */
const EXPECTED_WIDTH = "15";

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

function makeAgentConfig(): AgentConfig {
  return { extends: "default", topic_name: "Test Topic", schedule: [] } as unknown as AgentConfig;
}

function makeSwitchroomConfig(name: string, agentConfig: AgentConfig): SwitchroomConfig {
  return {
    switchroom: {
      version: 1,
      agents_dir: "~/.switchroom/agents",
      skills_dir: "~/.switchroom/skills",
    },
    telegram: telegramConfig,
    agents: { [name]: agentConfig },
  } as unknown as SwitchroomConfig;
}

/**
 * Pull the two export lines out of a rendered script, preserving order.
 * Anchored at column 0 on purpose: an indented copy would be nested inside a
 * conditional/function and therefore not unconditionally applied at boot.
 */
function extractExports(script: string): string[] {
  return script
    .split("\n")
    .filter((l) => new RegExp(`^export (${DEPTH_VAR}|${WIDTH_VAR})=`).test(l));
}

/**
 * Execute the extracted export lines in a clean shell and read the values back
 * with `printenv` (exported-only). `preset` simulates an operator override
 * already present in the environment.
 */
function runExports(lines: string[], preset: Record<string, string> = {}): Record<string, string> {
  const script = [
    "set -eu",
    ...lines,
    `printf 'DEPTH=%s\\n' "$(printenv ${DEPTH_VAR})"`,
    `printf 'WIDTH=%s\\n' "$(printenv ${WIDTH_VAR})"`,
  ].join("\n");
  const out = execFileSync("bash", ["-c", script], {
    encoding: "utf-8",
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...preset },
  });
  const depth = out.match(/DEPTH=(.*)/);
  const width = out.match(/WIDTH=(.*)/);
  return { depth: depth ? depth[1].trim() : "", width: width ? width[1].trim() : "" };
}

describe("start.sh: sub-agent spawn depth + concurrency are exported", () => {
  let tmpDir: string;
  let startSh: string;
  let lines: string[];

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-subagent-limits-"));
    const name = "sl-agent";
    const config = makeAgentConfig();
    const res = scaffoldAgent(name, config, tmpDir, telegramConfig, makeSwitchroomConfig(name, config));
    startSh = readFileSync(join(res.agentDir, "start.sh"), "utf-8");
    lines = extractExports(startSh);
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("exports BOTH limits unconditionally at top level", () => {
    // Fails if either export line is deleted, indented into a conditional, or
    // renamed — the exact silent-breakage this file guards.
    expect(lines.some((l) => l.startsWith(`export ${DEPTH_VAR}=`))).toBe(true);
    expect(lines.some((l) => l.startsWith(`export ${WIDTH_VAR}=`))).toBe(true);
  });

  it("yields depth=2 and width=15 in the child environment (no env preset)", () => {
    const { depth, width } = runExports(lines);
    expect(depth).toBe(EXPECTED_DEPTH);
    expect(width).toBe(EXPECTED_WIDTH);
  });

  it("pins the fan-out cap BELOW the claude CLI's own default of 20", () => {
    // The whole point of the width pin: 20 (the CLI default) would mean the
    // dev-protocol's "max 15" is prompt-only. Assert the numeric relationship,
    // not just the literal.
    const { width } = runExports(lines);
    const n = Number(width);
    expect(Number.isInteger(n)).toBe(true);
    // `De.int({ min: 1 })` in the CLI's env schema rejects <1.
    expect(n).toBeGreaterThanOrEqual(1);
    expect(n).toBeLessThan(20);
    expect(n).toBe(15);
  });

  it("honours a pre-set value (the ${VAR:-N} override shape)", () => {
    const { depth, width } = runExports(lines, {
      [DEPTH_VAR]: "3",
      [WIDTH_VAR]: "8",
    });
    expect(depth).toBe("3");
    expect(width).toBe("8");
  });

  it("exports both limits BEFORE `exec claude`, so the CLI actually inherits them", () => {
    const execIdx = startSh.indexOf("exec claude");
    expect(execIdx).toBeGreaterThan(-1);
    for (const v of [DEPTH_VAR, WIDTH_VAR]) {
      const idx = startSh.indexOf(`export ${v}=`);
      expect(idx, `${v} not exported`).toBeGreaterThan(-1);
      expect(idx, `${v} exported after exec claude`).toBeLessThan(execIdx);
    }
  });

  it("does not carry the retired claim that the fleet 'self-caps' at 15", () => {
    // The old comment asserted a self-cap that did not exist anywhere in the
    // codebase, which is why the 20 default was left in place.
    expect(startSh).not.toContain("self-caps at 15");
    expect(startSh).not.toContain("the 20 default is left untouched");
  });
});

describe("cron-session.sh: the same two limits are pinned for cron-fired sessions", () => {
  const CRON_SH = join(__dirname, "..", "profiles", "_base", "cron-session.sh.hbs");
  const rendered = renderTemplate(CRON_SH, {
    name: "marko",
    agentDir: "/state/agent",
    securityPluginDir: "/opt/switchroom/security-plugin",
    useSwitchroomPlugin: true,
    modelQ: "'claude-sonnet-5'",
    cronModelQ: "'claude-sonnet-5'",
  });
  const lines = extractExports(rendered);

  it("exports BOTH limits unconditionally at top level", () => {
    expect(lines.some((l) => l.startsWith(`export ${DEPTH_VAR}=`))).toBe(true);
    expect(lines.some((l) => l.startsWith(`export ${WIDTH_VAR}=`))).toBe(true);
  });

  it("yields depth=2 and width=15 in the child environment (no env preset)", () => {
    const { depth, width } = runExports(lines);
    expect(depth).toBe(EXPECTED_DEPTH);
    expect(width).toBe(EXPECTED_WIDTH);
  });

  it("honours a pre-set value inherited from start.sh (belt-and-braces default)", () => {
    // cron-session.sh normally INHERITS these from start.sh's env; its own
    // defaults must never clobber an inherited/operator value.
    const { depth, width } = runExports(lines, {
      [DEPTH_VAR]: "4",
      [WIDTH_VAR]: "6",
    });
    expect(depth).toBe("4");
    expect(width).toBe("6");
  });
});
