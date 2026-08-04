/**
 * Double-wake dedup (v0.20.8 candidate) — one background sub-agent completion
 * must produce ONE parent wake, not two.
 *
 * The bug: a single background sub-agent completion fanned out to TWO
 * independent wakes of the parent session —
 *   1. the claude CLI's own `<task-notification>` (enqueued by the CLI itself;
 *      switchroom read it only as a background-shell liveness signal), and
 *   2. the gateway-synthesized `subagent_handback` inbound (subagent-watcher
 *      `onFinish` → `pendingInboundBuffer.push`).
 * Nothing linked them. The CLI-native wake cannot be suppressed (it is the
 * CLI's internal queue), so the fix gates the ONE lever switchroom holds — the
 * handback enqueue — on a recently-seen terminal `<task-notification>` for
 * EXACTLY the same task/agent id (`CliTaskNotificationLedger`,
 * subagent-handback-marker.ts; consumed by `decideSubagentHandback`).
 *
 * FAIL-OPEN contract pinned here: every uncertain path DELIVERS the handback.
 * A dropped real wake (silent worker, user waits forever) is strictly worse
 * than an occasional double.
 */

import { describe, it, expect } from 'vitest'
import {
  CliTaskNotificationLedger,
  TASK_NOTIFICATION_DEDUP_TTL_MS,
} from '../gateway/subagent-handback-marker.js'
import { decideSubagentHandback } from '../gateway/subagent-handback-inbound-builder.js'
import { projectTranscriptLine } from '../session-tail.js'
import { applyBackgroundShellLiveness } from '../gateway/background-shell-liveness.js'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const T0 = 1_700_000_000_000

const base = {
  handbackEnvValue: undefined as string | undefined,
  outcome: 'completed' as 'completed' | 'failed' | 'orphan',
  isBackground: true,
  fleetChatId: '777',
  ownerChatId: '999',
  taskDescription: 'Do the thing',
  resultText: 'Done.',
  jsonlAgentId: 'a204deeaedb27b580',
  nowMs: T0,
}

// A real captured queue-operation enqueue line shape (fixture
// bg-shell-liveness-3519.jsonl), retargeted at an AGENT task id — the live
// transcripts prove `<task-id>` for a backgrounded agent equals the
// `agent-<id>.jsonl` stem the subagent-watcher uses as `agentId`
// (verified: <task-id>a204deeaedb27b580</task-id> ↔
// subagents/agent-a204deeaedb27b580.jsonl).
function notifLine(taskId: string, status: string): string {
  return JSON.stringify({
    type: 'queue-operation',
    operation: 'enqueue',
    timestamp: '2026-08-04T00:00:00.000Z',
    sessionId: 'deadbeef-0000-4000-8000-000000000000',
    content:
      `<task-notification>\n<task-id>${taskId}</task-id>\n` +
      `<tool-use-id>toolu_01TESTTESTTESTTEST</tool-use-id>\n` +
      `<output-file>/tmp/tasks/${taskId}.output</output-file>\n` +
      `<status>${status}</status>\n<summary>Agent done</summary>\n</task-notification>`,
  })
}

describe('CliTaskNotificationLedger', () => {
  it('records a terminal notification and reports it within the TTL', () => {
    const l = new CliTaskNotificationLedger()
    l.record('a204deeaedb27b580', 'completed', T0)
    expect(l.seenRecently('a204deeaedb27b580', T0 + 5_000)).toBe(true)
    expect(l.seenRecently('a204deeaedb27b580', T0 + TASK_NOTIFICATION_DEDUP_TTL_MS)).toBe(true)
  })

  it('fail-open: expires after the TTL (a resumed worker second completion delivers)', () => {
    const l = new CliTaskNotificationLedger()
    l.record('a204deeaedb27b580', 'completed', T0)
    expect(l.seenRecently('a204deeaedb27b580', T0 + TASK_NOTIFICATION_DEDUP_TTL_MS + 1)).toBe(false)
  })

  it('fail-open: a DIFFERENT task id never matches', () => {
    const l = new CliTaskNotificationLedger()
    l.record('a204deeaedb27b580', 'completed', T0)
    expect(l.seenRecently('a999999999999999', T0 + 1)).toBe(false)
  })

  it('fail-open: non-terminal statuses and empty ids are never recorded', () => {
    const l = new CliTaskNotificationLedger()
    l.record('a204deeaedb27b580', 'running', T0)
    l.record('', 'completed', T0)
    expect(l.seenRecently('a204deeaedb27b580', T0 + 1)).toBe(false)
    expect(l.seenRecently('', T0 + 1)).toBe(false)
  })

  it('records failed and killed as terminal (the CLI wakes the parent for those too)', () => {
    const l = new CliTaskNotificationLedger()
    l.record('aaa', 'failed', T0)
    l.record('bbb', 'killed', T0)
    expect(l.seenRecently('aaa', T0 + 1)).toBe(true)
    expect(l.seenRecently('bbb', T0 + 1)).toBe(true)
  })

  it('prunes expired entries on write (bounded memory)', () => {
    const l = new CliTaskNotificationLedger()
    l.record('old', 'completed', T0)
    l.record('new', 'completed', T0 + TASK_NOTIFICATION_DEDUP_TTL_MS + 60_000)
    // The old entry is both expired AND physically pruned; either way the
    // observable contract is: it no longer suppresses.
    expect(l.seenRecently('old', T0 + TASK_NOTIFICATION_DEDUP_TTL_MS + 60_001)).toBe(false)
    expect(l.seenRecently('new', T0 + TASK_NOTIFICATION_DEDUP_TTL_MS + 60_001)).toBe(true)
  })
})

describe('decideSubagentHandback × CLI task-notification dedup', () => {
  // ── Outcome (a): one background completion → exactly ONE parent wake ──────
  // RED-before/GREEN-after core: on pre-fix code this decision delivered a
  // second wake; post-fix it is suppressed with the dedicated reason.
  it('suppresses the handback when the CLI already woke the parent for this exact completion', () => {
    const ledger = new CliTaskNotificationLedger()
    // The CLI's wake for this completion (wake #1) is observed by the tail…
    for (const ev of projectTranscriptLine(notifLine('a204deeaedb27b580', 'completed'))) {
      if (ev.kind === 'task_notification') ledger.record(ev.taskId, ev.status, T0)
    }
    // …then the watcher's onFinish runs the decide gate (would-be wake #2).
    const wakes: string[] = ['cli-task-notification'] // wake #1 already happened
    const d = decideSubagentHandback({
      ...base,
      cliTaskNotificationSeen: ledger.seenRecently(base.jsonlAgentId, T0 + 2_000),
    })
    if (d.deliver) wakes.push('subagent_handback')
    expect(d).toEqual({ deliver: false, reason: 'cli-task-notification' })
    expect(wakes).toHaveLength(1) // exactly one parent wake, not two
  })

  it('suppresses a FAILED completion the CLI already reported, too', () => {
    const d = decideSubagentHandback({
      ...base,
      outcome: 'failed',
      cliTaskNotificationSeen: true,
    })
    expect(d).toEqual({ deliver: false, reason: 'cli-task-notification' })
  })

  // ── Outcome (b): fail-open — a handback with NO matching notification fires ─
  it('fail-open: delivers when no notification was seen (flag false)', () => {
    const d = decideSubagentHandback({ ...base, cliTaskNotificationSeen: false })
    expect(d.deliver).toBe(true)
    if (d.deliver) {
      expect(d.chatId).toBe('777')
      expect(d.inbound.meta?.source).toBe('subagent_handback')
    }
  })

  it('fail-open: delivers when the flag is omitted entirely (older callers)', () => {
    const d = decideSubagentHandback({ ...base })
    expect(d.deliver).toBe(true)
  })

  it('fail-open end-to-end: a notification for a DIFFERENT agent id does not suppress', () => {
    const ledger = new CliTaskNotificationLedger()
    for (const ev of projectTranscriptLine(notifLine('a999999999999999', 'completed'))) {
      if (ev.kind === 'task_notification') ledger.record(ev.taskId, ev.status, T0)
    }
    const d = decideSubagentHandback({
      ...base,
      cliTaskNotificationSeen: ledger.seenRecently(base.jsonlAgentId, T0 + 2_000),
    })
    expect(d.deliver).toBe(true)
  })

  it('fail-open end-to-end: an EXPIRED notification does not suppress', () => {
    const ledger = new CliTaskNotificationLedger()
    ledger.record(base.jsonlAgentId, 'completed', T0)
    const d = decideSubagentHandback({
      ...base,
      cliTaskNotificationSeen: ledger.seenRecently(
        base.jsonlAgentId,
        T0 + TASK_NOTIFICATION_DEDUP_TTL_MS + 1,
      ),
    })
    expect(d.deliver).toBe(true)
  })

  it('gate ordering: foreground/outcome/env gates still win over the dedup reason', () => {
    expect(
      decideSubagentHandback({ ...base, isBackground: false, cliTaskNotificationSeen: true }),
    ).toEqual({ deliver: false, reason: 'foreground' })
    expect(
      decideSubagentHandback({ ...base, outcome: 'orphan', cliTaskNotificationSeen: true }),
    ).toEqual({ deliver: false, reason: 'outcome-not-terminal' })
    expect(
      decideSubagentHandback({ ...base, handbackEnvValue: '0', cliTaskNotificationSeen: true }),
    ).toEqual({ deliver: false, reason: 'env-disabled' })
  })
})

// ── Outcome (c): the task-notification keeps working as a liveness signal ────
// Recording into the dedup ledger is an ADDITIVE read of the same event; the
// background-shell-liveness consumer must still see the shell as DEAD.
describe('task_notification still drives background-shell liveness (not swallowed)', () => {
  it('one projected event feeds BOTH the liveness registry and the dedup ledger', () => {
    const dead: string[] = []
    const alive: string[] = []
    const registry = {
      noteBackgroundShellAlive: (_k: string, id: string) => void alive.push(id),
      noteBackgroundShellDead: (_k: string, id: string) => void dead.push(id),
    }
    const ledger = new CliTaskNotificationLedger()
    const events = projectTranscriptLine(notifLine('bxa4sv3dq', 'completed'))
    expect(events).toHaveLength(1)
    for (const ev of events) {
      applyBackgroundShellLiveness(registry, 'chat:-', ev)
      if (ev.kind === 'task_notification') ledger.record(ev.taskId, ev.status, T0)
    }
    expect(dead).toEqual(['bxa4sv3dq']) // liveness signal intact
    expect(ledger.seenRecently('bxa4sv3dq', T0 + 1)).toBe(true) // dedup recorded
    expect(alive).toEqual([])
  })

  it('a foreground-shell task-notification with NO handback in flight changes nothing else', () => {
    // A background Bash shell death has no subagent-watcher onFinish — the
    // ledger entry simply ages out; nothing consults it for shells.
    const ledger = new CliTaskNotificationLedger()
    ledger.record('bxa4sv3dq', 'completed', T0)
    expect(ledger.seenRecently('bxa4sv3dq', T0 + TASK_NOTIFICATION_DEDUP_TTL_MS + 1)).toBe(false)
  })
})

// ── Wiring pins — the gateway must actually consult the ledger ───────────────
// gateway.ts is not unit-instantiable; pin the two wiring sites statically
// (repo precedent: subagent-handback-marker.test.ts scans gateway source).
describe('gateway wiring pins', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const gatewaySrc = readFileSync(join(here, '..', 'gateway', 'gateway.ts'), 'utf8')

  it('onSessionEvent records terminal task-notifications into the ledger', () => {
    expect(gatewaySrc).toMatch(
      /if \(ev\.kind === 'task_notification'\) cliTaskNotifLedger\.record\(ev\.taskId, ev\.status, Date\.now\(\)\)/,
    )
  })

  it('the onFinish decide callsite passes the fail-open seenRecently read', () => {
    expect(gatewaySrc).toMatch(
      /cliTaskNotificationSeen: cliTaskNotifLedger\.seenRecently\(agentId, Date\.now\(\)\)/,
    )
  })
})
