/**
 * Scheduler dispatch logic — pure-function core, mockable for tests.
 *
 * Post-cutover (Phase 4): cron runs in-container in every agent as a
 * sibling of the gateway. This module exports two primitives:
 *
 *   - `collectScheduleEntries(config)` — walk the cascade-resolved
 *     config and return a flat (agent, schedule_index) list. The
 *     in-agent scheduler then filters to its own agent name.
 *   - `dispatchAsInbound(entry, opts, dispatcher)` — synthesize the
 *     `InboundMessage` envelope the gateway forwards to the bridge,
 *     tagged `meta.source="cron"`.
 *
 * The host-side `docker exec` dispatcher (`dispatchEntry`) and the
 * dual-run canary helpers (`inlineScheduledAgents` / `filterForSingleton`)
 * were removed in Phase 4 along with the singleton switchroom-cron
 * container. See `git log --oneline src/scheduler/` for the deletion
 * commit.
 */

import { createHash } from "node:crypto";
import type { ScheduleEntry, SwitchroomConfig } from "../config/schema.js";
import { resolveAgentConfig } from "../config/merge.js";

export interface SchedulerEntry {
  agent: string;
  scheduleIndex: number;
  cron: string;
  prompt: string;
  /** SHA-256 prefix of prompt — stable, non-reversible audit key. */
  promptKey: string;
}

/**
 * Walk the resolved config and produce a flat list of (agent, index)
 * schedule entries that the cron loop registers. Pure function: no IO.
 *
 * Deterministic order: agents sorted by name, then schedule entries by
 * declared index. Important for snapshot tests of the audit log shape.
 */
export function collectScheduleEntries(
  config: SwitchroomConfig,
): SchedulerEntry[] {
  const out: SchedulerEntry[] = [];
  const agentNames = Object.keys(config.agents).sort();
  for (const agent of agentNames) {
    // #907 root cause: resolve through the cascade so schedule entries
    // declared in `defaults.schedule` or in a profile's `extends`-chain
    // are visible to the in-agent scheduler. Walking the raw
    // `config.agents[name].schedule` skipped them entirely, so
    // collectScheduleEntries returned 0 for every agent that inherited
    // its cron from a profile, the agent-scheduler exited 0 with "no
    // schedule entries — exiting cleanly", and the start.sh supervisor
    // burned its 10-restarts-in-60s budget then gave up. From the
    // operator's perspective: scheduler vanished, no fires.
    const agentDef = config.agents[agent];
    if (!agentDef) continue;
    const resolved = resolveAgentConfig(config.defaults, config.profiles, agentDef);
    const schedule: ScheduleEntry[] = resolved.schedule ?? [];
    for (let i = 0; i < schedule.length; i++) {
      const entry = schedule[i]!;
      out.push({
        agent,
        scheduleIndex: i,
        cron: entry.cron,
        prompt: entry.prompt,
        promptKey: createHash("sha256").update(entry.prompt).digest("hex").slice(0, 12),
      });
    }
  }
  return out;
}

/**
 * Audit row written to scheduler.jsonl on every fire. Same shape since
 * Phase 1; `exitCode` and `outputSummary` semantics shifted in Phase 4
 * when the singleton (`docker exec claude -p`) was retired:
 *   - `exitCode`: 0 when the inbound was accepted by the local gateway
 *     socket; -1 when the gateway wasn't connected, the wire write
 *     failed, or the dispatcher threw.
 *   - `outputSummary`: short status string (e.g. "delivered to bridge
 *     via gateway", "no agent client connected"). Capped at 200 chars.
 */
export interface DispatchResult {
  agent: string;
  scheduleIndex: number;
  promptKey: string;
  exitCode: number;
  outputSummary: string;
  startedAt: number;
  finishedAt: number;
}

// ───────────────────────────────────────────────────────────────────────
//  In-band cron synthesis primitive
// ───────────────────────────────────────────────────────────────────────
//
// Cron runs in-container in every agent as a sibling of the gateway.
// Fires are delivered to the agent as synthesized `InboundMessage`s
// flowing the same path as Telegram messages and button-callback
// injections (gateway.ts:5217, :8796, :9226), discriminated by
// `meta.source = "cron"`. Reusing the existing envelope means the
// agent transcript and Hindsight see cron fires as ordinary turns
// tagged with `<channel source="cron">`, rather than as out-of-band
// one-shot `claude -p` runs that vanish from session history.

/**
 * InboundMessage envelope, mirrored structurally from
 * `telegram-plugin/gateway/ipc-protocol.ts` so this module can build
 * one without crossing the src/ ↔ telegram-plugin/ tsconfig boundary.
 *
 * Keep this in sync with the source of truth — the bridge's
 * `validateGatewayMessage` validator (`telegram-plugin/bridge/ipc-client.ts`)
 * is what decides whether a wire-format message is accepted.
 */
export interface InboundMessageWire {
  type: "inbound";
  chatId: string;
  threadId?: number;
  messageId: number;
  user: string;
  userId: number;
  ts: number;
  text: string;
  imagePath?: string;
  attachment?: { fileId: string; mimeType: string; fileName?: string };
  meta: Record<string, string>;
}

/**
 * Minimum surface a dispatcher needs to deliver a synthesized inbound
 * to a connected agent client. Matches the shape of the gateway's
 * `IpcServer.sendToAgent` so a real gateway can be passed in directly,
 * and tests can pass a capturing fake.
 *
 * Returns true when an agent client was registered for `agentName` and
 * the message was written to its socket; false when the agent is not
 * currently connected (the caller decides whether to drop, queue, or
 * persist for replay-on-reconnect).
 */
export interface InboundDispatcher {
  sendToAgent(agentName: string, msg: InboundMessageWire): boolean;
}

export interface InboundDispatchOptions {
  /**
   * Required: the chat the synthesized turn belongs to. The Phase 2
   * in-agent scheduler resolves this from the agent's primary topic
   * mapping; tests pass it directly.
   */
  chatId: string;
  /** Optional Telegram topic / thread id when the chat has topics. */
  threadId?: number;
  /**
   * Synthetic timestamp source. Defaulted to `Date.now()`; tests inject
   * a fixed clock to make `messageId` and `ts` deterministic.
   */
  now?: () => number;
}

export interface InboundDispatchResult {
  /** False when no agent client was registered for `entry.agent`. */
  delivered: boolean;
  /** The exact wire message handed to the dispatcher. */
  message: InboundMessageWire;
}

/**
 * Build an `InboundMessage` from a `SchedulerEntry` and hand it to the
 * dispatcher. Pure synthesis — no clock, network, or filesystem unless
 * the dispatcher does it. Phase 1 ships this primitive; Phase 2 wires
 * it from the in-agent scheduler sibling.
 *
 * `meta.source = "cron"` is the only stable discriminator the bridge
 * uses to render the turn as `<channel source="cron">`. `schedule_index`
 * and `prompt_key` are carried for audit correlation against the
 * scheduler.jsonl ledger Phase 2 introduces — both as strings, since
 * `meta` is `Record<string, string>` on the wire.
 */
export function dispatchAsInbound(
  entry: SchedulerEntry,
  options: InboundDispatchOptions,
  dispatcher: InboundDispatcher,
): InboundDispatchResult {
  const ts = (options.now ?? Date.now)();
  const message: InboundMessageWire = {
    type: "inbound",
    chatId: options.chatId,
    ...(options.threadId !== undefined ? { threadId: options.threadId } : {}),
    // Synthetic id — cron fires don't have a Telegram message_id. The
    // bridge only uses messageId for telegram_reply context, which is
    // a no-op for cron-synthesized turns.
    messageId: ts,
    user: "cron",
    userId: 0,
    ts,
    text: entry.prompt,
    meta: {
      source: "cron",
      schedule_index: String(entry.scheduleIndex),
      prompt_key: entry.promptKey,
    },
  };
  const delivered = dispatcher.sendToAgent(entry.agent, message);
  return { delivered, message };
}
