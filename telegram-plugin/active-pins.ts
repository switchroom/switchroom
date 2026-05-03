/**
 * Pure helpers for tracking pinned progress-card message IDs across
 * restarts.
 *
 * The progress-card driver pins a per-turn card on first emit and
 * unpins on turn complete. That lifecycle is in-memory only, so a
 * crash or kill mid-turn leaves a pinned message with no cleanup
 * path — on restart, the in-memory map is empty and Telegram still
 * shows the stale pin.
 *
 * This module persists the set of currently-pinned cards to a
 * `.active-pins.json` sidecar under `$AGENT_DIR`. The server adds an
 * entry right after `pinChatMessage` succeeds, removes the entry
 * after `unpinChatMessage`, and on startup reads the file to sweep
 * any stale entries (best-effort unpin) before the driver starts.
 *
 * All helpers are filesystem-only — no Telegram side effects — so
 * they're unit-testable in isolation, mirroring `handoff-continuity.ts`.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const ACTIVE_PINS_FILENAME = ".active-pins.json";

export interface ActivePin {
  chatId: string;
  messageId: number;
  turnKey: string;
  pinnedAt: number;
  /**
   * Per-agent identity for the pin. Optional in the on-disk shape so
   * sidecars written before per-agent cards (#per-agent-cards) still
   * parse cleanly — readers should treat a missing field as the parent
   * sentinel (`__parent__`).
   */
  agentId?: string;
}

function pinsPath(agentDir: string): string {
  return join(agentDir, ACTIVE_PINS_FILENAME);
}

/**
 * Read the active-pins sidecar. Missing, empty, or malformed files
 * return an empty array — callers never have to handle parse errors.
 * Entries that fail shape validation are dropped silently so a
 * corrupted file can't brick the startup sweep.
 */
export function readActivePins(agentDir: string): ActivePin[] {
  const p = pinsPath(agentDir);
  if (!existsSync(p)) return [];
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch {
    return [];
  }
  if (raw.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ActivePin[] = [];
  for (const item of parsed) {
    if (
      item != null &&
      typeof item === "object" &&
      typeof (item as ActivePin).chatId === "string" &&
      typeof (item as ActivePin).messageId === "number" &&
      typeof (item as ActivePin).turnKey === "string" &&
      typeof (item as ActivePin).pinnedAt === "number"
    ) {
      const aid = (item as ActivePin).agentId;
      const entry: ActivePin = aid != null && typeof aid === "string"
        ? (item as ActivePin)
        : { ...(item as ActivePin), agentId: undefined };
      out.push(entry);
    }
  }
  return out;
}

/**
 * Atomically overwrite the sidecar with the given list. Writing an
 * empty list deletes the file so a fresh restart sees no state.
 */
export function writeActivePins(agentDir: string, pins: ActivePin[]): void {
  const p = pinsPath(agentDir);
  if (pins.length === 0) {
    try {
      unlinkSync(p);
    } catch {
      /* already gone */
    }
    return;
  }
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(pins) + "\n", "utf-8");
    renameSync(tmp, p);
  } catch {
    /* best-effort — failsafe cleanup is cosmetic, not safety-critical */
  }
}

/**
 * Append a new pin to the sidecar. Idempotent on `(chatId, messageId)`
 * — a duplicate add replaces the existing entry so `pinnedAt` reflects
 * the most recent pin.
 */
export function addActivePin(agentDir: string, pin: ActivePin): void {
  const existing = readActivePins(agentDir).filter(
    (p) => !(p.chatId === pin.chatId && p.messageId === pin.messageId),
  );
  existing.push(pin);
  writeActivePins(agentDir, existing);
}

/**
 * Remove the pin matching `(chatId, messageId)`. No-op when the
 * sidecar or entry is absent.
 */
export function removeActivePin(agentDir: string, chatId: string, messageId: number): void {
  const existing = readActivePins(agentDir);
  const next = existing.filter(
    (p) => !(p.chatId === chatId && p.messageId === messageId),
  );
  if (next.length === existing.length) return;
  writeActivePins(agentDir, next);
}

/**
 * Delete the sidecar outright. Called after the startup sweep so the
 * next run starts clean regardless of unpin success.
 */
export function clearActivePins(agentDir: string): void {
  try {
    unlinkSync(pinsPath(agentDir));
  } catch {
    /* already gone */
  }
}
