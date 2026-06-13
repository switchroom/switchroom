/**
 * Webhook dispatch (#715). After an event is verified and recorded by
 * `webhook-handler.ts`, this module evaluates per-rule matchers and, for
 * each match, delivers a synthesized turn to the agent so it can react
 * to the event via Telegram.
 *
 * Design principles:
 *   - **Static matcher** (no CEL/expression parser). Fields: `event`,
 *     `actions`, `labels_any`, `labels_all`, `exclude_authors`. All
 *     optional except `event`; absent fields are treated as wildcards.
 *   - **Template rendering**: simple `{{field}}` interpolation against
 *     a flat helper bag derived from the GitHub payload.
 *   - **Cooldown**: same `(repo, number)` re-trigger within window
 *     coalesces. State stored per-agent on disk.
 *   - **Quiet hours**: skip dispatch entirely when the wall clock is
 *     inside the configured window (events still in JSONL).
 *   - **Delivery (since #1620)**: a match synthesizes an
 *     `InboundMessage` tagged `meta.source="webhook"` and delivers it
 *     via `inject_inbound` to the agent's gateway socket — the same
 *     path cron uses. The webhook turn runs inside the agent's live
 *     interactive `claude` session. No `claude -p`: a headless
 *     `claude -p` is *programmatic* usage under Anthropic's 2026-06-15
 *     policy (off the subscription) and would spawn a parasitic second
 *     telegram bridge (#1617). See `docs/rfcs/eliminate-claude-p.md`.
 *
 * Sources (#2272): dispatch is no longer github-only. Rules live under
 * a per-source key — `github`, `generic`, or `linear`. Each source
 * gets its own context builder (`buildGithubContext` /
 * `buildLinearContext` / `buildGenericContext`) so the same static
 * matcher (event/action/label/author/assignee/mention) and the same
 * knobs (cooldown, quiet_hours; rate limit + dedup live in the ingest
 * handler) apply uniformly. The security model is unchanged: rendered
 * payloads are data, never instructions.
 *
 * Configuration (in switchroom.yaml under agents.<name>.channels.telegram):
 *
 * ```yaml
 * webhook_dispatch:
 *   github:
 *     - description: "Auto-review labelled PRs"
 *       match:
 *         event: pull_request
 *         actions: [opened, synchronize, ready_for_review]
 *         labels_any: [needs-review]
 *         exclude_authors: [dependabot[bot], coolify[bot]]
 *       prompt: |
 *         PR review please — {{repo}} #{{number}}: {{title}}
 *         {{html_url}}
 *       cooldown: 5m
 *       quiet_hours: { start: 22, end: 8, tz: Australia/Melbourne }
 *   linear:
 *     - description: "Act on issues assigned to me"
 *       match:
 *         event: issue
 *         actions: [create, update]
 *         assignee_any: [clerk]
 *       prompt: |
 *         Linear {{number}} assigned to you: {{title}}
 *         {{html_url}}
 *       cooldown: 2m
 * ```
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { createInjectIpcClient, type InjectIpcClient } from '../agent-scheduler/ipc-client.js'
import type { InboundMessageWire } from '../scheduler/dispatch.js'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DispatchMatcher {
  /** GitHub event name (e.g. "pull_request", "push"). Required. */
  event: string
  /** Allowed action values. If absent, all actions match. */
  actions?: string[]
  /** At least one of these labels must be present on the PR/issue. */
  labels_any?: string[]
  /** All of these labels must be present on the PR/issue. */
  labels_all?: string[]
  /** If the author login matches any of these, skip dispatch. */
  exclude_authors?: string[]
  /** (linear/generic) Match only when the event's assignee is one of
   *  these names. If absent, assignee is not constrained. */
  assignee_any?: string[]
  /** (linear/generic) Match only when the event text mentions one of
   *  these handles (substring, case-insensitive). Useful for
   *  "@mention the agent" routing. */
  mentions_any?: string[]
}

export interface QuietHours {
  /** Hour (0-23) when quiet period starts (inclusive). */
  start: number
  /** Hour (0-23) when quiet period ends (exclusive). */
  end: number
  /** IANA timezone string (e.g. "Australia/Melbourne"). Defaults to UTC. */
  tz?: string
}

export interface DispatchRule {
  description?: string
  match: DispatchMatcher
  /** Handlebars-style `{{field}}` template for the synthesized turn's prompt. */
  prompt: string
  /** Cooldown duration string: "5m", "1h", "30s". Defaults to "0" (no cooldown). */
  cooldown?: string
  quiet_hours?: QuietHours
}

export interface WebhookDispatchConfig {
  github?: DispatchRule[]
  generic?: DispatchRule[]
  linear?: DispatchRule[]
}

/** Webhook sources that support dispatch rule evaluation (#2272). */
export const DISPATCH_SOURCES = ['github', 'generic', 'linear'] as const
export type DispatchSource = (typeof DISPATCH_SOURCES)[number]

/** Flat helper bag for template interpolation. */
export interface TemplateContext {
  repo: string
  number: string
  title: string
  html_url: string
  author: string
  labels: string
  action: string
  event: string
  /** (linear/generic) Assignee display name, when the event carries one. */
  assignee: string
  /** (linear/generic) Free text searched by `mentions_any` — for linear
   *  this is the issue title + comment body. */
  body: string
  [key: string]: string
}

// ─── Template rendering ──────────────────────────────────────────────────────

/**
 * Render a `{{field}}` template against a context object.
 * Missing fields are replaced with an empty string.
 * No HTML escaping — the prompt goes to the CLI model, not a browser.
 */
export function renderTemplate(template: string, ctx: TemplateContext): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => ctx[key] ?? '')
}

/**
 * Build the flat TemplateContext from a GitHub payload + event type.
 * Handles pull_request, issues, push, and generic fallback shapes.
 */
export function buildGithubContext(
  eventType: string,
  payload: Record<string, unknown>,
): TemplateContext {
  const repo =
    (payload.repository as Record<string, unknown> | undefined)?.full_name as string ?? ''

  // Prefer pull_request sub-object, then issue sub-object
  const pr = payload.pull_request as Record<string, unknown> | undefined
  const issue = payload.issue as Record<string, unknown> | undefined
  const obj = pr ?? issue

  const number = String(payload.number ?? obj?.number ?? '')
  const firstCommit = (payload.commits as Array<Record<string, unknown>> | undefined)?.[0]
  const title = String(obj?.title ?? firstCommit?.message ?? '')
  const html_url = String(obj?.html_url ?? payload.html_url ?? '')
  const author = String(
    (obj?.user as Record<string, unknown> | undefined)?.login ??
    (payload.sender as Record<string, unknown> | undefined)?.login ??
    '',
  )
  const rawLabels = (obj?.labels as Array<Record<string, unknown>> | undefined) ?? []
  const labels = rawLabels.map((l) => String(l.name ?? '')).join(', ')
  const action = String(payload.action ?? '')
  const assignee = String(
    (obj?.assignee as Record<string, unknown> | undefined)?.login ?? '',
  )

  return {
    repo,
    number,
    title,
    html_url,
    author,
    labels,
    action,
    event: eventType,
    assignee,
    body: title,
  }
}

/**
 * Build the flat TemplateContext from a Linear webhook envelope (#2272).
 * `eventType` is the lower-cased Linear `type` ("issue", "comment").
 *
 * Linear envelope shape: `{ action, type, url, data: {...} }`.
 *   - issue:   data.{identifier,title,assignee,labels}
 *   - comment: data.{body, issue:{identifier,title}}
 */
export function buildLinearContext(
  eventType: string,
  payload: Record<string, unknown>,
): TemplateContext {
  const data = (payload.data as Record<string, unknown> | undefined) ?? {}
  const issue = (data.issue as Record<string, unknown> | undefined) ?? {}

  const number = String(data.identifier ?? issue.identifier ?? '')
  const title = String(data.title ?? issue.title ?? '')
  const html_url = String(payload.url ?? '')
  const action = String(payload.action ?? '')
  const assignee = String(
    (data.assignee as Record<string, unknown> | undefined)?.displayName ??
      (data.assignee as Record<string, unknown> | undefined)?.name ??
      '',
  )
  const author = String(
    (data.user as Record<string, unknown> | undefined)?.displayName ??
      (data.user as Record<string, unknown> | undefined)?.name ??
      '',
  )
  const rawLabels = (data.labels as Array<Record<string, unknown>> | undefined) ?? []
  const labels = rawLabels.map((l) => String(l.name ?? '')).join(', ')
  const commentBody = String(data.body ?? '')
  const body = [title, commentBody].filter(Boolean).join('\n')

  return {
    repo: 'linear',
    number,
    title,
    html_url,
    author,
    labels,
    action,
    event: eventType,
    assignee,
    body,
  }
}

/**
 * Build the flat TemplateContext for a generic webhook (#2272). The
 * shape is operator-defined; we probe common fields and treat the
 * source name as `repo` so `{{repo}}` is meaningful in templates.
 * `event` is the source name (generic events have no event header).
 */
export function buildGenericContext(
  source: string,
  payload: Record<string, unknown>,
): TemplateContext {
  const title =
    typeof payload.title === 'string'
      ? payload.title
      : typeof payload.message === 'string'
        ? payload.message
        : typeof payload.text === 'string'
          ? payload.text
          : ''
  const action = String(payload.action ?? '')
  const html_url = typeof payload.url === 'string' ? payload.url : ''
  const number = String(payload.id ?? payload.number ?? '')
  const author = String(payload.author ?? payload.user ?? '')
  const assignee = String(payload.assignee ?? '')
  const rawLabels = Array.isArray(payload.labels)
    ? (payload.labels as unknown[]).map((l) =>
        typeof l === 'string' ? l : String((l as Record<string, unknown>)?.name ?? ''),
      )
    : []
  const labels = rawLabels.join(', ')

  return {
    repo: source,
    number,
    title,
    html_url,
    author,
    labels,
    action,
    event: source,
    assignee,
    body: title,
  }
}

/**
 * Dispatch to the right context builder by source (#2272).
 */
export function buildContext(
  source: string,
  eventType: string,
  payload: Record<string, unknown>,
): TemplateContext {
  switch (source) {
    case 'linear':
      return buildLinearContext(eventType, payload)
    case 'generic':
      return buildGenericContext(eventType, payload)
    default:
      return buildGithubContext(eventType, payload)
  }
}

// ─── Static matcher ───────────────────────────────────────────────────────────

/** Split the comma-joined `labels` context field back into a Set. */
function labelSetFromContext(ctx: TemplateContext): Set<string> {
  return new Set(
    ctx.labels
      .split(',')
      .map((l) => l.trim())
      .filter(Boolean),
  )
}

/**
 * Returns true iff the payload matches all constraints in the matcher.
 *
 * Source-aware (#2272): label/author/assignee fields are read off the
 * source-specific TemplateContext, so the same matcher works for
 * github, linear, and generic events.
 *
 * @param source     The webhook source ("github" | "linear" | "generic").
 * @param eventType  Source event name (github event header / linear
 *                   type / generic source name).
 * @param payload    Parsed JSON body.
 * @param matcher    Rule matcher constraints.
 */
export function matchesRule(
  source: string,
  eventType: string,
  payload: Record<string, unknown>,
  matcher: DispatchMatcher,
): boolean {
  // Event name must match.
  if (matcher.event !== eventType) return false

  const ctx = buildContext(source, eventType, payload)

  // action filter — if specified, the payload's action must be in the list.
  if (matcher.actions && matcher.actions.length > 0) {
    if (!matcher.actions.includes(ctx.action)) return false
  }

  // exclude_authors — skip if author is in the exclusion list.
  if (matcher.exclude_authors && matcher.exclude_authors.length > 0) {
    if (matcher.exclude_authors.includes(ctx.author)) return false
  }

  // assignee_any — at least one assignee in the list must match (linear/generic).
  if (matcher.assignee_any && matcher.assignee_any.length > 0) {
    if (!matcher.assignee_any.includes(ctx.assignee)) return false
  }

  // mentions_any — the event text must mention one of these (case-insensitive substring).
  if (matcher.mentions_any && matcher.mentions_any.length > 0) {
    const hay = ctx.body.toLowerCase()
    const hasMention = matcher.mentions_any.some((m) => hay.includes(m.toLowerCase()))
    if (!hasMention) return false
  }

  // labels_any — at least one label in the list must be present.
  if (matcher.labels_any && matcher.labels_any.length > 0) {
    const labelNames = labelSetFromContext(ctx)
    if (!matcher.labels_any.some((l) => labelNames.has(l))) return false
  }

  // labels_all — every label in the list must be present.
  if (matcher.labels_all && matcher.labels_all.length > 0) {
    const labelNames = labelSetFromContext(ctx)
    if (!matcher.labels_all.every((l) => labelNames.has(l))) return false
  }

  return true
}

// ─── Cooldown ─────────────────────────────────────────────────────────────────

/** Parse duration strings like "5m", "1h", "30s" into milliseconds. */
export function parseDurationMs(d: string): number {
  const m = d.trim().match(/^(\d+)(s|m|h|d)?$/)
  if (!m) return 0
  const n = parseInt(m[1], 10)
  switch (m[2]) {
    case 's': return n * 1_000
    case 'm': return n * 60_000
    case 'h': return n * 3_600_000
    case 'd': return n * 86_400_000
    default: return n
  }
}

interface CooldownFileShape {
  dispatches: Record<string, number>
}

function cooldownKey(
  source: string,
  eventType: string,
  repo: string,
  number: string,
  ruleIndex: number,
): string {
  return `${source}:${eventType}:${repo}:${number}:${ruleIndex}`
}

function loadCooldownFile(path: string): Record<string, number> {
  try {
    if (!existsSync(path)) return {}
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as CooldownFileShape
    return typeof raw.dispatches === 'object' && raw.dispatches !== null
      ? raw.dispatches
      : {}
  } catch {
    return {}
  }
}

function saveCooldownFile(path: string, dispatches: Record<string, number>): void {
  try {
    writeFileSync(path, JSON.stringify({ dispatches } satisfies CooldownFileShape), {
      mode: 0o600,
    })
  } catch {
    // Non-fatal
  }
}

export interface CooldownStore {
  /** Returns true if the key is within cooldown (should skip). Also records on miss. */
  isCoolingDown(
    agent: string,
    key: string,
    cooldownMs: number,
    now: number,
  ): boolean
}

export function createFileCooldownStore(
  resolveAgentDir: (agent: string) => string,
): CooldownStore {
  // In-memory cache: loaded once per agent per process lifetime.
  // Safe because the webhook handler runs in a single-process gateway;
  // if this ever moves to a multi-worker deployment, the cache layer
  // would need a cross-process invalidation mechanism (or removal).
  const cache = new Map<string, Record<string, number>>()
  return {
    isCoolingDown(agent: string, key: string, cooldownMs: number, now: number): boolean {
      if (cooldownMs <= 0) return false

      const telegramDir = join(resolveAgentDir(agent), 'telegram')
      const filePath = join(telegramDir, 'webhook-cooldown.json')

      if (!cache.has(agent)) {
        cache.set(agent, loadCooldownFile(filePath))
      }

      const dispatches = cache.get(agent)!
      const lastDispatch = dispatches[key]

      if (lastDispatch !== undefined && now - lastDispatch < cooldownMs) {
        return true // still cooling
      }

      // Record this dispatch
      dispatches[key] = now
      try {
        mkdirSync(telegramDir, { recursive: true })
        saveCooldownFile(filePath, dispatches)
      } catch {
        // Non-fatal
      }

      return false
    },
  }
}

// ─── Quiet hours ──────────────────────────────────────────────────────────────

/**
 * Returns true when the current wall clock is inside the quiet window.
 * `start` and `end` are hours (0-23). When start > end the window wraps
 * midnight (e.g. start=22, end=8 = quiet from 10pm to 8am).
 */
export function isQuietHour(qh: QuietHours, now: Date): boolean {
  const tz = qh.tz ?? 'UTC'
  // Get current hour in the target timezone.
  let hour: number
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hour12: false,
    })
    const parts = formatter.formatToParts(now)
    const hourPart = parts.find((p) => p.type === 'hour')
    hour = parseInt(hourPart?.value ?? '0', 10)
  } catch {
    // Unknown timezone — fall back to UTC
    hour = now.getUTCHours()
  }

  const { start, end } = qh
  if (start < end) {
    // Simple range: e.g. 9-17
    return hour >= start && hour < end
  } else {
    // Wraps midnight: e.g. 22-8
    return hour >= start || hour < end
  }
}

// ─── Inbound injection ────────────────────────────────────────────────────────

export interface InjectWebhookInboundDeps {
  /**
   * Test seam — replace the gateway delivery. Default connects to the
   * agent's gateway UDS socket and writes one `inject_inbound` envelope.
   * Resolves true when the bytes were accepted by the socket.
   */
  injectFn?: (
    socketPath: string,
    agentName: string,
    inbound: InboundMessageWire,
  ) => Promise<boolean>
  /** Override agent dir resolver for tests. */
  resolveAgentDir?: (agent: string) => string
  /** Clock override for tests. */
  now?: () => number
  /** Log sink. */
  log?: (line: string) => void
}

/**
 * Default delivery: connect to the agent's gateway socket, write one
 * `inject_inbound` envelope, close. The webhook process is host-side;
 * the agent's gateway socket lives at a host-visible bind-mounted path
 * inside the agent's telegram state dir.
 */
async function defaultInject(
  socketPath: string,
  agentName: string,
  inbound: InboundMessageWire,
): Promise<boolean> {
  const client = createInjectIpcClient({ socketPath })
  try {
    const connected = await client.waitForConnect(5_000)
    if (!connected) return false
    return client.sendInjectInbound({
      type: 'inject_inbound',
      agentName,
      // InboundMessageWire is a structural mirror of telegram-plugin's
      // InboundMessage — the cast is a no-op at runtime. Same pattern
      // as the scheduler's `ipcDispatcher` (agent-scheduler/index.ts).
      inbound: inbound as unknown as Parameters<
        InjectIpcClient['sendInjectInbound']
      >[0]['inbound'],
    })
  } finally {
    client.close()
  }
}

/**
 * Synthesize an `InboundMessage` for a matched webhook rule and deliver
 * it to the agent's gateway as an `inject_inbound` envelope. The turn
 * runs in the agent's live interactive `claude` session — the same
 * path cron fires take.
 *
 * Fire-and-forget: the synthesized turn is delivered asynchronously and
 * the result is logged; the caller's match-evaluation loop does not
 * block on gateway round-trips.
 */
export function injectWebhookInbound(
  agent: string,
  prompt: string,
  ctx: { chatId: string; threadId?: number; eventType: string; ruleIndex: number },
  deps: InjectWebhookInboundDeps = {},
): void {
  const log = deps.log ?? ((s) => process.stderr.write(s))
  const resolveAgentDir =
    deps.resolveAgentDir ?? ((a) => join(homedir(), '.switchroom', 'agents', a))
  const now = (deps.now ?? Date.now)()
  const socketPath = join(resolveAgentDir(agent), 'telegram', 'gateway.sock')

  const inbound: InboundMessageWire = {
    type: 'inbound',
    chatId: ctx.chatId,
    ...(ctx.threadId !== undefined ? { threadId: ctx.threadId } : {}),
    // Synthetic id — webhook fires have no Telegram message_id. The
    // bridge only uses messageId for reply-context, a no-op here.
    messageId: now,
    user: 'webhook',
    userId: 0,
    ts: now,
    text: prompt,
    meta: {
      source: 'webhook',
      event: ctx.eventType,
      rule_index: String(ctx.ruleIndex),
    },
  }

  const injectFn = deps.injectFn ?? defaultInject
  injectFn(socketPath, agent, inbound)
    .then((ok) =>
      log(
        `webhook-dispatch: agent='${agent}' inject_inbound ` +
          `${ok ? 'delivered to gateway' : 'not delivered (gateway not connected)'}\n`,
      ),
    )
    .catch((err: unknown) =>
      log(`webhook-dispatch: agent='${agent}' inject failed: ${String(err)}\n`),
    )
}

// ─── Linear agent sessions (#2298) ──────────────────────────────────────────

/**
 * The interesting fields of a Linear `AgentSessionEvent` webhook payload.
 *
 * Linear's envelope for the agent platform (docs:
 * https://linear.app/developers/agents) looks roughly like:
 *
 * ```json
 * {
 *   "type": "AgentSessionEvent",
 *   "action": "created" | "prompted",
 *   "agentSession": {
 *     "id": "<session-id>",
 *     "issue": { "identifier": "ENG-42", "title": "..." },
 *     "comment": { "body": "@carrie draft this" }
 *   },
 *   "promptContext": "…pre-assembled, LLM-ready context…"   // sometimes top-level
 * }
 * ```
 *
 * Field placement has drifted across Linear's beta; we read defensively
 * from a couple of candidate locations and fall back to a readable summary
 * so the turn is never empty.
 */
export interface LinearAgentSession {
  sessionId: string
  /** "mention" (an @mention created the session) | "delegation" (an issue
   *  was delegated/assigned to the agent). Derived from the event. */
  trigger: 'mention' | 'delegation'
  /** The Linear envelope action (created / prompted / …), lower-cased. */
  action: string
  /** Linear's pre-assembled prompt context, when present. */
  promptContext?: string
  /** A readable fallback summary built from issue / comment fields. */
  summary: string
}

/**
 * Parse a verified Linear `AgentSessionEvent` payload into the fields the
 * inject path needs. Returns null when the payload is not an agent-session
 * event (so the caller can fall through to ordinary webhook_dispatch).
 *
 * Pure — no fetch, no DB. The payload is attacker-influenced DATA; nothing
 * here is treated as instructions (the rendered turn carries it verbatim,
 * the same posture as renderLinearEvent).
 */
export function parseLinearAgentSession(
  payload: Record<string, unknown>,
): LinearAgentSession | null {
  const type = String(payload.type ?? '').toLowerCase()
  if (type !== 'agentsessionevent') return null

  const action = String(payload.action ?? '').toLowerCase()
  const session =
    (payload.agentSession as Record<string, unknown> | undefined) ??
    (payload.agent_session as Record<string, unknown> | undefined) ??
    {}

  const sessionId = String(
    session.id ??
      (payload.agentSessionId as string | undefined) ??
      (payload.agent_session_id as string | undefined) ??
      '',
  )
  if (!sessionId) return null

  // Trigger derivation: a comment-driven session is a mention; an issue
  // delegated/assigned with no comment is a delegation. Linear sometimes
  // sets an explicit `trigger`; honour it when present.
  const explicitTrigger = String(
    session.trigger ?? (payload.trigger as string | undefined) ?? '',
  ).toLowerCase()
  const comment = session.comment as Record<string, unknown> | undefined
  const trigger: 'mention' | 'delegation' =
    explicitTrigger === 'mention' || explicitTrigger === 'delegation'
      ? (explicitTrigger as 'mention' | 'delegation')
      : comment
        ? 'mention'
        : 'delegation'

  const promptContext =
    typeof payload.promptContext === 'string'
      ? payload.promptContext
      : typeof session.promptContext === 'string'
        ? (session.promptContext as string)
        : undefined

  // Readable fallback summary from issue + comment.
  const issue = (session.issue as Record<string, unknown> | undefined) ?? {}
  const issueId = String(issue.identifier ?? '')
  const issueTitle = String(issue.title ?? '')
  const commentBody =
    typeof comment?.body === 'string' ? (comment.body as string) : ''
  const summaryParts: string[] = []
  summaryParts.push(
    trigger === 'mention'
      ? `You were @mentioned in Linear`
      : `An issue was delegated to you in Linear`,
  )
  if (issueId || issueTitle) {
    summaryParts.push(`Issue ${issueId}${issueTitle ? `: ${issueTitle}` : ''}`.trim())
  }
  if (commentBody) summaryParts.push(commentBody)
  const summary = summaryParts.join('\n')

  return { sessionId, trigger, action, promptContext, summary }
}

/**
 * Synthesize an `InboundMessage` for a Linear AgentSessionEvent and deliver
 * it to the agent's gateway as an `inject_inbound` envelope — the same path
 * `injectWebhookInbound` uses, but tagged for the agent-session lifecycle:
 *
 *   - `meta.source = "linear"`
 *   - `meta.agent_session_id` — the Linear session id (for the
 *     `linear_agent_activity` MCP tool to emit AgentActivity against)
 *   - `meta.linear_trigger` — "mention" | "delegation"
 *   - `meta.linear_event` — a compact event type ("agent_session.<action>")
 *
 * The turn content is Linear's pre-assembled `promptContext` when present,
 * else a readable summary. Mentions/delegations ALWAYS wake the agent (no
 * dispatch-rule matcher) — that is the whole point of the agents platform.
 *
 * Fire-and-forget (host-runtime path). In viaGateway mode the gateway
 * delivers in-process via the `inject` callback instead — see
 * recordWebhookEvent.
 */
export function injectLinearInbound(
  agent: string,
  session: LinearAgentSession,
  ctx: { chatId: string; threadId?: number },
  deps: InjectWebhookInboundDeps = {},
): void {
  const log = deps.log ?? ((s) => process.stderr.write(s))
  const resolveAgentDir =
    deps.resolveAgentDir ?? ((a) => join(homedir(), '.switchroom', 'agents', a))
  const now = (deps.now ?? Date.now)()
  const socketPath = join(resolveAgentDir(agent), 'telegram', 'gateway.sock')

  const inbound = buildLinearInbound(session, ctx, now)

  const injectFn = deps.injectFn ?? defaultInject
  injectFn(socketPath, agent, inbound)
    .then((ok) =>
      log(
        `linear-agent: agent='${agent}' session='${session.sessionId}' inject_inbound ` +
          `${ok ? 'delivered to gateway' : 'not delivered (gateway not connected)'}\n`,
      ),
    )
    .catch((err: unknown) =>
      log(`linear-agent: agent='${agent}' inject failed: ${String(err)}\n`),
    )
}

/**
 * Pure builder for the Linear AgentSession inbound. Shared by the
 * host-runtime inject path (injectLinearInbound) and the in-process
 * gateway path (recordWebhookEvent) so the wire shape is identical and
 * testable without a socket.
 */
export function buildLinearInbound(
  session: LinearAgentSession,
  ctx: { chatId: string; threadId?: number },
  now: number,
): InboundMessageWire {
  const content = session.promptContext && session.promptContext.trim().length > 0
    ? session.promptContext
    : session.summary
  return {
    type: 'inbound',
    chatId: ctx.chatId,
    ...(ctx.threadId !== undefined ? { threadId: ctx.threadId } : {}),
    messageId: now,
    user: 'linear',
    userId: 0,
    ts: now,
    text: content,
    meta: {
      source: 'linear',
      agent_session_id: session.sessionId,
      linear_trigger: session.trigger,
      linear_event: `agent_session.${session.action || 'event'}`,
    },
  }
}

// ─── Main dispatch evaluator ──────────────────────────────────────────────────

export interface EvaluateDispatchArgs {
  agent: string
  source: string
  eventType: string
  payload: Record<string, unknown>
  dispatchConfig: WebhookDispatchConfig
  /**
   * Chat the synthesized webhook turn belongs to — the fleet forum
   * chat. The caller resolves this from `telegram.forum_chat_id`.
   */
  chatId: string
  /** The agent's forum topic id, when the forum chat has topics. */
  threadId?: number
}

export interface EvaluateDispatchDeps extends InjectWebhookInboundDeps {
  /** Overridable Date for quiet-hours evaluation. */
  nowDate?: () => Date
  /** Injectable cooldown store for tests. */
  cooldownStore?: CooldownStore
}

/**
 * Evaluate all dispatch rules for the incoming event. For each matching
 * rule that is not in cooldown and not in quiet hours, deliver a
 * synthesized `inject_inbound` turn to the agent.
 *
 * Returns the number of dispatches fired (0 if nothing matched).
 */
export function evaluateDispatch(
  args: EvaluateDispatchArgs,
  deps: EvaluateDispatchDeps = {},
): number {
  const log = deps.log ?? ((s) => process.stderr.write(s))
  const now = (deps.now ?? Date.now)()
  const nowDate = deps.nowDate ?? (() => new Date(now))
  const resolveAgentDir =
    deps.resolveAgentDir ?? ((a) => join(homedir(), '.switchroom', 'agents', a))
  const cooldownStore =
    deps.cooldownStore ?? createFileCooldownStore(resolveAgentDir)

  // Dispatch supports github, generic, and linear sources (#2272).
  // Rules are keyed by source under dispatchConfig; an unknown source
  // (or one with no rules configured) is a no-op.
  if (!(DISPATCH_SOURCES as readonly string[]).includes(args.source)) return 0

  const rules = args.dispatchConfig[args.source as DispatchSource]
  if (!rules || rules.length === 0) return 0

  const ctx = buildContext(args.source, args.eventType, args.payload)
  let fired = 0

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]

    if (!matchesRule(args.source, args.eventType, args.payload, rule.match)) continue

    // Quiet hours check
    if (rule.quiet_hours && isQuietHour(rule.quiet_hours, nowDate())) {
      log(
        `webhook-dispatch: agent='${args.agent}' rule=${i} skipped (quiet hours)\n`,
      )
      continue
    }

    // Cooldown check
    const cooldownMs = rule.cooldown ? parseDurationMs(rule.cooldown) : 0
    if (cooldownMs > 0) {
      const ck = cooldownKey(args.source, args.eventType, ctx.repo, ctx.number, i)
      if (cooldownStore.isCoolingDown(args.agent, ck, cooldownMs, now)) {
        log(
          `webhook-dispatch: agent='${args.agent}' rule=${i} skipped (cooldown)\n`,
        )
        continue
      }
    }

    const prompt = renderTemplate(rule.prompt, ctx)

    log(
      `webhook-dispatch: agent='${args.agent}' rule=${i} matched event='${args.eventType}' action='${ctx.action}' firing\n`,
    )

    injectWebhookInbound(
      args.agent,
      prompt,
      {
        chatId: args.chatId,
        ...(args.threadId !== undefined ? { threadId: args.threadId } : {}),
        eventType: args.eventType,
        ruleIndex: i,
      },
      { ...deps, resolveAgentDir },
    )

    fired++
  }

  return fired
}
