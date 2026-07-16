/**
 * Timezone resolution for switchroom agents.
 *
 * Switchroom agents are long-lived Claude Code processes. Their inbound
 * prompts carry UTC timestamps (Telegram channel messages, scheduled
 * task triggers, session-start greetings). Without a local-time hint,
 * the LLM takes UTC as "now" and reasons wrong by up to a day at the
 * extremes — fine for a server-to-server bot, catastrophic for a
 * personal-assistant agent saying "good morning" at 10pm local.
 *
 * The resolver is a plain four-step cascade with server detection as
 * the final fallback. No I/O when an explicit value is present at any
 * cascade layer, and server detection is cheap (one file read plus a
 * readlink in the worst case). Pure function except for the probe
 * callbacks, which are injected for tests.
 *
 * Resolution order:
 *   1. agent.timezone        (explicit per-agent override)
 *   2. profile.timezone      (inherited via `extends:`)
 *   3. switchroom.timezone   (global default)
 *   4. host detection        (SWITCHROOM_HOST_TZ → /etc/timezone → /etc/localtime)
 *   5. "UTC" fallback        (with loud warning — almost always a misconfiguration)
 *
 * The resolver intentionally does NOT read switchroom.defaults.timezone
 * because the full defaults-profile-agent merge has already happened
 * by the time the resolved AgentConfig arrives here — the defaults
 * value, if present, is already on agent.timezone via the cascade.
 *
 * Server detection on Linux checks SWITCHROOM_HOST_TZ first (baked into
 * the hostd container environment at `switchroom hostd install` time so
 * that in-container `switchroom apply` sees the host's real zone, not the
 * container's Etc/UTC default). Falls back to /etc/timezone (Debian /
 * Ubuntu convention), then /etc/localtime (a symlink into the zoneinfo
 * database — we extract the tail after `zoneinfo/`). Container-default
 * UTC (/etc/localtime → Etc/UTC with no /etc/timezone) is treated as
 * "unknown / no signal" and falls through to the UTC hard-fallback, which
 * emits a loud warning.
 */

import { readFileSync, readlinkSync } from "node:fs";
import type { AgentConfig, SwitchroomConfig } from "./schema.js";

/**
 * Does this string name a timezone the runtime can actually resolve?
 *
 * `isValidTimezone` (schema.ts) is a SHAPE check — a cheap regex that accepts
 * any `Region/City` pair without shipping the IANA database. That lets a
 * shape-valid TYPO (e.g. `Australia/Melbrone`, `America/New_Yrok`) pass config
 * load, then silently degrade to UTC at runtime because `Intl` / `ZoneInfo`
 * reject the unknown zone (#tz-fix audit, LOW gap 3).
 *
 * This predicate closes that gap by asking the runtime directly: constructing
 * an `Intl.DateTimeFormat` with an unknown `timeZone` throws `RangeError`,
 * while every real IANA zone (and `UTC`) succeeds. Node ships full-ICU by
 * default, so the tz database backing this is the same one the agent's
 * `Intl`-based local-time rendering uses — a zone that passes here is a zone
 * that renders correctly at runtime. Total: never throws, returns a boolean.
 */
export function isResolvableTimezone(zone: string): boolean {
  try {
    // eslint-disable-next-line no-new
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

export interface ResolveTimezoneOpts {
  /**
   * Read /etc/timezone (or equivalent). Return the trimmed string or
   * undefined if unavailable. Exposed for tests — production callers
   * never pass this.
   */
  readEtcTimezone?: () => string | undefined;
  /**
   * Read /etc/localtime as a symlink. Return the symlink target or
   * undefined if it isn't a symlink / doesn't exist. Exposed for tests.
   */
  readLocaltimeLink?: () => string | undefined;
  /**
   * Override process.env for tests (used to inject SWITCHROOM_HOST_TZ
   * without touching the real environment).
   */
  env?: NodeJS.ProcessEnv;
  /**
   * Called when the resolver falls all the way through to the UTC
   * hard-fallback (no yaml entry, no SWITCHROOM_HOST_TZ, no /etc/timezone,
   * and /etc/localtime resolves to a bare container default). This is
   * almost always a misconfiguration — production callers wire this to
   * console.warn so the operator sees it on apply/reconcile. Exposed for
   * tests to capture output without polluting stdout.
   */
  onUtcFallback?: () => void;
}

function defaultReadEtcTimezone(): string | undefined {
  try {
    const raw = readFileSync("/etc/timezone", "utf-8").trim();
    return raw.length > 0 ? raw : undefined;
  } catch {
    return undefined;
  }
}

function defaultReadLocaltimeLink(): string | undefined {
  try {
    return readlinkSync("/etc/localtime");
  } catch {
    return undefined;
  }
}

/**
 * Extract the IANA zone name from a /etc/localtime symlink target.
 *
 * A typical link points at something like
 * `/usr/share/zoneinfo/Australia/Melbourne` or
 * `../usr/share/zoneinfo/America/Argentina/Buenos_Aires`. We take the
 * tail after `zoneinfo/` which covers both two- and three-segment
 * zones (Region/City and Region/Sub/City).
 *
 * Returns undefined when the target doesn't contain a `zoneinfo/`
 * segment, rather than returning something that will fail validation
 * downstream.
 */
export function extractZoneFromLocaltimeLink(target: string): string | undefined {
  const marker = "zoneinfo/";
  const idx = target.indexOf(marker);
  if (idx < 0) return undefined;
  const tail = target.slice(idx + marker.length);
  return tail.length > 0 ? tail : undefined;
}

/**
 * The set of bare UTC-equivalent zone strings that a Debian/Ubuntu base
 * image emits on a container with no explicit timezone configured. When
 * `/etc/localtime` resolves to one of these AND there is no
 * `/etc/timezone` file, we treat the result as "unknown / no signal from
 * the container" and fall through to the UTC hard-fallback in the caller
 * rather than silently accepting UTC as the real timezone.
 *
 * Rationale: a fresh Debian/Ubuntu container ships with
 * `/etc/localtime → /usr/share/zoneinfo/Etc/UTC` and no `/etc/timezone`.
 * That is indistinguishable from an operator who genuinely wants UTC — EXCEPT
 * we also have `SWITCHROOM_HOST_TZ` as a signal layer above this. If that
 * env var is absent AND the container is showing a bare UTC symlink with no
 * `/etc/timezone`, we assume we are inside a container (or an exotic host
 * that truly has no timezone configured) and emit the loud warning instead
 * of silently baking UTC into every agent.
 */
const CONTAINER_DEFAULT_UTC_ZONES = new Set([
  "UTC",
  "Etc/UTC",
  "Etc/Universal",
  "Universal",
]);

/**
 * Probe the host for its configured timezone.
 *
 * Cascade (highest to lowest priority):
 *   1. `SWITCHROOM_HOST_TZ` env var — baked into the hostd container at
 *      `switchroom hostd install` time from the host's real /etc/timezone
 *      or /etc/localtime. This is the primary signal for in-container runs.
 *   2. `/etc/timezone` — Debian/Ubuntu convention; absent in containers.
 *   3. `/etc/localtime` symlink — present everywhere; BUT if it resolves to
 *      a bare container-default UTC zone (Etc/UTC, UTC, …) AND there was no
 *      `/etc/timezone`, we treat that as "no signal" and return undefined so
 *      the caller can fall through to the UTC hard-fallback with a warning.
 *
 * Returns undefined (not "UTC") when no genuine signal is found, so the
 * caller can distinguish "detected UTC" from "no signal → fallback to UTC".
 */
export function detectServerTimezone(
  opts: ResolveTimezoneOpts = {},
): string | undefined {
  const readEtc = opts.readEtcTimezone ?? defaultReadEtcTimezone;
  const readLink = opts.readLocaltimeLink ?? defaultReadLocaltimeLink;
  const env = opts.env ?? process.env;

  // Layer 1: SWITCHROOM_HOST_TZ — baked in by `hostd install` on the host,
  // where /etc/localtime correctly points at Australia/Melbourne (or wherever).
  // This is the only reliable signal when `switchroom apply` runs inside the
  // hostd container (whose /etc/localtime → Etc/UTC regardless of host zone).
  const hostTzEnv = env.SWITCHROOM_HOST_TZ?.trim();
  if (hostTzEnv && hostTzEnv.length > 0) return hostTzEnv;

  // Layer 2: /etc/timezone — absent in containers, reliable on real hosts.
  const fromEtc = readEtc();
  if (fromEtc) return fromEtc;

  // Layer 3: /etc/localtime symlink — present in containers but typically
  // points at Etc/UTC (the Debian base image default). Accept it only if it
  // resolves to a non-bare-UTC zone, so we don't silently bake UTC into an
  // agent fleet running inside a container.
  const linkTarget = readLink();
  if (linkTarget) {
    const extracted = extractZoneFromLocaltimeLink(linkTarget);
    if (extracted && !CONTAINER_DEFAULT_UTC_ZONES.has(extracted)) {
      return extracted;
    }
  }

  // No genuine signal found. Return undefined so the caller can emit a loud
  // warning and fall back to "UTC" explicitly.
  return undefined;
}

/**
 * Resolve an agent's effective timezone.
 *
 * Cascade (highest to lowest priority):
 *   1. agent.timezone / profile.timezone / defaults.timezone  (explicit yaml override)
 *   2. switchroom.timezone                                     (global yaml override)
 *   3. detectServerTimezone()                                  (SWITCHROOM_HOST_TZ → /etc/timezone → /etc/localtime)
 *   4. "UTC" hard-fallback                                     (loud warning — almost always a misconfiguration)
 *
 * Steps 1–2 are handled implicitly: by the time mergeAgentConfig + resolveAgentConfig
 * have run, any profile-level or defaults-level timezone has already landed on
 * `resolvedAgent.timezone`. This function layers the global `switchroom.timezone`
 * on top (which is NOT merged through the agent cascade because it lives on the
 * root block, not in defaults/profile) and then falls back to host detection.
 *
 * The UTC hard-fallback fires `opts.onUtcFallback` (if provided) so callers can
 * emit a loud warning to the operator. Scaffold/reconcile wires this to
 * console.warn; tests inject a no-op or a spy.
 */
export function resolveTimezone(
  config: SwitchroomConfig,
  resolvedAgent: AgentConfig,
  opts: ResolveTimezoneOpts = {},
): string {
  if (resolvedAgent.timezone) return resolvedAgent.timezone;
  // `switchroom` is required by SwitchroomConfigSchema, but a handful of
  // older test fixtures cast partial literals to SwitchroomConfig without
  // the root block. Tolerate the undefined read rather than breaking them.
  const global = config.switchroom?.timezone;
  if (global) return global;
  const detected = detectServerTimezone(opts);
  if (detected !== undefined) return detected;
  // UTC hard-fallback: no explicit config, no SWITCHROOM_HOST_TZ, no
  // /etc/timezone, and /etc/localtime looks like a bare container default.
  // Fire the warning callback so the operator sees it on apply/reconcile.
  opts.onUtcFallback?.();
  return "UTC";
}

/**
 * Classify the cascade layer that produced the resolved timezone.
 *
 * Used by reconcile to decide whether to warn. We warn ONLY when the
 * resolved zone is UTC AND no explicit override appears in any config
 * layer — i.e. the result came from server detection and happens to be
 * UTC, which on most container hosts is a platform default rather than
 * a real expression of the user's locale.
 */
export type TimezoneSource = "agent" | "global" | "detected";

export function classifyTimezoneSource(
  config: SwitchroomConfig,
  resolvedAgent: AgentConfig,
): TimezoneSource {
  if (resolvedAgent.timezone) return "agent";
  if (config.switchroom?.timezone) return "global";
  return "detected";
}
