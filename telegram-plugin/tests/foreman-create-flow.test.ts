/**
 * Tests for the create-agent flow state machine (foreman-create-flow.ts).
 *
 * Pure function tests — no grammY, no SQLite, no network.
 *
 * Covers:
 *   - startCreateFlow: valid/invalid name, inline name, no name
 *   - handleFlowText: step transitions (asked-name → asked-profile → asked-bot-token → ...)
 *   - Error paths: invalid name, unknown profile, bad token shape, short code
 *   - makeInitialState / advanceState / stepLabel helpers
 */

import { describe, it, expect } from 'vitest'
import {
  startCreateFlow,
  handleFlowText,
  makeInitialState,
  advanceState,
  stepLabel,
  isValidAgentName,
} from '../foreman/foreman-create-flow.js'
import type { CreateFlowState } from '../foreman/state.js'

const PROFILES = ['default', 'health-coach', 'coding-assistant']

// ─── isValidAgentName ─────────────────────────────────────────────────────

describe('foreman-create-flow: isValidAgentName', () => {
  it('accepts lowercase simple name', () => expect(isValidAgentName('gymbro')).toBe(true))
  it('accepts name with hyphens', () => expect(isValidAgentName('my-agent')).toBe(true))
  it('accepts name with underscores', () => expect(isValidAgentName('my_agent')).toBe(true))
  it('accepts name starting with digit', () => expect(isValidAgentName('1agent')).toBe(true))
  it('rejects uppercase', () => expect(isValidAgentName('Gymbro')).toBe(false))
  it('rejects empty string', () => expect(isValidAgentName('')).toBe(false))
  it('rejects spaces', () => expect(isValidAgentName('my agent')).toBe(false))
  it('rejects semicolon', () => expect(isValidAgentName('agent; evil')).toBe(false))
  it('accepts 51-char name', () => expect(isValidAgentName('a'.repeat(51))).toBe(true))
  it('rejects 52-char name', () => expect(isValidAgentName('a'.repeat(52))).toBe(false))
})

// ─── startCreateFlow ──────────────────────────────────────────────────────

describe('foreman-create-flow: startCreateFlow', () => {
  it('asks for name when no inline name given', () => {
    const action = startCreateFlow(null, PROFILES)
    expect(action.kind).toBe('ask-name')
  })

  it('asks for profile when valid inline name given', () => {
    const action = startCreateFlow('gymbro', PROFILES)
    expect(action.kind).toBe('ask-profile')
    if (action.kind === 'ask-profile') {
      expect(action.profiles).toEqual(PROFILES)
    }
  })

  it('returns error when inline name is invalid', () => {
    const action = startCreateFlow('Bad Name!', PROFILES)
    expect(action.kind).toBe('error')
    if (action.kind === 'error') {
      expect(action.message).toContain('Bad Name!')
      expect(action.stayInStep).toBe(false)
    }
  })

  it('returns error for uppercase inline name', () => {
    const action = startCreateFlow('MyAgent', PROFILES)
    expect(action.kind).toBe('error')
  })
})

// ─── handleFlowText — null state ─────────────────────────────────────────

describe('foreman-create-flow: handleFlowText with null state', () => {
  it('cancels when no active flow', () => {
    const action = handleFlowText({ state: null, text: 'hello', profiles: PROFILES })
    expect(action.kind).toBe('cancel')
  })
})

// ─── handleFlowText — asked-name step ────────────────────────────────────

describe('foreman-create-flow: handleFlowText step=asked-name', () => {
  function makeState(): CreateFlowState {
    return makeInitialState('chat-1', null) // step = 'asked-name'
  }

  it('transitions to ask-profile on valid name', () => {
    const action = handleFlowText({ state: makeState(), text: 'gymbro', profiles: PROFILES })
    expect(action.kind).toBe('ask-profile')
    if (action.kind === 'ask-profile') {
      expect(action.profiles).toEqual(PROFILES)
    }
  })

  it('returns error on invalid name, stayInStep=true', () => {
    const action = handleFlowText({ state: makeState(), text: 'Bad Name!', profiles: PROFILES })
    expect(action.kind).toBe('error')
    if (action.kind === 'error') {
      expect(action.stayInStep).toBe(true)
    }
  })

  it('error message mentions the bad input', () => {
    const action = handleFlowText({ state: makeState(), text: 'MyBotIsGreat', profiles: PROFILES })
    if (action.kind === 'error') {
      expect(action.message).toContain('MyBotIsGreat')
    }
  })

  it('accepts name with hyphens', () => {
    const action = handleFlowText({ state: makeState(), text: 'my-agent', profiles: PROFILES })
    expect(action.kind).toBe('ask-profile')
  })
})

// ─── handleFlowText — asked-profile step ──────────────────────────────────

describe('foreman-create-flow: handleFlowText step=asked-profile', () => {
  function makeState(name = 'gymbro'): CreateFlowState {
    return {
      chatId: 'chat-1',
      step: 'asked-profile',
      name,
      profile: null,
      botToken: null,
      authSessionName: null,
      loginUrl: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }
  }

  it('transitions to ask-bot-token on valid profile', () => {
    const action = handleFlowText({ state: makeState(), text: 'health-coach', profiles: PROFILES })
    expect(action.kind).toBe('ask-bot-token')
    if (action.kind === 'ask-bot-token') {
      expect(action.profile).toBe('health-coach')
      expect(action.name).toBe('gymbro')
    }
  })

  it('returns error on unknown profile, stayInStep=true', () => {
    const action = handleFlowText({ state: makeState(), text: 'nonexistent-profile', profiles: PROFILES })
    expect(action.kind).toBe('error')
    if (action.kind === 'error') {
      expect(action.stayInStep).toBe(true)
      expect(action.message).toContain('nonexistent-profile')
    }
  })

  it('lists valid profiles in error message', () => {
    const action = handleFlowText({ state: makeState(), text: 'bad', profiles: PROFILES })
    if (action.kind === 'error') {
      for (const p of PROFILES) {
        expect(action.message).toContain(p)
      }
    }
  })

  it('cancels with missing-name when state.name is unset (#28 item 1)', () => {
    // Pre-#28 fix this fell back to using the profile name as the agent
    // name. Now we cancel cleanly so the user gets a clear restart
    // signal instead of an agent named "default".
    const stateNoName = {
      chatId: 'chat-1',
      step: 'asked-profile' as const,
      name: null,
      profile: null,
      botToken: null,
      authSessionName: null,
      loginUrl: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }
    const action = handleFlowText({ state: stateNoName, text: 'default', profiles: PROFILES })
    expect(action.kind).toBe('cancel')
    if (action.kind === 'cancel') {
      expect(action.reason).toBe('missing-name')
    }
  })
})

// ─── handleFlowText — asked-bot-token step ───────────────────────────────

describe('foreman-create-flow: handleFlowText step=asked-bot-token', () => {
  function makeState(): CreateFlowState {
    return {
      chatId: 'chat-1',
      step: 'asked-bot-token',
      name: 'gymbro',
      profile: 'health-coach',
      botToken: null,
      authSessionName: null,
      loginUrl: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }
  }

  it('transitions to call-create-agent on token-shaped input', () => {
    const token = '1234567890:AAHaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    const action = handleFlowText({ state: makeState(), text: token, profiles: PROFILES })
    expect(action.kind).toBe('call-create-agent')
    if (action.kind === 'call-create-agent') {
      expect(action.botToken).toBe(token)
      expect(action.name).toBe('gymbro')
      expect(action.profile).toBe('health-coach')
    }
  })

  it('returns error on token with no colon, stayInStep=true', () => {
    const action = handleFlowText({ state: makeState(), text: 'notavalidtoken', profiles: PROFILES })
    expect(action.kind).toBe('error')
    if (action.kind === 'error') {
      expect(action.stayInStep).toBe(true)
    }
  })

  it('returns error on token too short', () => {
    const action = handleFlowText({ state: makeState(), text: 'a:b', profiles: PROFILES })
    expect(action.kind).toBe('error')
    if (action.kind === 'error') {
      expect(action.stayInStep).toBe(true)
    }
  })

  it('cancels if name or profile missing in state', () => {
    const state: CreateFlowState = {
      ...makeState(),
      name: null,
    }
    const action = handleFlowText({ state, text: '1234567890:AAHsomething', profiles: PROFILES })
    expect(action.kind).toBe('cancel')
  })
})

// ─── handleFlowText — asked-oauth-code step ──────────────────────────────

describe('foreman-create-flow: handleFlowText step=asked-oauth-code', () => {
  function makeState(): CreateFlowState {
    return {
      chatId: 'chat-1',
      step: 'asked-oauth-code',
      name: 'gymbro',
      profile: 'health-coach',
      botToken: '1234567890:AAHsomething',
      authSessionName: 'gymbro-auth-123',
      loginUrl: 'https://claude.ai/oauth/authorize?...',
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }
  }

  it('transitions to call-complete-creation on plausible code', () => {
    const action = handleFlowText({ state: makeState(), text: 'abc12345', profiles: PROFILES })
    expect(action.kind).toBe('call-complete-creation')
    if (action.kind === 'call-complete-creation') {
      expect(action.name).toBe('gymbro')
      expect(action.code).toBe('abc12345')
    }
  })

  it('returns error on code that is too short, stayInStep=true', () => {
    const action = handleFlowText({ state: makeState(), text: 'ab', profiles: PROFILES })
    expect(action.kind).toBe('error')
    if (action.kind === 'error') {
      expect(action.stayInStep).toBe(true)
    }
  })

  it('cancels if name missing in state', () => {
    const state: CreateFlowState = { ...makeState(), name: null }
    const action = handleFlowText({ state, text: 'abc12345', profiles: PROFILES })
    expect(action.kind).toBe('cancel')
  })
})

// ─── handleFlowText — done step ──────────────────────────────────────────

describe('foreman-create-flow: handleFlowText step=done', () => {
  it('returns cancel when flow is already done', () => {
    const state: CreateFlowState = {
      chatId: 'chat-1',
      step: 'done',
      name: 'gymbro',
      profile: 'health-coach',
      botToken: null,
      authSessionName: null,
      loginUrl: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    }
    const action = handleFlowText({ state, text: 'hello', profiles: PROFILES })
    expect(action.kind).toBe('cancel')
  })
})

// ─── makeInitialState ─────────────────────────────────────────────────────

describe('foreman-create-flow: makeInitialState', () => {
  it('sets step to asked-name when name is null', () => {
    const state = makeInitialState('chat-1', null)
    expect(state.step).toBe('asked-name')
    expect(state.name).toBeNull()
  })

  it('sets step to asked-profile when name provided', () => {
    const state = makeInitialState('chat-1', 'gymbro')
    expect(state.step).toBe('asked-profile')
    expect(state.name).toBe('gymbro')
  })

  it('sets startedAt and updatedAt', () => {
    const before = Date.now()
    const state = makeInitialState('chat-1', null)
    const after = Date.now()
    expect(state.startedAt).toBeGreaterThanOrEqual(before)
    expect(state.startedAt).toBeLessThanOrEqual(after)
    expect(state.updatedAt).toBe(state.startedAt)
  })
})

// ─── advanceState ─────────────────────────────────────────────────────────

describe('foreman-create-flow: advanceState', () => {
  it('merges updates into state', () => {
    const state = makeInitialState('chat-1', 'gymbro')
    const next = advanceState(state, { step: 'asked-bot-token', profile: 'health-coach' })
    expect(next.step).toBe('asked-bot-token')
    expect(next.profile).toBe('health-coach')
    expect(next.name).toBe('gymbro')
    expect(next.chatId).toBe('chat-1')
  })

  it('updates updatedAt', () => {
    const state = makeInitialState('chat-1', null)
    const before = Date.now()
    const next = advanceState(state, { step: 'asked-profile', name: 'gymbro' })
    expect(next.updatedAt).toBeGreaterThanOrEqual(before)
  })

  it('preserves startedAt', () => {
    const state = makeInitialState('chat-1', null)
    const next = advanceState(state, { step: 'asked-profile' })
    expect(next.startedAt).toBe(state.startedAt)
  })
})

// ─── stepLabel ────────────────────────────────────────────────────────────

describe('foreman-create-flow: stepLabel', () => {
  it('returns a non-empty string for each step', () => {
    const steps = ['asked-name', 'asked-profile', 'asked-bot-token', 'asked-oauth-code', 'done'] as const
    for (const step of steps) {
      expect(stepLabel(step).length).toBeGreaterThan(0)
    }
  })
})
