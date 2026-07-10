/**
 * Contract pins for `handleMentalModelProposeCallback` — the operator-tap
 * resolver for a mental-model proposal card (hindsight Phase 5, Fix 6.1).
 *
 * These are source-inspection pins (the handler needs a live grammY Context +
 * hostd dispatch to run, so we assert its structure the same way the vault
 * callback posture tests do). Load-bearing invariants:
 *
 *   1. The `allowFrom` authorization gate is the FIRST thing the handler does —
 *      a tap from anyone not on the operator allow-list is refused before any
 *      pending lookup, pending delete, or hostd dispatch runs. This is the
 *      "an agent can never self-approve" boundary.
 *   2. The TTL is enforced at TAP time, not only on the next propose's sweep —
 *      a card past MENTAL_MODEL_PROPOSE_TTL_MS is refused and its keyboard is
 *      edited away, even when no fresh proposal has swept it.
 */

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// #2996 Phase 5: the callback-query handler families moved verbatim to
// gateway/callback-query-handlers.ts; these pins read the gateway source
// COMBINED with that module so the wiring assertions keep covering the
// same runtime source text.
const gatewaySrc =
  readFileSync(resolve(__dirname, '..', 'gateway', 'gateway.ts'), 'utf-8') +
  '\n' +
  readFileSync(resolve(__dirname, '..', 'gateway', 'callback-query-handlers.ts'), 'utf-8')

function proposeCallbackBlock(): string {
  return (
    gatewaySrc.split('async function handleMentalModelProposeCallback')[1]?.split('\nasync function')[0] ?? ''
  )
}

describe('handleMentalModelProposeCallback — authorization gate', () => {
  it('refuses a tap from a non-operator via the allowFrom allow-list FIRST', () => {
    const block = proposeCallbackBlock()
    expect(block).toMatch(/if \(!access\.allowFrom\.includes\(senderId\)\)/)
    expect(block).toMatch(/Not authorized/)
    // The allowFrom guard must precede the pending lookup / delete: no state
    // mutation before authorization.
    const beforeGuard = block.split('access.allowFrom.includes(senderId)')[0] ?? ''
    expect(beforeGuard).not.toMatch(/pendingMentalModelProposes\.get/)
    expect(beforeGuard).not.toMatch(/pendingMentalModelProposes\.delete/)
  })
})

describe('handleMentalModelProposeCallback — TTL enforced at tap time', () => {
  it('checks staged_at against MENTAL_MODEL_PROPOSE_TTL_MS at tap and routes through the shared expiry path', () => {
    const block = proposeCallbackBlock()
    expect(block).toMatch(/Date\.now\(\) - pending\.staged_at > MENTAL_MODEL_PROPOSE_TTL_MS/)
    // The expired branch routes through expireMentalModelProposeCard, which
    // deletes the pending entry, clears the durable store, edits the card away
    // (keyboard stripped), AND wakes the parked agent with a timeout synthetic —
    // so a stale card can't be tapped into an approval and the agent isn't left
    // parked. (The helper's delete/clear/wake behavior is pinned in
    // pending-card-durability-wiring.test.ts.)
    const ttlBranch =
      block.split('Date.now() - pending.staged_at > MENTAL_MODEL_PROPOSE_TTL_MS')[1]?.split('Single-shot')[0] ?? ''
    expect(ttlBranch).toMatch(/expireMentalModelProposeCard\(stageId, pending, Date\.now\(\)\)/)
    expect(ttlBranch).toMatch(/expired/)
  })
})

describe('executeMentalModelPropose — schema caps enforced up-front', () => {
  it('rejects an over-length source_query and an over-cap max_tokens before posting a card', () => {
    const fn =
      gatewaySrc.split('async function executeMentalModelPropose')[1]?.split('\nasync function')[0] ?? ''
    expect(fn).toMatch(/source_query\.length > MENTAL_MODEL_SOURCE_QUERY_MAX/)
    expect(fn).toMatch(/n > MENTAL_MODEL_MAX_TOKENS_CAP/)
    // Caps mirror the schema (src/config/schema.ts): 2000 / 8192.
    expect(gatewaySrc).toMatch(/MENTAL_MODEL_SOURCE_QUERY_MAX = 2000/)
    expect(gatewaySrc).toMatch(/MENTAL_MODEL_MAX_TOKENS_CAP = 8192/)
  })
})
