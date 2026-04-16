/**
 * Pure helpers for tracking in-flight status reactions across gateway
 * restarts.
 *
 * The status-reaction lifecycle is in-memory only (`activeStatusReactions`
 * Map in gateway.ts). When the *gateway* crashes mid-turn, the Map is
 * lost and Telegram still shows the intermediate emoji (🤔, 🔥, etc.)
 * with no cleanup path.
 *
 * This module persists the set of currently-active reactions to a
 * `.active-reactions.json` sidecar under `$AGENT_DIR`. The gateway adds
 * an entry right after creating a StatusReactionController, removes it
 * when the reaction reaches a terminal state, and on startup reads the
 * file to sweep any stale entries (best-effort promotion to 👍).
 *
 * All helpers are filesystem-only — no Telegram side effects — so
 * they're unit-testable in isolation, mirroring `active-pins.ts`.
 */

import { readFileSync, writeFileSync, renameSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

export const ACTIVE_REACTIONS_FILENAME = ".active-reactions.json";

export interface ActiveReaction {
  chatId: string;
  messageId: number;
  threadId: number | null;
  reactedAt: number;
}

function reactionsPath(agentDir: string): string {
  return join(agentDir, ACTIVE_REACTIONS_FILENAME);
}

/**
 * Read the active-reactions sidecar. Missing, empty, or malformed files
 * return an empty array — callers never have to handle parse errors.
 * Entries that fail shape validation are dropped silently so a
 * corrupted file can't brick the startup sweep.
 */
export function readActiveReactions(agentDir: string): ActiveReaction[] {
  const p = reactionsPath(agentDir);
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
  const out: ActiveReaction[] = [];
  for (const item of parsed) {
    if (
      item != null &&
      typeof item === "object" &&
      typeof (item as ActiveReaction).chatId === "string" &&
      typeof (item as ActiveReaction).messageId === "number" &&
      (typeof (item as ActiveReaction).threadId === "number" || (item as ActiveReaction).threadId === null) &&
      typeof (item as ActiveReaction).reactedAt === "number"
    ) {
      out.push(item as ActiveReaction);
    }
  }
  return out;
}

/**
 * Atomically overwrite the sidecar with the given list. Writing an
 * empty list deletes the file so a fresh restart sees no state.
 */
export function writeActiveReactions(agentDir: string, reactions: ActiveReaction[]): void {
  const p = reactionsPath(agentDir);
  if (reactions.length === 0) {
    try {
      unlinkSync(p);
    } catch {
      /* already gone */
    }
    return;
  }
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, JSON.stringify(reactions) + "\n", "utf-8");
    renameSync(tmp, p);
  } catch {
    /* best-effort — failsafe cleanup is cosmetic, not safety-critical */
  }
}

/**
 * Append a new reaction to the sidecar. Idempotent on `(chatId, messageId)`
 * — a duplicate add replaces the existing entry so `reactedAt` reflects
 * the most recent reaction.
 */
export function addActiveReaction(agentDir: string, reaction: ActiveReaction): void {
  const existing = readActiveReactions(agentDir).filter(
    (r) => !(r.chatId === reaction.chatId && r.messageId === reaction.messageId),
  );
  existing.push(reaction);
  writeActiveReactions(agentDir, existing);
}

/**
 * Remove the reaction matching `(chatId, messageId)`. No-op when the
 * sidecar or entry is absent.
 */
export function removeActiveReaction(agentDir: string, chatId: string, messageId: number): void {
  const existing = readActiveReactions(agentDir);
  const next = existing.filter(
    (r) => !(r.chatId === chatId && r.messageId === messageId),
  );
  if (next.length === existing.length) return;
  writeActiveReactions(agentDir, next);
}

/**
 * Delete the sidecar outright. Called after the startup sweep so the
 * next run starts clean regardless of sweep success.
 */
export function clearActiveReactions(agentDir: string): void {
  try {
    unlinkSync(reactionsPath(agentDir));
  } catch {
    /* already gone */
  }
}
