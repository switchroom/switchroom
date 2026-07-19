import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, appendFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  computeFirstAttachCursor,
  getProjectsDirForCwd,
  startSessionTail,
  type SessionEvent,
} from '../session-tail.js'

/**
 * computeFirstAttachCursor: on first attach to a transcript, seek to EOF
 * UNLESS the agent restarted mid-turn (an `enqueue` with no `turn_duration`
 * after it). Missing that enqueue strands the first post-restart turn with
 * no currentTurn (dead progress card / draft-mirror / silence-poke).
 */

const ENQUEUE = '{"type":"queue-operation","operation":"enqueue","content":"chat:123 msg:1"}'
const DEQUEUE = '{"type":"queue-operation","operation":"dequeue"}'
const ASSISTANT = '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}'
const TURN_DURATION = '{"type":"system","subtype":"turn_duration","durationMs":4200}'

function writeTranscript(dir: string, lines: string[]): { file: string; size: number } {
  const file = join(dir, 'sess.jsonl')
  writeFileSync(file, lines.join('\n') + '\n')
  return { file, size: statSync(file).size }
}

function offsetOfLine(lines: string[], index: number): number {
  let off = 0
  for (let i = 0; i < index; i++) off += Buffer.byteLength(lines[i]!, 'utf8') + 1 // +1 for '\n'
  return off
}

describe('computeFirstAttachCursor', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'first-attach-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('in-flight turn (enqueue, no turn_duration after) → replays from the enqueue offset', () => {
    const lines = [ASSISTANT, ENQUEUE, DEQUEUE, ASSISTANT] // enqueue at index 1, no turn_duration
    const { file, size } = writeTranscript(dir, lines)
    expect(computeFirstAttachCursor(file, size)).toBe(offsetOfLine(lines, 1))
  })

  it('completed turn (turn_duration after the enqueue) → EOF, no replay', () => {
    const lines = [ENQUEUE, DEQUEUE, ASSISTANT, TURN_DURATION]
    const { file, size } = writeTranscript(dir, lines)
    expect(computeFirstAttachCursor(file, size)).toBe(size)
  })

  it('no enqueue in the tail → EOF', () => {
    const lines = [ASSISTANT, ASSISTANT, TURN_DURATION]
    const { file, size } = writeTranscript(dir, lines)
    expect(computeFirstAttachCursor(file, size)).toBe(size)
  })

  it('completed turn followed by a NEW in-flight turn → replays from the second enqueue', () => {
    // turn 1: enqueue+turn_duration (done). turn 2: enqueue, still running.
    const lines = [ENQUEUE, ASSISTANT, TURN_DURATION, ENQUEUE, DEQUEUE, ASSISTANT]
    const { file, size } = writeTranscript(dir, lines)
    expect(computeFirstAttachCursor(file, size)).toBe(offsetOfLine(lines, 3))
  })

  it('empty / missing file → returns the given size (degrades to EOF)', () => {
    const missing = join(dir, 'nope.jsonl')
    expect(computeFirstAttachCursor(missing, 0)).toBe(0)
  })
})

// ── #3427 H2: first-attach replay marks `model` events as replayed ───────────
//
// A /model relaunch during an active turn is EXACTLY the shape that triggers
// the in-flight-turn replay above: the new gateway attaches to the OLD
// session's JSONL and replays its enqueue + assistant lines — which carry the
// PRE-relaunch model. Those replayed `model` observations must be flagged so
// the divergence tripwire (session-model-source) ignores them; live lines
// appended after attach must NOT be flagged. Outcome-asserted against the
// real tailer, not the source.

describe('startSessionTail — replayed model events are flagged (#3427 H2)', () => {
  const tempDirs: string[] = []
  afterEach(() => {
    for (const d of tempDirs) {
      try { rmSync(d, { recursive: true, force: true }) } catch { /* ignore */ }
    }
    tempDirs.length = 0
  })

  function mkProjectsDir(): { claudeHome: string; cwd: string; projectsDir: string } {
    const base = mkdtempSync(join(tmpdir(), 'first-attach-replayed-'))
    tempDirs.push(base)
    const cwd = join(base, 'agent')
    const claudeHome = join(base, 'claude-home')
    const projectsDir = getProjectsDirForCwd(cwd, claudeHome)
    mkdirSync(projectsDir, { recursive: true })
    return { claudeHome, cwd, projectsDir }
  }

  const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

  const assistantModelLine = (model: string): string =>
    JSON.stringify({
      type: 'assistant',
      message: { model, content: [{ type: 'text', text: 'hi' }] },
    }) + '\n'

  function modelEvents(events: SessionEvent[]): Array<{ model: string; replayed?: boolean }> {
    return events.filter((e): e is Extract<SessionEvent, { kind: 'model' }> => e.kind === 'model')
  }

  it('mid-turn restart: replayed OLD-model lines carry replayed:true; a live line appended after attach does not', async () => {
    const { claudeHome, cwd, projectsDir } = mkProjectsDir()
    const file = join(projectsDir, 'sess.jsonl')
    // The pre-relaunch session ended mid-turn: enqueue with no turn_duration,
    // followed by an assistant line served by the OLD model.
    writeFileSync(
      file,
      ENQUEUE + '\n' + DEQUEUE + '\n' + assistantModelLine('claude-opus-4-8'),
    )

    const events: SessionEvent[] = []
    const handle = startSessionTail({
      cwd,
      claudeHome,
      rescanIntervalMs: 50,
      onEvent: (ev) => { events.push(ev) },
    })
    try {
      await wait(200) // attach + replay the in-flight turn
      const replayedBatch = modelEvents(events)
      expect(replayedBatch.length).toBeGreaterThan(0)
      // THE H2 false-positive shape: the old model arrives AFTER boot — but
      // flagged, so the divergence tripwire skips it.
      expect(replayedBatch[0]).toMatchObject({ model: 'claude-opus-4-8', replayed: true })

      // The live session now writes its first assistant line (new model).
      appendFileSync(file, assistantModelLine('claude-sonnet-5'))
      await wait(200)
      const all = modelEvents(events)
      const live = all[all.length - 1]
      expect(live.model).toBe('claude-sonnet-5')
      expect(live.replayed).not.toBe(true)
    } finally {
      handle.stop()
    }
  })

  it('completed-turn attach (no replay): appended model lines are never flagged', async () => {
    const { claudeHome, cwd, projectsDir } = mkProjectsDir()
    const file = join(projectsDir, 'sess.jsonl')
    writeFileSync(
      file,
      ENQUEUE + '\n' + assistantModelLine('claude-opus-4-8') + TURN_DURATION + '\n',
    )

    const events: SessionEvent[] = []
    const handle = startSessionTail({
      cwd,
      claudeHome,
      rescanIntervalMs: 50,
      onEvent: (ev) => { events.push(ev) },
    })
    try {
      await wait(200) // attach seeks to EOF — no replay
      expect(modelEvents(events)).toHaveLength(0)
      appendFileSync(file, assistantModelLine('claude-sonnet-5'))
      await wait(200)
      const all = modelEvents(events)
      expect(all.length).toBeGreaterThan(0)
      expect(all[all.length - 1].model).toBe('claude-sonnet-5')
      expect(all[all.length - 1].replayed).not.toBe(true)
    } finally {
      handle.stop()
    }
  })
})
