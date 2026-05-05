/**
 * Pty-tail extractor against a tmux pipe-pane fragment (#725).
 *
 * Under the tmux supervisor, `service.log` is fed by
 * `tmux pipe-pane -o ... 'cat >> service.log'` instead of `script -qfc`
 * directly. The bytes are the same xterm escape stream Claude writes
 * to its PTY (tmux just splits the stream), but it's worth pinning a
 * fixture so a future tmux-config regression (different terminal type,
 * stripped escapes, etc.) can't silently break extraction.
 *
 * Fixture: small synthesized Ink-style fragment containing a
 * `● switchroom-telegram - reply (MCP)(... text: "...")` marker.
 * Kept ≤2KB.
 */

import { describe, expect, it } from 'vitest'
import { Terminal } from '@xterm/headless'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import { V1Extractor } from '../pty-tail.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE_PATH = resolve(__dirname, 'fixtures', 'pty-tail-tmux-fragment.bin')

async function feed(input: string): Promise<Terminal> {
  const term = new Terminal({
    cols: 132,
    rows: 40,
    scrollback: 5000,
    allowProposedApi: true,
  })
  await new Promise<void>((res) => {
    term.write(input, () => res())
  })
  return term
}

describe('V1Extractor — tmux pipe-pane fragment (#725)', () => {
  it('fixture is small (≤2KB) so test data stays cheap to maintain', () => {
    const bytes = readFileSync(FIXTURE_PATH)
    expect(bytes.length).toBeLessThanOrEqual(2048)
    expect(bytes.length).toBeGreaterThan(0)
  })

  it('extracts the reply text from a synthesized tmux pipe-pane fragment', async () => {
    const raw = readFileSync(FIXTURE_PATH, 'utf8')
    const term = await feed(raw)
    const extracted = new V1Extractor().extract(term)
    expect(extracted).not.toBeNull()
    // Continuation lines collapse to single-spaced text.
    expect(extracted).toContain('Hello')
    expect(extracted).toContain('from tmux pipe-pane fragment')
  })
})
