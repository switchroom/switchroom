#!/usr/bin/env node
/**
 * Stop hook — auto-interrupt for silent-end turns.
 *
 * When a Claude Code session ends without the agent having called reply or
 * stream_reply (a "silent-end"), the Telegram gateway writes a state file at
 * $TELEGRAM_STATE_DIR/silent-end-pending.json. This hook reads that file and,
 * if a first-time silent-end is detected (retryCount === 0), returns a
 * decision:block to re-prompt the agent instead of letting the session close.
 *
 * On the second silent-end (retryCount >= MAX_RETRIES), the hook allows the
 * stop so the gateway can render the "🙊 Ended without reply" warning card.
 *
 * Carve-outs preserved:
 *   - wasAutonomous=true turns: the gateway never writes a state file for
 *     these (no reply expected on autonomous wakeup turns).
 *   - Turns with running sub-agents: the gateway only fires onSilentEnd after
 *     all sub-agents have finished (same gate as completeTurnFully).
 *
 * Protocol:
 *   Input:  JSON on stdin — { session_id, transcript_path, ... }
 *   Output: exit 0 + empty stdout → allow stop.
 *           exit 0 + JSON stdout { decision: "block", reason: "..." } → re-prompt.
 *
 * Fail-open on any error — if we can't read/write the state file, allow stop
 * rather than blocking every session close.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const MAX_RETRIES = 1

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function getStateDir() {
  return process.env.TELEGRAM_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'telegram')
}

function main() {
  const raw = readStdin().trim()
  if (!raw) process.exit(0)

  // Parse the Stop hook input (fail-open)
  let _event
  try {
    _event = JSON.parse(raw)
  } catch {
    process.exit(0)
  }

  const stateDir = getStateDir()
  const statePath = join(stateDir, 'silent-end-pending.json')

  if (!existsSync(statePath)) {
    // No silent-end pending — normal completion, allow stop.
    process.exit(0)
  }

  let state
  try {
    state = JSON.parse(readFileSync(statePath, 'utf8'))
  } catch {
    // Corrupt state file — fail-open, allow stop.
    process.exit(0)
  }

  const retryCount = typeof state.retryCount === 'number' ? state.retryCount : 0

  if (retryCount >= MAX_RETRIES) {
    // Retry exhausted — let the session end so the gateway can render the
    // warning card.
    process.stderr.write(
      `[silent-end-interrupt] retry exhausted (retryCount=${retryCount} >= MAX_RETRIES=${MAX_RETRIES}) — allowing stop\n`,
    )
    process.exit(0)
  }

  // First silent-end: increment retryCount and block to re-prompt the agent.
  try {
    writeFileSync(statePath, JSON.stringify({ ...state, retryCount: retryCount + 1 }), 'utf8')
  } catch (err) {
    process.stderr.write(`[silent-end-interrupt] failed to update state file: ${err.message}\n`)
    // Fail-open: allow stop rather than blocking forever.
    process.exit(0)
  }

  process.stderr.write(
    `[silent-end-interrupt] blocking stop to re-prompt agent (chatId=${state.chatId ?? '?'} retryCount was ${retryCount})\n`,
  )

  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason:
        'You ran tools but never sent a reply to the user. ' +
        'Call mcp__switchroom-telegram__reply or mcp__switchroom-telegram__stream_reply (with done=true) ' +
        'to send your final answer now.',
    }),
  )
  process.exit(0)
}

main()
