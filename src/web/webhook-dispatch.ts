/**
 * Webhook dispatch (#715). After an event is verified and recorded by
 * `webhook-handler.ts`, this module evaluates per-rule matchers and, for
 * each match, spawns a fresh `claude -p` invocation against the agent so
 * it can react to the event via Telegram.
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
 *   - **Spawn pattern**: same shape as cron one-shots — `claude -p`
 *     with `--no-session-persistence`, env vars matching `buildCronScript`.
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
 *       model: claude-opus-4-7
 * ```
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { spawn } from 'child_process'

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
  /** Handlebars-style `{{field}}` template for the claude -p prompt. */
  prompt: string
  /** Cooldown duration string: "5m", "1h", "30s". Defaults to "0" (no cooldown). */
  cooldown?: string
  quiet_hours?: QuietHours
  /** Model override. Defaults to claude-sonnet-4-6. */
  model?: string
}

export interface WebhookDispatchConfig {
  github?: DispatchRule[]
}

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
  const title = String(obj?.title ?? (payload.commits as unknown[] | undefined)?.[0] ?? '')
  const html_url = String(obj?.html_url ?? payload.html_url ?? '')
  const author = String(
    (obj?.user as Record<string, unknown> | undefined)?.login ??
    (payload.sender as Record<string, unknown> | undefined)?.login ??
    '',
  )
  const rawLabels = (obj?.labels as Array<Record<string, unknown>> | undefined) ?? []
  const labels = rawLabels.map((l) => String(l.name ?? '')).join(', ')
  const action = String(payload.action ?? '')

  return { repo, number, title, html_url, author, labels, action, event: eventType }
}

// ─── Static matcher ───────────────────────────────────────────────────────────

/**
 * Returns true iff the payload matches all constraints in the matcher.
 *
 * @param eventType  The X-GitHub-Event header value.
 * @param payload    Parsed JSON body.
 * @param matcher    Rule matcher constraints.
 */
export function matchesRule(
  eventType: string,
  payload: Record<string, unknown>,
  matcher: DispatchMatcher,
): boolean {
  // Event name must match.
  if (matcher.event !== eventType) return false

  // Build context for label/author access.
  const ctx = buildGithubContext(eventType, payload)

  // action filter — if specified, the payload's action must be in the list.
  if (matcher.actions && matcher.actions.length > 0) {
    if (!matcher.actions.includes(ctx.action)) return false
  }

  // exclude_authors — skip if author is in the exclusion list.
  if (matcher.exclude_authors && matcher.exclude_authors.length > 0) {
    if (matcher.exclude_authors.includes(ctx.author)) return false
  }

  // labels_any — at least one label in the list must be present.
  if (matcher.labels_any && matcher.labels_any.length > 0) {
    const pr = payload.pull_request as Record<string, unknown> | undefined
    const issue = payload.issue as Record<string, unknown> | undefined
    const rawLabels =
      ((pr ?? issue)?.labels as Array<Record<string, unknown>> | undefined) ?? []
    const labelNames = new Set(rawLabels.map((l) => String(l.name ?? '')))
    const hasAny = matcher.labels_any.some((l) => labelNames.has(l))
    if (!hasAny) return false
  }

  // labels_all — every label in the list must be present.
  if (matcher.labels_all && matcher.labels_all.length > 0) {
    const pr = payload.pull_request as Record<string, unknown> | undefined
    const issue = payload.issue as Record<string, unknown> | undefined
    const rawLabels =
      ((pr ?? issue)?.labels as Array<Record<string, unknown>> | undefined) ?? []
    const labelNames = new Set(rawLabels.map((l) => String(l.name ?? '')))
    const hasAll = matcher.labels_all.every((l) => labelNames.has(l))
    if (!hasAll) return false
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

function cooldownKey(eventType: string, repo: string, number: string, ruleIndex: number): string {
  return `${eventType}:${repo}:${number}:${ruleIndex}`
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

// ─── Spawner ──────────────────────────────────────────────────────────────────

export interface SpawnAgentOneShotDeps {
  /** Override to capture spawn args in tests. */
  spawnFn?: (
    cmd: string,
    args: string[],
    opts: { env: NodeJS.ProcessEnv; stdio: [string, string, string] },
  ) => { on: (event: string, cb: (code: number | null) => void) => void; pid?: number }
  /** Override agent dir resolver for tests. */
  resolveAgentDir?: (agent: string) => string
  /** Injectable cooldown store for tests. */
  cooldownStore?: CooldownStore
  /** Clock override for tests. */
  now?: () => number
  /** Log sink. */
  log?: (line: string) => void
}

/**
 * Spawn a fresh `claude -p` process for the given agent and prompt.
 * Follows the same env setup as `buildCronScript` in scaffold.ts:
 *   - CLAUDE_CONFIG_DIR → <agentDir>/.claude
 *   - SWITCHROOM_AGENT_NAME → <agentName>
 *   - TELEGRAM_STATE_DIR → <agentDir>/telegram
 *   - CLAUDE_CODE_OAUTH_TOKEN injected from disk if present
 *   - ANTHROPIC_API_KEY unset to force OAuth
 */
export function spawnAgentOneShot(
  agent: string,
  prompt: string,
  model: string,
  deps: SpawnAgentOneShotDeps = {},
): void {
  const log = deps.log ?? ((s) => process.stderr.write(s))
  const resolveAgentDir =
    deps.resolveAgentDir ?? ((a) => join(homedir(), '.switchroom', 'agents', a))
  const agentDir = resolveAgentDir(agent)
  const claudeConfigDir = join(agentDir, '.claude')
  const telegramStateDir = join(agentDir, 'telegram')

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    SWITCHROOM_AGENT_NAME: agent,
    TELEGRAM_STATE_DIR: telegramStateDir,
  }

  // Unset ANTHROPIC_API_KEY to force OAuth auth (mirrors cron script pattern).
  delete env.ANTHROPIC_API_KEY

  // Inject OAuth token from disk if not already in env.
  if (!env.CLAUDE_CODE_OAUTH_TOKEN) {
    const tokenPath = join(claudeConfigDir, '.oauth-token')
    try {
      if (existsSync(tokenPath)) {
        env.CLAUDE_CODE_OAUTH_TOKEN = readFileSync(tokenPath, 'utf-8').trim()
      }
    } catch {
      // Non-fatal — claude will fall back to .credentials.json
    }
  }

  const spawnFn = deps.spawnFn ?? (
    (cmd: string, args: string[], opts: { env: NodeJS.ProcessEnv; stdio: [string, string, string] }) =>
      spawn(cmd, args, { ...opts, stdio: opts.stdio as ['ignore', 'ignore', 'pipe'] })
  )

  const child = spawnFn('claude', ['-p', prompt, '--model', model, '--no-session-persistence'], {
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  })

  log(`webhook-dispatch: agent='${agent}' model='${model}' pid=${child.pid ?? '?'} spawned\n`)

  child.on('close', (code) => {
    if (code !== 0) {
      log(`webhook-dispatch: agent='${agent}' claude -p exited with code ${code}\n`)
    }
  })
}

// ─── Main dispatch evaluator ──────────────────────────────────────────────────

export interface EvaluateDispatchArgs {
  agent: string
  source: string
  eventType: string
  payload: Record<string, unknown>
  dispatchConfig: WebhookDispatchConfig
}

export interface EvaluateDispatchDeps extends SpawnAgentOneShotDeps {
  /** Overridable Date for quiet-hours evaluation. */
  nowDate?: () => Date
}

/**
 * Evaluate all dispatch rules for the incoming event. For each matching
 * rule that is not in cooldown and not in quiet hours, spawn a fresh
 * `claude -p` process.
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

  // Only github source is supported for dispatch in this iteration.
  if (args.source !== 'github') return 0

  const rules = args.dispatchConfig.github
  if (!rules || rules.length === 0) return 0

  const ctx = buildGithubContext(args.eventType, args.payload)
  let fired = 0

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]

    if (!matchesRule(args.eventType, args.payload, rule.match)) continue

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
      const ck = cooldownKey(args.eventType, ctx.repo, ctx.number, i)
      if (cooldownStore.isCoolingDown(args.agent, ck, cooldownMs, now)) {
        log(
          `webhook-dispatch: agent='${args.agent}' rule=${i} skipped (cooldown)\n`,
        )
        continue
      }
    }

    const prompt = renderTemplate(rule.prompt, ctx)
    const model = rule.model ?? 'claude-sonnet-4-6'

    log(
      `webhook-dispatch: agent='${args.agent}' rule=${i} matched event='${args.eventType}' action='${ctx.action}' firing\n`,
    )

    spawnAgentOneShot(args.agent, prompt, model, {
      ...deps,
      resolveAgentDir,
      cooldownStore,
    })

    fired++
  }

  return fired
}
