/**
 * mcp-credential-failure.ts — "a paid MCP dependency is blocked" detection.
 *
 * WHY THIS EXISTS
 * ---------------
 * Ken: "If perplexity fails for any agent we should have hard warning via
 * message here per other failures."
 *
 * Perplexity (and Eraser, Brevo, Meta Ads, Postiz, Google Ads …) reach
 * switchroom over the MCP TOOL surface, not through LiteLLM. So the operator-
 * event path that PR A fixed for an OpenRouter 402 never sees them: an expired
 * Perplexity key surfaces as an ordinary `is_error` tool_result, gets rendered
 * as a transient step in the live feed, and dies there. Nobody is told the
 * fleet just lost a paid capability.
 *
 * This module is the classifier + ledger for that. It is deliberately GENERIC:
 * Perplexity is one row in `PROVIDER_CREDIT_REGISTRY` / `MCP_SERVER_VAULT_KEYS`,
 * not a special case, so every current and future MCP server gets the same
 * treatment by adding DATA, never a new conditional at a call site.
 *
 * THE CLASSIFICATION RULE (stated explicitly, because it decides whether Ken's
 * phone buzzes — and an alert he learns to ignore is worse than no alert):
 *
 *   ALERT — the key itself is the problem, and only Ken can fix it:
 *     • credit    — out of money   (402, "insufficient credits", "payment_required")
 *     • credential— key rejected   (401/403, "invalid api key", "unauthorized",
 *                                   "key has been disabled/revoked/blocked")
 *     • quota     — hard usage wall("quota exceeded", "usage limit reached",
 *                                   "monthly limit", "plan limit", "over
 *                                   quota") — i.e. spent for the period
 *
 *   SILENT — ordinary operational failure, retrying or rewording fixes it:
 *     • a bare rate limit / 429 with a retry-after (throttle, not a wall)
 *     • 404, 400, validation errors, a bad query, no results
 *     • timeouts, ECONNRESET, 5xx, transport errors
 *
 * The 429 split is the subtle one and is intentional: a throttle self-heals in
 * seconds and must NOT page the operator; a `quota exceeded`/`usage limit`
 * wording on the same status means the period's allowance is gone and only a
 * plan change or a top-up clears it. Status alone is never sufficient — see the
 * OpenAI case in `provider-credit.ts` (a spent balance arrives as 429).
 *
 * DEDUPLICATION — and its HONEST LIMIT
 * ------------------------------------
 * The ledger coalesces per `(server, class)` and re-notifies on the house
 * cadence (`RENOTIFY_MS`, 6 h — the same interval `src/hindsight-watch` uses,
 * so operator alerts across switchroom share one rhythm). Repeated failures
 * inside the window are ACCUMULATED, not dropped: the next alert names every
 * agent seen since the last one.
 *
 * The limit: this ledger is IN-PROCESS and therefore AGENT-LOCAL. Each agent
 * runs its own `switchroom-<agent>` container with its own gateway process and
 * no shared writable mount (`~/.switchroom/fleet` is read-only; per-agent state
 * dirs are 0700 under distinct UIDs). So if six agents hit a blocked Perplexity
 * key in the same minute, Ken gets up to six alerts — one per agent, each
 * naming its agent — not one coalesced alert, and not thirty-six. Honouring
 * "one alert naming the affected agents" fleet-wide needs a shared ledger the
 * gateway does not have; that is filed as a follow-up rather than faked here.
 *
 * Pure module: no IPC, no bot, no FS, no network, no ambient clock (`now` is a
 * parameter). Trivially unit-testable.
 */

import {
  PROVIDER_CREDIT_REGISTRY,
  hasCreditExhaustionWording,
  isProviderCreditStatus,
  type ProviderCreditEntry,
} from './provider-credit.js'

// ─── Server identity ─────────────────────────────────────────────────────────

/**
 * Vault key names for paid MCP servers that are NOT in the credit registry
 * (the registry only covers providers that also serve inference). A NAME only —
 * this module never reads or renders a secret VALUE.
 *
 * Adding a paid dependency is a DATA edit here.
 */
export const MCP_SERVER_VAULT_KEYS: Readonly<Record<string, { label: string; vaultKey: string; consoleUrl: string }>> = {
  eraser: { label: 'Eraser', vaultKey: 'eraser/api-key', consoleUrl: 'https://app.eraser.io/settings/api' },
  brevo: { label: 'Brevo', vaultKey: 'brevo/api-key', consoleUrl: 'https://app.brevo.com/settings/keys/api' },
  postiz: { label: 'Postiz', vaultKey: 'postiz/api-key', consoleUrl: 'https://platform.postiz.com/settings' },
  'meta-ads': { label: 'Meta Ads', vaultKey: 'meta-ads/access-token', consoleUrl: 'https://business.facebook.com/settings' },
  'google-ads': { label: 'Google Ads', vaultKey: 'google-ads/developer-token', consoleUrl: 'https://ads.google.com/aw/apicenter' },
  cloudflare: { label: 'Cloudflare', vaultKey: 'cloudflare/api-token', consoleUrl: 'https://dash.cloudflare.com/profile/api-tokens' },
  context7: { label: 'Context7', vaultKey: 'context7/api-key', consoleUrl: 'https://context7.com/dashboard' },
}

/**
 * `mcp__perplexity__perplexity_search` → `perplexity`. Returns `null` for a
 * non-MCP tool (Bash, Read, …) — those are never a credential problem, so the
 * caller short-circuits on `null` and the hot path costs one `startsWith`.
 */
export function parseMcpServerFromToolName(toolName: unknown): string | null {
  if (typeof toolName !== 'string') return null
  if (!toolName.startsWith('mcp__')) return null
  const rest = toolName.slice('mcp__'.length)
  const end = rest.indexOf('__')
  const server = end === -1 ? rest : rest.slice(0, end)
  return server.length > 0 ? server : null
}

/** Remedy metadata for a server, from either data source. `null` when unknown. */
export function describeMcpServer(
  server: string,
): { label: string; vaultKey: string; consoleUrl: string } | null {
  const direct = MCP_SERVER_VAULT_KEYS[server]
  if (direct != null) return direct
  const entry: ProviderCreditEntry | undefined = PROVIDER_CREDIT_REGISTRY.find(e => e.id === server)
  if (entry != null) {
    return { label: entry.label, vaultKey: entry.vaultKey, consoleUrl: entry.consoleUrl }
  }
  return null
}

// ─── Classification ──────────────────────────────────────────────────────────

/** `ordinary` is the SILENT class — everything else raises an operator alert. */
export type McpFailureClass = 'credit' | 'credential' | 'quota' | 'ordinary'

/** True for the classes that page the operator. */
export function isAlertingClass(c: McpFailureClass): boolean {
  return c !== 'ordinary'
}

interface ClassRule {
  cls: Exclude<McpFailureClass, 'ordinary'>
  /** Structured HTTP statuses that imply this class on their own. */
  statuses: readonly number[]
  /** Lowercase wordings that imply this class. */
  signals: readonly string[]
}

/**
 * Evaluated IN ORDER — first match wins. Credit precedes credential because a
 * spent Perplexity balance answers 401 with "insufficient credits", and the
 * remedy is "top up", not "re-issue the key".
 */
const CLASS_RULES: readonly ClassRule[] = [
  // `credit` is handled ahead of this table via the shared registry predicates.
  {
    cls: 'credential',
    statuses: [401, 403],
    signals: [
      'invalid api key',
      'invalid_api_key',
      'incorrect api key',
      'invalid authentication',
      'authentication_error',
      'authentication failed',
      'unauthorized',
      'unauthorised',
      'forbidden',
      'api key not found',
      'no api key provided',
      'missing api key',
      'api key expired',
      'key has been disabled',
      'key has been revoked',
      'key is disabled',
      'account has been blocked',
      'account is blocked',
      'account suspended',
      'permission_denied',
      'token expired',
      'invalid token',
    ],
  },
  {
    cls: 'quota',
    // NOTE: 429 is deliberately NOT listed. A bare 429 is a throttle and must
    // stay silent; only the hard-wall WORDINGS below promote it to an alert.
    statuses: [],
    signals: [
      'quota exceeded',
      'quota_exceeded',
      'over quota',
      'usage limit reached',
      'usage limit exceeded',
      'monthly limit',
      'monthly quota',
      'plan limit',
      'plan_limit',
      'limit reached for your plan',
      'upgrade your plan',
      'spending limit',
      // NOTE: "exceeded your current quota" is deliberately NOT here. It is
      // OpenAI's BILLING wording and already lives in `CREDIT_EXHAUSTION_SIGNALS`,
      // where it is matched first — duplicating it would be dead data that
      // silently disagrees with the shared registry.
    ],
  },
]

/**
 * Wordings that mean "transient throttle / operational hiccup" and must keep a
 * failure SILENT even if a broader signal would otherwise match. Checked before
 * the alerting rules so `429 rate limit, retry after 2s` never pages anyone.
 */
const TRANSIENT_SIGNALS: readonly string[] = [
  'rate limit',
  'rate_limit',
  'too many requests',
  'retry after',
  'retry-after',
  'slow down',
  'timeout',
  'timed out',
  'etimedout',
  'econnreset',
  'econnrefused',
  'socket hang up',
  'network error',
  'service unavailable',
  'bad gateway',
  'temporarily unavailable',
]

const MAX_SCAN_CHARS = 16_384

function sample(text: unknown): string {
  if (typeof text !== 'string' || text.length === 0) return ''
  return (text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text).toLowerCase()
}

/**
 * Pull a structured HTTP status out of free-form error text. Conservative on
 * purpose: only reads a 3-digit code that is LABELLED as a status/code, never a
 * bare number (ids, token counts and durations are full of them).
 */
export function extractHttpStatus(text: unknown): number | null {
  const lower = sample(text)
  if (lower.length === 0) return null
  const m =
    /\b(?:http[ _-]?status|status[ _-]?code|statuscode|status|http|code|error)\b\D{0,4}\b([1-5]\d\d)\b/.exec(lower) ??
    /\b([1-5]\d\d)\s+(?:unauthorized|unauthorised|forbidden|payment required|too many requests)\b/.exec(lower)
  if (m == null) return null
  const n = Number(m[1])
  return Number.isFinite(n) ? n : null
}

/**
 * Classify one failed MCP tool result. `status` may be supplied by a caller
 * that has a structured one; otherwise it is recovered from the text.
 *
 * Returns `'ordinary'` — the SILENT class — for anything not proven to be a
 * key/billing problem. That default is deliberate: a false alert costs Ken's
 * trust in the channel, a missed one costs a retry.
 */
export function classifyMcpFailure(text: unknown, status?: unknown): McpFailureClass {
  const lower = sample(text)
  const httpStatus = typeof status === 'number' ? status : extractHttpStatus(text)

  // 1. Credit wall — the shared registry decides, so the MCP path and the
  //    LiteLLM path can never disagree about what "out of money" looks like.
  if (isProviderCreditStatus(httpStatus) || hasCreditExhaustionWording(lower)) return 'credit'

  // 2. An EXPLICIT alerting wording beats everything below it. Deliberately
  //    ahead of the transient check: providers routinely wrap a hard wall in
  //    throttle language ("Rate limit exceeded: monthly quota exhausted"), and
  //    the wall is the real news.
  for (const rule of CLASS_RULES) {
    if (rule.signals.some(s => lower.includes(s))) return rule.cls
  }

  // 3. Transient beats a STATUS-ONLY inference: a throttle is not a wall, and
  //    a bare status with retry/timeout language is an operational hiccup.
  if (TRANSIENT_SIGNALS.some(s => lower.includes(s))) return 'ordinary'

  // 4. Status-only inference, last and weakest.
  for (const rule of CLASS_RULES) {
    if (httpStatus != null && rule.statuses.includes(httpStatus)) return rule.cls
  }

  return 'ordinary'
}

// ─── Ledger ──────────────────────────────────────────────────────────────────

/**
 * House re-notify cadence, matched to `src/hindsight-watch/thresholds.ts`
 * (`RENOTIFY_MS`) so every standing operator alert in switchroom repeats on the
 * same 6-hour rhythm.
 */
export const RENOTIFY_MS = 6 * 60 * 60 * 1000

export interface McpFailureAlert {
  server: string
  label: string
  vaultKey: string
  consoleUrl: string
  cls: Exclude<McpFailureClass, 'ordinary'>
  /** Every agent seen failing this way since the previous alert. */
  agents: string[]
  /** Total failures counted since the previous alert. */
  occurrences: number
  /** True when this is a 6-hourly repeat rather than a first firing. */
  renotify: boolean
}

interface LedgerRow {
  agents: Set<string>
  occurrences: number
  lastAlertAt: number
}

/**
 * Coalescing ledger. One instance per gateway process; `now` is injected so
 * tests are deterministic and no ambient clock leaks in.
 */
export class McpFailureLedger {
  private readonly rows = new Map<string, LedgerRow>()

  constructor(private readonly renotifyMs: number = RENOTIFY_MS) {}

  /**
   * Record one classified failure. Returns the alert to send, or `null` when
   * this occurrence is inside an already-alerted window (deduplicated).
   */
  note(input: {
    server: string
    agent: string
    cls: McpFailureClass
    now: number
  }): McpFailureAlert | null {
    if (!isAlertingClass(input.cls)) return null
    const cls = input.cls as Exclude<McpFailureClass, 'ordinary'>
    const key = `${input.server}::${cls}`
    const row = this.rows.get(key) ?? { agents: new Set<string>(), occurrences: 0, lastAlertAt: -Infinity }
    row.agents.add(input.agent)
    row.occurrences += 1
    this.rows.set(key, row)

    const due = input.now - row.lastAlertAt >= this.renotifyMs
    if (!due) return null

    const renotify = Number.isFinite(row.lastAlertAt)
    const meta = describeMcpServer(input.server)
    const alert: McpFailureAlert = {
      server: input.server,
      label: meta?.label ?? input.server,
      vaultKey: meta?.vaultKey ?? `${input.server}/api-key`,
      consoleUrl: meta?.consoleUrl ?? '',
      cls,
      agents: [...row.agents].sort(),
      occurrences: row.occurrences,
      renotify,
    }
    row.lastAlertAt = input.now
    row.agents = new Set<string>()
    row.occurrences = 0
    return alert
  }

  /** Test/diagnostic helper — number of tracked (server, class) pairs. */
  size(): number {
    return this.rows.size
  }
}

// ─── The seam watcher ────────────────────────────────────────────────────────

/** Bound on the pending tool_use→name map so a leaked id can't grow it forever. */
const PENDING_TOOL_NAMES_MAX = 512

/**
 * The whole seam in one object: pair `tool_use` → `tool_result` by
 * `toolUseId` (the session stream reports `toolName: null` on results, so the
 * name MUST be carried across), classify, coalesce, and hand back the alert to
 * emit — or `null` for the overwhelmingly common case of "nothing to say".
 *
 * One instance per gateway process. `now` is injected; nothing here touches a
 * clock, the network, or the FS.
 */
export class McpFailureWatcher {
  private readonly pending = new Map<string, string>()
  private readonly ledger: McpFailureLedger

  constructor(renotifyMs: number = RENOTIFY_MS) {
    this.ledger = new McpFailureLedger(renotifyMs)
  }

  /** Remember the tool name for a call in flight. Non-MCP tools are ignored. */
  onToolUse(toolUseId: unknown, toolName: unknown): void {
    if (typeof toolUseId !== 'string' || toolUseId.length === 0) return
    if (parseMcpServerFromToolName(toolName) == null) return
    if (this.pending.size >= PENDING_TOOL_NAMES_MAX) {
      // Evict oldest — Map preserves insertion order.
      const oldest = this.pending.keys().next()
      if (!oldest.done) this.pending.delete(oldest.value)
    }
    this.pending.set(toolUseId, toolName as string)
  }

  /**
   * Consume a tool result. Returns an alert only when the failure is proven to
   * be a key/billing problem AND the (server, class) is outside its re-notify
   * window. Everything else — a success, a non-MCP tool, an ordinary error, a
   * deduplicated repeat — returns `null`.
   */
  onToolResult(input: {
    toolUseId: unknown
    isError?: boolean
    errorText?: unknown
    agent: string
    now: number
  }): McpFailureAlert | null {
    const id = typeof input.toolUseId === 'string' ? input.toolUseId : ''
    const toolName = id.length > 0 ? this.pending.get(id) : undefined
    if (id.length > 0) this.pending.delete(id)
    if (input.isError !== true) return null
    if (toolName == null) return null
    const server = parseMcpServerFromToolName(toolName)
    if (server == null) return null
    const cls = classifyMcpFailure(input.errorText)
    return this.ledger.note({ server, agent: input.agent, cls, now: input.now })
  }
}

// ─── Rendering ───────────────────────────────────────────────────────────────

const CLASS_HEADLINE: Record<Exclude<McpFailureClass, 'ordinary'>, string> = {
  credit: 'is out of credit',
  credential: 'key is being rejected',
  quota: 'has hit its usage quota',
}

const CLASS_ACTION: Record<Exclude<McpFailureClass, 'ordinary'>, string> = {
  credit: 'Top up the balance',
  credential: 'Re-issue the key and update the vault entry',
  quota: 'Raise the plan limit or wait for the quota to reset',
}

/**
 * The operator-card DETAIL for an MCP credential alert. Names the provider, the
 * VAULT KEY NAME (never a value), the affected agents and the action.
 *
 * Never includes the raw provider error: the same standing rule as the
 * OpenRouter 402 work — the end user sees nothing, and the operator sees a
 * remedy, not a stack trace.
 *
 * The output is composed ENTIRELY of registry constants, counts and sanitised
 * agent slugs — no provider text, no user text — which is why the card may
 * render it as Markdown without escaping (see `renderOperatorEvent`).
 */
export function renderMcpFailureDetail(alert: McpFailureAlert): string {
  const agents =
    alert.agents.length > 0
      ? alert.agents.map(a => a.replace(/[^A-Za-z0-9._-]/g, '')).filter(Boolean).join(', ')
      : 'unknown agent'
  const console_ = alert.consoleUrl.length > 0 ? ` → ${alert.consoleUrl}` : ''
  const repeat = alert.renotify ? ' (still failing)' : ''
  const times = alert.occurrences === 1 ? '1 failure' : `${alert.occurrences} failures`
  return (
    `${alert.label} ${CLASS_HEADLINE[alert.cls]}${repeat} — ${times}, affecting: ${agents}. ` +
    `${CLASS_ACTION[alert.cls]}. Vault key: \`${alert.vaultKey}\`${console_}`
  )
}
