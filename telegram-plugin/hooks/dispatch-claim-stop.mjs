#!/usr/bin/env node
/**
 * Stop hook (#396) — deterministic guardrail against "narrate a dispatch
 * without executing it".
 *
 * The defect: the model replies "Dispatching a worker now to fix this",
 * the user sees a confident hand-off, but the turn contains no `Agent` /
 * `Task` tool call and no backgrounded `Bash` — nothing was actually
 * dispatched. The #1664 silent-end Stop gate does NOT catch this: that
 * turn HAS a qualifying final reply, so it passes untouched.
 *
 * This hook, at Stop, scans the just-finished turn's transcript slice for
 * a reply that makes a first-person dispatch commitment while the turn
 * dispatched nothing, and re-prompts the model exactly once to actually
 * dispatch (or send a correction reply). See `dispatch-claim-scan.mjs`
 * for the pure decision logic and the registry-check rationale.
 *
 * Protocol (Claude Code Stop hook v1):
 *   Input:  JSON on stdin — { session_id, transcript_path, ... }
 *   Output: exit 0 + empty stdout → allow stop.
 *           exit 0 + JSON stdout { decision: "block", reason } → re-prompt.
 *
 * Fail-open on EVERY error path (no transcript / unreadable / no
 * turn-start anchor / state-file failure) — consistent with every sibling
 * reply-path hook. A mis-firing gate must never loop a session; the
 * 1-retry budget bounds the block direction on top of that.
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

import { scanTurnForDispatchClaim, applyRetryBudget } from './dispatch-claim-scan.mjs'

// Exactly one re-prompt per turn (#396 design). A second Stop fire on the
// same turn (same turnSig) exhausts the budget and fails open.
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

  let event
  try {
    event = JSON.parse(raw)
  } catch {
    process.exit(0)
  }

  const transcriptPath = event?.transcript_path
  if (!transcriptPath || typeof transcriptPath !== 'string' || !existsSync(transcriptPath)) {
    process.exit(0)
  }

  let jsonl
  try {
    jsonl = readFileSync(transcriptPath, 'utf8')
  } catch (err) {
    process.stderr.write(
      `[dispatch-claim] failed to read transcript ${transcriptPath}: ${err.message}\n`,
    )
    process.exit(0)
  }

  const decision = scanTurnForDispatchClaim(jsonl)

  // 'allow' (no unbacked claim) and 'unknown' (no turn-start anchor) both
  // allow the stop.
  if (decision.decided !== 'block') {
    process.exit(0)
  }

  // 1-retry budget, keyed on the per-turn signature so a second Stop fire
  // on the SAME turn fails open while a genuinely new turn starts fresh.
  const statePath = join(getStateDir(), 'dispatch-claim-pending.json')

  let state = {}
  if (existsSync(statePath)) {
    try {
      state = JSON.parse(readFileSync(statePath, 'utf8'))
    } catch {
      state = {}
    }
  }

  const budget = applyRetryBudget(state, decision.turnSig, MAX_RETRIES)
  if (!budget.block) {
    process.stderr.write(
      `[dispatch-claim] retry budget exhausted for turn ${decision.turnSig} — allowing stop\n`,
    )
    process.exit(0)
  }

  try {
    writeFileSync(statePath, JSON.stringify(budget.nextState), 'utf8')
  } catch (err) {
    // Fail-open: a retry-count write failure must not loop the session.
    process.stderr.write(`[dispatch-claim] failed to update state file: ${err.message}\n`)
    process.exit(0)
  }

  process.stderr.write(
    `[dispatch-claim] blocking stop to re-prompt agent (reason=${decision.reason} turn=${decision.turnSig})\n`,
  )

  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason:
        'Your reply told the user you dispatched work, but no Agent/Task call ' +
        'ran this turn. Actually dispatch it now, or send a correction reply.',
    }),
  )
  process.exit(0)
}

main()
