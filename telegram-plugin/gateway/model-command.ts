/**
 * Telegram `/model` command — show or switch the Claude model for this
 * agent's live session.
 *
 * `/model` (bare) renders the model dashboard: the live model, a brief
 * quota line, and an inline-keyboard menu of the options claude's own
 * `/model` picker offers (discovered live via `src/agents/model-picker.ts`
 * — opened, parsed, Esc'd; never hardcoded, so new models appear the
 * moment the installed CLI offers them). A button tap re-opens the
 * picker fresh, matches the row by label, and applies session-only.
 * When discovery fails (agent mid-turn, CLI UI changed, kill-switched
 * via SWITCHROOM_MODEL_MENU=0) it falls back to the static v1 text.
 *
 * `/model <alias|full-id>` (and every menu tap) is a DETERMINISTIC carrier
 * relaunch (rev 5, session-model-stickiness.md §0.05): the requested token is
 * written to the consume-once `.session-model` carrier and applied by start.sh's
 * `exec claude --model <token>` on the next boot. The inject-into-tmux +
 * terminal-scrape path is RETIRED — it silently no-op'd (keystrokes swallowed
 * on a busy pane) then optimistically recorded success, an unverifiable lie to
 * `/status`. A relaunch cannot silently no-op, and `.active-session-model` is a
 * real post-boot signal. Still Claude-native (the unmodified CLI's `--model`
 * flag, no API/SDK). The switch is session-scoped — it lasts until the next
 * restart, then reverts to the configured `model:`; persisting requires
 * `model:` in switchroom.yaml (cascade), which the reply spells out. The cost
 * is a ~30s fresh session (Hindsight memory + the handoff briefing carry
 * context); no `--continue`/`--resume`.
 *
 * Split parser/handler shape mirrors `auth-command.ts` so the logic is
 * unit-testable without booting the bot.
 */

import {
  type DiscoverResult,
  type ModelPickerOption,
} from '../../src/agents/model-picker.js'

/**
 * Aliases the claude CLI resolves natively (`claude --help`: "an alias for
 * the latest model (e.g. 'fable', 'opus', or 'sonnet')"). Listed in help
 * text only — the handler does NOT restrict to these (a full model id like
 * `claude-opus-4-8` passes through and claude itself validates it, so new
 * aliases/models work without a switchroom release).
 *
 * `fable` is the latest flagship (Fable 5) — kept selectable here on
 * purpose. NB the alias is NOT the full codename: `claude-fable-5` (a
 * pinned pre-launch id) was retired server-side and 4xx'd the whole fleet
 * on 2026-06-13, while the `fable` alias keeps resolving to the current
 * model. Aliases are the durable way to pick a model — see the model
 * regression tests.
 */
export const MODEL_ALIASES = ['opus', 'sonnet', 'haiku', 'fable', 'default'] as const

/**
 * Shape gate for the model argument. This string is typed literally
 * into the agent's tmux pane, so the gate is strict by construction:
 * one token, alphanumeric start, then alphanumerics plus the chars
 * that appear in real model ids (`.` `_` `-` `/` and the `[1m]`-style
 * variant brackets). `/` is allowed for OpenRouter-style
 * `sr-vendor/model` ids; it is not a shell metachar inside the
 * double-quoted `claude --model "$_EFFECTIVE_MODEL"` usage, so it can't
 * break the launch. No whitespace means no second token can ride
 * along; no control characters means no newline/Enter smuggling.
 */
const MODEL_ARG_RE = /^[A-Za-z0-9][A-Za-z0-9._/\[\]-]{0,99}$/

export function isValidModelArg(arg: string): boolean {
  return MODEL_ARG_RE.test(arg)
}

/** True when `name` is an sr-* (LiteLLM/OpenRouter) model identifier. */
export function isSrModel(name: string): boolean {
  return name.startsWith('sr-')
}

/**
 * True when `name` is a Claude model — either a well-known alias or a
 * full `claude-*` id (including `[1m]` variants). This is intentionally
 * broader than MODEL_ALIASES: any `claude-…` string from claude's own
 * picker (e.g. `claude-opus-4-8`) qualifies.
 */
export function isClaudeModel(name: string): boolean {
  const lower = name.toLowerCase()
  if ((MODEL_ALIASES as readonly string[]).includes(lower)) return true
  return lower.startsWith('claude-')
}

/**
 * The outcome of a `/model` apply-boot, derived purely from the DETERMINISTIC
 * post-boot signals (never optimistic):
 *
 *   - `reason`     — the clean-shutdown marker reason that keyed this boot as a
 *                    `/model` apply-boot, e.g.
 *                    `user: /model fable (session-only relaunch, menu)`.
 *   - `launched`   — the contents of `.active-session-model`: the model start.sh
 *                    actually passed to `claude --model` this boot.
 *   - `configured` — the resolved configured default model.
 *
 * Three outcomes:
 *   - `applied`      — the launched model differs from the configured default, so
 *                      the switch landed (a session-only override).
 *   - `default`      — the operator asked for the configured default (`/model
 *                      default`, or `/model <configured>`) and got it.
 *   - `not-applied`  — the operator asked for a NON-default model, but the boot
 *                      came back on the configured default: the switch SILENTLY
 *                      failed to apply. The consume-once carrier was consumed by a
 *                      boot that never launched the target (e.g. a wedged apply-boot
 *                      that hit boot.lock_stale_recovered_boot_mismatch and reverted
 *                      to the default). This is the case that previously emitted a
 *                      MISLEADING green "✅ Now running <default> (the configured
 *                      default)" card with no signal that the requested switch was
 *                      lost. It self-corrects across boots: a later boot that
 *                      genuinely launches the target reports `applied`.
 */
export type ModelSwitchConfirmation =
  | { kind: 'applied'; launched: string }
  | { kind: 'default'; launched: string }
  | { kind: 'not-applied'; target: string; revertedTo: string }

/**
 * Extract the requested `/model <target>` token from a clean-shutdown reason
 * (e.g. `user: /model fable (session-only relaunch, menu)` → `fable`). Returns
 * null when the reason carries no `/model <token>` (a non-switch reason).
 */
export function parseModelSwitchTarget(reason: string): string | null {
  const m = reason.match(/\/model\s+(\S+)/)
  return m ? m[1] : null
}

/**
 * Reduce a model token to a comparable FAMILY key so an alias and its resolved
 * full id compare equal (`sonnet` ≡ `claude-sonnet-5` ≡ `claude-sonnet-5-<date>`).
 *
 * This is the normalization the silent-revert classifier needs: `target` from
 * the clean-shutdown reason is the RAW user token (an alias like `sonnet`),
 * while `.active-session-model` / the configured default may be the RESOLVED
 * full id start.sh wrote on a revert-with-alert path (config-default-changed at
 * start.sh.hbs:1228, proxy-down at :1234). A naive string compare would flag
 * `/model sonnet` on a `claude-sonnet-5`-default agent as "didn't apply" even
 * though sonnet IS the default.
 *
 * NB `resolveMainModel` (scaffold.ts:1358) is NOT sufficient here — it only
 * remaps the `default` alias / unset to the switchroom default; it passes
 * `sonnet`/`opus`/etc. through unchanged. The alias↔full-id equivalence is a
 * FAMILY reduction (same rule model-label.ts uses one-way), done here:
 *   - `claude-<family>-…` → `<family>`  (e.g. `claude-sonnet-5` → `sonnet`)
 *   - a bare alias / any other token     → itself, lowercased (`sonnet`, `sr-glm-5`)
 * sr-* ids never carry a `claude-` prefix, so they stay verbatim — correct,
 * since the reason token and `.active-session-model` both hold the same
 * already-expanded sr-* id and compare equal directly.
 */
export function modelFamilyToken(token: string): string {
  const t = token.trim().toLowerCase()
  if (t.startsWith('claude-')) {
    const family = t.slice('claude-'.length).split('-').filter((p) => p.length > 0)[0]
    return family ?? t
  }
  return t
}

/**
 * Classify a `/model` apply-boot outcome from the post-boot signals. Pure so the
 * confirmation-card decision is unit-testable without booting the gateway. The
 * `not-applied` branch is the fix for the silent-revert bug: a non-default switch
 * that reverted to the configured default must warn, not print a green ✅.
 */
export function classifyModelSwitchConfirmation(input: {
  reason: string
  launched: string
  configured: string
}): ModelSwitchConfirmation {
  const { reason, launched, configured } = input
  const isApplyBoot = launched.length > 0 && launched !== configured
  if (isApplyBoot) return { kind: 'applied', launched }
  // launched === configured (or empty): either an intended default/revert, or a
  // NON-default switch that silently reverted to the configured default.
  const target = parseModelSwitchTarget(reason)
  const revertedTo = launched.length > 0 ? launched : configured
  // Family-normalize both sides so an alias target (`sonnet`) matches its
  // resolved full-id revert (`claude-sonnet-5`) — otherwise a `/model sonnet`
  // that reverted to the sonnet default would emit a WRONG "didn't apply" card.
  if (
    target != null &&
    target.toLowerCase() !== 'default' &&
    modelFamilyToken(target) !== modelFamilyToken(revertedTo)
  ) {
    return { kind: 'not-applied', target, revertedTo }
  }
  return { kind: 'default', launched: revertedTo }
}

/**
 * Diagnostic stderr lines for a /model apply-boot rehydration.
 * Pure strings so gateway.ts stays thin (line-ratchet #2996).
 */
export function formatModelRelaunchDiagLog(input: {
  agent: string
  launched: string
  configured: string
  confirmation: ModelSwitchConfirmation | null
  isApplyBoot: boolean
}): string {
  const { agent, launched, configured, confirmation, isApplyBoot } = input
  const L = launched || '(none)'
  if (confirmation == null) {
    return (
      'telegram gateway: gw /model relaunch applied agent=' +
      agent +
      ' launched=' +
      L +
      ' configured=' +
      configured +
      ' override=' +
      (isApplyBoot ? 'set' : 'cleared') +
      '\n'
    )
  }
  if (confirmation.kind === 'not-applied') {
    return (
      'telegram gateway: gw /model relaunch NOT-APPLIED agent=' +
      agent +
      ' target=' +
      confirmation.target +
      ' launched=' +
      L +
      ' configured=' +
      configured +
      ' revertedTo=' +
      confirmation.revertedTo +
      '\n'
    )
  }
  if (confirmation.kind === 'applied') {
    return (
      'telegram gateway: gw /model relaunch applied agent=' +
      agent +
      ' launched=' +
      L +
      ' configured=' +
      configured +
      ' override=set outcome=applied\n'
    )
  }
  return (
    'telegram gateway: gw /model relaunch applied agent=' +
    agent +
    ' launched=' +
    L +
    ' configured=' +
    configured +
    ' override=cleared outcome=default\n'
  )
}

/** Telegram body for the single switch-confirmation card (F1/N4). */
export function formatModelSwitchConfirmationBody(
  confirmation: ModelSwitchConfirmation,
): string {
  if (confirmation.kind === 'applied') {
    return (
      '✅ Now running `' +
      confirmation.launched +
      '` — session-only, reverts to the configured model on the next restart. Fresh session; memory and the handoff briefing carry the context.'
    )
  }
  if (confirmation.kind === 'not-applied') {
    return (
      "⚠️ Your switch to `" +
      confirmation.target +
      "` didn't apply — the agent reverted to `" +
      confirmation.revertedTo +
      "` (the apply-boot didn't complete). Re-issue `/model " +
      confirmation.target +
      "` to try again."
    )
  }
  return (
    '✅ Now running `' +
    confirmation.launched +
    '` (the configured default) — fresh session; memory and the handoff briefing carry the context.'
  )
}

export function formatModelRelaunchSuppressNotAppliedLog(input: {
  agent: string
  target: string
}): string {
  return (
    'telegram gateway: gw /model relaunch NOT-APPLIED — suppressing not-applied confirmation (a .session-model-alert is present and will be relayed) agent=' +
    input.agent +
    ' target=' +
    input.target +
    '\n'
  )
}

/**
 * The single boot-time notification decision for a classified /model switch
 * (#3427 item 2): either the ONE confirmation card (green applied/default or
 * the ⚠️ not-applied warn), or — LOW-2 dedup — a suppress log when start.sh
 * wrote a TAILORED `.session-model-alert` for this boot that already explains
 * why the switch didn't apply (the alert relay is the more specific message,
 * so the generic not-applied card would double-warn). Pure so the decision is
 * unit-testable end-to-end (classify → notice) without booting the gateway;
 * gateway.ts only sends `card` bodies / writes `suppress` logs.
 */
export type ModelSwitchBootNotice =
  | { kind: 'card'; body: string }
  | { kind: 'suppress'; log: string }

export function resolveModelSwitchBootNotice(input: {
  agent: string
  confirmation: ModelSwitchConfirmation
  hasSessionModelAlert: boolean
}): ModelSwitchBootNotice {
  const { agent, confirmation, hasSessionModelAlert } = input
  if (confirmation.kind === 'not-applied' && hasSessionModelAlert) {
    return {
      kind: 'suppress',
      log: formatModelRelaunchSuppressNotAppliedLog({ agent, target: confirmation.target }),
    }
  }
  return { kind: 'card', body: formatModelSwitchConfirmationBody(confirmation) }
}

/**
 * Requested-vs-served divergence gate (#3427 item 4). `--fallback-model` masks
 * a shape-valid but UNKNOWN requested Claude id: claude silently serves the
 * fallback while `.active-session-model` (and the boot confirmation) carry the
 * requested token, until the first assistant transcript line reclaims /status.
 * That window used to self-heal SILENTLY — the operator was never told their
 * requested id was bogus. This comparator lets the session-model source flag
 * the divergence deterministically at the FIRST possible post-launch signal
 * (the first assistant line's `message.model`).
 *
 * Deliberately conservative — return true ("matches") whenever the pair is not
 * DETERMINISTICALLY comparable, so a false accusation is impossible:
 *   - served non-`claude-*` ids (sr-* / LiteLLM-mapped names) are skipped: the
 *     proxy may echo an alias, a mapped id, or the raw route name;
 *   - a requested alias (opus/sonnet/haiku/fable) family-matches its resolved
 *     full id (`sonnet` ≡ `claude-sonnet-5-…`) via modelFamilyToken;
 *   - a requested full `claude-*` id must be served exactly, or as a
 *     date-stamped descendant (`claude-sonnet-5` ≡ `claude-sonnet-5-20260203`);
 *   - anything else (sr-* requests, legacy friendly labels like "Opus 4.8")
 *     is not comparable → true.
 */
export function servedModelMatchesRequested(requested: string, served: string): boolean {
  const req = requested.trim().toLowerCase()
  const srv = served.trim().toLowerCase()
  if (!srv.startsWith('claude-')) return true
  if ((MODEL_ALIASES as readonly string[]).includes(req)) {
    if (req === 'default') return true
    if (modelFamilyToken(srv) === req) return true
    // L3 (#3437 review): legacy id shapes put the family AFTER the version
    // (`claude-3-opus-20240229` → first segment "3", not "opus"). Accept any
    // dash-segment equal to the alias — widens toward "match" only, so it can
    // suppress a real accusation in weird shapes but never create a false one.
    return srv.slice('claude-'.length).split('-').includes(req)
  }
  if (req.startsWith('claude-')) {
    return srv === req || srv.startsWith(req + '-')
  }
  return true
}

/**
 * Greppable stderr line for a requested-vs-served divergence (#3427 item 4).
 * Names BOTH candidate causes (M2): `--fallback-model` substitutes for an
 * invalid/unknown id AND for a transiently-unavailable one — the signal alone
 * cannot distinguish them, so the log must not assert "invalid".
 */
export function formatServedModelDivergenceLog(input: {
  agent: string
  requested: string
  served: string
}): string {
  return (
    'telegram gateway: gw /model served-model DIVERGENCE agent=' +
    input.agent +
    ' requested=' +
    input.requested +
    ' served=' +
    input.served +
    ' (--fallback-model substituted: requested id invalid/unknown OR model transiently unavailable)\n'
  )
}

/** Operator card for a requested-vs-served divergence (#3427 item 4, M2-softened). */
export function formatServedModelDivergenceCard(input: {
  requested: string
  served: string
}): string {
  return (
    '⚠️ The first reply was served by `' +
    input.served +
    '`, not the requested `' +
    input.requested +
    '` — claude substituted the fallback model. Either the requested id is invalid/unknown, or the model was temporarily unavailable for that call (a transient substitution self-corrects on later replies). If it persists, re-issue `/model <valid id>` or `/model default`. `/status` always shows the model actually serving calls.'
  )
}

/** The boot marker chat that initiated a /model switch (thread-aware). */
export interface ModelBootCardTarget {
  chatId: string
  threadId: number | null
}

/**
 * Injected side-effect surface for the boot-time /model cards (#3427): the
 * served-model divergence warn and the switch confirmation share ONE raw
 * Markdown send closure plus a stderr log sink. Lives here (not inline in
 * gateway.ts's boot IIFE) so gateway.ts does not inflate (#2996 ratchet).
 */
export interface ModelBootCardDeps {
  agent: string
  /** null → no initiating chat known; cards are skipped, logs still write. */
  chat: ModelBootCardTarget | null
  log: (line: string) => void
  sendCard: (
    chatId: string,
    body: string,
    opts: { parse_mode: 'Markdown'; message_thread_id?: number },
  ) => Promise<unknown>
}

/** One-shot fire-and-forget card to the marker chat; send failures log, never throw. */
function sendModelBootCard(deps: ModelBootCardDeps, chat: ModelBootCardTarget, body: string, failLabel: string): void {
  void deps
    .sendCard(chat.chatId, body, {
      parse_mode: 'Markdown',
      ...(chat.threadId != null ? { message_thread_id: chat.threadId } : {}),
    })
    .catch((err: unknown) =>
      deps.log(`telegram gateway: ${failLabel} send failed: ${(err as Error)?.message ?? String(err)}\n`),
    )
}

/**
 * Build the divergence-tripwire handler gateway.ts registers at the boot
 * rehydration site (#3427 item 4): the first LIVE assistant line serving a
 * different model (invalid id OR transient unavailability — --fallback-model
 * substituted) logs + warns the operator. The override is KEPT (M2): freshness
 * rules already make /status show the served model, and a transient
 * substitution self-corrects without destroying the switch record.
 */
export function buildServedModelDivergenceHandler(
  deps: ModelBootCardDeps,
): (d: { requested: string; served: string }) => void {
  return (d) => {
    deps.log(formatServedModelDivergenceLog({ agent: deps.agent, requested: d.requested, served: d.served }))
    if (deps.chat == null) return
    sendModelBootCard(deps, deps.chat, formatServedModelDivergenceCard(d), 'served-model divergence')
  }
}

/**
 * Deliver the boot-time model-switch confirmation (#3427 item 2): resolve the
 * card-vs-suppress decision (pure — resolveModelSwitchBootNotice) and either
 * log the suppress line or send the card. No-op when no initiating chat is
 * known — matching the pre-extraction inline gateway.ts behavior (the
 * suppress log only ever wrote when a marker chat existed).
 */
export function deliverModelSwitchBootNotice(
  deps: ModelBootCardDeps & { confirmation: ModelSwitchConfirmation; hasSessionModelAlert: boolean },
): void {
  if (deps.chat == null) return
  const notice = resolveModelSwitchBootNotice({
    agent: deps.agent,
    confirmation: deps.confirmation,
    hasSessionModelAlert: deps.hasSessionModelAlert,
  })
  if (notice.kind === 'suppress') {
    deps.log(notice.log)
    return
  }
  sendModelBootCard(deps, deps.chat, notice.body, 'model-switch confirmation')
}

export type ParsedModelCommand =
  | { kind: 'show' }
  | { kind: 'set'; model: string }
  | { kind: 'help'; reason?: string }

/**
 * Parse a `/model` message. Returns null when the text isn't a /model
 * command at all (caller bug — bot.command should pre-filter).
 */
export function parseModelCommand(text: string): ParsedModelCommand | null {
  const m = text.match(/^\/model(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/)
  if (!m) return null
  const rest = (m[1] ?? '').trim()
  if (rest.length === 0) return { kind: 'show' }
  const parts = rest.split(/\s+/)
  if (parts.length > 1) {
    return { kind: 'help', reason: 'model takes a single argument' }
  }
  const arg = parts[0]
  if (arg.toLowerCase() === 'help') return { kind: 'help' }
  if (!isValidModelArg(arg)) {
    return { kind: 'help', reason: `not a valid model name: ${arg}` }
  }
  return { kind: 'set', model: arg }
}

/**
 * The busy state a typed `/model` disposition is decided against. Two
 * independent signals are folded here (#3177): `currentTurnActive` is the
 * gateway's per-turn atom (`currentTurn !== null`), which is NULLED at
 * `turn_end`; `turnInFlight` is the authoritative delivery-machine +
 * pending-approval gate (`turnInFlightForGate()`). The atom can read idle
 * while the session is still busy (the "recovered-late" / premature-turn-end
 * window seen in finn's 2026-07-12 log), so a switch decided on the atom ALONE
 * takes the direct-inject path and types `/model <name>` into a still-busy
 * pane, where claude swallows it as literal text — a silent no-op. Folding
 * BOTH signals means a session busy by EITHER measure ack+queues instead.
 */
export interface ModelCommandContext {
  /** Gateway per-turn atom is non-null (`currentTurn !== null`). */
  currentTurnActive: boolean
  /** Authoritative busy gate (`turnInFlightForGate()`): machine-in-turn OR a pending approval. */
  turnInFlight: boolean
  /** Interactive picker menu is enabled (`SWITCHROOM_MODEL_MENU !== '0'`). */
  menuEnabled: boolean
}

/**
 * True when the session is busy by EITHER busy signal. A typed `/model` set
 * MUST NOT take the direct-inject path while this holds — it would type into a
 * busy pane and be swallowed as text. See ModelCommandContext.
 */
export function isModelCommandBusy(ctx: Pick<ModelCommandContext, 'currentTurnActive' | 'turnInFlight'>): boolean {
  return ctx.currentTurnActive || ctx.turnInFlight
}

/**
 * Raw busy signals for a `/model` or `/effort` command, PLUS the ages needed
 * to tell a live signal from a stale/dangling one (#3262). Pure + clock-free
 * (ages are passed in) so the apply-vs-queue outcome is unit-testable with the
 * same clock-injection pattern as the marker-sweep tests.
 */
export interface StaleAwareBusyInput {
  /** The in-memory turn atom is non-null (`currentTurn !== null`). */
  currentTurnActive: boolean
  /**
   * Age (ms) of the live turn: the turn-active liveness marker's mtime age
   * (touched on every tool_use / sub-agent activity), falling back to
   * `now - turn.startedAt` when the marker is absent. Null ONLY when there is
   * no live turn (`currentTurnActive` false). A large age on a non-null atom
   * means the `turn_end` that should have cleared it never fired — a phantom.
   */
  turnAgeMs: number | null
  /**
   * Machine-in-turn signal WITHOUT the pending-approval hold — the authoritative
   * "claude is actively producing a turn" gate (`turnInFlightForGate()` minus
   * its `pendingPermissions` leg).
   */
  machineInTurn: boolean
  /**
   * Age (ms) of the OLDEST outstanding pending approval, or null when there are
   * none. A wedged / undeliverable approval "never expires by design" (#3084)
   * and would otherwise hold the gate closed forever on an idle session.
   */
  oldestPendingApprovalAgeMs: number | null
  /** Hard TTL ceiling (ms) — reuse `TURN_ACTIVE_HARD_TTL_MS`, do not invent one. */
  hardTtlMs: number
}

export interface StaleAwareBusy {
  /** The turn atom, with a stale (older-than-TTL) atom discounted to idle. */
  currentTurnActive: boolean
  /** The gate: machine-in-turn OR a pending approval still within the TTL. */
  turnInFlight: boolean
  /**
   * True when the atom was judged STALE (non-null but older than the hard TTL).
   * The gateway caller clears the dangling atom when this is set so the phantom
   * doesn't re-block the next command either.
   */
  clearStaleTurn: boolean
}

/**
 * Fold the raw busy signals into an apply-vs-queue decision that treats a turn
 * atom OR a pending approval older than the hard TTL as STALE — a dangling atom
 * / wedged approval, not a live turn (#3262). A genuinely fresh turn (recent
 * marker) and a recent pending approval still read busy, preserving the
 * #3017/#3039 apply-or-queue contract; only a stale signal is discounted.
 */
export function resolveStaleAwareBusy(input: StaleAwareBusyInput): StaleAwareBusy {
  const turnStale =
    input.currentTurnActive &&
    input.turnAgeMs !== null &&
    input.turnAgeMs > input.hardTtlMs
  const approvalLive =
    input.oldestPendingApprovalAgeMs !== null &&
    input.oldestPendingApprovalAgeMs <= input.hardTtlMs
  return {
    currentTurnActive: input.currentTurnActive && !turnStale,
    turnInFlight: input.machineInTurn || approvalLive,
    clearStaleTurn: turnStale,
  }
}

/**
 * What the gateway should do with a parsed `/model` command. Pure so the
 * routing decision is unit-testable without booting the bot. Every parsed
 * shape maps to exactly one visible action — there is NO branch that silently
 * does nothing (the #3177 swallow):
 *
 *  - `menu`  — bare `/model` with the picker enabled → render the dashboard.
 *  - `queue` — a `set` while busy (by EITHER signal) → ack + enqueue for
 *              apply-on-idle. `target` is the alias-expanded token.
 *  - `apply` — run the handler now (idle `set`, or `show`/`help` text paths).
 */
export type ModelCommandDisposition =
  | { kind: 'menu' }
  | { kind: 'queue'; target: string }
  | { kind: 'apply'; parsed: ParsedModelCommand }

export function planModelCommand(
  parsed: ParsedModelCommand,
  ctx: ModelCommandContext,
): ModelCommandDisposition {
  if (parsed.kind === 'show' && ctx.menuEnabled) return { kind: 'menu' }
  if (parsed.kind === 'set' && isModelCommandBusy(ctx)) {
    return { kind: 'queue', target: expandSrAlias(parsed.model) }
  }
  return { kind: 'apply', parsed }
}

/**
 * The unconditional durable log line the gateway writes at `/model` entry,
 * BEFORE any branch or reply attempt (#3177 guarantee (b)). Even if every
 * downstream reply is shed/dropped, this line — plus the paired history row —
 * guarantees a typed `/model` is never invisible. Kept pure + shape-stable so
 * the format is testable and greppable (`grep 'gw /model received'`).
 */
export function modelCommandReceiptLine(
  agent: string,
  parsed: ParsedModelCommand,
  busy: boolean,
): string {
  const arg =
    parsed.kind === 'set' ? parsed.model
      : parsed.kind === 'show' ? '(show)'
        : '(help)'
  return `telegram gateway: gw /model received agent=${agent} kind=${parsed.kind} arg=${arg} busy=${busy}`
}

export interface ModelCommandDeps {
  /**
   * True while the agent is mid-turn. A typed `/model <name>` switch drives
   * claude's session (either an inject into the input box, or a carrier-backed
   * restart) — doing either mid-turn is unsafe: an inject queues `/model` as
   * user text instead of switching, and a restart would tear down the live
   * turn. So the set path refuses when this is true and asks the operator to
   * retry, exactly like the menu callback path (`ModelMenuDeps.isBusy`).
   */
  isBusy: () => boolean
  getAgentName: () => string
  /**
   * The agent's configured model from `switchroom agent list` (the
   * cascade-resolved `model:` field). Null when unset / unreadable —
   * rendered as "default".
   */
  getConfiguredModel: () => string | null
  escapeHtml: (s: string) => string
  preBlock: (s: string) => string
  /**
   * Schedule a graceful restart of this agent. Called instead of inject
   * when switching from an sr-* model back to Claude — the restart clears
   * the sr-* session context cleanly, whereas an in-place inject would
   * leave LiteLLM routing active. The gateway wires this to the same
   * mechanism as the `/restart` command (hostd-first, SIGTERM fallback).
   */
  scheduleRestart: (reason: string) => Promise<void>
  /**
   * Schedule a session-only switch TO a non-Claude (`sr-*` LiteLLM/OpenRouter)
   * model. claude's in-REPL `/model` picker rejects unknown `sr-*` ids, so an
   * inject can't set them. Instead the gateway writes the chosen token to the
   * durable `.session-model` override and gracefully restarts the agent;
   * the next boot launches `claude --model <token>` directly (LiteLLM routes
   * it, no picker validation). Session-only: reverts to the configured default
   * on the following restart. Wired to the same restart dispatch as
   * `scheduleRestart`, plus the carrier write. `model` is the full `sr-*` id
   * (already alias-expanded); `reason` is stamped as the restart reason.
   *
   * Rev 5 (deterministic switch): EVERY `/model` switch — Claude→Claude,
   * Claude→sr-*, sr-*→Claude, the Fable/alias button, and the picker SELECT —
   * routes through here. The inject-into-tmux + terminal-scrape path is retired,
   * so a switch can no longer silently no-op or optimistically lie to /status:
   * start.sh's `exec claude --model <token>` cannot silently no-op, and the
   * post-boot `.active-session-model` signal is what /status reflects.
   */
  scheduleModelRelaunch: (model: string, reason: string) => Promise<void>
  /**
   * Revert TO the configured default (`/model default`) via a relaunch. Clears
   * the consume-once `.session-model` carrier + the in-memory override, then
   * relaunches so the LIVE session actually reverts to `switchroom.yaml model:`
   * (rev 5: with inject retired, a relaunch is the only way to make `default`
   * take effect live — consistent with "all switches relaunch"). Mirrors
   * scheduleModelRelaunch's careful rollback: a `restart_in_flight` throw keeps
   * the cleared state (the in-flight boot reverts anyway); any other dispatch
   * failure restores the prior carrier + override.
   */
  scheduleModelDefaultRelaunch: (reason: string) => Promise<void>
}

export interface ModelCommandReply {
  text: string
  html: true
  /**
   * Rev 5: a `/model` switch NEVER carries a live-model field. The inject +
   * terminal-scrape path that produced an optimistic `selectedModel` is retired.
   * Every switch relaunches through `scheduleModelRelaunch`, which owns the
   * in-memory override write for the restart window; the ACTUAL running model is
   * reconciled at boot from `.active-session-model` (and by the transcript's
   * `message.model`), never optimistically asserted from a scraped pane. So
   * there is no `selectedModel`/`optimistic` here to lie to /status with.
   */
}

const PERSIST_NOTE =
  '_A `/model` switch relaunches the session (~30s) on the chosen model. Session-only — reverts to the configured \`model:\` on the next restart. \`/model default\` reverts now. Live scrollback is replaced by a fresh session; memory and the handoff briefing carry the context. To change the default permanently, set \`model:\` in switchroom.yaml._'

function helpText(deps: ModelCommandDeps, reason?: string): ModelCommandReply {
  const srAliasExamples = Object.keys(SR_MODEL_ALIASES).map(a => `\`${a}\``).join(' · ')
  const lines: string[] = []
  if (reason) lines.push(`⚠️ ${deps.escapeHtml(reason)}`)
  lines.push(
    '**/model** — show or switch the Claude model',
    '\`/model\` — show the configured model',
    `\`/model <name>\` — switch the live session (${MODEL_ALIASES.map(a => `\`${a}\``).join(' · ')} or a full model id)`,
    `_OpenRouter shortcuts:_ ${srAliasExamples}`,
    '_Every switch relaunches the session (~30s) on the chosen model — Claude and OpenRouter (sr-\\*) alike._',
    PERSIST_NOTE,
  )
  return { text: lines.join('\n'), html: true }
}

export async function handleModelCommand(
  parsed: ParsedModelCommand,
  deps: ModelCommandDeps,
): Promise<ModelCommandReply> {
  if (parsed.kind === 'help') return helpText(deps, parsed.reason)

  if (parsed.kind === 'show') {
    const configured = deps.getConfiguredModel()
    const shown = configured && configured.length > 0 ? configured : 'default'
    const srAliasExamples = Object.keys(SR_MODEL_ALIASES).map(a => `\`/model ${a}\``).join(' · ')
    return {
      text: [
        `**Model — ${deps.escapeHtml(deps.getAgentName())}**`,
        `Configured: \`${deps.escapeHtml(shown)}\``,
        `Switch the live session: ${MODEL_ALIASES.map(a => `\`/model ${a}\``).join(' · ')}`,
        `OpenRouter shortcuts: ${srAliasExamples}`,
        'or \`/model <full-model-id>\`',
        PERSIST_NOTE,
      ].join('\n'),
      html: true,
    }
  }

  // kind === 'set' — re-gate at the seam so a caller that skipped the
  // parser can't type arbitrary keys into the pane.
  if (!isValidModelArg(parsed.model)) {
    return helpText(deps, `not a valid model name: ${parsed.model}`)
  }

  // Expand short aliases: `flash` → `sr-gemini-2.5-flash`, `codex` → `sr-codex-5.5`, etc.
  const model = expandSrAlias(parsed.model)

  // Busy gate: a switch RELAUNCHES the session, which is unsafe mid-turn (it
  // would tear down the live turn). The gateway's mid-turn path ACKs + queues +
  // applies-on-idle before this handler is reached; this is the belt-and-braces
  // seam for a caller that skipped it.
  if (deps.isBusy()) {
    return {
      text: '⏳ The agent is mid-turn — a model switch needs an idle session. The switch was not applied.',
      html: true,
    }
  }

  // Rev 5 (deterministic switch): route EVERY target through the consume-once
  // `.session-model` carrier relaunch. `default` clears the carrier + override
  // and relaunches so the live session reverts to the configured `model:`; any
  // other token — Claude alias/id, sr-*, Fable — is carried and applied by
  // start.sh's `exec claude --model <token>`. The inject-into-tmux +
  // terminal-scrape path is RETIRED: a switch can no longer silently no-op or
  // optimistically lie to /status (start.sh cannot silently no-op, and the
  // post-boot `.active-session-model` signal is the source of truth).
  if (model.toLowerCase() === 'default') {
    return scheduleDefaultRelaunchReply(deps, 'user: /model default (revert relaunch)')
  }
  return scheduleRelaunchReply(deps, model, `user: /model ${model} (session-only relaunch)`)
}

/** The one-line ack shown while a switch relaunches (~30s). */
function switchingLine(deps: Pick<ModelCommandDeps, 'escapeHtml'>, model: string): string {
  const friendly = isSrModel(model) ? srFriendlyLabel(model) : model
  return `🔄 Switching to \`${deps.escapeHtml(friendly)}\` — relaunching the session (~30s).`
}

/** Map a relaunch-dispatch error to an honest reply (debounce vs failure). */
function relaunchErrorReply(
  deps: Pick<ModelCommandDeps, 'escapeHtml'>,
  model: string,
  err: unknown,
): ModelCommandReply {
  if (isRestartInFlight(err)) {
    return {
      text: `⏳ A restart is already in flight — your switch to \`${deps.escapeHtml(model)}\` will apply as it completes (~15s).`,
      html: true,
    }
  }
  const msg = err instanceof Error ? err.message : String(err)
  return { text: `❌ Could not schedule model switch: ${deps.escapeHtml(msg)}`, html: true }
}

/**
 * Fail-fast caveat (#3427 item 4) for a free-text full `claude-*` id: the
 * gateway cannot pre-validate an arbitrary id against the API (Claude-native
 * constraint — no raw API probes), so if the id is bogus `--fallback-model`
 * silently serves the fallback. Say so IMMEDIATELY in the switch ack, and
 * point at the first-reply tripwire that will catch it. Aliases and sr-* ids
 * are vouched by their own gates (MODEL_ALIASES / the LiteLLM route probe),
 * so only typed `claude-*` ids carry the caveat. Exported for tests.
 */
export function unvalidatedIdCaveat(
  deps: Pick<ModelCommandDeps, 'escapeHtml'>,
  model: string,
): string | null {
  if (!model.trim().toLowerCase().startsWith('claude-')) return null
  return `_\`${deps.escapeHtml(model)}\` can't be validated before launch — if it isn't a real Claude model id, claude will silently serve the configured fallback model instead. I check the first reply and will warn if that happens._`
}

/** Schedule a carrier relaunch onto `model`, returning the deterministic ack. */
async function scheduleRelaunchReply(
  deps: ModelCommandDeps,
  model: string,
  reason: string,
): Promise<ModelCommandReply> {
  try {
    await deps.scheduleModelRelaunch(model, reason)
  } catch (err) {
    return relaunchErrorReply(deps, model, err)
  }
  const caveat = unvalidatedIdCaveat(deps, model)
  return {
    text: [switchingLine(deps, model), ...(caveat ? [caveat] : []), PERSIST_NOTE].join('\n'),
    html: true,
  }
}

/** Schedule the `/model default` clear + revert relaunch, returning its ack. */
async function scheduleDefaultRelaunchReply(
  deps: ModelCommandDeps,
  reason: string,
): Promise<ModelCommandReply> {
  try {
    await deps.scheduleModelDefaultRelaunch(reason)
  } catch (err) {
    return relaunchErrorReply(deps, 'default', err)
  }
  return {
    text: [
      '🔄 Reverting to the configured default model — relaunching the session (~30s).',
      PERSIST_NOTE,
    ].join('\n'),
    html: true,
  }
}

// ---------------------------------------------------------------------------
// Picker-driven model menu (v2) — discovery, render, callback selection.
// ---------------------------------------------------------------------------

export interface ModelMenuDeps {
  /**
   * Live picker discovery — src/agents/model-picker.ts discoverModels. Used ONLY
   * to RENDER the model list (buildModelMenu); rev 5 retired the terminal-driving
   * `select` from the switch path, so discovery no longer applies a switch.
   */
  discover: (agent: string) => Promise<DiscoverResult>
  /**
   * True while the agent is mid-turn. Driving the picker (for RENDER) types into
   * claude's input box; doing that mid-turn would queue "/model" as
   * user text instead of opening the modal — refuse instead.
   */
  isBusy: () => boolean
  getAgentName: () => string
  /** One-line quota summary (e.g. "29% / 5h · 33% / 7d") or null. */
  getQuotaBrief: () => Promise<string | null>
  /**
   * Fetch sr-* model names available via LiteLLM for this agent.
   * Returns [] when LiteLLM is not configured or the probe fails.
   */
  discoverSrModels: () => Promise<string[]>
  escapeHtml: (s: string) => string
}

/** Raw Telegram inline-keyboard shape (grammY accepts it verbatim). */
export interface ModelMenuKeyboardButton {
  text: string
  callback_data: string
}

export interface ModelMenuReply {
  text: string
  html: true
  /** Rows of buttons; absent on the no-menu fallback. */
  keyboard?: ModelMenuKeyboardButton[][]
}

export const MODEL_CALLBACK_PREFIX = 'mdl:'
const MODEL_CALLBACK_SELECT = 'mdl:s:'
export const MODEL_CALLBACK_REFRESH = 'mdl:r'
/** Callback prefix for sr-* (LiteLLM non-Anthropic) model selection. */
export const MODEL_CALLBACK_SR = 'mdl:sr:'
/** Callback for section-header rows — shows an informational toast, no action. */
export const MODEL_CALLBACK_HEADER = 'mdl:h'
/**
 * Callback prefix for Claude aliases that the CLI picker doesn't render but
 * the CLI resolves natively (e.g. `fable`). Carries the alias verbatim; its
 * handler routes to the carrier relaunch (`scheduleModelRelaunch`) — the same
 * deterministic mechanism every switch uses (rev 5). `fable` boots via the
 * LiteLLM router repoint in start.sh (see the fable case there).
 */
export const MODEL_CALLBACK_ALIAS = 'mdl:alias:'
/** Callback: open the nested "External models" keyboard page. */
export const MODEL_CALLBACK_PAGE_EXTERNAL = 'mdl:page:ext'
/** Callback: return from the External page to the main keyboard page. */
export const MODEL_CALLBACK_PAGE_MAIN = 'mdl:page:main'

/** Which keyboard page the model menu is currently rendering. */
export type ModelMenuPage = 'main' | 'external'

/**
 * Static Claude aliases appended to the scraped Claude group. The claude CLI's
 * own `/model` picker (deps.discover) does NOT list `fable`, but the CLI
 * resolves the alias natively, so we render it as an extra button that switches
 * via the carrier relaunch (MODEL_CALLBACK_ALIAS → scheduleModelRelaunch, rev
 * 5). Extend this list to surface further CLI-resolvable aliases the picker
 * omits.
 */
export const EXTRA_CLAUDE_ALIASES: ReadonlyArray<{ alias: string; label: string }> = [
  { alias: 'fable', label: 'Fable' },
]

/**
 * Friendly display names for sr-* synthetic model names. An sr-* model in
 * LiteLLM has no entry in `model_group_settings.*.forward_client_headers_to_llm_api`
 * so the Anthropic OAuth credential is NEVER forwarded — safe to route to
 * OpenRouter. Names here are display-only (used by srFriendlyLabel for /status
 * and switch confirmations); the raw `sr-*` id is what gets injected into the
 * agent's session. This table is a SUPERSET of the menu-reachable set
 * (SR_MODEL_ALIASES): it also labels models that are only reachable by typing
 * the full `/model sr-<name>` (manual passthrough), so those still get a
 * friendly name without appearing as a keyboard button.
 * See reference/rfcs/litellm-max-subscription-invariants.md § I6.
 */
export const SR_MODEL_LABELS: Record<string, string> = {
  'sr-gemini-2.5-pro': 'Gemini 2.5 Pro',
  'sr-gemini-2.5-flash': 'Gemini 2.5 Flash',
  'sr-deepseek-r1': 'DeepSeek R1',
  'sr-deepseek-v3': 'DeepSeek V3',
  // sr-glm-5 now targets glm-5.2 in the live litellm config — label bumped to match.
  'sr-glm-5': 'GLM-5.2',
  'sr-codex-5.5': 'Codex 5.5',
  // OpenRouter coverage (pairs with the live litellm sr-* model_name additions).
  'sr-gpt-oss-20b': 'GPT-OSS 20B',
  'sr-gpt-oss-120b': 'GPT-OSS 120B',
  'sr-gpt-5.5': 'GPT-5.5',
  'sr-gpt-5-codex': 'GPT-5 Codex',
  'sr-gpt-5.2-codex': 'GPT-5.2 Codex',
  'sr-gemini-flash-lite': 'Gemini 3.1 Flash Lite',
  'sr-minimax-m3': 'MiniMax M3',
  'sr-deepseek-v4-flash': 'DeepSeek V4 Flash',
  // xAI Grok / Moonshot Kimi / OpenAI GPT-5.6 (added 2026-07-19, pairs with the
  // live litellm sr-* model_name additions). The `.5`/`.7`/`.6` version dots are
  // valid model-arg chars (MODEL_ARG_RE) and match the sr-* ids in the proxy config.
  'sr-grok-4.5': 'Grok 4.5',
  'sr-grok-4.3': 'Grok 4.3',
  'sr-kimi-k3': 'Kimi K3',
  'sr-kimi-k2.7-code': 'Kimi K2.7 Code',
  'sr-gpt-5.6-sol': 'GPT-5.6 Sol',
  'sr-gpt-5.6-terra': 'GPT-5.6 Terra',
  'sr-gpt-5.6-luna': 'GPT-5.6 Luna',
}

/**
 * Short text-command aliases for sr-* models. These let the operator type
 * `/model flash`, `/model codex`, etc. instead of the full `sr-*` id.
 * Expanded in handleModelCommand before injection; the full sr-* id is what
 * reaches the agent session and LiteLLM.
 */
export const SR_MODEL_ALIASES: Record<string, string> = {
  flash: 'sr-gemini-2.5-flash',
  gemini: 'sr-gemini-2.5-pro',
  deepseek: 'sr-deepseek-v3',
  r1: 'sr-deepseek-r1',
  glm: 'sr-glm-5',
  codex: 'sr-codex-5.5',
  // Flagship keyboard buttons for the three providers added 2026-07-19. Each
  // points at that provider's top tier; the cheaper tiers (grok-4.3,
  // kimi-k2.7-code, gpt-5.6-terra/luna) stay typeable via `/model sr-<id>` and
  // keep a friendly label above, matching the "labels are a superset of buttons"
  // design (SR_MODEL_LABELS doc comment).
  grok: 'sr-grok-4.5',
  kimi: 'sr-kimi-k3',
  gpt: 'sr-gpt-5.6-sol',
  // Per-tier buttons for the GPT-5.6 line so each is a one-word shortcut
  // (`gpt` stays the flagship-Sol default). Added 2026-07-19.
  sol: 'sr-gpt-5.6-sol',
  terra: 'sr-gpt-5.6-terra',
  luna: 'sr-gpt-5.6-luna',
}

/** Expand a short alias (case-insensitive) to its full sr-* id, or return the original. */
/**
 * #3042 review blocker 2a: can `token` be trusted for a boot-applied
 * `.session-model` carrier persist WITHOUT a live confirmation from claude?
 *
 * A queued typed `/model <arg>` that is persisted at shutdown was never
 * validated by claude's picker. Under the consume-once carrier (rev 4) a
 * garbage-but-shape-valid token (e.g. `claude-nonexistnet-9`) can crash at
 * most ONE boot before the carrier is gone and the agent reverts — but we
 * still avoid even that crash-boot. Only tokens with a switchroom-known
 * meaning are offline-trustable: the static Claude aliases (claude resolves
 * them itself) and the curated sr-* alias TARGETS (present in the LiteLLM
 * config by construction). Full `claude-*` / arbitrary `sr-*` ids typed by
 * hand are refused — they need the live session to verify, so the operator is
 * asked to re-issue after boot.
 */
export function isOfflineTrustedModelToken(token: string): boolean {
  // #3043 item 1: the live accept path normalizes case (isClaudeModel /
  // expandSrAlias lowercase before matching), so a queued `/model OPUS` is
  // accepted live — but this persist-time gate compared case-sensitively and
  // then refused it with the over-conservative "couldn't verify" card. Lowercase
  // once so the persist decision matches what the live path already accepted.
  const lower = token.toLowerCase()
  if ((MODEL_ALIASES as readonly string[]).includes(lower)) return true
  if (lower in SR_MODEL_ALIASES) return true
  return Object.values(SR_MODEL_ALIASES).includes(lower)
}

export function expandSrAlias(arg: string): string {
  return SR_MODEL_ALIASES[arg.toLowerCase()] ?? arg
}

export function srFriendlyLabel(srName: string): string {
  return SR_MODEL_LABELS[srName] ?? srName.replace(/^sr-/, '').replace(/-/g, ' ')
}

/**
 * Split picker-discovered options into native Claude options and sr-*
 * (LiteLLM non-Anthropic) options. Options with "/" in the label or
 * other non-native prefixes (e.g., "openrouter/...", "gpt-4") are
 * silently dropped — they're internal LiteLLM routing paths, not
 * user-facing switching targets.
 */
export function classifyDiscoveredOptions(options: ModelPickerOption[]): {
  claude: ModelPickerOption[]
  sr: ModelPickerOption[]
} {
  return {
    // Native Claude picker labels start with an uppercase letter (e.g.
    // "Default (recommended)", "Opus", "Sonnet") or with "claude-" for full
    // model IDs. This excludes sr-* names, internal routing paths
    // ("openrouter/..."), and non-Claude models exposed by GATEWAY_MODEL_DISCOVERY
    // ("gpt-4", "gpt-4o", "voyage-law-2", etc.) — those are LiteLLM internals
    // not meant as user-facing switching targets.
    claude: options.filter(
      (o) => !o.label.startsWith('sr-') && !o.label.includes('/') &&
        (/^[A-Z]/.test(o.label) || o.label.startsWith('claude-')),
    ),
    sr: options.filter((o) => o.label.startsWith('sr-')),
  }
}

export function modelSelectCallbackData(label: string): string {
  // Rev 5: embed the CANONICAL `claude --model` token directly, not a label
  // hash. A tap no longer needs live picker discovery to resolve the row — it
  // goes straight to the carrier relaunch (`mdl:s:<token>`), removing the last
  // terminal-driving step from the switch path.
  const token = canonicalClaudeToken(label)
  if (token) return `${MODEL_CALLBACK_SELECT}${token}`
  // The "Default (recommended)" row has no derivable token (`canonicalClaudeToken`
  // → null) — it carries the `default` sentinel so the tap routes to the
  // clear+revert relaunch.
  if (/^default\b/i.test(label.trim())) return `${MODEL_CALLBACK_SELECT}default`
  // N2: an UNMAPPED non-default Claude row (a label whose first word is neither a
  // known alias nor `claude-*`, nor `default`) has no derivable token. Emit an
  // EMPTY suffix so the tap is REJECTED by the switch-tap gate and re-renders,
  // rather than collapsing to the `default` sentinel — which would silently
  // REVERT to the configured default instead of switching to the labelled model.
  return MODEL_CALLBACK_SELECT
}

/**
 * N1: is `token` a switch target we actually recognize? A stale menu rendered by
 * an OLD gateway carries `mdl:s:<8-hex labelTag>` callback_data, which passes the
 * loose `MODEL_ARG_RE` shape gate — relaunching onto it would write a garbage
 * carrier and `--fallback-model` would silently serve a fallback. Constrain
 * SELECT/alias/sr tokens to a known set before scheduling any relaunch:
 *   - the `default` sentinel (clear+revert),
 *   - any sr-* (LiteLLM/OpenRouter) id (accepted raw, never picker-validated),
 *   - a canonical Claude token (a known alias or a `claude-*` id).
 * An 8-hex tag, an empty suffix, or any other unmapped string returns false → the
 * handler re-renders the menu (the old "Model list changed" graceful degrade)
 * instead of relaunching onto a token claude will silently fall back from.
 */
export function isRecognizedSwitchToken(token: string): boolean {
  if (token.toLowerCase() === 'default') return true
  if (isSrModel(token)) return true
  return canonicalClaudeToken(token) !== null
}

const BUSY_REFUSAL_TEXT =
  '⏳ The agent is mid-turn — the model picker needs an idle prompt. Your tap was not applied.'

/**
 * Busy-refusal detector (#3039). The gateway's queued-command drain applies a
 * command believing the session is idle; if a new turn started in the race
 * window the underlying handler still refuses with one of these texts. The
 * drain matches on this and RE-ENQUEUES the command instead of stamping the
 * refusal onto the ack card as a false final state — so no user-visible path
 * ever ends at "try again".
 */
export function isBusyRefusalText(text: string): boolean {
  return text.includes('The agent is mid-turn')
}

/**
 * Mid-turn `/model` menu (#3039): instead of refusing ("try again in a
 * moment"), render a STATIC keyboard that needs no picker discovery — the
 * alias rows + the external page. Every switch tap rides the gateway's
 * mid-turn queue (ack → apply at idle → confirm), so opening the menu during
 * a long turn still lets the operator lock in a choice.
 */
function busyStaticMenu(
  deps: Pick<ModelMenuDeps, 'escapeHtml'> & Pick<ModelCommandDeps, 'getAgentName'>,
  page: ModelMenuPage,
): ModelMenuReply {
  const externalNames = externalModelNames([])
  if (page === 'external') {
    return {
      text: [
        `**Model — ${deps.escapeHtml(deps.getAgentName())}** · 🌐 External`,
        '_Agent is mid-turn — taps are queued and apply the moment the turn ends._',
        'These models are **billed separately** via OpenRouter. Tap one to switch the **live session**:',
        PERSIST_NOTE,
      ].join('\n'),
      html: true,
      keyboard: externalPageKeyboard(externalNames),
    }
  }
  const rows: ModelMenuKeyboardButton[][] = []
  for (const alias of MODEL_ALIASES) {
    if (alias === 'default') continue
    rows.push([{
      text: alias.charAt(0).toUpperCase() + alias.slice(1),
      callback_data: `${MODEL_CALLBACK_ALIAS}${alias}`,
    }])
  }
  rows.push([{ text: 'Default (configured)', callback_data: `${MODEL_CALLBACK_ALIAS}default` }])
  if (externalNames.length > 0) {
    rows.push([{ text: '🌐 External models ▸', callback_data: MODEL_CALLBACK_PAGE_EXTERNAL }])
  }
  rows.push([{ text: '🔄 Refresh', callback_data: MODEL_CALLBACK_REFRESH }])
  return {
    text: [
      `**Model — ${deps.escapeHtml(deps.getAgentName())}**`,
      '_Agent is mid-turn, so the live picker can\u2019t be read right now — this is the quick list. A tap is queued and applies the moment the turn ends._',
      'Tap a model to switch the **live session**:',
      PERSIST_NOTE,
    ].join('\n'),
    html: true,
    keyboard: rows,
  }
}

function headerRow(label: string): ModelMenuKeyboardButton[] {
  return [{ text: label, callback_data: MODEL_CALLBACK_HEADER }]
}

/**
 * The external (🌐 non-Anthropic) model list, sourced from the static
 * SR_MODEL_ALIASES values UNION-ed with any live discoverSrModels() results,
 * deduped and sorted.
 *
 * Why the static union: discoverSrModels() reads LiteLLM's /model/info, which
 * requires ANTHROPIC_CUSTOM_HEADERS (a litellm key) to be set on the gateway
 * process. switchroom never sets that env on the gateway, so in production
 * discoverSrModels() always returns [] and the external group was silently
 * empty. The six SR_MODEL_ALIASES targets are the CURATED main sr-* set, so
 * seeding from them makes the group reliable without the missing env — while
 * still merging any live results on hosts that do configure discovery.
 *
 * Deliberately a SUBSET: the litellm config exposes more sr-* models than this
 * (the full OpenRouter catalogue). Those extras are display-labelled in
 * SR_MODEL_LABELS and remain typeable via `/model <full-sr-name>` (manual
 * passthrough — the set path is a shape gate, no whitelist), but they are kept
 * OUT of SR_MODEL_ALIASES on purpose so the keyboard stays small and curated.
 *
 * Subscription-honest: ONLY the curated sr-* aliases surface as buttons. Raw
 * gpt-4o / openrouter/* dupes / voyage-* embeddings never do.
 */
export function externalModelNames(discovered: string[]): string[] {
  const set = new Set<string>(Object.values(SR_MODEL_ALIASES))
  for (const n of discovered) {
    if (isSrModel(n)) set.add(n)
  }
  return [...set].sort()
}

/**
 * Main keyboard page: scraped Claude buttons + static Fable alias, then (only
 * when the external list is non-empty) a single "🌐 External models ▸" row that
 * opens the nested page, then Refresh.
 */
function mainPageKeyboard(
  claudeOptions: ModelPickerOption[],
  hasExternal: boolean,
): ModelMenuKeyboardButton[][] {
  const rows: ModelMenuKeyboardButton[][] = []

  for (const o of claudeOptions) {
    rows.push([{
      text: o.current ? `✅ ${o.label}` : o.label,
      callback_data: modelSelectCallbackData(o.label),
    }])
  }

  // Static Claude aliases the CLI picker omits (e.g. Fable). Deduped: if the
  // scraped Claude options already include a matching row, don't render the
  // static one too.
  for (const { alias, label } of EXTRA_CLAUDE_ALIASES) {
    const already = claudeOptions.some(
      (o) => o.label.toLowerCase() === label.toLowerCase() ||
        o.label.toLowerCase() === alias.toLowerCase(),
    )
    if (already) continue
    rows.push([{ text: label, callback_data: `${MODEL_CALLBACK_ALIAS}${alias}` }])
  }

  if (hasExternal) {
    rows.push([{ text: '🌐 External models ▸', callback_data: MODEL_CALLBACK_PAGE_EXTERNAL }])
  }

  rows.push([{ text: '🔄 Refresh', callback_data: MODEL_CALLBACK_REFRESH }])
  return rows
}

/**
 * External keyboard page: a labelled header, one 🌐 button per external model
 * (reusing the existing MODEL_CALLBACK_SR select handler), then Back + Refresh.
 */
function externalPageKeyboard(externalNames: string[]): ModelMenuKeyboardButton[][] {
  const rows: ModelMenuKeyboardButton[][] = []
  rows.push(headerRow('── External (billed separately) ──'))
  for (const name of externalNames) {
    rows.push([{
      text: `🌐 ${srFriendlyLabel(name)}`,
      callback_data: `${MODEL_CALLBACK_SR}${name}`,
    }])
  }
  rows.push([{ text: '◂ Back', callback_data: MODEL_CALLBACK_PAGE_MAIN }])
  rows.push([{ text: '🔄 Refresh', callback_data: MODEL_CALLBACK_REFRESH }])
  return rows
}

/**
 * Build the `/model` dashboard: live model + quota brief + tap menu.
 * Returns a keyboard-less fallback (v1-shaped static text) when the
 * picker can't be driven right now — the command never hard-fails.
 */
export async function buildModelMenu(
  deps: ModelMenuDeps & ModelCommandDeps,
  page: ModelMenuPage = 'main',
): Promise<ModelMenuReply> {
  if (deps.isBusy()) return busyStaticMenu(deps, page)

  const [discovered, quota, srNames] = await Promise.all([
    deps.discover(deps.getAgentName()),
    deps.getQuotaBrief().catch(() => null),
    deps.discoverSrModels().catch(() => [] as string[]),
  ])

  if (!discovered.ok) {
    // Graceful static fallback — same content as the v1 show path,
    // with the discovery failure surfaced.
    const v1 = await handleModelCommand({ kind: 'show' }, deps)
    return {
      text: [`_(picker unavailable: ${deps.escapeHtml(discovered.reason)})_`, v1.text].join('\n'),
      html: true,
    }
  }

  // claude's ✔ marks the DEFAULT FOR NEW SESSIONS, which is a different axis
  // from the model the agent is running right now (set via --model at launch
  // or a prior session switch). Labelling the ✔ row "Now:" was misleading —
  // it could read "Opus 4.8" while the live session is on Fable. Call it what
  // it is, and tell the operator a switch applies to the live session.
  // sr-* models come from LiteLLM (/model/info via discoverSrModels), not the
  // claude picker — the CLI only knows Anthropic models.
  const { claude: claudeOptions } = classifyDiscoveredOptions(discovered.options)
  const externalNames = externalModelNames(srNames)

  // External page: a focused list of the 🌐 (billed-separately) models with a
  // Back button. It never switches the model itself — the page callbacks just
  // re-render with the other page's keyboard.
  if (page === 'external') {
    const lines: string[] = [`**Model — ${deps.escapeHtml(deps.getAgentName())}** · 🌐 External`]
    lines.push(
      '',
      'These models are **billed separately** via OpenRouter — they do NOT use your Claude Max/Pro subscription. Tap one to switch the **live session**:',
      PERSIST_NOTE,
    )
    return { text: lines.join('\n'), html: true, keyboard: externalPageKeyboard(externalNames) }
  }

  // claude's ✔ marks the DEFAULT FOR NEW SESSIONS, which is a different axis
  // from the model the agent is running right now (set via --model at launch
  // or a prior session switch). Labelling the ✔ row "Now:" was misleading —
  // it could read "Opus 4.8" while the live session is on Fable. Call it what
  // it is, and tell the operator a switch applies to the live session.
  const current = claudeOptions.find((o) => o.current)
  const lines: string[] = [`**Model — ${deps.escapeHtml(deps.getAgentName())}**`]
  if (discovered.dismissFailed) {
    lines.push('⚠️ _The picker may still be open on the agent pane — check it before switching._')
  }
  if (current) {
    const detail = current.detail ? ` · ${deps.escapeHtml(current.detail)}` : ''
    lines.push(`Default (new sessions): **${deps.escapeHtml(current.label)}**${detail}`)
  } else {
    lines.push('Default (new sessions): _unknown (no ✔ row in picker)_')
  }
  if (quota) lines.push(`Quota: ${deps.escapeHtml(quota)}`)
  lines.push('', 'Tap a model to switch the **live session**:')
  if (externalNames.length > 0) {
    lines.push('Claude models use your Max/Pro subscription. Tap 🌐 External models for models billed separately via OpenRouter.')
  }
  lines.push(PERSIST_NOTE)

  return {
    text: lines.join('\n'),
    html: true,
    keyboard: mainPageKeyboard(claudeOptions, externalNames.length > 0),
  }
}

export interface ModelCallbackOutcome {
  /**
   * When true, the caller should ONLY show the toast (`answer`) and leave
   * the existing menu message untouched — used for the mid-turn refusal so
   * the menu keeps its buttons and the operator can simply tap again when
   * the agent goes idle, instead of the menu collapsing to a button-less
   * "try again" line (which read as "nothing happened").
   */
  toastOnly?: boolean
  /**
   * True when this outcome is the mid-turn refusal (#3039). The queued-command
   * drain re-enqueues on this instead of stamping the refusal onto the ack
   * card as a false final state.
   */
  busyRefusal?: boolean
  /**
   * Rev 5: a menu tap NEVER carries a scrape-derived live-model field. Every
   * switch (alias/Fable, picker SELECT, sr-*) relaunches through
   * `scheduleModelRelaunch`/`scheduleModelDefaultRelaunch`, which own the
   * in-memory override + carrier writes; the ACTUAL running model is reconciled
   * at boot from `.active-session-model`. So there is no `selectedModel` /
   * `selectedModelToken` / `clearedDefault` here to record optimistically — the
   * gateway no longer post-processes the outcome for side effects.
   */
  /** Short toast for answerCallbackQuery. */
  answer: string
  /** Replacement dashboard (message edit). */
  reply: ModelMenuReply
}

/**
 * Handle a `mdl:*` callback tap. `mdl:r` re-renders the dashboard;
 * `mdl:s:<tag>` re-discovers the picker, resolves the tag back to a
 * live label, and applies it session-only. A tag that no longer
 * matches (claude updated its options since render) re-renders the
 * menu instead of guessing.
 */
export async function handleModelMenuCallback(
  data: string,
  deps: ModelMenuDeps & ModelCommandDeps,
): Promise<ModelCallbackOutcome> {
  if (data === MODEL_CALLBACK_REFRESH) {
    return { answer: 'Refreshed', reply: await buildModelMenu(deps) }
  }

  // Page navigation — these DO NOT switch the model. They just re-render the
  // menu with the other page's keyboard + body text (mirrors the REFRESH shape).
  if (data === MODEL_CALLBACK_PAGE_EXTERNAL) {
    return { answer: 'External models', reply: await buildModelMenu(deps, 'external') }
  }
  if (data === MODEL_CALLBACK_PAGE_MAIN) {
    return { answer: 'Back', reply: await buildModelMenu(deps, 'main') }
  }

  if (data === MODEL_CALLBACK_HEADER) {
    // Section-header row — the gateway handles this with a direct answerCallbackQuery
    // before calling this function, so this branch is dead in practice. Guard
    // for callers that skip gateway.ts (tests, future refactors).
    return { answer: 'Tap a model in this section to switch', reply: { text: '', html: true }, toastOnly: true }
  }

  // A model-SWITCH tap — Fable/alias button (`mdl:alias:`), an sr-* target
  // (`mdl:sr:`), or a picker SELECT row (`mdl:s:<token>`). Rev 5: every one
  // relaunches through the consume-once `.session-model` carrier. No inject, no
  // cursor-nav, no terminal scrape — a tap resolves its canonical token and
  // hands off to `scheduleModelRelaunch` (or the clear+revert path for the
  // `default` sentinel, which the "Default (recommended)" row and the Default
  // alias button both carry). This is what makes a tap deterministic: it can no
  // longer silently no-op or optimistically record a switch that never applied.
  if (
    data.startsWith(MODEL_CALLBACK_ALIAS) ||
    data.startsWith(MODEL_CALLBACK_SR) ||
    data.startsWith(MODEL_CALLBACK_SELECT)
  ) {
    let token: string
    let label: string
    if (data.startsWith(MODEL_CALLBACK_ALIAS)) {
      token = data.slice(MODEL_CALLBACK_ALIAS.length)
      label = token
    } else if (data.startsWith(MODEL_CALLBACK_SR)) {
      token = data.slice(MODEL_CALLBACK_SR.length)
      label = srFriendlyLabel(token)
    } else {
      token = data.slice(MODEL_CALLBACK_SELECT.length)
      label = token
    }
    if (!isValidModelArg(token)) {
      return { answer: 'Invalid model name', reply: await buildModelMenu(deps) }
    }
    // N1: reject a token we don't recognize (a stale OLD-gateway `mdl:s:<hex>`
    // callback, an unmapped SELECT row, or garbage). Relaunching onto it would
    // write a carrier claude silently falls back from (--fallback-model). Re-render
    // the fresh menu instead — the graceful degrade the label-tag path used to give.
    if (!isRecognizedSwitchToken(token)) {
      return { answer: 'Model list changed — menu refreshed', reply: await buildModelMenu(deps) }
    }
    // Mid-turn: refuse WITHOUT touching the message so the menu keeps its
    // buttons and the operator can tap again once idle. (The gateway dispatcher
    // already enqueues switch taps mid-turn before calling this handler; this is
    // the belt-and-braces seam for callers that skip it.)
    if (deps.isBusy()) {
      return {
        answer: '⏳ Agent is mid-turn — tap again when it’s idle',
        reply: { text: BUSY_REFUSAL_TEXT, html: true },
        toastOnly: true,
        busyRefusal: true,
      }
    }
    return menuRelaunchOutcome(deps, token, label)
  }

  return { answer: 'Unknown action', reply: await buildModelMenu(deps) }
}

/**
 * Shared menu-tap relaunch: schedule the carrier relaunch onto `token` (or the
 * clear+revert relaunch for the `default` sentinel) and return the deterministic
 * "relaunching (~30s)" card. Uses the STATIC banner (no discover()) because the
 * pane is about to restart. No `selectedModel` — the actual running model is
 * reconciled at boot from `.active-session-model`.
 */
async function menuRelaunchOutcome(
  deps: ModelMenuDeps & ModelCommandDeps,
  token: string,
  label: string,
): Promise<ModelCallbackOutcome> {
  const isDefault = token.toLowerCase() === 'default'
  try {
    if (isDefault) {
      await deps.scheduleModelDefaultRelaunch('user: /model default (revert relaunch, menu)')
    } else {
      await deps.scheduleModelRelaunch(token, `user: /model ${token} (session-only relaunch, menu)`)
    }
  } catch (err) {
    if (isRestartInFlight(err)) {
      return {
        answer: 'A restart is already in flight (~15s)',
        reply: await menuWithBannerStatic(
          deps,
          `⏳ A restart is already in flight — your switch to **${deps.escapeHtml(label)}** will apply as it completes (~15s).`,
        ),
      }
    }
    const msg = err instanceof Error ? err.message : String(err)
    return {
      answer: 'Switch failed',
      reply: await menuWithBannerStatic(deps, `❌ Switch to **${deps.escapeHtml(label)}** failed: ${deps.escapeHtml(msg)}`),
    }
  }
  const friendly = isDefault ? 'the configured default' : label
  return {
    answer: `Switching to ${isDefault ? 'default' : label} — relaunching (~30s)`,
    reply: await menuWithBannerStatic(
      deps,
      `🔄 Switching session to **${deps.escapeHtml(friendly)}** — relaunching (~30s).\n${PERSIST_NOTE}`,
    ),
  }
}

/**
 * Normalize a picker ROW LABEL to a canonical `claude --model` token suitable
 * for the durable `.session-model` override (aliases and full `claude-*` ids —
 * NOT display strings like "Default (recommended)" or "Opus 4.8", which the CLI
 * flag rejects). Returns null when the label is a pure display label with no
 * derivable token: for the "Default" row that correctly means "boot the
 * configured default" (write no carrier).
 */
export function canonicalClaudeToken(label: string): string | null {
  const l = label.trim()
  if (l.toLowerCase().startsWith('claude-')) return l
  const first = l.toLowerCase().split(/\s+/)[0]
  if (first === 'default') return null
  if ((MODEL_ALIASES as readonly string[]).includes(first)) return first
  return null
}

/**
 * True when an error thrown by scheduleRestart / scheduleModelRelaunch signals
 * "a restart is already in flight" (the gateway's 15s debounce) rather than a
 * genuine dispatch failure. Carried as a `code` property so model-command.ts
 * need not import the gateway's error type.
 */
export function isRestartInFlight(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: unknown }).code === 'restart_in_flight'
}

/**
 * Re-render the live menu with a one-line banner on top. Used by every
 * post-tap outcome (success, already-default, failure) so the menu ALWAYS
 * keeps its buttons and the operator can act again — the consistent
 * "status line + interactive menu" shape the other dashboards use. Falls
 * back to the banner alone if the menu can't be rebuilt right now.
 */
async function menuWithBanner(
  deps: ModelMenuDeps & ModelCommandDeps,
  banner: string,
): Promise<ModelMenuReply> {
  const fresh = await buildModelMenu(deps)
  return {
    text: [banner, '', fresh.text].join('\n'),
    html: true,
    ...(fresh.keyboard ? { keyboard: fresh.keyboard } : {}),
  }
}

// Static variant — skips discover() entirely and uses the v1 text path.
// Use after a text-inject where the picker state is inherently uncertain:
// discover() reliably fails immediately post-inject, producing a spurious
// "(picker unavailable)" warning that reads as an error.
async function menuWithBannerStatic(
  deps: ModelMenuDeps & ModelCommandDeps,
  banner: string,
): Promise<ModelMenuReply> {
  const v1 = await handleModelCommand({ kind: 'show' }, deps)
  return {
    text: [banner, '', v1.text].join('\n'),
    html: true,
    // No keyboard — picker state is unknown after a text-inject; operator
    // can tap /model to get a fresh interactive menu.
  }
}
