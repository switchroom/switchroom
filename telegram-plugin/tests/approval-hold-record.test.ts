/**
 * #3084 follow-up, PR 1 — an undeliverable permission card must be RECORDED,
 * not discarded.
 *
 * The incident: overlord was flood-banned for 4.6h, a permission prompt fired
 * during the ban, the card send threw, and the catch handler wrote the error to
 * stderr and dropped it. The operator never learned an agent was blocked.
 *
 * These tests pin the record itself: its schema (a contract with the
 * switchroom-web reader), its file mode (0644 — web runs as uid 1000 and cannot
 * read the agent's 0600 state files), and the hard rule that it carries
 * METADATA ONLY. A world-readable file that could hold raw tool input is a
 * credential leak — the failure `approve-what-my-agent-can-touch.md` names.
 *
 * No fake timers anywhere: this file must pass under BOTH vitest and bun, and
 * bun's shim lacks `vi.useFakeTimers()` (the trap that made 5 tests silently
 * ERROR on #3097).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, chmodSync, rmSync, statSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createBlockedApprovalStore,
  blockedApprovalsDir,
  isHeldUndeliverable,
  safeActionForRecord,
  BLOCKED_APPROVAL_DIR_MODE,
  BLOCKED_APPROVAL_FILE_MODE,
  type BlockedApprovalRecord,
} from '../gateway/approval-hold.js'
import { naturalAction } from '../permission-title.js'
import { isFloodWaitActiveError, FLOOD_WAIT_ACTIVE } from '../retry-api-call.js'

// Every path is a fresh tmpdir — never ~/.switchroom (the production state
// tree; a test that writes there corrupts a running fleet).
let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'blocked-approvals-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const REC: BlockedApprovalRecord = {
  agent: 'overlord',
  requestId: 'req-abc123',
  toolName: 'Bash',
  action: 'run: npm test',
  blockedSince: 1783753731607,
  undeliverableSince: 1783753731607,
  retryableAt: 1783767801049,
  reason: 'flood_wait',
}

describe('blocked-approval record — the off-Telegram surface', () => {
  it('writes the exact schema switchroom-web reads', () => {
    const dir = blockedApprovalsDir(root)
    const store = createBlockedApprovalStore(dir, 'overlord')
    store.write(REC)

    const onDisk = JSON.parse(readFileSync(join(dir, 'overlord.json'), 'utf-8'))
    expect(onDisk).toEqual({
      agent: 'overlord',
      requestId: 'req-abc123',
      toolName: 'Bash',
      action: 'run: npm test',
      blockedSince: 1783753731607,
      undeliverableSince: 1783753731607,
      retryableAt: 1783767801049,
      reason: 'flood_wait',
    })
  })

  it('lands at <dir>/<agent>.json so web can find every agent in one place', () => {
    const dir = blockedApprovalsDir(root)
    const store = createBlockedApprovalStore(dir, 'marko')
    expect(store.path).toBe(join(root, 'blocked-approvals', 'marko.json'))
  })

  // THE MODE IS LOAD-BEARING. switchroom-web runs as uid 1000; the agent's
  // telegram state (pending-perm-cards.json) is 0600 and it CANNOT read it —
  // verified on the live box. A 0600 record renders a silently empty dashboard.
  it('is world-readable (0644 file, 0755 dir) — a non-owner uid can read it', () => {
    const dir = blockedApprovalsDir(root)
    const store = createBlockedApprovalStore(dir, 'overlord')
    store.write(REC)

    const fileMode = statSync(store.path).mode & 0o777
    const dirMode = statSync(dir).mode & 0o777

    expect(fileMode).toBe(BLOCKED_APPROVAL_FILE_MODE)
    // Spelled out as the property that actually matters: OTHER can read.
    expect(fileMode & 0o004).toBe(0o004) // o+r on the file
    expect(dirMode & 0o001).toBe(0o001) // o+x on the dir (traversable)
    expect(dirMode & 0o004).toBe(0o004) // o+r on the dir
  })

  // Agents run as PER-AGENT non-root uids (AGENT_UID_MIN = 10001). A shared dir
  // that is operator-owned — or root-owned, which is what Docker does to any
  // bind source that doesn't exist — is NOT writable by uid 10001, so the write
  // EACCESes and the record silently never appears. The dir must be
  // world-writable, and sticky so no agent can delete another's record.
  it('the shared dir is WORLD-WRITABLE — every agent uid can write its own record', () => {
    const dir = blockedApprovalsDir(root)
    createBlockedApprovalStore(dir, 'overlord').write(REC)

    const dirMode = statSync(dir).mode & 0o7777
    // THE load-bearing property. Agents are per-agent non-root uids (10001+); a
    // dir they cannot write is a feature that silently never records anything.
    expect(dirMode & 0o002).toBe(0o002)

    // The sticky bit (0o1000) is defense-in-depth on top — it stops one agent
    // deleting another's record. It is NOT relied on for correctness, and it
    // cannot be: bun's chmodSync silently drops it (verified against `stat` —
    // node yields 1777, bun yields 777), and the gateway runs under bun. In
    // production the host CLI (node) sets it via compose.ts. Cross-agent
    // tampering is out of threat model anyway — `single-tenant` says every agent
    // the operator wires in is implicitly trusted. So: assert the constant we
    // ASK for, and assert only the writability we actually depend on.
    expect(BLOCKED_APPROVAL_DIR_MODE).toBe(0o1777)
  })

  // THE BUG THE REVIEWER CAUGHT: without a fallback, a non-writable shared dir
  // meant the whole feature was a silent no-op in production.
  it('falls back to the agent\'s own state dir when the shared dir is not writable', () => {
    // Simulate the production failure: Docker auto-created the bind source as
    // root:root, so this agent's uid can neither create the dir nor chmod it.
    // Modelled as a read-only PARENT — the store can't mkdir the shared dir
    // inside it, and can't chmod its way out either.
    const readOnlyParent = join(root, 'root-owned')
    mkdirSync(readOnlyParent, { recursive: true })
    chmodSync(readOnlyParent, 0o555) // r-xr-xr-x
    const unwritable = join(readOnlyParent, 'blocked-approvals') // cannot be created
    const ownDir = join(root, 'agent-state')
    mkdirSync(ownDir, { recursive: true })

    const store = createBlockedApprovalStore(unwritable, 'overlord', ownDir)
    store.write(REC)

    // The record MUST exist somewhere — never silently lost.
    expect(store.read()?.requestId).toBe('req-abc123')
    expect(store.path).toBe(join(ownDir, 'blocked-approval.json'))
    expect(statSync(store.path).mode & 0o777).toBe(BLOCKED_APPROVAL_FILE_MODE)

    // …and clear() reaches the fallback location too.
    store.clear()
    expect(store.read()).toBeNull()
  })

  it('never carries raw tool input — the record is metadata only', () => {
    const dir = blockedApprovalsDir(root)
    const store = createBlockedApprovalStore(dir, 'overlord')
    store.write(REC)

    const raw = readFileSync(store.path, 'utf-8')
    // The file is 0644. Anything derived from raw tool input could be a
    // credential (`Bash(export TOKEN=...)`), so none of these may ever appear.
    expect(raw).not.toContain('inputPreview')
    expect(raw).not.toContain('input_preview')
    expect(raw).not.toContain('cardText')
    expect(raw).not.toContain('card_text')
    expect(Object.keys(JSON.parse(raw)).sort()).toEqual([
      'action',
      'agent',
      'blockedSince',
      'reason',
      'requestId',
      'retryableAt',
      'toolName',
      'undeliverableSince',
    ])
  })

  it('THROWS if a caller ever tries to widen the record with tool input', () => {
    const store = createBlockedApprovalStore(blockedApprovalsDir(root), 'overlord')
    const leaky = {
      ...REC,
      inputPreview: 'export ANTHROPIC_' + 'TOKEN=sk-ant-' + 'oat01-secret',
    } as unknown as BlockedApprovalRecord

    expect(() => store.write(leaky)).toThrow(/must not carry raw tool input/)
    // …and nothing was written, so the secret never touched a 0644 file.
    expect(store.read()).toBeNull()
  })

  it('read() returns null when nothing is blocked, and after clear()', () => {
    const store = createBlockedApprovalStore(blockedApprovalsDir(root), 'overlord')
    expect(store.read()).toBeNull()

    store.write(REC)
    expect(store.read()?.requestId).toBe('req-abc123')

    store.clear()
    expect(store.read()).toBeNull()
    // clear() on an absent record is a no-op, not a throw.
    expect(() => store.clear()).not.toThrow()
  })

  it('survives a corrupt file rather than crashing the gateway', () => {
    const dir = blockedApprovalsDir(root)
    const store = createBlockedApprovalStore(dir, 'overlord')
    store.write(REC)
    writeFileSync(store.path, '{ not json', 'utf-8')

    expect(store.read()).toBeNull()
    // …and a fresh write repairs it.
    store.write(REC)
    expect(store.read()?.requestId).toBe('req-abc123')
  })

  it('a write failure never throws into the gateway (best-effort surface)', () => {
    // Point the store at a path that cannot be created (a FILE, not a dir).
    const notADir = join(root, 'blocker')
    writeFileSync(notADir, 'x', 'utf-8')
    const store = createBlockedApprovalStore(join(notADir, 'nested'), 'overlord')

    // Must degrade quietly: the SURFACE is best-effort, and a surface failure
    // must never be able to fall the hold back into an auto-deny.
    expect(() => store.write(REC)).not.toThrow()
  })
})

/**
 * The `action` field is the one free-text field in a WORLD-READABLE file, so it
 * is the one place a credential could plausibly land. `naturalAction()` is NOT
 * uniformly safe to put there — for Bash it interpolates the raw command:
 *
 *   naturalAction('Bash', '{"command":"curl -H \'Authorization: Bearer sk-…\'"}')
 *     → "run: curl -H 'Authorization: Bearer sk-…"
 *
 * safeActionForRecord() is the guard. It fails CLOSED: only tools whose action
 * text is basename-derived keep their specifics; everything else degrades to
 * input-free phrasing.
 */
describe('safeActionForRecord — no raw tool input in a 0644 file', () => {
  it('REDACTS a Bash command — the leak naturalAction would have written', () => {
    const secret = 'curl -H "Authorization: Bearer sk-ant-' + 'oat01-SECRET" https://x'
    const input = JSON.stringify({ command: secret })

    // What the naive implementation would have put on disk:
    expect(naturalAction('Bash', input)).toContain('Authorization')

    // What we actually write:
    const safe = safeActionForRecord(naturalAction, 'Bash', input)
    expect(safe).toBe('run shell commands')
    expect(safe).not.toContain('Authorization')
    expect(safe).not.toContain('sk-ant-')
    expect(safe).not.toContain('curl')
  })

  it('redacts the other free-form-input tools too', () => {
    expect(safeActionForRecord(naturalAction, 'Grep', '{"pattern":"SECRET_KEY"}'))
      .toBe('search files')
    expect(safeActionForRecord(naturalAction, 'Glob', '{"pattern":"/etc/**"}'))
      .toBe('search files')
    // A URL routinely carries a token in its query string.
    expect(safeActionForRecord(naturalAction, 'WebFetch', '{"url":"https://x?token=abc123"}'))
      .toBe('fetch a web page')
    expect(
      safeActionForRecord(naturalAction, 'WebFetch', '{"url":"https://x?token=abc123"}'),
    ).not.toContain('abc123')
  })

  it('fails CLOSED for unknown and MCP tools (arbitrary args)', () => {
    expect(safeActionForRecord(naturalAction, 'mcp__brevo__send', '{"to":"a@b.com"}'))
      .not.toContain('a@b.com')
    expect(safeActionForRecord(naturalAction, 'SomeFutureTool', '{"secret":"xyz789"}'))
      .not.toContain('xyz789')
  })

  it('KEEPS the useful specifics for basename-derived tools', () => {
    // The record still has to tell the operator what is blocked, or it is a
    // useless surface. A file basename is the right trade.
    expect(safeActionForRecord(naturalAction, 'Edit', '{"file_path":"/home/k/supplement-log.md"}'))
      .toBe('edit: supplement-log.md')
    expect(safeActionForRecord(naturalAction, 'Write', '{"file_path":"/tmp/out.txt"}'))
      .toBe('write: out.txt')
  })
})

describe('the undeliverable mark', () => {
  it('is what the flood-wait failure produces — and only flood-wait', () => {
    // The real marker `retryApiCall` throws when it refuses to send into an
    // open ban (retry-api-call.ts:192). This is its first production consumer.
    const floodErr = Object.assign(new Error(FLOOD_WAIT_ACTIVE), {
      retryAfterSec: 16739,
      untilTs: 1783767801049,
    })
    expect(isFloodWaitActiveError(floodErr)).toBe(true)

    // A 400 (malformed card) is NOT a hold — that send will never succeed, and
    // holding on it would park the agent forever.
    expect(isFloodWaitActiveError(new Error('Bad Request: can\'t parse entities'))).toBe(false)
    expect(isFloodWaitActiveError(undefined)).toBe(false)
  })

  it('isHeldUndeliverable is the TTL-freeze predicate', () => {
    expect(isHeldUndeliverable({ undeliverable: null })).toBe(false)
    expect(isHeldUndeliverable({})).toBe(false)
    expect(
      isHeldUndeliverable({
        undeliverable: { since: 1, retryableAt: 2, reason: 'flood_wait' },
      }),
    ).toBe(true)
  })
})

/**
 * gateway.ts has top-level side effects and is NOT unit-importable (the same
 * constraint `permission-card-routing.test.ts` documents), so the WIRING is
 * pinned as source text. The logic itself is unit-tested above; these guard
 * that the gateway actually calls it, and can't silently revert to discarding
 * the error.
 */
describe('gateway wiring — the failure handler records instead of discarding', () => {
  const GATEWAY_SRC = readFileSync(
    new URL('../gateway/gateway.ts', import.meta.url),
    'utf8',
  )

  /** Body of the `onPermissionRequest` IPC handler. */
  function onPermissionRequestBody(): string {
    const start = GATEWAY_SRC.indexOf('onPermissionRequest(')
    expect(start).toBeGreaterThan(-1)
    const rest = GATEWAY_SRC.slice(start)
    const end = rest.indexOf('onHeartbeat(')
    expect(end).toBeGreaterThan(-1)
    return rest.slice(0, end)
  }

  it('discriminates the send failure with isFloodWaitActiveError', () => {
    // Before this change the catch was a bare stderr write — the error, which
    // already carried the FLOOD_WAIT_ACTIVE marker post-#3094, was thrown away.
    expect(onPermissionRequestBody()).toContain('isFloodWaitActiveError(e)')
  })

  it('marks the pending entry undeliverable with the window end', () => {
    const body = onPermissionRequestBody()
    expect(body).toContain('pend.undeliverable = {')
    expect(body).toContain("reason: 'flood_wait'")
    expect(body).toContain('retryableAt: e.untilTs')
  })

  it('writes the shared record IN the failure handler (live in <1s, not on a 60s tick)', () => {
    // reconcileBlockedApprovals() derives the record from live pending state and
    // writes it — called synchronously here, not deferred to the reaper tick.
    expect(onPermissionRequestBody()).toContain('reconcileBlockedApprovals()')
  })

  it('the record it writes uses safeActionForRecord, NOT bare naturalAction', () => {
    const at = GATEWAY_SRC.indexOf('function reconcileBlockedApprovals(')
    expect(at).toBeGreaterThan(-1)
    const fn = GATEWAY_SRC.slice(at, GATEWAY_SRC.indexOf('\n}', at))
    // Bare naturalAction() would interpolate the raw Bash command into a
    // world-readable file. The guard must be on the write path itself.
    expect(fn).toContain('action: safeActionForRecord(')
    expect(fn).not.toMatch(/action: naturalAction\(/)
    expect(fn).not.toContain('input_preview:')
    expect(fn).not.toContain('inputPreview')
  })

  it('the surface RECONCILES from live pending state (several holds at once are real)', () => {
    // Claude Code issues parallel tool calls; cancelPendingPermissionsForHalt
    // iterates multiple pendings. A naive clear() on one resolution would delete
    // the file while ANOTHER request was still held.
    expect(GATEWAY_SRC).toContain('function reconcileBlockedApprovals(')
    expect(GATEWAY_SRC).not.toContain('function clearBlockedApproval(')
  })

  it('boot reconciles, so a restart mid-hold cannot orphan a record forever', () => {
    const at = GATEWAY_SRC.indexOf('blocked-approval boot reconcile failed')
    expect(at).toBeGreaterThan(-1)
  })

  it('logs a distinct, greppable HELD signature that says NOT denied', () => {
    const body = onPermissionRequestBody()
    expect(body).toContain('permission-card HELD (undeliverable)')
    expect(body).toContain('held, NOT denied')
  })

  it('does NOT hold on non-flood errors (a 400 would park the agent forever)', () => {
    // The early-return is the whole guard: only FLOOD_WAIT_ACTIVE is a hold.
    expect(onPermissionRequestBody()).toContain('if (!isFloodWaitActiveError(e)) return')
  })
})
