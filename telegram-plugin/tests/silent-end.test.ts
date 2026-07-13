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
  decideCapturedProseDelivery,
  CAPTURED_PROSE_MIN_CHARS,
  SILENT_END_MAX_RETRIES,
  SILENT_END_STALE_RECORD_MAX_AGE_MS,
} from '../silent-end.js'
import { isFinalAnswerReply } from '../final-answer-detect.js'
import { OutboundDedupCache } from '../recent-outbound-dedup.js'

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

  it('turn-start clear pattern resets retryCount for a new turn on the same chat', () => {
    // 2026-05-25 finn incident: the stored turnKey is `chat:thread`
    // shape (no per-instance startedAt suffix). When a prior turn for
    // a chat left the silent-end-pending.json at retryCount=1 (Stop
    // hook had incremented but no successful reply cleared it),
    // writeSilentEndState on the next silent-end for the SAME chat
    // matches `prev.turnKey === args.turnKey` and inherits
    // retryCount=1 — so the Stop hook bails on the very first
    // silent-end of the new turn without re-prompting.
    //
    // The gateway's fix (gateway.ts:6503) calls
    // clearSilentEndState(statusKey(chatId, threadId)) at turn-start.
    // This test pins the contract: clear-then-write yields
    // retryCount=0, not the inherited 1.
    const path = join(stateDir, 'silent-end-pending.json')
    // Prior turn left retryCount=1 stuck on this chat.
    writeFileSync(path, JSON.stringify({
      chatId: '12345', threadId: null, turnKey: '12345:_',
      retryCount: 1, timestamp: 0,
    }))

    // Gateway turn-start hook fires for a NEW turn on the same chat.
    clearSilentEndState('12345:_')
    expect(existsSync(path)).toBe(false)

    // The new turn later ends silent → writeSilentEndState writes
    // fresh state. Without the turn-start clear above, retryCount
    // would have inherited as 1 (per the test at line 42 above).
    writeSilentEndState({ chatId: '12345', threadId: null, turnKey: '12345:_' })
    expect(readSilentEndState()!.retryCount).toBe(0)
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

  it('clearSilentEndState unlinks a pre-#1664 legacy-format file (no turnKey field)', () => {
    // 2026-05-25 incident: clerk had a stale `{retryCount:1,timestamp:...}`
    // file with NO `turnKey` field — written by a pre-#1664 build before
    // the chatId/threadId/turnKey schema landed. The strict
    // `prev.turnKey !== turnKey` check meant `undefined !== <anything>`
    // returned true and every clear callsite no-op'd against it. The file
    // survived two container restarts. When a new turn ended silently
    // ~hours later, the Stop hook read the stale retryCount=1 and bailed
    // without re-prompting, leaving the user with no reply for 5 minutes
    // (until the framework's silence-poke fallback fired).
    //
    // Contract: any clearSilentEndState call must be able to evict a
    // legacy file whose turnKey is missing. Strict matching still applies
    // when both sides have a turnKey (the `clearSilentEndState leaves the
    // file alone when turnKey does NOT match` test above pins that).
    const path = join(stateDir, 'silent-end-pending.json')
    writeFileSync(path, JSON.stringify({ retryCount: 1, timestamp: 1779692417907 }))
    expect(existsSync(path)).toBe(true)

    clearSilentEndState('any-turn-key-here')

    expect(existsSync(path)).toBe(false)
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
    // Pin `now` alongside the record's timestamp=0 so this exercises the
    // genuine same-turn ladder, not fix #8's age-based staleness bound
    // (which is covered by its own dedicated tests below).
    const r = recordSilentTurnEnd(
      { chatId: 'c', threadId: null, turnKey: 'c:_' },
      { now: () => 0 },
    )
    expect(r.exhausted).toBe(true)
    // State cleared so the Stop hook on this final turn allows the stop.
    expect(readSilentEndState()).toBeNull()
  })

  it('fix #8: an exhausted record older than the plausible turn lifetime starts a fresh retry budget (no delivery evidence needed)', () => {
    // A crash/interrupt bypassed the gateway's own exhaust-read-and-clear,
    // so a spent (retryCount >= MAX) record from an OLD turn survives on
    // disk. turnKey is the STABLE statusKey(chatId, threadId) — it matches
    // this brand-new dark turn on the same chat/thread even though it
    // belongs to a completely different turn instance.
    const path = join(stateDir, 'silent-end-pending.json')
    writeFileSync(path, JSON.stringify({
      chatId: 'c', threadId: null, turnKey: 'c:_',
      retryCount: SILENT_END_MAX_RETRIES, timestamp: 0,
    }))
    const now = SILENT_END_STALE_RECORD_MAX_AGE_MS + 1000 // just past the age bound
    const r = recordSilentTurnEnd(
      { chatId: 'c', threadId: null, turnKey: 'c:_' },
      { now: () => now },
    )
    // Must run its OWN re-prompt ladder, not immediately fall back.
    expect(r.exhausted).toBe(false)
    expect(readSilentEndState()).toMatchObject({ turnKey: 'c:_', retryCount: 0 })
  })

  it('fix #8: a genuinely same-turn exhausted record (within the age bound) still reports exhausted — no regression', () => {
    const path = join(stateDir, 'silent-end-pending.json')
    const recentTimestamp = 1_000_000
    writeFileSync(path, JSON.stringify({
      chatId: 'c', threadId: null, turnKey: 'c:_',
      retryCount: SILENT_END_MAX_RETRIES, timestamp: recentTimestamp,
    }))
    // Well within the plausible single-turn retry-ladder window.
    const now = recentTimestamp + 5000
    const r = recordSilentTurnEnd(
      { chatId: 'c', threadId: null, turnKey: 'c:_' },
      { now: () => now },
    )
    expect(r.exhausted).toBe(true)
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
    // 2. Stop hook blocks and bumps retryCount up to the ceiling
    //    (simulated; the hook does retryCount+1 each block until MAX).
    const path = join(stateDir, 'silent-end-pending.json')
    const s = readSilentEndState()!
    writeFileSync(path, JSON.stringify({ ...s, retryCount: SILENT_END_MAX_RETRIES }))
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
    // Stop hook blocks until retryCount hits the ceiling (simulated;
    // the hook does retryCount+1 each block until SILENT_END_MAX_RETRIES).
    const path = join(stateDir, 'silent-end-pending.json')
    const s = readSilentEndState()!
    writeFileSync(path, JSON.stringify({ ...s, retryCount: SILENT_END_MAX_RETRIES }))
    // Re-prompted turn STILL ends with only an interim ack → exhausted.
    const second = recordUndeliveredTurnEnd({ chatId: 'c', threadId: null, turnKey: 'c:exhaust' })
    expect(second.exhausted).toBe(true)
    expect(readSilentEndState()).toBeNull()
  })
})

describe('#1741 — ack reply must not clear silent-end state', () => {
  // The gateway gates `clearSilentEndState` at the reply send-site on
  // `isFinalAnswerReply`. These tests reproduce that gate as a unit:
  // simulate a turn's reply sequence by calling the same predicate the
  // gateway uses, and assert state-file persistence matches the contract.
  //
  // Why this matters: if `turn_end` never lands (Claude Code's
  // `turn_duration` system event is unreliable for trivial-prompt
  // turns), the only line of defence between an undelivered turn and
  // the Stop hook is the persistence of `silent-end-pending.json`.
  // Pre-fix, an ack reply cleared the file unconditionally — so the
  // Stop hook found no state and allowed the stop on every ack-then-
  // tool-then-silent shape. Post-fix, only a plausibly-final reply
  // clears it.

  function simulateReplyAtGateway(
    reply: { text: string; disableNotification: boolean; done?: boolean },
    turnKey: string,
  ): void {
    // The gateway calls clearSilentEndState ONLY when isFinalAnswerReply
    // is true. Mirror that gate exactly.
    if (isFinalAnswerReply(reply)) {
      clearSilentEndState(turnKey)
    }
  }

  it('ack reply (disable_notification, short, no done) does NOT clear pending state', () => {
    // A prior turn-end already wrote state (or a re-prompt round wrote it).
    writeSilentEndState({ chatId: 'c', threadId: null, turnKey: 'c:_' })
    // Agent sends an interim ack.
    simulateReplyAtGateway(
      { text: 'On it', disableNotification: true },
      'c:_',
    )
    // State must persist — the Stop hook still needs to be able to
    // catch a subsequent silent end.
    expect(readSilentEndState()).not.toBeNull()
    expect(readSilentEndState()!.turnKey).toBe('c:_')
  })

  it('final-answer reply (disable_notification=false) clears the state', () => {
    writeSilentEndState({ chatId: 'c', threadId: null, turnKey: 'c:_' })
    simulateReplyAtGateway(
      { text: "Done — here's the result.", disableNotification: false },
      'c:_',
    )
    expect(readSilentEndState()).toBeNull()
  })

  it('stream_reply done=true clears the state even with disable_notification=true', () => {
    writeSilentEndState({ chatId: 'c', threadId: null, turnKey: 'c:_' })
    simulateReplyAtGateway(
      { text: 'ok', disableNotification: true, done: true },
      'c:_',
    )
    expect(readSilentEndState()).toBeNull()
  })

  it('long ack-shaped reply (>=200 chars) is treated as final and clears the state', () => {
    writeSilentEndState({ chatId: 'c', threadId: null, turnKey: 'c:_' })
    simulateReplyAtGateway(
      { text: 'x'.repeat(250), disableNotification: true },
      'c:_',
    )
    expect(readSilentEndState()).toBeNull()
  })

  it('ack-then-silent end-to-end: ack does not clear, Stop hook still blocks', () => {
    // 1. The previous undelivered turn-end wrote state, OR the turn
    //    starts fresh and only the Stop hook will see this state file
    //    once the gateway re-writes it. Simulate the gateway's writer
    //    firing at turn-end with finalAnswerDelivered=false (no
    //    qualifying reply happened this turn).
    writeSilentEndState({ chatId: 'c', threadId: null, turnKey: 'c:_' })
    // 2. Mid-turn ack reply lands. Pre-fix this would unlink the
    //    state file; post-fix it must persist.
    simulateReplyAtGateway(
      { text: 'On it, working on it…', disableNotification: true },
      'c:_',
    )
    // 3. Stop hook fires (separately tested below): it must still
    //    find the state file and decide to block. Verify the file is
    //    intact at the path the hook reads.
    const state = readSilentEndState()
    expect(state).not.toBeNull()
    expect(state!.turnKey).toBe('c:_')
  })

  it('ack-then-final: ack does not clear, final clears', () => {
    writeSilentEndState({ chatId: 'c', threadId: null, turnKey: 'c:_' })
    // Interim ack — state persists.
    simulateReplyAtGateway(
      { text: 'On it', disableNotification: true },
      'c:_',
    )
    expect(readSilentEndState()).not.toBeNull()
    // Final answer — state cleared.
    simulateReplyAtGateway(
      { text: 'Done — the answer is 42.', disableNotification: false },
      'c:_',
    )
    expect(readSilentEndState()).toBeNull()
  })
})

describe('silent-end-interrupt-stop hook — integration (#1775: transcript-scan signal)', () => {
  // Post-#1775 the hook's BLOCK/ALLOW signal is derived from the
  // transcript file, not the state file. The state file remains for
  // retry-count bookkeeping only. These tests pin the new contract.
  //
  // The race the new contract closes: pre-fix the hook read the
  // state file as its signal, but the gateway wrote that file
  // ~175ms AFTER the hook fired (race lost every time). Now the
  // hook reads `transcript_path` directly — Claude Code flushes
  // assistant content before firing Stop hooks, so the read is
  // race-free.

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

  function writeTranscript(lines: object[]): string {
    const path = join(stateDir, 'transcript.jsonl')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n'), 'utf8')
    return path
  }

  const ENQUEUE = {
    type: 'queue-operation',
    operation: 'enqueue',
    content: '<channel source="switchroom-telegram" chat_id="c">hi</channel>',
  }

  function replyToolUse(text: string, opts: { disable_notification?: boolean; done?: boolean } = {}) {
    return {
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', name: 'mcp__switchroom-telegram__reply', input: { text, ...opts } },
        ],
      },
    }
  }

  it('allows the stop when transcript_path is missing from the event (fail-open)', () => {
    // Pre-#1775 this branch was "no state file → allow". Post-fix
    // the same outcome holds via the fail-open transcript guard.
    const r = runHook({ session_id: 's', hook_event_name: 'Stop' })
    expect(r.exit).toBe(0)
    expect(r.stdout.trim()).toBe('')
  })

  it('blocks the stop when transcript shows ack-only (no final reply) — Ken-2026-05-25 repro', () => {
    const transcript = writeTranscript([
      ENQUEUE,
      replyToolUse('on it — checking now', { disable_notification: true }),
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'A'.repeat(2237) }] } },
    ])
    const r = runHook({ session_id: 's', transcript_path: transcript, hook_event_name: 'Stop' })
    expect(r.exit).toBe(0)
    const out = JSON.parse(r.stdout.trim())
    expect(out.decision).toBe('block')
    expect(out.reason).toContain('reply')
    // #1664 — the re-prompt must offer the NO_REPLY escape hatch.
    expect(out.reason).toContain('NO_REPLY')
    // retryCount incremented to 1 (the budget bookkeeping still
    // uses the state file).
    expect(readSilentEndState()!.retryCount).toBe(1)
  })

  it('allows the stop when retryCount >= MAX_RETRIES, even if transcript still shows no reply', () => {
    // Retry budget already spent — gateway will post the user-facing
    // fallback so the user isn't left silent.
    const path = join(stateDir, 'silent-end-pending.json')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(path, JSON.stringify({
      chatId: 'c', threadId: null, turnKey: 'c:_',
      retryCount: SILENT_END_MAX_RETRIES, timestamp: 0,
    }))
    const transcript = writeTranscript([
      ENQUEUE,
      replyToolUse('still just an ack', { disable_notification: true }),
    ])
    const r = runHook({ session_id: 's', transcript_path: transcript, hook_event_name: 'Stop' })
    expect(r.exit).toBe(0)
    expect(r.stdout.trim()).toBe('')
    expect(r.stderr).toContain('retry exhausted')
  })

  it('allows the stop when transcript shows a notification-bearing reply (no state needed)', () => {
    // Pre-#1775 this scenario depended on the gateway having
    // already cleared the state file (race-prone). Post-fix the
    // transcript scan finds the qualifying reply directly.
    const transcript = writeTranscript([
      ENQUEUE,
      replyToolUse('here is the answer', { disable_notification: false }),
    ])
    const r = runHook({ session_id: 's', transcript_path: transcript, hook_event_name: 'Stop' })
    expect(r.exit).toBe(0)
    expect(r.stdout.trim()).toBe('')
    // No state file written (nothing to bookkeep — no block).
    expect(readSilentEndState()).toBeNull()
  })

  it('end-to-end: silent turn → hook blocks → re-prompt delivers → next stop allows', () => {
    // The contract for the HOOK's stdout decision — independent of
    // gateway state-file lifecycle. Gateway's clear happens via
    // recordSilentTurnEnd / clearSilentEndState; this test only
    // exercises the hook's decision based on the transcript that's
    // on disk at hook-time.

    // 1. Turn first-stop with ack-only transcript → block + retryCount→1.
    const transcriptAck = writeTranscript([
      ENQUEUE,
      replyToolUse('ack', { disable_notification: true }),
    ])
    const r1 = runHook({ session_id: 's', transcript_path: transcriptAck, hook_event_name: 'Stop' })
    expect(JSON.parse(r1.stdout).decision).toBe('block')
    expect(readSilentEndState()!.retryCount).toBe(1)

    // 2. Model retried within the same turn — transcript now has the
    //    final reply appended. The hook scans transcript at its next
    //    fire and finds the qualifying reply.
    const transcriptFinal = writeTranscript([
      ENQUEUE,
      replyToolUse('ack', { disable_notification: true }),
      replyToolUse('here is the actual answer', { disable_notification: false }),
    ])
    const r2 = runHook({ session_id: 's', transcript_path: transcriptFinal, hook_event_name: 'Stop' })
    expect(r2.stdout.trim()).toBe('')
    // State file still present (retryCount=1) — gateway's
    // clearSilentEndState path (post-finalAnswerDelivered) is what
    // clears it; the hook doesn't manage that.
  })

  it('NO_REPLY silent-marker in transcript → allow stop even without final reply', () => {
    const transcript = writeTranscript([
      ENQUEUE,
      replyToolUse('NO_REPLY'),
    ])
    const r = runHook({ session_id: 's', transcript_path: transcript, hook_event_name: 'Stop' })
    expect(r.exit).toBe(0)
    expect(r.stdout.trim()).toBe('')
  })

  it('fails open on a corrupt state file (when block would otherwise fire)', () => {
    // Transcript shows ack-only (would block), but state file is
    // corrupt. The hook treats the state file as fresh (retryCount=0)
    // and proceeds to block + write a fresh state file. This is the
    // safe behavior — corrupt state shouldn't cause perpetual stop.
    const transcript = writeTranscript([
      ENQUEUE,
      replyToolUse('ack', { disable_notification: true }),
    ])
    const path = join(stateDir, 'silent-end-pending.json')
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(path, 'corrupt {{{', 'utf8')
    const r = runHook({ session_id: 's', transcript_path: transcript, hook_event_name: 'Stop' })
    expect(r.exit).toBe(0)
    // Decision is block (transcript says block, state is treated as fresh).
    expect(JSON.parse(r.stdout.trim()).decision).toBe('block')
    expect(readSilentEndState()!.retryCount).toBe(1)
  })

  it('fails open on empty stdin', () => {
    const r = runHook({}) // serialised as `{}` — but the hook also tolerates empty
    expect(r.exit).toBe(0)
  })

  // ── Option A transcript-prose bridge (#3227) — end-to-end scan → hook →
  //    state → gateway decision. Proves the gateway would deliver the model's
  //    real answer directly on the FIRST silent-end.
  describe('captured-prose delivery bridge (#3227)', () => {
    const ANSWER = 'That was actually your FY25 NOA, not Bloomfield. ' + 'A'.repeat(2200)

    it('FIRST silent-end with a genuine plain-text answer → hook persists pendingText and decide → deliver', () => {
      // A turn that ended with a substantive answer written as plain text
      // (never sent via the reply tool). The Stop hook scans, blocks, and now
      // persists the answer prose into silent-end-pending.json.
      const transcript = writeTranscript([
        ENQUEUE,
        replyToolUse('on it — checking now', { disable_notification: true }),
        { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
        { type: 'assistant', message: { content: [{ type: 'text', text: ANSWER }] } },
      ])
      const r = runHook({ session_id: 's', transcript_path: transcript, hook_event_name: 'Stop' })
      expect(r.exit).toBe(0)
      expect(JSON.parse(r.stdout.trim()).decision).toBe('block')

      // The bridge: the hook wrote the answer prose into the state file...
      const state = readSilentEndState()!
      expect(state.pendingText).toBe(ANSWER)
      expect(state.turnKey).toBe('c:_')

      // ...and the gateway's pure decision core reads it back and decides to
      // deliver directly on this FIRST silent-end (retryCount just went to 1).
      const decision = decideCapturedProseDelivery({ turnKey: 'c:_' })
      expect(decision.deliver).toBe(true)
      expect(decision.text).toBe(ANSWER)
      expect(decision.reason).toBe('captured-prose')
      // FIRST silent-end: this is the retry-budget's first block, not exhaustion.
      expect(state.retryCount).toBe(1)
    })

    it('a turn that DID call a final reply → no state, no pendingText, decide → no synthetic send', () => {
      const transcript = writeTranscript([
        ENQUEUE,
        replyToolUse('here is the answer, notification-bearing', { disable_notification: false }),
      ])
      const r = runHook({ session_id: 's', transcript_path: transcript, hook_event_name: 'Stop' })
      expect(r.stdout.trim()).toBe('')
      expect(readSilentEndState()).toBeNull()
      const decision = decideCapturedProseDelivery({ turnKey: 'c:_' })
      expect(decision.deliver).toBe(false)
      expect(decision.reason).toBe('no-state')
    })

    it('a genuinely empty turn (no substantive prose) → hook blocks WITHOUT pendingText → decide falls through', () => {
      // Short closer under the substance floor: not a dropped answer. The hook
      // still blocks (re-prompt), but writes NO pendingText, so the gateway
      // takes the existing recordUndeliveredTurnEnd / represent path unchanged.
      const transcript = writeTranscript([
        ENQUEUE,
        { type: 'assistant', message: { content: [{ type: 'text', text: 'ok done' }] } },
      ])
      const r = runHook({ session_id: 's', transcript_path: transcript, hook_event_name: 'Stop' })
      expect(JSON.parse(r.stdout.trim()).decision).toBe('block')
      const state = readSilentEndState()!
      expect(state.pendingText).toBeUndefined()
      const decision = decideCapturedProseDelivery({ turnKey: 'c:_' })
      expect(decision.deliver).toBe(false)
      expect(decision.reason).toBe('no-substantive-prose')
    })

    it('a stale pendingText for a DIFFERENT turn is never delivered (turnKey guard)', () => {
      const path = join(stateDir, 'silent-end-pending.json')
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(path, JSON.stringify({
        chatId: 'c', threadId: null, turnKey: 'OTHER:_',
        retryCount: 1, timestamp: Date.now(), pendingText: ANSWER,
      }))
      const decision = decideCapturedProseDelivery({ turnKey: 'c:_' })
      expect(decision.deliver).toBe(false)
      expect(decision.reason).toBe('turnkey-mismatch')
    })

    it('double-send guard: once the captured prose is recorded in the dedup cache, a late reply-tool retry is suppressed', () => {
      // The gateway records what it delivered in the #546 dedup cache. This is
      // the airtight guard: the re-prompted model's reply (same answer) hits
      // the same cache at its send site and is dropped — the represent + the
      // captured-prose delivery are mutually exclusive by construction.
      const dedup = new OutboundDedupCache()
      const t0 = 1_000_000
      // Gateway captured-prose delivery records the answer.
      dedup.record('c', undefined, ANSWER, t0, 'reg-1')
      // Model re-prompt then calls reply with the same answer moments later.
      const hit = dedup.check('c', undefined, ANSWER, t0 + 5_000, 'reg-1')
      expect(hit).not.toBeNull()
      // A genuinely different later answer is NOT suppressed.
      const miss = dedup.check('c', undefined, 'a completely different answer ' + 'X'.repeat(50), t0 + 5_000, 'reg-1')
      expect(miss).toBeNull()
    })

    it('CAPTURED_PROSE_MIN_CHARS matches the scan/final-answer substance floor', () => {
      expect(CAPTURED_PROSE_MIN_CHARS).toBe(200)
    })
  })
})
