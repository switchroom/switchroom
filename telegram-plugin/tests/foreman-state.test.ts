/**
 * Tests for telegram-plugin/foreman/state.ts — SQLite-backed conversation state.
 *
 * Uses bun:test (not vitest) because it imports bun:sqlite.
 * Run with: bun test telegram-plugin/tests/foreman-state.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'

// We override SWITCHROOM_FOREMAN_DIR before importing state so each test
// gets a fresh DB in a temp directory.

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(tmpdir() + '/foreman-state-test-')
  process.env.SWITCHROOM_FOREMAN_DIR = tmpDir
})

afterEach(async () => {
  // Must reset the DB singleton between tests so the next test gets a fresh one
  const { _resetDbForTest } = await import('../foreman/state.js')
  _resetDbForTest()
  delete process.env.SWITCHROOM_FOREMAN_DIR
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

// ─── Round-trip: setState + getState ─────────────────────────────────────

describe('foreman-state: setState + getState round-trip', () => {
  it('returns null for unknown chat', async () => {
    const { getState } = await import('../foreman/state.js')
    const result = getState('unknown-chat')
    expect(result).toBeNull()
  })

  it('persists and retrieves state', async () => {
    const { setState, getState } = await import('../foreman/state.js')
    const now = Date.now()
    setState({
      chatId: 'chat-1',
      step: 'asked-name',
      name: null,
      profile: null,
      botToken: null,
      authSessionName: null,
      loginUrl: null,
      startedAt: now,
      updatedAt: now,
    })
    const retrieved = getState('chat-1')
    expect(retrieved).not.toBeNull()
    expect(retrieved!.chatId).toBe('chat-1')
    expect(retrieved!.step).toBe('asked-name')
    expect(retrieved!.name).toBeNull()
    expect(retrieved!.startedAt).toBe(now)
  })

  it('persists all fields', async () => {
    const { setState, getState } = await import('../foreman/state.js')
    const now = Date.now()
    setState({
      chatId: 'chat-2',
      step: 'asked-oauth-code',
      name: 'gymbro',
      profile: 'health-coach',
      botToken: '1234567890:AAH...',
      authSessionName: 'gymbro-auth-session',
      loginUrl: 'https://example.com/oauth',
      startedAt: now - 5000,
      updatedAt: now,
    })
    const retrieved = getState('chat-2')
    expect(retrieved!.step).toBe('asked-oauth-code')
    expect(retrieved!.name).toBe('gymbro')
    expect(retrieved!.profile).toBe('health-coach')
    expect(retrieved!.botToken).toBe('1234567890:AAH...')
    expect(retrieved!.authSessionName).toBe('gymbro-auth-session')
    expect(retrieved!.loginUrl).toBe('https://example.com/oauth')
  })

  it('upserts on conflict (same chat_id)', async () => {
    const { setState, getState } = await import('../foreman/state.js')
    const now = Date.now()
    setState({ chatId: 'chat-3', step: 'asked-name', name: null, profile: null, botToken: null, authSessionName: null, loginUrl: null, startedAt: now, updatedAt: now })
    setState({ chatId: 'chat-3', step: 'asked-profile', name: 'gymbro', profile: null, botToken: null, authSessionName: null, loginUrl: null, startedAt: now, updatedAt: now + 100 })

    const retrieved = getState('chat-3')
    expect(retrieved!.step).toBe('asked-profile')
    expect(retrieved!.name).toBe('gymbro')
  })
})

// ─── clearState ───────────────────────────────────────────────────────────

describe('foreman-state: clearState', () => {
  it('removes state so getState returns null', async () => {
    const { setState, getState, clearState } = await import('../foreman/state.js')
    const now = Date.now()
    setState({ chatId: 'chat-4', step: 'asked-name', name: null, profile: null, botToken: null, authSessionName: null, loginUrl: null, startedAt: now, updatedAt: now })
    clearState('chat-4')
    expect(getState('chat-4')).toBeNull()
  })

  it('is idempotent on unknown chat', async () => {
    const { clearState } = await import('../foreman/state.js')
    expect(() => clearState('nonexistent-chat')).not.toThrow()
  })
})

// ─── listActiveFlows ──────────────────────────────────────────────────────

describe('foreman-state: listActiveFlows', () => {
  it('returns empty when no flows', async () => {
    const { listActiveFlows } = await import('../foreman/state.js')
    expect(listActiveFlows()).toHaveLength(0)
  })

  it('returns in-progress flows updated within window', async () => {
    const { setState, listActiveFlows } = await import('../foreman/state.js')
    const now = Date.now()
    setState({ chatId: 'chat-5', step: 'asked-bot-token', name: 'gymbro', profile: 'health-coach', botToken: null, authSessionName: null, loginUrl: null, startedAt: now - 1000, updatedAt: now - 500 })

    const flows = listActiveFlows(60 * 60 * 1000)
    expect(flows).toHaveLength(1)
    expect(flows[0].chatId).toBe('chat-5')
    expect(flows[0].step).toBe('asked-bot-token')
  })

  it('excludes flows with step=done', async () => {
    const { setState, listActiveFlows } = await import('../foreman/state.js')
    const now = Date.now()
    setState({ chatId: 'chat-6', step: 'done', name: 'gymbro', profile: null, botToken: null, authSessionName: null, loginUrl: null, startedAt: now - 1000, updatedAt: now - 500 })

    const flows = listActiveFlows(60 * 60 * 1000)
    const match = flows.find(f => f.chatId === 'chat-6')
    expect(match).toBeUndefined()
  })

  it('excludes flows older than maxAgeMs', async () => {
    const { setState, listActiveFlows } = await import('../foreman/state.js')
    const now = Date.now()
    // updated_at is 2 hours ago
    setState({ chatId: 'chat-7', step: 'asked-oauth-code', name: 'gymbro', profile: null, botToken: null, authSessionName: null, loginUrl: null, startedAt: now - 2 * 3600 * 1000, updatedAt: now - 2 * 3600 * 1000 })

    const flows = listActiveFlows(60 * 60 * 1000) // 1 hour window
    const match = flows.find(f => f.chatId === 'chat-7')
    expect(match).toBeUndefined()
  })

  it('returns multiple in-progress flows', async () => {
    const { setState, listActiveFlows } = await import('../foreman/state.js')
    const now = Date.now()
    setState({ chatId: 'chat-8', step: 'asked-name', name: null, profile: null, botToken: null, authSessionName: null, loginUrl: null, startedAt: now, updatedAt: now })
    setState({ chatId: 'chat-9', step: 'asked-profile', name: 'agent2', profile: null, botToken: null, authSessionName: null, loginUrl: null, startedAt: now, updatedAt: now })

    const flows = listActiveFlows()
    const chatIds = flows.map(f => f.chatId)
    expect(chatIds).toContain('chat-8')
    expect(chatIds).toContain('chat-9')
  })
})
