/**
 * tier-downgrade.ts — MODEL-TIER downgrade failover (second recovery tier).
 *
 * The problem this owns:
 *   A user selects a premium model (e.g. `/model fable`). Mid-turn that model
 *   is overloaded / throttled fleet-wide (HTTP 529 / 429 / overloaded_error /
 *   503). The FIRST recovery tier — account-level failover (swap the OAuth
 *   account, same model) — is tried first and already exists
 *   (`runFleetAutoFallback` → `doFireFleetAutoFallback`). When that comes back
 *   `all-blocked` (no account still serves the premium model), the live turn
 *   would otherwise stall silently. This module adds a SECOND, lower-priority
 *   tier: DOWNGRADE the session to the agent's configured default model (the
 *   fleet default is `opus`) and resume, so the turn keeps moving.
 *
 * Precedence (HARD): account-swap FIRST. The gateway only consults this module
 * inside the `all-blocked` branch of `doFireFleetAutoFallback` — i.e. AFTER
 * account-swap has been tried and found no eligible account. A `switched`
 * outcome never reaches here (the existing resume-after-swap path handles it),
 * so a premium model that is merely throttled on ONE account is recovered by
 * account-swap, never by a downgrade.
 *
 * Revert is NATIVE (do not fight it). The downgrade writes a CONSUME-ONCE
 * `.session-model` carrier for the configured default
 * (reference/rfcs/session-model-stickiness.md §0.1 rev 4): start.sh applies it
 * on the single boot that reads it, deletes it, and every SUBSEQUENT restart
 * reverts to the configured default for free. The premium /model override was
 * itself session-scoped (a live Claude switch writes no carrier), so the
 * downgrade boot naturally lands on the configured default; writing the carrier
 * makes that DETERMINISTIC even if a stray carrier is on disk.
 *
 * Effort is NATIVE too. A live `/effort` override records in gateway memory
 * only (no carrier), so the self-restart sheds it and the downgraded default
 * boots at the configured `thinking_effort` (the fleet `low` pin, #1978 /
 * src/config/thinking-effort-risk.ts). This module writes NO effort carrier —
 * that is the whole point: the downgraded opus must resolve LOW.
 *
 * Loop guard (survives restart). The gate is bounded so a turn that dies AGAIN
 * during its own downgrade-resume is named-as-lost rather than looped forever:
 *   - The natural guard: after the downgrade boot the session is ON the
 *     configured default (override null), so a second `all-blocked` finds no
 *     premium tier and `decide()` returns `skip` — no re-downgrade.
 *   - The belt-and-suspenders guard: a restart-surviving
 *     `.tier-downgrade-attempts` counter caps consecutive downgrades per
 *     interruption chain (default 1). A record older than `staleMs` starts a
 *     fresh chain, so a later INDEPENDENT interruption can downgrade again.
 *
 * NB — carrier-name choice. The in-memory single-flight latch in
 * fleet-fallback-resume.ts does NOT survive the restart, and the historical
 * `.session-model-boot-attempts` filename is UNUSABLE as a boot-surviving guard
 * on current main: start.sh unconditionally `rm -f`s it every boot (retired
 * with the rev-3 crashloop self-heal, session-model-stickiness.md §0.1). So the
 * loop guard uses a DISTINCT file, `.tier-downgrade-attempts`, that start.sh
 * never touches — the durable equivalent of the premise's intent.
 *
 * This module is pure at its core (`decideTierDowngrade`) so the decision is
 * unit-testable without a process restart; the small FS helpers for the counter
 * file live here too (they mirror session-model-file.ts's shape).
 */

import { readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'

export const TIER_DOWNGRADE_ATTEMPTS_FILE = '.tier-downgrade-attempts'

/** Consecutive downgrades allowed per interruption chain. The 2nd consecutive
 *  downgrade-resume failure is named-as-lost, never attempted. */
export const DEFAULT_MAX_TIER_DOWNGRADES = 1

/** An attempts record older than this is a FRESH chain (a later independent
 *  interruption), not a continuation of a storm. Comfortably longer than a
 *  restart + boot-resume cycle so a genuine loop (which cycles in seconds) is
 *  always caught, while an unrelated overload minutes later can downgrade
 *  again. */
export const DEFAULT_TIER_DOWNGRADE_STALE_MS = 600_000 // 10 min

export interface TierDowngradeAttempts {
  /** Number of downgrades fired in the current chain. */
  count: number
  /** The premium model that was walled when the chain started (observability). */
  premiumModel: string
  /** Wall-clock ms of the most recent downgrade in the chain. */
  ts: number
}

export type TierDowngradeDecision =
  | {
      /** Fire the downgrade: write a consume-once carrier for `toModel`, persist
       *  `nextAttempts`, and self-restart to resume the dead turn. */
      action: 'downgrade'
      toModel: string
      fromModel: string
      nextAttempts: TierDowngradeAttempts
    }
  | {
      /** The downgrade budget is spent for this chain — name the turn as lost
       *  (surface to the operator) and do NOT restart. */
      action: 'exhausted'
      premiumModel: string
    }
  | {
      /** No downgrade is warranted. `on-default`: the session is already on the
       *  configured default (nothing lower to fall to). `unresolved`: the
       *  configured default could not be read (never downgrade blind). */
      action: 'skip'
      reason: 'on-default' | 'unresolved'
    }

export interface TierDowngradeInput {
  /** The live session model override (`sessionModelSource.getOverride()`), or
   *  null when the session is running the plain configured default. Null is the
   *  common "on default" signal (boot seeding leaves it null when the launched
   *  model equals the configured default). */
  sessionOverride: string | null
  /** The resolved configured default model token (from
   *  `.configured-default-model` / `resolveMainModel`). Empty/undefined => the
   *  boot record was unreadable and we must not downgrade blind. */
  configuredDefault: string | null | undefined
  /** Canonicalizer so `sessionOverride` and `configuredDefault` compare in the
   *  same dialect (the gateway passes `resolveMainModel`). Keeps `opus` from
   *  spuriously reading as a premium tier over a `claude-opus-*`-shaped default
   *  and vice versa, as far as the resolver can. */
  resolve: (token: string) => string
  /** The parsed `.tier-downgrade-attempts` counter, or null when absent/corrupt. */
  attempts: TierDowngradeAttempts | null
  /** Now, epoch ms. */
  now: number
  /** Override the staleness window (tests). */
  staleMs?: number
  /** Override the per-chain downgrade cap (tests). */
  maxDowngrades?: number
}

/**
 * Decide whether — and to what — the walled premium session should downgrade.
 * PURE: no FS, no clock, no restart. The gateway does the I/O and the restart
 * off this verdict.
 */
export function decideTierDowngrade(input: TierDowngradeInput): TierDowngradeDecision {
  const staleMs = input.staleMs ?? DEFAULT_TIER_DOWNGRADE_STALE_MS
  const maxDowngrades = input.maxDowngrades ?? DEFAULT_MAX_TIER_DOWNGRADES

  const configured =
    typeof input.configuredDefault === 'string' ? input.configuredDefault.trim() : ''
  if (configured.length === 0) {
    // No configured-default record — never downgrade to an unknown model.
    return { action: 'skip', reason: 'unresolved' }
  }

  const override = input.sessionOverride
  if (override == null || override.length === 0) {
    // On the configured default already — no lower tier to fall to.
    return { action: 'skip', reason: 'on-default' }
  }

  // Canonicalize both sides so an alias vs resolved-id spelling of the SAME
  // model reads as "on default", never as a premium tier (which would loop).
  if (input.resolve(override) === input.resolve(configured)) {
    return { action: 'skip', reason: 'on-default' }
  }

  // A premium model is active AND walled fleet-wide. Consult the loop guard.
  const fresh = input.attempts != null && input.now - input.attempts.ts <= staleMs
    ? input.attempts
    : null
  const priorCount = fresh?.count ?? 0
  if (priorCount >= maxDowngrades) {
    // Already downgraded this chain and it died again → name-as-lost.
    return { action: 'exhausted', premiumModel: override }
  }

  return {
    action: 'downgrade',
    toModel: configured,
    fromModel: override,
    nextAttempts: { count: priorCount + 1, premiumModel: override, ts: input.now },
  }
}

// ─── `.tier-downgrade-attempts` counter file (restart-surviving loop guard) ──
//
// Deliberately NOT `.session-model-boot-attempts`: start.sh `rm -f`s that name
// every boot (retired rev-4 hygiene), so it cannot survive a restart. This file
// is untouched by start.sh — the gateway is its only reader/writer.

/** Parse the counter file. Null on corrupt JSON or a bad shape. */
export function parseTierDowngradeAttempts(text: string): TierDowngradeAttempts | null {
  try {
    const raw = JSON.parse(text) as Partial<TierDowngradeAttempts>
    if (
      typeof raw.count !== 'number' ||
      !Number.isFinite(raw.count) ||
      raw.count < 0 ||
      typeof raw.premiumModel !== 'string' ||
      typeof raw.ts !== 'number' ||
      !Number.isFinite(raw.ts)
    ) {
      return null
    }
    return { count: raw.count, premiumModel: raw.premiumModel, ts: raw.ts }
  } catch {
    return null
  }
}

export function serializeTierDowngradeAttempts(rec: TierDowngradeAttempts): string {
  return `${JSON.stringify({ count: rec.count, premiumModel: rec.premiumModel, ts: rec.ts })}\n`
}

function atomicWrite(path: string, content: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, path)
}

/** Read + parse the counter for `agentDir`, or null when absent/corrupt. */
export function readTierDowngradeAttempts(agentDir: string): TierDowngradeAttempts | null {
  try {
    const raw = readFileSync(join(agentDir, TIER_DOWNGRADE_ATTEMPTS_FILE), 'utf8')
    return parseTierDowngradeAttempts(raw)
  } catch {
    return null
  }
}

/** Persist the counter BEFORE the downgrade restart (it must survive the boot). */
export function writeTierDowngradeAttempts(agentDir: string, rec: TierDowngradeAttempts): void {
  atomicWrite(join(agentDir, TIER_DOWNGRADE_ATTEMPTS_FILE), serializeTierDowngradeAttempts(rec))
}

/** Clear the counter (a fresh chain / recovery). Best-effort. */
export function clearTierDowngradeAttempts(agentDir: string): void {
  try {
    rmSync(join(agentDir, TIER_DOWNGRADE_ATTEMPTS_FILE), { force: true })
  } catch {
    /* best-effort */
  }
}
