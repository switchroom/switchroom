/**
 * Cross-reboot persistence for the boot card's Telegram message id.
 *
 * Why: a freshly *sent* Telegram message always bumps the chat's unread
 * badge — `disable_notification: true` removes the sound/banner but not the
 * badge (there is no Bot API flag for that). To make routine reboots produce
 * ZERO notification (operator request, 2026-06-03), the gateway reuses the
 * PRIOR boot card's message and EDITS it in place instead of sending a new
 * one — and edits never touch the badge.
 *
 * That requires remembering the last boot card's `message_id` across gateway
 * restarts, keyed by the chat (+ forum topic) it lives in. This module is the
 * tiny JSON store for that, mirroring `config-snapshot.ts` /
 * `boot-issue-cache.ts`: one file under the agent's (bind-mounted, reboot-
 * surviving) state dir, read once on boot, written once after the id is
 * established. All failures are non-fatal — a missing/corrupt file just means
 * "no prior card", so the boot path falls back to a fresh (silent) send.
 */

import { readFileSync, writeFileSync } from 'node:fs'

/** Stable key for a boot-card target: chat id + optional forum topic. A DM
 *  agent always boots to the same `<chatId>:` key; a supergroup agent keys by
 *  `<chatId>:<threadId>` so a topic change starts a fresh card. */
export function bootCardChatKey(chatId: string, threadId: number | undefined): string {
  return `${chatId}:${threadId ?? ''}`
}

type Store = Record<string, number>

function readStore(path: string): Store {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Store
    }
  } catch {
    /* missing / corrupt → treat as empty */
  }
  return {}
}

/** The persisted message id for this chat+topic, or null when there's no
 *  prior boot card to reuse (first boot, corrupt file, different chat). */
export function loadBootCardMsgId(
  path: string,
  chatKey: string,
): number | null {
  const id = readStore(path)[chatKey]
  return typeof id === 'number' && Number.isFinite(id) && id > 0 ? id : null
}

/** Record the current boot card's message id for this chat+topic. Merges into
 *  the existing store (other chats' ids survive). Non-fatal on write failure —
 *  the worst case is the next reboot sends a fresh card (one badge). */
export function saveBootCardMsgId(
  path: string,
  chatKey: string,
  messageId: number,
): void {
  if (!(Number.isFinite(messageId) && messageId > 0)) return
  try {
    const store = readStore(path)
    if (store[chatKey] === messageId) return // idempotent — no rewrite
    store[chatKey] = messageId
    writeFileSync(path, JSON.stringify(store), 'utf8')
  } catch {
    /* non-fatal */
  }
}
