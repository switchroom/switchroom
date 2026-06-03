/**
 * YAML editor for the per-agent `agents.<name>.channels.telegram.chat_id`
 * field — the one knob that flips an agent into supergroup-owned mode.
 *
 * Pure module — string-in / string-out — so the setup wizard can read the
 * existing file, mutate, and atomic-write the result without losing
 * comments or surrounding formatting. Mirrors `auth-active-yaml.ts`.
 *
 * Setting `chat_id` is the minimum to activate supergroup mode: the
 * config schema smart-defaults `default_topic_id` to General (topic 1)
 * when `chat_id` is present and `default_topic_id` is omitted
 * (`src/config/schema.ts`), so the wizard only needs to write the chat_id.
 * `default_topic_id` and `topic_aliases` are left for the operator to add
 * by hand — see `docs/supergroup-mode.md`.
 */

import { parseDocument, isMap } from "yaml";

/**
 * A Telegram supergroup id is a negative integer rendered as a string
 * (e.g. "-1001234567890"). Same shape the schema enforces — validate
 * here so the wizard never writes a malformed value to disk.
 */
export function isValidSupergroupChatId(value: string): boolean {
  return /^-\d+$/.test(value);
}

/**
 * Set `agents.<agentName>.channels.telegram.chat_id: <chatId>` in the
 * YAML text, creating the `channels` / `channels.telegram` maps if
 * missing while preserving any existing siblings and comments.
 * Idempotent — returns the input verbatim when the value already matches.
 *
 * Throws if the agent isn't present in the config (the caller is
 * expected to offer only agents that already exist). Returns the new
 * YAML text; the caller owns the atomic-write + mode preservation.
 */
export function setAgentSupergroupChatId(
  yamlText: string,
  agentName: string,
  chatId: string,
): string {
  if (!isValidSupergroupChatId(chatId)) {
    throw new Error(
      `setAgentSupergroupChatId: chat_id must be a negative integer string (got "${chatId}")`,
    );
  }
  const doc = parseDocument(yamlText);
  const root = doc.contents;
  if (!isMap(root)) {
    throw new Error("setAgentSupergroupChatId: YAML root is not a map");
  }
  const agents = root.get("agents", true);
  if (!isMap(agents)) {
    throw new Error("setAgentSupergroupChatId: config has no `agents:` map");
  }
  const agent = agents.get(agentName, true);
  if (!isMap(agent)) {
    throw new Error(
      `setAgentSupergroupChatId: agent "${agentName}" not found in config`,
    );
  }

  // Coerce a null/scalar intermediate (e.g. a bare `channels:` key) to a
  // fresh map — setIn/set crash otherwise, same hazard as auth-active-yaml.
  const channels = agent.get("channels", true);
  if (isMap(channels)) {
    const telegram = channels.get("telegram", true);
    if (isMap(telegram)) {
      if (telegram.get("chat_id") === chatId) return yamlText; // idempotent
      telegram.set("chat_id", chatId);
    } else {
      channels.set("telegram", doc.createNode({ chat_id: chatId }));
    }
  } else {
    agent.set("channels", doc.createNode({ telegram: { chat_id: chatId } }));
  }

  const out = String(doc);
  return out.endsWith("\n") ? out : out + "\n";
}
