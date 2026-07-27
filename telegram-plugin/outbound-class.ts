/**
 * Outbound priority class, propagated to the grammY transformer stack.
 *
 * ── Why this module exists ────────────────────────────────────────────────
 * The send gate (`send-gate.ts`) knows every outbound call's `priorityClass`
 * — `cosmetic` (a repaint of a progress card), `useful`, or `critical` (the
 * operator's actual answer). The edit-flood fuse (`edit-flood-fuse.ts`) is a
 * grammY API transformer, and a transformer sees only `(method, payload)`.
 * It therefore could NOT tell a liveness repaint apart from a reply, and had
 * to treat every edit identically.
 *
 * That blindness is the core defect behind the 2026-07-27 incident: agent
 * `overlord` sustained ~17 activity-card edits/min for hours, earned a
 * 15908-second (4.4h) per-chat flood ban, and the ban took out ALL replies.
 * The fuse's per-chat edit ceiling at the time was 30/60s, so it never bound
 * — a purely cosmetic surface was allowed to consume the whole chat's real
 * Telegram budget, and the answer path paid for it.
 *
 * A class-aware fuse can do the two things a class-blind one cannot:
 *   1. hold COSMETIC traffic to a rate far below Telegram's per-chat ceiling,
 *      without throttling approval cards or answers; and
 *   2. RESERVE part of the per-chat budget so a reply is never starved by
 *      repaints.
 *
 * ── Why AsyncLocalStorage ─────────────────────────────────────────────────
 * The class must travel from the send gate (well above grammY) down to the
 * transformer, through an arbitrary async chain, WITHOUT smuggling a
 * non-Bot-API field into the outbound payload. `AsyncLocalStorage` is the
 * Node-native mechanism for exactly that, and the plugin already uses the
 * same pattern for `tg-post` log tags (`shared/bot-runtime.ts`).
 *
 * This module deliberately has NO imports beyond `async_hooks`: both
 * `send-gate.ts` (the writer) and `edit-flood-fuse.ts` (the reader) import
 * it, so anything heavier would create an import cycle.
 */

import { AsyncLocalStorage } from 'async_hooks'

/**
 * Mirrors `send-gate.ts`'s `PriorityClass`. Declared here rather than
 * imported so this module stays dependency-free (see the docblock); the
 * send gate's `PriorityClass` is assignable to it and a compile-time
 * assertion in `send-gate.ts` keeps the two in lockstep.
 */
export type OutboundClass = 'critical' | 'useful' | 'cosmetic'

const store = new AsyncLocalStorage<OutboundClass>()

/**
 * Run `fn` with `cls` visible to every Telegram API call it makes, including
 * across awaits. The send gate wraps each admitted call in this.
 */
export function withOutboundClass<T>(cls: OutboundClass, fn: () => T): T {
  return store.run(cls, fn)
}

/** The class of the call currently in flight, or undefined when untagged. */
export function currentOutboundClass(): OutboundClass | undefined {
  return store.getStore()
}

/**
 * The class the fuse assigns to a call that arrived with no tag.
 *
 * Asymmetric ON PURPOSE:
 *
 *   - an untagged EDIT is treated as `cosmetic`. An edit that never went
 *     through the send gate is, by construction, exactly the shape of the
 *     incident (the activity card edited one message id with no key and no
 *     class). Defaulting it to cosmetic means a NEW unkeyed edit call site
 *     is rate-limited by default instead of being invisible until it earns
 *     a ban. Dropping a repaint is free — the next render carries full
 *     state.
 *   - an untagged SEND is treated as `critical`, matching the send gate's
 *     own `UNTAGGED_SEND_CLASS`. Sends create user-visible output and are
 *     never dropped by the fuse; the conservative default here is the one
 *     that cannot lose an answer.
 */
export function defaultOutboundClass(isEdit: boolean): OutboundClass {
  return isEdit ? 'cosmetic' : 'critical'
}
