/**
 * Agent quarantine marker — a permanent-config-error flag the gateway
 * raises so an out-of-band restart loop can't burn the supervisor budget.
 *
 * The Telegram gateway writes one of these (via `writeQuarantineMarker`)
 * when a startup API call returns 401 Unauthorized — see #1076. A 401
 * is permanent: the bot token has been revoked, rotated, or wrong-typed
 * (a string that doesn't tokenise). Pre-fix the gateway exited 1 on
 * every attempt; the in-container `_switchroom_supervise` respawned 10
 * times in <60 s, hit the cap, and the gateway went silently dead. No
 * Telegram surface, no operator signal, no doctor flag — just a non-
 * responsive agent.
 *
 * Post-fix the gateway writes this marker + an issue + exits 78 (sysexits
 * `EX_CONFIG`). The supervisor recognises 78 as "config error, don't
 * restart" and stops. On the host side, `switchroom apply` and
 * `switchroom agent restart` refuse to start a quarantined agent until
 * the operator runs `switchroom agent unquarantine <name>`. The
 * unquarantine simply clears the marker — the next boot is naive, and
 * if the token is still bad we re-quarantine immediately.
 *
 * On-disk layout:
 *
 *   <telegramStateDir>/quarantine.json
 *
 * which expands to `<agentDir>/telegram/quarantine.json` for the
 * canonical compose layout. The telegram state dir is the directory the
 * gateway already mints (mkdir at 0o700) and that the host CLI can
 * locate by joining `<agentsDir>/<name>/telegram`. Storing the marker
 * here keeps the contract symmetric for both sides without inventing a
 * new state location.
 *
 * SECURITY: the marker NEVER contains the bot token, even truncated.
 * The threat model assumes the token is the secret being misused — see
 * #1076. We store only timestamps, a reason code, and an optional short
 * detail (e.g. the Telegram API description, which is "Unauthorized"
 * for a 401 and contains no token material).
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const QUARANTINE_FILENAME = "quarantine.json";

/**
 * Stable machine-readable reason codes. Add to this list (and document
 * the operator remediation) when extending quarantine to new failure
 * modes — e.g. "vault permanently sealed", "agent UID mismatch".
 */
export type QuarantineReason =
  | "startup.unauthorized"
  // Config-class refusal-to-boot. Added 2026-05-13 — the gateway
  // can now exit EX_CONFIG (78) on a vault-posture config error
  // (telegram-id posture declared but auto-unlock blob missing /
  // unreadable / empty). The supervisor in start.sh quarantines on
  // exit 78 (see _switchroom_supervise's exit-78 short-circuit).
  // Operator remediation: run `switchroom vault broker
  // enable-auto-unlock`, OR remove `vault.broker.approvalAuth:
  // telegram-id` from switchroom.yaml.
  | "startup.config_error";

export interface QuarantineMarker {
  /** Schema version for forward-compat. Bump if shape changes. */
  v: 1;
  /** Stable code so doctor / CLI can switch on the reason. */
  reason: QuarantineReason;
  /** Unix epoch ms when the marker was written. */
  ts: number;
  /**
   * Optional short human-readable detail. MUST NOT include any secret
   * material (bot token, vault password, etc). For the 401 case this
   * is just "Telegram API returned 401 Unauthorized".
   */
  detail?: string;
}

/**
 * Resolve the marker path inside a Telegram state dir.
 */
export function quarantineMarkerPath(telegramStateDir: string): string {
  return join(telegramStateDir, QUARANTINE_FILENAME);
}

/**
 * Write the quarantine marker. Idempotent — overwrites any existing
 * marker so a fresh `ts` lands on each detection. Creates the parent
 * dir if it doesn't exist (defensive — the gateway already minted it
 * by the time it would call this, but `apply --check`-like paths might
 * not have).
 */
export function writeQuarantineMarker(
  telegramStateDir: string,
  reason: QuarantineReason,
  detail?: string,
  nowFn: () => number = Date.now,
): void {
  mkdirSync(telegramStateDir, { recursive: true, mode: 0o700 });
  const marker: QuarantineMarker = {
    v: 1,
    reason,
    ts: nowFn(),
    detail,
  };
  // No atomic-rename song-and-dance — the marker is a single tiny JSON
  // and a torn write yields invalid JSON, which `readQuarantineMarker`
  // treats as "no marker" (best-effort surface). The next boot's
  // detector will re-write it cleanly.
  writeFileSync(
    quarantineMarkerPath(telegramStateDir),
    JSON.stringify(marker) + "\n",
    "utf-8",
  );
}

/**
 * Read the quarantine marker, or `null` if absent / unparseable.
 *
 * Unparseable / corrupt markers are treated as "no marker present" so
 * a single bad write can't deadlock the agent. The next gateway boot's
 * 401-detection path will replace it with a valid marker.
 */
export function readQuarantineMarker(
  telegramStateDir: string,
): QuarantineMarker | null {
  const path = quarantineMarkerPath(telegramStateDir);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const m = parsed as Partial<QuarantineMarker>;
    if (m.v !== 1) return null;
    if (typeof m.reason !== "string") return null;
    if (typeof m.ts !== "number") return null;
    return {
      v: 1,
      reason: m.reason as QuarantineReason,
      ts: m.ts,
      detail: typeof m.detail === "string" ? m.detail : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Remove the marker, returning true if one was actually deleted.
 * Idempotent: returns false if no marker existed. Used by
 * `switchroom agent unquarantine`.
 */
export function clearQuarantineMarker(telegramStateDir: string): boolean {
  const path = quarantineMarkerPath(telegramStateDir);
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Host-side convenience. Given a switchroom config's agents dir and an
 * agent name, return the path to that agent's telegram state dir as
 * the host sees it on disk (NOT inside the container). The canonical
 * layout is `<agentsDir>/<name>/telegram/` — mirrors
 * `src/cli/agent.ts:preflightCheck`.
 */
export function hostTelegramStateDir(
  agentsDir: string,
  name: string,
): string {
  return join(agentsDir, name, "telegram");
}

/**
 * Convenience reader for host-side callers (apply, agent start/restart,
 * doctor). Resolves the marker path from agentsDir + name.
 */
export function readQuarantineMarkerForAgent(
  agentsDir: string,
  name: string,
): QuarantineMarker | null {
  return readQuarantineMarker(hostTelegramStateDir(agentsDir, name));
}
