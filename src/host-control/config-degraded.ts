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

import { existsSync, readFileSync, renameSync, unlinkSync, watchFile, unwatchFile, writeFileSync, mkdirSync } from "node:fs";
import { connect, type Socket } from "node:net";
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

/**
 * Cap on the degraded window a pending self-bump rollout marker is
 * preserved across. Past this, the roll is NOT auto-resumed: after hours
 * of outage the operator may have manually rolled, pinned, or moved on —
 * silently relaunching a stale roll is worse than asking. The marker is
 * left untouched (the normal boot-resume freshness check then treats it
 * as stale → terminal row, no resume) and the recovery DM names the pin
 * and age so the operator can re-run the roll deliberately.
 */
export const MAX_PRESERVED_DEGRADED_MS = 4 * 60 * 60 * 1000;

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

/**
 * Read the persisted degraded-entry epoch from an existing
 * `config-degraded.json`, if any. Lets a hostd that DIED while degraded
 * (crash, docker restart) credit the FULL degraded window on the next
 * boot's recovery instead of only the in-memory span since its own start.
 * Returns the epoch ms, or null when the file is absent/unparseable.
 */
export function readDegradedSince(markerPath: string): number | null {
  try {
    if (!existsSync(markerPath)) return null;
    const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as {
      v?: unknown;
      since?: unknown;
    };
    if (parsed?.v !== 1 || typeof parsed.since !== "string") return null;
    const since = Date.parse(parsed.since);
    return Number.isFinite(since) ? since : null;
  } catch {
    return null;
  }
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
    "hostd's sockets are not bound yet, so fleet operations (rollouts, config " +
    "edits, restarts) will fail with connection errors until the config parses. " +
    "Fix the YAML (`switchroom config check` validates it) — no hostd restart " +
    "needed. A pending self-bump rollout, if any, will resume once the config " +
    "loads (its 15-min freshness budget is frozen while degraded, up to " +
    `${Math.round(MAX_PRESERVED_DEGRADED_MS / 3_600_000)}h).`
  );
}

/** What happened to a pending self-bump rollout marker across the outage. */
export interface PendingRolloutOutcome {
  /** The roll's target pin, `vX.Y.Z`. */
  pin: string;
  /** Marker age (ms) as the resume check will see it, at recovery time. */
  ageMs: number;
  /** True ⇒ created_at was shifted; the roll will auto-resume. */
  preserved: boolean;
}

function humanMins(ms: number): string {
  const mins = Math.max(1, Math.round(ms / 60_000));
  return mins >= 90 ? `${(mins / 60).toFixed(1)}h` : `${mins}m`;
}

/** Operator-DM text for recovering from degraded mode. */
export function formatRecoveredNotice(
  degradedMs: number,
  pending: PendingRolloutOutcome | null,
): string {
  let tail = "";
  if (pending?.preserved) {
    tail =
      ` Pending self-bump rollout to ${pending.pin} was preserved through the ` +
      `outage (marker now ${humanMins(pending.ageMs)} old) and will resume now.`;
  } else if (pending) {
    tail =
      ` NOTE: pending self-bump rollout to ${pending.pin} was NOT auto-resumed — ` +
      `degraded for ~${humanMins(degradedMs)}, past the ` +
      `${Math.round(MAX_PRESERVED_DEGRADED_MS / 3_600_000)}h preservation cap. Its ` +
      `marker (${humanMins(pending.ageMs)} old) will be treated as stale; re-run ` +
      `the rollout if it is still wanted.`;
  }
  return (
    `✅ hostd: switchroom.yaml loads again after ~${humanMins(degradedMs)} degraded — ` +
    `normal service resumed.` +
    tail
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

/** A candidate gateway IPC socket for the degraded-mode operator DM. */
export interface GatewayCandidate {
  agent: string;
  sock: string;
}

/**
 * Post ONE plain operator-DM (`rollout_status_post` wire shape — the same
 * message `SocketRolloutRelay` sends) through the FIRST candidate gateway
 * that actually accepts the connection and the write. `existsSync` on a
 * socket path does not prove a listener (a crashed gateway leaves the
 * inode behind), so candidates are tried IN ORDER until one succeeds.
 * Best-effort: resolves with the agent name that took the message, or
 * null when every candidate failed. Never throws.
 */
export function postOperatorNoticeViaGateways(
  candidates: GatewayCandidate[],
  text: string,
  log: (msg: string) => void,
  connectTimeoutMs = 5_000,
): Promise<string | null> {
  const tryOne = (c: GatewayCandidate): Promise<boolean> =>
    new Promise<boolean>((resolve) => {
      let done = false;
      const finish = (ok: boolean, why?: string): void => {
        if (done) return;
        done = true;
        if (why) log(`config-degraded: gateway ${c.agent} — ${why}`);
        try {
          client.destroy();
        } catch {
          /* already gone */
        }
        resolve(ok);
      };
      let client: Socket;
      try {
        client = connect({ path: c.sock });
      } catch (e) {
        log(`config-degraded: gateway ${c.agent} — connect threw: ${(e as Error).message}`);
        resolve(false);
        return;
      }
      client.setTimeout(connectTimeoutMs);
      client.on("connect", () => {
        try {
          client.write(
            JSON.stringify({
              type: "rollout_status_post",
              requestId: "config-degraded",
              agentName: c.agent,
              text,
            }) + "\n",
            () => {
              // Write flushed to the kernel — the line left our process.
              client.end();
              finish(true);
            },
          );
        } catch (e) {
          finish(false, `write failed: ${(e as Error).message}`);
        }
      });
      client.on("timeout", () => finish(false, "connect timed out"));
      client.on("error", (e) => finish(false, `socket error: ${e.message}`));
    });

  return (async () => {
    for (const c of candidates) {
      if (await tryOne(c)) return c.agent;
    }
    if (candidates.length > 0) {
      log("config-degraded: every candidate gateway socket failed; relying on marker file");
    }
    return null;
  })();
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
  // If a degraded marker already exists (hostd died while degraded — crash
  // or docker restart), credit the FULL window from its persisted `since`,
  // not just this process's lifetime; otherwise the shift applied at
  // recovery would silently drop the pre-crash portion of the outage.
  const persistedSince = readDegradedSince(degradedMarkerPath);
  const enteredAt = Math.min(persistedSince ?? now(), now());
  if (persistedSince !== null) {
    opts.log(
      `config-degraded: resuming an existing degraded window (since ` +
        `${new Date(enteredAt).toISOString()}, persisted in ${degradedMarkerPath})`,
    );
  }

  // 1. Prominent marker file — written even when no gateway is reachable.
  // `since` carries the (possibly inherited) entry epoch; tmp+rename so a
  // crash mid-write can't leave a torn marker.
  try {
    mkdirSync(hostdDir, { recursive: true, mode: 0o700 });
    writeFileSync(
      degradedMarkerPath + ".tmp",
      JSON.stringify(buildDegradedMarker(opts.initialError, enteredAt), null, 2) + "\n",
      { mode: 0o600 },
    );
    renameSync(degradedMarkerPath + ".tmp", degradedMarkerPath);
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
  // Capped at MAX_PRESERVED_DEGRADED_MS: past that, auto-resuming a roll
  // the operator may have superseded is worse than reporting it stale.
  let pendingOutcome: PendingRolloutOutcome | null = null;
  try {
    if (existsSync(pendingMarkerPath)) {
      const raw = readFileSync(pendingMarkerPath, "utf8");
      const marker = parsePendingRolloutMarker(raw);
      if (marker && degradedMs <= 0) {
        // Instant recovery — no age credit needed; the marker resumes on
        // its own freshness.
        pendingOutcome = {
          pin: marker.pin,
          ageMs: Math.max(0, now() - Date.parse(marker.created_at)),
          preserved: true,
        };
      } else if (marker) {
        const withinCap = degradedMs <= MAX_PRESERVED_DEGRADED_MS;
        const shifted = withinCap
          ? shiftPendingRolloutMarker(raw, degradedMs)
          : null;
        if (shifted !== null) {
          // tmp+rename: a crash mid-rewrite must never leave a torn marker
          // (the boot-resume path deletes malformed markers — the roll
          // would be silently lost).
          writeFileSync(pendingMarkerPath + ".tmp", shifted, { mode: 0o600 });
          renameSync(pendingMarkerPath + ".tmp", pendingMarkerPath);
          pendingOutcome = {
            pin: marker.pin,
            ageMs: Math.max(0, now() - (Date.parse(marker.created_at) + degradedMs)),
            preserved: true,
          };
          opts.log(
            `config-degraded: shifted pending-rollout marker (${marker.pin}) ` +
              `created_at by ${Math.round(degradedMs / 1000)}s so the degraded ` +
              `window does not count against the resume cutoff`,
          );
        } else {
          pendingOutcome = {
            pin: marker.pin,
            ageMs: Math.max(0, now() - Date.parse(marker.created_at)),
            preserved: false,
          };
          if (!withinCap) {
            opts.log(
              `config-degraded: NOT preserving pending-rollout marker ` +
                `(${marker.pin}) — degraded ${Math.round(degradedMs / 60_000)}m, ` +
                `past the ${Math.round(MAX_PRESERVED_DEGRADED_MS / 3_600_000)}h ` +
                `preservation cap; the roll will not auto-resume`,
            );
          }
        }
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
    opts.notify(formatRecoveredNotice(degradedMs, pendingOutcome));
  } catch (e) {
    opts.log(`config-degraded: recovery notify threw: ${(e as Error).message}`);
  }
  opts.log(
    `config-degraded: config loads again after ${Math.round(degradedMs / 1000)}s — resuming normal boot`,
  );
  return config;
}
