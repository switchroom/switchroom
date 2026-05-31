// Problem B — deferred safe-boundary interrupt.
//
// A `!`-prefix interrupt SIGINTs the agent's in-flight turn (tmux C-c) and
// then resumes with the replacement body as a fresh turn. Firing the SIGINT
// the instant `!` arrives can land mid-tool-call — a C-c during a Write or a
// Bash leaves the tool's work half-done. `reference/steer-or-queue-mid-flight.md`
// names this exact anti-pattern: "Mid-tool-call is not 'amend time.'"
//
// We can't pause claude's internal loop (the unmodified-CLI constraint — the
// only levers are SIGINT via tmux and observing the session JSONL). But we CAN
// observe when a tool call starts and finishes, and defer the SIGINT to the
// next clean boundary. This module is the pure, deterministic core of that
// decision so it can be unit-tested without the gateway's IPC / timers.

/** The session-event shape this tracker cares about. A structural subset of
 *  the gateway's `SessionEvent` so tests don't need the full union. */
export interface FlightEvent {
  kind: string
  toolUseId?: string | null
}

/**
 * Tracks top-level tool calls in flight for the CURRENT turn, keyed by
 * toolUseId. A `tool_use` adds; its matching `tool_result` removes; a
 * `turn_end` or a fresh `enqueue` clears the slate (a new turn starts clean,
 * and a killed turn may never emit the trailing `tool_result`).
 *
 * Sub-agent events (`sub_agent_*`) are intentionally ignored: the parent's
 * `Task` tool_use already sits in the set and represents the user-observable
 * wait, so the sub-agent's own tool calls don't independently gate the
 * boundary. Telegram-surface tools are NOT excluded — treating every in-flight
 * tool as "unsafe to C-c" is the conservative call, and the max-wait bound
 * keeps a stuck reply tool from stranding the interrupt.
 */
export class ToolFlightTracker {
  private readonly inFlight = new Set<string>()

  onEvent(ev: FlightEvent): void {
    switch (ev.kind) {
      case 'tool_use':
        if (typeof ev.toolUseId === 'string' && ev.toolUseId.length > 0) {
          this.inFlight.add(ev.toolUseId)
        }
        break
      case 'tool_result':
        if (typeof ev.toolUseId === 'string' && ev.toolUseId.length > 0) {
          this.inFlight.delete(ev.toolUseId)
        }
        break
      case 'turn_end':
      case 'enqueue':
        this.inFlight.clear()
        break
      // dequeue / thinking / text / tool_label / sub_agent_* — no effect.
      default:
        break
    }
  }

  /** True when at least one top-level tool call is open (unsafe boundary). */
  isMidToolCall(): boolean {
    return this.inFlight.size > 0
  }

  /** Count of in-flight tool calls — exposed for diagnostics/logging. */
  inFlightCount(): number {
    return this.inFlight.size
  }

  clear(): void {
    this.inFlight.clear()
  }
}

export type InterruptTiming = 'fire-now' | 'defer'

/**
 * Decide whether a `!` interrupt should fire immediately or wait for a safe
 * boundary. Pure: the gateway feeds the live flag + tracker reading.
 *
 *  - flag off                  → fire-now (historical synchronous behaviour)
 *  - flag on, no tool in flight → fire-now (already at a clean boundary)
 *  - flag on, tool in flight    → defer (wait for tool_result / turn_end)
 */
export function decideInterruptTiming(opts: {
  safeBoundaryEnabled: boolean
  midToolCall: boolean
}): InterruptTiming {
  if (!opts.safeBoundaryEnabled) return 'fire-now'
  return opts.midToolCall ? 'defer' : 'fire-now'
}

/** Floor for the deferred-interrupt max-wait. A non-positive or absent config
 *  value falls back to the default; we never wait forever. */
export const DEFAULT_INTERRUPT_MAX_WAIT_MS = 8000

export function resolveInterruptMaxWaitMs(configured: number | undefined): number {
  if (typeof configured === 'number' && configured > 0) return configured
  return DEFAULT_INTERRUPT_MAX_WAIT_MS
}
