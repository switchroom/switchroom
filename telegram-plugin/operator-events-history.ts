/**
 * operator-events-history.ts — short-lived in-memory history of recent
 * OperatorEvents per agent, used by /status enrichment (Phase 4b).
 *
 * Design:
 *  - Keyed by agent name.
 *  - Stores the most recent event per agent.
 *  - Events expire after EVENT_TTL_MS (1 hour by default).
 *  - Zero persistence — intentionally volatile; survives gateway restarts
 *    only as long as the process lives. /status shows last event if fresh.
 */

import type { OperatorEvent } from './operator-events.js'

export const EVENT_TTL_MS = 60 * 60 * 1000 // 1 hour

interface StoredEvent {
  event: OperatorEvent
  storedAt: number
}

const store = new Map<string, StoredEvent>()

/**
 * Record the most recent OperatorEvent for an agent.
 * Overwrites any previous event for the same agent.
 */
export function recordOperatorEvent(event: OperatorEvent, now: number = Date.now()): void {
  store.set(event.agent, { event, storedAt: now })
}

/**
 * Retrieve the most recent OperatorEvent for an agent, or null if
 * none exists or the stored event has expired.
 */
export function getLastOperatorEvent(
  agent: string,
  now: number = Date.now(),
  ttlMs: number = EVENT_TTL_MS,
): OperatorEvent | null {
  const stored = store.get(agent)
  if (!stored) return null
  if (now - stored.storedAt > ttlMs) {
    store.delete(agent)
    return null
  }
  return stored.event
}

/**
 * Clear all stored events (for testing).
 */
export function clearOperatorEventHistory(): void {
  store.clear()
}

/**
 * Format a last-event line for /status display.
 * Returns an HTML string like "  last: 🔑 credentials-expired (2m ago)"
 * or null if no fresh event exists.
 */
export function formatLastEventLine(
  agent: string,
  now: number = Date.now(),
  ttlMs: number = EVENT_TTL_MS,
): string | null {
  const ev = getLastOperatorEvent(agent, now, ttlMs)
  if (!ev) return null

  const ageSec = Math.floor((now - ev.firstSeenAt.getTime()) / 1000)
  let age: string
  if (ageSec < 60) {
    age = `${ageSec}s ago`
  } else if (ageSec < 3600) {
    age = `${Math.floor(ageSec / 60)}m ago`
  } else {
    age = `${Math.floor(ageSec / 3600)}h ago`
  }

  const kindIcon = EVENT_KIND_ICON[ev.kind] ?? '⚪'
  return `  _last: ${kindIcon} ${ev.kind} (${age})_`
}

const EVENT_KIND_ICON: Record<string, string> = {
  'credentials-expired': '🔑',
  'credentials-invalid': '🔑',
  'credit-exhausted': '💳',
  'quota-exhausted': '⚠️',
  'rate-limited': '🚦',
  'agent-crashed': '💥',
  'agent-restarted-unexpectedly': '🔄',
  'unknown-4xx': '⚠️',
  'unknown-5xx': '🔥',
}
