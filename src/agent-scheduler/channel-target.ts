/**
 * Channel-target resolution — extracted from `index.ts` so callers that
 * only need to resolve an agent's chat/thread target can import these
 * pure functions WITHOUT dragging the scheduler's `node-cron` require
 * (in `index.ts`) into their bundle. The in-container gateway's webhook
 * ingest path (`src/web/webhook-gateway-record.ts`) imports from here;
 * `index.ts` re-exports for backward compatibility.
 *
 * All functions here are pure — no I/O, no node-cron, no top-level side
 * effects.
 */

import { loadConfig } from "../config/loader.js";
import { resolveAgentConfig } from "../config/merge.js";
import { resolveOutboundTopic } from "../telegram/topic-router.js";
import type { SchedulerEntry } from "../scheduler/dispatch.js";

/**
 * Resolved chat target for a single agent. When the agent is in
 * supergroup-owned mode, each per-entry `topic` field resolves through
 * `resolveOutboundTopic({ kind: 'cron', entryTopic })`. Unset /
 * undefined for fleet-mode and DM agents — behavior unchanged.
 */
export interface AgentChannelTarget {
  chatId: string;
  threadId?: number;
  routerConfig?: { default_topic_id?: number; topic_aliases?: Record<string, number> };
}

/**
 * Resolve the chat target for the in-agent scheduler from the
 * cascade-resolved config: the forum chat ID is global; the agent's
 * topic ID is per-agent (auto-populated by `switchroom topics sync`).
 *
 * Returns null when the agent has no configured topic — the scheduler
 * exits with a clear error rather than silently misrouting fires.
 */
export function resolveChannelTarget(
  config: ReturnType<typeof loadConfig>,
  agentName: string,
): AgentChannelTarget | null {
  const agent = config.agents?.[agentName];

  // Resolve through the cascade only when the agent exists, so a
  // supergroup-owned override at the per-agent
  // `channels.telegram.chat_id` level takes precedence over the
  // fleet `telegram.forum_chat_id`. Missing-agent fall-through to
  // the fleet-chat lookup preserves the prior leniency contract.
  const tgChannel = agent
    ? resolveAgentConfig(config.defaults, config.profiles, agent).channels?.telegram
    : undefined;
  const supergroupChatId = tgChannel?.chat_id;
  const supergroupDefaultTopic = tgChannel?.default_topic_id;

  if (typeof supergroupChatId === "string" && supergroupChatId.length > 0) {
    // Supergroup-owned mode: agent owns its own supergroup. The
    // router config carries default_topic_id + topic_aliases so
    // per-entry `topic` resolves at dispatch time (PR4b-cron).
    return {
      chatId: supergroupChatId,
      ...(typeof supergroupDefaultTopic === "number" ? { threadId: supergroupDefaultTopic } : {}),
      routerConfig: {
        ...(typeof supergroupDefaultTopic === "number" ? { default_topic_id: supergroupDefaultTopic } : {}),
        ...(tgChannel?.topic_aliases ? { topic_aliases: tgChannel.topic_aliases } : {}),
      },
    };
  }

  // Fleet mode (the existing default): one shared forum_chat_id, each
  // agent assigned a per-agent topic_id.
  const forumChatId = config.telegram?.forum_chat_id;
  if (typeof forumChatId !== "string" || forumChatId.length === 0) return null;
  const threadId = agent?.topic_id;
  return {
    chatId: forumChatId,
    ...(typeof threadId === "number" ? { threadId } : {}),
  };
}

/**
 * Resolve the Telegram thread_id to dispatch a synthetic-inbound on.
 *
 * - Supergroup-owned agents: the per-entry `topic` field (alias name
 *   or numeric ID) flows through `resolveOutboundTopic({ kind: 'cron',
 *   entryTopic })`. Unknown aliases / missing topic field fall back to
 *   the agent's `default_topic_id` (carried as `channel.threadId`).
 * - Fleet / DM agents: returns the channel's threadId unchanged
 *   (the agent's home topic_id in the shared supergroup, or undefined
 *   for DMs).
 *
 * Pure — no I/O. Tested via the topic-router suite plus a small
 * integration row in the scheduler's tests.
 */
export function resolveEntryThreadId(
  entry: SchedulerEntry,
  channel: AgentChannelTarget,
): number | undefined {
  if (channel.routerConfig) {
    const routed = resolveOutboundTopic(channel.routerConfig, {
      kind: "cron",
      entryTopic: entry.topic,
    });
    if (routed !== undefined) return routed;
  }
  return channel.threadId;
}
