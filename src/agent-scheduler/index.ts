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
import { overlayReadFailures, type OverlayReadFailure } from "../config/overlay-loader.js";
import {
  collectScheduleEntries,
  dispatchAsInbound,
  type DispatchResult,
  type InboundDispatcher,
  type InboundMessageWire,
  type SchedulerEntry,
} from "../scheduler/dispatch.js";
import { isCheapCronEnabled, resolveCronRouting, resolveEscalationRouting } from "../scheduler/cron-routing.js";
import { applyDefaultTier } from "../scheduler/tier-selector.js";
import type { PollOutcome } from "../scheduler/poll-engine.js";
import type { ActionOutcome } from "../scheduler/action-engine.js";
import type { PollStateStore } from "../scheduler/poll-state.js";
import type { ActionSpec, PollSpec } from "../config/schema.js";
import { buildCheapCronHooks } from "./cheap-cron-wiring.js";
// AgentChannelTarget, resolveChannelTarget, and resolveEntryThreadId
// live in ./channel-target.js (a node-cron-free leaf) so the gateway's
// webhook-ingest path can import them without pulling node-cron into
// its bundle. Imported + re-exported here for backward compatibility.
import {
  type AgentChannelTarget,
  resolveChannelTarget,
  resolveEntryThreadId,
} from "./channel-target.js";
export { type AgentChannelTarget, resolveChannelTarget, resolveEntryThreadId };
import { JsonlAuditSink, type AuditSink } from "../scheduler/audit.js";
import {
  decideQuotaPreflight,
  type QuotaPreflightDecision,
} from "../scheduler/quota-preflight.js";
import { AuthBrokerClient } from "../auth/broker/client.js";
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
  /**
   * Optional quota preflight. When it resolves `defer:true` (the fleet is
   * fully quota-walled), the fire is HELD and bounded-retried instead of
   * dispatched into a wall (where it would 429 and the run would be silently
   * lost). Absent = legacy behavior (always dispatch). Injectable for tests;
   * the caller fails open (broker unreachable → dispatch). See
   * ../scheduler/quota-preflight.ts.
   */
  quotaGate?: (agent: string) => Promise<QuotaPreflightDecision>;
  /** Max dispatch attempts (initial + retries) before giving up to the next
   *  natural occurrence. Default 3. */
  maxQuotaDeferAttempts?: number;
  /** Backoff before the next retry, by zero-based attempt index. Default
   *  1m / 3m / 5m. */
  quotaDeferBackoffMs?: (attempt: number) => number;
  /** Retry timer seam (tests inject a synchronous driver). Default setTimeout;
   *  returns a canceller cleared on task stop. */
  scheduleRetry?: (fn: () => void, ms: number) => { cancel: () => void };
  /**
   * Cheap-cron hooks (reference/rfcs/cheap-cron-sessions.md). Absent or
   * `enabled:false` ⟹ today's behaviour exactly (resolveCronRouting returns
   * the main session, no poll runs). Wired in main() with the real broker
   * secret-resolver + file poll-state; tests inject fakes.
   */
  cheapCron?: CheapCronHooks;
}

export interface CheapCronHooks {
  enabled: boolean;
  pollState: PollStateStore;
  /** Run a declarative poll (model-free) and return whether to escalate. */
  runPoll: (spec: PollSpec, prevCursor: string | undefined) => Promise<PollOutcome>;
  /**
   * Run a declarative ACTION (model-free, terminal — no escalation). Posts to
   * the agent's OWN chat (`ctx.threadId` resolves the entry's topic) or fires a
   * webhook. Optional: present once the action transport (send_outbound IPC) is
   * wired; absent ⟹ a `kind: action` fire records a graceful "transport
   * unavailable" no-op rather than crashing or falling through to a model fire.
   */
  runAction?: (spec: ActionSpec, ctx: { threadId?: number }) => Promise<ActionOutcome>;
}

/** Replace {{diff}} in an escalation prompt with the poll's diff summary.
 *  Only called for poll entries (which carry a prompt); the `?? ""` keeps the
 *  type total now that SchedulerEntry.prompt is optional (kind=action). */
function templateEscalationPrompt(prompt: string | undefined, diff: string): string {
  return (prompt ?? "").replace(/\{\{\s*diff\s*\}\}/g, diff);
}

/**
 * Boot recovery for the lost-hit window (reviewer note, PR #2244): a crash
 * AFTER a poll's write-ahead cursor advance but BEFORE its escalation was
 * delivered leaves a dangling `pendingEscalation` in poll-state. On boot,
 * re-dispatch each one exactly once and clear it. Without this the cursor is
 * advanced but the hit was never sent → the lead is silently dropped. Runs
 * before the live cron loop registers. Pure-ish: side effects are the
 * dispatcher write + pollState.clearPending + log.
 */
export function recoverPendingEscalations(opts: {
  entries: SchedulerEntry[];
  pollState: PollStateStore;
  dispatcher: InboundDispatcher;
  channel: AgentChannelTarget;
  cheapCronEnabled: boolean;
  now: () => number;
  log: (m: string) => void;
  /** Optional audit sink so a boot-recovered hit shows in `schedule report`. */
  sink?: { recordFire: (r: DispatchResult) => void };
}): number {
  let recovered = 0;
  for (const entry of opts.entries) {
    if (entry.kind !== "poll" || !entry.poll) continue;
    const st = opts.pollState.get(entry.poll.state_key);
    if (!st?.pendingEscalation) continue;
    const esc = resolveEscalationRouting(entry, { cheapCronEnabled: opts.cheapCronEnabled });
    const threadId = resolveEntryThreadId(entry, opts.channel);
    const startedAt = opts.now();
    try {
      const r = dispatchAsInbound(
        { ...entry, prompt: templateEscalationPrompt(entry.prompt, st.pendingEscalation) },
        { chatId: opts.channel.chatId, threadId, now: opts.now, session: esc.session ?? "main", model: esc.cronModel },
        opts.dispatcher,
      );
      if (r.delivered) {
        opts.pollState.clearPending(entry.poll.state_key);
        recovered += 1;
        opts.log(`recovered pending escalation for poll '${entry.poll.state_key}'`);
      } else {
        opts.log(`pending escalation for '${entry.poll.state_key}' not delivered — will retry next boot`);
      }
      opts.sink?.recordFire({
        agent: entry.agent,
        scheduleIndex: entry.scheduleIndex,
        promptKey: entry.promptKey,
        exitCode: r.delivered ? 0 : -1,
        outputSummary: r.delivered ? "recovered pending escalation (boot)" : "pending escalation not delivered (boot)",
        startedAt,
        finishedAt: opts.now(),
        tier: esc.tier === "cheap" ? "cheap" : "main",
        ...(esc.cronModel ? { modelUsed: esc.cronModel } : {}),
        ...(entry.name ? { scheduleName: entry.name } : {}),
      });
    } catch (e) {
      opts.log(`pending-escalation recovery failed for '${entry.poll.state_key}': ${(e as Error).message}`);
    }
  }
  return recovered;
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
// Default retry policy for quota-deferred fires.
const DEFAULT_MAX_QUOTA_DEFER_ATTEMPTS = 3;
function defaultQuotaDeferBackoffMs(attempt: number): number {
  return [60_000, 180_000, 300_000][attempt] ?? 300_000;
}

/**
 * Delay before a deferred fire's retry. A throttle soft-defer (429 throttle
 * tier) carries `retryAtMs` — the throttled account's clear time — so the
 * retry is aimed just past it (2s slack, bounded to 5s..10m) instead of the
 * blind backoff ladder; every other defer keeps the default 1/3/5m backoff.
 * Exported for tests.
 */
export function resolveQuotaDeferDelayMs(
  decision: QuotaPreflightDecision,
  fallbackMs: number,
  nowMs: number,
): number {
  if (decision.retryAtMs === undefined) return fallbackMs;
  const target = decision.retryAtMs - nowMs + 2_000;
  return Math.min(Math.max(target, 5_000), 10 * 60_000);
}

export function registerAgentSchedule(opts: RegisterOptions): RegisteredTask[] {
  const tasks: RegisteredTask[] = [];
  const now = opts.now ?? Date.now;
  const maxAttempts = opts.maxQuotaDeferAttempts ?? DEFAULT_MAX_QUOTA_DEFER_ATTEMPTS;
  const backoff = opts.quotaDeferBackoffMs ?? defaultQuotaDeferBackoffMs;
  const scheduleRetry =
    opts.scheduleRetry ??
    ((fn, ms) => {
      const t = setTimeout(fn, ms);
      if (typeof t.unref === "function") t.unref();
      return { cancel: () => clearTimeout(t) };
    });

  for (const entry of opts.entries) {
    // Pending retry timers for this entry — cancelled on stop so a deferred
    // fire never dispatches after shutdown.
    const pendingRetries = new Set<{ cancel: () => void }>();

    // One dispatch attempt. `attempt` is zero-based. Returns nothing; records
    // the outcome to the audit sink (always — deferred fires are recorded too,
    // closing the silent-loss hole) and may schedule a bounded retry.
    //
    // Cadence note: for a cron whose interval is SHORTER than the retry backoff
    // (default 1/3/5m, i.e. sub-5-min crons), a pending retry chain may still be
    // live when the next natural occurrence fires, so two chains can briefly
    // overlap and — on recovery — both dispatch (mild over-delivery). This is
    // never silent loss (every attempt is audited distinctly) and is bounded by
    // the cron cadence (no worse than the pre-gate baseline's per-minute futile
    // fires); at-least-once is the scheduler's documented contract (replay.ts).
    // Typical crons (hourly/daily briefings) never hit this.
    const attemptFire = async (attempt: number): Promise<void> => {
      const startedAt = now();

      // Quota preflight — only when a gate is wired. Fail OPEN: a broker
      // hiccup must never block a scheduled fire.
      if (opts.quotaGate) {
        let decision: QuotaPreflightDecision;
        try {
          decision = await opts.quotaGate(entry.agent);
        } catch {
          decision = { defer: false, reason: "quota gate error (fail-open)" };
        }
        if (decision.defer) {
          const more = attempt + 1 < maxAttempts;
          const summary =
            `deferred (quota): ${decision.reason} ` +
            `[attempt ${attempt + 1}/${maxAttempts}]` +
            (more ? "" : " — giving up; will re-run on next scheduled occurrence");
          // exit_code -2 = deferred (fleet fully quota-walled). Distinct from
          // 0 (delivered) / -1 (gateway not connected) so the truth is in the
          // audit, not a silent "success".
          opts.sink.recordFire({
            agent: entry.agent,
            scheduleIndex: entry.scheduleIndex,
            promptKey: entry.promptKey,
            exitCode: -2,
            outputSummary: summary,
            startedAt,
            finishedAt: now(),
            ...(entry.name ? { scheduleName: entry.name } : {}),
          });
          if (more) {
            let handle: { cancel: () => void };
            handle = scheduleRetry(() => {
              pendingRetries.delete(handle);
              void attemptFire(attempt + 1);
            }, resolveQuotaDeferDelayMs(decision, backoff(attempt), now()));
            pendingRetries.add(handle);
          }
          return;
        }
      }

      const cheapEnabled = opts.cheapCron?.enabled ?? false;
      // Value-gate: fill the cheap-by-default tier for a hint-less entry
      // (frequent → cheap Tier-1 session) before routing. Explicit
      // kind/model/context are untouched. Only when cheap-cron is on.
      const routed = cheapEnabled ? applyDefaultTier(entry) : entry;
      const routing = resolveCronRouting(routed, { cheapCronEnabled: cheapEnabled });
      const threadId = resolveEntryThreadId(entry, opts.channel);
      const record = (fields: {
        exitCode: number;
        summary: string;
        tier: "poll" | "action" | "cheap" | "main";
        modelUsed?: string;
      }) =>
        opts.sink.recordFire({
          agent: entry.agent,
          scheduleIndex: entry.scheduleIndex,
          promptKey: entry.promptKey,
          exitCode: fields.exitCode,
          outputSummary: fields.summary.slice(0, 200),
          startedAt,
          finishedAt: now(),
          tier: fields.tier,
          ...(fields.modelUsed ? { modelUsed: fields.modelUsed } : {}),
          ...(entry.name ? { scheduleName: entry.name } : {}),
        });

      // ── Tier 0: deterministic poll, no model ──────────────────────────
      if (routing.tier === "poll" && opts.cheapCron && entry.poll) {
        const stateKey = entry.poll.state_key;
        const prev = opts.cheapCron.pollState.get(stateKey)?.value;
        let outcome: PollOutcome;
        try {
          outcome = await opts.cheapCron.runPoll(entry.poll, prev);
        } catch (err) {
          outcome = { hit: false, baseline: false, error: (err as Error).message };
        }
        if (outcome.error) {
          // exit -3 = poll error: no escalation; re-polls on next tick (idempotent).
          record({ exitCode: -3, summary: `poll error: ${outcome.error}`, tier: "poll" });
          return;
        }
        if (outcome.baseline) {
          opts.cheapCron.pollState.setBaseline(stateKey, outcome.cursor!);
          record({ exitCode: 0, summary: "poll baseline recorded — first run, no escalate", tier: "poll" });
          return;
        }
        if (!outcome.hit) {
          record({ exitCode: 0, summary: "HEARTBEAT_OK — no change (model-free)", tier: "poll" });
          return;
        }
        // HIT → write-ahead the cursor BEFORE dispatch (double-escalation guard),
        // then escalate the entry's prompt as a model fire (Tier 1/2).
        opts.cheapCron.pollState.writeAhead(stateKey, outcome.cursor!, startedAt, outcome.diff ?? "");
        const esc = resolveEscalationRouting(entry, { cheapCronEnabled: cheapEnabled });
        let delivered = false;
        try {
          const r = dispatchAsInbound(
            { ...entry, prompt: templateEscalationPrompt(entry.prompt, outcome.diff ?? "") },
            { chatId: opts.channel.chatId, threadId, now, session: esc.session ?? "main", model: esc.cronModel },
            opts.dispatcher,
          );
          delivered = r.delivered;
        } catch (err) {
          record({ exitCode: -1, summary: `escalation dispatch error: ${(err as Error).message}`, tier: esc.tier === "cheap" ? "cheap" : "main", modelUsed: esc.cronModel });
          return;
        }
        if (delivered) opts.cheapCron.pollState.clearPending(stateKey);
        record({
          exitCode: delivered ? 0 : -1,
          summary: delivered ? `poll hit → escalated (${outcome.diff})` : "poll hit → escalation not delivered",
          tier: esc.tier === "cheap" ? "cheap" : "main",
          modelUsed: esc.cronModel,
        });
        return;
      }

      // ── Tier 0: deterministic ACTION, no model, terminal ──────────────
      // Routing returns tier:"action" FLAG-INDEPENDENTLY (an action is
      // model-free regardless of SWITCHROOM_CHEAP_CRON). It COMPLETES the work
      // and never escalates — no dispatchAsInbound, no session wake.
      if (routing.tier === "action") {
        if (!opts.cheapCron?.runAction || !entry.action) {
          // Transport not wired yet (PR2/PR3) or malformed entry: graceful
          // no-op so a misconfigured action never crashes the tick or falls
          // through to a (prompt-less) model fire. Audited, not silent.
          record({
            exitCode: -4,
            summary: !entry.action
              ? "action skipped — no action spec on entry"
              : "action skipped — action transport unavailable",
            tier: "action",
          });
          return;
        }
        let outcome: ActionOutcome;
        try {
          outcome = await opts.cheapCron.runAction(entry.action, { threadId });
        } catch (err) {
          outcome = { ok: false, summary: "", error: (err as Error).message };
        }
        // exit -4 = action error: no escalation; re-runs next tick (we accept a
        // possibly-missed fire over a double-fire — actions are not replayed).
        record({
          exitCode: outcome.ok ? 0 : -4,
          summary: outcome.ok ? `action ok: ${outcome.summary}` : `action error: ${outcome.error}`,
          tier: "action",
        });
        return;
      }

      // ── Tier 1/2: a model fire into the cron or main session ──────────
      let delivered = false;
      let summary = "";
      try {
        const result = dispatchAsInbound(
          entry,
          { chatId: opts.channel.chatId, threadId, now, session: routing.session ?? "main", model: routing.cronModel },
          opts.dispatcher,
        );
        delivered = result.delivered;
        summary = delivered
          ? "delivered to bridge via gateway"
          : "no agent client connected — fire dropped";
      } catch (err) {
        summary = `dispatch error: ${(err as Error).message}`.slice(0, 200);
      }
      // exit_code semantics for the IPC path:
      //   0 — bytes accepted by the local gateway socket (best signal)
      //  -1 — gateway not connected, or wire write failed
      //  -2 — deferred: fleet fully quota-walled (recorded above)
      //  -3 — Tier-0 poll error (recorded above)
      //  -4 — Tier-0 action error / skipped (recorded above)
      record({
        exitCode: delivered ? 0 : -1,
        summary,
        tier: routing.tier === "cheap" ? "cheap" : "main",
        modelUsed: routing.cronModel,
      });
    };

    const task = opts.cronLib.schedule(entry.cron, () => attemptFire(0));
    tasks.push({
      entry,
      task: {
        stop: () => {
          for (const h of pendingRetries) h.cancel();
          pendingRetries.clear();
          task.stop();
        },
      },
    });
  }
  return tasks;
}

/**
 * Stable change-detection signature for an agent's schedule entries.
 *
 * The agent-scheduler loads the schedule (switchroom.yaml + the
 * `schedule.d/*.yaml` overlay) ONCE at boot. Agents self-author cron
 * entries via their agent-config tools, and operators edit the overlay
 * — but without a reload those edits don't take effect until the
 * container restarts, so a *removed* entry keeps firing (a zombie
 * schedule that burns a wasted turn every interval) and a *new* entry
 * never runs. This signature lets the reload watcher cheaply detect
 * "did the effective schedule change?" by value, independent of file
 * mtimes (which are unreliable over Docker bind mounts).
 */
export function scheduleSignature(entries: SchedulerEntry[]): string {
  // JSON of the full entry array, in collectScheduleEntries' deterministic
  // order. Captures cron, prompt, promptKey, scheduleIndex AND the
  // cheap-cron routing fields (kind/poll/model/session) — any of which
  // changes scheduling behaviour.
  return JSON.stringify(entries);
}

export interface ScheduleReloader {
  /** One poll: reload entries, and if the signature changed, stop the
   *  current tasks and re-register. Never throws — a transient config
   *  parse error (e.g. an overlay caught mid-write) keeps the current
   *  schedule and is reported via onError. */
  tick(): void;
  /** The currently-live tasks (post-reload) — shutdown must stop THESE,
   *  not the boot set, or a reloaded-away task leaks. */
  currentTasks(): RegisteredTask[];
}

/**
 * In-process schedule hot-reload (no container restart).
 *
 * Pure orchestration — fs / node-cron live behind the injected
 * `loadEntries` and `register` callbacks, so this is unit-testable with
 * fakes. The container's tmux/agent session is untouched; only the cron
 * task set is swapped. Replay is a boot-only concern and is deliberately
 * NOT re-run here (a reload is not a restart — it must not resurrect
 * missed fires).
 */
export function createScheduleReloader(opts: {
  loadEntries: () => SchedulerEntry[];
  register: (entries: SchedulerEntry[]) => RegisteredTask[];
  initialTasks: RegisteredTask[];
  initialEntries: SchedulerEntry[];
  log: (msg: string) => void;
  onError?: (err: Error) => void;
}): ScheduleReloader {
  let tasks = opts.initialTasks;
  let sig = scheduleSignature(opts.initialEntries);
  return {
    tick(): void {
      let next: SchedulerEntry[];
      try {
        next = opts.loadEntries();
      } catch (err) {
        opts.onError?.(err as Error);
        return; // keep the current schedule on a transient load error
      }
      const nextSig = scheduleSignature(next);
      if (nextSig === sig) return;
      const before = tasks.length;
      for (const t of tasks) t.task.stop();
      tasks = opts.register(next);
      sig = nextSig;
      opts.log(`schedule reloaded: ${before} → ${tasks.length} task(s)`);
    },
    currentTasks(): RegisteredTask[] {
      return tasks;
    },
  };
}

/** Human-readable remedy appended to unreadable-overlay diagnostics. */
function formatReadFailures(failures: OverlayReadFailure[]): string {
  return (
    failures.map((f) => `${f.file} (${f.code})`).join(", ") +
    " — fix ownership/mode so the agent uid can read the file " +
    "(a root-euid writer leaves cron overlays root-owned 0600; " +
    "`switchroom apply` / a reconcile ownership sweep heals this)"
  );
}

/**
 * Load THIS agent's schedule entries, refusing (throwing) when any of its
 * `schedule.d/*.yaml` overlay files exists but cannot be READ.
 *
 * Why strict: the overlay loader isolates per-file failures, so an
 * EACCES'd cron file yields a config that simply LACKS that file's
 * entries. For the boot path that is the best we can do (warn loudly —
 * see main()), but for the hot-reload path it is poison: the reloader
 * would diff the shrunken schedule against the live one and silently
 * UNREGISTER a healthy cron ("schedule reloaded: 11 → 10"), losing every
 * fire until the ownership is fixed (observed on clerk: 2,298 EACCES
 * ticks over weeks, entries dropped the whole time). Throwing routes
 * into createScheduleReloader's onError path, which keeps the current
 * schedule — the same fail-safe already used for a config parse error.
 *
 * Content failures (malformed YAML, schema rejection) do NOT throw:
 * those files were read fine and their entries are legitimately excluded.
 *
 * Scope is `schedule.d` ONLY (#4373): the strict loader is agent-wide over
 * the config object, but an unreadable `skills.d` overlay is unrelated to
 * the schedule and must not freeze cron reloads. `skills.d` read failures
 * still warn (the loader's per-file `console.warn`); they just don't throw
 * here. Filtering on `source: "schedule"` keeps the freeze targeted at the
 * only class that can silently unregister a live cron.
 */
export function loadAgentEntriesStrict(
  configPath: string,
  agentName: string,
): SchedulerEntry[] {
  const config = loadConfig(configPath);
  const failures = overlayReadFailures(config, agentName, "schedule");
  if (failures.length > 0) {
    throw new Error(
      `schedule.d overlay unreadable — refusing a reload that may be ` +
        `missing entries: ${formatReadFailures(failures)}`,
    );
  }
  return collectScheduleEntries(config).filter((e) => e.agent === agentName);
}

/** Reload poll cadence (ms). Overlay edits are rare and detection within
 *  ~30s is plenty; the poll is a yaml re-parse + a few overlay file reads,
 *  negligible CPU. Floored at 1s. */
export function resolveReloadPollMs(env: NodeJS.ProcessEnv): number {
  const raw = Number.parseInt(env.SWITCHROOM_SCHEDULER_RELOAD_POLL_MS ?? "", 10);
  return Number.isFinite(raw) && raw >= 1000 ? raw : 30_000;
}

/** Hot-reload is on by default; `SWITCHROOM_SCHEDULER_HOT_RELOAD=0` restores
 *  the pre-reload behaviour (schedule frozen at boot). */
export function isHotReloadEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.SWITCHROOM_SCHEDULER_HOT_RELOAD !== "0";
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

  // Unreadable overlay files at BOOT: we cannot register entries we
  // cannot read, so boot proceeds with what loaded — but say so loudly
  // and actionably instead of the loader's per-file console.warn only.
  // (The hot-reload path below is strict: it refuses to swap the live
  // schedule against a load that is missing unreadable files.)
  // Scoped to schedule.d (#4373): this warning is specifically about
  // unregistered cron entries — an unreadable skills.d overlay is a
  // different concern and still surfaces via the loader's console.warn.
  const bootReadFailures = overlayReadFailures(config, agentName, "schedule");
  if (bootReadFailures.length > 0) {
    process.stderr.write(
      `agent-scheduler: ${agentName} WARNING: ${bootReadFailures.length} ` +
        `schedule.d overlay file(s) unreadable at boot — their cron entries ` +
        `are NOT registered: ${formatReadFailures(bootReadFailures)}\n`,
    );
  }

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
    //
    // Hot-reload (cold 0→N): an agent that self-authors its FIRST cron
    // (or an operator adding one to a previously schedule-less agent)
    // shouldn't have to wait for a manual bounce. A lightweight watcher
    // detects entries appearing and exits(0) so the supervisor reboots
    // straight into the active path above — which sets up the sink / IPC
    // / replay that a 0-entry boot deliberately skipped. The exit is
    // clean and the sidecar typically ran ≫60s, so the supervisor's
    // backoff counter resets (no penalty). Guarded against flapping: we
    // only exit when entries are genuinely non-empty.
    let idleTimer: ReturnType<typeof setInterval>;
    if (isHotReloadEnabled(process.env)) {
      idleTimer = setInterval(() => {
        let appeared: SchedulerEntry[];
        try {
          appeared = collectScheduleEntries(loadConfig(configPath)).filter(
            (e) => e.agent === agentName,
          );
        } catch {
          return; // overlay caught mid-write — re-check next tick
        }
        if (appeared.length > 0) {
          process.stdout.write(
            `agent-scheduler: ${agentName} schedule appeared (${appeared.length} ` +
            `entr${appeared.length === 1 ? "y" : "ies"}) — restarting to activate\n`,
          );
          clearInterval(idleTimer);
          releaseLock(lockPath);
          process.exit(0); // supervisor respawns into the active scheduling path
        }
      }, resolveReloadPollMs(process.env));
    } else {
      idleTimer = setInterval(() => { /* idle */ }, 1 << 30);
    }
    // Release the lock cleanly on SIGTERM/SIGINT so a subsequent
    // boot doesn't have to fall back to the stale-lock reclaim path
    // in acquireLock. Only matters for log cleanliness — the reclaim
    // path works either way (#895 boot-time freshness check).
    const cleanup = (): never => {
      clearInterval(idleTimer);
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
        const cheapEnabledForReplay = isCheapCronEnabled(process.env);
        for (const m of missed) {
          const startedAt = Date.now();
          // A `kind: action` entry must NOT replay as a raw prompt (it has no
          // prompt) and must NOT double-fire a side effect (a re-sent message /
          // re-fired webhook). We accept a possibly-MISSED action over a
          // double — the next natural tick runs it. Flag-independent (actions
          // are model-free regardless of cheap-cron). Skip + audit.
          if (m.entry.kind === "action") {
            sink.recordFire({
              agent: m.entry.agent,
              scheduleIndex: m.entry.scheduleIndex,
              promptKey: m.entry.promptKey,
              exitCode: 0,
              outputSummary: "action replay skipped — runs on next tick (never double-fired)",
              startedAt,
              finishedAt: Date.now(),
              tier: "action",
              ...(m.entry.name ? { scheduleName: m.entry.name } : {}),
            });
            continue;
          }
          // Cheap-cron: a `kind: poll` entry must NOT replay as a raw prompt —
          // that would fire its escalation text (with a literal {{diff}}) as a
          // model turn, bypassing the poll. A poll is stateful (durable cursor),
          // so a missed fire is harmlessly caught by the next natural tick's
          // poll (which compares against the advanced cursor). Skip + audit.
          if (cheapEnabledForReplay && m.entry.kind === "poll") {
            sink.recordFire({
              agent: m.entry.agent,
              scheduleIndex: m.entry.scheduleIndex,
              promptKey: m.entry.promptKey,
              exitCode: 0,
              outputSummary: "poll replay skipped — re-polls on next tick (stateful cursor)",
              startedAt,
              finishedAt: Date.now(),
              tier: "poll",
              ...(m.entry.name ? { scheduleName: m.entry.name } : {}),
            });
            continue;
          }
          const threadId = resolveEntryThreadId(m.entry, channel);
          // #2793 part B: stamp the minute-aligned fire this replay is for so
          // the gateway routes it through the durable inbound spool (accept vs
          // consume ledgered separately) and `spoolId` derives a stable dedup
          // key. Closes the boot-replay silent-loss window (accepted but never
          // consumed → the spool re-delivers on the next gateway boot) and the
          // double-fire window (re-replay collapses on the stable id).
          const result = dispatchAsInbound(
            m.entry,
            { chatId: channel.chatId, threadId, replayFireMs: m.expectedFireMs },
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
            ...(m.entry.name ? { scheduleName: m.entry.name } : {}),
          });
        }
      }
      if (staleSkipped.length > 0) {
        process.stdout.write(
          `agent-scheduler: ${staleSkipped.length} scheduled run(s) ` +
          `skipped (older than ${windowMinutes}min window) — notifying user\n`,
        );
        const lines = staleSkipped.map((s) => {
          const label = s.entry.prompt ?? `action: ${s.entry.action?.type ?? "?"}`;
          const oneLine = label.replace(/\s+/g, " ").trim().slice(0, 80);
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
              ...(s.entry.name ? { scheduleName: s.entry.name } : {}),
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

  // Cron quota preflight — don't throw a scheduled fire at a fully
  // quota-walled fleet (it would 429 and the run would be silently lost);
  // hold + bounded-retry until an account frees. Disable with
  // SWITCHROOM_DISABLE_CRON_QUOTA_PREFLIGHT=1. Fails open: any broker error
  // makes the gate return defer:false (handled in attemptFire), so a broker
  // hiccup never blocks crons.
  const quotaPreflightEnabled =
    process.env.SWITCHROOM_DISABLE_CRON_QUOTA_PREFLIGHT !== "1";
  const quotaGate = quotaPreflightEnabled
    ? async (agent: string): Promise<QuotaPreflightDecision> => {
        const client = new AuthBrokerClient();
        try {
          // `agent` scopes the 429-throttle soft-defer to the agent's own
          // EFFECTIVE account (its override, else the fleet active).
          return decideQuotaPreflight(await client.listState(), { agent });
        } finally {
          await client.close().catch(() => {});
        }
      }
    : undefined;

  // Cheap-cron live wiring (reference/rfcs/cheap-cron-sessions.md). Returns
  // undefined when SWITCHROOM_CHEAP_CRON is off → registerAgentSchedule sees
  // no hook → today's behaviour exactly.
  //
  // postOutbound: the MODEL-FREE send_outbound seam for Tier-0 telegram-message
  // actions (#2307), bound here over the IPC client + the agent's OWN channel
  // target. The gateway re-fences chatId to the agent's allowlist; the action
  // spec carries no chat target, so an action can only post to this chat.
  const postOutbound = (args: { threadId?: number; text: string; parseMode: "html" | "text" }): boolean =>
    ipcClient.sendOutbound({
      type: "send_outbound",
      agentName,
      chatId: channel.chatId,
      ...(args.threadId != null ? { threadId: args.threadId } : {}),
      text: args.text,
      parseMode: args.parseMode,
    });
  const cheapCron = buildCheapCronHooks(config, process.env, { agentName, postOutbound });
  if (cheapCron) {
    // Recover any escalation that advanced its cursor but crashed before
    // delivery (the lost-hit window), before the live loop starts.
    const recovered = recoverPendingEscalations({
      entries,
      pollState: cheapCron.pollState,
      dispatcher,
      channel,
      cheapCronEnabled: true,
      now: Date.now,
      log: (m) => process.stderr.write(`agent-scheduler: ${m}\n`),
      sink,
    });
    process.stdout.write(
      `agent-scheduler: ${agentName} cheap-cron ENABLED` +
      (recovered > 0 ? ` (recovered ${recovered} pending escalation(s))` : "") + "\n",
    );
  }

  const registerForEntries = (es: SchedulerEntry[]): RegisteredTask[] =>
    registerAgentSchedule({
      entries: es,
      channel,
      sink,
      cronLib,
      dispatcher,
      ...(quotaGate ? { quotaGate } : {}),
      ...(cheapCron ? { cheapCron } : {}),
    });

  const tasks = registerForEntries(entries);

  process.stdout.write(
    `agent-scheduler: ${agentName} registered ${tasks.length} task(s); ` +
    `chat=${channel.chatId} thread=${channel.threadId ?? "(none)"} ` +
    `socket=${socketPath} jsonl=${jsonlPath}\n`,
  );

  // Hot-reload: pick up schedule.d / switchroom.yaml edits WITHOUT a
  // container restart (an agent self-authoring crons, or an operator
  // editing the overlay). Before this, the schedule was frozen at boot,
  // so a removed entry kept firing (a zombie that burned a wasted turn
  // every interval) and a new entry never ran until the next bounce.
  // In-process task swap — the tmux/agent session is untouched.
  let reloader: ScheduleReloader | undefined;
  let reloadTimer: ReturnType<typeof setInterval> | undefined;
  if (isHotReloadEnabled(process.env)) {
    // Dedupe the per-tick error line: a persistently-unreadable overlay
    // would otherwise emit an identical line every poll (~30s) — the
    // 2,298-line log flood that buried the original clerk incident.
    // A reload that actually lands resets the memo so a recurrence of
    // the same error is reported again.
    let lastReloadError: string | undefined;
    reloader = createScheduleReloader({
      // Strict on purpose: an unreadable schedule.d file throws, landing
      // in onError (keep current schedule) instead of silently
      // unregistering the file's crons. See loadAgentEntriesStrict.
      loadEntries: () => loadAgentEntriesStrict(configPath, agentName),
      register: registerForEntries,
      initialTasks: tasks,
      initialEntries: entries,
      log: (m) => {
        lastReloadError = undefined;
        process.stdout.write(`agent-scheduler: ${agentName} ${m}\n`);
      },
      onError: (e) => {
        if (e.message === lastReloadError) return;
        lastReloadError = e.message;
        process.stderr.write(
          `agent-scheduler: ${agentName} reload skipped (config error, keeping current schedule): ${e.message}\n`,
        );
      },
    });
    reloadTimer = setInterval(() => reloader!.tick(), resolveReloadPollMs(process.env));
  }

  const shutdown = () => {
    if (reloadTimer) clearInterval(reloadTimer);
    // Stop the CURRENTLY-live tasks (post-reload), not the boot set.
    for (const t of (reloader ? reloader.currentTasks() : tasks)) t.task.stop();
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
