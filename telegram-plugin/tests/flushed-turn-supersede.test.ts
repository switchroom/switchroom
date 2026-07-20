/**
 * Unit coverage for the turnId-keyed flushed-turn supersede registry
 * (2026-07 duplicate-reply fix).
 *
 * The regression these tests pin: the answer-ready quiescence flush (or the
 * turn-end backstop) posts a turn's terminal text as a Telegram message, then
 * the model's REAL `reply` tool call for the SAME turn lands ~10 s later and
 * ships a SECOND message. The pre-existing `OutboundDedupCache` misses this
 * because it matches on EXACT text equality — a `narration\n\nanswer` flush
 * never equals the clean `answer`-only reply.
 *
 * Identity-only supersede (adversarial-review HIGH fix): supersede fires ONLY
 * when the landing reply is positively attributable to the flushed turn by
 * turnId. A reply with an UNRESOLVED turn (`liveTurnId == null`) never deletes a
 * turnId-bearing record — we never delete a message we can't attribute to the
 * reply's own turn. The lane holds a per-turnId map, so two concurrent turns can
 * each flush a message and each turn's reply supersedes ONLY its own.
 */

import { describe, it, expect } from 'vitest'
import {
  decideSupersede,
  decideSupersedeCorrection,
  flushedAnswerMatchesReply,
  FlushedTurnSupersedeRegistry,
  DEFAULT_SUPERSEDE_TTL_MS,
  SUPERSEDE_MATCH_MIN_CONTAINMENT_CHARS,
  type FlushedTurnRecord,
} from '../flushed-turn-supersede.js'

const rec = (over: Partial<FlushedTurnRecord> = {}): FlushedTurnRecord => ({
  turnId: 'turn-A',
  messageIds: [101, 102],
  text: 'narration\n\nthe real answer',
  ts: 1_000_000,
  ...over,
})

describe('decideSupersedeCorrection — edit-in-place vs delete+resend', () => {
  const base = {
    flushMessageIds: [500],
    chunkCount: 1,
    hasFiles: false,
    suppressText: false,
    hasOpenPreview: false,
  }

  it('edits in place when the flush posted ONE message and the reply fits one plain-text message', () => {
    const c = decideSupersedeCorrection(base)
    expect(c.mode).toBe('edit-in-place')
    // edit target is the single flushed message; nothing is deleted (A becomes B).
    expect(c).toMatchObject({ mode: 'edit-in-place', editMessageId: 500, deleteMessageIds: [] })
  })

  it('literal (format:text) single-message replies still edit in place (text is text)', () => {
    // literalText is not an input to the decision — a literal reply is still a
    // text message the edit lane renders identically.
    const c = decideSupersedeCorrection({ ...base })
    expect(c.mode).toBe('edit-in-place')
  })

  it('falls back to delete+resend for a MULTI-PART reply (edit can only carry one message)', () => {
    const c = decideSupersedeCorrection({ ...base, chunkCount: 3 })
    expect(c).toEqual({ mode: 'delete-resend', deleteMessageIds: [500] })
  })

  it('falls back to delete+resend when the flush posted MORE THAN ONE message', () => {
    const c = decideSupersedeCorrection({ ...base, flushMessageIds: [500, 501] })
    expect(c).toEqual({ mode: 'delete-resend', deleteMessageIds: [500, 501] })
  })

  it('falls back to delete+resend for a file/album reply (not a plain-text edit)', () => {
    const c = decideSupersedeCorrection({ ...base, hasFiles: true })
    expect(c.mode).toBe('delete-resend')
  })

  it('falls back to delete+resend for a voice-only reply (no text body to edit into)', () => {
    const c = decideSupersedeCorrection({ ...base, suppressText: true })
    expect(c.mode).toBe('delete-resend')
  })

  it('falls back to delete+resend when a draft-stream preview already owns the edit lane', () => {
    const c = decideSupersedeCorrection({ ...base, hasOpenPreview: true })
    expect(c.mode).toBe('delete-resend')
  })

  it('anti-duplicate invariant: every correction resolves to exactly one surviving message', () => {
    // edit-in-place → A becomes B (1 message, 0 deletes); delete-resend → all
    // flushed ids deleted then B sent fresh (1 message). Neither leaves A+B both
    // visible, and neither loses the reply.
    const editing = decideSupersedeCorrection(base)
    expect(editing.mode === 'edit-in-place' && editing.deleteMessageIds.length).toBe(0)
    const resending = decideSupersedeCorrection({ ...base, chunkCount: 2 })
    expect(resending.deleteMessageIds).toEqual([500])
  })
})

describe('decideSupersede — the duplicate-reply decision core', () => {
  it('supersedes when the reply is attributed to the SAME turn as the flush', () => {
    // The common late-replay dup: the gateway resolves the reply's turnId (from
    // origin_turn_id) even after currentTurn cleared, so it matches by identity.
    const d = decideSupersede(rec({ turnId: 'turn-A' }), {
      liveTurnId: 'turn-A',
      now: 1_000_000 + 10_000,
    })
    expect(d.supersede).toBe(true)
    expect(d.deleteMessageIds).toEqual([101, 102])
    expect(d.reason).toBe('supersede')
  })

  it('does NOT supersede a reply belonging to a DIFFERENT turn', () => {
    // A different turn is the resolved owner — it must never delete this turn's
    // message. This is the guard that keeps the fix from eating a legit answer.
    const d = decideSupersede(rec({ turnId: 'turn-A' }), {
      liveTurnId: 'turn-B',
      now: 1_000_000 + 500,
    })
    expect(d.supersede).toBe(false)
    expect(d.deleteMessageIds).toEqual([])
    expect(d.reason).toBe('different-turn')
  })

  it('does NOT supersede a turnId-bearing record when the reply turn is UNRESOLVED (liveTurnId == null)', () => {
    // HIGH-finding core guard: a late reply we cannot attribute to a turn must
    // NEVER delete a message that positively belongs to some turn. Pre-fix the
    // null branch superseded ANY record — deleting a possibly-different turn's
    // legitimate message.
    const d = decideSupersede(rec({ turnId: 'turn-A' }), {
      liveTurnId: null,
      now: 1_000_000 + 10_000,
    })
    expect(d.supersede).toBe(false)
    expect(d.reason).toBe('different-turn')
  })

  it('does NOT supersede once the record is past its TTL', () => {
    const d = decideSupersede(rec(), {
      liveTurnId: 'turn-A',
      now: 1_000_000 + DEFAULT_SUPERSEDE_TTL_MS + 1,
    })
    expect(d.supersede).toBe(false)
    expect(d.reason).toBe('expired')
  })

  it('returns no-record when there is nothing to supersede', () => {
    const d = decideSupersede(undefined, { liveTurnId: null, now: 1_000_000 })
    expect(d.supersede).toBe(false)
    expect(d.reason).toBe('no-record')
  })

  it('a null-turnId record is superseded ONLY by an equally-unresolved (null) reply', () => {
    // A synthetic/no-nonce flush: only a reply that ALSO has no resolvable turn
    // matches it — it never clobbers a turn we CAN identify.
    const live = decideSupersede(rec({ turnId: null }), {
      liveTurnId: 'turn-Z',
      now: 1_000_000,
    })
    expect(live.supersede).toBe(false)
    expect(live.reason).toBe('different-turn')

    const unresolved = decideSupersede(rec({ turnId: null }), {
      liveTurnId: null,
      now: 1_000_000,
    })
    expect(unresolved.supersede).toBe(true)
  })
})

describe('FlushedTurnSupersedeRegistry — record / peek / take lifecycle', () => {
  it('records a flush and supersedes the same turn`s later reply end to end', () => {
    const reg = new FlushedTurnSupersedeRegistry()
    reg.record('chat1', undefined, { turnId: 'turn-A', messageIds: [7, 8], text: 'x' }, 1000)
    const d = reg.take('chat1', undefined, { liveTurnId: 'turn-A', now: 5000 })
    expect(d.supersede).toBe(true)
    expect(d.deleteMessageIds).toEqual([7, 8])
  })

  it('take() CONSUMES the matched record so a replayed reply does not double-delete', () => {
    const reg = new FlushedTurnSupersedeRegistry()
    reg.record('chat1', undefined, { turnId: 'turn-A', messageIds: [7], text: 'x' }, 1000)
    const first = reg.take('chat1', undefined, { liveTurnId: 'turn-A', now: 2000 })
    expect(first.supersede).toBe(true)
    // Replay of the same reply — the flushed message is already gone.
    const second = reg.take('chat1', undefined, { liveTurnId: 'turn-A', now: 2001 })
    expect(second.supersede).toBe(false)
    expect(second.reason).toBe('no-record')
  })

  it('peek() does NOT consume — repeated peeks keep returning supersede', () => {
    const reg = new FlushedTurnSupersedeRegistry()
    reg.record('chat1', undefined, { turnId: 'turn-A', messageIds: [7], text: 'x' }, 1000)
    expect(reg.peek('chat1', undefined, { liveTurnId: 'turn-A', now: 2000 }).supersede).toBe(true)
    expect(reg.peek('chat1', undefined, { liveTurnId: 'turn-A', now: 2001 }).supersede).toBe(true)
  })

  it('does not record a flush that posted zero messages', () => {
    const reg = new FlushedTurnSupersedeRegistry()
    reg.record('chat1', undefined, { turnId: 'turn-A', messageIds: [], text: 'x' }, 1000)
    expect(reg.take('chat1', undefined, { liveTurnId: 'turn-A', now: 2000 }).supersede).toBe(false)
  })

  it('keys per chat|thread — a flush in one thread never supersedes a reply in another', () => {
    const reg = new FlushedTurnSupersedeRegistry()
    reg.record('chat1', 42, { turnId: 'turn-A', messageIds: [7], text: 'x' }, 1000)
    // different thread, same chat
    expect(reg.take('chat1', 99, { liveTurnId: 'turn-A', now: 2000 }).supersede).toBe(false)
    // correct thread supersedes
    expect(reg.take('chat1', 42, { liveTurnId: 'turn-A', now: 2000 }).supersede).toBe(true)
  })

  // ---- HIGH finding regression: wrong-delete via a null-turn late reply. ----
  describe('HIGH regression — two concurrent turns on one lane', () => {
    it('turn A`s late reply supersedes ONLY A`s flush, never turn B`s legitimate message', () => {
      const reg = new FlushedTurnSupersedeRegistry()
      // Turn A flushes msg 100.
      reg.record('chat1', undefined, { turnId: 'turn-A', messageIds: [100], text: 'a' }, 1000)
      // Turn B flushes msg 200 (B's real answer message).
      reg.record('chat1', undefined, { turnId: 'turn-B', messageIds: [200], text: 'b' }, 1100)

      // Turn A's real reply lands late, resolved (via origin_turn_id) to turn A.
      const dA = reg.take('chat1', undefined, { liveTurnId: 'turn-A', now: 1200 })
      expect(dA.supersede).toBe(true)
      expect(dA.deleteMessageIds).toEqual([100]) // NOT [200] — B's message is untouched.

      // B's own message is still independently supersedable by B's reply — proof
      // A's reply did not consume or clobber B's record.
      const dB = reg.take('chat1', undefined, { liveTurnId: 'turn-B', now: 1300 })
      expect(dB.supersede).toBe(true)
      expect(dB.deleteMessageIds).toEqual([200])
    })

    it('an UNRESOLVED (null-turn) late reply does NOT delete a different turn`s legitimate message', () => {
      // This is the exact wrong-delete the review flagged. Pre-fix: single lane
      // slot overwritten to {turn-B,[200]} + promiscuous null branch → the null
      // reply superseded and DELETED msg 200 (B's good answer). Post-fix: a null
      // liveTurnId matches no turnId-bearing record, so nothing is deleted.
      const reg = new FlushedTurnSupersedeRegistry()
      reg.record('chat1', undefined, { turnId: 'turn-A', messageIds: [100], text: 'a' }, 1000)
      reg.record('chat1', undefined, { turnId: 'turn-B', messageIds: [200], text: 'b' }, 1100)

      const d = reg.take('chat1', undefined, { liveTurnId: null, now: 1200 })
      expect(d.supersede).toBe(false)
      expect(d.deleteMessageIds).toEqual([])

      // Both records survive — neither turn's message was wrongly deleted.
      expect(reg.peek('chat1', undefined, { liveTurnId: 'turn-A', now: 1300 }).supersede).toBe(true)
      expect(reg.peek('chat1', undefined, { liveTurnId: 'turn-B', now: 1300 }).supersede).toBe(true)
    })
  })

  it('size() evicts expired records and prunes emptied lanes', () => {
    const reg = new FlushedTurnSupersedeRegistry({ ttlMs: 1000 })
    reg.record('chat1', undefined, { turnId: 'turn-A', messageIds: [1], text: 'a' }, 1000)
    reg.record('chat1', undefined, { turnId: 'turn-B', messageIds: [2], text: 'b' }, 1000)
    expect(reg.size(1500)).toBe(2)
    expect(reg.size(3000)).toBe(0)
  })

  it('record() actively sweeps expired records (LOW-2 GC — no orphan accumulation)', () => {
    const reg = new FlushedTurnSupersedeRegistry({ ttlMs: 1000 })
    reg.record('chat1', undefined, { turnId: 'turn-A', messageIds: [1], text: 'a' }, 1000)
    // A much later flush on a DIFFERENT lane sweeps the now-expired turn-A record.
    reg.record('chat2', undefined, { turnId: 'turn-B', messageIds: [2], text: 'b' }, 5000)
    // Only the fresh record remains; the orphan was swept, not left to leak.
    expect(reg.size(5000)).toBe(1)
    expect(reg.peek('chat1', undefined, { liveTurnId: 'turn-A', now: 5000 }).reason).toBe('no-record')
  })
})

/**
 * #3429 — async handback edit-in-place supersede of a flush-delivered message
 * can fail to surface client-side.
 *
 * The flush ends its turn synchronously BEFORE recording, so EVERY superseding
 * reply is a late reply — and an async sub-agent handback landing within the
 * 60 s TTL with no live gateway turn resolves the flush-delivered ENDED turn
 * as its owner via the latest-ended tier, the SAME identity as the turn's own
 * canonical late replay. Identity-only supersede then consumed the record and
 * EDITED the flushed message in place with the handback's unrelated content
 * (msgs 10482/10486, 2026-07-20) — Telegram edits never push-notify, so the
 * handback silently failed to surface AND the flushed answer was destroyed.
 *
 * The content gate: `replyText` is compared against the record's flushed text
 * (`flushedAnswerMatchesReply` — whitespace-normalized equality, or containment
 * with a minimum-length guard on the contained side). Same answer → supersede
 * (the wanted correction); different content → 'new-content', send fresh,
 * record NOT consumed.
 */
describe('#3429 — flushedAnswerMatchesReply (content discriminator)', () => {
  const ANSWER = 'The deploy is green: all 12 services rolled out and health checks pass.'
  const FLUSH_BLOB = `Let me check the rollout status.\n\n${ANSWER}`

  it('matches whitespace-normalized equality', () => {
    expect(flushedAnswerMatchesReply(ANSWER, ANSWER)).toBe(true)
    expect(flushedAnswerMatchesReply(`${ANSWER}\n`, ANSWER.replace(': ', ':  '))).toBe(true)
  })

  it('matches the classic containment class: flush = narration+answer ⊇ clean reply', () => {
    expect(flushedAnswerMatchesReply(FLUSH_BLOB, ANSWER)).toBe(true)
  })

  it('matches reverse containment: reply ⊇ partially-delivered flush text', () => {
    expect(flushedAnswerMatchesReply(ANSWER, FLUSH_BLOB)).toBe(true)
  })

  it('does NOT match genuinely different content (the handback)', () => {
    const handback =
      'Worker finished: PR #3430 is up with the fix for the vault broker timeout, ' +
      'tests are green, ready for your review.'
    expect(flushedAnswerMatchesReply(FLUSH_BLOB, handback)).toBe(false)
  })

  it('short containment below the minimum-length guard does NOT match ' +
    '(a coincidental substring must never claim a handback)', () => {
    const shortReply = 'rolled out'
    expect(shortReply.length).toBeLessThan(SUPERSEDE_MATCH_MIN_CONTAINMENT_CHARS)
    expect(FLUSH_BLOB.includes(shortReply)).toBe(true)
    expect(flushedAnswerMatchesReply(FLUSH_BLOB, shortReply)).toBe(false)
  })

  it('short EQUAL texts still match (equality has no length floor)', () => {
    expect(flushedAnswerMatchesReply('yes, done', 'yes, done')).toBe(true)
  })
})

describe('#3429 — decideSupersede new-content gate', () => {
  const FLUSHED = 'Narration first.\n\nHere is the finished summary of the incident you asked about.'
  const HANDBACK =
    'Sub-agent handback: the researcher finished and found three root causes, ' +
    'written up in the report at /tmp/report.md — want the highlights?'

  it('same-turn same-answer late reply still supersedes (the wanted correction)', () => {
    const d = decideSupersede(rec({ text: FLUSHED }), {
      liveTurnId: 'turn-A',
      replyText: 'Here is the finished summary of the incident you asked about.',
      now: 1_000_010,
    })
    expect(d.supersede).toBe(true)
    expect(d.reason).toBe('supersede')
    expect(d.recordText).toBe(FLUSHED)
  })

  it('CORE #3429: same turn identity + DIFFERENT content → new-content, NO supersede', () => {
    const d = decideSupersede(rec({ text: FLUSHED }), {
      liveTurnId: 'turn-A',
      replyText: HANDBACK,
      now: 1_000_010,
    })
    expect(d.supersede).toBe(false)
    expect(d.reason).toBe('new-content')
    expect(d.deleteMessageIds).toEqual([])
    expect(d.recordText).toBe(FLUSHED)
  })

  it('legacy identity-only callers (no replyText) keep the pre-#3429 behaviour', () => {
    const d = decideSupersede(rec({ text: FLUSHED }), { liveTurnId: 'turn-A', now: 1_000_010 })
    expect(d.supersede).toBe(true)
  })

  it('take() does NOT consume the record on new-content — the genuine replay ' +
    'can still correct the flushed message afterwards', () => {
    const reg = new FlushedTurnSupersedeRegistry()
    const now = 1_000_000
    reg.record('chat9', undefined, { turnId: 'turn-F', messageIds: [7001], text: FLUSHED }, now)

    // The handback lands first: new-content, nothing consumed, nothing deleted.
    const d1 = reg.take('chat9', undefined, { liveTurnId: 'turn-F', replyText: HANDBACK, now: now + 10_000 })
    expect(d1.supersede).toBe(false)
    expect(d1.reason).toBe('new-content')

    // The turn's own canonical replay lands later: record still there, supersede
    // fires and consumes it.
    const d2 = reg.take('chat9', undefined, {
      liveTurnId: 'turn-F',
      replyText: 'Here is the finished summary of the incident you asked about.',
      now: now + 20_000,
    })
    expect(d2.supersede).toBe(true)
    expect(d2.deleteMessageIds).toEqual([7001])
    // Now consumed.
    expect(reg.peek('chat9', undefined, { liveTurnId: 'turn-F', now: now + 21_000 }).reason).toBe('no-record')
  })
})

/**
 * The tier discriminator (fix/backstop-duplicate-reply). `positiveAttribution`
 * lets the gateway bypass the #3429 content gate when the reply's owner turn was
 * resolved by POSITIVE attribution (live / origin echo / quoted) rather than the
 * ambiguous latest-ended fallback. On a positive tier a genuinely-DIFFERENT
 * (reworded) reply for the same turn still supersedes — closing the reworded
 * same-turn duplicate — while the latest-ended path keeps the content gate so a
 * true async handback still sends fresh.
 */
describe('positiveAttribution — tier-gated content check', () => {
  const FLUSHED = 'Narration first.\n\nHere is the finished summary of the incident you asked about.'
  const REWORDED =
    'So, to wrap up: the incident boiled down to a stale cache entry, and it is fully resolved now.'

  it('positiveAttribution=true: same turn + DIFFERENT (reworded) content STILL supersedes', () => {
    // Guard: the reworded text is genuinely new vs the flushed blob (would be
    // declined new-content without the tier bypass).
    expect(flushedAnswerMatchesReply(FLUSHED, REWORDED)).toBe(false)

    const d = decideSupersede(rec({ text: FLUSHED }), {
      liveTurnId: 'turn-A',
      replyText: REWORDED,
      positiveAttribution: true,
      now: 1_000_010,
    })
    expect(d.supersede).toBe(true)
    expect(d.reason).toBe('supersede')
    expect(d.deleteMessageIds).toEqual([101, 102])
  })

  it('positiveAttribution=false (latest-ended): the SAME reworded content declines as new-content', () => {
    const d = decideSupersede(rec({ text: FLUSHED }), {
      liveTurnId: 'turn-A',
      replyText: REWORDED,
      positiveAttribution: false,
      now: 1_000_010,
    })
    expect(d.supersede).toBe(false)
    expect(d.reason).toBe('new-content')
  })

  it('positiveAttribution=true still requires turn IDENTITY (different turn never supersedes)', () => {
    const d = decideSupersede(rec({ turnId: 'turn-A', text: FLUSHED }), {
      liveTurnId: 'turn-B',
      replyText: REWORDED,
      positiveAttribution: true,
      now: 1_000_010,
    })
    expect(d.supersede).toBe(false)
    expect(d.reason).toBe('different-turn')
  })

  it('positiveAttribution=true still respects the TTL (expired record never supersedes)', () => {
    const d = decideSupersede(rec({ text: FLUSHED }), {
      liveTurnId: 'turn-A',
      replyText: REWORDED,
      positiveAttribution: true,
      now: 1_000_000 + DEFAULT_SUPERSEDE_TTL_MS + 1,
    })
    expect(d.supersede).toBe(false)
    expect(d.reason).toBe('expired')
  })

  it('registry take() threads positiveAttribution through to the decision', () => {
    const reg = new FlushedTurnSupersedeRegistry()
    const now = 1_000_000
    reg.record('chatT', undefined, { turnId: 'turn-Q', messageIds: [8001], text: FLUSHED }, now)

    // latest-ended (positiveAttribution falsey): reworded → new-content, kept.
    const ambiguous = reg.peek('chatT', undefined, {
      liveTurnId: 'turn-Q',
      replyText: REWORDED,
      now: now + 5_000,
    })
    expect(ambiguous.reason).toBe('new-content')

    // positive tier: same reworded reply supersedes and consumes the record.
    const positive = reg.take('chatT', undefined, {
      liveTurnId: 'turn-Q',
      replyText: REWORDED,
      positiveAttribution: true,
      now: now + 6_000,
    })
    expect(positive.supersede).toBe(true)
    expect(positive.deleteMessageIds).toEqual([8001])
    expect(reg.peek('chatT', undefined, { liveTurnId: 'turn-Q', now: now + 7_000 }).reason).toBe('no-record')
  })
})
