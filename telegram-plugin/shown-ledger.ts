/**
 * shown-ledger.ts — the durable "this block was surfaced on the ephemeral
 * progress card, never deliver it to chat" mark (switchroom#3513 §4).
 *
 * ## Role in the single-surface invariant
 * Every trailing plain-text block a turn produces is assigned to exactly one
 * surface: the delivered chat answer, the ephemeral progress card, or
 * suppression. In-process (E1/E2 turn-flush, the card) that assignment is made
 * once by the shared structural classifier (`hooks/narration-classify.mjs`).
 * But the out-of-process backstops — the Stop-hook captured-prose bridge (E3)
 * and the durable outbox heartbeat sweep (E4) — run in a separate process / on
 * a later tick and cannot share an in-memory decision. So the component that
 * paints a block as ephemeral narration appends `{turnNonce, hash}` here, and
 * E3/E4 treat a ledger hit exactly like a silent marker: not deliverable.
 *
 * ## Correction 4 — only structural narration is ever marked
 * The writer (the mid-turn narrative paint in `gateway/narrative-lane.ts`) marks
 * ONLY blocks that are provably followed by more turn activity (a new narrative
 * block or a tool call), i.e. structural narration — NEVER a possibly-terminal
 * block (the timer-paint / turn-end paint that could turn out to be the real
 * answer). This keeps the invariant fail-open for answers: a genuine unsent
 * answer is never in the ledger, so a ledger check can never suppress it (a drop
 * is worse than a duplicate). The structural rule, not the ledger, is the sole
 * guard for the answer path.
 *
 * ## Envelope-bearing-only (documented should-fix, #3513 §8)
 * The ledger is keyed by the turnNonce (`deriveTurnId` → `${chatKey}#${msgId}`),
 * which is reachable-matching ONLY for envelope-bearing turns — `deriveTurnId`
 * returns null without a message_id (`gateway/derive-turn-id.ts`), and the
 * outbox falls back to a sha nonce. So the ledger is a best-effort belt for
 * envelope-bearing turns (the common Telegram-inbound shape); for envelope-less
 * turns (handback / background / cron) the structural classifier is the sole
 * guard. The writer skips a null turnId; the readers simply miss and fall
 * through to the structural rule — never a false suppression.
 *
 * Best-effort throughout: a missing / unwritable ledger degrades to the
 * structural-rule-only behaviour (leak possible, drop impossible).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  appendFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { resolveOutboxDir } from './outbox.js'
import { ledgerHashHex } from './hooks/narration-classify.mjs'

const SHOWN_LEDGER_FILE = 'shown-ledger.jsonl'

/** Bounded growth — compact to the newest KEEP entries past ROTATE_AT lines. */
export const SHOWN_LEDGER_KEEP = 2_000
export const SHOWN_LEDGER_ROTATE_AT = 4_000

/** One appended shown-block entry. */
export interface ShownLedgerEntry {
  turnNonce: string
  hash: string
  ts: number
}

export function shownLedgerPath(stateDir?: string): string {
  return join(resolveOutboxDir(stateDir), SHOWN_LEDGER_FILE)
}

/**
 * Mark a block as ephemeral-shown for `turnNonce`. Correction 4: callers MUST
 * only pass blocks that are structural narration (followed by more turn
 * activity), never a possibly-terminal block. A null/empty turnNonce is ignored
 * (envelope-less turn — the structural rule is the sole guard there).
 * Best-effort; never throws.
 */
export function appendShownBlock(
  turnNonce: string | null,
  text: string,
  stateDir?: string,
  now: number = Date.now(),
): void {
  if (turnNonce == null || turnNonce === '') return
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed.length === 0) return
  const dir = resolveOutboxDir(stateDir)
  const path = shownLedgerPath(stateDir)
  try {
    mkdirSync(dir, { recursive: true })
    const entry: ShownLedgerEntry = { turnNonce, hash: ledgerHashHex(trimmed), ts: now }
    appendFileSync(path, JSON.stringify(entry) + '\n', { mode: 0o600 })
    compactIfLarge(path)
  } catch {
    /* best-effort */
  }
}

/** The set of block hashes marked ephemeral-shown for `turnNonce`. */
export function readShownHashes(turnNonce: string | null, stateDir?: string): Set<string> {
  const set = new Set<string>()
  if (turnNonce == null || turnNonce === '') return set
  const path = shownLedgerPath(stateDir)
  if (!existsSync(path)) return set
  try {
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      if (!line) continue
      try {
        const e = JSON.parse(line) as ShownLedgerEntry
        if (e.turnNonce === turnNonce && typeof e.hash === 'string') set.add(e.hash)
      } catch {
        /* skip corrupt line */
      }
    }
  } catch {
    /* best-effort */
  }
  return set
}

/**
 * Was `text` marked ephemeral-shown for `turnNonce`? The out-of-process
 * suppression check consumed by the E3 captured-prose decision and the E4 sweep.
 */
export function isShownBlock(
  turnNonce: string | null,
  text: string,
  stateDir?: string,
): boolean {
  if (turnNonce == null || turnNonce === '') return false
  const trimmed = typeof text === 'string' ? text.trim() : ''
  if (trimmed.length === 0) return false
  return readShownHashes(turnNonce, stateDir).has(ledgerHashHex(trimmed))
}

function compactIfLarge(path: string): void {
  try {
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.length > 0)
    if (lines.length <= SHOWN_LEDGER_ROTATE_AT) return
    const kept = lines.slice(lines.length - SHOWN_LEDGER_KEEP)
    const tmp = `${path}.${process.pid}.compact`
    writeFileSync(tmp, kept.join('\n') + '\n', { mode: 0o600 })
    renameSync(tmp, path)
  } catch {
    /* best-effort */
  }
}
