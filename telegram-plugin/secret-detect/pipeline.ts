/**
 * High-level orchestrator: take an inbound user text, run the detector,
 * decide per-detection whether to auto-store or stage as ambiguous, rewrite
 * the prompt so Claude never sees raw bytes, and emit audit events.
 *
 * Pure of side effects *except* the injected vault-write function — keeping
 * the real child-process spawn out of the hot path keeps this unit-testable
 * and lets us stub it from server.ts.
 *
 * The vault passphrase must already be resolved by the caller (via the
 * plugin's existing `vaultPassphraseCache`). If the cache is empty, this
 * returns early with `needs_passphrase=true` — the caller prompts the user
 * and re-invokes.
 */
import { detectSecrets, type Detection } from './index.js'
import { rewritePrompt, type RewriteTarget } from './rewrite.js'
import { deriveSlug } from './slug.js'
import { emitAudit } from './audit.js'
import { maskToken } from './mask.js'
import type { VaultWriteFn, VaultListFn } from './vault-write.js'

export interface PipelineInputs {
  chat_id: string
  message_id: number | null
  text: string
  passphrase: string
  vaultWrite: VaultWriteFn
  vaultList: VaultListFn
}

export interface ConfirmedStore {
  detection: Detection
  actual_slug: string
  masked: string
}

export interface PipelineResult {
  /** The rewritten text — this is what Claude sees. Equals input when no confirmed hits. */
  rewritten_text: string
  /** Confirmed stores (high-confidence, not suppressed) that were written to the vault. */
  stored: ConfirmedStore[]
  /** Ambiguous hits (entropy-only, or suppressed) requiring user confirmation. */
  ambiguous: Detection[]
  /** Failed stores — detection found but vault write failed. Caller should surface. */
  failed: Array<{ detection: Detection; error: string }>
}

export function runPipeline(inputs: PipelineInputs): PipelineResult {
  const { chat_id, message_id, text, passphrase, vaultWrite, vaultList } = inputs

  const detections = detectSecrets(text)
  if (detections.length === 0) {
    return { rewritten_text: text, stored: [], ambiguous: [], failed: [] }
  }

  // Separate confirmed (high + !suppressed) from ambiguous.
  const confirmed: Detection[] = []
  const ambiguous: Detection[] = []
  for (const d of detections) {
    if (d.confidence === 'high' && !d.suppressed) {
      confirmed.push(d)
    } else {
      ambiguous.push(d)
    }
  }

  if (confirmed.length === 0) {
    // All ambiguous — log them and return; caller stages.
    for (const d of ambiguous) {
      emitAudit({
        chat_id,
        message_id,
        rule_id: d.rule_id,
        slug: d.suggested_slug,
        action: 'ambiguous',
        delete_ok: false,
      })
    }
    return { rewritten_text: text, stored: [], ambiguous, failed: [] }
  }

  // Read the current vault key set ONCE so we can resolve collisions
  // across multiple hits in the same message.
  const listResult = vaultList(passphrase)
  const existing = new Set(listResult.ok ? listResult.keys : [])

  const stored: ConfirmedStore[] = []
  const failed: Array<{ detection: Detection; error: string }> = []

  for (const d of confirmed) {
    const actual_slug = deriveSlug(
      { key_name: d.key_name, rule_id: d.rule_id },
      existing,
    )
    const writeResult = vaultWrite(actual_slug, d.matched_text, passphrase)
    if (!writeResult.ok) {
      failed.push({ detection: d, error: writeResult.output })
      emitAudit({
        chat_id,
        message_id,
        rule_id: d.rule_id,
        slug: actual_slug,
        action: 'failed',
        delete_ok: false,
        detail: writeResult.output.slice(0, 200),
      })
      continue
    }
    existing.add(actual_slug)
    stored.push({
      detection: d,
      actual_slug,
      masked: maskToken(d.matched_text),
    })
    emitAudit({
      chat_id,
      message_id,
      rule_id: d.rule_id,
      slug: actual_slug,
      action: 'stored',
      delete_ok: false, // caller updates after Telegram deleteMessage
    })
  }

  // Also log ambiguous entries that co-occurred with confirmed ones.
  for (const d of ambiguous) {
    emitAudit({
      chat_id,
      message_id,
      rule_id: d.rule_id,
      slug: d.suggested_slug,
      action: d.suppressed ? 'suppressed' : 'ambiguous',
      delete_ok: false,
    })
  }

  const targets: RewriteTarget[] = stored.map((s) => ({
    detection: s.detection,
    actual_slug: s.actual_slug,
  }))
  const rewritten_text = rewritePrompt(text, targets)

  return { rewritten_text, stored, ambiguous, failed }
}
