import { describe, expect, it } from 'vitest'

import {
  ackDelivery,
  createDeliveryQueue,
  extractEnqueueMessageIds,
  forgetDelivery,
  isRedeliverySuspended,
  isTrackableResumeSynthetic,
  shouldTrackDelivery,
  sweep,
  trackDelivery,
  type DeliveryQueue,
  type SuspendedTargets,
} from '../gateway/inbound-delivery-confirm.js'

/**
 * Regression coverage for the marko drop-wedge.
 *
 * An inbound delivered to claude's TUI composer strands unsubmitted when the
 * auto-submit races turn-completion. claude never emits `enqueue`, so the
 * gateway used to sit "typing…" for 300s then DROP the message.
 *
 * The queue's contract: a delivered inbound is acked ONLY by `enqueue`; until
 * then it is re-delivered every `timeoutMs`, forever, never dropped — and an
 * acked delivery never re-fires (no duplicate turns).
 */
type Msg = { text: string }
const TIMEOUT = 15_000

function fresh(): DeliveryQueue<Msg> {
  return createDeliveryQueue<Msg>()
}

describe('inbound-delivery-confirm (reliable deliver-until-acked queue)', () => {
  it('an acked delivery is never re-delivered (happy path — no duplicate turns)', () => {
    const q = fresh()
    trackDelivery(q, 'chat:_', { text: 'hi' }, 1_000)
    expect(ackDelivery(q, 'chat:_')).toBe(true) // enqueue arrived
    expect(sweep(q, 1_000 + 999_999, TIMEOUT)).toHaveLength(0)
    expect(q.pending.size).toBe(0)
  })

  it('within the timeout, an un-acked delivery is left alone (claude may still be picking it up)', () => {
    const q = fresh()
    trackDelivery(q, 'chat:_', { text: 'hi' }, 1_000)
    expect(sweep(q, 1_000 + 14_999, TIMEOUT)).toHaveLength(0)
    expect(q.pending.size).toBe(1)
  })

  it('a strand (no ack) is re-delivered after the timeout, and the clock resets', () => {
    const q = fresh()
    trackDelivery(q, 'chat:_', { text: 'draft nurture email' }, 1_000)
    const r = sweep(q, 1_000 + 15_000, TIMEOUT)
    expect(r).toHaveLength(1)
    expect(r[0]!.inbound.text).toBe('draft nurture email')
    expect(r[0]!.lastAttemptAt).toBe(1_000 + 15_000) // clock reset
    // not re-swept until another full timeout elapses
    expect(sweep(q, 1_000 + 15_000 + 14_999, TIMEOUT)).toHaveLength(0)
  })

  it('keeps re-delivering forever until acked — never drops (the reliability invariant)', () => {
    const q = fresh()
    let t = 0
    trackDelivery(q, 'chat:_', { text: 'x' }, t)
    for (let i = 0; i < 50; i++) {
      t += 15_000
      expect(sweep(q, t, TIMEOUT)).toHaveLength(1) // still trying after 50 strands
    }
    expect(q.pending.size).toBe(1) // never dropped
    // claude finally picks it up → acked → stops.
    expect(ackDelivery(q, 'chat:_')).toBe(true)
    expect(sweep(q, t + 999_999, TIMEOUT)).toHaveLength(0)
  })

  it('an ack that lands right after a re-delivery stops further re-delivery (no duplicate turns)', () => {
    const q = fresh()
    trackDelivery(q, 'chat:_', { text: 'x' }, 0)
    sweep(q, 15_000, TIMEOUT) // strand → re-delivered
    expect(ackDelivery(q, 'chat:_')).toBe(true) // the re-delivered copy landed
    expect(sweep(q, 999_999, TIMEOUT)).toHaveLength(0)
    expect(q.pending.size).toBe(0)
  })

  it('keys are independent — a strand on one topic does not affect another (DM + supergroup topics)', () => {
    const q = fresh()
    trackDelivery(q, '-100:4', { text: 'crm topic msg' }, 0) // supergroup CRM topic
    trackDelivery(q, '555:_', { text: 'dm msg' }, 0) // a DM
    ackDelivery(q, '555:_') // the DM submits fine
    const r = sweep(q, 15_000, TIMEOUT)
    expect(r).toHaveLength(1)
    expect(r[0]!.key).toBe('-100:4') // only the stranded topic re-delivers
  })

  it('tracking the same key twice keeps only the latest inbound (gate serialises per key)', () => {
    const q = fresh()
    trackDelivery(q, 'chat:_', { text: 'first' }, 0)
    trackDelivery(q, 'chat:_', { text: 'second' }, 100)
    expect(q.pending.size).toBe(1)
    expect(sweep(q, 100 + 15_000, TIMEOUT)[0]!.inbound.text).toBe('second')
  })

  it('ack on an unknown key is a harmless no-op', () => {
    expect(ackDelivery(fresh(), 'never-tracked')).toBe(false)
  })

  it('forgetDelivery clears without acking or re-delivering (bridge went offline)', () => {
    const q = fresh()
    trackDelivery(q, 'chat:_', { text: 'x' }, 0)
    forgetDelivery(q, 'chat:_')
    expect(q.pending.size).toBe(0)
    expect(sweep(q, 999_999, TIMEOUT)).toHaveLength(0)
  })
})

// Regression for #2787 Mechanism A — a permission / ask_user card must suspend
// the confirm sweep ONLY for its own chat/topic, never globally. Before the fix
// the gateway early-returned the whole sweep whenever ANY card was pending
// anywhere, so one card parked in a single topic (or the operator DM) froze
// re-delivery of every stranded inbound across every topic until it resolved —
// the ~5-minute all-topics stall of #1922. isRedeliverySuspended encodes the
// scoped decision the sweep now makes per swept entry.
describe('isRedeliverySuspended — per-topic sweep suspension (#2787 Mechanism A)', () => {
  const none: SuspendedTargets = { keys: new Set(), chats: new Set() }

  it('no cards open → nothing is suspended (sweep runs for every topic)', () => {
    expect(isRedeliverySuspended('-100:4', none)).toBe(false)
    expect(isRedeliverySuspended('555:_', none)).toBe(false)
  })

  it('reproduces the global-stall fix: a card in topic A does NOT suspend topic B', () => {
    // A permission card is open in supergroup topic 4; a DIFFERENT topic (7) and
    // an unrelated DM both have inbounds stranded in the composer.
    const suspended: SuspendedTargets = { keys: new Set(['-100:4']), chats: new Set() }
    expect(isRedeliverySuspended('-100:4', suspended)).toBe(true) // the card's own topic — deferred
    expect(isRedeliverySuspended('-100:7', suspended)).toBe(false) // sibling topic keeps flowing
    expect(isRedeliverySuspended('555:_', suspended)).toBe(false) // unrelated DM keeps flowing
  })

  it('a card fanned to the operator DM (chatId only, topic unknown) suspends just that chat', () => {
    const suspended: SuspendedTargets = { keys: new Set(), chats: new Set(['999']) }
    expect(isRedeliverySuspended('999:_', suspended)).toBe(true) // operator DM — deferred
    expect(isRedeliverySuspended('-100:4', suspended)).toBe(false) // every topic elsewhere flows
    expect(isRedeliverySuspended('555:_', suspended)).toBe(false)
  })

  it('drives the actual sweep: stranded siblings still re-deliver while one topic holds a card', () => {
    const q = createDeliveryQueue<{ text: string }>()
    trackDelivery(q, '-100:4', { text: 'msg in the card topic' }, 0)
    trackDelivery(q, '-100:7', { text: 'msg in a sibling topic' }, 0)
    trackDelivery(q, '555:_', { text: 'dm msg' }, 0)
    const suspended: SuspendedTargets = { keys: new Set(['-100:4']), chats: new Set() }
    // The gateway loop: sweep, then skip only entries suspended for their target.
    const redelivered = sweep(q, 15_000, TIMEOUT).filter(
      (p) => !isRedeliverySuspended(p.key, suspended),
    )
    const keys = redelivered.map((p) => p.key).sort()
    expect(keys).toEqual(['-100:7', '555:_']) // the card's topic held; the rest flowed
  })
})

// Regression for the cross-source ACK collision (silent drop): `enqueue` fires
// for EVERY turn start regardless of source. A synthetic-source turn (cron /
// resume / vault / reaction) that shares the chatKey of a real user message
// still waiting to land would, with a key-only ack, clear — and silently drop
// — that user message. The ack must match on the tracked message id.
describe('ackDelivery — message-id-matched (cross-source false-ack guard)', () => {
  it('acks when the enqueue message id matches the tracked one', () => {
    const q = fresh()
    trackDelivery(q, 'chat:_', { text: 'real user msg' }, 0, '5001')
    expect(ackDelivery(q, 'chat:_', '5001')).toBe(true)
    expect(q.pending.size).toBe(0)
  })

  it('does NOT ack when a different (synthetic-source) turn enqueues under the same key', () => {
    const q = fresh()
    trackDelivery(q, 'chat:_', { text: 'real user msg' }, 0, '5001')
    // a cron / resume turn for the same chat enqueues first, with its own id
    expect(ackDelivery(q, 'chat:_', '1716123456789')).toBe(false)
    // the user message is still tracked — it strands → gets re-delivered, not dropped
    expect(q.pending.size).toBe(1)
    expect(sweep(q, 15_000, TIMEOUT)).toHaveLength(1)
    // and its own enqueue (matching id) later acks it cleanly
    expect(ackDelivery(q, 'chat:_', '5001')).toBe(true)
    expect(q.pending.size).toBe(0)
  })

  it('does NOT ack when the enqueue carries no message id but the tracked one has one', () => {
    const q = fresh()
    trackDelivery(q, 'chat:_', { text: 'real user msg' }, 0, '5001')
    expect(ackDelivery(q, 'chat:_', null)).toBe(false)
    expect(q.pending.size).toBe(1)
  })

  it('falls back to key-only ack when no message id was recorded (legacy/defensive)', () => {
    const q = fresh()
    trackDelivery(q, 'chat:_', { text: 'x' }, 0) // no messageId
    expect(ackDelivery(q, 'chat:_', '5001')).toBe(true)
    expect(q.pending.size).toBe(0)
  })
})

// Regression for #2786 — the enqueue-ack mismatch that re-delivers a RUNNING
// turn (a duplicate turn / double-actioned user message). Delivery-confirm
// re-parses the `<channel message_id="…">` envelope back out of the transcript
// to match the ack. When the composer merges/reorders inbound envelopes, the
// single re-parsed id can belong to a sibling, so strict equality mis-concludes
// "never delivered" and the sweep re-delivers a turn already running. Passing
// the raw enqueue content lets the ack tolerate that by scanning every id.
describe('ackDelivery — composer-tolerant match (#2786 duplicate-turn guard)', () => {
  const envelope = (id: string, text: string) =>
    `<channel source="telegram" chat_id="555" message_id="${id}" user="ken">${text}</channel>`

  it('reproduces the bug: strict re-parsed id mismatch would NOT ack (pre-fix)', () => {
    const q = fresh()
    trackDelivery(q, 'chat:_', { text: 'run the deploy' }, 0, '5002')
    // Composer merged an earlier sibling first, so parseChannelMeta re-parsed
    // the FIRST id (5001), not our tracked 5002. Without the content, no ack →
    // the sweep would re-deliver the already-running turn (the duplicate).
    expect(ackDelivery(q, 'chat:_', '5001')).toBe(false)
    expect(sweep(q, 15_000, TIMEOUT)).toHaveLength(1) // would double-action
  })

  it('acks when the tracked id appears anywhere in the merged enqueue content', () => {
    const q = fresh()
    trackDelivery(q, 'chat:_', { text: 'run the deploy' }, 0, '5002')
    const merged = `${envelope('5001', 'hi')}\n${envelope('5002', 'run the deploy')}`
    // First-parsed id is the sibling's 5001, but our 5002 is present in content.
    expect(ackDelivery(q, 'chat:_', '5001', merged)).toBe(true)
    expect(q.pending.size).toBe(0)
    expect(sweep(q, 15_000, TIMEOUT)).toHaveLength(0) // no duplicate turn
  })

  it('acks on a reformatted single envelope where content still carries the id', () => {
    const q = fresh()
    trackDelivery(q, 'chat:_', { text: 'x' }, 0, '5002')
    // Re-parse yielded null (wrapper reformatted) but the id survives in content.
    expect(ackDelivery(q, 'chat:_', null, envelope('5002', 'x'))).toBe(true)
    expect(q.pending.size).toBe(0)
  })

  it('preserves the cross-source false-ack guard: a synthetic turn whose content lacks our id does NOT ack', () => {
    const q = fresh()
    trackDelivery(q, 'chat:_', { text: 'real user msg' }, 0, '5002')
    // A cron/resume turn under the same key — its envelope carries a fabricated
    // id, never the user's 5002. Even with content scanning, it must not ack.
    const cron = envelope('1716123456789', 'scheduled digest')
    expect(ackDelivery(q, 'chat:_', '1716123456789', cron)).toBe(false)
    expect(q.pending.size).toBe(1)
    expect(sweep(q, 15_000, TIMEOUT)).toHaveLength(1) // user msg re-delivered, not dropped
  })

  it('extractEnqueueMessageIds pulls every id from a merged envelope', () => {
    const merged = `${envelope('5001', 'a')}\n${envelope('5002', 'b')}`
    expect(extractEnqueueMessageIds(merged)).toEqual(['5001', '5002'])
    expect(extractEnqueueMessageIds('no envelope here')).toEqual([])
  })

  // Regression for the unanchored-regex substring collision (silent-drop
  // hazard on this never-drop path). `target_message_id`, `reply_to_message_id`,
  // `original_message_id`, `card_message_id` etc. all END in `message_id="…"`.
  // An unanchored /message_id="([^"]+)"/ grabs those siblings' values as if they
  // were the real `message_id`, so a synthetic-source turn that merely REFERENCES
  // message 5002 (e.g. `reply_to_message_id="5002"`) — without actually being
  // message 5002 — would false-ack and silently drop the still-pending real
  // inbound 5002. The regex must match ONLY the real `message_id` attribute.
  it('does NOT extract same-suffix sibling attributes (target_/reply_to_/original_/card_message_id)', () => {
    const content =
      'target_message_id="5002" reply_to_message_id="5003" ' +
      'original_message_id="5004" card_message_id="5005"'
    expect(extractEnqueueMessageIds(content)).toEqual([])
  })

  it('extracts the real message_id even when a sibling *_message_id sits alongside it', () => {
    const content =
      '<channel source="reaction" chat_id="555" target_message_id="5002" ' +
      'message_id="9999" user="ken">reacted</channel>'
    // Only the real attribute (9999) is pulled — never the referenced 5002.
    expect(extractEnqueueMessageIds(content)).toEqual(['9999'])
  })

  it('a sibling *_message_id="5002" reference does NOT false-ack a pending entry keyed on 5002 (substring-collision guard)', () => {
    const q = fresh()
    trackDelivery(q, 'chat:_', { text: 'real user msg 5002' }, 0, '5002')
    // A synthetic-source turn (its own id 8000) merely REFERENCES 5002 via
    // sibling attributes — it is not message 5002 itself.
    const synthetic =
      '<channel source="reaction" chat_id="555" message_id="8000" ' +
      'target_message_id="5002" reply_to_message_id="5002" user="ken">👍</channel>'
    expect(ackDelivery(q, 'chat:_', '8000', synthetic)).toBe(false)
    // The real inbound 5002 is still pending — it strands and re-delivers, not dropped.
    expect(q.pending.size).toBe(1)
    expect(sweep(q, 15_000, TIMEOUT)).toHaveLength(1)
    // Its own genuine envelope (real message_id="5002") later acks it cleanly.
    expect(ackDelivery(q, 'chat:_', '5002', envelope('5002', 'real user msg 5002'))).toBe(true)
    expect(q.pending.size).toBe(0)
  })
})

// Regression for the steer/interrupt re-delivery loop: steering and `!`
// interrupt inbounds amend the running turn and never emit `enqueue`, so they
// must NOT be tracked (else the sweep re-delivers them forever). Only
// fresh-turn messages — which DO enqueue — are tracked.
describe('shouldTrackDelivery — only fresh-turn messages are tracked', () => {
  it('tracks a normal (non-steering, non-interrupt) message', () => {
    expect(shouldTrackDelivery({ isSteering: false, isInterrupt: false })).toBe(true)
  })
  it('does NOT track a /steer message (amends the turn — never acks)', () => {
    expect(shouldTrackDelivery({ isSteering: true, isInterrupt: false })).toBe(false)
  })
  it('does NOT track a ! interrupt message (amends the turn — never acks)', () => {
    expect(shouldTrackDelivery({ isSteering: false, isInterrupt: true })).toBe(false)
  })
  it('does NOT track when both flags set (defensive)', () => {
    expect(shouldTrackDelivery({ isSteering: true, isInterrupt: true })).toBe(false)
  })
  it('does NOT track a synthetic (meta.source) inbound — cron/resume/vault/reaction enqueue under their own semantics', () => {
    expect(shouldTrackDelivery({ isSteering: false, isInterrupt: false, hasSource: true })).toBe(false)
  })
  it('does NOT track an empty-body message (e.g. `/queue` with no text) — never enqueues, would re-deliver forever', () => {
    expect(shouldTrackDelivery({ isSteering: false, isInterrupt: false, effectiveText: '' })).toBe(false)
    expect(shouldTrackDelivery({ isSteering: false, isInterrupt: false, effectiveText: '   ' })).toBe(false)
  })
  it('tracks a normal message when effectiveText is provided and non-empty', () => {
    expect(shouldTrackDelivery({ isSteering: false, isInterrupt: false, effectiveText: 'draft the email' })).toBe(true)
  })
})

// The boot-resume synthetic is the one synthetic ENROLLED for re-delivery (so a
// restart can't silently drop the "pick up your interrupted work" wake into a
// not-ready session). It is safe ONLY because it carries a round-trippable
// message_id that its own enqueue acks — without that it would re-deliver
// forever (the storm the hasSource exclusion otherwise prevents).
describe('isTrackableResumeSynthetic — resume carve-in to the deliver-until-acked queue', () => {
  it('tracks a resume_interrupted synthetic that carries a message_id', () => {
    expect(isTrackableResumeSynthetic({ source: 'resume_interrupted', message_id: '1700000000000' })).toBe(true)
  })
  it('does NOT track a resume_interrupted WITHOUT a message_id (would never ack → storm)', () => {
    expect(isTrackableResumeSynthetic({ source: 'resume_interrupted' })).toBe(false)
    expect(isTrackableResumeSynthetic({ source: 'resume_interrupted', message_id: '' })).toBe(false)
  })
  it('does NOT track the watchdog report (untracked by design) even though it carries chat_id', () => {
    expect(isTrackableResumeSynthetic({ source: 'resume_watchdog_timeout', chat_id: '123' })).toBe(false)
  })
  it('does NOT track other synthetics (cron / vault / handback) even if they somehow had a message_id', () => {
    expect(isTrackableResumeSynthetic({ source: 'cron', message_id: '1' })).toBe(false)
    expect(isTrackableResumeSynthetic({ source: 'subagent_handback', message_id: '1' })).toBe(false)
    expect(isTrackableResumeSynthetic({ source: 'vault_grant_approved', message_id: '1' })).toBe(false)
  })
  it('does NOT track a real (no source) inbound here — that path is shouldTrackDelivery', () => {
    expect(isTrackableResumeSynthetic({ chat_id: '1', message_id: '2' })).toBe(false)
    expect(isTrackableResumeSynthetic(undefined)).toBe(false)
  })
})

// End-to-end queue contract for the resume synthetic: tracked by its fabricated
// id, acked by its OWN enqueue (which round-trips the same id), and — crucially
// — it can never re-deliver forever (the storm the original deferral feared).
describe('resume synthetic: tracked, acked by own enqueue, never storms', () => {
  const RESUME_ID = '1700000000000' // String(ts), the fabricated message_id
  it('acks when its own enqueue arrives with the matching id (no storm)', () => {
    const q = fresh()
    trackDelivery(q, 'chat:_', { text: 'resume…' }, 1_000, RESUME_ID)
    // The resume turn starts → enqueue fires carrying the round-tripped id.
    expect(ackDelivery(q, 'chat:_', RESUME_ID)).toBe(true)
    expect(q.pending.size).toBe(0)
    // Never re-delivered after the ack — bounded, not a forever loop.
    expect(sweep(q, 1_000 + 999_999, TIMEOUT)).toHaveLength(0)
  })
  it('strands then re-delivers until acked (rescues a drop into a not-ready session)', () => {
    const q = fresh()
    trackDelivery(q, 'chat:_', { text: 'resume…' }, 1_000, RESUME_ID)
    // Dropped into a not-ready session: no enqueue within the timeout → re-deliver.
    const stranded = sweep(q, 1_000 + TIMEOUT + 1, TIMEOUT)
    expect(stranded).toHaveLength(1)
    expect(stranded[0]!.messageId).toBe(RESUME_ID)
    // Once claude is ready, its enqueue acks it and the loop stops.
    expect(ackDelivery(q, 'chat:_', RESUME_ID)).toBe(true)
    expect(sweep(q, 1_000 + TIMEOUT * 10, TIMEOUT)).toHaveLength(0)
  })
  it('a DIFFERENT enqueue id (e.g. a racing real user msg) does NOT false-ack the resume', () => {
    const q = fresh()
    trackDelivery(q, 'chat:_', { text: 'resume…' }, 1_000, RESUME_ID)
    expect(ackDelivery(q, 'chat:_', '999')).toBe(false) // not our id
    expect(q.pending.size).toBe(1) // still pending, will re-deliver
  })
})
