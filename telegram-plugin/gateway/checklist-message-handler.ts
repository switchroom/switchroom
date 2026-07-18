/**
 * `checklist_tasks_done` / `checklist_tasks_added` service-message forwarding
 * (switchroom#2996 P6 cluster F).
 *
 * Telegram emits these service messages when users tick or add tasks in a
 * native checklist. They arrive as part of the `message` update type (no extra
 * `allowed_updates` config needed). We route them to the agent as a new channel
 * event with kind="checklist_task_changed" so the agent can react to user
 * actions on a checklist it sent.
 *
 * Extracted verbatim from gateway.ts (Amendment 9 — no module-global reads).
 * The two `bot.on('message:checklist_tasks_*')` registration lines stay in
 * gateway.ts (order is a load-bearing invariant) and delegate here.
 */

import type { Context } from 'grammy'
import type { InboundMessage } from './ipc-protocol.js'

type ChecklistTaskUpdate = {
  message_checklist?: {
    title?: string
    tasks?: Array<{ id?: number; text?: string; is_completed?: boolean }>
  }
  checklist_tasks_done?: Array<{ id?: number; user?: { id?: number; username?: string }; done?: boolean }>
  checklist_tasks_added?: Array<{ id?: number; text?: string; user?: { id?: number; username?: string } }>
}

export interface ChecklistHandlerDeps {
  /** Access config — only `allowFrom` is consulted (same gate as inbound). */
  loadAccess: () => { allowFrom: string[] }
  /** Broadcast a channel event to connected bridges. */
  broadcast: (msg: InboundMessage) => void
  /** stderr log sink. */
  log: (line: string) => void
}

export function handleChecklistUpdate(
  ctx: Context,
  kind: 'checklist_tasks_done' | 'checklist_tasks_added',
  deps: ChecklistHandlerDeps,
): void {
  try {
    const msg = ctx.message as (typeof ctx.message & ChecklistTaskUpdate) | undefined
    if (!msg) return

    const chat = ctx.chat
    if (!chat) return

    const chat_id = String(chat.id)
    const access = deps.loadAccess()

    // Only notify if this chat is allowlisted — same guard as inbound user messages.
    // Closes #472 finding #13. Pre-fix the `&& access.allowFrom.length > 0`
    // tail made this fail-OPEN when the allowlist was empty: every chat's
    // checklist tasks would forward to the agent. Sibling guards (the
    // inbound-message gate at line ~588 and the operator-event broadcast
    // at line ~1221) are both fail-closed for empty allowlists. The
    // empty-allowlist case is the most likely state for a misconfiguration
    // (e.g. /unpair just ran), so fail-OPEN is the worst default.
    if (!access.allowFrom.includes(chat_id)) return

    const message_id = String(msg.message_id)
    const ts = msg.date ?? Math.floor(Date.now() / 1000)

    // Extract task updates depending on service message type
    const tasksDone = msg.checklist_tasks_done ?? []
    const tasksAdded = msg.checklist_tasks_added ?? []
    const allTasks = kind === 'checklist_tasks_done' ? tasksDone : tasksAdded

    // Build per-task channel events and broadcast each to connected bridges.
    for (const task of allTasks) {
      const taskId = task.id != null ? String(task.id) : '?'
      const user = (task.user as { username?: string; id?: number } | undefined)
      const userName = user?.username ?? (user?.id != null ? String(user.id) : 'unknown')
      const state = kind === 'checklist_tasks_done'
        ? ((task as { done?: boolean }).done === false ? 'undone' : 'done')
        : 'added'

      const inboundMsg: InboundMessage = {
        type: 'inbound',
        chatId: chat_id,
        messageId: Number(message_id),
        user: userName,
        userId: user?.id ?? 0,
        ts,
        text: `(checklist task ${state}: id=${taskId})`,
        meta: {
          chat_id,
          message_id,
          kind: 'checklist_task_changed',
          task_id: taskId,
          state,
          user: userName,
          user_id: user?.id != null ? String(user.id) : '0',
          ts: new Date(ts * 1000).toISOString(),
        },
      }
      // allow-broadcast: informational checklist task notification, not turn-driving
      deps.broadcast(inboundMsg)
      deps.log(
        `telegram gateway: checklist ${kind}: chat_id=${chat_id} message_id=${message_id} task_id=${taskId} state=${state} user=${userName}\n`,
      )
    }
  } catch (err) {
    deps.log(`telegram gateway: checklist handler error (${kind}): ${err}\n`)
  }
}
