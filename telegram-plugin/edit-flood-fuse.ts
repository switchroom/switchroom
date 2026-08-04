/**
 * Edit-flood fuse — a LAST-RESORT rate ceiling installed at the one seam no
 * outbound call can bypass (#3620).
 *
 * ── Why this exists ───────────────────────────────────────────────────────
 * The send gate (`send-gate.ts`) is the primary pacer, and every call that
 * goes through `robustApiCall` is admitted by it. But two properties make it
 * a gate with side doors rather than a failsafe:
 *
 *   1. Its per-message protections (edit floor, last-write-wins coalescing,
 *      no-op skip, long-horizon edit budget) are OPT-IN: `gate()` routes to
 *      the edit path only when the caller passes BOTH `messageId` and
 *      `editPayload` (send-gate.ts, `gate()`). A caller that forgets gets a
 *      plain send — no floor, no coalescing.
 *   2. An untagged call is admitted as `critical` (UNTAGGED_SEND_CLASS), the
 *      class that is never shed and queues unbounded.
 *
 * That combination is exactly what earned agent `overlord` a 3713-second
 * flood ban on 2026-07-25: the live activity card edited ONE message id with
 * neither key nor class, so it ran at the per-chat bucket rate (60/min) for
 * an hour. Keying that call site fixes that call site — it does not make the
 * next unkeyed call site impossible.
 *
 * ── Why a grammY transformer ──────────────────────────────────────────────
 * The gateway constructs exactly ONE `new Bot(TOKEN)`, and grammY routes
 * 100% of outbound API traffic through that instance's transformer stack —
 * `bot.api.*`, `ctx.api.*`, anything holding a reference to the `Api` object,
 * wrapped or raw, gated or not. Installing here is therefore STRUCTURAL, not
 * conventional: a new call site cannot opt out, because there is no code path
 * to the network that skips the transformer stack. (`shared/bot-runtime.ts`
 * already proves the seam with `installTgPostLogger`.)
 *
 * ── What it does (and deliberately does NOT do) ───────────────────────────
 *   - EDITS of the same `${chat_id}:${message_id}` are capped at
 *     `perMessageMaxPerWindow` per `perMessageWindowMs` (default 20/60s).
 *     Over-budget edits WAIT for the window to slide, and while they wait a
 *     newer edit to the same message SUPERSEDES them — last-write-wins at the
 *     chokepoint, for every caller, including ones that never heard of the
 *     send gate. A superseded or over-deferred edit is DROPPED (resolved as a
 *     benign no-op), which is safe precisely because the next render of any
 *     card carries full state.
 *   - NON-EDIT sends are PACED (per-chat rolling ceiling) but NEVER dropped.
 *     Dropping a reply would lose a user-visible answer; dropping a repaint
 *     costs nothing. Pacing is capped at `maxDeferMs`, after which the call
 *     passes through rather than blocking a reply for an unbounded time.
 *   - On an observed 429 the ceilings TIGHTEN multiplicatively (AIMD) for
 *     `tightenMs`, then restore. `retry-api-call.ts` sleeps `retry_after` and
 *     resumes at FULL rate; nothing in the stack previously reduced the
 *     sustained rate after a soft 429.
 *
 * ── Where the ceiling actually sits (review 2026-07-26, R1) ───────────────
 * An earlier draft of this docblock claimed the fuse "sits ABOVE every
 * legitimate cadence". That is FALSE and the claim mattered, so it is
 * corrected here rather than deleted. The in-repo cadences are:
 *
 *   - send gate `editFloorMs` = 1500ms          ⇒ up to 40 edits/min/message
 *   - send gate cosmetic budget 150 / 300s      ⇒ 30 edits/min/message
 *   - worker feed's own floor 2500ms            ⇒ 24 edits/min/message
 *   - gateway `FEED_HEARTBEAT_TICK_MS` = 6000ms ⇒ 10 repaints/min/turn
 *
 * The fuse's cosmetic ceilings sit BELOW all of these. That is deliberate —
 * Telegram's own per-group limit is ~20 messages/minute and edits count
 * against it, so the *legitimate* cadences are themselves above what
 * Telegram tolerates; that is precisely how `overlord` got banned while
 * every in-repo pacer believed it was behaving. The fuse is therefore the
 * BINDING constraint on a hot card, not a never-reached backstop.
 *
 * Because it binds routinely, "over budget" must never mean "silently
 * lost". Two rules follow, and both are load-bearing:
 *   - per-MESSAGE over-budget edits SUPERSEDE (newest wins, older frame is
 *     discarded) — safe, because the frame that killed it will paint;
 *   - an over-budget edit may only be DROPPED AT THE DEFER DEADLINE while a
 *     NEWER frame for that same message is still in flight to repaint it. When
 *     the waiting frame is the only one for its card (a turn-final `finalize`,
 *     say) it is RELEASED late instead of dropped. Dropping it would freeze the
 *     card mid-run AND return `true` to the send gate, which would then record a
 *     never-painted payload as on-screen and no-op-skip every retry. This rule
 *     (`dropGuard`) binds on ALL THREE tiers — per-message included. It was
 *     originally wired into the two per-chat tiers only, which left the
 *     per-message tier dropping a lone terminal frame unconditionally at
 *     `maxDeferMs` and freezing the card by exactly the route R1 forbids.
 *
 * ── 2026-07-27: the fuse existed and the ban happened anyway ──────────────
 * The ceilings above were sized against the in-repo pacers, not against what
 * Telegram actually tolerates. Agent `overlord` then sustained ~17
 * `editMessageText`/min on ONE DM chat for hours (326 edits against 6 real
 * replies in the final 20 minutes) and took a **15908-second** flood ban that
 * severed every outbound reply. Both original ceilings — 20 edits/60s per
 * message, 30 edits/60s per chat — sat ABOVE that observed rate, so the fuse
 * never bound once. Three structural changes follow, and each is a separate,
 * independently-sufficient reason the same incident cannot recur:
 *
 *   1. **Class awareness.** The fuse now reads the send gate's priority class
 *      off `outbound-class.ts` (AsyncLocalStorage). `cosmetic` traffic — every
 *      activity/worker/liveness repaint — is governed by its own, much tighter
 *      ceilings; `useful` / `critical` edits (approval cards, answers) are not
 *      throttled by them. Previously the fuse was class-blind and had to pick
 *      one number for both, which is why the number was too high.
 *   2. **A hard cosmetic rate ceiling.** 4 edits/60s per message (one per 15s,
 *      matching the worker feed's own `elapsedRefreshMs`) and 6 edits/60s per
 *      chat across ALL cosmetic surfaces. 6/min is below the ~4-6/min band the
 *      live chat survived for hours and far below the 15-17/min that earned
 *      the ban. Coalescing (supersede) means the card still shows CURRENT
 *      state at every permitted edit — the operator loses refresh frequency,
 *      never accuracy.
 *   3. **A shared per-chat budget with a reply reservation.** Telegram meters
 *      sends and edits against the SAME per-chat allowance, so separate
 *      edit/send windows could each be "in budget" while their sum was not.
 *      One `perChatTotalMaxPerWindow` window (default 20/60s) counts every
 *      chat-targeted call, and `perChatReplyReserve` (default 8) slots of it
 *      are unreachable by `cosmetic` traffic. A reply therefore cannot be
 *      starved by repaints even if a future call site is misclassified.
 *
 * ── 2026-07-28: the meter was reading ~58% of the traffic (#3855) ─────────
 * Point 3 above USED to claim `perChatTotalMaxPerWindow` "counts every
 * admitted call" and "matches Telegram's own per-chat metering". Both were
 * false, and the gap is the reason a "20/60s" ceiling did not stop a ban.
 * `apply` opened with `if (!isEdit && !isSend) return runObserved(next)` —
 * an ALLOWLIST. Anything outside `EDIT_METHODS`/`SEND_METHODS` was entirely
 * unmetered: it took no slot, and the ceiling therefore governed only the
 * subset of traffic it happened to recognise.
 *
 * Measured on overlord's own gateway log (46791 `tg-post` lines), the
 * unmetered share was 29% overall and 42% inside the 30 minutes before the
 * 20:19:56 ban. By method:
 *
 *     sendChatAction      10457   ← unmetered, and up to 18/min on ONE DM
 *     setMessageReaction   2098   ← unmetered
 *     deleteMessage         370   ← unmetered
 *     pinChatMessage        366   ← unmetered
 *     unpinChatMessage      365   ← unmetered
 *     answerCallbackQuery    31   ← unmetered (carries no chat_id)
 *
 * `sendChatAction` alone ran at Telegram's entire documented per-chat/minute
 * allowance while the fuse counted none of it. So the fix is not a smaller
 * number, it is an honest meter:
 *
 *   4. **DEFAULT-DENY metering.** Every method whose payload carries a
 *      `chat_id` is charged to `perChatTotalMaxPerWindow`, whether or not this
 *      file has heard of it. There is no per-chat exemption list to forget to
 *      update — a new Bot API method, or one this gateway starts calling
 *      tomorrow (`sendChecklist` is exactly that case: it carries `chat_id`,
 *      creates a message, and was in neither set), is metered on arrival.
 *      Methods that are neither edits nor sends are PACED and never dropped,
 *      except `CHAT_ACTION_METHODS` — a typing indicator expires by itself in
 *      ~5s and carries no content, so shedding one loses nothing.
 *      The ceiling NUMBER is unchanged at 20/60s; what changed is that 20
 *      admitted calls now means 20 on the wire rather than ~34.
 *   5. **A per-BOT-TOKEN window.** Telegram's flood ban is scoped to the bot
 *      token, not the chat, and enforces a global rate across all chats. A
 *      second window keyed by the bot's PUBLIC numeric id (`perTokenWindowMs`
 *      / `perTokenMaxPerWindow`, default 25 per 1000ms) is now charged for
 *      EVERY outbound call — including the chat-less ones like
 *      `answerCallbackQuery`, which the per-chat tier structurally cannot key.
 *      A call is admitted only if BOTH windows have room.
 *      LIMITATION, stated plainly: this window is per-PROCESS. Two agents
 *      sharing one bot token run in separate containers with separate state
 *      dirs, so neither sees the other's window. It is a real improvement on
 *      the single process that actually floods and it is NOT full coverage
 *      under a shared token; a cross-process view would need a token-keyed
 *      store on a path both processes can write, which does not exist today.
 *      Only the public bot id (the prefix before the `:`) is ever used as a
 *      key, and it is never logged — see {@link deriveBotScopeKey}.
 *
 * Plus **escalating** backoff: a 429 used to apply ONE 0.5× tightening for a
 * flat 10 minutes, so a stream that took repeated small 429s re-tightened to
 * the same level forever and walked into the big ban. Tightening is now
 * multiplicative PER 429 (`tightenFactor ^ level`, level capped by
 * `maxTightenLevel`) and decays one level at a time, so sustained pressure
 * ratchets the cosmetic rate down towards the floor of 1/window.
 *
 * ── 2026-07-28: the reserve could not fire, and the reply paid (#3885) ────
 * Points 3 and 5 above, and the escalating backoff, combined into a defect
 * that hit the operator directly: during a 12-agent staggered restart that drew
 * **three** genuine 429s, one chat logged 792 fuse events in an hour against a
 * 35-50/hr baseline, shed 221 typing indicators, deferred 18 reactions, and
 * deferred real replies long enough that the MCP `reply` tool's 60s timeout
 * fired — so the agent retried and the operator got the same answer twice. One
 * ~1900-character reply was lost outright.
 *
 * Three 3-second 429s ratchet `tightenLevel` to 3, and each one also writes
 * `flood-wait.json`, which pinned `levelAt` at `maxTightenLevel` outright. At
 * level 4 the shared per-chat budget is `max(1, floor(20 * 0.5^4))` = **1 call
 * per minute for the entire chat**. The reserve that exists for precisely this
 * case could not help, because it was a fixed count subtracted from the BASE:
 * `max(1, 20 - 8)` = 12, tightened to 1 — the same 1 the reply had. Reply and
 * repaint ended up with an identical budget, which is the opposite of a
 * reservation. Three changes:
 *
 *   6. **The reserve is a PROPORTION, re-derived per window.** `cosmeticTotalMax`
 *      computes it against the EFFECTIVE ceiling, so "8 of 20" means "40% of
 *      whatever the budget currently is", and at least one slot is always
 *      reserved. When the effective budget shrinks to the reserve, cosmetic
 *      traffic gets 0 and every remaining slot belongs to a reply.
 *   7. **A hard floor under `critical`.** `perChatCriticalMinPerWindow`
 *      (default 3) is a rate no tightening may cross, on every per-chat tier.
 *      Shedding a typing indicator under pressure is correct; holding the
 *      answer past the caller's own timeout is not — it does not save a call,
 *      it doubles it.
 *   8. **A persisted flood window tightens IN PROPORTION to what remains**,
 *      through the same severity ladder `noteFlood` uses, instead of jumping
 *      straight to `maxTightenLevel`. `makeFloodWaitRecorder` writes the marker
 *      for every 429 including a 3-second nudge, so the flat jump reintroduced
 *      on the persisted path exactly the "a nudge and a 4.4h ban are the same
 *      signal" defect that #3856 had just fixed on the in-memory path.
 *
 * ── 2026-08 (#4300): one shared cosmetic bucket starved the watched card ──
 * Point 2's `cosmeticPerChatMaxPerWindow` (6/60s) is ONE bucket shared across
 * every cosmetic surface in a chat — the primary activity card, the worker /
 * sub-agent card, and answer-stream draft edits. With two live cards plus a
 * draft contending, the surface a user actually watches — the primary activity
 * card — worst-cased well past 60s between permitted frames, purely from
 * intra-cosmetic contention (not event starvation: the 6s heartbeat is trying
 * to repaint). AIMD tightening halves the bucket and makes it worse. Two
 * changes, both confined to this file, restore fairness WITHOUT raising the
 * wire rate (so 429 risk is unchanged) and WITHOUT touching the reply reserve:
 *
 *   9.  **Per-`message_id` fair-share of the cosmetic pool.** The shared bucket
 *       is split into a FLOOR lane — each distinct cosmetic `message_id` gets a
 *       guaranteed `cosmeticFloorPerWindow` edits/window (default 1/30s), up to
 *       `cosmeticFloorSlots` ids at once — and a REMAINDER lane (the rest of the
 *       pool), still shared and AIMD-reduced. The two caps SUM to
 *       `cosmeticPerChatMaxPerWindow`, so nothing new reaches the wire; a lone
 *       card still bursts to `cosmeticPerMessageMaxPerWindow` (its floor + the
 *       whole remainder). No surface can starve another, and no primary-vs-not
 *       discriminator is needed — the floor is symmetric per message id. Stale
 *       ids self-evict through the existing window LRU. See
 *       {@link createEditFloodFuse}'s `awaitCosmeticChatFair`.
 *   10. **An AIMD tighten floor on the watched card.** The per-message cosmetic
 *       ceiling and the floor lane are both held at `cosmeticFloorPerWindow`
 *       (1/30s) no matter how many 429s tighten the pool — the same "floor the
 *       thing users watch" pattern as `perChatCriticalMinPerWindow`, so a flood
 *       backoff slows a card without freezing it. The aggregate cosmetic floor
 *       under maximum tightening is `cosmeticFloorPerWindow * cosmeticFloorSlots`
 *       (4/60s by default), which sits at the BOTTOM of the 4-6/min band the
 *       2026-07-27 chat provably survived for hours — a deliberate, bounded
 *       relaxation of "cosmetic sheds to zero", reversible via the kill-switch
 *       `SWITCHROOM_FEED_FAIR_SHARE=0` (flag OFF is byte-identical to the old
 *       single shared bucket). The reply-starvation guarantee is UNTOUCHED: a
 *       floored cosmetic edit still charges `perChatTotalMaxPerWindow` and still
 *       yields to a real reply at that tier — the floor governs cosmetic-vs-
 *       cosmetic only. When the fuse defers a cosmetic edit past
 *       `throttleNoticeMs` (45s) it raises a `'throttled'` `onTrip` signal so the
 *       lag is observable rather than a silent freeze.
 *
 * Every ceiling is operator-overridable via env — see
 * {@link editFloodFuseConfigFromEnv}. Previously none of them were, and until
 * #3885 the tightening CURVE (`maxTightenLevel`, `tightenFactor`) still was
 * not, which is why the only available workaround for the above was to inflate
 * the base ceiling fleet-wide.
 */

import { createHash } from 'node:crypto'

import type { Bot } from 'grammy'

import type { Clock } from './send-gate.js'
import { systemClock } from './send-gate.js'
import { floodStatePath, makeFloodWaitProbe } from './flood-circuit-breaker.js'
import {
  currentOutboundClass,
  defaultOutboundClass,
  type OutboundClass,
} from './outbound-class.js'

/** Methods that mutate an EXISTING message — droppable, coalescible. */
const EDIT_METHODS: ReadonlySet<string> = new Set([
  'editMessageText',
  'editMessageCaption',
  'editMessageMedia',
  'editMessageReplyMarkup',
  'editMessageLiveLocation',
  // Review 2026-07-26 (R2): the checklist tools drive this one exactly like a
  // card — `update_checklist` re-edits ONE message id in a loop
  // (gateway.ts `_rawEditMessageChecklist`, called through `bot.api.raw`, which
  // grammY routes through the transformer stack like everything else). Omitting
  // it left a same-shaped flood path completely unfused.
  'editMessageChecklist',
])

/** Methods that CREATE user-visible output — paced, never dropped. */
const SEND_METHODS: ReadonlySet<string> = new Set([
  'sendMessage', 'sendPhoto', 'sendDocument', 'sendMediaGroup', 'sendAnimation',
  'sendVideo', 'sendVoice', 'sendAudio', 'sendSticker', 'sendLocation',
  'forwardMessage', 'forwardMessages', 'copyMessage', 'copyMessages',
  // Review 2026-07-26 (R3): `sendRichMessage` is the plugin's PRIMARY send —
  // every rich reply, every activity-card OPEN, every stream finalisation goes
  // through it (`rich-send.ts`, `narrative-lane.ts`, `stream-render.ts`).
  // Leaving it out meant the "non-edit sends are paced" property applied to
  // almost nothing that this gateway actually sends. Sends are never dropped,
  // so this only ever adds a bounded (`maxDeferMs`) delay under real pressure.
  // NOTE: `sendRichMessageDraft` is deliberately NOT here — an ephemeral
  // 30s-preview draft is high-cadence by design and is not a persisted message.
  'sendRichMessage',
])

/**
 * Chat-targeted methods whose effect EXPIRES on its own and carries no content,
 * so shedding one under pressure loses nothing a user would notice.
 *
 * `sendChatAction` is the entire set and the reason this tier exists: it was
 * the single largest unmetered method in the incident log (10457 calls, up to
 * 18/min on ONE DM — Telegram's whole documented per-chat/minute allowance),
 * and the typing status it sets clears itself after ~5 seconds regardless.
 * Every OTHER non-edit, non-send method with a `chat_id` (`deleteMessage`,
 * `pinChatMessage`, `setMessageReaction`, …) has a durable, user-visible
 * effect and is paced but never dropped.
 */
const CHAT_ACTION_METHODS: ReadonlySet<string> = new Set(['sendChatAction'])

/**
 * The ONLY methods exempt from metering entirely. Deliberately one entry.
 *
 * `getUpdates` is the long-poll RECEIVE loop, not outbound traffic: it is how
 * inbound messages arrive at all. Pacing it would stall message delivery
 * rather than protect anything, and it targets no chat, so it consumes no
 * per-chat budget by construction.
 *
 * Nothing else is listed. The one-off administrative calls (`setMyCommands`,
 * `deleteWebhook`, `getFile`, `getChat` — 37 calls TOTAL across a 46791-call
 * log) are metered like everything else: at 25/second the cost is nil, and
 * exempting them would mean asserting something about Telegram's accounting
 * that this repo cannot verify from first-party evidence. Default-deny means
 * the burden of proof is on the exemption.
 */
const UNMETERED_METHODS: ReadonlySet<string> = new Set(['getUpdates'])

/**
 * Reduce a bot token to a key safe to hold in memory.
 *
 * A Telegram token is `<bot_id>:<secret>`. The bot id is PUBLIC (it is the
 * bot's user id, visible on every message it sends); the secret half is not.
 * This returns the bot id alone when the token has that shape, so nothing
 * secret is ever used as a map key, logged, or persisted. A token that does
 * not match the shape falls back to a truncated SHA-256, which is stable
 * across processes and irreversible.
 */
export function deriveBotScopeKey(token: string | undefined): string {
  if (token == null || token === '') return 'unknown'
  const id = token.slice(0, token.indexOf(':'))
  if (/^\d+$/.test(id)) return id
  return `h${createHash('sha256').update(token).digest('hex').slice(0, 16)}`
}

export interface EditFloodFuseConfig {
  /** Master switch. When false, `apply` is a pure passthrough. Default true. */
  enabled?: boolean
  clock?: Clock
  /**
   * Hard ceiling on NON-cosmetic (`useful` / `critical`) edits to ONE message
   * id. Default 20 per 60s. Approval cards and answer finalisations live here;
   * they are low-cadence by nature, so this stays a backstop, not a pacer.
   */
  perMessageMaxPerWindow?: number
  perMessageWindowMs?: number
  /** Hard ceiling on ALL edits to ONE chat across all messages. Default 30 per 60s. */
  perChatEditMaxPerWindow?: number
  /** Pacing ceiling on non-edit sends to ONE chat. Default 25 per 60s. */
  perChatSendMaxPerWindow?: number
  /**
   * ADDITIONAL ceiling applied to COSMETIC edits of ONE message id, on top of
   * `perMessageMaxPerWindow` (the effective ceiling is the lower of the two).
   * Default 4 per 60s — one per 15s, matching the worker feed's
   * `elapsedRefreshMs`. This is the number that bounds a hot progress card.
   */
  cosmeticPerMessageMaxPerWindow?: number
  /**
   * ADDITIONAL ceiling applied to COSMETIC edits in ONE chat, summed across
   * every cosmetic surface in it (lower of this and `perChatEditMaxPerWindow`
   * binds). Default 6 per 60s. Without it, N concurrent cards each inside their
   * own per-message ceiling still add up to a flood.
   */
  cosmeticPerChatMaxPerWindow?: number
  /**
   * PER-`message_id` FAIRNESS inside the shared cosmetic per-chat pool. Default
   * true. When true, `cosmeticPerChatMaxPerWindow` is not a single contended
   * bucket every cosmetic surface races for — instead each distinct cosmetic
   * `message_id` is guaranteed a small floor of the pool (see
   * `cosmeticFloorPerWindow` / `cosmeticFloorSlots`) that the OTHER cosmetic
   * surfaces cannot consume, and only the REMAINDER stays shared/contended as
   * before. This is the anti-starvation fix (#4300): with two live cosmetic
   * cards (the primary activity card + a worker/sub-agent card) plus answer
   * draft edits all charging one 6/60s bucket, the primary card worst-cased
   * well past 60s between permitted frames purely from intra-cosmetic
   * contention. Flag OFF is byte-identical to the pre-fix single shared bucket.
   *
   * SAFETY: the floor is carved FROM `cosmeticPerChatMaxPerWindow`, never added
   * on top, so the wire rate is unchanged (429 risk does not rise) and the 40%
   * per-chat reply reserve (`perChatReplyReserve`, on `perChatTotalMaxPerWindow`)
   * is untouched — a floored cosmetic edit STILL yields to a real reply at the
   * shared total tier. This governs cosmetic-vs-cosmetic only.
   */
  cosmeticFairShareEnabled?: boolean
  /**
   * The per-`message_id` guaranteed floor, in edits per `perChatWindowMs`,
   * carved from `cosmeticPerChatMaxPerWindow`. Default 2 = 1 edit / 30s. This is
   * ALSO the AIMD tighten floor: a floored cosmetic message never drops below
   * this rate no matter how many 429s tighten the pool (mirrors
   * `perChatCriticalMinPerWindow` — "floor the thing users watch"), so a flood
   * backoff can slow a watched card but not freeze it. Set 0 to disable the
   * floor while leaving fair-share keying on.
   */
  cosmeticFloorPerWindow?: number
  /**
   * How many DISTINCT cosmetic `message_id`s may each hold a guaranteed floor
   * concurrently. Default 2 — the two sustained mid-turn cards (primary
   * activity + worker feed). `cosmeticFloorPerWindow * cosmeticFloorSlots` is
   * the slice reserved from the pool; the rest is the shared remainder, so this
   * is clamped so the reserve can never exceed the pool. Additional concurrent
   * cosmetic surfaces (e.g. an answer draft) contend the remainder exactly as
   * today. Stale ids self-evict via the existing window LRU, so the tracked set
   * cannot grow unbounded.
   */
  cosmeticFloorSlots?: number
  /**
   * How long a COSMETIC edit may sit deferred before the fuse emits a
   * `'throttled'` `onTrip` signal, so the lag is observable (and a card can
   * render a "updates throttled (flood backoff)" line) rather than freezing
   * silently. Default 45000ms. The render itself is a gateway concern; the fuse
   * only raises the signal.
   */
  throttleNoticeMs?: number
  /**
   * Shared per-chat allowance counting EVERY admitted call — edits and sends,
   * every class. Default 20 per 60s, matching Telegram's own per-chat/group
   * metering (which does not separate the two). Sends and non-cosmetic edits
   * are paced against it and never dropped.
   */
  perChatTotalMaxPerWindow?: number
  /**
   * Slots of `perChatTotalMaxPerWindow` that `cosmetic` traffic may NEVER
   * consume. Default 8. This is the reply-starvation guarantee: whatever the
   * repaint surfaces do, at least this many calls per window remain available
   * to an actual answer.
   *
   * Read as a PROPORTION of the base, not an absolute count (#3885). The
   * reserve used to be a fixed number subtracted from the base ceiling, which
   * made it arithmetically dead under tightening: at `maxTightenLevel` the base
   * 20 collapses to an effective 1, and `1 - 8` clamps to the same floor of 1
   * that cosmetic traffic already had — so reply and repaint ended up with an
   * identical budget in exactly the situation the reserve exists for. It is now
   * re-derived against the EFFECTIVE ceiling every window, and always leaves at
   * least one slot reserved.
   */
  perChatReplyReserve?: number
  /**
   * Absolute floor, per `perChatWindowMs`, on `critical`-class traffic in one
   * chat — the operator's actual answer, an approval card, a reaction. Default
   * 3. No amount of tightening may take a chat below this: a reply held past
   * the caller's own timeout is not "shedding under pressure", it is a lost
   * answer plus a retry that sends it twice (#3885). Cosmetic traffic has no
   * floor and is still shed to zero, which is the correct trade.
   *
   * Capped by the tier's own base ceiling, so an operator who deliberately
   * configures a base below this floor still gets what they configured.
   */
  perChatCriticalMinPerWindow?: number
  /**
   * Ceiling on EVERY outbound call made with this bot token, across all chats
   * and including the chat-less ones. Default 25 per `perTokenWindowMs`
   * (1000ms), just under the ~30/second Telegram enforces at the token level.
   * The flood ban is token-scoped, so this is the tier that matches the thing
   * that actually gets banned. Per-PROCESS — see the docblock's point 5.
   */
  perTokenMaxPerWindow?: number
  perTokenWindowMs?: number
  /**
   * Scope key for the token window: the bot's PUBLIC numeric id. Never pass a
   * raw token — {@link installEditFloodFuse} derives this via
   * {@link deriveBotScopeKey}. Default `'unknown'` (a single shared window,
   * which is still correct for the one-bot-per-process case).
   */
  botScopeKey?: string
  /**
   * Longest a `CHAT_ACTION_METHODS` call may be held before it is shed.
   * Default 3000ms — a typing indicator that arrives after the status it
   * describes has already expired is worse than no typing indicator.
   */
  chatActionMaxDeferMs?: number
  /**
   * Cap on COSMETIC edits that may be released late (over budget) because
   * nothing newer will repaint them — the bounded form of the R1 rule. Default
   * 2 per `perChatWindowMs`, so the worst-case sustained cosmetic rate is
   * `cosmeticPerChatMaxPerWindow + lateReleaseMaxPerWindow`.
   */
  lateReleaseMaxPerWindow?: number
  perChatWindowMs?: number
  /** Longest a call may be held before it is dropped (edit) / released (send). Default 30s. */
  maxDeferMs?: number
  /** Multiplicative decrease applied per observed 429. Default 0.5. */
  tightenFactor?: number
  /** How long ONE level of tightening stays in force before decaying. Default 10 minutes. */
  tightenMs?: number
  /**
   * Cap on compounding 429 tightening levels. Default 4 (⇒ 0.5^4 = 1/16).
   * Operator-overridable via `SWITCHROOM_EDIT_FUSE_MAX_TIGHTEN_LEVEL` (#3885);
   * `0` disables tightening entirely.
   */
  maxTightenLevel?: number
  /**
   * Remaining ms of a KNOWN-OPEN Telegram flood window, or 0 when none — the
   * persisted breaker state (`flood-circuit-breaker.ts`) that every other
   * outbound path already consults. Wired by {@link editFloodFuseConfigFromEnv}.
   *
   * The fuse's tightening lived only in process memory, so before #3856 a
   * gateway restart during a ban came back FULLY UNTIGHTENED and resumed at
   * the rate that earned the ban — and a restart is the single most likely
   * thing to happen during a multi-hour outage. Consulting the persisted
   * window makes the response durable: while it is open the fuse holds
   * `maxTightenLevel` regardless of what this process remembers.
   *
   * FAILS OPEN (throwing or absent probe ⇒ untightened): a breaker that cannot
   * read its own state must never gag the bot.
   */
  floodWaitRemainingMs?: () => number
  /** How often the persisted window may be re-read. Default 1000ms. */
  floodProbeIntervalMs?: number
  /** Observability hook; fired whenever the fuse binds. */
  onTrip?: (info: {
    method: string
    key: string
    action: 'deferred' | 'dropped' | 'superseded' | 'throttled'
    cls: OutboundClass
  }) => void
}

export interface EditFloodFuseStats {
  enabled: boolean
  /** Calls the fuse held back waiting for a window to slide. */
  deferred: number
  /** Edits dropped because the window never opened inside `maxDeferMs`. */
  dropped: number
  /** Edits dropped because a NEWER edit to the same message arrived. */
  superseded: number
  /**
   * COSMETIC edits that crossed `throttleNoticeMs` while deferred — the direct
   * measure of a card the flood backoff is visibly slowing. Non-zero here is
   * the signal a "throttled" indicator should render for.
   */
  throttled: number
  /** Whether per-`message_id` cosmetic fair-share is in force (the #4300 fix). */
  cosmeticFairShareEnabled: boolean
  /** 429s observed (each one tightens the ceilings). */
  floodObserved: number
  /** Whether a tightened ceiling is in force right now. */
  tightened: boolean
  /** Compounding 429 tightening level currently in force (0 = untightened). */
  tightenLevel: number
  /** Live NON-cosmetic per-message ceiling (post-AIMD). */
  perMessageCeiling: number
  /** Live COSMETIC per-message ceiling (post-AIMD) — the incident-relevant one. */
  cosmeticPerMessageCeiling: number
  /** Live COSMETIC per-chat ceiling (post-AIMD). */
  cosmeticPerChatCeiling: number
  /**
   * Live shared per-chat budget available to COSMETIC traffic (post-AIMD, after
   * the reply reserve). Goes to 0 under heavy tightening — that is the reserve
   * working, not a fault.
   */
  cosmeticPerChatTotalCeiling: number
  /**
   * Live shared per-chat budget available to CRITICAL traffic (post-AIMD, after
   * the critical floor). The direct measure of #3885: this must never drop
   * below `perChatCriticalMinPerWindow`, at any tighten level.
   */
  criticalPerChatTotalCeiling: number
  /**
   * Chat-targeted calls charged by the DEFAULT-DENY rule — every one of these
   * was completely unmetered before #3855. A non-zero value here is the direct
   * measure of the hole this closed.
   */
  meteredByDefault: number
  /** Calls with no `chat_id`, charged to the token window only. */
  chatless: number
  /** Live per-bot-token ceiling (post-AIMD). */
  perTokenCeiling: number
  /**
   * True when a PERSISTED flood window is open right now — i.e. the tightening
   * in force is durable rather than remembered, and survives a restart (#3856).
   */
  persistedFloodOpen: boolean
}

export const EDIT_FLOOD_FUSE_DEFAULTS = {
  perMessageMaxPerWindow: 20,
  perMessageWindowMs: 60_000,
  perChatEditMaxPerWindow: 30,
  perChatSendMaxPerWindow: 25,
  /**
   * 4/60s. One cosmetic repaint per 15s per card. Chosen to equal the worker
   * feed's `elapsedRefreshMs` (15000) — the slowest cadence at which the feed
   * itself considers a repaint worth making — so the fuse binds the runaway
   * case without ever throttling the feed's own intended pace.
   */
  cosmeticPerMessageMaxPerWindow: 4,
  /**
   * 6/60s across every cosmetic surface in a chat. The incident's own timeline
   * is the evidence: 10-minute buckets of 58/53/41 edits (≈4-6/min) ran for
   * hours without a ban; 115/78/73 then 152/174 (≈8-17/min) earned one. 6/min
   * sits at the top of the survived band and less than half the banned rate.
   */
  cosmeticPerChatMaxPerWindow: 6,
  /**
   * 2/60s = 1 edit / 30s per distinct cosmetic message_id, guaranteed and
   * AIMD-immune. Sized so a LONE card still bursts to the full
   * `cosmeticPerMessageMaxPerWindow` (4): its 2 floor slots + the 2-slot
   * remainder (6 - 2*2) = 4. Two live cards each keep 1/30s and share the
   * remaining 2; a third cosmetic surface contends the remainder as before.
   * The aggregate cosmetic floor under maximum tightening is therefore
   * `cosmeticFloorPerWindow * cosmeticFloorSlots` = 4/60s, which sits at the
   * bottom of the 4-6/min band the incident chat provably survived for hours
   * (see this file's 2026-07-27 note) — enough to keep a watched card from
   * freezing, low enough not to re-earn a ban. Disable via the kill-switch to
   * restore shed-cosmetic-to-zero under pressure.
   */
  cosmeticFloorPerWindow: 2,
  cosmeticFloorSlots: 2,
  /** A cosmetic edit deferred longer than this raises a `'throttled'` signal. */
  throttleNoticeMs: 45_000,
  /**
   * 20/60s. Telegram's documented per-group ceiling, and it meters sends and
   * edits together — so this is the only window that reflects the real budget.
   */
  perChatTotalMaxPerWindow: 20,
  /**
   * 8 of those 20 slots/min are unreachable by cosmetic traffic — i.e. 40% of
   * whatever the EFFECTIVE ceiling is, re-derived per window (#3885).
   */
  perChatReplyReserve: 8,
  /**
   * 3/60s. The hard floor on `critical` traffic in a chat. Sized against the
   * thing that broke: the MCP `reply` tool times out at 60s, so a chat that can
   * pass fewer than a couple of criticals a minute turns one answer into a
   * timeout, a retry, and a duplicate message.
   */
  perChatCriticalMinPerWindow: 3,
  /**
   * 25 per second across the whole bot token. Telegram enforces ~30/s at the
   * token level and the ban it issues is token-scoped; 25 leaves headroom for
   * traffic this process cannot see (a peer agent sharing the token, or a
   * retry issued below the transformer stack).
   */
  perTokenMaxPerWindow: 25,
  perTokenWindowMs: 1_000,
  /** A typing indicator held longer than this is not worth sending. */
  chatActionMaxDeferMs: 3_000,
  /** At most 2 cosmetic frames/min may exceed the ceiling as "lone" releases. */
  lateReleaseMaxPerWindow: 2,
  perChatWindowMs: 60_000,
  maxDeferMs: 30_000,
  tightenFactor: 0.5,
  tightenMs: 600_000,
  maxTightenLevel: 4,
  /** The persisted flood window is re-read at most once a second (#3856). */
  floodProbeIntervalMs: 1_000,
} as const

/** Parse a positive integer from env, or undefined when unset/invalid. */
function envInt(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : undefined
}

/**
 * Parse a multiplicative-decrease factor from env: a real in (0, 1].
 *
 * Rejects 0 and negatives (which would zero every ceiling) and anything above
 * 1 (which would make a 429 LOOSEN the fuse). An out-of-range value is treated
 * as unset rather than clamped — silently reinterpreting an operator's number
 * is how a fuse ends up at a rate nobody chose.
 */
function envFactor(raw: string | undefined): number | undefined {
  if (raw == null || raw.trim() === '') return undefined
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : undefined
}

/**
 * Operator config surface. Before the 2026-07-27 incident the fuse had exactly
 * one knob — `SWITCHROOM_EDIT_FUSE=0`, which turns the whole failsafe OFF —
 * so an operator whose chat was being flooded had no way to tighten it and no
 * way to loosen it for a chat that could take more. Every ceiling is now
 * overridable; unset values keep the defaults above.
 */
export function editFloodFuseConfigFromEnv(
  env: Record<string, string | undefined>,
): EditFloodFuseConfig {
  const cfg: EditFloodFuseConfig = { enabled: env.SWITCHROOM_EDIT_FUSE !== '0' }
  const assign = <K extends keyof EditFloodFuseConfig>(k: K, v: number | undefined): void => {
    if (v !== undefined) (cfg[k] as number) = v
  }
  assign('cosmeticPerMessageMaxPerWindow', envInt(env.SWITCHROOM_FEED_EDIT_MAX_PER_MSG_PER_MIN))
  assign('cosmeticPerChatMaxPerWindow', envInt(env.SWITCHROOM_FEED_EDIT_MAX_PER_CHAT_PER_MIN))
  // #4300 — per-message_id cosmetic fair-share. Kill-switch OFF restores the
  // pre-fix single shared cosmetic bucket byte-for-byte; the floor/slots/notice
  // knobs let an operator retune the reserved slice without a redeploy.
  if (env.SWITCHROOM_FEED_FAIR_SHARE === '0') cfg.cosmeticFairShareEnabled = false
  assign('cosmeticFloorPerWindow', envInt(env.SWITCHROOM_FEED_EDIT_FLOOR_PER_MSG_PER_MIN))
  assign('cosmeticFloorSlots', envInt(env.SWITCHROOM_FEED_EDIT_FLOOR_SLOTS))
  assign('throttleNoticeMs', envInt(env.SWITCHROOM_FEED_THROTTLE_NOTICE_MS))
  assign('perChatTotalMaxPerWindow', envInt(env.SWITCHROOM_CHAT_TOTAL_MAX_PER_MIN))
  assign('perChatReplyReserve', envInt(env.SWITCHROOM_CHAT_REPLY_RESERVE))
  assign('perChatCriticalMinPerWindow', envInt(env.SWITCHROOM_CHAT_CRITICAL_MIN_PER_MIN))
  assign('perTokenMaxPerWindow', envInt(env.SWITCHROOM_TOKEN_MAX_PER_SEC))
  assign('maxDeferMs', envInt(env.SWITCHROOM_EDIT_FUSE_MAX_DEFER_MS))
  // #3885 — the tightening curve itself is now operator-tunable. Before this,
  // `SWITCHROOM_CHAT_TOTAL_MAX_PER_MIN` was the ONLY lever on it, so an
  // operator whose chats were collapsing under `factor^maxLevel` had to inflate
  // the BASE ceiling fleet-wide to compensate — raising the untightened rate
  // (the one that earns bans) to fix the tightened one.
  assign('maxTightenLevel', envInt(env.SWITCHROOM_EDIT_FUSE_MAX_TIGHTEN_LEVEL))
  assign('tightenFactor', envFactor(env.SWITCHROOM_EDIT_FUSE_TIGHTEN_FACTOR))
  // #3856 — durable ban awareness. The fuse reads the SAME persisted marker
  // (`flood-wait.json`) that `robustApiCall` and the outbox sweep consult, so a
  // restart mid-ban comes back tightened instead of at full rate. Wired here
  // rather than at the call site so no caller can forget it, and because
  // `gateway.ts` is under a zero-slack line ratchet.
  const stateDir = env.TELEGRAM_STATE_DIR
  if (stateDir != null && stateDir !== '') {
    cfg.floodWaitRemainingMs = makeFloodWaitProbe(floodStatePath(stateDir))
  }
  return cfg
}

/**
 * What a DROPPED call resolves to.
 *
 * `apply` is a grammY **transformer**, and a transformer's contract is the raw
 * `ApiResponse` ENVELOPE (`{ok: true, result}` / `{ok: false, error_code,
 * description}`) — not the unwrapped result. grammY's `Api.callApi` does:
 *
 * ```js
 * const data = await this.call(method, payload, signal)
 * if (data.ok) return data.result
 * else throw toGrammyError(data, method, payload)
 * ```
 * (grammy `out/core/client.js`)
 *
 * This constant used to be the bare `true` — the *result* an edit resolves to,
 * with the envelope omitted. `(true).ok` is `undefined`, so every deliberate
 * fuse drop took the `else` branch and surfaced as
 * `GrammyError: Call to 'editMessageText' failed! (undefined: undefined)`
 * (`err.error_code` / `err.description` are both absent on a boolean). Callers
 * then counted the fuse's INTENDED rate-limiting as a transport failure — which
 * is how a healthy turn reached `activityDrainFailures=8` and was flagged
 * DEGRADED for behaving exactly as designed (narrative-lane.ts drain catch).
 *
 * Wrapping it in the envelope restores the contract the rest of this file
 * already documents: a dropped call resolves as the benign no-op described in
 * the header ("A superseded or over-deferred edit is DROPPED (resolved as a
 * benign no-op)") and returns `true` to the send gate, as the R1 note assumes.
 */
const DROPPED_RESULT = { ok: true as const, result: true }

interface Window {
  ts: number[]
  /** The newest waiter on this key; a fresh waiter supersedes it. */
  waiter: { kill: () => void } | null
  /**
   * How many calls for this key are currently inside `apply` (per-MESSAGE keys
   * only). Read at the per-chat defer deadline: dropping is only honest while
   * a NEWER frame for the same message is still in flight to repaint. See the
   * docblock's "Where the ceiling actually sits" (R1).
   */
  inflight: number
}

/**
 * The fuse as a pure, clock-injectable unit. `apply` has the grammY
 * transformer shape so it can be handed straight to `bot.api.config.use`.
 */
export function createEditFloodFuse(config: EditFloodFuseConfig = {}) {
  const enabled = config.enabled ?? true
  const clock = config.clock ?? systemClock
  const D = EDIT_FLOOD_FUSE_DEFAULTS
  const perMessageMax = config.perMessageMaxPerWindow ?? D.perMessageMaxPerWindow
  const perMessageWindowMs = config.perMessageWindowMs ?? D.perMessageWindowMs
  const perChatEditMax = config.perChatEditMaxPerWindow ?? D.perChatEditMaxPerWindow
  const perChatSendMax = config.perChatSendMaxPerWindow ?? D.perChatSendMaxPerWindow
  // Cosmetic tiers are an ADDITIONAL constraint on the same window keys, so the
  // effective ceiling is the lower of the two. Folding them in here (rather
  // than as extra tiers) keeps the admission path at the same number of awaits.
  const cosmeticPerMessageMax = Math.min(
    perMessageMax, config.cosmeticPerMessageMaxPerWindow ?? D.cosmeticPerMessageMaxPerWindow)
  const cosmeticPerChatMax = Math.min(
    perChatEditMax, config.cosmeticPerChatMaxPerWindow ?? D.cosmeticPerChatMaxPerWindow)
  // #4300 — per-message_id fair-share of the cosmetic per-chat pool.
  const cosmeticFairShareEnabled = config.cosmeticFairShareEnabled ?? true
  // The per-message guaranteed floor, capped by the per-message cosmetic
  // ceiling (a floor above the message's own max would be incoherent).
  const cosmeticFloorPerWindow = Math.min(
    cosmeticPerMessageMax,
    Math.max(0, config.cosmeticFloorPerWindow ?? D.cosmeticFloorPerWindow))
  // The reserved slice = floor * slots, clamped so it can never exceed the pool
  // (a reserve larger than the pool would leave a negative remainder). This is
  // the aggregate cap that bounds how many distinct ids hold a floor at once.
  const cosmeticFloorAggMax = Math.min(
    cosmeticPerChatMax,
    cosmeticFloorPerWindow * Math.max(0, config.cosmeticFloorSlots ?? D.cosmeticFloorSlots))
  // What is left of the pool after the reserve — the still-shared, still-AIMD
  // remainder. Cosmetic edits beyond a message's floor contend here as before.
  const cosmeticRemainderMax = Math.max(0, cosmeticPerChatMax - cosmeticFloorAggMax)
  const throttleNoticeMs = Math.max(0, config.throttleNoticeMs ?? D.throttleNoticeMs)
  const perChatTotalMax = config.perChatTotalMaxPerWindow ?? D.perChatTotalMaxPerWindow
  const perChatWindowMs = config.perChatWindowMs ?? D.perChatWindowMs
  // Clamped so a misconfigured reserve can never eat more than the whole
  // budget. Note this clamp is on the BASE only — the reserve that actually
  // binds is re-derived per window by `cosmeticTotalMax` (#3885).
  const perChatReplyReserve = Math.min(
    Math.max(0, config.perChatReplyReserve ?? D.perChatReplyReserve),
    Math.max(0, perChatTotalMax - 1),
  )
  /**
   * The reserve as a FRACTION of the base. This is the whole #3885 fix: the
   * reserve has to mean "40% of the chat's budget belongs to replies", not "8
   * calls", because 8 is meaningless once the effective budget is 1.
   */
  const replyReserveFraction = perChatTotalMax > 0 ? perChatReplyReserve / perChatTotalMax : 0
  const perChatCriticalMin = Math.max(
    0, config.perChatCriticalMinPerWindow ?? D.perChatCriticalMinPerWindow)
  const perTokenMax = Math.max(1, config.perTokenMaxPerWindow ?? D.perTokenMaxPerWindow)
  const perTokenWindowMs = Math.max(1, config.perTokenWindowMs ?? D.perTokenWindowMs)
  // Only ever the PUBLIC bot id (or an irreversible hash) reaches this key.
  const tokenKey = `g:${config.botScopeKey ?? 'unknown'}`
  const chatActionMaxDeferMs = config.chatActionMaxDeferMs ?? D.chatActionMaxDeferMs
  const lateReleaseMax = Math.max(0, config.lateReleaseMaxPerWindow ?? D.lateReleaseMaxPerWindow)
  const maxDeferMs = config.maxDeferMs ?? D.maxDeferMs
  const tightenFactor = config.tightenFactor ?? D.tightenFactor
  const tightenMs = config.tightenMs ?? D.tightenMs
  const maxTightenLevel = Math.max(0, config.maxTightenLevel ?? D.maxTightenLevel)
  const floodProbe = config.floodWaitRemainingMs
  const floodProbeIntervalMs = Math.max(0, config.floodProbeIntervalMs ?? D.floodProbeIntervalMs)
  const onTrip = config.onTrip

  const windows = new Map<string, Window>()
  const counters = {
    deferred: 0, dropped: 0, superseded: 0, floodObserved: 0,
    /** Chat-targeted calls charged by the DEFAULT-DENY rule that the old
     *  allowlist would have let through unmetered (#3855 observability). */
    meteredByDefault: 0,
    /** Calls with no `chat_id`, charged to the token window only. */
    chatless: 0,
    /** Cosmetic edits that crossed `throttleNoticeMs` while deferred (#4300). */
    throttled: 0,
  }
  /**
   * Compounding 429 backoff. `tightenLevel` is the number of multiplicative
   * decreases currently in force; `tightenedUntil` is when the NEXT level
   * decays. A single flat tightening (the pre-2026-07-27 behaviour) let a
   * stream that kept taking small 429s sit at 0.5× indefinitely and walk into
   * a long ban; escalating means repeated 429s ratchet the rate down.
   */
  let tightenLevel = 0
  let tightenedUntil = 0

  /**
   * Cached read of the PERSISTED flood window (#3856). Throttled to
   * `floodProbeIntervalMs` because `levelAt` runs on every admission and the
   * probe is a file read — an unthrottled read would make the fuse the latency
   * problem it exists to prevent. Between reads the cached remaining time is
   * decayed by elapsed wall time, so a window never appears to last longer
   * than it does.
   *
   * FAILS OPEN: any throw is treated as "no window". `makeFloodWaitProbe`
   * already fails open on an unreadable marker and warns loudly (#3106); this
   * catch covers the rest.
   */
  let probedAt = Number.NEGATIVE_INFINITY
  let probedRemainingMs = 0
  function persistedFloodRemainingMs(now: number): number {
    if (floodProbe === undefined) return 0
    const since = now - probedAt
    if (since < floodProbeIntervalMs) return Math.max(0, probedRemainingMs - since)
    probedAt = now
    try {
      const ms = floodProbe()
      probedRemainingMs = Number.isFinite(ms) && ms > 0 ? ms : 0
    } catch {
      probedRemainingMs = 0
    }
    return probedRemainingMs
  }

  /** Decay one level per `tightenMs` of quiet, rather than a single cliff. */
  function levelAt(now: number): number {
    while (tightenLevel > 0 && tightenedUntil <= now) {
      tightenLevel--
      tightenedUntil = tightenLevel > 0 ? tightenedUntil + tightenMs : 0
    }
    // #3856 — a KNOWN-OPEN persisted window pins the fuse regardless of
    // in-memory state. This is what survives a restart: the process forgets,
    // the marker on disk does not. It does not MUTATE `tightenLevel`, so when
    // the window closes the fuse returns to whatever this process actually
    // earned rather than staying pinned.
    //
    // #3885 — but pinned at a level PROPORTIONAL to the window still open, not
    // unconditionally at `maxTightenLevel`. `flood-wait.json` is written for
    // EVERY 429 including a routine 3-second nudge (`makeFloodWaitRecorder` →
    // `computeFloodWait`), so the flat jump meant a 3s burst nudge and a 4.4h
    // ban produced the identical maximal response — the exact asymmetry #3856
    // fixed for the in-memory path and left in place here. The remaining window
    // is graded through the SAME severity ladder `noteFlood` uses, so a big ban
    // still pins at maximum and a nudge costs one level.
    //
    // Clamped by `maxTightenLevel` like every other path: `tightenStepFor`
    // returns a fixed 1..3 for the smaller bands, so an operator who sets
    // `SWITCHROOM_EDIT_FUSE_MAX_TIGHTEN_LEVEL=0` to disable tightening entirely
    // must not find the fuse tightening anyway the moment a marker exists.
    const remainingMs = persistedFloodRemainingMs(now)
    if (remainingMs > 0) {
      return Math.max(tightenLevel, Math.min(maxTightenLevel, tightenStepFor(remainingMs / 1000)))
    }
    return tightenLevel
  }

  function isTightened(now: number): boolean {
    return levelAt(now) > 0
  }

  /**
   * AIMD multiplicative decrease, compounding per observed 429. Applied to
   * every ceiling while tightened; floored at 1 so the fuse never deadlocks a
   * surface completely.
   */
  function ceiling(base: number, now: number): number {
    const level = levelAt(now)
    if (level === 0) return base
    return Math.max(1, Math.floor(base * Math.pow(tightenFactor, level)))
  }

  /**
   * The ceiling a given CLASS sees on a tier whose base is `base` (#3885).
   *
   * `critical` traffic — the operator's answer, an approval card, a reaction —
   * gets an absolute floor that tightening cannot cross. Everything else takes
   * the tightened ceiling as-is, so shedding still happens; it just happens to
   * the traffic that can afford it.
   *
   * The floor is capped by `base` so it can only ever RAISE a tightened ceiling
   * back towards what the operator configured, never above it.
   */
  function classCeiling(base: number, cls: OutboundClass, now: number): number {
    const eff = ceiling(base, now)
    if (cls !== 'critical') return eff
    return Math.max(eff, Math.min(base, perChatCriticalMin))
  }

  /**
   * The PER-MESSAGE cosmetic ceiling, with the #4300 AIMD tighten floor. Same
   * shape as the `critical` floor in `classCeiling`: no amount of 429 tightening
   * may drop a cosmetic card below `cosmeticFloorPerWindow` (default 1 edit/30s)
   * on its own message tier, so the flood backoff slows a watched card without
   * freezing it. Capped by `base` so it only ever raises a tightened ceiling
   * back towards the configured max, never above it. Flag OFF ⇒ plain `ceiling`,
   * i.e. byte-identical to the pre-fix behaviour.
   *
   * This floors ONLY cosmetic-vs-AIMD; the reply-starvation guarantee is on a
   * different tier (`cosmeticTotalMax` / `perChatTotalMax`) and is untouched, so
   * a floored cosmetic edit still yields to a real reply.
   */
  function cosmeticMessageCeiling(now: number): number {
    const eff = ceiling(cosmeticPerMessageMax, now)
    if (!cosmeticFairShareEnabled) return eff
    return Math.max(eff, Math.min(cosmeticPerMessageMax, cosmeticFloorPerWindow))
  }

  /**
   * The shared per-chat budget COSMETIC traffic may reach, re-derived against
   * the EFFECTIVE ceiling (#3885).
   *
   * Returns 0 when the effective budget has shrunk to the reserve — at that
   * point every remaining slot belongs to replies, and a repaint waits for the
   * window or is shed. That is the intended behaviour under real flood
   * pressure: the operator loses refresh frequency, never the answer.
   */
  function cosmeticTotalMax(now: number): number {
    const eff = ceiling(perChatTotalMax, now)
    if (replyReserveFraction <= 0) return eff
    const reserve = Math.min(eff, Math.max(1, Math.round(eff * replyReserveFraction)))
    return Math.max(0, eff - reserve)
  }

  /** Shared per-chat budget resolver, per class, evaluated at admission time. */
  function totalMaxFor(cls: OutboundClass): (now: number) => number {
    if (cls === 'cosmetic') return cosmeticTotalMax
    return (now: number) => classCeiling(perChatTotalMax, cls, now)
  }

  function win(key: string): Window {
    let w = windows.get(key)
    if (w === undefined) {
      w = { ts: [], waiter: null, inflight: 0 }
      windows.set(key, w)
    }
    return w
  }

  function prune(w: Window, now: number, windowMs: number): void {
    const cutoff = now - windowMs
    while (w.ts.length > 0 && w.ts[0]! <= cutoff) w.ts.shift()
  }

  /**
   * Bounded LRU-ish eviction so a long-lived process cannot grow the map
   * without limit. A window with no in-flight waiter and no timestamps inside
   * the widest window is dead state.
   */
  let sinceEvict = 0
  function evict(now: number): void {
    if (windows.size < 4096) return
    // Sweep at most once per 1024 admissions: an unconditional sweep would be
    // O(n) on EVERY outbound call once the map is large, i.e. the fuse itself
    // would become the latency problem it exists to prevent.
    if (++sinceEvict < 1024) return
    sinceEvict = 0
    const widest = Math.max(perMessageWindowMs, perChatWindowMs)
    for (const [k, w] of windows) {
      // `inflight > 0` keeps a key whose caller is mid-wait: evicting it would
      // hand that caller a stale Window object while a FRESH one (empty `ts`)
      // took its place in the map, resetting the ceiling for everyone else.
      if (w.waiter === null && w.inflight === 0
        && (w.ts.length === 0 || w.ts[w.ts.length - 1]! <= now - widest)) {
        windows.delete(k)
      }
    }
  }

  /** ms until `w` has room, or 0 if it has room now. */
  function waitFor(w: Window, now: number, windowMs: number, max: number): number {
    prune(w, now, windowMs)
    // A ceiling of 0 is reachable now that the reply reserve is derived against
    // the EFFECTIVE budget (#3885): under heavy tightening the whole remaining
    // budget belongs to replies, so cosmetic traffic has none. There is no
    // "oldest slot" to wait behind in that case, so wait out the window rather
    // than indexing an empty array (which would produce NaN and admit).
    if (max <= 0) {
      return w.ts.length > 0 ? Math.max(1, w.ts[0]! + windowMs - now) : Math.max(1, windowMs)
    }
    if (w.ts.length < max) return 0
    return Math.max(1, w.ts[0]! + windowMs - now)
  }

  function payloadKeys(payload: unknown): { chat: string | null; msg: string | null } {
    const p = (payload ?? {}) as Record<string, unknown>
    const chat = p.chat_id != null ? String(p.chat_id) : null
    const msg = p.message_id != null ? String(p.message_id) : null
    return { chat, msg }
  }

  /**
   * Record a 429 and tighten IN PROPORTION TO THE PENALTY (#3856).
   *
   * Before this, every 429 was worth exactly one level: a 3-second "slow down
   * a touch" nudge and a **15908-second** ban produced the identical response.
   * The whole point of AIMD is that the decrease matches the signal, and a
   * four-hour ban is not one nudge's worth of signal. `retryAfterSec` is the
   * severity Telegram itself states, so it is what the step is scaled by.
   *
   * The tightening is also held for at least the ban's own duration. A flat
   * 10-minute `tightenMs` expired ~25× over during the 2026-07-27 ban, so the
   * fuse would have been back at full rate long before the window closed.
   */
  function noteFlood(now: number, retryAfterSec: number): void {
    counters.floodObserved++
    levelAt(now)
    tightenLevel = Math.min(maxTightenLevel, tightenLevel + tightenStepFor(retryAfterSec))
    // Every level currently in force is re-armed; the decay clock restarts
    // from the newest 429, and never expires before the penalty itself does.
    tightenedUntil = now + Math.max(tightenMs, retryAfterSec * 1000 + tightenMs)
  }

  /**
   * Levels of multiplicative decrease one 429 is worth, by stated penalty:
   *
   *   ≤ 5s     1   a routine burst nudge
   *   ≤ 60s    2   sustained overrate
   *   ≤ 600s   3   a real ban
   *   > 600s   ALL the way to `maxTightenLevel` — at this magnitude the rate
   *               that produced it is categorically wrong, and stepping down
   *               one level at a time would spend the next window earning the
   *               next ban. The 2026-07-25 (3713s) and 2026-07-27 (15908s)
   *               bans are both in this band.
   */
  function tightenStepFor(retryAfterSec: number): number {
    if (!Number.isFinite(retryAfterSec) || retryAfterSec <= 5) return 1
    if (retryAfterSec <= 60) return 2
    if (retryAfterSec <= 600) return 3
    return maxTightenLevel
  }

  /**
   * The stated `retry_after` in seconds when `err` is a flood rejection, else
   * null. Returns 0 for a flood whose magnitude is not stated (the text-match
   * path), which `tightenStepFor` treats as the mildest case — an unquantified
   * signal must not be inflated into a maximal response.
   */
  function floodRetryAfterSec(err: unknown): number | null {
    const e = err as { error_code?: number; parameters?: { retry_after?: number } } | null
    if (e != null && typeof e === 'object') {
      const stated = e.parameters?.retry_after
      if (typeof stated === 'number') return stated
      if (e.error_code === 429) return 0
    }
    // Match on the SEMANTIC markers only. A bare "429" substring
    // false-positives on ordinary server text (e.g. "message 429 not found"),
    // and a false positive here halves every ceiling for ten minutes.
    const msg = err instanceof Error ? err.message : String(err ?? '')
    if (!/too many requests/i.test(msg) && !/retry[ _-]?after/i.test(msg)) return null
    // grammY and the Bot API both surface the magnitude in the text; use it
    // when it is there rather than throwing the severity away.
    const m = /retry[ _-]?after[^0-9]{0,4}(\d+)/i.exec(msg)
    return m != null ? Number(m[1]) : 0
  }

/**
   * How a call that finds no room behaves:
   *   supersede — per-message edits: a newer edit to the SAME message kills it
   *   drop      — per-chat edits: waits, then drops at the defer deadline
   *   release   — sends: waits, then passes through (never lost)
   */
  type WaitMode = 'supersede' | 'drop' | 'release'

  /** Give back a slot reserved by `awaitRoom` (used when a later tier denies). */
  function unreserve(key: string, at: number): void {
    const w = windows.get(key)
    if (w === undefined) return
    const i = w.ts.lastIndexOf(at)
    if (i >= 0) w.ts.splice(i, 1)
  }

  /**
   * A per-wait tracker that raises the `'throttled'` signal once (#4300) when a
   * COSMETIC call has been continuously deferred longer than `throttleNoticeMs`.
   * The first `tick(now)` records the defer start; each subsequent `tick` fires
   * the signal exactly once on crossing the threshold. `sleepCap(now)` returns
   * the ms until that threshold so the wait loop can clamp its sleep and wake to
   * fire the notice — WITHOUT this, a single wait that runs straight to the defer
   * deadline (`sleep(deadline - now)`) would skip past the threshold and never
   * signal. Once fired, `sleepCap` returns Infinity (no more clamping). Both are
   * no-ops for non-cosmetic calls and a zero/disabled threshold. Rendering the
   * visible indicator is a gateway concern reading `onTrip`/`stats().throttled`;
   * the fuse only signals.
   */
  function makeThrottleNotice(
    method: string, key: string, cls: OutboundClass,
  ): { tick: (now: number) => void; sleepCap: (now: number) => number } {
    // The 'throttled' marker is part of the #4300 fair-share feature, so the
    // kill-switch also disables it — leaving flag-OFF byte-identical to the
    // pre-fix behaviour (no new signal, no extra threshold wakeup).
    if (!cosmeticFairShareEnabled || cls !== 'cosmetic' || throttleNoticeMs <= 0) {
      return { tick: () => {}, sleepCap: () => Number.POSITIVE_INFINITY }
    }
    let firstAt = Number.NaN
    let fired = false
    return {
      tick: (now: number): void => {
        if (Number.isNaN(firstAt)) firstAt = now
        if (fired || now - firstAt < throttleNoticeMs) return
        fired = true
        counters.throttled++
        onTrip?.({ method, key, action: 'throttled', cls })
      },
      sleepCap: (now: number): number => {
        if (fired || Number.isNaN(firstAt)) return Number.POSITIVE_INFINITY
        return Math.max(1, firstAt + throttleNoticeMs - now)
      },
    }
  }

  /**
   * Fair admission to the per-chat COSMETIC pool, keyed per `message_id` (#4300).
   *
   * The single shared `ce:${chat}` bucket every cosmetic surface raced for is
   * replaced (when `cosmeticFairShareEnabled`) by two lanes drawn from the SAME
   * `cosmeticPerChatMax` budget — so the wire rate, the 429 risk, and the reply
   * reserve are all unchanged:
   *
   *   - a FLOOR lane: each distinct cosmetic `message_id` is guaranteed up to
   *     `cosmeticFloorPerWindow` edits/window (`cmf:${chat}:${msg}`), bounded in
   *     aggregate to `cosmeticFloorAggMax` = floor*slots (`cfa:${chat}`) so only
   *     that many distinct ids hold a floor at once. This lane is AIMD-IMMUNE —
   *     it is the anti-starvation + anti-freeze guarantee, and 429 tightening
   *     cannot take a watched card below it.
   *   - a REMAINDER lane (`cer:${chat}`, cap `cosmeticRemainderMax`, AIMD-reduced)
   *     — the still-shared, still-contended part. A lone card uses its floor AND
   *     the whole remainder, so it still bursts to `cosmeticPerMessageMax`.
   *
   * The two caps sum to `cosmeticPerChatMax`, so a floor edit and a remainder
   * edit can never both be admitted beyond the pool. Stale message windows
   * self-evict via the existing `evict` LRU, so the distinct-id set is bounded.
   *
   * Returns the reserved [key, ts] pairs (to hand to the caller's give-back on a
   * later-tier denial), or null when the edit is dropped. Same drop/late-release
   * semantics as the `'drop'` mode of {@link awaitRoom}: an over-budget frame is
   * dropped unless it is the LONE frame for its message, in which case it is
   * released late against the bounded overshoot budget.
   */
  async function awaitCosmeticChatFair(
    chat: string, msg: string, method: string, cls: OutboundClass,
    dropGuard: () => boolean, deadline: number, lateReleaseKey: string,
  ): Promise<Array<[string, number]> | null> {
    const fMsgKey = `cmf:${chat}:${msg}`
    const fAggKey = `cfa:${chat}`
    const remKey = `cer:${chat}`
    const fw = win(fMsgKey)
    const aw = win(fAggKey)
    const rw = win(remKey)
    let counted = false
    const throttle = makeThrottleNotice(method, remKey, cls)
    for (;;) {
      const now = clock.now()
      // Floor lane is free only when BOTH the per-message and the aggregate
      // floor windows have room; those caps are constants (AIMD-immune).
      const wFloor = Math.max(
        waitFor(fw, now, perChatWindowMs, cosmeticFloorPerWindow),
        waitFor(aw, now, perChatWindowMs, cosmeticFloorAggMax),
      )
      const remCap = cosmeticRemainderMax <= 0 ? 0 : ceiling(cosmeticRemainderMax, now)
      const wRem = waitFor(rw, now, perChatWindowMs, remCap)
      if (wFloor === 0) {
        fw.ts.push(now); aw.ts.push(now)
        return [[fMsgKey, now], [fAggKey, now]]
      }
      if (remCap > 0 && wRem === 0) {
        rw.ts.push(now)
        return [[remKey, now]]
      }
      if (now >= deadline) {
        // Over budget at the deadline: drop, unless this is the LONE frame for
        // its message (nothing newer will repaint it), which is released late
        // against the shared overshoot budget — identical to `awaitRoom`'s
        // per-chat drop mode, so a card's terminal frame never freezes it.
        if (dropGuard()) {
          counters.dropped++
          onTrip?.({ method, key: remKey, action: 'dropped', cls })
          return null
        }
        const lw = win(lateReleaseKey)
        prune(lw, now, perChatWindowMs)
        if (lw.ts.length >= ceiling(lateReleaseMax, now)) {
          counters.dropped++
          onTrip?.({ method, key: remKey, action: 'dropped', cls })
          return null
        }
        lw.ts.push(now)
        // Release into the remainder lane when it exists, else the floor lane —
        // either way the slot is recorded so the window reflects the wire.
        if (cosmeticRemainderMax > 0) {
          rw.ts.push(now)
          return [[remKey, now]]
        }
        fw.ts.push(now); aw.ts.push(now)
        return [[fMsgKey, now], [fAggKey, now]]
      }
      if (!counted) {
        counters.deferred++
        counted = true
        onTrip?.({ method, key: remKey, action: 'deferred', cls })
      }
      throttle.tick(now)
      // Both lanes are per-chat keys (a "newer" frame is usually a DIFFERENT
      // message), so this tier never supersedes — it waits for the sooner of the
      // two lanes to open, bounded by the shared deadline and clamped so the
      // loop wakes to raise the 'throttled' notice at its threshold.
      await clock.sleep(Math.min(Math.min(wFloor, wRem), deadline - now, throttle.sleepCap(now)))
    }
  }

  /**
   * Wait for room on `key` and RESERVE the slot on success. Reserving inside
   * the same synchronous step as the check is what makes the ceiling hold
   * under concurrency: N producers that all pass a check-then-act test in the
   * same tick would each admit, and N parallel sub-agents is exactly the shape
   * that turns a ceiling into N× the ceiling.
   *
   * Returns the reserved timestamp, or null when the call must be dropped.
   */
  async function awaitRoom(
    key: string, windowMs: number,
    /**
     * The ceiling, resolved at EVERY loop iteration rather than once at entry.
     * It has to be a function: the effective ceiling depends on the tighten
     * level, the tighten level decays with time, and a call can sit in this
     * loop for `maxDeferMs`. Passing a number would pin a waiter to the ceiling
     * that was in force when it arrived.
     */
    maxFor: (now: number) => number,
    method: string, mode: WaitMode, cls: OutboundClass,
    /**
     * Consulted ONLY at the defer deadline, for every non-`release` mode
     * (`drop` AND `supersede`). Returning false converts the drop into a late
     * release: this call is the last thing that will ever paint its message, so
     * losing it is not "shedding a stale frame", it is freezing a card. Absent
     * ⇒ drop unconditionally (the pre-review behaviour).
     *
     * Note this is the DEADLINE guard only. In `supersede` mode a genuinely
     * newer frame still kills a waiter outright via `w.waiter.kill()` — that is
     * last-write-wins and is unaffected by this guard.
     */
    dropGuard: (() => boolean) | undefined,
    /**
     * Absolute deadline SHARED by every tier of one `apply` call. Each tier
     * used to start its own `maxDeferMs`, so a call crossing three tiers could
     * be held 3×`maxDeferMs` — an unbounded-in-practice hold that a caller's
     * own timeout, not this fuse, would have to end. One deadline per call
     * makes `maxDeferMs` mean what it says.
     */
    deadline: number,
    /**
     * Bounded overshoot budget for the R1 late-release path (cosmetic edits
     * only). R1 says an over-budget edit that nothing newer will repaint must
     * be RELEASED late rather than dropped, so a card cannot freeze mid-run.
     * Taken literally that rule has no ceiling: a stream of cosmetic edits to
     * DISTINCT message ids is a stream of "lone" frames, every one of which
     * releases over budget — which is how 6 concurrent worker cards can sail
     * past a 6/min chat ceiling. Charging each late release to a small extra
     * window keeps R1's guarantee for the rare genuinely-lone frame (a
     * worker's terminal recap) while capping the leak at `lateReleaseMax` per
     * window. Absent ⇒ unbounded late release (sends, non-cosmetic edits).
     */
    lateReleaseKey?: string,
  ): Promise<number | null> {
    const w = win(key)
    let counted = false
    const throttle = makeThrottleNotice(method, key, cls)
    for (;;) {
      const now = clock.now()
      const wait = waitFor(w, now, windowMs, maxFor(now))
      if (wait === 0) {
        w.ts.push(now)
        return now
      }
      if (now >= deadline) {
        // Held as long as we are willing to hold. An edit is dropped (the next
        // render carries full state); a send is released (losing a reply is
        // worse than a late one).
        if (mode !== 'release' && (dropGuard === undefined || dropGuard())) {
          counters.dropped++
          onTrip?.({ method, key, action: 'dropped', cls })
          return null
        }
        // A send — or an edit that nothing newer will repaint — is released
        // rather than dropped, and still takes a slot so the window reflects
        // what actually went out. Cosmetic late releases are additionally
        // charged to the bounded overshoot budget; when that is exhausted the
        // frame is dropped after all, so the ceiling cannot be walked past one
        // "lone" frame at a time.
        if (lateReleaseKey !== undefined) {
          const lw = win(lateReleaseKey)
          prune(lw, now, perChatWindowMs)
          if (lw.ts.length >= ceiling(lateReleaseMax, now)) {
            counters.dropped++
            onTrip?.({ method, key, action: 'dropped', cls })
            return null
          }
          lw.ts.push(now)
        }
        w.ts.push(now)
        return now
      }
      if (!counted) {
        counters.deferred++
        counted = true
        onTrip?.({ method, key, action: 'deferred', cls })
      }
      throttle.tick(now)
      // Clamp the sleep so a single long wait wakes to raise the 'throttled'
      // notice at its threshold rather than sleeping straight to the deadline.
      const nap = Math.min(wait, deadline - now, throttle.sleepCap(now))
      // Last-write-wins: a newer edit to the same message kills this one. Only
      // valid on the per-MESSAGE tier — on a per-chat key the "newer" edit is
      // usually to a DIFFERENT message, and killing an unrelated card's edit is
      // not last-write-wins, it is data loss.
      let killed = false
      if (mode === 'supersede') {
        w.waiter?.kill()
        const superseded = new Promise<void>((resolve) => {
          w.waiter = { kill: () => { killed = true; resolve() } }
        })
        await Promise.race([clock.sleep(nap), superseded])
        if (killed) {
          counters.superseded++
          onTrip?.({ method, key, action: 'superseded', cls })
          return null
        }
        w.waiter = null
      } else {
        await clock.sleep(nap)
      }
    }
  }

  /** The grammY transformer body. */
  async function apply<R>(
    method: string,
    payload: unknown,
    next: () => Promise<R>,
  ): Promise<R> {
    if (!enabled) return next()
    if (UNMETERED_METHODS.has(method)) return runObserved(next)

    const isEdit = EDIT_METHODS.has(method)
    const isSend = SEND_METHODS.has(method)
    const isChatAction = CHAT_ACTION_METHODS.has(method)

    const { chat, msg } = payloadKeys(payload)

    const now = clock.now()
    evict(now)
    // ONE deadline for the whole call, shared by every tier it crosses.
    const deadline = now + maxDeferMs

    // The send gate's priority class, propagated through AsyncLocalStorage.
    // An untagged edit is COSMETIC by default — see `defaultOutboundClass`.
    // A chat action is cosmetic too: it is a self-expiring status, not content.
    const cls =
      currentOutboundClass() ?? (isChatAction ? 'cosmetic' : defaultOutboundClass(isEdit))

    // DEFAULT-DENY (#3855): a call the fuse cannot key to a chat — an inline
    // edit, `answerCallbackQuery`, `getFile`, `setMyCommands` — is NOT free.
    // It cannot take a per-chat slot (there is no chat to charge), but it does
    // consume the bot token's global allowance, which is the thing Telegram
    // actually bans. Charge it there and pass.
    // The token tier is per-SECOND and global; a class floor there would be
    // meaningless (even at maximum tightening it admits 60/min), so it takes
    // the plain tightened ceiling.
    const tokenMaxFor = (t: number): number => ceiling(perTokenMax, t)

    if (chat == null) {
      counters.chatless++
      await awaitRoom(tokenKey, perTokenWindowMs, tokenMaxFor, method, 'release', cls, undefined, deadline)
      return runObserved(next)
    }

    const totalKey = `t:${chat}`
    // Cosmetic traffic may only reach the effective ceiling MINUS the reply
    // reserve; the remaining slots stay available to a real reply no matter how
    // hot the repaint surfaces are, and `critical` additionally cannot be
    // tightened below `perChatCriticalMinPerWindow`. Together these are the
    // reply-starvation guarantee, and unlike the pre-#3885 shape they hold at
    // every tighten level rather than only at level 0.
    const chatTotalMax = totalMaxFor(cls)

    /** Final tier for every chat-targeted path: the token-scoped ceiling. */
    const passToken = async (): Promise<R> => {
      await awaitRoom(tokenKey, perTokenWindowMs, tokenMaxFor, method, 'release', cls, undefined, deadline)
      return runObserved(next)
    }

    if (isEdit && msg != null) {
      const msgKey = `m:${chat}:${msg}`
      const mw = win(msgKey)
      // Counted BEFORE the first await so a frame that arrives while an older
      // one is waiting is visible to that older one's `dropGuard`.
      mw.inflight++
      // R1: only drop while something newer for THIS message is still in
      // flight to repaint it. `> 1` = this frame plus at least one newer.
      const dropGuard = (): boolean => mw.inflight > 1
      // Cosmetic frames share ONE overshoot budget per chat across the
      // per-message and per-chat tiers, so a frame cannot late-release twice on
      // its way out.
      const lateKey = cls === 'cosmetic' ? `lr:${chat}` : undefined
      try {
        // R1 applies to the per-MESSAGE tier too. `supersede` mode still lets a
        // genuinely-newer frame kill this one mid-wait (last-write-wins, the
        // `killed` path), but at the DEFER DEADLINE this tier used to pass
        // `dropGuard: undefined`, which `awaitRoom` reads as "drop
        // unconditionally". A LONE frame — the terminal `finalize` of a card,
        // whose whole job is to replace "→ in-progress" with the done state and
        // which by definition has nothing newer coming — was therefore dropped
        // here after `maxDeferMs`, freezing the card mid-step. That is the exact
        // failure R1 was written to prevent; it was only ever wired into the two
        // per-chat tiers. Passing the same guard makes a lone frame LATE-RELEASE
        // instead, bounded for cosmetic traffic by the shared `lateKey`
        // overshoot budget (non-cosmetic edits — finalize, approval cards — are
        // low-cadence by nature and already late-release unbounded on both
        // per-chat tiers, so this adds no new class of overshoot).
        const msgSlot = await awaitRoom(
          msgKey, perMessageWindowMs,
          cls === 'cosmetic'
            // #4300: cosmetic per-message tier carries the AIMD tighten floor
            // (1 edit/30s) so a 429 cannot freeze a watched card at this tier.
            ? (t) => cosmeticMessageCeiling(t)
            : (t) => classCeiling(perMessageMax, cls, t),
          method, 'supersede', cls, dropGuard, deadline, lateKey,
        )
        if (msgSlot === null) return DROPPED_RESULT as unknown as R
        const reserved: Array<[string, number]> = [[msgKey, msgSlot]]
        const giveBack = (): void => { for (const [k, at] of reserved) unreserve(k, at) }

        // Per-chat COSMETIC pool. #4300: when fair-share is on, admit through the
        // per-`message_id` floor/remainder lanes so one cosmetic surface cannot
        // starve another; the two lanes sum to `cosmeticPerChatMax`, so the wire
        // rate is unchanged. Flag OFF (or a non-cosmetic edit) keeps the single
        // shared `ce:${chat}` bucket byte-for-byte.
        if (cls === 'cosmetic' && cosmeticFairShareEnabled) {
          const fairSlots = await awaitCosmeticChatFair(
            chat, msg, method, cls, dropGuard, deadline, lateKey!,
          )
          if (fairSlots === null) { giveBack(); return DROPPED_RESULT as unknown as R }
          reserved.push(...fairSlots)
        } else {
          const chatKey = `ce:${chat}`
          const chatSlot = await awaitRoom(
            chatKey, perChatWindowMs,
            cls === 'cosmetic'
              ? (t) => ceiling(cosmeticPerChatMax, t)
              : (t) => classCeiling(perChatEditMax, cls, t),
            method, 'drop', cls, dropGuard, deadline, lateKey,
          )
          if (chatSlot === null) { giveBack(); return DROPPED_RESULT as unknown as R }
          reserved.push([chatKey, chatSlot])
        }

        // Shared per-chat budget — the one that mirrors Telegram's real
        // metering. A non-cosmetic edit is RELEASED late rather than dropped:
        // an approval card or answer finalisation has no newer frame coming.
        const totalSlot = await awaitRoom(
          totalKey, perChatWindowMs, chatTotalMax, method,
          cls === 'cosmetic' ? 'drop' : 'release', cls, dropGuard, deadline, lateKey,
        )
        if (totalSlot === null) { giveBack(); return DROPPED_RESULT as unknown as R }
        return passToken()
      } finally {
        mw.inflight--
      }
    }

    if (isSend) {
      // Sends create user-visible output and are NEVER dropped — only paced.
      // The shared budget's reserve is what guarantees they still have room
      // when the repaint surfaces are saturated.
      await awaitRoom(`cs:${chat}`, perChatWindowMs,
        (t) => classCeiling(perChatSendMax, cls, t), method, 'release', cls, undefined, deadline)
      await awaitRoom(totalKey, perChatWindowMs, chatTotalMax, method, 'release', cls, undefined, deadline)
      return passToken()
    }

    // DEFAULT-DENY (#3855). Everything else with a `chat_id` — `sendChatAction`,
    // `setMessageReaction`, `deleteMessage`, `pinChatMessage`, `sendChecklist`,
    // an inline edit that carries a chat but no message id, and any Bot API
    // method added after this file was written — is charged to the SAME shared
    // per-chat window. Previously all of it was free, which is how a "20/60s"
    // ceiling admitted ~34 calls/60s on the wire.
    counters.meteredByDefault++
    if (isChatAction) {
      // Self-expiring status: shed it rather than deliver it late. Its own
      // short deadline also keeps a typing ping from occupying a 30s hold.
      const actionDeadline = Math.min(deadline, now + chatActionMaxDeferMs)
      const slot = await awaitRoom(
        totalKey, perChatWindowMs, chatTotalMax, method, 'drop', cls, undefined, actionDeadline,
      )
      if (slot === null) return DROPPED_RESULT as unknown as R
      return passToken()
    }
    // Durable, user-visible effect (a deletion, a pin, a reaction): paced,
    // never dropped — the same contract sends get.
    await awaitRoom(totalKey, perChatWindowMs, chatTotalMax, method, 'release', cls, undefined, deadline)
    return passToken()
  }

  /** Run the downstream call, tightening the ceilings if it floods. */
  async function runObserved<R>(next: () => Promise<R>): Promise<R> {
    try {
      const res = await next()
      // grammY throws on ok:false, but a transformer installed BELOW another
      // one can still observe a raw ApiResponse — handle both shapes.
      const r = res as unknown as {
        ok?: boolean; error_code?: number; parameters?: { retry_after?: number }
      }
      if (r != null && typeof r === 'object' && r.ok === false && r.error_code === 429) {
        noteFlood(clock.now(), r.parameters?.retry_after ?? 0)
      }
      return res
    } catch (err) {
      const retryAfterSec = floodRetryAfterSec(err)
      if (retryAfterSec !== null) noteFlood(clock.now(), retryAfterSec)
      throw err
    }
  }

  function stats(): EditFloodFuseStats {
    const now = clock.now()
    return {
      enabled,
      deferred: counters.deferred,
      dropped: counters.dropped,
      superseded: counters.superseded,
      throttled: counters.throttled,
      cosmeticFairShareEnabled,
      floodObserved: counters.floodObserved,
      tightened: isTightened(now),
      tightenLevel: levelAt(now),
      perMessageCeiling: ceiling(perMessageMax, now),
      cosmeticPerMessageCeiling: ceiling(cosmeticPerMessageMax, now),
      cosmeticPerChatCeiling: ceiling(cosmeticPerChatMax, now),
      cosmeticPerChatTotalCeiling: cosmeticTotalMax(now),
      criticalPerChatTotalCeiling: classCeiling(perChatTotalMax, 'critical', now),
      meteredByDefault: counters.meteredByDefault,
      chatless: counters.chatless,
      perTokenCeiling: ceiling(perTokenMax, now),
      persistedFloodOpen: persistedFloodRemainingMs(now) > 0,
    }
  }

  return { apply, stats }
}

export type EditFloodFuse = ReturnType<typeof createEditFloodFuse>

/**
 * The bot handle the fuse installs on. Typed against grammY's own `Bot` so the
 * transformer signature is checked by the compiler, not by convention.
 */
export type FuseInstallable = Bot

export function installEditFloodFuse(bot: FuseInstallable, config: EditFloodFuseConfig = {}): EditFloodFuse {
  // The token window is keyed by the bot's PUBLIC id only. `deriveBotScopeKey`
  // never returns any part of the secret half, and the key is used solely as an
  // in-memory Map key — never logged, never persisted.
  const fuse = createEditFloodFuse({
    botScopeKey: deriveBotScopeKey((bot as { token?: string }).token),
    ...config,
  })
  bot.api.config.use(async (prev, method, payload, signal) =>
    fuse.apply(method, payload, () => prev(method, payload, signal)))
  return fuse
}
