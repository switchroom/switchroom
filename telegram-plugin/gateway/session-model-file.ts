/**
 * Durable session-model stickiness — file helpers shared by the gateway.
 *
 * Two files in the bind-mounted agent state dir carry the contract
 * (reference/rfcs/session-model-stickiness.md):
 *
 *   - `.session-model` — the DURABLE session override written on every
 *     positively-confirmed `/model` switch. One-line JSON
 *     `{"model","configuredDefaultAtWrite","ts"}`. It is NOT consumed by a
 *     keep-path boot; start.sh deletes it on revert / invalidation /
 *     corruption / 7-day staleness, and the gateway deletes it on
 *     `/model default`.
 *
 *   - `.relaunch-model-intent` — the ONE-SHOT intent bit for the next boot.
 *     One-line JSON `{"intent":"keep"|"revert","reason","ts"}`, atomic
 *     write, last-writer-wins. Boot default is REVERT (operator decision:
 *     a raw `docker restart` / host reboot / crash must revert to the yaml
 *     model), so every switchroom-managed KEEP path must stamp keep-intent
 *     BEFORE the bounce. start.sh consumes it (rm -f) every boot; a stale
 *     (>10 min by the embedded ts) or corrupt intent counts as no intent.
 *
 * The `model` token is always a canonical `claude --model` token (alias,
 * `claude-*` id, or `sr-*` id) — NEVER a display label like "Opus 4.8".
 * Shape-gated on write with the same regex start.sh greps with.
 */

import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isValidModelArg } from './model-command.js'

export const SESSION_MODEL_FILE = '.session-model'
export const RELAUNCH_MODEL_INTENT_FILE = '.relaunch-model-intent'
export const CONFIGURED_DEFAULT_MODEL_FILE = '.configured-default-model'

export type RelaunchModelIntent = 'keep' | 'revert'

export interface SessionModelRecord {
  model: string
  configuredDefaultAtWrite: string
  ts: number
}

/**
 * Restart reasons whose semantics are "revert the session model to the
 * configured default". Everything else `triggerSelfRestart` fires with is a
 * switchroom-managed relaunch (watchdog recovery, drain-cap bounce,
 * turn-complete deferred restart, fleet-fallback resume, sr-to-claude model
 * switch, grant restarts) and KEEPS the override — the whole point of the
 * stickiness contract. Enumerated in the RFC §3; default-keep here is safe
 * because only gateway code calls triggerSelfRestart, and a bounce nobody
 * stamped (crash, raw docker restart, deploy) reverts by boot default anyway.
 */
const REVERT_RESTART_REASONS: ReadonlySet<string> = new Set(['inline-button-restart'])

/** Classify a triggerSelfRestart reason into the intent the boot should honor. */
export function intentForRestartReason(reason: string): RelaunchModelIntent {
  return REVERT_RESTART_REASONS.has(reason) ? 'revert' : 'keep'
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, path)
}

/** Serialize a `.session-model` record (one line + trailing newline). */
export function serializeSessionModel(rec: SessionModelRecord): string {
  return `${JSON.stringify({
    model: rec.model,
    configuredDefaultAtWrite: rec.configuredDefaultAtWrite,
    ts: rec.ts,
  })}\n`
}

/**
 * Parse `.session-model` content. Returns null on corrupt JSON, a missing /
 * non-string field, or a model token that fails the MODEL_ARG_RE shape gate
 * (never trust an unvalidated string near `claude --model`).
 */
export function parseSessionModel(text: string): SessionModelRecord | null {
  try {
    const raw = JSON.parse(text) as Partial<SessionModelRecord>
    if (
      typeof raw.model !== 'string' ||
      typeof raw.configuredDefaultAtWrite !== 'string' ||
      typeof raw.ts !== 'number' ||
      !isValidModelArg(raw.model)
    ) {
      return null
    }
    return { model: raw.model, configuredDefaultAtWrite: raw.configuredDefaultAtWrite, ts: raw.ts }
  } catch {
    return null
  }
}

/**
 * Write the durable session override. Throws on a non-canonical token —
 * callers must pass a `claude --model` token, never a display label
 * (regression guard for the "Opus 4.5 persisted" class).
 */
export function writeSessionModelFile(
  agentDir: string,
  model: string,
  configuredDefaultAtWrite: string,
): void {
  if (!isValidModelArg(model)) {
    throw new Error(`refusing to persist non-canonical session model token: ${JSON.stringify(model)}`)
  }
  atomicWrite(
    join(agentDir, SESSION_MODEL_FILE),
    serializeSessionModel({ model, configuredDefaultAtWrite, ts: Date.now() }),
  )
}

/** Raw file text (for rollback snapshots), or null when absent/unreadable. */
export function readSessionModelFileRaw(agentDir: string): string | null {
  try {
    return readFileSync(join(agentDir, SESSION_MODEL_FILE), 'utf8')
  } catch {
    return null
  }
}

/** Parsed durable override, or null when absent/corrupt. */
export function readSessionModelFile(agentDir: string): SessionModelRecord | null {
  const raw = readSessionModelFileRaw(agentDir)
  return raw == null ? null : parseSessionModel(raw)
}

/** Delete the durable override (`/model default`, rollback). Best-effort. */
export function clearSessionModelFile(agentDir: string): void {
  try {
    rmSync(join(agentDir, SESSION_MODEL_FILE), { force: true })
  } catch {
    /* best-effort */
  }
}

/** Restore a rollback snapshot taken with readSessionModelFileRaw. */
export function restoreSessionModelFileRaw(agentDir: string, raw: string | null): void {
  if (raw == null) {
    clearSessionModelFile(agentDir)
    return
  }
  try {
    atomicWrite(join(agentDir, SESSION_MODEL_FILE), raw)
  } catch {
    /* best-effort */
  }
}

/**
 * Stamp the one-shot relaunch intent. MUST be called synchronously BEFORE
 * the restart signal/dispatch it describes (write-before-kill invariant —
 * the next start.sh boot reads this to decide keep vs revert). Best-effort:
 * a failed write means the boot falls back to the default (revert), which
 * is the safe side.
 */
export function writeRelaunchModelIntent(
  agentDir: string,
  intent: RelaunchModelIntent,
  reason: string,
): void {
  try {
    atomicWrite(
      join(agentDir, RELAUNCH_MODEL_INTENT_FILE),
      `${JSON.stringify({ intent, reason, ts: Date.now() })}\n`,
    )
  } catch (err) {
    process.stderr.write(
      `telegram gateway: relaunch-model-intent write failed (boot will revert): ${(err as Error)?.message ?? String(err)}\n`,
    )
  }
}

/**
 * Reason prefix the gateway's SIGTERM/SIGINT shutdown handler stamps on its
 * deploy-survival keep-intent (#3017/#3018). Distinguishable on purpose:
 * a gateway-only bounce (supervisor relaunch, bare gateway-unit restart)
 * leaves that stamp UNCONSUMED on disk — start.sh only runs on a container
 * boot — and the next gateway boot uses this prefix to recognise and clear
 * the stale stamp (see clearStaleGatewayShutdownIntent).
 */
export const GATEWAY_SHUTDOWN_INTENT_REASON_PREFIX = 'gateway-shutdown:'

export interface RelaunchModelIntentRecord {
  intent: RelaunchModelIntent
  reason: string
  ts: number
}

/** Parsed `.relaunch-model-intent`, or null when absent / corrupt / malformed. */
export function readRelaunchModelIntent(agentDir: string): RelaunchModelIntentRecord | null {
  try {
    const raw = readFileSync(join(agentDir, RELAUNCH_MODEL_INTENT_FILE), 'utf8')
    const parsed = JSON.parse(raw) as Partial<RelaunchModelIntentRecord>
    if (
      (parsed.intent !== 'keep' && parsed.intent !== 'revert') ||
      typeof parsed.reason !== 'string' ||
      typeof parsed.ts !== 'number'
    ) {
      return null
    }
    return { intent: parsed.intent, reason: parsed.reason, ts: parsed.ts }
  } catch {
    return null
  }
}

/**
 * Boot-time cleanup for the gateway-only-bounce hole (#3018 finding 4).
 *
 * A container-level stop/deploy consumes `.relaunch-model-intent` in start.sh
 * BEFORE any gateway boots. So if a freshly-booting GATEWAY still sees an
 * intent that a gateway shutdown handler stamped (reason carries
 * GATEWAY_SHUTDOWN_INTENT_REASON_PREFIX), the preceding bounce was
 * gateway-only — the container never restarted and the stamp is stale.
 * Left in place, it could convert a genuine crash within the 10-min
 * freshness window into a "keep", breaking the crash-reverts policy.
 * Clear it. Never touches a triggerSelfRestart / user-slash stamp (those
 * use their own un-prefixed reasons and precede a container bounce).
 * Returns true when a stale stamp was cleared.
 */
export function clearStaleGatewayShutdownIntent(agentDir: string): boolean {
  const rec = readRelaunchModelIntent(agentDir)
  if (rec == null || !rec.reason.startsWith(GATEWAY_SHUTDOWN_INTENT_REASON_PREFIX)) return false
  clearRelaunchModelIntent(agentDir)
  return true
}

/** Remove a stamped intent (rollback of a failed dispatch). Best-effort. */
export function clearRelaunchModelIntent(agentDir: string): void {
  try {
    rmSync(join(agentDir, RELAUNCH_MODEL_INTENT_FILE), { force: true })
  } catch {
    /* best-effort */
  }
}

/**
 * The resolved configured default start.sh recorded this boot
 * (`.configured-default-model`, written before override resolution — the
 * same resolver output the invalidation compare uses). Null when missing.
 */
export function readConfiguredDefaultModel(agentDir: string): string | null {
  try {
    const v = readFileSync(join(agentDir, CONFIGURED_DEFAULT_MODEL_FILE), 'utf8').trim()
    return v.length > 0 ? v : null
  } catch {
    return null
  }
}
