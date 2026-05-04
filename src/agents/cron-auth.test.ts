/**
 * Tests for cron-script authentication. Switchroom's whole thesis is OAuth
 * subscription quota, NOT API-key billing. Every generated cron script must:
 *   1. unset ANTHROPIC_API_KEY (defense against ambient env pollution),
 *   2. point claude CLI at the agent's own .claude/ via CLAUDE_CONFIG_DIR,
 *   3. inject CLAUDE_CODE_OAUTH_TOKEN from the agent's .oauth-token,
 *   4. never contain a literal API-key pattern (sk-ant-...).
 *
 * Regression: a prior build emitted Environment=ANTHROPIC_API_KEY=... into
 * agent cron systemd units (resolved from a vault: ref in switchroom.yaml),
 * silently shifting cron auth from OAuth to the API. The fix moved auth
 * setup into the .sh template so it's deterministic and inspectable.
 */

import { describe, expect, it } from "vitest";
import { buildCronScript } from "./scaffold.js";

const SAMPLE_AGENT_DIR = "/home/test/.switchroom/agents/sample";
const SAMPLE_PROMPT = "Send a brief.";
const SAMPLE_MODEL = "claude-sonnet-4-6";
const SAMPLE_CHAT = "1234567";

describe("buildCronScript: OAuth-only auth", () => {
  it("unsets ANTHROPIC_API_KEY before invoking claude", () => {
    const script = buildCronScript(
      SAMPLE_AGENT_DIR, SAMPLE_PROMPT, SAMPLE_MODEL, SAMPLE_CHAT, undefined,
    );
    const unsetIdx = script.indexOf("unset ANTHROPIC_API_KEY");
    const claudeIdx = script.search(/^claude -p /m);
    expect(unsetIdx).toBeGreaterThan(-1);
    expect(claudeIdx).toBeGreaterThan(-1);
    expect(unsetIdx).toBeLessThan(claudeIdx);
  });

  it("points CLAUDE_CONFIG_DIR at the agent's own .claude directory", () => {
    const script = buildCronScript(
      SAMPLE_AGENT_DIR, SAMPLE_PROMPT, SAMPLE_MODEL, SAMPLE_CHAT, undefined,
    );
    expect(script).toContain(`export CLAUDE_CONFIG_DIR='${SAMPLE_AGENT_DIR}/.claude'`);
  });

  it("injects CLAUDE_CODE_OAUTH_TOKEN from .oauth-token when present", () => {
    const script = buildCronScript(
      SAMPLE_AGENT_DIR, SAMPLE_PROMPT, SAMPLE_MODEL, SAMPLE_CHAT, undefined,
    );
    expect(script).toMatch(/unset CLAUDE_CODE_OAUTH_TOKEN/);
    expect(script).toMatch(/if \[ -f "\$CLAUDE_CONFIG_DIR\/\.oauth-token" \]/);
    expect(script).toMatch(/export CLAUDE_CODE_OAUTH_TOKEN="\$\(/);
  });

  it("never embeds a literal API-key pattern", () => {
    const script = buildCronScript(
      SAMPLE_AGENT_DIR, "Prompt that mentions sk-ant-api03-foo as text.",
      SAMPLE_MODEL, SAMPLE_CHAT, undefined,
    );
    // The prompt is single-quoted shell, so even if user text contains
    // sk-ant-* it must be inside the prompt body, not as bare env. We assert
    // that no `Environment=ANTHROPIC_API_KEY=...` or `export ANTHROPIC_API_KEY=`
    // line is present anywhere in the generated script.
    expect(script).not.toMatch(/^export ANTHROPIC_API_KEY=/m);
    expect(script).not.toMatch(/^Environment=ANTHROPIC_API_KEY=/m);
  });

  it("uses --no-session-persistence and the configured model", () => {
    const script = buildCronScript(
      SAMPLE_AGENT_DIR, SAMPLE_PROMPT, "claude-haiku-4-5-20251001", SAMPLE_CHAT, undefined,
    );
    expect(script).toContain("--no-session-persistence");
    expect(script).toContain("--model 'claude-haiku-4-5-20251001'");
  });

  it("exports SWITCHROOM_AGENT_NAME derived from agentDir basename", () => {
    // Required so in-prompt `switchroom issues record` calls without an
    // explicit --agent flag attribute correctly, and so the vault broker
    // client can resolve a default agent. Mirrors the gateway unit's
    // Environment=SWITCHROOM_AGENT_NAME= setting in src/agents/systemd.ts.
    const script = buildCronScript(
      SAMPLE_AGENT_DIR, SAMPLE_PROMPT, SAMPLE_MODEL, SAMPLE_CHAT, undefined,
    );
    expect(script).toContain("export SWITCHROOM_AGENT_NAME='sample'");
  });

  it("auth setup happens after cd into agent dir, before claude invocation", () => {
    const script = buildCronScript(
      SAMPLE_AGENT_DIR, SAMPLE_PROMPT, SAMPLE_MODEL, SAMPLE_CHAT, undefined,
    );
    const cdIdx = script.indexOf(`cd '${SAMPLE_AGENT_DIR}'`);
    const oauthIdx = script.indexOf("export CLAUDE_CODE_OAUTH_TOKEN");
    const claudeIdx = script.search(/^claude -p /m);
    expect(cdIdx).toBeGreaterThan(-1);
    expect(cdIdx).toBeLessThan(oauthIdx);
    expect(oauthIdx).toBeLessThan(claudeIdx);
  });
});
