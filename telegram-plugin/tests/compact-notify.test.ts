import { describe, it, expect } from 'vitest'
import {
  nextCompactNotify,
  idleCompactNotifyState,
  type CompactNotifyState,
} from '../gateway/compact-notify.js'

const FILE_A = '/state/.../sess-a.jsonl'
const FILE_B = '/state/.../sess-b.jsonl'

describe('nextCompactNotify', () => {
  it('idle + fired → start, awaiting with fileAtStart', () => {
    const r = nextCompactNotify(idleCompactNotifyState(), {
      fired: true,
      rearmed: false,
      activeFile: FILE_A,
    })
    expect(r.action).toBe('start')
    expect(r.state).toEqual({ phase: 'awaiting', fileAtStart: FILE_A })
  })

  it('idle + nothing → none', () => {
    const r = nextCompactNotify(idleCompactNotifyState(), {
      fired: false,
      rearmed: false,
      activeFile: FILE_A,
    })
    expect(r.action).toBe('none')
    expect(r.state.phase).toBe('idle')
  })

  it('idle + spurious rearm (no card outstanding) → none', () => {
    const r = nextCompactNotify(idleCompactNotifyState(), {
      fired: false,
      rearmed: true,
      activeFile: FILE_A,
    })
    expect(r.action).toBe('none')
    expect(r.state.phase).toBe('idle')
  })

  it('awaiting + rearm on SAME file → finish, back to idle', () => {
    const awaiting: CompactNotifyState = { phase: 'awaiting', fileAtStart: FILE_A }
    const r = nextCompactNotify(awaiting, {
      fired: false,
      rearmed: true,
      activeFile: FILE_A,
    })
    expect(r.action).toBe('finish')
    expect(r.state).toEqual(idleCompactNotifyState())
  })

  it('awaiting + rearm on DIFFERENT file → none (sub-agent false-positive guard)', () => {
    const awaiting: CompactNotifyState = { phase: 'awaiting', fileAtStart: FILE_A }
    const r = nextCompactNotify(awaiting, {
      fired: false,
      rearmed: true,
      activeFile: FILE_B,
    })
    expect(r.action).toBe('none')
    expect(r.state).toBe(awaiting) // unchanged, still awaiting
  })

  it('awaiting + rearm but activeFile null → none', () => {
    const awaiting: CompactNotifyState = { phase: 'awaiting', fileAtStart: FILE_A }
    const r = nextCompactNotify(awaiting, {
      fired: false,
      rearmed: true,
      activeFile: null,
    })
    expect(r.action).toBe('none')
    expect(r.state.phase).toBe('awaiting')
  })

  it('awaiting + no rearm → none, stays awaiting (shell timeout owns dangling)', () => {
    const awaiting: CompactNotifyState = { phase: 'awaiting', fileAtStart: FILE_A }
    const r = nextCompactNotify(awaiting, {
      fired: false,
      rearmed: false,
      activeFile: FILE_A,
    })
    expect(r.action).toBe('none')
    expect(r.state.phase).toBe('awaiting')
  })

  it('awaiting + fired again → start-superseding, awaiting with NEW fileAtStart', () => {
    const awaiting: CompactNotifyState = { phase: 'awaiting', fileAtStart: FILE_A }
    const r = nextCompactNotify(awaiting, {
      fired: true,
      rearmed: false,
      activeFile: FILE_B,
    })
    expect(r.action).toBe('start-superseding')
    expect(r.state).toEqual({ phase: 'awaiting', fileAtStart: FILE_B })
  })

  it('full healthy cycle: fire → hold → rearm(same file) → idle', () => {
    let s = idleCompactNotifyState()
    const fires: string[] = []
    const seq = [
      { fired: true, rearmed: false, activeFile: FILE_A }, // START
      { fired: false, rearmed: false, activeFile: FILE_A }, // cooldown/hold
      { fired: false, rearmed: false, activeFile: FILE_A }, // hold
      { fired: false, rearmed: true, activeFile: FILE_A }, // FINISH
      { fired: false, rearmed: false, activeFile: FILE_A }, // idle, nothing
    ]
    for (const ev of seq) {
      const r = nextCompactNotify(s, ev)
      s = r.state
      fires.push(r.action)
    }
    expect(fires).toEqual(['start', 'none', 'none', 'finish', 'none'])
    expect(s).toEqual(idleCompactNotifyState())
  })

  it('rearm that arrives only after a file flip never finishes the wrong card', () => {
    // START on FILE_A; a sub-agent (FILE_B) leads and "rearms" → ignored;
    // later the real drop is observed back on FILE_A → finish.
    let s = nextCompactNotify(idleCompactNotifyState(), {
      fired: true,
      rearmed: false,
      activeFile: FILE_A,
    }).state
    const mid = nextCompactNotify(s, {
      fired: false,
      rearmed: true,
      activeFile: FILE_B,
    })
    expect(mid.action).toBe('none')
    s = mid.state
    const fin = nextCompactNotify(s, {
      fired: false,
      rearmed: true,
      activeFile: FILE_A,
    })
    expect(fin.action).toBe('finish')
  })
})
