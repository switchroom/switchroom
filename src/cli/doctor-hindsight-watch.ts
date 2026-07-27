/**
 * `switchroom doctor` — is the memory watchdog actually ARMED?
 *
 * ## Why a check for a check
 *
 * #3617 shipped `switchroom hindsight-watch` complete and tested, with a
 * CHANGELOG line reading "This does not install a cron" and four manual steps
 * in the docs. The steps were never run. The fleet then spent six weeks with
 * recall ~86 % broken and no alert, partly because the one component that
 * would have noticed had never executed — and nothing anywhere said so.
 *
 * `--install-cron` is the mechanism that arms it. This is the mechanism that
 * makes an UNARMED watchdog loud, so the same gap cannot open again by
 * omission. A monitoring system whose own absence is silent is not a
 * monitoring system.
 *
 * ## Why staleness, not just presence
 *
 * Checking only for the cron file would pass on a host where cron is
 * installed but not running, where the fragment has a syntax error, or where
 * the tick has been exiting 1 for a week. The state file's mtime is the only
 * evidence that a tick actually *completed*, so it is the primary signal and
 * the cron file is the diagnostic detail.
 */

import { existsSync, statSync } from "node:fs";

import { CRON_PATH } from "../hindsight-watch/install-cron.js";
import { defaultStatePath } from "../hindsight-watch/state.js";

export interface CheckResult {
  name: string;
  status: "ok" | "warn" | "fail";
  detail?: string;
  fix?: string;
}

/**
 * How stale the state file may be before the row goes red.
 *
 * The cron runs every 15 minutes, so an hour is four missed ticks — past any
 * plausible transient (a slow tick holding the `flock`, a host reboot, one
 * `docker inspect` hanging on its 10 s timeout) and well short of letting a
 * dead watchdog look alive for a working day.
 */
export const WATCH_STALE_MS = 60 * 60 * 1000;

const FIX =
  "Arm it: `sudo switchroom hindsight-watch --install-cron` (writes " +
  `${CRON_PATH}, 15-min cadence, flock-guarded). Dry-run first with ` +
  "`switchroom hindsight-watch --dry-run`. While this row is red, NOTHING is " +
  "watching whether the fleet's memory works — the recall path fails open at " +
  "every layer and produces no user-visible symptom.";

/**
 * Pure classifier, so both branches are asserted in a unit test rather than
 * by arranging a stale file on a real host.
 *
 * @param cronPresent  does the cron fragment exist
 * @param stateMtimeMs mtime of the watchdog state file, or null when absent
 * @param now          epoch ms
 */
export function classifyWatchArmed(
  cronPresent: boolean,
  stateMtimeMs: number | null,
  now: number,
): CheckResult {
  const name = "hindsight-watch armed";

  if (stateMtimeMs === null) {
    // Never ticked. Whether the cron file exists changes the DIAGNOSIS (not
    // installed vs installed-but-not-running), so say which — an operator who
    // has "already installed it" needs to be pointed at cron itself, not sent
    // to run the installer a second time.
    return {
      name,
      status: "fail",
      detail: cronPresent
        ? `${CRON_PATH} exists but the watchdog has never completed a tick ` +
          "(no state file) — cron may not be running, or every tick is failing early"
        : `not armed: no ${CRON_PATH} and no state file — the memory watchdog has never run`,
      fix: FIX,
    };
  }

  const ageMs = now - stateMtimeMs;
  const mins = Math.round(ageMs / 60_000);

  // A future-dated state file means clock skew or a restored backup. Report it
  // rather than letting a negative age read as "extremely fresh".
  if (ageMs < -WATCH_STALE_MS) {
    return {
      name,
      status: "warn",
      detail: `watchdog state file is dated ${Math.abs(mins)}m in the FUTURE — clock skew or a restored backup`,
      fix: FIX,
    };
  }

  if (ageMs > WATCH_STALE_MS) {
    return {
      name,
      status: "fail",
      detail:
        `last watchdog tick was ${mins}m ago (stale past ${WATCH_STALE_MS / 60_000}m) — ` +
        (cronPresent
          ? "the cron fragment is installed, so cron itself or the tick is failing"
          : `and ${CRON_PATH} is missing`),
      fix: FIX,
    };
  }

  return {
    name,
    status: "ok",
    detail: `last tick ${mins}m ago${cronPresent ? "" : ` (no ${CRON_PATH} — running from somewhere else)`}`,
  };
}

/** Read the host facts and classify. */
export function checkHindsightWatchArmed(
  now: number = Date.now(),
  cronPath: string = CRON_PATH,
  statePath: string = defaultStatePath(),
): CheckResult {
  let mtime: number | null = null;
  try {
    mtime = statSync(statePath).mtimeMs;
  } catch {
    // Absent or unreadable — both mean "no evidence a tick completed".
  }
  return classifyWatchArmed(existsSync(cronPath), mtime, now);
}
