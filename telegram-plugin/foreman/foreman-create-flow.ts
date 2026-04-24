/**
 * Pure create-agent flow state machine — extracted from foreman.ts for
 * testability. No grammY imports, no SQLite imports, no side effects.
 *
 * Each function takes current state + input and returns an Action
 * (what the foreman should do next). foreman.ts interprets actions
 * by calling the actual SQLite / grammY / orchestrator APIs.
 *
 * Steps:
 *   start                  → asked-name  (when no name given)
 *                          → asked-profile (when name provided inline)
 *   asked-name  + text     → asked-profile (if valid name)
 *   asked-profile + text   → asked-bot-token (if valid profile)
 *   asked-bot-token + text → asked-oauth-code (after createAgent())
 *   asked-oauth-code + text → done (after completeCreation())
 */

import type { CreateFlowState, CreateFlowStep } from './state.js'

// ─── Action types ────────────────────────────────────────────────────────

export type CreateFlowAction =
  | { kind: 'ask-name' }
  | { kind: 'ask-profile'; profiles: string[] }
  | { kind: 'ask-bot-token'; name: string; profile: string }
  | { kind: 'call-create-agent'; name: string; profile: string; botToken: string }
  | { kind: 'ask-oauth-code'; loginUrl: string; name: string }
  | { kind: 'call-complete-creation'; name: string; code: string }
  | { kind: 'done'; name: string; botUsername: string | null }
  | { kind: 'error'; message: string; stayInStep: boolean }
  | { kind: 'cancel'; reason: string }

// ─── Name validation (mirrors assertSafeAgentName) ───────────────────────

export function isValidAgentName(name: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,50}$/.test(name)
}

// ─── Flow entry point ────────────────────────────────────────────────────

/**
 * Start or resume a /create-agent flow.
 *
 * @param inlineName  Optional name from the command args (/create-agent gymbro)
 * @param profiles    Available profile names (from listAvailableProfiles())
 * @returns Action to perform
 */
export function startCreateFlow(
  inlineName: string | null,
  profiles: string[],
): CreateFlowAction {
  if (!inlineName) {
    return { kind: 'ask-name' }
  }

  if (!isValidAgentName(inlineName)) {
    return {
      kind: 'error',
      message: `"${inlineName}" is not a valid agent name. Names must be lowercase, alphanumeric, hyphens or underscores, max 51 chars.`,
      stayInStep: false,
    }
  }

  return { kind: 'ask-profile', profiles }
}

// ─── Step transition: handle inbound text for current step ───────────────

export interface StepTransitionInput {
  /** Current persisted state (or null if no state yet). */
  state: CreateFlowState | null
  /** The text the user sent. */
  text: string
  /** Available profiles (for profile validation). */
  profiles: string[]
}

/**
 * Given the current state and user text, compute the next action.
 * The caller (foreman.ts) is responsible for persisting state changes
 * and executing the returned action.
 */
export function handleFlowText(input: StepTransitionInput): CreateFlowAction {
  const { state, text, profiles } = input
  const trimmed = text.trim()

  if (!state) {
    // No active flow — ignore
    return { kind: 'cancel', reason: 'no-active-flow' }
  }

  switch (state.step) {
    case 'asked-name': {
      if (!isValidAgentName(trimmed)) {
        return {
          kind: 'error',
          message: `"${trimmed}" is not a valid agent name. Names must be lowercase, alphanumeric, hyphens or underscores, max 51 chars. Try again:`,
          stayInStep: true,
        }
      }
      return { kind: 'ask-profile', profiles }
    }

    case 'asked-profile': {
      if (!profiles.includes(trimmed)) {
        return {
          kind: 'error',
          message: `Unknown profile "${trimmed}". Choose one of: ${profiles.join(', ')}`,
          stayInStep: true,
        }
      }
      const name = state.name ?? trimmed // name was set when we transitioned here
      return { kind: 'ask-bot-token', name, profile: trimmed }
    }

    case 'asked-bot-token': {
      const name = state.name ?? ''
      const profile = state.profile ?? ''
      if (!name || !profile) {
        return { kind: 'cancel', reason: 'missing-name-or-profile' }
      }
      // Basic bot token shape check (foreman.ts validates via Telegram API)
      if (!trimmed.includes(':') || trimmed.length < 20) {
        return {
          kind: 'error',
          message: "That doesn't look like a BotFather token. It should be in the form <code>1234567890:AAH...</code> — try again:",
          stayInStep: true,
        }
      }
      return { kind: 'call-create-agent', name, profile, botToken: trimmed }
    }

    case 'asked-oauth-code': {
      const name = state.name ?? ''
      if (!name) return { kind: 'cancel', reason: 'missing-name' }
      // Codes are typically 8+ alphanumeric chars; pass through for server validation
      if (trimmed.length < 4) {
        return {
          kind: 'error',
          message: 'That code looks too short. Paste the full code from the browser:',
          stayInStep: true,
        }
      }
      return { kind: 'call-complete-creation', name, code: trimmed }
    }

    case 'done':
      return { kind: 'cancel', reason: 'flow-already-done' }

    default: {
      const _exhaustive: never = state.step
      return { kind: 'cancel', reason: `unknown-step:${_exhaustive}` }
    }
  }
}

// ─── State factory helpers (for foreman.ts to build new state objects) ───

export function makeInitialState(chatId: string, name: string | null): CreateFlowState {
  const now = Date.now()
  return {
    chatId,
    step: name ? 'asked-profile' : 'asked-name',
    name,
    profile: null,
    botToken: null,
    authSessionName: null,
    loginUrl: null,
    startedAt: now,
    updatedAt: now,
  }
}

export function advanceState(
  state: CreateFlowState,
  updates: Partial<Omit<CreateFlowState, 'chatId' | 'startedAt'>>,
): CreateFlowState {
  return {
    ...state,
    ...updates,
    updatedAt: Date.now(),
  }
}

/** Compute the human-readable step label for recovery messages. */
export function stepLabel(step: CreateFlowStep): string {
  switch (step) {
    case 'asked-name': return 'waiting for agent name'
    case 'asked-profile': return 'waiting for profile selection'
    case 'asked-bot-token': return 'waiting for BotFather token'
    case 'asked-oauth-code': return 'waiting for OAuth code'
    case 'done': return 'done'
  }
}
