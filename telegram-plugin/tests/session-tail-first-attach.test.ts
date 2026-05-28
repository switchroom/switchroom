import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeFirstAttachCursor } from '../session-tail.js'

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
