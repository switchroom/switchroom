/**
 * `/auth` CLI-vernacular alignment coverage (RFC H Decision 11 —
 * "same shape on the CLI and in Telegram").
 *
 * Pins the post-/auth-add verb tree that mirrors `switchroom auth`:
 *
 *   list / show [<agent>] / rm <label> [confirm] / refresh [<label>]
 *   / agent override <agent> <label|clear> / help
 *
 * The headline guarantees:
 *
 *   1. Every verb resolves through the pure parser to the right
 *      ParsedAuthCommand kind (no I/O in `parseAuthCommand`).
 *   2. Read verbs (`show`, `list`, `show <agent>`, `help`) are open
 *      to any agent; mutating verbs are admin-gated.
 *   3. The `rm` two-step confirm is paired by chat id + label and
 *      respects the 60s TTL.
 *   4. `rm` refuses to even prompt when the label is the fleet active
 *      (broker enforces too, but the chat surface short-circuits for
 *      a cleaner error).
 *   5. `refresh` (no label) iterates every known account, once each.
 *   6. `override` set vs clear translates the chat-ergonomic `clear`
 *      keyword to a `null` broker argument.
 *   7. Help text lists every verb (string-contains).
 *
 * Sibling to `auth-add-flow.test.ts` — keeps the new surface's tests
 * scoped to a dedicated file rather than ballooning that one further.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'

import {
  parseAuthCommand,
  handleAuthCommand,
  pendingAuthRmFlows,
  AUTH_RM_CONFIRM_TTL_MS,
  type AuthBrokerClient,
  type ListStateData,
} from '../gateway/auth-command.js'

/* ── Fixture builders ─────────────────────────────────────────────────── */

function fakeState(over: Partial<ListStateData> = {}): ListStateData {
  return {
    active: 'primary',
    fallback_order: ['primary', 'spare'],
    accounts: [
      {
        label: 'primary',
        expiresAt: Date.now() + 6 * 3600_000,
        exhausted: false,
        last_refreshed_at: Date.now() - 600_000,
      },
      {
        label: 'spare',
        expiresAt: Date.now() + 4 * 3600_000,
        exhausted: false,
      },
    ],
    agents: [
      { name: 'clerk', account: 'primary', override: null },
      { name: 'researcher', account: 'spare', override: 'spare' },
    ],
    consumers: [],
    ...over,
  }
}

interface MockClient extends AuthBrokerClient {
  listState: ReturnType<typeof vi.fn>
  setActive: ReturnType<typeof vi.fn>
  rmAccount: ReturnType<typeof vi.fn>
  refreshAccount: ReturnType<typeof vi.fn>
  setOverride: ReturnType<typeof vi.fn>
}

function mockClient(state: ListStateData = fakeState()): MockClient {
  return {
    listState: vi.fn().mockResolvedValue(state),
    setActive: vi.fn().mockResolvedValue({ active: 'spare', fanned: ['clerk'] }),
    rmAccount: vi.fn().mockImplementation(async (label: string) => ({ label })),
    refreshAccount: vi.fn().mockImplementation(async (label: string) => ({
      account: label,
      expiresAt: Date.now() + 8 * 3600_000,
    })),
    setOverride: vi
      .fn()
      .mockImplementation(async (agent: string, account: string | null) => ({
        agent,
        account,
      })),
  }
}

beforeEach(() => {
  pendingAuthRmFlows.clear()
})

/* ── 1. Parser ────────────────────────────────────────────────────────── */

describe('parseAuthCommand — new verbs', () => {
  it('parses /auth list as { kind: "list" }', () => {
    expect(parseAuthCommand('/auth list')).toEqual({ kind: 'list' })
  })

  it('parses /auth show <agent> as { kind: "show", agent }', () => {
    expect(parseAuthCommand('/auth show clerk')).toEqual({
      kind: 'show',
      agent: 'clerk',
    })
  })

  it('bare /auth show stays kindshow with no agent field set', () => {
    const p = parseAuthCommand('/auth show')
    expect(p?.kind).toBe('show')
    expect((p as { agent?: string }).agent).toBeUndefined()
  })

  it('parses /auth rm <label> as rm-prompt', () => {
    expect(parseAuthCommand('/auth rm spare')).toEqual({
      kind: 'rm-prompt',
      label: 'spare',
    })
  })

  it('parses /auth rm <label> confirm as rm-confirmed (case-insensitive)', () => {
    expect(parseAuthCommand('/auth rm spare confirm')).toEqual({
      kind: 'rm-confirmed',
      label: 'spare',
    })
    expect(parseAuthCommand('/auth rm spare CONFIRM')).toEqual({
      kind: 'rm-confirmed',
      label: 'spare',
    })
  })

  it('rejects /auth rm <label> <bogus> with a help reason', () => {
    const p = parseAuthCommand('/auth rm spare yesplease')
    expect(p?.kind).toBe('help')
    expect((p as { reason?: string }).reason).toMatch(/confirm/i)
  })

  it('rejects /auth rm with no label', () => {
    const p = parseAuthCommand('/auth rm')
    expect(p?.kind).toBe('help')
    expect((p as { reason?: string }).reason).toMatch(/usage/i)
  })

  it('parses /auth refresh (no label)', () => {
    expect(parseAuthCommand('/auth refresh')).toEqual({ kind: 'refresh' })
  })

  it('parses /auth refresh <label>', () => {
    expect(parseAuthCommand('/auth refresh primary')).toEqual({
      kind: 'refresh',
      label: 'primary',
    })
  })

  it('parses /auth agent override <agent> <label>', () => {
    expect(parseAuthCommand('/auth agent override clerk primary')).toEqual({
      kind: 'override-set',
      agent: 'clerk',
      label: 'primary',
    })
  })

  it('parses /auth agent override <agent> clear as override-clear', () => {
    expect(parseAuthCommand('/auth agent override clerk clear')).toEqual({
      kind: 'override-clear',
      agent: 'clerk',
    })
    // case-insensitive
    expect(parseAuthCommand('/auth agent override clerk CLEAR')).toEqual({
      kind: 'override-clear',
      agent: 'clerk',
    })
  })

  it('rejects /auth agent override with missing args', () => {
    const a = parseAuthCommand('/auth agent override')
    const b = parseAuthCommand('/auth agent override clerk')
    expect(a?.kind).toBe('help')
    expect(b?.kind).toBe('help')
  })

  it('rejects /auth agent <unknown-sub>', () => {
    const p = parseAuthCommand('/auth agent pin clerk primary')
    expect(p?.kind).toBe('help')
    expect((p as { reason?: string }).reason).toMatch(/override/i)
  })

  it('parses /auth help explicitly', () => {
    expect(parseAuthCommand('/auth help')).toEqual({ kind: 'help' })
  })

  it('routes unknown verbs to help with a reason', () => {
    const p = parseAuthCommand('/auth nonsense')
    expect(p?.kind).toBe('help')
    expect((p as { reason?: string }).reason).toMatch(/unknown/i)
  })

  it('tolerates extra whitespace and bot-suffix', () => {
    expect(parseAuthCommand('   /auth   list  ')).toEqual({ kind: 'list' })
    expect(parseAuthCommand('/auth@switchroombot list')).toEqual({ kind: 'list' })
    expect(parseAuthCommand('/auth\tshow\tclerk')).toEqual({
      kind: 'show',
      agent: 'clerk',
    })
  })

  it('is case-insensitive on the verb', () => {
    expect(parseAuthCommand('/auth LIST')?.kind).toBe('list')
    expect(parseAuthCommand('/auth REFRESH')?.kind).toBe('refresh')
    expect(parseAuthCommand('/auth Agent OVERRIDE clerk clear')).toEqual({
      kind: 'override-clear',
      agent: 'clerk',
    })
  })
})

/* ── 2. Read-verb open access ─────────────────────────────────────────── */

describe('handleAuthCommand — read verbs are open to any agent', () => {
  it('/auth list renders the fleet snapshot without an admin gate', async () => {
    const client = mockClient()
    const reply = await handleAuthCommand(
      { kind: 'list' },
      { agentName: 'random-agent', adminAgents: ['someone-else'], client },
    )
    expect(reply.html).toBe(true)
    expect(reply.text).toMatch(/Auth — fleet snapshot/)
    expect(reply.text).not.toMatch(/Not authorized/i)
    expect(client.listState).toHaveBeenCalledTimes(1)
  })

  it('/auth show <agent> renders per-agent detail for any agent', async () => {
    const client = mockClient()
    const reply = await handleAuthCommand(
      { kind: 'show', agent: 'researcher' },
      { agentName: 'random', adminAgents: [], client },
    )
    expect(reply.text).toMatch(/researcher/)
    expect(reply.text).toMatch(/override/)
    expect(reply.text).toMatch(/spare/)
  })

  it('/auth show <unknown-agent> returns a friendly error', async () => {
    const client = mockClient()
    const reply = await handleAuthCommand(
      { kind: 'show', agent: 'ghost' },
      { agentName: 'random', adminAgents: [], client },
    )
    expect(reply.text).toMatch(/no agent named/i)
    expect(reply.text).toMatch(/ghost/)
  })
})

/* ── 3. Admin gating ──────────────────────────────────────────────────── */

describe('handleAuthCommand — admin gating', () => {
  const nonAdmin = { agentName: 'snooper', adminAgents: ['clerk'] as string[] }

  it('refuses /auth rm <label> for non-admin', async () => {
    const client = mockClient()
    const reply = await handleAuthCommand(
      { kind: 'rm-prompt', label: 'spare' },
      { ...nonAdmin, client },
    )
    expect(reply.text).toMatch(/Not authorized/i)
    expect(client.listState).not.toHaveBeenCalled()
  })

  it('refuses /auth rm <label> confirm for non-admin', async () => {
    const client = mockClient()
    const reply = await handleAuthCommand(
      { kind: 'rm-confirmed', label: 'spare' },
      { ...nonAdmin, client },
    )
    expect(reply.text).toMatch(/Not authorized/i)
    expect(client.rmAccount).not.toHaveBeenCalled()
  })

  it('refuses /auth refresh for non-admin', async () => {
    const client = mockClient()
    const reply = await handleAuthCommand(
      { kind: 'refresh' },
      { ...nonAdmin, client },
    )
    expect(reply.text).toMatch(/Not authorized/i)
    expect(client.refreshAccount).not.toHaveBeenCalled()
  })

  it('refuses /auth agent override <set> for non-admin', async () => {
    const client = mockClient()
    const reply = await handleAuthCommand(
      { kind: 'override-set', agent: 'clerk', label: 'spare' },
      { ...nonAdmin, client },
    )
    expect(reply.text).toMatch(/Not authorized/i)
    expect(client.setOverride).not.toHaveBeenCalled()
  })

  it('refuses /auth agent override <clear> for non-admin', async () => {
    const client = mockClient()
    const reply = await handleAuthCommand(
      { kind: 'override-clear', agent: 'clerk' },
      { ...nonAdmin, client },
    )
    expect(reply.text).toMatch(/Not authorized/i)
    expect(client.setOverride).not.toHaveBeenCalled()
  })
})

/* ── 4. rm two-step confirm flow ──────────────────────────────────────── */

describe('handleAuthCommand — /auth rm two-step confirm', () => {
  const admin = { agentName: 'clerk', adminAgents: ['clerk'] as string[] }

  it('prompt phase succeeds for a valid non-active label and stashes a pending entry', async () => {
    const client = mockClient()
    const reply = await handleAuthCommand(
      { kind: 'rm-prompt', label: 'spare' },
      { ...admin, client, chatId: '999' },
    )
    expect(reply.text).toMatch(/about to remove/i)
    expect(reply.text).toMatch(/spare/)
    expect(reply.text).toMatch(/confirm/i)
    expect(pendingAuthRmFlows.get('999')?.label).toBe('spare')
  })

  it('refuses to prompt when the label is unknown', async () => {
    const client = mockClient()
    const reply = await handleAuthCommand(
      { kind: 'rm-prompt', label: 'doesnotexist' },
      { ...admin, client, chatId: '999' },
    )
    expect(reply.text).toMatch(/no account named/i)
    expect(client.rmAccount).not.toHaveBeenCalled()
    expect(pendingAuthRmFlows.size).toBe(0)
  })

  it('refuses to prompt when the label is the fleet active', async () => {
    const client = mockClient()
    const reply = await handleAuthCommand(
      { kind: 'rm-prompt', label: 'primary' },
      { ...admin, client, chatId: '999' },
    )
    expect(reply.text).toMatch(/fleet active/i)
    expect(reply.text).toMatch(/use/)
    expect(client.rmAccount).not.toHaveBeenCalled()
    expect(pendingAuthRmFlows.size).toBe(0)
  })

  it('confirm phase only fires when a matching pending entry exists', async () => {
    const client = mockClient()
    // Phase 1
    await handleAuthCommand(
      { kind: 'rm-prompt', label: 'spare' },
      { ...admin, client, chatId: 'C' },
    )
    // Phase 2
    const reply = await handleAuthCommand(
      { kind: 'rm-confirmed', label: 'spare' },
      { ...admin, client, chatId: 'C' },
    )
    expect(reply.text).toMatch(/Removed/i)
    expect(client.rmAccount).toHaveBeenCalledTimes(1)
    expect(client.rmAccount).toHaveBeenCalledWith('spare')
    expect(pendingAuthRmFlows.has('C')).toBe(false)
  })

  it('confirm refuses when no prompt was issued', async () => {
    const client = mockClient()
    const reply = await handleAuthCommand(
      { kind: 'rm-confirmed', label: 'spare' },
      { ...admin, client, chatId: 'C' },
    )
    expect(reply.text).toMatch(/no pending confirm/i)
    expect(client.rmAccount).not.toHaveBeenCalled()
  })

  it('confirm refuses when the pending label does not match', async () => {
    const client = mockClient()
    pendingAuthRmFlows.set('C', {
      label: 'other-label',
      expiresAt: Date.now() + AUTH_RM_CONFIRM_TTL_MS,
    })
    const reply = await handleAuthCommand(
      { kind: 'rm-confirmed', label: 'spare' },
      { ...admin, client, chatId: 'C' },
    )
    expect(reply.text).toMatch(/no pending confirm/i)
    expect(client.rmAccount).not.toHaveBeenCalled()
  })

  it('confirm refuses when the pending entry has expired', async () => {
    const client = mockClient()
    pendingAuthRmFlows.set('C', {
      label: 'spare',
      expiresAt: Date.now() - 1, // expired
    })
    const reply = await handleAuthCommand(
      { kind: 'rm-confirmed', label: 'spare' },
      { ...admin, client, chatId: 'C' },
    )
    expect(reply.text).toMatch(/expired|no pending confirm/i)
    expect(client.rmAccount).not.toHaveBeenCalled()
    // Stale entry should be reaped.
    expect(pendingAuthRmFlows.has('C')).toBe(false)
  })

  it('TTL is the documented 60 seconds', () => {
    expect(AUTH_RM_CONFIRM_TTL_MS).toBe(60_000)
  })
})

/* ── 5. refresh ───────────────────────────────────────────────────────── */

describe('handleAuthCommand — /auth refresh', () => {
  const admin = { agentName: 'clerk', adminAgents: ['clerk'] as string[] }

  it('without a label refreshes every account, once each', async () => {
    const client = mockClient()
    const reply = await handleAuthCommand(
      { kind: 'refresh' },
      { ...admin, client },
    )
    expect(reply.text).toMatch(/Refreshed/)
    expect(client.refreshAccount).toHaveBeenCalledTimes(2)
    expect(client.refreshAccount).toHaveBeenCalledWith('primary')
    expect(client.refreshAccount).toHaveBeenCalledWith('spare')
  })

  it('with a label refreshes that account once', async () => {
    const client = mockClient()
    const reply = await handleAuthCommand(
      { kind: 'refresh', label: 'spare' },
      { ...admin, client },
    )
    expect(reply.text).toMatch(/Refreshed/)
    expect(reply.text).toMatch(/spare/)
    expect(client.refreshAccount).toHaveBeenCalledTimes(1)
    expect(client.refreshAccount).toHaveBeenCalledWith('spare')
  })

  it('with an unknown label returns a friendly error and does not call the broker', async () => {
    const client = mockClient()
    const reply = await handleAuthCommand(
      { kind: 'refresh', label: 'ghost' },
      { ...admin, client },
    )
    expect(reply.text).toMatch(/no account named/i)
    expect(client.refreshAccount).not.toHaveBeenCalled()
  })

  it('reports per-account failures without aborting the whole sweep', async () => {
    const client = mockClient()
    client.refreshAccount.mockImplementation(async (label: string) => {
      if (label === 'primary') throw new Error('rate-limited')
      return { account: label, expiresAt: Date.now() + 1000 }
    })
    const reply = await handleAuthCommand(
      { kind: 'refresh' },
      { ...admin, client },
    )
    expect(client.refreshAccount).toHaveBeenCalledTimes(2)
    expect(reply.text).toMatch(/Failures/i)
    expect(reply.text).toMatch(/rate-limited/)
  })
})

/* ── 6. override set + clear ──────────────────────────────────────────── */

describe('handleAuthCommand — /auth agent override', () => {
  const admin = { agentName: 'clerk', adminAgents: ['clerk'] as string[] }

  it('set calls setOverride(agent, label)', async () => {
    const client = mockClient()
    const reply = await handleAuthCommand(
      { kind: 'override-set', agent: 'researcher', label: 'primary' },
      { ...admin, client },
    )
    expect(client.setOverride).toHaveBeenCalledTimes(1)
    expect(client.setOverride).toHaveBeenCalledWith('researcher', 'primary')
    expect(reply.text).toMatch(/Override set/i)
    expect(reply.text).toMatch(/researcher/)
    expect(reply.text).toMatch(/primary/)
  })

  it('clear calls setOverride(agent, null) — chat "clear" → null arg', async () => {
    const client = mockClient()
    const reply = await handleAuthCommand(
      { kind: 'override-clear', agent: 'researcher' },
      { ...admin, client },
    )
    expect(client.setOverride).toHaveBeenCalledTimes(1)
    expect(client.setOverride).toHaveBeenCalledWith('researcher', null)
    expect(reply.text).toMatch(/Override cleared/i)
    expect(reply.text).toMatch(/researcher/)
  })
})

/* ── 7. help text contents ────────────────────────────────────────────── */

describe('handleAuthCommand — help text lists every verb', () => {
  it('help reply mentions all the load-bearing verbs', async () => {
    const client = mockClient()
    const reply = await handleAuthCommand(
      { kind: 'help' },
      { agentName: 'x', adminAgents: ['x'], client },
    )
    const text = reply.text
    // Verbs (all variants). The help is HTML; <code> wraps each verb.
    for (const fragment of [
      '/auth show',
      '/auth show &lt;agent&gt;',
      '/auth list',
      '/auth use',
      '/auth rotate',
      '/auth add',
      '/auth cancel',
      '/auth rm',
      '/auth refresh',
      '/auth agent override',
      '/auth help',
    ]) {
      expect(text).toContain(fragment)
    }
  })
})
