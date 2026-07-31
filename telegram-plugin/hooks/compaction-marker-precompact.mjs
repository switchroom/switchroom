#!/usr/bin/env node
/**
 * PreCompact hook — marks "compaction in flight" for the gateway (#4058).
 *
 * Claude Code PreCompact protocol:
 *   Input:  JSON on stdin — { session_id, transcript_path, cwd,
 *           hook_event_name: "PreCompact", trigger: "auto"|"manual",
 *           custom_instructions }
 *   Output: exit 0 + empty stdout → proceed. We NEVER block compaction and
 *           NEVER exit non-zero.
 *
 * Side effect: writes (overwrites) ONE small JSON file
 *   $TELEGRAM_STATE_DIR/compaction-in-flight.json
 * with shape { ts, session_id, trigger }.
 *
 * Why: during mid-turn auto-compaction the model emits zero output and runs
 * zero tools for minutes, so the gateway's silence-poke saw pure silence and
 * fired its 300s "stalled turn" fallback on a healthy turn. The transcript
 * only records compaction at its END (`system/compact_boundary` carries the
 * compaction's own durationMs), so this hook is the one observable START
 * signal. The gateway reads the marker's mtime (compaction-marker.ts) to
 * DEFER the fallback — bounded by the same hard ceiling as the in-flight-tool
 * defer — and removes it when the compact_boundary lands.
 *
 * If $TELEGRAM_STATE_DIR is unset → silent skip (dev / one-shot contexts;
 * the fallback just keeps its pre-#4058 behaviour).
 */

import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

function readStdin() {
  try {
    return readFileSync(0, 'utf8')
  } catch {
    return ''
  }
}

function main() {
  const stateDir = process.env.TELEGRAM_STATE_DIR
  if (!stateDir) return

  let payload = {}
  try {
    payload = JSON.parse(readStdin() || '{}')
  } catch {
    // Unparseable stdin — still write the marker: the mtime alone carries
    // the load-bearing signal; the body fields are diagnostics.
  }

  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(
      join(stateDir, 'compaction-in-flight.json'),
      JSON.stringify({
        ts: Date.now(),
        session_id: typeof payload.session_id === 'string' ? payload.session_id : null,
        trigger: typeof payload.trigger === 'string' ? payload.trigger : null,
      }) + '\n',
      { mode: 0o600 },
    )
  } catch {
    // Best-effort: a missed marker just reverts one fallback decision to
    // the pre-#4058 behaviour. Never fail the hook (never block compaction).
  }
}

main()
process.exit(0)
