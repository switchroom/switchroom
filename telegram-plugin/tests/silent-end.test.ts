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
  SILENT_END_MAX_RETRIES,
} from '../silent-end.js'

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
