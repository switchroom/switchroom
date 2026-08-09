/**
 * Inbound routing seam (switchroom#2996 P7).
 *
 * `routeInbound` is the single entry point the gateway's coalesced inbound
 * surfaces (`bot.on('message:text')` and the terminal
 * `installUnhandledMessageCatchAll`) delegate through. TODAY it is a pure
 * indirection: it forwards straight to the existing `handleInboundCoalesced`
 * via an injected `InboundRouterDeps` — behaviour-identical, zero control-flow
 * change. It exists so the later P7 stages can (a) move the intercept gauntlet
 * into `inbound-interceptors.ts` behind this same Deps boundary and (b) put the
 * eventual v2 consolidated control flow behind a deterministic kill switch at
 * one chokepoint, mirroring the P6 `MediaEnvelopeDeps` injection idiom.
 *
 * The Deps object holds LIVE references to the gateway's collaborators (never
 * value snapshots), bound once in gateway.ts alongside `mediaEnvelopeDeps`.
 */

import type { Context } from 'grammy'
import type { AttachmentMeta } from './gateway.js'
import {
  interceptStopKeyword,
  interceptInterruptMarker,
  interceptPermissionReply,
  interceptAuthAdd,
  interceptLoopbackRelay,
  interceptReauth,
  interceptVault,
  interceptSecretStagingCommand,
  type InboundInterceptorDeps,
  type InterceptOutcome,
  type StopKeywordParams,
  type InterruptMarkerParams,
  type InterruptMarkerOutcome,
  type AuthAddParams,
} from './inbound-interceptors.js'
import type { InboundMessage } from './ipc-protocol.js'
import { deriveTurnId } from './derive-turn-id.js'
import { formatReplyToText } from '../steering.js'
import { fmtLocalStamp, resolveEnvTimezone } from '../shared/local-time.js'
import { safeResolvePersonName, type PersonDirectory } from './resolve-person.js'
import {
  parseForwardOrigin,
  dedupeForwardOrigins,
  buildForwardOriginMeta,
  forwardOriginDateIso,
  type ForwardOriginInfo,
} from './forward-origin.js'

/**
 * Collaborators `routeInbound` needs, injected from gateway.ts module scope so
 * this module stays importable + unit-testable without gateway's boot side
 * effects. Extended by later P7 stages as intercepts move across the boundary;
 * every field is a live reference (function / Map / object), not a snapshot.
 */
export interface InboundRouterDeps {
  handleInboundCoalesced: (
    ctx: Context,
    text: string,
    downloadImage: (() => Promise<string | undefined>) | undefined,
    attachment?: AttachmentMeta,
  ) => Promise<void>
}

/**
 * Route a coalesced inbound message. Pure indirection in P7 PR-1 — forwards to
 * `deps.handleInboundCoalesced` unchanged.
 */
export async function routeInbound(
  ctx: Context,
  text: string,
  downloadImage: (() => Promise<string | undefined>) | undefined,
  attachment: AttachmentMeta | undefined,
  deps: InboundRouterDeps,
): Promise<void> {
  return deps.handleInboundCoalesced(ctx, text, downloadImage, attachment)
}


// ─── P7 PR-10: admission head + pure envelope builders ─────────────────────

/** Admission decision facts injected from gateway.ts (all live refs / fixed
 * values). `topicId` is the boot-fixed TOPIC_ID scoping; `gate` is the
 * allowFrom access gate; `logGateDeny` the rate-limited deny logger. */
export interface InboundAdmissionDeps {
  topicId: number | null
  gate: (ctx: Context) =>
    | { action: 'deliver'; access: unknown }
    | { action: 'drop'; reason: unknown }
    | { action: 'pair'; code: string; isResend: boolean }
  logGateDeny: (ctx: Context, reason: never) => void
}

/** Outcome of admission: `admitted: false` — fully handled (topic-scoped out,
 * gate-dropped, or pairing replied); `admitted: true` carries the gate's
 * access payload for downstream person-resolution. */
export type InboundAdmissionResult =
  | { admitted: false }
  | { admitted: true; access: unknown }

/**
 * Topic-scope + access-gate admission head of handleInbound, moved verbatim
 * (#2996 P7 PR-10). Drop/pair early-return semantics unchanged: TOPIC_ID
 * scoping silently ignores out-of-topic messages; gate 'drop' logs the deny;
 * gate 'pair' replies with the pairing instruction.
 */
export async function admitInbound(
  ctx: Context,
  deps: InboundAdmissionDeps,
): Promise<InboundAdmissionResult> {
  const isTopicMessage = ctx.message?.is_topic_message ?? false
  const messageThreadId = ctx.message?.message_thread_id

  if (deps.topicId != null) {
    if (!isTopicMessage || messageThreadId !== deps.topicId) return { admitted: false }
  }

  const result = deps.gate(ctx)
  if (result.action === 'drop') {
    deps.logGateDeny(ctx, result.reason as never)
    return { admitted: false }
  }
  if (result.action === 'pair') {
    const lead = result.isResend ? 'Still pending' : 'Pairing required'
    await ctx.reply(`${lead} — run in Claude Code:\n\n/telegram:access pair ${result.code}`)
    return { admitted: false }
  }
  return { admitted: true, access: result.access }
}

/** Inputs for {@link buildReplyForwardContext} (pure). */
export interface ReplyForwardContextParams {
  ctx: Context
  coalescedForwardOrigins: ForwardOriginInfo[] | undefined
  /** REPLY_TO_TEXT_MAX — fixed constant. */
  replyToTextMax: number
}

/** Pure builder: Telegram-native reply context (#119) + server-stamped
 * forward-origin context. Moved verbatim (#2996 P7 PR-10); raw-vs-escaped
 * split preserved (raw for SQLite, escaped for channel meta). */
export function buildReplyForwardContext(p: ReplyForwardContextParams): {
  replyToMessageId: number | undefined
  replyToText: string | undefined
  replyToTextEscaped: string | undefined
  forwardOrigins: ForwardOriginInfo[]
  forwardOriginMeta: Record<string, string>
  primaryForwardOrigin: ForwardOriginInfo | undefined
} {
  // Telegram-native reply context (issue #119). Same pattern as server.ts:
  // `replyToText` is raw (for SQLite); `replyToTextEscaped` is XML-escaped
  // (for channel meta).
  const replyToMsg = p.ctx.message?.reply_to_message
  const replyToMessageId = replyToMsg?.message_id
  // Native partial-quote preference (Bot API 7.0+ `message.quote`, issue #119
  // follow-up). When the user long-presses a message and drag-selects a
  // substring before choosing Reply, Telegram delivers only that quoted span
  // on `message.quote.text` — the user is pointing at that exact slice, so it
  // is a stronger antecedent than the full parent message. Prefer it over the
  // parent `.text`/`.caption`, and over the history-buffer fallback the
  // gateway runs when neither is present. Accessed defensively in case the
  // installed grammy/@grammyjs/types predate `TextQuote`.
  const quoteText = p.ctx.message?.quote?.text
  const replyToTextRaw = (quoteText != null && quoteText.length > 0)
    ? quoteText
    : replyToMsg
      ? (replyToMsg.text ?? replyToMsg.caption ?? undefined)
      : undefined
  const replyToText = replyToTextRaw != null
    ? (replyToTextRaw.length > p.replyToTextMax
        ? replyToTextRaw.slice(0, p.replyToTextMax - 1) + '…'
        : replyToTextRaw)
    : undefined
  const replyToTextEscaped = formatReplyToText(replyToTextRaw, p.replyToTextMax)

  // Forwarded-message origin context. `forward_origin` is stamped by
  // Telegram's servers (Bot API 7.0+) — the forwarding user cannot forge
  // it via the message body, so it rides the trusted attrs lane and is
  // NEVER folded into the body text. Coalesced bursts pass their deduped
  // per-entry origins; direct/bypass paths parse this p.ctx's own origin.
  // Same raw-vs-escaped split as reply_to_text: `forwardOrigins` carries
  // raw (truncated) names for SQLite, `buildForwardOriginMeta` escapes at
  // the channel-meta boundary.
  const forwardOrigins = p.coalescedForwardOrigins
    ?? dedupeForwardOrigins([parseForwardOrigin(p.ctx.message?.forward_origin)])
  const forwardOriginMeta = buildForwardOriginMeta(forwardOrigins)
  const primaryForwardOrigin = forwardOrigins[0]
  return {
    replyToMessageId,
    replyToText,
    replyToTextEscaped,
    forwardOrigins,
    forwardOriginMeta,
    primaryForwardOrigin,
  }
}

/** Inputs for {@link resolveReplyToFromBuffer}. */
export interface ReplyToBufferFallbackParams {
  /** From {@link buildReplyForwardContext}. */
  replyToMessageId: number | undefined
  /** Raw reply text off the live update (for the SQLite write); empty when the
   *  reply target is the bot's own message (Telegram omits its text). */
  replyToText: string | undefined
  /** XML-escaped reply text for the channel meta; empty in the same case. */
  replyToTextEscaped: string | undefined
  /** HISTORY_ENABLED — the DB is only present when history is on. */
  historyEnabled: boolean
  /** REPLY_TO_TEXT_MAX. */
  replyToTextMax: number
  /** `lookupMessageRoleAndText` bound to the chat, or any equivalent. May
   *  throw (e.g. requireDb when history disabled mid-run) — this is caught.
   *
   *  Bind it with `includeSystem: true` (#4571) so a reply that points at a
   *  CARD — the activity card, a status pin, an approval card — resolves
   *  instead of returning null. `kind` carries the card family. */
  lookup: (
    messageId: number,
  ) => { role: 'user' | 'assistant' | 'system'; text: string; kind?: string | null } | null
}

/**
 * Reply-to buffer fallback (post-reset continuity). On a native reply to the
 * BOT's OWN message, Telegram delivers `reply_to_message.message_id` but NOT
 * its `.text` — so the live reply text is empty even though the gateway
 * authored (and, via `recordOutbound`, persisted) that message. This recovers
 * the antecedent from the local history buffer so it survives a session reset
 * (`resume_mode: handoff`), where the transcript is gone.
 *
 * Returns updated `replyToText` (raw, for the SQLite `recordInbound` write —
 * envelope-only would leave the row NULL and starve future handoff briefings),
 * `replyToTextEscaped` (for the channel-meta `reply_to_text`), and the
 * recovered `replyToRole` ('assistant' = the bot's own message, disambiguating
 * the "you're replying to yourself" case). Pure except for the injected
 * `lookup`. Only fills in when the live reply text is empty — never overwrites
 * a non-empty live value (a partial-quote or a reply to a person's message).
 * Degrades silently to the id-only inputs on any lookup failure.
 */
export function resolveReplyToFromBuffer(p: ReplyToBufferFallbackParams): {
  replyToText: string | undefined
  replyToTextEscaped: string | undefined
  replyToRole: 'user' | 'assistant' | 'system' | undefined
  /** Card family (`activity-summary`, `approval-card`, …) when the antecedent
   *  is a system-lane row. Undefined otherwise. #4571. */
  replyToKind: string | undefined
} {
  let replyToText = p.replyToText
  let replyToTextEscaped = p.replyToTextEscaped
  let replyToRole: 'user' | 'assistant' | 'system' | undefined
  let replyToKind: string | undefined
  const liveTextEmpty = replyToTextEscaped == null || replyToTextEscaped.length === 0
  if (p.historyEnabled && p.replyToMessageId != null && liveTextEmpty) {
    try {
      const recovered = p.lookup(p.replyToMessageId)
      if (recovered != null && recovered.role === 'system' && recovered.kind) {
        replyToKind = recovered.kind
      }
      if (recovered && recovered.text.length > 0) {
        replyToText =
          recovered.text.length > p.replyToTextMax
            ? recovered.text.slice(0, p.replyToTextMax - 1) + '…'
            : recovered.text
        replyToTextEscaped = formatReplyToText(recovered.text, p.replyToTextMax)
        replyToRole = recovered.role
      } else if (recovered) {
        // Row exists (authorship known) but text is empty/redacted — still
        // surface the role so the model knows whose message it is replying to.
        replyToRole = recovered.role
      }
    } catch {
      // History disabled mid-run / requireDb throws / row missing — degrade
      // silently to the id-only inputs (current behavior).
    }
  }
  return { replyToText, replyToTextEscaped, replyToRole, replyToKind }
}

/** Inputs for {@link buildInboundEnvelope} — every field is an at-call
 * captured value (steering meta, at-receipt snapshots, resolved attachments),
 * never a live getter. */
export interface EnvelopeBuildParams {
  ctx: Context
  chat_id: string
  messageThreadId: number | undefined
  msgId: number | undefined
  effectiveText: string
  imagePath: string | undefined
  attachment: AttachmentMeta | undefined
  attachmentCount: number
  extraMeta: Record<string, string>
  from: { id: number; username?: string }
  access: { groups: Record<string, { allowFrom?: string[] } | undefined> }
  isSteering: boolean
  isQueuedPrefix: boolean
  isQueuedMidTurn: boolean
  priorTurnInProgress: boolean
  secondsSinceTurnStart: number | undefined
  priorAssistantPreview: string | undefined
  replyToMessageId: number | undefined
  replyToTextEscaped: string | undefined
  /** Authorship of the replied-to message ('assistant' = the bot's own
   * message, 'user' = a person's), when known — recovered from the history
   * buffer by handleInbound's reply-to fallback. Undefined when the role
   * can't be determined (e.g. text came live off the update, not the DB). */
  replyToRole: 'user' | 'assistant' | 'system' | undefined
  /** #4571 — when the antecedent is a CARD the gateway posted (activity card,
   * status pin, approval card…), the card family. Emitted as `reply_to_kind`
   * alongside `reply_to_role="system"`. */
  replyToKind?: string | undefined
  forwardOriginMeta: Record<string, string>
  /** TOPIC_FRAMING_ENABLED — fixed constant. */
  topicFramingEnabled: boolean
  /** Captured at call time; the gateway's PERSON_DIRECTORY is a boot-assigned
   * mutable let, so the value crosses per message. */
  personDirectory: PersonDirectory
  isDmChatId: (chatId: string | null | undefined) => boolean
}

/**
 * Pure builder for the ipc-protocol InboundMessage envelope (meta lane +
 * attachment fields + steering/queued flags + origin-turn-id + topic-scope
 * directive). Moved verbatim from handleInbound (#2996 P7 PR-10); the machine
 * emit and deliver-or-buffer dispatch stay in gateway.ts, wired exactly as
 * before.
 */
export function buildInboundEnvelope(p: EnvelopeBuildParams): InboundMessage {
  // Dispatch to connected bridge via IPC
  // Component 3 — stable origin turn id stamped into the meta the model
  // reads, so a reply can echo it back (origin_turn_id) and the gateway
  // can route the answer to the turn that owns it even after currentTurn
  // flips. Derived from chat/thread/messageId, matching the turnId the
  // enqueue handler computes for the turn this inbound starts.
  const originTurnId = deriveTurnId(p.chat_id, p.messageThreadId ?? null, p.msgId)
  // Component 4 — per-turn topic framing. In a forum supergroup a queued
  // cross-topic message could tempt the model to also answer a pending
  // question from another topic. A one-line directive (only for topic
  // inbounds, only when framing is enabled) pins the model to THIS
  // message's topic. DMs / non-topic chats get nothing.
  const topicScope =
    p.topicFramingEnabled && p.messageThreadId != null
      ? 'This message belongs to the current topic only — answer ONLY this question, in this topic. Do not also answer a pending message from another topic.'
      : undefined
  // person_id name resolution (docs/configuration.md, resolve-person.ts):
  // chat-scoped, boot-time-static lookup — falls back to today's raw
  // id/username behavior (fail-open) whenever unresolved or when group
  // membership can't be positively confirmed from p.access.json's allowFrom.
  // Never touches p.access.json itself and never blocks/denies anything.
  const rawUser = p.from.username ?? String(p.from.id)
  const displayUser = safeResolvePersonName(
    p.personDirectory,
    {
      telegramId: String(p.from.id),
      username: p.from.username,
      isDm: p.isDmChatId(p.chat_id),
      groupAllowFrom: p.access.groups[p.chat_id]?.allowFrom,
    },
    rawUser,
  )
  const inboundMsg: InboundMessage = {
    type: 'inbound',
    chatId: p.chat_id,
    ...(p.messageThreadId != null ? { threadId: p.messageThreadId } : {}),
    messageId: p.msgId ?? 0,
    user: displayUser,
    userId: p.from.id,
    ts: p.ctx.message?.date ?? Math.floor(Date.now() / 1000),
    text: p.effectiveText,
    ...(p.imagePath ? { imagePath: p.imagePath } : {}),
    ...(p.attachment ? {
      attachment: {
        fileId: p.attachment.file_id,
        mimeType: p.attachment.mime ?? 'application/octet-stream',
        ...(p.attachment.name ? { fileName: p.attachment.name } : {}),
      },
    } : {}),
    meta: {
      chat_id: p.chat_id,
      ...(p.msgId != null ? { message_id: String(p.msgId) } : {}),
      user: displayUser,
      user_id: String(p.from.id),
      // Model-facing `ts="…"` on the inbound <channel> tag. Rendered as the
      // agent's LOCAL am/pm wall-clock (NOT UTC ISO) so the model never reads
      // a competing UTC "now" — the numeric epoch survives on InboundMessage.ts
      // (above) and in the SQLite history for any machine consumer.
      ts: fmtLocalStamp((p.ctx.message?.date ?? 0) * 1000, resolveEnvTimezone()),
      ...(p.messageThreadId != null ? { message_thread_id: String(p.messageThreadId) } : {}),
      // Component 3 — origin turn id. The model is told to pass this back
      // as origin_turn_id on the reply so the answer routes to the topic
      // this message came from (turn-origin routing). The reply tool also
      // resolves it from the live/recent turn registry, so a model that
      // omits it still routes correctly via the live-turn fallback.
      ...(originTurnId != null ? { origin_turn_id: originTurnId } : {}),
      // Component 4 — per-turn topic-scope directive (supergroup topics).
      ...(topicScope != null ? { topic_scope: topicScope } : {}),
      ...(p.imagePath ? { image_path: p.imagePath } : {}),
      // Telegram-native reply context (issue #119). When set, the user
      // long-pressed a prior message and chose "Reply" — the agent should
      // treat this as the antecedent for "this" / "that" / pronoun
      // references in the body, instead of asking the user what they meant.
      ...(p.replyToMessageId != null ? { reply_to_message_id: String(p.replyToMessageId) } : {}),
      // Use the XML-escaped form for the meta — the raw form is in the
      // SQLite buffer for verbatim retrieval via get_recent_messages.
      ...(p.replyToTextEscaped != null && p.replyToTextEscaped.length > 0 ? { reply_to_text: p.replyToTextEscaped } : {}),
      // Authorship of the replied-to message. Disambiguates "you are replying
      // to the BOT's own message" (assistant) from "…to a person's message"
      // (user) — the incident where a native reply to one of the bot's own
      // messages ("is this added as a calendar invite yet?") left the agent
      // guessing the antecedent. Free: the history-buffer lookup that recovers
      // reply_to_text already returns the role. Emitted only when known.
      ...(p.replyToRole != null ? { reply_to_role: p.replyToRole } : {}),
      // #4571 — the antecedent is one of the bot's own CARDS, not a reply.
      // `reply_to_role="system"` + `reply_to_kind="activity-summary"` tells the
      // agent the operator tapped the live working card (the most recent thing
      // on their screen for most of a turn) rather than an answer, so it can
      // read `reply_to_text` as the card body instead of reporting amnesia.
      ...(p.replyToKind != null && p.replyToKind.length > 0
        ? { reply_to_kind: p.replyToKind }
        : {}),
      // Forwarded-message origin (server-stamped, attrs-only — see above).
      // forwarded_from / forwarded_from_type / forwarded_from_id /
      // forwarded_date, plus numbered _2.. siblings for a multi-origin
      // burst. Names are XML-escaped inside buildForwardOriginMeta.
      ...p.forwardOriginMeta,
      // queued="true" when mid-turn with no steer prefix (new default), or
      // with explicit /queue or /q prefix (legacy alias).
      ...((p.isQueuedMidTurn || p.isQueuedPrefix) ? { queued: 'true' } : {}),
      // steering="true" only when explicit /steer or /s prefix used.
      ...(p.isSteering ? { steering: 'true' } : {}),
      ...(p.priorTurnInProgress ? { prior_turn_in_progress: 'true' } : {}),
      ...(p.priorTurnInProgress && p.secondsSinceTurnStart != null ? { seconds_since_turn_start: String(p.secondsSinceTurnStart) } : {}),
      ...(p.priorTurnInProgress && p.priorAssistantPreview != null && p.priorAssistantPreview.length > 0 ? { prior_assistant_preview: p.priorAssistantPreview } : {}),
      ...(p.attachment ? {
        attachment_kind: p.attachment.kind,
        attachment_file_id: p.attachment.file_id,
        ...(p.attachment.size != null ? { attachment_size: String(p.attachment.size) } : {}),
        ...(p.attachment.mime ? { attachment_mime: p.attachment.mime } : {}),
        ...(p.attachment.name ? { attachment_name: p.attachment.name } : {}),
      } : {}),
      // A2: numbered fields for the 2nd..Nth p.attachment + a total count so
      // the agent reads every item in a coalesced multi-media burst.
      ...(p.attachmentCount > 1 ? { attachment_count: String(p.attachmentCount) } : {}),
      ...p.extraMeta,
    },
  }
  return inboundMsg
}


// ─── P7 PR-11: kill-switched v2 intercept chain ────────────────────────────

/**
 * THE deterministic cutover switch (#2996 P7 PR-11, design §2). Read ONCE at
 * module load (F2: flags are const-captured — flipping requires an agent
 * restart, same as every other `_ENABLED` flag). Default ON (canary-validated
 * on v0.18.33 — 5/5 UAT, DM + supergroup): the v2 consolidated intercept chain
 * is the production control flow. The v2 chain and the legacy sequence call the
 * SAME extracted intercept functions in the SAME order — the characterization
 * harness is the parity oracle (F6; the #3316-removed gate-parity probe is not
 * relied on), and tests/inbound-router-v2-chain.test.ts pins the v2 path with
 * the flag set env-before-import.
 *
 * Rollback (escape hatch): `SWITCHROOM_INBOUND_ROUTER_V2=0` + agent restart.
 * No model involvement.
 */
export const INBOUND_ROUTER_V2 = process.env.SWITCHROOM_INBOUND_ROUTER_V2 !== '0'

/** Outcome of the pre-turn chain: stop-keyword then interrupt-marker. */
export type PreTurnChainOutcome = InterruptMarkerOutcome

/**
 * v2 chain, segment 1 — the pre-turn kill switches, in load-bearing order:
 * stop-keyword (#3020) THEN interrupt-marker (#575). Between this chain and
 * the paste-back chain the caller runs the stay-behind status-KPI telemetry
 * block (F3 — non-intercepting, position preserved).
 */
export async function runPreTurnIntercepts(
  p: { stop: StopKeywordParams; interrupt: InterruptMarkerParams },
  deps: InboundInterceptorDeps,
): Promise<PreTurnChainOutcome> {
  const stopOutcome = await interceptStopKeyword(p.stop, deps)
  if (stopOutcome.handled) return { handled: true }
  return interceptInterruptMarker(p.interrupt, deps)
}

/**
 * v2 chain, segment 2 — the reply/paste-back gauntlet, in load-bearing order:
 * permission-reply → auth-add → loopback-relay (incl. #3084 fail-safe) →
 * reauth → vault → secret-staging command. Auth-add-before-reauth and
 * fail-safe-before-reauth orderings are enforced structurally here (the
 * design's PR-11 goal: ordering by code, not by comment).
 */
export async function runPasteBackIntercepts(
  p: AuthAddParams,
  deps: InboundInterceptorDeps,
): Promise<InterceptOutcome> {
  const perm = interceptPermissionReply(
    { text: p.text, chat_id: p.chat_id, msgId: p.msgId },
    deps,
  )
  if (perm.handled) return perm
  const authAdd = await interceptAuthAdd(p, deps)
  if (authAdd.handled) return authAdd
  const loopback = await interceptLoopbackRelay(p, deps)
  if (loopback.handled) return loopback
  const reauth = await interceptReauth(p, deps)
  if (reauth.handled) return reauth
  const vault = await interceptVault(
    { ctx: p.ctx, text: p.text, chat_id: p.chat_id, msgId: p.msgId },
    deps,
  )
  if (vault.handled) return vault
  return interceptSecretStagingCommand(
    { ctx: p.ctx, text: p.text, chat_id: p.chat_id, msgId: p.msgId },
    deps,
  )
}
