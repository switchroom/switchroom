/**
 * Outbound topic router for supergroup-owned agents.
 *
 * Resolves the `message_thread_id` an autonomous (non-reply) outbound
 * should target when an agent is in supergroup-owned mode
 * (`channels.telegram.chat_id` + `default_topic_id` set per
 * docs/rfcs/supergroup-mode.md). Returns `undefined` for agents in
 * fleet-shared or dm_only mode — callers fall back to today's behavior
 * (route to the agent's single `topic_id` / DM chat).
 *
 * The routing table is the authoritative encoding of the
 * "Outbound routing — by event class" section of the RFC.
 * Two principles:
 *
 *   1. Things the operator triggered in a conversation FOLLOW the
 *      conversation (`reply`, `subagent-progress`, `command-query`,
 *      `vault` and `permission` when `turnInitiated`).
 *
 *   2. Things the system / schedule triggered land in the OPS lanes —
 *      `alerts` for notifications (boot, compact, watchdog) and
 *      `admin` for action-required (background vault, background
 *      permission, command mutations, heavy-output commands,
 *      hostd approvals).
 *
 * When an alias is referenced (`alerts`, `admin`) but undefined in
 * `topic_aliases`, the router falls back to `default_topic_id`.
 */

export interface TopicRouterConfig {
  default_topic_id?: number;
  topic_aliases?: Record<string, number>;
}

/**
 * Discriminated union of every outbound event class the gateway can
 * emit. Adding a new event class is a deliberate UX decision — add
 * a case here, update the routing table below, and add a test row.
 */
export type OutboundEvent =
  // ─── Things the operator triggered (follow the conversation) ────────
  | { kind: "reply"; originThreadId: number | undefined }
  | { kind: "subagent-progress"; parentThreadId: number | undefined }
  | { kind: "command-query"; originThreadId: number | undefined }
  // Vault / permission cards split by who initiated.
  | { kind: "vault"; turnInitiated: boolean; originThreadId: number | undefined }
  | { kind: "permission"; turnInitiated: boolean; originThreadId: number | undefined }
  // Hostd approval cards are always operator-initiated (someone typed
  // /restart or tapped a button) — follow the originating turn.
  | { kind: "hostd-approval"; originThreadId: number | undefined }
  // ─── Things the system / schedule triggered (ops lanes) ─────────────
  // Cron: per-entry topic override, or default fallback.
  | { kind: "cron"; entryTopic: string | number | undefined }
  // Boot card / SessionStart — always alerts.
  | { kind: "boot" }
  // Linear app-token auth went dead and can't self-heal (no refresh bundle
  // or a revoked refresh token) — an operator-action alert, ops/alerts lane.
  | { kind: "linear-auth" }
  // Compact / watchdog — system-initiated notifications.
  | { kind: "compact-watchdog" }
  // Slash-command output classes that always belong in admin.
  | { kind: "command-mutation" }
  | { kind: "command-heavy" };

const ALERTS_ALIAS = "alerts";
const ADMIN_ALIAS = "admin";

/**
 * Look up an alias name (e.g. "planning") in the config; returns the
 * mapped numeric topic ID or undefined when the alias is unknown.
 */
function aliasToId(config: TopicRouterConfig, name: string): number | undefined {
  return config.topic_aliases?.[name];
}

/**
 * Returns the topic ID an outbound of this event class should target,
 * or `undefined` when the agent isn't in supergroup-owned mode (caller
 * uses today's per-agent routing).
 *
 * Contract:
 *   - In supergroup mode (`default_topic_id` set), always returns a
 *     number — either an alias-resolved ID, the origin thread, or
 *     `default_topic_id` as the fallback.
 *   - Outside supergroup mode (no `default_topic_id`), returns the
 *     origin thread for "follow the conversation" events (callers
 *     already pass through `message_thread_id` in this case) and
 *     `undefined` for everything else.
 */
export function resolveOutboundTopic(
  config: TopicRouterConfig | undefined,
  event: OutboundEvent,
): number | undefined {
  const cfg = config ?? {};
  const inSupergroupMode = cfg.default_topic_id != null;

  switch (event.kind) {
    // ─── Follow-the-conversation events ─────────────────────────────
    case "reply":
      return event.originThreadId;
    case "subagent-progress":
      return event.parentThreadId;
    case "command-query":
      return event.originThreadId;
    case "vault":
    case "permission":
      if (event.turnInitiated) {
        return event.originThreadId ?? cfg.default_topic_id;
      }
      // Background vault/permission requests land in admin.
      if (!inSupergroupMode) return undefined;
      return aliasToId(cfg, ADMIN_ALIAS) ?? cfg.default_topic_id;
    case "hostd-approval":
      // Operator-initiated — prefer the originating turn; fall back to
      // admin (operator commands are usually issued from admin anyway).
      if (event.originThreadId != null) return event.originThreadId;
      if (!inSupergroupMode) return undefined;
      return aliasToId(cfg, ADMIN_ALIAS) ?? cfg.default_topic_id;

    // ─── Ops-lane events ────────────────────────────────────────────
    case "cron": {
      // Cron: per-entry override (alias name or numeric ID), then
      // fall back to the agent's default_topic_id.
      if (typeof event.entryTopic === "number") return event.entryTopic;
      if (typeof event.entryTopic === "string") {
        const resolved = aliasToId(cfg, event.entryTopic);
        if (resolved != null) return resolved;
        // Unknown alias in supergroup mode falls back to default.
        // Loader-time validation should reject unknown aliases up front
        // (PR1 loader-side TODO), but defend against config drift here.
      }
      return cfg.default_topic_id;
    }
    case "boot":
    case "compact-watchdog":
    case "linear-auth":
      if (!inSupergroupMode) return undefined;
      return aliasToId(cfg, ALERTS_ALIAS) ?? cfg.default_topic_id;
    case "command-mutation":
    case "command-heavy":
      if (!inSupergroupMode) return undefined;
      return aliasToId(cfg, ADMIN_ALIAS) ?? cfg.default_topic_id;
  }
}

/**
 * Decide the `message_thread_id` to attach when an approval / permission card
 * is sent to a SPECIFIC recipient chat.
 *
 * A forum topic id (what {@link resolveOutboundTopic} returns) is valid ONLY
 * inside the agent's own supergroup (`channels.telegram.chat_id`). The approval
 * emitters, however, fan out to the operator's `allowFrom` chats — which are
 * normally **DMs**, and DMs have no topics. Attaching a topic id to a DM makes
 * Telegram reject the send with `400 Bad Request: message thread not found`, so
 * the card never arrives, the request auto-denies at its TTL, and the agent
 * wedges on the still-open prompt (the `marko` brevo incident, 2026-06-02).
 *
 * So attach the resolved topic ONLY to the recipient that actually owns it —
 * the agent's supergroup chat — and send thread-less to everyone else.
 * Returns `undefined` (no `message_thread_id`) for any non-owning recipient.
 */
export function topicForRecipient(args: {
  recipientChatId: string | number;
  resolvedTopic: number | undefined;
  supergroupChatId: string | number | undefined;
}): number | undefined {
  const { recipientChatId, resolvedTopic, supergroupChatId } = args;
  if (resolvedTopic == null || supergroupChatId == null) return undefined;
  return String(recipientChatId) === String(supergroupChatId) ? resolvedTopic : undefined;
}

/**
 * Validate that every per-cron `topic:` field in `schedule[]` is
 * resolvable — either a numeric topic ID (always accepted) or a
 * string alias defined in `topic_aliases`.
 *
 * Returns a list of human-readable error strings; empty list means OK.
 * Intended for use by the config loader (kept out of the zod schema
 * because it needs cross-field state: the schedule entries don't know
 * about the agent's `topic_aliases`).
 */
export function validateCronTopicAliases(
  config: TopicRouterConfig | undefined,
  schedule: ReadonlyArray<{ cron: string; topic?: string | number | undefined }>,
): string[] {
  const errors: string[] = [];
  const aliases = new Set(Object.keys(config?.topic_aliases ?? {}));
  for (const entry of schedule) {
    if (entry.topic == null) continue;
    if (typeof entry.topic === "number") continue;
    if (!aliases.has(entry.topic)) {
      errors.push(
        `cron \`${entry.cron}\`: topic alias "${entry.topic}" is not defined in channels.telegram.topic_aliases`,
      );
    }
  }
  return errors;
}
