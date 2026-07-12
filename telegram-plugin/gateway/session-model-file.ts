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
 *   - `.session-effort` — the DURABLE effort override (#3039), still
 *     keep-across-restarts (NOT changed by rev 4). Same shape as
 *     `.session-model` with `level` in place of `model`:
 *     `{"level","configuredDefaultAtWrite","ts"}`. Written on every
 *     positively-confirmed `/effort` apply, resolved by start.sh into the
 *     relaunch's `--effort`, cleared only by `/effort default` or
 *     invalidation (with a boot alert).
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

// ─── Durable session-effort override (#3039) ────────────────────────────────
//
// The `/effort` sibling of `.session-model`. Same lifecycle: written on every
// positively-confirmed effort apply, honored by start.sh on every boot
// (`--effort <level>`), cleared only by `/effort default` or invalidation
// (configured `thinking_effort:` changed / corrupt file — both alert once).

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
 * Write the durable effort override. Throws on a non-allowlisted level —
 * the value is passed verbatim to `claude --effort` at the next boot.
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

/** Parsed durable effort override, or null when absent/corrupt. */
export function readSessionEffortFile(agentDir: string): SessionEffortRecord | null {
  try {
    return parseSessionEffort(readFileSync(join(agentDir, SESSION_EFFORT_FILE), 'utf8'))
  } catch {
    return null
  }
}

/** Delete the durable effort override (`/effort default`). Best-effort. */
export function clearSessionEffortFile(agentDir: string): void {
  try {
    rmSync(join(agentDir, SESSION_EFFORT_FILE), { force: true })
  } catch {
    /* best-effort */
  }
}
