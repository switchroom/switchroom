/**
 * In-agent scheduler sibling — Phase 2 of the cron-fold-in.
 *
 * Runs as a process inside each agent container, supervised by
 * start.sh's `_switchroom_supervise` wrapper, gated behind
 * `SWITCHROOM_INLINE_SCHEDULER=1`. Reads the agent's own schedule
 * entries from the bind-mounted switchroom.yaml, registers each
 * with node-cron, and on fire sends an `inject_inbound` envelope
 * to the local gateway (which forwards it to the bridge as a
 * synthesized turn tagged `meta.source="cron"`).
 *
 * Why a separate entry from `src/scheduler/index.ts`:
 *   - The host-side singleton scheduler dispatches via `docker
 *     exec switchroom-<name> claude -p`. It needs the docker.sock
 *     and lives outside any agent.
 *   - The in-agent sibling dispatches via the gateway's IPC. It
 *     has no docker.sock, no docker CLI, and only ever fires for
 *     ONE agent (its own).
 *   Two dispatch transports → two separate entry points. Phase 4
 *   deletes the host-side bundle entirely.
 *
 * Audit: writes one JSONL row per fire to `/state/agent/scheduler.jsonl`
 * (under the agent's own bind mount, never shared across agents).
 * The shape mirrors `DispatchResult` from `src/scheduler/dispatch.ts`
 * so Phase 3's audit-parity check can compare per-agent JSONL rows
 * against the singleton's SQLite rows column-for-column.
 */

import { resolve, join } from "node:path";
import { loadConfig } from "../config/loader.js";
import { resolveAgentConfig } from "../config/merge.js";
import { resolveOutboundTopic } from "../telegram/topic-router.js";
import {
  collectScheduleEntries,
  dispatchAsInbound,
  type InboundDispatcher,
  type InboundMessageWire,
  type SchedulerEntry,
} from "../scheduler/dispatch.js";
import { JsonlAuditSink, type AuditSink } from "../scheduler/audit.js";
import {
  createInjectIpcClient,
  type InjectIpcClient,
} from "./ipc-client.js";
import { acquireLock, releaseLock } from "./lock.js";
import {
  findMissedFires,
  findStaleSkippedFires,
  readRecentFires,
  STALE_LOOKBACK_MAX_MIN,
} from "./replay.js";

/**
 * Minimum node-cron-shaped surface — same as the host scheduler. The
 * package is installed inside the agent image (Phase 2 Dockerfile
 * change) and resolved at runtime; tests inject their own.
 */
export interface CronLib {
  schedule(
    expr: string,
    handler: () => void | Promise<void>,
  ): { stop(): void };
}

/**
 * The fields the in-agent scheduler knows about its target chat at
 * registration time. The forum_chat_id is global (one per fleet);
 * threadId is the agent's own topic in that forum (fleet mode) or
 * the supergroup-owned default fallback.
 *
 * `routerConfig` (PR4b-cron of supergroup-mode rollout): when the
 * agent is in supergroup-owned mode, each per-entry `topic` field
 * resolves through `resolveOutboundTopic({ kind: 'cron', entryTopic })`.
 * Unset / undefined for fleet-mode and DM agents — behavior unchanged.
 */
export interface AgentChannelTarget {
  chatId: string;
  threadId?: number;
  routerConfig?: { default_topic_id?: number; topic_aliases?: Record<string, number> };
}

export interface RegisterOptions {
  /** Already-filtered to a single agent's entries. */
  entries: SchedulerEntry[];
  channel: AgentChannelTarget;
  sink: AuditSink;
  cronLib: CronLib;
  /** Sends one inject_inbound per fire. */
  dispatcher: InboundDispatcher;
  /** Replaceable for tests. */
  now?: () => number;
}

export interface RegisteredTask {
  entry: SchedulerEntry;
  task: { stop: () => void };
}

/**
 * Register every entry with node-cron. Returns the live tasks so the
 * caller can stop them on shutdown. Pure-ish: side effects are limited
 * to `dispatcher.sendToAgent` (the IPC write) and `sink.recordFire`
 * (the JSONL append).
 */
export function registerAgentSchedule(opts: RegisterOptions): RegisteredTask[] {
  const tasks: RegisteredTask[] = [];
  const now = opts.now ?? Date.now;
  for (const entry of opts.entries) {
    const task = opts.cronLib.schedule(entry.cron, () => {
      const startedAt = now();
      let delivered = false;
      let summary = "";
      try {
        const threadId = resolveEntryThreadId(entry, opts.channel);
        const result = dispatchAsInbound(
          entry,
          { chatId: opts.channel.chatId, threadId, now },
          opts.dispatcher,
        );
        delivered = result.delivered;
        summary = delivered
          ? "delivered to bridge via gateway"
          : "no agent client connected — fire dropped";
      } catch (err) {
        summary = `dispatch error: ${(err as Error).message}`.slice(0, 200);
      }
      const finishedAt = now();
      // Mirror the shape host-side dispatch.ts:DispatchResult emits so
      // Phase 3 audit parity is a field-for-field equality check.
      // exit_code semantics for the IPC path:
      //   0 — bytes accepted by the local gateway socket (best signal)
      //  -1 — gateway not connected, or wire write failed
      opts.sink.recordFire({
        agent: entry.agent,
        scheduleIndex: entry.scheduleIndex,
        promptKey: entry.promptKey,
        exitCode: delivered ? 0 : -1,
        outputSummary: summary,
        startedAt,
        finishedAt,
      });
    });
    tasks.push({ entry, task });
  }
  return tasks;
}

/**
 * Build an `InboundDispatcher` backed by a local IPC client that
 * writes `inject_inbound` envelopes to the gateway. Tests pass a
 * capturing dispatcher directly to `registerAgentSchedule` and skip
 * this adapter.
 */
export function ipcDispatcher(client: InjectIpcClient): InboundDispatcher {
  return {
    sendToAgent(agentName: string, inbound: InboundMessageWire): boolean {
      // The wire envelope wraps the InboundMessage so the gateway's
      // validateClientMessage validates it as a client→gateway
      // message rather than impersonating a gateway→client one.
      return client.sendInjectInbound({
        type: "inject_inbound",
        agentName,
        // dispatchAsInbound builds an InboundMessageWire, which is a
        // structural mirror of telegram-plugin's InboundMessage —
        // the cast is a no-op at runtime.
        inbound: inbound as unknown as Parameters<
          InjectIpcClient["sendInjectInbound"]
        >[0]["inbound"],
      });
    },
  };
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
 * integration row in this module's tests.
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

export async function main(): Promise<void> {
  const agentName = process.env.SWITCHROOM_AGENT_NAME;
  if (!agentName) {
    process.stderr.write(
      "agent-scheduler: SWITCHROOM_AGENT_NAME is required\n",
    );
    process.exit(64); // EX_USAGE
  }

  const configPath = process.env.SWITCHROOM_CONFIG ?? "/state/config/switchroom.yaml";
  const stateDir = process.env.TELEGRAM_STATE_DIR ?? "/state/agent/telegram";
  const socketPath = process.env.SWITCHROOM_GATEWAY_SOCKET
    ?? join(stateDir, "gateway.sock");
  const jsonlPath = process.env.SWITCHROOM_AGENT_SCHEDULER_JSONL
    ?? "/state/agent/scheduler.jsonl";
  const lockPath = process.env.SWITCHROOM_AGENT_SCHEDULER_LOCK
    ?? "/state/agent/scheduler.lock";

  // Phase 3 belt-and-braces dedup: refuse to start if another
  // agent-scheduler is already running. start.sh's
  // `_switchroom_supervise` only respawns after the previous instance
  // exits, so this catches operator-launched second instances and
  // mis-configured supervisors. Stale-lock detection lives in
  // acquireLock — see the doc-comment there.
  const lock = acquireLock(lockPath);
  if (!lock.acquired) {
    process.stderr.write(
      `agent-scheduler: ${agentName} lock at ${lockPath} held by pid ` +
      `${lock.holderPid ?? "unknown"} — exiting\n`,
    );
    process.exit(75); // EX_TEMPFAIL — the supervisor's restart cap handles repeated failures
  }

  const config = loadConfig(configPath);
  const allEntries = collectScheduleEntries(config);
  const entries = allEntries.filter((e) => e.agent === agentName);

  const channel = resolveChannelTarget(config, agentName);
  if (channel === null) {
    process.stderr.write(
      `agent-scheduler: ${agentName} has no resolvable chat target ` +
      `(missing telegram.forum_chat_id) — exiting\n`,
    );
    process.exit(78); // EX_CONFIG
  }

  if (entries.length === 0) {
    process.stdout.write(
      `agent-scheduler: ${agentName} has no schedule entries — idling ` +
      `(re-checks on container restart)\n`,
    );
    // Stay alive so start.sh's _switchroom_supervise restart-cap
    // doesn't burn through 10 restarts and give up. An agent that
    // legitimately has no cron is a perfectly normal state — most
    // agents in a typical fleet don't have schedule blocks. The
    // previous `process.exit(0)` produced 10 lines of noise per
    // schedule-less agent in the supervisor log every container
    // restart, then permanently wedged the supervisor for that
    // agent. setInterval is enough to peg the event loop; container
    // restart re-runs main() and re-reads config, so a future
    // `apply` that adds schedule entries gets picked up cleanly.
    setInterval(() => { /* idle */ }, 1 << 30);
    // Release the lock cleanly on SIGTERM/SIGINT so a subsequent
    // boot doesn't have to fall back to the stale-lock reclaim path
    // in acquireLock. Only matters for log cleanliness — the reclaim
    // path works either way (#895 boot-time freshness check).
    const cleanup = (): never => {
      releaseLock(lockPath);
      process.exit(0);
    };
    process.once("SIGTERM", cleanup);
    process.once("SIGINT", cleanup);
    return;
  }

  const sink: AuditSink = new JsonlAuditSink(resolve(jsonlPath));
  const ipcClient = createInjectIpcClient({
    socketPath,
    log: (m) => process.stderr.write(`agent-scheduler: ${m}\n`),
  });
  const dispatcher = ipcDispatcher(ipcClient);

  // At-least-once replay: if the container restarted across a
  // scheduled fire, replay it now before the live cron loop starts.
  // Bounded by SWITCHROOM_AGENT_SCHEDULER_REPLAY_MIN minutes (default
  // 30) — long enough to cover routine restarts (image pull, OOM
  // bounce, host reboot) without resurrecting yesterday's morning
  // briefing if an agent was down for a day.
  //
  // We wait briefly for the gateway socket to come up before
  // dispatching replays — otherwise the replay would be audited as
  // "no agent client connected" and findMissedFires would re-fire it
  // again on the next boot.
  const replayWindowMin = Number.parseInt(
    process.env.SWITCHROOM_AGENT_SCHEDULER_REPLAY_MIN ?? "30",
    10,
  );
  const windowMinutes = Number.isFinite(replayWindowMin) ? replayWindowMin : 30;
  const staleMaxRaw = Number.parseInt(
    process.env.SWITCHROOM_AGENT_SCHEDULER_STALE_MAX_MIN
      ?? String(STALE_LOOKBACK_MAX_MIN),
    10,
  );
  const staleMaxMin = Number.isFinite(staleMaxRaw)
    ? staleMaxRaw
    : STALE_LOOKBACK_MAX_MIN;
  const recentFires = readRecentFires(resolve(jsonlPath));
  const replayNow = new Date();
  const missed = findMissedFires({
    entries,
    recentFires,
    now: replayNow,
    windowMinutes,
  });
  // Genuinely-dropped runs: matched the cron but are older than the
  // replay window, so they will NOT be re-run. The survive-reboots
  // JTBD requires these be "explicitly skipped, not silently dropped"
  // — emit one summary turn (not one per entry). A per-entry
  // exitCode=0 sentinel row, written only once the notice is
  // delivered, dedups subsequent boots.
  const staleSkipped = findStaleSkippedFires({
    entries,
    recentFires,
    now: replayNow,
    windowMinutes,
    maxLookbackMinutes: staleMaxMin,
  });
  if (missed.length > 0 || staleSkipped.length > 0) {
    const connected = await ipcClient.waitForConnect(5_000);
    if (connected) {
      if (missed.length > 0) {
        process.stdout.write(
          `agent-scheduler: replaying ${missed.length} missed fire(s) ` +
          `from past ${windowMinutes}min — ` +
          missed
            .map((m) => `[idx=${m.entry.scheduleIndex} key=${m.entry.promptKey}]`)
            .join(" ") + "\n",
        );
        for (const m of missed) {
          const startedAt = Date.now();
          const threadId = resolveEntryThreadId(m.entry, channel);
          const result = dispatchAsInbound(
            m.entry,
            { chatId: channel.chatId, threadId },
            dispatcher,
          );
          sink.recordFire({
            agent: m.entry.agent,
            scheduleIndex: m.entry.scheduleIndex,
            promptKey: m.entry.promptKey,
            exitCode: result.delivered ? 0 : -1,
            outputSummary: result.delivered
              ? `replayed (originally scheduled at ${new Date(m.expectedFireMs).toISOString()})`
              : "replay attempted but gateway not connected",
            startedAt,
            finishedAt: Date.now(),
          });
        }
      }
      if (staleSkipped.length > 0) {
        process.stdout.write(
          `agent-scheduler: ${staleSkipped.length} scheduled run(s) ` +
          `skipped (older than ${windowMinutes}min window) — notifying user\n`,
        );
        const lines = staleSkipped.map((s) => {
          const oneLine = s.entry.prompt.replace(/\s+/g, " ").trim().slice(0, 80);
          return `- "${oneLine}" — cron \`${s.entry.cron}\`, ` +
            `most recent missed run ~${new Date(s.expectedFireMs).toISOString()}`;
        });
        const noticeText =
          "[switchroom scheduler notice] While this agent was offline, the " +
          "following scheduled task(s) had at least one run skipped. They were " +
          `older than the ${windowMinutes}-minute catch-up window, so they ` +
          "will NOT be re-run:\n" +
          lines.join("\n") +
          "\n\nBriefly and plainly tell the user these scheduled runs did not " +
          "happen so they are not left in the dark. Do not perform the tasks " +
          "now unless the user asks.";
        const noticeEntry: SchedulerEntry = {
          agent: agentName,
          scheduleIndex: -1,
          cron: "",
          prompt: noticeText,
          promptKey: "skip-notice",
        };
        const startedAt = Date.now();
        const threadId = resolveEntryThreadId(noticeEntry, channel);
        const result = dispatchAsInbound(
          noticeEntry,
          { chatId: channel.chatId, threadId },
          dispatcher,
        );
        sink.recordFire({
          agent: agentName,
          scheduleIndex: -1,
          promptKey: "skip-notice",
          exitCode: result.delivered ? 0 : -1,
          outputSummary: result.delivered
            ? `skip-notice sent for ${staleSkipped.length} dropped run(s)`
            : "skip-notice attempted but gateway not connected",
          startedAt,
          finishedAt: Date.now(),
        });
        // Stamp the per-entry "acknowledged" sentinel ONLY if the
        // notice reached the gateway. On failed delivery, leave the
        // entries uncovered so the next boot retries the notice rather
        // than swallowing it.
        if (result.delivered) {
          for (const s of staleSkipped) {
            sink.recordFire({
              agent: s.entry.agent,
              scheduleIndex: s.entry.scheduleIndex,
              promptKey: s.entry.promptKey,
              exitCode: 0,
              outputSummary:
                `skip-notice: run at ${new Date(s.expectedFireMs).toISOString()} ` +
                `was older than the ${windowMinutes}min replay window and was ` +
                "not executed",
              startedAt: s.expectedFireMs,
              finishedAt: s.expectedFireMs,
            });
          }
        }
      }
    } else {
      process.stderr.write(
        `agent-scheduler: ${missed.length} missed + ${staleSkipped.length} ` +
        "stale-skipped fire(s) detected but gateway socket not up after 5s — " +
        "skipping this boot\n",
      );
    }
  }

  // Lazy-resolve node-cron at runtime — it's installed inside the
  // agent image (docker/Dockerfile.agent) and not pulled in as a
  // top-level switchroom dep so the host-side install footprint is
  // unchanged.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cronLib = require("node-cron") as CronLib;

  const tasks = registerAgentSchedule({
    entries,
    channel,
    sink,
    cronLib,
    dispatcher,
  });

  process.stdout.write(
    `agent-scheduler: ${agentName} registered ${tasks.length} task(s); ` +
    `chat=${channel.chatId} thread=${channel.threadId ?? "(none)"} ` +
    `socket=${socketPath} jsonl=${jsonlPath}\n`,
  );

  const shutdown = () => {
    for (const t of tasks) t.task.stop();
    sink.close();
    ipcClient.close();
    releaseLock(lockPath);
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

// Entry guard — only run main() when invoked as the agent-scheduler
// bundle. Same shape as src/scheduler/index.ts so vitest imports of
// helpers (registerAgentSchedule, ipcDispatcher, resolveChannelTarget)
// don't accidentally trigger main().
if (
  import.meta.url === `file://${process.argv[1]}` &&
  /(?:^|[/\\])agent-scheduler[/\\]index\.(?:js|ts)$/.test(process.argv[1] ?? "")
) {
  main().catch((err) => {
    process.stderr.write(
      `agent-scheduler fatal: ${err instanceof Error ? err.stack : err}\n`,
    );
    process.exit(1);
  });
}
