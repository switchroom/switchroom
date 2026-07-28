// Read-only "is Telegram currently throttling this agent?" probe, for the
// wedge-watchdog's permission-prompt branch (issue: the Esc-before-the-card
// race, 2026-07-28).
//
// ## Why this exists
//
// The watchdog runs in the `autoaccept-poll` sidecar — a DIFFERENT process to
// the gateway, in the same container and sharing `TELEGRAM_STATE_DIR`. It
// cannot see the gateway's in-memory send-gate or edit-flood-fuse state. What
// it CAN see is the two on-disk artefacts the flood-ban work (#3084, #3847,
// #3853) already writes there, and this module reads exactly those two:
//
//   * `flood-windows.json` — the send gate's SCOPED flood windows
//     (`global` / `chat:<id>` / `group:<id>` / `msg-edit:<id>`), written
//     through by `makeFloodWindowRecorder` on every 429 and re-read at boot
//     (`flood-circuit-breaker.ts`).
//   * `429-ledger.json` — the 429 pressure ledger, folded into EPISODES by
//     `recordFlood429`, which every `onFloodWait` wiring goes through
//     (`flood-429-ledger.ts`).
//
// Both readers are imported, not reimplemented. There is deliberately NO new
// state file, no new recorder, and no writing of any kind here.
//
// ## Why the ledger and not just the open window
//
// An open window alone is too narrow to answer the question the watchdog is
// really asking, which is "could a Telegram approval card be LATE right now?".
// Measured against the live clerk incident (2026-07-28,
// `~/.switchroom/agents/clerk/telegram/`):
//
//   429-ledger episode:  firstTs 1785197264885 → lastTs 1785197284509,
//                        peakRetryAfterSec 3, count 3
//   flood-windows.json:  [{ scopeKey: "chat:12345",
//                           untilTs: 1785197287509, ... }]
//
// Each individual window is only ~3s wide (retry_after 3), while the gateway's
// edit-flood-fuse kept DEFERRING critical sends into that same chat from
// 00:11:16Z to past 00:12:03Z — 47s after the first 429. A watchdog polling
// every 5s would usually sample BETWEEN the 3s windows and conclude "all
// clear" while the card was still stuck behind the fuse. So an open window is
// sufficient evidence of pressure but not necessary: a 429 observed within
// `FLOOD_PRESSURE_GRACE_MS` counts too.

import {
  readFloodWindows,
  floodWindowsPath,
} from "../../telegram-plugin/flood-circuit-breaker.js";
import {
  flood429LedgerPath,
  readFlood429LedgerResult,
} from "../../telegram-plugin/flood-429-ledger.js";

/**
 * How long after the LAST observed 429 (or after a window's expiry) the
 * outbound path is still treated as under flood pressure.
 *
 * Calibrated on the clerk incident above: the 429 burst spanned ~20s and the
 * edit-flood-fuse went on deferring `class=critical` sends for that chat for
 * at least another ~27s (00:11:37Z `sendRichMessage` … 00:12:03Z
 * `editMessageText`), i.e. ~47s of card-delivery risk behind a peak
 * `retry_after` of 3s. 120s is ~2.5x that observed tail — comfortably past it
 * without being open-ended, and it is a floor on the suppression, not a
 * ceiling: the caller bounds total patience separately.
 */
export const FLOOD_PRESSURE_GRACE_MS = 120_000;

/**
 * Scope keys that can delay a NEW card POST into a chat.
 *
 * `msg-edit:<id>` is deliberately excluded: it throttles edits of ONE
 * already-sent message, which cannot be the reason an approval card has not
 * appeared yet. Counting it would let an unrelated worker-feed card's edit
 * ceiling suppress the watchdog.
 */
function scopeBlocksCardDelivery(scopeKey: string): boolean {
  return !scopeKey.startsWith("msg-edit:");
}

/** Why the probe answered `true` — for the watchdog's log line. */
export interface FloodPressure {
  /** Telegram is (or was very recently) throttling this agent's outbound path. */
  active: boolean;
  /** Human-readable evidence, e.g. `open window chat:123 (4s left)`. */
  reason: string;
}

const NO_PRESSURE: FloodPressure = { active: false, reason: "" };

export interface FloodPressureProbeOptions {
  /** Agent telegram state dir. Default: `TELEGRAM_STATE_DIR` or the container path. */
  stateDir?: string;
  /** Grace after the last 429. Default `FLOOD_PRESSURE_GRACE_MS`. */
  graceMs?: number;
}

/** Resolve the agent's telegram state dir the same way the gateway does. */
export function resolveTelegramStateDir(): string {
  return process.env.TELEGRAM_STATE_DIR ?? "/state/agent/telegram";
}

/**
 * Answer "is this agent's Telegram outbound path under flood pressure right
 * now?" from the two existing on-disk flood artefacts. Pure read; never
 * throws (the caller is a never-throw sidecar).
 *
 * Note `readFloodWindows` fails SAFE — a corrupt/unreadable
 * `flood-windows.json` yields a synthesized conservative `global` window. That
 * is the right answer here too: if we cannot tell whether a ban is open, we
 * must not fire a permanent Esc-deny on the assumption that it is not. The
 * caller's absolute patience ceiling keeps that bounded.
 */
export function readFloodPressure(
  now: number,
  opts: FloodPressureProbeOptions = {},
): FloodPressure {
  const stateDir = opts.stateDir ?? resolveTelegramStateDir();
  const graceMs = opts.graceMs ?? FLOOD_PRESSURE_GRACE_MS;
  try {
    // (a) A scoped window that is open NOW, or expired less than `graceMs`
    //     ago. `readFloodWindows` prunes anything already expired, so query it
    //     with a clock rolled BACK by the grace to keep recently-closed
    //     windows visible.
    const windows = readFloodWindows(
      floodWindowsPath(stateDir),
      now - graceMs,
      // The gateway logs corrupt-marker warnings loudly already; a 5s poll
      // loop must not duplicate them into the sidecar log forever.
      () => {},
    );
    for (const w of windows) {
      if (!scopeBlocksCardDelivery(w.scopeKey)) continue;
      const msLeft = w.untilTs - now;
      return {
        active: true,
        reason:
          msLeft > 0
            ? `open flood window ${w.scopeKey} (${Math.ceil(msLeft / 1000)}s left, src=${w.retryAfterSrc})`
            : `flood window ${w.scopeKey} closed ${Math.ceil(-msLeft / 1000)}s ago (within ${Math.round(graceMs / 1000)}s grace)`,
      };
    }
    // (b) A 429 episode observed within the grace. Catches the common case the
    //     windows miss: several short (retry_after ≤ 5s) windows whose gaps a
    //     5s poll cadence samples straight through, while the edit-flood-fuse
    //     is still deferring the card.
    const ledger = readFlood429LedgerResult(flood429LedgerPath(stateDir));
    if (ledger.status === "ok") {
      for (const ep of ledger.episodes) {
        const lastEvidenceTs = Math.max(ep.lastTs, ep.untilTs);
        if (lastEvidenceTs >= now - graceMs) {
          return {
            active: true,
            reason:
              `429 episode ${ep.count}x peak=${ep.peakRetryAfterSec}s last seen ` +
              `${Math.max(0, Math.round((now - ep.lastTs) / 1000))}s ago ` +
              `(within ${Math.round(graceMs / 1000)}s grace)`,
          };
        }
      }
    }
    return NO_PRESSURE;
  } catch {
    // Soft-fail. Unlike the window reader's deliberate fail-SAFE, an
    // unexpected throw here means we learned nothing at all, and reporting
    // "under flood pressure" forever on a coding error would be worse than
    // falling back to the (bounded, longer) streak gate. Report no pressure.
    return NO_PRESSURE;
  }
}

/** Bind a probe to this agent's state dir. Used by the wedge-watchdog. */
export function makeFloodPressureProbe(
  opts: FloodPressureProbeOptions = {},
): (now: number) => FloodPressure {
  return (now: number) => readFloodPressure(now, opts);
}
