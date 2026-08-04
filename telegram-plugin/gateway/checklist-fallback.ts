/**
 * Checklist send/update with graceful degradation.
 *
 * Telegram's native `sendChecklist` / `editMessageChecklist` (Bot API 9.1)
 * are **Business-account-only**: both REQUIRE a `business_connection_id`,
 * and the payload nests `title`/`tasks` inside a single `checklist` object
 * (`InputChecklist`) whose tasks each carry a REQUIRED integer `id` and NO
 * completion flag (`InputChecklistTask = { id, text }` — a native checklist
 * cannot be pre-marked done). The original wrapper sent a FLAT
 * `{ chat_id, title, tasks: [{ text, is_completed? }] }` payload, which
 * Telegram rejected with `400: parameter "checklist" is required` — and even
 * a well-formed payload fails for ordinary bot DMs/groups (no business
 * connection), which is every chat this fleet uses.
 *
 * So the tool degrades gracefully instead of surfacing a raw 400:
 *   1. If a business connection id is configured AND the Bot API supports
 *      checklists → build the CORRECT native payload and send natively.
 *   2. Otherwise (the normal case) → render the checklist as a formatted
 *      text message (bold title + ✅/⬜ task lines — text CAN show the
 *      `done` flag) and send via the normal message path. The tool result
 *      carries `degraded: "text"` so the caller knows it is not interactive.
 *   3. A failed native attempt falls back to text rather than erroring.
 *
 * Updates work against a per-message in-memory state store (the gateway has
 * no other record of a text-rendered checklist's tasks): a patch is applied
 * to the stored state and the message is edited (natively or as text to
 * match how it was sent). State is process-local — after a gateway restart
 * an update to a pre-restart checklist returns a graceful
 * `unknown_checklist` result unless the patch itself carries a full
 * replacement (title + all task texts), never a raw Telegram error.
 *
 * Pure/deps-injected so the orchestration is unit-testable without a bot
 * (same pattern as checklist-message-handler.ts).
 */

import { parseSourceMessageId } from './source-message-id.js'

export interface ChecklistTaskState {
  /** 1-based sequential id assigned at send time (mirrors the native API's
   *  required per-task integer id; doubles as the patch handle in text mode). */
  id: number
  text: string
  done: boolean
}

export interface ChecklistState {
  title: string
  tasks: ChecklistTaskState[]
  /** How the message was actually delivered — updates must match it. */
  mode: 'native' | 'text'
}

export interface ChecklistPatchTask {
  id?: string | number
  text?: string
  done?: boolean
}

export interface ChecklistPatch {
  title?: string
  tasks?: ChecklistPatchTask[]
}

export const CHECKLIST_MAX_TASKS = 30

/** Assign sequential 1-based ids and normalize the `done` flag. */
export function buildChecklistTasks(
  tasks: ReadonlyArray<{ text: string; done?: boolean }>,
): ChecklistTaskState[] {
  if (tasks.length > CHECKLIST_MAX_TASKS) {
    throw new Error(`checklist exceeds ${CHECKLIST_MAX_TASKS}-task limit (got ${tasks.length})`)
  }
  return tasks.map((t, i) => ({ id: i + 1, text: t.text, done: t.done === true }))
}

/**
 * Render a checklist as a text message: title header + one ✅/⬜ line per
 * task. Rich (default) output is GFM markdown for `richMessage()`; pass
 * `literal: true` when the access config pins `parseMode: 'text'` (plain
 * sends, no markdown parsing) so the title doesn't ship raw asterisks.
 */
export function renderChecklistText(
  cl: { title: string; tasks: ReadonlyArray<{ text: string; done: boolean }> },
  opts?: { literal?: boolean },
): string {
  const header = opts?.literal ? cl.title : `**${cl.title}**`
  const lines = cl.tasks.map((t) => `${t.done ? '✅' : '⬜'} ${t.text}`)
  return [header, ...lines].join('\n')
}

/**
 * Apply an update_checklist patch: `title` replaces the title; a task with
 * an `id` matching an existing task updates its text/done in place; a task
 * without an `id` (or with an unknown id) is appended. Returns a NEW state
 * (input untouched). Removal is not supported by the patch shape.
 */
export function applyChecklistPatch(
  cl: { title: string; tasks: ReadonlyArray<ChecklistTaskState> },
  patch: ChecklistPatch,
): { title: string; tasks: ChecklistTaskState[] } {
  const tasks = cl.tasks.map((t) => ({ ...t }))
  for (const p of patch.tasks ?? []) {
    const pid = p.id != null ? Number(p.id) : undefined
    const existing = pid != null ? tasks.find((t) => t.id === pid) : undefined
    if (existing) {
      if (p.text != null) existing.text = p.text
      if (p.done != null) existing.done = p.done
    } else {
      const nextId = pid != null && Number.isFinite(pid)
        ? pid
        : tasks.reduce((m, t) => Math.max(m, t.id), 0) + 1
      tasks.push({ id: nextId, text: p.text ?? '', done: p.done === true })
    }
  }
  if (tasks.length > CHECKLIST_MAX_TASKS) {
    throw new Error(`checklist exceeds ${CHECKLIST_MAX_TASKS}-task limit (got ${tasks.length})`)
  }
  return { title: patch.title ?? cl.title, tasks }
}

/**
 * Build a CORRECT native `sendChecklist` payload per Bot API 9.1:
 * `business_connection_id` is required, `title`/`tasks` nest inside a single
 * `checklist` object (`InputChecklist`), each task carries its integer `id`,
 * and there is NO completion field (`InputChecklistTask` has none).
 */
export function buildNativeChecklistPayload(p: {
  businessConnectionId: string
  chatId: number
  title: string
  tasks: ReadonlyArray<ChecklistTaskState>
  replyToMessageId?: number
  protectContent?: boolean
}): Record<string, unknown> {
  // #4368 — defense at the payload boundary: a fabricated / out-of-int32
  // reply anchor is dropped here so the native checklist sends UNANCHORED
  // rather than Telegram 400ing on `reply_parameters.message_id`. Independent
  // of any caller-side guard so this builder can never emit a bad anchor.
  const replyAnchor = parseSourceMessageId(p.replyToMessageId)
  return {
    business_connection_id: p.businessConnectionId,
    chat_id: p.chatId,
    checklist: {
      title: p.title,
      tasks: p.tasks.map((t) => ({ id: t.id, text: t.text })),
    },
    ...(replyAnchor != null ? { reply_parameters: { message_id: replyAnchor } } : {}),
    ...(p.protectContent === true ? { protect_content: true } : {}),
  }
}

/**
 * Build a native `editMessageChecklist` payload. The native edit REPLACES
 * the whole checklist, so the FULL post-patch state is sent; reusing the
 * stored task ids preserves user tick state for unchanged tasks.
 */
export function buildNativeEditChecklistPayload(p: {
  businessConnectionId: string
  chatId: number
  messageId: number
  title: string
  tasks: ReadonlyArray<ChecklistTaskState>
}): Record<string, unknown> {
  return {
    business_connection_id: p.businessConnectionId,
    chat_id: p.chatId,
    message_id: p.messageId,
    checklist: {
      title: p.title,
      tasks: p.tasks.map((t) => ({ id: t.id, text: t.text })),
    },
  }
}

/** Bounded per-message checklist state store (insertion-order eviction). */
export interface ChecklistStore {
  get(key: string): ChecklistState | undefined
  set(key: string, state: ChecklistState): void
}

export function createChecklistStore(cap = 500): ChecklistStore {
  const map = new Map<string, ChecklistState>()
  return {
    get: (key) => map.get(key),
    set: (key, state) => {
      if (map.has(key)) map.delete(key) // refresh insertion order
      map.set(key, state)
      while (map.size > cap) {
        const oldest = map.keys().next().value as string | undefined
        if (oldest == null) break
        map.delete(oldest)
      }
    },
  }
}

export function checklistStoreKey(chatId: string, messageId: string | number): string {
  return `${chatId}:${messageId}`
}

// ─── Orchestration (deps-injected, unit-testable) ─────────────────────────

export interface SendChecklistDeps {
  /** Business connection id, when the operator has one configured. Native
   *  checklists are impossible without it (required API parameter). */
  businessConnectionId: string | undefined
  /** Boot-probe result: the connected grammY/Bot API exposes sendChecklist. */
  nativeAvailable: boolean
  sendNative: (payload: Record<string, unknown>) => Promise<{ message_id: number }>
  sendText: (text: string) => Promise<{ message_id: number }>
  /** access.parseMode === 'text' — render without markdown. */
  literalText: boolean
  log: (line: string) => void
}

export interface SendChecklistResult {
  message_id: number
  mode: 'native' | 'text'
  state: ChecklistState
}

/**
 * Send a checklist: natively when possible, degrading to a formatted text
 * message otherwise. NEVER lets a native-send failure escape — the fallback
 * is the text render. (A text-send failure still throws: there is nothing
 * further to degrade to, and the caller's normal error path applies.)
 */
export async function performSendChecklist(
  deps: SendChecklistDeps,
  args: {
    title: string
    tasks: ReadonlyArray<{ text: string; done?: boolean }>
    chatId: number
    replyToMessageId?: number
    protectContent?: boolean
  },
): Promise<SendChecklistResult> {
  const tasks = buildChecklistTasks(args.tasks)
  if (deps.nativeAvailable && deps.businessConnectionId) {
    try {
      const sent = await deps.sendNative(buildNativeChecklistPayload({
        businessConnectionId: deps.businessConnectionId,
        chatId: args.chatId,
        title: args.title,
        tasks,
        replyToMessageId: args.replyToMessageId,
        protectContent: args.protectContent,
      }))
      return {
        message_id: sent.message_id,
        mode: 'native',
        state: { title: args.title, tasks, mode: 'native' },
      }
    } catch (err) {
      deps.log(`native sendChecklist failed — falling back to text render: ${err}\n`)
    }
  }
  const text = renderChecklistText({ title: args.title, tasks }, { literal: deps.literalText })
  const sent = await deps.sendText(text)
  return {
    message_id: sent.message_id,
    mode: 'text',
    state: { title: args.title, tasks, mode: 'text' },
  }
}

/** Tool-result text for send_checklist. The degraded shape carries
 *  `degraded: "text"` + a note so the calling agent knows the checklist is a
 *  formatted message, not a natively tickable one. */
export function sendChecklistToolText(r: SendChecklistResult): string {
  return JSON.stringify(
    r.mode === 'native'
      ? { ok: true, message_id: r.message_id, mode: 'native' }
      : {
          ok: true,
          message_id: r.message_id,
          mode: 'text',
          degraded: 'text',
          note: 'rendered as a formatted text message (native Telegram checklists require a Business connection) — tasks are not tappable; use update_checklist with task ids 1..N to tick them',
        },
  )
}

export interface UpdateChecklistDeps {
  /** Stored state for this chat:message, if the gateway still has it. */
  state: ChecklistState | undefined
  businessConnectionId: string | undefined
  nativeAvailable: boolean
  editNative: (payload: Record<string, unknown>) => Promise<void>
  editText: (text: string) => Promise<void>
  literalText: boolean
  log: (line: string) => void
  chatId: number
  messageId: number
}

export type UpdateChecklistResult =
  | { ok: true; mode: 'native' | 'text'; state: ChecklistState }
  | { ok: false; reason: 'unknown_checklist' | 'edit_failed'; hint: string }

/**
 * Update a checklist message. Applies the patch to the stored state and
 * re-renders in the mode the message was originally sent in. Failures come
 * back as structured `{ ok: false, reason, hint }` results — never a raw
 * Telegram error thrown at the caller.
 */
export async function performUpdateChecklist(
  deps: UpdateChecklistDeps,
  patch: ChecklistPatch,
): Promise<UpdateChecklistResult> {
  let base = deps.state
  if (!base) {
    // State lost (gateway restart / evicted). If the patch is a full
    // replacement — a title plus tasks that all carry text — we can rebuild
    // and edit as text (the fleet-normal mode). Otherwise we cannot know
    // the existing tasks; degrade gracefully.
    const fullReplacement =
      patch.title != null &&
      (patch.tasks?.length ?? 0) > 0 &&
      (patch.tasks ?? []).every((t) => t.text != null)
    if (!fullReplacement) {
      return {
        ok: false,
        reason: 'unknown_checklist',
        hint: 'no stored state for this checklist (gateway restarted?). Re-send it with send_checklist, or pass a full replacement (title + every task\'s text) to update_checklist.',
      }
    }
    base = { title: patch.title!, tasks: [], mode: 'text' }
  }
  let next: { title: string; tasks: ChecklistTaskState[] }
  try {
    next = applyChecklistPatch(base, patch)
  } catch (err) {
    return { ok: false, reason: 'edit_failed', hint: String(err) }
  }
  const state: ChecklistState = { title: next.title, tasks: next.tasks, mode: base.mode }
  if (base.mode === 'native') {
    // A native checklist message cannot be edited into plain text — there is
    // no text fallback here; a failure surfaces as a structured result.
    if (!deps.nativeAvailable || !deps.businessConnectionId) {
      return {
        ok: false,
        reason: 'edit_failed',
        hint: 'this checklist was sent natively but the business connection / checklist API is no longer available.',
      }
    }
    try {
      await deps.editNative(buildNativeEditChecklistPayload({
        businessConnectionId: deps.businessConnectionId,
        chatId: deps.chatId,
        messageId: deps.messageId,
        title: state.title,
        tasks: state.tasks,
      }))
      return { ok: true, mode: 'native', state }
    } catch (err) {
      deps.log(`native editMessageChecklist failed: ${err}\n`)
      return { ok: false, reason: 'edit_failed', hint: String(err) }
    }
  }
  try {
    await deps.editText(renderChecklistText(state, { literal: deps.literalText }))
    return { ok: true, mode: 'text', state }
  } catch (err) {
    deps.log(`checklist text edit failed: ${err}\n`)
    return { ok: false, reason: 'edit_failed', hint: String(err) }
  }
}

/** Tool-result text for update_checklist — structured for both outcomes. */
export function updateChecklistToolText(r: UpdateChecklistResult, messageId: number): string {
  return JSON.stringify(
    r.ok
      ? { ok: true, message_id: messageId, mode: r.mode, ...(r.mode === 'text' ? { degraded: 'text' } : {}) }
      : { ok: false, reason: r.reason, hint: r.hint },
  )
}
