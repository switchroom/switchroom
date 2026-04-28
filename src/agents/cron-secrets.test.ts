/**
 * Tests for vault-broker ACL comment in buildCronScript (PR 1).
 *
 * Verifies:
 *   - When secrets: ["foo", "bar"] are declared, the generated script
 *     contains the "# Allowed vault keys" comment with both names.
 *   - When secrets is empty (or absent), no such comment is emitted.
 *   - The rest of the script body is unaffected by the secrets parameter.
 */

import { describe, expect, it } from "vitest";
import { buildCronScript } from "./scaffold.js";

const AGENT_DIR = "/home/test/.switchroom/agents/sample";
const PROMPT = "Send a brief.";
const MODEL = "claude-sonnet-4-6";
const CHAT_ID = "1234567";

describe("buildCronScript: vault-broker ACL comment", () => {
  it("emits '# Allowed vault keys' comment when secrets are declared", () => {
    const script = buildCronScript(AGENT_DIR, PROMPT, MODEL, CHAT_ID, undefined, ["foo", "bar"]);
    expect(script).toContain("# Allowed vault keys for this cron (broker ACL): foo, bar");
  });

  it("lists all declared secrets in the comment", () => {
    const script = buildCronScript(
      AGENT_DIR, PROMPT, MODEL, CHAT_ID, undefined,
      ["openai_api_key", "polygon_api_key", "slack_token"],
    );
    expect(script).toContain("openai_api_key, polygon_api_key, slack_token");
  });

  it("omits the comment entirely when secrets is []", () => {
    const script = buildCronScript(AGENT_DIR, PROMPT, MODEL, CHAT_ID, undefined, []);
    expect(script).not.toContain("Allowed vault keys");
  });

  it("omits the comment entirely when secrets parameter is omitted (default [])", () => {
    const script = buildCronScript(AGENT_DIR, PROMPT, MODEL, CHAT_ID, undefined);
    expect(script).not.toContain("Allowed vault keys");
  });

  it("preserves OAuth auth setup regardless of secrets", () => {
    const script = buildCronScript(AGENT_DIR, PROMPT, MODEL, CHAT_ID, undefined, ["foo"]);
    expect(script).toContain("unset ANTHROPIC_API_KEY");
    expect(script).toContain("unset CLAUDE_CODE_OAUTH_TOKEN");
    expect(script).toContain(`export CLAUDE_CONFIG_DIR='${AGENT_DIR}/.claude'`);
  });

  it("preserves --no-session-persistence and model flag regardless of secrets", () => {
    const script = buildCronScript(AGENT_DIR, PROMPT, MODEL, CHAT_ID, undefined, ["foo"]);
    expect(script).toContain("--no-session-persistence");
    expect(script).toContain(`--model '${MODEL}'`);
  });

  it("script without secrets is byte-identical to script with empty secrets", () => {
    const noSecrets = buildCronScript(AGENT_DIR, PROMPT, MODEL, CHAT_ID, undefined);
    const emptySecrets = buildCronScript(AGENT_DIR, PROMPT, MODEL, CHAT_ID, undefined, []);
    expect(noSecrets).toBe(emptySecrets);
  });

  it("the ACL comment appears near the top, before the claude invocation", () => {
    const script = buildCronScript(AGENT_DIR, PROMPT, MODEL, CHAT_ID, undefined, ["foo"]);
    const commentIdx = script.indexOf("# Allowed vault keys");
    const claudeIdx = script.indexOf("exec claude -p");
    expect(commentIdx).toBeGreaterThan(-1);
    expect(claudeIdx).toBeGreaterThan(-1);
    expect(commentIdx).toBeLessThan(claudeIdx);
  });
});
