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
import { findMissedFires, readRecentFires } from "./replay.js";

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
 * threadId is the agent's own topic in that forum.
 */
export interface AgentChannelTarget {
  chatId: string;
  threadId?: number;
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
        const result = dispatchAsInbound(
          entry,
          { chatId: opts.channel.chatId, threadId: opts.channel.threadId, now },
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
  const forumChatId = config.telegram?.forum_chat_id;
  if (typeof forumChatId !== "string" || forumChatId.length === 0) return null;
  const agent = config.agents?.[agentName];
  const threadId = agent?.topic_id;
  return {
    chatId: forumChatId,
    ...(typeof threadId === "number" ? { threadId } : {}),
  };
}

/**
 * Park the process indefinitely without exiting. Used by main() when the
 * config is unusable (missing forum chat or zero resolved entries) — see
 * #907 root cause: exiting in those cases burns the start.sh supervisor's
 * restart budget and the scheduler silently disappears. Wakes on SIGTERM
 * so container shutdown still proceeds cleanly.
 */
async function idle(): Promise<void> {
  await new Promise<void>((resolve) => {
    const onSignal = () => resolve();
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  });
  process.exit(0);
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

  // Startup self-check (#907 regression visibility): always log the
  // registered timer set up-front. Before this, a silent "0 entries
  // resolved" looked identical to "scheduler running fine but no fires
  // are due" — the May 8 cutover regression went unnoticed for two days
  // for exactly this reason. Now the log line names every entry's cron
  // expression so an operator can grep `agent-scheduler.log` and see
  // immediately whether the cascade resolved their schedule at all.
  const summary = entries.length === 0
    ? "(none)"
    : entries
        .map((e) => `[idx=${e.scheduleIndex} cron="${e.cron}" key=${e.promptKey}]`)
        .join(" ");
  process.stdout.write(
    `agent-scheduler: ${agentName} startup self-check — ` +
    `${entries.length} entry(ies) resolved from ${configPath}: ${summary}\n`,
  );

  const channel = resolveChannelTarget(config, agentName);
  if (channel === null) {
    process.stderr.write(
      `agent-scheduler: ${agentName} has no resolvable chat target ` +
      `(missing telegram.forum_chat_id) — sleeping (no exit, avoid supervisor restart-burn)\n`,
    );
    // Idle-sleep instead of exit. Exiting non-zero would burn the
    // start.sh supervisor's 10-restart-in-60s budget and the scheduler
    // would silently disappear — exactly the #907 failure mode. An
    // idle process is observable (`ps` shows it) and recovers on the
    // next container restart after the operator fixes the config.
    await idle();
    return;
  }

  if (entries.length === 0) {
    process.stdout.write(
      `agent-scheduler: ${agentName} has no schedule entries — sleeping ` +
      `(no exit, avoid supervisor restart-burn)\n`,
    );
    await idle();
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
  const recentFires = readRecentFires(resolve(jsonlPath));
  const missed = findMissedFires({
    entries,
    recentFires,
    now: new Date(),
    windowMinutes: Number.isFinite(replayWindowMin) ? replayWindowMin : 30,
  });
  if (missed.length > 0) {
    const connected = await ipcClient.waitForConnect(5_000);
    if (connected) {
      process.stdout.write(
        `agent-scheduler: replaying ${missed.length} missed fire(s) ` +
        `from past ${replayWindowMin}min — ` +
        missed
          .map((m) => `[idx=${m.entry.scheduleIndex} key=${m.entry.promptKey}]`)
          .join(" ") + "\n",
      );
      for (const m of missed) {
        const startedAt = Date.now();
        const result = dispatchAsInbound(
          m.entry,
          { chatId: channel.chatId, threadId: channel.threadId },
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
    } else {
      process.stderr.write(
        `agent-scheduler: ${missed.length} missed fire(s) detected but ` +
        `gateway socket not up after 5s — skipping replay this boot\n`,
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
