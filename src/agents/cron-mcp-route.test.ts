/**
 * Tests asserting the MCP-only delivery path for generated cron scripts (issue #269).
 *
 * Verifies:
 *   - buildCronScript() produces a script that discards stdout (> /dev/null)
 *   - buildCronScript() does NOT produce a script with curl or sendMessage
 *     (no Telegram Bot API call from the shell)
 *   - The wrapped prompt visible inside the generated script contains the
 *     literal strings `mcp__switchroom-telegram__reply` and `HEARTBEAT_OK`
 */

import { describe, expect, it } from "vitest";
import { buildCronScript } from "./scaffold.js";

const AGENT_DIR = "/home/test/.switchroom/agents/sample";
const PROMPT = "Send a morning briefing.";
const MODEL = "claude-sonnet-4-6";
const CHAT_ID = "1234567";

describe("buildCronScript: MCP-only delivery path (issue #269)", () => {
  it("stdout is suppressed (> /dev/null) in the generated script", () => {
    const script = buildCronScript(AGENT_DIR, PROMPT, MODEL, CHAT_ID, undefined);
    // The exec line must redirect stdout to /dev/null
    expect(script).toMatch(/> \/dev\/null/);
  });

  it("stderr is NOT suppressed — journalctl can capture errors", () => {
    const script = buildCronScript(AGENT_DIR, PROMPT, MODEL, CHAT_ID, undefined);
    // Must not contain 2>&1 alongside the /dev/null redirect (that would swallow stderr)
    expect(script).not.toContain("> /dev/null 2>&1");
  });

  it("does NOT contain curl in the generated script", () => {
    const script = buildCronScript(AGENT_DIR, PROMPT, MODEL, CHAT_ID, undefined);
    expect(script).not.toContain("curl");
  });

  it("does NOT contain sendMessage (no Bot API call from shell)", () => {
    const script = buildCronScript(AGENT_DIR, PROMPT, MODEL, CHAT_ID, undefined);
    expect(script).not.toContain("sendMessage");
  });

  it("does NOT contain api.telegram.org in the generated script", () => {
    const script = buildCronScript(AGENT_DIR, PROMPT, MODEL, CHAT_ID, undefined);
    expect(script).not.toContain("api.telegram.org");
  });

  it("wrapped prompt contains mcp__switchroom-telegram__reply instruction", () => {
    const script = buildCronScript(AGENT_DIR, PROMPT, MODEL, CHAT_ID, undefined);
    // The wrapped prompt is shell-quoted inside the script; the MCP tool name
    // must appear verbatim so the model knows to call it.
    expect(script).toContain("mcp__switchroom-telegram__reply");
  });

  it("wrapped prompt contains HEARTBEAT_OK sentinel instruction", () => {
    const script = buildCronScript(AGENT_DIR, PROMPT, MODEL, CHAT_ID, undefined);
    expect(script).toContain("HEARTBEAT_OK");
  });

  it("uses exec claude -p (not OUTPUT=$(...)) — process replacement, no subshell", () => {
    const script = buildCronScript(AGENT_DIR, PROMPT, MODEL, CHAT_ID, undefined);
    expect(script).toContain("exec claude -p");
    expect(script).not.toContain("OUTPUT=$(claude -p");
  });

  it("the chatId from the call site is embedded in the wrapped prompt", () => {
    const script = buildCronScript(AGENT_DIR, PROMPT, MODEL, CHAT_ID, undefined);
    // The guidance block includes the chatId so the model can address the right chat
    expect(script).toContain(CHAT_ID);
  });

  it("with broker socket: still uses MCP-only path (no curl)", () => {
    const script = buildCronScript(
      AGENT_DIR, PROMPT, MODEL, CHAT_ID, undefined,
      ["key_a"], "/home/test/.switchroom/vault-broker.sock",
    );
    expect(script).not.toContain("curl");
    expect(script).toContain("exec claude -p");
    expect(script).toMatch(/> \/dev\/null/);
  });
});
