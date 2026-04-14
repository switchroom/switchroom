import type { SwitchroomConfig } from "../config/schema.js";
import { loadTopicState, saveTopicState, type TopicState, type TopicEntry } from "./state.js";

export interface TopicSyncResult {
  agent: string;
  topic_name: string;
  topic_id: number;
  status: "created" | "existing";
}

export class TopicSyncError extends Error {
  constructor(
    message: string,
    public agent?: string,
    public apiResponse?: unknown
  ) {
    super(message);
    this.name = "TopicSyncError";
  }
}

/**
 * Resolve the bot token from config, handling vault: prefix and env fallback.
 * Returns the token string or null if unresolvable.
 */
export function resolveBotToken(configToken: string): string | null {
  if (configToken.startsWith("vault:")) {
    console.warn(
      `Warning: Vault references are not yet implemented (found "${configToken}").`
    );
    console.warn(
      "  Set TELEGRAM_BOT_TOKEN environment variable as a fallback."
    );
    const envToken = process.env.TELEGRAM_BOT_TOKEN;
    return envToken && envToken.length > 0 ? envToken : null;
  }

  // Check env override first, then fall back to config value
  const envToken = process.env.TELEGRAM_BOT_TOKEN;
  if (envToken && envToken.length > 0) {
    return envToken;
  }

  return configToken;
}

interface CreateForumTopicResponse {
  ok: boolean;
  result?: {
    message_thread_id: number;
    name: string;
    icon_color?: number;
    icon_custom_emoji_id?: string;
  };
  description?: string;
  error_code?: number;
}

async function createForumTopic(
  botToken: string,
  chatId: string,
  name: string,
  iconCustomEmojiId?: string
): Promise<{ topic_id: number; topic_name: string }> {
  const url = `https://api.telegram.org/bot${botToken}/createForumTopic`;

  const body: Record<string, string> = {
    chat_id: chatId,
    name,
  };
  if (iconCustomEmojiId) {
    body.icon_custom_emoji_id = iconCustomEmojiId;
  }

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new TopicSyncError(
      `Network error calling Telegram API: ${(err as Error).message}`
    );
  }

  const data = (await response.json()) as CreateForumTopicResponse;

  if (!data.ok) {
    const errorMsg = data.description ?? "Unknown Telegram API error";
    const code = data.error_code ?? response.status;

    if (errorMsg.includes("not enough rights") || errorMsg.includes("CHAT_ADMIN_REQUIRED")) {
      throw new TopicSyncError(
        `Bot is not an admin in the forum group: ${errorMsg}`
      );
    }
    if (errorMsg.includes("PEER_ID_INVALID") || errorMsg.includes("chat not found")) {
      throw new TopicSyncError(
        `Forum chat not found. Check forum_chat_id in config: ${errorMsg}`
      );
    }
    if (code === 429) {
      throw new TopicSyncError(
        `Rate limited by Telegram API. Please try again later: ${errorMsg}`
      );
    }
    if (errorMsg.includes("not a forum")) {
      throw new TopicSyncError(
        `Chat is not a forum group. Enable topics in the group settings: ${errorMsg}`
      );
    }

    throw new TopicSyncError(`Telegram API error (${code}): ${errorMsg}`);
  }

  if (!data.result) {
    throw new TopicSyncError("Telegram API returned ok but no result");
  }

  return {
    topic_id: data.result.message_thread_id,
    topic_name: data.result.name,
  };
}

/**
 * Sync forum topics for all agents that have a topic_name.
 * Creates topics that don't exist yet, skips ones already mapped.
 */
export async function syncTopics(
  config: SwitchroomConfig,
  statePath?: string
): Promise<TopicSyncResult[]> {
  const botToken = resolveBotToken(config.telegram.bot_token);
  if (!botToken) {
    throw new TopicSyncError(
      "Cannot resolve bot token. Set TELEGRAM_BOT_TOKEN environment variable or configure a literal token in switchroom.yaml."
    );
  }

  const chatId = config.telegram.forum_chat_id;
  const state = loadTopicState(statePath);
  const results: TopicSyncResult[] = [];

  for (const [agentName, agentConfig] of Object.entries(config.agents)) {
    if (!agentConfig.topic_name) continue;

    // Check if already mapped in state
    const existing = state.topics[agentName];
    if (existing) {
      results.push({
        agent: agentName,
        topic_name: existing.topic_name,
        topic_id: existing.topic_id,
        status: "existing",
      });
      continue;
    }

    // Check if agent has a hardcoded topic_id in config
    if (agentConfig.topic_id) {
      state.topics[agentName] = {
        topic_id: agentConfig.topic_id,
        topic_name: agentConfig.topic_name,
        created_at: new Date().toISOString(),
      };
      results.push({
        agent: agentName,
        topic_name: agentConfig.topic_name,
        topic_id: agentConfig.topic_id,
        status: "existing",
      });
      continue;
    }

    // Create the topic via Bot API
    const { topic_id, topic_name } = await createForumTopic(
      botToken,
      chatId,
      agentConfig.topic_name,
      agentConfig.topic_emoji
    );

    state.topics[agentName] = {
      topic_id,
      topic_name,
      created_at: new Date().toISOString(),
    };

    results.push({
      agent: agentName,
      topic_name,
      topic_id,
      status: "created",
    });
  }

  saveTopicState(state, statePath);
  return results;
}

/**
 * List all known agent-to-topic mappings from state file.
 */
export function listTopics(
  config: SwitchroomConfig,
  statePath?: string
): { agent: string; topic_name: string; topic_id: number | null }[] {
  const state = loadTopicState(statePath);
  const results: { agent: string; topic_name: string; topic_id: number | null }[] = [];

  for (const [agentName, agentConfig] of Object.entries(config.agents)) {
    if (!agentConfig.topic_name) continue;

    const entry = state.topics[agentName];
    results.push({
      agent: agentName,
      topic_name: agentConfig.topic_name,
      topic_id: entry?.topic_id ?? agentConfig.topic_id ?? null,
    });
  }

  return results;
}

/**
 * Look up a topic_id for a given agent name from the state file.
 */
export function resolveTopicId(
  agentName: string,
  statePath?: string
): number | null {
  const state = loadTopicState(statePath);
  return state.topics[agentName]?.topic_id ?? null;
}

/**
 * Find orphaned topics — topics in the state file that are not in the current config.
 * Returns the list of orphaned agent names and their topic IDs.
 */
export function findOrphanedTopics(
  config: SwitchroomConfig,
  statePath?: string
): { agent: string; topic_id: number; topic_name: string }[] {
  const state = loadTopicState(statePath);
  const configAgents = new Set(Object.keys(config.agents));
  const orphans: { agent: string; topic_id: number; topic_name: string }[] = [];

  for (const [agentName, entry] of Object.entries(state.topics)) {
    if (!configAgents.has(agentName)) {
      orphans.push({
        agent: agentName,
        topic_id: entry.topic_id,
        topic_name: entry.topic_name,
      });
    }
  }

  return orphans;
}

interface CloseForumTopicResponse {
  ok: boolean;
  description?: string;
  error_code?: number;
}

/**
 * Close (archive) a forum topic via the Telegram Bot API.
 * Note: Telegram doesn't support deleting topics — only closing them.
 */
async function closeForumTopic(
  botToken: string,
  chatId: string,
  messageThreadId: number
): Promise<boolean> {
  const url = `https://api.telegram.org/bot${botToken}/closeForumTopic`;

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        message_thread_id: messageThreadId,
      }),
    });

    const data = (await response.json()) as CloseForumTopicResponse;
    return data.ok === true;
  } catch {
    return false;
  }
}

/**
 * Clean up orphaned topics: close them in Telegram and remove from state.
 */
export async function cleanupOrphanedTopics(
  config: SwitchroomConfig,
  statePath?: string
): Promise<{ agent: string; topic_id: number; closed: boolean }[]> {
  const botToken = resolveBotToken(config.telegram.bot_token);
  if (!botToken) {
    throw new TopicSyncError(
      "Cannot resolve bot token for cleanup."
    );
  }

  const chatId = config.telegram.forum_chat_id;
  const orphans = findOrphanedTopics(config, statePath);
  const state = loadTopicState(statePath);
  const results: { agent: string; topic_id: number; closed: boolean }[] = [];

  for (const orphan of orphans) {
    const closed = await closeForumTopic(botToken, chatId, orphan.topic_id);
    delete state.topics[orphan.agent];
    results.push({
      agent: orphan.agent,
      topic_id: orphan.topic_id,
      closed,
    });
  }

  saveTopicState(state, statePath);
  return results;
}
