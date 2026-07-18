/**
 * ask_user option-button callback family (`aq:<idx>:<askId>`, #574) extracted
 * verbatim from the gateway's `callback_query:data` dispatcher
 * (switchroom#2996 P6 dispatcher drain).
 *
 * A tapped option resolves the originating ask_user tool call's deferred
 * promise; the agent receives { kind: 'answered', choice, idx } as the tool
 * result and continues. Same authorization gate as permission buttons — only
 * allowFrom users can answer.
 *
 * Returns true when the callback was an ask callback (handled — dispatcher
 * must `return`), false when it isn't (dispatcher falls through). The pending
 * store and access loader are injected; ctx-methods (answerCallbackQuery /
 * editMessageText) need no raw Bot API wrapping.
 */

import type { Context } from 'grammy'
import { decodeAskCallback, type AskUserOutcome } from '../ask-user.js'
import { richMessage } from '../rich-send.js'
import { escapeHtmlForTg } from '../shared/bot-runtime.js'

export interface PendingAskUserEntry {
  options: string[]
  resolve: (outcome: AskUserOutcome) => void
  timer: ReturnType<typeof setTimeout>
}

export interface AskCallbackDeps {
  loadAccess: () => { allowFrom: string[] }
  pendingAskUser: {
    get: (id: string) => PendingAskUserEntry | undefined
    delete: (id: string) => void
  }
}

/** Handle an `aq:` callback. Returns false if `data` is not an ask callback. */
export async function handleAskCallback(
  ctx: Context,
  data: string,
  deps: AskCallbackDeps,
): Promise<boolean> {
  const askMatch = decodeAskCallback(data)
  if (askMatch == null) return false
  const accessCheck = deps.loadAccess()
  const senderId = String(ctx.from!.id)
  if (!accessCheck.allowFrom.includes(senderId)) {
    await ctx.answerCallbackQuery({ text: 'Not authorized.' }).catch(() => {})
    return true
  }
  const entry = deps.pendingAskUser.get(askMatch.askId)
  if (entry == null) {
    // Stale tap — TTL fired, prompt was cancelled, or chat closed
    // before the user got back to it. Acknowledge politely so the
    // user doesn't see the spinner stick.
    await ctx.answerCallbackQuery({ text: 'This question expired.' }).catch(() => {})
    return true
  }
  if (askMatch.idx >= entry.options.length) {
    // Encoded an out-of-bounds index — should be impossible from
    // our own encoding, but defend against a hostile callback.
    await ctx.answerCallbackQuery({ text: 'Invalid option.' }).catch(() => {})
    return true
  }
  const choice = entry.options[askMatch.idx]
  clearTimeout(entry.timer)
  deps.pendingAskUser.delete(askMatch.askId)
  entry.resolve({ kind: 'answered', choice, idx: askMatch.idx })

  // Edit the question in place to remove the buttons + show the
  // chosen option as a checkmarked line. Makes the chat surface
  // self-documenting — no orphaned-buttons graveyard.
  //
  // Escape `sourceMsg.text` before re-rendering with HTML parse
  // mode. `msg.text` returns entities-stripped plain UTF-8; an
  // agent-supplied `ask_user` question containing raw `<`/`>`/`&`
  // (common in code-related questions like "Run `<command>`?")
  // would crash the HTML re-parse, the try/catch would swallow,
  // and the button keyboard would stay tappable — the exact bug
  // PR #1158 caught on the operator-event card.
  const sourceMsg = ctx.callbackQuery?.message
  if (sourceMsg && 'text' in sourceMsg && sourceMsg.text != null) {
    try {
      await ctx.editMessageText(
        richMessage(`${escapeHtmlForTg(sourceMsg.text)}\n\n✅ **${escapeHtmlForTg(choice)}**`),
      )
    } catch {
      /* edit-failed is fine — the answer-callback below still acks */
    }
  }
  await ctx.answerCallbackQuery({ text: '✅ ' + choice.slice(0, 60) }).catch(() => {})
  return true
}
