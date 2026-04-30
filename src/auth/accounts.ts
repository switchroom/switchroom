/**
 * Multi-account Claude OAuth slot management.
 *
 * Storage layout (per agent):
 *   <agentDir>/.claude/
 *     accounts/
 *       <slot>/
 *         .oauth-token          — token value
 *         .oauth-token.meta.json — { createdAt, expiresAt, quotaExhaustedUntil?, source }
 *         .credentials.json     — (optional, legacy)
 *     active                    — text file: the active slot name
 *     .oauth-token              — LEGACY path, kept in sync with the active slot
 *     .oauth-token.meta.json    — LEGACY path, kept in sync with the active slot
 *
 * The legacy `.oauth-token` / meta files are always mirrored from the active
 * slot so that start.sh.hbs and Claude Code itself see no layout change.
 *
 * Slot names are validated: [A-Za-z0-9._-]+, max 64 chars, no `..`, no `/`.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const DEFAULT_SLOT = "default";
const SLOT_NAME_MAX = 64;
const SLOT_NAME_RE = /^[A-Za-z0-9._-]+$/;
const FIVE_HOURS_MS = 5 * 60 * 60_000;

export interface SlotMeta {
  createdAt: number;
  expiresAt: number;
  source: string;
  /** Unix ms; when set and in the future, slot is rate-limited. */
  quotaExhaustedUntil?: number;
  /** Free-form note about the last quota event. */
  quotaReason?: string;
}

export type SlotHealth =
  | "active"
  | "healthy"
  | "quota-exhausted"
  | "expired"
  | "missing";

export interface SlotInfo {
  slot: string;
  active: boolean;
  health: SlotHealth;
  expiresAt?: number;
  quotaExhaustedUntil?: number;
}

/* ── Path helpers ────────────────────────────────────────────────────── */

function claudeDir(agentDir: string): string {
  return join(agentDir, ".claude");
}

function accountsDir(agentDir: string): string {
  return join(claudeDir(agentDir), "accounts");
}

export function slotDir(agentDir: string, slot: string): string {
  return join(accountsDir(agentDir), slot);
}

export function slotTokenPath(agentDir: string, slot: string): string {
  return join(slotDir(agentDir, slot), ".oauth-token");
}

export function slotMetaPath(agentDir: string, slot: string): string {
  return join(slotDir(agentDir, slot), ".oauth-token.meta.json");
}

export function activeMarkerPath(agentDir: string): string {
  return join(claudeDir(agentDir), "active");
}

export function legacyTokenPath(agentDir: string): string {
  return join(claudeDir(agentDir), ".oauth-token");
}

export function legacyMetaPath(agentDir: string): string {
  return join(claudeDir(agentDir), ".oauth-token.meta.json");
}

/* ── Slot name validation ────────────────────────────────────────────── */

export function validateSlotName(slot: string): void {
  if (typeof slot !== "string" || slot.length === 0) {
    throw new Error("Slot name cannot be empty");
  }
  if (slot.length > SLOT_NAME_MAX) {
    throw new Error(`Slot name too long (max ${SLOT_NAME_MAX} chars)`);
  }
  if (slot === "." || slot === "..") {
    throw new Error(`Slot name "${slot}" is reserved`);
  }
  if (slot.includes("/") || slot.includes("\\")) {
    throw new Error("Slot name cannot contain path separators");
  }
  if (!SLOT_NAME_RE.test(slot)) {
    throw new Error(
      "Slot name must match [A-Za-z0-9._-]+ (letters, digits, dot, underscore, dash)",
    );
  }
}

/* ── Active-slot management ──────────────────────────────────────────── */

export function readActiveSlot(agentDir: string): string | null {
  const p = activeMarkerPath(agentDir);
  if (!existsSync(p)) return null;
  try {
    const val = readFileSync(p, "utf-8").trim();
    return val.length > 0 ? val : null;
  } catch {
    return null;
  }
}

export function writeActiveSlot(agentDir: string, slot: string): void {
  validateSlotName(slot);
  mkdirSync(claudeDir(agentDir), { recursive: true });
  writeFileSync(activeMarkerPath(agentDir), slot + "\n", { mode: 0o600 });
}

/* ── Slot listing ────────────────────────────────────────────────────── */

export function listSlots(agentDir: string): string[] {
  const dir = accountsDir(agentDir);
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((name) => {
        try {
          return statSync(join(dir, name)).isDirectory();
        } catch {
          return false;
        }
      })
      .sort();
  } catch {
    return [];
  }
}

export function slotExists(agentDir: string, slot: string): boolean {
  return existsSync(slotTokenPath(agentDir, slot));
}

export function readSlotMeta(agentDir: string, slot: string): SlotMeta | null {
  const p = slotMetaPath(agentDir, slot);
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as SlotMeta;
  } catch {
    return null;
  }
}

export function writeSlotMeta(
  agentDir: string,
  slot: string,
  meta: SlotMeta,
): void {
  validateSlotName(slot);
  mkdirSync(slotDir(agentDir, slot), { recursive: true });
  writeFileSync(slotMetaPath(agentDir, slot), JSON.stringify(meta, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function readSlotToken(agentDir: string, slot: string): string | null {
  const p = slotTokenPath(agentDir, slot);
  if (!existsSync(p)) return null;
  try {
    const v = readFileSync(p, "utf-8").trim();
    return v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

/** Write a token + fresh meta into a slot. */
export function writeSlotToken(
  agentDir: string,
  slot: string,
  token: string,
  opts: { expiresAtMs?: number; source?: string } = {},
): { tokenPath: string; metaPath: string } {
  validateSlotName(slot);
  const dir = slotDir(agentDir, slot);
  mkdirSync(dir, { recursive: true });
  const tokenPath = slotTokenPath(agentDir, slot);
  const metaPath = slotMetaPath(agentDir, slot);
  const now = Date.now();
  const expiresAt = opts.expiresAtMs ?? now + 365 * 24 * 60 * 60_000;

  writeFileSync(tokenPath, token.trim() + "\n", { mode: 0o600 });
  writeFileSync(
    metaPath,
    JSON.stringify(
      {
        createdAt: now,
        expiresAt,
        source: opts.source ?? "claude-setup-token",
      } satisfies SlotMeta,
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  return { tokenPath, metaPath };
}

/* ── Legacy mirror ───────────────────────────────────────────────────── */

/**
 * Sync the legacy top-level .oauth-token (+ meta) path from the active slot
 * so that start.sh / Claude Code see no layout change.
 */
export function syncLegacyFromActive(agentDir: string): void {
  const active = readActiveSlot(agentDir);
  if (!active) return;
  const srcToken = slotTokenPath(agentDir, active);
  const srcMeta = slotMetaPath(agentDir, active);
  if (!existsSync(srcToken)) return;
  mkdirSync(claudeDir(agentDir), { recursive: true });
  copyFileSync(srcToken, legacyTokenPath(agentDir));
  if (existsSync(srcMeta)) {
    copyFileSync(srcMeta, legacyMetaPath(agentDir));
  }
}

/* ── Migration ───────────────────────────────────────────────────────── */

/**
 * Idempotent migration from legacy single-token layout to accounts/<slot>/.
 * - If accounts/ already exists and active is set: no-op.
 * - If legacy .oauth-token exists but no slots: copy into accounts/default/,
 *   write active=default.
 * - If neither exists: no-op.
 */
export function migrateLegacyIfNeeded(agentDir: string): {
  migrated: boolean;
  slot?: string;
} {
  const active = readActiveSlot(agentDir);
  const slots = listSlots(agentDir);
  if (active && slotExists(agentDir, active)) {
    return { migrated: false };
  }
  // Legacy token?
  const legacyToken = legacyTokenPath(agentDir);
  if (!existsSync(legacyToken)) {
    // Nothing to migrate; but if we have exactly one slot, adopt it.
    if (slots.length === 1 && slotExists(agentDir, slots[0])) {
      writeActiveSlot(agentDir, slots[0]);
      syncLegacyFromActive(agentDir);
      return { migrated: true, slot: slots[0] };
    }
    return { migrated: false };
  }
  let token: string;
  try {
    token = readFileSync(legacyToken, "utf-8").trim();
  } catch {
    return { migrated: false };
  }
  if (!token) return { migrated: false };

  const slot = DEFAULT_SLOT;
  const targetDir = slotDir(agentDir, slot);
  mkdirSync(targetDir, { recursive: true });
  // Copy token
  writeFileSync(slotTokenPath(agentDir, slot), token + "\n", { mode: 0o600 });
  // Copy meta if it exists, otherwise synthesize
  const legacyMeta = legacyMetaPath(agentDir);
  if (existsSync(legacyMeta)) {
    try {
      copyFileSync(legacyMeta, slotMetaPath(agentDir, slot));
    } catch {
      // best-effort; write a synthesized one
      const now = Date.now();
      writeSlotMeta(agentDir, slot, {
        createdAt: now,
        expiresAt: now + 365 * 24 * 60 * 60_000,
        source: "legacy-migration",
      });
    }
  } else {
    const now = Date.now();
    writeSlotMeta(agentDir, slot, {
      createdAt: now,
      expiresAt: now + 365 * 24 * 60 * 60_000,
      source: "legacy-migration",
    });
  }
  writeActiveSlot(agentDir, slot);
  syncLegacyFromActive(agentDir);
  return { migrated: true, slot };
}

/* ── Slot name auto-generation ───────────────────────────────────────── */

/** Produce `slot-2`, `slot-3`, ... skipping any names already present. */
export function suggestSlotName(agentDir: string): string {
  const existing = new Set(listSlots(agentDir));
  if (!existing.has(DEFAULT_SLOT)) return DEFAULT_SLOT;
  let i = 2;
  while (existing.has(`slot-${i}`)) i++;
  return `slot-${i}`;
}

/* ── Health & selection ──────────────────────────────────────────────── */

export function slotHealth(
  agentDir: string,
  slot: string,
  now: number = Date.now(),
): SlotHealth {
  if (!slotExists(agentDir, slot)) return "missing";
  const meta = readSlotMeta(agentDir, slot);
  if (!meta) return "healthy"; // token exists but no meta — assume healthy
  if (meta.expiresAt <= now) return "expired";
  if (meta.quotaExhaustedUntil != null && meta.quotaExhaustedUntil > now) {
    return "quota-exhausted";
  }
  return "healthy";
}

export function getSlotInfos(
  agentDir: string,
  now: number = Date.now(),
): SlotInfo[] {
  const active = readActiveSlot(agentDir);
  return listSlots(agentDir).map((slot) => {
    const meta = readSlotMeta(agentDir, slot);
    let health: SlotHealth = slotHealth(agentDir, slot, now);
    if (slot === active && health === "healthy") health = "active";
    return {
      slot,
      active: slot === active,
      health,
      expiresAt: meta?.expiresAt,
      quotaExhaustedUntil: meta?.quotaExhaustedUntil,
    };
  });
}

/**
 * Pick the next slot to fall back to.
 *
 * Preference order:
 *   1. healthy slots (not currently active)
 *   2. quota-exhausted slots whose reset has passed (treated as healthy above
 *      via slotHealth())
 *   3. null if nothing usable
 *
 * Never returns `excludeSlot` (typically the currently-active/exhausted one).
 */
export function pickFallbackSlot(
  agentDir: string,
  excludeSlot: string | null,
  now: number = Date.now(),
): string | null {
  const candidates = listSlots(agentDir).filter((s) => s !== excludeSlot);
  const healthy: string[] = [];
  const quotaExhausted: Array<{ slot: string; until: number }> = [];
  const expired: string[] = [];

  for (const slot of candidates) {
    const h = slotHealth(agentDir, slot, now);
    if (h === "healthy") healthy.push(slot);
    else if (h === "quota-exhausted") {
      const meta = readSlotMeta(agentDir, slot);
      quotaExhausted.push({
        slot,
        until: meta?.quotaExhaustedUntil ?? Number.POSITIVE_INFINITY,
      });
    } else if (h === "expired") expired.push(slot);
  }

  if (healthy.length > 0) return healthy[0];
  // prefer expired (might still refresh) over quota-exhausted; this is a
  // defensive last-resort and the brief explicitly says prefer healthy >
  // expired > quota-exhausted.
  if (expired.length > 0) return expired[0];
  if (quotaExhausted.length > 0) {
    quotaExhausted.sort((a, b) => a.until - b.until);
    return quotaExhausted[0].slot;
  }
  return null;
}

/* ── Quota detection + marking ───────────────────────────────────────── */

/**
 * Best-guess quota-exhaustion detector.
 *
 * TODO: verify exact strings emitted by Claude Code when the 5-hour quota
 * trips. Patterns below are plausible but unconfirmed.
 */
export function detectQuotaExhausted(chunk: string): {
  hit: boolean;
  resetAtMs?: number;
} {
  if (!chunk) return { hit: false };
  const patterns: RegExp[] = [
    /5-hour (usage )?limit/i,
    /rate.?limit/i,
    /usage limit/i,
    /\b429\b/,
    /quota (exceeded|exhausted)/i,
    /too many requests/i,
  ];
  const hit = patterns.some((r) => r.test(chunk));
  if (!hit) return { hit: false };

  // Try to parse an explicit reset time: "resets at 14:05 UTC" or
  // "try again in 42 minutes" or "retry after 3600" (seconds).
  let resetAtMs: number | undefined;
  const retryAfterSec = chunk.match(/retry.?after[^0-9]*(\d+)/i);
  if (retryAfterSec) {
    resetAtMs = Date.now() + parseInt(retryAfterSec[1], 10) * 1000;
  } else {
    const inMinutes = chunk.match(/in\s+(\d+)\s+minute/i);
    if (inMinutes) {
      resetAtMs = Date.now() + parseInt(inMinutes[1], 10) * 60_000;
    }
  }
  return { hit: true, resetAtMs };
}

export function markSlotQuotaExhausted(
  agentDir: string,
  slot: string,
  resetAtMs?: number,
  reason?: string,
): void {
  const meta = readSlotMeta(agentDir, slot) ?? {
    createdAt: Date.now(),
    expiresAt: Date.now() + 365 * 24 * 60 * 60_000,
    source: "unknown",
  };
  meta.quotaExhaustedUntil = resetAtMs ?? Date.now() + FIVE_HOURS_MS;
  if (reason) meta.quotaReason = reason;
  writeSlotMeta(agentDir, slot, meta);
}

/* ── High-level slot operations ──────────────────────────────────────── */

/** Switch the active slot. Throws on unknown slot. Mirrors legacy path. */
export function useSlot(agentDir: string, slot: string): void {
  validateSlotName(slot);
  if (!slotExists(agentDir, slot)) {
    throw new Error(`Slot "${slot}" does not exist for this agent`);
  }
  writeActiveSlot(agentDir, slot);
  syncLegacyFromActive(agentDir);
}

/** Remove a slot. Refuses when it would leave the agent unusable. */
export function removeSlot(agentDir: string, slot: string): void {
  validateSlotName(slot);
  if (!slotExists(agentDir, slot)) {
    throw new Error(`Slot "${slot}" does not exist`);
  }
  const slots = listSlots(agentDir);
  if (slots.length <= 1) {
    throw new Error(
      `Refusing to remove the only slot "${slot}" — add another first with 'switchroom auth add'.`,
    );
  }
  const active = readActiveSlot(agentDir);
  if (active === slot) {
    // Need a healthy fallback to swap to first.
    const fallback = pickFallbackSlot(agentDir, slot);
    if (!fallback) {
      throw new Error(
        `Refusing to remove active slot "${slot}" — no other healthy slot to switch to.`,
      );
    }
    useSlot(agentDir, fallback);
  }
  rmSync(slotDir(agentDir, slot), { recursive: true, force: true });
}
