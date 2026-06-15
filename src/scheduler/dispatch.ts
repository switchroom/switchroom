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
import type { ActionSpec, PollSpec, ScheduleEntry, SwitchroomConfig } from "../config/schema.js";
import { resolveAgentConfig } from "../config/merge.js";
import { OVERLAY_TITLE } from "../config/overlay-loader.js";

export interface SchedulerEntry {
  agent: string;
  scheduleIndex: number;
  cron: string;
  /**
   * Human-readable title for this cron, surfaced in the dashboard's
   * Schedule tab as the per-cron block header. Sourced from an overlay
   * file's top-of-file `# name:` comment (or a meaningful filename) via
   * the `OVERLAY_TITLE` symbol the overlay loader stamps. Absent for
   * base-config crons and for hash-only overlay filenames (no
   * meaningful title) — the UI falls back to the cron expression.
   */
  name?: string;
  /** The model-fire text (prompt/poll). Absent for kind=action — an action
   *  never fires a model, so it has no prompt. */
  prompt?: string;
  /** SHA-256 prefix of the prompt (or, for an action, its spec) — stable,
   *  non-reversible audit key. */
  promptKey: string;
  /**
   * Cheap-cron routing fields (docs/rfcs/cheap-cron-sessions.md). Consumed
   * by the in-agent scheduler via resolveCronRouting() at fire time. Active by
   * default; SWITCHROOM_CHEAP_CRON=0/false/off is the kill-switch. `kind: poll`
   * runs a model-free deterministic poll (requires `poll`) that only escalates
   * on a hit.
   */
  kind?: "poll" | "prompt" | "action";
  model?: string;
  context?: "fresh" | "agent";
  poll?: PollSpec;
  /** Required iff kind=action. The declarative model-free action spec. */
  action?: ActionSpec;
  /**
   * Per-entry Telegram topic override (PR4b of supergroup-mode rollout).
   * Either a string alias defined in the agent's
   * `channels.telegram.topic_aliases` (e.g. "planning"), or a numeric
   * thread_id. Consumed by the in-agent scheduler's dispatch path via
   * `resolveOutboundTopic({ kind: 'cron', entryTopic })`. Undefined for
   * fleet-mode / DM agents and for supergroup-mode entries that want
   * the default_topic_id.
   */
  topic?: string | number;
}

/**
 * Walk the cascade-resolved config and produce a flat list of (agent,
 * index) schedule entries that the cron loop registers. Pure function:
 * no IO.
 *
 * Cascade resolution is load-bearing — `schedule` is a `concatenate`
 * cascade key (defaults.schedule + profile.schedule + agent.schedule).
 * Walking raw `config.agents[name].schedule` (as the pre-fix code did)
 * silently dropped entries declared in defaults or in a profile's
 * extends-chain, leaving the in-agent scheduler with "no schedule
 * entries" — which then triggered the start.sh supervisor's
 * restart-cap and silently killed cron for the affected agent.
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
    const raw = config.agents[agent];
    if (!raw) continue;
    const resolved = resolveAgentConfig(config.defaults, config.profiles, raw);
    const schedule: ScheduleEntry[] = resolved.schedule ?? [];
    for (let i = 0; i < schedule.length; i++) {
      const entry = schedule[i]!;
      // An action has no prompt; key the audit off its spec instead so the
      // promptKey stays a stable, non-reversible correlation id.
      const auditMaterial = entry.prompt ?? `action:${JSON.stringify(entry.action ?? {})}`;
      // Human title: stamped by the overlay loader on the raw entry via the
      // non-enumerable OVERLAY_TITLE symbol (survives the cascade-merge
      // spread, same as OVERLAY_SOURCE). Absent for base-config crons and
      // hash-only overlay filenames.
      const title = (entry as Record<symbol, unknown>)[OVERLAY_TITLE];
      out.push({
        agent,
        scheduleIndex: i,
        cron: entry.cron,
        ...(typeof title === "string" && title.length > 0 ? { name: title } : {}),
        ...(entry.prompt !== undefined ? { prompt: entry.prompt } : {}),
        promptKey: createHash("sha256").update(auditMaterial).digest("hex").slice(0, 12),
        // Propagate the per-entry topic override (PR1 schema field).
        // Resolved at dispatch time via resolveOutboundTopic().
        ...(entry.topic !== undefined ? { topic: entry.topic } : {}),
        // Cheap-cron routing fields — active by default (SWITCHROOM_CHEAP_CRON=0 disables).
        ...(entry.kind !== undefined ? { kind: entry.kind } : {}),
        ...(entry.model !== undefined ? { model: entry.model } : {}),
        ...(entry.context !== undefined ? { context: entry.context } : {}),
        ...(entry.poll !== undefined ? { poll: entry.poll } : {}),
        ...(entry.action !== undefined ? { action: entry.action } : {}),
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
  /**
   * Cheap-cron observability (docs/rfcs/cheap-cron-sessions.md §5). Which
   * tier this fire took and the model it ran at, so `switchroom schedule
   * report` can show the cost breakdown. Absent on legacy audit rows and
   * when SWITCHROOM_CHEAP_CRON is off (treated as 'main').
   */
  tier?: "poll" | "action" | "cheap" | "main";
  modelUsed?: string;
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
  /**
   * Cheap-cron routing (docs/rfcs/cheap-cron-sessions.md §3.3). Which
   * gateway session this fire injects into — 'cron' for a Tier-1 cheap
   * session, 'main' (or unset) for the live session. Emitted as
   * `meta.session`; the gateway defaults absent → 'main' (back-compat).
   */
  session?: "cron" | "main";
  /** Tier-1 cron-session model; emitted as `meta.model` for the cron bridge. */
  model?: string;
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
    // dispatchAsInbound is only called for prompt/poll entries (which carry a
    // prompt); an action never reaches here. Fallback keeps the type total.
    text: entry.prompt ?? "",
    meta: {
      source: "cron",
      schedule_index: String(entry.scheduleIndex),
      prompt_key: entry.promptKey,
      // Cheap-cron session routing — emitted only when targeting the cron
      // session, so existing fires stay byte-identical (gateway defaults
      // absent → 'main'). meta is Record<string,string> on the wire.
      ...(options.session === "cron" ? { session: "cron" } : {}),
      ...(options.session === "cron" && options.model ? { model: options.model } : {}),
    },
  };
  const delivered = dispatcher.sendToAgent(entry.agent, message);
  return { delivered, message };
}
