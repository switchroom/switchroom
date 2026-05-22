import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  writeSilentEndState,
  clearSilentEndState,
  readSilentEndState,
  recordSilentTurnEnd,
  recordUndeliveredTurnEnd,
  SILENT_END_MAX_RETRIES,
} from '../silent-end.js'
import { isFinalAnswerReply } from '../final-answer-detect.js'

let stateDir: string
const ORIG_ENV = process.env.TELEGRAM_STATE_DIR

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'silent-end-test-'))
  process.env.TELEGRAM_STATE_DIR = stateDir
})

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true })
  if (ORIG_ENV != null) process.env.TELEGRAM_STATE_DIR = ORIG_ENV
  else delete process.env.TELEGRAM_STATE_DIR
})

describe('silent-end.ts — gateway state writer', () => {
  it('writeSilentEndState creates the file with retryCount=0 on first write', () => {
    writeSilentEndState({ chatId: '123', threadId: null, turnKey: '123:_' })
    const state = readSilentEndState()
    expect(state).not.toBeNull()
    expect(state!.chatId).toBe('123')
    expect(state!.threadId).toBeNull()
    expect(state!.turnKey).toBe('123:_')
    expect(state!.retryCount).toBe(0)
    expect(typeof state!.timestamp).toBe('number')
  })

  it('writeSilentEndState inherits retryCount IFF the prior file matches the same turnKey', () => {
    // Prior file at retryCount=1 for the same turn (Stop hook had already
    // blocked once and re-incremented).
    const path = join(stateDir, 'silent-end-pending.json')
    writeFileSync(path, JSON.stringify({
      chatId: '123', threadId: null, turnKey: '123:_', retryCount: 1, timestamp: 0,
    }))
    writeSilentEndState({ chatId: '123', threadId: null, turnKey: '123:_' })
    expect(readSilentEndState()!.retryCount).toBe(1)
  })

  it('writeSilentEndState resets retryCount to 0 when turnKey differs', () => {
    const path = join(stateDir, 'silent-end-pending.json')
    writeFileSync(path, JSON.stringify({
      chatId: '123', threadId: null, turnKey: '123:_', retryCount: 1, timestamp: 0,
    }))
    // Different turn — new silent-end, fresh counter.
    writeSilentEndState({ chatId: '999', threadId: 42, turnKey: '999:42' })
    const state = readSilentEndState()
    expect(state!.turnKey).toBe('999:42')
    expect(state!.retryCount).toBe(0)
  })

  it('writeSilentEndState falls back to ~/.claude/channels/telegram when TELEGRAM_STATE_DIR is unset', () => {
    // Updated 2026-05-13 UAT overnight: discovered the writer used to
    // silently no-op when the env var was unset, while the Stop hook
    // (silent-end-interrupt-stop.mjs) and the gateway both fall back
    // to `~/.claude/channels/telegram`. Mismatch meant the hook
    // always read a missing file → silent-end recovery never engaged.
    // The writer now applies the same fallback.
    delete process.env.TELEGRAM_STATE_DIR
    const fakeHome = mkdtempSync(join(tmpdir(), 'silent-end-fallback-home-'))
    const origHome = process.env.HOME
    process.env.HOME = fakeHome
    try {
      writeSilentEndState({ chatId: '123', threadId: null, turnKey: '123:_' })
      const expected = join(fakeHome, '.claude', 'channels', 'telegram', 'silent-end-pending.json')
      expect(existsSync(expected)).toBe(true)
    } finally {
      if (origHome != null) process.env.HOME = origHome
      else delete process.env.HOME
      rmSync(fakeHome, { recursive: true, force: true })
    }
  })

  it('clearSilentEndState removes the file when turnKey matches', () => {
    writeSilentEndState({ chatId: '123', threadId: null, turnKey: '123:_' })
    expect(existsSync(join(stateDir, 'silent-end-pending.json'))).toBe(true)
    clearSilentEndState('123:_')
    expect(existsSync(join(stateDir, 'silent-end-pending.json'))).toBe(false)
  })

  it('clearSilentEndState leaves the file alone when turnKey does NOT match', () => {
    writeSilentEndState({ chatId: '123', threadId: null, turnKey: '123:_' })
    clearSilentEndState('different-turn')
    expect(existsSync(join(stateDir, 'silent-end-pending.json'))).toBe(true)
  })

  it('clearSilentEndState is a no-op when no file exists', () => {
    expect(() => clearSilentEndState('123:_')).not.toThrow()
  })

  it('clearSilentEndState is a no-op when TELEGRAM_STATE_DIR is unset', () => {
    delete process.env.TELEGRAM_STATE_DIR
    expect(() => clearSilentEndState('123:_')).not.toThrow()
  })

  it('writeSilentEndState handles corrupt prior file by resetting retryCount', () => {
    const path = join(stateDir, 'silent-end-pending.json')
    writeFileSync(path, 'not valid json {{{')
    writeSilentEndState({ chatId: '123', threadId: null, turnKey: '123:_' })
    expect(readSilentEndState()!.retryCount).toBe(0)
  })

  it('round-trip: write → read → clear', () => {
    writeSilentEndState({ chatId: 'c', threadId: 7, turnKey: 'c:7' })
    const state = readSilentEndState()
    expect(state).toMatchObject({ chatId: 'c', threadId: 7, turnKey: 'c:7', retryCount: 0 })
    clearSilentEndState('c:7')
    expect(readSilentEndState()).toBeNull()
  })
})

describe('recordSilentTurnEnd — #1161 exhaustion detection', () => {
  it('first silent-end of a turn writes state and reports exhausted:false', () => {
    const r = recordSilentTurnEnd({ chatId: 'c', threadId: null, turnKey: 'c:_' })
    expect(r.exhausted).toBe(false)
    expect(readSilentEndState()).toMatchObject({ turnKey: 'c:_', retryCount: 0 })
  })

  it('reports exhausted:false while prior retryCount is still below the cap', () => {
    // The Stop hook has not yet been able to push retryCount to the cap.
    const path = join(stateDir, 'silent-end-pending.json')
    writeFileSync(path, JSON.stringify({
      chatId: 'c', threadId: null, turnKey: 'c:_',
      retryCount: SILENT_END_MAX_RETRIES - 1, timestamp: 0,
    }))
    const r = recordSilentTurnEnd({ chatId: 'c', threadId: null, turnKey: 'c:_' })
    expect(r.exhausted).toBe(false)
    // State is (re)written, inheriting the prior counter for the same turn.
    expect(readSilentEndState()!.retryCount).toBe(SILENT_END_MAX_RETRIES - 1)
  })

  it('reports exhausted:true and clears state once the re-prompt cap is reached', () => {
    // The Stop hook already blocked once and pushed retryCount to the cap;
    // the agent is STILL silent on this re-prompted turn.
    const path = join(stateDir, 'silent-end-pending.json')
    writeFileSync(path, JSON.stringify({
      chatId: 'c', threadId: null, turnKey: 'c:_',
      retryCount: SILENT_END_MAX_RETRIES, timestamp: 0,
    }))
    const r = recordSilentTurnEnd({ chatId: 'c', threadId: null, turnKey: 'c:_' })
    expect(r.exhausted).toBe(true)
    // State cleared so the Stop hook on this final turn allows the stop.
    expect(readSilentEndState()).toBeNull()
  })

  it('treats a capped prior state for a DIFFERENT turn as a fresh silent-end', () => {
    const path = join(stateDir, 'silent-end-pending.json')
    writeFileSync(path, JSON.stringify({
      chatId: 'old', threadId: null, turnKey: 'old:_',
      retryCount: SILENT_END_MAX_RETRIES, timestamp: 0,
    }))
    const r = recordSilentTurnEnd({ chatId: 'new', threadId: 9, turnKey: 'new:9' })
    expect(r.exhausted).toBe(false)
    expect(readSilentEndState()).toMatchObject({ turnKey: 'new:9', retryCount: 0 })
  })

  it('full lifecycle: silent → re-prompt → still silent → exhausted', () => {
    // 1. Turn ends silent — first record.
    expect(recordSilentTurnEnd({ chatId: 'c', threadId: null, turnKey: 'c:_' }).exhausted).toBe(false)
    // 2. Stop hook blocks and increments retryCount (simulated).
    const path = join(stateDir, 'silent-end-pending.json')
    const s = readSilentEndState()!
    writeFileSync(path, JSON.stringify({ ...s, retryCount: s.retryCount + 1 }))
    // 3. Re-prompted turn ends silent again — recovery exhausted.
    expect(recordSilentTurnEnd({ chatId: 'c', threadId: null, turnKey: 'c:_' }).exhausted).toBe(true)
    expect(readSilentEndState()).toBeNull()
  })

  it('SILENT_END_MAX_RETRIES matches MAX_RETRIES in the Stop hook', () => {
    // The hook is a standalone .mjs and hardcodes its own copy — this
    // guards the two from drifting apart.
    const hookSrc = readFileSync(join(__dirname, '..', 'hooks', 'silent-end-interrupt-stop.mjs'), 'utf8')
    const m = hookSrc.match(/const MAX_RETRIES = (\d+)/)
    expect(m).not.toBeNull()
    expect(Number(m![1])).toBe(SILENT_END_MAX_RETRIES)
  })
})

describe('recordUndeliveredTurnEnd — #1664 extended trigger', () => {
  it('is the same function as recordSilentTurnEnd (semantic alias)', () => {
    expect(recordUndeliveredTurnEnd).toBe(recordSilentTurnEnd)
  })

  // The gateway computes `finalAnswerDelivered` by OR-ing isFinalAnswerReply
  // across every reply landed this turn, then engages the re-prompt iff the
  // flag is still false at turn_end. These tests reproduce that exact
  // decision: classify the turn's replies, then call recordUndeliveredTurnEnd
  // only when no reply qualified.
  function simulateTurnEnd(
    replies: Array<{ text: string; disableNotification: boolean; done?: boolean }>,
    turnKey: string,
  ): { finalAnswerDelivered: boolean; rePromptEngaged: boolean } {
    const finalAnswerDelivered = replies.some((r) =>
      isFinalAnswerReply(r),
    )
    let rePromptEngaged = false
    if (finalAnswerDelivered === false) {
      recordUndeliveredTurnEnd({ chatId: 'c', threadId: null, turnKey })
      rePromptEngaged = true
    }
    return { finalAnswerDelivered, rePromptEngaged }
  }

  it('#1664 regression: ack reply + answer-as-transcript → re-prompt fires', () => {
    // The exact #1664 shape: the model sent a short interim ack via the
    // reply tool (disable_notification:true), then ended the turn with its
    // real answer as plain transcript text — which the gateway renders into
    // an ephemeral draft and retracts at turn_end, never finalized. No
    // reply qualified as the final answer, so the turn is undelivered.
    const r = simulateTurnEnd(
      [{ text: 'On it — give me a moment.', disableNotification: true }],
      'c:1664',
    )
    expect(r.finalAnswerDelivered).toBe(false)
    expect(r.rePromptEngaged).toBe(true)
    // State file written so silent-end-interrupt-stop.mjs blocks the stop.
    expect(readSilentEndState()).toMatchObject({ turnKey: 'c:1664', retryCount: 0 })
  })

  it('a turn with a final-answer reply (notification-bearing) → re-prompt NOT engaged', () => {
    const r = simulateTurnEnd(
      [{ text: 'Here is the answer.', disableNotification: false }],
      'c:final',
    )
    expect(r.finalAnswerDelivered).toBe(true)
    expect(r.rePromptEngaged).toBe(false)
    expect(readSilentEndState()).toBeNull()
  })

  it('a long reply mis-marked interim → re-prompt NOT engaged (length backstop)', () => {
    const r = simulateTurnEnd(
      [{ text: 'x'.repeat(500), disableNotification: true }],
      'c:long',
    )
    expect(r.finalAnswerDelivered).toBe(true)
    expect(r.rePromptEngaged).toBe(false)
    expect(readSilentEndState()).toBeNull()
  })

  it('zero-outbound turn → re-prompt still engaged (regression of the original case)', () => {
    // No replies at all — the original #1122 silent-end case is now just
    // the subset of "no final answer delivered" where nothing landed.
    const r = simulateTurnEnd([], 'c:zero')
    expect(r.finalAnswerDelivered).toBe(false)
    expect(r.rePromptEngaged).toBe(true)
    expect(readSilentEndState()).toMatchObject({ turnKey: 'c:zero', retryCount: 0 })
  })

  it('interim ack followed by a final-answer reply in the same turn → NOT engaged', () => {
    // The model ack'd first then properly delivered — finalAnswerDelivered
    // latches true on the second reply; the turn is answered.
    const r = simulateTurnEnd(
      [
        { text: 'Looking into it…', disableNotification: true },
        { text: 'Done — the result is 42.', disableNotification: false },
      ],
      'c:ack-then-final',
    )
    expect(r.finalAnswerDelivered).toBe(true)
    expect(r.rePromptEngaged).toBe(false)
    expect(readSilentEndState()).toBeNull()
  })

  it('stream_reply done=true counts as the final answer → NOT engaged', () => {
    const r = simulateTurnEnd(
      [{ text: 'ok', disableNotification: true, done: true }],
      'c:stream-done',
    )
    expect(r.finalAnswerDelivered).toBe(true)
    expect(r.rePromptEngaged).toBe(false)
    expect(readSilentEndState()).toBeNull()
  })

  it('exhaustion still applies on the #1664 path after the Stop-hook re-prompt', () => {
    // First undelivered turn-end writes state.
    expect(simulateTurnEnd(
      [{ text: 'one sec', disableNotification: true }],
      'c:exhaust',
    ).rePromptEngaged).toBe(true)
    // Stop hook blocks once and bumps retryCount (simulated).
    const path = join(stateDir, 'silent-end-pending.json')
    const s = readSilentEndState()!
    writeFileSync(path, JSON.stringify({ ...s, retryCount: s.retryCount + 1 }))
    // Re-prompted turn STILL ends with only an interim ack → exhausted.
    const second = recordUndeliveredTurnEnd({ chatId: 'c', threadId: null, turnKey: 'c:exhaust' })
    expect(second.exhausted).toBe(true)
    expect(readSilentEndState()).toBeNull()
  })
})

describe('silent-end-interrupt-stop hook — integration', () => {
  const hookPath = join(__dirname, '..', 'hooks', 'silent-end-interrupt-stop.mjs')

  function runHook(input: object): { exit: number; stdout: string; stderr: string } {
    const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
    const r = spawnSync('node', [hookPath], {
      input: JSON.stringify(input),
      env: { ...process.env, TELEGRAM_STATE_DIR: stateDir },
      encoding: 'utf8',
      timeout: 5_000,
    })
    return { exit: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
  }

  it('allows the stop when no state file exists (normal completion)', () => {
    const r = runHook({
      session_id: 's',
      transcript_path: '/tmp/x.jsonl',
      hook_event_name: 'Stop',
    })
    expect(r.exit).toBe(0)
    expect(r.stdout.trim()).toBe('')
  })

  it('blocks the stop with decision:block when silent-end state exists at retryCount=0', () => {
    writeSilentEndState({ chatId: 'c', threadId: null, turnKey: 'c:_' })
    const r = runHook({
      session_id: 's',
      transcript_path: '/tmp/x.jsonl',
      hook_event_name: 'Stop',
    })
    expect(r.exit).toBe(0)
    const out = JSON.parse(r.stdout.trim())
    expect(out.decision).toBe('block')
    expect(out.reason).toContain('reply')
    // #1664 — the re-prompt must offer the NO_REPLY escape hatch so a
    // model that already delivered (or intentionally has nothing to add)
    // can end the turn cleanly instead of being forced to re-send.
    expect(out.reason).toContain('NO_REPLY')
    // retryCount must have been incremented to 1
    expect(readSilentEndState()!.retryCount).toBe(1)
  })

  it('allows the stop when retryCount >= MAX_RETRIES (1)', () => {
    const path = join(stateDir, 'silent-end-pending.json')
    writeFileSync(path, JSON.stringify({
      chatId: 'c', threadId: null, turnKey: 'c:_', retryCount: 1, timestamp: 0,
    }))
    const r = runHook({
      session_id: 's',
      transcript_path: '/tmp/x.jsonl',
      hook_event_name: 'Stop',
    })
    expect(r.exit).toBe(0)
    expect(r.stdout.trim()).toBe('')
    expect(r.stderr).toContain('retry exhausted')
  })

  it('end-to-end: write silent-end → hook blocks → simulate reply → next stop allows', () => {
    // 1. Turn ends silently — gateway writes state
    writeSilentEndState({ chatId: 'c', threadId: null, turnKey: 'c:_' })

    // 2. Stop hook fires, blocks, increments retryCount
    const r1 = runHook({ session_id: 's', transcript_path: '/tmp/x.jsonl', hook_event_name: 'Stop' })
    expect(JSON.parse(r1.stdout).decision).toBe('block')
    expect(readSilentEndState()!.retryCount).toBe(1)

    // 3. Re-prompted agent calls reply — gateway clears the file
    clearSilentEndState('c:_')
    expect(readSilentEndState()).toBeNull()

    // 4. Next Stop allows cleanly (no state file)
    const r2 = runHook({ session_id: 's', transcript_path: '/tmp/x.jsonl', hook_event_name: 'Stop' })
    expect(r2.stdout.trim()).toBe('')
  })

  it('fails open on a corrupt state file', () => {
    const path = join(stateDir, 'silent-end-pending.json')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(path, 'corrupt {{{', 'utf8')
    const r = runHook({ session_id: 's', transcript_path: '/tmp/x.jsonl', hook_event_name: 'Stop' })
    expect(r.exit).toBe(0)
    expect(r.stdout.trim()).toBe('')
  })

  it('fails open on empty stdin', () => {
    const r = runHook({}) // serialised as `{}` — but the hook also tolerates empty
    expect(r.exit).toBe(0)
  })
})
