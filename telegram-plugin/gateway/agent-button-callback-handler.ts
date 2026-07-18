/**
 * Agent-emitted inline-keyboard callback family (`agent:` prefix, #271)
 * extracted verbatim from the gateway's `callback_query:data` dispatcher
 * (switchroom#2996 P6 dispatcher drain).
 *
 * A tap is forwarded to the connected bridge as an InboundMessage with
 * meta.button_callback_data set, routed through the SAME turn-safe delivery
 * machinery as a normal inbound (injected deliverButtonTapInbound). Ack
 * toast (#710), single-use keyboard strip, and the #789 "✅ You chose: X"
 * annotation move with it.
 *
 * Returns true when the callback was an agent button (handled — dispatcher
 * must `return`), false otherwise (dispatcher falls through to the perm:
 * family).
 *
 * DI note (cluster-F pattern): the raw `bot.api.sendMessage` restarting
 * notice stays in gateway.ts inside swallowingApiCall, injected as
 * `sendRestartingNotice`. This module has no raw Bot API site.
 */

import type { Context } from 'grammy'
import {
  parseAgentCallback,
  keyboardIsSingleUse,
  resolveTapAnnotation,
  applyTapAnnotationEdit,
  type AgentButtonMeta,
} from '../inline-keyboard-callbacks.js'
import type { InboundMessage } from './ipc-protocol.js'

export interface AgentButtonCallbackDeps {
  loadAccess: () => {
    allowFrom: string[]
    parseMode?: 'html' | 'markdownv2' | 'text'
    button_choice_confirmation?: unknown
  }
  /** chatId:messageId → per-button meta stashed at send time (#710). */
  agentButtonMeta: {
    get: (key: string) => Map<string, AgentButtonMeta> | undefined
    delete: (key: string) => void
  }
  /** Turn-safe button-tap delivery (#271) — buffers mid-turn, spools offline. */
  deliverButtonTapInbound: (
    agent: string,
    msg: InboundMessage,
  ) => Promise<string>
  /** swallowingApiCall(() => bot.api.sendMessage(...)) — bound in gateway.ts. */
  sendRestartingNotice: (chatId: string, threadId: number | undefined) => void
  /** Warn-once registries (#789), keyed per agent-process. */
  buttonConfirmSingleUseWarned: Set<string>
  buttonConfirmParseModeWarned: Set<string>
  /** stderr log sink. */
  log: (line: string) => void
}

/** Handle an `agent:` callback. Returns false if `data` is not one. */
export async function handleAgentButtonCallback(
  ctx: Context,
  data: string,
  deps: AgentButtonCallbackDeps,
): Promise<boolean> {
  const agentCb = parseAgentCallback(data)
  if (agentCb == null) return false
  // Authorization gate — same allowlist as inbound text messages.
  // Without this any random Telegram user who could see a button
  // could trigger an action on the agent's behalf.
  const access = deps.loadAccess()
  const senderId = String(ctx.from!.id)
  if (!access.allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return true
  }
  const cbChatId = String(ctx.chat?.id ?? ctx.from!.id)
  const cbMessageId = ctx.callbackQuery?.message?.message_id
  // #710: look up agent-supplied per-button meta (ack_text / single_use)
  // stashed at send time. Empty map after a gateway restart — defaults
  // still give the user-visible toast + keyboard removal.
  const metaForMessage = cbMessageId != null
    ? deps.agentButtonMeta.get(`${cbChatId}:${cbMessageId}`)
    : undefined
  const tapMeta = metaForMessage?.get(agentCb.raw)
  const ackText = (typeof tapMeta?.ack_text === 'string' && tapMeta.ack_text.length > 0)
    ? tapMeta.ack_text
    : '✓ received'
  // Ack the spinner FIRST with a visible toast so the user knows the
  // tap registered (#710 — empty ack showed nothing, users re-tapped).
  await ctx.answerCallbackQuery({ text: ackText }).catch(() => {})
  const buttonText = (() => {
    // Best-effort: pull the tapped button's label from the source
    // message's keyboard so the agent gets a human-readable echo.
    const msg = ctx.callbackQuery?.message
    const kb = (msg && 'reply_markup' in msg ? msg.reply_markup : undefined) as
      | { inline_keyboard?: Array<Array<{ text?: string; callback_data?: string }>> }
      | undefined
    if (!kb?.inline_keyboard) return undefined
    for (const row of kb.inline_keyboard) {
      for (const btn of row) {
        if (btn.callback_data === data && typeof btn.text === 'string') return btn.text
      }
    }
    return undefined
  })()
  const cbThreadId = (() => {
    const msg = ctx.callbackQuery?.message
    if (msg && 'is_topic_message' in msg && msg.is_topic_message && 'message_thread_id' in msg) {
      const tid = (msg as { message_thread_id?: number }).message_thread_id
      return typeof tid === 'number' ? tid : undefined
    }
    return undefined
  })()
  const inboundText = buttonText
    ? `[user tapped button: ${JSON.stringify(buttonText)} → ${agentCb.raw}]`
    : `[user tapped button: ${agentCb.raw}]`
  const inboundMsg: InboundMessage = {
    type: 'inbound',
    chatId: cbChatId,
    ...(cbThreadId != null ? { threadId: cbThreadId } : {}),
    messageId: cbMessageId ?? 0,
    user: ctx.from!.username ?? String(ctx.from!.id),
    userId: ctx.from!.id,
    ts: Math.floor(Date.now() / 1000),
    text: inboundText,
    meta: {
      chat_id: cbChatId,
      ...(cbMessageId != null ? { message_id: String(cbMessageId) } : {}),
      user: ctx.from!.username ?? String(ctx.from!.id),
      user_id: String(ctx.from!.id),
      ts: new Date().toISOString(),
      ...(cbThreadId != null ? { message_thread_id: String(cbThreadId) } : {}),
      button_callback: 'true',
      button_callback_data: agentCb.raw,
      ...(buttonText != null ? { button_text: buttonText } : {}),
    },
  }
  deps.log(
    `telegram gateway: button_callback chatId=${cbChatId} user=${ctx.from!.id} data=${JSON.stringify(agentCb.raw)} btnText=${JSON.stringify(buttonText ?? null)}\n`,
  )
  // #271 turn-safety: route the tap through the SAME turn-safe delivery
  // machinery as a normal inbound (deliverButtonTapInbound) instead of a raw
  // sendToAgent. A tap landing mid-turn now buffers until idle (never strands
  // in the composer, #1556), a delivered tap is composer-cleared first and
  // tracked so the redelivery sweep rescues a strand, and a bridge-offline tap
  // still spools + shows the restart notice below (unchanged UX). The old raw
  // path (sendToAgent → pendingInboundBuffer, drained by onClientRegistered)
  // fixed only the bridge-mid-reconnect drop; it never gated on turn state.
  const selfAgentBtn = process.env.SWITCHROOM_AGENT_NAME ?? ''
  const btnOutcome = await deps.deliverButtonTapInbound(selfAgentBtn, inboundMsg)
  if (btnOutcome === 'buffered-bridge-offline') {
    // No registered bridge — the agent's mid-restart. Tell the user
    // so they don't think the button silently swallowed their tap;
    // the tap is genuinely buffered now and replays on reconnect.
    // #1075: thread-id-bearing — swallow on THREAD_NOT_FOUND.
    deps.sendRestartingNotice(cbChatId, cbThreadId)
  }
  // #710: strip the keyboard after tap so the buttons can't be
  // double-fired. Default policy is single-use — preserve the
  // keyboard only if at least one button on the message explicitly
  // opts out via `single_use: false`. With no stashed meta (e.g.
  // gateway restarted between send and tap) the default fires too,
  // which is the desired UX.
  const singleUse = metaForMessage == null || keyboardIsSingleUse(metaForMessage)

  // Source message body text — photos/stickers/etc. carry no `text`.
  const cbMsg = ctx.callbackQuery?.message
  const sourceText = cbMsg && 'text' in cbMsg && typeof cbMsg.text === 'string'
    ? cbMsg.text
    : undefined

  // #789: pure decision for the "✅ You chose: X" body annotation. Per-message
  // override (the tapped button's inline_keyboard_confirm) wins over the agent
  // default; fires only on single-use keyboards with body text + a label and
  // the default 'html' parse mode.
  const annotation = resolveTapAnnotation({
    ...(tapMeta?.inline_keyboard_confirm != null
      ? { perMessageOverride: tapMeta.inline_keyboard_confirm }
      : {}),
    singleUse,
    ...(access.button_choice_confirmation != null
      ? { config: access.button_choice_confirmation as never }
      : {}),
    parseMode: access.parseMode ?? 'html',
    ...(sourceText != null ? { sourceText } : {}),
    ...(buttonText != null ? { label: buttonText } : {}),
    // escapeLabel deliberately omitted → defaults to the real HTML-entity
    // escaper (escapeHtmlEntities). The GFM-markdown escaper
    // (escapeHtmlForTg, #2669) is WRONG here: it doesn't escape &/</> (a
    // label containing them would 400 the HTML editMessageText) and it
    // garbles text under HTML parse mode (`Do_it` → `Do\_it`).
  })

  const warnKey = process.env.SWITCHROOM_AGENT_NAME ?? ''
  // Round-1 minor finding: a confirmation requested on a single_use:false
  // (re-tappable) keyboard can never fire. Warn once per agent-process.
  if (annotation.warnSingleUseMismatch && !deps.buttonConfirmSingleUseWarned.has(warnKey)) {
    deps.buttonConfirmSingleUseWarned.add(warnKey)
    deps.log(
      `telegram gateway: button_choice_confirmation skipped — inline_keyboard_confirm requested on a single_use:false (re-tappable) keyboard; annotation only fires on single-use keyboards (#789)\n`,
    )
  }
  // Parse-mode gate (Blocker 1): annotation is emitted with HTML. Warn once
  // per agent-process when a non-html parseMode suppresses it.
  if (annotation.warnParseMode && !deps.buttonConfirmParseModeWarned.has(warnKey)) {
    deps.buttonConfirmParseModeWarned.add(warnKey)
    deps.log(
      `telegram gateway: button_choice_confirmation skipped — agent parseMode=${access.parseMode ?? 'html'}, only 'html' supported (#789)\n`,
    )
  }

  if (annotation.annotate && cbMessageId != null) {
    // Single API call (Blocker 2): editMessageText accepts reply_markup, so
    // we annotate the body AND strip the keyboard in one edit. If the edit
    // rejects (400 on an HTML edge case, over-long body, too-old message…),
    // applyTapAnnotationEdit falls back to a keyboard-only strip so
    // single-use protection still holds — the meta is deleted below either
    // way, so a swallowed failure must not leave the keyboard live.
    await applyTapAnnotationEdit(
      {
        editMessageText: (text, other) => ctx.editMessageText(text, other),
        editMessageReplyMarkup: other => ctx.editMessageReplyMarkup(other),
      },
      annotation.text as string,
    )
    if (metaForMessage != null) {
      deps.agentButtonMeta.delete(`${cbChatId}:${cbMessageId}`)
    }
  } else if (singleUse && cbMessageId != null) {
    // No annotation (disabled, non-single-use, non-html parseMode, or no
    // body text) — preserve the historical keyboard-only strip.
    await ctx.editMessageReplyMarkup({
      reply_markup: { inline_keyboard: [] },
    }).catch(() => {})
    if (metaForMessage != null) {
      deps.agentButtonMeta.delete(`${cbChatId}:${cbMessageId}`)
    }
  }
  return true
}
