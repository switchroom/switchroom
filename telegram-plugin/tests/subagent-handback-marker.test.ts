/**
 * Unit coverage for the per-chat/thread subagent-handback marker
 * (fix/backstop-duplicate-reply; thread-keying — dup-audit F2 2026-07-21). The
 * marker is the deterministic signal the supersede path uses to tell a flushed
 * turn's OWN reworded late reply (no handback in flight → supersede) from a
 * background handback attributed to that ended turn (handback in flight → keep
 * the #3429 content gate).
 */

import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  SubagentHandbackMarker,
  stampsHandbackMarker,
  INBOUND_SOURCE_CLASSIFICATION,
} from '../gateway/subagent-handback-marker.js'

describe('SubagentHandbackMarker', () => {
  it('returns null for a chat with no recorded handback', () => {
    const m = new SubagentHandbackMarker()
    expect(m.lastAt('chatA', undefined)).toBe(null)
  })

  it('returns the recorded enqueue ts for the chat', () => {
    const m = new SubagentHandbackMarker()
    m.record('chatA', undefined, 1_000_000)
    expect(m.lastAt('chatA', undefined)).toBe(1_000_000)
  })

  it('is per-chat — one chat never leaks into another', () => {
    const m = new SubagentHandbackMarker()
    m.record('chatA', undefined, 1_000_000)
    expect(m.lastAt('chatB', undefined)).toBe(null)
  })

  it('keeps only the MOST RECENT enqueue (overwrites)', () => {
    const m = new SubagentHandbackMarker()
    m.record('chatA', undefined, 1_000_000)
    m.record('chatA', undefined, 1_050_000)
    expect(m.lastAt('chatA', undefined)).toBe(1_050_000)
  })

  // ── F2: thread-keying (dup-audit 2026-07-21) ────────────────────────────
  it('is per-THREAD — a handback in topic A does not leak into topic B', () => {
    const m = new SubagentHandbackMarker()
    m.record('chatA', 111, 1_000_000)
    // Same chat, different topic → no marker: topic B's CASE-A collapse is
    // untouched by topic A's handback (the visible-dup gap F2 closed).
    expect(m.lastAt('chatA', 222)).toBe(null)
    expect(m.lastAt('chatA', 111)).toBe(1_000_000)
  })

  it('a thread handback does not leak into the DM (no-thread) lane of the same chat', () => {
    const m = new SubagentHandbackMarker()
    m.record('chatA', 111, 1_000_000)
    expect(m.lastAt('chatA', undefined)).toBe(null)
  })

  it('the no-thread lane keys identically to the supersede registry (chat only)', () => {
    const m = new SubagentHandbackMarker()
    m.record('chatA', undefined, 1_000_000)
    // A later thread read must NOT see the DM stamp, and vice-versa.
    expect(m.lastAt('chatA', undefined)).toBe(1_000_000)
    expect(m.lastAt('chatA', 111)).toBe(null)
  })

  // ── MUST-FIX 2 (dup-audit / Fable): chat-wide gate read ─────────────────
  it('lastAtInChat returns the MOST RECENT handback across ALL topics of a chat', () => {
    const m = new SubagentHandbackMarker()
    m.record('chatA', 111, 1_000)
    m.record('chatA', 222, 3_000)
    m.record('chatA', undefined, 2_000)
    expect(m.lastAtInChat('chatA')).toBe(3_000)
    expect(m.lastAtInChat('chatB')).toBe(null)
  })

  it('lastAtInChat makes the gate un-steerable: a topic-A stamp is seen chat-wide ' +
    'even when a thread-specific read of topic B would miss it', () => {
    const m = new SubagentHandbackMarker()
    m.record('chatA', 111, 5_000)
    // The content gate reads chat-wide → sees topic A's handback…
    expect(m.lastAtInChat('chatA')).toBe(5_000)
    // …whereas a thread-specific read of topic 222 (the F2 regression) missed it,
    // which is exactly how a steered `message_thread_id` bypassed the gate.
    expect(m.lastAt('chatA', 222)).toBe(null)
  })
})

// ── MUST-FIX 3 (dup-audit / Fable): fail-safe classification + exhaustiveness ──
describe('inbound source classification (F1 durability)', () => {
  it('stampsHandbackMarker: subagent_handback stamps; other known sources do not', () => {
    expect(stampsHandbackMarker('subagent_handback')).toBe(true)
    expect(stampsHandbackMarker('cron')).toBe(false)
    expect(stampsHandbackMarker('reaction')).toBe(false)
    expect(stampsHandbackMarker('resume_interrupted')).toBe(false)
    expect(stampsHandbackMarker('vault_grant_approved')).toBe(false)
    // #4662 — the eval-case outcome inbounds. The exhaustiveness test below pins
    // only their PRESENCE in the registry; these pin the VALUE, which is the part
    // with runtime consequence: classified `true` (or left to the fail-safe
    // default) they would hold the content gate chat-wide for 60 s after every
    // operator tap on an eval-case card.
    expect(stampsHandbackMarker('eval_case_applied')).toBe(false)
    expect(stampsHandbackMarker('eval_case_rejected')).toBe(false)
    expect(stampsHandbackMarker('eval_case_apply_failed')).toBe(false)
  })

  it('a normal user inbound (no meta.source) never stamps', () => {
    expect(stampsHandbackMarker(null)).toBe(false)
    expect(stampsHandbackMarker(undefined)).toBe(false)
  })

  it('FAIL-SAFE default: an UNKNOWN synthesized source STAMPS (visible dup, never ' +
    'silent edit-over)', () => {
    // The unsafe old default (deny → no stamp → bypass eligible → silent loss)
    // is inverted: an unclassified future decoupled source keeps the content gate.
    expect(stampsHandbackMarker('some_future_decoupled_source')).toBe(true)
    expect(stampsHandbackMarker('another_unclassified_source')).toBe(true)
  })

  // The real tripwire: scan the gateway for meta.source literals and FAIL when a
  // new one is added without a registry classification. The grep-the-predicate
  // structural test could not catch rot; this does.
  it('exhaustiveness: every gateway-inbound meta.source literal is classified in the registry', () => {
    const gatewayDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'gateway')
    const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
    // `source:` fields that are NOT inbound meta.source tags (config cascade, the
    // model-source selector, doc comments, typeof guards). Allowlisted so a
    // genuinely new INBOUND source still trips this guard.
    const NON_INBOUND_SOURCE_LITERALS = new Set([
      'env', 'config', 'default', 'transcript', 'override', 'gateway', 'cli', 'string', 'github',
    ])
    // The scan surface = every gateway module PLUS the out-of-gateway inbound
    // builders whose synthesized inbounds are delivered THROUGH the gateway
    // (dup-audit pass-2 / Fable): `src/web/webhook-dispatch.ts` builds the
    // `webhook` / `linear` inbounds injected via `webhookInject` → the same
    // buffer chokepoint. Grep for other `meta:`+`source:` inbound builders if new
    // dirs appear.
    const files: string[] = [
      ...readdirSync(gatewayDir)
        .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
        .map((f) => join(gatewayDir, f)),
      join(repoRoot, 'src', 'web', 'webhook-dispatch.ts'),
    ]
    const found = new Set<string>()
    // Catch BOTH quote styles and full source spellings (digits / underscores /
    // any case) — a single-quote-only, `[a-z_]+`-only regex silently missed the
    // double-quoted `mental_model_proposal_*` and the out-of-gateway webhook
    // sources (pass-2 porosity). Variable-valued `source: expr` stays structurally
    // invisible; the fail-safe stamp default is the safety boundary, not this scan.
    const patterns = [
      /source:\s*['"]([A-Za-z0-9_]+)['"]/g,
      /meta\??\.source\s*===\s*['"]([A-Za-z0-9_]+)['"]/g,
    ]
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      for (const re of patterns) {
        let m: RegExpExecArray | null
        while ((m = re.exec(src)) != null) found.add(m[1]!)
      }
    }
    const unclassified = [...found]
      .filter((s) => !NON_INBOUND_SOURCE_LITERALS.has(s))
      .filter((s) => INBOUND_SOURCE_CLASSIFICATION[s] == null)
      .sort()
    // If this fails: a new meta.source literal was added. Classify it in
    // INBOUND_SOURCE_CLASSIFICATION (decoupledCompletion true ONLY if its reply
    // can land as a late reply with no live turn of its own), or — if it is a
    // non-inbound `source:` field — add it to NON_INBOUND_SOURCE_LITERALS.
    expect(unclassified).toEqual([])
  })
})
