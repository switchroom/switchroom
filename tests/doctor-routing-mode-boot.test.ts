/**
 * Producer ↔ consumer coupling for the untracked-LiteLLM-boot signal.
 *
 * `src/cli/doctor-routing-mode.ts` parses a one-line record that a SHELL
 * `printf` in `profiles/_base/start.sh.hbs` writes. Nothing in the type system
 * connects the two, so a reworded field in the template would silently turn
 * the doctor check into a no-op — reporting a perfectly clean fleet while an
 * agent burns untracked tokens. That is the exact class of failure this check
 * exists to end, so it must not be possible to reintroduce it here.
 *
 * These tests therefore run the REAL rendered start.sh routing block under the
 * REAL missing-key strip conditions, let it write a REAL `.routing-mode` file,
 * and feed that file to the REAL doctor check off disk. No hand-written
 * fixture strings.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { scaffoldAgent } from "../src/agents/scaffold.js";
import { runRoutingModeChecks } from "../src/cli/doctor-routing-mode.js";
import { printSection } from "../src/cli/doctor.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

const BLOCK_HEADER = "# --- Session model resolution";
const AGENT = "routing-doctor-agent";

function makeSwitchroomConfig(name: string, agentConfig: AgentConfig): SwitchroomConfig {
  return {
    switchroom: {
      version: 1,
      agents_dir: "~/.switchroom/agents",
      skills_dir: "~/.switchroom/skills",
    },
    telegram: telegramConfig,
    agents: { [name]: agentConfig },
  };
}

describe("untracked-boot signal: rendered start.sh → switchroom doctor", () => {
  let tmpDir: string;
  let agentDir: string;
  let block: string;

  /** Scaffold the agent and slice the resolver→routing-write block out of it. */
  function scaffold(model: string): void {
    const config = { extends: "default", topic_name: "T", schedule: [], model } as AgentConfig;
    const res = scaffoldAgent(
      AGENT,
      config,
      tmpDir,
      telegramConfig,
      makeSwitchroomConfig(AGENT, config),
    );
    agentDir = res.agentDir;
    const startSh = readFileSync(join(agentDir, "start.sh"), "utf-8");
    const start = startSh.indexOf(BLOCK_HEADER);
    const end = startSh.indexOf('if [ -n "$APPEND_PROMPT" ]', start);
    expect(start, "session-model resolver block not found in rendered start.sh").toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    block = startSh.slice(start, end);
  }

  /**
   * Simulate the MISSING-KEY fail-open exactly as start.sh's litellm block
   * leaves the environment: routing vars stripped, but SWITCHROOM_LITELLM_
   * DECLARED still carrying the pre-strip intent, and neither _LITELLM_OK nor
   * _LITELLM_UNREACHABLE set.
   */
  function bootStripped(): void {
    execFileSync(
      "bash",
      [
        "-c",
        [
          "set -e",
          "unset SWITCHROOM_CONFIG ANTHROPIC_BASE_URL SWITCHROOM_LITELLM SWITCHROOM_LITELLM_BASE",
          'export SWITCHROOM_LITELLM_DECLARED="1"',
          '_LITELLM_OK=""',
          '_LITELLM_UNREACHABLE=""',
          block,
        ].join("\n"),
      ],
      { encoding: "utf-8" },
    );
  }

  /** A healthy boot: key present, proxy live, riding the /anthropic passthrough. */
  function bootHealthy(): void {
    execFileSync(
      "bash",
      [
        "-c",
        [
          "set -e",
          "unset SWITCHROOM_CONFIG",
          'export ANTHROPIC_BASE_URL="http://litellm:4010/anthropic"',
          'export SWITCHROOM_LITELLM_BASE="http://litellm:4010"',
          'export SWITCHROOM_LITELLM_DECLARED="1"',
          '_LITELLM_OK="1"',
          '_LITELLM_UNREACHABLE=""',
          block,
        ].join("\n"),
      ],
      { encoding: "utf-8" },
    );
  }

  /** Run the real doctor check against the real file on disk. */
  function doctor() {
    return runRoutingModeChecks(
      { agents: { [basename(agentDir)]: {} } } as unknown as SwitchroomConfig,
      { agentsDir: dirname(agentDir) },
    );
  }

  /**
   * Push rows through doctor's REAL section counter. `switchroom doctor` exits
   * 1 iff the summed `fails` is > 0 (src/cli/doctor.ts), so a zero `fails`
   * tally here is the actual "does not turn the build red" assertion.
   */
  function counts(results: ReturnType<typeof doctor>) {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      return printSection("LiteLLM boot routing", results);
    } finally {
      logSpy.mockRestore();
    }
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-doctor-routing-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("WARNs doctor after a real missing-key boot lands on untracked direct OAuth", () => {
    scaffold("claude-sonnet-5"); // declares passthrough
    bootStripped();

    // Precondition: the shell really did record the untracked landing. If this
    // ever stops holding, the assertion below is meaningless.
    const record = readFileSync(join(agentDir, ".routing-mode"), "utf-8");
    expect(record).toContain("mode=direct-oauth");
    expect(record).toContain("declared=passthrough");

    const results = doctor();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("warn");
    expect(results[0].name).toContain(AGENT);
    expect(results[0].detail).toContain("UNTRACKED");
    expect(results[0].fix).toContain("switchroom apply");
  });

  it("does NOT make doctor exit non-zero — real shell boot → real fail tally", () => {
    // The end-to-end version of the operator's 2026-07-29 ruling: a REAL
    // rendered start.sh really stripping the routing env must leave a standing
    // row, and that row must contribute ZERO to the counter doctor exits on.
    scaffold("claude-sonnet-5");
    bootStripped();
    expect(readFileSync(join(agentDir, ".routing-mode"), "utf-8")).toContain("mode=direct-oauth");

    const results = doctor();
    expect(results).toHaveLength(1); // the row is really there…
    expect(counts(results)).toEqual({ oks: 0, warns: 1, fails: 0, skips: 0 }); // …and costs 0 fails
  });

  it("WARNs doctor for a stripped router-root agent (fable) too", () => {
    scaffold("fable"); // declares router-root
    bootStripped();
    expect(readFileSync(join(agentDir, ".routing-mode"), "utf-8")).toContain("declared=router-root");

    const results = doctor();
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("warn");
    expect(counts(results).fails).toBe(0);
  });

  it("stays silent after a real healthy boot on the passthrough", () => {
    scaffold("claude-sonnet-5");
    bootHealthy();
    expect(readFileSync(join(agentDir, ".routing-mode"), "utf-8")).toContain("mode=passthrough");
    expect(doctor()).toEqual([]);
  });

  it("stays silent for an agent that has never booted (no record written)", () => {
    scaffold("claude-sonnet-5");
    expect(existsSync(join(agentDir, ".routing-mode"))).toBe(false);
    expect(doctor()).toEqual([]);
  });

  it("stays silent when LiteLLM was never configured for the agent", () => {
    // No SWITCHROOM_LITELLM_DECLARED at all → start.sh forces
    // declared=direct-oauth, landed matches, no invariant to breach.
    scaffold("claude-sonnet-5");
    execFileSync(
      "bash",
      [
        "-c",
        [
          "set -e",
          "unset SWITCHROOM_CONFIG ANTHROPIC_BASE_URL SWITCHROOM_LITELLM SWITCHROOM_LITELLM_BASE SWITCHROOM_LITELLM_DECLARED",
          '_LITELLM_OK=""',
          '_LITELLM_UNREACHABLE=""',
          block,
        ].join("\n"),
      ],
      { encoding: "utf-8" },
    );
    expect(readFileSync(join(agentDir, ".routing-mode"), "utf-8")).toContain("declared=direct-oauth");
    expect(doctor()).toEqual([]);
  });
});
