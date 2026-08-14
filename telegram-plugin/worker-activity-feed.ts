/**
 * Live worker-activity feed — a regular chat message that edits in place
 * while a *background* sub-agent (Agent/Task `run_in_background: true`)
 * runs, then finalizes when the worker completes.
 *
 * Why this exists: the pinned progress card was deleted (#1126) and the
 * "Chat is the artifact" principle bars re-adding card chrome. But a
 * background worker decouples from the parent turn — when the parent's
 * turn ends, nothing surfaces the worker's ongoing jsonl activity, so a
 * long worker reads as silence (the exact gap an operator hit watching a
 * dispatched worker go quiet). This module surfaces that activity the
 * same way the main agent's live answer does: a normal Telegram message
 * that grows/edits as work happens — indistinguishable from "the agent
 * is typing live", not a status widget.
 *
 * COALESCED (#3084 follow-up): all live workers dispatched to the SAME
 * chat/thread render into ONE shared message (a {@link FeedGroup}), not one
 * message each. With N workers, N separate messages each coalesce their own
 * edit stream but ALL draw from the send gate's 1/sec per-chat bucket — so
 * ~N-1 of every second's edits SHED and every card refreshes only ~once per N
 * seconds (liveness collapse). One combined message = ONE per-message edit
 * stream: it coalesces (last-write-wins) and never contends with siblings, so
 * every worker's row refreshes together within the ~1.5s edit floor. A single-
 * worker chat still renders the full 🛠 Worker card (identical to before); a
 * 2+ worker chat renders `renderCombinedWorkerFeed`.
 *
 * Pure render (`renderWorkerActivity` / `renderCombinedWorkerFeed`) + an
 * injected bot API (`BotApiForWorkerFeed`). The manager
 * (`createWorkerActivityFeed`) owns one edit-in-place message per (chat,thread)
 * with:
 *   - a first-paint delay so trivial sub-second workers never post a
 *     message (their result still lands via the handback reply),
 *   - a proactive min-edit-interval throttle (worker jsonl ticks ~1/s;
 *     Telegram rate-limits edits) plus body-dedup,
 *   - per-message serialization so two rapid ticks can't double-send,
 *   - 429 cooldown + message_id drift resilience (re-post on stale edit),
 *   - a forced terminal edit on the LAST worker's `finish`.
 *
 * The completed-worker RESULT is NOT folded into this cosmetic feed — it
 * reaches the user as its own `useful` handback reply (gateway onFinish). The
 * feed shows only *live* work; a finished worker's row is dropped from the
 * combined body (or, when it is the last worker, the message finalizes to its
 * terminal recap).
 *
 * The feed is gated to BACKGROUND workers and is ON by default; set
 * `SWITCHROOM_WORKER_ACTIVITY_FEED=0` to disable it — see the gateway
 * wiring. The watcher already drives the cues (it polls the worker jsonl
 * directly, so it keeps firing after the parent turn ends), which is why
 * the feed is fed from watcher callbacks rather than the bridge event stream.
 */

import {
  stripMarkdown,
  truncate,
} from './card-format.js'
import { WORKER_HISTORY_MAX } from './status-no-truncate.js'
import { renderCardTitleLine } from './card-layout.js'
import {
  deriveCardResult,
  renderStatusCard,
  formatStepSuffix,
  renderCombinedWorkerFeed,
  workerHistoryDepth,
  type CombinedWorkerRow,
} from './tool-activity-summary.js'
import { isSendGateShed } from './send-gate.js'

/** Worker-activity feed is ON by default; an operator opts out with
 *  SWITCHROOM_WORKER_ACTIVITY_FEED=0. */
export function isWorkerActivityFeedEnabled(envVal: string | undefined): boolean {
  return envVal !== '0'
}

/**
 * Terminal states a worker card can render.
 *   - 'running'    — live.
 *   - 'done'       — clean finish WITH a result (✅).
 *   - 'failed'     — clean finish reporting a failure / crash observed in the
 *                    transcript (⚠️).
 *   - 'incomplete' — force-reaped / vanished / crashed WITHOUT any clean finish
 *                    (the TTL sweep or the watcher's authoritative
 *                    `onTerminalCleanup` synthesised the terminal because
 *                    neither `onFinish` nor a turn_end ever delivered a result).
 *                    Renders `incomplete · …` so a reaped worker NEVER reads as
 *                    "done" — the truthful "ended without result" terminal.
 */
export type WorkerActivityState = 'running' | 'done' | 'failed' | 'incomplete'

/** The render-relevant snapshot of a worker at one instant. */
export interface WorkerActivityView {
  /** Dispatch-time task description (stable across the worker's life). */
  description: string
  /** Most recent tool the worker invoked, with a pre-sanitised arg. */
  lastTool: { name: string; sanitisedArg: string } | null
  /** Number of tool calls observed so far. */
  toolCount: number
  /**
   * Running TOTAL tokens across the worker's assistant messages so far
   * (input + output + cache_creation, deduped by message.id in the watcher;
   * cache_read is excluded — replayed cached context, not new work). Rendered
   * as `· {N} tok` on the card's metrics line. Omitted /
   * 0 → no token segment (a worker that emitted no usage).
   */
  totalTokens?: number
  /** The worker's latest narrative line, if any (already capped upstream). */
  latestSummary: string
  /**
   * Accumulated narrative lines, oldest→newest, already deduped + capped by
   * the feed manager. When present and non-empty, the render grows a `✓`/`→`
   * step feed (prior steps done, newest in-progress — mirroring the main
   * agent's activity card) instead of collapsing to the single `latestSummary`
   * line. Absent/empty → the single-line fallback (back-compat for direct
   * render callers).
   */
  narrativeLines?: string[]
  /** Wall-clock since dispatch, ms. */
  elapsedMs: number
  state: WorkerActivityState
  /**
   * Live model the worker is running, as a raw resolved model id sourced from
   * its transcript (`message.model`) or, before its first assistant line, the
   * dispatch-time `tool_input.model` persisted on the registry row. Rendered as
   * a short friendly tag on the worker card's metrics line. Omitted when
   * unknown — never guessed from config.
   */
  model?: string
}

/**
 * Out-of-band metadata about ONE feed edit, handed to the transport adapter
 * alongside the Bot API arguments (switchroom#3848).
 *
 * Deliberately a SEPARATE parameter rather than a field on `opts`: `opts` is
 * forwarded verbatim to `editMessageText` and therefore onto the wire, and
 * `outbound-class.ts` exists precisely so a priority signal never has to be
 * smuggled into an outbound Bot API payload.
 */
export interface WorkerFeedEditMeta {
  /**
   * True when this edit paints the card's FINAL state — the last worker's
   * terminal recap, or the "superseded" note on a rotated-out message. False
   * for every intermediate / liveness repaint.
   */
  terminal: boolean
}

/**
 * The send-gate priority class a worker-feed edit must carry.
 *
 * Intermediate repaints are `cosmetic`: dropping one costs nothing, because
 * the next render carries full state, and holding them to the fuse's tight
 * cosmetic ceilings (4/message/60s, 6/chat/60s) is what stops the feed
 * earning a per-chat flood ban (#3847).
 *
 * A TERMINAL frame is `useful` (#3848). It is the last frame the operator
 * ever reads for that card and nothing newer is coming to repaint it, so
 * classing it cosmetic made the one frame carrying the finished state
 * compete in — and get shed from — the same starved budget as a heartbeat.
 * `useful` rather than `critical` matches the activity-summary finalize in
 * `gateway/narrative-lane.ts`: it may be DEFERRED under pressure, but it is
 * not shed, and it does not spend the per-chat reply reservation that keeps
 * the operator's real answer unstarvable.
 *
 * Exported so the mapping is unit-testable; `gateway.ts` only calls it.
 */
export function workerFeedEditPriorityClass(
  meta?: WorkerFeedEditMeta,
): 'useful' | 'cosmetic' {
  return meta?.terminal === true ? 'useful' : 'cosmetic'
}

export interface BotApiForWorkerFeed {
  sendMessage(
    chatId: string,
    text: string,
    opts?: Record<string, unknown>,
  ): Promise<{ message_id: number }>
  editMessageText(
    chatId: string,
    messageId: number,
    text: string,
    opts?: Record<string, unknown>,
    /**
     * Out-of-band edit metadata (NOT part of the Bot API payload). The
     * gateway adapter maps `terminal` to the send-gate priority class via
     * {@link workerFeedEditPriorityClass}.
     */
    meta?: WorkerFeedEditMeta,
  ): Promise<unknown>
}

/** Dispatch-time task description cap for the worker header. */
const DESC_MAX = 80

/**
 * Repeat marker appended to a narrative step that fired more than once in a
 * row (`Running a command ·×3`). Rendered inline on the step line so a worker
 * whose every step carries the SAME label still visibly advances instead of
 * freezing the card. `·` is already the card's separator glyph.
 */
const REPEAT_SUFFIX_RE = / ·×(\d+)$/

/** The step text without its `·×N` marker (identity for dedup comparisons). */
export function stripRepeatSuffix(line: string): string {
  return line.replace(REPEAT_SUFFIX_RE, '')
}

/** How many times a step line has fired: 1 when it carries no marker. */
export function repeatCountOf(line: string): number {
  const m = REPEAT_SUFFIX_RE.exec(line)
  return m == null ? 1 : Number(m[1])
}

/**
 * Thin adapter over the unified `renderStatusCard` primitive (emoji 🛠, label
 * 'WORKER'): builds the header, passes raw narrative steps
 * (the primitive runs stripMarkdown → collapse ws → clip → escape per line),
 * and on finish passes the cleaned result paragraph as the `result` block.
 *
 * Layout (running):
 *   🛠 **WORKER** · _{description}_
 *   _{elapsed} · {n} tools_
 *   ~~_✓ {earlier step}_~~
 *   **→ {newest step}**
 *
 * Layout (finished): the feed renders all-done, then a rule + cleaned result:
 *   🛠 **WORKER** · _{description}_
 *   _done · {n} tools · {elapsed}_
 *   ~~_✓ {step}_~~
 *   ─────
 *   ✅ _{cleaned result paragraph}_
 *
 * FLUSH (#3842): this card sits at the left margin. #3820/#3821 indented the
 * whole block and prefixed line 1 with `└─ ` to mark it subordinate to the 🤖
 * agent card; that was reverted because it burned a level of horizontal phone
 * width and because this card does not always sit below the agent card, so a
 * card-level subordination marker asserts a relationship that is not always
 * true. The remaining type cue is line 1: the 🛠 emoji plus the caps `WORKER`
 * label against the agent card's 🤖 `Agent`. Keep that pair — with identical
 * step text and stats the two cards' BODY lines can now coincide byte for
 * byte, so line 1 is doing all of the distinguishing work.
 */
export function renderWorkerActivity(v: WorkerActivityView, liveSuffix = ''): string {
  const desc = truncate(stripMarkdown(v.description).trim() || 'background task', DESC_MAX)
  const finished = v.state === 'done' || v.state === 'failed' || v.state === 'incomplete'

  // Raw narrative steps (unstripped/unescaped) — the unified renderer runs the
  // full per-line pipeline (stripMarkdown → collapse ws → clip → escape).
  const rawSteps = (v.narrativeLines ?? []).filter((s) => s != null && s.trim().length > 0)

  // Back-compat for direct render callers that pass only latestSummary while
  // RUNNING; the manager always supplies narrativeLines. On the FINISHED path
  // latestSummary is the worker's RESULT (below), never a narrative step — so
  // the fallback only applies while running.
  let steps = rawSteps
  if (steps.length === 0 && !finished) {
    const summary = stripMarkdown(v.latestSummary).replace(/\s+/g, ' ').trim()
    if (summary.length > 0) steps = [v.latestSummary]
  }

  const header: Parameters<typeof renderStatusCard>[0]['header'] = {
    emoji: '🛠',
    // Caps (#3820, issue option 4): `WORKER` against the agent card's `Agent`
    // is a high-contrast type label, not a same-shaped word one letter apart.
    label: 'WORKER',
    description: desc,
    elapsedMs: v.elapsedMs,
    toolCount: v.toolCount,
    state: v.state,
    model: v.model,
    totalTokens: v.totalTokens,
  }

  // Terminal: latestSummary carries the worker's final result text (gateway
  // onFinish), distinct from the running narrative steps. Pass it as `result`.
  //
  // The whole derivation — state gating, the truthful-no-result invariant for
  // `incomplete`, ✅/⚠️ selection, and omission on an empty summary — lives ONCE
  // in `deriveCardResult` and is SHARED with the 🤖 agent card. It used to be
  // inline here, which is precisely why the agent card had no result footer at
  // all: the logic was unreachable from the other surface.
  const result = deriveCardResult(v.state, v.latestSummary)

  const card = renderStatusCard({
    header,
    steps,
    final: finished,
    liveSuffix: finished ? '' : liveSuffix,
    result,
    // Lone-worker card: window to the w=1 point of Ken's curve (6) so it shows
    // the full recent trail, not the 5-line agent-card default (#3349).
    historyWindow: workerHistoryDepth(1),
    // A just-dispatched worker has no narrative yet. The placeholder is a normal
    // BODY line of the shared spec now (#3846): it used to be concatenated onto
    // this function's return value, which put a user-visible card line outside
    // the primitive that owns hard-break stacking, the collapse-safe separator
    // and the char budget, and made the seam the one boundary that could mash in
    // Telegram's pinned bar. Only while RUNNING — a finished worker with no
    // steps must not read as "starting…".
    emptyPlaceholder: finished ? undefined : '_starting…_',
  })
  if (card == null) {
    // Unreachable (header always present) — defensive.
    return renderCardTitleLine('🛠', 'WORKER', 'starting…')
  }
  return card
}

export interface WorkerActivityFeedOpts {
  bot: BotApiForWorkerFeed
  /** `Date.now` override for tests. */
  now?: () => number
  /**
   * Minimum ms between in-place edits to one worker's message. Worker
   * jsonl ticks roughly once per second; without this we'd burn through
   * Telegram's edit budget. Default 2500ms. First paint and the terminal
   * `finish` edit bypass it.
   */
  minEditIntervalMs?: number
  /**
   * Coarse cadence (ms) for elapsed-ONLY refreshes. When the only thing that
   * changed since the last edit is the volatile elapsed clock (no new step, no
   * state/toolCount/token change), the card is NOT re-edited until this much
   * time has passed — so a worker sitting in one long tool call advances its
   * clock only every ~`elapsedRefreshMs`, not every jsonl tick. This is the
   * primary defense against the sustained same-message edit stream that earns a
   * Telegram flood ban (finn incident: 26,460 clock-only edits → ~88min 429).
   * A SUBSTANTIVE change (new narrative step, done/failed, toolCount/token
   * delta) still renders promptly under `minEditIntervalMs`. Default 15000ms.
   * The terminal finish edit and forced edits bypass it. Liveness for a truly
   * silent worker is already carried by the typing loop, so a slow clock is not
   * a liveness regression.
   */
  elapsedRefreshMs?: number
  /**
   * A worker must have been running at least this long before its first
   * message is posted. Sub-second / trivial workers never surface a live
   * message — their result still reaches the user via the handback
   * reply, so a message would be pure noise. Default 8000ms.
   */
  firstPaintMinMs?: number
  /** stderr-style log sink. Defaults to noop. */
  log?: (msg: string) => void
  /**
   * Remaining ms of the currently-open per-bot flood window, read from the
   * SAME persisted marker the gateway's `robustApiCall` and held-card sweep
   * consult (`makeFloodWaitProbe(FLOOD_STATE_PATH)`). Two independent reads of
   * one source of truth — not a second notion of "is the channel open".
   *
   * Why the feed needs it (#3084 follow-up): the feed's send/edit adapters run
   * through the send gate, which SHEDS (resolves `undefined`) any call made
   * while a flood window is open. Without this probe the heartbeat re-fires a
   * shed send every `heartbeatTickMs` (~6s) for the WHOLE ban — thousands of
   * gate admissions, and (pre-fix) a `sent.message_id` crash on the `undefined`
   * every tick. With it, a running/first-paint tick that sees an open window
   * parks the group in cooldown for the window's remaining and makes ZERO api
   * calls until it closes, mirroring the held-card sweep's pre-send probe.
   * Defaults to `() => 0` (no window) so tests and non-gateway callers are
   * unchanged.
   */
  floodWaitRemainingMs?: () => number
  /**
   * Heartbeat timer factory. Injectable for tests. Defaults to the real
   * `setInterval`, `.unref()`'d so it never keeps the process alive.
   */
  setInterval?: (cb: () => void, ms: number) => unknown
  /** Heartbeat timer disposer. Injectable for tests. Defaults to `clearInterval`. */
  clearInterval?: (handle: unknown) => void
  /**
   * Heartbeat tick cadence in ms. On each tick a stale, running feed is
   * re-rendered with climbing elapsed so a worker that emits no new narrative
   * still visibly advances. Default 6000ms.
   */
  heartbeatTickMs?: number
  /**
   * Max worker rows rendered in a COMBINED feed (2+ workers in one chat/thread)
   * before the `+M more working…` spill line. Keeps the coalesced body compact
   * and legible (and under the rich-message wire ceiling). Default 8. A single-
   * worker chat renders the full 🛠 Worker card and ignores this. Sourced from
   * `channels.telegram.worker_feed.max_rows` via the config cascade.
   */
  maxRows?: number
  /**
   * Backstop TTL (ms): a worker row that has received no `update()` cue for
   * longer than this AND is not already finished is force-terminated by the
   * heartbeat sweep — its row is removed, and when it was the last live worker
   * the shared card collapses to its terminal summary and unpins. This is the
   * durable guard against an immortal card if BOTH terminal signals are missed
   * (the gateway's `onFinish` AND the watcher's `onTerminalCleanup` sweep).
   *
   * The gateway DERIVES this in code from the watcher's effective in-flight
   * terminal cap (`resolveInflightTerminalCapMs()` — the same env/default the
   * watcher resolves) plus a margin, so the invariant "never reap a row the
   * watcher still considers live" holds even if an operator raises the cap via
   * `SWITCHROOM_SUBAGENT_INFLIGHT_TERMINAL_CAP_MS`. A worker mid-very-long tool
   * can go silent up to the cap before the watcher declares it terminal, so any
   * row still present past cap + margin is a definitive leak — the watcher would
   * already have swept a live worker.
   *
   * Fallback default (this module, for direct / non-gateway callers) 50 min.
   * Tests inject a small value.
   */
  staleWorkerTtlMs?: number
  /**
   * ABSOLUTE row-lifetime cap (ms), measured from a row's creation — NOT from
   * its last `update()`. The heartbeat force-terminates (and, when it was the
   * last live worker, unpins) ANY row this old, whether or not it is marked
   * finished and no matter how recently it updated.
   *
   * Why this exists AND is distinct from `staleWorkerTtlMs` (Carrie 5h zombie
   * pin, v0.18.23): the `staleWorkerTtlMs` backstop is keyed off `lastUpdateAt`,
   * so it only bites a row that goes SILENT. A leaked row that never transitions
   * to finished AND keeps receiving `update()` cues every heartbeat (~6s) resets
   * `lastUpdateAt` on every tick, so the silence sweep can NEVER match — the row
   * (and its group pin) lives forever. This cap is immune to that reset: it is
   * anchored to `createdAtMs` (immutable), so an immortal-but-updating row is
   * still reaped past an absolute age. The primary fix (the watcher's
   * `onTerminalCleanup` → `terminate` wiring) drives the clean path; this is the
   * deterministic last-resort guarantee that no card can outlive the cap even if
   * that signal is missed or the row is spuriously re-driven.
   *
   * The gateway DERIVES this from the watcher's effective in-flight terminal cap
   * (`resolveInflightTerminalCapMs()`) times a multiple, matching the
   * `staleWorkerTtlMs` derivation pattern (never a bare magic number). It is set
   * comfortably above any legitimate single worker's lifetime so it can only
   * bite a genuine leak; if a real long worker ever hit it, its cosmetic feed
   * card collapses to `incomplete` and unpins — its actual result still reaches
   * the user via the separate handback reply.
   *
   * Fallback default (this module, for direct / non-gateway callers) 6 h.
   * Tests inject a small value.
   */
  absoluteRowLifetimeCapMs?: number
  /**
   * ABSOLUTE reused-group-MESSAGE lifetime cap (ms), measured from the moment
   * the shared message was posted (`messageCreatedAtMs`), NOT from a worker
   * row's age. When workers overlap continuously the group is NEVER reset to a
   * fresh message (the only messageId reset is the group-reuse-after-terminal
   * branch, gated on `!hasLiveWorker`), so ONE message can live for hours. If
   * that message loses its pin out-of-band (a raw unpin somewhere else, or
   * Telegram pin-stacking burying it), the steady-state edit path re-pins via
   * `syncPin`; but a STALE in-memory pin claim (the claim still names this id, so
   * `decidePinAction` no-ops on equal id) can only be cleared by rotating to a
   * NEW message id. This cap force-rotates the shared message past an absolute
   * age WHILE live workers remain, so the pin surface is periodically re-
   * established through the first-paint `syncPin` path — the deterministic
   * defense-in-depth that bounds how long a buried card can stay invisible
   * (invisible-worker-cards incident, 2026-07-15; mirrors the immutable-anchor
   * absolute-cap pattern of `absoluteRowLifetimeCapMs` / #3239's row cap).
   *
   * Conservative by design: set well above a normal edit cadence so a healthy
   * pinned card is not needlessly churned. Rotation costs ONE unpin (old claim)
   * + ONE pin (fresh message) per cap interval — never a burst. Fallback default
   * (this module) 60 min; tests inject a small value.
   */
  groupMessageLifetimeCapMs?: number
  /**
   * Group-level status-pin reconcile hook (#3207 review). Because workers now
   * COALESCE into one shared message, the pin MUST follow the GROUP lifecycle,
   * not a single worker's: pin the shared message when a group's first worker
   * paints, and unpin ONLY when the group empties (its LAST worker finishes / is
   * dropped). The feed alone knows group membership + running-count, so it owns
   * the pin. `messageId: null` means "unpin this group". A per-worker unpin would
   * physically unpin a message a SIBLING still needs, and the survivor's next
   * pin request NO-OPs (its claim still names that id) — so it would run
   * unpinned for the rest of its life (the shared-message NOOP trap). Best-
   * effort; defaults to a noop for tests / non-gateway callers.
   */
  reconcilePin?: (args: {
    feedKey: string
    chatId: string
    threadId?: number
    messageId: number | null
  }) => void
  /**
   * TEST-ONLY (never set in production). Invoked once at construction with a
   * narrow control that repoints the internal `agentId → feedKey` index WITHOUT
   * moving the worker's row. Its sole purpose is to reproduce the
   * `agentIndex`/`workers` DESYNC that the migration-eviction root-cause fix now
   * prevents any public API sequence from producing — so the heartbeat sweep's
   * force-evict backstop (the branch that removes a leaked row when
   * `groupOfAgent(agentId)` no longer resolves to the group physically holding
   * it) can be covered by a deterministic test. A no-op when unset.
   */
  exposeTestControls?: (controls: {
    /** Set the internal index entry for `agentId` to `feedKey` (or delete it
     *  when `feedKey` is null) without touching any group's `workers` map. */
    repointAgentIndex: (agentId: string, feedKey: string | null) => void
  }) => void
}

/**
 * One live worker's per-row state inside a chat/thread feed group. The row
 * carries everything the render needs for THIS worker; the shared message
 * (id, cooldown, chain) lives on the enclosing {@link FeedGroup}.
 */
interface WorkerRow {
  /** jsonl agent id — carried so success/failure log lines can name the worker. */
  agentId: string
  /**
   * Accumulated narrative lines (oldest→newest), deduped within the whole
   * rolling window. Rolling-window capped to WORKER_HISTORY_MAX. Grows the
   * live render so the feed reads like the main agent's answer.
   */
  narrative: string[]
  /**
   * `view.toolCount` observed when the newest narrative step was last recorded
   * or counted. The repeat counter (`·×N`) increments only when toolCount has
   * MOVED — the watcher re-emits an unchanged view every tick, so counting
   * label-equality alone would inflate the number with no work behind it.
   */
  lastNarrativeToolCount: number | null
  /** Last view for this worker (drives the heartbeat re-render + combined row). */
  lastView: WorkerActivityView | null
  /** Latest state observed for this worker; excluded from the running set once
   *  terminal (its result reaches the user via the separate handback reply). */
  state: WorkerActivityState
  /**
   * Latched in `finish` before the terminal edit. A late watcher `onProgress`
   * tick that arrives after `finish()` queued its chain must NOT resurrect the
   * row and paint a fresh `running` state on an already-finalized worker.
   */
  finished: boolean
  /**
   * Wall-clock ms the worker was dispatched, derived from `now - view.elapsedMs`
   * on the first update. The heartbeat computes a live elapsed from this so the
   * elapsed climbs even when no fresh view arrives, and it fixes the worker's
   * stable sort order within the combined feed.
   */
  dispatchAtMs: number | null
  /**
   * Wall-clock ms of the most recent `update()` cue for this worker (its last
   * observed liveness). The heartbeat's backstop TTL sweep force-terminates a
   * row whose `lastUpdateAt` is older than `staleWorkerTtlMs` — the durable
   * guard that no card can go immortal even if every terminal signal (onFinish
   * AND the onTerminalCleanup sweep) is somehow missed. Stamped on row creation
   * and on every `update()`.
   */
  lastUpdateAt: number
  /**
   * Wall-clock ms this row was first CREATED (its first `update()` cue).
   * IMMUTABLE after creation — unlike `lastUpdateAt`, it is NEVER re-stamped by
   * later updates. The heartbeat's ABSOLUTE row-lifetime cap force-terminates a
   * row whose `createdAtMs` is older than `absoluteRowLifetimeCapMs` regardless
   * of how recently it updated. This closes the immortal-card leak the
   * `lastUpdateAt` backstop cannot: a row that keeps receiving `update()` cues
   * (a zombie whose watcher entry re-registers, or any spurious re-drive) resets
   * `lastUpdateAt` every tick, so the silence-TTL sweep NEVER fires — but the
   * absolute cap is immune to that reset (Carrie 5h zombie pin, re-edited 3000+
   * times, only cleared by the restart-time dm-pin-sweep).
   */
  createdAtMs: number
  /**
   * Wall-clock ms the CURRENT step started — stamped whenever a NEW narrative
   * line lands (the `→` line changes). The heartbeat's step suffix shows the
   * step's OWN elapsed from this anchor (single-worker card only), and only
   * once past STEP_TIMER_MIN_MS.
   */
  stepStartedAtMs: number | null
  /**
   * Stable 1-based ordinal within the group's CURRENT card, assigned from the
   * group's monotonic counter when the row is first registered and IMMUTABLE
   * thereafter. The combined feed renders it as a `{n}. ` header prefix when
   * 2+ workers are running; survivors keep their numbers when an earlier
   * worker finishes (never renumbered positionally — #3298).
   */
  ordinal: number
}

/**
 * One shared feed message per (chatId, threadId). ALL live workers dispatched
 * to the same chat/thread render into this one message — so their edits form a
 * single per-message edit stream under the send gate's 1/sec per-chat ceiling
 * (last-write-wins coalescing + no-op skip) instead of N contending streams
 * that shed (#3084). A single-worker group renders the full 🛠 Worker card;
 * a 2+ worker group renders the combined `renderCombinedWorkerFeed` body.
 */
interface FeedGroup {
  /** Stable `(chat, thread)` key — see `feedKeyOf`: `<chatId>:<threadId|->`. */
  feedKey: string
  chatId: string
  threadId?: number
  messageId: number | null
  /**
   * Wall-clock ms the CURRENT shared message was posted (first paint / re-paint).
   * IMMUTABLE for the lifetime of a given `messageId`: stamped when a message id
   * is assigned and NEVER re-stamped by later edits, so the group-message
   * lifetime cap (`groupMessageLifetimeCapMs`) measures the reused message's true
   * absolute age and cannot be reset by a continuous edit stream. Reset to 0
   * whenever `messageId` goes null (rotation / stale-message drop).
   */
  messageCreatedAtMs: number
  lastBody: string | null
  /**
   * Substance signature of the last EDITED body — every rendered field EXCEPT
   * the volatile elapsed clock (and heartbeat live suffix). Used to distinguish
   * an elapsed-only change (paced to `elapsedRefreshMs`) from a real update
   * (new step / state / toolCount / tokens, rendered promptly). Null until the
   * group's first paint. See {@link groupSubstanceKey}.
   */
  lastSubstanceKey: string | null
  lastEditAt: number
  cooldownUntil: number
  /** Single serialization chain for the shared message — ticks can't interleave sends. */
  chain: Promise<void>
  /** Live workers in this group, keyed by agentId (insertion ≈ dispatch order). */
  workers: Map<string, WorkerRow>
  /**
   * Monotonic per-card worker counter — `++counter` hands each newly
   * registered row its stable {@link WorkerRow.ordinal}. Reset to 0 whenever a
   * fresh card starts (group creation, and registration into an emptied group
   * — which covers the group-reuse-after-terminal repaint, since finalize
   * drops rows from `workers` immediately), so every new card numbers from 1.
   */
  workerOrdinalCounter: number
  /**
   * Terminal renders (per finishing worker's recap) staged because a 429
   * cooldown / flood window blocked the edit. Keyed by agentId so a SECOND
   * worker finishing in the same window can't overwrite the first's staged
   * recap (the single-slot bug: two near-simultaneous last-worker finishes
   * leaked the earlier finished row forever). The heartbeat drains EVERY entry
   * once the cooldown expires so a finished feed can't get stuck on its last
   * running render. Empty when no finalize is pending.
   *
   * Note: the finishing row is dropped from `workers` immediately at finalize
   * time (decoupled from edit success — #3207 leaked-finished-row fix), so a
   * staged entry here is purely the best-effort terminal REPAINT; group
   * emptiness / deletion / unpin never wait on it.
   */
  pendingFinalize: Map<string, WorkerActivityView>
  /**
   * True once this group's shared message last rendered a TERMINAL recap (a
   * finished worker's done/failed/incomplete card), and no live worker has
   * repainted since. A later worker joining the group must NOT edit that
   * terminal message — it forces a fresh first-paint (new message) instead, so
   * a new dispatch never appends to a stale "done" card. Reset to false on any
   * fresh first-paint.
   */
  terminalPainted: boolean
}

const COOLDOWN_JITTER_MS = 500

/**
 * Static body the retired shared message is finalized to when the group-message
 * lifetime cap rotates to a fresh card (invisible-worker-cards review, FIX 1).
 * Without this the abandoned message stays frozen showing live-styled worker
 * rows and reads like a stuck worker. A single best-effort edit collapses it to
 * an honest "moved" note — issued once per rotation (≥ cap interval), never per
 * tick, so it adds no edit churn / pin storm. Plain voice, no em dash.
 *
 * Exported so the card-preview harness (`scripts/card-previews.ts`) renders the
 * real string rather than a copy that can drift from it.
 *
 * DELIBERATELY still a constant, not a card render (#3846). It shows no live
 * state — no elapsed, no tool count, no steps — so there is nothing for a
 * renderer to compose and no rolling window or char budget to enforce; routing
 * it through `renderStatusCard` would mean inventing a state to render. What it
 * DOES share with every other card is its type chrome, so line 1 comes from the
 * one title composer (`renderCardTitleLine`): if the 🛠 / **WORKER** convention
 * ever changes, this notice moves with it instead of being the one stale card.
 */
export const WORKER_CARD_SUPERSEDED_BODY =
  `${renderCardTitleLine('🛠', 'WORKER', 'continued')}\n\n` +
  '_Live progress moved to a fresh card to stay pinned._'

function extractRetryAfterSecs(err: unknown): number | null {
  if (err == null || typeof err !== 'object') return null
  const e = err as { error_code?: unknown; parameters?: { retry_after?: unknown } }
  if (e.error_code !== 429) return null
  const ra = e.parameters?.retry_after
  if (typeof ra === 'number' && Number.isFinite(ra) && ra > 0) return ra
  return null
}

/**
 * Classify a card-edit transport error. Card edits are a best-effort
 * liveness surface — a recoverable hiccup must never freeze the card, and
 * a permanent failure must never log a scary warning for something with
 * nothing to update.
 *
 *   'not_modified' — content identical to what's already shown. The card
 *     already reads correctly; treat as SUCCESS (no retry, no warning).
 *   'rate_limited' — 429 with retry_after. Back off; the heartbeat re-drives
 *     the edit after cooldown (running renders + deferred terminal edits).
 *   'gone'         — message/chat deleted or edit window expired. Nothing to
 *     update; drop the message silently (no warning — there is no card).
 *   'transient'    — anything else (network blip, 5xx). Retry on the next
 *     heartbeat tick; don't spam stderr.
 */
type EditOutcome = 'not_modified' | 'rate_limited' | 'gone' | 'transient'
function classifyEditError(err: unknown): EditOutcome {
  const retryAfter = extractRetryAfterSecs(err)
  if (retryAfter != null) return 'rate_limited'
  const desc =
    err instanceof Error ? err.message : err != null && typeof err === 'object' && 'description' in err
      ? String((err as { description?: unknown }).description)
      : String(err)
  const low = desc.toLowerCase()
  // "message is not modified" / "message was not modified" — Telegram's
  // identical-content signal. The card already shows the right thing.
  if (low.includes('not modified')) return 'not_modified'
  // Message or chat no longer exists, or the edit window (48h) has closed.
  // "message to edit not found" / "message to delete not found" / "chat not
  // found" / "message can't be edited". Nothing to update.
  if (
    low.includes('not found') ||
    low.includes("can't be edited") ||
    low.includes('cannot be edited') ||
    low.includes('not enough rights')
  ) {
    return 'gone'
  }
  return 'transient'
}

/**
 * Manager owning one live message per (chat,thread) into which all live
 * workers there coalesce. Public methods stay keyed by jsonl agent id (the
 * gateway wiring is unchanged): the manager resolves the enclosing feed group
 * internally. The gateway calls `update` on each watcher activity cue and
 * `finish` on terminal; `drop` discards a worker's state without a final edit
 * (error / supersession paths).
 */
export interface WorkerActivityFeed {
  /** True if a message is currently posted for this worker's feed group. */
  has(agentId: string): boolean
  /** The Telegram message_id currently posted for this worker's feed group, or
   *  null if none is posted (never painted, or dropped after a stale-edit
   *  re-post). Lets the gateway pin the EXISTING `🛠 Worker` message. Note:
   *  siblings sharing the chat/thread return the SAME id (one message). */
  messageIdOf(agentId: string): number | null
  /** True while the feed group `feedKey` (see `feedKeyOf` — `<chatId>:<threadId|->`) still
   *  tracks live work — used by the gateway's `wk:group:` pin reaper to exempt
   *  a live group's pin from the stale-TTL sweep (#3207). */
  hasRunningInFeed(feedKey: string): boolean
  /** Push a running-state cue. Returns the serialized op for tests. */
  update(
    agentId: string,
    chatId: string,
    view: WorkerActivityView,
    threadId?: number,
  ): Promise<void>
  /** Finalize a worker: drop its row from the combined feed (its result reaches
   *  the user via the separate handback), or — when it is the last live worker
   *  in the group — force the terminal recap edit. No-op if the worker was
   *  never tracked. */
  finish(agentId: string, view: WorkerActivityView): Promise<void>
  /**
   * Force a worker terminal from an AUTHORITATIVE watcher sweep
   * (`onTerminalCleanup`) or the backstop TTL, WITHOUT an external result view:
   * the terminal recap is synthesised from the worker's own last-known row
   * state (state → `done`, no fabricated result text — the real result reaches
   * the user via the separate handback, if one ran). When it was the last live
   * worker the shared card collapses to its terminal summary and unpins; with
   * siblings, its row is dropped and the combined body re-renders. Idempotent —
   * a no-op if the worker was already removed (e.g. `onFinish` fired first).
   */
  terminate(agentId: string): Promise<void>
  /** Forget a worker's state without a recap edit (e.g. error path); re-renders
   *  the group so the dropped worker disappears from the combined body. */
  drop(agentId: string): void
  /**
   * Issue #3023 (card resurrection). Undo a finalization: clear the durable
   * `finalized` gate (and any lingering per-row `finished` latch) so a
   * worker whose card was FALSELY finalized can be painted/edited again. The
   * watcher calls this (via the gateway's `onResurrect` wiring) when a
   * falsely-finalized worker's JSONL resumes growing. A fresh `running` cue
   * after this repaints a live card — the operator invariant that active work
   * stays visible. Idempotent; a no-op if the worker was never finalized.
   */
  resurrect(agentId: string): void
  /**
   * Boot / reconnect purge — reconcile the ENTIRE feed to empty and release
   * EVERY group's pin, unconditionally.
   *
   * Why this is a hard invariant, not a TTL: every tracked worker row is a live
   * sub-agent that was a CHILD PROCESS of the gateway. It cannot outlive a
   * gateway restart, and it cannot survive a bridge reconnect that reconstructs
   * the feed either — so any row still present when the feed is (re)initialised
   * is definitionally dead. Left alone, the OLD feed instance's `wk:group:` pins
   * are orphaned: the replacement feed is empty and never knew those groups, so
   * it never unpins them (the reconnect-orphaned-pin leak — no full-boot pin
   * sweep runs on a bare reconnect). This finalizes+removes every row and drives
   * `reconcilePin(messageId: null)` for every group so the coalesced card is
   * unpinned at once. Idempotent; a no-op on an already-empty feed.
   */
  purgeAllOnBoot(): void
  /** Clear the heartbeat interval (gateway shutdown). Idempotent. */
  stop(): void
  /** Manually fire one heartbeat tick (test hook). */
  heartbeatTick(): void
  /** Number of tracked workers across all feed groups (test/inspection hook). */
  readonly size: number
}

export function createWorkerActivityFeed(opts: WorkerActivityFeedOpts): WorkerActivityFeed {
  const log = opts.log ?? (() => {})
  const nowFn = opts.now ?? Date.now
  const floodWaitRemainingMs = opts.floodWaitRemainingMs ?? (() => 0)
  const minEditInterval = opts.minEditIntervalMs ?? 2500
  const elapsedRefreshMs = Math.max(minEditInterval, Math.floor(opts.elapsedRefreshMs ?? 15000))
  const firstPaintMin = opts.firstPaintMinMs ?? 4000
  const heartbeatTickMs = opts.heartbeatTickMs ?? 6000
  const maxRows = Math.max(1, Math.floor(opts.maxRows ?? 8))
  const staleWorkerTtlMs = Math.max(1, Math.floor(opts.staleWorkerTtlMs ?? 50 * 60_000))
  const absoluteRowLifetimeCapMs = Math.max(1, Math.floor(opts.absoluteRowLifetimeCapMs ?? 6 * 60 * 60_000))
  const groupMessageLifetimeCapMs = Math.max(1, Math.floor(opts.groupMessageLifetimeCapMs ?? 60 * 60_000))
  const reconcilePinFn = opts.reconcilePin ?? (() => {})
  const setIntervalFn =
    opts.setInterval ??
    ((cb: () => void, ms: number): unknown => {
      const t = setInterval(cb, ms)
      // Never keep the process alive on the heartbeat alone.
      ;(t as { unref?: () => void }).unref?.()
      return t
    })
  const clearIntervalFn = opts.clearInterval ?? ((handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>))

  /** Feed groups keyed by `feedKeyOf(chatId, threadId)` — `<chatId>:<threadId|->`. */
  const groups = new Map<string, FeedGroup>()
  /** Reverse index agentId → feedKey, so the agentId-keyed public API resolves
   *  its group in O(1). Cleared when a worker's row is removed. */
  const agentIndex = new Map<string, string>()

  /**
   * Agent ids that have been finalized (`finish` latched). Survives row/group
   * deletion so a LATE watcher `onProgress` tick — which can arrive after
   * `finish()`'s chain has fully settled — cannot resurrect a fresh row and
   * paint a running card on a worker that is already done. A late tick arrives
   * within seconds of finish (watcher poll cadence), so the set only needs to
   * cover recent finalizations — capped at FINALIZED_CAP and trimmed FIFO to
   * stay bounded across a long gateway lifetime.
   */
  const finalized = new Set<string>()
  const FINALIZED_CAP = 256
  function markFinalized(agentId: string): void {
    if (finalized.has(agentId)) return
    finalized.add(agentId)
    if (finalized.size > FINALIZED_CAP) {
      const oldest = finalized.values().next().value
      if (oldest != null) finalized.delete(oldest)
    }
  }
  let heartbeatTimer: unknown = null

  /**
   * The `(chat, thread)` identity of a feed group — and, prefixed with
   * `wk:group:`, the pin key that gets PERSISTED into status-pins.json.
   *
   * The separator and the topic-less sentinel are both load-bearing. This used
   * to be `` `${chatId} ${threadId ?? ''}` ``, which for a topic-less group
   * rendered as `-1004444444444 ` — a key ending in a bare space. On disk that
   * became `"pinKey": "wk:group:-1004444444444 "`: trailing whitespace that
   * survives JSON round-trips, is invisible in every log line and grep, and
   * cannot be distinguished by eye from the same chat WITH a topic. Any operator
   * or tool reconciling rows by chat would silently treat the two as one.
   *
   * `<chatId>:<threadId|->` is unambiguous in both directions: the topic-less
   * case is spelled explicitly (`-`), and a topic key can never be confused with
   * a topic-less one. Note chat ids are negative, so the `-` sentinel and the
   * sign of the id never occupy the same position.
   *
   * The value is opaque to every consumer (it round-trips through the pin key
   * and back into `hasRunningInFeed`), so the format may change; a key written
   * by an older build is work-scoped and is unpinned unconditionally by the next
   * boot's cleanup, so there is nothing to migrate.
   */
  function feedKeyOf(chatId: string, threadId?: number): string {
    return `${chatId}:${threadId ?? '-'}`
  }
  function groupOfAgent(agentId: string): FeedGroup | undefined {
    const key = agentIndex.get(agentId)
    return key != null ? groups.get(key) : undefined
  }

  function sendOptsFor(g: FeedGroup): Record<string, unknown> {
    return {
      disable_web_page_preview: true,
      // Sub-agent progress feed is a status surface, never the user's answer —
      // silence the open ping. (editMessageText ignores disable_notification,
      // so this is a no-op on the in-place edits that share these opts.)
      disable_notification: true,
      ...(g.threadId != null ? { message_thread_id: g.threadId } : {}),
    }
  }

  function noteRateLimited(g: FeedGroup, err: unknown, label: string): void {
    const retryAfter = extractRetryAfterSecs(err)
    if (retryAfter == null) return
    g.cooldownUntil = nowFn() + retryAfter * 1000 + COOLDOWN_JITTER_MS
    log(`worker-feed: ${label} 429 — backing off ${retryAfter}s`)
  }

  /**
   * Park a group in cooldown for the remaining of an open flood window (if
   * any), so the heartbeat's `nowFn() < g.cooldownUntil` guard suppresses every
   * further send/edit until the ban closes. Returns true when a window was open
   * (caller should abandon the current attempt). Two reads of the SAME on-disk
   * marker `robustApiCall` gates on — never a second notion of "channel open".
   */
  function parkIfFloodWindowOpen(g: FeedGroup): boolean {
    const remaining = floodWaitRemainingMs()
    if (remaining <= 0) return false
    const until = nowFn() + remaining + COOLDOWN_JITTER_MS
    if (until > g.cooldownUntil) g.cooldownUntil = until
    return true
  }

  function accumulateNarrative(row: WorkerRow, view: WorkerActivityView): void {
    const line = view.latestSummary.trim()
    if (line.length === 0) return

    // A REPEAT of the current step is counted, not dropped. A worker whose
    // steps all render the same label (e.g. Bash calls with no description →
    // "Running a command") used to hit the dedup below on every tool call and
    // the card held ONE frozen line for the whole job — indistinguishable from
    // a wedged worker. `·×N` makes the repetition visible and, because a new
    // count resets stepStartedAtMs, the climbing `· Ns` step timer restarts
    // with each real call.
    //
    // Gated on `view.toolCount`, NOT on the label: the watcher re-emits an
    // UNCHANGED view on every tick, so counting label-equality alone would
    // inflate the number with no work behind it. One increment per observed
    // tool call, deterministically.
    const last = row.narrative.length > 0 ? row.narrative[row.narrative.length - 1] : null
    if (last != null && stripRepeatSuffix(last) === line) {
      if (view.toolCount === row.lastNarrativeToolCount) return
      row.lastNarrativeToolCount = view.toolCount
      row.narrative[row.narrative.length - 1] = `${line} ·×${repeatCountOf(last) + 1}`
      row.stepStartedAtMs = nowFn()
      return
    }

    // Dedup within the whole rolling window (the watcher re-emits the same
    // narrative across ticks, and a preamble + its tool label can repeat
    // non-adjacently — the A,B,A duplication observed on live cards).
    if (row.narrative.some((l) => stripRepeatSuffix(l) === line)) return
    row.lastNarrativeToolCount = view.toolCount
    row.narrative.push(line)
    // The `→` current-step line just CHANGED — reset the per-step timer.
    row.stepStartedAtMs = nowFn()
    // Retain up to WORKER_HISTORY_MAX (6) — the lone-worker card's deepest
    // window (#3349). STATUS_ROLLING_LINES (5) governs the agent card, not this.
    if (row.narrative.length > WORKER_HISTORY_MAX) {
      row.narrative.splice(0, row.narrative.length - WORKER_HISTORY_MAX)
    }
  }

  /** Live wall-clock elapsed for a worker (climbs between fresh views). */
  function liveElapsed(row: WorkerRow, now: number): number {
    const base = row.dispatchAtMs != null ? now - row.dispatchAtMs : row.lastView?.elapsedMs ?? 0
    return Math.max(base, row.lastView?.elapsedMs ?? 0)
  }

  /** The running rows of a group, dispatch-ordered (oldest first, stable). */
  function runningRows(g: FeedGroup): WorkerRow[] {
    return [...g.workers.values()]
      .filter((w) => w.state === 'running' && w.lastView != null)
      .sort((a, b) => (a.dispatchAtMs ?? 0) - (b.dispatchAtMs ?? 0))
  }

  /**
   * Render a group's shared message body at `now`.
   *   - `terminalRecap` set + zero running → the last worker's terminal recap
   *     (single 🛠 Worker card, done/failed).
   *   - exactly one running → the full 🛠 Worker card (single-worker parity).
   *   - 2+ running → the combined `renderCombinedWorkerFeed` body.
   *   - zero running, no recap → null (nothing to show).
   * `heartbeat` toggles the single-worker climbing `· Ns` step suffix.
   */
  function renderGroupBody(
    g: FeedGroup,
    now: number,
    terminalRecap: WorkerActivityView | null,
    heartbeat: boolean,
  ): string | null {
    const running = runningRows(g)
    if (running.length === 0) {
      if (terminalRecap == null) return null
      return renderWorkerActivity(terminalRecap)
    }
    // On a normal update/finish the header shows the worker's LAST-REPORTED
    // elapsed (byte-stable for the dedup / no-op skip). Only the heartbeat —
    // which fires when no fresh view arrived — climbs a live wall-clock elapsed
    // so a silent worker still visibly advances.
    const elapsedFor = (r: WorkerRow): number =>
      heartbeat ? liveElapsed(r, now) : r.lastView?.elapsedMs ?? liveElapsed(r, now)
    if (running.length === 1) {
      const r = running[0]
      const view: WorkerActivityView = {
        ...(r.lastView as WorkerActivityView),
        elapsedMs: elapsedFor(r),
        narrativeLines: [...r.narrative],
      }
      let liveSuffix = ''
      if (heartbeat) {
        const stepElapsed = r.stepStartedAtMs != null ? now - r.stepStartedAtMs : liveElapsed(r, now)
        liveSuffix = formatStepSuffix(stepElapsed)
      }
      return renderWorkerActivity(view, liveSuffix)
    }
    const rows: CombinedWorkerRow[] = running.map((r) => {
      const v = r.lastView as WorkerActivityView
      const currentStep = r.narrative.length > 0 ? r.narrative[r.narrative.length - 1] : v.latestSummary
      return {
        description: v.description,
        // Stable per-card ordinal — assigned at registration, kept for the
        // card's life (survivors don't renumber when an earlier worker ends).
        ordinal: r.ordinal,
        elapsedMs: elapsedFor(r),
        toolCount: v.toolCount,
        totalTokens: v.totalTokens,
        currentStep,
        // Full per-worker rolling history (oldest→newest) so the combined feed
        // can paint an adaptive-depth ✓/→ trail, not just the latest line. The
        // renderer clamps depth to the shared body-line budget; when a worker
        // has no narrative yet this is empty and it falls back to currentStep.
        historyLines: r.narrative.length > 0 ? [...r.narrative] : undefined,
        model: v.model,
      }
    })
    return renderCombinedWorkerFeed(rows, { maxRows })
  }

  /**
   * Substance signature of a group's render at `now` — a stable string of every
   * field that renders EXCEPT the volatile elapsed clock (and the heartbeat
   * live suffix, which is elapsed-derived). Two renders with the same substance
   * key differ only in their clock; an edit between them advances nothing the
   * user cares about and is exactly the churn that accumulates into a flood ban.
   *
   * Built from the group data (not by string-stripping the rendered body) so it
   * is deterministic and robust to render-format changes: description, state,
   * toolCount, totalTokens, and the full narrative trail per running row (or the
   * terminal recap's state/result/narrative when finalizing).
   */
  function groupSubstanceKey(g: FeedGroup, terminalRecap: WorkerActivityView | null): string {
    // Unambiguous delimiters so adjacent fields can never blur into a boundary
    // collision (e.g. toolCount `1`+desc `"23"` vs toolCount `12`+desc `"3"`).
    // FS separates fields within a row; RS separates rows in the combined body.
    const FS = '\x00'
    const RS = '\x1e'
    if (terminalRecap != null) {
      return [
        'T',
        terminalRecap.state,
        terminalRecap.description,
        terminalRecap.toolCount,
        terminalRecap.totalTokens ?? '',
        terminalRecap.latestSummary,
        ...(terminalRecap.narrativeLines ?? []),
      ].join(FS)
    }
    const running = runningRows(g)
    if (running.length === 0) return 'EMPTY'
    return running
      .map((r) => {
        const v = r.lastView as WorkerActivityView
        return [
          r.agentId,
          v.state,
          v.description,
          v.toolCount,
          v.totalTokens ?? '',
          ...r.narrative,
        ].join(FS)
      })
      .join(RS)
  }

  /** Remove a worker's row + index entry; delete the group if it is now empty. */
  function removeWorker(g: FeedGroup, agentId: string): void {
    g.workers.delete(agentId)
    agentIndex.delete(agentId)
    maybeDeleteGroup(g)
  }

  /**
   * Force-evict a LEAKED row from the specific group it lives in, used when the
   * agentIndex has desynced (points at a different feed, or none) so the normal
   * `removeWorker`/`terminateWorker` path — which resolves the group via the
   * index — can't reach it. Deletes the index entry ONLY if it still points at
   * THIS group, so a live row for the same agentId in another feed keeps its
   * mapping intact.
   */
  function evictRowFromGroup(g: FeedGroup, agentId: string): void {
    g.workers.delete(agentId)
    if (agentIndex.get(agentId) === g.feedKey) agentIndex.delete(agentId)
    maybeDeleteGroup(g)
  }

  /**
   * Delete an empty group. A group is gone only when it has NO tracked workers
   * AND no staged terminal repaints pending — the latter keeps the group object
   * reachable for the heartbeat re-drive after a flood/429 deferred the recap,
   * without keeping it "alive" for the pin (syncPin / hasRunningInFeed count
   * only live workers, so an emptied-but-pending group is already unpinned).
   */
  function maybeDeleteGroup(g: FeedGroup): void {
    if (g.workers.size === 0 && g.pendingFinalize.size === 0) groups.delete(g.feedKey)
  }

  /** Live (not-yet-finished) workers still tracked in a group. */
  function hasLiveWorker(g: FeedGroup): boolean {
    for (const w of g.workers.values()) if (!w.finished) return true
    return false
  }

  /**
   * Reconcile the GROUP-level status pin (#3207 review). Pin the shared message
   * while the group has a posted message AND at least one tracked worker;
   * unpin the instant the group empties. Because it is keyed by the whole group
   * (not a single worker), a per-worker finish never unpins a message a sibling
   * still needs — the survivors keep the pin until the LAST worker is done.
   */
  function syncPin(g: FeedGroup): void {
    // Pin follows LIVE membership, not row count: a finished-but-not-yet-swept
    // row (or a staged terminal repaint) must NOT keep the pin. Unpin the
    // instant the last running worker is gone.
    const messageId = g.messageId != null && hasLiveWorker(g) ? g.messageId : null
    reconcilePinFn({ feedKey: g.feedKey, chatId: g.chatId, threadId: g.threadId, messageId })
  }

  /**
   * Drive the group's shared message to the current combined body. Handles
   * first-paint gating, the proactive throttle (bypassed by `force`), the
   * dedup/no-op skip, the send-gate SHED contract, and 429/flood cooldown.
   * `terminalRecap` (set on the last worker's finish) renders + finalizes the
   * message, then removes the finished row.
   */
  async function doRender(
    g: FeedGroup,
    opts2: { force?: boolean; heartbeat?: boolean; terminalRecap?: WorkerActivityView; finishingAgentId?: string } = {},
  ): Promise<void> {
    const now = nowFn()
    const isTerminal = opts2.terminalRecap != null
    const finishingAgentId = opts2.finishingAgentId

    // Stage the terminal recap for the heartbeat re-drive, keyed by the
    // FINISHING agent so a second worker finishing in the same cooldown/flood
    // window can't overwrite an earlier staged recap (#3207: the single-slot
    // overwrite that orphaned finished rows). Best-effort repaint only — the
    // row is dropped and the pin released independently, below.
    const stageRecap = (): void => {
      if (isTerminal && finishingAgentId != null && opts2.terminalRecap != null) {
        g.pendingFinalize.set(finishingAgentId, opts2.terminalRecap)
      }
    }
    // Terminal repaint no longer pending (landed / not-modified / gone / never
    // had a message): stop re-driving it and reap the group if now fully empty.
    const clearStaged = (): void => {
      if (finishingAgentId != null) g.pendingFinalize.delete(finishingAgentId)
      maybeDeleteGroup(g)
      syncPin(g)
    }

    // #3207 leaked-finished-row fix — decouple row removal + unpin from the
    // terminal edit's SUCCESS. The instant a worker finalizes we drop its row
    // and release the group pin; a 429 / flood / transport failure on the
    // cosmetic recap edit must NEVER keep the group, its message, or its pin
    // alive. The recap is staged (above) purely as a best-effort repaint.
    if (isTerminal) {
      stageRecap()
      if (finishingAgentId != null && g.workers.has(finishingAgentId)) {
        removeWorker(g, finishingAgentId)
      }
      // Only latch terminalPainted when NO live worker remains at paint time.
      // Race: this finalize was the last live worker when the chain latched, but
      // a fresh worker B may have called update() and joined g.workers before
      // this body runs — in which case renderGroupBody paints B's RUNNING card,
      // not a terminal recap. Setting the flag true unconditionally would
      // mislabel that running paint as terminal (a spurious group-reuse fresh-
      // paint on B's next update). Reflect reality: the group only went terminal
      // if it's actually empty of live workers.
      g.terminalPainted = !hasLiveWorker(g)
      syncPin(g)
    }

    if (now < g.cooldownUntil) {
      // Row already dropped + unpinned above; the recap stays staged so the
      // heartbeat re-drives the repaint once the cooldown expires.
      return
    }
    // A flood window is open: the gate would SHED every call. Park in cooldown
    // and make ZERO api calls until it closes; the heartbeat re-drives.
    if (parkIfFloodWindowOpen(g)) {
      return
    }

    const body = renderGroupBody(g, now, opts2.terminalRecap ?? null, opts2.heartbeat ?? false)
    const substanceKey = groupSubstanceKey(g, opts2.terminalRecap ?? null)
    if (body == null) {
      // Nothing to show. On a terminal finalize the row is already dropped;
      // clear the staged repaint (the handback carries the result).
      if (isTerminal) clearStaged()
      return
    }

    // First paint: hold until some worker in the group has run long enough.
    if (g.messageId == null) {
      // A terminal recap for a group that never painted → nothing to finalize;
      // never first-paint a terminal card (trivial workers stay silent, the
      // handback carries the result — matches the pre-coalesce doFinish guard).
      // The finished row is already dropped; just clear the staged repaint.
      if (isTerminal) {
        clearStaged()
        return
      }
      const maxElapsed = Math.max(0, ...runningRows(g).map((r) => liveElapsed(r, now)))
      if (maxElapsed < firstPaintMin) return
      try {
        const sent = await opts.bot.sendMessage(g.chatId, body, sendOptsFor(g))
        // Shed contract (#3084): the gate resolves `undefined`/non-object for a
        // shed send (open flood window) or dropped-stale `useful` TTL. That is
        // NOT a delivered message — record no id, park on any window, let the
        // heartbeat re-drive.
        if (sent == null || typeof sent.message_id !== 'number') {
          parkIfFloodWindowOpen(g)
          log(`worker-feed: first paint shed by send gate feed=${g.feedKey} — not delivered`)
          return
        }
        g.messageId = sent.message_id
        // Stamp the reused-message birth time (immutable for this id) so the
        // group-message lifetime cap measures the message's true absolute age.
        g.messageCreatedAtMs = now
        g.lastBody = body
        g.lastSubstanceKey = substanceKey
        g.lastEditAt = now
        // A fresh message is a live running paint, never a terminal recap.
        g.terminalPainted = false
        // Group's first (or re-established) message is up → pin it for the group.
        syncPin(g)
        log(
          `worker-feed: paint feed=${g.feedKey} chat=${g.chatId} ` +
            `thread=${g.threadId ?? '-'} msgId=${g.messageId} workers=${g.workers.size} bytes=${body.length}`,
        )
      } catch (err) {
        noteRateLimited(g, err, 'send')
        log(`worker-feed: send failed: ${(err as Error).message}`)
      }
      return
    }

    // Dedup + proactive throttle (finish/terminal edits force through).
    if (body === g.lastBody) {
      if (isTerminal) clearStaged()
      return
    }
    if (!opts2.force && !isTerminal) {
      // Spacing floor: never edit the same message faster than the 429 floor.
      if (now - g.lastEditAt < minEditInterval) return
      // Elapsed-only pacing (flood-ban defense): if the SUBSTANCE is unchanged
      // since the last edit — the body differs only because the clock advanced —
      // hold the edit until the coarse `elapsedRefreshMs` cadence. A real change
      // (new step / state / toolCount / tokens) shifts `substanceKey` and falls
      // through immediately (subject only to the spacing floor above). This is
      // what collapses the sustained ~0.33/s clock-only edit stream that
      // accumulates into Telegram's per-message flood counter.
      const substanceChanged = substanceKey !== g.lastSubstanceKey
      if (!substanceChanged && now - g.lastEditAt < elapsedRefreshMs) return
    }

    try {
      // #3848: tell the transport whether this is the card's LAST frame. A
      // terminal recap must not be shed with the heartbeat repaints.
      const res = await opts.bot.editMessageText(
        g.chatId, g.messageId, body, sendOptsFor(g), { terminal: isTerminal },
      )
      // Shed honesty (#3084): a cosmetic edit the gate shed resolves the
      // distinguishable SEND_GATE_SHED sentinel (NOT a bare `undefined`, which
      // the gate reserves for a benign no-op drop whose payload IS on screen).
      // The shed payload is NOT on screen, so do not record it as `lastBody`.
      if (isSendGateShed(res)) {
        parkIfFloodWindowOpen(g)
        // Recap stays staged (above); row already dropped + unpinned.
        return
      }
      g.lastBody = body
      g.lastSubstanceKey = substanceKey
      g.lastEditAt = now
      if (isTerminal) {
        log(
          `worker-feed: finish feed=${g.feedKey} chat=${g.chatId} thread=${g.threadId ?? '-'} ` +
            `msgId=${g.messageId} agent=${finishingAgentId ?? '-'} ` +
            `state=${opts2.terminalRecap?.state ?? 'done'} bytes=${body.length}`,
        )
      } else {
        log(
          `worker-feed: edit feed=${g.feedKey} chat=${g.chatId} ` +
            `thread=${g.threadId ?? '-'} msgId=${g.messageId} workers=${g.workers.size} bytes=${body.length}`,
        )
        // Re-assert the group pin on the steady-state edit path (invisible-
        // worker-cards fix). `syncPin` was previously called ONLY at lifecycle
        // edges (first-paint / terminal / GC), so once a long-lived reused
        // message lost its pin out-of-band it was edited live forever but never
        // re-pinned → scroll-buried. This closes that gap deterministically. It
        // is a NO-OP when the pin is already correct: `decidePinAction` returns
        // `noop` on equal claim id (status-pin.ts), so this makes ZERO Telegram
        // calls on the common path and cannot create a pin storm — when the
        // claim was dropped (variant 1) it re-pins the current message.
        syncPin(g)
      }
      if (isTerminal) clearStaged()
    } catch (err) {
      const outcome = classifyEditError(err)
      if (outcome === 'rate_limited') {
        noteRateLimited(g, err, isTerminal ? 'finish' : 'edit')
        // Recap stays staged; the heartbeat re-drives after the cooldown.
        return
      }
      if (outcome === 'not_modified') {
        g.lastBody = body
        g.lastSubstanceKey = substanceKey
        g.lastEditAt = now
        if (isTerminal) clearStaged()
        return
      }
      if (outcome === 'gone') {
        // Message/chat gone or edit window closed — no card to update. Drop the
        // stale message id; a fresh first-paint re-establishes one if workers
        // are still live. On a terminal finalize, clear the staged repaint.
        g.messageId = null
        g.messageCreatedAtMs = 0
        g.lastBody = null
        g.lastSubstanceKey = null
        // The pinned message no longer exists → release the group pin claim
        // (clearStaged already re-syncs on the terminal path).
        if (isTerminal) clearStaged()
        else syncPin(g)
        return
      }
      // 'transient' — leave the message intact; the heartbeat re-attempts.
      // Recap stays staged for the terminal path.
      log(`worker-feed: edit transient error feed=${g.feedKey}: ${(err as Error).message}`)
    }
  }

  /**
   * Shared terminal-finalize path for a worker whose row is still tracked.
   * Latches the row terminal synchronously (so a late `running` cue on the
   * chain can't resurrect it), then on the chain either drops the row + re-
   * renders the surviving siblings, or — when it was the last live worker —
   * finalizes the shared message to its terminal recap. Used by `finish` (with
   * the gateway's onFinish view) AND by `terminate` (authoritative watcher
   * sweep / TTL backstop, view synthesised from the row's own last state).
   */
  function finalizeWorker(group: FeedGroup, agentId: string, row: WorkerRow, view: WorkerActivityView): Promise<void> {
    row.finished = true
    // Preserve the truthful terminal state through to the row (done / failed /
    // incomplete) — never collapse a reaped 'incomplete' into 'done'. view.state
    // is always terminal on this path (finalize is only reached for a finishing
    // worker), so threading it verbatim is correct.
    row.state = view.state
    markFinalized(agentId)
    group.chain = group.chain
      .then(() => {
        const others = runningRows(group).filter((w) => w.agentId !== agentId)
        if (others.length > 0) {
          // Siblings still live → drop this row from the combined body and re-
          // render the running set. The group pin STAYS (siblings still need
          // the shared message).
          removeWorker(group, agentId)
          syncPin(group)
          return doRender(group, { force: true })
        }
        // Last live worker → finalize the shared message to its terminal recap.
        const recap: WorkerActivityView = { ...view, narrativeLines: [...row.narrative] }
        return doRender(group, { force: true, terminalRecap: recap, finishingAgentId: agentId })
      })
      .catch((err) => {
        log(`worker-feed: finalize chain error ${agentId}: ${(err as Error).message}`)
      })
    return group.chain
  }

  /**
   * Force a worker terminal without an external result view (authoritative
   * `onTerminalCleanup` sweep or the TTL backstop). Synthesises the recap from
   * the row's own last-known state — state `incomplete` (NOT `done`), NO
   * fabricated result text (the real result, if any, reaches the user via the
   * separate handback). Reaching here means NO clean finish arrived: a clean
   * `onFinish` removes the row FIRST (this call is then a no-op), and an
   * errored worker goes through `onFinish(outcome:'failed')` → `finish` — so a
   * row still present at terminate time genuinely ended WITHOUT a result. It
   * must therefore render `incomplete · …`, never "done" (a crash/vanish read
   * as "done" was the residual this fixes). Idempotent: a no-op once the worker
   * was already removed (onFinish first). Depth-generic: operates on the
   * generic worker row by agentId, identical at every nesting level.
   */
  function terminateWorker(agentId: string): Promise<void> {
    const g = groupOfAgent(agentId)
    const row = g?.workers.get(agentId)
    if (g == null || row == null) {
      // Already gone (onFinish removed it) — latch finalized so a late cue can't
      // resurrect, and no-op.
      markFinalized(agentId)
      return Promise.resolve()
    }
    if (row.finished) {
      // Terminal already latched; the chain will settle removal. No-op.
      return g.chain
    }
    const lv = row.lastView
    const view: WorkerActivityView = {
      description: lv?.description ?? 'background task',
      lastTool: null,
      toolCount: lv?.toolCount ?? 0,
      totalTokens: lv?.totalTokens,
      // No fabricated result paragraph — an authoritative sweep can't know what
      // the worker returned; the terminal card shows the header struck-through
      // as `incomplete`, and the handback (if it ran) carries the actual result.
      latestSummary: '',
      elapsedMs: liveElapsed(row, nowFn()),
      state: 'incomplete',
      model: lv?.model,
    }
    return finalizeWorker(g, agentId, row, view)
  }

  // Arm the heartbeat once at construction. The real timer is `.unref()`'d so
  // it never keeps the process alive; tests inject setInterval/clearInterval.
  function heartbeatTick(): void {
    const now = nowFn()
    // Backstop TTL sweep: force-terminate any worker row that has gone silent
    // past `staleWorkerTtlMs` (no `update()` cue AND not already finished). This
    // is the durable guard against an immortal card if BOTH terminal signals
    // are missed — the gateway's `onFinish` AND the watcher's authoritative
    // `onTerminalCleanup` sweep. Collect the stale agent ids first (terminate
    // mutates the group's worker map), then terminate each through its chain so
    // the render/unpin happens under the normal cooldown/flood guards.
    //
    // TWO independent triggers, OR'd per row:
    //   1. SILENCE TTL (`staleWorkerTtlMs`, keyed off `lastUpdateAt`) — a row
    //      that stopped receiving cues.
    //   2. ABSOLUTE row-lifetime cap (`absoluteRowLifetimeCapMs`, keyed off the
    //      IMMUTABLE `createdAtMs`) — a row past an absolute age NO MATTER how
    //      recently it updated. This is the durable guard against the immortal-
    //      but-updating card the silence sweep can never catch: a leaked row
    //      that keeps getting `update()` cues every heartbeat resets
    //      `lastUpdateAt` forever, so only an age anchor immune to that reset can
    //      reap it (Carrie 5h zombie pin, re-edited 3000+ times).
    const staleAgentIds: Array<{ g: FeedGroup; agentId: string; reason: 'silence' | 'absolute' }> = []
    const staleFinished: Array<{ g: FeedGroup; agentId: string; reason: 'silence' | 'absolute' }> = []
    for (const g of groups.values()) {
      for (const row of g.workers.values()) {
        const silent = now - row.lastUpdateAt >= staleWorkerTtlMs
        const tooOld = now - row.createdAtMs >= absoluteRowLifetimeCapMs
        if (!silent && !tooOld) continue
        // Attribute the reap to the absolute cap only when silence alone would
        // NOT have fired — so the log names the trigger that actually caught it.
        const reason: 'silence' | 'absolute' = silent ? 'silence' : 'absolute'
        // Carry the group the row was ACTUALLY found in (not `groupOfAgent`,
        // which resolves via the agentIndex — that index can desync from a
        // group's `workers` map when an agentId migrated feeds, orphaning the
        // old row. Using `g` guarantees the reap evicts the row that exists.)
        if (row.finished) staleFinished.push({ g, agentId: row.agentId, reason })
        else staleAgentIds.push({ g, agentId: row.agentId, reason })
      }
    }
    // GC any FINISHED row still lingering past the TTL (#3207: finished rows
    // were exempt from the sweep — `if (!row.finished …)` — so a stuck finished
    // row could keep a group, its message, and its pin alive forever). The
    // normal finalize path drops the row immediately now, but reap directly
    // here as a durable backstop: `terminate()` no-ops on a finished row, so
    // remove it and release the pin without routing through it.
    for (const { g, agentId, reason } of staleFinished) {
      if (reason === 'absolute') {
        const age = Math.floor((now - (g.workers.get(agentId)?.createdAtMs ?? now)) / 1000)
        log(`worker-feed: ABSOLUTE cap GC finished row agent=${agentId} feed=${g.feedKey} — age ${age}s (>= ${Math.floor(absoluteRowLifetimeCapMs / 1000)}s); reaping immortal finished row`)
      } else {
        log(`worker-feed: TTL GC finished row agent=${agentId} feed=${g.feedKey} — reaping leaked finished row`)
      }
      g.pendingFinalize.delete(agentId)
      removeWorker(g, agentId)
      syncPin(g)
    }
    for (const { g, agentId, reason } of staleAgentIds) {
      // Read the row from the group it was FOUND in, so the log reports the
      // real age even when the agentIndex has desynced (the old bug printed
      // "no update in 0s" because it read `groupOfAgent(agentId)`, which
      // resolved to a different/absent group and fell back to `now`).
      const row = g.workers.get(agentId)
      if (reason === 'absolute') {
        const age = Math.floor((now - (row?.createdAtMs ?? now)) / 1000)
        log(`worker-feed: ABSOLUTE cap reap agent=${agentId} — row age ${age}s (>= ${Math.floor(absoluteRowLifetimeCapMs / 1000)}s); force-terminating immortal row (survives lastUpdateAt reset)`)
      } else {
        log(`worker-feed: TTL reap agent=${agentId} — no update in ${Math.floor((now - (row?.lastUpdateAt ?? now)) / 1000)}s (>= ${Math.floor(staleWorkerTtlMs / 1000)}s); force-terminating leaked row`)
      }
      // Normal honest finalize when the agentIndex still points at THIS group
      // (renders the terminal recap + releases the pin through the chain). But
      // when the index has desynced — it resolves to a different group or none
      // — `terminateWorker` would look up the wrong/no row and no-op, leaving
      // this row to churn every heartbeat forever. Detect that and force-evict
      // the leaked row directly from the group it actually lives in.
      if (groupOfAgent(agentId) === g) {
        void terminateWorker(agentId)
      } else {
        log(`worker-feed: force-evicting leaked row agent=${agentId} feed=${g.feedKey} — agentIndex desynced (points elsewhere); removing directly`)
        markFinalized(agentId)
        evictRowFromGroup(g, agentId)
        syncPin(g)
      }
    }
    for (const g of [...groups.values()]) {
      // Deferred-finalize re-drive: a terminal edit that hit a cooldown/flood
      // window was staged on `pendingFinalize`. Re-drive it once the cooldown
      // expires so a finished feed can't get stuck on its last running render.
      if (g.pendingFinalize.size > 0 && now >= g.cooldownUntil) {
        // Drain EVERY staged terminal recap, keyed by its finishing agent
        // (#3207: the single `pendingFinalize` slot dropped all but one when
        // multiple workers finished inside the same cooldown/flood window, so
        // the earlier finished rows leaked). Each re-drive removes its own
        // staged entry on success and reaps the group once fully empty.
        for (const [agentId, recap] of [...g.pendingFinalize]) {
          g.chain = g.chain
            .then(() => doRender(g, { force: true, terminalRecap: recap, finishingAgentId: agentId }))
            .catch((err) => {
              log(`worker-feed: heartbeat finalize re-drive error feed=${g.feedKey}: ${(err as Error).message}`)
            })
        }
        continue
      }

      if (now < g.cooldownUntil) continue
      const running = runningRows(g)
      if (running.length === 0) continue

      // ABSOLUTE group-message lifetime cap (invisible-worker-cards fix, defense
      // in depth). While workers overlap continuously the shared message is
      // never reset, so one message can live for hours; if its pin was lost
      // out-of-band and the in-memory claim went STALE (claim still names this
      // id → `decidePinAction` no-ops on equal id), `syncPin` alone can never
      // re-pin it. Force-rotate to a fresh message past an absolute age WHILE
      // live workers remain: drop the id (unpinning the stale claim via
      // `syncPin`, which clears it to null), then fall through to the first-
      // paint path, whose `syncPin` re-pins the NEW message from a null claim.
      // Costs exactly one unpin + one pin per cap interval — never a burst.
      if (g.messageId != null && now - g.messageCreatedAtMs >= groupMessageLifetimeCapMs) {
        const age = Math.floor((now - g.messageCreatedAtMs) / 1000)
        const retiredId = g.messageId
        log(
          `worker-feed: group-message lifetime cap rotate feed=${g.feedKey} ` +
            `msgId=${retiredId} — age ${age}s (>= ${Math.floor(groupMessageLifetimeCapMs / 1000)}s); ` +
            `rotating to a fresh message to re-establish the pin surface`,
        )
        g.messageId = null
        g.messageCreatedAtMs = 0
        g.lastBody = null
        g.lastSubstanceKey = null
        // Clear the (possibly stale) pin claim for the retired message; the
        // fresh first-paint below re-pins the new one from a null claim.
        syncPin(g)
        // FIX 1: collapse the retired message to an honest "moved" note so it
        // doesn't sit frozen showing live-styled rows (mistakable for a stuck
        // worker). ONE best-effort edit per rotation (≥ cap interval), fired
        // off-chain and swallowing errors — never per-tick, never a burst.
        // #3848: terminal — this is the retired message's LAST frame, and it
        // fires at most once per `groupMessageLifetimeCapMs`, so promoting it
        // out of the cosmetic budget costs nothing and stops the retired card
        // being left frozen showing live-styled rows.
        void opts.bot
          .editMessageText(
            g.chatId, retiredId, WORKER_CARD_SUPERSEDED_BODY, sendOptsFor(g), { terminal: true },
          )
          .catch(() => {})
      }

      // First-paint path: no message yet and some worker has now crossed
      // firstPaintMin (a prose-silent worker's single early tick was held).
      if (g.messageId == null) {
        const maxElapsed = Math.max(0, ...running.map((r) => liveElapsed(r, now)))
        if (maxElapsed < firstPaintMin) continue
        g.chain = g.chain
          .then(() => doRender(g, {}))
          .catch((err) => {
            log(`worker-feed: heartbeat first-paint chain error feed=${g.feedKey}: ${(err as Error).message}`)
          })
        continue
      }

      if (now - g.lastEditAt < minEditInterval) continue
      const stale = now - g.lastEditAt >= heartbeatTickMs
      if (!stale) continue
      // Re-render THROUGH the chain → doRender path with climbing elapsed.
      g.chain = g.chain
        .then(() => doRender(g, { heartbeat: true }))
        .catch((err) => {
          log(`worker-feed: heartbeat chain error feed=${g.feedKey}: ${(err as Error).message}`)
        })
    }
  }

  heartbeatTimer = setIntervalFn(heartbeatTick, heartbeatTickMs)

  // TEST-ONLY: hand out the narrow index-repoint control (see opts doc). Never
  // provided in production wiring, so this is a no-op there.
  opts.exposeTestControls?.({
    repointAgentIndex: (agentId, feedKey) => {
      if (feedKey == null) agentIndex.delete(agentId)
      else agentIndex.set(agentId, feedKey)
    },
  })

  return {
    has(agentId) {
      const g = groupOfAgent(agentId)
      return g != null && g.messageId != null && g.workers.has(agentId)
    },
    messageIdOf(agentId) {
      return groupOfAgent(agentId)?.messageId ?? null
    },
    hasRunningInFeed(feedKey) {
      const g = groups.get(feedKey)
      // Count only RUNNING (not-yet-finished) rows (#3207): a finished row
      // lingering pre-sweep — or a group kept alive solely for a staged
      // terminal repaint — is NOT running, so the gateway's `wk:group:` pin
      // reaper must be free to unpin it.
      return g != null && hasLiveWorker(g)
    },
    get size() {
      let n = 0
      for (const g of groups.values()) n += g.workers.size
      return n
    },
    update(agentId, chatId, view, threadId) {
      // No chat to post to (owner DM unconfigured) — don't create state that
      // would retry a failing send('') every tick.
      if (chatId.length === 0) return Promise.resolve()
      // Resurrection guard: a worker already finalized must not get a fresh
      // running cue (a late watcher tick would repaint a done worker as live).
      if (finalized.has(agentId)) return Promise.resolve()
      const existingRow = groupOfAgent(agentId)?.workers.get(agentId)
      if (existingRow?.finished === true) return Promise.resolve()

      const feedKey = feedKeyOf(chatId, threadId)
      // Feed-migration cleanup (root-cause of the "no update in 0s" churn): if
      // this agentId is already indexed to a DIFFERENT feed, its prior row is
      // about to be orphaned (we re-index below to the new feed, but the old
      // group's `workers` map still holds the stale row — invisible to
      // `groupOfAgent` forever after, so the TTL sweep can never evict it and
      // it churns every heartbeat). Evict the stale row from its old group now.
      const priorFeedKey = agentIndex.get(agentId)
      if (priorFeedKey != null && priorFeedKey !== feedKey) {
        const priorGroup = groups.get(priorFeedKey)
        if (priorGroup != null) {
          evictRowFromGroup(priorGroup, agentId)
          syncPin(priorGroup)
        }
      }
      let g = groups.get(feedKey)
      if (g == null) {
        g = {
          feedKey,
          chatId,
          threadId,
          messageId: null,
          messageCreatedAtMs: 0,
          lastBody: null,
          lastSubstanceKey: null,
          lastEditAt: 0,
          cooldownUntil: 0,
          chain: Promise.resolve(),
          workers: new Map(),
          workerOrdinalCounter: 0,
          pendingFinalize: new Map(),
          terminalPainted: false,
        }
        groups.set(feedKey, g)
      }
      // Group-reuse-after-terminal (#3207): a later worker landing in a group
      // whose shared message last rendered a TERMINAL recap (its prior workers
      // all finished, but the group lingered — e.g. a staged repaint, or a
      // finished row not yet swept) must NOT inherit that message id and edit
      // the "done" card. Force a fresh first-paint (new message) so the new
      // dispatch never appends to a stale terminal card. Only triggers when no
      // live worker remains AND the group last went terminal.
      if (!g.workers.has(agentId) && g.terminalPainted && !hasLiveWorker(g)) {
        g.messageId = null
        g.messageCreatedAtMs = 0
        g.lastBody = null
        g.lastSubstanceKey = null
        g.pendingFinalize.clear()
        g.terminalPainted = false
        // The stale terminal message is no longer this group's pinned surface.
        syncPin(g)
      }
      let row = g.workers.get(agentId)
      if (row == null) {
        // A registration into an EMPTIED group starts a fresh card — number
        // from 1 again rather than continuing the dead card's sequence.
        if (g.workers.size === 0) g.workerOrdinalCounter = 0
        row = {
          agentId,
          ordinal: ++g.workerOrdinalCounter,
          narrative: [],
          lastNarrativeToolCount: null,
          lastView: null,
          state: 'running',
          finished: false,
          lastUpdateAt: nowFn(),
          createdAtMs: nowFn(),
          dispatchAtMs: null,
          stepStartedAtMs: null,
        }
        g.workers.set(agentId, row)
        agentIndex.set(agentId, feedKey)
      }
      // Stamp liveness for the backstop TTL sweep (this is the worker's most
      // recent observed activity cue).
      row.lastUpdateAt = nowFn()
      // Accumulate before the gate so a throttled tick still grows the
      // narrative — it surfaces on the next edit that does fire.
      accumulateNarrative(row, view)
      row.state = 'running'
      row.lastView = { ...view, narrativeLines: [...row.narrative] }
      if (row.dispatchAtMs == null) row.dispatchAtMs = nowFn() - view.elapsedMs

      const group = g
      group.chain = group.chain.then(() => doRender(group)).catch((err) => {
        log(`worker-feed: update chain error ${agentId}: ${(err as Error).message}`)
      })
      return group.chain
    },
    finish(agentId, view) {
      const g = groupOfAgent(agentId)
      const row = g?.workers.get(agentId)
      if (g == null || row == null) {
        // Never tracked (trivial worker) — mark finalized so a late tick can't
        // resurrect, and let the handback carry the result.
        markFinalized(agentId)
        return Promise.resolve()
      }
      // Latch + finalize via the shared path (drop-with-siblings / terminal
      // recap on the last worker). Synchronous latch inside finalizeWorker
      // stops a late `running` cue on the chain from resurrecting the row.
      return finalizeWorker(g, agentId, row, view)
    },
    terminate(agentId) {
      return terminateWorker(agentId)
    },
    drop(agentId) {
      // A dropped worker is also done — mark finalized so a late tick can't
      // resurrect a running card on it (same gate as `finish`).
      markFinalized(agentId)
      const g = groupOfAgent(agentId)
      if (g == null) return
      const hadMessage = g.messageId != null
      removeWorker(g, agentId)
      // Group pin follows membership: unpin if this emptied the group, else
      // keep it (siblings still need the shared message).
      if (hadMessage) syncPin(g)
      // Re-render so the dropped worker disappears from a combined body. Skip
      // when the group is gone (removeWorker deleted it) or never painted.
      if (hadMessage && groups.has(g.feedKey) && runningRows(g).length > 0) {
        g.chain = g.chain
          .then(() => doRender(g, { force: true }))
          .catch((err) => {
            log(`worker-feed: drop re-render error ${agentId}: ${(err as Error).message}`)
          })
      }
    },
    resurrect(agentId) {
      // Issue #3023: the worker's card was falsely finalized and its JSONL has
      // resumed. Re-open the paint path: drop the durable finalized gate + any
      // surviving per-row latch so a fresh `running` cue repaints a live card.
      const wasFinalized = finalized.delete(agentId)
      const row = groupOfAgent(agentId)?.workers.get(agentId)
      if (row != null) {
        row.finished = false
        row.state = 'running'
      }
      if (wasFinalized || row != null) {
        log(`worker-feed: resurrect agent=${agentId} — cleared finalized gate; card will repaint on next running cue`)
      }
    },
    purgeAllOnBoot(): void {
      for (const g of [...groups.values()]) {
        // Release the group pin unconditionally: the shared card is orphaned
        // after a restart/reconnect (its workers are dead child processes), so
        // it must be unpinned regardless of `hasLiveWorker` — NOT gated like
        // `syncPin`, which would keep the pin for a row we are about to drop.
        if (g.messageId != null) {
          reconcilePinFn({ feedKey: g.feedKey, chatId: g.chatId, threadId: g.threadId, messageId: null })
        }
        for (const agentId of [...g.workers.keys()]) {
          // Latch finalized so a late/inflight cue on the OLD chain can't
          // resurrect a row on a feed we are tearing down.
          markFinalized(agentId)
          agentIndex.delete(agentId)
        }
        g.workers.clear()
        g.pendingFinalize.clear()
        groups.delete(g.feedKey)
      }
      log('worker-feed: purgeAllOnBoot — reconciled feed to empty and released all group pins')
    },
    heartbeatTick,
    stop() {
      if (heartbeatTimer != null) {
        clearIntervalFn(heartbeatTimer)
        heartbeatTimer = null
      }
    },
  }
}
