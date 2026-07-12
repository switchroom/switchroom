/**
 * Session-scoped `/model` carrier — file helpers shared by the gateway.
 *
 * Contract: reference/rfcs/session-model-stickiness.md §0.1 (rev 4, operator
 * decision 2026-07-12 — SESSION-SCOPED, superseding the rev-3 keep-by-default).
 * Files in the bind-mounted agent state dir:
 *
 *   - `.session-model` — a CONSUME-ONCE carrier written ONLY immediately
 *     before a relaunch that applies the switch (the sr-* / sr→Claude paths
 *     and a queued /model persisted at graceful shutdown). One-line JSON
 *     `{"model","configuredDefaultAtWrite","ts"}`. start.sh applies it on the
 *     single boot that reads it and then deletes it; every SUBSEQUENT restart
 *     (deploy, /restart, /new, watchdog recovery, crash, raw docker restart)
 *     finds no carrier and boots the configured default. Live Claude switches
 *     do NOT write a carrier — they apply in-session and the explicit
 *     `claude --model <configured>` flag reverts them on the next boot.
 *     Cleared live by `/model default`; invalidation (corruption / the
 *     configured yaml default changed at the apply-boot) drops it and notifies
 *     the operator chat via `.session-model-alert`.
 *
 *   - `.session-effort` — the CONSUME-ONCE effort carrier (#3186, session-
 *     scoped like `.session-model`). Same shape with `level` in place of
 *     `model`: `{"level","configuredDefaultAtWrite","ts"}`. Written ONLY by
 *     the queued-command shutdown persist (a mid-turn `/effort` carried
 *     across the bounce); start.sh resolves it into the apply-boot's
 *     `--effort` and deletes it, so any subsequent restart reverts to the
 *     configured `thinking_effort`. Live `/effort` applies record in memory
 *     only. Cleared live by `/effort default`; invalidation alerts at boot.
 *
 * The `model` token is always a canonical `claude --model` token (alias,
 * `claude-*` id, or `sr-*` id) — NEVER a display label like "Opus 4.8".
 * Shape-gated on write with the same regex start.sh greps with.
 */

import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { isValidModelArg } from './model-command.js'

export const SESSION_MODEL_FILE = '.session-model'
export const CONFIGURED_DEFAULT_MODEL_FILE = '.configured-default-model'

export interface SessionModelRecord {
  model: string
  configuredDefaultAtWrite: string
  ts: number
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
 * Write the consume-once session-model carrier. Throws on a non-canonical
 * token — callers must pass a `claude --model` token, never a display label
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

/** Delete the session-model carrier (`/model default`, rollback). Best-effort. */
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

// ─── Consume-once session-effort carrier (#3186) ────────────────────────────
//
// The `/effort` sibling of `.session-model`, session-scoped. Written ONLY by
// the queued-command shutdown persist (a mid-turn /effort carried across the
// bounce); start.sh applies it on the single boot that reads it (`--effort
// <level>`) and deletes it. Cleared live by `/effort default`; invalidation
// (configured `thinking_effort:` changed / corrupt file) alerts once at boot.

export const SESSION_EFFORT_FILE = '.session-effort'

/**
 * The level allowlist, duplicated from effort-command.ts to avoid a cycle
 * (effort-command must stay gateway-agnostic; this module already imports
 * from model-command). Kept in sync by the cross-check regression test.
 */
const EFFORT_LEVEL_RE = /^(low|medium|high|xhigh|max)$/

export interface SessionEffortRecord {
  level: string
  /** The cascade-resolved `thinking_effort` at write time ('' when unset). */
  configuredDefaultAtWrite: string
  ts: number
}

/** Parse `.session-effort` content. Null on corrupt JSON / bad shape / non-allowlisted level. */
export function parseSessionEffort(text: string): SessionEffortRecord | null {
  try {
    const raw = JSON.parse(text) as Partial<SessionEffortRecord>
    if (
      typeof raw.level !== 'string' ||
      typeof raw.configuredDefaultAtWrite !== 'string' ||
      typeof raw.ts !== 'number' ||
      !EFFORT_LEVEL_RE.test(raw.level)
    ) {
      return null
    }
    return { level: raw.level, configuredDefaultAtWrite: raw.configuredDefaultAtWrite, ts: raw.ts }
  } catch {
    return null
  }
}

/**
 * Write the consume-once effort carrier. Throws on a non-allowlisted level —
 * the value is passed verbatim to `claude --effort` at the next boot (the
 * apply-boot, which consumes the file).
 */
export function writeSessionEffortFile(
  agentDir: string,
  level: string,
  configuredDefaultAtWrite: string | null,
): void {
  if (!EFFORT_LEVEL_RE.test(level)) {
    throw new Error(`refusing to persist non-allowlisted effort level: ${JSON.stringify(level)}`)
  }
  atomicWrite(
    join(agentDir, SESSION_EFFORT_FILE),
    `${JSON.stringify({ level, configuredDefaultAtWrite: configuredDefaultAtWrite ?? '', ts: Date.now() })}\n`,
  )
}

/** Parsed effort carrier, or null when absent/corrupt. */
export function readSessionEffortFile(agentDir: string): SessionEffortRecord | null {
  try {
    return parseSessionEffort(readFileSync(join(agentDir, SESSION_EFFORT_FILE), 'utf8'))
  } catch {
    return null
  }
}

/** Delete the effort carrier (`/effort default`, leftover hygiene). Best-effort. */
export function clearSessionEffortFile(agentDir: string): void {
  try {
    rmSync(join(agentDir, SESSION_EFFORT_FILE), { force: true })
  } catch {
    /* best-effort */
  }
}

// ─── Consume-once premium-recovery marker (tier-downgrade companion) ─────────
//
// A DURABLE marker the tier-downgrade writes when it walls a premium `/model`
// selection fleet-wide. It records the DROPPED premium token + the chats to
// notify, and survives the downgrade self-restart (start.sh never touches this
// name — unlike `.session-model`, which is consumed at boot). The gateway's
// `runQuotaWatch` tick reads it, and when the broker's `list-state` shows the
// premium tier servable again (deterministic per-account eligibility), fires
// EXACTLY ONE "available again" ping with a one-tap switch-back button, then
// clears the marker (at-most-once). Also cleared the instant the user re-issues
// `/model <premium>` manually (no stale ping). Shape-gated like the carriers
// above — the model token passes the same MODEL_ARG_RE gate.

export const PREMIUM_RECOVERY_FILE = '.premium-recovery'

export interface PremiumRecoveryRecord {
  /** The dropped premium `/model` token (e.g. `fable`) to offer switching back to. */
  premiumModel: string
  /** Telegram chat ids to ping on recovery (the downgrade notice's allowFrom). */
  chats: string[]
  ts: number
}

/**
 * Parse `.premium-recovery` content. Null on corrupt JSON, a missing/wrong-typed
 * field, a model token that fails the MODEL_ARG_RE shape gate, or a `chats`
 * array that is not a non-empty list of non-empty strings.
 */
export function parsePremiumRecovery(text: string): PremiumRecoveryRecord | null {
  try {
    const raw = JSON.parse(text) as Partial<PremiumRecoveryRecord>
    if (
      typeof raw.premiumModel !== 'string' ||
      !isValidModelArg(raw.premiumModel) ||
      typeof raw.ts !== 'number' ||
      !Array.isArray(raw.chats) ||
      raw.chats.length === 0 ||
      !raw.chats.every((c) => typeof c === 'string' && c.length > 0)
    ) {
      return null
    }
    return { premiumModel: raw.premiumModel, chats: raw.chats, ts: raw.ts }
  } catch {
    return null
  }
}

/**
 * Write the premium-recovery marker. Throws on a non-canonical token (parity
 * with the carriers) or an empty chat list — a marker with nowhere to ping is a
 * bug, not a silent no-op.
 */
export function writePremiumRecoveryFile(
  agentDir: string,
  premiumModel: string,
  chats: string[],
): void {
  if (!isValidModelArg(premiumModel)) {
    throw new Error(`refusing to persist non-canonical premium-recovery token: ${JSON.stringify(premiumModel)}`)
  }
  const clean = chats.filter((c) => typeof c === 'string' && c.length > 0)
  if (clean.length === 0) {
    throw new Error('refusing to persist premium-recovery marker with no chats to notify')
  }
  atomicWrite(
    join(agentDir, PREMIUM_RECOVERY_FILE),
    `${JSON.stringify({ premiumModel, chats: clean, ts: Date.now() })}\n`,
  )
}

/**
 * Parsed premium-recovery marker, or null when absent/corrupt. A present-but-
 * corrupt marker (null parse of a file that exists) is SWEPT on read: neither
 * the ping path nor `clearPremiumRecoveryOnManualSwitch` can act on a null
 * parse, so a garbled file would otherwise linger forever. Deleting it here is
 * best-effort hygiene — the read still returns null either way.
 */
export function readPremiumRecoveryFile(agentDir: string): PremiumRecoveryRecord | null {
  let raw: string
  try {
    raw = readFileSync(join(agentDir, PREMIUM_RECOVERY_FILE), 'utf8')
  } catch {
    return null // absent / unreadable — nothing on disk to sweep.
  }
  const parsed = parsePremiumRecovery(raw)
  if (parsed == null) {
    // Corrupt marker present on disk — garbage-collect it so it can't wedge the
    // recovery path (best-effort; a failed unlink still returns null).
    clearPremiumRecoveryFile(agentDir)
    return null
  }
  return parsed
}

/** Delete the premium-recovery marker (consumed on ping / manual re-issue). Best-effort. */
export function clearPremiumRecoveryFile(agentDir: string): void {
  try {
    rmSync(join(agentDir, PREMIUM_RECOVERY_FILE), { force: true })
  } catch {
    /* best-effort */
  }
}
