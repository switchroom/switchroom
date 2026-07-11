/**
 * hostd config-error resilience — degraded boot mode.
 *
 * Problem this fixes (live incident 2026-07-11): an invalid
 * `switchroom.yaml` (e.g. duplicate keys — the `yaml` package throws on
 * those) made `loadConfig()` throw at hostd boot, `main().catch` exited 1,
 * and docker's restart policy turned that into a silent crash-loop. During
 * a self-bump rollout that crash-loop is fatal to the roll: the
 * pending-rollout resume marker ages past `SELF_BUMP_MARKER_MAX_AGE_MS`
 * (15 min) while hostd flaps, and the roll is silently abandoned.
 *
 * Fix (deterministic, no model in the loop):
 *   1. Instead of exit-1, hostd enters a DEGRADED mode: the process stays
 *      alive, retries `loadConfig()` every `CONFIG_DEGRADED_RETRY_MS` and
 *      on config-file change, and logs clearly each attempt.
 *   2. On entering degraded mode it writes a prominent marker file
 *      (`config-degraded.json` in `~/.switchroom/hostd/`) that fleet
 *      skills / doctor checks can key on, and fire-and-forgets ONE
 *      operator-DM through any reachable agent gateway socket (the same
 *      `rollout_status_post` relay the rollout narrator uses).
 *   3. While degraded, a pending self-bump rollout marker must NOT age
 *      out: on recovery the marker's `created_at` is shifted forward by
 *      the degraded duration, so the 15-min freshness budget only counts
 *      time hostd was actually able to act.
 *
 * Pure pieces (marker shift, notice formatting) are exported for unit
 * tests; the wait loop takes injected load/notify/now fns for the same
 * reason.
 */

import { existsSync, readFileSync, unlinkSync, watchFile, unwatchFile, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ConfigError } from "../config/loader.js";
import type { SwitchroomConfig } from "../config/schema.js";
import {
  SELF_BUMP_MARKER_FILENAME,
  encodePendingRolloutMarker,
  parsePendingRolloutMarker,
} from "./self-bump.js";

/** Prominent degraded-mode marker, next to the self-bump marker in the
 *  bind-mounted `~/.switchroom/hostd/` dir (root-owned, agent-unforgeable,
 *  survives container recreate). Present ⇒ hostd is alive but running
 *  WITHOUT a loadable config. Removed on recovery. */
export const CONFIG_DEGRADED_MARKER_FILENAME = "config-degraded.json";

/** Interval between config reload attempts while degraded. */
export const CONFIG_DEGRADED_RETRY_MS = 15_000;

export interface ConfigDegradedMarker {
  v: 1;
  /** ISO timestamp hostd entered degraded mode. */
  since: string;
  /** The ConfigError message (first line of why the load failed). */
  error: string;
  /** ConfigError details lines, if any. */
  details?: string[];
}

export function buildDegradedMarker(
  err: ConfigError,
  nowMs: number,
): ConfigDegradedMarker {
  return {
    v: 1,
    since: new Date(nowMs).toISOString(),
    error: err.message,
    ...(err.details && err.details.length > 0
      ? { details: err.details }
      : {}),
  };
}

/** Operator-DM text for entering degraded mode. Plain text, < 4096 chars. */
export function formatDegradedNotice(err: ConfigError): string {
  const details = (err.details ?? [])
    .map((d) => d.trim())
    .filter(Boolean)
    .slice(0, 6)
    .join("\n");
  return (
    "⚠️ hostd: switchroom.yaml failed to load — running DEGRADED.\n" +
    `${err.message}\n` +
    (details ? details + "\n" : "") +
    `Retrying every ${Math.round(CONFIG_DEGRADED_RETRY_MS / 1000)}s and on file change. ` +
    "Fleet operations (rollouts, config edits, restarts) are paused until the " +
    "config parses. Fix the YAML (`switchroom config check` validates it) — " +
    "no hostd restart needed. A pending self-bump rollout, if any, will resume " +
    "once the config loads (its 15-min freshness budget is frozen while degraded)."
  );
}

/** Operator-DM text for recovering from degraded mode. */
export function formatRecoveredNotice(
  degradedMs: number,
  resumedPendingRollout: boolean,
): string {
  const mins = Math.max(1, Math.round(degradedMs / 60_000));
  return (
    `✅ hostd: switchroom.yaml loads again after ~${mins}m degraded — normal service resumed.` +
    (resumedPendingRollout
      ? " A pending self-bump rollout marker was preserved through the outage and will resume now."
      : "")
  );
}

/**
 * Shift a pending-rollout marker's `created_at` forward by the degraded
 * duration, so time spent degraded does not count against
 * `SELF_BUMP_MARKER_MAX_AGE_MS`. Returns the re-encoded marker, or null
 * when the input is not a parseable marker (caller leaves the file
 * untouched — the normal boot path already handles malformed markers).
 */
export function shiftPendingRolloutMarker(
  raw: string,
  degradedMs: number,
): string | null {
  if (degradedMs <= 0) return null;
  const marker = parsePendingRolloutMarker(raw);
  if (!marker) return null;
  const created = Date.parse(marker.created_at);
  if (!Number.isFinite(created)) return null;
  return encodePendingRolloutMarker({
    ...marker,
    created_at: new Date(created + degradedMs).toISOString(),
  });
}

export interface DegradedConfigWaitOptions {
  /** The ConfigError that failed the initial load. */
  initialError: ConfigError;
  /** hostd's view of the operator home (`/host-home` in the container). */
  homeDir: string;
  /** Reload attempt — normally `() => loadConfig()`. */
  loadFn: () => SwitchroomConfig;
  /** Absolute config-file path to watch for changes, if known. */
  configPath?: string | undefined;
  /** Fire-and-forget operator notification (relay wraps its own errors). */
  notify: (text: string) => void;
  log: (msg: string) => void;
  retryMs?: number;
  nowFn?: () => number;
}

/**
 * Block until `loadFn` succeeds, maintaining the degraded marker file and
 * the operator notifications, and preserving any pending-rollout marker
 * across the outage. Never throws on ConfigError — only a non-ConfigError
 * (a genuine bug) escapes to the caller's fatal handler.
 */
export async function waitForConfigRecovery(
  opts: DegradedConfigWaitOptions,
): Promise<SwitchroomConfig> {
  const now = opts.nowFn ?? Date.now;
  const retryMs = opts.retryMs ?? CONFIG_DEGRADED_RETRY_MS;
  const hostdDir = join(opts.homeDir, ".switchroom", "hostd");
  const degradedMarkerPath = join(hostdDir, CONFIG_DEGRADED_MARKER_FILENAME);
  const pendingMarkerPath = join(hostdDir, SELF_BUMP_MARKER_FILENAME);
  const enteredAt = now();

  // 1. Prominent marker file — written even when no gateway is reachable.
  try {
    mkdirSync(hostdDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      degradedMarkerPath,
      JSON.stringify(buildDegradedMarker(opts.initialError, enteredAt), null, 2) + "\n",
      { mode: 0o600 },
    );
  } catch (e) {
    opts.log(
      `config-degraded: could not write marker ${degradedMarkerPath}: ${(e as Error).message}`,
    );
  }

  // 2. Operator DM (best-effort, fire-and-forget).
  try {
    opts.notify(formatDegradedNotice(opts.initialError));
  } catch (e) {
    opts.log(`config-degraded: notify threw: ${(e as Error).message}`);
  }

  opts.log(
    `config-degraded: entering degraded mode — ${opts.initialError.message}. ` +
      `Retrying every ${Math.round(retryMs / 1000)}s` +
      (opts.configPath ? ` and on change to ${opts.configPath}` : "") +
      `. Marker: ${degradedMarkerPath}`,
  );

  const config = await new Promise<SwitchroomConfig>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null;
    let settled = false;
    const cleanup = (): void => {
      if (timer) clearInterval(timer);
      if (opts.configPath) {
        try {
          unwatchFile(opts.configPath, onFileChange);
        } catch {
          /* never watched */
        }
      }
    };
    const attempt = (why: string): void => {
      if (settled) return;
      try {
        const cfg = opts.loadFn();
        settled = true;
        cleanup();
        resolve(cfg);
      } catch (err) {
        if (err instanceof ConfigError) {
          opts.log(
            `config-degraded: reload attempt (${why}) still failing — ${err.message}`,
          );
          return; // keep waiting
        }
        settled = true;
        cleanup();
        reject(err as Error);
      }
    };
    const onFileChange = (): void => attempt("file change");
    timer = setInterval(() => attempt("interval"), retryMs);
    // Don't let the retry timer alone keep the process alive decisions —
    // hostd's main() awaits this promise, so the interval ref is wanted.
    if (opts.configPath) {
      // watchFile (stat-polling) rather than fs.watch: inotify does not
      // propagate reliably across the bind mount hostd reads the config
      // through, and editors replace-rename the file. 5s poll = prompt
      // pickup without meaningful load.
      try {
        watchFile(opts.configPath, { interval: 5_000 }, onFileChange);
      } catch (e) {
        opts.log(
          `config-degraded: could not watch ${opts.configPath}: ${(e as Error).message}`,
        );
      }
    }
  });

  const degradedMs = Math.max(0, now() - enteredAt);

  // 3. Preserve the pending self-bump rollout marker: freeze its age for
  // the degraded window so the boot-resume freshness check (isMarkerFresh)
  // doesn't discard a roll that was only stalled by the bad config.
  let preservedPendingRollout = false;
  try {
    if (existsSync(pendingMarkerPath)) {
      const shifted = shiftPendingRolloutMarker(
        readFileSync(pendingMarkerPath, "utf8"),
        degradedMs,
      );
      if (shifted !== null) {
        writeFileSync(pendingMarkerPath, shifted, { mode: 0o600 });
        preservedPendingRollout = true;
        opts.log(
          `config-degraded: shifted pending-rollout marker created_at by ` +
            `${Math.round(degradedMs / 1000)}s so the degraded window does not ` +
            `count against the resume cutoff`,
        );
      }
    }
  } catch (e) {
    opts.log(
      `config-degraded: could not preserve pending-rollout marker: ${(e as Error).message}`,
    );
  }

  // 4. Clear the degraded marker + tell the operator we're back.
  try {
    if (existsSync(degradedMarkerPath)) unlinkSync(degradedMarkerPath);
  } catch (e) {
    opts.log(
      `config-degraded: could not remove marker ${degradedMarkerPath}: ${(e as Error).message}`,
    );
  }
  try {
    opts.notify(formatRecoveredNotice(degradedMs, preservedPendingRollout));
  } catch (e) {
    opts.log(`config-degraded: recovery notify threw: ${(e as Error).message}`);
  }
  opts.log(
    `config-degraded: config loads again after ${Math.round(degradedMs / 1000)}s — resuming normal boot`,
  );
  return config;
}
