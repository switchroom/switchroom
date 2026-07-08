import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldAgent } from "../src/agents/scaffold.js";
import type { AgentConfig, SwitchroomConfig, TelegramConfig } from "../src/config/schema.js";

// Session-only model relaunch (non-Claude sr-* models): the rendered start.sh
// must, at boot, consume a `.session-model-override` carrier written by the
// Telegram gateway and launch `claude --model <token>`. One-shot + session-
// only: the carrier is deleted regardless of validity, so the next restart
// reverts to the configured default. An sr-* override with LiteLLM unreachable
// at boot (empty _LITELLM_OK) is DROPPED back to the default + an alert
// sentinel is written for the gateway to surface to the operator.
// See profiles/_base/start.sh.hbs and telegram-plugin/gateway/model-command.ts.

const telegramConfig: TelegramConfig = {
  bot_token: "123456:ABC-DEF",
  forum_chat_id: "-1001234567890",
};

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    extends: "default",
    topic_name: "Test Topic",
    schedule: [],
    ...overrides,
  } as AgentConfig;
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
  };
}

const DEFAULT_MODEL = "claude-sonnet-5";

describe("scaffoldAgent: session-only model override carrier (start.sh)", () => {
  let tmpDir: string;
  let agentDir: string;
  let block: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "switchroom-session-model-"));
    const name = "sm-agent";
    const config = makeAgentConfig();
    const res = scaffoldAgent(name, config, tmpDir, telegramConfig, makeSwitchroomConfig(name, config));
    agentDir = res.agentDir;
    const startSh = readFileSync(join(agentDir, "start.sh"), "utf-8");

    // Extract JUST the session-model-override block so we can execute it in
    // isolation (the full start.sh forks tmux/gateway). From the block header
    // through the `.active-session-model` write.
    const start = startSh.indexOf("# --- Session-only model override");
    const anchor = startSh.indexOf('printf \'%s\\n\' "$_EFFECTIVE_MODEL" > ');
    const end = startSh.indexOf("\n", anchor);
    expect(start).toBeGreaterThan(-1);
    expect(anchor).toBeGreaterThan(-1);
    block = startSh.slice(start, end);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Run the extracted block with a given _LITELLM_OK, echo the effective model. */
  function runBlock(litellmOk: string): string {
    const script = `set -e\n_LITELLM_OK=${JSON.stringify(litellmOk)}\n${block}\necho "EFFECTIVE=$_EFFECTIVE_MODEL"`;
    const out = execFileSync("bash", ["-c", script], { encoding: "utf-8" });
    const m = out.match(/EFFECTIVE=(.*)/);
    return m ? m[1].trim() : "";
  }

  /**
   * Run the extracted block with routing env seeded the way the litellm block
   * above would leave it on a REACHABLE proxy: ANTHROPIC_BASE_URL points at the
   * `/anthropic` passthrough, SWITCHROOM_LITELLM_BASE at the router root. Returns
   * both the effective model and the ANTHROPIC_BASE_URL the block leaves set, so
   * we can assert the sr-* passthrough→router repoint.
   */
  const PASSTHROUGH = "http://litellm:4010/anthropic";
  const ROUTER_ROOT = "http://litellm:4010";
  function runBlockRouting(litellmOk: string): { effective: string; baseUrl: string } {
    const script = [
      "set -e",
      `export ANTHROPIC_BASE_URL=${JSON.stringify(PASSTHROUGH)}`,
      `export SWITCHROOM_LITELLM_BASE=${JSON.stringify(ROUTER_ROOT)}`,
      `_LITELLM_OK=${JSON.stringify(litellmOk)}`,
      block,
      'echo "EFFECTIVE=$_EFFECTIVE_MODEL"',
      'echo "BASEURL=$ANTHROPIC_BASE_URL"',
    ].join("\n");
    const out = execFileSync("bash", ["-c", script], { encoding: "utf-8" });
    const eff = out.match(/EFFECTIVE=(.*)/);
    const base = out.match(/BASEURL=(.*)/);
    return {
      effective: eff ? eff[1].trim() : "",
      baseUrl: base ? base[1].trim() : "",
    };
  }

  it("renders the carrier + companion file wiring in start.sh", () => {
    expect(block).toContain(".session-model-override");
    expect(block).toContain(".active-session-model");
    expect(block).toContain(".session-model-alert");
    // modelQ is assigned BARE (already shell-quoted by the scaffold).
    expect(block).toContain("_EFFECTIVE_MODEL='claude-sonnet-5'");
    // The exec section launches with the effective model, not a baked --model.
    const startSh = readFileSync(join(agentDir, "start.sh"), "utf-8");
    expect(startSh).toContain('--model "$_EFFECTIVE_MODEL"');
    expect(startSh).not.toContain("--model {{{modelQ}}}");
  });

  it("no carrier present → boots on the configured default, writes .active-session-model", () => {
    expect(runBlock("1")).toBe(DEFAULT_MODEL);
    expect(existsSync(join(agentDir, ".session-model-override"))).toBe(false);
    expect(readFileSync(join(agentDir, ".active-session-model"), "utf-8").trim()).toBe(DEFAULT_MODEL);
  });

  it("valid sr-* override + LiteLLM up → launches the override, deletes the carrier", () => {
    writeFileSync(join(agentDir, ".session-model-override"), "sr-glm-5\n");
    expect(runBlock("1")).toBe("sr-glm-5");
    // One-shot: carrier consumed regardless.
    expect(existsSync(join(agentDir, ".session-model-override"))).toBe(false);
    // Companion reflects the effective launched model.
    expect(readFileSync(join(agentDir, ".active-session-model"), "utf-8").trim()).toBe("sr-glm-5");
    // No down-alert when LiteLLM is reachable.
    expect(existsSync(join(agentDir, ".session-model-alert"))).toBe(false);
  });

  it("malformed override → falls back to default and still deletes the carrier", () => {
    writeFileSync(join(agentDir, ".session-model-override"), "bad name; rm -rf /\n");
    expect(runBlock("1")).toBe(DEFAULT_MODEL);
    expect(existsSync(join(agentDir, ".session-model-override"))).toBe(false);
    expect(readFileSync(join(agentDir, ".active-session-model"), "utf-8").trim()).toBe(DEFAULT_MODEL);
  });

  it("sr-* override + LiteLLM DOWN → drops to default, writes alert sentinel", () => {
    writeFileSync(join(agentDir, ".session-model-override"), "sr-glm-5\n");
    // _LITELLM_OK empty = proxy unreachable at boot.
    expect(runBlock("")).toBe(DEFAULT_MODEL);
    expect(existsSync(join(agentDir, ".session-model-override"))).toBe(false);
    expect(readFileSync(join(agentDir, ".active-session-model"), "utf-8").trim()).toBe(DEFAULT_MODEL);
    const alert = readFileSync(join(agentDir, ".session-model-alert"), "utf-8");
    expect(alert).toContain("sr-glm-5");
    expect(alert).toContain("LiteLLM");
  });

  it("a Claude override does NOT require LiteLLM (launches even with proxy down)", () => {
    writeFileSync(join(agentDir, ".session-model-override"), "claude-opus-4-8\n");
    expect(runBlock("")).toBe("claude-opus-4-8");
    expect(existsSync(join(agentDir, ".session-model-alert"))).toBe(false);
  });

  // --- sr-* passthrough→router repoint (fleet-wide /model <sr-*> fix) ---------
  // The default ANTHROPIC_BASE_URL points at the LiteLLM `/anthropic`
  // PASSTHROUGH (a raw byte-forward to api.anthropic.com added 2026-07-05 to
  // dodge the Opus SSE re-chunk stall). That passthrough is model-agnostic:
  // it ships EVERY request to Anthropic regardless of --model, so an sr-*
  // OpenRouter model 4xxs "model not found". When an sr-* override is picked up
  // AND LiteLLM is reachable, start.sh must repoint ANTHROPIC_BASE_URL onto the
  // LiteLLM router root so /v1/messages routes by model name to OpenRouter.
  it("sr-* override + LiteLLM up → repoints ANTHROPIC_BASE_URL off /anthropic onto the router root", () => {
    writeFileSync(join(agentDir, ".session-model-override"), "sr-glm-5\n");
    const { effective, baseUrl } = runBlockRouting("1");
    // Launches the requested OpenRouter model.
    expect(effective).toBe("sr-glm-5");
    // Repointed to the LiteLLM router root — the `/anthropic` passthrough suffix
    // is gone, so claude's /v1/messages hits LiteLLM's model router.
    expect(baseUrl).toBe(ROUTER_ROOT);
    expect(baseUrl.endsWith("/anthropic")).toBe(false);
  });

  it("no override (Claude default) → KEEPS the /anthropic passthrough (guards the Opus SSE fix)", () => {
    // No carrier: default Claude session must retain the passthrough endpoint.
    const { effective, baseUrl } = runBlockRouting("1");
    expect(effective).toBe(DEFAULT_MODEL);
    expect(baseUrl).toBe(PASSTHROUGH);
    expect(baseUrl.endsWith("/anthropic")).toBe(true);
  });

  it("claude-* override → KEEPS the /anthropic passthrough (only sr-* repoints)", () => {
    writeFileSync(join(agentDir, ".session-model-override"), "claude-opus-4-8\n");
    const { effective, baseUrl } = runBlockRouting("1");
    expect(effective).toBe("claude-opus-4-8");
    expect(baseUrl).toBe(PASSTHROUGH);
    expect(baseUrl.endsWith("/anthropic")).toBe(true);
  });

  it("sr-* override + LiteLLM DOWN → override dropped to default, passthrough untouched, alert written", () => {
    writeFileSync(join(agentDir, ".session-model-override"), "sr-glm-5\n");
    const { effective, baseUrl } = runBlockRouting("");
    // Dropped back to configured default (existing fail-safe behavior).
    expect(effective).toBe(DEFAULT_MODEL);
    // No repoint when the proxy is down — endpoint left as-is.
    expect(baseUrl).toBe(PASSTHROUGH);
    // Operator alert sentinel written.
    const alert = readFileSync(join(agentDir, ".session-model-alert"), "utf-8");
    expect(alert).toContain("sr-glm-5");
    expect(alert).toContain("LiteLLM");
  });
});
