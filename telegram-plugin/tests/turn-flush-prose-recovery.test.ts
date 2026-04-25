/**
 * Tests for the prose-recovery helper used by the turn-flush backstop
 * to bridge the divergence between the gateway's `capturedText`
 * accumulator and the progress-card driver's narrative state. See #51.
 */

import { describe, it, expect } from 'vitest'
import type { ProgressCardState, NarrativeStep } from '../progress-card.js'
import { recoverProseFromProgressCard } from '../turn-flush-prose-recovery.js'

function narrative(id: number, text: string): NarrativeStep {
  return { id, text, state: 'done', startedAt: 0, toolCount: 0 }
}

function stateWith(narratives: NarrativeStep[]): ProgressCardState {
  return {
    turnStartedAt: 0,
    items: [],
    stage: 'idle',
    thinking: false,
    narratives,
    subAgents: new Map(),
    pendingAgentSpawns: new Map(),
  } as unknown as ProgressCardState
}

describe('recoverProseFromProgressCard', () => {
  it('returns empty string for undefined state', () => {
    expect(recoverProseFromProgressCard(undefined)).toBe('')
  })

  it('returns empty string when there are no narratives', () => {
    expect(recoverProseFromProgressCard(stateWith([]))).toBe('')
  })

  it('joins narrative text in order, newline-separated', () => {
    const state = stateWith([
      narrative(1, 'Reading the file.'),
      narrative(2, 'Found the issue.'),
      narrative(3, 'Patching gateway.ts.'),
    ])
    expect(recoverProseFromProgressCard(state)).toBe(
      'Reading the file.\nFound the issue.\nPatching gateway.ts.',
    )
  })

  it('skips empty-string narratives but preserves order of the rest', () => {
    const state = stateWith([
      narrative(1, 'first'),
      narrative(2, ''),
      narrative(3, 'third'),
    ])
    expect(recoverProseFromProgressCard(state)).toBe('first\nthird')
  })

  it('trims surrounding whitespace from the joined result', () => {
    const state = stateWith([narrative(1, '   prose with edges   ')])
    expect(recoverProseFromProgressCard(state)).toBe('prose with edges')
  })

  it('recovers the original incident — single narrative line that should have flushed', () => {
    // Mirrors the #45/#51 incident transcript: the assistant emitted
    // prose-as-step but never called reply. Recovery must surface that
    // text so the flush backstop can send it.
    const state = stateWith([
      narrative(1, 'Just the caption swap — the Klanker body stays.'),
    ])
    expect(recoverProseFromProgressCard(state)).toBe(
      'Just the caption swap — the Klanker body stays.',
    )
  })
})
