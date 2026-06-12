/**
 * Gateway-side webhook record handler (RFC docs/rfcs/webhook-via-gateway-socket.md).
 *
 * Under the Docker runtime the host-side web receiver runs as the operator
 * UID and cannot write a per-agent-UID-owned agent dir (EACCES → HTTP 500)
 * nor connect the gateway socket. The receiver therefore verifies + renders
 * the event and forwards it over a peercred-gated UDS to the agent's
 * in-container gateway, which runs as the agent UID. This module is the
 * gateway-side handler the forwarded record lands in: it owns ALL agent-dir
 * state — dedup, the `webhook-events.jsonl` append, and `webhook_dispatch`
 * firing — so the receiver stays stateless.
 *
 * It deliberately reuses the existing dedup store (`createFileDedupStore`)
 * and dispatch evaluator (`evaluateDispatch`) so behaviour is identical to
 * the legacy host-runtime path; only the *writer identity* moves.
 *
 * Dispatch delivery is in-process: the gateway already holds the bridge IPC
 * server, so instead of `injectWebhookInbound` opening a fresh socket to
 * `gateway.sock`, the caller passes an `inject(agentName, inbound)` callback
 * that funnels through the gateway's own `sendToAgent` + buffer-on-failure
 * path (the same primitive cron's `inject_inbound` uses).
 */

import { appendFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import {
  createFileDedupStore,
  type DedupStore,
} from './webhook-handler.js'
import {
  evaluateDispatch,
  DISPATCH_SOURCES,
  type CooldownStore,
  type WebhookDispatchConfig,
} from './webhook-dispatch.js'
import type { InboundMessageWire } from '../scheduler/dispatch.js'
import { loadConfig as loadSwitchroomConfig } from '../config/loader.js'
import { resolveAgentConfig } from '../config/merge.js'
import { resolveChannelTarget } from '../agent-scheduler/channel-target.js'

/**
 * One forwarded webhook event. Mirrors the record the legacy receiver
 * wrote inline, plus the github delivery id for dedup (the receiver no
 * longer dedups — the gateway is the sole owner of dedup state).
 */
export interface WebhookGatewayRecord {
  agent: string
  source: string
  event_type: string
  ts: number
  rendered_text: string
  payload: Record<string, unknown>
  /** X-GitHub-Delivery, github source only. Absent for generic. */
  delivery_id?: string
}

export type RecordStatus = 'ok' | 'deduped' | 'error'

export interface RecordResult {
  status: RecordStatus
  /** Recorded (or original, on dedup) timestamp. */
  ts?: number
  /** Operator-facing reason when status === 'error'. No secrets. */
  error?: string
  /** Number of dispatch rules that fired (0 when none / not github). */
  dispatched?: number
}

export interface RecordDeps {
  /** Override the agent-dir resolver (tests). */
  resolveAgentDir?: (agent: string) => string
  /**
   * In-process delivery of a synthesized webhook turn to the agent's
   * bridge. Returns true when the bridge accepted it. Required in
   * production (the gateway passes its `sendToAgent` wrapper); tests
   * pass a spy.
   */
  inject?: (agentName: string, inbound: InboundMessageWire) => boolean
  /** Clock override (tests). */
  now?: () => number
  /** Log sink — stderr in production. */
  log?: (line: string) => void
  /** Injectable dedup store (tests). Falls back to file-backed. */
  dedupStore?: DedupStore
  /** Injectable cooldown store (tests). Forwarded to evaluateDispatch. */
  cooldownStore?: CooldownStore
  /**
   * Override config load (tests). Production reads switchroom.yaml via
   * the same loader the gateway uses, resolved per-event so config edits
   * land without a gateway restart (webhook events are infrequent).
   */
  loadConfig?: () => ReturnType<typeof loadSwitchroomConfig>
}

/**
 * Persist a forwarded webhook event and fire matching dispatch rules.
 * Runs inside the gateway (agent UID), so the agent-dir writes succeed.
 *
 * Flow mirrors the legacy receiver tail (dedup → append → dispatch) with
 * the writer identity moved in-container. Returns a structured result the
 * gateway's socket server serializes back to the receiver, which maps it
 * to an HTTP status.
 */
export function recordWebhookEvent(
  rec: WebhookGatewayRecord,
  deps: RecordDeps = {},
): RecordResult {
  const log = deps.log ?? ((s) => process.stderr.write(s))
  const now = rec.ts || (deps.now ?? Date.now)()
  const resolveAgentDir =
    deps.resolveAgentDir ?? ((a) => join(homedir(), '.switchroom', 'agents', a))
  const dedupStore = deps.dedupStore ?? createFileDedupStore(resolveAgentDir)

  const agent = rec.agent
  const telegramDir = join(resolveAgentDir(agent), 'telegram')

  // ── Dedup (github only — generic has no delivery id) ──────────────────────
  if (rec.source === 'github' && rec.delivery_id) {
    const originalTs = dedupStore.check(agent, rec.delivery_id, now)
    if (originalTs !== undefined) {
      log(
        `webhook-gateway: agent='${agent}' source='${rec.source}' deduped delivery='${rec.delivery_id}'\n`,
      )
      return { status: 'deduped', ts: originalTs }
    }
  }

  // ── Append the verified event to the agent's webhook log ──────────────────
  // This is the write that EACCES'd when attempted as the host operator
  // UID; here it runs as the agent UID and succeeds.
  const logPath = join(telegramDir, 'webhook-events.jsonl')
  try {
    mkdirSync(telegramDir, { recursive: true })
    const record = {
      ts: now,
      source: rec.source,
      event_type: rec.event_type,
      rendered_text: rec.rendered_text,
      payload: rec.payload,
    }
    appendFileSync(logPath, JSON.stringify(record) + '\n', { mode: 0o600 })
  } catch (err) {
    log(
      `webhook-gateway: agent='${agent}' source='${rec.source}' write failed: ${(err as Error).message}\n`,
    )
    return { status: 'error', error: 'write failed' }
  }

  log(
    `webhook-gateway: agent='${agent}' source='${rec.source}' event='${rec.event_type}' recorded ts=${now}\n`,
  )

  // ── Fire webhook_dispatch rules (github / generic / linear) ───────────────
  // This wires the previously-unreachable evaluateDispatch: the legacy
  // receiver passed dispatchConfig through but never consumed it (#1625
  // shipped the evaluator with no production caller). The gateway holds
  // the bridge IPC server, so delivery is in-process via deps.inject.
  // #2272 extends dispatch beyond github to generic + linear sources.
  let dispatched = 0
  try {
    const config = (deps.loadConfig ?? loadSwitchroomConfig)()
    const rawAgent = config.agents?.[agent]
    const dispatchConfig: WebhookDispatchConfig | undefined = rawAgent
      ? resolveAgentConfig(config.defaults, config.profiles, rawAgent).channels?.telegram
          ?.webhook_dispatch
      : undefined

    if (dispatchConfig && (DISPATCH_SOURCES as readonly string[]).includes(rec.source)) {
      const target = resolveChannelTarget(config, agent)
      if (!target) {
        log(
          `webhook-gateway: agent='${agent}' dispatch skipped — no chat target (forum_chat_id / chat_id unset)\n`,
        )
      } else {
        const injectFn = deps.inject
        dispatched = evaluateDispatch(
          {
            agent,
            source: rec.source,
            eventType: rec.event_type,
            payload: rec.payload,
            dispatchConfig,
            chatId: target.chatId,
            ...(target.threadId !== undefined ? { threadId: target.threadId } : {}),
          },
          {
            now: () => now,
            resolveAgentDir,
            log,
            ...(deps.cooldownStore ? { cooldownStore: deps.cooldownStore } : {}),
            // In-process delivery: ignore the socketPath evaluateDispatch
            // would dial and hand the inbound straight to the gateway's
            // bridge sender. Absent inject (misconfiguration) → no-op false.
            ...(injectFn
              ? {
                  injectFn: async (
                    _socketPath: string,
                    agentName: string,
                    inbound: InboundMessageWire,
                  ) => injectFn(agentName, inbound),
                }
              : {}),
          },
        )
      }
    }
  } catch (err) {
    // Dispatch failure must not fail the ingest — the event is already
    // durably recorded; the agent can still read it. Log and move on.
    log(
      `webhook-gateway: agent='${agent}' dispatch error (event recorded): ${(err as Error).message}\n`,
    )
  }

  return { status: 'ok', ts: now, dispatched }
}
