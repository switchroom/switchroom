/**
 * Persistence store for in-flight AGENT-INITIATED approval cards that park
 * the requesting agent until the operator taps: `vault_request_access`,
 * `vault_request_save`, `request_secret`, and `mental_model_propose`.
 *
 * Problem (mirror of the permission-card `permission-card-store.ts` bug): the
 * gateway holds each staged request in an in-memory Map only
 * (`pendingVaultRequestAccesses`, `pendingVaultRequestSaves`,
 * `pendingSecretRequests`, `pendingMentalModelProposes`). When the gateway
 * restarts (crash OR container restart), every entry is lost. The card in
 * Telegram keeps its live inline keyboard, so when the operator taps it later
 * they hit the "Card expired — ask the agent to re-request" tombstone: no
 * grant, no injected inbound, and the agent that ended its turn to WAIT on the
 * card stays parked forever.
 *
 * Fix: persist the METADATA for every posted card to a JSON file in STATE_DIR.
 * On each resolution (tap / TTL-expire) remove the entry. On gateway boot,
 * restore surviving entries into the in-memory maps so a post-restart tap on a
 * still-valid (unexpired) card works exactly like a pre-restart tap.
 *
 * SECRETS HYGIENE — LOAD-BEARING: this file is written to disk unencrypted.
 * It MUST NOT carry any secret VALUE. `vault_request_save` stages a secret
 * value in gateway memory; only its key/metadata is persisted here (never the
 * value), so a restored save card is re-associated with a tap but cannot
 * complete the write — the caller degrades gracefully (tells the agent the
 * value was lost to a restart). `request_secret` never holds a value at
 * staging time (the value arrives after the tap), so its metadata is safe to
 * persist. The `check-no-pii-secrets` guard and the accompanying test pin the
 * "no value field" invariant.
 *
 * File format: JSON array of PersistedApprovalCard objects. Written
 * synchronously (mode 0o600) to avoid interleaving on concurrent card posts;
 * production rate is a handful of cards, so the file stays tiny.
 */

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

/** The four agent-initiated approval-card families we persist. */
export type ApprovalCardFamily =
  | 'vault_request_access'
  | 'vault_request_save'
  | 'request_secret'
  | 'mental_model_propose'

interface BasePersistedCard {
  family: ApprovalCardFamily
  /** The staging id embedded in the card's callback_data (dedup + re-associate). */
  stageId: string
  /** Agent that requested (process.env.SWITCHROOM_AGENT_NAME). */
  agent: string
  /** Chat the card was rendered into; edited on tap / expiry. */
  chatId: string
  /** Card message id (filled after the card is sent). */
  cardMessageId?: number
  /** Forum topic the agent was working in, if any. */
  threadId?: number
  /** Unix-ms staging timestamp — the TTL clock. Preserved across restart. */
  stagedAt: number
}

export interface PersistedVaultAccessCard extends BasePersistedCard {
  family: 'vault_request_access'
  key: string
  scope: 'read' | 'write'
  reason?: string
  ttlSeconds: number
}

export interface PersistedVaultSaveCard extends BasePersistedCard {
  family: 'vault_request_save'
  key: string
  kind: 'string' | 'binary'
  why?: string
  // NOTE: NO `value` — the staged secret never touches disk.
}

export interface PersistedSecretRequestCard extends BasePersistedCard {
  family: 'request_secret'
  key: string
  reason?: string
}

export interface PersistedMentalModelCard extends BasePersistedCard {
  family: 'mental_model_propose'
  spec: {
    name: string
    source_query: string
    refresh_after_consolidation?: boolean
    max_tokens?: number
  }
  reason?: string
}

export type PersistedApprovalCard =
  | PersistedVaultAccessCard
  | PersistedVaultSaveCard
  | PersistedSecretRequestCard
  | PersistedMentalModelCard

export interface PendingCardStore {
  /** Record a newly-posted card. Idempotent on stageId (replaces in place). */
  add(entry: PersistedApprovalCard): void
  /** Remove the entry for this stageId (resolved — tap or TTL). */
  remove(stageId: string): void
  /** All persisted entries (for boot-time restore). */
  loadAll(): PersistedApprovalCard[]
  /** Delete the backing file entirely. */
  clear(): void
}

export function createPendingCardStore(stateDir: string): PendingCardStore {
  const filePath = join(stateDir, 'pending-approval-cards.json')

  function read(): PersistedApprovalCard[] {
    try {
      const raw = readFileSync(filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? (parsed as PersistedApprovalCard[]) : []
    } catch {
      return []
    }
  }

  function write(entries: PersistedApprovalCard[]): void {
    try {
      writeFileSync(filePath, JSON.stringify(entries), { encoding: 'utf-8', mode: 0o600 })
    } catch (err) {
      process.stderr.write(
        `telegram gateway: pending-card-store write failed: ${(err as Error).message}\n`,
      )
    }
  }

  return {
    add(entry) {
      const entries = read()
      const idx = entries.findIndex(e => e.stageId === entry.stageId)
      if (idx >= 0) {
        entries[idx] = entry
      } else {
        entries.push(entry)
      }
      write(entries)
    },

    remove(stageId) {
      const entries = read()
      const filtered = entries.filter(e => e.stageId !== stageId)
      if (filtered.length !== entries.length) {
        write(filtered)
      }
    },

    loadAll() {
      return read()
    },

    clear() {
      try {
        unlinkSync(filePath)
      } catch {
        // File may not exist — that's fine.
      }
    },
  }
}
