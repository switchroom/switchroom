/**
 * Bridge-side outstanding permission-request ledger (#2861 / umbrella #2859).
 *
 * Problem it closes (R2): the bridge's `permission_request` handler used to
 * DROP the request when the gateway IPC was down
 * (`if (!ipc || !ipc.isConnected()) { log; return }`). claude stays suspended
 * inside the MCP permission call, no card is ever posted, the turn wedges
 * forever. There was no record of the ask to re-send once the gateway came
 * back.
 *
 * Fix: every `permission_request` notification from claude is recorded here,
 * keyed by request_id. When the IPC (re)connects, the bridge re-sends every
 * outstanding request (the gateway dedupes / re-arms them idempotently — see
 * `gateway/permission-rearm.ts`). An entry is deleted the moment a verdict is
 * delivered back to claude (`onPermission`), so a resolved request is never
 * re-sent.
 *
 * This never answers a card — it only re-transmits the QUESTION
 * (no-self-escalation invariant). Pure in-memory bookkeeping: no model
 * callsite, no I/O.
 */

/** The claude-side `permission_request` params the bridge forwards. */
export interface OutstandingPermissionParams {
  request_id: string
  tool_name: string
  description: string
  input_preview: string
}

export interface OutstandingPermissionLedger {
  /** Record a request. Idempotent on request_id (latest params win). */
  add(params: OutstandingPermissionParams): void
  /** Remove a request once its verdict has been delivered. */
  delete(requestId: string): void
  has(requestId: string): boolean
  /** Snapshot of all outstanding requests (insertion order). */
  all(): OutstandingPermissionParams[]
  readonly size: number
}

export function createOutstandingPermissionLedger(): OutstandingPermissionLedger {
  const map = new Map<string, OutstandingPermissionParams>()
  return {
    add(params) {
      map.set(params.request_id, params)
    },
    delete(requestId) {
      map.delete(requestId)
    },
    has(requestId) {
      return map.has(requestId)
    },
    all() {
      return [...map.values()]
    },
    get size() {
      return map.size
    },
  }
}
