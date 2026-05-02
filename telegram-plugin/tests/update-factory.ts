/**
 * Typed factories for Telegram Update objects, used by tests that drive
 * a grammy bot via `bot.handleUpdate(update)`.
 *
 * Replaces raw-JSON update construction scattered across test files.
 * Every builder takes a small `overrides` object so tests only have to
 * specify the fields that matter for the behaviour under test; the rest
 * gets sensible realistic defaults (date, message_id sequencing, etc).
 *
 * Shapes follow https://core.telegram.org/bots/api. `as` casts to grammy
 * types are centralized here so the rest of the suite stays typed.
 */

import type { Update } from 'grammy/types'

let updateIdCounter = 1000
let messageIdCounter = 2000

export function resetUpdateCounters(updateId = 1000, messageId = 2000): void {
  updateIdCounter = updateId
  messageIdCounter = messageId
}

export interface UserLike {
  id: number
  username?: string
  first_name?: string
  is_bot?: boolean
}

export interface ChatLike {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
  title?: string
  username?: string
  is_forum?: boolean
}

const DEFAULT_USER: UserLike = { id: 777, username: 'test_user', first_name: 'Test' }
const DEFAULT_PRIVATE_CHAT: ChatLike = { id: 777, type: 'private' }
const DEFAULT_FORUM_CHAT: ChatLike = {
  id: -100123456789,
  type: 'supergroup',
  title: 'Test Forum',
  is_forum: true,
}

function nowSec(): number { return Math.floor(Date.now() / 1000) }

/** Build a text-message Update. */
export function makeMessageUpdate(opts: {
  text: string
  chat?: Partial<ChatLike>
  from?: Partial<UserLike>
  message_thread_id?: number
  is_topic_message?: boolean
  reply_to_message?: { message_id: number; from?: Partial<UserLike>; text?: string }
  entities?: Array<{ type: string; offset: number; length: number }>
  update_id?: number
  message_id?: number
}): Update {
  const chat: ChatLike = { ...DEFAULT_PRIVATE_CHAT, ...opts.chat }
  const from: UserLike = { ...DEFAULT_USER, ...opts.from }
  const message_id = opts.message_id ?? messageIdCounter++
  const update_id = opts.update_id ?? updateIdCounter++

  const reply_to_message = opts.reply_to_message
    ? {
        message_id: opts.reply_to_message.message_id,
        chat,
        from: { ...DEFAULT_USER, ...opts.reply_to_message.from },
        date: nowSec(),
        text: opts.reply_to_message.text ?? '',
      }
    : undefined

  return {
    update_id,
    message: {
      message_id,
      chat,
      from,
      date: nowSec(),
      text: opts.text,
      ...(opts.message_thread_id != null ? { message_thread_id: opts.message_thread_id } : {}),
      ...(opts.is_topic_message === true ? { is_topic_message: true } : {}),
      ...(opts.entities ? { entities: opts.entities } : {}),
      ...(reply_to_message ? { reply_to_message } : {}),
    },
  } as unknown as Update
}

/** Build a message in a forum topic. */
export function makeTopicMessageUpdate(opts: {
  text: string
  message_thread_id: number
  chat?: Partial<ChatLike>
  from?: Partial<UserLike>
}): Update {
  return makeMessageUpdate({
    ...opts,
    chat: { ...DEFAULT_FORUM_CHAT, ...opts.chat },
    is_topic_message: true,
  })
}

/** Build a callback_query Update (inline button tap). */
export function makeCallbackQueryUpdate(opts: {
  data: string
  chat?: Partial<ChatLike>
  from?: Partial<UserLike>
  inline_message_id?: string
  message_id?: number
  update_id?: number
}): Update {
  const from: UserLike = { ...DEFAULT_USER, ...opts.from }
  const chat: ChatLike = { ...DEFAULT_PRIVATE_CHAT, ...opts.chat }
  const update_id = opts.update_id ?? updateIdCounter++
  const message_id = opts.message_id ?? messageIdCounter++
  return {
    update_id,
    callback_query: {
      id: 'cbq-' + update_id,
      from,
      chat_instance: 'inst-' + update_id,
      data: opts.data,
      ...(opts.inline_message_id
        ? { inline_message_id: opts.inline_message_id }
        : {
            message: {
              message_id,
              chat,
              date: nowSec(),
              text: '',
            },
          }),
    },
  } as unknown as Update
}

/** Build a my_chat_member Update (bot added/removed). */
export function makeMyChatMemberUpdate(opts: {
  chat?: Partial<ChatLike>
  from?: Partial<UserLike>
  oldStatus?: 'left' | 'kicked' | 'member' | 'administrator' | 'creator'
  newStatus?: 'left' | 'kicked' | 'member' | 'administrator' | 'creator'
  update_id?: number
}): Update {
  const chat: ChatLike = { ...DEFAULT_FORUM_CHAT, ...opts.chat }
  const from: UserLike = { ...DEFAULT_USER, ...opts.from }
  const update_id = opts.update_id ?? updateIdCounter++
  const bot: UserLike = { id: 999, username: 'test_bot', first_name: 'TestBot', is_bot: true }
  return {
    update_id,
    my_chat_member: {
      chat,
      from,
      date: nowSec(),
      old_chat_member: {
        user: bot,
        status: opts.oldStatus ?? 'left',
      },
      new_chat_member: {
        user: bot,
        status: opts.newStatus ?? 'administrator',
      },
    },
  } as unknown as Update
}

/** Build a photo-attachment Update. */
export function makePhotoUpdate(opts: {
  caption?: string
  chat?: Partial<ChatLike>
  from?: Partial<UserLike>
  file_id?: string
  file_size?: number
}): Update {
  const chat: ChatLike = { ...DEFAULT_PRIVATE_CHAT, ...opts.chat }
  const from: UserLike = { ...DEFAULT_USER, ...opts.from }
  const update_id = updateIdCounter++
  const message_id = messageIdCounter++
  const file_id = opts.file_id ?? 'AgACAgIAAx0C-photo-' + update_id
  const file_size = opts.file_size ?? 54321
  return {
    update_id,
    message: {
      message_id,
      chat,
      from,
      date: nowSec(),
      ...(opts.caption ? { caption: opts.caption } : {}),
      photo: [
        { file_id, file_unique_id: 'unique-' + file_id, file_size, width: 800, height: 600 },
      ],
    },
  } as unknown as Update
}

/** Build an `edited_message` Update — user edits an existing message. */
export function makeEditedMessageUpdate(opts: {
  message_id: number
  text: string
  chat?: Partial<ChatLike>
  from?: Partial<UserLike>
  message_thread_id?: number
  /** Original send time. Defaults to "30 seconds ago" so edit_date > date stays plausible. */
  date?: number
  /** Edit time. Defaults to now. */
  edit_date?: number
  update_id?: number
}): Update {
  const chat: ChatLike = { ...DEFAULT_PRIVATE_CHAT, ...opts.chat }
  const from: UserLike = { ...DEFAULT_USER, ...opts.from }
  const update_id = opts.update_id ?? updateIdCounter++
  const date = opts.date ?? nowSec() - 30
  const edit_date = opts.edit_date ?? nowSec()
  return {
    update_id,
    edited_message: {
      message_id: opts.message_id,
      chat,
      from,
      date,
      edit_date,
      text: opts.text,
      ...(opts.message_thread_id != null ? { message_thread_id: opts.message_thread_id } : {}),
    },
  } as unknown as Update
}

/**
 * Build a `message_reaction` Update — a user adds/removes a reaction
 * to a message. Telegram delivers these only if the bot has reactions
 * subscribed (allowed_updates includes "message_reaction").
 *
 * Shape: `old_reaction` and `new_reaction` are arrays of ReactionType
 * objects (`{ type: 'emoji', emoji: '👍' }` for standard, or
 * `{ type: 'custom_emoji', custom_emoji_id: '...' }` for custom).
 *
 * Common usage: a user reacts with 👍 (old=[], new=[👍]) or removes
 * the reaction (old=[👍], new=[]).
 */
export function makeMessageReactionUpdate(opts: {
  message_id: number
  /** Emoji currently NOT yet on the message (transitioning to). Default: 👍. */
  newEmoji?: string | null
  /** Emoji previously on the message. Default: null (none). */
  oldEmoji?: string | null
  chat?: Partial<ChatLike>
  user?: Partial<UserLike>
  update_id?: number
}): Update {
  const chat: ChatLike = { ...DEFAULT_PRIVATE_CHAT, ...opts.chat }
  const user: UserLike = { ...DEFAULT_USER, ...opts.user }
  const update_id = opts.update_id ?? updateIdCounter++
  const oldEmoji = opts.oldEmoji ?? null
  const newEmoji = opts.newEmoji === undefined ? '👍' : opts.newEmoji
  const old_reaction = oldEmoji == null ? [] : [{ type: 'emoji', emoji: oldEmoji }]
  const new_reaction = newEmoji == null ? [] : [{ type: 'emoji', emoji: newEmoji }]
  return {
    update_id,
    message_reaction: {
      chat,
      message_id: opts.message_id,
      user,
      date: nowSec(),
      old_reaction,
      new_reaction,
    },
  } as unknown as Update
}

/** Build a document-attachment Update. */
export function makeDocumentUpdate(opts: {
  file_name: string
  mime_type?: string
  chat?: Partial<ChatLike>
  from?: Partial<UserLike>
  file_id?: string
  file_size?: number
}): Update {
  const chat: ChatLike = { ...DEFAULT_PRIVATE_CHAT, ...opts.chat }
  const from: UserLike = { ...DEFAULT_USER, ...opts.from }
  const update_id = updateIdCounter++
  const message_id = messageIdCounter++
  const file_id = opts.file_id ?? 'BQACAgIAAx0C-doc-' + update_id
  const file_size = opts.file_size ?? 1024
  return {
    update_id,
    message: {
      message_id,
      chat,
      from,
      date: nowSec(),
      document: {
        file_id,
        file_unique_id: 'unique-' + file_id,
        file_name: opts.file_name,
        mime_type: opts.mime_type ?? 'application/octet-stream',
        file_size,
      },
    },
  } as unknown as Update
}
